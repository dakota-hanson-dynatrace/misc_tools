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
  vice versa) as a real inventory discrepancy, not a silently-dropped edge case. A device that's
  monitored but never backed up gets an **Add** action to onboard it on the spot - picking an
  existing Credential Vault entry rather than requiring a trip to Manage first. SNMP can't
  supply vendor, site, or management port, so those still need a human; the device is captured
  on the extension's next scheduled run, not immediately.
- **Changes** - fleet-wide change feed: every config version except each device's first.
- **Backup failures** - which devices failed last night and why (auth, unreachable, timeout,
  needs enable, host-key mismatch).
- **Device detail / Diff** - version history, stored config viewer, diff between any two
  versions.
- **Initial Setup** - one-time tenant provisioning: creates the three dedicated Grail buckets
  and the OpenPipeline routing that sends captured records there instead of `default_logs`.
  Shows a persistent banner and a nav indicator until it reports all-green.
- **Manage** - activate an already-uploaded extension version, and add/edit/remove devices in
  the monitoring configuration (metadata only - see [Security model](#security-model)). A
  device can point at its own Credential Vault entry instead of the configuration's shared
  credentials, for fleets that need a unique password per device.
- **Bulk Credentials** - a deliberately separate, admin-only page for provisioning or rotating
  vault entries at fleet scale. See [Credential provisioning and rotation at
  scale](#credential-provisioning-and-rotation-at-scale) - it is the one place in this app that
  is a real exception to the security model described below.

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
(signing CA, trust bootstrap, build, sign, upload, activate, monitoring configuration). Once it's running,
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
  configurations). Never touches a plaintext credential - `sanitizeDevice()`/
  `buildDeviceForWrite()` guarantee that a device read or write only ever carries a Credential
  Vault entry ID, never `username`/`password`, even if a raw config somewhere contained them.
- **`api/ncmCredentials.function.ts`** - the Bulk Credentials page's backend, and the one
  deliberate exception to the rule above. See [Credential provisioning and rotation at
  scale](#credential-provisioning-and-rotation-at-scale).

## Security model

- **Device credentials never reach the app or the browser** - with one deliberate, clearly
  isolated exception (bulk provisioning, described below). The extension resolves credentials
  from the Dynatrace Credential Vault at capture time; the rest of this app only ever sees a
  vault reference ID in the monitoring configuration, and its device-management code is
  written to never read or write the credential fields at all.
- **SSH host keys** are trust-on-first-use, then pinned - a `known_hosts` file would be
  extension state, which the design forbids. The observed fingerprint is written to Grail on
  every capture (`ncm.host.key.fingerprint`), but there is no in-app review queue for it yet;
  pinning it today means independently obtaining the fingerprint (e.g. `ssh-keyscan`) and
  entering it on the Manage tab, with policy set to `pinned`.
- **Uploading a new extension package is not a feature of this app**, and not an oversight:
  AppEngine functions cap request/response payload at 5 MB each way, and the collector's
  package is several MB - it does not fit through that boundary regardless of design choices.
  Build and sign stay a local step against the project's own private signing key.

## Credential provisioning and rotation at scale

Most fleets don't need this section - a handful of shared, tiered credentials (one per site,
per vendor, or per security zone) referenced by every device via the monitoring
configuration's `global_credentials` covers the common case, and never requires touching this
page at all. This section is for the minority case: a security policy that requires a unique
password per device, at a scale (hundreds or thousands of devices) where creating Credential
Vault entries one at a time through Settings doesn't work.

### Two ways to bulk-provision, and why both exist

| | `tools/bulk-provision-vault.ts` | The **Bulk Credentials** page in the app |
|---|---|---|
| Where it runs | Locally, by an admin with `dtctl` access | In the deployed app, in the browser |
| Does the app ever see a password? | No - never touches anything deployed | **Yes**, transiently, for this action only |
| Requires | `dtctl` / CLI access | Just a browser and the app's scopes granted |

The local script is the more conservative choice and keeps the app's "never sees a credential"
guarantee airtight, but requires giving every admin who onboards devices `dtctl`/CLI access -
not always realistic, and it only creates entries (no rotation). The in-app page trades that
guarantee, narrowly and visibly, for letting any admin with browser access create *or rotate*
credentials without CLI access. Pick whichever matches how your organization actually operates;
nothing about using one forecloses using the other later.

### Bulk Credentials page (`ncmCredentials.function.ts`)

Deliberately its own page, not folded into Manage, so this exception is easy to find and easy
to audit rather than buried in the routine device-management code path. It never logs a row,
never persists an uploaded file, and never echoes a password back in any response - only
aliases, vault entry IDs, and pass/fail status. Requires three additional scopes beyond what
the rest of the app needs (`credential-vault:entries:write/read/admin` - see `app.config.json`
for exactly what each is used for); a tenant admin has to consent to these separately, the
same as any other scope grant.

**Create** - CSV (`alias,username,password`), one new vault entry per row. Copy the returned
`credentialVaultId` into that device's entry on the Manage tab.

**Rotate - the long-term-management answer.** CSV (`credentialVaultId,username,password`),
updates each entry **in place** via the Credential Vault API's `PUT /entries/{id}`, which
replaces the password without changing the entry's ID. This is the entire point: rotating a
password never requires touching the monitoring configuration or any device record - every
device that already references that vault entry picks up the new password automatically on
its next scheduled capture. The alternative (creating a new entry per rotation and updating
every device that pointed at the old one) doesn't scale and was rejected for exactly that
reason.

A few things worth knowing about rotation specifically:
- It requires `credential-vault:entries:admin` - a materially more privileged scope than the
  `:write` scope creation needs, since it can modify (and, if ever extended to use it, delete)
  an existing credential rather than only add new ones. Review this scope grant deliberately,
  not as a rubber stamp alongside the others.
- The function reads each entry's existing metadata first (name, scopes, `ownerAccessOnly`)
  and reuses it - the Credential Vault's `GET` endpoint never returns `username`/`password` at
  all (confirmed against the real API schema), so there is no secret to accidentally handle on
  the read side; only the new username/password you supply ever get written.
- It refuses to rotate an entry that isn't `USERNAME_PASSWORD` type, in case a vault ID from
  somewhere else in the tenant gets pasted in by mistake.
- **Nothing here talks to an external secrets manager.** If your organization rotates network
  device credentials from CyberArk, HashiCorp Vault, or a similar PAM system, that rotation has
  to be mirrored into the Dynatrace Credential Vault by *something* - either by hand through
  this page, or by having your PAM system's own rotation pipeline call the same
  `PUT /entries/{id}` API directly. Building that sync is a real, separate piece of work this
  app does not attempt; until it exists (or the manual step is accepted as policy), a rotation
  on the PAM side that isn't mirrored here means captures start failing `auth_failed`
  fleet-wide with no warning until someone notices.

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
  a second secret; this is a documented onboarding requirement, not a schema limitation
  (the schema already has an `enableSecretVaultId` field for it - the collector code just
  doesn't read it yet), and has not been tested against a real device that needs `enable`.
- Revert detection is computed (`versionPeriods`'s `reverted` field: a config that changed away
  and came back within its observed span) but not yet surfaced anywhere in the UI - it's
  discarded after the query runs. The Changes page shows every change; it doesn't yet
  distinguish a revert from a forward change.
- SSH host-key fingerprints are captured on every run (`ncm.host.key.fingerprint`) but there is
  no in-app queue to review and one-click-approve an observed value yet. Pinning a fingerprint
  today means obtaining it independently and entering it on the Manage tab.

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

### `npm run create:action`

Generates a new action in the app.

### `npm run update`

Updates `@dynatrace-sdk`/`@dynatrace` packages and applies automatic migrations.

### `npm run lint`

Runs ESLint.

### `npm run info`

Outputs App Toolkit and environment information - useful for confirming which tenant/version
`dt-app` thinks it's pointed at.

### `npm run help`

Outputs `dt-app` CLI help.

## Learn more

[Dynatrace Developer](https://dt-url.net/developers) has the App Toolkit and platform SDK
reference. [React documentation](https://reactjs.org/) for the UI framework.

## Disclaimer

A personal project, not an official Dynatrace product or supported offering. See the repo
root `README.md`.
