import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { Modal } from '@dynatrace/strato-components/overlays';
import { FormField, TextInput, Label } from '@dynatrace/strato-components/forms';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import type { DataTableColumnDef } from '@dynatrace/strato-components-preview/tables';
import { useIpam } from '../context/IpamContext';
import { getSubnetInfo, isValidCidr, normalizeNetworkAddress } from '../utils/ipUtils';
import type { Subnet } from '../types/ipam';

interface SubnetRow extends Subnet {
  usableHosts: number;
  assigned: number;
  utilization: number;
}

const emptyForm = { name: '', cidr: '', description: '', site: '', vlan: '', owner: '' };

export const Subnets = () => {
  const navigate = useNavigate();
  const { subnets, ipRecords, addSubnet, updateSubnet, deleteSubnet } = useIpam();

  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [cidrError, setCidrError] = useState('');
  const [saving, setSaving] = useState(false);

  const rows: SubnetRow[] = useMemo(() => {
    const assignedCountBySubnet = new Map<string, number>();
    for (const r of ipRecords) {
      if (r.status !== 'assigned') continue;
      assignedCountBySubnet.set(r.subnetId, (assignedCountBySubnet.get(r.subnetId) ?? 0) + 1);
    }
    return subnets.map((s) => {
      let usableHosts = 0;
      try {
        usableHosts = getSubnetInfo(s.cidr).usableHosts;
      } catch { /* ignore */ }
      const assigned = assignedCountBySubnet.get(s.id) ?? 0;
      const utilization = usableHosts > 0 ? Math.round((assigned / usableHosts) * 100) : 0;
      return { ...s, usableHosts, assigned, utilization };
    });
  }, [subnets, ipRecords]);

  const columns: DataTableColumnDef<SubnetRow>[] = useMemo(
    () => [
      { id: 'name', header: 'Name', accessor: 'name' },
      { id: 'cidr', header: 'CIDR', accessor: 'cidr' },
      { id: 'site', header: 'Site', accessor: (row) => row.site ?? '—' },
      { id: 'vlan', header: 'VLAN', accessor: (row) => row.vlan ?? '—' },
      { id: 'owner', header: 'Owner', accessor: (row) => row.owner ?? '—' },
      {
        id: 'usableHosts',
        header: 'Total IPs',
        accessor: (row) => row.usableHosts.toLocaleString(),
      },
      { id: 'assigned', header: 'Assigned', accessor: (row) => row.assigned.toString() },
      {
        id: 'utilization',
        header: 'Utilization',
        accessor: 'utilization',
        cell: ({ value }: { value: number }) => (
          <Flex alignItems="center" gap={8}>
            <div
              style={{
                height: 6,
                width: 60,
                background: 'var(--dt-color-border-default)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${value}%`,
                  background:
                    value > 90
                      ? 'var(--dt-color-indicator-critical)'
                      : value > 70
                        ? 'var(--dt-color-indicator-warning)'
                        : 'var(--dt-color-indicator-success)',
                  borderRadius: 3,
                }}
              />
            </div>
            <Text style={{ fontSize: 12 }}>{value}%</Text>
          </Flex>
        ),
      },
    ],
    []
  );

  function openAdd() {
    setEditId(null);
    setForm(emptyForm);
    setCidrError('');
    setShowModal(true);
  }

  function openEdit(row: SubnetRow) {
    setEditId(row.id);
    setForm({
      name: row.name,
      cidr: row.cidr,
      description: row.description ?? '',
      site: row.site ?? '',
      vlan: row.vlan ?? '',
      owner: row.owner ?? '',
    });
    setCidrError('');
    setShowModal(true);
  }

  async function handleSave() {
    if (!isValidCidr(form.cidr)) {
      setCidrError('Invalid CIDR notation (e.g. 192.168.1.0/24)');
      return;
    }
    const normalized = normalizeNetworkAddress(form.cidr);
    const payload = { ...form, cidr: normalized };
    setSaving(true);
    try {
      if (editId) {
        await updateSubnet(editId, payload);
      } else {
        await addSubnet(payload);
      }
      setShowModal(false);
    } catch (e: unknown) {
      setCidrError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this subnet and all its IP records?')) return;
    try {
      await deleteSubnet(id);
    } catch (e: unknown) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const field = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading>Subnets</Heading>
        <Button onClick={openAdd} variant="accent">
          Add Subnet
        </Button>
      </Flex>

      <DataTable data={rows} columns={columns} fullWidth>
        <DataTable.RowActions>
          {(row: SubnetRow) => (
            <Flex gap={8}>
              <Button
                onClick={() => void navigate(`/subnets/${row.id}`)}
                variant="emphasized"
              >
                View IPs
              </Button>
              <Button onClick={() => openEdit(row)}>Edit</Button>
              <Button onClick={() => void handleDelete(row.id)}>
                Delete
              </Button>
            </Flex>
          )}
        </DataTable.RowActions>
        <DataTable.EmptyState>No subnets yet. Click "Add Subnet" to get started.</DataTable.EmptyState>
      </DataTable>

      <Modal
        title={editId ? 'Edit Subnet' : 'Add Subnet'}
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
            <Label>Name *</Label>
            <TextInput value={form.name} onChange={field('name')} placeholder="e.g. Corp LAN" />
          </FormField>
          <FormField>
            <Label>CIDR *</Label>
            <TextInput
              value={form.cidr}
              onChange={field('cidr')}
              placeholder="e.g. 192.168.1.0/24"
            />
            {cidrError && (
              <Text style={{ color: 'var(--dt-color-text-critical)', fontSize: 12 }}>
                {cidrError}
              </Text>
            )}
          </FormField>
          <FormField>
            <Label>Description</Label>
            <TextInput value={form.description} onChange={field('description')} />
          </FormField>
          <FormField>
            <Label>Site</Label>
            <TextInput value={form.site} onChange={field('site')} placeholder="e.g. HQ" />
          </FormField>
          <FormField>
            <Label>VLAN</Label>
            <TextInput value={form.vlan} onChange={field('vlan')} placeholder="e.g. 100" />
          </FormField>
          <FormField>
            <Label>Owner</Label>
            <TextInput value={form.owner} onChange={field('owner')} />
          </FormField>
        </Flex>
      </Modal>
    </Flex>
  );
};
