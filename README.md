# TILL

**Trusted Independent Ledger Library.** An agent-first ERP for Swiss SMEs.

TILL is a free, open-source (MIT) ERP for Swiss small businesses: sales, purchasing, payments, stock,
projects, books and MWST. Every function is exposed as an MCP tool, 822 of them, so your AI agent runs
it and the Studio (the app you work in) shows you what it did. It works with Claude Desktop, Cursor
and other MCP clients that can start a local stdio server. TILL runs on your own computer, or on a
server you host yourself. Your books are a single SQLite file on that machine, and no server of ours
holds a copy.

By default, the agent waits for your OK before it books anything, moves your money, grants access
or deletes your data for good: it drafts, and you approve. For each of
those areas you decide whether it may act on its own. Much of what you can change back, such
as drafts and contact details, runs without asking, and every call the agent makes is recorded.
The dial covers agents that connect to TILL. An agent that can drive your browser or run commands on
your computer can act as you: give your agent TILL, not your browser or your shell.

> **Public beta, version 1.0.0-beta.1.** Nomadik GmbH, the company behind TILL, keeps its own books
> in it. If you move your books to TILL, keep your old system running until the figures match, and
> read [what the beta does not do yet](#what-the-beta-does-not-do-yet) first.

## Why

TILL is MIT licensed and costs nothing. You can run it, change it and keep it, with no limit on
users, companies or bookings, and your books stay on a computer you control. It is built for what
makes Swiss books Swiss:

- **QR-bill** (Swiss QR-Rechnung) with the structured-address standard
- **MWST** at 8.1%, 3.8% and 2.6%, with the effective and the Saldosteuersatz method, and the
  MWST-Abrechnung drawn straight from the ledger
- **Kontenrahmen KMU** seeded out of the box
- **ISO 20022** banking: camt.053 statements in, pain.001 payment files out
- de-CH and en

## What TILL covers

- Accounting: double-entry ledger, period locks and year close, foreign currencies and revaluation,
  accruals, fixed assets, and several companies in one install.
- MWST: the MWST-Abrechnung per period, reconciled to the ledger, and the eCH-0217 file you upload
  to the ESTV ePortal.
- Sales: quotes, orders, delivery notes, invoices with the QR-bill, credit notes, recurring invoices,
  reminder letters and the open-items list.
- Purchasing: supplier bills with input VAT, purchase orders, goods receipt, expense claims, and
  pain.001 payment files that you release in your eBanking. TILL never sends a payment.
- Bank: import the camt.053 statements from your eBanking. The bank inbox proposes a booking for
  each line it can place, and you confirm it.
- Contacts and CRM, products and stock (warehouses, lots and serial numbers, stock valuation),
  projects and time tracking, documents, reports.
- Moving in: import from bexio's CSV and Excel exports (there is no bexio API connection), a trial
  company to try the import on, and a parallel run that checks TILL's figures against your old
  system. Fixed assets, stock and payroll history do not come over, and last year's journal lands
  in a read-only archive beside the live books.

## The ledger is not negotiable

Posted entries are append-only and immutable. A correction is a **reversing entry**, never a
destructive edit, exactly as real accounting works. Posting is idempotent: a double-post does not
double-count. These are asserted in the test suite, not merely promised in a README.

## Install and run

You need Node.js 22 or newer on macOS or Linux. The quickest way in is to let your agent do it:
[tillbooks.ch/en/start](https://tillbooks.ch/en/start/) has a setup prompt for Claude Code (terminal or
desktop app), Cursor or Windsurf: it installs TILL, starts the Studio, asks you to open the demo
company and connects itself. By hand, it is two commands:

```bash
npm install -g tillbooks@beta
till up
```

Keep the `@beta`. Until the beta ends, a plain `tillbooks` on npm is the old 0.1.0, which has no
Studio.

`till up` starts the Studio at `http://127.0.0.1:8788` and opens it in your browser. It listens on
your own machine only. The first screen offers three ways in: create a new ledger, restore a backup,
or restart TILL on an existing database file. Beneath them, **Try the demo** sets up a demo workspace
with sample postings. Your books go to `~/.till/till.db`; set `TILL_DB_PATH` to put them somewhere
else.

To connect an MCP client such as Claude Desktop or Cursor, point it at the stdio server. No account
and no API key are needed:

```json
{
  "mcpServers": {
    "tillbooks": {
      "command": "npx",
      "args": ["-y", "tillbooks@beta", "mcp"]
    }
  }
}
```

In Claude Code, the same server is one line:

```bash
claude mcp add tillbooks -- npx -y tillbooks@beta mcp
```

The agent and the Studio work on the same file, so what the agent does shows up in the Studio.

To work on TILL itself, build it from a checkout:

```bash
npm run setup            # installs the core and the Studio dependencies
npm run build:all        # builds the core into dist/ and the Studio into app/dist/
node bin/till.mjs up
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full dev setup, and
[the quickstart](site-docs/quickstart.mdx) walks through the first run.

## Your data

- Your books are one SQLite file. You can copy it, back it up and open it with standard tools.
- No account, no sign-up, no telemetry. TILL does not report on you or on how you use it. Error
  details are recorded only if you switch that on, they stay on your machine, and they leave it only
  in a feedback mail you send yourself.
- You can export a whole company at any time in an open, documented format, and a backup restores
  into a fresh workspace without touching the ones you have.

## What the beta does not do yet

- No payroll. TILL exports your employee data for your payroll provider and posts the wage journal
  you bring back. Pay slips, AHV and Swissdec stay with the provider.
- No MWST filing. TILL prepares the MWST-Abrechnung and writes the eCH-0217 file. You upload it and
  file in the ESTV ePortal yourself.
- No MWST on received consideration (vereinnahmte Entgelte). TILL computes the Abrechnung on agreed
  consideration (vereinbarte Entgelte) and refuses a period set up the other way.
- No email sending yet. TILL makes the PDF of an invoice, quote or reminder, and you send it from
  your own mail program. Sending through your own mail account is planned for a later beta
  release.
- German (de-CH) and English only. No French or Italian yet.
- No mobile app, and no Windows app. We do not test on Windows; the documented route there is
  [running TILL inside an agent](site-docs/mcp/run-inside-agent.mdx).
- No direct bank connection in this release. The EBICS client is built and has been tested with
  ZKB's test platform, but the module that connects it to the bank is not published yet (it will
  be, under MIT).
  Until then you download camt.053 statements from your eBanking and import them.
- On your own computer, backups run when you start them (Data & Backup, "Back up now"), not on a
  schedule. Keep a copy of the backup file somewhere other than the computer the books are on. (The
  self-hosting recipe replicates the book continuously with Litestream.)
- Several people in one book only on a server you host yourself. The local app is for one computer.
- No eBill sending, e-signature or online customer portal.

## Documentation

- [Quickstart](site-docs/quickstart.mdx) : install, first run, and connecting your agent
- [Run inside an agent](site-docs/mcp/run-inside-agent.mdx) : drive TILL over MCP with no machine of your own
- [Self-hosting in under an hour](site-docs/self-hosting/under-an-hour.mdx) : stand up a served instance
- [Documentation](https://docs.tillbooks.ch) : the product guides and capability reference
- [Design](brand/DESIGN.md) : the design law this project builds to

## Before you use it

TILL keeps books, so [DISCLAIMER.md](DISCLAIMER.md) is worth two minutes: TILL is not tax advice,
you stay responsible for your own filings, and a beta deserves a parallel run before you rely on it.

Help is free and best effort during the beta, and paid help with setup and with moving from bexio is
available. [SUPPORT.md](SUPPORT.md) has the details.

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) : how to run it, and the rules that are not negotiable
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) : how we treat each other
- [SECURITY.md](SECURITY.md) : report vulnerabilities privately to security@tillbooks.ch
- [SUPPORT.md](SUPPORT.md) : where to ask questions

## License

MIT, Copyright (c) 2026 Nomadik GmbH. See [LICENSE](LICENSE).

TILL is an independent project. It is not affiliated with, endorsed by, or derived from bexio AG or
any other accounting vendor, and it copies no code, UI or trade dress from any of them.
