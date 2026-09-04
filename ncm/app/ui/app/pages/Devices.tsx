import React from 'react';
import { DataTable } from '@dynatrace/strato-components/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { useNavigate, useLocation } from 'react-router-dom';
import { deviceInventory } from '../queries';
import { useNcmQuery, fmtTime, num, VENDOR_LABEL } from '../hooks/useNcm';
import { FleetSummary } from '../components/FleetSummary';
import { StatusDot } from '../components/StatusDot';

interface Row {
  'ncm.device.id': string;
  name: string;
  site: string;
  vendor: string;
  role: string;
  lastCapture: string;
  captures: string;
  versions: string;
  failures: string;
  healthy: boolean;
}

export const Devices = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { rows, error, isLoading } = useNcmQuery<Row>(deviceInventory());

  const columns = React.useMemo(
    () => [
      {
        id: 'health',
        header: 'Status',
        accessor: 'healthy',
        width: 90,
        cell: ({ value }: { value: unknown }) => <StatusDot ok={value === true} />,
      },
      { id: 'name', header: 'Device', accessor: 'name', width: 160 },
      { id: 'site', header: 'Site', accessor: 'site', width: 130 },
      {
        id: 'vendor',
        header: 'Vendor',
        accessor: 'vendor',
        width: 160,
        cell: ({ value }: { value: unknown }) => <>{VENDOR_LABEL[String(value)] ?? String(value)}</>,
      },
      { id: 'role', header: 'Role', accessor: 'role', width: 180 },
      {
        id: 'versions',
        header: 'Versions',
        accessor: 'versions',
        width: 90,
        alignment: 'center' as const,
        cell: ({ value }: { value: unknown }) => <>{num(value)}</>,
      },
      {
        id: 'failures',
        header: 'Failed captures',
        accessor: 'failures',
        width: 130,
        alignment: 'center' as const,
        cell: ({ value }: { value: unknown }) => <>{num(value) || '-'}</>,
      },
      {
        id: 'lastCapture',
        header: 'Last capture',
        accessor: 'lastCapture',
        width: 180,
        cell: ({ value }: { value: unknown }) => <>{fmtTime(value)}</>,
      },
    ],
    []
  );

  if (error) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Heading level={2}>Could not load devices</Heading>
        <Paragraph>{String(error.message ?? error)}</Paragraph>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Devices</Heading>
      <FleetSummary />
      <DataTable
        data={rows}
        columns={columns}
        sortable
        fullWidth
        loading={isLoading}
        interactiveRows
        // onActiveRowChange yields a row ID, which with default row
        // identification is the array index as a string - not the device id.
        onActiveRowChange={(activeRow) => {
          if (activeRow === null) return;
          const id = rows[Number(activeRow)]?.['ncm.device.id'];
          if (id) navigate(`/device/${encodeURIComponent(id)}`, { state: { backgroundLocation: location } });
        }}
      >
        <DataTable.EmptyState>No devices found. Seed data or configure a collector.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
