import React from 'react';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { useNavigate, useLocation } from 'react-router-dom';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { k8sNodeCapacity, k8sWorkloadRawSeries } from '../lib/queries';
import { useCostOptQuery, fmtCores, fmtBytes } from '../hooks/useCostOpt';
import { toTimeseries, seriesValues, percentileOf, avgOf, STATUS_LABEL, type SizingStatus } from '../lib/sizing';
import { computeRecommendation, type WorkloadSlackRow } from '../lib/kubectl';
import { StatTiles } from '../components/StatTiles';

interface NodeRow {
  'k8s.node.name': string;
  cpu_millicores: number;
  mem_gb: number;
  max_pods: number;
  cur_pods: number;
}

export interface RawWorkloadRecord {
  'k8s.workload.name': string;
  'k8s.namespace.name': string;
  'k8s.container.name': string;
  interval: string;
  timeframe: { start: string; end: string };
  cpu_usage: (number | null)[];
  cpu_req: (number | null)[];
  mem_usage: (number | null)[];
  mem_req: (number | null)[];
}

/** Composite key for the workload detail drawer route - k8s names can't contain "::". */
export const workloadKey = (r: {
  'k8s.namespace.name': string;
  'k8s.workload.name': string;
  'k8s.container.name': string;
}) => `${r['k8s.namespace.name']}::${r['k8s.workload.name']}::${r['k8s.container.name']}`;

function slackColor(slack: number): string {
  return slack < 0 ? Colors.Text.Critical.Default : Colors.Text.Neutral.Default;
}

