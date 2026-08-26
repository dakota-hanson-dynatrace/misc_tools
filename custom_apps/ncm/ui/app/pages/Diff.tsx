import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { Select } from '@dynatrace/strato-components/forms';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { versionCaptureIds } from '../queries';
import { useNcmQuery, fmtTime } from '../hooks/useNcm';
import { useConfig } from '../hooks/useConfig';
import { QueryError } from '../components/QueryError';
import { diffLines } from '../utils/diff';

interface VersionRow {
  'ncm.capture.id': string; captureTime: string; hash: string; bytes: string; chunks: string;
}

export const Diff = () => {
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const { rows: versions, isLoading, error } = useNcmQuery<VersionRow>(versionCaptureIds(deviceId));

  // Default to the two most recent versions - the comparison people actually want.
  const [rightId, setRightId] = React.useState<string | undefined>();
  const [leftId, setLeftId] = React.useState<string | undefined>();
  const right = rightId ?? versions[0]?.['ncm.capture.id'];
  const left = leftId ?? versions[1]?.['ncm.capture.id'];

  const a = useConfig(left);
  const b = useConfig(right);

  const blocked = a.problem ?? b.problem;
  const rows = React.useMemo(
    () => (blocked || a.isLoading || b.isLoading ? [] : diffLines(a.content, b.content)),
    [a.content, b.content, a.isLoading, b.isLoading, blocked]
  );

  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'del').length;

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex alignItems="center" gap={12}>
        <Button onClick={() => navigate(-1)}>&larr; Device</Button>
        <Heading level={1}>Compare versions</Heading>
      </Flex>

      {error ? (
        <QueryError what="versions" error={error} />
      ) : isLoading ? (
        <Text>Loading versions...</Text>
      ) : versions.length < 2 ? (
        <Paragraph>This device has only one stored version, so there is nothing to compare.</Paragraph>
      ) : (
        <>
          <Flex gap={16} flexWrap="wrap" alignItems="center">
            <Flex flexDirection="column" gap={4}>
              <Text>From (older)</Text>
              {/* Options MUST be wrapped in Select.Content. SelectOption is
                  declared `(props) => null` - a descriptor consumed by the
                  parent, not a renderer - so as a direct child it silently
                  produces an empty dropdown that type-checks clean. */}
              <Select value={left ?? null} onChange={(v) => setLeftId(v ?? undefined)}>
                <Select.Content>
                  {versions.map((v) => (
                    <Select.Option key={v['ncm.capture.id']} value={v['ncm.capture.id']}>
                      {fmtTime(v.captureTime)}
                    </Select.Option>
                  ))}
                </Select.Content>
              </Select>
            </Flex>
            <Flex flexDirection="column" gap={4}>
              <Text>To (newer)</Text>
              <Select value={right ?? null} onChange={(v) => setRightId(v ?? undefined)}>
                <Select.Content>
                  {versions.map((v) => (
                    <Select.Option key={v['ncm.capture.id']} value={v['ncm.capture.id']}>
                      {fmtTime(v.captureTime)}
                    </Select.Option>
                  ))}
                </Select.Content>
              </Select>
            </Flex>
            <Text>
              +{added} / -{removed}
            </Text>
          </Flex>

          {blocked ? (
            <Surface padding={16}>
              <Heading level={3}>Cannot diff these versions</Heading>
              <Paragraph>
                <Code>{blocked}</Code>
              </Paragraph>
              <Paragraph>
                One of the stored records failed its integrity check, so diffing it would show
                changes that never happened.
              </Paragraph>
            </Surface>
          ) : (
            <Surface padding={0}>
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  overflowX: 'auto',
                  fontFamily: 'monospace',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                {rows.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background:
                        r.kind === 'add'
                          ? Colors.Background.Field.Success.Emphasized
                          : r.kind === 'del'
                            ? Colors.Background.Field.Critical.Emphasized
                            : 'transparent',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '} {r.text}
                  </div>
                ))}
              </pre>
            </Surface>
          )}
        </>
      )}
    </Flex>
  );
};
