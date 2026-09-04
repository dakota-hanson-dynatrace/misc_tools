# AI Coding Agent Instructions - NCM (app)

Network Configuration Management for Dynatrace: backup, version history, diff, drift
detection, and coverage against SNMP-monitored inventory. This is the `my.ncm` dt-app - all
storage, comparison, and UI. It has one counterpart, `custom:ncm-collector` (the EF2 Python
extension in the sibling `extensions/ncm-collector/` project) which does the actual SSH
capture. **Neither is useful without the other** - see the root `README.md`.

---

## Non-negotiables

These exist because each one was found the hard way, against a real tenant. Do not
"simplify" any of them away.

### 1. `content` truncates SILENTLY at 512 KiB

A 6 MB config is accepted with **HTTP 200, `ok:true`, no warning**, and stored as its first
524,288 bytes.

- **Always** write blobs through `buildBlobRecords()` (`ui/app/utils/records.ts`).
- **Always** read them through `reassemble()`, and honour `problem`.
- **Never** render a config whose reassembly failed. A truncated config displays as a change
  that never happened - the worst output this system can produce.
- Never put config text in an **attribute** - the attribute cap is 32 kB.

### 2. `ncm.capture.time` is logical time; `timestamp` is ingest time

Grail rejects timestamps more than 24h old (`"All logs are out of correct time range."`), so
`timestamp` cannot carry history. Every query's `from:` filters **ingest** time; every sort,
pairing and version comparison uses the `ncm.capture.time` attribute.

### 3. Prefix every app-owned field with `ncm.`

`event.type` is **reserved** - set it to anything and Grail stores `LOG`. Assume other
well-known names are similarly managed.

### 4. Both normalizers must agree

The extension's `normalize.py` and this app's `normalize.ts` must produce byte-identical
output for the same input - that is the whole basis for change detection being trustworthy.
The contract is `../../shared/normalize-fixtures.json` (one level up from this repo's
`custom_apps/`, shared with `extensions/ncm-collector/`); both self-checks run it and print
per-fixture digests, so drift is a visible `diff`.

Normalization computes the **hash only**. The app stores RAW config text - that is what makes
a normalizer bug repairable instead of permanently corrupting history.

### 5. The collector holds no state - do not build anything here that assumes it does

A hard requirement on the extension side, but it shapes this app too: this app is the ONLY
place comparison, storage, and fingerprint approval happen. Do not add a feature that expects
the collector to remember anything between runs.

---

## Running the checks

No test framework by design - plain assert scripts that run anywhere:

```bash
npx esbuild ui/app/utils/normalize.selfcheck.ts --bundle --platform=node --format=cjs --outfile=/tmp/n.js && node /tmp/n.js
npx esbuild ui/app/utils/records.selfcheck.ts   --bundle --platform=node --format=cjs --outfile=/tmp/r.js && node /tmp/r.js
npx esbuild ui/app/utils/coverage.selfcheck.ts  --bundle --platform=node --format=cjs --outfile=/tmp/c.js && node /tmp/c.js
```

Cross-language check: run this app's `normalize.selfcheck.ts` and the extension's
`normalize_selfcheck.py`, and diff the digest lists they print. They must match exactly.

## Deploying

```bash
./bump-deploy.sh     # bumps patch version, then dt-app deploy
```

- **Every deploy needs a fresh version.** Reusing one with a different checksum fails.
- **`dt-app deploy` reports success before the function is served.** Wait, and confirm with
  `dtctl get apps my.ncm --context <your-context>`. A test fired immediately after deploy hits
  the OLD code and produces thoroughly confusing results.
- A scope problem in `dt-app dev` is not confirmed until it reproduces in the **deployed**
  app - the dev server uses a separate, reduced-permission OAuth client.

**Rollback.** There is no dedicated rollback command - this is the actual procedure:
`git checkout` the last-known-good commit and run `bump-deploy.sh` forward from there (a new,
higher patch version is always required, even to go backward in behavior). `dist/` is
gitignored, so the commit history is the only record of what was actually deployed at a given
version number. Not automated, not rehearsed end-to-end - treat as the documented starting
point for a real incident, not a tested runbook.

