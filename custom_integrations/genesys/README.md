# Genesys Cloud Monitoring in Dynatrace

Scheduled workflow that pulls Genesys Cloud conversation-analytics metrics
(voice, chat, email, message, callback) every 5 minutes and ingests them into
Dynatrace as `genesys.*` metrics, plus an executive dashboard on top. Built as
a Workflow instead of a custom Extension — see [AGENTS.md](AGENTS.md) for the
reasoning and full technical context if you're picking this up for further
development.

## 1. Genesys Cloud setup (one-time, customer side)

1. In Genesys Cloud, go to **Admin > Integrations > OAuth > Add Client**.
2. Grant type: **Client Credentials**.
3. Assign a role with:
   - `Analytics > Conversation Aggregate > View`
   - `Analytics > Conversation Detail > View` (not used by this workflow today, but matches Datadog's required scope in case detail-level queries get added later)
4. Note the **Client ID**, **Client Secret**, and the org's **region** (e.g. `mypurecloud.com`, `usw2.pure.cloud`, `euw1.pure.cloud`).

## 2. Dynatrace setup

Create three Credential Vault entries (**Settings > Credential Vault**):

| Vault secret name | Value |
|---|---|
| `genesys_client_id` | Genesys OAuth Client ID |
| `genesys_client_secret` | Genesys OAuth Client Secret |
| `dt_metrics_ingest_token` | A Dynatrace API token scoped to `metrics.ingest` |

The names must match exactly — `workflow.yaml` references them via `{{ secret('name') }}`.

Then edit two placeholders in `workflow.yaml` before applying:
- `region` (appears in the `get_token` and `get_queues`/`get_metrics` tasks via `token.region`) — set to the customer's Genesys Cloud region.
- `dtEnvUrl` in the `ingest_metrics` task — set to the target Dynatrace environment URL (currently a placeholder from the tenant this was developed against).

## 3. Apply

```bash
dtctl apply -f workflow.yaml --plain
dtctl apply -f dashboard.yaml --share-environment read --plain
```

`--share-environment read` makes the dashboard visible to everyone in the tenant — a dashboard YAML's `isPrivate: false` field alone does **not** do this (see AGENTS.md gotchas).

## 4. Test

```bash
# Trigger a manual run (grab the id from the apply output or `dtctl get workflows --mine`)
dtctl exec workflow <workflow-id> --wait --show-results --plain

# Check what happened
dtctl logs workflow-execution <execution-id>

# Confirm metrics landed
dtctl query "timeseries avg(genesys.service_level), sum(genesys.conversations.offered) by:{media_type}" -o json --plain
```

Then open the dashboard and confirm the KPI row, trend chart, channel comparison table, and queue performance table all render with data for at least 2 channels.

## Known limitations / open items

- **15-minute lookback, `PT5M` granularity, clock-aligned buckets**: `get_metrics` floors its window to 5-minute boundaries so re-querying the same bucket overwrites the same Dynatrace timestamp instead of creating a new point each run (an earlier version used `PT15M` granularity on a sliding, non-aligned window, which triple-counted every absolute metric — see AGENTS.md if you're touching this code). A conversation still open when a run fires gets corrected once a later run sees it closed — but only within the 15-minute window. Genesys itself documents no upper bound on when aggregate data "settles" (nightly recalculations can revise it later, and email/chat/callback conversations routinely stay open far longer than 15 minutes) — so this is a bounded approximation for voice-heavy queues, not a guarantee for async channels. Revisit with a real high-water-mark if strict historical accuracy matters for those channels.
- **No retry on 429/5xx**: each Genesys/Dynatrace `fetch` throws immediately on a non-OK response, which fails that run. Mitigated in practice by the 15-minute lookback — the next successful run 5 minutes later re-covers the same window — but a run that fails repeatedly for 15+ minutes will drop data. Genesys explicitly documents 429 as an expected, retriable condition if this needs hardening later.
- **Dedicate the Genesys OAuth client to this integration**: a client-credentials app can hold at most ~50 concurrent tokens; minting a fresh one every 5 minutes (no caching — see below) cycles through that ceiling every ~4 hours. Harmless in isolation, but if this OAuth client is ever shared with another integration, this workflow will quietly invalidate that integration's live tokens too.
- **Token is not cached across runs**: fetched fresh every 5 minutes rather than reused until near expiry (tokens are typically valid ~24h). Simpler, and confirmed safe at this call volume (well under Genesys's rate-limit buckets), but revisit if the OAuth client ends up shared (see above) or if Genesys tightens token-issuance limits.
- **Metrics-ingest payload isn't chunked**: `ingest_metrics` sends the whole transformed payload in one POST. Dynatrace's ingest API caps requests at 1000 metric lines; fine at pilot scale, but a large org (150+ active queue/media-type combinations in a 15-min window) could exceed it. Add chunking before wider rollout.
- **Queue names**: resolved via a single `GET /api/v2/routing/queues?pageSize=500` call per run. Orgs with more than 500 queues need pagination added to the `get_queues` task.
- **`oServiceLevel` shape is unconfirmed**: `transform` tries `stats.ratio`, then `value`, then `stats.value`, in that order, and logs (doesn't silently drop) if none match. Confirm the real field name and scale (0–1 vs 0–100) against a live response, and adjust `dashboard.yaml`'s `coloring.colorRules` (tile `"7"`, currently assumes 0–100) accordingly.
- **Deferred on purpose (not built)**: agent activity/coaching/barging/monitoring metrics, transfer/consult detail, and audit-log ingestion. Datadog's integration includes these, but they're operational detail rather than executive-level signal — add if the customer asks.
- **HTTP calls run as `run-javascript` tasks** (using `fetch`) rather than the `http-function` action, so header/Basic-auth handling is fully explicit in code instead of depending on the action's less-documented `authentication` field.
