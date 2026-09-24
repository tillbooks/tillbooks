# Changelog

All notable changes to TILL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and TILL aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves pre-alpha.

## [Unreleased]

## [1.0.0-rc.1] - 2026-09-17

The technical v1 release candidate. The whole capability corpus is built end to end and the
self-hosted served path is proven against a local image. This is a candidate: 1.0.0 final is
gated on real-world validation and stays pre-alpha until then. Do not run your business on it.

### Added

- Self-hosted served instance: a Docker image and healthcheck, compose recipes for a direct
  Caddy front and for Cloudflare Access, a Litestream backup target, and a self-hosting recipe
  proven end to end against a local image (restore drill included, observed RPO 2s).
- An owner-gated Infomaniak deploy runbook (recipe A, Cloudflare Access), with the Cloudflare
  TLS residency caveat stated plainly.

### Security

- Hardened the served identity boundary, verified by a non-author critic: fail-closed fences so a
  served subject cannot write or delete arbitrary host files through `env_*`, cannot restore a
  backup or read another tenant's backup metadata, and cannot wipe instance diagnostics; a
  served-subject deny sweep test over the ungated verbs; case-insensitive served-subject
  resolution; and the plugin sandbox fails closed with copy that no longer overclaims isolation.

### Fixed

- UX friction residuals: the locked-period refusal names the way out (change the booking date),
  the migration column mapping suggests columns for a linked Saldenliste, and the served
  collaboration dead ends are closed (a full-page not-a-member state, a retry on the sign-in
  page, re-invite replacing an expired invite, a confirm before revoke, and the session
  re-resolving after redeem without a manual reconnect).
- `till --version` now reads the package version instead of a hardcoded string.

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
