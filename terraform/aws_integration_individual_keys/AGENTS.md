# AI Coding Agent Instructions

## Project Overview

This is a Terraform module that onboards AWS accounts to the Dynatrace DA-AWS Clouds App in a single `terraform apply`. It handles the full provisioning chain: Dynatrace service users and platform tokens (which the Terraform provider cannot create), AWS Secrets Manager storage, Dynatrace monitoring configuration, and CloudFormation activation stack deployment.

Read [README.md](README.md) first for prerequisites, usage, and token rotation steps. This file is for anyone (human or agent) about to change the code.

The reference implementation this is modeled on: [kishikawa12/dt-cloud-integrations-terraform](https://github.com/kishikawa12/dt-cloud-integrations-terraform/tree/main/aws/account/). Resources from that repo were folded directly into this module rather than called via a Git source to avoid child-module provider conflicts and data-source timing problems.

## Files

- `main.tf` — all resources: service user pool, Secrets Manager secrets, token provisioner (`terraform_data` + `local-exec`), Dynatrace monitoring config (`dynatrace_hub_extension_v2_config`), and CloudFormation activation stack.
- `variables.tf` — all input variables with validations. Events ingest variables are defined here but feed commented-out code in main.tf.
- `outputs.tf` — service user pool, secret ARNs, monitoring config IDs, CFN stack IDs and outputs.
- `providers.tf` — provider requirements (dynatrace >= 1.64.0, aws ~> 5.0, terraform >= 1.6.0) and credential comments.
- `terraform.tfvars.example` — copy to `terraform.tfvars` and fill in.

## Working with this repo

```bash
cp terraform.tfvars.example terraform.tfvars
# fill in terraform.tfvars

# Dynatrace provider credentials (read by the provider from env)
export DT_ENV_URL="https://<environment-id>.apps.dynatrace.com"
export DT_CLIENT_ID="dt0s02.XXXXXXXXXX"
export DT_CLIENT_SECRET="dt0s02.XXXXXXXXXX.XXXXXXXXXX..."

# Same OAuth client for local-exec (provider can't pass these to provisioners)
export TF_VAR_dt_oauth_client_id="dt0s02.XXXXXXXXXX"
export TF_VAR_dt_oauth_client_secret="dt0s02.XXXXXXXXXX.XXXXXXXXXX..."

terraform init
terraform plan
terraform apply -parallelism=5   # limit concurrent local-exec calls to avoid DT API rate limits
```

The DA-AWS extension must be enabled in the target Dynatrace environment before the first apply. See README step 1 for the one-time curl.

Local dependencies required on the machine running `terraform apply`: `curl`, `jq`.

## Gotchas discovered the hard way (don't rediscover these)

1. **`pMonitoringConfigId` MUST be the Dynatrace-assigned UUID, not the account ID or scope string.** The CFN Lambda calls `GET/PUT https://<dt-env>/platform/extensions/v1/com.dynatrace.extension.da-aws/monitoring-configuration/{objectId}` using this value as a URL path parameter. The Terraform provider stores the resource ID as `<extension_name>#-#<objectId>` - the extraction `element(split("#-#", dynatrace_hub_extension_v2_config.aws_connection[each.key].id), 1)` is not fragile style - it is load-bearing correctness. Replacing it with `each.key` (the 12-digit account ID) causes a 404 on every Lambda invocation, the CFN custom resource reports FAILED, and the stack rolls back. This was verified by reading the CFN Lambda source from `da-aws-activation.yaml v0.8.4`.

2. **`ignore_changes = [value]` on `dynatrace_hub_extension_v2_config` is non-negotiable.** The CFN Lambda writes back `connectionId` and flips `enabled` to true after registering the IAM role with Dynatrace HAS. If Terraform reverted those fields, the live connection would break. Side effect: changes to `monitored_regions`, `feature_sets`, `logs_ingest_enabled`, etc. made after the initial apply will show no plan diff. To apply such changes, force replacement: `terraform apply -replace='dynatrace_hub_extension_v2_config.aws_connection["<account-id>"]'`.

3. **Two credential mechanisms, one OAuth client.** The Dynatrace provider reads from shell env (`DT_CLIENT_ID`, `DT_CLIENT_SECRET`). The `local-exec` provisioner runs in a clean environment and cannot inherit shell state - it reads from Terraform variables (`var.dt_oauth_client_id`, `var.dt_oauth_client_secret`). Both `DT_CLIENT_*` and `TF_VAR_dt_oauth_client_*` must be set before `terraform plan`. They point to the same OAuth client.

4. **Sensitive values in `local-exec` pass via `environment =`, not command arguments.** The `DT_CLIENT_SECRET` and `dt_oauth_client_secret` are set in the provisioner `environment` block, not interpolated into the shell command string, so they never appear in process listings or audit logs. Don't move them inline.

5. **`prevent_destroy = true` on service users means `terraform destroy` will fail intentionally.** Deleting a `dynatrace_iam_service_user` cascades to all its platform tokens instantly with no warning. The lifecycle guard is there to prevent accidental destruction at 100-account scale. To intentionally decommission: remove `prevent_destroy` from `main.tf`, run `terraform apply`, then proceed.

6. **`recovery_window_in_days = 0` on Secrets Manager resources requires `secretsmanager:DeleteSecret` IAM permission.** Without it, destroy fails with `AccessDeniedException`. The permission is listed in README prerequisites and providers.tf comments. The zero window also means re-applying within 30 days after a destroy works correctly - the default 30-day pending deletion state would otherwise block recreation.

7. **Events ingest is scaffolded but not wired.** Variables `events_ingest_enabled`, `events_ingest_regions`, `event_sources`, and `event_bus_name` are defined and locals `effective_events_regions` / `events_ingest_regions_csv` are computed. The corresponding CFN parameters (`pDtEventsIngestEnabled`, `pDtEventsIngestRegions`, `pEventBridgeBusName`, `pEventSources`) and the `eventsConfiguration` block in `dynatrace_hub_extension_v2_config` are present as commented-out code. To enable events ingest, uncomment those blocks together - they are atomic (comment or both uncomment; partial is broken).

8. **Pool assignment uses `floor(index / accounts_per_service_user)`.** The account list is `sort(tolist(var.aws_accounts))` - stable across applies. Adding new accounts to the set shifts no existing assignments as long as the new account ID sorts after existing ones that are near pool boundaries. Removing an account from the middle of the list shifts indexes and will cause `triggers_replace` to fire for accounts that moved pools, reprovisioning their tokens.

9. **`pMonitoringConfigId` shows `(known after apply)` in the first plan.** This is expected. The UUID is assigned by Dynatrace at creation time. The CFN stack resource correctly depends on `dynatrace_hub_extension_v2_config` being applied first.

10. **CFN template version is pinned to `v0.8.4` in `main.tf`.** The template URL is `https://dynatrace-data-acquisition.s3.amazonaws.com/aws/deployment/cfn/v0.8.4/da-aws-activation.yaml`. The Lambda source and parameter names in this module were validated against this version. Check for newer versions before production use - parameter names can change between template versions.

## Verification approach

There is no CI for this - testing means applying against real AWS accounts with real Dynatrace credentials:

```bash
# Single account smoke test before full rollout
aws_accounts = ["<your-test-account-id>"]

terraform apply -parallelism=1

# Watch the CFN stack reach CREATE_COMPLETE
aws cloudformation describe-stacks --stack-name "dynatrace-aws-<account-id>" \
  --query 'Stacks[0].StackStatus'

# Confirm the monitoring config got its connectionId written back by the Lambda
terraform show -json | jq '.values.root_module.resources[] |
  select(.type == "dynatrace_hub_extension_v2_config") |
  .values.value' | jq '.aws.credentials[0].connectionId'
```

A `connectionId` value other than `"*"` means the Lambda successfully registered the IAM role with Dynatrace HAS. Allow up to 5 minutes, then check **Infrastructure > AWS** in the Dynatrace UI for the account connection status.

## Where to pick this up

- **Not tested end-to-end yet.** The module was built by combining the reference repo's confirmed-working resources with the token provisioning layer. It has not been applied against a real account. A single-account smoke test is the highest-priority next step.
- **Events ingest untested.** Even after uncommenting, the EventBridge → Firehose → Dynatrace path has not been exercised. Start with a non-production bus.
- **CFN template version.** Verify `v0.8.4` is still current before production rollout. The `da-aws-activation.yaml` S3 bucket may have newer versions with additional parameters.
- **Cross-account credential handling.** The `aws` provider runs with a single credential context. Multi-account deployments that require per-account IAM assume-role need a wrapper calling this module once per account. See README for the pattern.
