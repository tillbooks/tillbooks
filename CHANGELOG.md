# Changelog

All notable changes to TILL are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A pre-release such as a beta makes no
compatibility promise yet, so back up before every upgrade.

## [Unreleased]

## [1.0.0-beta.2] - 2026-10-27

The second beta. It makes the bank inbox and the Studio's daily screens easier to work in, turns
more of TILL's built-in choices into settings, and gives the Mac a native TILL app. It is still a
beta: back up before you update.

**Upgrade note (database generation 18).** Opening your books with this version upgrades them
in one go, even from generation 10 (every step in order). Make a backup before you upgrade and
another one afterwards: a backup from before the upgrade restores only into the previous version, and
an older version refuses the upgraded books without changing them. Update the desktop extension
(.mcpb) and the command line tool together.

### Added

- Settings: a new Settings section in the company profile lists the workspace's settings, each with
  its default, and lets you change one with a short reason. Every change is kept with the old and the
  new value, and a setting can go back to its default at any time. Agents can read the settings; a
  change an agent proposes waits for your approval, and automations never change them. The first
  setting is how many days ahead Pendenzen shows due checklist steps (14 by default). More settings
  follow as TILL's built-in rules become yours to choose.
- A Belegnummer on every journal entry, gap-free and given when the entry is posted. Entries migrated
  from bexio keep their bexio number and new entries continue after the highest one; a bexio voucher
  that became several entries shares one number. The Journal gains a Beleg-Nr. column and filter. Under
  Setup, Einstellungen, you can choose another start number, restart each fiscal year with a prefix,
  or switch numbering off.
- Bank statements can be imported as MT940 and as CSV, beside camt.053. TILL detects the format, shows
  a preview, and for a CSV asks you to map the columns once; the mapping is saved per bank account.
- A line that may already be in TILL from another statement format is flagged instead of dropped or
  silently imported twice. The line names the entries it may duplicate, and you answer "Duplikat" or
  "Kein Duplikat". A statement delivered again never adds a line silently.
- Buchungsregeln. The ☆ on a bank line saves "this payer or payee books to this account and MWST
  code", and later lines arrive prefilled; TILL also proposes from your past journal entries. A
  rule can split an amount over several accounts, route it through a Durchlaufkonto, ask for an amount
  the line cannot say, compute an amount as an exact fraction of the payout, and match on the line's
  text. A rule only proposes: nothing books by itself.
- "Nicht buchen" as a rule outcome, and Vorlagen for manual entries: a template in the journal composer
  asks for its amounts and shows what it will post.
- More ways to book a bank line: to a customer or a supplier as a Guthaben, to several invoices or
  bills at once, to a Spesen claim, or as a foreign-currency Anzahlung fixed in CHF at the receipt
  rate. VAT on a received Anzahlung is a setting and is off by default.
- Card payments in a foreign currency show the amount, the rate and the fee the bank reported, and
  TILL proposes splitting the fee onto Bankspesen. The setting `bank.fx_mode` lets you prefill the
  split, show the facts only, or book the counter-leg in the transaction currency.
- A bank pane you can arrange: the Details area docks at the bottom or the right, closes and resizes
  by drag, and the table's columns resize. The list filters by Zeitraum and by Gutschriften or
  Belastungen, counts honestly and pages past 200 lines.
- Pendenzen in sections by area, bank Vorschläge first, one row pattern throughout. You tick the
  bank decisions you agree with and approve them together (rows are never pre-ticked); each still runs
  as its own approval. A setting switches to one by one, or to approve all behind a confirmation.
- The Übersicht is arranged in place: one Anpassen icon turns the page into two zones, key figures
  and cards, that you drag into order, hide and resize, and it saves as you go. Cards are a free
  library (for example the expense ring and the monthly money in and out), the bank action can be a
  tile, a card or a slim bar, and a saved view keeps the layout.
- Meine Einstellungen, a page of personal settings for each person and workspace: bank layout, menu,
  motion, Pendenzen grouping, Übersicht content. Agents can read and change them with `prefs_list`,
  `prefs_get`, `prefs_set` and `prefs_reset`.
