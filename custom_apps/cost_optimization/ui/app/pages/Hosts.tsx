import React from 'react';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { hostUsage } from '../lib/queries';
import { useCostOptQuery } from '../hooks/useCostOpt';
import { StatTiles } from '../components/StatTiles';
import { UsageCell } from '../components/UsageCell';

interface Row {
  'dt.entity.host': string;
  host_name: string;
  cpu_avg: number;
  mem_avg: number;
  disk_avg: number;
}

const DOWNSIZE_CPU_THRESHOLD = 20;
const DOWNSIZE_MEM_THRESHOLD = 30;
const NEAR_CAPACITY_THRESHOLD = 80;

function recommendationFor(row: Row): string {
  if (row.cpu_avg > NEAR_CAPACITY_THRESHOLD || row.mem_avg > NEAR_CAPACITY_THRESHOLD || row.disk_avg > NEAR_CAPACITY_THRESHOLD) {
    return 'Near capacity';
  }
  if (row.cpu_avg < DOWNSIZE_CPU_THRESHOLD && row.mem_avg < DOWNSIZE_MEM_THRESHOLD) {
    return 'Downsize candidate';
  }
  return 'Right-sized';
}

export const Hosts = () => {
  const { rows, error, isLoading } = useCostOptQuery<Row>(hostUsage());

  const downsizeCount = rows.filter((r) => recommendationFor(r) === 'Downsize candidate').length;
  const avg = (key: keyof Row) =>
    rows.length ? rows.reduce((sum, r) => sum + Number(r[key]), 0) / rows.length : 0;

  const columns = React.useMemo(
    () => [
      { id: 'host_name', header: 'Host', accessor: 'host_name', width: 260 },
      {
        id: 'cpu_avg',
        header: 'CPU (7d avg)',
        accessor: 'cpu_avg',
        width: 130,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
      {
        id: 'mem_avg',
        header: 'Memory (7d avg)',
        accessor: 'mem_avg',
        width: 140,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
      {
        id: 'disk_avg',
        header: 'Disk (7d avg)',
        accessor: 'disk_avg',
        width: 130,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
      {
        id: 'recommendation',
        header: 'Recommendation',
        accessor: (row: Row) => row,
        width: 180,
        cell: ({ value }: { value: unknown }) => <>{recommendationFor(value as Row)}</>,
      },
    ],
    []
  );

  if (error) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Heading level={2}>Could not load hosts</Heading>
        <Paragraph>{String(error.message ?? error)}</Paragraph>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Hosts</Heading>
      <StatTiles
        loading={isLoading}
        tiles={[
          { label: 'Hosts', value: rows.length },
          { label: 'Avg CPU', value: `${avg('cpu_avg').toFixed(1)}%` },
          { label: 'Avg memory', value: `${avg('mem_avg').toFixed(1)}%` },
          { label: 'Avg disk', value: `${avg('disk_avg').toFixed(1)}%` },
          { label: 'Downsize candidates', value: downsizeCount },
        ]}
      />
      <DataTable data={rows} columns={columns} sortable fullWidth loading={isLoading}>
        <DataTable.EmptyState>No hosts found in this environment.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
