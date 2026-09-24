# TILL

**Trusted Independent Ledger Library.** Swiss accounting your agent can actually use.

TILL is a free, open-source (MIT), local-first accounting app built for Switzerland. Your books live
in a single SQLite file on your own machine. They never leave the country, because they never leave
your laptop.

The difference is the interface. Most accounting software is a GUI with an AI button bolted on. TILL
is built the other way around: an **MCP server is a first-class interface**, so an agent can post
entries, categorize transactions, draft and chase invoices, prepare the MWST-Abrechnung, and answer
"how did my quarter go" by talking to the ledger directly. A minimalist Studio gives you human
oversight of everything the agent did. Agent and human share one ledger.

> **Status: pre-alpha.** The engine, the MCP verbs and the Studio are built across the numbered
> capabilities. Nothing here is ready to keep real books yet. Do not run your business on it.

## Why

Switzerland has accounting software. It does not have accounting software an agent can drive, and
the open-source option (Gäld) is AGPL, which forecloses an open-core model. TILL is a clean-room
MIT rebuild aimed at the things that actually make Swiss books Swiss:

- **QR-bill** (Swiss QR-Rechnung) with the structured-address standard
- **Three MWST rates** (8.1%, 3.8%, 2.6%) and the MWST-Abrechnung that falls out of them
- **Kontenrahmen KMU** seeded out of the box
- **ISO 20022** (camt/pain) for banking
- de-CH and en from day one

## The ledger is not negotiable

Posted entries are append-only and immutable. A correction is a **reversing entry**, never a
destructive edit, exactly as real accounting works. Posting is idempotent: a double-post does not
double-count. These are asserted in the test suite, not merely promised in a README.

## Install and run

TILL is on npm as `tillbooks` (0.1.0, pre-alpha). Installing it globally puts the `till` command
on your path:

```bash
npm install -g tillbooks
till help
```

To connect an MCP client such as Claude Desktop or Cursor, point it at the stdio server. No API key
is needed:

```json
{
  "mcpServers": {
    "tillbooks": {
      "command": "npx",
      "args": ["-y", "tillbooks", "mcp"]
    }
  }
}
```

The ledger is created at `~/.till/till.db`; set `TILL_DB_PATH` to put it somewhere else. `till up`
starts the Studio, the human oversight GUI.

To work on TILL itself, build it from a checkout:

```bash
npm install
npm run build            # tsc emits dist/
node bin/till.mjs help
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full dev setup, and
[the quickstart](site-docs/quickstart.mdx) walks the same steps.

## Documentation

- [Quickstart](site-docs/quickstart.mdx) : where TILL stands, and how it connects to your agent
- [Run inside an agent](site-docs/mcp/run-inside-agent.mdx) : drive TILL over MCP with no machine of your own
- [Self-hosting in under an hour](site-docs/self-hosting/under-an-hour.mdx) : stand up a served instance
- [Documentation](https://docs.tillbooks.ch) : the product guides and capability reference
- [Design](brand/DESIGN.md) : the design law this project builds to

## Before you use it

TILL is pre-alpha and it keeps books. [DISCLAIMER.md](DISCLAIMER.md) is worth two minutes: TILL is
not tax advice, you stay responsible for your own filings, and you should not point it at real
accounts yet.

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) : how to run it, and the rules that are not negotiable
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) : how we treat each other
- [SECURITY.md](SECURITY.md) : report vulnerabilities privately to security@tillbooks.ch
- [SUPPORT.md](SUPPORT.md) : where to ask questions

## License

MIT, Copyright (c) 2026 Nomadik GmbH. See [LICENSE](LICENSE).

TILL is an independent project. It is not affiliated with, endorsed by, or derived from bexio AG or
any other accounting vendor. It is a clean-room implementation built from public documentation.
