# IPAM

A Dynatrace custom app for tracking subnets and IP address assignments: manual entry, CSV import (including a dedicated SolarWinds IPAM import path), and correlation against Dynatrace-monitored host entities via "Sync from Dynatrace."

This project was bootstrapped with Dynatrace App Toolkit and uses React with TypeScript for the UI.

## Architecture

- **UI** (`ui/`) — reads subnet/IP data directly from the Document Service (`my-ipam-data-v1`) and polls every 20s to pick up other users' changes.
- **Backend** (`api/ipamMutate.function.ts`) — the sole write path. Every subnet/IP-record mutation (add, update, delete, bulk import, host sync) is routed through this one serverless function, which:
  - validates CIDR overlap and duplicate IP addresses before writing, using a precomputed bounds/key index so bulk imports don't rescan the whole data set per row
  - stamps `createdBy`/`updatedBy` from the authenticated caller, falling back to the browser-reported identity if the runtime doesn't populate it
  - retries automatically on optimistic-locking conflicts
  - never throws or rejects itself — it always returns `{ ok: true, result }` or `{ ok: false, message }`, because an exception that escapes the function is reported by the Dynatrace runtime as a generic "Execution crashed" with the actual message lost

This is an application-level write-path guarantee, not an IAM boundary: the function runs under the same document scopes the browser bundle already holds (see `initializeDatabase`/`load` in `ui/app/hooks/useDocumentStorage.ts`), so it centralizes validation and attribution for this app's own UI rather than enforcing them at the platform's permission layer.

## Available Scripts

In the project directory, you can run:

### `npm run start`

Runs the app in the development mode. A new browser window with your running app will be automatically opened.

Edit a component file in `ui` and save it. The page will reload when you make changes. You may also see any errors in the console.

### `npm run build`

Builds the app for production to the `dist` folder. It correctly bundles your app in production mode and optimizes the build for the best performance.

### `npm run deploy`

Builds the app and deploys it to the specified environment in `app.config.json`.

### `npm run uninstall`

Uninstalls the app from the specified environment in `app.config.json`.

### `npm run generate:function`

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
