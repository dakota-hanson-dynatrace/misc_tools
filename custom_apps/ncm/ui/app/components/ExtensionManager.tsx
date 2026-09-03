import React from 'react';
import { functions } from '@dynatrace-sdk/app-utils';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';

// Extension version activation + device metadata management, called from the
// Initial Setup page. Devices can point at the configuration's shared
// credentials or at their own Credential Vault entry (needed once a fleet
// has genuinely unique per-device passwords - see
// tools/bulk-provision-vault.ts for creating those entries at scale). Either
// way, this UI only ever handles a vault entry ID - a pointer, never a
// secret. See api/ncmExtension.function.ts for what this is deliberately NOT
// able to do (upload a new package, read or write a plaintext credential)
// and why - both are hard platform/security limits, not missing polish.

interface HostKey {
  policy: 'pinned' | 'trust_on_first_use' | 'accept_any';
  fingerprint?: string | null;
}
interface DeviceCredentialRef {
  useCredentialVault: true;
  credentialVaultId: string;
}
interface Device {
  enabled: boolean;
  hostname: string;
  port: number;
  alias: string;
  vendor: string;
  site?: string | null;
  use_global_credentials: boolean;
  credentials?: DeviceCredentialRef;
  host_key: HostKey;
}
interface ExtensionVersion {
  version: string;
  active?: boolean;
}
interface ConfigSummary {
  objectId: string;
  scope: string;
  deviceCount: number;
}
interface ExtensionResponse {
  ok: boolean;
  message?: string;
  versions?: ExtensionVersion[];
  configs?: ConfigSummary[];
  devices?: Device[];
  configId?: string;
}

const VENDORS: { value: string; label: string }[] = [
  { value: 'cisco_ios', label: 'Cisco IOS / IOS-XE' },
  { value: 'cisco_nxos', label: 'Cisco NX-OS' },
  { value: 'arista_eos', label: 'Arista EOS' },
  { value: 'junos', label: 'Juniper Junos' },
  { value: 'panos', label: 'Palo Alto PAN-OS' },
  { value: 'fortios', label: 'Fortinet FortiOS' },
];
const HOST_KEY_POLICIES: { value: HostKey['policy']; label: string }[] = [
  { value: 'pinned', label: 'Pinned - reject anything else' },
  { value: 'trust_on_first_use', label: 'Trust on first use, then pin' },
  { value: 'accept_any', label: 'Accept any key (insecure)' },
];

const blankDevice = (): Device => ({
  enabled: true,
  hostname: '',
  port: 22,
  alias: '',
  vendor: 'cisco_ios',
  site: '',
  use_global_credentials: true,
  host_key: { policy: 'trust_on_first_use', fingerprint: '' },
});

async function callExtension(body: Record<string, unknown>): Promise<ExtensionResponse> {
  const res = await functions.call('ncmExtension', { data: body });
  return res.json();
}

const inputStyle: React.CSSProperties = {
  background: Colors.Background.Base.Default,
  border: `1px solid ${Colors.Border.Neutral.Default}`,
  borderRadius: 4,
  color: Colors.Text.Neutral.Default,
  padding: '4px 8px',
  fontSize: 13,
};

