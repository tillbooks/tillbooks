# Contributing to TILL

Thanks for your interest. This covers how to run TILL, the rules that keep it coherent, and what we
will not merge.

## Running it

TILL needs no credentials and no network. Everything runs offline.

```bash
npm install
npm run build          # tsc emits dist/
npm test               # the node:test suites
npm run check          # typecheck + house style + tests
node bin/till.mjs help
```

`npm test` builds first, so a clean checkout works. Node 20 or newer. CI runs on 20 and 22.

## The rules that are not negotiable

These are not style preferences. They are why the project can be trusted with money.

**Posted entries are append-only and immutable.** A correction is a reversing entry, never a
destructive edit. A change that mutates or deletes a posted entry will not be merged, whatever it
makes easier.

**Posting is idempotent.** A double-post must not double-count. If your change touches the posting
path, prove this in a test.

**Money is integer Rappen.** No floats anywhere on the money path. `0.1 + 0.2 !== 0.3` is not a
curiosity here, it is a defect that compounds across a year and then fails an audit. See
[src/money.ts](src/money.ts).

**One posting path.** Every financial effect delegates to the financial core. A second way to post
is the thing this architecture exists to prevent.

**TDD on the ledger core is mandatory.** Write the failing test first. This stays on even when we are
moving fast: it is what makes autonomy safe rather than reckless.

**Clean room.** Never copy code, UI assets, or trade dress from bexio, Gäld, or anyone else. Learn
what to build from public API docs and from observing your own accounts. Copied code poisons an MIT
repo, and we will not take the change.

## House style

- **No em dashes. Anywhere.** Use a colon, a comma, or parentheses. CI enforces this via
  `npm run check:style`. En dashes are fine in real ranges (`B–F`, `8.1–3.8`).
- de-CH uses real umlauts, and never `ss` for `ß`. Swiss German has no `ß`.
- Comments say why, not what. If the code needs a comment to explain what it does, fix the code.
- The design law is [brand/DESIGN.md](brand/DESIGN.md). One accent, one typeface, no decoration
  pretending to be signal.

## Sending a change

`develop` is the default branch and the integration trunk. Work on a short-lived branch and open a
pull request into `develop`. Promotion is always `develop -> staging -> main`.

Conventional commits: `feat(scope):`, `fix(scope):`, `docs:`. Say what changed and why. A commit
message that says "fix bug" is not a commit message.

Before you open the PR: `npm run check` passes, and you have actually run the thing.

## What we will not merge

- Anything that edits or deletes a posted entry.
- Floats on the money path.
- A second posting path.
- Copied code or trade dress from another product.
- An em dash.
- A change with no test on the ledger core.

## Reporting bugs and security issues

Bugs: open an issue with reproduction steps. A clear report with steps beats a patch with none.

Security: do **not** open a public issue. See [SECURITY.md](SECURITY.md) and mail
security@tillbooks.ch.
