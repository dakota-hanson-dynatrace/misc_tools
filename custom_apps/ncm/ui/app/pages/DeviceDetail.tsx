import React from 'react';
import { useParams, useNavigate, useLocation, type Location } from 'react-router-dom';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { DataTable } from '@dynatrace/strato-components/tables';
import { CodeEditor } from '@dynatrace/strato-components/editors';
import { versionPeriods, versionCaptureIds, deviceStatus } from '../queries';
import { useNcmQuery, fmtTime, fmtBytes, num, STATUS_LABEL, VENDOR_LABEL } from '../hooks/useNcm';
import { QueryError } from '../components/QueryError';
import { useConfig } from '../hooks/useConfig';

interface Period {
  'ncm.device.id': string; 'ncm.config.hash': string;
  firstSeen: string; lastSeen: string; captures: string;
  name: string; site: string; vendor: string; bytes: string;
}
interface VersionRow {
  'ncm.capture.id': string; captureTime: string; hash: string; bytes: string; chunks: string;
}
interface StatusRow {
  name: string; site: string; vendor: string; role: string;
  lastAttempt: string; attempts: string; failures: string;
  statuses: string[]; lastSuccess: string | null;
}

export const DeviceDetail = () => {
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { rows: periods, isLoading, error } = useNcmQuery<Period>(versionPeriods(deviceId));
  const { rows: versions } = useNcmQuery<VersionRow>(versionCaptureIds(deviceId));
  // Identity comes from deviceStatus, NOT versionPeriods: the latter filters to
  // successful captures, so a device that has never captured cleanly would
  // otherwise render with no name, no vendor and no failure reason.
  const { rows: statusRows } = useNcmQuery<StatusRow>(deviceStatus(deviceId));
  const status = statusRows[0];
  const [selected, setSelected] = React.useState<string | undefined>();

  const captureId = selected ?? versions[0]?.['ncm.capture.id'];
  const { content, problem, isLoading: cfgLoading } = useConfig(captureId);


  const columns = React.useMemo(() => [
    { id: 'firstSeen', header: 'In effect from', accessor: 'firstSeen', width: 180,
      cell: ({ value }: { value: unknown }) => <>{fmtTime(value)}</> },
    { id: 'lastSeen', header: 'Until', accessor: 'lastSeen', width: 180,
      cell: ({ value }: { value: unknown }) => <>{fmtTime(value)}</> },
    { id: 'captures', header: 'Captures', accessor: 'captures', width: 100,
      cell: ({ value }: { value: unknown }) => <>{num(value)}</> },
    { id: 'bytes', header: 'Size', accessor: 'bytes', width: 100,
      cell: ({ value }: { value: unknown }) => <>{fmtBytes(value)}</> },
    // Bracket form is required: Strato splits a dotted accessor into a deep
    // object path (row.ncm.config.hash), which is undefined for a flat row with
    // a literal dotted key. Renders blank otherwise - and type-checks clean.
    { id: 'hash', header: 'Config hash', accessor: '["ncm.config.hash"]', width: 240 },
  ], []);

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex alignItems="center" gap={12}>
        <Button onClick={() => navigate(-1)}>&larr; Back</Button>
        <Heading level={1}>{status?.name ?? deviceId}</Heading>
      </Flex>
      {status && (
        <Text>
          {status.site} &middot; {VENDOR_LABEL[status.vendor] ?? status.vendor} &middot;{' '}
          {periods.length} version{periods.length === 1 ? '' : 's'}
        </Text>
      )}

      {/* A device with failures needs its reason stated here, not inferred from
          an empty version table. These are the devices operators click first. */}
      {status && num(status.failures) > 0 && (
        <Surface padding={16}>
          <Heading level={3}>
            {num(status.failures)} of {num(status.attempts)} captures failed
          </Heading>
          <Paragraph>
            {(Array.isArray(status.statuses) ? status.statuses : [])
              .filter((x) => x !== 'ok')
              .map((x) => STATUS_LABEL[String(x)] ?? String(x))
              .join(', ') || 'Unknown reason'}
          </Paragraph>
          <Paragraph>
            {status.lastSuccess
              ? `Last successful capture ${fmtTime(status.lastSuccess)}.`
              : 'This device has never been captured successfully - it is not backed up.'}
          </Paragraph>
        </Surface>
      )}

      {error && <QueryError what="version history" error={error} />}

      <Heading level={2}>Version history</Heading>
      <DataTable data={periods} columns={columns} sortable fullWidth loading={isLoading}>
        <DataTable.EmptyState>No successful captures for this device.</DataTable.EmptyState>
      </DataTable>

      <Flex alignItems="center" gap={12} flexWrap="wrap">
        <Heading level={2}>Stored config</Heading>
        {versions.length > 1 && (
          <Button
            onClick={() =>
              navigate(`/diff/${encodeURIComponent(deviceId)}`, {
                state: {
                  backgroundLocation:
                    (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ?? location,
                },
              })
            }
          >
            Compare versions
          </Button>
        )}
      </Flex>

      <Flex gap={8} flexWrap="wrap">
        {versions.map((v) => (
          <Button
            key={v['ncm.capture.id']}
            variant={v['ncm.capture.id'] === captureId ? 'accent' : 'default'}
            onClick={() => setSelected(v['ncm.capture.id'])}
          >
            {fmtTime(v.captureTime)}
            {num(v.chunks) > 1 ? ` (${num(v.chunks)} chunks)` : ''}
          </Button>
        ))}
      </Flex>

      {problem ? (
        // Never render a config that failed integrity checks - a truncated
        // config would read as a change that never happened.
        <Surface padding={16}>
          <Heading level={3}>This version could not be verified</Heading>
          <Paragraph>
            <Code>{problem}</Code>
          </Paragraph>
          <Paragraph>
            The stored record is incomplete, so it is not being displayed. Re-capture the device.
          </Paragraph>
        </Surface>
      ) : cfgLoading ? (
        <Text>Loading config...</Text>
      ) : content ? (
        // CodeEditor's language union has no shell/plaintext option. 'other'
        // disables highlighting, which is right for multi-vendor config text
        // that no single grammar matches anyway.
        <CodeEditor value={content} language="other" readOnly />
      ) : (
        <Text>No stored config for this capture.</Text>
      )}
    </Flex>
  );
};
