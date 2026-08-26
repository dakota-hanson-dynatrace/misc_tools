import { useDql } from '@dynatrace-sdk/react-hooks';

/**
 * Thin wrapper over useDql that returns plain rows.
 *
 * Every NCM query embeds its own timeframe (`from: -30d` on ingest time), so the
 * app shell's timeframe picker must NOT be allowed to override it - the shell's
 * window applies to `timestamp`, which here is ingest time, while all logical
 * history lives in the `ncm.capture.time` attribute. A user narrowing the
 * picker to "last 30 minutes" would otherwise empty the whole app.
 */
export function useNcmQuery<T = Record<string, unknown>>(query: string) {
  const { data, error, isLoading } = useDql({ query });
  const rows = (data?.records ?? []) as T[];
  return { rows, error, isLoading };
}

/** ISO-8601 -> short local display. Falls back to the raw value rather than "Invalid Date". */
export function fmtTime(iso: unknown): string {
  if (typeof iso !== 'string') return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** Grail returns numeric aggregates as strings; coerce without NaN leaking into the UI. */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function fmtBytes(v: unknown): string {
  const n = num(v);
  if (n === 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Human labels for capture.status. Unknown values pass through rather than vanish. */
export const STATUS_LABEL: Record<string, string> = {
  ok: 'OK',
  enable_required: 'Enable required',
  auth_failed: 'Auth failed',
  unreachable: 'Unreachable',
  timeout: 'Timeout',
  host_key_mismatch: 'Host key mismatch',
};

export const VENDOR_LABEL: Record<string, string> = {
  cisco_ios: 'Cisco IOS',
  cisco_nxos: 'Cisco NX-OS',
  arista_eos: 'Arista EOS',
  junos: 'Juniper Junos',
  panos: 'Palo Alto PAN-OS',
  fortios: 'Fortinet FortiOS',
};
