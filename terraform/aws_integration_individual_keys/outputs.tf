output "service_user_pool" {
  description = "Dynatrace service user UUIDs and their assigned account ranges"
  value = {
    for i, su in dynatrace_iam_service_user.pool : su.name => {
      uuid     = su.id
      accounts = slice(local.account_list, i * var.accounts_per_service_user, min((i + 1) * var.accounts_per_service_user, length(local.account_list)))
    }
  }
}

output "secret_arns" {
  description = "Secrets Manager ARNs for each account's platform tokens"
  value = {
    for account_id in local.account_list : account_id => {
      settings_token = aws_secretsmanager_secret.settings[account_id].arn
      ingest_token   = aws_secretsmanager_secret.ingest[account_id].arn
    }
  }
}

output "monitoring_config_ids" {
  description = "Dynatrace monitoring configuration IDs per account"
  value       = { for k, v in dynatrace_hub_extension_v2_config.aws_connection : k => v.id }
}

output "cloudformation_stack_ids" {
  description = "CloudFormation stack IDs per account"
  value       = { for k, v in aws_cloudformation_stack.aws_connection : k => v.id }
}

output "cloudformation_stack_outputs" {
  description = "Outputs exported by the CloudFormation activation stack per account (e.g. IAM role ARN, Lambda ARN)"
  value       = { for k, v in aws_cloudformation_stack.aws_connection : k => v.outputs }
}
