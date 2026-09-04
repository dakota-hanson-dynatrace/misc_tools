import assert from 'node:assert/strict';
import {
  chunkByBytes,
  buildBlobRecords,
  reassemble,
  byteLength,
  CONTENT_LIMIT_BYTES,
  CHUNK_BYTES,
  type ChunkRow,
} from './records';

// Run with esbuild + node:
//   npx esbuild ui/app/utils/records.selfcheck.ts --bundle --platform=node --format=esm --outfile=/tmp/reccheck.mjs && node /tmp/reccheck.mjs
//
// Guards the silent-truncation defect: Grail accepts a 6 MB `content` with HTTP
// 200 and stores its first 512 KiB. Every assertion below exists to make that
// undetectable-by-default failure detectable.

// --- chunk sizing -----------------------------------------------------------

assert.equal(CHUNK_BYTES < CONTENT_LIMIT_BYTES, true, 'chunk size must leave headroom');

assert.deepEqual(chunkByBytes('', 10), [''], 'empty text yields one empty chunk');
assert.deepEqual(chunkByBytes('short', 10), ['short'], 'text under the limit is not split');

const exact = 'a'.repeat(10);
assert.deepEqual(chunkByBytes(exact, 10), [exact], 'text exactly at the limit is not split');
assert.deepEqual(chunkByBytes('a'.repeat(11), 10), ['a'.repeat(10), 'a'], 'one byte over splits');

for (const c of chunkByBytes('x'.repeat(1000), 7)) {
  assert.ok(byteLength(c) <= 7, 'no chunk may exceed the byte budget');
}

// --- the multi-byte trap ----------------------------------------------------
// Slicing by CHARACTER count would pass a naive test and overflow in production
// the moment a config contains a non-ASCII banner or interface description.

const multi = 'é'.repeat(10); // 2 bytes each => 20 bytes
assert.equal(byteLength(multi), 20, 'fixture must actually be multi-byte');
const mchunks = chunkByBytes(multi, 7); // 3 chars = 6 bytes per chunk
for (const c of mchunks) {
  assert.ok(byteLength(c) <= 7, `multi-byte chunk overflowed: ${byteLength(c)} bytes`);
}
assert.equal(mchunks.join(''), multi, 'multi-byte text must round-trip exactly');

// A 4-byte code point (emoji) must never be split across chunks.
const emoji = '\u{1F600}'.repeat(5); // 4 bytes each
const echunks = chunkByBytes(emoji, 9); // fits 2 per chunk
for (const c of echunks) {
  assert.ok(byteLength(c) <= 9, 'emoji chunk overflowed');
  assert.ok(!c.includes('�'), 'code point was split, producing a replacement char');
}
assert.equal(echunks.join(''), emoji, 'emoji text must round-trip exactly');

// A character larger than the budget is unsatisfiable and must be loud.
assert.throws(() => chunkByBytes('\u{1F600}', 2), /exceeds maxBytes/, 'must reject impossible budget');

// --- record building and round trip ----------------------------------------

const opts = {
  deviceId: 'dev-1',
  captureId: 'cap-1',
  captureTime: '2026-08-24T00:00:00.000Z',
  recordType: 'version' as const,
};

const small = buildBlobRecords('hostname sw1\n!', opts);
assert.equal(small.length, 1, 'a small config is one record');
assert.equal(small[0]['ncm.chunk.total'], 1);
assert.equal(small[0]['ncm.content.bytes'], byteLength('hostname sw1\n!'));

// The case that matters: larger than the real Grail ceiling.
const big = 'line of config text\n'.repeat(40_000); // ~800 KB, over 512 KiB
assert.ok(byteLength(big) > CONTENT_LIMIT_BYTES, 'fixture must exceed the real ceiling');

const bigRecords = buildBlobRecords(big, opts);
assert.ok(bigRecords.length > 1, 'an oversized config must be split');
for (const r of bigRecords) {
  assert.ok(
    byteLength(r.content) <= CONTENT_LIMIT_BYTES,
    'every chunk must fit under the ceiling that truncates silently'
  );
  assert.equal(r['ncm.content.bytes'], byteLength(big), 'every chunk carries the total');
  assert.equal(r['ncm.capture.id'], 'cap-1', 'chunks share a capture id');
}

const rows = bigRecords.map((r) => ({
  content: r.content,
  'ncm.chunk.index': r['ncm.chunk.index'] as number,
  'ncm.chunk.total': r['ncm.chunk.total'] as number,
  'ncm.content.bytes': r['ncm.content.bytes'] as number,
})) as ChunkRow[];

const good = reassemble(rows);
assert.equal(good.ok, true, `reassembly failed: ${good.problem}`);
assert.equal(good.content, big, 'reassembled content must equal the original exactly');

// Order must not matter - DQL returns rows unordered unless told otherwise.
const shuffled = [...rows].reverse();
assert.equal(reassemble(shuffled).content, big, 'reassembly must be order-independent');

// --- the failure modes must be DETECTED, not silently tolerated -------------

assert.equal(reassemble([]).ok, false, 'no chunks must be reported as a problem');

const missing = rows.slice(0, rows.length - 1);
const r1 = reassemble(missing);
assert.equal(r1.ok, false, 'a missing chunk must be detected');
assert.match(r1.problem!, /expected \d+ chunks/, 'problem must name the chunk count');

// The one that models the real bug: a chunk silently truncated in transit.
const truncated = rows.map((r, i) =>
  i === 0 ? { ...r, content: r.content.slice(0, 100) } : r
);
const r2 = reassemble(truncated);
assert.equal(r2.ok, false, 'SILENT TRUNCATION MUST BE DETECTED - this is the whole point');
assert.match(r2.problem!, /length mismatch/, 'problem must name the length mismatch');

// A duplicated index (same chunk twice, one missing) must not pass.
const dup = rows.map((r, i) => (i === 1 ? { ...rows[0] } : r));
assert.equal(reassemble(dup).ok, false, 'duplicated chunk index must be detected');

console.log(
  `records.selfcheck: all assertions passed ` +
    `(${bigRecords.length} chunks for ${byteLength(big).toLocaleString()} bytes, ` +
    `ceiling ${CONTENT_LIMIT_BYTES.toLocaleString()})`
);
