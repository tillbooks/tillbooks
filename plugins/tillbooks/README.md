# TILL plugin

TILL is a free, open-source (MIT) ERP for Swiss small businesses: sales, purchasing, payments, stock,
projects, books and MWST. This plugin connects your agent to TILL as a local MCP server. Every
function of TILL is a tool, and your books are one SQLite file on your own computer.

By default, the agent waits for your OK before it books anything, moves your money, grants access or
deletes your data for good: it drafts, and you approve in the Studio, the app that shows what the
agent did. Every call the agent makes is recorded.

## Install

In Claude Code:

```
/plugin install tillbooks --marketplace tillbooks/tillbooks
```

The same folder is a Cursor plugin: `.cursor-plugin/plugin.json` points Cursor at `mcp.json`, which
starts the same server.

## What the plugin runs

The plugin declares one MCP server and nothing else (no skills, hooks or scripts). In Claude it
connects to the TILL Studio running on your own machine:

```json
{ "type": "http", "url": "http://127.0.0.1:8788/mcp" }
```

Start the Studio first, in a terminal, and leave it running:

```bash
npx -y tillbooks@1.0.0-beta.3 up
```

`npx` downloads the `tillbooks` package from the npm registry (registry.npmjs.org) the first time.
The Studio listens on 127.0.0.1 only, so nothing outside your computer can reach it. You need
Node.js 22 or newer on macOS or Linux.

In Cursor, `mcp.json` starts the server itself over stdio (`npx -y tillbooks@1.0.0-beta.3 mcp`), so
there the Studio is only needed to see and approve drafts.

## Use it

Ask your agent to set up a company, post an entry, draft an invoice or prepare the MWST-Abrechnung.
To see and approve its drafts, start the Studio in a terminal:

```bash
npx -y tillbooks@1.0.0-beta.3 up
```

It opens at `http://127.0.0.1:8788` and listens on your own machine only.

Your books go to `~/.till/till.db`. Two environment variables are optional: `TILL_DB_PATH` puts the
ledger somewhere else, and `TILL_SUPPORT_DIR` moves the machine-scoped state (diagnostics, backups)
away from `~/.till`. Set them in your shell before you start your agent, or in your MCP client's
server configuration.

The full guides are at [docs.tillbooks.ch](https://docs.tillbooks.ch), and the source is at
[github.com/tillbooks/tillbooks](https://github.com/tillbooks/tillbooks).

## Privacy Policy

TILL is software you run yourself. Nomadik GmbH, which publishes it, does not run a server for it and
receives nothing from it.

- **Data collection.** TILL collects no data about you or how you use it: no account, no sign-up, no
  telemetry, no analytics. Error details are recorded only if you switch that on.
- **Usage and storage.** What you enter (your company, contacts, documents and postings) is stored in
  one SQLite file on your machine, `~/.till/till.db` or the path in `TILL_DB_PATH`. Diagnostics,
  backups and feedback reports you create stay in `~/.till` or `TILL_SUPPORT_DIR`. TILL itself opens
  no outbound connection: the MCP server talks to your agent over stdio or over 127.0.0.1, and the Studio listens on 127.0.0.1 only.
- **Third-party sharing.** TILL shares nothing with anyone. Two things leave your machine because
  other software sends them: `npx` downloads the package from the npm registry, under npm's terms,
  and what your agent reads through TILL's tools becomes part of your conversation with your AI
  provider, under that provider's terms. Files TILL writes for you (an eCH-0217 return, a pain.001
  payment file, an invoice PDF, a feedback report) leave only when you upload or send them yourself.
- **Data retention.** Your data stays on your disk until you delete it. Posted entries are
  append-only, as Swiss bookkeeping requires; a correction is a reversing entry. Deleting the
  database file and `~/.till` removes everything TILL stored. Keeping your books for the statutory
  period (OR Art. 958f) is your responsibility.
- **Contact.** Nomadik GmbH, Männedorf, Switzerland,
  [hello@tillbooks.ch](mailto:hello@tillbooks.ch). The privacy statement for the tillbooks.ch website
  is at [tillbooks.ch/en/legal](https://tillbooks.ch/en/legal/#datenschutz).

## License

MIT. Copyright (c) 2026 Nomadik GmbH. See
[LICENSE](https://github.com/tillbooks/tillbooks/blob/main/LICENSE).