export const Kubernetes = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const nodes = useCostOptQuery<NodeRow>(k8sNodeCapacity());
  const workloads = useCostOptQuery<RawWorkloadRecord>(k8sWorkloadRawSeries());

  const rows = React.useMemo(
    () =>
      workloads.rows
        .map((raw) => {
          const slackRow: WorkloadSlackRow = {
            'k8s.workload.name': raw['k8s.workload.name'],
            'k8s.namespace.name': raw['k8s.namespace.name'],
            'k8s.container.name': raw['k8s.container.name'],
            cpu_p90_avg: percentileOf(seriesValues(toTimeseries(raw, 'cpu_usage', 'cpu')), 90),
            cpu_req_avg: avgOf(seriesValues(toTimeseries(raw, 'cpu_req', 'req'))),
            mem_p100_avg: percentileOf(seriesValues(toTimeseries(raw, 'mem_usage', 'mem')), 100),
            mem_req_avg: avgOf(seriesValues(toTimeseries(raw, 'mem_req', 'req'))),
          };
          return { row: slackRow, rec: computeRecommendation(slackRow), key: workloadKey(raw) };
        })
        .sort((a, b) => b.rec.cpuSlackM - a.rec.cpuSlackM),
    [workloads.rows]
  );
  const underProvisionedCount = rows.filter((r) => r.rec.cpuStatus === 'near-capacity' || r.rec.memStatus === 'near-capacity').length;
  const totalCpuSlack = rows.reduce((sum, r) => sum + r.rec.cpuSlackM, 0);

  // Widths kept tight (and headers short) so the table fits without
  // horizontal scroll - open a row's drawer for the full kubectl command
  // (see WorkloadDetail's Copy buttons) instead of a Copy column here.
  // `fr` (not a plain px number) so the columns stretch to fill fullWidth's
  // available space instead of leaving it blank past the last column.
  const columns = React.useMemo(
    () => [
      { id: 'workload', header: 'Workload', accessor: (r: (typeof rows)[number]) => r.row['k8s.workload.name'], width: '13fr' as const },
      { id: 'namespace', header: 'Namespace', accessor: (r: (typeof rows)[number]) => r.row['k8s.namespace.name'], width: '10fr' as const },
      { id: 'container', header: 'Container', accessor: (r: (typeof rows)[number]) => r.row['k8s.container.name'], width: '11fr' as const },
      {
        id: 'cpu',
        header: 'CPU req. → rec.',
        accessor: (r: (typeof rows)[number]) => r,
        width: '12fr' as const,
        cell: ({ value }: { value: (typeof rows)[number] }) => (
          <>{fmtCores(value.row.cpu_req_avg)} {'→'} {fmtCores(value.rec.recommendedCpuRequestM)}</>
        ),
      },
      {
        id: 'cpuSlack',
        header: 'CPU slack',
        accessor: (r: (typeof rows)[number]) => r.rec.cpuSlackM,
        width: '8fr' as const,
        cell: ({ value }: { value: unknown }) => <span style={{ color: slackColor(Number(value)) }}>{fmtCores(value)}</span>,
      },
      {
        id: 'cpuStatus',
        header: 'CPU rec.',
        accessor: (r: (typeof rows)[number]) => r.rec.cpuStatus,
        width: '10fr' as const,
        cell: ({ value }: { value: unknown }) => <>{STATUS_LABEL[value as SizingStatus]}</>,
      },
      {
        id: 'mem',
        header: 'Mem. req. → rec.',
        accessor: (r: (typeof rows)[number]) => r,
        width: '14fr' as const,
        cell: ({ value }: { value: (typeof rows)[number] }) => (
          <>{fmtBytes(value.row.mem_req_avg)} {'→'} {value.rec.recommendedMemRequestMi} MB</>
        ),
      },
      {
        id: 'memSlack',
        header: 'Mem. slack',
        accessor: (r: (typeof rows)[number]) => r.rec.memSlackMi,
        width: '9fr' as const,
        cell: ({ value }: { value: unknown }) => <span style={{ color: slackColor(Number(value)) }}>{Number(value).toFixed(0)} MB</span>,
      },
      {
        id: 'memStatus',
        header: 'Mem. rec.',
        accessor: (r: (typeof rows)[number]) => r.rec.memStatus,
        width: '10fr' as const,
        cell: ({ value }: { value: unknown }) => <>{STATUS_LABEL[value as SizingStatus]}</>,
      },
    ],
    []
  );

  if (workloads.error || nodes.error) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Heading level={2}>Could not load Kubernetes data</Heading>
        <Paragraph>{String((workloads.error ?? nodes.error)?.message ?? workloads.error ?? nodes.error)}</Paragraph>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Kubernetes</Heading>
      <StatTiles
        loading={nodes.isLoading || workloads.isLoading}
        tiles={[
          { label: 'Nodes', value: nodes.rows.length },
          { label: 'Workloads analyzed', value: rows.length },
          { label: 'Under-provisioned', value: underProvisionedCount },
          { label: 'Total CPU slack', value: fmtCores(totalCpuSlack) },
        ]}
      />

      <Heading level={2}>Node capacity</Heading>
      <DataTable
        data={nodes.rows}
        loading={nodes.isLoading}
        fullWidth
        columns={[
          // Accessor must be a function, not the dotted string 'k8s.node.name' -
          // Strato splits a dotted string accessor into a nested object path
          // (row.k8s.node.name), which is undefined for a flat row whose key
          // literally contains dots. Renders blank instead of erroring.
          { id: 'name', header: 'Node', accessor: (r: NodeRow) => r['k8s.node.name'], width: '26fr' },
          { id: 'cpu', header: 'Allocatable CPU', accessor: 'cpu_millicores', width: '15fr', cell: ({ value }: { value: unknown }) => <>{fmtCores(value)}</> },
          { id: 'mem', header: 'Allocatable memory', accessor: 'mem_gb', width: '16fr', cell: ({ value }: { value: unknown }) => <>{Number(value).toFixed(1)} GB</> },
          { id: 'pods', header: 'Pods', accessor: (r: NodeRow) => `${r.cur_pods} / ${r.max_pods}`, width: '10fr' },
        ]}
      >
        <DataTable.EmptyState>No Kubernetes nodes found in this environment.</DataTable.EmptyState>
      </DataTable>

      <Heading level={2}>Container request slack</Heading>
      <DataTable
        data={rows}
        columns={columns}
        sortable
        fullWidth
        loading={workloads.isLoading}
        interactiveRows
        onActiveRowChange={(activeRow) => {
          if (activeRow === null) return;
          const key = rows[Number(activeRow)]?.key;
          if (key) navigate(`/workload/${encodeURIComponent(key)}`, { state: { backgroundLocation: location } });
        }}
      >
        <DataTable.EmptyState>No Kubernetes workloads found in this environment.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
