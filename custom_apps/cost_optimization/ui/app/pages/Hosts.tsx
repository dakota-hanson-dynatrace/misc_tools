import React from 'react';
import { DataTable } from '@dynatrace/strato-components-preview/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { useNavigate, useLocation } from 'react-router-dom';
import { hostRawSeries, hostCapacity, hostDiskRawSeries } from '../lib/queries';
import { useCostOptQuery, num } from '../hooks/useCostOpt';
import { toTimeseries, seriesValues, cpuRecommendation, memRecommendation, diskRecommendation } from '../lib/hostSizing';
import { StatTiles } from '../components/StatTiles';
import { UsageCell } from '../components/UsageCell';

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

interface HostRow {
  id: string;
  name: string;
  cpuPct: number;
  memPct: number;
  diskPct: number;
}

export const Hosts = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const raw = useCostOptQuery<RawHostRecord>(hostRawSeries());
  const capacity = useCostOptQuery<CapacityRow>(hostCapacity());
  const disks = useCostOptQuery<RawDiskRecord>(hostDiskRawSeries());
  const isLoading = raw.isLoading || capacity.isLoading || disks.isLoading;

  const capacityById = React.useMemo(() => new Map(capacity.rows.map((c) => [c.id, c])), [capacity.rows]);

  // Every disk's own recommendation, independent of which host it belongs to -
  // "near capacity" is a per-disk fact, not something that should be diluted
  // by averaging with a host's other (possibly empty) disks.
  const diskRecs = React.useMemo(
    () =>
      disks.rows.map((d) => {
        const usedArr = seriesValues(toTimeseries(d, 'used', 'used'));
        const availArr = seriesValues(toTimeseries(d, 'avail', 'avail'));
        const totalBytes = (usedArr.at(-1) ?? 0) + (availArr.at(-1) ?? 0);
        return { hostId: d['dt.entity.host'], ...diskRecommendation(usedArr, totalBytes) };
      }),
    [disks.rows]
  );

  const rows: HostRow[] = React.useMemo(
    () =>
      raw.rows
        .map((r) => {
          const hostId = r['dt.entity.host'];
          const cap = capacityById.get(hostId);
          const cores = num(cap?.cores) || 1;
          const memBytes = num(cap?.memory);
          const cpuRec = cpuRecommendation(cores, seriesValues(toTimeseries(r, 'cpu', 'cpu')));
          const memRec = memRecommendation(memBytes, seriesValues(toTimeseries(r, 'mem', 'mem')));
          const worstDiskPct = Math.max(0, ...diskRecs.filter((d) => d.hostId === hostId).map((d) => d.usagePct));
          return { id: hostId, name: cap?.name ?? hostId, cpuPct: cpuRec.usagePct, memPct: memRec.usagePct, diskPct: worstDiskPct };
        })
        .sort((a, b) => b.cpuPct - a.cpuPct),
    [raw.rows, capacityById, diskRecs]
  );

  const cpuDownsizeCount = raw.rows.filter((r) => {
    const cap = capacityById.get(r['dt.entity.host']);
    return cpuRecommendation(num(cap?.cores) || 1, seriesValues(toTimeseries(r, 'cpu', 'cpu'))).status === 'downsize';
  }).length;
  const memDownsizeCount = raw.rows.filter((r) => {
    const cap = capacityById.get(r['dt.entity.host']);
    return memRecommendation(num(cap?.memory), seriesValues(toTimeseries(r, 'mem', 'mem'))).status === 'downsize';
  }).length;
  const disksNearCapacityCount = diskRecs.filter((d) => d.status === 'near-capacity').length;

  const avg = (key: keyof HostRow) => (rows.length ? rows.reduce((sum, r) => sum + Number(r[key]), 0) / rows.length : 0);

  const columns = React.useMemo(
    () => [
      { id: 'name', header: 'Host', accessor: 'name', width: 260 },
      {
        id: 'cpuPct',
        header: 'CPU (p90, 7d)',
        accessor: 'cpuPct',
        width: 140,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
      {
        id: 'memPct',
        header: 'Memory (p90, 7d)',
        accessor: 'memPct',
        width: 150,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
      {
        id: 'diskPct',
        header: 'Worst disk (p90, 7d)',
        accessor: 'diskPct',
        width: 160,
        cell: ({ value }: { value: unknown }) => <UsageCell value={Number(value)} />,
      },
    ],
    []
  );

  if (raw.error || capacity.error || disks.error) {
    const error = raw.error ?? capacity.error ?? disks.error;
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Heading level={2}>Could not load hosts</Heading>
        <Paragraph>{String(error?.message ?? error)}</Paragraph>
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
          { label: 'Avg CPU (p90)', value: `${avg('cpuPct').toFixed(1)}%` },
          { label: 'Avg memory (p90)', value: `${avg('memPct').toFixed(1)}%` },
          { label: 'CPU downsize candidates', value: cpuDownsizeCount },
          { label: 'Memory downsize candidates', value: memDownsizeCount },
          { label: 'Disks near capacity', value: disksNearCapacityCount },
        ]}
      />
      <DataTable
        data={rows}
        columns={columns}
        sortable
        fullWidth
        loading={isLoading}
        interactiveRows
        onActiveRowChange={(activeRow) => {
          if (activeRow === null) return;
          const id = rows[Number(activeRow)]?.id;
          if (id) navigate(`/host/${encodeURIComponent(id)}`, { state: { backgroundLocation: location } });
        }}
      >
        <DataTable.EmptyState>No hosts found in this environment.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
