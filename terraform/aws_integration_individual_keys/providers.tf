terraform {
  required_version = ">= 1.6.0"

  required_providers {
    dynatrace = {
      # dynatrace_iam_service_user was introduced in 1.64.0.
      # Do not lower this bound without verifying the resource exists in that version.
      source  = "dynatrace-oss/dynatrace"
      version = ">= 1.64.0, < 2.0.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Dynatrace provider
#
# Configure via environment variables:
#   export DT_ENV_URL="https://<environment-id>.apps.dynatrace.com"
#   export DT_CLIENT_ID="<oauth-client-id>"
#   export DT_CLIENT_SECRET="<oauth-client-secret>"
#
# Required OAuth scopes for the provider:
#   account-idm-read               (list dynatrace_iam_service_user)
#   account-idm-write              (create/update dynatrace_iam_service_user)
#   extensions:configurations:read  (read dynatrace_hub_extension_v2_config)
#   extensions:configurations:write (create/update dynatrace_hub_extension_v2_config)
# ---------------------------------------------------------------------------

provider "dynatrace" {}

# ---------------------------------------------------------------------------
# AWS provider
#
# Credentials resolved from the standard AWS credential chain.
# The executing role needs:
#   secretsmanager:CreateSecret
#   secretsmanager:PutSecretValue
#   secretsmanager:GetSecretValue
#   secretsmanager:DescribeSecret
#   secretsmanager:DeleteSecret  (required - recovery_window_in_days=0 uses immediate deletion)
# ---------------------------------------------------------------------------

provider "aws" {
  region = var.aws_region
}