- A menu you can rearrange: reorder groups and items, move an item to another group, hide one, reset
  to the default. A favourite sits flush in the menu as the page's icon with a filled star, and moves
  and renames from its Mehr menu.
- The bank balance card reads as one sum (Buchhaltung, open lines, Differenz, Bank), says when bank
  and books already differ before the first statement, and repairs all statement gaps of an account
  from one dialog.
- Reduced-rate input tax codes for operating costs and material: VST-M26 and VST-M38 on Ziffer 400,
  VST-I26 and VST-I38 on Ziffer 405. Existing books receive them when they open.
- A native TILL app for the Mac. It opens the Studio in its own window with no link and no terminal,
  and "Bestehende Datenbank übernehmen" on the first run picks your book with a file dialog.
- A signed and notarised TILL.app for Apple-silicon Macs, as a dmg with its own Node runtime and no
  Intel code. Intel Macs use the npm install.
- A browser you have opened TILL in stays signed in across new tabs, bookmarks and restarts, and
  "Auf allen Geräten abmelden" under Zugriff signs every other browser out.
- MCP tools: 822 now (800 in beta.1). New are the settings verbs `settings_list`, `settings_get`,
  `settings_set` and `settings_reset`; the undo verbs `expense_claim_reverse`, `dunning_fee_reverse`,
  `asset_transaction_reverse` and `wage_journal_reverse`; `import_bank_statement`, `bank_csv_preview`,
  `get_bank_csv_mapping` and `set_bank_csv_mapping`; `resolve_possible_duplicate`; the bank standard
  verbs such as `set_bank_standard` and `list_bank_standards`; `journal_numbering_plan`; and
  `dashboard_series` for the Übersicht's monthly figures.

### Changed

- A bank line has one decision per row. "Prüfen" is gone: a line an agent drafted reads "Buchen" like
  any other, and an edited line books your version first and then closes the agent's Vorschlag. The
  account field can be cleared, MWST is always a field with "Ohne MWST" first, and the picker lists
  the payer's Buchungsregeln first.
- An agent's Vorschlag is one line in Pendenzen: title, the figures that matter, and Genehmigen, with
  Details as label and value, never raw JSON. The floating Agent pill and its panel are gone; live
  sessions stay under Agent.
- One icon set and one icon button across the Studio: an icon-only button shows its name on hover and
  focus, and a tap on a touch screen opens no bubble. Menu group names are 14 px semibold without an icon.
- The Übersicht's expense ring counts expense accounts with a debit balance and names the credit-balance
  accounts as reductions, so a stock change no longer empties it.
- Issuing a Mahnlauf from a Pendenzen row asks you to confirm first, with the consequence in words.
- Motion has four levels in Meine Einstellungen (Lively, Standard, Calm, Off). A count-up never runs
  in a table, an input or a bank amount, and your system's reduced-motion setting wins.

### Fixed

- An approved expense claim can now be reversed from its row under HR. TILL books the correcting
  entry and closes the claim as reversed. A claim that was already paid out asks you to reverse the
  payment first, and the journal no longer lets a plain reversal leave the claim looking approved.
- A dunning run's reminder fees can now be reversed from the run under Dunning. TILL books the
  correcting entry; the reminder levels and any letter already sent stay as they are. A letter not
  yet sent is re-issued without the fee and can then be sent; the run shows which letters were
  re-issued. A fee the customer already paid asks you to reverse the
  payment first, and the journal no longer reverses a run's fee on its own.
  Under Setup, Einstellungen, you can choose to hold such letters instead, and whether a re-issued
  letter keeps the date of the run (the default) or carries the day it was re-issued. A single run
  can be handled differently from these settings, with a reason that is kept with the correcting entry.
- A fixed asset's purchase, added cost, opening balance or disposal can now be reversed from the
  asset's transactions in the asset register. TILL books the correcting entry and updates the register
  in one step, so the register and the books keep matching. A reversed purchase closes the asset; a
  reversed disposal puts it back in the register. Depreciation already booked on the asset asks you to
  reverse that run first, and the journal no longer reverses these entries on its own.
