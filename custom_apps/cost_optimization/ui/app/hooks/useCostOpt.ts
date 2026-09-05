import { useDql } from '@dynatrace-sdk/react-hooks';

/** Thin wrapper over useDql that returns plain rows. */
export function useCostOptQuery<T = Record<string, unknown>>(query: string) {
  const { data, error, isLoading } = useDql({ query });
  const rows = (data?.records ?? []) as T[];
  return { rows, error, isLoading };
}

/** Grail returns numeric aggregates as strings/nulls; coerce without NaN leaking into the UI. */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function fmtPct(v: unknown): string {
  return `${num(v).toFixed(1)}%`;
}

export function fmtBytes(v: unknown): string {
  const n = num(v);
  if (n === 0) return '-';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fmtCores(millicores: unknown): string {
  const n = num(millicores);
  return n >= 1000 ? `${(n / 1000).toFixed(1)} cores` : `${n}m`;
}
