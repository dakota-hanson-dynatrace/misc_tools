# AI Coding Agent Instructions

## Project Overview

This is a Dynatrace **Workflow** (Automation Engine) + **Dashboard** pair, not a custom
app or Extension. There's no build step, no `dt-app` toolkit, no npm — it's two
declarative resource files applied directly to a Dynatrace tenant with `dtctl`. It polls
Oracle Fusion Cloud Applications' Enterprise Scheduler Service (ESS) REST API on a
schedule for job-request status across ERP/HCM/SCM, and ingests the result into
Dynatrace as `oracle_fusion.ess.*` metrics plus `CUSTOM_ALERT` events, with a small
verification dashboard on top.

A custom Extension was considered and rejected: no pre-built Dynatrace Extension for
Oracle Fusion exists, and building/versioning/packaging one (EF2 lifecycle) is
disproportionate for what's fundamentally a periodic REST pull + transform + ingest. A
Workflow does the same job with far less to own — same reasoning as this repo's other
SaaS-vendor integrations (see `../genesys/`).

Read [README.md](README.md) first for setup/deploy steps and the current list of known
limitations, and `oracle_fusion_observability_breakdown.md` for the research behind
*why* ESS specifically (what else was considered, what's available vs. deferred, auth,
rate limits). This file is for anyone (human or agent) about to *change* the code.

## Files

- `workflow.yaml` — 5 tasks, all `dynatrace.automations:run-javascript`, chained via
  `await (await execution(execution_id)).result('task_name')`: `get_token` →
  `get_ess_requests` → `transform` → `ingest_metrics` + `ingest_events` (parallel). One
  fetch task, not two/three like some sibling integrations — ESS's response carries both
  metric-worthy and event-worthy fields in a single row, no separate alerts/lookup
  endpoint to join.
- `dashboard.yaml` — 8 tiles (markdown header, 4 KPI singleValues, 1 trend line chart, 2
  tables) using DQL `timeseries` + `arraySum`/`arrayAvg` to collapse metric arrays to
  scalars, and `fetch events | filter event.type == "CUSTOM_ALERT"` for the two tables.
- `README.md` — setup, deploy, test, and the living list of known limitations. Keep it in
  sync with the code — it's the first thing a customer-facing reader opens.
- `oracle_fusion_observability_breakdown.md` — standalone research reference: the full
  landscape of what Oracle Fusion exposes for observability (API and otherwise), why ESS
  was chosen over the alternatives, auth, rate limits, and the business case. Not
  required reading to modify the code, but read it before proposing a new data source —
  it likely already covers why that source was or wasn't built.

## Working with this repo

Use the **`dtctl` CLI** (Dynatrace's kubectl-style CLI) to deploy and test, not the
Dynatrace UI or REST calls by hand:

```bash
dtctl apply -f workflow.yaml --write-id --plain                                   # first apply: creates + stamps id into file
dtctl apply -f dashboard.yaml --write-id --share-environment read --plain
dtctl exec workflow <id> --wait --show-results --timeout 3m --plain               # trigger + see per-task results
dtctl logs workflow-execution <execution-id> --plain
dtctl diff -f workflow.yaml --id <id>                                             # check for drift from what's deployed
dtctl query "timeseries sum(oracle_fusion.ess.job.count) by:{status_bucket}" -o json --plain
```

If `dtctl` isn't installed or configured, look for its Claude Code skill (`dtctl`) —
load it before writing DQL or workflow/dashboard YAML, it documents the dashboard schema
and gotchas referenced below.

## Gotchas already discovered the hard way (don't rediscover these)

1. **Workflow YAML has TWO different "standard" shapes — only one works with `dtctl
   apply`.** Dynatrace's official `Dynatrace-workflow-samples` GitHub repo uses a
   `metadata:` + `workflow: {title, tasks, trigger, schemaVersion: 3}` wrapper. That's an
   **import/export bundle format**, not what `dtctl apply`/`dtctl get workflow -o yaml`
   actually use. The real shape is **flat**: `title`, `tasks`, `trigger`, `triggerType`,
   `type`, `hourlyExecutionLimit`, `schemaVersion: 4` all at the top level, no wrapper —
   exactly what `workflow.yaml` in this folder looks like (confirmed against this repo's
   `../genesys/workflow.yaml`, itself confirmed against a live tenant export).
2. **A dashboard's `isPrivate: false` in the YAML does not make it visible to others.**
   Visibility is a separate share action: `dtctl apply -f dashboard.yaml
   --share-environment read` (everyone in the tenant, read-only) or `dtctl share
   dashboard <id> --user/--group ...` (specific people). Check with `dtctl get dashboard
   <id> -o json --plain | grep isPrivate` after applying if in doubt.
3. **Free-text dimension/property values must be sanitized before use.** `product`,
   `application`, `job_name` (from `jobDisplayName`), and `request_category` routinely
   contain spaces (e.g. "Order Management"-style names). `transform`'s `sanitize()`
   strips `,`/`=`/space/newline before building the metric-ingest dims string — skipping
   this breaks the `metric.key,dim=val,dim2=val2 value timestamp` line-protocol parse
   (space separates value/timestamp, comma separates dimensions). This was caught in
   design review before it ever shipped — don't reintroduce an unsanitized field.
4. **Event `properties` keys must be consistently namespaced** (`oracle_fusion.ess.*`,
   never bare keys like `job_name`), and numeric values (`request_id`,
   `elapsed_time_ms`) must be `String()`-coerced — Events Ingest v2's `properties` bag is
   string-typed. Also caught in design review; an earlier draft had bare keys for some
   properties and namespaced keys for others, which would have made `dashboard.yaml`'s
   event-table queries silently return nulls for half the columns.
5. **No documented Oracle rate limit, and `Retry-After` is not confirmed** for Fusion
   REST APIs (unlike some other vendors integrated in this repo, which fully document
   IETF rate-limit headers). `get_ess_requests`'s backoff is a fixed schedule (4 total
   attempts, 3 delays: ~2s/4s/8s + jitter) on 429/5xx, not a header-driven wait — don't
   "simplify" this to trust a `Retry-After` header Oracle hasn't committed to sending.
