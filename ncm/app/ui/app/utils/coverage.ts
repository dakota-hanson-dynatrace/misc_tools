// Joining SNMP-monitored network devices against NCM backup state.
//
// Neither available key is trustworthy on its own:
//
//   - `entity.name` is sysName, a MUTABLE display label. It always exists.
//   - the polled address comes from a metric dimension, so it is stronger
//     (machine-derived) but BEST-EFFORT - absent for any device not currently
//     reporting the metric.
//
// So: match on address when both sides have one, fall back to normalised name,
// and treat disagreement between the two as a FINDING rather than suppressing
// it. "SNMP polls core-rtr01 at 10.1.1.1 / NCM backs up core-rtr01 at 10.1.1.5"
// is a real operational discrepancy nobody currently has a way to see.
//
// Deliberately NOT built: a correlation engine or a stored mapping table. The
// ambiguous case is reported, not resolved.

/** 2x the 24h capture schedule. Must track the schedule if that changes. */
export const FRESHNESS_WINDOW_HOURS = 48;

export type CoverageState =
  | 'covered' // successful capture inside the window
  | 'stale' // last SUCCESSFUL capture is older than the window
  | 'failing' // captures are happening and failing
  | 'never' // monitored, but never backed up
  | 'unmonitored' // backed up, but no matching SNMP entity
  | 'ambiguous'; // one monitored device matches several NCM devices

export type MatchBasis = 'address' | 'name' | 'none';

export interface MonitoredDevice {
  entityId: string;
  name: string;
}
export interface MonitoredAddress {
  entityId: string;
  address: string;
}
export interface BackupState {
  deviceId: string;
  name: string;
  address: string | null;
  site: string | null;
  vendor: string | null;
  attempts: string | number;
  failures: string | number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  statuses: string[] | null;
}

export interface CoverageRow {
  state: CoverageState;
  matchedBy: MatchBasis;
  /** Present when the device is known to Dynatrace via SNMP. */
  entityId?: string;
  /** Present when NCM has any record of the device. */
  deviceId?: string;
  name: string;
  monitoredAddress?: string;
  backupAddress?: string;
  site?: string;
  vendor?: string;
  lastSuccess?: string;
  lastAttempt?: string;
  failures: number;
  attempts: number;
  reasons: string[];
  /** Disagreements between the two keys. Findings, not errors. */
  discrepancies: string[];
}

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Lower-case and drop any DNS suffix, so `core-rtr01.corp.example.com` matches `core-rtr01`. */
export function normalizeName(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .split('.')[0];
}

function stateFor(b: BackupState, nowMs: number): { state: CoverageState; reasons: string[] } {
  const failures = n(b.failures);
  const reasons = (b.statuses ?? []).filter((s) => s && s !== 'ok').map(String);

  if (!b.lastSuccess) {
    // Captures are being attempted and none has ever succeeded. That is worse
    // than stale and must not be coloured as merely outdated.
    return { state: failures > 0 ? 'failing' : 'never', reasons };
  }

  const ageMs = nowMs - Date.parse(b.lastSuccess);
  const stale = !Number.isFinite(ageMs) || ageMs > FRESHNESS_WINDOW_HOURS * 3600_000;

  // A device with a good backup from 30 days ago and 30 days of auth failures
  // is not "outdated", it is broken - report the failure, not the staleness.
  if (failures > 0 && stale) return { state: 'failing', reasons };
  if (stale) return { state: 'stale', reasons };
  return { state: 'covered', reasons };
}

export interface CoverageInput {
  monitored: MonitoredDevice[];
  addresses: MonitoredAddress[];
  backups: BackupState[];
  /** Injectable for testing. */
  nowMs?: number;
}

/**
 * Produce one row per device across both worlds:
 *   - every SNMP-monitored device, with its backup state (or `never`)
 *   - plus any NCM device with no monitored counterpart (`unmonitored`)
 */
