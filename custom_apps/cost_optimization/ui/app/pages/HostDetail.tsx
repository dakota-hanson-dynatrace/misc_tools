import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TimeseriesChart } from '@dynatrace/strato-components-preview/charts';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { hostRawSeries, hostCapacity, hostDiskRawSeries, diskInventory } from '../lib/queries';
import { useCostOptQuery, num } from '../hooks/useCostOpt';
import {
  toTimeseries,
  seriesValues,
  cpuRecommendation,
  memRecommendation,
  diskRecommendation,
  STATUS_LABEL,
  type SizeRecommendation,
} from '../lib/hostSizing';
import { CPU_COLOR, MEM_COLOR } from '../lib/colors';

interface RawHostRecord {
  'dt.entity.host': string;
  interval: string;
  timeframe: { start: string; end: string };
  cpu: (number | null)[];
  mem: (number | null)[];
}
interface CapacityRow {
  id: string;
  name: string;
  cores: string;
  memory: string;
}
interface RawDiskRecord {
  'dt.entity.host': string;
  'dt.entity.disk': string;
  interval: string;
  timeframe: { start: string; end: string };
  used: (number | null)[];
  avail: (number | null)[];
}
interface DiskInfo {
  id: string;
  name: string;
}

const RecommendationTile = ({
  label,
  chart,
  rec,
}: {
  label: string;
  chart: React.ReactNode;
  rec: SizeRecommendation;
}) => (
  <Surface padding={16} style={{ flex: '1 1 280px' }}>
    <Flex flexDirection="column" gap={8}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading level={4}>{label}</Heading>
        <Text style={{ color: rec.status === 'near-capacity' ? Colors.Text.Critical.Default : Colors.Text.Neutral.Default }}>
          {STATUS_LABEL[rec.status]}
        </Text>
      </Flex>
      {chart}
      <Flex justifyContent="space-between">
        <Text>Current: {rec.currentLabel}</Text>
        <Text>Recommended: {rec.recommendedLabel}</Text>
      </Flex>
    </Flex>
  </Surface>
);

export const HostDetail = () => {
  const { hostId = '' } = useParams();
  const navigate = useNavigate();

  const raw = useCostOptQuery<RawHostRecord>(hostRawSeries());
  const capacity = useCostOptQuery<CapacityRow>(hostCapacity());
  const disks = useCostOptQuery<RawDiskRecord>(hostDiskRawSeries());
  const diskNames = useCostOptQuery<DiskInfo>(diskInventory());
  const isLoading = raw.isLoading || capacity.isLoading || disks.isLoading || diskNames.isLoading;

  const hostRecord = raw.rows.find((r) => r['dt.entity.host'] === hostId);
  const cap = capacity.rows.find((c) => c.id === hostId);
  const hostDisks = disks.rows.filter((d) => d['dt.entity.host'] === hostId);
  const diskNameById = new Map(diskNames.rows.map((d) => [d.id, d.name]));

  if (isLoading) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Text>Loading...</Text>
      </Flex>
    );
  }

  if (!hostRecord) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Heading level={2}>Host not found</Heading>
      </Flex>
    );
  }

  const cores = num(cap?.cores) || 1;
  const memBytes = num(cap?.memory);
  const cpuSeries = toTimeseries(hostRecord, 'cpu', 'CPU usage');
  const memSeries = toTimeseries(hostRecord, 'mem', 'Memory usage');
  cpuSeries.unit = '%';
  memSeries.unit = '%';
  const cpuRec = cpuRecommendation(cores, seriesValues(cpuSeries));
  const memRec = memRecommendation(memBytes, seriesValues(memSeries));

  const diskEntries = hostDisks.map((d) => {
    const usedSeries = toTimeseries(d, 'used', diskNameById.get(d['dt.entity.disk']) ?? d['dt.entity.disk']);
    usedSeries.unit = 'byte';
    const availValues = seriesValues(toTimeseries(d, 'avail', 'avail'));
    const usedValues = seriesValues(usedSeries);
    const totalBytes = (usedValues.at(-1) ?? 0) + (availValues.at(-1) ?? 0);
    return {
      diskId: d['dt.entity.disk'],
      name: diskNameById.get(d['dt.entity.disk']) ?? d['dt.entity.disk'],
      series: usedSeries,
      rec: diskRecommendation(usedValues, totalBytes),
    };
  });
  const worstDisk = [...diskEntries].sort((a, b) => b.rec.usagePct - a.rec.usagePct)[0];

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex alignItems="center" gap={12}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Heading level={1}>{cap?.name ?? hostId}</Heading>
      </Flex>

      <Flex gap={16} flexWrap="wrap">
        <RecommendationTile
          label="CPU"
          rec={cpuRec}
          chart={
            <TimeseriesChart data={[cpuSeries]} variant="area" height={160} colorPalette={[CPU_COLOR]} />
          }
        />
        <RecommendationTile
          label="Memory"
          rec={memRec}
          chart={
            <TimeseriesChart data={[memSeries]} variant="area" height={160} colorPalette={[MEM_COLOR]} />
          }
        />
        {worstDisk && (
          <RecommendationTile
            label={`Disk (${diskEntries.length} total, worst shown)`}
            rec={worstDisk.rec}
            chart={
              <TimeseriesChart
                data={diskEntries.map((d) => d.series)}
                variant="area"
                height={160}
              />
            }
          />
        )}
      </Flex>

      <Heading level={2}>Disks</Heading>
      <DataTable
        data={diskEntries}
        fullWidth
        sortable
        columns={[
          { id: 'name', header: 'Mount', accessor: 'name', width: 280 },
          {
            id: 'usage',
            header: 'Usage (p90, 7d)',
            accessor: (r: (typeof diskEntries)[number]) => r.rec.usagePct,
            width: 150,
            cell: ({ value }: { value: unknown }) => <>{Number(value).toFixed(1)}%</>,
          },
          { id: 'current', header: 'Current size', accessor: (r: (typeof diskEntries)[number]) => r.rec.currentLabel, width: 130 },
          { id: 'recommended', header: 'Recommended size', accessor: (r: (typeof diskEntries)[number]) => r.rec.recommendedLabel, width: 150 },
          {
            id: 'status',
            header: 'Status',
            accessor: (r: (typeof diskEntries)[number]) => r.rec.status,
            width: 160,
            cell: ({ value }: { value: unknown }) => <>{STATUS_LABEL[value as SizeRecommendation['status']]}</>,
          },
        ]}
      >
        <DataTable.EmptyState>No disks found for this host.</DataTable.EmptyState>
      </DataTable>

      <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: 12 }}>
        Recommendations use the 90th percentile of usage over the last 7 days with a 10% buffer. Disk
        recommendations name the safe floor for the next resize - shrinking a live disk below its current
        used space isn&apos;t possible, so treat &quot;downsize candidate&quot; as directional, not actionable today.
      </Paragraph>
    </Flex>
  );
};
