# AI Coding Agent Instructions - NCM collector

`custom:ncm-collector` - an EF2 Python extension that SSHes to network devices, captures
config text, hashes it, and forwards records to Grail. **Stateless by requirement** - no
cache, no previous config, no comparison. This extension has one counterpart, the `my.ncm`
dt-app (in the sibling `custom_apps/ncm/` project) which does all storage and comparison.
**Neither is useful without the other** - see the root `README.md`.

---

## Non-negotiables

### 1. The extension holds no state

A hard requirement, not a preference. Connect, capture, hash, forward - nothing more. The one
place this bites: SSH host-key verification needs a `known_hosts` file, which would be state.
Resolution is trust-on-first-use then **pinned fingerprints in the monitoring
configuration** (config is not extension state, it lives in the platform). Do not add a
`known_hosts` file to work around this.

### 2. `ncm.capture.time` is logical time; `timestamp` is ingest time

Grail rejects timestamps more than 24h old, so `timestamp` (what the ingest API stamps) cannot
carry history. Every record also carries `ncm.capture.time`, which the app treats as
authoritative for sorting, pairing, and version comparison. This also makes the extension
robust to catching up after downtime - a late run's records are still logically dated
correctly even if ingested hours later.

### 3. Normalization must agree byte-for-byte with the app's TypeScript copy

`ncm_collector/normalize.py` computes the hash the app compares against. The contract is
`../../shared/normalize-fixtures.json` (one level up from this repo's `extensions/`, shared
with `custom_apps/ncm/`); `normalize_selfcheck.py` runs it and prints per-fixture digests -
diff those against the app's own selfcheck output before trusting any hash comparison.

Normalization computes the **hash only**. The extension forwards RAW config text - never
normalize before storage, or a normalizer bug becomes permanently unfixable history instead of
a repairable one.

### 4. `ncm.capture.id` must be deterministic per calendar day

`<deviceId>-<YYYY-MM-DD>`, not a full timestamp. The app dedups every aggregating query on
this id because Grail is append-only; a full-timestamp id means a retried or re-triggered run
within the same day mints a second, undeduped record instead of collapsing into the same
day's capture - every fleet count in the app inflates silently.

---

## Running the checks

```bash
python3 -m py_compile ncm_collector/*.py
python3 -m ncm_collector.normalize_selfcheck
python3 -m ncm_collector.records_selfcheck
```

## Building, signing, and uploading

```bash
dt-sdk build       # produces dist/custom_ncm-collector-<version>.zip
dt-sdk sign         # signs it with your own CA - see "Trust bootstrap" below
dtctl create extension --file dist/custom_ncm-collector-<version>.zip.signed --context <your-context>
```

**dtctl must be >= 0.38.0.** Earlier versions always fail `create extension` with HTTP 415
(they send multipart where the API wants a raw body).

### Activation has no native `dtctl` verb - use `dtctl exec api`

```bash
echo '{"version":"0.0.1"}' > /tmp/activate.json
dtctl exec api '/platform/extensions/v2/extensions/custom:ncm-collector/environment-configuration' \
  -X POST -d @/tmp/activate.json --context <your-context>
```

**`POST` creates the environment configuration, `PUT` updates it.** Re-activating a different
version with `POST` fails `400 Extension environment configuration already set` - use `PUT` to
move the active version afterward. Response 200 on `POST` is idempotent for the *same*
version - re-running it is a no-op.

**Until a version is ACTIVE, the extension does not exist for configuration purposes.**
Applying a monitoring configuration first fails with `extension "custom:ncm-collector" not
found` - a masked 404 that looks like a bad extension name and is actually a missing
activation. Check with `dtctl get extensions -o wide`, which has an ACTIVE VERSION column that
the default and `describe` output both omit.

Two path gotchas: the platform paths are **hyphenated** (`monitoring-configurations`,
`environment-configuration`), not camelCase as older classic API docs show - a camelCase path
returns a bare 404. And `dtctl exec api` prints a "prefer the native command" warning whenever
one exists; that is advice, not an error.

## Monitoring configuration (device inventory)

```bash
dtctl apply -f example-monitoring-config.yaml --context <your-context>
```

**Creates unless the file carries an `objectId`.** Without one, every apply adds another
configuration - which can leave two configs running the same extension at different versions
simultaneously, the older one still throwing the old code's exceptions. Once applied once,
copy the returned `objectId` back into the file before applying again.

**Declares its own `version:` field.** Bump it whenever the active extension version moves, or
the configuration keeps running against the old code's expectations.

**Read ActiveGate group membership from the ActiveGate itself, never infer it** from which
monitoring configs happen to exist - that inference has put a signing CA on the wrong box
before. Use:

```bash
dtctl exec api '/platform/extensions/v2/extensions/{name}/{version}/active-gate-groups' --context <your-context>
```

It also reports per-AG errors such as `Not supported DataSources. Expected python(min:3.10.0)`.

**Once the extension is running, devices can be added/edited/removed from the `my.ncm` app's
Manage tab** (metadata only - hostname, port, alias, vendor, site, host key policy) instead of
hand-editing this YAML every time. Credentials still only ever go through the vault, from
either side.

## Trust bootstrap (once per ActiveGate)

The AG's trust store needs your signing CA installed before it will run a signed extension.
`dt-sdk gencerts` mints a **new, untrusted root** every time it's run - locate and reuse an
existing CA rather than regenerating one, or every AG that already trusted the old CA needs
re-bootstrapping too.

**`<version>.signer.txt`** in `agent/runtime/extensions/cache/<ext_dir>/` on the AG names which
CA actually validated the extension - a more reliable check than grepping logs for a specific
error string.

Harmless noise to ignore in the EEC log: `404 ... /extconfig/...?feature_sets_json: Request
send from non-python DataSource or feature sets are not present in extension.yaml`. This
extension declares no feature sets, so that 404 is expected on every poll.

## Collector-specific gotchas

**Timestamps must be MILLISECOND precision, not microsecond.** `datetime.isoformat()` emits 6
fractional digits and the EEC log endpoint rejects them with `400 One or all logs are out of
correct time range.` - the *same* message a genuinely backdated record produces, so it reads
as a clock problem when it is a format problem. Use `isoformat(timespec="milliseconds")`.

**A real CLI rejection is short; a real config never is.** `classify_output()` bounds its
privilege-error string matching to short output only (under ~1 KB). A real FortiGate's stock
`show full-configuration` contains the literal text "authorization failed" as denial-page copy
in a built-in web-filter template, tens of thousands of lines in - without the length bound,
generic phrase matching that's safe against a short rejection message false-positives against
a legitimate, large config. Do not remove or loosen this bound without a regression fixture
built from that exact shape.

**Cisco enable mode is a documented onboarding requirement, not a code path.** The service
account should be `privilege 15` (works on classic IOS too:
`username X privilege 15 secret Y`). The adapter's only safeguard is checking whether the
prompt ends `>` or `#` and failing loudly (`capture.status = "enable_required"`) rather than
silently returning a truncated config that would read as a change that never happened. This
has not been validated against a real device that actually needs `enable` - see the root
README's "device support status" section.

## Platform traps that bite here specifically

**`--check-scopes` lies.** It validates TOKEN SCOPES, not IAM permissions - a call can report
`ok` and still 403 for real.

**Extension logs are owned by a service account, not your login.** Use `sudo`, or a plain
`find`/`ls` silently returns nothing and looks like the logs are missing.

**`Endpoints OK` does not mean data is flowing.** A rig can report OK while collecting only a
subset of the expected data. Assert on actual Grail records, not on a status field.