- A posted wage journal can now be reversed from its row on the Payroll tab under HR. TILL books the
  correcting entry and the history marks the posting as reversed; you then upload the corrected
  journal. Salary payments, social insurance declarations and wage statements are handled in your
  payroll system and stay as they are. A wage journal a bank line booked asks you to reopen that line
  first, and the journal no longer reverses a wage journal on its own.
- A month can no longer be booked twice from the payroll. Uploading a second wage journal for a
  month whose journal still stands is refused with the way out: reverse the posted one on the Payroll
  tab first, then upload the corrected journal. A retry of the same upload still returns the original
  booking. Under Setup, Einstellungen, you can change this to post with a warning or not to check at
  all. A single extra posting for a month (a late bonus, say) can be booked as a Nachtragsbuchung with
  a reason, which is kept with the booking.
- Each wage journal now has a payroll run: Regular (the default), Bonus, 13th month salary or
  Correction. Only regular runs count for the one-journal-per-month check, so a bonus or 13th salary
  can be posted in a month whose regular journal already stands. Journals you posted earlier count as
  regular. A correction run asks for a reason, which is kept with the booking; under Setup,
  Einstellungen, you can ask for a reason on every bonus and 13th salary too, or on none. Every bonus,
  13th salary and correction run is recorded in the audit trail.
- An approval whose action was interrupted half-way (TILL quit or crashed after the action committed,
  before the approval was marked done) now settles as done when you approve again. It used to be
  shown as "never executed" next to the booking it had already made.
- Two approvals of the same dunning run at once no longer send a debtor two letters, and a rejection
  that crosses an approval in another window no longer records "rejected" over an act that ran.
- An approval whose action ran only in part (a dunning run cut off half-way, a bank fetch that
  imported a statement and then lost the bank) can no longer be rejected as if nothing happened.
- A send or a payment transmission whose outcome is unknown is never repeated. Approving it again
  records the unknown outcome instead of trying a second time.
- VAT periods follow the filing calendar. Only a real filing period (a quarter, or a half-year under
  Saldosteuersätze) can be marked filed, and `export_vat` now takes the labels `2026-Q3` and `2026-H2`
  and flags any range that is not one. A method or timing change takes effect on 01.01; the one
  mid-year exception is the switch from Saldo to effektiv that MWSTV Art. 81 Abs. 2 allows. A
  period cut by that switch is computed correctly, and TILL tells you to file it in the ESTV ePortal.
  Labels before 1995, when MWST began, are refused.
- Merging two contacts now moves their recurring schedules to the surviving contact, so no invoice is
  drafted to a contact that no longer shows in the lists.
- The raw reversal of a landed-cost voucher's entry is refused and points to the voucher's own undo, so
  the voucher and its stock layers keep matching the books.
- Rolling back a migration step whose opening entry cannot be reversed (a locked period, say) changes
  nothing and says why, instead of letting the next approval post a second opening.
- A refund through a contact first nets against that contact's open Guthaben, so a refunded payment can
  no longer be applied to an invoice. A refund larger than the Guthaben is refused unless you allow it.
- An Anzahlung clearing that was reversed no longer counts as cleared.
- An adopted book that has gone missing or cannot be opened is reported on a calm page and never
  replaced by an empty one.
- A CSV whose first lines are a key and value preamble no longer takes that preamble for the header,
  and an MT940 line key no longer depends on the order its pages arrive in.
- The expense ring's legend keeps each share and amount on one line, and the menu rail fits the screen
  height by stepping its row pitch down only as far as needed.

### Security

- The Studio key stays in an owner-only file between launches. Links carry one-time tickets and
  never the key, a browser pairs with a device key that cannot be exported, and a failed rotation
  changes nothing. TILL.app checks that the server on the port is the real one before it loads
  anything.
- Statement parsing is bounded against crafted files that stall the import.
- Overriding the VAT refund on an Anzahlung needs the right to manage the VAT configuration and a
  reason, and an agent's override waits for approval.
- Dependency advisories in proxy-addr, fast-uri, ip-address, hono and qs are patched.

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