## Initial Setup (`ncmSetup`) and Manage (`ncmExtension`)

`ncmSetup.function.ts` creates the three dedicated Grail buckets and the OpenPipeline
routing that sends captured records to them instead of `default_logs`. It is idempotent
(every step checks current state first) and defaults to a dry run - `dryRun` must be
explicitly set to `false` to write anything:

```bash
dtctl exec function my.ncm/ncmSetup --method POST --context <your-context> --payload '{"dryRun":true}'
```

The routing step reads and appends to the tenant's **one shared** `builtin:openpipeline.logs.routing`
object - every other integration's routing rules live in that same object. Never construct
that value from scratch; always read-modify-write.

`ncmExtension.function.ts` (the Manage tab) activates already-uploaded extension versions and
edits the monitoring configuration's device list. It calls the Extensions 2.0 API directly via
the generic `httpClient` export (`@dynatrace-sdk/http-client`) - no dedicated SDK client exists
for monitoring configurations. It never touches `global_credentials`: every device write reads
the full config, replaces only `pythonRemote.devices`, and sends the rest back exactly as
read - including the masked credential fields. Verified safe by hand before this code was
written: a masked value sent back unchanged round-trips byte-identical, and the underlying
credential survives.

**Uploading a new extension package is deliberately not a feature here.** The collector zip is
several MB; AppEngine functions cap request/response payload at 5 MB each way, so it does not
fit through the function boundary. Build and sign stay a local `dt-sdk` step in
`extensions/ncm-collector/` regardless of payload size, since that step needs the project's
private signing key.

## Promotion (`ncmPromote`)

```bash
dtctl exec function my.ncm/ncmPromote --method POST --context <your-context> --payload '{"dryRun":true}'
```

Turns `capture` records into `version` records - the link between what the collector writes
and what the UI reads. **One invocation drains the whole fleet**, bounded by a byte and time
budget, and returns `remaining` so a caller can invoke it again. Deliberately not per-device
fan-out: that hits a documented 429 concurrency cap, and the AutomationEngine docs say it
"isn't suitable as a data pipeline".

- Idempotent. A second run with no new captures finds `candidates: 0`.
- Refuses to promote a blob that fails its integrity check - a truncated config would become
  a permanent `version` reading as a change that never happened.
- **Line counts are measured on NORMALISED text**, matching the hash. Counting raw text
  reported `+2/-1` for a single added ACL line, because the vendor's own "last configuration
  change" timestamp counted as a change. Stored text stays raw; only the measurement is
  normalised.
- **A real capture that never gets promoted is invisible in the UI**, not just missing a
  version count - this is why `extensions/ncm-collector/workflows/ncm-promote-schedule.yaml`
  exists. Run it on a schedule; do not rely on remembering to invoke this by hand.

## Anything dtctl has no native verb for: `dtctl exec api`

**Look for this before concluding something needs a human or a raw curl call.** It calls any
operation the environment publishes, with discovery built in:

```bash
dtctl get apis
dtctl get apis --uncovered
dtctl describe api extensions
dtctl describe api extensions --operation 'POST /extensions/{extension-name}/environment-configuration'
dtctl exec api '<path>' -X POST -d @body.json
```

Two path gotchas found the hard way: the platform paths are **hyphenated**
(`monitoring-configurations`, `environment-configuration`), not camelCase as older classic API
docs show - a camelCase path returns a bare 404. And `dtctl exec api` prints a "prefer the
native command" warning whenever one exists; that is advice, not an error.

**What `exec api` does NOT get past: IAM.** `403 Required permissions not met` on bucket
creation is the same through the raw API as through `dtctl create bucket` - a genuine
permission gap (the token's OAuth scope and the underlying IAM policy are two separate gates;
`--check-scopes` validates only the former), not a tooling limitation. Grant the app's own
OAuth client `storage:bucket-definitions:write` at the IAM policy level, separately from the
scope consent it already has, before expecting `ncmSetup` to succeed.

