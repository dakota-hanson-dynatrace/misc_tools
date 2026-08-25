/**
 * Pure logic for the dt_suggest analysis pipeline: prompt construction,
 * LLM response parsing, and run-to-run issue diffing.
 *
 * Kept free of platform SDK calls so `check.ts` can exercise it directly.
 */

/** One (exception type, message, service, endpoint) group returned by the cluster DQL. */
export type Cluster = {
  exceptionType: string;
  message: string;
  service: string;
  serviceId: string;
  endpoint: string;
  occurrences: number;
  traceIds: string[];
  stack: string;
};

export type IssueStatus = 'new' | 'recurring' | 'dismissed';

export type Issue = {
  /** Stable across runs: the set of exceptionType@serviceId pairs the issue covers. */
  key: string;
  title: string;
  impact: string;
  cause: string;
  fix: string;
  rank: number;
  occurrences: number;
  services: string[];
  endpoints: string[];
  exampleTraceIds: string[];
  firstSeen: string;
  lastSeen: string;
  status: IssueStatus;
};

export type Findings = {
  lastRun: string;
  lookbackHours: number;
  issues: Issue[];
  dismissedKeys: string[];
};

export const EMPTY_FINDINGS: Findings = {
  lastRun: '',
  lookbackHours: 0,
  issues: [],
  dismissedKeys: [],
};

/**
 * The conversation skill rejects a `text` longer than 10000 characters with
 * "Constraints violated", so the prompt is budgeted rather than assembled and hoped for.
 */
export const MAX_PROMPT_CHARS = 9600;

/**
 * Output format lives in the `instruction` context item, not in the prompt text.
 * Asking for "JSON only, no prose" inside the question itself trips the skill's
 * guardrail, which answers "this doesn't seem to be a valid question" and returns
 * nothing usable. As an instruction it is honoured.
 */
export const FORMAT_INSTRUCTION =
  'Respond with JSON only, no prose and no markdown fences, in exactly this shape: ' +
  '{"issues":[{"title":"short imperative summary",' +
  '"impact":"which services and endpoints are affected and how",' +
  '"cause":"the likely root cause","fix":"a concrete actionable fix","clusters":[0,3]}]}. ' +
  '"clusters" lists the data indices the issue covers; every index appears in exactly one issue. ' +
  'Never state occurrence counts in your text.';

/** Detail levels tried in order, richest first. */
const STACK_FRAME_LEVELS = [8, 3, 1, 0];
const MAX_MESSAGE_CHARS = 240;

function clamp(value: string, max: number): string {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function renderCluster(cluster: Cluster, index: number, stackFrames: number): string {
  const parts = [
    `[${index}] ${cluster.exceptionType}`,
    `msg: ${clamp(cluster.message, MAX_MESSAGE_CHARS) || '(none)'}`,
    `service: ${cluster.service || cluster.serviceId}`,
    `endpoint: ${cluster.endpoint || '(none)'}`,
    `occurrences: ${cluster.occurrences}`,
  ];
  const frames = (cluster.stack ?? '').split('\n').filter(Boolean).slice(0, stackFrames);
  if (frames.length) parts.push(`top frames:\n${frames.join('\n')}`);
  return parts.join(' | ');
}

/**
 * The prompt shape was validated by hand against a live tenant: it correctly merged
 * 3 AxisFault endpoints into one issue and 8 SocketTimeout endpoints into another.
 *
 * Two things matter here and are load-bearing:
 *  - The framing is observability analysis. The conversation skill is guardrailed to
 *    Dynatrace topics and refuses bare instructions ("say ok").
 *  - The model returns cluster *indices*, never counts. Every number in the UI is
 *    derived from the DQL result, so the model cannot fabricate volume.
 */
export function buildPrompt(
  clusters: Cluster[],
  priorTitles: string[],
  lookbackHours: number,
): { prompt: string; included: Cluster[] } {
  const known = priorTitles.length
    ? `\nIssues already reported in earlier runs (reuse the same wording where it is the same issue):\n${priorTitles
        .map((t) => `- ${t}`)
        .join('\n')}\n`
    : '';

  const header = `You are analyzing recurring failure patterns in Dynatrace distributed trace data.

Below are root-cause exceptions aggregated from failed spans over the last ${lookbackHours} hours in this environment. Davis has NOT raised a problem for these, because they are steady-state rather than anomalous - they are chronic defects hiding in the baseline.

Group the numbered clusters below into distinct underlying issues. Merge near-duplicate endpoints and messages into ONE issue (for example, the same exception across several endpoints of one service, or messages that differ only by an id or a key value). Rank the issues by severity, considering how often they occur, how damaging each occurrence is, and how far the failure can spread.
${known}
Do not invent services, endpoints, or causes that the data below does not support.

DATA:
`;

  // Clusters arrive sorted by volume, so shedding from the tail sheds the least
  // important evidence. Stack frames go before whole clusters do - the model leans on
  // exception type, message, and endpoint far more than on the frames.
  const budget = MAX_PROMPT_CHARS - header.length;
  let best: { entries: string[]; included: Cluster[] } = { entries: [], included: [] };

  for (const stackFrames of STACK_FRAME_LEVELS) {
    const entries: string[] = [];
    const included: Cluster[] = [];
    let used = 0;
    for (const cluster of clusters) {
      const entry = renderCluster(cluster, included.length, stackFrames);
      if (used + entry.length + 2 > budget) break;
      entries.push(entry);
      included.push(cluster);
      used += entry.length + 2;
    }
    if (included.length > best.included.length) best = { entries, included };
    if (included.length === clusters.length) break;
  }

  return { prompt: header + best.entries.join('\n\n'), included: best.included };
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))];
}

