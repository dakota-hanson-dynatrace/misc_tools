import assert from 'node:assert/strict';
import { computeCoverage, normalizeName, FRESHNESS_WINDOW_HOURS, type BackupState } from './coverage';

// npx esbuild ui/app/utils/coverage.selfcheck.ts --bundle --platform=node --format=esm --outfile=/tmp/cov.mjs && node /tmp/cov.mjs
//
// The join uses two individually-untrustworthy keys, so every assertion below
// pins one specific way it could silently produce a wrong answer.

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const bs = (o: Partial<BackupState> & { deviceId: string; name: string }): BackupState => ({
  address: null, site: 'S', vendor: 'cisco_ios', attempts: 10, failures: 0,
  lastAttempt: hoursAgo(1), lastSuccess: hoursAgo(1), statuses: ['ok'], ...o,
});

// --- name normalisation -----------------------------------------------------
assert.equal(normalizeName('core-rtr01.corp.example.com'), 'core-rtr01', 'DNS suffix must be dropped');
assert.equal(normalizeName('CORE-RTR01'), 'core-rtr01', 'case must not matter');
assert.equal(normalizeName(null), '', 'null must not throw');

// --- address match wins over name, and surfaces a name disagreement ---------
let rows = computeCoverage({
  monitored: [{ entityId: 'E1', name: 'old-name' }],
  addresses: [{ entityId: 'E1', address: '10.0.0.4' }],
  backups: [bs({ deviceId: 'D1', name: 'new-name', address: '10.0.0.4' })],
  nowMs: NOW,
});
assert.equal(rows.length, 1);
assert.equal(rows[0].state, 'covered');
assert.equal(rows[0].matchedBy, 'address', 'address must take precedence over name');
assert.match(rows[0].discrepancies[0], /Name differs/, 'a name disagreement must be reported, not hidden');

// --- name fallback when no address is being reported ------------------------
rows = computeCoverage({
  monitored: [{ entityId: 'E1', name: 'core-rtr01' }],
  addresses: [], // metric absent - the best-effort case
  backups: [bs({ deviceId: 'D1', name: 'core-rtr01.corp.example.com', address: '10.1.1.1' })],
  nowMs: NOW,
});
assert.equal(rows[0].state, 'covered', 'must still match via name');
assert.equal(rows[0].matchedBy, 'name');
assert.match(rows[0].discrepancies[0], /no polled address/i, 'the weaker basis must be disclosed');

// --- name matches but addresses disagree: the management-VRF case -----------
rows = computeCoverage({
  monitored: [{ entityId: 'E1', name: 'core-rtr01' }],
  addresses: [{ entityId: 'E1', address: '10.1.1.1' }],
  backups: [bs({ deviceId: 'D1', name: 'core-rtr01', address: '10.1.1.5' })],
  nowMs: NOW,
});
assert.equal(rows[0].matchedBy, 'name', 'addresses differ so the address index cannot match');
assert.match(rows[0].discrepancies[0], /Address differs/, 'the address split must be reported');

// --- ambiguity must NOT be guessed at (the live 127.0.0.1 case) -------------
rows = computeCoverage({
  monitored: [{ entityId: 'E1', name: 'rig' }],
  addresses: [{ entityId: 'E1', address: '127.0.0.1' }],
  backups: [
    bs({ deviceId: 'D1', name: 'rig-a', address: '127.0.0.1' }),
    bs({ deviceId: 'D2', name: 'rig-b', address: '127.0.0.1' }),
  ],
  nowMs: NOW,
});
assert.equal(rows[0].state, 'ambiguous', 'a colliding address must not silently pick one device');
assert.match(rows[0].discrepancies[0], /2 NCM devices match/);
// Both claimed devices must be suppressed from the unmonitored list, or they
// would appear twice with contradictory states.
assert.equal(rows.length, 1, 'ambiguous claimants must not also render as unmonitored');

// --- the four coverage states ----------------------------------------------
const mon = [{ entityId: 'E1', name: 'd1' }];
const addr = [{ entityId: 'E1', address: '10.0.0.1' }];

const state = (o: Partial<BackupState>) =>
  computeCoverage({
    monitored: mon, addresses: addr,
    backups: [bs({ deviceId: 'D1', name: 'd1', address: '10.0.0.1', ...o })],
    nowMs: NOW,
  })[0].state;

assert.equal(state({ lastSuccess: hoursAgo(1) }), 'covered');
assert.equal(state({ lastSuccess: hoursAgo(FRESHNESS_WINDOW_HOURS + 1) }), 'stale', 'past the window is stale');
assert.equal(state({ lastSuccess: hoursAgo(FRESHNESS_WINDOW_HOURS - 1) }), 'covered', 'inside the window is covered');
assert.equal(
  state({ lastSuccess: null, failures: 91, statuses: ['auth_failed'] }),
  'failing',
  'attempted and never succeeded is failing, not stale'
);
// The case the design calls out: an old good backup plus ongoing failures is
// broken, not merely outdated.
assert.equal(
  state({ lastSuccess: hoursAgo(30 * 24), failures: 30, statuses: ['auth_failed'] }),
  'failing',
  'a stale backup WITH failures must report failing, not stale'
);

// --- monitored but entirely absent from NCM --------------------------------
rows = computeCoverage({
  monitored: [{ entityId: 'E1', name: 'ghost' }],
  addresses: [{ entityId: 'E1', address: '10.9.9.9' }],
  backups: [],
  nowMs: NOW,
});
assert.equal(rows[0].state, 'never', 'monitored with no backup at all is the red case');
assert.equal(rows[0].deviceId, undefined);

// --- the inverse gap -------------------------------------------------------
rows = computeCoverage({
  monitored: [],
  addresses: [],
  backups: [bs({ deviceId: 'D1', name: 'orphan', address: '10.2.2.2' })],
  nowMs: NOW,
});
assert.equal(rows[0].state, 'unmonitored', 'backed up but unmonitored is also a gap');

// --- ordering puts problems first ------------------------------------------
rows = computeCoverage({
  monitored: [
    { entityId: 'E1', name: 'good' },
    { entityId: 'E2', name: 'bad' },
  ],
  addresses: [
    { entityId: 'E1', address: '10.0.0.1' },
    { entityId: 'E2', address: '10.0.0.2' },
  ],
  backups: [bs({ deviceId: 'D1', name: 'good', address: '10.0.0.1' })],
  nowMs: NOW,
});
assert.equal(rows[0].state, 'never', 'problems must sort above healthy rows');
assert.equal(rows[1].state, 'covered');

// --- empty input must not throw -------------------------------------------
assert.deepEqual(computeCoverage({ monitored: [], addresses: [], backups: [], nowMs: NOW }), []);

console.log('coverage.selfcheck: all assertions passed');