---

## Platform traps

**`--check-scopes` lies.** It validates TOKEN SCOPES, not IAM permissions. `dtctl create
bucket --check-scopes` reports `ok` even when the actual call 403s.

**Bucket-partitioned tables need `storage:buckets:read` in ADDITION to `storage:logs:read`,**
or queries **silently return 0 records** with `MISSING_BUCKET_PERMISSIONS` in the metadata
while appearing to succeed.

**Grail bills bytes SCANNED per bucket.** `fields` is a projection applied after the scan and
buys nothing on its own - measured 328 MB vs 337 MB for different projections of the same
rows. Only bucket membership (which `ncmSetup`'s routing configures) reduces cost.

**DQL has no window functions.** `prev`, `lag`, `lead`, `rowNumber`, `over`, `partitionBy` are
all `UNKNOWN_FUNCTION`. Change detection is `summarize by {device, hash} | min(capture.time)` -
each distinct hash's first appearance is a change event.

**That method alone cannot see a REVERT.** A device going A -> B -> back to A produces no new
first-appearance for A, so the return is invisible. `versionPeriods` adds an explicit check:
captures are daily, so a continuously-active hash must appear once per day between its first
and last sighting. `captures < spanDays + 1` means the config moved away and came back - the
`reverted` flag. **Any change to change detection must be tested against a device that
reverts**, or synthetic test data that never reverts will "validate" a blind spot.

**`countDistinctExact(if(cond, x, else: ""))` counts the empty string** as a distinct bucket
and overstates by one. Drop the `else` - null is not counted.

**Grail is append-only.** `ncm.capture.id` must be deterministic per calendar day
(`<deviceId>-<YYYY-MM-DD>`) - a full-timestamp id makes a retried or re-triggered run mint a
second, undeduped record instead of collapsing into the same day. Every aggregating query
dedups on `ncm.capture.id`, and chunk reads dedup on `{ncm.capture.id, ncm.chunk.index}`. **Do
not remove those `dedup` clauses**, and sort by ingest `timestamp` before dedup wherever a
promotion index record can collide with the original (see `queries.ts`) - without a
deterministic sort, which of the two rows survives is scan-order luck.

**The SNMP metric carries the device address AND an entity link.** `device.address` (bare IP),
`device` (`ip:port`) and `` `dt.entity.network:device` `` are all dimensions on
`com.dynatrace.extension.network_device.sysuptime`. That is the only way to get an IP for a
network device - the *entity* exposes just `id`, `entity.name` and `tags`. It is
**best-effort**: a device not currently reporting the metric has no address at all.

**`Endpoints OK` does not mean data is flowing.** Assert on actual records, not on a status
field.

---

## Strato

**Grep the category's `index.d.ts` for the literal export name before using anything.** An
`_` prefix (`_Drawer`, `_Calendar`, `_BaseCodeEditor`) means private API.

**Type-checking is NOT proof a component renders.** `Sheet` and `HealthIndicator` both matched
their documented props, built clean, deployed, and rendered visibly broken in a sibling app -
and were reverted to hand-rolled equivalents. This app follows that precedent: `StatusDot` is
a plain coloured `<span>`, and the nav is plain `NavLink`s.

Corrections found by typechecking, all of which contradicted a reasonable guess:

| Assumed | Actual |
|---|---|
| `DataTable onRowClick` | `interactiveRows` + `onActiveRowChange(rowId)`; rowId is the array index as a string |
| `Background.Surface.Neutral` | Surface has only `Backdrop`, `BackdropEmbedded`, `Default` |
| `Field.Success.Default` for diff highlight | Transparent (`#e0e7e600`). Use `.Emphasized` |
| `CodeEditor language="shell"` | Union is json/js/jsx/ts/tsx/md/yaml/other only |
| `Select value={string[]}` | Takes a `string` |

Import from the category subdirectory, never the package root.
