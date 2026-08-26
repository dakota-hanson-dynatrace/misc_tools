import { httpClient } from '@dynatrace-sdk/http-client';

// Extension version + device management for the Initial Setup tab.
//
// No dedicated @dynatrace-sdk client package exists for Extensions 2.0
// monitoring configurations, so this calls the platform API directly via the
// generic `httpClient` export - the same low-level client the generated SDK
// packages (bucketDefinitionsClient, settingsObjectsClient) are built on top
// of. Every path and body shape here was read from the live tenant via
// `dtctl describe api Extensions --operation '...'` and `dtctl ... --debug`,
// not guessed.
//
// Scope: version activation (pick an ALREADY-UPLOADED version and make it
// active) and device metadata management (hostname/port/alias/vendor/site).
// Deliberately NOT in scope, and not just missing polish:
//   - Uploading a NEW extension package. The zip is ~7 MB; AppEngine
//     functions cap request/response payload at 5 MB each way. It does not
//     fit through the function boundary at all. Build+sign stays a local
//     dt-sdk command regardless, since it needs the private signing key.
//   - Per-device custom credentials (`use_global_credentials: false`). Those
//     are a `credentials` sub-object with secret-typed fields; keeping the
//     app out of that path entirely is what makes "the app never sees a
//     device credential" still true after this feature exists. Every device
//     this function writes has use_global_credentials forced to true.

const EXTENSION_NAME = 'custom:ncm-collector';

interface HostKey {
  policy: 'pinned' | 'trust_on_first_use' | 'accept_any';
  fingerprint?: string | null;
}

interface Device {
  enabled: boolean;
  hostname: string;
  port: number;
  alias: string;
  vendor: string;
  site?: string | null;
  use_global_credentials: true;
  host_key: HostKey;
}

interface ExtensionVersion {
  version: string;
  active?: boolean;
}

interface MonitoringConfigSummary {
  objectId: string;
  scope: string;
  deviceCount: number;
}

interface ExtensionRequest {
  action: 'status' | 'getDevices' | 'saveDevices' | 'activateVersion';
  configId?: string;
  devices?: Device[];
  version?: string;
}

