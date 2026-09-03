import { httpClient } from '@dynatrace-sdk/http-client';

// Bulk credential provisioning - a DELIBERATE, narrow exception to this
// app's one hard rule everywhere else ("the app and browser never see a
// device credential"). This is the one place that isn't true, and it exists
// for exactly one reason: a fleet of hundreds/thousands of devices needing
// unique-per-device passwords has no way to get those into the Credential
// Vault at scale other than typing each one into Settings by hand, which
// doesn't scale, or a local script (tools/bulk-provision-vault.ts), which
// needs dtctl/CLI access every admin may not have.
//
// Everything here is a one-time or occasional admin action, never part of
// the routine device-management path (that's ncmExtension.function.ts,
// which never touches a credential field at all). Kept in its own file, its
// own UI page, and its own scope grants specifically so this exception stays
// visible and auditable rather than buried inside a "normal" code path.
//
// What it never does, structurally, not just by convention:
//   - Never logs a row, a username, or a password - only aliases, vault IDs,
//     and pass/fail status ever reach console.error or the response body.
//   - Never persists an uploaded file or parsed row anywhere. Each row is
//     read, forwarded to the Credential Vault API, and discarded.
//   - Never echoes a password back in a response, including on failure.
//
// Two operations:
//   bulkCreate - makes NEW vault entries (POST /entries).
//   bulkRotate - updates an EXISTING entry's password IN PLACE (PUT
//     /entries/{id}), so a device's credentialVaultId reference never has to
//     change when a password rotates on the device/PAM side. This is the
//     long-term-management answer: rotation is "update the vault entry,"
//     never "create a new entry and go edit every device that referenced the
//     old one." See the app README's "Credential rotation" section.

const VAULT_BASE = '/platform/credential-vault/v1/entries';
const TIME_BUDGET_MS = 90_000; // hard cap is 120s; leave margin

interface CreateRow {
  alias: string;
  username: string;
  password: string;
}
interface RotateRow {
  credentialVaultId: string;
  username: string;
  password: string;
}

interface RowResult {
  alias?: string;
  credentialVaultId?: string;
  status: 'created' | 'rotated' | 'failed';
  detail?: string;
}

interface CredentialsRequest {
  action: 'bulkCreate' | 'bulkRotate';
  rows?: (CreateRow | RotateRow)[];
}

interface CredentialsResponse {
  ok: boolean;
  message?: string;
  results?: RowResult[];
  /** Rows not yet attempted this invocation - resend exactly this array to continue. */
  remainingRows?: (CreateRow | RotateRow)[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function validateCreateRow(r: Partial<CreateRow>): string | null {
  if (!r.alias?.trim()) return 'alias is required';
  if (!r.username?.trim()) return 'username is required';
  if (!r.password) return 'password is required';
  return null;
}
function validateRotateRow(r: Partial<RotateRow>): string | null {
  if (!r.credentialVaultId?.trim()) return 'credentialVaultId is required';
  if (!r.username?.trim()) return 'username is required';
  if (!r.password) return 'password is required';
  return null;
}

/**
 * ownerAccessOnly MUST be false, or the extension - a platform-side process,
 * not the creating user - cannot resolve the credential at capture time.
 * Documented directly in the schema; easy to miss because the entry still
 * creates successfully either way, and only fails later, opaquely, at
 * capture time.
 */
async function createEntry(row: CreateRow): Promise<string> {
  const res = await httpClient.send({
    url: VAULT_BASE,
    method: 'POST',
    body: {
      type: 'USERNAME_PASSWORD',
      name: `ncm-collector - ${row.alias}`,
      description: `Bulk-provisioned via my.ncm's Bulk Credentials page for device "${row.alias}"`,
      user: row.username,
      password: row.password,
      scopes: ['EXTENSION_AUTHENTICATION'],
      ownerAccessOnly: false,
    },
  });
  const body = (await res.body('json')) as { id?: string };
  if (!body.id) throw new Error('no id in response');
  return body.id;
}

interface VaultEntryMeta {
  type: string;
  name: string;
  description?: string;
  scopes?: string[];
  ownerAccessOnly?: boolean;
  allowContextlessRequests?: boolean;
}

/**
 * GET never returns user/password at all (confirmed against the real API
 * response schema, not assumed) - only bookkeeping metadata. That's what
 * makes it safe to read here: there is no secret to accidentally handle.
 */
async function getEntryMeta(id: string): Promise<VaultEntryMeta> {
  const res = await httpClient.send({ url: `${VAULT_BASE}/${encodeURIComponent(id)}`, method: 'GET' });
  return (await res.body('json')) as VaultEntryMeta;
}

/** PUT replaces the whole entry and needs entries:admin - a more privileged scope than create's entries:write. */
async function rotateEntry(row: RotateRow): Promise<void> {
  const meta = await getEntryMeta(row.credentialVaultId);
  if (meta.type !== 'USERNAME_PASSWORD') {
    throw new Error(`entry is type ${meta.type}, not USERNAME_PASSWORD - refusing to rotate`);
  }
  await httpClient.send({
    url: `${VAULT_BASE}/${encodeURIComponent(row.credentialVaultId)}`,
    method: 'PUT',
    body: {
      type: 'USERNAME_PASSWORD',
      name: meta.name,
      description: meta.description,
      scopes: meta.scopes ?? ['EXTENSION_AUTHENTICATION'],
      ownerAccessOnly: meta.ownerAccessOnly ?? false,
      allowContextlessRequests: meta.allowContextlessRequests,
      user: row.username,
      password: row.password,
    },
  });
}

export default async function (request: CredentialsRequest): Promise<CredentialsResponse> {
  const startedAt = Date.now();
  try {
    const rows = request.rows ?? [];
    const results: RowResult[] = [];
    let i = 0;

    for (; i < rows.length; i++) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      if (request.action === 'bulkCreate') {
        const row = rows[i] as CreateRow;
        const problem = validateCreateRow(row);
        if (problem) {
          results.push({ alias: row.alias, status: 'failed', detail: problem });
          continue;
        }
        try {
          const id = await createEntry(row);
          results.push({ alias: row.alias, credentialVaultId: id, status: 'created' });
        } catch (e) {
          results.push({ alias: row.alias, status: 'failed', detail: msg(e) });
        }
      } else if (request.action === 'bulkRotate') {
        const row = rows[i] as RotateRow;
        const problem = validateRotateRow(row);
        if (problem) {
          results.push({ credentialVaultId: row.credentialVaultId, status: 'failed', detail: problem });
          continue;
        }
        try {
          await rotateEntry(row);
          results.push({ credentialVaultId: row.credentialVaultId, status: 'rotated' });
        } catch (e) {
          results.push({ credentialVaultId: row.credentialVaultId, status: 'failed', detail: msg(e) });
        }
      } else {
        return { ok: false, message: `unknown action: ${String(request.action)}` };
      }
    }

    return { ok: true, results, remainingRows: rows.slice(i) };
  } catch (e) {
    console.error('ncmCredentials failed:', e);
    return { ok: false, message: msg(e) };
  }
}