6. **The ESS response's pagination wrapper shape (`items`/`hasMore`) and the exact `q`
   filter operator are assumed, not confirmed** against a live tenant — only the
   per-row *fields* (`requestId`, `state`, etc.) are doc-confirmed. `get_ess_requests`
   logs `Object.keys(json)` on page 1 specifically so a real run makes the actual shape
   visible in `dtctl logs workflow-execution`. If items come back empty on a live run,
   check that log line before assuming the workflow itself is broken.
7. **24h fetch lookback vs. 15-min event timeout are deliberately different windows,
   not a bug.** ESS jobs can run for hours (month-end close, payroll), so
   `get_ess_requests` looks back 24h to avoid losing still-running jobs — but each
   `CUSTOM_ALERT`'s `timeout: 15` stays tied to the 5-min poll interval (3x, same
   convention as other event-emitting integrations in this repo). A failed job keeps
   refreshing its alert every poll as long as it's both still alert-worthy *and* within
   the 24h window; if nobody resolves it for 24h, the alert auto-closes even though the
   job may still show `ERROR` in Fusion. Don't read that auto-close as resolution, and
   don't "fix" the mismatch by shrinking the lookback — that would reintroduce the
   long-running-job visibility gap this design avoids.
8. **Event dedup is resend + Dynatrace's own timeout-refresh, not a persisted
   "already-alerted" store** — `requestId` is carried as `oracle_fusion.ess.request_id`
   purely as a human/DQL-visible identity key. This was a deliberate scope decision, not
   an oversight: `requestId` being genuinely unique per execution makes the resend
   pattern read cleanly during triage. Don't add a persistence layer for this unless a
   concrete need for independent alert-acknowledgment tracking shows up.

## Verification approach

There is no CI/build for this — "testing" means applying to a real tenant and
triggering a real (or intentionally-failing) run. **This integration has not yet been
exercised against a live Oracle Fusion tenant** — everything above was verified via
`dtctl verify query` against a live Dynatrace tenant (DQL syntax, dashboard schema) and
`node --check` + assert-based self-checks on the transform logic (sanitization,
state-bucketing, alert-eligibility, timestamp fallbacks all pass), but the actual ESS API
calls (`get_token`, `get_ess_requests`) have only been checked against Oracle's published
docs, not a live Fusion pod.

```bash
dtctl apply -f workflow.yaml --write-id --plain
dtctl exec workflow <id> --wait --show-results --timeout 3m --plain
```

Without real Oracle Fusion credentials in the vault, expect `get_token` to fail against
the placeholder `iamDomainUrl`/`scope` and every downstream task to show `DISCARDED` —
that's the DAG's `conditions.states` gating working correctly, not a bug. The moment real
`oracle_fusion_client_id`/`oracle_fusion_client_secret` and a real `fusionBaseUrl` exist,
re-run with `--show-results` and check `get_ess_requests`'s logged
`Sample ESS response keys: ...` line against what `transform` assumes (see gotcha #6).

## Where to pick this up

Check README.md's "Known limitations / open items" first — it's the live list of what's
deliberately deferred vs. genuinely unverified. The single highest-value next step is
running this against a real Oracle Fusion sandbox/tenant to confirm: the OAuth scope for
a cross-product API like ESS (README setup step 5), the pagination wrapper shape and `q`
filter syntax (gotcha #6), and the Security Console job/data-role name actually needed
(README setup step 7) — then adjust `get_token`/`get_ess_requests` accordingly.
