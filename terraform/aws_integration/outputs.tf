output "monitoring_config_id" {
  description = "ID of the created Dynatrace monitoring configuration (used by CFN)"
  value       = dynatrace_hub_extension_config.da_aws_monitoring_configuration.id
}

output "cloudformation_stack_id" {
  description = "ID of the AWS activation stack"
  value       = aws_cloudformation_stack.da_aws_activation.id
}