locals {
  # Sort for stable index assignment - the same account ID always maps to the
  # same service user across applies, including when new accounts are added.
  account_list = sort(tolist(var.aws_accounts))
  pool_size    = ceil(length(local.account_list) / var.accounts_per_service_user)

  extension_name       = "com.dynatrace.extension.da-aws"
  extension_version    = var.dt_extension_version
  cfn_template_version = "v0.8.4"
  cfn_template_url     = "https://dynatrace-data-acquisition.s3.amazonaws.com/aws/deployment/cfn/${local.cfn_template_version}/da-aws-activation.yaml"

  # Fall back to monitored_regions when per-feature region lists are not set.
  effective_logs_regions    = length(var.logs_ingest_regions) > 0 ? var.logs_ingest_regions : var.monitored_regions
  effective_events_regions  = length(var.events_ingest_regions) > 0 ? var.events_ingest_regions : var.monitored_regions
  logs_ingest_regions_csv   = join(",", local.effective_logs_regions)
  events_ingest_regions_csv = join(",", local.effective_events_regions)
}

# ---------------------------------------------------------------------------
# Service user pool
#
# One service user per N accounts (default 10). Limits blast radius -
# accidental deletion of a service user cascades to all its tokens instantly,
# taking down every account in that pool. prevent_destroy blocks Terraform
# from ever deleting these.
#
# To intentionally decommission: remove prevent_destroy, apply, then delete.
# ---------------------------------------------------------------------------

