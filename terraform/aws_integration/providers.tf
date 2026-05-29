terraform {
  required_version = ">= 1.6.0"

  required_providers {
    dynatrace = {
      source  = "dynatrace-oss/dynatrace"
      version = "~> 1.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Dynatrace provider is typically configured with env vars:
#   DYNATRACE_ENV_URL
#   DYNATRACE_API_TOKEN
# (Terraform Registry provider docs describe this pattern) [3](https://registry.terraform.io/providers/dynatrace-oss/dynatrace/latest/docs)
provider "dynatrace" {}

provider "aws" {
  region = var.aws_region
}