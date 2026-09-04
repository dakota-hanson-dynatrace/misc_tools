# Network Config Manager (`my.ncm`)

One product, two runtimes, kept in one folder because neither half is useful without the other:

- **[`app/`](app/)** — the `my.ncm` Dynatrace custom app (TypeScript/React). Owns all storage,
  comparison, and UI. Shows nothing without real captures.
- **[`collector/`](collector/)** — the `custom:ncm-collector` Extension 2.0 (EF2, Python). SSHes
  to devices and forwards raw config captures to Grail. Stateless - produces records nobody can
  browse without the app.

Deploy both. See [`collector/README.md`](collector/README.md#setup-order) for the setup
sequence (extension first, then the app), and each folder's own `README.md`/`AGENTS.md` for
everything else.

`shared/normalize-fixtures.json` is the cross-language contract both halves' normalizers must
agree on byte-for-byte - see either side's `AGENTS.md` for how it's used.

## Disclaimer

A personal project developed independently by me (Dakota Hanson), not an official Dynatrace
product or supported offering. There is no official support - if you run into an issue, you're
welcome to open an issue or reach out directly, but there's no guarantee of a response or fix.
