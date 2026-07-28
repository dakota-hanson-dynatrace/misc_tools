# aws_tf_integration_keys

Terraform module that onboards AWS accounts to the Dynatrace DA-AWS Clouds App in a single `terraform apply`. Handles token provisioning, Secrets Manager storage, Dynatrace monitoring configuration, and CloudFormation activation stack deployment together.

## Why this exists

The Dynatrace AWS integration (modeled on [kishikawa12/dt-cloud-integrations-terraform](https://github.com/kishikawa12/dt-cloud-integrations-terraform/tree/main/aws)) requires two Dynatrace platform tokens per account at CloudFormation stack deployment time:

- `pDtApiToken` - settings token (`settings:objects:read/write`, `extensions:configurations:read/write`)
- `pDtIngestToken` - ingest token (`logs:ingest`, `metrics:ingest`)

**The problem:** the Dynatrace Terraform provider (`dynatrace-oss/dynatrace`) has no resource for platform tokens. They must be created via the Dynatrace Account Management API. At 100+ accounts this is unmanageable manually.

This module fills that gap by:
1. Creating Dynatrace service users to own the tokens (with `prevent_destroy` to prevent accidental cascade deletion)
2. Creating AWS Secrets Manager secrets (empty shells) to hold the tokens
3. Calling the Platform Tokens API at onboarding time via `local-exec` and writing results to Secrets Manager
4. Creating the Dynatrace monitoring configuration (`dynatrace_hub_extension_v2_config`) per account
5. Deploying the CloudFormation activation stack per account - tokens are passed as `{{resolve:secretsmanager:...}}` so Terraform never holds raw token values

---

## How it works

```
dynatrace_iam_service_user.pool    aws_secretsmanager_secret.{settings,ingest}
         \                                    /
          +---> terraform_data.tokens <-------+
               (triggers_replace.service_user  +  depends_on secrets)
                        |
                        v
          aws_cloudformation_stack.aws_connection
          (depends_on = [terraform_data.tokens])
          pDtApiToken    = {{resolve:secretsmanager:dynatrace/<account>/settings-token}}
          pDtIngestToken = {{resolve:secretsmanager:dynatrace/<account>/ingest-token}}

dynatrace_hub_extension_v2_config.aws_connection
(for_each, runs in parallel with token provisioning)
          |
          v  (pMonitoringConfigId = UUID extracted from resource ID via split("#-#", id)[1])
          aws_cloudformation_stack.aws_connection
```

CloudFormation resolves `{{resolve:secretsmanager:...}}` at stack execution time - Terraform passes the literal reference string. `depends_on = [terraform_data.tokens]` ensures local-exec has written the tokens before CFN tries to resolve them.

---

## Confirmed limits (verified against Account Management API)

| Limit | Value |
|---|---|
| Platform tokens per regular user | 50 |
| Platform tokens per service user | 100 |
| Platform tokens per account | 50,000 |

At 2 tokens per AWS account and 10 accounts per service user (default), each service user holds 20 tokens. The `accounts_per_service_user` variable controls this. Lowering it reduces blast radius if a service user is accidentally deleted (see Risks below).

---

## Prerequisites

> **Dynatrace SaaS only.** This module calls `sso.dynatrace.com` and `api.dynatrace.com` - the Dynatrace SaaS global endpoints. Dynatrace Managed installations use customer-specific URLs and are not supported.

### 1. Enable the DA-AWS extension in your Dynatrace environment (once per environment)

Before the first account is onboarded, `com.dynatrace.extension.da-aws` must be added to the Dynatrace environment. This is a one-time step per environment, not per account.

```bash
# Get an OAuth access token (uses the same OAuth client you'll configure in step 2)
ACCESS_TOKEN=$(curl -sf -X POST "https://sso.dynatrace.com/sso/oauth2/token" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=<oauth-client-id>" \
  --data-urlencode "client_secret=<oauth-client-secret>" \
  --data-urlencode "scope=extensions:configurations:write" \
  --data-urlencode "resource=urn:dtaccount:<account-uuid>" \
  -H "Content-Type: application/x-www-form-urlencoded" | jq -r '.access_token')

curl -sf -X POST \
  "https://<env-id>.apps.dynatrace.com/api/v2/hub/extensions2/com.dynatrace.extension.da-aws/actions/addToEnvironment" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: application/json"
```

Alternatively: navigate to **Settings > Collect and capture > Cloud and virtualization > AWS** in the Dynatrace UI and leave the page open for ~10 minutes.

### 2. Find the installed extension version

After enabling the extension, query the installed version. Set `dt_extension_version` in your `terraform.tfvars` to this value if it differs from the default (`1.0.0`).

```bash
curl -sf \
  "https://<env-id>.apps.dynatrace.com/api/v2/extensions/com.dynatrace.extension.da-aws" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.version'
```

### 3. Dynatrace OAuth client

Create an OAuth client in **Dynatrace Account Management > Identity & access management > OAuth clients** with the following scopes. All are required - missing any one causes 403 errors.

| Scope | Used by |
|---|---|
| `account-idm-read` | Dynatrace provider - list service users |
| `account-idm-write` | Dynatrace provider - create service users |
| `extensions:configurations:read` | Dynatrace provider - read monitoring configs |
| `extensions:configurations:write` | Dynatrace provider - create monitoring configs |
| `platform-token:tokens:write` | local-exec - create platform tokens |
| `platform-token:tokens:manage` | local-exec - list and delete platform tokens |
| `iam:service-users:use` | local-exec - assign tokens to service users |

Note the client ID (`dt0s02.XXXXXXXXXX`) and secret. The same OAuth client is used for both the Dynatrace Terraform provider (via env vars) and the `local-exec` token creation (via Terraform variables).

> **Two credential mechanisms, one OAuth client:** the Dynatrace provider reads credentials from shell environment variables (`DT_CLIENT_ID`, `DT_CLIENT_SECRET`). The `local-exec` provisioner cannot inherit the shell environment automatically - it reads credentials from Terraform variables (`var.dt_oauth_client_id`, `var.dt_oauth_client_secret`). Both must be set before running `terraform plan` even though they point to the same OAuth client.

### 4. AWS credentials

The executing role needs the following permissions. Permissions are split between the Secrets Manager operations (which this module manages directly) and the CloudFormation stack and IAM role operations (which the CFN template manages on your behalf):

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:CreateSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:GetSecretValue",
    "secretsmanager:DescribeSecret",
    "secretsmanager:DeleteSecret",
    "cloudformation:CreateStack",
    "cloudformation:DescribeStacks",
    "cloudformation:GetTemplate",
    "cloudformation:UpdateStack",
    "cloudformation:DeleteStack",
    "iam:CreateRole",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:DeleteRole"
  ],
  "Resource": "*"
}
```

`secretsmanager:DeleteSecret` is required because `recovery_window_in_days = 0` performs immediate deletion (rather than the default 30-day scheduled deletion). Without it, `terraform destroy` fails.

The CloudFormation template deploys with `CAPABILITY_NAMED_IAM`, so IAM permissions are required to create and later delete the monitoring IAM role.

### 5. Local dependencies

The `local-exec` provisioner requires both `curl` and `jq` on the machine running `terraform apply`.

```bash
# macOS
brew install jq

