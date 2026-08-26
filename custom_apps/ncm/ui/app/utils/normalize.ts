// Strips the lines that change between two polls of an UNCHANGED device, so a
// hash of the result is stable. Everything here exists because some vendor puts
// a timestamp, a byte count, or the last operator's username into the config
// output itself.
//
// This runs ONLY to compute a hash. The raw config text is what gets stored, so
// a bug here is repairable: fix the patterns, re-derive hashes from the stored
// raw blobs. That is the whole reason storage is raw and not normalized.
//
// ponytail: this TS copy is the REPAIR path (re-deriving hashes tenant-side).
// The capture path is the Python copy in collector/. They are kept honest by a
// shared fixture file rather than by a shared implementation, because there is
// no runtime common to an ActiveGate extension and an AppEngine function.
// Ceiling: two implementations can drift. If they ever do, the fixtures fail
// first - run both self-checks in CI before trusting a hash comparison.

/** Line-level patterns. A line matching any of these is dropped entirely. */
const VOLATILE_LINE_PATTERNS: RegExp[] = [
  // --- Cisco IOS / IOS-XE ---
  /^Building configuration\.\.\.\s*$/,
  /^Current configuration\s*:\s*\d+\s*bytes\s*$/,
  /^!\s*Last configuration change at .*$/,
  /^!\s*NVRAM config last updated at .*$/,
  // Drifts on its own with no operator action - a classic false-positive source.
  /^ntp clock-period \d+\s*$/,

  // --- Cisco NX-OS ---
  /^!Command:\s*show running-config\s*$/,
  /^!Running configuration last done at:.*$/,
  /^!Time:.*$/,

  // --- Arista EOS ---
  // Only the command echo. The "! device:" line carries the real model and EOS
  // version, which IS meaningful config state - keep it.
  /^!\s*Command:\s*show running-config\s*$/,

  // --- Junos ---
  /^##\s*Last commit:.*$/,

  // --- PAN-OS ---
  /^\s*<last-modified>.*<\/last-modified>\s*$/,

  // --- FortiOS ---
  // Carries :user=<whoever last logged in>, so it changes without a config edit.
  /^#config-version=.*$/,
  /^#conf_file_ver=.*$/,
];

/** A bare comment/separator line - no content, pure visual spacing. */
function isSeparator(line: string): boolean {
  return line === '!';
}

function isTrimmable(line: string): boolean {
  return line === '' || isSeparator(line);
}

/**
 * Normalize config text for hashing.
 *
 * - CRLF and lone CR are folded to LF
 * - trailing whitespace is stripped per line
 * - volatile lines are dropped
 * - leading/trailing blank lines are trimmed
 *
 * Interior blank lines are PRESERVED - a banner or MOTD can legitimately
 * contain them, and collapsing would alter real content. Runs of bare `!`
 * separators ARE collapsed, because they are pure spacing and their count
 * varies with which volatile lines a given poll emitted.
 */
export function normalizeConfig(raw: string): string {
  if (!raw) return '';

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/, '');
    if (VOLATILE_LINE_PATTERNS.some((re) => re.test(trimmed))) continue;

    // Collapse runs of bare `!` separators. Dropping a volatile line from
    // between two of them would otherwise leave a different number of
    // separators depending on which volatile lines that particular poll
    // happened to emit - which is false drift on an unchanged device. `!` is a
    // pure separator in IOS/NX-OS with no semantics, so collapsing is safe.
    // (Caught by normalize.selfcheck's two-poll assertion.)
    if (isSeparator(trimmed) && kept.length > 0 && isSeparator(kept[kept.length - 1])) continue;

    kept.push(trimmed);
  }

  // Trim leading/trailing blank and separator-only lines. A config that starts
  // or ends with `!` carries no more information than one that does not.
  let start = 0;
  let end = kept.length;
  while (start < end && isTrimmable(kept[start])) start++;
  while (end > start && isTrimmable(kept[end - 1])) end--;

  return kept.slice(start, end).join('\n');
}

/**
 * SHA-256 of the normalized text, lowercase hex. This is the value compared
 * between captures to decide whether a config actually changed.
 *
 * Must match the Python collector's hash byte-for-byte, hence the explicit
 * UTF-8 encoding on both sides.
 */
export async function configHash(raw: string): Promise<string> {
  const normalized = normalizeConfig(raw);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
