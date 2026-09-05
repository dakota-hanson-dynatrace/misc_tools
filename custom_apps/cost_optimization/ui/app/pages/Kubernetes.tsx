import React from 'react';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Button } from '@dynatrace/strato-components/buttons';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { k8sNodeCapacity, k8sWorkloadSlack } from '../lib/queries';
import { useCostOptQuery, fmtCores, fmtBytes } from '../hooks/useCostOpt';
import { computeRecommendation, type WorkloadSlackRow } from '../lib/kubectl';
import { StatTiles } from '../components/StatTiles';

interface NodeRow {
  'k8s.node.name': string;
  cpu_millicores: number;
  mem_gb: number;
  max_pods: number;
  cur_pods: number;
}

function slackColor(slack: number): string {
  return slack < 0 ? Colors.Text.Critical.Default : Colors.Text.Neutral.Default;
}

export const Kubernetes = () => {
  const nodes = useCostOptQuery<NodeRow>(k8sNodeCapacity());
  const workloads = useCostOptQuery<WorkloadSlackRow>(k8sWorkloadSlack());

  const rows = React.useMemo(
    () =>
      workloads.rows
        .map((row) => ({ row, rec: computeRecommendation(row) }))
        .sort((a, b) => b.rec.cpuSlackM - a.rec.cpuSlackM),
    [workloads.rows]
  );
  const underProvisionedCount = rows.filter((r) => r.rec.cpuSlackM < 0 || r.rec.memSlackMi < 0).length;
  const totalCpuSlack = rows.reduce((sum, r) => sum + r.rec.cpuSlackM, 0);

  const columns = React.useMemo(
    () => [
      { id: 'workload', header: 'Workload', accessor: (r: typeof rows[number]) => r.row['k8s.workload.name'], width: 180 },
      { id: 'namespace', header: 'Namespace', accessor: (r: typeof rows[number]) => r.row['k8s.namespace.name'], width: 130 },
      { id: 'container', header: 'Container', accessor: (r: typeof rows[number]) => r.row['k8s.container.name'], width: 160 },
      {
        id: 'cpu',
        header: 'CPU request → recommended',
        accessor: (r: typeof rows[number]) => r,
        width: 190,
        cell: ({ value }: { value: typeof rows[number] }) => (
          <>{fmtCores(value.row.cpu_req_avg)} {'→'} {fmtCores(value.rec.recommendedCpuRequestM)}</>
        ),
      },
      {
        id: 'cpuSlack',
        header: 'CPU slack',
        accessor: (r: typeof rows[number]) => r.rec.cpuSlackM,
        width: 110,
        cell: ({ value }: { value: unknown }) => (
          <span style={{ color: slackColor(Number(value)) }}>{fmtCores(value)}</span>
        ),
      },
      {
        id: 'mem',
        header: 'Memory request → recommended',
        accessor: (r: typeof rows[number]) => r,
        width: 210,
        cell: ({ value }: { value: typeof rows[number] }) => (
          <>{fmtBytes(value.row.mem_req_avg)} {'→'} {value.rec.recommendedMemRequestMi} MB</>
        ),
      },
      {
        id: 'memSlack',
        header: 'Memory slack',
        accessor: (r: typeof rows[number]) => r.rec.memSlackMi,
        width: 130,
        cell: ({ value }: { value: unknown }) => (
          <span style={{ color: slackColor(Number(value)) }}>{Number(value).toFixed(0)} MB</span>
        ),
      },
      {
        id: 'copy',
        header: '',
        accessor: (r: typeof rows[number]) => r,
        width: 80,
        cell: ({ value }: { value: typeof rows[number] }) => (
          <Button
            variant="emphasized"
            onClick={() => void navigator.clipboard.writeText(`${value.rec.cpuCommand}\n${value.rec.memCommand}`)}
          >
            Copy fix
          </Button>
        ),
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
          { id: 'name', header: 'Node', accessor: 'k8s.node.name', width: 260 },
          { id: 'cpu', header: 'Allocatable CPU', accessor: 'cpu_millicores', width: 150, cell: ({ value }: { value: unknown }) => <>{fmtCores(value)}</> },
          { id: 'mem', header: 'Allocatable memory', accessor: 'mem_gb', width: 160, cell: ({ value }: { value: unknown }) => <>{Number(value).toFixed(1)} GB</> },
          { id: 'pods', header: 'Pods', accessor: (r: NodeRow) => `${r.cur_pods} / ${r.max_pods}`, width: 100 },
        ]}
      >
        <DataTable.EmptyState>No Kubernetes nodes found in this environment.</DataTable.EmptyState>
      </DataTable>

      <Heading level={2}>Container request slack</Heading>
      <DataTable data={rows} columns={columns} sortable fullWidth loading={workloads.isLoading}>
        <DataTable.EmptyState>No Kubernetes workloads found in this environment.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
