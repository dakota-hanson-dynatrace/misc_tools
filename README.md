# misc_tools

A collection of personal tools, integrations, and infrastructure code:

- `custom_apps/` — custom Dynatrace apps
- `custom_integrations/` — third-party API → Dynatrace polling integrations (workflow + dashboard pairs)
- `extensions/` — Extensions 2.0 (EF2) extensions. Some pair with a `custom_apps/` entry as two
  halves of one product (see each side's README for which) - deploy both, not just the one
  that looks self-contained.
- `terraform/` — infrastructure modules

## Disclaimer

These are personal projects developed independently by me (Dakota Hanson), not official
Dynatrace products or supported offerings. There is no official support — if you run
into an issue using anything in this repo, you're welcome to open an issue or reach out
directly, but there's no guarantee of a response or fix.
