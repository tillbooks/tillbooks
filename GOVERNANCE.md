# Governance

TILL is an open-source (MIT) project stewarded by **Nomadik GmbH**. This document
says who decides what, and how, so the process is legible to everyone who
contributes.

## Stewardship

Nomadik GmbH maintains TILL and holds the copyright on the original work
(contributions stay under the contributor's copyright, licensed to the project
under MIT). While TILL is pre-alpha, the maintainers make the final call on
direction, scope, and what ships. This is deliberate: a Swiss accounting engine
has to be internally consistent and statutorily correct before it is democratic.

As the project matures we expect to add named maintainers from outside Nomadik and
to move more decisions into the open. That evolution will be recorded here.

## How decisions are made

- **Everyday changes** (bug fixes, tests, docs, a capability that fits an existing
  spec) are decided in the pull request. A maintainer reviews and merges.
- **Money-path changes** (anything touching posting, reversing entries,
  idempotency, tenant scoping, or a statutory figure) always get a second,
  non-author reviewer, and the invariant tests must still assert the contract. This
  is the one place self-review is not trusted.
- **Direction and scope** (new capability families, breaking changes, licensing,
  a new statutory regime) are decided by the maintainers, in the open where
  possible, in an issue or a discussion.

## Principles that are not up for negotiation

- **The ledger contract.** Posted entries are append-only; corrections are
  reversing entries; posting is idempotent; every query is tenant-scoped.
- **Clean-room and independent.** TILL is a clean-room implementation built from
  public documentation. It does not copy code, UI, or trade dress from any
  accounting vendor, and it is not affiliated with one.
- **Local-first and private.** The books live in a SQLite file on the user's own
  machine. TILL does not phone home and does not add telemetry.
- **House style.** No em dashes. English and de-CH, with real umlauts.

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md), never in a public
issue.

## Code of conduct

Everyone participating in the project is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
