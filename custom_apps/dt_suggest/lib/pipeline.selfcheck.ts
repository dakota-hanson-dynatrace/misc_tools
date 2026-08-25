import assert from 'node:assert/strict';
import {
  buildPrompt,
  parseIssues,
  mergeWithPrior,
  setDismissed,
  EMPTY_FINDINGS,
  MAX_PROMPT_CHARS,
  FORMAT_INSTRUCTION,
  type Cluster,
} from './pipeline';

// Self-check for the run-to-run diff logic - the only non-trivial branch in the app.
// No test runner is installed in this project - run with esbuild + node:
//   npx esbuild lib/pipeline.selfcheck.ts --bundle --platform=node --format=cjs --outfile=/tmp/check.js && node /tmp/check.js

const clusters: Cluster[] = [
  { exceptionType: 'org.apache.axis2.AxisFault', message: 'backend', service: 'Business', serviceId: 'SERVICE-A', endpoint: '/getAll', occurrences: 2151, traceIds: ['t1'], stack: 'a\nb' },
  { exceptionType: 'org.apache.axis2.AxisFault', message: 'backend', service: 'Business', serviceId: 'SERVICE-A', endpoint: '/getEnabled', occurrences: 2152, traceIds: ['t2'], stack: 'a\nb' },
  { exceptionType: 'java.net.SocketTimeoutException', message: 'Read timed out', service: 'Frontend', serviceId: 'SERVICE-B', endpoint: '/orange.jsf', occurrences: 176, traceIds: ['t3'], stack: 'c' },
];

const modelResponse = JSON.stringify({
  issues: [
    { title: 'SOAP backend unreachable', impact: 'Business', cause: 'backend down', fix: 'check host', clusters: [0, 1] },
    { title: 'Frontend read timeouts', impact: 'Frontend', cause: 'slow deps', fix: 'profile', clusters: [2] },
  ],
});

// Counts come from the DQL rows, never from the model, and merged clusters aggregate.
const candidates = parseIssues(modelResponse, clusters);
assert.equal(candidates.length, 2);
assert.equal(candidates[0].occurrences, 4303, 'merged clusters sum their occurrences');
assert.deepEqual(candidates[0].endpoints, ['/getAll', '/getEnabled']);
// eslint-disable-next-line noSecrets/no-secrets -- issue key fixture, not a credential
assert.equal(candidates[0].key, 'org.apache.axis2.AxisFault@SERVICE-A');

// A model that wraps its JSON in a markdown fence is still parseable.
assert.equal(parseIssues('```json\n' + modelResponse + '\n```', clusters).length, 2);

// A response that references no real cluster is an error, not a silent empty run.
assert.throws(() => parseIssues(JSON.stringify({ issues: [{ title: 'x', clusters: [99] }] }), clusters));

// First run: everything is new.
const run1 = mergeWithPrior(candidates, EMPTY_FINDINGS, '2026-01-01T00:00:00Z', 6);
assert.deepEqual(run1.issues.map((i) => i.status), ['new', 'new']);

// Second run: same keys are recurring, and firstSeen survives.
const run2 = mergeWithPrior(candidates, run1, '2026-01-01T06:00:00Z', 6);
assert.deepEqual(run2.issues.map((i) => i.status), ['recurring', 'recurring']);
assert.equal(run2.issues[0].firstSeen, '2026-01-01T00:00:00Z');
assert.equal(run2.lastRun, '2026-01-01T06:00:00Z');

// A dismissal survives the next run...
const afterDismiss = setDismissed(run2, candidates[0].key, true);
assert.equal(afterDismiss.issues[0].status, 'dismissed');
const run3 = mergeWithPrior(candidates, afterDismiss, '2026-01-01T12:00:00Z', 6);
assert.deepEqual(run3.issues.map((i) => i.status), ['dismissed', 'recurring']);

// ...and survives the issue disappearing for a run and coming back.
const gapRun = mergeWithPrior([candidates[1]], run3, '2026-01-01T18:00:00Z', 6);
assert.deepEqual(gapRun.issues.map((i) => i.status), ['recurring']);
const returnRun = mergeWithPrior(candidates, gapRun, '2026-01-02T00:00:00Z', 6);
assert.equal(returnRun.issues[0].status, 'dismissed', 'dismissal is not lost when an issue lapses');

// Undismissing brings it back as recurring, not as new.
assert.equal(setDismissed(returnRun, candidates[0].key, false).issues[0].status, 'recurring');

// The prompt carries the data and the prior titles, and asks for JSON only.
const { prompt, included } = buildPrompt(clusters, ['SOAP backend unreachable'], 6);
assert.ok(prompt.includes('[0] org.apache.axis2.AxisFault'));
assert.ok(prompt.includes('SOAP backend unreachable'));
assert.ok(!prompt.includes('JSON only'), 'format goes in the instruction, not the question');
assert.ok(FORMAT_INSTRUCTION.includes('JSON only'));
assert.ok(prompt.includes('last 6 hours'));
assert.equal(included.length, clusters.length, 'a small cluster set fits whole');
assert.ok(prompt.length <= MAX_PROMPT_CHARS);

// The conversation skill hard-rejects text over 10000 chars, so a big cluster set must
// still produce a prompt under the cap - and the indices must match what survived.
const many: Cluster[] = Array.from({ length: 200 }, (_, i) => ({
  exceptionType: `com.example.Exception${i}`,
  message: 'x'.repeat(900),
  service: `Service ${i}`,
  serviceId: `SERVICE-${i}`,
  endpoint: `/endpoint/${i}`,
  occurrences: 1000 - i,
  traceIds: [`trace-${i}`],
  stack: Array.from({ length: 30 }, (_, f) => `com.example.Frame${f} (Frame${f}.java:${f})`).join('\n'),
}));
const big = buildPrompt(many, [], 6);
assert.ok(big.prompt.length <= MAX_PROMPT_CHARS, `prompt was ${big.prompt.length} chars`);
assert.ok(big.included.length > 0 && big.included.length < many.length, 'sheds the tail, keeps the head');
assert.equal(big.included[0].serviceId, 'SERVICE-0', 'highest-volume clusters are kept');
assert.ok(big.prompt.includes(`[${big.included.length - 1}] `), 'indices are contiguous over what survived');
// Indices in the prompt must resolve against `included`, not the original array.
const lastIndex = big.included.length - 1;
const derived = parseIssues(JSON.stringify({ issues: [{ title: 't', clusters: [lastIndex] }] }), big.included);
assert.equal(derived[0].occurrences, big.included[lastIndex].occurrences);

console.log('pipeline.selfcheck: all assertions passed');
