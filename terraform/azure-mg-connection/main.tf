# ===========================================================================
# Dynatrace Azure Connection — main.tf
#
# Connects an Azure management group to Dynatrace using the hyperscaler
# cloud connection model:
# https://docs.dynatrace.com/docs/ingest-from/microsoft-azure-services/
#   create-an-azure-connection/azure-connection-api
#
# The Azure integration is assembled from discrete resources:
#
#   Step 1 — Azure identity      (azuread_application_registration + service principal)
#   Step 2 — Role assignment     (azurerm_role_assignment, Monitoring Reader on MG)
#   Step 3 — Dynatrace connection (dynatrace_azure_connection)
#   Step 4 — Federated binding   (federated auth only)
#   Step 5 — Monitoring config    (dynatrace_hub_extension_v2_config)
# ===========================================================================

locals {
  extension_name    = "com.dynatrace.extension.da-azure"
  extension_version = "1.1.7"

  is_federated = var.auth_type == "federatedIdentityCredential"

  # Consumer for federated connections used by the da-azure extension.
  # "DA" is the deprecated shorthand (blocked by the API for federated type).
  # "APP:dynatrace.microsoft.azure.connector" is the separate app-based Azure
  # Connector product. The correct value for the da-azure extension is the
  # Data Acquisition service consumer.
  federated_consumer = "SVC:com.dynatrace.da"

  # Extract the first subdomain of dt_env_url to use in Azure resource names.
  # e.g. "abc12345" from "https://abc12345.apps.dynatrace.com"
  dt_env_id = split(".", trimprefix(var.dt_env_url, "https://"))[0]

  # The Dynatrace provider stores hub_extension_v2_config IDs as
  # "<extension-name>#-#<uuid>". The ARM template expects only the UUID portion
  # as dtConfigId (used as the dt-log-ingest-activated tag value).
  monitoring_config_id = split("#-#", dynatrace_hub_extension_v2_config.azure_connection.id)[1]


  # Dynatrace derives the aud claim of its OIDC token from the consumer:
  #   APP:X → {env-host}/app-id/X
  #   SVC:X → {env-host}/svc-id/X
  # The https:// scheme is omitted in the token, so strip it here so the
  # registered Azure credential audience matches what Dynatrace actually presents.
  _federated_consumer_parts = split(":", local.federated_consumer)
  federated_audience        = "${trimprefix(var.dt_env_url, "https://")}/${lower(local._federated_consumer_parts[0])}-id/${local._federated_consumer_parts[1]}"
}

# ---------------------------------------------------------------------------
# PREREQUISITE — enable the da-azure extension in the environment (first run only)
#
# If this is the first Azure connection in the environment you must add the
# extension before creating a monitoring configuration. Do one of:
#
#   Option A (manual):
#     Settings > Collect and capture > Cloud and virtualization > Azure
#     (open and keep open ~10 min)
#
#   Option B (API — run once, not managed by this Terraform):
#     curl -X POST \
#       "https://${DYNATRACE_ENV_URL}/api/v2/hub/extensions2/\
#        com.dynatrace.extension.da-azure/actions/addToEnvironment" \
#       --header "Authorization: Api-Token ${DYNATRACE_API_TOKEN}" \
#       --header "Accept: application/json"
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# STEP 1 — Azure identity
#
# The app registration + service principal is the identity Dynatrace assumes
# when polling Azure Monitor. The app's client ID is the servicePrincipalId
# referenced by the monitoring configuration in Step 5.
#
# Docs: https://registry.terraform.io/providers/hashicorp/azuread/latest/docs/resources/application_registration
# ---------------------------------------------------------------------------
resource "azuread_application_registration" "dynatrace" {
  display_name = var.app_display_name
  description  = "Dynatrace monitoring connection: ${var.connection_name}"
}

resource "azuread_service_principal" "dynatrace" {
  client_id = azuread_application_registration.dynatrace.client_id
}

# ---------------------------------------------------------------------------
# STEP 2 — Role assignment
#
# Grants the service principal read access to Azure Monitor metrics across the
# entire management group. The Monitoring Reader role cascades to all
# subscriptions beneath the management group.
#
# The signed-in identity must have Owner or User Access Administrator at the
# management group scope to create this role assignment.
#
# To narrow to a single subscription instead, use azure/sub.
#
# Docs: https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment
# ---------------------------------------------------------------------------
resource "azurerm_role_assignment" "monitoring_reader" {
  scope                = "/providers/Microsoft.Management/managementGroups/${var.management_group_id}"
  role_definition_name = "Monitoring Reader"
  principal_id         = azuread_service_principal.dynatrace.object_id
}

