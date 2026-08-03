# Extreme Platform ONE Wireless Monitoring in Dynatrace

Scheduled workflow that polls Extreme Platform ONE (`cloudapi.extremecloudiq.com`) every
5 minutes for per-site wireless health scores and active alerts, and ingests them into
Dynatrace as `extreme.*` metrics plus `CUSTOM_ALERT` events, plus a small verification
dashboard on top.

This replaces an earlier attempt (see `reference_extreme_dashboard_dql_audit.md`) that
built a 40-tile production dashboard against ExtremeCloud IQ (XIQ) fields that were never
verified against the real API — roughly half the tiles turned out to reference fields or
event keywords that don't exist. This workflow only uses fields pulled directly from
Extreme's published OpenAPI specs; the few gaps that couldn't be verified from the spec
alone are called out explicitly below instead of guessed at.

## 1. Extreme Platform ONE setup (one-time, customer side)

1. Log in to Extreme Platform ONE.
2. Go to **Administration & Settings > Integrations > Create New API Key**.
3. Give it a name/description, and an expiration date (Extreme recommends rotating every
   90 days — put a reminder on the calendar, there's no auto-rotation).
4. Copy the generated key immediately — it's only shown once.

## 2. Dynatrace setup

Create two Credential Vault entries (**Settings > Credential Vault**):

| Vault secret name | Value |
|---|---|
| `extreme_platform_one_api_key` | The Extreme Platform ONE API key from step 1 |
| `dt_ingest_token` | A Dynatrace API token scoped to `metrics.ingest` and `events.ingest` |

The names must match exactly — `workflow.yaml` references them via `{{ secret('name') }}`.

Then edit one placeholder, in two places, before applying:
- `dtEnvUrl` in both the `ingest_metrics` and `ingest_events` tasks — set to the target
  Dynatrace environment URL (currently defaults to the `ditmar` POC tenant,
  `https://mfa20993.apps.dynatrace.com`).

## 3. Apply

```bash
dtctl apply -f workflow.yaml --plain
dtctl apply -f dashboard.yaml --share-environment read --plain
```

`--share-environment read` makes the dashboard visible to everyone in the tenant — a
dashboard YAML's `isPrivate: false` field alone does **not** do this (see AGENTS.md).

## 4. Test

```bash
# Trigger a manual run (grab the id from the apply output or `dtctl get workflows --mine`)
dtctl exec workflow <workflow-id>

# Check what happened, and check the get_dashboard task's logged response keys
# against what transform actually expects (see "Known gaps" below)
dtctl logs workflow-execution <execution-id>

# Confirm metrics landed
dtctl query "timeseries avg(extreme.health.client), avg(extreme.health.device), by:{site.name}" -o json --plain

# Confirm alerts landed
dtctl query "fetch events | filter event.type == \"CUSTOM_ALERT\" | limit 10" -o json --plain
```

Then open the dashboard and confirm the KPI row, trend chart, per-site table, and alerts
feed all render with data for at least one site.

## Known limitations / open items

- **`/analytics/dashboard`'s response field names are unconfirmed**: Extreme's published
  OpenAPI spec documents this endpoint's request filters in full but ships an *empty*
  response schema (`DashboardResponse: {}`) — there's no authoritative field list to build
  against. `get_dashboard` logs the top-level response keys on its first page each run
  (`console.log('Sample dashboard response keys: ...')`), and `transform` guesses at
  `siteName`/`siteId`/`deviceHealthScore`/`clientHealthScore`/`usageCapacityScore`/
  `wirelessClientCount` using this API's naming conventions elsewhere. Check
  `dtctl logs workflow-execution <id>` after the first real run and correct the field names
  in `transform` if they don't match — the same defensive, log-instead-of-silently-drop
  approach the Genesys workflow used for its own unconfirmed `oServiceLevel` field.
- **Health score scale (0-100) is assumed, not confirmed**: carried over from the
  equivalent XIQ `network-scorecard` API's convention. `dashboard.yaml`'s per-site table
  coloring assumes 0-100 (thresholds at 60/80) — adjust once a live response confirms the
  actual scale.
- **No historical lookback for health scores**: unlike `get_alerts` (15-min overlapping
  window), `/analytics/dashboard` has no `startTime`/`endTime` — it's a live snapshot each
  call. If a run fails, that 5-minute sample is simply missing from the metric timeseries
  (a gap, not stale/wrong data) rather than self-healing on the next run.
- **429 handling**: both fetch tasks wait on `Retry-After` and retry exactly once, then let
  the run fail if still blocked — cheap to implement because Extreme fully documents the
  IETF rate-limit headers (unlike the Genesys integration, where this was deliberately
  deferred since the behavior wasn't documented there). At ~5-10 calls per 5-minute run,
  hitting the 7,500/hour quota at all would mean something else is very wrong.
- **Alerts are deduplicated by Dynatrace's event timeout, not by us**: `get_alerts` re-sends
  every active alert in its 15-minute lookback window on every run; `transform` doesn't
  track which alert IDs were already sent. Each `CUSTOM_ALERT` event carries `timeout: 15`
  (3x the poll interval), so Dynatrace treats repeated sends of the same still-active alert
  as refreshing one open event, and auto-closes it if Extreme stops reporting it active for
  three consecutive polls. Simpler than tracking resolve transitions ourselves, but it means
  an alert that flaps faster than 15 minutes will look like one continuous event, not
  several.
- **Events ingest isn't batched**: `ingest_events` sends one `POST` per alert (the Events
  Ingest v2 API takes a single event per call, unlike the line-protocol batching
  metrics-ingest allows). Fine at typical alert volumes; revisit if a site regularly
  surfaces hundreds of simultaneously-active alerts.
- **Deferred on purpose (not built)**: per-client connectivity-experience session funnel
  (`/analytics/client-trail/connectivity-experience` — richer than the site-level rollup,
  but much higher volume), MetaStore raw device-event ingestion, and per-device
  `/metric-data` drill-down. Add if the customer asks for that level of detail.
- **The old 40-tile dashboard is untouched**: `reference_extreme_dashboard_dql_audit.md`
  catalogs 14 incorrect and 10 questionable tiles in
  `Extreme Networks _ Network Monitoring — Production DQL.json`. Fixing those is a separate
  follow-up, once the field-name gaps above are confirmed against a live tenant — this
  workflow's `dashboard.yaml` is deliberately a small verification dashboard, not a
  replacement for that one.
- **HTTP calls run as `run-javascript` tasks** (using `fetch`) rather than the
  `http-function` action, matching the Genesys workflow's rationale — header/Bearer-auth
  handling is fully explicit in code instead of depending on the action's less-documented
  `authentication` field.
