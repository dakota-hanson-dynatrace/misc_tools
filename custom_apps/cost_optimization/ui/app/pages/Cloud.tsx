import React from 'react';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading } from '@dynatrace/strato-components/typography';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  awsEc2Cpu,
  azureVmCpu,
  gcpComputeCpu,
  awsUnattachedVolumes,
  azureUnattachedDisks,
  gcpUnattachedDisks,
} from '../lib/queries';
import { useCostOptQuery, num } from '../hooks/useCostOpt';
import { toTimeseries, seriesValues, percentileOf, statusFromUsagePct, STATUS_LABEL, type SizingStatus } from '../lib/sizing';
import { StatTiles } from '../components/StatTiles';
import { UsageCell } from '../components/UsageCell';

export type Provider = 'AWS' | 'Azure' | 'GCP';

export interface RawCloudCpuRecord {
  'dt.smartscape_source.id': string;
  name: string;
  interval: string;
  timeframe: { start: string; end: string };
  cpu: (number | null)[];
}

interface ComputeRow {
  provider: Provider;
  id: string;
  name: string;
  cpuPct: number;
  status: SizingStatus;
}

interface VolumeRow {
  provider: Provider;
  name: string;
  size_gb: number;
  location: string;
}

/** GCP's utilization metric is a 0-1 ratio; AWS/Azure are already 0-100. */
function computeRows(rows: RawCloudCpuRecord[], provider: Provider, scale = 1): ComputeRow[] {
  return rows.map((r) => {
    const cpuPct = percentileOf(seriesValues(toTimeseries(r, 'cpu', 'cpu')), 90) * scale;
    return { provider, id: r['dt.smartscape_source.id'], name: r.name ?? '-', cpuPct, status: statusFromUsagePct(cpuPct) };
  });
}

export const cloudInstanceKey = (provider: Provider, id: string) => `${provider}::${id}`;

// ponytail: three sequential useDql calls merged client-side rather than one
// unioned query - DQL can't union differently-shaped timeseries calls across
// distinct metric keys in a single query. Fine at this scale (tens of
// instances); revisit if an environment has thousands of cloud instances.
export const Cloud = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const aws = useCostOptQuery<RawCloudCpuRecord>(awsEc2Cpu());
  const azure = useCostOptQuery<RawCloudCpuRecord>(azureVmCpu());
  const gcp = useCostOptQuery<RawCloudCpuRecord>(gcpComputeCpu());

  const awsVolumes = useCostOptQuery<{ name: string; size_gb: number; 'aws.availability_zone': string }>(awsUnattachedVolumes());
  const azureDisks = useCostOptQuery<{ name: string; size_gb: number; 'azure.location': string }>(azureUnattachedDisks());
  const gcpDisks = useCostOptQuery<{ name: string; size_gb: number; 'gcp.zone': string }>(gcpUnattachedDisks());

  const rows: ComputeRow[] = React.useMemo(
    () => [...computeRows(aws.rows, 'AWS'), ...computeRows(azure.rows, 'Azure'), ...computeRows(gcp.rows, 'GCP', 100)].sort((a, b) => a.cpuPct - b.cpuPct),
    [aws.rows, azure.rows, gcp.rows]
  );

  const volumeRows: VolumeRow[] = [
    ...awsVolumes.rows.map((r) => ({ provider: 'AWS' as const, name: r.name, size_gb: num(r.size_gb), location: r['aws.availability_zone'] })),
    ...azureDisks.rows.map((r) => ({ provider: 'Azure' as const, name: r.name, size_gb: num(r.size_gb), location: r['azure.location'] })),
    ...gcpDisks.rows.map((r) => ({ provider: 'GCP' as const, name: r.name, size_gb: num(r.size_gb), location: r['gcp.zone'] })),
  ];

  const isLoadingCompute = aws.isLoading || azure.isLoading || gcp.isLoading;
  const isLoadingVolumes = awsVolumes.isLoading || azureDisks.isLoading || gcpDisks.isLoading;
  const downsizeCount = rows.filter((r) => r.status === 'downsize').length;

  const columns = React.useMemo(
    () => [
      { id: 'provider', header: 'Provider', accessor: 'provider', width: 90 },
      { id: 'name', header: 'Instance', accessor: 'name', width: 260 },
      {
        id: 'cpu',
        header: 'CPU (p90, 7d)',
        accessor: 'cpuPct',
        width: 130,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
      {
        id: 'recommendation',
        header: 'Recommendation',
        accessor: 'status',
        width: 180,
        cell: ({ value }: { value: unknown }) => <>{STATUS_LABEL[value as SizingStatus]}</>,
      },
    ],
    []
  );

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Cloud</Heading>
      <StatTiles
        loading={isLoadingCompute || isLoadingVolumes}
        tiles={[
          { label: 'Compute instances', value: rows.length },
          { label: 'Downsize candidates', value: downsizeCount },
          { label: 'Unattached volumes', value: volumeRows.length },
        ]}
      />

      <Heading level={2}>Compute utilization</Heading>
      <DataTable
        data={rows}
        columns={columns}
        sortable
        fullWidth
        loading={isLoadingCompute}
        interactiveRows
        onActiveRowChange={(activeRow) => {
          if (activeRow === null) return;
          const row = rows[Number(activeRow)];
          if (row) navigate(`/cloud/${encodeURIComponent(cloudInstanceKey(row.provider, row.id))}`, { state: { backgroundLocation: location } });
        }}
      >
        <DataTable.EmptyState>
          No AWS, Azure, or GCP compute instances are monitored in this environment.
        </DataTable.EmptyState>
      </DataTable>

      <Heading level={2}>Unattached storage</Heading>
      <DataTable
        data={volumeRows}
        sortable
        fullWidth
        loading={isLoadingVolumes}
        columns={[
          { id: 'provider', header: 'Provider', accessor: 'provider', width: 90 },
          { id: 'name', header: 'Volume/disk', accessor: 'name', width: 220 },
          { id: 'size', header: 'Size', accessor: 'size_gb', width: 100, cell: ({ value }: { value: unknown }) => <>{Number(value)} GB</> },
          { id: 'location', header: 'Location', accessor: 'location', width: 160 },
        ]}
      >
        <DataTable.EmptyState>
          No unattached AWS EBS volumes, Azure disks, or GCP disks found in this environment.
        </DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
