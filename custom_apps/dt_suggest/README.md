# dt suggest

A Dynatrace custom app that surfaces chronic trace failure patterns Davis never alerts on, and proposes a fix for each one: a scheduled workflow clusters root-cause exceptions from failed spans, has Dynatrace Intelligence merge the near-duplicates into ranked issues with a likely cause and a concrete fix, and the app renders them with trace-level evidence.

Davis alerts on *change*. Steady-state breakage never raises a problem because it **is** the baseline — a service throwing 28,000 connection refusals every six hours looks exactly like normal to anomaly detection. This app reads that blind spot. It follows the shape of [Arize Signal](https://arize.com/docs/ax/observe/signal), but does far less work with a model: Dynatrace already knows what "failed" means, so clustering is a DQL `summarize` and the model only handles the last mile.

This project was bootstrapped with Dynatrace App Toolkit and uses React with TypeScript for the UI.

## Architecture

```
Workflow (cron 0 */6 * * *)              App  my.dt.suggest
  └─ run-javascript                        ├─ function  analyze
       fetch('/apps/my.dt.suggest/         │    1. DQL clusters root-cause exceptions
              api/analyze')                │    2. Dynatrace Intelligence merges + explains
                                           │    3. diffs against the previous run
                                           │    4. stateClient.setAppState('findings')
                                           └─ UI  reads app state, renders ranked issues
```

- **Pipeline logic** (`lib/pipeline.ts`) — prompt construction, response parsing, and the run-to-run diff. Free of platform SDK calls so `lib/pipeline.selfcheck.ts` can exercise it directly.
- **Backend** (`api/analyze.function.ts`) — the only thing that writes findings. Queries spans, calls the conversational skill once for the whole cluster set, diffs against the previous run, and persists to app state. It:
  - groups failures in DQL rather than in the model, using `dt.failure_detection` and `exception.is_caused_by_root`, so the model's only job is merging near-duplicate endpoints and messages
  - has the model return cluster *indices*, never counts — every number in the UI is recomputed from the DQL rows, so it cannot fabricate volume
  - budgets the prompt to 9,600 characters, shedding stack frames before whole clusters
  - never throws — it returns `{ ok: true, ... }` or `{ ok: false, error }`, because an exception that escapes the function is reported by the Dynatrace runtime as a generic "Execution crashed" with the actual message *and* the console logs stripped
- **UI** (`ui/app/pages/Issues.tsx`) — reads the `findings` app state, renders a ranked table with expandable detail, and links each issue's sampled traces into Distributed Tracing via intent. Dismissing an issue records its key so the suppression survives future runs, including runs where the issue lapses and later returns.

Findings live in app state (10 MB per value, 50 MB per app), which is ample for a few dozen issues but keeps no history — move to business-event ingest if trending over time matters. There is no repository integration, so fixes stay advisory: Signal's pull-request loop needs code context that trace data alone does not carry.

## Setup

1. Set `environmentUrl` in `app.config.json` to your tenant, then `npm install && npm run deploy`.
2. Open the app once as an admin to approve its scopes.
3. Deploy the schedule: `dtctl apply -f workflow.yaml`.

The workflow calls the app function, so the app must be deployed first. The function inherits the **caller's** permissions narrowed by the app's declared scopes, so the workflow's actor needs `storage:spans:read` and `davis-copilot:conversations:execute` of its own — otherwise the scheduled run comes back empty while the same function works fine from the UI.

Trigger a run without waiting for the schedule with `dtctl exec workflow <id>`, or select **Analyze now** in the app.

## Notes

Things that are non-obvious and cost time:

- **The conversational skill caps `text` at 10,000 characters**, returning `400 Constraints violated` past that. `MAX_PROMPT_CHARS` in `lib/pipeline.ts` is the knob.
- **Asking for "JSON only, no prose" inside the prompt trips the skill's guardrail** — it answers "this doesn't seem to be a valid question" and returns nothing usable. Output format has to travel in the `instruction` context item instead.
- **`storage:buckets:read` is mandatory** alongside `storage:spans:read`. Without it a span query returns SUCCEEDED with zero records and zero scanned bytes; the only evidence is a `MISSING_BUCKET_PERMISSIONS` warning in `result.metadata.grail.notifications`, which `fetchClusters` reads and turns into a real error.
- **A `dtctl` OAuth token usually has no `state:app-states:write`**, so invoking `analyze` from the CLI fails at the persist step while the UI and the workflow succeed. That is the token, not the app.
- **Deploys take 30-60s to roll over.** Immediately after `npm run deploy`, function calls still run the previous bundle.

## Self-check

`lib/pipeline.selfcheck.ts` asserts the new/recurring/dismissed diff logic and the prompt budget. No test runner is installed:

```bash
npx esbuild lib/pipeline.selfcheck.ts --bundle --platform=node --format=cjs --outfile=/tmp/check.js && node /tmp/check.js
```

## Available Scripts

In the project directory, you can run:

### `npm run start`

Runs the app in the development mode. A new browser window with your running app will be automatically opened.

Edit a component file in `ui` and save it. The page will reload when you make changes. You may also see any errors in the console.

### `npm run build`

Builds the app for production to the `dist` folder. It correctly bundles your app in production mode and optimizes the build for the best performance.

### `npm run deploy`

Builds the app and deploys it to the specified environment in `app.config.json`. Bump `version` in `app.config.json` first — redeploying the same version with different content fails on a checksum mismatch.

### `npm run uninstall`

Uninstalls the app from the specified environment in `app.config.json`.

### `npm run create:function`

Generates a new serverless function for your app in the `api` folder.

### `npm run update`

Updates @dynatrace-scoped packages to the latest version and applies automatic migrations.

### `npm run info`

Outputs the CLI and environment information.

### `npm run help`

Outputs help for the Dynatrace App Toolkit.

## Learn more

You can find more information on how to use all the features of the new Dynatrace Platform in [Dynatrace Developer](https://dt-url.net/developers).

To learn React, check out the [React documentation](https://reactjs.org/).
