import React from 'react';
import { DataTable } from '@dynatrace/strato-components/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { useNavigate, useLocation } from 'react-router-dom';
import { backupFailures } from '../queries';
import { useNcmQuery, fmtTime, num, STATUS_LABEL, VENDOR_LABEL } from '../hooks/useNcm';
import { QueryError } from '../components/QueryError';

interface Row {
  'ncm.device.id': string; name: string; site: string; vendor: string;
  statuses: string[]; failures: string; total: string; failureRate: string; lastCapture: string;
}

export const Failures = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { rows, isLoading, error } = useNcmQuery<Row>(backupFailures());

  const columns = React.useMemo(() => [
    { id: 'name', header: 'Device', accessor: 'name', width: 160 },
    { id: 'site', header: 'Site', accessor: 'site', width: 130 },
    { id: 'vendor', header: 'Vendor', accessor: 'vendor', width: 160,
      cell: ({ value }: { value: unknown }) => <>{VENDOR_LABEL[String(value)] ?? String(value)}</> },
    { id: 'statuses', header: 'Reason', accessor: 'statuses', width: 200,
      cell: ({ value }: { value: unknown }) => {
        const list = Array.isArray(value) ? value : [];
        const bad = list.filter((s) => s !== 'ok').map((s) => STATUS_LABEL[String(s)] ?? String(s));
        return <>{bad.join(', ') || '-'}</>;
      } },
    { id: 'failures', header: 'Failed', accessor: 'failures', width: 90,
      cell: ({ value }: { value: unknown }) => <>{num(value)}</> },
    { id: 'failureRate', header: 'Failure rate', accessor: 'failureRate', width: 120,
      cell: ({ value }: { value: unknown }) => <>{num(value)}%</> },
    { id: 'lastCapture', header: 'Last attempt', accessor: 'lastCapture', width: 180,
      cell: ({ value }: { value: unknown }) => <>{fmtTime(value)}</> },
  ], []);

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Backup failures</Heading>
      <Paragraph>
        Devices with at least one failed capture. A device failing every night is not backed up
        at all, however healthy the rest of the fleet looks.
      </Paragraph>
      {error && <QueryError what="backup failures" error={error} />}
      <DataTable
        data={rows}
        columns={columns}
        sortable
        fullWidth
        loading={isLoading}
        interactiveRows
        onActiveRowChange={(activeRow) => {
          if (activeRow === null) return;
          const id = rows[Number(activeRow)]?.['ncm.device.id'];
          if (id) navigate(`/device/${encodeURIComponent(id)}`, { state: { backgroundLocation: location } });
        }}
      >
        <DataTable.EmptyState>Every device captured successfully.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
