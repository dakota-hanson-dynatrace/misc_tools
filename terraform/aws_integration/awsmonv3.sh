#!/bin/bash
set -euo pipefail

LOG_FILE="validation_errors.log"

log_error() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') ❌ $1" >> "$LOG_FILE"
  echo "❌ $1"
}

# Prompt for user inputs
read -p "Enter configuration name (letters, numbers, hyphens, must start with a letter): " CONFIG_NAME
read -p "Enter AWS account ID (12-digit number): " AWS_ACCOUNT_ID
read -p "Enter deployment region (e.g., us-east-1): " DEPLOYMENT_REGION
read -p "Enter monitored regions (comma-separated, e.g., us-west-1,us-west-2): " MONITORED_REGIONS
read -p "Enter Dynatrace environment URL (e.g., https://abc.live.dynatrace.com): " ENV_URL
read -sp "Enter Dynatrace Platform SETTINGS token: " SETTINGS_TOKEN; echo
read -sp "Enter Dynatrace Platform INGEST token: " INGEST_TOKEN; echo

# Validate configuration name
if [[ ! $CONFIG_NAME =~ ^[a-zA-Z][a-zA-Z0-9-]*$ ]]; then
  log_error "Invalid configuration name. Must start with a letter and contain only letters, numbers, and hyphens."
  exit 1
fi

# Validate AWS account ID
if [[ ! $AWS_ACCOUNT_ID =~ ^[0-9]{12}$ ]]; then
  log_error "Invalid AWS account ID. Must be a 12-digit number."
  exit 1
fi

# Validate deployment region (e.g., us-east-1 or eu-central-1)
if [[ ! $DEPLOYMENT_REGION =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]]; then
  log_error "Invalid deployment region format. Must match AWS region pattern like us-east-1 or eu-central-1."
  exit 1
fi

# Validate environment URL (Dynatrace SaaS)
if [[ ! $ENV_URL =~ ^https://[a-zA-Z0-9.\-]+\.dynatrace\.com$ ]]; then
  log_error "Invalid Dynatrace environment URL. Must match pattern like https://abc.live.dynatrace.com"
  exit 1
fi

# Validate and convert monitored regions to a JSON array
IFS=',' read -ra REGIONS <<< "$MONITORED_REGIONS"
REGION_JSON=""
for region in "${REGIONS[@]}"; do
  region_trimmed="$(echo "$region" | xargs)"
  if [[ ! $region_trimmed =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]]; then
    log_error "Invalid AWS region format: '$region_trimmed'. Must match pattern like us-east-1 or eu-central-1."
    exit 1
  fi
  REGION_JSON+="\"${region_trimmed}\"," 
done
REGION_JSON="[${REGION_JSON%,}]"

# --- Option A: Write JSON to a temp file (literal heredoc), then substitute placeholders ---
PAYLOAD_FILE="$(mktemp -t awsmon_payload.XXXXXX).json"

# Literal heredoc: variables won't expand here; we will replace placeholders safely afterward.
cat > "$PAYLOAD_FILE" <<'EOF'
[
  {
    "scope": "integration-aws",
    "value": {
      "enabled": false,
      "description": "$CONFIG_NAME",
      "version": "0.1.6",
      "featureSets": [
        "ApiGateway_essential", "ApplicationELB_essential", "AutoScaling_essential", "CloudFront_essential",
        "DynamoDB_essential", "EBS_essential", "EC2_essential", "ECR_essential", "ECS_essential", "EFS_essential",
        "ELB_essential", "ElastiCache_essential", "Firehose_essential", "Lambda_essential", "NATGateway_essential",
        "NetworkELB_essential", "PrivateLinkEndpoints_essential", "PrivateLinkServices_essential", "RDS_essential",
        "Route53_essential", "S3_essential", "SNS_essential", "SQS_essential"
      ],
      "aws": {
        "smartscapeConfiguration": {
          "enabled": true
        },
        "deploymentRegion": "$DEPLOYMENT_REGION",
        "credentials": [
          {
            "enabled": false,
            "description": "$CONFIG_NAME",
            "connectionId": "*",
            "accountId": "$AWS_ACCOUNT_ID"
          }
        ],
        "regionFiltering": $REGION_JSON,
        "metricsConfiguration": {
          "enabled": true,
          "regions": $REGION_JSON
        },
        "cloudWatchLogsConfiguration": {
          "enabled": true,
          "regions": $REGION_JSON
        },
        "configurationMode": "QUICK_START",
        "deploymentScope": "SINGLE_ACCOUNT",
        "deploymentMode": "AUTOMATED",
        "manualDeploymentStatus": "NA",
        "automatedDeploymentStatus": "NA"
      }
    }
  }
]
EOF

# Substitute placeholders inside the file (portable; avoids sed -i differences)
SUB_TMP="${PAYLOAD_FILE}.subst"
sed \
  -e "s|\$CONFIG_NAME|$CONFIG_NAME|g" \
  -e "s|\$AWS_ACCOUNT_ID|$AWS_ACCOUNT_ID|g" \
  -e "s|\$DEPLOYMENT_REGION|$DEPLOYMENT_REGION|g" \
  -e "s|\$REGION_JSON|$REGION_JSON|g" \
  "$PAYLOAD_FILE" > "$SUB_TMP"
mv "$SUB_TMP" "$PAYLOAD_FILE"

# Pretty-print (hierarchical) & validate JSON
if command -v jq >/dev/null 2>&1; then
  if ! jq . "$PAYLOAD_FILE" > "${PAYLOAD_FILE}.pretty"; then
    log_error "Invalid JSON after variable substitution. Aborting."
    rm -f "$PAYLOAD_FILE" "${PAYLOAD_FILE}.pretty"
    exit 1
  fi
  mv "${PAYLOAD_FILE}.pretty" "$PAYLOAD_FILE"
elif command -v python3 >/dev/null 2>&1; then
  if ! python3 -m json.tool "$PAYLOAD_FILE" > "${PAYLOAD_FILE}.pretty"; then
    log_error "Invalid JSON after variable substitution. Aborting."
    rm -f "$PAYLOAD_FILE" "${PAYLOAD_FILE}.pretty"
    exit 1
  fi
  mv "${PAYLOAD_FILE}.pretty" "$PAYLOAD_FILE"
else
  echo "ℹ️  Neither 'jq' nor 'python3' found. Proceeding without reformatting."
fi

# Ensure cleanup of the temp file on exit
trap 'rm -f "$PAYLOAD_FILE"' EXIT

# Execute the API call using the file
curl -s -w "\n%{http_code}" \
  -X POST "$ENV_URL/platform/extensions/v1/com.dynatrace.extension.da-aws/monitoring-configuration" \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SETTINGS_TOKEN" \
  --data-binary "@$PAYLOAD_FILE"
