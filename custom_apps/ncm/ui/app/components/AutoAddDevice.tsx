import React from 'react';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { Select } from '@dynatrace/strato-components/forms';
import { SlideOverDrawer } from './SlideOverDrawer';
import { VaultEntryPicker } from './VaultEntryPicker';
import {
  callExtension, blankDevice, inputStyle, VENDORS, HOST_KEY_POLICIES,
  type Device, type HostKey, type ConfigSummary,
} from './ExtensionManager';
import type { CoverageRow } from '../utils/coverage';

// Onboards a Coverage "Not backed up" row (SNMP sees it, NCM never has) using
// a credential that already exists in the vault. Round-trips the full device
// list the same way ExtensionManager's own "Add device" does - there is no
// smaller/atomic add endpoint (see api/ncmExtension.function.ts). The row
// itself supplies only a name and, best-effort, an address; vendor, site and
// port aren't derivable from SNMP telemetry at all and are always manual.

export const AutoAddDevice = ({
  row,
  onClose,
  onAdded,
}: {
  row: CoverageRow;
  onClose: () => void;
  onAdded: () => void;
}) => {
  const [configs, setConfigs] = React.useState<ConfigSummary[] | null>(null);
  const [configId, setConfigId] = React.useState<string | null>(null);
  const [device, setDevice] = React.useState<Device>(() => ({
    ...blankDevice(),
    hostname: row.monitoredAddress ?? '',
    alias: row.name,
  }));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    callExtension({ action: 'status' })
      .then((r) => {
        if (!r.ok) throw new Error(r.message ?? 'could not load monitoring configurations');
        setConfigs(r.configs ?? []);
        setConfigId((prev) => prev ?? r.configs?.[0]?.objectId ?? null);
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)));
  }, []);

  const useShared = device.use_global_credentials;

  const submit = async () => {
    if (!configId) return;
    if (!device.hostname.trim()) return setError('Hostname is required.');
    if (!device.alias.trim()) return setError('Device name is required.');
    if (!useShared && !device.credentials?.credentialVaultId) {
      return setError('Pick a credential vault entry, or switch to shared credentials.');
    }
    setSaving(true);
    setError(null);
    try {
      const current = await callExtension({ action: 'getDevices', configId });
      if (!current.ok) throw new Error(current.message ?? 'could not load current devices');
      const devices = [...(current.devices ?? []), device];
      const saved = await callExtension({ action: 'saveDevices', configId, devices });
      if (!saved.ok) throw new Error(saved.message ?? 'save failed');
      onAdded();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SlideOverDrawer open onClose={onClose} width="min(560px, 92vw)">
      <Flex flexDirection="column" gap={16} padding={32}>
        <Flex alignItems="center" gap={12}>
          <Button onClick={onClose}>&larr; Cancel</Button>
          <Heading level={2}>Add {row.name} to monitoring</Heading>
        </Flex>
        <Paragraph>
          Seen by Dynatrace via SNMP, not yet backed up by NCM. SNMP can't tell us vendor,
          management port, or which credential to use - fill those in and it'll be captured on
          the extension's next scheduled run.
        </Paragraph>

        {configs && configs.length > 1 && (
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Monitoring configuration</Text>
            <Select value={configId} onChange={(v) => setConfigId(v ?? null)}>
              <Select.Content>
                {configs.map((c) => (
                  <Select.Option key={c.objectId} value={c.objectId}>
                    {c.scope} ({c.deviceCount})
                  </Select.Option>
                ))}
              </Select.Content>
            </Select>
          </Flex>
        )}

        <Flex gap={12} flexWrap="wrap">
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Hostname/IP</Text>
            <input style={{ ...inputStyle, width: 180 }} value={device.hostname}
              onChange={(e) => setDevice((d) => ({ ...d, hostname: e.target.value }))} />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Device name</Text>
            <input style={{ ...inputStyle, width: 160 }} value={device.alias}
              onChange={(e) => setDevice((d) => ({ ...d, alias: e.target.value }))} />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Port</Text>
            <input style={{ ...inputStyle, width: 70 }} type="number" min={1} max={65535} value={device.port}
              onChange={(e) => setDevice((d) => ({ ...d, port: Number(e.target.value) || 22 }))} />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Vendor</Text>
            <select style={inputStyle} value={device.vendor}
              onChange={(e) => setDevice((d) => ({ ...d, vendor: e.target.value }))}>
              {VENDORS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Site</Text>
            <input style={{ ...inputStyle, width: 120 }} value={device.site ?? ''}
              onChange={(e) => setDevice((d) => ({ ...d, site: e.target.value }))} />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: 13 }}>Host key policy</Text>
            <select style={inputStyle} value={device.host_key.policy}
              onChange={(e) => setDevice((d) => ({ ...d, host_key: { ...d.host_key, policy: e.target.value as HostKey['policy'] } }))}>
              {HOST_KEY_POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Flex>
        </Flex>

        <Flex flexDirection="column" gap={4}>
          <Text style={{ fontSize: 13 }}>Credentials</Text>
          <Flex gap={8} alignItems="center" flexWrap="wrap">
            <select style={inputStyle} value={useShared ? 'shared' : 'vault'}
              onChange={(e) => {
                if (e.target.value === 'shared') {
                  setDevice((d) => ({ ...d, use_global_credentials: true, credentials: undefined }));
                } else {
                  setDevice((d) => ({ ...d, use_global_credentials: false, credentials: { useCredentialVault: true, credentialVaultId: '' } }));
                }
              }}
            >
              <option value="shared">Configuration's shared credentials</option>
              <option value="vault">An existing vault entry</option>
            </select>
            {!useShared && (
              <div style={{ width: 260 }}>
                <VaultEntryPicker
                  value={device.credentials?.credentialVaultId ?? ''}
                  onChange={(id) => setDevice((d) => ({ ...d, credentials: { useCredentialVault: true, credentialVaultId: id } }))}
                />
              </div>
            )}
          </Flex>
        </Flex>

        <Flex gap={12}>
          <Button onClick={() => void submit()} disabled={saving || !configId} variant="accent">
            {saving ? 'Adding...' : 'Add device'}
          </Button>
        </Flex>

        {error && (
          <Surface padding={16}>
            <Heading level={3}>Could not add device</Heading>
            <Paragraph><Code>{error}</Code></Paragraph>
          </Surface>
        )}
      </Flex>
    </SlideOverDrawer>
  );
};
