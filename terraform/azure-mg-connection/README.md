# azure/mg — Azure Management Group Connection

Connects an Azure management group to Dynatrace using the hyperscaler cloud connection model (da-azure extension v1.1.7). Terraform provisions the Azure-side identity, grants it read access at the management group scope (cascading to all subscriptions beneath it), registers the connection in Dynatrace, and creates the monitoring configuration.

For single-subscription coverage see [azure-sub-connection](../azure-sub-connection/).

## Architecture

```
Terraform
  ├── Azure AD: app registration + service principal       (the identity Dynatrace assumes)
  ├── Azure RBAC: Monitoring Reader role on the management group  (cascades to all child subscriptions)
  ├── Dynatrace: connection object                         (federated identity OR client secret)
  │     └── [federated] Azure federated credential + connection authentication binding
  └── Dynatrace: monitoring configuration                  (da-azure extension v1.1.7)
```

## Authentication

Set `auth_type` to choose how Dynatrace authenticates as the service principal:

- **`federatedIdentityCredential`** (default, recommended) — passwordless. Azure trusts a Dynatrace-issued OIDC token whose subject is bound to the connection ID (issuer `https://token.dynatrace.com`). No secret is stored or rotated.
- **`clientSecret`** — Terraform generates a client secret and stores it in the Dynatrace connection object. Simpler, but a long-lived secret you must rotate.

## Prerequisites

- Terraform ≥ 1.6.0
- **azuread** + **azurerm** providers authenticated (e.g. `az login`) as an identity that can:
  - create app registrations in the Entra tenant, and
  - create role assignments on the management group (**Owner** or **User Access Administrator** at the management group scope)
- Dynatrace provider authenticated via `DT_*` env vars:
  - OAuth: `DT_CLIENT_ID` + `DT_CLIENT_SECRET` with scopes `settings:objects:read`, `settings:objects:write`, `extensions:configurations:read`, `extensions:configurations:write`
  - or platform token: `DT_PLATFORM_TOKEN`
- Azure extension (`com.dynatrace.extension.da-azure`) enabled in your Dynatrace environment (first run only — see [main.tf](main.tf) prerequisite block)

## Usage

```bash
cd terraform/cloud/azure-mg-connection
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

az login   # azuread/azurerm credentials

# Dynatrace provider auth (choose one)
export DT_ENV_URL="https://<env-id>.apps.dynatrace.com"
export DT_CLIENT_ID="..."
export DT_CLIENT_SECRET="..."
# or: export DT_PLATFORM_TOKEN="..."

terraform init
terraform plan
terraform apply
```

## Variables

### Required

| Name | Description |
|------|-------------|
| `dt_env_url` | Dynatrace environment URL, e.g. `https://<env-id>.apps.dynatrace.com` |
| `connection_name` | Human-readable label (letters, numbers, hyphens; must start with a letter) |
| `tenant_id` | Azure tenant (directory) ID (GUID) |
| `management_group_id` | Azure management group ID (e.g. `my-management-group` — the ID, not the display name or full resource path) |
| `deployment_subscription_id` | Subscription where the azurerm provider operates and (when `enable_log_forwarder = true`) where Event Hub resources are created. Does **not** limit the monitoring scope. |
| `monitored_locations` | List of Azure region names, e.g. `["eastus", "westeurope"]` (at least one required) |

### Optional

| Name | Default | Description |
|------|---------|-------------|
| `auth_type` | `"federatedIdentityCredential"` | `federatedIdentityCredential` (recommended) or `clientSecret` |
| `dynatrace_token_issuer` | `"https://token.dynatrace.com"` | OIDC issuer Azure trusts (federated auth only) |
| `app_display_name` | `"Dynatrace-Monitoring"` | Display name of the Azure AD app registration |
| `monitoring_config_scope` | `"integration-azure"` | Dynatrace scope for the monitoring configuration |
| `subscription_ids` | `[]` | Filter monitoring to specific subscriptions within the MG (empty = all subscriptions) |
| `enable_log_forwarder` | `false` | Deploy Event Hub log/event forwarding infrastructure in each monitored location (see [Logs and events](#logs-and-events)) |
| `feature_sets` | 17 core Azure services (see below) | da-azure v1.1.7 feature sets to enable |

### Default feature sets

`microsoft_compute.virtualmachines_essential`, `microsoft_compute.virtualmachinescalesets_essential`, `microsoft_web.sites_app_essential`, `microsoft_web.sites_functionapp_essential`, `microsoft_web.serverfarms_essential`, `microsoft_containerservice.managedclusters_essential`, `microsoft_sql.servers.databases_essential`, `microsoft_dbforpostgresql.flexibleservers_essential`, `microsoft_dbformysql.flexibleservers_essential`, `microsoft_documentdb.databaseaccounts_essential`, `microsoft_storage.storageaccounts_essential`, `microsoft_network.loadbalancers_essential`, `microsoft_network.applicationgateways_essential`, `microsoft_cache.redis_essential`, `microsoft_servicebus.namespaces_essential`, `microsoft_eventhub.namespaces_essential`, `microsoft_keyvault.vaults_essential`

### Advanced configuration

[main.tf](main.tf) contains commented-out blocks for all optional fields: `configurationMode` (QUICK_START / ADVANCED), `deploymentScope`, `smartscapeConfiguration`, `metricsConfiguration`, `tagEnrichment`, `tagFiltering`, `dtLabelsEnrichment` (map Azure tags to Dynatrace cost/security labels), `eventHubsConfiguration` (Event Hub push-based ingest), and `namespaces` (custom Azure Monitor namespaces for ADVANCED mode). [variables.tf](variables.tf) documents every valid `feature_sets` identifier for da-azure v1.1.7.

## Logs and events

Set `enable_log_forwarder = true` to deploy the Event Hub infrastructure required for Azure log and event ingestion. Per each entry in `monitored_locations`, Terraform creates the following resources in `deployment_subscription_id`:

- Resource group `rg-dt-<env-id>-<location>`
- Event Hub namespace `evhns-dt-<env-id>-<location>-<suffix>` (Standard tier, auto-inflate)
- Event Hub `dt-logs-evh` (4 partitions) with a `dynatrace` consumer group
- Event Hub `dt-events-evh` (1 partition) with a `dynatrace` consumer group
- `Azure Event Hubs Data Receiver` role assignment for the Dynatrace service principal

Resources in any subscription under the management group can forward logs cross-subscription to these Event Hubs. After `terraform apply`, configure [Azure diagnostic settings](https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/diagnostic-settings) on your resources to forward logs and activity events to the `dt-logs-evh` Event Hub in the nearest deployed region. Dynatrace auto-discovers the namespaces via the `managed-by: dynatrace` resource tag applied by the ARM template.

[`log_forwarder.arm.json`](log_forwarder.arm.json) is sourced from [`dynatrace-oss/cloud-snippets — azure/event-hub-deployment`](https://github.com/dynatrace-oss/cloud-snippets/tree/main/azure/event-hub-deployment) and is vendored in this module directory so Terraform can reference it locally without a network fetch at apply time.

## Outputs

| Name | Description |
|------|-------------|
| `connection_id` | Dynatrace Azure connection object ID |
| `service_principal_app_id` | App (client) ID of the service principal Dynatrace assumes |
| `service_principal_object_id` | Service principal object ID (holder of the Monitoring Reader role) |
| `monitoring_config_id` | Dynatrace da-azure monitoring configuration ID |
| `log_forwarder_deployed_namespaces` | Event Hub namespace names deployed by the log forwarder (one per monitored location); empty list when `enable_log_forwarder = false` |
