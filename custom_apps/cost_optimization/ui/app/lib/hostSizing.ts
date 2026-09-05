import type { Timeseries } from '@dynatrace/strato-components/charts';

// ponytail: buffer/percentile are hardcoded, matching the same convention as
// lib/kubectl.ts - add a settings UI only if tunable buffers are ever needed.
const BUFFER = 1.1;
const NEAR_CAPACITY_PCT = 80;

export type SizingStatus = 'downsize' | 'near-capacity' | 'right-sized';

export interface SizeRecommendation {
  usagePct: number;
  currentLabel: string;
  recommendedLabel: string;
  status: SizingStatus;
}

/** True percentile of the raw value array (sorts and indexes - not an approximation). */
export function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Converts one DQL `timeseries` record's raw value array into chart
 * datapoints. Every `timeseries` record carries `interval` (nanoseconds) and
 * `timeframe.start` alongside each named value array - confirmed via
 * `dtctl query` before relying on it here.
 */
export function toTimeseries(
  record: { interval: string | number; timeframe: { start: string } },
  field: string,
  name: string
): Timeseries {
  const asRecord = record as unknown as Record<string, unknown>;
  const intervalMs = Number(record.interval) / 1_000_000;
  const startMs = new Date(record.timeframe.start).getTime();
  const values = (asRecord[field] as (number | null)[] | undefined) ?? [];
  const datapoints = values
    .map((value, i) => ({ start: new Date(startMs + i * intervalMs), value }))
    .filter((d): d is { start: Date; value: number } => d.value != null);
  return { datapoints, name };
}

export const seriesValues = (ts: Timeseries): number[] => ts.datapoints.map((d) => d.value);

function fmtGB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function cpuRecommendation(cores: number, cpuPct: number[]): SizeRecommendation {
  const p90 = percentileOf(cpuPct, 90);
  const recommendedCores = Math.max(1, Math.ceil(((cores * p90) / 100) * BUFFER));
  return {
    usagePct: p90,
    currentLabel: `${cores} core${cores === 1 ? '' : 's'}`,
    recommendedLabel: `${recommendedCores} core${recommendedCores === 1 ? '' : 's'}`,
    status: p90 > NEAR_CAPACITY_PCT ? 'near-capacity' : recommendedCores < cores ? 'downsize' : 'right-sized',
  };
}

export function memRecommendation(memBytes: number, memPct: number[]): SizeRecommendation {
  const p90 = percentileOf(memPct, 90);
  const recommendedBytes = memBytes * (p90 / 100) * BUFFER;
  return {
    usagePct: p90,
    currentLabel: fmtGB(memBytes),
    recommendedLabel: fmtGB(recommendedBytes),
    status: p90 > NEAR_CAPACITY_PCT ? 'near-capacity' : recommendedBytes < memBytes * 0.7 ? 'downsize' : 'right-sized',
  };
}

/**
 * ponytail: unlike CPU/memory, a disk usually can't be shrunk while it holds
 * data, so "downsize" here means "over-provisioned" (safe to note for the
 * next resize), not something to act on immediately the way CPU/memory are.
 */
export function diskRecommendation(usedBytesSeries: number[], totalBytes: number): SizeRecommendation {
  const p90 = percentileOf(usedBytesSeries, 90);
  const usagePct = totalBytes > 0 ? (p90 / totalBytes) * 100 : 0;
  const recommendedBytes = Math.max(p90 * BUFFER, totalBytes * 0.2);
  return {
    usagePct,
    currentLabel: fmtGB(totalBytes),
    recommendedLabel: fmtGB(recommendedBytes),
    status: usagePct > NEAR_CAPACITY_PCT ? 'near-capacity' : recommendedBytes < totalBytes * 0.5 ? 'downsize' : 'right-sized',
  };
}
