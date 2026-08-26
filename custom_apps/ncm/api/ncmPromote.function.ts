import { queryExecutionClient } from '@dynatrace-sdk/client-query';
import { logsClient } from '@dynatrace-sdk/client-classic-environment-v2';
import { buildBlobRecords, reassemble, byteLength, type ChunkRow } from '../ui/app/utils/records';
import { countLineChanges } from '../ui/app/utils/diff';
import { normalizeConfig } from '../ui/app/utils/normalize';

// Promotes changed configs from `capture` to `version`.
//
// This is the link between what the collector produces and what the UI reads.
// The collector writes a `capture` blob every run; only a config whose hash
// actually moved becomes a `version`, which is the durable record.
//
// ONE invocation handles the whole fleet. Deliberately not per-device fan-out:
// that would need ~N invocations against a documented concurrency cap returning
// HTTP 429, and the AutomationEngine docs are explicit that it "isn't suitable
// as a data pipeline". Instead this drains a bounded amount of work per call and
// reports what is left, so a caller can simply invoke it again.
//
// Nothing throws out of here - an exception escaping an app function is
// reported by the runtime as a generic "Execution crashed" with the real
// message lost.

/**
 * Byte budget for config text held in memory per invocation. The runtime gives
 * 256 MB total, so this stays well clear while still draining a normal night's
 * changes (~2% of a fleet) in one pass.
 */
const MAX_BYTES_PER_RUN = 40_000_000;

/** Wall-clock guard. The hard function timeout is 120 s; stop early and cleanly. */
const TIME_BUDGET_MS = 90_000;

/**
 * Skip line-counting above this size. Diffing two multi-megabyte, wholly
 * different texts is the pathological O(ND) case and would burn the whole time
 * budget on one device. The version is still promoted - only the line counts
 * are omitted, flagged by ncm.lines.counted = false.
 */
const MAX_DIFF_BYTES = 2_000_000;

interface PromoteRequest {
  /** Compute everything, write nothing. */
  dryRun?: boolean;
  /** Override the byte budget (testing). */
  maxBytes?: number;
}

interface PromotedDevice {
  deviceId: string;
  captureId: string;
  fromHash: string | null;
  toHash: string;
  bytes: number;
  chunks: number;
  linesAdded: number | null;
  linesRemoved: number | null;
}

interface PromoteResponse {
  ok: boolean;
  message?: string;
  dryRun?: boolean;
  /** Devices whose latest capture hash differs from their latest promoted version. */
  candidates?: number;
  promoted?: PromotedDevice[];
  /** Not attempted this run because a budget ran out. Invoke again to continue. */
  remaining?: number;
  /** Candidates skipped permanently, with the reason. */
  skipped?: { deviceId: string; captureId: string; reason: string }[];
}

/**
 * Run a DQL query to completion.
 *
 * The poll response does NOT echo the request token, so it must be captured
 * from the initial execute call - polling with `res.requestToken` terminates the
 * loop after one iteration and silently returns partial results.
 */
async function dql(query: string): Promise<Record<string, unknown>[]> {
  const started = await queryExecutionClient.queryExecute({ body: { query, requestTimeoutMilliseconds: 60_000 } });
  const token = started.requestToken;
  if (started.result) return (started.result.records ?? []) as Record<string, unknown>[];
  if (!token) return [];

  for (let i = 0; i < 30; i++) {
    const polled = await queryExecutionClient.queryPoll({ requestToken: token });
    if (polled.result) return (polled.result.records ?? []) as Record<string, unknown>[];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('query did not complete within the poll budget');
}

const s = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
};
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Grail is append-only, so reseeding or a retried collector run duplicates
// records. Every query here dedups on the deterministic capture id.
const WINDOW = 'from: -30d';

/** Latest capture per device, by logical capture time. */
const LATEST_CAPTURES = `
fetch logs, ${WINDOW}
| filter ncm.record.type == "index" and ncm.capture.status == "ok" and ncm.config.type == "running"
| dedup {ncm.capture.id}
| sort ncm.capture.time desc
| summarize
    captureId   = takeFirst(ncm.capture.id),
    captureTime = takeFirst(ncm.capture.time),
    hash        = takeFirst(ncm.config.hash),
    name        = takeFirst(ncm.device.name),
    address     = takeFirst(ncm.device.address),
    vendor      = takeFirst(ncm.vendor),
    site        = takeFirst(ncm.site),
    by: {deviceId = ncm.device.id}`;

/** Latest already-promoted version per device. */
const LATEST_VERSIONS = `
fetch logs, ${WINDOW}
| filter ncm.record.type == "version"
| dedup {ncm.capture.id, ncm.chunk.index}
| sort ncm.capture.time desc
| summarize
    captureId   = takeFirst(ncm.capture.id),
    captureTime = takeFirst(ncm.capture.time),
    hash        = takeFirst(ncm.config.hash),
    by: {deviceId = ncm.device.id}`;

const chunkQuery = (captureId: string, recordType: 'capture' | 'version') => `
fetch logs, ${WINDOW}
| filter ncm.capture.id == "${captureId}" and ncm.record.type == "${recordType}"
| dedup {ncm.capture.id, ncm.chunk.index}
| fields content, ncm.chunk.index, ncm.chunk.total, ncm.content.bytes
| sort ncm.chunk.index asc`;

