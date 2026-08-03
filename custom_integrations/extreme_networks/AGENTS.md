# AI Coding Agent Instructions

## Project Overview

This is a Dynatrace **Workflow** (Automation Engine) + **Dashboard** pair, not a custom
app — no build step, no `dt-app` toolkit, no npm. Two declarative resource files applied
directly to a Dynatrace tenant with `dtctl`. It pulls per-site wireless health scores and
active alerts from **Extreme Platform ONE** (`cloudapi.extremecloudiq.com`) every 5
minutes and ingests them into Dynatrace as `extreme.*` metrics and `CUSTOM_ALERT` events.

This replaces an earlier, never-actually-built assumption: a prior session built a
40-tile production dashboard against ExtremeCloud IQ (XIQ) fields that were never
verified against the real API (`disconnect.count`, `auth.failure.count`,
`ap.status == "ONLINE"` — none of which exist). See
`reference_extreme_dashboard_dql_audit.md` for the full catalog of what was wrong and
why. This workflow only uses fields pulled directly from Extreme's published OpenAPI
specs; the handful that couldn't be confirmed that way are flagged explicitly rather than
guessed at silently (see gotcha #2 below).

Read [README.md](README.md) first for setup/deploy steps and the current list of known
limitations. This file is for anyone (human or agent) about to *change* the code.

## Files

- `workflow.yaml` — 5 tasks, all `dynatrace.automations:run-javascript`, chained via
  `await (await execution(execution_id)).result('task_name')`: `get_dashboard` +
  `get_alerts` (parallel) → `transform` → `ingest_metrics` + `ingest_events` (parallel).
- `dashboard.yaml` — 8 tiles (markdown header, 4 KPI singleValues, 1 trend line chart, 2
  tables). Deliberately a small **verification** dashboard, not a replacement for the old
  40-tile one — see README for why.
- `README.md` — setup, deploy, test, and the living list of known limitations. Keep it in
  sync with the code.
- `reference_extreme_dashboard_dql_audit.md` — audit of the old, separate, still-broken
  40-tile dashboard. Kept for context on what NOT to repeat; not itself part of this
  integration's deploy.

## Working with this repo

Use the **`dtctl` CLI** (Dynatrace's kubectl-style CLI) to deploy and test, not the
Dynatrace UI or REST calls by hand:

```bash
dtctl apply -f workflow.yaml --plain                                  # update in place (id is in the file)
dtctl apply -f dashboard.yaml --share-environment read --plain        # update + share (see gotcha #4)
dtctl exec workflow <id> --wait --show-results --timeout 3m --plain  # trigger + see per-task results
dtctl logs workflow-execution <execution-id> --plain
dtctl diff -f workflow.yaml --id <id>                                  # check for drift from what's deployed
dtctl query "timeseries avg(extreme.health.client), avg(extreme.health.device), by:{site.name}" -o json --plain
```

If `dtctl` isn't installed or configured, load its Claude Code skill (`dtctl`) before
writing DQL or workflow/dashboard YAML — it documents the schema and gotchas referenced
below.

## Gotchas already discovered the hard way (don't rediscover these)

1. **"Extreme Platform ONE," not XIQ directly.** `cloudapi.extremecloudiq.com` is the
   unified Platform ONE gateway now — the hostname is a historical artifact, not a sign
   this only talks to the old XIQ-only API. Services are path-prefixed:
   `/{service}/v1/{endpoint}` (e.g. `/pm/v1/analytics/dashboard`, `/alert/v1/alerts`).
   Auth is a long-lived API key (`Authorization: Bearer <key>`, generated once via
   Administration & Settings → Integrations in the UI — no REST endpoint for this), not
   the old XIQ `/login` + 24h-token dance.
2. **`DashboardResponse` and `WirelessUsageCapacityDataResponse` response schemas are
   unpublished** in Extreme's OpenAPI spec (confirmed empty `{}` schemas) even though the
   request-side filters are fully documented. `transform`'s field names
   (`siteName`/`siteId`/`deviceHealthScore`/etc.) are best-effort guesses based on this
   API's camelCase conventions elsewhere — not confirmed against a live response.
   `get_dashboard` logs the response's top-level keys on page 1 specifically so this is
   fixable from `dtctl logs workflow-execution` on the first real run, not a silent guess
   that stays wrong forever.
3. **`dtctl apply --write-id` doesn't always stamp the ID back** — hit
   `could not write ID back to file: no source file to write ID back to` even with a
   normal local file. If this happens, copy the `id` from the apply output into the
   YAML's top-level `id:` field by hand; otherwise every subsequent apply creates a
   duplicate resource instead of updating in place.
4. **Dashboard `isPrivate: false` in the YAML does not make it visible to others**
   (same gotcha the `genesys` integration in this repo already found). Visibility is a
   separate share action: `dtctl apply -f dashboard.yaml --share-environment read`
   (whole tenant) or `dtctl share dashboard <id> --user/--group ...` (specific people).
   Verify with `dtctl get dashboard <id> -o json --plain | grep isPrivate` after applying.
5. **Custom event property field mapping** (confirmed against Dynatrace docs, not
   assumed): `POST /api/v2/events/ingest`'s `eventType` becomes `event.type` in DQL,
   `title` becomes `event.name`, and everything under `properties` becomes flat
   top-level fields under the exact key given (e.g. `extreme.severity` — no
   `properties.` prefix, no nesting).
6. **Extreme's rate-limit headers follow the IETF RateLimit Headers draft**
   (structured-fields format: `RateLimit: "tenant-hour";r=7499`), not a simpler
   `X-RateLimit-*` header set. `get_dashboard`/`get_alerts` only read `Retry-After` for
   the single-retry logic today; parse the structured `RateLimit`/`RateLimit-Policy`
   headers instead if this needs to get smarter about pre-emptive throttling later.
7. **`/alert/v1/alerts` uses RFC 3339 timestamps** (`2024-02-22T10:00:00Z`) for
   `startTime`/`endTime`, not epoch milliseconds. Some older XIQ-generation
   documentation floating around shows epoch-ms for the equivalent legacy endpoint —
   don't copy that convention into this workflow's date handling.

## Verification approach

There is no CI/build for this — "testing" means applying to a real tenant and
triggering a real (or intentionally-failing) run:

```bash
dtctl apply -f workflow.yaml --plain
dtctl exec workflow <id> --wait --show-results --timeout 3m --plain
```

Without a real Extreme Platform ONE API key in the vault, expect `get_dashboard` and
`get_alerts` to fail with a 401 and `transform`/`ingest_metrics`/`ingest_events` to show
`DISCARDED` — that's the DAG's `conditions.states` gating working correctly, not a bug.
That's as far as this integration has been exercised end-to-end so far (both YAML files
were validated by applying them to a live tenant with the schedule trigger left
`isActive: false`, and every dashboard DQL query was syntax-checked with `dtctl query`
against real — if empty — data).

## Where to pick this up

Check README.md's "Known limitations / open items" first. The single highest-value next
step is running this against a real Extreme Platform ONE tenant to confirm the
`/analytics/dashboard` response shape (gotcha #2) and adjust `transform` / the
dashboard's color thresholds accordingly.
