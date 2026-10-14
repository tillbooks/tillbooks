# Changelog

All notable changes to TILL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A pre-release such as a beta makes no
compatibility promise yet, so back up before every upgrade.

## [Unreleased]

## [1.0.0-beta.1] - 2026-10-14

The first public beta, and the first release since 0.1.0 to reach npm. You can install it, open the
Studio and keep books in it. Nomadik GmbH, the company behind TILL, keeps its own books in it. It is
still a beta: if you move real books in, keep your old system running until the figures match. The
parallel run in the migration area does that comparison for you, to the Rappen.

1.0.0-rc.1 (below) stayed a workshop version and never reached npm. This beta is the one that does.

### Added

- The Studio ships inside the npm package: `npm install -g tillbooks@beta`, then `till up`, opens
  it in your browser. The beta is published under the `beta` tag, so a plain `tillbooks` still
  installs 0.1.0, which had no Studio. Open the Studio through the link `till up` prints: it
  carries a key for that launch, and a tab opened without it cannot act as you and points you
  back to that link.
- The bank inbox. For each line of an imported camt.053 statement that TILL can place, it proposes a
  booking, and you confirm it; a booked line is undone with a reversing entry. A transfer between
  two of your own accounts is never booked without you.
- Receipts on bank lines. You attach the Beleg to the bank line, and once the line is booked TILL
  keeps it as a voucher under the ten-year retention rule. An expense account such as bank
  charges can be marked "Beleg = Kontoauszug", so lines booked to it stop asking for a receipt.
- A bank band on the overview: the open lines, the lines that need you and the booked lines without
  a receipt, across your bank accounts, each leading into the bank screen.
- The EBICS client for statement download (EBICS 3.0, protocol H005, camt.053), with the key setup,
  the INI letter and a daily fetch at 07:00 while `till up` runs. It has been tested with ZKB's test
  platform. The module that connects it to the bank is not part of this release, so every EBICS
  step that would reach a bank answers `needs_bank_transport`. We will publish that module under MIT.
- TILL notices a missing bank statement and keeps showing it. When the statement numbers or balances of an
  account do not chain, the gap is shown on the overview and on the bank account until you fill it.
  You fill it by hand: download the missing camt.053 files from your eBanking and import them
  together, and TILL books them in number order. Only a person can mark a gap as closed, with a
  reason, and only when the balances on both sides chain; a gap with an amount nobody can explain
  stays open. A failed automatic fetch keeps the bank's return code and shows as waiting too.
- A default payment term for the whole company (Firmenprofil, "Standard-Zahlungsfrist"). A
  document's due date is the one it names, else its date plus the contact's own terms, else plus
  the company default, and the same rule applies to invoices and supplier bills. A new book starts
  at 30 days; an existing book keeps no default until you set one. On a contact, "Standard" (use the
  company default) and "sofort" (0 days, due immediately) are now different settings.
- A new invoice screen. You pick the customer first, and their payment terms fill in the due
  date. An invoice, a quote or an order can carry one "Datum", the date the service
  was delivered, for the whole document. Each line is priced and booked at its own date if you gave
  it one, else at the document's Datum, else at the issue date, so a line in another VAT rate period
  gets that period's rate. Converting a quote to an order or an invoice keeps both dates. Changing
  the Datum after your agent proposed the invoice makes the approval refuse with `vorschlag_stale`.

### Changed

- The agent's approval dial follows one rule. By default, your agent waits for your OK before it
  books anything, moves your money, grants access or deletes your data for good. That now includes
  opening balances (`set_opening_balances` no longer posts directly), the opening seeds for bank,
  assets and stock, the migration steps, payment files, bank-detail changes, filings and period
  seals, issued documents, invites, roles, plugins and permanent deletion. Recurring schedules set
  to "Issue automatically" issue when someone runs the due schedules, not on a timer. Drafts, notes,
  tasks and contact edits still run without asking, and every call is recorded. The dial covers
  agents that connect to TILL. An agent that can drive your browser or run commands on your
  computer can act as you: give your agent TILL, not your browser or your shell.
- What you approve is what runs. A proposal records the figures it was made on (the document and its
  lines, the recipient, the VAT rates, the payee, the default payment terms), and the approval card
  shows them: net, VAT, total and who it goes to. If anything it depends on changes before you
  approve, the approval refuses with `vorschlag_stale`, nothing runs, and the agent has to propose
  again.
- One text per action says what it does and how it is undone, in English and German. The MCP tools
  serve it to your agent, each tool declares whether it can be undone, and the Studio shows it
  behind an (i) beside the button that commits.
- The README, the docs and the MCP listings call TILL the agent-first ERP for Swiss SMEs, and each
  of them says what it covers and what it does not.