resource "dynatrace_iam_service_user" "pool" {
  count       = local.pool_size
  name        = "aws-integration-pool-${count.index}"
  description = "Platform token pool for AWS integration - account list indexes ${count.index * var.accounts_per_service_user} to ${(count.index * var.accounts_per_service_user) + var.accounts_per_service_user - 1}"

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Secrets Manager secrets (one settings + one ingest token per account)
#
# Created empty here. The local-exec provisioner below populates the values
# by calling the Dynatrace Platform Tokens API.
#
# recovery_window_in_days = 0 enables immediate deletion on destroy.
# Without this, re-applying within 30 days after a destroy fails with
# InvalidRequestException because AWS holds the secret name in a pending
# deletion state.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "settings" {
  for_each                = toset(local.account_list)
  name                    = "dynatrace/${each.key}/settings-token"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "ingest" {
  for_each                = toset(local.account_list)
  name                    = "dynatrace/${each.key}/ingest-token"
  recovery_window_in_days = 0
}

# ---------------------------------------------------------------------------
# Token creation
#
# Calls the Dynatrace Platform Tokens API at account onboarding time and
# stores the result directly in Secrets Manager. Skips creation if the
# secret already has a value - safe to re-run.
#
# The Dynatrace Terraform provider has no platform token resource. This
# local-exec is the only automated path.
#
# Pool assignment uses floor division so each service user owns a contiguous
# sequential block of accounts matching the description and outputs.
# ---------------------------------------------------------------------------

resource "terraform_data" "tokens" {
  for_each = toset(local.account_list)

  # stable trigger - only re-runs if the account or its assigned service user changes
  triggers_replace = {
    account_id   = each.key
    service_user = dynatrace_iam_service_user.pool[floor(index(local.account_list, each.key) / var.accounts_per_service_user)].id
  }

  provisioner "local-exec" {
    # Sensitive values passed via environment variables, not command arguments,
    # so they do not appear in process listings or audit logs.
    environment = {
      DT_CLIENT_ID      = var.dt_oauth_client_id
      DT_OAUTH_SECRET   = var.dt_oauth_client_secret
      DT_ACCOUNT_UUID   = var.dt_account_uuid
      TOKEN_EXPIRY      = var.token_expiration_date
      ACCOUNT_ID        = each.key
      SU_UUID           = dynatrace_iam_service_user.pool[floor(index(local.account_list, each.key) / var.accounts_per_service_user)].id
    }

    command = <<-EOT
      set -e

      ACCESS_TOKEN=$(curl -sf -X POST "https://sso.dynatrace.com/sso/oauth2/token" \
        --data-urlencode "grant_type=client_credentials" \
        --data-urlencode "client_id=$DT_CLIENT_ID" \
        --data-urlencode "client_secret=$DT_OAUTH_SECRET" \
        --data-urlencode "scope=platform-token:tokens:write platform-token:tokens:manage iam:service-users:use" \
        --data-urlencode "resource=urn:dtaccount:$DT_ACCOUNT_UUID" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        | jq -r '.access_token')

      if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
        echo "[$ACCOUNT_ID] ERROR: OAuth token fetch failed - check DT_CLIENT_ID, DT_OAUTH_SECRET, DT_ACCOUNT_UUID"
        exit 1
      fi

      create_token() {
        local NAME=$1 SCOPE=$2 SM_PATH=$3

        # idempotency check - skip if secret already has a value
        EXISTING=$(aws secretsmanager get-secret-value \
          --secret-id "$SM_PATH" \
          --query SecretString \
          --output text 2>/dev/null || echo "")

        if [ -n "$EXISTING" ]; then
          echo "[$ACCOUNT_ID] $NAME already present in Secrets Manager - skipping"
          return
        fi

        TOKEN=$(curl -sf -X POST \
          "https://api.dynatrace.com/iam/v1/accounts/$DT_ACCOUNT_UUID/platform-tokens" \
          -H "Authorization: Bearer $ACCESS_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{
            \"name\": \"aws-$ACCOUNT_ID-$NAME\",
            \"userUuid\": \"$SU_UUID\",
            \"scope\": $SCOPE,
            \"resource\": [\"urn:dtaccount:$DT_ACCOUNT_UUID\"],
            \"expirationDate\": \"$TOKEN_EXPIRY\"
          }" | jq -r '.token')

        # guard against null or empty token before writing to Secrets Manager.
        # a null written here would pass the idempotency check on re-runs,
        # permanently storing an invalid token with no further error.
        if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
          echo "[$ACCOUNT_ID] ERROR: token extraction failed for $NAME - API may have returned an unexpected response"
          exit 1
        fi

        aws secretsmanager put-secret-value \
          --secret-id "$SM_PATH" \
          --secret-string "$TOKEN"

        echo "[$ACCOUNT_ID] $NAME created and stored in $SM_PATH"
      }

      create_token "settings" \
        '["settings:objects:read","settings:objects:write","extensions:configurations:read","extensions:configurations:write"]' \
        "dynatrace/$ACCOUNT_ID/settings-token"

      create_token "ingest" \
        '["logs:ingest","metrics:ingest"]' \
        "dynatrace/$ACCOUNT_ID/ingest-token"
    EOT
  }

  depends_on = [
    aws_secretsmanager_secret.settings,
    aws_secretsmanager_secret.ingest,
  ]
}

# ---------------------------------------------------------------------------
# Dynatrace monitoring configuration
#
# One config per AWS account. scope = account ID ensures uniqueness across
# accounts and lets the CFN Lambda look up the config by account ID.
#
# The CFN Lambda writes back credentials[0].connectionId and flips
# credentials[0].enabled to true after it registers the IAM role with
# Dynatrace HAS. ignore_changes = [value] prevents Terraform from reverting
# those live fields on re-apply.
# ---------------------------------------------------------------------------

resource "dynatrace_hub_extension_v2_config" "aws_connection" {
  for_each = toset(local.account_list)

  name  = local.extension_name
  scope = each.key

  value = jsonencode({
    enabled           = true
    activationContext = "DATA_ACQUISITION"
    description       = "aws-${each.key}"
    version           = local.extension_version
    featureSets       = var.feature_sets

    aws = {
      credentials = [
        {
          description  = "aws-${each.key}"
          enabled      = false
          connectionId = "*"
          accountId    = each.key
          # rootOrganizationId = "o-xxxxxxxxxx"           # required when deploymentScope = "ORGANIZATION"
          # parentConfigurationId = "xxxxxxxx-xxxx-..."   # org template config ID for member accounts
          # overrideParentConfiguration = false           # set true to override org template per-account
        }
      ]

      regionFiltering  = var.monitored_regions
      deploymentRegion = var.aws_region
      deploymentScope  = "SINGLE_ACCOUNT"
      deploymentMode   = "MANUAL"
      manualDeploymentStatus             = "COMPLETE"
      automatedDeploymentStatus          = "NA"
      automatedDeploymentTemplateVersion = local.cfn_template_version
      configurationMode                  = "QUICK_START"

      smartscapeConfiguration = { enabled = true }

      metricsConfiguration = {
        enabled = true
        regions = var.monitored_regions
      }

      cloudWatchLogsConfiguration = {
        enabled = var.logs_ingest_enabled
        regions = local.effective_logs_regions
      }

      # eventsConfiguration - uncomment together with the pDtEventsIngest* CFN parameters below
      # eventsConfiguration = {
      #   enabled = var.events_ingest_enabled
      #   regions = local.effective_events_regions
      # }

      # tagEnrichment - written back by the API as [] on first apply; kept explicit to prevent drift
      tagEnrichment = []
      # tagEnrichment = ["CostCenter", "Team", "Environment"]

      # tagFiltering - written back by the API as [] on first apply; kept explicit to prevent drift
      tagFiltering = []
      # tagFiltering = [
      #   { key = "Environment", value = "production", condition = "INCLUDE" }
      # ]

      # dtLabelsEnrichment - map AWS resource tags to Dynatrace enrichment labels
      # dtLabelsEnrichment = {
      #   "dt.security_context" = { tagKey = "SecurityContext" }
      #   "dt.cost.costcenter"  = { tagKey = "CostCenter" }
      # }

      # ingestPercentileMetrics = false  # adds P95/P99 stats; increases CloudWatch API calls
      # ingestS3StorageLENSMetrics = false  # ingested at most once per 24h window

      # namespaces - written back by the API as [] on first apply; only used in ADVANCED configurationMode
      namespaces = []
    }
  })

  lifecycle {
    # The CFN Lambda writes back connectionId and enabled after IAM role
    # registration. Reverting those would break the live connection.
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# CloudFormation activation stack
#
# Deploys the Dynatrace-provided template that creates the IAM monitoring
# role, Secrets Manager secrets, and Lambda integration inside each AWS
# account.
#
# Tokens are passed via {{resolve:secretsmanager:...}} so CloudFormation
# resolves them at stack execution time - Terraform never holds the raw
# token value. depends_on ensures local-exec has written the tokens to
# Secrets Manager before CFN tries to resolve them.
#
# ignore_changes on the two token parameters is required because CFN marks
# them NoEcho and returns "****" on reads, which would cause perpetual drift.
# ---------------------------------------------------------------------------

resource "aws_cloudformation_stack" "aws_connection" {
  for_each = toset(local.account_list)

  name         = "${var.stack_name_prefix}-${each.key}"
  template_url = local.cfn_template_url
  capabilities = ["CAPABILITY_NAMED_IAM"]

  parameters = {
    pDynatraceUrl       = var.dt_env_url
    # The provider encodes the resource ID as "<extension_name>#-#<objectId>" where
    # objectId is the UUID Dynatrace assigns at creation time. The CFN Lambda calls
    # GET/PUT /platform/extensions/v1/.../monitoring-configuration/{objectId} - it
    # needs the UUID, not the scope string and not the account ID.
    pMonitoringConfigId = element(split("#-#", dynatrace_hub_extension_v2_config.aws_connection[each.key].id), 1)
    pDtApiToken         = "{{resolve:secretsmanager:dynatrace/${each.key}/settings-token}}"
    pDtIngestToken      = "{{resolve:secretsmanager:dynatrace/${each.key}/ingest-token}}"
    pDtLogsIngestEnabled = var.logs_ingest_enabled ? "TRUE" : "FALSE"
    pDtLogsIngestRegions = local.logs_ingest_regions_csv

    # Uncomment together with eventsConfiguration in dynatrace_hub_extension_v2_config above
    # pDtEventsIngestEnabled = var.events_ingest_enabled ? "TRUE" : "FALSE"
    # pDtEventsIngestRegions = local.events_ingest_regions_csv
    # pEventBridgeBusName    = var.event_bus_name
    # pEventSources          = var.event_sources

    # pUseCMK = "FALSE"  # set to "TRUE" to use a customer-managed KMS key for secrets, logs, and S3
  }

  disable_rollback   = false
  timeout_in_minutes = 30
  tags               = var.tags

  lifecycle {
    precondition {
      condition     = contains(var.monitored_regions, var.aws_region)
      error_message = "monitored_regions must include aws_region (${var.aws_region}) - the CFN stack deploys there and metrics from that region will not be collected otherwise."
    }
    ignore_changes = [
      parameters["pDtApiToken"],
      parameters["pDtIngestToken"],
    ]
  }

  depends_on = [terraform_data.tokens]
}
