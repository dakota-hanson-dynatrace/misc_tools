import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Text, Paragraph } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { Select } from '@dynatrace/strato-components/forms';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import type { DataTableColumnDef } from '@dynatrace/strato-components-preview/tables';
import { useIpam } from '../context/IpamContext';
import { parseCsvRows, isValidCidr, normalizeNetworkAddress, isValidIpv4 } from '../utils/ipUtils';
import type { Subnet, IpStatus } from '../types/ipam';

// ─── Subnet import (existing format) ────────────────────────────────────────

const SUBNET_FIELDS: Array<keyof Omit<Subnet, 'id' | 'createdAt'>> = [
  'cidr', 'name', 'description', 'site', 'vlan', 'owner',
];

type ColumnMap = Record<string, string>;

interface SubnetPreviewRow {
  cidr: string;
  name: string;
  description: string;
  site: string;
  vlan: string;
  owner: string;
  _valid: boolean;
  _error: string;
}

// ─── SolarWinds IP-record import ─────────────────────────────────────────────

const SW_AUTO_MAP: Record<string, string> = {
  swAddress:          'IP Address',
  swSubnet:           'Subnet',
  swStatus:           'Status',
  swHostname:         'DNS Name',
  swHostnameFallback: 'Node Name',
  swOwner:            'Department',
  swNotes1:           'Description',
  swNotes2:           'Comments',
  swVlan:             'VLAN ID',
  swSite:             'Location',
};

function mapSwStatus(raw: string): IpStatus {
  switch (raw.trim().toLowerCase()) {
    case 'used':      return 'assigned';
    case 'reserved':  return 'reserved';
    case 'available': return 'available';
    default:          return 'available'; // Transient, Unknown, etc.
  }
}

interface SwIpRow {
  address: string;
  subnetCidr: string;
  status: IpStatus;
  hostname: string;
  owner: string;
  notes: string;
  _rawStatus: string;
  _isDuplicate: boolean;
  _isInvalidIp: boolean;
}

interface SwSubnetMeta {
  cidr: string;
  name: string;
  site: string;
  vlan: string;
  isNew: boolean;
  existingId: string | null;
  count: number;
  skipped: number;
}

function isSolarWindsFormat(headers: string[]): boolean {
  return headers.includes('IP Address') && headers.includes('Subnet') && headers.includes('Status');
}

// ─── Component ───────────────────────────────────────────────────────────────

