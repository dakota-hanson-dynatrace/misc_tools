import React from 'react';
import { DataTable } from '@dynatrace/strato-components/tables';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { useNavigate, useLocation } from 'react-router-dom';
import { changeFeed } from '../queries';
import { useNcmQuery, fmtTime, fmtBytes, VENDOR_LABEL } from '../hooks/useNcm';

interface Row {
  'ncm.device.id': string;
  name: string; site: string; vendor: string; hash: string; at: string; bytes: string;
}

export const Changes = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { rows, error, isLoading } = useNcmQuery<Row>(changeFeed(200));

  const columns = React.useMemo(() => [
    { id: 'at', header: 'Changed', accessor: 'at', width: 180,
      cell: ({ value }: { value: unknown }) => <>{fmtTime(value)}</> },
    { id: 'name', header: 'Device', accessor: 'name', width: 160 },
    { id: 'site', header: 'Site', accessor: 'site', width: 130 },
    { id: 'vendor', header: 'Vendor', accessor: 'vendor', width: 160,
      cell: ({ value }: { value: unknown }) => <>{VENDOR_LABEL[String(value)] ?? String(value)}</> },
    { id: 'bytes', header: 'Size', accessor: 'bytes', width: 100,
      cell: ({ value }: { value: unknown }) => <>{fmtBytes(value)}</> },
    // Attribution would join syslog here. Deliberately absent until that data
    // is known to exist - see the plan: it degrades to a dash, never an error.
  ], []);

  if (error) {
    return (
      <Flex flexDirection="column" gap={8} padding={32}>
        <Heading level={2}>Could not load changes</Heading>
        <Paragraph>{String(error.message ?? error)}</Paragraph>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Heading level={1}>Changes</Heading>
      <Paragraph>
        Every config version except each device&apos;s first. A device&apos;s earliest capture is
        its baseline, not a change.
      </Paragraph>
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
        <DataTable.EmptyState>No config changes recorded.</DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
