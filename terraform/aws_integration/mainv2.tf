locals {
  # CFN template URL is the same as your wget step, but Terraform can use it directly
  cfn_template_url = "https://dynatrace-data-acquisition.s3.amazonaws.com/aws/deployment/cfn/${var.cfn_template_version}/da-aws-activation.yaml"

  # Keep featureSets identical to the payload in awsmonv3.sh
  feature_sets = [
    "ApiGateway_essential", "ApplicationELB_essential", "AutoScaling_essential", "CloudFront_essential",
    "DynamoDB_essential", "EBS_essential", "EC2_essential", "ECR_essential", "ECS_essential", "EFS_essential",
    "ELB_essential", "ElastiCache_essential", "Firehose_essential", "Lambda_essential", "NATGateway_essential",
    "NetworkELB_essential", "PrivateLinkEndpoints_essential", "PrivateLinkServices_essential", "RDS_essential",
    "Route53_essential", "S3_essential", "SNS_essential", "SQS_essential"
  ]

  monitored_regions_trimmed = [for r in var.monitored_regions : trimspace(r)]
  logs_ingest_regions_csv   = join(",", [for r in var.dt_logs_ingest_regions : trimspace(r)])
}

# --- (A) Native Dynatrace: create the monitoring configuration (replaces curl) ---
# This resource configures a monitoring configuration for an extension and expects JSON in `value`. [2](https://registry.terraform.io/providers/dynatrace-oss/dynatrace/latest/docs/resources/hub_extension_config)
resource "dynatrace_hub_extension_config" "da_aws_monitoring_configuration" {
  name  = "com.dynatrace.extension.da-aws"
  scope = "integration-aws" # matches the scope in awsmonv3.sh

  # `value` corresponds to the inner "value" object your script posts (see awsmonv3.sh)
  value = jsonencode({
    enabled      = false
    description  = var.config_name
    version      = "0.1.6"
    featureSets  = local.feature_sets

    aws = {
      smartscapeConfiguration = {
        enabled = true
      }

      deploymentRegion = var.aws_region

      credentials = [
        {
          enabled      = false
          description  = var.config_name
          connectionId = "*"
          accountId    = var.aws_account_id
        }
      ]

      regionFiltering = local.monitored_regions_trimmed

      metricsConfiguration = {
        enabled = true
        regions = local.monitored_regions_trimmed
      }

      cloudWatchLogsConfiguration = {
        enabled = true
        regions = local.monitored_regions_trimmed
      }

      configurationMode         = "QUICK_START"
      deploymentScope           = "SINGLE_ACCOUNT"
      deploymentMode            = "AUTOMATED"
      manualDeploymentStatus    = "NA"
      automatedDeploymentStatus = "NA"
    }
  })
}

# --- (B) Native AWS: deploy activation CFN stack (replaces aws cloudformation deploy) ---
resource "aws_cloudformation_stack" "da_aws_activation" {
  name         = var.stack_name
  template_url = local.cfn_template_url

  capabilities = ["CAPABILITY_NAMED_IAM"]

  parameters = {
    pDynatraceUrl        = var.dynatrace_env_url

    # This is the key connection between steps:
    # Use the ID produced by the Dynatrace config resource as pMonitoringConfigId
    pMonitoringConfigId  = dynatrace_hub_extension_config.da_aws_monitoring_configuration.id

    # Tokens: keep these in your secret manager; variables are sensitive
    pDtApiToken          = var.dynatrace_api_token
    pDtIngestToken       = var.dynatrace_api_token  # if you have a separate ingest token, split this variable

    pDtLogsIngestEnabled = var.dt_logs_ingest_enabled ? "TRUE" : "FALSE"
    pDtLogsIngests       = local.logs_ingest_regions_csv
  }

  tags = {
    Project    = "da-aws"
    DeployedBy = "terraform"
    Config     = var.config_name
  }
}