interface ExtensionResponse {
  ok: boolean;
  message?: string;
  versions?: ExtensionVersion[];
  configs?: MonitoringConfigSummary[];
  devices?: Device[];
  configId?: string;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const path = (p: string) => `/platform/extensions/v2/extensions/${p}`;

/**
 * The version-list endpoint never includes an `active` flag by itself - it
 * has to be cross-referenced against a SEPARATE environment-configuration
 * call and merged client-side. Confirmed by watching `dtctl get extension`
 * make exactly these two calls (--debug); the first call's response is too
 * small to contain per-item active flags at all.
 */
async function listVersions(): Promise<ExtensionVersion[]> {
  const versionsRes = await httpClient.send({ url: path(`${encodeURIComponent(EXTENSION_NAME)}`), method: 'GET' });
  const body = (await versionsRes.body('json')) as { items: ExtensionVersion[] };

  // No active version yet (fresh tenant, nothing activated) is a normal
  // state, not an error - degrade to "none active" rather than fail the
  // whole status check over it.
  let active: string | undefined;
  try {
    const activeRes = await httpClient.send({
      url: path(`${encodeURIComponent(EXTENSION_NAME)}/environment-configuration`),
      method: 'GET',
    });
    active = ((await activeRes.body('json')) as { version?: string }).version;
  } catch {
    active = undefined;
  }
  return body.items.map((v) => ({ ...v, active: v.version === active }));
}

interface RawMonitoringConfig {
  objectId: string;
  scope: string;
  value: { pythonRemote?: { devices?: Device[] } };
}

async function listMonitoringConfigs(): Promise<RawMonitoringConfig[]> {
  const res = await httpClient.send({
    url: path(`${encodeURIComponent(EXTENSION_NAME)}/monitoring-configurations?page-size=100`),
    method: 'GET',
  });
  const body = (await res.body('json')) as { items: RawMonitoringConfig[] };
  return body.items;
}

async function getMonitoringConfig(configId: string): Promise<RawMonitoringConfig> {
  const res = await httpClient.send({
    url: path(`${encodeURIComponent(EXTENSION_NAME)}/monitoring-configurations/${encodeURIComponent(configId)}`),
    method: 'GET',
  });
  return (await res.body('json')) as RawMonitoringConfig;
}

/**
 * Replaces ONLY pythonRemote.devices and sends the rest of the config back
 * exactly as read - including global_credentials, which GET returns masked
 * (e.g. "***a1b2c3d4e5f6a7b8***"). Verified safe by hand against a real
 * tenant before this function was written: read the config, PUT the masked
 * value straight back unchanged, re-read - the masked fragment came back
 * byte-identical and the device kept capturing. The PUT endpoint has no
 * optimistic-locking version and replaces the value wholesale, so touching
 * anything beyond `devices` here would risk corrupting the real credential.
 */
async function putDevices(configId: string, devices: Device[]): Promise<void> {
  const current = await getMonitoringConfig(configId);
  const value = { ...current.value, pythonRemote: { ...current.value.pythonRemote, devices } };
  await httpClient.send({
    url: path(`${encodeURIComponent(EXTENSION_NAME)}/monitoring-configurations/${encodeURIComponent(configId)}`),
    method: 'PUT',
    body: { value },
  });
}

async function activateVersion(version: string): Promise<void> {
  await httpClient.send({
    url: path(`${encodeURIComponent(EXTENSION_NAME)}/environment-configuration`),
    method: 'PUT',
    body: { version },
  });
}

function validateDevice(d: Partial<Device>): string | null {
  if (!d.hostname || d.hostname.length < 1 || d.hostname.length > 255) return 'hostname is required (1-255 chars)';
  if (!d.alias || d.alias.length < 1 || d.alias.length > 255) return 'device name is required (1-255 chars)';
  if (!d.port || d.port < 1 || d.port > 65535) return 'port must be 1-65535';
  const VENDORS = ['cisco_ios', 'cisco_nxos', 'arista_eos', 'junos', 'panos', 'fortios'];
  if (!d.vendor || !VENDORS.includes(d.vendor)) return `vendor must be one of ${VENDORS.join(', ')}`;
  const POLICIES = ['pinned', 'trust_on_first_use', 'accept_any'];
  if (!d.host_key || !POLICIES.includes(d.host_key.policy)) return `host_key.policy must be one of ${POLICIES.join(', ')}`;
  return null;
}

export default async function (request: ExtensionRequest): Promise<ExtensionResponse> {
  try {
    switch (request.action) {
      case 'status': {
        const [versions, configs] = await Promise.all([listVersions(), listMonitoringConfigs()]);
        return {
          ok: true,
          versions,
          configs: configs.map((c) => ({
            objectId: c.objectId,
            scope: c.scope,
            deviceCount: c.value.pythonRemote?.devices?.length ?? 0,
          })),
        };
      }
      case 'getDevices': {
        if (!request.configId) return { ok: false, message: 'configId is required' };
        const cfg = await getMonitoringConfig(request.configId);
        return { ok: true, configId: request.configId, devices: cfg.value.pythonRemote?.devices ?? [] };
      }
      case 'saveDevices': {
        if (!request.configId) return { ok: false, message: 'configId is required' };
        const devices = request.devices ?? [];
        for (const d of devices) {
          const problem = validateDevice(d);
          if (problem) return { ok: false, message: `${d.alias || d.hostname || 'device'}: ${problem}` };
          // Force this rather than merely validate it: this function must
          // never be the thing that flips a device onto per-device secret
          // fields, even if a caller's payload tried to.
          d.use_global_credentials = true;
        }
        await putDevices(request.configId, devices);
        return { ok: true, configId: request.configId, devices };
      }
      case 'activateVersion': {
        if (!request.version) return { ok: false, message: 'version is required' };
        await activateVersion(request.version);
        const versions = await listVersions();
        return { ok: true, versions };
      }
      default:
        return { ok: false, message: `unknown action: ${(request as { action: string }).action}` };
    }
  } catch (e) {
    console.error('ncmExtension failed:', e);
    return { ok: false, message: msg(e) };
  }
}