- Reversing the entry of an invoice, a credit note, a supplier bill, a depreciation run or a stock
  valuation run goes through that document's own undo, so its status follows the reversal.
- For a bank account connected over EBICS, the pain.001 payment file now says what to do with it:
  upload it and release it in your eBanking. TILL never transmits a payment.
- A payment file is fixed when it is created: its references, the order of its payments and the
  names and IBANs on both sides. Generating it again gives the identical file, so a restored book
  cannot produce a second file with new references for payments you already released. A bank
  account's IBAN cannot change while a payment batch names it.
- A calmer, denser Studio: a tighter sidebar, tabular figures in every money field, and select
  menus that replace the operating system's pop-ups.
- Less to read on the busiest screens:
  - A manual entry is a Buchungssatz (Soll an Haben, Betrag, MWST). MWST is pre-filled from the
    account, shown only where a code can apply (income and expense accounts and fixed assets), and
    the input-tax line is worked out for you. "Aufteilen" opens the line grid for a split entry.
  - The bank queue selects nothing by itself, and the selected line shows one strip: how sure TILL
    is, one reason, the MWST split and the actions.
  - More screens were cut down the same way, among them the MWST-Abrechnung, the MWST settings,
    Perioden (one guided year close), Prüfung, Zahlung erfassen, Kreditoren, Offene Posten and
    Versand.
  - No list pre-selects a row, including the payables of a pain.001 run.
  - Every item in the sidebar has its own name.
  - The page header sits flush with the scroll edge, so content no longer scrolls visibly above it.
- Motion, kept short: a brief confirmation when you approve, book or review something, and a
  highlight on a figure that changed. It uses CSS only, stays within 120 to 200 ms (loading
  indicators excepted), and stops when your system asks for reduced motion.

### Fixed

- An older TILL no longer writes into books that a newer TILL has upgraded. It refuses to open them
  and asks you to update, so old-format and new-format figures cannot mix in one book.
- A stock movement into a locked period is refused, and the MWST method cannot be changed without a
  start date once a period has been filed.
- The bookings and records a combined action makes on the way (a supplier bill from a scanned
  receipt, the wage journal, an exchange-rate import, a payment batch from the liquidity plan, a
  mail draft) use internal keys that no other call can claim first. Before, a call made earlier
  under the same key could be replayed in their place while the combined action still reported
  success. Each of them is now read back after it is written.
- A backup of a book replicated with Litestream (the self-hosting recipe) restores on another
  machine. Litestream's own tables used to travel into the backup, and a restore anywhere without
  Litestream refused it as made by a newer TILL. Backups taken before this fix restore too.
- A backup records the TILL version that made it, not `0.0.0`.

### Security

- The Studio's own seat needs the per-launch key. Before, an MCP client that called itself the
  Studio was treated as the person and skipped the dial.
- Accepting a quote through the generic document transition goes through the approval dial and checks
  the quote's expiry, like the quote's own accept action.
- An agent cannot approve its own purchase requisition, a plugin cannot pass a sign-off that only a
  person may give, and regenerating a mail draft no longer overwrites a person's unsent edits.
- A restore refuses any record that points outside the restored book, and starts with sync
  publishing switched off.

### Not in this beta

- Payroll: TILL exports your employee data for your payroll provider and posts the wage journal you
  bring back. It makes no pay slips and no AHV or Swissdec filings.
- MWST filing: TILL prepares the MWST-Abrechnung and writes the eCH-0217 file. You file in the ESTV
  ePortal.
- MWST on received consideration (vereinnahmte Entgelte): TILL computes the Abrechnung on agreed
  consideration only and refuses a period set up the other way.
- Email: TILL makes the PDFs and does not send them yet. Sending through your own mail account is
  planned for a later beta release.
- Languages: German (de-CH) and English only.
- No mobile app and no Windows app.
- No direct bank connection until the EBICS connection module is published. Import camt.053
  statements from your eBanking instead.
- On a local install, backups run when you start them, not on a schedule.
- No restore across book formats: a backup restores only into a TILL with the same book format.
  When an update upgrades your book, take a fresh backup right after it.
- No ranged statement download: TILL does not ask the bank for a date range, so a missing
  statement is filled by importing the file yourself.

## [1.0.0-rc.1] - 2026-09-17

The technical v1 release candidate. The whole capability corpus is built end to end and the
self-hosted served path is proven against a local image. This is a candidate: 1.0.0 final is
gated on real-world validation and stays pre-alpha until then. Do not run your business on it.

(Note added with 1.0.0-beta.1: this candidate was never published to npm. The public beta above
followed it and replaces the status stated here.)

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
