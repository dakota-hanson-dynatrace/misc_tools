resource "google_project_iam_custom_role" "dynatrace_monitor_helm_deployment" {
  project     = var.gcp_project  
  role_id     = var.role_id
  title       = var.role_title
  description = var.role_description
  permissions = var.role_permissions
}

resource "google_pubsub_topic" "dynatrace_monitor_pubsub_topic" {
  project = var.gcp_project
  name = var.topic_name
}

resource "google_pubsub_subscription" "dynatrace_monitor_pubsub_subscription" {
  project = var.gcp_project
  name  = var.subscription_name
  topic = google_pubsub_topic.dynatrace_monitor_pubsub_topic.id


  # 1 day
  message_retention_duration = "86600s"
  retain_acked_messages      = false

  ack_deadline_seconds = 120
}