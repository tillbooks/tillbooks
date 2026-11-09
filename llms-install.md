# Installing the TILL MCP server (for AI agents)

TILL is a local-first Swiss accounting and ERP app. Its MCP server runs on the user's own machine and
keeps the books in one SQLite file. No API key, no account, no network service.

## Requirements

- Node.js 22 or newer (`node --version`).
- macOS or Linux. On Windows, use WSL.

## Add the server to the MCP client

Use stdio with `npx`. Keep the `@beta` tag: a plain `tillbooks` on npm is the old 0.1.0.

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

Optional environment variables:

- `TILL_DB_PATH`: the books file. Default `~/.till/till.db`.
- `TILL_SUPPORT_DIR`: backups and support files. Default `~/.till`.

## Check it works

After the client reconnects, call `whoami`. It answers with the workspace state. If no workspace
exists yet, the user can open the Studio with `npx -y tillbooks@beta up` (http://127.0.0.1:8788) and
choose "Try the demo" ("Demo ausprobieren").

## Rules for the agent

- Work in the demo company until the user says otherwise.
- By default, postings, payments, access changes and deletions wait as proposals until the user
  approves them in the Studio. Tell the user when that happens; never try to approve your own proposal.
- Never ask for, read or type passwords, e-banking logins, EBICS keys or card numbers.

The full guide is in [AGENTS.md](AGENTS.md).