# Amazon Linux / RHEL
yum install -y jq
```

### 6. Cross-account deployments

The `aws` provider uses a single credential context. For accounts that require separate IAM assume-role credentials, run the module once per account with the appropriate credentials set. The `aws_accounts` input accepts a single account ID in that scenario.

---

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars

# Dynatrace provider authentication (read by the provider directly)
export DT_ENV_URL="https://<environment-id>.apps.dynatrace.com"
export DT_CLIENT_ID="dt0s02.XXXXXXXXXX"
export DT_CLIENT_SECRET="dt0s02.XXXXXXXXXX.XXXXXXXXXX..."

# Platform Tokens API credentials (read via Terraform variables by local-exec)
export TF_VAR_dt_oauth_client_id="dt0s02.XXXXXXXXXX"
export TF_VAR_dt_oauth_client_secret="dt0s02.XXXXXXXXXX.XXXXXXXXXX..."

terraform init
terraform plan
terraform apply -parallelism=5
```

> **Known after apply:** `pMonitoringConfigId` in the plan output shows as `(known after apply)` on first run because the Dynatrace UUID is assigned when the monitoring configuration is created. This is expected - it is not an error.

> **Parallelism:** `-parallelism=5` limits simultaneous `local-exec` provisioner calls to avoid hitting Dynatrace API rate limits at 100+ accounts. If a provisioner fails due to rate limiting, the resource is tainted and retries on the next apply.

