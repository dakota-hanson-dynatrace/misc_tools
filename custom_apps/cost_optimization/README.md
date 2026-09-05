# Cost Optimization

A Dynatrace custom app that surfaces FinOps cost-saving opportunities across three tabs:

- **Hosts** — CPU, memory, and disk usage per host (7d avg), flagging downsize candidates and hosts near capacity.
- **Kubernetes** — node capacity headroom, plus a per-container CPU/memory request-vs-usage table with generated `kubectl set resources` commands sized off p90 CPU / peak memory usage (mirrors a common FinOps rightsizing dashboard pattern).
- **Cloud** — AWS EC2 / Azure VM / GCP Compute utilization and unattached-volume detection across all three providers.

This project was bootstrapped with Dynatrace App Toolkit and uses React with TypeScript for the UI. Layout follows the [`ncm`](../../ncm/app/ui/app) app's pattern (hand-rolled tab nav, `useXxxQuery` over `useDql`, DQL builders in `lib/queries.ts`).

Every query in `ui/app/lib/queries.ts` was confirmed via `dtctl query` against a live environment before being wired in. The Cloud tab's queries were verified against `demo-live` (which has real AWS/Azure/GCP entities) since the deployment target (`ditmar`) doesn't monitor any cloud provider today — they'll render empty there until that changes.

## Available Scripts

### `npm run start`

Runs the app in development mode. A new browser window with your running app will be automatically opened.

### `npm run build`

Builds the app for production to the `dist` folder.

### `npm run deploy`

Builds the app and deploys it to the environment in `app.config.json`.

### `npm run uninstall`

Uninstalls the app from the environment in `app.config.json`.

### `npm run lint`

Lints the project with ESLint.

## Learn more

You can find more information on how to use all the features of the new Dynatrace Platform in [Dynatrace Developer](https://dt-url.net/developers).
