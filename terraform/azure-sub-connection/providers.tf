terraform {
  required_version = ">= 1.6.0"

  required_providers {
    dynatrace = {
      # https://registry.terraform.io/providers/dynatrace-oss/dynatrace/latest
      source  = "dynatrace-oss/dynatrace"
      version = "~> 1.0"
    }
    azuread = {
      # https://registry.terraform.io/providers/hashicorp/azuread/latest
      source  = "hashicorp/azuread"
      version = "~> 3.1"
    }
    azurerm = {
      # https://registry.terraform.io/providers/hashicorp/azurerm/latest
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Dynatrace provider
# Configure via environment variables (preferred — never commit tokens):
#
# OPTION 1 (RECOMMENDED): OAuth client credentials
#   export DT_ENV_URL="https://<environment-id>.apps.dynatrace.com"
#   export DT_CLIENT_ID="<oauth-client-id>"
#   export DT_CLIENT_SECRET="<oauth-client-secret>"
#
# OPTION 2: Platform token
#   export DT_ENV_URL="https://<environment-id>.apps.dynatrace.com"
#   export DT_PLATFORM_TOKEN="<platform-token>"
#
# Create OAuth client in Dynatrace:
#   Settings > Account Settings > Identity & access management > OAuth clients
#
# Required scopes for this configuration:
#   settings:objects:read            (read the Azure connection object)
#   settings:objects:write           (write the Azure connection object)
#   extensions:configurations:read   (read the monitoring configuration)
#   extensions:configurations:write  (write the monitoring configuration)
# ---------------------------------------------------------------------------
provider "dynatrace" {
}

# ---------------------------------------------------------------------------
# Azure AD (Microsoft Entra ID) provider — creates the app registration,
# service principal, and credential (federated or secret) for the connection.
#
# Credentials resolve from the standard Azure credential chain (az login,
# ARM_* environment variables, managed identity, etc.). The signed-in
# identity needs permission to create app registrations in the tenant.
# ---------------------------------------------------------------------------
provider "azuread" {
  tenant_id = var.tenant_id
}

# ---------------------------------------------------------------------------
# Azure Resource Manager provider — assigns the Monitoring Reader role on the
# target subscription. The signed-in identity needs Owner or User Access
# Administrator on the subscription to create role assignments.
#
# azurerm v4 requires subscription_id to be set explicitly.
# ---------------------------------------------------------------------------
provider "azurerm" {
  features {
    resource_group {
      # The log forwarder RGs contain Event Hub resources created by the ARM
      # template deployment. Those resources are not tracked individually in
      # Terraform state but are intentionally owned by this workspace — allow
      # cascade-deletion when the resource group is destroyed.
      prevent_deletion_if_contains_resources = false
    }
  }
  subscription_id = var.subscription_id
}