# ---------------------------------------------------------------------------
# STEP 3 — Dynatrace connection object
#
# Stores how Dynatrace authenticates as the service principal. The block used
# depends on var.auth_type:
#   federatedIdentityCredential — passwordless; binding is finalized in Step 4.
#   clientSecret                — a Terraform-generated secret stored here.
#
# Schema: builtin:hyperscaler-authentication.connections.azure
# Docs: https://registry.terraform.io/providers/dynatrace-oss/dynatrace/latest/docs/resources/azure_connection
# ---------------------------------------------------------------------------

# Client secret for the app registration — created only for clientSecret auth.
resource "azuread_application_password" "dynatrace" {
  count          = local.is_federated ? 0 : 1
  application_id = azuread_application_registration.dynatrace.id
}

resource "dynatrace_azure_connection" "dynatrace" {
  name = var.connection_name
  type = var.auth_type

  # Federated identity: no secret is stored. Dynatrace mints OIDC tokens that
  # Azure trusts via the federated credential created in Step 4. The connection
  # must exist first so its ID can be used as that credential's subject — the
  # application_id/directory_id are bound afterwards via
  # dynatrace_azure_connection_authentication.
  dynamic "federated_identity_credential" {
    for_each = local.is_federated ? [1] : []
    content {
      consumers = [local.federated_consumer]
    }
  }

  # Client secret: the app's client ID, tenant, and the generated secret are
  # stored directly on the connection.
  dynamic "client_secret" {
    for_each = local.is_federated ? [] : [1]
    content {
      application_id = azuread_application_registration.dynatrace.client_id
      directory_id   = var.tenant_id
      client_secret  = azuread_application_password.dynatrace[0].value
      consumers      = ["DA"]
    }
  }
}

# ---------------------------------------------------------------------------
# STEP 4 — Federated credential binding (federated auth only)
#
# Establishes the trust between Azure and Dynatrace, then finalizes the
# Dynatrace-side binding of the app registration + tenant to the connection.
# ---------------------------------------------------------------------------

# Azure trusts a Dynatrace-issued token whose subject is this connection's ID.
resource "azuread_application_federated_identity_credential" "dynatrace" {
  count          = local.is_federated ? 1 : 0
  application_id = azuread_application_registration.dynatrace.id
  display_name   = var.connection_name
  issuer         = var.dynatrace_token_issuer
  subject        = "dt:connection-id/${dynatrace_azure_connection.dynatrace.id}"
  audiences      = [local.federated_audience]
}

# Finalizes the connection by binding the app (client) ID and tenant to it.
# Created after the federated credential so Dynatrace can validate the trust.
resource "dynatrace_azure_connection_authentication" "dynatrace" {
  count               = local.is_federated ? 1 : 0
  azure_connection_id = dynatrace_azure_connection.dynatrace.id
  application_id      = azuread_application_registration.dynatrace.client_id
  directory_id        = var.tenant_id

  depends_on = [azuread_application_federated_identity_credential.dynatrace]
}

