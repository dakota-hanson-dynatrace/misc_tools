# Oracle Fusion Cloud Applications – Operational Health Monitoring (ESS) in Dynatrace

Scheduled workflow that polls Oracle Fusion's Enterprise Scheduler Service (ESS) REST
API every 5 minutes for job-request status across ERP/HCM/SCM, and ingests them into
Dynatrace as `oracle_fusion.ess.*` metrics plus `CUSTOM_ALERT` events, plus a small
verification dashboard on top.

ESS is the highest-value operational signal available via REST across all of Fusion
Applications — every nightly import, month-end close step, payroll run, and report goes
through it. This integration deliberately does not attempt infrastructure-level metrics
(they don't exist for Fusion SaaS customers — see
`oracle_fusion_observability_breakdown.md`) or UI-only signals like the Diagnostic
Dashboard. Built as a Workflow instead of a custom Extension — see
[AGENTS.md](AGENTS.md) for the reasoning and full technical context if you're picking
this up for further development. See `oracle_fusion_observability_breakdown.md` in this
folder for the full research behind this — what else was considered, what's available
now vs. deferred, auth, rate limits, and the business case.

## Executive summary

**Can do**
- Detect ERP/HCM/SCM batch job failures (payroll, close, imports, reports) within ~5 min via Davis alerts
- Track job duration trends to catch batch-window creep before it becomes an outage
- Single dashboard for job health across all Fusion products
- Route alerts by submitter/product/application without opening Fusion
- Correlate Fusion job health with the rest of the customer's Dynatrace estate

**Cannot do**
- No infrastructure metrics (CPU/memory/DB) — doesn't exist for Fusion SaaS, by Oracle design
- No job log / root-cause text — only exposed via SOAP, not REST; out of scope
- No real-time outage/status feed — no supported API (only an undocumented, unofficial JSON file)
- No audit trail or sign-in monitoring — deferred, not built
- No guaranteed rate-limit safety — Oracle publishes no numeric API limit

## 1. Oracle Fusion setup (one-time, customer side)

1. Confirm the Fusion instance's **OCI IAM Identity Domain URL** (from the customer's
   Oracle Cloud account admin, or the Fusion Applications environment details).
2. In the OCI IAM Identity Domain console: **Applications → Add application →
   Confidential Application**.
3. Name it (e.g. "Dynatrace ESS Monitoring"). No redirect/web-tier config is needed —
   this is a client-credentials-only integration.
4. Under **Client configuration → Configure this as a client now**, grant type: check
   **Client Credentials**.
5. Add a scope matching `urn:opc:resource:fusion:<POD_NAME>:<product>/`. **Confirm with
   the customer's IAM admin whether a broader/global scope is available for a
   cross-product API like ESS**, or whether a per-product scope (e.g. `.../ess/`) is
   sufficient — this couldn't be verified without a live tenant (see Known Limitations).
6. Activate the application; copy the **Client ID** and **Client Secret** immediately —
   the secret is shown once.
7. **Critical step, no generic shortcut**: in Fusion's **Security Console** (not the IAM
   console) — locate or create a user record matching the OAuth Client ID, and assign it
   a job role granting REST access to Enterprise Scheduler plus a data role/data-security
   policy scoping which requests it can see. Oracle's REST authorization is the same
   function+data security model as the UI — there's no generic API-only toggle. Get the
   exact duty/job-role name from the customer's security admin; it varies by which Fusion
   offerings are licensed on the tenant.
8. Test the client credentials manually (curl the token endpoint, then one
   `GET .../ess/rest/scheduler/v1/requests?limit=1`) before wiring up Dynatrace, to
   confirm the scope + role assignment actually works end-to-end.

## 2. Dynatrace setup

Create three Credential Vault entries (**Settings > Credential Vault**):

| Vault secret name | Value |
|---|---|
| `oracle_fusion_client_id` | OCI IAM Confidential Application Client ID |
| `oracle_fusion_client_secret` | OCI IAM Confidential Application Client Secret |
| `dt_ingest_token` | A Dynatrace API token scoped to `metrics.ingest` and `events.ingest` |

The names must match exactly — `workflow.yaml` references them via `{{ secret('name') }}`.

Then edit these placeholders before applying (4 distinct names, 5 edit locations —
more than a single-host integration would need, since the IAM domain, the Fusion
instance, and the Dynatrace tenant are three different hosts):
- `iamDomainUrl` in `get_token`
- `scope` in `get_token`
- `fusionBaseUrl` in `get_ess_requests`
- `dtEnvUrl` in **both** `ingest_metrics` and `ingest_events` (currently defaults to the
  `ditmar` POC tenant, `https://mfa20993.apps.dynatrace.com`)

## 3. Apply

```bash
dtctl apply -f workflow.yaml --write-id --plain
dtctl apply -f dashboard.yaml --write-id --share-environment read --plain
```

`--write-id` stamps the created resource ID back into the file so later re-applies update
in place instead of creating duplicates. `--share-environment read` makes the dashboard
visible to everyone in the tenant — a dashboard YAML's `isPrivate: false` field alone does
**not** do this (see AGENTS.md).

## 4. Test

