import React from 'react';
import { functions } from '@dynatrace-sdk/app-utils';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Text, Code } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { useNavigate } from 'react-router-dom';

interface StepResult {
  name: string;
  status: 'ok' | 'created' | 'would_create' | 'updated' | 'would_update' | 'failed';
  detail?: string;
}
interface SetupResponse {
  ok: boolean;
  dryRun: boolean;
  steps: StepResult[];
  message?: string;
}

const STATUS_LABEL: Record<StepResult['status'], string> = {
  ok: 'Already set up',
  created: 'Created',
  would_create: 'Would create',
  updated: 'Updated',
  would_update: 'Would update',
  failed: 'Failed',
};

const STATUS_COLOR: Record<StepResult['status'], string> = {
  ok: Colors.Text.Neutral.Default,
  created: Colors.Text.Success.Default,
  would_create: Colors.Text.Neutral.Default,
  updated: Colors.Text.Success.Default,
  would_update: Colors.Text.Neutral.Default,
  failed: Colors.Text.Critical.Default,
};

async function callSetup(dryRun: boolean): Promise<SetupResponse> {
  const res = await functions.call('ncmSetup', { data: { dryRun } });
  return res.json();
}

export const Setup = () => {
  const navigate = useNavigate();
  const [preview, setPreview] = React.useState<SetupResponse | null>(null);
  const [result, setResult] = React.useState<SetupResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadPreview = React.useCallback(() => {
    setLoading(true);
    setError(null);
    callSetup(true)
      .then((r) => setPreview(r))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const runSetup = () => {
    setLoading(true);
    setError(null);
    setResult(null);
    callSetup(false)
      .then((r) => {
        setResult(r);
        return callSetup(true).then(setPreview);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };

  const shown = result ?? preview;
  // "Nothing left to do" only after we've actually seen a preview and every
  // step in it reports the steady state - never on the initial null render,
  // which would otherwise flash "all set" before the first check completes.
  const allSteadyState = !!preview && preview.steps.every((s) => s.status === 'ok');

  return (
    <Flex flexDirection="column" gap={16} padding={32} style={{ maxWidth: 1100 }}>
      <Heading level={1}>Initial Setup</Heading>
      <Paragraph>
        Creates the three dedicated Grail buckets (<Code>ncm_index</Code>, <Code>ncm_captures</Code>,{' '}
        <Code>ncm_versions</Code>) and wires OpenPipeline routing so captured configs land there instead of{' '}
        <Code>default_logs</Code>. Safe to run more than once - every step checks current state first and only
        changes what's missing.
      </Paragraph>

      {error && (
        <Surface padding={16}>
          <Heading level={3}>Could not check setup status</Heading>
          <Paragraph>
            <Code>{error}</Code>
          </Paragraph>
          <Paragraph>
            If this is a permissions error, it most likely means the app's own OAuth client hasn't been granted the{' '}
            <Code>storage:bucket-definitions:write</Code> IAM policy yet - that's a separate grant from the scope
            consent you already gave this app, and needs a tenant admin to bind it once.
          </Paragraph>
        </Surface>
      )}

      {allSteadyState && !result && (
        <Surface padding={16}>
          <Heading level={3}>Nothing to do</Heading>
          <Paragraph>Buckets and routing are already in place.</Paragraph>
        </Surface>
      )}

      {shown && shown.steps.length > 0 && (
        <Flex flexDirection="column" gap={8}>
          {shown.steps.map((s) => (
            <Flex key={s.name} justifyContent="space-between" alignItems="center" gap={12}
              style={{ padding: '8px 12px', border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 6 }}
            >
              <Text>{s.name}</Text>
              <Flex alignItems="center" gap={8}>
                {s.detail && <Text style={{ color: Colors.Text.Neutral.Subdued }}>{s.detail}</Text>}
                <Text style={{ color: STATUS_COLOR[s.status], fontWeight: 600 }}>{STATUS_LABEL[s.status]}</Text>
              </Flex>
            </Flex>
          ))}
        </Flex>
      )}

      {result?.message && (
        <Surface padding={16}>
          <Heading level={3}>Setup did not complete</Heading>
          <Paragraph>
            <Code>{result.message}</Code>
          </Paragraph>
        </Surface>
      )}

      <Flex gap={12}>
        <Button onClick={runSetup} disabled={loading} variant="accent">
          Run Initial Setup
        </Button>
        <Button onClick={loadPreview} disabled={loading}>
          Re-check status
        </Button>
      </Flex>

      <Flex alignItems="center" gap={8}>
        <Text>Extension version activation and device management live on the Manage tab.</Text>
        <Button onClick={() => navigate('/manage')}>Go to Manage</Button>
      </Flex>
    </Flex>
  );
};
