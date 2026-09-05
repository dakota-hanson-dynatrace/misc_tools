import React from 'react';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading } from '@dynatrace/strato-components/typography';
import {
  awsEc2Cpu,
  azureVmCpu,
  gcpComputeCpu,
  awsUnattachedVolumes,
  azureUnattachedDisks,
  gcpUnattachedDisks,
} from '../lib/queries';
import { useCostOptQuery, num } from '../hooks/useCostOpt';
import { StatTiles } from '../components/StatTiles';
import { UsageCell } from '../components/UsageCell';

const DOWNSIZE_CPU_THRESHOLD = 20;

interface ComputeRow {
  provider: 'AWS' | 'Azure' | 'GCP';
  name: string;
  cpu_avg: number;
}

interface VolumeRow {
  provider: 'AWS' | 'Azure' | 'GCP';
  name: string;
  size_gb: number;
  location: string;
}

// ponytail: three sequential useDql calls merged client-side rather than one
// unioned query - DQL can't union differently-shaped timeseries calls across
// distinct metric keys in a single query. Fine at this scale (tens of
// instances); revisit if an environment has thousands of cloud instances.
export const Cloud = () => {
  const aws = useCostOptQuery<{ name: string; cpu_avg: number }>(awsEc2Cpu());
  const azure = useCostOptQuery<{ name: string; cpu_avg: number }>(azureVmCpu());
  const gcp = useCostOptQuery<{ name: string; cpu_avg: number }>(gcpComputeCpu());

  const awsVolumes = useCostOptQuery<{ name: string; size_gb: number; 'aws.availability_zone': string }>(awsUnattachedVolumes());
  const azureDisks = useCostOptQuery<{ name: string; size_gb: number; 'azure.location': string }>(azureUnattachedDisks());
  const gcpDisks = useCostOptQuery<{ name: string; size_gb: number; 'gcp.zone': string }>(gcpUnattachedDisks());

  const computeRows: ComputeRow[] = [
    ...aws.rows.map((r) => ({ provider: 'AWS' as const, name: r.name ?? '-', cpu_avg: num(r.cpu_avg) })),
    ...azure.rows.map((r) => ({ provider: 'Azure' as const, name: r.name ?? '-', cpu_avg: num(r.cpu_avg) })),
    ...gcp.rows.map((r) => ({ provider: 'GCP' as const, name: r.name ?? '-', cpu_avg: num(r.cpu_avg) })),
  ].sort((a, b) => a.cpu_avg - b.cpu_avg);

  const volumeRows: VolumeRow[] = [
    ...awsVolumes.rows.map((r) => ({ provider: 'AWS' as const, name: r.name, size_gb: num(r.size_gb), location: r['aws.availability_zone'] })),
    ...azureDisks.rows.map((r) => ({ provider: 'Azure' as const, name: r.name, size_gb: num(r.size_gb), location: r['azure.location'] })),
    ...gcpDisks.rows.map((r) => ({ provider: 'GCP' as const, name: r.name, size_gb: num(r.size_gb), location: r['gcp.zone'] })),
  ];

  const isLoadingCompute = aws.isLoading || azure.isLoading || gcp.isLoading;
  const isLoadingVolumes = awsVolumes.isLoading || azureDisks.isLoading || gcpDisks.isLoading;
  const downsizeCount = computeRows.filter((r) => r.cpu_avg < DOWNSIZE_CPU_THRESHOLD).length;

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Cloud</Heading>
      <StatTiles
        loading={isLoadingCompute || isLoadingVolumes}
        tiles={[
          { label: 'Compute instances', value: computeRows.length },
          { label: 'Downsize candidates', value: downsizeCount },
          { label: 'Unattached volumes', value: volumeRows.length },
        ]}
      />

      <Heading level={2}>Compute utilization (7d avg)</Heading>
      <DataTable
        data={computeRows}
        sortable
        fullWidth
        loading={isLoadingCompute}
        columns={[
          { id: 'provider', header: 'Provider', accessor: 'provider', width: 90 },
          { id: 'name', header: 'Instance', accessor: 'name', width: 260 },
          {
            id: 'cpu',
            header: 'CPU',
            accessor: 'cpu_avg',
            width: 120,
            cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
          },
          {
            id: 'recommendation',
            header: 'Recommendation',
            accessor: 'cpu_avg',
            width: 180,
            cell: ({ value }: { value: unknown }) => <>{Number(value) < DOWNSIZE_CPU_THRESHOLD ? 'Downsize candidate' : 'Right-sized'}</>,
          },
        ]}
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