/** Read a stored config and verify its integrity before using it. */
async function readConfig(
  captureId: string,
  recordType: 'capture' | 'version'
): Promise<{ content: string; problem?: string }> {
  const rows = await dql(chunkQuery(captureId, recordType));
  if (rows.length === 0) return { content: '', problem: `no ${recordType} blob found` };
  const chunks: ChunkRow[] = rows.map((r) => ({
    content: s(r.content),
    'ncm.chunk.index': num(r['ncm.chunk.index']),
    'ncm.chunk.total': num(r['ncm.chunk.total']) || 1,
    'ncm.content.bytes': num(r['ncm.content.bytes']),
  }));
  const res = reassemble(chunks);
  return { content: res.content, problem: res.ok ? undefined : res.problem };
}

export default async function (request: PromoteRequest = {}): Promise<PromoteResponse> {
  const startedAt = Date.now();
  const budget = Math.max(1, Number(request.maxBytes) || MAX_BYTES_PER_RUN);
  const dryRun = request.dryRun === true;

  try {
    const [captures, versions] = await Promise.all([dql(LATEST_CAPTURES), dql(LATEST_VERSIONS)]);

    const promotedHash = new Map<string, string>();
    const promotedCapture = new Map<string, string>();
    for (const v of versions) {
      promotedHash.set(s(v.deviceId), s(v.hash));
      promotedCapture.set(s(v.deviceId), s(v.captureId));
    }

    // A device needs promotion when its newest capture's hash differs from the
    // newest hash already promoted. A device with no promoted version at all is
    // a baseline and must be promoted too, or it would never get a version.
    const candidates = captures.filter((c) => promotedHash.get(s(c.deviceId)) !== s(c.hash));

    const promoted: PromotedDevice[] = [];
    const skipped: { deviceId: string; captureId: string; reason: string }[] = [];
    let bytesUsed = 0;
    let i = 0;

    for (; i < candidates.length; i++) {
      if (bytesUsed >= budget || Date.now() - startedAt > TIME_BUDGET_MS) break;

      const c = candidates[i];
      const deviceId = s(c.deviceId);
      const captureId = s(c.captureId);
      const toHash = s(c.hash);
      const fromHash = promotedHash.get(deviceId) ?? null;

      const cur = await readConfig(captureId, 'capture');
      if (cur.problem) {
        // Never promote a blob that failed its integrity check - a truncated
        // config would become a permanent "version" that reads as a change
        // that never happened.
        skipped.push({ deviceId, captureId, reason: cur.problem });
        continue;
      }
      bytesUsed += byteLength(cur.content);

      // Line counts need the previous version's text. Optional by design: a
      // missing or oversized predecessor costs the counts, not the promotion.
      let linesAdded: number | null = null;
      let linesRemoved: number | null = null;
      const prevCaptureId = promotedCapture.get(deviceId);
      if (prevCaptureId && byteLength(cur.content) <= MAX_DIFF_BYTES) {
        const prev = await readConfig(prevCaptureId, 'version');
        if (!prev.problem && byteLength(prev.content) <= MAX_DIFF_BYTES) {
          bytesUsed += byteLength(prev.content);
          // Count on NORMALISED text so the counts agree with the hash. The
          // hash ignores volatile lines, so counting raw text reported +2/-1
          // for a single added ACL line - the vendor's own "last changed"
          // timestamp showing up as a change. Stored text stays raw; only this
          // measurement is normalised.
          const counts = countLineChanges(normalizeConfig(prev.content), normalizeConfig(cur.content));
          linesAdded = counts.added;
          linesRemoved = counts.removed;
        }
      }

      const attrs = {
        'ncm.device.name': s(c.name),
        'ncm.device.address': s(c.address) || null,
        'ncm.vendor': s(c.vendor),
        'ncm.site': s(c.site),
        'ncm.config.type': 'running',
        'ncm.config.hash': toHash,
        'ncm.promoted.from.hash': fromHash,
        'ncm.lines.added': linesAdded,
        'ncm.lines.removed': linesRemoved,
        'ncm.lines.counted': linesAdded !== null,
      };

      const blobs = buildBlobRecords(cur.content, {
        deviceId,
        captureId,
        captureTime: s(c.captureTime),
        recordType: 'version',
        attrs,
      });

      // The promotion index record: the change-ledger entry for this version.
      const indexRecord = {
        content: '',
        timestamp: new Date().toISOString(),
        'ncm.capture.time': s(c.captureTime),
        'ncm.record.type': 'index',
        'ncm.device.id': deviceId,
        'ncm.capture.id': captureId,
        'ncm.capture.status': 'ok',
        'ncm.promotion': true,
        'ncm.size.bytes': byteLength(cur.content),
        ...attrs,
      };

      if (!dryRun) {
        // One record per call - the EEC's own batching sizes records by counting
        // dict keys, and storeLog silently truncates content at 512 KiB, so
        // nothing here delegates splitting to a library.
        for (const b of blobs) {
          await logsClient.storeLog({ type: 'application/json; charset=utf-8', body: [b] });
        }
        await logsClient.storeLog({ type: 'application/json; charset=utf-8', body: [indexRecord] });
      }

      promoted.push({
        deviceId,
        captureId,
        fromHash,
        toHash,
        bytes: byteLength(cur.content),
        chunks: blobs.length,
        linesAdded,
        linesRemoved,
      });
    }

    return {
      ok: true,
      dryRun,
      candidates: candidates.length,
      promoted,
      remaining: Math.max(0, candidates.length - i),
      skipped,
    };
  } catch (e) {
    console.error('ncmPromote failed:', e);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
