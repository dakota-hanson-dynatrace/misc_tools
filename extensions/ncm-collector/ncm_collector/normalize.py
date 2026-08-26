"""Config normalization for hashing - the CAPTURE-path implementation.

Strips the lines that change between two polls of an UNCHANGED device, so that a
hash of the result is stable. Everything here exists because some vendor puts a
timestamp, a byte count, or the last operator's username into the config output.

This runs ONLY to compute a hash. The RAW config text is what gets shipped and
stored, so a bug here is repairable: fix the patterns and re-derive hashes from
the stored raw blobs.

MUST stay byte-for-byte identical to the TypeScript implementation in
app/ui/app/utils/normalize.ts. The shared contract is
shared/normalize-fixtures.json - both self-checks run it. If they diverge,
hashes diverge and every device looks permanently changed.
"""

from __future__ import annotations

import hashlib
import re

# Line-level patterns. A line matching any of these is dropped entirely.
VOLATILE_LINE_PATTERNS: list[re.Pattern[str]] = [
    # --- Cisco IOS / IOS-XE ---
    re.compile(r"^Building configuration\.\.\.\s*$"),
    re.compile(r"^Current configuration\s*:\s*\d+\s*bytes\s*$"),
    re.compile(r"^!\s*Last configuration change at .*$"),
    re.compile(r"^!\s*NVRAM config last updated at .*$"),
    # Drifts on its own with no operator action - a classic false-positive source.
    re.compile(r"^ntp clock-period \d+\s*$"),
    # --- Cisco NX-OS ---
    re.compile(r"^!Command:\s*show running-config\s*$"),
    re.compile(r"^!Running configuration last done at:.*$"),
    re.compile(r"^!Time:.*$"),
    # --- Arista EOS ---
    # Only the command echo. "! device:" carries the real model and EOS version,
    # which IS meaningful config state - keep it.
    re.compile(r"^!\s*Command:\s*show running-config\s*$"),
    # --- Junos ---
    re.compile(r"^##\s*Last commit:.*$"),
    # --- PAN-OS ---
    re.compile(r"^\s*<last-modified>.*</last-modified>\s*$"),
    # --- FortiOS ---
    # Carries :user=<whoever last logged in>, so it changes without a config edit.
    re.compile(r"^#config-version=.*$"),
    re.compile(r"^#conf_file_ver=.*$"),
]

_TRAILING_WS = re.compile(r"[ \t]+$")


def _is_separator(line: str) -> bool:
    """A bare comment/separator line - no content, pure visual spacing."""
    return line == "!"


def _is_trimmable(line: str) -> bool:
    return line == "" or _is_separator(line)


def normalize_config(raw: str) -> str:
    """Normalize config text for hashing.

    - CRLF and lone CR are folded to LF
    - trailing whitespace is stripped per line
    - volatile lines are dropped
    - runs of bare ``!`` separators collapse to one
    - leading/trailing blank and separator-only lines are trimmed

    Interior blank lines are PRESERVED - a banner or MOTD can legitimately
    contain them, and collapsing would alter real content.
    """
    if not raw:
        return ""

    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    kept: list[str] = []

    for line in lines:
        trimmed = _TRAILING_WS.sub("", line)
        if any(p.match(trimmed) for p in VOLATILE_LINE_PATTERNS):
            continue

        # Collapse runs of bare `!`. Dropping a volatile line from between two
        # separators would otherwise leave a different number of them depending
        # on which volatile lines that poll emitted - false drift on an
        # unchanged device.
        if _is_separator(trimmed) and kept and _is_separator(kept[-1]):
            continue

        kept.append(trimmed)

    start, end = 0, len(kept)
    while start < end and _is_trimmable(kept[start]):
        start += 1
    while end > start and _is_trimmable(kept[end - 1]):
        end -= 1

    return "\n".join(kept[start:end])


def config_hash(raw: str) -> str:
    """SHA-256 of the normalized text, lowercase hex.

    Explicit UTF-8 encoding so this matches the TS side's TextEncoder exactly.
    """
    return hashlib.sha256(normalize_config(raw).encode("utf-8")).hexdigest()
