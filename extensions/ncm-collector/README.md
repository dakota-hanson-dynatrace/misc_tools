# NCM collector (`custom:ncm-collector`)

A Dynatrace Extension 2.0 (EF2, Python) that backs up network device configurations over SSH.
It connects to each device, runs the vendor-appropriate "show config" command, hashes the
result, and forwards the raw text to Grail. **It is stateless by design** - no local cache, no
previous config, no comparison. All storage, versioning, diffing, and drift detection happen
in the companion app, [`my.ncm`](../../custom_apps/ncm/), not here.

**This extension and that app are two halves of one product.** The extension alone produces
raw records nobody can browse; the app alone has nothing to show without real captures. Deploy
both - see [Setup order](#setup-order) below.

## Why stateless

Holding no state was a hard design requirement, not a default. Consequences that fall out of
it:
- No `known_hosts` file - SSH host-key trust starts as trust-on-first-use, then the observed
  fingerprint gets pinned in the *monitoring configuration* (platform-held config, not
  extension state) once approved in the app's Manage tab.
- No local retry/backoff state across runs - a failed capture is just a `capture.status` the
  app surfaces, not something the extension remembers and reacts to.
- Restarting the ActiveGate mid-schedule loses nothing meaningful; the next scheduled run picks
  up cleanly.

## Device support status

| Vendor | Config capture | Startup-config capture | Validated against real hardware |
|---|---|---|---|
| Cisco IOS / IOS-XE | ✅ | ✅ | ❌ Not yet |
| Cisco NX-OS | ✅ | ✅ | ❌ Not yet |
| Arista EOS | ✅ | ✅ | ❌ Not yet |
| Juniper Junos | ✅ | N/A - Junos has no separate startup concept; a commit *is* the saved state | ❌ Not yet |
| Palo Alto PAN-OS | ✅ | N/A - `show config saved` needs a filename argument on most versions, no portable command | ❌ Not yet |
| Fortinet FortiOS | ✅ | N/A - FortiOS writes config on change, no separate startup copy | ✅ Yes - real device, byte-exact capture verified end to end |

All six adapters pass fixture-based unit tests (`ncm_collector/records_selfcheck.py`), which
proves the code handles each vendor's *expected* output shape correctly - it does not prove
any given vendor's real CLI actually produces that shape. FortiOS is the only one that has
crossed that gap, and it's exactly where a real bug was found that no fixture would have
caught (see `adapters.py`'s `REJECTION_LENGTH_LIMIT` comment). Treat the other five as
untested until validated the same way: a real device, a byte-exact integrity check, and a
render check in the app - not just "the SSH session succeeded."

**Not supported at all** (no adapter exists): Cisco ASA, F5, wireless controllers.

**Cisco enable mode** (`enable_required` in `capture.status`): the documented onboarding
requirement is a `privilege 15` service account, which sidesteps the need for `enable`
entirely on both classic IOS and IOS-XE. The adapter's safety net (detect a `>` prompt and
fail loudly rather than silently return a truncated config) has not been exercised against a
real device that actually needs it.

## Setup order

1. **Signing CA.** `dt-sdk gencerts` mints a new, untrusted root every time - locate and reuse
   an existing CA if you have one; don't regenerate.
2. **Trust bootstrap** (once per ActiveGate). Install your signing CA's public certificate
   into the target ActiveGate's trust store. Symptom if skipped: the EEC log shows
   `Cannot extract extension` with no clearer explanation.
3. **Build, sign, upload:**
   ```bash
   dt-sdk build       # produces dist/custom_ncm-collector-<version>.zip
   dt-sdk sign
   dtctl create extension --file dist/custom_ncm-collector-<version>.zip.signed --context <your-context>
   ```
   Requires `dtctl >= 0.38.0` - earlier versions fail `create extension` with HTTP 415.
4. **Activate the version** (no native `dtctl` verb - see `AGENTS.md` for the full
   `dtctl exec api` incantation and its `POST` vs `PUT` trap).
5. **Apply a monitoring configuration** - copy `example-monitoring-config.yaml`, fill in real
   devices and a real Credential Vault entry, then:
   ```bash
   dtctl apply -f my-monitoring-config.yaml --context <your-context>
   ```
6. **Deploy `my.ncm`** and run its Initial Setup tab (dedicated Grail buckets + routing) -
   see that app's README. Order relative to steps 1-5 doesn't matter functionally, but doing
   it first means a capture never has a moment to land in `default_logs`.
7. Add/adjust devices going forward from the app's **Manage** tab instead of hand-editing the
   YAML, for anything that isn't a credential.

Full command-by-command detail, including every trap found the hard way, is in `AGENTS.md`.

## Credentials

Vault-backed only (`useCredentialVault: true`), resolved by the EEC and injected as plaintext
into the activation config *before* this extension's code runs - the extension code never
constructs, logs, or has any special handling for a credential; it just reads whatever
`global_credentials` resolves to. This is also why the `my.ncm` app can safely manage the
device list without ever seeing a credential: it only ever edits `pythonRemote.devices`, never
`global_credentials`.

Cisco enable/privileged-mode secrets are a known gap in the current schema - handled today by
requiring a `privilege 15` service account instead of a second secret. See `AGENTS.md` if a
real deployment needs that closed.

## Structure

| Path | Contents |
|---|---|
| `ncm_collector/` | The extension's Python code - `__main__.py` (schedule/capture loop), `adapters.py` (per-vendor commands), `normalize.py` (hash input, byte-identical contract with the app's TypeScript copy), `records.py` (chunking), `ssh_client.py` |
| `extension/` | `extension.yaml`, `activationSchema.json` - the extension's declared configuration schema |
| `workflows/ncm-promote-schedule.yaml` | Optional but strongly recommended: schedules the app's `ncmPromote` function so a real capture never sits un-promoted waiting for someone to run it by hand. Ships with its trigger disabled - verify against your own tenant, then flip `isActive: true`. |
| `example-monitoring-config.yaml` | Template device inventory - copy and fill in |
| `setup.py` | Python packaging metadata |
| `activation.json`, `secrets.json` (gitignored) | Local-simulation-only scaffold files for `dt-sdk run`; not used by a real deployment |

## Running the checks

```bash
python3 -m py_compile ncm_collector/*.py
python3 -m ncm_collector.normalize_selfcheck
python3 -m ncm_collector.records_selfcheck
```

## Disclaimer

A personal project, not an official Dynatrace product or supported offering. See the repo
root `README.md`.
