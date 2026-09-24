/**
 * A20's three tables, kept in A20's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A15/A21/E00 established: a capability's DDL sits beside the code that writes it, so
 * concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * `bank_statement` is the imported FILE-level fact, keyed for dedupe on `(workspace, bank account,
 * Stmt/Id, ElctrncSeqNb, page number)`, never on `MsgId` alone, because a bank re-delivers the same
 * statement under a fresh message envelope on a `CpyDplctInd` resend and the statement's own identity
 * is `Stmt/Id`, not the envelope's. `page_number` (D81, A20-C9) is part of the key because a
 * multi-page statement shares its `Stmt/Id` and `ElctrncSeqNb` across every page BY DESIGN (SPS 2.3
 * p.54): without the page number, page 2 collides with page 1's identity and is thrown away as a
 * duplicate. The unique index folds a NULL `electronic_seq_nb` (camt.054 rarely carries one) to the
 * empty string, because SQLite's default uniqueness treats every NULL as distinct and a
 * `WHERE electronic_seq_nb IS NOT NULL` partial index would let two null-seq statements with the same
 * Id and account collide silently. `content_hash` is a fingerprint of the parsed statement's content
 * (`hashCamtStatement`): a same-identity re-import whose hash differs is a corrected bank figure
 * (A20-C2, `statement_amended`), not a byte-identical re-delivery (`duplicate: true`). `last_page_ind`
 * gates the D64 `reconciled` indicator: a non-last page's balance, even if present, is never the
 * statement's real closing position (D81).
 *
 * `bank_txn` is one row per BOOKED entry (or, for a batch `Ntry`, one row per `TxDtls` inside it,
 * D81/A20-C10) the importer kept: a `PDNG` entry (camt.054 may carry one) is never imported, because
 * a pending movement is not a booked fact, and neither is an entry this parser could not read
 * (A20-C6, reported in `importCamt`'s `skipped` list rather than silently dropped). `entry_key` is
 * D81's identity ladder resolved by the parser (`AcctSvcrRef`, falling back to `NtryRef`, falling
 * back to a content hash), unique per `(workspace, bank account)` so an overlapping or re-cut
 * statement, or the camt.054-then-camt.053 pair, cannot re-import the same booked fact twice
 * (A20-C1); an explicit `allowDuplicateEntries` escape on `import_camt` is the only way to admit a
 * genuine same-day twin, and it does so by minting a distinct suffixed key, never by relaxing the
 * index. `classification` is set once, at import time, from the entry's own facts (`CdtDbtInd` and
 * `RvslInd`), and never re-derived: a booked, non-reversal CREDIT is `incoming_credit` and flows
 * through the public `recordIncomingCredit` seam into A21's queue (`credit_id` is the resulting
 * `reconciliation_match.id`, spec §0 note 2); everything else (a DBIT, or a reversal of either sign)
 * is `outgoing_debit` or `unclassified` and stays A20's own to confirm or book.
 *
 * `bank_txn_link` is A20's OWN settlement record, for the half of the queue A21 does not own: a debit
 * settling one or more vendor bills through `confirmCamtMatch`, or a manual annotation to an existing
 * journal entry. A credit's "match" is never a second row here: it IS the A21 queue row, joined by
 * `bank_txn_id` on `reconciliation_match` (A21 already carries that nullable seam). The unique index
 * makes a txn linkable exactly once, so "matched" is a structural fact (`EXISTS` a link row) rather
 * than a derived status column that could drift from what was actually written.
 */

export const CAMT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bank_statement (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  bank_account_id       TEXT NOT NULL REFERENCES bank_account(id),
  message_type          TEXT NOT NULL,
  statement_id          TEXT NOT NULL,
  electronic_seq_nb     TEXT,
  page_number           INTEGER NOT NULL DEFAULT 1,
  last_page_ind         INTEGER NOT NULL DEFAULT 1,
  content_hash          TEXT NOT NULL DEFAULT '',
  from_date             TEXT,
  to_date                TEXT,
  opening_balance_minor INTEGER,
  closing_balance_minor INTEGER,
  balance_currency      TEXT,
  txn_count             INTEGER NOT NULL DEFAULT 0,
  imported_by           TEXT,
  imported_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_dedupe
  ON bank_statement (workspace_id, bank_account_id, statement_id, COALESCE(electronic_seq_nb, ''), page_number);

CREATE INDEX IF NOT EXISTS bank_statement_account
  ON bank_statement (workspace_id, bank_account_id, to_date);

CREATE TABLE IF NOT EXISTS bank_txn (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  bank_account_id  TEXT NOT NULL REFERENCES bank_account(id),
  statement_id     TEXT NOT NULL REFERENCES bank_statement(id),
  entry_key        TEXT NOT NULL,
  entry_ref        TEXT,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  credit_debit     TEXT NOT NULL,
  booking_date     TEXT,
  value_date       TEXT,
  reference_kind   TEXT NOT NULL DEFAULT 'none',
  reference_value  TEXT,
  payer_name       TEXT,
  reversal_ind     INTEGER NOT NULL DEFAULT 0,
  btc_domain       TEXT,
  btc_family       TEXT,
  btc_sub_family   TEXT,
  -- SPS IG §3.9, Ntry/NtryDtls/Btch/PmtInfId: the pain.001 batch this movement settled, when the bank
  -- reports it. A18 does not exist yet (spec §0 note 3); this column is the seam it joins on later
  -- without A20 re-parsing a single file. Nothing reads it today.
  batch_pmt_inf_id TEXT,
  classification   TEXT NOT NULL,
  -- The A21 queue row this credit was registered into (spec §0 note 2). NULL for a debit or an
  -- unclassified (reversal) row: those settle through bank_txn_link instead, never through this column.
  credit_id        TEXT REFERENCES reconciliation_match(id),
  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_txn_entry_dedupe
  ON bank_txn (workspace_id, bank_account_id, entry_key);

CREATE INDEX IF NOT EXISTS bank_txn_statement ON bank_txn (workspace_id, statement_id);

CREATE INDEX IF NOT EXISTS bank_txn_account_date ON bank_txn (workspace_id, bank_account_id, value_date);

CREATE TABLE IF NOT EXISTS bank_txn_link (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id   TEXT NOT NULL REFERENCES bank_txn(id),
  kind          TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_txn_link_one_per_txn
  ON bank_txn_link (workspace_id, bank_txn_id);

CREATE INDEX IF NOT EXISTS bank_txn_link_target
  ON bank_txn_link (workspace_id, kind, target_id);

-- A36 (live bank feed): the workspace's debit-matching tuning (spec §4/§6b). One row per workspace,
-- upserted by set_camt_matching; absent means the defaults (value-date window +/- 5 days, review
-- threshold 'any'). These tune RANKING and review-event emission only: they never touch the mandatory
-- exact amount + currency gate on debit candidates (fuzzy amounts on the money path invite wrong
-- bookings). No CHECK on review_threshold: the enum lives at the verb boundary (the qr_match_config
-- convention). §H-TENANT via the workspace_id primary key.
CREATE TABLE IF NOT EXISTS camt_match_config (
  workspace_id            TEXT PRIMARY KEY REFERENCES workspace(id),
  value_date_window_days  INTEGER NOT NULL DEFAULT 5,
  review_threshold        TEXT NOT NULL DEFAULT 'any'
);
`;
