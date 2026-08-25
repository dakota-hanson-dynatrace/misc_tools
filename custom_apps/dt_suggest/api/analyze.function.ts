import { queryExecutionClient } from '@dynatrace-sdk/client-query';
import { stateClient } from '@dynatrace-sdk/client-state';
import { httpClient } from '@dynatrace-sdk/http-client';
import {
  buildPrompt,
  parseIssues,
  mergeWithPrior,
  EMPTY_FINDINGS,
  FORMAT_INSTRUCTION,
  type Cluster,
  type Findings,
} from '../lib/pipeline';

export const STATE_KEY = 'findings';

const DEFAULT_LOOKBACK_HOURS = 6;
const MAX_CLUSTERS = 40;

/**
 * Chronic-defect clusters: root-cause exceptions on failed spans, grouped so that
 * one row is one (exception type, message, service, endpoint) combination.
 *
 * Grouping is deliberately DQL's job, not the model's - Dynatrace already knows what
 * "failed" means via dt.failure_detection, so the model only has to merge near-duplicates.
 */
const clusterQuery = (hours: number) => `
fetch spans, from: now()-${hours}h
| filter request.is_failed == true and span.is_exit_by_exception == true
| expand span.events
| filter span.events[span_event.name] == "exception"
      and span.events[exception.is_caused_by_root] == true
| summarize occurrences = count(),
            traceIds = collectDistinct(trace.id, maxLength: 3),
            stack = takeFirst(span.events[exception.stack_trace]),
    by:{exceptionType = span.events[exception.type],
        message      = span.events[exception.message],
        service      = dt.service.name,
        serviceId    = dt.entity.service,
        endpoint     = endpoint.name}
| sort occurrences desc
| limit ${MAX_CLUSTERS}
| fieldsAdd stack = substring(stack, from: 0, to: 400)`;

async function fetchClusters(hours: number): Promise<Cluster[]> {
  const start = await queryExecutionClient.queryExecute({
    body: { query: clusterQuery(hours), requestTimeoutMilliseconds: 60_000 },
  });

  // The poll token only ever comes from queryExecute - QueryPollResponse has no
  // requestToken, so re-reading it from the poll response stops polling after one round.
  let response = start;
  if (start.state === 'RUNNING' && start.requestToken) {
    const requestToken = start.requestToken;
    do {
      response = await queryExecutionClient.queryPoll({ requestToken });
    } while (response.state === 'RUNNING');
  }

  const records = response.result?.records ?? [];
  if (records.length === 0) {
    // A missing storage:buckets:read scope returns SUCCEEDED with zero records and
    // zero scanned bytes - the only trace of it is this warning.
    const warning = response.result?.metadata?.grail?.notifications?.find((n) => n.severity === 'WARNING');
    if (warning) throw new Error(`Grail returned no data: ${warning.message}`);
  }

  // Grail leaves any of these null when the dimension is absent on a span, so each
  // one is coerced explicitly rather than relying on String() over an unknown.
  const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

  return records.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      exceptionType: text(row.exceptionType, 'unknown'),
      message: text(row.message),
      service: text(row.service),
      serviceId: text(row.serviceId),
      endpoint: text(row.endpoint),
      occurrences: Number(row.occurrences ?? 0),
      traceIds: Array.isArray(row.traceIds) ? row.traceIds.map((id) => text(id)).filter(Boolean) : [],
      stack: text(row.stack),
    };
  });
}

/**
 * One batched call for all clusters, not one per issue: the conversation skill takes
 * 6-15s per round trip and app functions are not generous with wall time.
 */
async function askCopilot(prompt: string): Promise<string> {
  const response = await httpClient.send({
    url: '/platform/davis/copilot/v1/skills/conversations:message',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: {
      text: prompt,
      context: [
        // Dynatrace doc retrieval adds latency and nothing useful for source-level fixes.
        { type: 'document-retrieval', value: 'disabled' },
        { type: 'instruction', value: FORMAT_INSTRUCTION },
      ],
    },
  });

  const payload = (await response.body('json')) as { text?: string };
  if (!payload?.text) throw new Error('Dynatrace Intelligence returned an empty response');
  return payload.text;
}

async function readPrior(): Promise<Findings> {
  try {
    const state = await stateClient.getAppState({ key: STATE_KEY });
    return { ...EMPTY_FINDINGS, ...(JSON.parse(state.value) as Findings) };
  } catch {
    // No state yet on the first run, or an unreadable blob we are about to replace.
    return EMPTY_FINDINGS;
  }
}

/**
 * Failures are returned, never thrown. An uncaught throw surfaces as a bare
 * "Execution crashed" with the message and console logs stripped, which is useless
 * both in the app UI and in the workflow execution log.
 */
export default async function (payload: { lookbackHours?: number } = {}) {
  try {
    return { ok: true as const, ...(await analyze(payload?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS)) };
  } catch (error) {
    const e = error as { name?: string; message?: string; stack?: string };
    return {
      ok: false as const,
      error: `${e?.name ?? 'Error'}: ${e?.message ?? String(error)}`,
      stack: e?.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
}

async function analyze(lookbackHours: number) {
  const clusters = await fetchClusters(lookbackHours);
  const prior = await readPrior();

  if (clusters.length === 0) {
    const findings: Findings = { ...prior, lastRun: new Date().toISOString(), lookbackHours, issues: [] };
    await stateClient.setAppState({ key: STATE_KEY, body: { value: JSON.stringify(findings) } });
    return { clusters: 0, issues: 0, lastRun: findings.lastRun };
  }

  // buildPrompt may drop the lowest-volume clusters to fit the prompt cap; only the
  // clusters it kept are addressable by index in the response.
  const { prompt, included } = buildPrompt(clusters, prior.issues.map((i) => i.title), lookbackHours);
  const candidates = parseIssues(await askCopilot(prompt), included);
  const findings = mergeWithPrior(candidates, prior, new Date().toISOString(), lookbackHours);

  await stateClient.setAppState({ key: STATE_KEY, body: { value: JSON.stringify(findings) } });

  return {
    clusters: clusters.length,
    analyzed: included.length,
    issues: findings.issues.length,
    new: findings.issues.filter((i) => i.status === 'new').length,
    lastRun: findings.lastRun,
  };
}
