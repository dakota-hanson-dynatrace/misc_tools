# Network Config Manager (`my.ncm`)

A Dynatrace custom app for network device configuration backup, version history, diffing, and
drift detection - modeled on the SolarWinds NCM problem space, built natively inside
Dynatrace. Read-only by design: it backs up and compares configs, it does not push changes to
devices.

This app owns all storage, comparison, and UI. It has one counterpart, the
[`custom:ncm-collector`](../../extensions/ncm-collector/) extension, which does the actual SSH
capture and holds no state of its own. **Neither is useful without the other.** If you haven't
deployed the extension yet, start there - this app has nothing to show without real captures
feeding it.

This project was bootstrapped with the Dynatrace App Toolkit and uses React with TypeScript
for the UI.

## What it does

- **Devices** - fleet inventory: capture status, version count, failure count, last capture
  time.
- **Coverage** - cross-references devices Dynatrace already knows about via SNMP against what
  is actually being backed up, surfacing devices that are monitored but never backed up (or
  vice versa) as a real inventory discrepancy, not a silently-dropped edge case.
- **Changes** - fleet-wide change feed, with revert detection (a config that changed away and
  came back is flagged, not just silently omitted).
- **Backup failures** - which devices failed last night and why (auth, unreachable, timeout,
  needs enable, host-key mismatch).
- **Device detail / Diff** - version history, stored config viewer, diff between any two
  versions.
- **Initial Setup** - one-time tenant provisioning: creates the three dedicated Grail buckets
  and the OpenPipeline routing that sends captured records there instead of `default_logs`.
  Shows a persistent banner and a nav indicator until it reports all-green.