```bash
# Trigger a manual run and wait for it to finish
dtctl exec workflow <workflow-id> --wait --show-results --timeout 3m --plain

# Check what happened, and check get_ess_requests's logged response keys against what
# transform actually expects (see "Known limitations" below)
dtctl logs workflow-execution <execution-id>

# Confirm metrics landed
dtctl query "timeseries avg(oracle_fusion.ess.job.duration), sum(oracle_fusion.ess.job.count) by:{status_bucket}" -o json --plain

# Confirm alerts landed (only populated if a job failed within the lookback window)
dtctl query "fetch events | filter event.type == \"CUSTOM_ALERT\" | limit 10" -o json --plain
```

Then open the dashboard and confirm the KPI row, trend chart, detail table, and alerts
feed all render with data for at least one product.

## Known limitations / open items

- **OAuth scope for ESS specifically is unconfirmed**: the documented scope pattern is
  per-product; ESS is cross-product. Verify with a live tenant/IAM admin whether a
  broader scope exists (see setup step 5).
- **Security Console job/duty role name isn't standardized across tenants** — varies by
  licensed offering; confirm with the customer's security admin and test end-to-end
  (setup step 8) before relying on it.
- **No documented numeric rate limit for Fusion REST APIs**. A WAF-level limit exists
  with an undisclosed, DDoS-oriented threshold. 429 is confirmed to occur; `Retry-After`
  behavior is *not* confirmed — `get_ess_requests` uses fixed/exponential backoff (4 total
  attempts, 3 delays: ~2s/4s/8s + jitter) instead of trusting a header. An unofficial
  ~5,000 calls/hour/user community figure exists but isn't built against precisely.
- **`q` filter syntax for `submissionTime` is assumed, not confirmed**: SCIM `ge`
  comparator with single-quoted ISO-8601, per research. `get_ess_requests` logs the raw
  response's top-level keys on page 1; adjust the filter if items come back empty or the
  wrapper shape differs from the assumed `items`/`hasMore` convention.
- **Event dedup uses resend + Dynatrace timeout-refresh** (`requestId` carried as
  `oracle_fusion.ess.request_id`, not a persisted "already-alerted" store). Trade-off
  specific to this integration: because the fetch lookback (24h) is much wider than the
  event timeout (15 min), a failed job nobody investigates keeps its alert refreshed for
  up to 24h, then silently ages out and auto-closes even though the job may still be
  sitting `ERROR` in Fusion — don't mistake that auto-close for resolution.
- **No bucket-flooring needed for metric timestamps**: each ESS row's `stateChangeTime` is
  a stable, real timestamp once set (falls back to `submissionTime`, then `Date.now()` if
  both are missing/malformed), so re-sending the same row at the same timestamp on every
  poll is already a safe overwrite.
- **`CANCELLED`/`EXPIRED` show up in the dashboard's `failed` bucket but don't fire
  `CUSTOM_ALERT`**, and `ERROR_AUTO_RETRY` fires neither — deliberate choices, not
  oversights (a deliberate cancel or missed schedule window isn't necessarily a system
  failure; Oracle is still self-healing during auto-retry).
- **No job log/output content available via REST** — only the SOAP
  `ErpIntegrationService.downloadESSJobExecutionDetails` operation exposes that; out of
  scope/deferred.
- **Interface-table backlogs / FBDI error counts**: no unified API; the only proxy is ESS
  job state/errorType per known interface-loader job definition. Possible follow-up, not
  built now.
- **Sign-in/sign-out audit REST API**: deprecation/tenant-migration status unresolved —
  not built against without live tenant verification.
- **Business-object audit trail**
  (`/fscmRestApi/fndAuditRESTService/audittrail/getaudithistory`): real and useful, but
  enrichment (1-month cap, needs per-object audit policy enabled first) rather than core
  scope — documented follow-up candidate.
- **saasstatus.oracle.com**: only data source found is an undocumented, unversioned
  `pub_pg_data.json` with no contract/SLA — unsupported/fragile, not built.
- **OIC / OCI Monitoring metrics**: real and well-documented, but only applicable if the
  customer runs Oracle Integration Cloud alongside Fusion, and uses a completely
  different auth model (OCI signing-key, not the Fusion identity domain) —
  optional/conditional add-on, not core scope.
- **No infrastructure metrics (CPU/memory/DB) exist for core Fusion SaaS at all** — a
  confirmed architectural SaaS boundary in Oracle's own docs, not a gap this integration
  works around.
- **Events ingest isn't batched** — one POST per event, same limit as the Events Ingest
  v2 API itself; revisit if a tenant regularly surfaces hundreds of simultaneously
  alert-worthy jobs in one 5-minute window.
- **Token not cached across runs** — fetched fresh every 5 min; Oracle's token is only
  valid 1h anyway, so caching would save proportionally less here than in an
  integration with a longer-lived token. For an unusually large tenant, a very slow
  pagination loop could theoretically outlast the 1h token — not expected at realistic
  24h-window volumes.
- **Detail table and alerts feed both read the same `CUSTOM_ALERT` event stream**,
  differentiated only by column selection — ESS's free-text error detail
  (`errorWarningMessage`) only exists on the event side, metrics are numeric-only.
- **Pagination safety cap** (`MAX_PAGES = 50`, 25k rows) — defensive guard against a
  buggy/always-true `hasMore`, not expected to bind at realistic volumes; if it ever
  does, the oldest/longest-running jobs in the window are the ones dropped (see the
  logged warning in `get_ess_requests`).
- **HTTP calls run as `run-javascript` tasks** (using `fetch`) rather than the
  `http-function` action — header/Bearer-auth handling is fully explicit in code instead
  of depending on the action's less-documented `authentication` field.
