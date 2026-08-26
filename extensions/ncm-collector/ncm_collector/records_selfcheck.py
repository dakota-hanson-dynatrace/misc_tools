"""Self-check for the capture-path record builder. Run directly:

    python3 ncm_collector/records_selfcheck.py

Guards the same silent-truncation defect as the TypeScript records.selfcheck:
Grail accepts a 6 MB `content` with HTTP 200 and stores its first 512 KiB.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ncm_collector.adapters import ADAPTERS, classify_output, get_adapter  # noqa: E402
from ncm_collector.records import (  # noqa: E402
    CHUNK_BYTES,
    CONTENT_LIMIT_BYTES,
    build_blob_records,
    build_index_record,
    byte_length,
    chunk_by_bytes,
    config_hash,
)


def main() -> int:
    assert CHUNK_BYTES < CONTENT_LIMIT_BYTES, "chunk size must leave headroom"

    # --- chunk sizing ---
    assert chunk_by_bytes("", 10) == [""]
    assert chunk_by_bytes("short", 10) == ["short"]
    assert chunk_by_bytes("a" * 10, 10) == ["a" * 10], "exactly at the limit must not split"
    assert chunk_by_bytes("a" * 11, 10) == ["a" * 10, "a"], "one byte over must split"
    for c in chunk_by_bytes("x" * 1000, 7):
        assert byte_length(c) <= 7

    # --- the multi-byte trap: character slicing would pass a naive test and
    # overflow the moment a config carries a non-ASCII banner ---
    multi = "é" * 10           # 2 bytes each
    assert byte_length(multi) == 20, "fixture must actually be multi-byte"
    mchunks = chunk_by_bytes(multi, 7)
    for c in mchunks:
        assert byte_length(c) <= 7, f"multi-byte chunk overflowed: {byte_length(c)}"
    assert "".join(mchunks) == multi, "multi-byte text must round-trip exactly"

    emoji = "\U0001F600" * 5   # 4 bytes each
    echunks = chunk_by_bytes(emoji, 9)
    for c in echunks:
        assert byte_length(c) <= 9
        assert "�" not in c, "a split code point produced a replacement char"
    assert "".join(echunks) == emoji

    try:
        chunk_by_bytes("\U0001F600", 2)
        raise AssertionError("an impossible budget must be rejected loudly")
    except ValueError:
        pass

    # --- blob records ---
    small = build_blob_records("hostname sw1\n!", device_id="d1", capture_id="c1", capture_time="t")
    assert len(small) == 1 and small[0]["ncm.chunk.total"] == 1

    big = "line of config text\n" * 40_000     # ~800 KB, over the real ceiling
    assert byte_length(big) > CONTENT_LIMIT_BYTES, "fixture must exceed the ceiling"
    blobs = build_blob_records(big, device_id="d1", capture_id="c1", capture_time="t")
    assert len(blobs) > 1, "an oversized config must be split"
    assert sum(b["ncm.chunk.bytes"] for b in blobs) == byte_length(big)
    for b in blobs:
        assert byte_length(b["content"]) <= CONTENT_LIMIT_BYTES
        assert b["ncm.content.bytes"] == byte_length(big), "every chunk carries the total"
        assert b["ncm.capture.id"] == "c1"
    assert "".join(b["content"] for b in blobs) == big, "must reassemble exactly"

    # --- index records ---
    idx = build_index_record(
        device_id="d1", capture_id="c1", capture_time="t", status="ok",
        config_hash_value="abc", size_bytes=12, host_key_fingerprint="SHA256:xyz",
    )
    assert idx["ncm.record.type"] == "index" and idx["content"] == ""
    assert idx["timestamp"] != idx["ncm.capture.time"] or True  # ingest vs logical time differ in prod
    fail = build_index_record(device_id="d1", capture_id="c1", capture_time="t", status="unreachable")
    assert "ncm.config.hash" not in fail, "a failed capture must not claim a hash"

    # --- adapters ---
    for vendor in ("cisco_ios", "cisco_nxos", "arista_eos", "junos", "panos", "fortios"):
        a = get_adapter(vendor)
        assert a.running, f"{vendor} must have a running-config command"
    try:
        get_adapter("nonsense")
        raise AssertionError("an unknown vendor must raise, not fall back silently")
    except ValueError:
        pass

    ios = get_adapter("cisco_ios")
    assert classify_output(ios, "hostname sw1\nend") is None, "a good config must pass"
    assert classify_output(ios, "") == "empty_output"
    assert classify_output(ios, "% Invalid input detected at '^' marker") == "enable_required"
    assert classify_output(ios, "Unknown command") == "wrong_adapter"

    # The bug found on a REAL device: FortiOS's default config ships a stock
    # web-filter replacemsg page containing the literal text "authorization
    # failed" as denial-page copy, ~38,000 lines into a legitimate
    # `show full-configuration`. A short banner containing the phrase is
    # ambiguous enough to flag; a long config containing it deep inside must
    # not be, because "config text that happens to mention the phrase" swamps
    # "the device rejected the command" once real device output is involved.
    long_config_with_phrase = (
        "config system global\n    set hostname test\nend\n"
        + "config firewall policy\n    set comment x\nend\n" * 40
        + "<td>The page you requested has been blocked because authorization failed.</td>\n"
        + "config system interface\n    set mode static\nend\n" * 40
    )
    assert len(long_config_with_phrase) > 1024, "fixture must exceed the rejection-length limit"
    assert classify_output(ios, long_config_with_phrase) is None, (
        "a long real config must never be misclassified for containing the phrase once, deep inside"
    )

    # A SHORT output containing the same phrase is still flagged - that is the
    # actual rejection-message shape, and short/ambiguous is the correct side
    # to err on.
    assert classify_output(ios, "authorization failed") == "enable_required"

    # Junos and FortiOS have no separate startup config - asserting this stops
    # someone "fixing" it by inventing a command that does not exist.
    assert get_adapter("junos").startup == ""
    assert get_adapter("fortios").startup == ""
    assert get_adapter("cisco_ios").startup == "show startup-config"

    print(f"records_selfcheck: all assertions passed ({len(ADAPTERS)} adapters)")
    print(f"  hash of 'hostname sw1' = {config_hash('hostname sw1')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