export const ExtensionManager = () => {
  const [versions, setVersions] = React.useState<ExtensionVersion[] | null>(null);
  const [configs, setConfigs] = React.useState<ConfigSummary[] | null>(null);
  const [selectedConfigId, setSelectedConfigId] = React.useState<string | null>(null);
  const [devices, setDevices] = React.useState<Device[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);

  const loadStatus = React.useCallback(() => {
    setLoading(true);
    setError(null);
    callExtension({ action: 'status' })
      .then((r) => {
        if (!r.ok) throw new Error(r.message ?? 'status check failed');
        setVersions(r.versions ?? []);
        setConfigs(r.configs ?? []);
        // Default to the only (or first) monitoring config - most tenants
        // will have exactly one, matching this project's own single config.
        setSelectedConfigId((prev) => prev ?? r.configs?.[0]?.objectId ?? null);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  React.useEffect(() => {
    if (!selectedConfigId) return;
    setLoading(true);
    callExtension({ action: 'getDevices', configId: selectedConfigId })
      .then((r) => {
        if (!r.ok) throw new Error(r.message ?? 'could not load devices');
        setDevices(r.devices ?? []);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [selectedConfigId]);

  const activate = (version: string) => {
    setLoading(true);
    setError(null);
    callExtension({ action: 'activateVersion', version })
      .then((r) => {
        if (!r.ok) throw new Error(r.message ?? 'activation failed');
        setVersions(r.versions ?? []);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };

  const updateDevice = (index: number, patch: Partial<Device>) => {
    setDevices((prev) => (prev ? prev.map((d, i) => (i === index ? { ...d, ...patch } : d)) : prev));
  };
  const removeDevice = (index: number) => {
    setDevices((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
  };
  const addDevice = () => {
    setDevices((prev) => [...(prev ?? []), blankDevice()]);
  };

  const saveDevices = () => {
    if (!selectedConfigId || !devices) return;
    setLoading(true);
    setError(null);
    setSaveMessage(null);
    callExtension({ action: 'saveDevices', configId: selectedConfigId, devices })
      .then((r) => {
        if (!r.ok) throw new Error(r.message ?? 'save failed');
        setDevices(r.devices ?? []);
        setSaveMessage(`Saved ${r.devices?.length ?? 0} device(s).`);
        setConfigs((prev) =>
          prev ? prev.map((c) => (c.objectId === selectedConfigId ? { ...c, deviceCount: r.devices?.length ?? c.deviceCount } : c)) : prev
        );
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };

  return (
    <Flex flexDirection="column" gap={24}>
      <Flex flexDirection="column" gap={12}>
        <Heading level={2}>Extension version</Heading>
        <Paragraph>
          Activates an already-uploaded <Code>custom:ncm-collector</Code> version tenant-wide. Uploading a NEW
          package isn't done from here - the collector zip (~7 MB) exceeds the 5 MB payload limit on app functions,
          and build/sign needs the project's private signing key, which stays a local <Code>dt-sdk</Code> step.
        </Paragraph>
        {versions && versions.length > 0 && (
          <Flex flexDirection="column" gap={8}>
            {versions.map((v) => (
              <Flex key={v.version} justifyContent="space-between" alignItems="center" gap={12}
                style={{ padding: '8px 12px', border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 6 }}
              >
                <Text>{v.version}</Text>
                {v.active ? (
                  <Text style={{ color: Colors.Text.Success.Default, fontWeight: 600 }}>Active</Text>
                ) : (
                  <Button onClick={() => activate(v.version)} disabled={loading}>
                    Activate
                  </Button>
                )}
              </Flex>
            ))}
          </Flex>
        )}
        {versions && versions.length === 0 && <Text>No uploaded versions found.</Text>}
      </Flex>

      <Flex flexDirection="column" gap={12}>
        <Heading level={2}>Devices</Heading>
        <Paragraph>
          Metadata only - hostname, port, name, vendor, site, host key policy, and which credential source a device
          uses. A device can use the configuration's shared credentials, or point at its own Credential Vault entry
          for fleets that need a unique password per device. Either way, only a vault entry ID ever passes through
          here - never a username or password.
        </Paragraph>

        {configs && configs.length > 1 && (
          <Flex gap={8}>
            {configs.map((c) => (
              <Button
                key={c.objectId}
                variant={c.objectId === selectedConfigId ? 'accent' : 'default'}
                onClick={() => setSelectedConfigId(c.objectId)}
              >
                {c.scope} ({c.deviceCount})
              </Button>
            ))}
          </Flex>
        )}

        {devices && (
          <Flex flexDirection="column" gap={8}>
            {devices.map((d, i) => {
              const useShared = d.use_global_credentials;
              return (
              <Flex key={i} flexDirection="column" gap={6}
                style={{ padding: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 6 }}
              >
                <Flex gap={8} alignItems="center" flexWrap="wrap">
                  <input style={{ ...inputStyle, width: 140 }} placeholder="Hostname/IP" value={d.hostname}
                    onChange={(e) => updateDevice(i, { hostname: e.target.value })} />
                  <input style={{ ...inputStyle, width: 120 }} placeholder="Device name" value={d.alias}
                    onChange={(e) => updateDevice(i, { alias: e.target.value })} />
                  <input style={{ ...inputStyle, width: 70 }} type="number" min={1} max={65535} value={d.port}
                    onChange={(e) => updateDevice(i, { port: Number(e.target.value) || 22 })} />
                  <select style={inputStyle} value={d.vendor} onChange={(e) => updateDevice(i, { vendor: e.target.value })}>
                    {VENDORS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </select>
                  <input style={{ ...inputStyle, width: 120 }} placeholder="Site" value={d.site ?? ''}
                    onChange={(e) => updateDevice(i, { site: e.target.value })} />
                  <select style={inputStyle} value={d.host_key.policy}
                    onChange={(e) => updateDevice(i, { host_key: { ...d.host_key, policy: e.target.value as HostKey['policy'] } })}>
                    {HOST_KEY_POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={d.enabled} onChange={(e) => updateDevice(i, { enabled: e.target.checked })} />
                    Enabled
                  </label>
                  <Button onClick={() => removeDevice(i)}>Remove</Button>
                </Flex>
                <Flex gap={8} alignItems="center" flexWrap="wrap">
                  <Text style={{ fontSize: 13, color: Colors.Text.Neutral.Subdued }}>Credentials:</Text>
                  <select style={inputStyle} value={useShared ? 'shared' : 'vault'}
                    onChange={(e) => {
                      if (e.target.value === 'shared') {
                        updateDevice(i, { use_global_credentials: true, credentials: undefined });
                      } else {
                        updateDevice(i, { use_global_credentials: false, credentials: { useCredentialVault: true, credentialVaultId: d.credentials?.credentialVaultId ?? '' } });
                      }
                    }}
                  >
                    <option value="shared">Configuration's shared credentials</option>
                    <option value="vault">This device's own vault entry</option>
                  </select>
                  {!useShared && (
                    <input style={{ ...inputStyle, width: 260 }} placeholder="CREDENTIALS_VAULT-... (from Settings, or bulk-provision-vault.ts)"
                      value={d.credentials?.credentialVaultId ?? ''}
                      onChange={(e) => updateDevice(i, { credentials: { useCredentialVault: true, credentialVaultId: e.target.value } })}
                    />
                  )}
                </Flex>
              </Flex>
              );
            })}
          </Flex>
        )}

        <Flex gap={12}>
          <Button onClick={addDevice} disabled={!devices}>Add device</Button>
          <Button onClick={saveDevices} disabled={!devices || loading} variant="accent">Save devices</Button>
        </Flex>
        {saveMessage && <Text style={{ color: Colors.Text.Success.Default }}>{saveMessage}</Text>}
      </Flex>

      {error && (
        <Surface padding={16}>
          <Heading level={3}>Extension management error</Heading>
          <Paragraph><Code>{error}</Code></Paragraph>
        </Surface>
      )}
    </Flex>
  );
};
