# AGENTS.md

TILL is agent-native: an MCP server is a first-class interface, not a bolt-on. This
file is the guide for an AI coding agent (or a contributor driving one) working in
this repository. It is the public counterpart to the human-facing
[CONTRIBUTING.md](CONTRIBUTING.md), and everything here also applies to a human.

## What TILL is

A local-first, MIT-licensed Swiss accounting engine. The books live in a single
SQLite file on the user's machine. Every capability is exposed twice: as an **MCP
verb** an agent can call, and as a **REST twin** with the same behaviour. A
minimalist **Studio** gives a human oversight of what the agent did.

## Layout

| Path | What |
|---|---|
| `src/` | The TypeScript/Node core: the ledger, Swiss compliance, the MCP stdio server. |
| `app/` | The Vite/React Studio (the human oversight GUI). |
| `bin/till.mjs` | The `till` CLI entry point. |
| `site-docs/` | The product documentation (Mintlify), published at docs.tillbooks.ch. |
| `test/` | The test suites, including the money-path invariant suites. |
| `packaging/` | Distribution scaffolding. |
| `brand/` | The design law (`DESIGN.md`) and the design tokens. |

## Build and test

Everything runs offline. Node is the only prerequisite.

```
npm install       # install dependencies
npm run build     # type-check and build the engine
npm test          # run the test suite (offline)
npm run gate      # the full local gate: typecheck, tests, and style checks
```

Run `npm run gate` before you open a pull request. It is the same gate the
maintainers run.

## The rules that are not negotiable

1. **The money path is unforgiving.** Posted entries are append-only and immutable.
   A correction is a **reversing entry**, never a destructive edit. Posting is
   **idempotent**: a double-post must not double-count. Every query is
   **tenant-scoped**. These are asserted in the tests, not merely documented. If
   you touch the money path, the invariant tests must still bite, and a non-author
   must review the change.
2. **Parity.** A write capability ships on BOTH faces: the MCP verb and its REST
   twin. The parity test enforces it. Do not add one without the other.
3. **Clean-room.** TILL is built from public documentation. Never copy code, UI, or
   trade dress from any accounting vendor. Copied code cannot live in an MIT repo.
4. **House style.** No em dashes anywhere: use a colon, a comma, or parentheses. En
   dashes are fine in real ranges. English and de-CH only, with real umlauts (never
   `ae`/`oe`/`ue` as a substitute, and Swiss German has no `ss`-for-`ss` rule to
   invent). Minimalist, one accent, one typeface: build to `brand/DESIGN.md`.
5. **Local-first and private.** Do not add telemetry. Do not make TILL phone home.
   Never commit a secret, a key, or a `.env` file.

## Statutory correctness

TILL encodes Swiss rules (the MWST rates, the QR-bill standard, ISO 20022, the
Kontenrahmen KMU). If you change a statutory value, cite the source. When in doubt,
look it up rather than guessing: a guessed figure in an accounting engine is a
defect, not a shortcut.
