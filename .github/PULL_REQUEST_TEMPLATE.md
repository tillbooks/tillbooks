## What this changes

A short description of the change and why.

## Checklist

- [ ] `npm run gate` passes (typecheck, the test suite, and the style checks).
- [ ] If I added or changed a write capability, it ships on BOTH faces (the MCP verb and its REST twin) and the parity test still passes.
- [ ] The money path is intact: posted entries stay append-only, corrections are reversing entries (never destructive edits), and posting stays idempotent. If I touched it, the invariant tests still assert it.
- [ ] Every query is tenant-scoped (section H-TENANT).
- [ ] I followed the house style: no em dashes, English or de-CH only, real umlauts (never `ae`/`oe`/`ue`, never `ss` for a Swiss word).
- [ ] I did not commit any secrets, keys, or a `.env` file.
- [ ] Docs updated if behaviour changed (README or `site-docs/`).

## How I tested it

Describe what you ran. All tests run offline (`npm test`).
