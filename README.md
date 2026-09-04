# misc_tools

A collection of personal tools, integrations, and infrastructure code:

- `custom_apps/` — custom Dynatrace apps
- `custom_integrations/` — third-party API → Dynatrace polling integrations (workflow + dashboard pairs)
- `extensions/` — Extensions 2.0 (EF2) extensions
- `terraform/` — infrastructure modules

A project that's genuinely one product split across multiple runtimes (e.g. a custom app paired
with its own extension, with neither useful without the other) gets its own top-level folder
instead of being scattered across the type-based ones above - see [`ncm/`](ncm/) for the pattern.

## Disclaimer

These are personal projects developed independently by me (Dakota Hanson), not official
Dynatrace products or supported offerings. There is no official support — if you run
into an issue using anything in this repo, you're welcome to open an issue or reach out
directly, but there's no guarantee of a response or fix.
