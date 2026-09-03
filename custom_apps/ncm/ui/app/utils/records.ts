// Building and reassembling NCM Grail records.
//
// The single most important thing in this file is that `content` truncates
// SILENTLY at 512 KiB. A 6 MB config is accepted with HTTP 200, stored as its
// first 512 KiB, and looks perfectly healthy (verified against a real tenant). Nothing
// detects that except comparing reassembled length against a recorded total.
//
// So: split by MEASURED UTF-8 BYTES, record the expected total, and assert on
// read. Never trust an ingest success response.

/** Hard ceiling observed in Grail. Not a documented number we trusted - a measured one. */
export const CONTENT_LIMIT_BYTES = 524_288;

/** Chunk target, leaving headroom under the ceiling for attributes. */
export const CHUNK_BYTES = 400_000;

export type RecordType = 'index' | 'capture' | 'version';
export type ConfigType = 'running' | 'startup';
export type CaptureStatus =
  | 'ok'
  | 'enable_required'
  | 'auth_failed'
  | 'unreachable'
  | 'timeout'
  | 'host_key_mismatch';

export interface NcmRecord {
  content: string;
  timestamp: string;
  'ncm.capture.time': string;
  'ncm.record.type': RecordType;
  'ncm.device.id': string;
  'ncm.capture.id': string;
  [k: string]: unknown;
}

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;

/**
 * Split text into chunks that are each at most `maxBytes` when UTF-8 encoded.
 *
 * Splits on BYTES, not characters - a `.slice()` by character count can exceed
 * a byte budget the moment any multi-byte character appears (a UTF-8 banner, a
 * degree sign in an interface description). Code points are never split across
 * chunks, so each chunk is independently valid UTF-8.
 */
export function chunkByBytes(text: string, maxBytes: number = CHUNK_BYTES): string[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  if (text === '') return [''];
  if (byteLength(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  // Iterating the string yields whole code points (surrogate pairs stay intact).
  for (const ch of text) {
    const chBytes = byteLength(ch);
    if (chBytes > maxBytes) {
      throw new Error(`single character requires ${chBytes} bytes, exceeds maxBytes ${maxBytes}`);
    }
    if (currentBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

export interface BlobOptions {
  deviceId: string;
  captureId: string;
  captureTime: string;
  recordType: 'capture' | 'version';
  /** Extra attributes copied onto every chunk. */
  attrs?: Record<string, unknown>;
}

/**
 * Build the blob record(s) for one config. Always returns at least one record;
 * returns several when the config exceeds CHUNK_BYTES.
 *
 * `ncm.content.bytes` is the total reassembled length and is the assertion
 * target on read - it is what makes silent truncation detectable.
 */
export function buildBlobRecords(content: string, o: BlobOptions): NcmRecord[] {
  const chunks = chunkByBytes(content);
  const total = byteLength(content);
  const now = new Date().toISOString();

  return chunks.map((chunk, i) => ({
    content: chunk,
    timestamp: now,
    'ncm.capture.time': o.captureTime,
    'ncm.record.type': o.recordType,
    'ncm.device.id': o.deviceId,
    'ncm.capture.id': o.captureId,
    'ncm.chunk.index': i,
    'ncm.chunk.total': chunks.length,
    'ncm.chunk.bytes': byteLength(chunk),
    'ncm.content.bytes': total,
    ...(o.attrs ?? {}),
  }));
}

export interface ChunkRow {
  content: string;
  'ncm.chunk.index': number;
  'ncm.chunk.total': number;
  'ncm.content.bytes': number;
}

export interface Reassembled {
  ok: boolean;
  content: string;
  /** Populated when ok is false. Never render a config whose reassembly failed. */
  problem?: string;
}

/**
 * Reassemble chunk rows returned by DQL, verifying integrity.
 *
 * Returns ok:false rather than throwing, because the caller's correct response
 * is to show the version as damaged - not to crash, and emphatically not to
 * silently display a truncated config as though it were real.
 */
export function reassemble(rows: ChunkRow[]): Reassembled {
  if (rows.length === 0) return { ok: false, content: '', problem: 'no chunks found' };

  const expectedTotal = rows[0]['ncm.content.bytes'];
  const expectedCount = rows[0]['ncm.chunk.total'];

  if (rows.length !== expectedCount) {
    return {
      ok: false,
      content: '',
      problem: `expected ${expectedCount} chunks, found ${rows.length}`,
    };
  }

  const sorted = [...rows].sort((a, b) => a['ncm.chunk.index'] - b['ncm.chunk.index']);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]['ncm.chunk.index'] !== i) {
      return { ok: false, content: '', problem: `chunk index ${i} missing or duplicated` };
    }
  }

  const content = sorted.map((r) => r.content).join('');
  const actual = byteLength(content);
  if (actual !== expectedTotal) {
    // This is the silent-truncation detector. If it ever fires in production,
    // something between here and Grail dropped bytes without saying so.
    return {
      ok: false,
      content,
      problem: `length mismatch: expected ${expectedTotal} bytes, reassembled ${actual}`,
    };
  }

  return { ok: true, content };
}
