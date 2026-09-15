# Changelog

All notable changes to TILL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and TILL aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves pre-alpha.

## [Unreleased]

## [0.1.0] - 2026-09-15

The first open-source (MIT) release of TILL: a local-first Swiss accounting engine
an AI agent drives over MCP, with a minimalist Studio for human oversight. This is
the version reserved for npm and the Model Context Protocol registry.

### Added

- Double-entry ledger with append-only, immutable posted entries and idempotent posting.
- The MCP stdio server (`till mcp`), the agent interface to the full action registry, with REST twins for every write verb.
- The Studio (`till up`): the human-oversight GUI over the same actions.
- Swiss compliance: the MWST-Abrechnung, QR-bill (QR-Rechnung), and ISO 20022 payments.
- Root `server.json` and `glama.json` for MCP-registry and directory discoverability.

### The ledger contract (stable from day one)

- Posted entries are append-only and immutable.
- A correction is a reversing entry, never a destructive edit.
- Posting is idempotent: a double-post does not double-count.
- Every query is tenant-scoped.

These are asserted in the test suite, not merely promised here.
