# AI Coding Agent Instructions

## Project Overview

This is a Dynatrace **Workflow** (Automation Engine) + **Dashboard** pair, not a custom app. There's no build step, no `dt-app` toolkit, no npm — it's two declarative resource files applied directly to a Dynatrace tenant with `dtctl`. It pulls Genesys Cloud contact-center metrics (voice, chat, email, message, callback) on a schedule and ingests them into Dynatrace as `genesys.*` metrics, with an executive dashboard on top.

A custom Extension was considered and rejected: no pre-built Dynatrace Extension for Genesys exists, and building/versioning/packaging one (EF2 lifecycle) is disproportionate for what's fundamentally a periodic REST pull + transform + ingest. A Workflow does the same job with far less to own.

Read [README.md](README.md) first for setup/deploy steps and the current list of known limitations. This file is for anyone (human or agent) about to *change* the code.

## Files

- `workflow.yaml` — 5 tasks, all `dynatrace.automations:run-javascript`, chained via `await (await execution(execution_id)).result('task_name')`: `get_token` → `get_queues` + `get_metrics` (parallel) → `transform` → `ingest_metrics`.
- `dashboard.yaml` — 8 tiles (markdown header, 4 KPI singleValues, 1 trend line chart, 2 tables) using DQL `timeseries` + `arraySum`/`arrayAvg` to collapse metric arrays to scalars.
- `README.md` — setup, deploy, test, and the living list of known limitations. Keep it in sync with the code — it's the first thing a customer-facing reader opens.

## Working with this repo

Use the **`dtctl` CLI** (Dynatrace's kubectl-style CLI) to deploy and test, not the Dynatrace UI or REST calls by hand:

```bash
dtctl apply -f workflow.yaml --id <existing-id> --plain              # update in place
dtctl apply -f dashboard.yaml --id <existing-id> --share-environment read --plain
dtctl exec workflow <id> --wait --show-results --timeout 3m --plain  # trigger + see per-task results
dtctl logs workflow-execution <execution-id> --plain
dtctl diff -f workflow.yaml --id <id>                                  # check for drift from what's deployed
dtctl query "timeseries sum(genesys.conversations.offered) by:{media_type}" -o json --plain
```

If `dtctl` isn't installed or configured, look for its Claude Code skill (`dtctl`) — load it before writing DQL or workflow/dashboard YAML, it documents the dashboard schema and gotchas referenced below.

## Gotchas already discovered the hard way (don't rediscover these)

1. **Workflow YAML has TWO different "standard" shapes — only one works with `dtctl apply`.** Dynatrace's official `Dynatrace-workflow-samples` GitHub repo uses a `metadata:` + `workflow: {title, tasks, trigger, schemaVersion: 3}` wrapper. That's an **import/export bundle format**, not what `dtctl apply`/`dtctl get workflow -o yaml` actually use. The real shape (confirmed by exporting a live workflow from this tenant) is **flat**: `title`, `tasks`, `trigger`, `triggerType`, `type`, `hourlyExecutionLimit`, `schemaVersion: 4` all at the top level, no wrapper — exactly what `workflow.yaml` in this folder looks like. If `dtctl apply` on a workflow file silently creates a **dashboard** instead (yes, this happened), the top-level shape doesn't match anything it recognizes — check against a real `dtctl get workflow <id> -o yaml` export, not a sample repo.
2. **A dashboard's `isPrivate: false` in the YAML does not make it visible to others.** Visibility is a separate share action: `dtctl apply -f dashboard.yaml --share-environment read` (share with everyone in the tenant) or `dtctl share dashboard <id> --user/--group ...` (specific people). **You cannot verify this after the fact from `isPrivate`** — confirmed empirically while auditing this across `custom_integrations/`: `dtctl get dashboard <id> -o json` / `describe` only ever expose `id`, `name`, `type`, `owner`, `isPrivate`, `version`, `modificationInfo`, `content`, regardless of actual sharing state — there is no share/environment/recipient field in that output at all, and `dtctl share dashboard` itself only covers per-user/per-group shares, not the whole-environment case. Since `--share-environment read` is idempotent, the reliable move is to just (re-)apply it rather than trying to check first.
3. **Dashboard DQL for metrics**: use `timeseries`, not `fetch`/`makeTimeseries` (those are for logs/spans). To turn a `timeseries` array into a single scalar for a `singleValue` tile or a table cell, pipe through `fieldsAdd x = arraySum(value)` or `arrayAvg(value)` — confirmed working against live data. `if(cond, then: x, else: y)` requires named params, not positional.
4. **Dashboard coloring**: use `coloring.colorRules` with a `value: -1` catch-all sentinel as the first (most permissive) rule, last-wins ordering. The `thresholds` shorthand silently drops any rule without an explicit lower bound on save — don't use it if you need a baseline color.
5. **Every `data` tile needs `davis: { enabled: false, davisVisualization: { isAvailable: true } }`**, and every layout `"y"` key must be quoted (bare `y` parses as YAML boolean `true`).
6. **Genesys conversation-aggregate `stats` has no `avg` field** for timer metrics (`tWait`, `tHandle`, `tTalk`, `tAcw`, `tAgentResponseTime`) — only `count`/`sum`/`max`/`min`. Derive average as `sum / count`. This was a real, silent bug in an earlier version of `transform` (read `m.stats.avg` → always `undefined` → metric silently never ingested). See `extractValue()` in `workflow.yaml`'s `transform` task.
7. **Secrets are spliced into the JS source as raw text** (`{{ secret('name') }}` → literal string substitution before the script runs), not passed in as a JS variable at runtime. A secret containing an unescaped `"` or backtick would break the generated JS. Holds fine for Genesys-issued client credentials (URL-safe strings) — reconsider if this pattern is reused for a freeform secret.
8. **Genesys's OAuth token endpoint requires HTTP Basic auth** (`Authorization: Basic base64(id:secret)`) for the client-credentials grant — sending `client_id`/`client_secret` in the body instead does not work. Confirmed live: a request with fake credentials got back a real `invalid_client` response, not a malformed-request error.

## Verification approach

There is no CI/build for this — "testing" means applying to a real tenant and triggering a real (or intentionally-failing) run:

```bash
dtctl apply -f workflow.yaml --id <id> --plain
dtctl exec workflow <id> --wait --show-results --timeout 3m --plain
```

Without real Genesys credentials in the vault, expect `get_token` to fail with a Genesys-returned `invalid_client` and every downstream task to show `DISCARDED` — that's the DAG's `conditions.states` gating working correctly, not a bug. That's as far as this integration has been exercised end-to-end so far. The moment real `genesys_client_id`/`genesys_client_secret` exist in a tenant's vault, re-run the trigger and use `--show-results` to sanity-check the `get_metrics` response shape against what `transform`'s `METRIC_MAP`/`extractValue()` assume — particularly `oServiceLevel` (see README's "Known limitations").

## Where to pick this up

Check README.md's "Known limitations / open items" first — it's the live list of what's deliberately deferred vs. genuinely unverified. The single highest-value next step is running this against a real Genesys Cloud sandbox to confirm the `get_metrics` response shape (especially `oServiceLevel`) and adjust `transform` / the dashboard's color thresholds accordingly.