export function computeCoverage(input: CoverageInput): CoverageRow[] {
  const nowMs = input.nowMs ?? Date.now();
  const addrByEntity = new Map(input.addresses.map((a) => [a.entityId, a.address]));

  // Index NCM devices by both keys. Arrays, not single values - collisions are
  // the ambiguous case and must be detectable rather than silently overwritten.
  const byAddress = new Map<string, BackupState[]>();
  const byName = new Map<string, BackupState[]>();
  for (const b of input.backups) {
    if (b.address) {
      const k = b.address.trim();
      byAddress.set(k, [...(byAddress.get(k) ?? []), b]);
    }
    const nk = normalizeName(b.name);
    if (nk) byName.set(nk, [...(byName.get(nk) ?? []), b]);
  }

  const rows: CoverageRow[] = [];
  const claimed = new Set<string>();

  for (const m of input.monitored) {
    const monitoredAddress = addrByEntity.get(m.entityId);
    const nameKey = normalizeName(m.name);

    const addrMatches = monitoredAddress ? (byAddress.get(monitoredAddress) ?? []) : [];
    const nameMatches = byName.get(nameKey) ?? [];

    let matches = addrMatches;
    let matchedBy: MatchBasis = 'address';
    if (matches.length === 0) {
      matches = nameMatches;
      matchedBy = matches.length ? 'name' : 'none';
    }

    const base = {
      entityId: m.entityId,
      name: m.name,
      monitoredAddress,
      failures: 0,
      attempts: 0,
      reasons: [] as string[],
    };

    if (matches.length === 0) {
      rows.push({
        ...base,
        state: 'never',
        matchedBy: 'none',
        discrepancies: monitoredAddress
          ? []
          : ['No polled address available for this device, so only the name could be matched'],
      });
      continue;
    }

    if (matches.length > 1) {
      rows.push({
        ...base,
        state: 'ambiguous',
        matchedBy,
        discrepancies: [
          `${matches.length} NCM devices match this monitored device by ${matchedBy}` +
            (matchedBy === 'address' ? ` (${monitoredAddress})` : '') +
            ': ' +
            matches.map((x) => x.name).join(', '),
        ],
      });
      matches.forEach((x) => claimed.add(x.deviceId));
      continue;
    }

    const b = matches[0];
    claimed.add(b.deviceId);
    const { state, reasons } = stateFor(b, nowMs);

    const discrepancies: string[] = [];
    if (matchedBy === 'address' && normalizeName(b.name) !== nameKey) {
      discrepancies.push(
        `Name differs: monitored as "${m.name}", backed up as "${b.name}" (matched on ${monitoredAddress})`
      );
    }
    if (matchedBy === 'name' && monitoredAddress && b.address && b.address !== monitoredAddress) {
      discrepancies.push(
        `Address differs: SNMP polls ${monitoredAddress}, backups connect to ${b.address} - likely a management VRF or a stale inventory entry`
      );
    }
    if (matchedBy === 'name' && !monitoredAddress) {
      discrepancies.push('Matched by name only - no polled address is being reported for this device');
    }

    rows.push({
      state,
      matchedBy,
      entityId: m.entityId,
      deviceId: b.deviceId,
      name: b.name || m.name,
      monitoredAddress,
      backupAddress: b.address ?? undefined,
      site: b.site ?? undefined,
      vendor: b.vendor ?? undefined,
      lastSuccess: b.lastSuccess ?? undefined,
      lastAttempt: b.lastAttempt ?? undefined,
      failures: n(b.failures),
      attempts: n(b.attempts),
      reasons,
      discrepancies,
    });
  }

  // The inverse gap: backed up, but nothing is monitoring it.
  for (const b of input.backups) {
    if (claimed.has(b.deviceId)) continue;
    const { reasons } = stateFor(b, nowMs);
    rows.push({
      state: 'unmonitored',
      matchedBy: 'none',
      deviceId: b.deviceId,
      name: b.name,
      backupAddress: b.address ?? undefined,
      site: b.site ?? undefined,
      vendor: b.vendor ?? undefined,
      lastSuccess: b.lastSuccess ?? undefined,
      lastAttempt: b.lastAttempt ?? undefined,
      failures: n(b.failures),
      attempts: n(b.attempts),
      reasons,
      discrepancies: ['Backed up, but no SNMP-monitored device matches it'],
    });
  }

  const ORDER: CoverageState[] = ['never', 'failing', 'ambiguous', 'stale', 'unmonitored', 'covered'];
  return rows.sort(
    (a, z) => ORDER.indexOf(a.state) - ORDER.indexOf(z.state) || a.name.localeCompare(z.name)
  );
}

export const STATE_LABEL: Record<CoverageState, string> = {
  covered: 'Backed up',
  stale: 'Outdated',
  failing: 'Failing',
  never: 'Not backed up',
  unmonitored: 'Not monitored',
  ambiguous: 'Ambiguous match',
};
