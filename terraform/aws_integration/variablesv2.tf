variable "config_name" {
  description = "Configuration name (letters, numbers, hyphens; must start with a letter)"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9-]*$", var.config_name))
    error_message = "config_name must start with a letter and contain only letters, numbers, and hyphens."
  }
}

variable "aws_account_id" {
  description = "AWS account ID (12-digit number)"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit number."
  }
}

variable "aws_region" {
  description = "Deployment region (e.g., us-east-2)"
  type        = string
  default     = "us-east-2"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must match AWS region pattern like us-east-1 or eu-central-1."
  }
}

variable "monitored_regions" {
  description = "Regions to monitor (list); bash script converted comma-separated input into an array"
  type        = list(string)

  validation {
    condition     = alltrue([for r in var.monitored_regions : can(regex("^[a-z]{2}-[a-z]+-[0-9]$", trimspace(r)))])
    error_message = "Each monitored region must match AWS region pattern like us-east-1."
  }
}

# Dynatrace tokens as Terraform variables instead of read -p prompts
variable "dynatrace_env_url" {
  description = "Dynatrace environment URL (used by provider via env var or explicit provider config)"
  type        = string
}

variable "dynatrace_api_token" {
  description = "Token with permissions to configure extensions (keep in secret manager; never commit)"
  type        = string
  sensitive   = true
}

# CloudFormation activation stack name + template version
variable "stack_name" {
  description = "CloudFormation stack name"
  type        = string
  default     = "kbiton-cli-demo"
}

variable "cfn_template_version" {
  description = "Dynatrace CFN template version (e.g., v0.8.4)"
  type        = string
  default     = "v0.8.4"
}

variable "dt_logs_ingest_enabled" {
  description = "Enable logs ingest in the CFN activation"
  type        = bool
  default     = true
}

variable "dt_logs_ingest_regions" {
  description = "Regions for logs ingest (CFN expects a comma-separated string)"
  type        = list(string)
  default     = ["us-east-1", "us-east-2"]
}