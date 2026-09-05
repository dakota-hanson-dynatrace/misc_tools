import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TimeseriesChart } from '@dynatrace/strato-components-preview/charts';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { k8sWorkloadRawSeries } from '../lib/queries';
import { useCostOptQuery } from '../hooks/useCostOpt';
import { toTimeseries, seriesValues, percentileOf, avgOf, STATUS_LABEL, type SizingStatus } from '../lib/sizing';
import { computeRecommendation, type WorkloadSlackRow, type Recommendation } from '../lib/kubectl';
import { CPU_COLOR, MEM_COLOR } from '../lib/colors';
import type { RawWorkloadRecord } from './Kubernetes';

const RecommendationTile = ({
  label,
  chart,
  status,
  currentLabel,
  recommendedLabel,
  command,
}: {
  label: string;
  chart: React.ReactNode;
  status: SizingStatus;
  currentLabel: string;
  recommendedLabel: string;
  command: string;
}) => (
  // minWidth: 0 on every flex-item in this chain (tile, command row, code
  // block) - without it a flex item's default min-width is its content's
  // natural width, so the long kubectl command refuses to shrink and forces
  // the whole drawer wider than the viewport instead of truncating.
  <Surface padding={16} style={{ flex: '1 1 320px', minWidth: 0 }}>
    <Flex flexDirection="column" gap={8}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading level={4}>{label}</Heading>
        <Text style={{ color: status === 'near-capacity' ? Colors.Text.Critical.Default : Colors.Text.Neutral.Default }}>
          {STATUS_LABEL[status]}
        </Text>
      </Flex>
      {chart}
      <Flex justifyContent="space-between">
        <Text>Request: {currentLabel}</Text>
        <Text>Recommended: {recommendedLabel}</Text>
      </Flex>
      <Flex alignItems="center" gap={8} style={{ minWidth: 0 }}>
        <Code style={{ flex: 1, minWidth: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {command}
        </Code>
        <Button onClick={() => void navigator.clipboard.writeText(command)}>Copy</Button>
      </Flex>
    </Flex>
  </Surface>
);

export const WorkloadDetail = () => {
  const { key = '' } = useParams();
  const navigate = useNavigate();
  const [namespace = '', workload = '', container = ''] = decodeURIComponent(key).split('::');

  const workloads = useCostOptQuery<RawWorkloadRecord>(k8sWorkloadRawSeries());
  const raw = workloads.rows.find(
    (r) => r['k8s.namespace.name'] === namespace && r['k8s.workload.name'] === workload && r['k8s.container.name'] === container
  );

  if (workloads.isLoading) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Text>Loading...</Text>
      </Flex>
    );
  }

  if (!raw) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Heading level={2}>Workload not found</Heading>
      </Flex>
    );
  }

  const cpuUsageSeries = toTimeseries(raw, 'cpu_usage', 'CPU usage');
  const cpuReqSeries = toTimeseries(raw, 'cpu_req', 'CPU request');
  const memUsageSeries = toTimeseries(raw, 'mem_usage', 'Memory usage');
  const memReqSeries = toTimeseries(raw, 'mem_req', 'Memory request');
  memUsageSeries.unit = 'byte';
  memReqSeries.unit = 'byte';

  const slackRow: WorkloadSlackRow = {
    'k8s.workload.name': workload,
    'k8s.namespace.name': namespace,
    'k8s.container.name': container,
    cpu_p90_avg: percentileOf(seriesValues(cpuUsageSeries), 90),
    cpu_req_avg: avgOf(seriesValues(cpuReqSeries)),
    mem_p100_avg: percentileOf(seriesValues(memUsageSeries), 100),
    mem_req_avg: avgOf(seriesValues(memReqSeries)),
  };
  const rec: Recommendation = computeRecommendation(slackRow);

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex alignItems="center" gap={12}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Heading level={1}>{container}</Heading>
      </Flex>
      <Text>
        {workload} &middot; {namespace}
      </Text>

      <Flex gap={16} flexWrap="wrap">
        <RecommendationTile
          label="CPU"
          status={rec.cpuStatus}
          currentLabel={`${Math.round(slackRow.cpu_req_avg)}m`}
          recommendedLabel={`${rec.recommendedCpuRequestM}m (limit ${rec.recommendedCpuLimitM}m)`}
          command={rec.cpuCommand}
          chart={
            <TimeseriesChart data={[cpuUsageSeries, cpuReqSeries]} variant="area" height={160} colorPalette={[CPU_COLOR, Colors.Text.Neutral.Default]} />
          }
        />
        <RecommendationTile
          label="Memory"
          status={rec.memStatus}
          currentLabel={`${Math.round(avgOf(seriesValues(memReqSeries)) / 1024 / 1024)} MB`}
          recommendedLabel={`${rec.recommendedMemRequestMi} MB (limit ${rec.recommendedMemLimitMi} MB)`}
          command={rec.memCommand}
          chart={
            <TimeseriesChart data={[memUsageSeries, memReqSeries]} variant="area" height={160} colorPalette={[MEM_COLOR, Colors.Text.Neutral.Default]} />
          }
        />
      </Flex>

      <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: 12 }}>
        CPU sized off the 90th percentile of usage over the last 7 days; memory off the peak (100th
        percentile), both with a 10% buffer - matching the FinOps dashboard convention this tab is modeled on.
      </Paragraph>
    </Flex>
  );
};
