"""Building the Grail records a capture produces.

Python mirror of ``app/ui/app/utils/records.ts``. Both exist because there is no
runtime shared between an ActiveGate extension and an AppEngine function; the
app side must be able to reassemble exactly what this side splits.

The load-bearing fact: Grail truncates ``content`` **silently** at 512 KiB. A
6 MB config is accepted with HTTP 200 and stored as its first 524,288 bytes,
with no error anywhere (verified - see spikes/S1-content-size-limit.md). So
splitting is mandatory, it must be measured in UTF-8 BYTES, and every record
carries the expected total so the reader can detect a short arrival.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from .normalize import normalize_config

#: Measured Grail ceiling, not a documented one.
CONTENT_LIMIT_BYTES = 524_288
#: Chunk target, leaving headroom under the ceiling for attributes.
CHUNK_BYTES = 400_000


def byte_length(text: str) -> int:
    return len(text.encode("utf-8"))


def config_hash(raw: str) -> str:
    """SHA-256 of the NORMALIZED text, lowercase hex.

    Must match the TypeScript ``configHash`` byte for byte, hence the explicit
    UTF-8 encoding on both sides.
    """
    return hashlib.sha256(normalize_config(raw).encode("utf-8")).hexdigest()


def chunk_by_bytes(text: str, max_bytes: int = CHUNK_BYTES) -> list[str]:
    """Split so each chunk is at most ``max_bytes`` when UTF-8 encoded.

    Splits on BYTES, not characters. Slicing by character count overflows the
    moment any multi-byte character appears - a UTF-8 banner, a degree sign in
    an interface description - and code points are never split across chunks so
    each chunk stays independently valid UTF-8.
    """
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if text == "":
        return [""]
    if byte_length(text) <= max_bytes:
        return [text]

    chunks: list[str] = []
    current: list[str] = []
    current_bytes = 0

    for ch in text:
        ch_bytes = byte_length(ch)
        if ch_bytes > max_bytes:
            raise ValueError(
                f"single character requires {ch_bytes} bytes, exceeds max_bytes {max_bytes}"
            )
        if current_bytes + ch_bytes > max_bytes:
            chunks.append("".join(current))
            current = []
            current_bytes = 0
        current.append(ch)
        current_bytes += ch_bytes

    if current:
        chunks.append("".join(current))
    return chunks


def _now_iso() -> str:
    """Current UTC time, MILLISECOND precision.

    Not microseconds. `datetime.isoformat()` emits 6 fractional digits, and the
    EEC's log endpoint rejects that with
    `400 One or all logs are out of correct time range.` - the same error a
    genuinely backdated record produces, which makes it look like a clock
    problem rather than a format problem. The app side never hit this because
    JavaScript's toISOString() emits 3 digits.
    """
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_index_record(
    *,
    device_id: str,
    capture_id: str,
    capture_time: str,
    status: str,
    config_type: str = "running",
    config_hash_value: str | None = None,
    size_bytes: int = 0,
    host_key_fingerprint: str | None = None,
    attrs: dict | None = None,
) -> dict:
    """The change-ledger entry. Written for EVERY capture, success or failure.

    A failed capture still gets one: "which devices failed backup last night" is
    a first-class report, and it can only be answered if failures are recorded.
    """
    record = {
        "content": "",
        # Ingest time. Logical time is ncm.capture.time - Grail rejects
        # timestamps older than 24h, so history cannot live here.
        "timestamp": _now_iso(),
        "ncm.capture.time": capture_time,
        "ncm.record.type": "index",
        "ncm.device.id": device_id,
        "ncm.capture.id": capture_id,
        "ncm.config.type": config_type,
        "ncm.capture.status": status,
        "ncm.size.bytes": size_bytes,
    }
    if config_hash_value:
        record["ncm.config.hash"] = config_hash_value
    if host_key_fingerprint:
        record["ncm.host.key.fingerprint"] = host_key_fingerprint
    record.update(attrs or {})
    return record


def build_blob_records(
    content: str,
    *,
    device_id: str,
    capture_id: str,
    capture_time: str,
    record_type: str = "capture",
    attrs: dict | None = None,
) -> list[dict]:
    """The raw config, split into chunks that fit under the silent ceiling.

    ``ncm.content.bytes`` is the total reassembled length and is the assertion
    target on read - it is the only thing that makes truncation detectable.

    Stores the RAW text. Normalization is used only to derive the hash, which is
    what makes a normalizer bug repairable rather than permanently corrupting
    history.
    """
    chunks = chunk_by_bytes(content)
    total = byte_length(content)
    now = _now_iso()

    records = []
    for i, chunk in enumerate(chunks):
        record = {
            "content": chunk,
            "timestamp": now,
            "ncm.capture.time": capture_time,
            "ncm.record.type": record_type,
            "ncm.device.id": device_id,
            "ncm.capture.id": capture_id,
            "ncm.chunk.index": i,
            "ncm.chunk.total": len(chunks),
            "ncm.chunk.bytes": byte_length(chunk),
            "ncm.content.bytes": total,
        }
        record.update(attrs or {})
        records.append(record)
    return records
