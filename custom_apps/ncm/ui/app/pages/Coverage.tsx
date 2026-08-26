import React from 'react';
import { DataTable } from '@dynatrace/strato-components/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { SingleValue } from '@dynatrace/strato-components-preview/charts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { useNavigate, useLocation } from 'react-router-dom';
import { monitoredDevices, monitoredAddresses, backupState } from '../queries';
import { useNcmQuery, fmtTime, VENDOR_LABEL } from '../hooks/useNcm';
import { QueryError } from '../components/QueryError';
import { CoverageDot } from '../components/CoverageDot';
import {
  computeCoverage, STATE_LABEL, FRESHNESS_WINDOW_HOURS,
  type MonitoredDevice, type MonitoredAddress, type BackupState, type CoverageState,
} from '../utils/coverage';

// Same fix as FleetSummary: Container is the tile level in the surface
// hierarchy (Base -> Surface -> Container), and SingleValue is the documented
// stat-tile component (dt-app-ui-design section 4) - this was the identical
// anti-pattern (a Surface wrapping hand-rolled Heading and Text) found and fixed there.
const Tile = ({ label, value, loading }: { label: string; value: number; loading: boolean }) => (
  <div
    style={{
      background: Colors.Background.Container.Neutral.Default,
      border: `1px solid ${Colors.Border.Neutral.Default}`,
      borderRadius: 8,
      padding: '12px 16px',
      minWidth: 150,
      height: 116,
    }}
  >
    <SingleValue label={label} data={value} loading={loading} />
  </div>
);

export const Coverage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const mon = useNcmQuery<MonitoredDevice>(monitoredDevices());
  const addr = useNcmQuery<MonitoredAddress>(monitoredAddresses());
  const back = useNcmQuery<BackupState>(backupState());

  const isLoading = mon.isLoading || addr.isLoading || back.isLoading;
  const error = mon.error ?? addr.error ?? back.error;

  const rows = React.useMemo(
    () =>
      isLoading || error
        ? []
        : computeCoverage({ monitored: mon.rows, addresses: addr.rows, backups: back.rows }),
    [mon.rows, addr.rows, back.rows, isLoading, error]
  );

  const count = (s: CoverageState) => rows.filter((r) => r.state === s).length;

  const columns = React.useMemo(
    () => [
      {
        id: 'state', header: 'Coverage', accessor: 'state', width: 170,
        cell: ({ value }: { value: unknown }) => <CoverageDot state={value as CoverageState} />,
      },
      { id: 'name', header: 'Device', accessor: 'name', width: 170 },
      {
        id: 'address', header: 'Address', accessor: 'monitoredAddress', width: 130,
        cell: ({ value, rowData }: { value: unknown; rowData?: { backupAddress?: string } }) => {
          const addr = typeof value === 'string' ? value : rowData?.backupAddress;
          return <>{addr ?? '-'}</>;
        },
      },
      { id: 'site', header: 'Site', accessor: 'site', width: 120 },
      {
        id: 'vendor', header: 'Vendor', accessor: 'vendor', width: 150,
        cell: ({ value }: { value: unknown }) => {
          const v = typeof value === 'string' ? value : '';
          return <>{v ? (VENDOR_LABEL[v] ?? v) : '-'}</>;
        },
      },
      {
        id: 'lastSuccess', header: 'Last good backup', accessor: 'lastSuccess', width: 180,
        cell: ({ value }: { value: unknown }) => <>{value ? fmtTime(value) : 'never'}</>,
      },
      {
        id: 'matchedBy', header: 'Matched by', accessor: 'matchedBy', width: 120,
        cell: ({ value }: { value: unknown }) => <>{value === 'none' ? '-' : String(value)}</>,
      },
      {
        id: 'notes', header: 'Notes', accessor: 'discrepancies', width: 380,
        cell: ({ value, rowData }: { value: unknown; rowData?: { reasons?: string[] } }) => {
          const d = Array.isArray(value) ? (value as string[]) : [];
          const r = rowData?.reasons ?? [];
          const all = [...r, ...d];
          return <>{all.length ? all.join(' · ') : '-'}</>;
        },
      },
    ],
    []
  );

  if (error) {
    return (
      <Flex flexDirection="column" gap={16} padding={32}>
        <Heading level={1}>Backup coverage</Heading>
        <QueryError what="coverage data" error={error} />
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Backup coverage</Heading>
      <Paragraph>
        Network devices Dynatrace already monitors via SNMP, matched against what is actually
        being backed up. A device is considered current if it has a successful capture within{' '}
        {FRESHNESS_WINDOW_HOURS} hours.
      </Paragraph>

      <Flex gap={12} flexWrap="wrap">
        <Tile label={STATE_LABEL.never} value={count('never')} loading={isLoading} />
        <Tile label={STATE_LABEL.failing} value={count('failing')} loading={isLoading} />
        <Tile label={STATE_LABEL.stale} value={count('stale')} loading={isLoading} />
        <Tile label={STATE_LABEL.covered} value={count('covered')} loading={isLoading} />
        <Tile label={STATE_LABEL.unmonitored} value={count('unmonitored')} loading={isLoading} />
        <Tile label={STATE_LABEL.ambiguous} value={count('ambiguous')} loading={isLoading} />
      </Flex>

      <Paragraph>
        Matching uses the polled address where one is reported and the device name otherwise.
        Neither key is authoritative on its own, so disagreements between them are listed in
        Notes rather than hidden - an address or name split is usually a real inventory
        discrepancy worth fixing.
      </Paragraph>

      <DataTable data={rows} columns={columns} sortable fullWidth loading={isLoading} interactiveRows
        onActiveRowChange={(activeRow) => {
          if (activeRow === null) return;
          const id = rows[Number(activeRow)]?.deviceId;
          if (id) navigate(`/device/${encodeURIComponent(id)}`, { state: { backgroundLocation: location } });
        }}
      >
        <DataTable.EmptyState>
          No SNMP-monitored network devices found, and nothing backed up yet.
        </DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
