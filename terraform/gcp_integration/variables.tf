### Required inputs ###
variable "gcp_project" {
  type = string
}

variable "topic_name" {
  type = string
}

variable "subscription_name" {
  type = string
}

### Default variables ###
variable "role_id" {
  type = string
  default = "dynatrace_monitor.helm_deployment"
}

variable "role_title" {
  type = string
  default = "Dynatrace GCP Monitor helm deployment role"
}

variable "role_description" {
  type = string
  default = "Role for Dynatrace GCP Monitor helm and pubsub deployment"
}

### All default permissions are required for integration to function properly ###
variable "role_permissions" {
  type = list(string)
  default = [
    "container.clusters.get",
    "container.configMaps.create",
    "container.configMaps.delete",
    "container.configMaps.get",
    "container.configMaps.update",
    "container.deployments.create",
    "container.deployments.delete",
    "container.deployments.get",
    "container.deployments.update",
    "container.namespaces.create",
    "container.namespaces.get",
    "container.pods.get",
    "container.pods.list",
    "container.secrets.create",
    "container.secrets.delete",
    "container.secrets.get",
    "container.secrets.list",
    "container.secrets.update",
    "container.serviceAccounts.create",
    "container.serviceAccounts.delete",
    "container.serviceAccounts.get",
    "iam.roles.create",
    "iam.roles.list",
    "iam.roles.update",
    "iam.serviceAccounts.actAs",
    "iam.serviceAccounts.create",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.list",
    "iam.serviceAccounts.setIamPolicy",
    "pubsub.subscriptions.create",
    "pubsub.subscriptions.get",
    "pubsub.subscriptions.list",
    "pubsub.topics.attachSubscription",
    "pubsub.topics.create",
    "pubsub.topics.getIamPolicy",
    "pubsub.topics.list",
    "pubsub.topics.setIamPolicy",
    "pubsub.topics.update",
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
    "resourcemanager.projects.setIamPolicy",
    "serviceusage.services.enable",
    "serviceusage.services.get",
    "serviceusage.services.list",
    "serviceusage.services.use",
    ]
}