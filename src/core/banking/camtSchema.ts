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
 * `bank_txn_id` on `reconciliation_match` (A21 already carries that nullable seam). "Matched" is a
 * structural fact (an active link row) rather than a derived status column that could drift from what
 * was actually written.
 *
 * A39 (the bank inbox, 25.09.2026) keeps this table as THE link and widens what it means: every line
 * decision (booked, matched, ignored) is a link row, a correction SUPERSEDES the active link through the
 * A39 decision row instead of deleting it, and exactly one link per line is active. See
 * `bankInboxSchema.ts` for the guards that replaced A20's one-link-ever unique index.
 */

import { BANK_INBOX_SCHEMA_SQL } from './bankInboxSchema.js';

/**
 * D178 point 19 (the round 3 re-cut, A20 §11.4, generation 18): THE ONE CHOKEPOINT of "not bookable until
 * decided". Every booking, settlement and match of a bank line writes its active row into
 * `bank_line_decision` (line state is derived from it), so this trigger refuses any active row other than
 * an ignore while the line carries a possible-duplicate flag whose latest answer is not 'distinct'. The
 * verbs refuse first, readably (`duplicate_decision_pending`, writeLineLink and performBooking); this is
 * the second line, for a path that forgets. `resolve_possible_duplicate` (duplicate) writes its ignore first.
 */
export const DUPLICATE_CHOKEPOINT_SQL = `
CREATE TRIGGER IF NOT EXISTS bank_line_decision_duplicate_pending
BEFORE INSERT ON bank_line_decision
WHEN NEW.state <> 'ignored' AND NEW.superseded_at IS NULL
  AND EXISTS (SELECT 1 FROM bank_txn_possible_duplicate pd WHERE pd.workspace_id = NEW.workspace_id AND pd.bank_txn_id = NEW.bank_txn_id)
  AND COALESCE((SELECT dd.decision FROM bank_txn_duplicate_decision dd
                 WHERE dd.workspace_id = NEW.workspace_id AND dd.bank_txn_id = NEW.bank_txn_id
                 ORDER BY dd.decided_at DESC, dd.rowid DESC LIMIT 1), '') <> 'distinct'
BEGIN
  SELECT RAISE(ABORT, 'duplicate_decision_pending: the line is flagged as a possible duplicate and not decided');
END;
`;

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
  imported_at           TEXT NOT NULL,
  -- D178 point 19 (A20 §11.4, generation 18): how coverage classified the delivery at import, 'extends'
  -- (it extended the balance chain: its lines were new) or 'checked' (its lines were matched against the
  -- covered span); NULL for a statement imported before. Its later pages take the same classification.
  -- Listed in ADDITIVE_COLUMNS (store/schema.ts) for a book written before it.
  coverage              TEXT
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

-- A39: the A20 unique index "one link per line, ever" (bank_txn_link_one_per_txn) is gone; data
-- migration generation 8 drops it from an older file, and A39's BANK_INBOX_SCHEMA_SQL (appended below)
-- holds "exactly one ACTIVE link per line" instead (a partial unique index plus an insert trigger), so
-- a correction can supersede a link without ever deleting it.

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