**terraform.tfvars.example:**

```hcl
aws_accounts        = ["123456789012", "234567890123"]
dt_account_uuid     = "405f3b12-4e9d-4cd6-ad1f-c7936a9b23fc"
dt_env_url          = "https://<environment-id>.apps.dynatrace.com"
token_expiration_date = "2027-08-01T00:00:00.000Z"
monitored_regions   = ["us-east-1", "us-west-2"]

# Optional overrides
# dt_extension_version      = "1.0.0"
# accounts_per_service_user = 10
# stack_name_prefix         = "dynatrace-aws"
# logs_ingest_enabled       = true
```

---

## Token rotation (manual)

Rotation does not require a `terraform apply`. The CFN stack uses `ignore_changes` on the token parameters and resolves them from Secrets Manager at execution time - updating the secret and triggering a stack update is all that is needed.

For each account being rotated:

**Step 1 - Create a new token in Dynatrace**

```bash
ACCESS_TOKEN=$(curl -sf -X POST "https://sso.dynatrace.com/sso/oauth2/token" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=<oauth-client-id>" \
  --data-urlencode "client_secret=<oauth-client-secret>" \
  --data-urlencode "scope=platform-token:tokens:write platform-token:tokens:manage iam:service-users:use" \
  --data-urlencode "resource=urn:dtaccount:<dt-account-uuid>" \
  -H "Content-Type: application/x-www-form-urlencoded" | jq -r '.access_token')

NEW_TOKEN=$(curl -sf -X POST \
  "https://api.dynatrace.com/iam/v1/accounts/<dt-account-uuid>/platform-tokens" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "aws-<aws-account-id>-settings-rotated",
    "userUuid": "<service-user-uuid>",
    "scope": ["settings:objects:read","settings:objects:write","extensions:configurations:read","extensions:configurations:write"],
    "resource": ["urn:dtaccount:<dt-account-uuid>"],
    "expirationDate": "2028-08-01T00:00:00.000Z"
  }' | jq -r '.token')
```

**Step 2 - Update Secrets Manager**

```bash
aws secretsmanager put-secret-value \
  --secret-id "dynatrace/<aws-account-id>/settings-token" \
  --secret-string "$NEW_TOKEN"
```

**Step 3 - Trigger a CloudFormation stack update**

CloudFormation resolves `{{resolve:secretsmanager:...}}` at stack execution time, not continuously. A stack update is required to push the new token to the running Firehose and Lambda resources.

```bash
STACK_NAME="dynatrace-aws-<aws-account-id>"

# Retrieve all current parameter keys and resubmit with UsePreviousValue=true.
# This is required - omitting any parameter from --parameters causes a validation error.
PARAMS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Parameters[].ParameterKey' \
  --output text | tr '\t' '\n' \
  | awk '{print "ParameterKey="$1",UsePreviousValue=true"}' \
  | tr '\n' ' ')

aws cloudformation update-stack \
  --stack-name "$STACK_NAME" \
  --use-previous-template \
  --parameters $PARAMS

aws cloudformation wait stack-update-complete \
  --stack-name "$STACK_NAME"
```

