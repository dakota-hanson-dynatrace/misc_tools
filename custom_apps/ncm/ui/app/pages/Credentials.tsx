import React from 'react';
import { functions } from '@dynatrace-sdk/app-utils';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';

// Bulk Credential Provisioning - deliberately its own page, not a section of
// Manage, so this exception to "the app never sees a device credential" stays
// visible rather than buried. See api/ncmCredentials.function.ts for the full
// reasoning and the structural guarantees (never logged, never persisted,
// never echoed back).

interface CreateRow { alias: string; username: string; password: string }
interface RotateRow { credentialVaultId: string; username: string; password: string }
interface RowResult {
  alias?: string;
  credentialVaultId?: string;
  status: 'created' | 'rotated' | 'failed';
  detail?: string;
}
interface CredentialsResponse {
  ok: boolean;
  message?: string;
  results?: RowResult[];
  remainingRows?: (CreateRow | RotateRow)[];
}

type Mode = 'create' | 'rotate';

/** alias,username,password  OR  credentialVaultId,username,password - same shape either way. */
function parseCsv(text: string): { col1: string; username: string; password: string }[] {
  const rows: { col1: string; username: string; password: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 3) throw new Error(`malformed row (expected 3 columns): "${parts[0]}"`);
    const [col1, username, ...rest] = parts;
    rows.push({ col1: col1.trim(), username: username.trim(), password: rest.join(',') });
  }
  return rows;
}

async function callCredentials(action: string, rows: unknown[]): Promise<CredentialsResponse> {
  const res = await functions.call('ncmCredentials', { data: { action, rows } });
  return (await res.json()) as CredentialsResponse;
}

export const Credentials = () => {
  const [mode, setMode] = React.useState<Mode>('create');
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [rowCount, setRowCount] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const [results, setResults] = React.useState<RowResult[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Rows contain plaintext passwords for the duration of the upload only -
  // kept in a ref, never React state, so they never sit in a re-rendered
  // component tree (or DevTools) any longer than the single run that needs
  // them, and are dropped (set to null) the instant that run ends.
  const pendingRows = React.useRef<(CreateRow | RotateRow)[] | null>(null);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // don't let the browser retain the file reference in the input either
    if (!file) return;
    setError(null);
    setResults([]);
    file.text().then((text) => {
      try {
        const parsed = parseCsv(text);
        pendingRows.current =
          mode === 'create'
            ? parsed.map((r) => ({ alias: r.col1, username: r.username, password: r.password }))
            : parsed.map((r) => ({ credentialVaultId: r.col1, username: r.username, password: r.password }));
        setFileName(file.name);
        setRowCount(parsed.length);
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      }
    }).catch((err: unknown) => setError(String((err as Error)?.message ?? err)));
  };

  const run = async () => {
    if (!pendingRows.current || pendingRows.current.length === 0) return;
    setRunning(true);
    setError(null);
    const allResults: RowResult[] = [];
    try {
      let rows = pendingRows.current;
      while (rows.length > 0) {
        const r = await callCredentials(mode === 'create' ? 'bulkCreate' : 'bulkRotate', rows);
        if (!r.ok) throw new Error(r.message ?? 'request failed');
        allResults.push(...(r.results ?? []));
        setResults([...allResults]);
        rows = r.remainingRows ?? [];
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      // Drop the plaintext the moment the run is over, success or failure.
      pendingRows.current = null;
      setFileName(null);
      setRowCount(0);
      setRunning(false);
    }
  };

  const created = results.filter((r) => r.status === 'created' || r.status === 'rotated').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return (
    <Flex flexDirection="column" gap={16} padding={32} style={{ maxWidth: 1000 }}>
      <Heading level={1}>Bulk Credentials</Heading>

      <Surface padding={16}>
        <Heading level={3}>This page is a deliberate exception</Heading>
        <Paragraph>
          Every other credential path in this app - device management on the Manage tab, the collector itself -
          is built so the app structurally cannot see a device password. This page is the one place that isn't
          true: bulk-provisioning hundreds or thousands of unique device credentials has no other practical path
          that doesn't require every admin to have CLI/<Code>dtctl</Code> access. Use it deliberately, not
          routinely. Nothing uploaded here is logged or stored - each row is sent straight to the Credential
          Vault and discarded.
        </Paragraph>
      </Surface>

      <Flex gap={8}>
        <Button variant={mode === 'create' ? 'accent' : 'default'} onClick={() => { setMode('create'); pendingRows.current = null; setFileName(null); setRowCount(0); setResults([]); }}>
          Create new entries
        </Button>
        <Button variant={mode === 'rotate' ? 'accent' : 'default'} onClick={() => { setMode('rotate'); pendingRows.current = null; setFileName(null); setRowCount(0); setResults([]); }}>
          Rotate existing entries
        </Button>
      </Flex>

      {mode === 'create' ? (
        <Paragraph>
          CSV, no header: <Code>alias,username,password</Code> - one new Credential Vault entry per row. Copy
          each resulting <Code>credentialVaultId</Code> into that device's entry on the Manage tab (credential
          source: "This device's own vault entry").
        </Paragraph>
      ) : (
        <Paragraph>
          CSV, no header: <Code>credentialVaultId,username,password</Code> - updates each entry&apos;s password
          IN PLACE. No device or monitoring configuration needs to change; every device already referencing
          that vault entry picks up the new password on its next capture.
        </Paragraph>
      )}

      <Flex alignItems="center" gap={12}>
        <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={running} />
        {fileName && <Text>{fileName} - {rowCount} row(s)</Text>}
      </Flex>

      <Flex gap={12}>
        <Button onClick={() => void run()} disabled={!rowCount || running} variant="accent">
          {running ? 'Running...' : mode === 'create' ? 'Create entries' : 'Rotate entries'}
        </Button>
      </Flex>

      {error && (
        <Surface padding={16}>
          <Heading level={3}>Error</Heading>
          <Paragraph><Code>{error}</Code></Paragraph>
        </Surface>
      )}

      {results.length > 0 && (
        <Flex flexDirection="column" gap={8}>
          <Text style={{ fontWeight: 600 }}>{created} succeeded, {failed} failed</Text>
          <Flex flexDirection="column" gap={4}>
            {results.map((r, i) => (
              <Flex key={i} justifyContent="space-between" gap={12}
                style={{ padding: '6px 10px', border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 4 }}
              >
                <Text>{r.alias ?? r.credentialVaultId}</Text>
                <Flex gap={8}>
                  {r.status !== 'failed' && r.credentialVaultId && mode === 'create' && (
                    <Code>{r.credentialVaultId}</Code>
                  )}
                  {r.detail && <Text style={{ color: Colors.Text.Neutral.Subdued }}>{r.detail}</Text>}
                  <Text style={{ color: r.status === 'failed' ? Colors.Text.Critical.Default : Colors.Text.Success.Default, fontWeight: 600 }}>
                    {r.status}
                  </Text>
                </Flex>
              </Flex>
            ))}
          </Flex>
        </Flex>
      )}
    </Flex>
  );
};
