output "connection_id" {
  description = "Dynatrace Azure connection object ID"
  value       = dynatrace_azure_connection.dynatrace.id
}

output "service_principal_app_id" {
  description = "Azure app (client) ID of the service principal Dynatrace assumes (servicePrincipalId in the monitoring config)"
  value       = azuread_application_registration.dynatrace.client_id
}

output "service_principal_object_id" {
  description = "Azure service principal object ID (the principal the Monitoring Reader role is assigned to)"
  value       = azuread_service_principal.dynatrace.object_id
}

output "monitoring_config_id" {
  description = "Dynatrace monitoring configuration ID (da-azure) — UUID only, suitable for use as dtConfigId in the log forwarder ARM template"
  value       = local.monitoring_config_id
}

output "log_forwarder_deployed_namespaces" {
  description = "Event Hub namespace names deployed by the log forwarder ARM template (one per monitored location). Empty list when enable_log_forwarder = false."
  value       = var.enable_log_forwarder ? jsondecode(azurerm_subscription_template_deployment.dt_log_forwarder[0].output_content).deployedNamespaces.value : []
}
