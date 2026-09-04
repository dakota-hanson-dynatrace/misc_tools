import assert from 'node:assert/strict';
import { normalizeConfig, configHash } from './normalize';
// esbuild inlines this, so the bundled check is self-contained and can run from
// anywhere. Do not switch to readFileSync: import.meta.url points at the bundle.
import fixtures from '../../../../../shared/normalize-fixtures.json';

// No test runner is installed in this project - run with esbuild + node:
//   npx esbuild ui/app/utils/normalize.selfcheck.ts --bundle --platform=node --format=cjs --outfile=/tmp/ncmcheck.js && node /tmp/ncmcheck.js
//
// The fixture file is the CONTRACT between this normalizer and the Python one in
// collector/. Both must pass it. If they disagree, hashes diverge and every
// device looks permanently changed.

type Fixture = { name: string; vendor: string; raw: string; expected: string };
const cases: Fixture[] = (fixtures as { cases: Fixture[] }).cases;

assert.ok(cases.length >= 10, 'fixture file looks truncated');

for (const c of cases) {
  assert.equal(normalizeConfig(c.raw), c.expected, `fixture "${c.name}" (${c.vendor})`);
}

// Idempotence: normalizing already-normalized text must be a no-op, or repeated
// repair passes would keep changing the hash.
for (const c of cases) {
  assert.equal(
    normalizeConfig(c.expected),
    c.expected,
    `fixture "${c.name}" must be idempotent`
  );
}

// The property the whole design rests on: two polls of an UNCHANGED device that
// differ only in volatile lines must normalize identically. If this breaks, the
// promote job writes a new version every night, forever.
const pollA = cases.find((c) => c.name === 'cisco_ios_header_and_timestamps')!;
const pollB = cases.find((c) => c.name === 'cisco_ios_unchanged_device_two_polls_match')!;
assert.notEqual(pollA.raw, pollB.raw, 'the two polls must genuinely differ as raw text');
assert.equal(
  normalizeConfig(pollA.raw),
  normalizeConfig(pollB.raw),
  'two polls of an unchanged device must normalize to the same text'
);

// And the converse: a real config change must NOT be normalized away.
const withRoute = cases.find((c) => c.name === 'real_change_survives_normalization')!;
assert.ok(
  normalizeConfig(withRoute.raw).includes('ip route 10.0.0.0'),
  'a real config line must survive normalization'
);

// Volatile lines must not merely be blanked - a blank line left behind still
// shifts diff line numbers and makes every diff noisy.
assert.ok(
  !normalizeConfig(pollA.raw).includes('Building configuration'),
  'volatile lines must be removed, not blanked'
);

// Hash must be stable and must actually differ on a real change.
(async () => {
  const h1 = await configHash(pollA.raw);
  const h2 = await configHash(pollA.raw);
  assert.equal(h1, h2, 'hash must be deterministic');
  assert.match(h1, /^[0-9a-f]{64}$/, 'hash must be lowercase hex sha256');

  const changed = await configHash(pollA.raw + '\nip route 1.1.1.0 255.255.255.0 10.0.0.1');
  assert.notEqual(h1, changed, 'a real config change must change the hash');

  console.log(`normalize.selfcheck: all assertions passed (${cases.length} fixtures)`);
  // Emit the cross-language contract: the Python self-check prints the same
  // digest list, so drift between the two implementations is a visible diff.
  for (const c of cases) {
    console.log(`  ${await configHash(c.raw)}  ${c.name}`);
  }
})();
