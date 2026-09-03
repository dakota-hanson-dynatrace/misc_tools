// Bulk-creates Credential Vault entries for a large device fleet.
//
// Deliberately a LOCAL script, not an app function: creating a vault entry
// requires a real plaintext password at least once, and running that through
// our deployed app's function - even without logging or displaying it - would
// mean the app's own server-side code touches a device credential, breaking
// the one invariant this whole project holds everywhere else ("the app and
// browser never see a device credential"). This script talks directly to the
// Credential Vault API from the admin's own machine, using their own
// already-authenticated dtctl session. It never goes near anything deployed.
//
// The password never appears as a CLI argument or in shell history: each
// request body is written to a private (0600) temp file, used once by
// `dtctl exec api`, then deleted - mirroring how the real vault-entry
// round-trip was verified earlier in this project (see AGENTS.md).
//
// Input CSV (no header): alias,username,password
//   ash-fw01,admin,Sup3rSecret!
//   ash-rtr01,netops,AnotherOne#2
//
// Output CSV: alias,credentialVaultId,status
//   Paste credentialVaultId into that device's `credentials.credentialVaultId`
//   in the monitoring configuration, with `use_global_credentials: false`.
//
// Run from the app project root (dry run by default - prints what would be
// created, creates nothing):
//   npx esbuild tools/bulk-provision-vault.ts --bundle --platform=node --format=esm --outfile=/tmp/bulkvault.mjs \
//     && node /tmp/bulkvault.mjs devices.csv --out result.csv
//
// Add --apply to actually create entries:
//   node /tmp/bulkvault.mjs devices.csv --out result.csv --apply

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTEXT = process.env.DT_CONTEXT;
if (!CONTEXT) {
  console.error('Set DT_CONTEXT to a dtctl context name (see `dtctl config get-contexts`).');
  process.exit(1);
}
const VAULT_ENTRIES_PATH = '/platform/credential-vault/v1/entries';

interface Row {
  alias: string;
  username: string;
  password: string;
}

interface Result {
  alias: string;
  credentialVaultId: string;
  status: 'created' | 'would_create' | 'failed';
  detail?: string;
}

function parseCsv(path: string): Row[] {
  const text = readFileSync(path, 'utf8');
  const rows: Row[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 3) {
      throw new Error(`malformed row (expected alias,username,password): ${line.split(',')[0]}`);
    }
    const [alias, username, ...passwordParts] = parts;
    // Passwords can legitimately contain commas; everything after the second
    // comma is the password, rejoined.
    rows.push({ alias: alias.trim(), username: username.trim(), password: passwordParts.join(',') });
  }
  return rows;
}

/**
 * Creates one vault entry via `dtctl exec api`, passing the body through a
 * private temp file rather than a CLI argument or stdin string - both of
 * those risk landing in shell history or a process list. `ownerAccessOnly`
 * MUST be false, or the extension (a platform-side process, not the creating
 * user) cannot resolve the credential at capture time - a real trap
 * documented directly in the schema.
 */
function createVaultEntry(row: Row): string {
  const body = {
    type: 'USERNAME_PASSWORD',
    name: `ncm-collector - ${row.alias}`,
    description: `Bulk-provisioned for device "${row.alias}" via bulk-provision-vault.ts`,
    user: row.username,
    password: row.password,
    scopes: ['EXTENSION_AUTHENTICATION'],
    ownerAccessOnly: false,
  };

  const tmpFile = join(tmpdir(), `ncm-vault-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(tmpFile, JSON.stringify(body), { mode: 0o600 });
  try {
    const out = execFileSync(
      'dtctl',
      ['exec', 'api', VAULT_ENTRIES_PATH, '-X', 'POST', '-d', `@${tmpFile}`, '--context', CONTEXT, '-o', 'json', '--plain'],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(out);
    if (!parsed.ok) throw new Error(parsed.error?.message ?? 'unknown dtctl error');
    const id = parsed.result?.id;
    if (!id) throw new Error(`no id in response: ${out.slice(0, 300)}`);
    return id;
  } finally {
    // Always clean up, success or failure - the file held a real password.
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  }
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const csvPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');

  if (!csvPath) {
    console.error('Usage: node bulkvault.mjs <devices.csv> [--out result.csv] [--apply]');
    process.exit(1);
  }

  const rows = parseCsv(csvPath);
  console.log(`${rows.length} row(s) read from ${csvPath}. ${apply ? 'APPLYING' : 'DRY RUN - pass --apply to actually create entries'}.`);

  const results: Result[] = [];
  for (const row of rows) {
    if (!apply) {
      results.push({ alias: row.alias, credentialVaultId: '', status: 'would_create' });
      continue;
    }
    try {
      const id = createVaultEntry(row);
      results.push({ alias: row.alias, credentialVaultId: id, status: 'created' });
      console.log(`  ${row.alias} -> ${id}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ alias: row.alias, credentialVaultId: '', status: 'failed', detail });
      console.error(`  ${row.alias} -> FAILED: ${detail}`);
    }
  }

  const csvOut = ['alias,credentialVaultId,status,detail']
    .concat(results.map((r) => `${r.alias},${r.credentialVaultId},${r.status},"${(r.detail ?? '').replace(/"/g, "'")}"`))
    .join('\n');
  if (outPath) {
    writeFileSync(outPath, csvOut);
    console.log(`Wrote ${outPath}`);
  } else {
    console.log(csvOut);
  }

  const failed = results.filter((r) => r.status === 'failed').length;
  if (failed) {
    console.error(`${failed} of ${rows.length} entries failed - see the "detail" column.`);
    process.exit(1);
  }
}

main();