# ---------------------------------------------------------------------------
# STEP 5 — Monitoring configuration
#
# Creates the Azure monitoring configuration in Dynatrace, bound to the
# connection from Step 3.
#
# Docs: https://registry.terraform.io/providers/dynatrace-oss/dynatrace/latest/docs/resources/hub_extension_v2_config
# Requires scopes: extensions:configurations:read, extensions:configurations:write
# ---------------------------------------------------------------------------
resource "dynatrace_hub_extension_v2_config" "azure_connection" {
  name  = local.extension_name
  scope = var.monitoring_config_scope

  value = jsonencode({
    # Required: whether this monitoring configuration is active.
    enabled = true

    # Written back by the Dynatrace API — kept explicit to prevent perpetual drift.
    activationContext = "DATA_ACQUISITION"

    # Required: human-readable label shown in the Dynatrace UI.
    description = var.connection_name

    # Required: must match the installed extension version.
    version = local.extension_version

    # Required: Azure service groups to monitor (0–500 values). Each identifier
    # follows the pattern <namespace>_<tier> where tier is essential,
    # essentialplus, or autodiscovery. See var.feature_sets for valid values.
    featureSets = var.feature_sets

    azure = {
      # Required: Azure connection binding. Exactly one entry (minObjects: 1,
      # maxObjects: 1).
      credentials = [
        {
          # Required: human-readable label for this connection in the UI.
          description = var.connection_name

          # Required: whether this credential is actively polled for metrics.
          enabled = true

          # Required: Dynatrace connection object ID from Step 3.
          connectionId = dynatrace_azure_connection.dynatrace.id

          # Required: Azure app (client) ID of the service principal Dynatrace assumes.
          # Pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
          servicePrincipalId = azuread_application_registration.dynatrace.client_id

          # Optional: service principal object ID. Useful for auditing which
          # Azure RBAC principal holds the Monitoring Reader role assignment.
          # principalObjectId = azuread_service_principal.dynatrace.object_id

          # Required for federated connections: tells the da-azure extension which
          # authentication path to use. Without this, it falls back to SECRET and
          # rejects the connection with "Unsupported connection."
          type = local.is_federated ? "FEDERATED" : "SECRET"
        }
      ]

      # Required: restrict active monitoring to these Azure regions (1–60).
      # Valid values (lowercase location names from the schema):
      #   US:     eastus, eastus2, westus, westus2, westus3, centralus,
      #           northcentralus, southcentralus, westcentralus
      #   Europe: westeurope, northeurope, uksouth, ukwest, francecentral,
      #           francesouth, germanywestcentral, germanynorth, swedencentral,
      #           switzerlandnorth, switzerlandwest, norwayeast, norwaywest,
      #           italynorth, polandcentral, spaincentral
      #   Asia Pacific: eastasia, southeastasia, australiaeast, australiasoutheast,
      #           japaneast, japanwest, koreacentral, koreasouth, centralindia,
      #           southindia, westindia, jioindiacentral, jioindiawest,
      #           australiacentral, australiacentral2, newzealandnorth
      #   Canada: canadacentral, canadaeast
      #   South America: brazilsouth, brazilsoutheast, brazilus
      #   Africa: southafricanorth, southafricawest
      #   Middle East: uaenorth, uaecentral, qatarcentral, israelcentral
      #   Mexico: mexicocentral
      locationFiltering = var.monitored_locations

      # Optional: restrict monitoring to specific subscriptions within the
      # management group (0–10 GUIDs). An empty list monitors all subscriptions
      # under the management group. subscriptionFilteringMode controls whether
      # the list is an allow-list (INCLUDE) or block-list (EXCLUDE); ignored
      # when subscriptionFiltering is empty.
      subscriptionFiltering     = var.subscription_ids
      subscriptionFilteringMode = "INCLUDE"

      # Optional: monitoring setup mode. No schema default.
      #   QUICK_START — Dynatrace-recommended defaults driven by featureSets.
      #   ADVANCED    — full control over namespaces and metrics. Required when
      #                 using the namespaces block below.
      configurationMode = "QUICK_START"

      # Optional: scope this monitoring config targets. No schema default.
      #   SUBSCRIPTION     — a single Azure subscription.
      #   MANAGEMENT_GROUP — all subscriptions under a management group (this workspace).
      deploymentScope = "MANAGEMENT_GROUP"

      # Optional: how the Azure identity was provisioned. No schema default.
      #   AUTOMATED — Dynatrace-managed ARM template deployment.
      #   MANUAL    — you manage the app registration and role assignment (this workspace).
      deploymentMode = "MANUAL"

      # Optional: signals to Dynatrace that the manual identity setup is done.
      # Meaningful only when deploymentMode = "MANUAL".
      #   NA         — not applicable.
      #   INCOMPLETE — identity has not yet been configured.
      #   COMPLETE   — identity is ready; Dynatrace will begin polling.
      manualDeploymentStatus = "COMPLETE"

      # Optional: Smartscape topology mapping. Default when omitted: enabled = true.
      # smartscapeConfiguration = {
      #   # Required: whether Smartscape topology mapping is active. Default: true.
      #   enabled = true
      # }

      # Optional: Azure Monitor metrics collection. Default when omitted: enabled = true.
      # metricsConfiguration = {
      #   # Required: whether Azure Monitor metric polling is active.
      #   enabled = true
      # }

      # Optional: Azure tag keys whose values are added as dimensions on all
      # ingested metrics and Smartscape nodes (0–20 tag keys). Written back by
      # the API as [] — kept explicit to prevent perpetual drift. Replace with a
      # list to enable.
      tagEnrichment = []
      # tagEnrichment = ["CostCenter", "Team", "Environment"]

      # Optional: include or exclude Azure resources by tag (0–10 rules).
      # Evaluated before any featureSet or namespace configuration. Written back
      # by the API as [] — kept explicit to prevent perpetual drift.
      tagFiltering = []
      # tagFiltering = [
      #   {
      #     # Required: Azure resource tag key to match.
      #     key = "Environment"
      #     # Required: Azure resource tag value to match.
      #     value = "production"
      #     # Required: filter action.
      #     #   INCLUDE — keep only resources matching this tag key/value.
      #     #   EXCLUDE — skip resources matching this tag key/value.
      #     condition = "INCLUDE"
      #   }
      # ]

      # Optional: map Azure resource tags (or literal strings) to Dynatrace
      # enrichment labels. Exactly one of tagKey or literal must be set per label.
      # dtLabelsEnrichment = {
      #   "dt.security_context" = {
      #     # Required (one of): populate from the value of this Azure tag key.
      #     tagKey = "SecurityContext"
      #     # Required (one of): OR a fixed literal string (mutually exclusive with tagKey).
      #     # literal = "fixed-value"
      #   }
      #   "dt.cost.costcenter" = {
      #     tagKey = "CostCenter"
      #   }
      #   "dt.cost.product" = {
      #     tagKey = "Product"
      #   }
      # }

      # Optional: push-based ingest from Azure Event Hub (0–10 entries). Use
      # when you want to stream Azure Monitor metrics/logs via Event Hub instead
      # of or in addition to the polling path. Requires configurationMode = "ADVANCED".
      # eventHubsConfiguration = [
      #   {
      #     # Required: Event Hub namespace fully-qualified domain name.
      #     fqdn = "myns.servicebus.windows.net"
      #     # Required: Event Hub name (e.g. "insights-metrics-pt1m" for metrics).
      #     eventHub = "insights-metrics-pt1m"
      #     # Required: consumer group name. Use "$Default" for the default group.
      #     consumerGroup = "$Default"
      #     # Required: how many seconds back to read on first connect. Default: 60.
      #     receiveFrom = 60
      #   }
      # ]

      # Optional: custom Azure namespaces to monitor (0–100, ADVANCED mode only).
      # Written back by the API as [] — kept explicit to prevent perpetual drift.
      namespaces = []
      # namespaces = [
      #   {
      #     # Required: Azure Monitor resource provider namespace
      #     # (e.g. "Microsoft.Storage/storageAccounts").
      #     namespace = "Microsoft.Storage/storageAccounts"
      #
      #     # Required: Azure resource type
      #     # (e.g. "Microsoft.Storage/storageAccounts").
      #     resourceType = "Microsoft.Storage/storageAccounts"
      #
      #     # Required: auto-discover all metrics in this namespace.
      #     # Set to false to define metrics explicitly in the metrics list below.
      #     autoDiscoveryEnabled = true
      #
      #     # Optional: seconds to delay ingestion for late-arriving data points.
      #     # ingestDelay = 60
      #
      #     # Required when autoDiscoveryEnabled = false (1–100 metrics).
      #     # metrics = [
      #     #   {
      #     #     # Required: Azure Monitor metric name.
      #     #     name = "BlobCapacity"
      #     #
      #     #     # Required: ISO 8601 time grain (e.g. "PT1M", "PT5M", "PT1H").
      #     #     timeGrain = "PT1M"
      #     #
      #     #     # Optional: metric unit (e.g. "Bytes", "Count", "Percent").
      #     #     # unit = "Bytes"
      #     #
      #     #     # Required: dimensions to group by (0–10 strings).
      #     #     dimensions = ["BlobType", "Tier"]
      #     #
      #     #     # Required: aggregation methods to collect (0–10).
      #     #     # Valid values: average | minimum | maximum | total | count
      #     #     aggregations = ["average", "maximum"]
      #     #
      #     #     # Required: metric type.
      #     #     # Valid values:
      #     #     #   ESSENTIAL_PLUS — extend an existing essential metric set.
      #     #     #   CUSTOM_AZURE   — standard Azure Monitor metric.
      #     #     #   CUSTOM         — generic custom metric.
      #     #     type = "CUSTOM_AZURE"
      #     #   }
      #     # ]
      #   }
      # ]
    }
  })

  # Ensure the connection (and its federated binding, when applicable) is fully
  # established before the monitoring configuration references it.
  depends_on = [
    dynatrace_azure_connection.dynatrace,
    dynatrace_azure_connection_authentication.dynatrace,
    azurerm_role_assignment.monitoring_reader,
  ]

  lifecycle {
    # The Dynatrace API writes back fields (e.g. credentials[0].type and
    # connection state) after the connection activates. All API-managed fields
    # are declared explicitly above; ignore_changes = [value] prevents the
    # remaining server-side writebacks from showing as perpetual drift.
    # To push a config change:
    #   terraform apply -replace=dynatrace_hub_extension_v2_config.azure_connection
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# STEP 6 — Azure Logs and Events forwarder (optional; set enable_log_forwarder = true)
#
# Runs the canonical Dynatrace ARM template at a pinned commit, which deploys
# per monitored region into deployment_subscription_id:
#   - Resource group  rg-dt-<env-id>-<location>
#   - Event Hub namespace  evhns-dt-<env-id>-<location>-<suffix>  (Standard, auto-inflate)
#   - Event Hub  dt-logs-evh    (4 partitions) with "dynatrace" consumer group
#   - Event Hub  dt-events-evh  (1 partition)  with "dynatrace" consumer group
#   - Role assignment  Azure Event Hubs Data Receiver → Dynatrace SP
#
# Resources in any subscription under the management group can forward logs
# cross-subscription to these Event Hubs via Azure diagnostic settings.
#
# After apply, configure Azure diagnostic settings on your resources to forward
# logs to the dt-logs-evh Event Hub in the nearest region.
#
# To update the template version, re-vendor log_forwarder.arm.json (see the
# comment above template_content below).
# Docs: https://docs.dynatrace.com/docs/ingest-from/microsoft-azure-services/ingest-telemetry/azure-logs-and-events
# ---------------------------------------------------------------------------

# One resource group per monitored location, named to match what the ARM
# template would create. Terraform owning the RGs means `terraform destroy`
# cascade-deletes all Event Hub resources inside them — without this,
# destroying azurerm_subscription_template_deployment only removes the
# deployment record and leaves the actual resources orphaned in Azure.
resource "azurerm_resource_group" "dt_log_forwarder" {
  for_each = var.enable_log_forwarder ? toset(var.monitored_locations) : toset([])
  name     = "rg-dt-${local.dt_env_id}-${each.value}"
  location = each.value

  lifecycle {
    # The ARM template merges its own tags (managed-by: dynatrace) onto the RG
    # on every deployment. Let ARM own tag management to avoid perpetual drift.
    ignore_changes = [tags]
    # Prevent accidental cascade-deletion of everything inside the RG.
    # To destroy: remove this block, then re-run `terraform destroy`.
    prevent_destroy = true
  }
}

resource "azurerm_subscription_template_deployment" "dt_log_forwarder" {
  count    = var.enable_log_forwarder ? 1 : 0
  name     = "dt-log-forwarder-${local.dt_env_id}"
  location = var.monitored_locations[0]

  # Vendored from dynatrace-oss/cloud-snippets @ 2ad029333c5c12aa91c4cb110d7c23b863cec79f (2026-05-21)
  # To update: re-fetch from dynatrace-oss/cloud-snippets at the desired commit and strip JSONC comments
  template_content = file("${path.module}/log_forwarder.arm.json")

  parameters_content = jsonencode({
    locations                      = { value = var.monitored_locations }
    dtTenantId                     = { value = local.dt_env_id }
    dtConfigId                     = { value = local.monitoring_config_id }
    dtMonitoringServicePrincipalId = { value = azuread_service_principal.dynatrace.object_id }
    # Derive a stable 4-char suffix from the env ID so the namespace name is
    # deterministic across applies. Without this the template default uses
    # utcNow(), which would generate a new suffix — and a new namespace — on
    # every re-deployment.
    evhnsSuffix = { value = substr(local.dt_env_id, 0, 4) }
    # Explicit defaults — Azure stores all parameters (including those with
    # defaultValue) in the deployment and returns them on read. Without these,
    # Terraform would always see them as removed and produce a nonempty plan.
    skuName                  = { value = "Standard" }
    skuCapacity              = { value = 1 }
    maximumThroughputUnits   = { value = 10 }
    evhLogsPartitionCount    = { value = 4 }
    evhLogsRetentionInDays   = { value = 1 }
    evhEventsPartitionCount  = { value = 1 }
    evhEventsRetentionInDays = { value = 1 }
    tags                     = { value = {} }
  })

  depends_on = [
    dynatrace_hub_extension_v2_config.azure_connection,
    azurerm_resource_group.dt_log_forwarder,
  ]
}
