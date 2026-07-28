variable "aws_region" {
  description = "AWS region where Secrets Manager secrets and the CloudFormation activation stack are deployed"
  type        = string
  default     = "us-east-1"
}

variable "aws_accounts" {
  description = "Set of 12-digit AWS account IDs to onboard"
  type        = set(string)
  validation {
    condition     = alltrue([for id in var.aws_accounts : can(regex("^[0-9]{12}$", id))])
    error_message = "Each AWS account ID must be exactly 12 digits."
  }
}

# ---------------------------------------------------------------------------
# Dynatrace account-level credentials (Platform Tokens API)
# ---------------------------------------------------------------------------

variable "dt_account_uuid" {
  description = "Dynatrace account UUID. Found in Account Management > Account settings."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.dt_account_uuid))
    error_message = "dt_account_uuid must be a lowercase UUID, e.g. 405f3b12-4e9d-4cd6-ad1f-c7936a9b23fc."
  }
}

variable "dt_oauth_client_id" {
  description = "OAuth client ID used to generate platform tokens. See README for required scopes."
  type        = string
  sensitive   = true
}

variable "dt_oauth_client_secret" {
  description = "OAuth client secret. Pass via TF_VAR_dt_oauth_client_secret - never commit."
  type        = string
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Dynatrace environment credentials (Terraform provider + monitoring config)
# ---------------------------------------------------------------------------

variable "dt_env_url" {
  description = "Dynatrace environment URL (e.g. https://<env-id>.apps.dynatrace.com)"
  type        = string
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9.\\-]+\\.dynatrace\\.com$", var.dt_env_url))
    error_message = "dt_env_url must be a valid Dynatrace SaaS URL, e.g. https://abc123.apps.dynatrace.com."
  }
}

# ---------------------------------------------------------------------------
# Token lifecycle
# ---------------------------------------------------------------------------

variable "token_expiration_date" {
  description = "ISO 8601 expiration date for created platform tokens (e.g. 2027-08-01T00:00:00.000Z)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", var.token_expiration_date))
    error_message = "token_expiration_date must be ISO 8601 format with milliseconds: 2027-08-01T00:00:00.000Z"
  }
}

variable "accounts_per_service_user" {
  description = "Number of AWS accounts assigned to each Dynatrace service user. Each account uses 2 tokens; service user limit is 100. Default of 10 limits blast radius to 10 accounts if a service user is accidentally deleted."
  type        = number
  default     = 10
  validation {
    condition     = var.accounts_per_service_user >= 1
    error_message = "accounts_per_service_user must be at least 1."
  }
}

# ---------------------------------------------------------------------------
# AWS monitoring regions and features
# ---------------------------------------------------------------------------

variable "monitored_regions" {
  description = "AWS regions Dynatrace will monitor. Must include aws_region."
  type        = list(string)
  validation {
    condition     = length(var.monitored_regions) > 0
    error_message = "At least one monitored region is required."
  }
}

variable "feature_sets" {
  description = "da-aws extension feature sets to enable"
  type        = list(string)
  default = [
    "ApiGateway_essential",
    "ApplicationELB_essential",
    "AutoScaling_essential",
    "CloudFront_essential",
    "DynamoDB_essential",
    "EBS_essential",
    "EC2_essential",
    "ECR_essential",
    "ECS_essential",
    "EFS_essential",
    "ElastiCache_essential",
    "ELB_essential",
    "Firehose_essential",
    "Lambda_essential",
    "NATGateway_essential",
    "NetworkELB_essential",
    "PrivateLinkEndpoints_essential",
    "PrivateLinkServices_essential",
    "RDS_essential",
    "Route53_essential",
    "S3_essential",
    "SNS_essential",
    "SQS_essential",
  ]
}

# ---------------------------------------------------------------------------
# CloudWatch Logs ingest (Firehose push-based)
# ---------------------------------------------------------------------------

variable "logs_ingest_enabled" {
  description = "Enable push-based CloudWatch Logs ingest via Firehose"
  type        = bool
  default     = true
}

variable "logs_ingest_regions" {
  description = "Regions where Firehose log ingest is deployed. Defaults to monitored_regions when empty."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# CloudWatch Events / EventBridge ingest (optional)
#
# To enable: set events_ingest_enabled = true and uncomment the
# pDtEventsIngestEnabled / pDtEventsIngestRegions / pEventBridgeBusName /
# pEventSources parameters in the aws_cloudformation_stack block in main.tf,
# and uncomment the eventsConfiguration block in dynatrace_hub_extension_v2_config.
# ---------------------------------------------------------------------------

variable "events_ingest_enabled" {
  description = "Enable CloudWatch Events / EventBridge ingest via the CFN stack"
  type        = bool
  default     = false
}

variable "events_ingest_regions" {
  description = "Regions where EventBridge ingest is deployed. Defaults to monitored_regions when empty."
  type        = list(string)
  default     = []
}

variable "event_sources" {
  description = "Comma-separated EventBridge event sources to forward to Dynatrace. Only used when events_ingest_enabled = true."
  type        = string
  default     = "aws.ec2"
}

variable "event_bus_name" {
  description = "Existing EventBridge bus name to consume events from. Only used when events_ingest_enabled = true."
  type        = string
  default     = "default"
}

# ---------------------------------------------------------------------------
# CloudFormation stack
# ---------------------------------------------------------------------------

variable "stack_name_prefix" {
  description = "Prefix for CloudFormation stack names. Each account gets a stack named <prefix>-<account_id>."
  type        = string
  default     = "dynatrace-aws"
}

variable "dt_extension_version" {
  description = "Version of the com.dynatrace.extension.da-aws extension installed in the environment. Must match the installed version exactly. Query with: curl -H 'Authorization: Bearer <token>' 'https://<env>.apps.dynatrace.com/api/v2/extensions/com.dynatrace.extension.da-aws' | jq '.version'"
  type        = string
  default     = "1.0.0"
}

variable "tags" {
  description = "Tags applied to the CloudFormation stack and its resources"
  type        = map(string)
  default     = {}
}