/**
 * Parses the model response and rebuilds every quantitative field from `clusters`.
 * Throws when the response is unusable, so the caller can surface a real error
 * instead of writing an empty findings blob over a good one.
 */
export function parseIssues(raw: string, clusters: Cluster[]): Omit<Issue, 'firstSeen' | 'status'>[] {
  const parsed = JSON.parse(stripFences(raw)) as { issues?: unknown };
  if (!Array.isArray(parsed.issues)) throw new Error('model response has no "issues" array');

  const now = new Date().toISOString();

  /** Only accept a real string; an object here would stringify to "[object Object]". */
  const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

  const issues = parsed.issues.map((entry, rank) => {
    const e = entry as Record<string, unknown>;
    const indices = uniq((Array.isArray(e.clusters) ? e.clusters : []).map(String))
      .map(Number)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < clusters.length);
    if (indices.length === 0) throw new Error(`issue "${text(e.title, 'untitled')}" references no valid cluster`);

    const members = indices.map((i) => clusters[i]);
    return {
      key: uniq(members.map((c) => `${c.exceptionType}@${c.serviceId}`)).sort().join(','),
      title: text(e.title, 'Untitled issue'),
      impact: text(e.impact),
      cause: text(e.cause),
      fix: text(e.fix),
      rank: rank + 1,
      occurrences: members.reduce((sum, c) => sum + c.occurrences, 0),
      services: uniq(members.map((c) => c.service || c.serviceId)),
      endpoints: uniq(members.map((c) => c.endpoint)),
      exampleTraceIds: uniq(members.flatMap((c) => c.traceIds ?? [])).slice(0, 5),
      lastSeen: now,
    };
  });

  // ponytail: a key collision means the model split one exception+service pair across
  // two issues. Fold them rather than letting the later one silently win the merge.
  const byKey = new Map<string, Omit<Issue, 'firstSeen' | 'status'>>();
  for (const issue of issues) {
    const existing = byKey.get(issue.key);
    if (!existing) {
      byKey.set(issue.key, issue);
      continue;
    }
    existing.occurrences += issue.occurrences;
    existing.services = uniq([...existing.services, ...issue.services]);
    existing.endpoints = uniq([...existing.endpoints, ...issue.endpoints]);
    existing.exampleTraceIds = uniq([...existing.exampleTraceIds, ...issue.exampleTraceIds]).slice(0, 5);
  }
  return [...byKey.values()];
}

/**
 * Diffs this run's issues against the previous run: new vs recurring, preserved
 * firstSeen, and dismissals that survive an issue disappearing and coming back.
 */
export function mergeWithPrior(
  candidates: Omit<Issue, 'firstSeen' | 'status'>[],
  prior: Findings,
  now: string,
  lookbackHours: number,
): Findings {
  const priorByKey = new Map(prior.issues.map((i) => [i.key, i]));
  const dismissed = new Set(prior.dismissedKeys);

  const issues: Issue[] = candidates.map((candidate) => {
    const before = priorByKey.get(candidate.key);
    return {
      ...candidate,
      firstSeen: before?.firstSeen ?? now,
      status: dismissed.has(candidate.key) ? 'dismissed' : before ? 'recurring' : 'new',
    };
  });

  return { lastRun: now, lookbackHours, issues, dismissedKeys: [...dismissed] };
}

/** Dismissing suppresses an issue now and on every future run until undismissed. */
export function setDismissed(findings: Findings, key: string, dismissed: boolean): Findings {
  const keys = new Set(findings.dismissedKeys);
  if (dismissed) keys.add(key);
  else keys.delete(key);

  return {
    ...findings,
    dismissedKeys: [...keys],
    issues: findings.issues.map((i) =>
      i.key !== key ? i : { ...i, status: dismissed ? 'dismissed' : 'recurring' },
    ),
  };
}