**Step 4 - Delete the old token from Dynatrace**

Find the old token ID by listing tokens for the service user that owns this account (see `service_user_pool` output for the UUID):

```bash
# List tokens owned by the service user; match against the SM secret value to identify the old one
curl -sf \
  "https://api.dynatrace.com/iam/v1/accounts/<dt-account-uuid>/platform-tokens?userUuid=<service-user-uuid>" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.items[] | {tokenId, name, expirationDate}'
```

Then delete the old token by its `tokenId`:

```bash
OLD_TOKEN_ID="dt0s16.XXXXXXXXXX"

curl -sf -X DELETE \
  "https://api.dynatrace.com/iam/v1/accounts/<dt-account-uuid>/platform-tokens/$OLD_TOKEN_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Delete the old token only after the stack update is complete.

**Step 5 - Verify**

Check **Infrastructure > AWS** in Dynatrace and confirm the connection status and that metrics are flowing. Allow up to 5 minutes after the stack update.

---

## Risks and mitigations

### Service user cascade delete

Deleting a `dynatrace_iam_service_user` resource instantly and permanently deletes all platform tokens owned by that user. With 10 accounts per service user (default), one accidental delete breaks monitoring for 10 accounts simultaneously with no warning.

All service user resources have `prevent_destroy = true`. Terraform will refuse to destroy them. To intentionally decommission a service user, remove `prevent_destroy` from `main.tf`, run `terraform apply`, then delete.

### Monitoring config changes after first apply are not propagated by Terraform

`dynatrace_hub_extension_v2_config` uses `ignore_changes = [value]`. This is required because the CFN Lambda writes back live fields (`connectionId`, `enabled`) after it registers the IAM role with Dynatrace HAS. Reverting those fields would break the live connection.

The side effect is that changes to `monitored_regions`, `feature_sets`, `logs_ingest_enabled`, or `logs_ingest_regions` after the first apply will produce a clean `terraform plan` with no changes - Terraform will not update the Dynatrace monitoring config. To apply these changes after initial onboarding, update the config directly in the Dynatrace UI under **Infrastructure > AWS**, or force resource replacement with:

```bash
terraform apply -replace='dynatrace_hub_extension_v2_config.aws_connection["<account-id>"]'
```

Force replacement tears down and re-creates the monitoring config. The CFN stack remains unaffected, but `connectionId` is reset and the CFN Lambda must re-register the IAM role (which happens automatically on the next Lambda invocation).

### Token orphaning on provisioner failure

If `terraform apply` fails mid-run (network error, AWS credential expiry), the `local-exec` provisioner may have already created a token in Dynatrace but not stored it in Secrets Manager. On the next apply, the provisioner's idempotency check finds no secret value and creates a new token. The orphaned token from the failed run remains in Dynatrace.

To clean up: list all tokens for the service user via the Account Management API and compare against current Secrets Manager secret values. Revoke any with no corresponding secret.

### `prevent_destroy` blocks `terraform destroy`

Running `terraform destroy` will fail because service user resources have `prevent_destroy = true`. This is intentional. Remove `prevent_destroy` manually before destroying.

### Events ingest not supported

This module provisions logs ingest (`pDtLogsIngestEnabled`, `pDtLogsIngestRegions`) but does not wire EventBridge events ingest. The CFN template supports events ingest via additional parameters (`pDtEventsIngestEnabled`, `pDtEventsIngestRegions`, `pEventBridgeBusName`, `pEventSources`). Scaffolding for all four is present as commented-out code in `main.tf` and `variables.tf` - uncomment them together with the `eventsConfiguration` block in `dynatrace_hub_extension_v2_config` to enable the feature.
