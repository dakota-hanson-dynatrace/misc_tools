import React, { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Text, Paragraph } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { Modal } from '@dynatrace/strato-components/overlays';
import { FormField, TextInput, Label, Select } from '@dynatrace/strato-components/forms';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import type { DataTableColumnDef } from '@dynatrace/strato-components-preview/tables';
import { useIpam } from '../context/IpamContext';
import { useHostCorrelation, type HostInfo } from '../hooks/useHostCorrelation';
import { getSubnetInfo, isIpInCidr, isValidIpv4 } from '../utils/ipUtils';
import type { IpRecord, IpStatus } from '../types/ipam';

const STATUS_COLORS: Record<IpStatus, string> = {
  available: 'var(--dt-color-indicator-success)',
  assigned: 'var(--dt-color-indicator-primary)',
  reserved: 'var(--dt-color-indicator-warning)',
};

const emptyForm = { address: '', status: 'available' as IpStatus, hostname: '', owner: '', notes: '' };

export const SubnetDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { subnets, addIpRecord, addIpRecords, updateIpRecord, deleteIpRecord, getSubnetRecords } = useIpam();
  const { hostMap, isLoading: hostsLoading, error: hostsError } = useHostCorrelation();

  const subnet = subnets.find((s) => s.id === id);
  const records = id ? getSubnetRecords(id) : [];

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [addressError, setAddressError] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [showSyncPreview, setShowSyncPreview] = useState(false);
  const [syncPreview, setSyncPreview] = useState<{
    toAdd: Array<{ ip: string; hostname: string; entityId: string }>;
    conflicts: Array<{ ip: string; existingHostname: string; dtHostname: string; same: boolean }>;
  }>({ toAdd: [], conflicts: [] });

  const subnetInfo = useMemo(() => {
    if (!subnet) return null;
    try {
      return getSubnetInfo(subnet.cidr);
    } catch {
      return null;
    }
  }, [subnet]);

  const columns: DataTableColumnDef<IpRecord>[] = useMemo(
    () => [
      { id: 'address', header: 'IP Address', accessor: 'address' },
      {
        id: 'status',
        header: 'Status',
        accessor: 'status',
        cell: ({ value }: { value: IpStatus }) => (
          <Flex alignItems="center" gap={6}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: STATUS_COLORS[value],
              }}
            />
            <Text style={{ textTransform: 'capitalize' }}>{value}</Text>
          </Flex>
        ),
      },
      { id: 'hostname', header: 'Hostname', accessor: (r) => r.hostname ?? '—' },
      {
        id: 'dtHost',
        header: 'DT Host',
        accessor: (r) => hostMap.get(r.address),
        cell: ({ value }: { value: HostInfo | undefined }) =>
          value ? (
            <Flex alignItems="center" gap={6}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: 'var(--dt-color-indicator-primary)',
                }}
              />
              <Text
                style={{
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 200,
                  color: 'var(--dt-color-text-default)',
                }}
                title={value.entityName}
              >
                {value.entityName}
              </Text>
            </Flex>
          ) : (
            <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>—</Text>
          ),
      },
      { id: 'owner', header: 'Owner', accessor: (r) => r.owner ?? '—' },
      { id: 'notes', header: 'Notes', accessor: (r) => r.notes ?? '—' },
      {
        id: 'updatedAt',
        header: 'Last Updated',
        accessor: (r) => r,
        cell: ({ value: r }: { value: IpRecord }) => (
          <Flex flexDirection="column" style={{ lineHeight: 1.3 }}>
            <Text style={{ fontSize: 12 }}>{new Date(r.updatedAt).toLocaleDateString()}</Text>
            {r.updatedBy && (
              <Text style={{ fontSize: 11, color: 'var(--dt-color-text-subdued)' }}>{r.updatedBy}</Text>
            )}
          </Flex>
        ),
      },
    ],
    [hostMap]
  );

  if (!subnet) {
    return (
      <Flex flexDirection="column" alignItems="center" padding={64} gap={16}>
        <Paragraph>Subnet not found.</Paragraph>
        <Button onClick={() => void navigate('/subnets')}>Back to Subnets</Button>
      </Flex>
    );
  }

  function openAdd() {
    setEditId(null);
    setForm(emptyForm);
    setAddressError('');
    setShowModal(true);
  }

  function openEdit(record: IpRecord) {
    setEditId(record.id);
    setForm({
      address: record.address,
      status: record.status,
      hostname: record.hostname ?? '',
      owner: record.owner ?? '',
      notes: record.notes ?? '',
    });
    setAddressError('');
    setShowModal(true);
  }

  async function handleSave() {
    if (!isValidIpv4(form.address)) {
      setAddressError('Enter a valid IPv4 address (e.g. 192.168.1.10)');
      return;
    }
    setSaving(true);
    try {
      if (editId) {
        await updateIpRecord(editId, form);
      } else if (subnet) {
        await addIpRecord({ ...form, subnetId: subnet.id });
      }
      setShowModal(false);
    } catch (e: unknown) {
      setAddressError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(recordId: string) {
    if (!confirm('Remove this IP record?')) return;
    try {
      await deleteIpRecord(recordId);
    } catch (e: unknown) {
      alert(`Remove failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleOpenSyncPreview() {
    if (!subnet) return;
    const existingByAddress = new Map(records.map((r) => [r.address, r]));
    const toAdd: typeof syncPreview.toAdd = [];
    const conflicts: typeof syncPreview.conflicts = [];

    for (const [ip, host] of hostMap.entries()) {
      if (!isIpInCidr(ip, subnet.cidr)) continue;
      const existing = existingByAddress.get(ip);
      if (existing) {
        conflicts.push({
          ip,
          existingHostname: existing.hostname ?? '(none)',
          dtHostname: host.entityName,
          same: (existing.hostname ?? '') === host.entityName,
        });
      } else {
        toAdd.push({ ip, hostname: host.entityName, entityId: host.entityId });
      }
    }

    setSyncPreview({ toAdd, conflicts });
    setShowSyncPreview(true);
  }

  async function handleConfirmSync() {
    if (!subnet) return;
    setSyncing(true);
    try {
      // One bulk call instead of one function round-trip per host: keeps sync
      // fast and lets the server re-validate everything against fresh data.
      const result = await addIpRecords(
        syncPreview.toAdd.map(({ ip, hostname, entityId }) => ({
          subnetId: subnet.id,
          address: ip,
          status: 'assigned',
          hostname,
          owner: '',
          notes: `Synced from Dynatrace (${entityId})`,
        }))
      );
      setShowSyncPreview(false);
      const skipped = result.skipped + syncPreview.conflicts.length;
      setSyncResult(
        `${result.added > 0 ? `Added ${result.added} record${result.added !== 1 ? 's' : ''}` : 'No new records added'}.` +
        (skipped > 0 ? ` ${skipped} existing record${skipped !== 1 ? 's' : ''} left unchanged.` : '')
      );
      setTimeout(() => setSyncResult(null), 6000);
    } catch (e: unknown) {
      setSyncResult(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  const field = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const assigned = records.filter((r) => r.status === 'assigned').length;
  const reserved = records.filter((r) => r.status === 'reserved').length;
  const utilization = subnetInfo && subnetInfo.usableHosts > 0
    ? Math.round((assigned / subnetInfo.usableHosts) * 100)
    : 0;

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Flex alignItems="center" gap={12}>
        <Button onClick={() => void navigate('/subnets')} variant="emphasized">
          ← Subnets
        </Button>
        <Heading>{subnet.name}</Heading>
        <Text style={{ color: 'var(--dt-color-text-subdued)', fontSize: 14 }}>{subnet.cidr}</Text>
      </Flex>

      <Flex gap={24} flexFlow="wrap">
        {subnetInfo && (
          <>
            <Flex flexDirection="column" style={{ fontSize: 13 }}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Network</Text>
              <Text>{subnetInfo.networkAddress}</Text>
            </Flex>
            <Flex flexDirection="column" style={{ fontSize: 13 }}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Broadcast</Text>
              <Text>{subnetInfo.broadcastAddress}</Text>
            </Flex>
            <Flex flexDirection="column" style={{ fontSize: 13 }}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Usable Range</Text>
              <Text>
                {subnetInfo.firstUsable} – {subnetInfo.lastUsable}
              </Text>
            </Flex>
            <Flex flexDirection="column" style={{ fontSize: 13 }}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Usable Hosts</Text>
              <Text>{subnetInfo.usableHosts.toLocaleString()}</Text>
            </Flex>
          </>
        )}
        {subnet.site && (
          <Flex flexDirection="column" style={{ fontSize: 13 }}>
            <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Site</Text>
            <Text>{subnet.site}</Text>
          </Flex>
        )}
        {subnet.vlan && (
          <Flex flexDirection="column" style={{ fontSize: 13 }}>
            <Text style={{ color: 'var(--dt-color-text-subdued)' }}>VLAN</Text>
            <Text>{subnet.vlan}</Text>
          </Flex>
        )}
        <Flex flexDirection="column" style={{ fontSize: 13 }}>
          <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Utilization</Text>
          <Text>{assigned} assigned / {subnetInfo?.usableHosts ?? 0} usable ({utilization}%)</Text>
        </Flex>
      </Flex>

      {syncResult && (
        <Flex
          padding={8}
          style={{
            background: 'var(--dt-color-background-base-default)',
            border: '1px solid var(--dt-color-border-default)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <Text>{syncResult}</Text>
        </Flex>
      )}

      <Flex justifyContent="space-between" alignItems="center">
        <Heading level={3}>IP Records ({records.length})</Heading>
        <Flex gap={8}>
          <Flex gap={16} alignItems="center" style={{ fontSize: 13 }}>
            <Flex gap={6} alignItems="center">
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS.assigned }} />
              <Text>Assigned: {assigned}</Text>
            </Flex>
            <Flex gap={6} alignItems="center">
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS.reserved }} />
              <Text>Reserved: {reserved}</Text>
            </Flex>
            <Flex gap={6} alignItems="center">
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS.available }} />
              <Text>Available: {records.filter((r) => r.status === 'available').length}</Text>
            </Flex>
          </Flex>
          <Button
            onClick={handleOpenSyncPreview}
            disabled={syncing || hostsLoading}
            variant="emphasized"
          >
            {hostsLoading ? 'Loading hosts…' : 'Sync from Dynatrace'}
          </Button>
          {hostsError && (
            <Text style={{ fontSize: 12, color: 'var(--dt-color-text-critical)', alignSelf: 'center' }}>
              Host query error: {hostsError.message}
            </Text>
          )}
          <Button onClick={openAdd} variant="accent">
            Add IP Record
          </Button>
        </Flex>
      </Flex>

      <DataTable data={records} columns={columns} fullWidth>
        <DataTable.RowActions>
          {(row: IpRecord) => (
            <Flex gap={8}>
              <Button onClick={() => openEdit(row)}>Edit</Button>
              <Button onClick={() => void handleDelete(row.id)}>
                Remove
              </Button>
            </Flex>
          )}
        </DataTable.RowActions>
        <DataTable.EmptyState>No IP records. Click "Add IP Record" to track an address.</DataTable.EmptyState>
      </DataTable>

      <Modal
        title="Sync from Dynatrace — Preview"
        show={showSyncPreview}
        onDismiss={() => setShowSyncPreview(false)}
        size="large"
        footer={
          <Flex justifyContent="space-between" alignItems="center" style={{ width: '100%' }}>
            <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>
              Existing records are never removed or overwritten by sync.
            </Text>
            <Flex gap={8}>
              <Button onClick={() => setShowSyncPreview(false)}>Cancel</Button>
              <Button
                onClick={() => void handleConfirmSync()}
                variant="accent"
                disabled={syncPreview.toAdd.length === 0 || syncing}
              >
                {syncPreview.toAdd.length > 0
                  ? `Add ${syncPreview.toAdd.length} record${syncPreview.toAdd.length !== 1 ? 's' : ''}`
                  : 'Nothing to add'}
              </Button>
            </Flex>
          </Flex>
        }
      >
        <Flex flexDirection="column" gap={20} padding={8}>
          {syncPreview.toAdd.length === 0 && syncPreview.conflicts.length === 0 && (
            <Text style={{ color: 'var(--dt-color-text-subdued)' }}>
              No Dynatrace-monitored hosts were found within the <strong>{subnet?.cidr}</strong> range.
            </Text>
          )}

          {syncPreview.toAdd.length > 0 && (
            <Flex flexDirection="column" gap={8}>
              <Text style={{ fontWeight: 600 }}>
                New records to add ({syncPreview.toAdd.length})
              </Text>
              <div
                style={{
                  border: '1px solid var(--dt-color-border-default)',
                  borderRadius: 6,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '160px 1fr',
                    background: 'var(--dt-color-background-base-secondary)',
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--dt-color-text-subdued)',
                  }}
                >
                  <span>IP Address</span>
                  <span>DT Hostname</span>
                </div>
                {syncPreview.toAdd.map((row, i) => (
                  <div
                    key={row.ip}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '160px 1fr',
                      padding: '7px 12px',
                      fontSize: 13,
                      borderTop: i > 0 ? '1px solid var(--dt-color-border-default)' : undefined,
                      background: 'var(--dt-color-background-base-default)',
                    }}
                  >
                    <span style={{ fontFamily: 'monospace' }}>{row.ip}</span>
                    <span>{row.hostname}</span>
                  </div>
                ))}
              </div>
            </Flex>
          )}

          {syncPreview.conflicts.length > 0 && (
            <Flex flexDirection="column" gap={8}>
              <Text style={{ fontWeight: 600 }}>
                Already in IPAM — will be skipped ({syncPreview.conflicts.length})
              </Text>
              <div
                style={{
                  border: '1px solid var(--dt-color-border-default)',
                  borderRadius: 6,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '160px 1fr 1fr 80px',
                    background: 'var(--dt-color-background-base-secondary)',
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--dt-color-text-subdued)',
                  }}
                >
                  <span>IP Address</span>
                  <span>Existing hostname</span>
                  <span>DT hostname</span>
                  <span>Match</span>
                </div>
                {syncPreview.conflicts.map((row, i) => (
                  <div
                    key={row.ip}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '160px 1fr 1fr 80px',
                      padding: '7px 12px',
                      fontSize: 13,
                      borderTop: i > 0 ? '1px solid var(--dt-color-border-default)' : undefined,
                      background: 'var(--dt-color-background-base-default)',
                    }}
                  >
                    <span style={{ fontFamily: 'monospace' }}>{row.ip}</span>
                    <span style={{ color: 'var(--dt-color-text-subdued)' }}>{row.existingHostname}</span>
                    <span>{row.dtHostname}</span>
                    <span
                      style={{
                        color: row.same
                          ? 'var(--dt-color-indicator-success)'
                          : 'var(--dt-color-indicator-warning)',
                        fontWeight: 600,
                        fontSize: 12,
                      }}
                    >
                      {row.same ? 'Yes' : 'Differs'}
                    </span>
                  </div>
                ))}
              </div>
              {syncPreview.conflicts.some((r) => !r.same) && (
                <Text style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>
                  Records marked "Differs" have a different hostname in Dynatrace than what is stored in IPAM.
                  The existing IPAM record will be kept as-is — edit it manually if you want to update it.
                </Text>
              )}
            </Flex>
          )}
        </Flex>
      </Modal>

      <Modal
        title={editId ? 'Edit IP Record' : 'Add IP Record'}
        show={showModal}
        onDismiss={() => setShowModal(false)}
        footer={
          <Flex justifyContent="flex-end" gap={8}>
            <Button onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={() => void handleSave()} variant="accent" disabled={saving}>
              {saving ? 'Saving…' : editId ? 'Save' : 'Add'}
            </Button>
          </Flex>
        }
      >
        <Flex flexDirection="column" gap={16} padding={8}>
          <FormField>
            <Label>IP Address *</Label>
            <TextInput
              value={form.address}
              onChange={field('address')}
              placeholder="e.g. 192.168.1.10"
            />
            {addressError && (
              <Text style={{ color: 'var(--dt-color-text-critical)', fontSize: 12 }}>
                {addressError}
              </Text>
            )}
          </FormField>
          <FormField>
            <Label>Status</Label>
            <Select<IpStatus>
              value={form.status}
              onChange={(val) => val && setForm((prev) => ({ ...prev, status: val }))}
            >
              <Select.Content>
                <Select.Option value="available">Available</Select.Option>
                <Select.Option value="assigned">Assigned</Select.Option>
                <Select.Option value="reserved">Reserved</Select.Option>
              </Select.Content>
            </Select>
          </FormField>
          <FormField>
            <Label>Hostname</Label>
            <TextInput value={form.hostname} onChange={field('hostname')} />
          </FormField>
          <FormField>
            <Label>Owner</Label>
            <TextInput value={form.owner} onChange={field('owner')} />
          </FormField>
          <FormField>
            <Label>Notes</Label>
            <TextInput value={form.notes} onChange={field('notes')} />
          </FormField>
        </Flex>
      </Modal>
    </Flex>
  );
};
