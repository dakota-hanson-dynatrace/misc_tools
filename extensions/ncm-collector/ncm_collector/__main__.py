"""custom:ncm-collector - network configuration backup collector.

STATELESS BY REQUIREMENT. This connects, captures, hashes, forwards. It keeps no
cache, holds no previous config, and makes no comparison. Deciding what changed
is tenant-side work (see the app's ncmPromote function). Do not add local state
here - not a known_hosts file, not a last-hash cache, nothing.

What it emits per device, per run:
  - one `index` record: the hash, status, size, host-key fingerprint
  - one or more `capture` blobs: the RAW config text, chunked

Read-only. It never writes to a device.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from dynatrace_extension import Extension, Status, StatusValue

from .adapters import classify_output, get_adapter
from .records import build_blob_records, build_index_record, byte_length, config_hash
from .ssh_client import Credentials, HostKeyMismatch, capture

#: Fallback only - the real value is activation_config["advanced"]["capture_interval_hours"],
#: read in initialize(). Config backup is a daily job, not a metric poll; the schema bounds
#: this to 1-168h so it can never be tightened into a per-minute poll.
DEFAULT_CAPTURE_INTERVAL_HOURS = 24

#: Stagger against other monitoring configurations on the same ActiveGate, which
#: share a CPU/RAM budget with this one.
CAPTURE_OFFSET_SECONDS = 30.0


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


class NcmCollectorExtension(Extension):
    def initialize(self):
        self.extension_name = "custom:ncm-collector"

        # Deliberately NOT implementing query(): that is pre-registered to run
        # every minute, and hammering SSH on network gear once a minute would be
        # both useless and rude. A long interval is registered instead.
        advanced = self.activation_config.get("advanced") or {}
        interval_hours = int(advanced.get("capture_interval_hours", DEFAULT_CAPTURE_INTERVAL_HOURS))
        self.schedule(
            self.capture_all,
            timedelta(hours=interval_hours),
            offset_seconds=CAPTURE_OFFSET_SECONDS,
        )

    def fastcheck(self) -> Status:
        """Validate the configuration without touching a device.

        Connectivity is deliberately not tested here: a fastcheck that SSHes to
        every device turns a config save into a fleet-wide connection storm.
        """
        devices = self.activation_config.get("devices") or []
        if not devices:
            return Status(StatusValue.ERROR, "no devices configured")

        for d in devices:
            vendor = d.get("vendor")
            try:
                get_adapter(vendor)
            except ValueError as e:
                return Status(StatusValue.ERROR, str(e))
            if not d.get("hostname"):
                return Status(StatusValue.ERROR, f"device {d.get('alias')!r} has no hostname")

        enabled = [d for d in devices if d.get("enabled", True)]
        return Status(StatusValue.OK, f"{len(enabled)} of {len(devices)} devices enabled")

    # ---------------------------------------------------------------- helpers

    def _credentials(self, device: dict) -> Credentials:
        """Resolve credentials for one device.

        The EEC has already replaced any credential-vault reference with the
        plaintext username/password by the time this runs, so there is nothing to
        look up here.

        NEVER log the object this returns, and never log the activation config -
        both carry secrets in the clear.
        """
        block = (
            self.activation_config.get("global_credentials")
            if device.get("use_global_credentials", True)
            else device.get("credentials")
        ) or {}

        if block.get("scheme") == "ssh_key":
            return Credentials(
                username=block.get("username", ""),
                private_key=block.get("ssh_key_contents"),
                key_passphrase=block.get("key_passphrase"),
            )
        return Credentials(
            username=block.get("username", ""),
            password=block.get("password"),
        )

    def _emit(self, record: dict) -> None:
        """Send one record.

        ONE per call, never report_log_events(). The EEC sizes a batch by
        counting dict KEYS rather than bytes, so its batching is byte-blind: 50
        records of 200 kB were measured going out as a single 10 MB POST. Sending
        singly keeps request size under our own control.
        """
        self.report_log_event(record)

    def _device_attrs(self, device: dict) -> dict:
        return {
            "ncm.device.name": device.get("alias") or device.get("hostname"),
            "ncm.device.address": device.get("hostname"),
            "ncm.vendor": device.get("vendor"),
            "ncm.site": device.get("site") or None,
        }

    def _capture_one(self, device: dict, capture_id: str, capture_time: str) -> None:
        """Capture one device and emit its records. Never raises."""
        alias = device.get("alias") or device.get("hostname")
        attrs = self._device_attrs(device)
        adapter = get_adapter(device["vendor"])
        advanced = self.activation_config.get("advanced") or {}
        host_key = device.get("host_key") or {}

        commands = [adapter.running]
        want_startup = bool(advanced.get("capture_startup_config", True)) and bool(adapter.startup)

        try:
            result = capture(
                hostname=device["hostname"],
                port=int(device.get("port", 22)),
                creds=self._credentials(device),
                commands=commands,
                pager_off=adapter.pager_off,
                host_key_policy=host_key.get("policy", "trust_on_first_use"),
                expected_fingerprint=host_key.get("fingerprint"),
                connect_timeout=int(advanced.get("connect_timeout_seconds", 20)),
                command_timeout=int(advanced.get("command_timeout_seconds", 120)),
                disabled_algorithms=advanced.get("disabled_algorithms") or "",
            )
        except HostKeyMismatch as e:
            self.logger.warning(f"{alias}: host key mismatch: {e}")
            self._emit(
                build_index_record(
                    device_id=capture_id.rsplit("-", 1)[0],
                    capture_id=capture_id,
                    capture_time=capture_time,
                    status="host_key_mismatch",
                    attrs=attrs,
                )
            )
            return
        except Exception as e:  # noqa: BLE001 - one device must not sink the run
            status = "timeout" if "timed out" in str(e).lower() else "unreachable"
            if "authentication" in str(e).lower():
                status = "auth_failed"
            # Log the exception TYPE and a short message only. A paramiko error
            # can echo connection parameters, and this must not leak a secret.
            self.logger.warning(f"{alias}: {status}: {type(e).__name__}")
            self._emit(
                build_index_record(
                    device_id=device["_device_id"],
                    capture_id=capture_id,
                    capture_time=capture_time,
                    status=status,
                    attrs=attrs,
                )
            )
            return

        device_id = device["_device_id"]
        problem = classify_output(adapter, result.output)
        if problem:
            self.logger.warning(f"{alias}: capture rejected by device: {problem}")
            self._emit(
                build_index_record(
                    device_id=device_id,
                    capture_id=capture_id,
                    capture_time=capture_time,
                    status=problem,
                    host_key_fingerprint=result.host_key_fingerprint,
                    attrs=attrs,
                )
            )
            return

        raw = result.output
        digest = config_hash(raw)

        self._emit(
            build_index_record(
                device_id=device_id,
                capture_id=capture_id,
                capture_time=capture_time,
                status="ok",
                config_hash_value=digest,
                size_bytes=byte_length(raw),
                host_key_fingerprint=result.host_key_fingerprint,
                attrs=attrs,
            )
        )
        for blob in build_blob_records(
            raw,
            device_id=device_id,
            capture_id=capture_id,
            capture_time=capture_time,
            record_type="capture",
            attrs={**attrs, "ncm.config.type": "running", "ncm.config.hash": digest},
        ):
            self._emit(blob)

        if advanced.get("log_command_output"):
            # Opt-in, documented as debugging-only: device output can contain
            # secrets (SNMP communities, pre-shared keys, hashed passwords).
            self.logger.debug(f"{alias} output ({byte_length(raw)} bytes)")

        # startup-config, for the unsaved-changes report. A failure here must not
        # invalidate the running-config capture that already succeeded.
        if want_startup:
            try:
                st = capture(
                    hostname=device["hostname"],
                    port=int(device.get("port", 22)),
                    creds=self._credentials(device),
                    commands=[adapter.startup],
                    pager_off=adapter.pager_off,
                    host_key_policy=host_key.get("policy", "trust_on_first_use"),
                    expected_fingerprint=host_key.get("fingerprint"),
                    connect_timeout=int(advanced.get("connect_timeout_seconds", 20)),
                    command_timeout=int(advanced.get("command_timeout_seconds", 120)),
                    disabled_algorithms=advanced.get("disabled_algorithms") or "",
                )
            except Exception as e:  # noqa: BLE001
                self.logger.info(f"{alias}: startup-config capture skipped: {type(e).__name__}")
                return
            if classify_output(adapter, st.output):
                return
            st_digest = config_hash(st.output)
            st_capture_id = f"{capture_id}-startup"
            self._emit(
                build_index_record(
                    device_id=device_id,
                    capture_id=st_capture_id,
                    capture_time=capture_time,
                    status="ok",
                    config_type="startup",
                    config_hash_value=st_digest,
                    size_bytes=byte_length(st.output),
                    attrs=attrs,
                )
            )
            for blob in build_blob_records(
                st.output,
                device_id=device_id,
                capture_id=st_capture_id,
                capture_time=capture_time,
                record_type="capture",
                attrs={**attrs, "ncm.config.type": "startup", "ncm.config.hash": st_digest},
            ):
                self._emit(blob)

    # ------------------------------------------------------------- entrypoint

    def capture_all(self):
        """Capture every enabled device in this task's bucket.

        Sequential on purpose. The EEC allows 5% CPU / 500 MB RAM per monitoring
        configuration and kills the most recently started task first on a hard
        breach, so a late-starting parallel fan-out is the first casualty.
        Devices are already spread across ActiveGates by the bucket split
        declared in extension.yaml - parallelism here would fight that, not add
        to it.
        """
        devices = [d for d in (self.activation_config.get("devices") or []) if d.get("enabled", True)]
        capture_time = _now_iso()
        # Date ONLY, not the full timestamp: capture_id must be deterministic
        # per calendar day, or a retried/re-triggered run within the same day
        # mints a second, undeduped index+capture record - every fleet count
        # in the app inflates and versionPeriods' revert math (which assumes
        # exactly one capture per day) breaks.
        stamp = capture_time[:10]

        ok = 0
        failed = 0
        for device in devices:
            # Stable, deterministic id: the app dedups on capture id because
            # Grail is append-only and a retried run would otherwise double every
            # count.
            device_id = f"dev-{device.get('alias') or device.get('hostname')}"
            device["_device_id"] = device_id
            capture_id = f"{device_id}-{stamp}"
            try:
                self._capture_one(device, capture_id, capture_time)
                ok += 1
            except Exception as e:  # noqa: BLE001 - never let one device end the run
                failed += 1
                self.logger.error(f"{device.get('alias')}: unhandled {type(e).__name__}")

        self.logger.info(f"capture run complete: {ok} attempted, {failed} unhandled errors")


def main():
    NcmCollectorExtension(name="ncm_collector").run()


if __name__ == "__main__":
    main()
