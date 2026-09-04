"""Self-check for the capture-path normalizer. Run directly:

    python3 ncm_collector/normalize_selfcheck.py

Runs the SAME fixture file as the paired app's TypeScript self-check
(ui/app/utils/normalize.selfcheck.ts). Both must pass. No test framework -
this is deliberately a plain script so it runs anywhere, including on an
ActiveGate.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ncm_collector.normalize import config_hash, normalize_config  # noqa: E402

# Repo root is 3 levels up from this file, regardless of what the collector's
# own top-level directory is named - this is deliberately relative, not a
# path baked in by name, so a rename can't silently break it.
FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "normalize-fixtures.json"


def main() -> int:
    cases = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 10, "fixture file looks truncated"

    for c in cases:
        got = normalize_config(c["raw"])
        assert got == c["expected"], (
            f'fixture "{c["name"]}" ({c["vendor"]})\n'
            f"  expected: {c['expected']!r}\n"
            f"  actual:   {got!r}"
        )

    # Idempotence: repeated repair passes must not keep changing the hash.
    for c in cases:
        assert normalize_config(c["expected"]) == c["expected"], (
            f'fixture "{c["name"]}" must be idempotent'
        )

    by_name = {c["name"]: c for c in cases}

    # The property the whole design rests on: two polls of an UNCHANGED device
    # that differ only in volatile lines must normalize identically. If this
    # breaks, the promote job writes a new version every night, forever.
    a = by_name["cisco_ios_header_and_timestamps"]
    b = by_name["cisco_ios_unchanged_device_two_polls_match"]
    assert a["raw"] != b["raw"], "the two polls must genuinely differ as raw text"
    assert normalize_config(a["raw"]) == normalize_config(b["raw"]), (
        "two polls of an unchanged device must normalize to the same text"
    )

    # Converse: a real config change must NOT be normalized away.
    ch = by_name["real_change_survives_normalization"]
    assert "ip route 10.0.0.0" in normalize_config(ch["raw"]), (
        "a real config line must survive normalization"
    )

    # Volatile lines must be removed, not blanked - a leftover blank still
    # shifts diff line numbers and makes every diff noisy.
    assert "Building configuration" not in normalize_config(a["raw"])

    h1 = config_hash(a["raw"])
    assert h1 == config_hash(a["raw"]), "hash must be deterministic"
    assert len(h1) == 64 and all(ch in "0123456789abcdef" for ch in h1), (
        "hash must be lowercase hex sha256"
    )
    changed = config_hash(a["raw"] + "\nip route 1.1.1.0 255.255.255.0 10.0.0.1")
    assert h1 != changed, "a real config change must change the hash"

    # Emit the cross-language contract: the TS self-check prints the same digest
    # list, so a drift between implementations is visible by diffing output.
    print(f"normalize_selfcheck: all assertions passed ({len(cases)} fixtures)")
    for c in cases:
        print(f"  {config_hash(c['raw'])}  {c['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