- **Manage** - activate an already-uploaded extension version, and add/edit/remove devices in
  the monitoring configuration (metadata only - see [Security model](#security-model)).

## Setup

### Prerequisites

- A Dynatrace tenant with an OAuth client that can consent to this app's declared scopes
  (`app.config.json`), and - separately - a tenant admin able to grant one IAM policy (see
  step 3).
- Node.js and `dtctl` (>= 0.38.0) for deploying this app.
- The `custom:ncm-collector` extension deployed and capturing at least one device - see its
  [README](../../extensions/ncm-collector/README.md). You can do the two steps below first and
  the extension after; nothing here depends on a real capture existing yet.

### 1. Configure and deploy the app

```bash
npm install
```

Edit `app.config.json`: replace `<YOUR-TENANT-ID>` in `environmentUrl` with your real tenant
ID. `dt-app build` validates this and refuses a placeholder.

```bash
./bump-deploy.sh    # bumps the patch version, then dt-app deploy
```

`dt-app` refuses to redeploy a version whose bundle checksum changed but whose version number
didn't, so every deploy after the first needs a fresh version - `bump-deploy.sh` does that
automatically. It also reports success before the function is actually served; wait a few
seconds and confirm with `dtctl get apps my.ncm --context <your-context>` before testing.

### 2. Run Initial Setup

Open the app, go to the **Initial Setup** tab, and click **Run Initial Setup**. It's
idempotent and defaults to previewing changes - re-running it once everything exists reports
"Already set up" for every step and changes nothing.

**If it fails with a permissions error**, this is the one step that needs a tenant admin
outside the app itself: the app's own OAuth client needs the
`storage:bucket-definitions:write` **IAM policy** bound to it (Account Management → Identity &
Access Management → find the client registered for this app → bind a policy granting that
permission). This is a separate gate from the OAuth *scope* consent you already gave the app
when it first loaded - having the scope does not imply having the policy, and the error
message from a missing policy looks identical to a missing scope. `settings:objects:write`
(needed for the OpenPipeline routing step) has not been observed to need the same extra grant,
but hasn't been exhaustively proven not to either.

**What it actually does**, safely and idempotently:
- Creates `ncm_index` (730-day retention), `ncm_captures` (14-day), `ncm_versions` (730-day).
- Creates one custom OpenPipeline pipeline with three conditional bucket-assignment
  processors, one per `ncm.record.type`.
- Appends **one entry** to your tenant's existing `builtin:openpipeline.logs.routing`
  object - the object every other integration's routing rules already live in. This step only
  ever reads the current value and appends; it never reconstructs or replaces what's there.

### 3. Deploy the extension and start capturing

See the [collector's README](../../extensions/ncm-collector/README.md) for the full sequence
(build, sign, upload, activate, trust bootstrap, monitoring configuration). Once it's running,
the **Manage** tab in this app lets you add/edit/remove devices without hand-editing YAML for
anything that isn't a credential.

**Also apply `extensions/ncm-collector/workflows/ncm-promote-schedule.yaml`.** Without it, a
real capture is only turned into a browsable "version" record when someone manually runs
`dtctl exec function my.ncm/ncmPromote`. That's the single biggest gap between "captures are
happening" and "the app actually shows them" - the workflow closes it. It ships with its
schedule trigger disabled; verify it against your own tenant (see that file's header comment
for exactly how it was verified here), then flip `isActive: true`.

## Architecture

- **UI** (`ui/`) - reads everything via DQL against Grail. No local/document-based state; the
  UI is a pure view over what the extension has captured and `ncmPromote` has promoted.
- **`api/ncmPromote.function.ts`** - turns `capture` blobs into durable `version` records. One
  invocation drains the whole fleet (bounded by a byte/time budget, returns `remaining`);
  deliberately not per-device fan-out, which would hit AutomationEngine's documented
  concurrency limits. Idempotent - a second run with nothing new to promote is a no-op.
- **`api/ncmSetup.function.ts`** - the Initial Setup tab's backend. Every step checks current
  state before writing anything; defaults to a dry run.
- **`api/ncmExtension.function.ts`** - the Manage tab's backend. Calls the Extensions 2.0 API
  directly via the generic `httpClient` export (no dedicated SDK client exists for monitoring
  configurations). Never touches `global_credentials` - every device write reads the full
  configuration and replaces only `pythonRemote.devices`, sending the rest back exactly as
  read.

## Security model

- **Device credentials never reach the app or the browser.** The extension resolves them from
  the Dynatrace Credential Vault at capture time; this app only ever sees a vault reference ID
  in the monitoring configuration, and its own device-management code is written to never
  read or write the credential fields at all.
- **SSH host keys** are trust-on-first-use, then pinned - a `known_hosts` file would be
  extension state, which the design forbids, so the first-observed fingerprint is recorded and
  surfaces in the app for approval instead.
- **Uploading a new extension package is not a feature of this app**, and not an oversight:
  AppEngine functions cap request/response payload at 5 MB each way, and the collector's
  package is several MB - it does not fit through that boundary regardless of design choices.
  Build and sign stay a local step against the project's own private signing key.

## Current status and known limitations

- Only Fortinet FortiOS has been validated against real hardware; the other five vendor
  adapters (Cisco IOS/IOS-XE, Cisco NX-OS, Arista EOS, Juniper Junos, Palo Alto PAN-OS) are
  fixture-tested only. See the extension's README for the full device-support table.
- No config push or remediation - this app is intentionally read-only. EdgeConnect and EF2 v2
  extensions both have real technical walls in front of a push path today.
- Change attribution from syslog (who made a change) is deliberately not built - it would
  depend on syslog being wired up, which often isn't true for exactly the customers who need
  this app most.
- Cisco enable/privileged-mode credentials assume a `privilege 15` service account rather than
  a second secret; this is a documented onboarding requirement, not a schema limitation, and
  has not been tested against a real device that needs `enable`.

## Available Scripts

### `npm run start`

Runs the app in development mode.

### `npm run build`

Type-checks and bundles the app for production to the `dist` folder.

### `npm run deploy`

Builds the app and deploys it to the environment specified in `app.config.json`.

### `npm run uninstall`

Uninstalls the app from the specified environment.

### `npm run create:function`

Generates a new serverless function in the `api` folder.

### `npm run update`

Updates `@dynatrace-sdk`/`@dynatrace` packages and applies automatic migrations.

### `npm run lint`

Runs ESLint.

## Learn more

[Dynatrace Developer](https://dt-url.net/developers) has the App Toolkit and platform SDK
reference. [React documentation](https://reactjs.org/) for the UI framework.

## Disclaimer

A personal project, not an official Dynatrace product or supported offering. See the repo
root `README.md`.
