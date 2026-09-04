"""Per-vendor capture recipes.

One dict entry per vendor: which command yields the running config, which yields
the startup config, and how to recognise a privilege problem in the OUTPUT.

Deliberately not a class hierarchy. Each vendor differs only in a handful of
strings, so a table is the whole abstraction - an adapter base class with six
one-method subclasses would be more code saying less.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Adapter:
    """How to capture a config from one vendor's CLI."""

    #: Command that prints the running configuration.
    running: str
    #: Command that prints the saved/startup configuration. Empty = unsupported.
    startup: str = ""
    #: Commands to run first, to stop the device paginating its own output.
    #: With exec_command most platforms do not paginate, but the ones that do
    #: will otherwise return a config truncated at the first ---More--- prompt.
    pager_off: tuple[str, ...] = ()
    #: Substrings that mean "the command was rejected for lack of privilege".
    #: Checked case-insensitively against the captured output.
    privilege_errors: tuple[str, ...] = field(
        default=(
            "invalid input detected",
            "% incomplete command",
            "permission denied",
            "authorization failed",
            "% invalid command",
        )
    )
    #: Substrings that mean the command itself was not understood - a wrong
    #: adapter for the device, rather than a privilege problem.
    unknown_command_errors: tuple[str, ...] = field(
        default=("unknown command", "syntax error", "invalid command name")
    )


ADAPTERS: dict[str, Adapter] = {
    "cisco_ios": Adapter(
        running="show running-config",
        startup="show startup-config",
        pager_off=("terminal length 0",),
    ),
    "cisco_nxos": Adapter(
        running="show running-config",
        startup="show startup-config",
        pager_off=("terminal length 0",),
    ),
    "arista_eos": Adapter(
        running="show running-config",
        startup="show startup-config",
        pager_off=("terminal length 0",),
    ),
    "junos": Adapter(
        # `display set` produces one self-contained `set ...` line per statement,
        # which diffs far more usefully than the nested brace format.
        running="show configuration | display set | no-more",
        # Junos has no separate startup config - a commit IS the saved state, so
        # there is nothing to compare and no unsaved-changes concept.
        startup="",
    ),
    "panos": Adapter(
        running="show config running",
        # `show config saved` needs a filename argument on most PAN-OS versions,
        # so there is no single portable command.
        startup="",
        pager_off=("set cli pager off",),
    ),
    "fortios": Adapter(
        running="show full-configuration",
        # FortiOS writes config on change; there is no separate startup copy.
        startup="",
        pager_off=("config system console", "set output standard", "end"),
    ),
}


def get_adapter(vendor: str) -> Adapter:
    """Look up an adapter, failing loudly on an unknown vendor.

    The schema constrains `vendor` to an enum, so an unknown value here means
    the schema and this table have drifted apart - worth an exception rather
    than a silent fallback that would capture nothing useful.
    """
    try:
        return ADAPTERS[vendor]
    except KeyError:
        raise ValueError(
            f"no adapter for vendor {vendor!r}; known vendors: {', '.join(sorted(ADAPTERS))}"
        ) from None


#: A real CLI rejection ("% Invalid input detected...", "authorization failed")
#: IS the entire output, and it is short - a handful of words. A real config,
#: even a small one, runs to hundreds of lines. Confirmed the hard way: a real
#: FortiGate's default config was misclassified as enable_required because a
#: stock web-filter replacemsg template 38,000 lines in contains the literal
#: text "authorization failed" as denial-page copy, not a device response.
#: Bounding the check to short output only is what makes generic phrase
#: matching safe against arbitrary real config content.
REJECTION_LENGTH_LIMIT = 1024


def classify_output(adapter: Adapter, output: str) -> str | None:
    """Return a capture.status for a failed capture, or None if it looks fine.

    Network gear answers a command it will not run with a *successful* SSH exit
    and an error string in stdout, so the exit code cannot be trusted. In
    particular a device left in user EXEC returns an error here rather than a
    prompt - with exec_command there is no prompt to inspect at all, which is
    why this checks the output instead.
    """
    stripped = output.strip()
    if not stripped:
        return "empty_output"

    if len(stripped) > REJECTION_LENGTH_LIMIT:
        # Long output cannot be a bare rejection message - it is config text
        # that happens to mention one of these phrases somewhere in it.
        return None

    low = stripped.lower()
    for needle in adapter.privilege_errors:
        if needle in low:
            return "enable_required"
    for needle in adapter.unknown_command_errors:
        if needle in low:
            return "wrong_adapter"
    return None
