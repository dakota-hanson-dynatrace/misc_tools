"""SSH transport for config capture.

Bare paramiko, no netmiko. The first-party Remote Unix Monitoring 2.0 extension
makes the same choice, and netmiko's 100+ device drivers and TextFSM parsing buy
nothing here: each vendor needs one command and one output, which `adapters.py`
already expresses as a table.

Host key handling is the security-critical part. A `known_hosts` file would be
state on the ActiveGate, which the stateless requirement forbids, so the expected
fingerprint lives in the monitoring configuration instead.
"""

from __future__ import annotations

import base64
import hashlib
import io
from dataclasses import dataclass

import paramiko


def fingerprint(key: paramiko.PKey) -> str:
    """OpenSSH-style SHA256 fingerprint, matching `ssh-keygen -lf`."""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


class HostKeyMismatch(Exception):
    """The device presented a host key other than the pinned one."""


class _RecordingPolicy(paramiko.MissingHostKeyPolicy):
    """Records the presented host key, and enforces a pin when one is configured.

    Three behaviours, chosen per device by `host_key.policy`:

    - ``pinned``             reject anything but the configured fingerprint
    - ``trust_on_first_use`` accept, and report what was seen so an operator can
                             approve it; enforce it once approved
    - ``accept_any``         accept unconditionally (insecure, offered but labelled)
    """

    def __init__(self, policy: str, expected: str | None):
        self.policy = policy
        self.expected = (expected or "").strip()
        self.observed: str | None = None

    def missing_host_key(self, client, hostname, key):  # noqa: ANN001, ANN201
        self.observed = fingerprint(key)

        if self.policy == "accept_any":
            return
        if self.expected:
            # A pin is configured - enforce it regardless of policy, so an
            # approved TOFU fingerprint is genuinely protective afterwards.
            if self.observed != self.expected:
                raise HostKeyMismatch(
                    f"{hostname} presented {self.observed}, expected {self.expected}"
                )
            return
        if self.policy == "pinned":
            raise HostKeyMismatch(
                f"{hostname}: policy is 'pinned' but no expected fingerprint is configured"
            )
        # trust_on_first_use with nothing pinned yet: accept and report.
        return


@dataclass
class Credentials:
    username: str
    password: str | None = None
    private_key: str | None = None
    key_passphrase: str | None = None


@dataclass
class CaptureResult:
    output: str
    host_key_fingerprint: str | None


def _load_key(pem: str, passphrase: str | None) -> paramiko.PKey:
    """Load a private key without caring which algorithm it is.

    paramiko has no single "load any key" entry point, so each type is tried in
    turn. Ed25519 first: it is the modern default and the cheapest to reject.
    """
    last_error: Exception | None = None
    for loader in (
        paramiko.Ed25519Key,
        paramiko.ECDSAKey,
        paramiko.RSAKey,
        paramiko.DSSKey,
    ):
        try:
            return loader.from_private_key(io.StringIO(pem), password=passphrase or None)
        except Exception as e:  # noqa: BLE001 - genuinely want the next loader
            last_error = e
    raise ValueError(f"could not load private key as any supported type: {last_error}")


def capture(
    *,
    hostname: str,
    port: int,
    creds: Credentials,
    commands: list[str],
    pager_off: tuple[str, ...] = (),
    host_key_policy: str = "trust_on_first_use",
    expected_fingerprint: str | None = None,
    connect_timeout: int = 20,
    command_timeout: int = 120,
    disabled_algorithms: str = "",
) -> CaptureResult:
    """Connect, run the commands, return their combined output.

    One connection per call, closed on the way out. Connection reuse is
    deliberately not implemented: the Remote Unix extension offers it, but on a
    24-hour schedule a held-open socket buys nothing and only adds a way to
    leak file descriptors.
    """
    policy = _RecordingPolicy(host_key_policy, expected_fingerprint)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(policy)

    # Legacy gear frequently needs an algorithm turned off - the first-party
    # Remote Unix extension ships a `disable_rsa2` toggle for exactly this.
    disabled: dict[str, list[str]] = {}
    names = [a.strip() for a in disabled_algorithms.split(",") if a.strip()]
    if names:
        disabled = {"pubkeys": names, "keys": names}

    pkey = None
    if creds.private_key:
        pkey = _load_key(creds.private_key, creds.key_passphrase)

    try:
        client.connect(
            hostname=hostname,
            port=port,
            username=creds.username,
            password=creds.password if pkey is None else None,
            pkey=pkey,
            timeout=connect_timeout,
            banner_timeout=connect_timeout,
            auth_timeout=connect_timeout,
            look_for_keys=False,   # never read the ActiveGate user's own keys
            allow_agent=False,     # nor an agent that happens to be running
            disabled_algorithms=disabled or None,
        )

        chunks: list[str] = []
        for cmd in [*pager_off, *commands]:
            _in, out, err = client.exec_command(cmd, timeout=command_timeout)
            text = out.read().decode("utf-8", errors="replace")
            stderr = err.read().decode("utf-8", errors="replace")
            # Pager-disable commands are housekeeping; their output is noise and
            # must not end up inside the captured config.
            if cmd in pager_off:
                continue
            chunks.append(text if text.strip() else stderr)

        return CaptureResult(
            output="\n".join(chunks),
            host_key_fingerprint=policy.observed,
        )
    finally:
        client.close()
