import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TimeseriesChart } from '@dynatrace/strato-components-preview/charts';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { awsEc2Cpu, azureVmCpu, gcpComputeCpu } from '../lib/queries';
import { useCostOptQuery } from '../hooks/useCostOpt';
import { toTimeseries, seriesValues, percentileOf, statusFromUsagePct, STATUS_LABEL } from '../lib/sizing';
import { CPU_COLOR } from '../lib/colors';
import type { RawCloudCpuRecord, Provider } from './Cloud';

const PROVIDER_SCALE: Record<Provider, number> = { AWS: 1, Azure: 1, GCP: 100 };

export const CloudInstanceDetail = () => {
  const { key = '' } = useParams();
  const navigate = useNavigate();
  const [provider = 'AWS', id = ''] = decodeURIComponent(key).split('::') as [Provider, string];

  const aws = useCostOptQuery<RawCloudCpuRecord>(awsEc2Cpu());
  const azure = useCostOptQuery<RawCloudCpuRecord>(azureVmCpu());
  const gcp = useCostOptQuery<RawCloudCpuRecord>(gcpComputeCpu());
  const isLoading = aws.isLoading || azure.isLoading || gcp.isLoading;

  const rows = provider === 'AWS' ? aws.rows : provider === 'Azure' ? azure.rows : gcp.rows;
  const raw = rows.find((r) => r['dt.smartscape_source.id'] === id);

  if (isLoading) {
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
        <Heading level={2}>Instance not found</Heading>
      </Flex>
    );
  }

  const scale = PROVIDER_SCALE[provider];
  const cpuSeries = toTimeseries(raw, 'cpu', 'CPU usage');
  if (scale !== 1) cpuSeries.datapoints = cpuSeries.datapoints.map((d) => ({ ...d, value: d.value * scale }));
  cpuSeries.unit = '%';
  const cpuPct = percentileOf(seriesValues(cpuSeries), 90);
  const status = statusFromUsagePct(cpuPct);

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex alignItems="center" gap={12}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Heading level={1}>{raw.name}</Heading>
      </Flex>
      <Text>{provider}</Text>

      <Surface padding={16} style={{ maxWidth: 640 }}>
        <Flex flexDirection="column" gap={8}>
          <Flex justifyContent="space-between" alignItems="center">
            <Heading level={4}>CPU</Heading>
            <Text style={{ color: status === 'near-capacity' ? Colors.Text.Critical.Default : Colors.Text.Neutral.Default }}>
              {STATUS_LABEL[status]}
            </Text>
          </Flex>
          <TimeseriesChart data={[cpuSeries]} variant="area" height={200} colorPalette={[CPU_COLOR]} />
          <Text>p90 usage: {cpuPct.toFixed(1)}%</Text>
        </Flex>
      </Surface>

      <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: 12 }}>
        {status === 'downsize'
          ? 'Sustained low CPU utilization - consider a smaller instance type at the next resize.'
          : status === 'near-capacity'
            ? 'Sustained high CPU utilization - consider a larger instance type to avoid throttling.'
            : 'Utilization is in a healthy range for this instance type.'}{' '}
        This app doesn&apos;t know the instance&apos;s vCPU count, so it can&apos;t suggest a specific target size the
        way the Hosts and Kubernetes tabs do.
      </Paragraph>
    </Flex>
  );
};