-- A36 §4.7 (D150): APPEND-ONLY, one row per confirmation that a statement gap holds nothing (a person
-- says the numbers between two neighbouring day-end statements carry no money) and one per withdrawal
-- of it. The LATEST row of a pair (after, before) decides; nothing here is ever updated or deleted. A
-- row is written only for a gap whose balances chain (difference_minor 0, recorded as evidence). It
-- hides the attention item and nothing else: the successor rule still imports a statement found later.
-- No CHECK on action: the enum (confirm | revoke) lives at the verb boundary.
CREATE TABLE IF NOT EXISTS bank_statement_gap_ack (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  bank_account_id      TEXT NOT NULL REFERENCES bank_account(id),
  after_statement_id   TEXT NOT NULL REFERENCES bank_statement(id),
  before_statement_id  TEXT NOT NULL REFERENCES bank_statement(id),
  action               TEXT NOT NULL,
  reason               TEXT NOT NULL,
  difference_minor     INTEGER NOT NULL,
  actor                TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bank_statement_gap_ack_by_pair
ON bank_statement_gap_ack (workspace_id, bank_account_id, after_statement_id, before_statement_id);

-- Critic LOW 1: append-only is a property of the table, not of the code that writes it (the
-- bank_line_decision precedent). A withdrawal is a new 'revoke' row, never an edit.
CREATE TRIGGER IF NOT EXISTS bank_statement_gap_ack_no_update
BEFORE UPDATE ON bank_statement_gap_ack
BEGIN
  SELECT RAISE(ABORT, 'bank_statement_gap_ack rows are immutable: a withdrawal is a new revoke row');
END;

CREATE TRIGGER IF NOT EXISTS bank_statement_gap_ack_no_delete
BEFORE DELETE ON bank_statement_gap_ack
BEGIN
  SELECT RAISE(ABORT, 'bank_statement_gap_ack rows are never deleted');
END;

-- D178 points 3 and 4 (spec A20 §11.1): what a statement says about a line beyond its booked fact, one
-- row per line, written ONCE at import (statementFacts.ts) and never changed, like bank_txn itself. A NEW
-- table rather than new bank_txn columns so neither the D81 identity key nor the statement content hash
-- moves: a camt imported before it still re-imports as duplicate:true. A line imported before it has no
-- row (the file is not stored, so its facts cannot be re-derived) and reads facts: null.
-- The three bank texts are named so the landscape sanitiser's free-text rule covers them by name
-- (remittance_text = RmtInf/Ustrd, description = AddtlTxInf, remark = AddtlNtryInf). Every money
-- column is integer hundredths of the currency as written; a rate is the bank's decimal string.
CREATE TABLE IF NOT EXISTS bank_txn_fact (
  bank_txn_id             TEXT PRIMARY KEY REFERENCES bank_txn(id),
  workspace_id            TEXT NOT NULL REFERENCES workspace(id),
  source                  TEXT NOT NULL,
  btc_domain              TEXT,
  btc_family              TEXT,
  btc_sub_family          TEXT,
  btc_proprietary         TEXT,
  btc_issuer              TEXT,
  remittance_text         TEXT,
  description             TEXT,
  remark                  TEXT,
  end_to_end_id           TEXT,
  acct_svcr_ref           TEXT,
  instruction_id          TEXT,
  transaction_id          TEXT,
  instructed_minor        INTEGER,
  instructed_currency     TEXT,
  tx_amount_minor         INTEGER,
  tx_amount_currency      TEXT,
  counter_value_minor     INTEGER,
  counter_value_currency  TEXT,
  fx_source_currency      TEXT,
  fx_target_currency      TEXT,
  fx_unit_currency        TEXT,
  fx_rate                 TEXT,
  fx_effective_rate       TEXT,
  fx_origin               TEXT,
  charges_total_minor     INTEGER,
  charges_currency        TEXT,
  charges_records         TEXT,
  charges_origin          TEXT,
  fee_minor               INTEGER,
  fee_currency            TEXT,
  fee_included            INTEGER,
  fee_origin              TEXT,
  created_at              TEXT NOT NULL
);

-- D178 point 4 (spec A20 §11.3): the CSV column mapping of one Bankkonto, saved once and reused. One live
-- row per account (a later save replaces it, each change is in the audit log). The mapping names columns
-- by their header TEXT, never by position, so a re-export with reordered columns still maps.
CREATE TABLE IF NOT EXISTS bank_csv_mapping (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  bank_account_id  TEXT NOT NULL REFERENCES bank_account(id),
  mapping_json     TEXT NOT NULL,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_csv_mapping_one_per_account
  ON bank_csv_mapping (workspace_id, bank_account_id);

-- D178 (spec A20 §11.4, "warn, don't block"): a new line that RESEMBLES a stored one without strong proof
-- that it is the same movement is imported and named here, once, at import (statementDedupe.ts). The
-- person decides on the bank inbox (ignore it as "Duplikat", or keep it); nothing is ever dropped on a
-- guess. One row per flagged line; reason is POSSIBLE_DUPLICATE_REASONS.
CREATE TABLE IF NOT EXISTS bank_txn_possible_duplicate (
  bank_txn_id           TEXT PRIMARY KEY REFERENCES bank_txn(id),
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  -- The first stored line the flag names; NULL for 'covered_period_new_line' with nothing to name.
  existing_bank_txn_id  TEXT REFERENCES bank_txn(id),
  reason                TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

-- D178 point 19 (owner): EVERY stored line a flagged line may be (the flag above is the nearest), the
-- nearest first (rank 0). Naming never uses a stored line up: it may be a candidate of several lines.
CREATE TABLE IF NOT EXISTS bank_txn_duplicate_candidate (
  bank_txn_id           TEXT NOT NULL REFERENCES bank_txn(id),
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  existing_bank_txn_id  TEXT NOT NULL REFERENCES bank_txn(id),
  reason                TEXT NOT NULL,
  rank                  INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (bank_txn_id, existing_bank_txn_id)
);

-- D178 point 19 (owner): the person's answer on a flagged line, append-only (the latest row is in force):
-- 'duplicate' (the line was ignored with that reason; reopened, it needs a decision again) or 'distinct'
-- (a normal line). Who and when, for the audit trail; a re-import never touches it.
CREATE TABLE IF NOT EXISTS bank_txn_duplicate_decision (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id        TEXT NOT NULL REFERENCES bank_txn(id),
  decision           TEXT NOT NULL,
  other_bank_txn_id  TEXT REFERENCES bank_txn(id),
  note               TEXT,
  decided_by         TEXT NOT NULL,
  decided_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bank_txn_duplicate_decision_line ON bank_txn_duplicate_decision (workspace_id, bank_txn_id);

-- D178 point 19 (critic R3-5, generation 18): a person's answer is append-only: a new answer is a new row.
CREATE TRIGGER IF NOT EXISTS bank_txn_duplicate_decision_no_update
BEFORE UPDATE ON bank_txn_duplicate_decision
BEGIN
  SELECT RAISE(ABORT, 'bank_txn_duplicate_decision is append-only: an answer is never rewritten, a new answer is a new row');
END;

CREATE TRIGGER IF NOT EXISTS bank_txn_duplicate_decision_no_delete
BEFORE DELETE ON bank_txn_duplicate_decision
BEGIN
  SELECT RAISE(ABORT, 'bank_txn_duplicate_decision rows are never deleted');
END;

-- D178 point 19 (A20 §11.4, generation 18): a line's movement key (booking date, else value date; direction;
-- amount; currency) is an expression over its own columns, so EVERY stored line has it, history included,
-- and coverage's one-to-one match reads it through this index.
CREATE INDEX IF NOT EXISTS bank_txn_movement
  ON bank_txn (workspace_id, bank_account_id, COALESCE(booking_date, value_date), credit_debit, amount_minor, currency);

CREATE INDEX IF NOT EXISTS bank_txn_account_booking ON bank_txn (workspace_id, bank_account_id, booking_date);
${BANK_INBOX_SCHEMA_SQL}
${DUPLICATE_CHOKEPOINT_SQL}`;
