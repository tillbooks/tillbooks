# Changelog

All notable changes to TILL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and TILL aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves pre-alpha.

## [Unreleased]

TILL is pre-alpha. The engine, the MCP verbs and their REST twins, and the Studio
are being built across the numbered capabilities. Nothing here is ready to keep
real books yet, so there is no released version and the package is not on npm. The
first tagged release lands when the ledger can keep real books, not before.

### The ledger contract (stable from day one)

- Posted entries are append-only and immutable.
- A correction is a reversing entry, never a destructive edit.
- Posting is idempotent: a double-post does not double-count.
- Every query is tenant-scoped.

These are asserted in the test suite, not merely promised here.
