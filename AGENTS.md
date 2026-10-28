# AGENTS.md

TILL is an agent-first ERP for Swiss SMEs: an MCP server is a first-class
interface, not a bolt-on. This file is the guide for an AI coding agent (or a
contributor driving one) working in this repository. It is the public counterpart to the human-facing
[CONTRIBUTING.md](CONTRIBUTING.md), and everything here also applies to a human.

## What TILL is

A local-first, MIT-licensed ERP for Swiss SMEs: sales, purchasing, payments,
stock, projects, books and MWST. The books live in a single SQLite file on the
user's machine. Every capability is exposed twice: as an **MCP
verb** an agent can call, and as a **REST twin** with the same behaviour. A
minimalist **Studio** gives a human oversight of what the agent did.

## If you are setting TILL up or running it for someone

This section is for an agent that was asked to install TILL and work in it on a person's behalf (the
setup prompt on tillbooks.ch/en/start sends you here). The rest of this file is for working on the
code.

1. **Install and start.** Node.js 22 or newer on macOS or Linux, then `npm install -g tillbooks@beta`
   and `till up`. Keep the `@beta`: a plain `tillbooks` on npm is still the old 0.1.0 with no Studio.
   `till up` serves the Studio at `http://127.0.0.1:8788` and the MCP endpoint at
   `http://127.0.0.1:8788/mcp`, on the person's own machine only. A client that only speaks stdio
   runs `npx -y tillbooks@beta mcp`; both work on the same file (`~/.till/till.db`, or `TILL_DB_PATH`).
2. **Demo first.** Until the person says otherwise, work in the demo company: they choose
   "Try the demo" ("Demo ausprobieren") on the Studio's first screen. Do not create, restore or adopt
   real books on your own initiative.
3. **You draft, the person decides.** TILL tells the person: "By default, your agent waits for your OK
   before it books anything, moves your money, grants access or deletes your data for good." Keep that
   true. When a write comes back as a proposal waiting for approval, say so: the person decides it in the Studio, under Attention (Pendenzen in German) or Agent > Proposals. Never try to approve it yourself or to route around the wait.
4. **Never handle secrets.** Do not read, type, store or ask for a password, an e-banking login, an
   EBICS key or a card number. The person enters those in the Studio themselves.
5. **Stay inside TILL.** The approval dial covers agents that connect to TILL. An agent that can drive
   your browser or run commands on your computer can act as you: give your agent TILL, not your
   browser or your shell. Once TILL runs, do the bookkeeping through its MCP tools, not by opening the
   SQLite file or clicking through the Studio as the person.
6. **Say what you did.** After each step, tell the person in plain language what changed and where
   they can see it in the Studio.

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
3. **Copy nothing.** TILL is built from public documentation. Never copy code, UI, or
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