export const Import = () => {
  const navigate = useNavigate();
  const { importSubnets, importIpRecords, subnets, ipRecords } = useIpam();
  const fileRef = useRef<HTMLInputElement>(null);

  // shared state
  const [importMode, setImportMode] = useState<'none' | 'subnet' | 'solarwinds'>('none');
  const [imported, setImported] = useState(false);
  const [importSummary, setImportSummary] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');

  // subnet import state
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [columnMap, setColumnMap] = useState<ColumnMap>({});

  // solarwinds import state
  const [swRows, setSwRows] = useState<SwIpRow[]>([]);
  const [swSubnets, setSwSubnets] = useState<SwSubnetMeta[]>([]);
  const [swColumnMap, setSwColumnMap] = useState<ColumnMap>({});
  const [swAllHeaders, setSwAllHeaders] = useState<string[]>([]);
  const [showSwMapping, setShowSwMapping] = useState(false);

  // ── Subnet preview rows ────────────────────────────────────────────────────

  const subnetPreview: SubnetPreviewRow[] = rawRows.map((row) => {
    const mapped: Record<string, string> = {};
    SUBNET_FIELDS.forEach((field) => {
      mapped[field] = columnMap[field] ? (row[columnMap[field]] ?? '') : '';
    });
    const valid = isValidCidr(mapped.cidr) && mapped.name.trim().length > 0;
    return {
      cidr: mapped.cidr,
      name: mapped.name,
      description: mapped.description,
      site: mapped.site,
      vlan: mapped.vlan,
      owner: mapped.owner,
      _valid: valid,
      _error: !isValidCidr(mapped.cidr) ? 'Invalid CIDR' : !mapped.name ? 'Name required' : '',
    };
  });
  const validSubnetRows = subnetPreview.filter((r) => r._valid);

  // ── File parsing ───────────────────────────────────────────────────────────

  function rebuildSwRows(rows: Record<string, string>[], cmap: ColumnMap, existingSubnets: Subnet[]) {
    const existingRecordKeys = new Set(
      ipRecords.map((r) => {
        const sub = existingSubnets.find((s) => s.id === r.subnetId);
        return sub ? `${sub.cidr}|${r.address}` : '';
      })
    );

    // Build per-subnet metadata from first row of each group
    const subnetMetaMap = new Map<string, { name: string; site: string; vlan: string }>();

    const parsed: SwIpRow[] = rows.map((row) => {
      const address    = row[cmap.swAddress ?? ''] ?? '';
      const subnetCidr = row[cmap.swSubnet ?? ''] ?? '';
      const rawStatus  = row[cmap.swStatus ?? ''] ?? '';
      const dnsName    = row[cmap.swHostname ?? ''] ?? '';
      const nodeName   = row[cmap.swHostnameFallback ?? ''] ?? '';
      const owner      = row[cmap.swOwner ?? ''] ?? '';
      const notes1     = row[cmap.swNotes1 ?? ''] ?? '';
      const notes2     = row[cmap.swNotes2 ?? ''] ?? '';
      const vlan       = row[cmap.swVlan ?? ''] ?? '';
      const site       = row[cmap.swSite ?? ''] ?? '';
      const vlanName   = row['VLAN Name'] ?? '';

      const hostname = dnsName || nodeName;
      const notes = [notes1, notes2].filter(Boolean).join(' | ');
      const normCidr = isValidCidr(subnetCidr) ? normalizeNetworkAddress(subnetCidr) : subnetCidr;

      if (!subnetMetaMap.has(normCidr)) {
        subnetMetaMap.set(normCidr, {
          name: vlanName || normCidr,
          site,
          vlan,
        });
      }

      const isDuplicate = existingRecordKeys.has(`${normCidr}|${address}`);
      const isInvalidIp = !isValidIpv4(address);

      return {
        address,
        subnetCidr: normCidr,
        status: mapSwStatus(rawStatus),
        hostname,
        owner,
        notes,
        _rawStatus: rawStatus,
        _isDuplicate: isDuplicate,
        _isInvalidIp: isInvalidIp,
      };
    });

    // Build per-subnet summary
    const subnetCidrs = [...new Set(parsed.map((r) => r.subnetCidr))];
    const subnetMetas: SwSubnetMeta[] = subnetCidrs.map((cidr) => {
      const existing = existingSubnets.find((s) => normalizeNetworkAddress(s.cidr) === cidr);
      const meta = subnetMetaMap.get(cidr) ?? { name: cidr, site: '', vlan: '' };
      const rows = parsed.filter((r) => r.subnetCidr === cidr);
      const skipped = rows.filter((r) => r._isDuplicate || r._isInvalidIp).length;
      return {
        cidr,
        name: meta.name,
        site: meta.site,
        vlan: meta.vlan,
        isNew: !existing,
        existingId: existing?.id ?? null,
        count: rows.length - skipped,
        skipped,
      };
    });

    setSwRows(parsed);
    setSwSubnets(subnetMetas);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCsvRows(text);
      if (rows.length === 0) return;

      const headers = Object.keys(rows[0]);
      setImported(false);

      if (isSolarWindsFormat(headers)) {
        setImportMode('solarwinds');
        setSwAllHeaders(headers);

        // Auto-map: match SW_AUTO_MAP defaults, then fall back to any header that
        // exists in this file
        const cmap: ColumnMap = {};
        Object.entries(SW_AUTO_MAP).forEach(([field, defaultCol]) => {
          cmap[field] = headers.includes(defaultCol) ? defaultCol : '';
        });
        setSwColumnMap(cmap);
        rebuildSwRows(rows, cmap, subnets);
        setRawRows(rows); // reuse rawRows to hold raw data for re-mapping
        setCsvHeaders(headers);
      } else {
        setImportMode('subnet');
        setCsvHeaders(headers);
        setRawRows(rows);

        const autoMap: ColumnMap = {};
        SUBNET_FIELDS.forEach((field) => {
          const match = headers.find(
            (h) => h.toLowerCase().replace(/[\s_-]/g, '') === field.toLowerCase()
          );
          if (match) autoMap[field] = match;
        });
        setColumnMap(autoMap);
      }
    };
    reader.readAsText(file);
  }

  // ── SW column map change ──────────────────────────────────────────────────

  function handleSwMapChange(field: string, value: string) {
    const next = { ...swColumnMap, [field]: value };
    setSwColumnMap(next);
    rebuildSwRows(rawRows, next, subnets);
  }

  // ── Import actions ─────────────────────────────────────────────────────────

  async function handleSubnetImport() {
    const toAdd = validSubnetRows.map(({ cidr, name, description, site, vlan, owner }) => ({
      cidr,
      name,
      description: description || undefined,
      site: site || undefined,
      vlan: vlan || undefined,
      owner: owner || undefined,
    }));
    setImporting(true);
    try {
      const result = await importSubnets(toAdd);
      setImportSummary(
        `Imported ${result.added} subnet${result.added !== 1 ? 's' : ''}` +
        (result.skipped > 0 ? ` (${result.skipped} skipped - overlapping or duplicate CIDR)` : '')
      );
      setImported(true);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  async function handleSwImport() {
    const newSubnets = swSubnets
      .filter((s) => s.isNew)
      .map(({ cidr, name, site, vlan }) => ({
        cidr,
        name,
        site: site || undefined,
        vlan: vlan || undefined,
        description: undefined,
        owner: undefined,
      }));

    const validRecords = swRows
      .filter((r) => !r._isDuplicate && !r._isInvalidIp)
      .map((r) => ({
        _tempSubnetCidr: r.subnetCidr,
        subnetId: '',
        address: r.address,
        status: r.status,
        hostname: r.hostname || undefined,
        owner: r.owner || undefined,
        notes: r.notes || undefined,
      }));

    setImporting(true);
    try {
      const result = await importIpRecords(newSubnets, validRecords);
      const parts: string[] = [];
      if (result.subnetsAdded > 0) parts.push(`${result.subnetsAdded} new subnet${result.subnetsAdded !== 1 ? 's' : ''}`);
      parts.push(`${result.added} IP record${result.added !== 1 ? 's' : ''}`);
      setImportSummary(
        `Imported ${parts.join(' and ')}` +
        (result.skipped > 0 ? ` (${result.skipped} skipped - overlapping subnet or duplicate address)` : '')
      );
      setImported(true);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  // ── Preview columns ────────────────────────────────────────────────────────

  const subnetPreviewColumns: DataTableColumnDef<SubnetPreviewRow>[] = [
    {
      id: 'status', header: '', accessor: '_valid', width: 36,
      cell: ({ value }: { value: boolean }) => (
        <Text style={{ color: value ? 'var(--dt-color-indicator-success)' : 'var(--dt-color-indicator-critical)', fontSize: 16 }}>
          {value ? '✓' : '✗'}
        </Text>
      ),
    },
    { id: 'cidr',  header: 'CIDR',  accessor: 'cidr' },
    { id: 'name',  header: 'Name',  accessor: 'name' },
    { id: 'site',  header: 'Site',  accessor: (r) => r.site  || '—' },
    { id: 'vlan',  header: 'VLAN',  accessor: (r) => r.vlan  || '—' },
    { id: 'owner', header: 'Owner', accessor: (r) => r.owner || '—' },
    { id: 'error', header: 'Issue', accessor: (r) => r._error || '—' },
  ];

  const STATUS_COLORS: Record<IpStatus, string> = {
    available: 'var(--dt-color-indicator-success)',
    assigned:  'var(--dt-color-indicator-primary)',
    reserved:  'var(--dt-color-indicator-warning)',
  };

  const swPreviewColumns: DataTableColumnDef<SwIpRow>[] = [
    {
      id: 'flag', header: '', accessor: (r) => r, width: 36,
      cell: ({ value: r }: { value: SwIpRow }) => (
        <Text style={{
          color: (r._isDuplicate || r._isInvalidIp)
            ? 'var(--dt-color-text-subdued)'
            : 'var(--dt-color-indicator-success)',
          fontSize: 16,
        }}>
          {r._isDuplicate ? '⊘' : r._isInvalidIp ? '✗' : '✓'}
        </Text>
      ),
    },
    { id: 'address', header: 'IP Address', accessor: 'address',
      cell: ({ value }: { value: string }) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{value}</Text>
      ),
    },
    {
      id: 'status', header: 'Status', accessor: (r) => ({ status: r.status, raw: r._rawStatus }),
      cell: ({ value }: { value: { status: IpStatus; raw: string } }) => (
        <Flex alignItems="center" gap={6}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[value.status], flexShrink: 0 }} />
          <Text style={{ fontSize: 12, textTransform: 'capitalize' }}>{value.status}</Text>
          {value.raw.toLowerCase() === 'transient' && (
            <Text style={{ fontSize: 11, color: 'var(--dt-color-text-subdued)' }}>(Transient)</Text>
          )}
        </Flex>
      ),
    },
    { id: 'hostname', header: 'Hostname', accessor: (r) => r.hostname || '—',
      cell: ({ value }: { value: string }) => (
        <Text style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{value}</Text>
      ),
    },
    { id: 'owner',  header: 'Owner/Dept', accessor: (r) => r.owner || '—',
      cell: ({ value }: { value: string }) => <Text style={{ fontSize: 12 }}>{value}</Text>,
    },
    { id: 'subnet', header: 'Subnet', accessor: 'subnetCidr',
      cell: ({ value }: { value: string }) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{value}</Text>
      ),
    },
    { id: 'skip', header: 'Action', accessor: (r) => r,
      cell: ({ value: r }: { value: SwIpRow }) => (
        <Text style={{ fontSize: 12, color: r._isDuplicate ? 'var(--dt-color-text-subdued)' : r._isInvalidIp ? 'var(--dt-color-text-critical)' : 'var(--dt-color-text-default)' }}>
          {r._isDuplicate ? 'Skip (duplicate)' : r._isInvalidIp ? 'Skip (invalid IP)' : 'Import'}
        </Text>
      ),
    },
  ];

  const headerOptions = ['', ...csvHeaders];
  const swHeaderOptions = ['', ...swAllHeaders];

  const swValidCount  = swRows.filter((r) => !r._isDuplicate && !r._isInvalidIp).length;
  const swSkipCount   = swRows.length - swValidCount;
  const swNewSubnets  = swSubnets.filter((s) => s.isNew);
  const swExistSubnets = swSubnets.filter((s) => !s.isNew);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (imported) {
    return (
      <Flex flexDirection="column" alignItems="center" padding={48} gap={16}
        style={{ background: 'var(--dt-color-background-base-default)', border: '1px solid var(--dt-color-indicator-success)', borderRadius: 8, margin: 32 }}>
        <Text style={{ color: 'var(--dt-color-indicator-success)', fontSize: 20, fontWeight: 600 }}>
          {importSummary}
        </Text>
        <Flex gap={12}>
          <Button onClick={() => void navigate('/subnets')} variant="accent">View Subnets</Button>
          <Button onClick={() => { setImported(false); setImportMode('none'); if (fileRef.current) fileRef.current.value = ''; }}>
            Import Another
          </Button>
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Heading>Import from CSV</Heading>

      <Flex flexDirection="column" gap={8}>
        <Paragraph style={{ fontSize: 13, color: 'var(--dt-color-text-subdued)' }}>
          Accepts standard subnet CSV (one row per subnet) or SolarWinds IPAM exports (one row per IP address).
          SolarWinds format is detected automatically.
        </Paragraph>
      </Flex>

      <Flex flexDirection="column" gap={12}>
        <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFile} />
        <Button onClick={() => fileRef.current?.click()} variant="accent">
          Choose CSV File
        </Button>
      </Flex>

      {importError && (
        <Flex
          padding={8}
          style={{
            background: 'var(--dt-color-background-base-default)',
            border: '1px solid var(--dt-color-indicator-critical)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <Text style={{ color: 'var(--dt-color-text-critical)' }}>Import failed: {importError}</Text>
        </Flex>
      )}

      {/* ── SolarWinds mode ──────────────────────────────────────────────── */}
      {importMode === 'solarwinds' && (
        <>
          <Flex
            gap={8}
            alignItems="center"
            padding={8}
            style={{
              background: 'var(--dt-color-background-base-default)',
              border: '1px solid var(--dt-color-indicator-primary)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--dt-color-indicator-primary)', flexShrink: 0 }} />
            <Text>SolarWinds IPAM format detected — importing IP records</Text>
          </Flex>

          {/* Status mapping note */}
          <Flex gap={12} alignItems="center" style={{ fontSize: 12, color: 'var(--dt-color-text-subdued)' }}>
            <Text style={{ fontWeight: 600 }}>Status mapping:</Text>
            {[['Used','Assigned'], ['Reserved','Reserved'], ['Available','Available'], ['Transient','Available']].map(([from, to]) => (
              <Text key={from}>{from} → {to}</Text>
            ))}
          </Flex>

          {/* Column mapping (collapsible) */}
          <Flex flexDirection="column" gap={8}>
            <Flex alignItems="center" gap={8}>
              <Text style={{ fontWeight: 600 }}>Column mapping</Text>
              <Button onClick={() => setShowSwMapping((v) => !v)} variant="emphasized">
                {showSwMapping ? 'Hide' : 'Edit'}
              </Button>
            </Flex>
            {showSwMapping && (
              <Flex gap={12} flexFlow="wrap">
                {Object.entries(SW_AUTO_MAP).map(([field, _]) => {
                  const label = field
                    .replace('sw', '')
                    .replace(/([A-Z])/g, ' $1')
                    .trim();
                  return (
                    <Flex key={field} flexDirection="column" gap={4} style={{ minWidth: 160 }}>
                      <Text style={{ fontSize: 12 }}>{label}</Text>
                      <Select<string>
                        value={swColumnMap[field] ?? ''}
                        onChange={(val) => handleSwMapChange(field, val ?? '')}
                      >
                        <Select.Content>
                          {swHeaderOptions.map((h) => (
                            <Select.Option key={h} value={h}>{h || '(none)'}</Select.Option>
                          ))}
                        </Select.Content>
                      </Select>
                    </Flex>
                  );
                })}
              </Flex>
            )}
          </Flex>

          {/* Summary */}
          <Flex gap={24} flexFlow="wrap" style={{ fontSize: 13 }}>
            <Flex flexDirection="column" gap={2}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>IP records</Text>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{swRows.length}</Text>
            </Flex>
            <Flex flexDirection="column" gap={2}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>To import</Text>
              <Text style={{ fontWeight: 600, fontSize: 18, color: 'var(--dt-color-indicator-success)' }}>{swValidCount}</Text>
            </Flex>
            <Flex flexDirection="column" gap={2}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>Skipped</Text>
              <Text style={{ fontWeight: 600, fontSize: 18, color: 'var(--dt-color-text-subdued)' }}>{swSkipCount}</Text>
            </Flex>
            <Flex flexDirection="column" gap={2}>
              <Text style={{ color: 'var(--dt-color-text-subdued)' }}>New subnets</Text>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{swNewSubnets.length}</Text>
            </Flex>
          </Flex>

          {/* New subnets section */}
          {swNewSubnets.length > 0 && (
            <Flex flexDirection="column" gap={8}>
              <Text style={{ fontWeight: 600 }}>Subnets that will be created ({swNewSubnets.length})</Text>
              <div style={{ border: '1px solid var(--dt-color-border-default)', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 120px 80px 60px', background: 'var(--dt-color-background-base-secondary)', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--dt-color-text-subdued)' }}>
                  <span>CIDR</span><span>Name (from VLAN Name)</span><span>Site</span><span>VLAN</span><span>IPs</span>
                </div>
                {swNewSubnets.map((s, i) => (
                  <div key={s.cidr} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 120px 80px 60px', padding: '7px 12px', fontSize: 13, borderTop: i > 0 ? '1px solid var(--dt-color-border-default)' : undefined, background: 'var(--dt-color-background-base-default)' }}>
                    <span style={{ fontFamily: 'monospace' }}>{s.cidr}</span>
                    <span>{s.name}</span>
                    <span style={{ color: 'var(--dt-color-text-subdued)' }}>{s.site || '—'}</span>
                    <span style={{ color: 'var(--dt-color-text-subdued)' }}>{s.vlan || '—'}</span>
                    <span>{s.count}</span>
                  </div>
                ))}
              </div>
            </Flex>
          )}

          {swExistSubnets.length > 0 && (
            <Flex flexDirection="column" gap={8}>
              <Text style={{ fontWeight: 600 }}>Existing subnets (records will be added to these)</Text>
              <div style={{ border: '1px solid var(--dt-color-border-default)', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 80px 60px', background: 'var(--dt-color-background-base-secondary)', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--dt-color-text-subdued)' }}>
                  <span>CIDR</span><span>Name</span><span>Skip</span><span>Import</span>
                </div>
                {swExistSubnets.map((s, i) => (
                  <div key={s.cidr} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 80px 60px', padding: '7px 12px', fontSize: 13, borderTop: i > 0 ? '1px solid var(--dt-color-border-default)' : undefined, background: 'var(--dt-color-background-base-default)' }}>
                    <span style={{ fontFamily: 'monospace' }}>{s.cidr}</span>
                    <span>{s.name}</span>
                    <span style={{ color: 'var(--dt-color-text-subdued)' }}>{s.skipped}</span>
                    <span>{s.count}</span>
                  </div>
                ))}
              </div>
            </Flex>
          )}

          {/* IP records preview */}
          <Flex flexDirection="column" gap={8}>
            <Flex justifyContent="space-between" alignItems="center">
              <Text style={{ fontWeight: 600 }}>
                IP Records Preview ({swValidCount} to import, {swSkipCount} skipped)
              </Text>
              <Button
                onClick={() => void handleSwImport()}
                variant="accent"
                disabled={swValidCount === 0 || importing}
              >
                {importing ? 'Importing…' : `Import ${swValidCount} Record${swValidCount !== 1 ? 's' : ''}`}
              </Button>
            </Flex>
            <DataTable data={swRows} columns={swPreviewColumns} fullWidth />
          </Flex>
        </>
      )}

      {/* ── Subnet mode ──────────────────────────────────────────────────── */}
      {importMode === 'subnet' && (
        <>
          <Flex flexDirection="column" gap={12}>
            <Text style={{ fontWeight: 600 }}>Map CSV columns</Text>
            <Flex gap={16} flexFlow="wrap">
              {SUBNET_FIELDS.map((field) => (
                <Flex key={field} flexDirection="column" gap={4} style={{ minWidth: 160 }}>
                  <Text style={{ fontSize: 13, textTransform: 'capitalize' }}>
                    {field}{field === 'cidr' || field === 'name' ? ' *' : ''}
                  </Text>
                  <Select<string>
                    value={columnMap[field] ?? ''}
                    onChange={(val) => setColumnMap((prev) => ({ ...prev, [field]: val ?? '' }))}
                  >
                    <Select.Content>
                      {headerOptions.map((h) => (
                        <Select.Option key={h} value={h}>{h || '(none)'}</Select.Option>
                      ))}
                    </Select.Content>
                  </Select>
                </Flex>
              ))}
            </Flex>
          </Flex>

          <Flex flexDirection="column" gap={12}>
            <Flex justifyContent="space-between" alignItems="center">
              <Text style={{ fontWeight: 600 }}>
                Preview ({validSubnetRows.length} valid / {subnetPreview.length} total)
              </Text>
              <Button onClick={() => void handleSubnetImport()} variant="accent" disabled={validSubnetRows.length === 0 || importing}>
                {importing ? 'Importing…' : `Import ${validSubnetRows.length} Subnet${validSubnetRows.length !== 1 ? 's' : ''}`}
              </Button>
            </Flex>
            <DataTable data={subnetPreview} columns={subnetPreviewColumns} fullWidth />
          </Flex>
        </>
      )}
    </Flex>
  );
};
