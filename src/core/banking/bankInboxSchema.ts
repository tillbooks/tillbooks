/**
 * A39's tables and guards (spec §4.1), appended to A20's `CAMT_SCHEMA_SQL` so they ride the one
 * banking DDL block the store already concatenates (the store module itself is not this capability's
 * to edit, so nothing here widens an existing table with an `ALTER TABLE`: every A39 fact lives in a
 * NEW table, spec §0.1 D-A39.1).
 *
 * THE LINE'S STATE IS A STRUCTURAL FACT. A bank line has one current state (`open`, `booked`,
 * `matched`, `ignored`), and it is derived from the line's ONE active link, never stored in a status
 * column that could drift from what was written. `bank_txn_link` (A20's table) stays the link: A39
 * writes every decision as a link row plus a `bank_line_decision` row keyed by the link id, which
 * carries what the decision was (its state, the entry or payment it created or matched, the ignore
 * reason, the remainder of a settlement) and the SUPERSESSION stamp that retires it.
 *
 * LINKS ARE NEVER DELETED, AND EXACTLY ONE IS ACTIVE. A20 enforced "one link per line, ever" with a
 * full unique index, which made a correction impossible (walk B11.2: a reversed booking kept its line
 * "Zugeordnet" forever). That index is no longer created, and generation 8 drops it from an older book
 * (`src/core/store/migrations.ts`; dropping an index loses no row). Two guards replace it, allowing
 * history but never two live answers:
 *
 *   1. `bank_line_decision_one_active`: a PARTIAL unique index over the decision rows that are not
 *      superseded. Every link A39 writes has a decision, so among A39's links at most one is live.
 *   2. `bank_txn_link_one_active`: a BEFORE INSERT trigger on `bank_txn_link` that aborts while the
 *      line already has an active DECISION. A link without a decision row is inert: every pre-A39 link
 *      is ADOPTED into a decision and its claims ONCE, by data migration generation 8
 *      (`src/core/store/migrations.ts`, spec L1), so there is ONE decision model at the storage layer
 *      and no legacy read path.
 *
 * Append-only is asserted the same way (each guard RAISEs ABORT, the shape the landscape copy's
 * self-maintaining trigger suspension recognises): no DELETE and no UPDATE on `bank_txn_link`; no
 * DELETE on `bank_line_decision`; an UPDATE of a decision may only stamp the three supersession columns,
 * once, and may change nothing else.
 *
 * RESTORE SAFETY. G04's backup copies tables in name order and re-mints surrogate ids only through a
 * DECLARED foreign key. So every id a decision holds is a single column with a REFERENCES clause
 * (`link_id`, `entry_id`, `payment_id`, `journal_line_id`), never a JSON list a
 * restore could not remap (the claims are one ROW per leg for the same reason), and
 * `bank_line_decision` sorts BEFORE `bank_txn_link`, so a superseded
 * decision is on disk before the link row that replaced it is inserted and the trigger above passes.
 *
 * A DECISION CLAIMS LEGS, NEVER ENTRIES (critic A39-1/A39-2). What a booked or matched line accounts
 * for is the specific `journal_line` rows on its Bankkonto's ledger account that carry its money: the
 * merged bank leg of an `accounts` entry, the bank leg of an A14 payment, each item payment's bank leg of
 * a batch, the one leg an existing entry was matched on. `bank_line_claim` holds one row per claimed leg,
 * and `bank_line_claim_one_active` (a PARTIAL unique index over the claims not yet released) makes "an
 * entry leg backs at most one active line" a storage fact: an own-account transfer entry has TWO bank
 * legs, one per account, so each side's line claims its own leg and neither can claim the other's
 * twice. A claim is released, never deleted, by the same stamp that supersedes its decision
 * (`bank_line_claim_release`), so the claim set and the active decisions cannot drift apart.
 *
 * `bank_txn_detail` carries the parsed counterparty facts (name, IBAN, remittance text, EndToEndId) the
 * inbox and the proposals read. It is kept OUT of A20's statement content hash and entry key on
 * purpose: a pre-A39 file re-imported after this lands must still answer `duplicate: true`, not
 * `statement_amended`.
 *
 * Bank rules and the per-account reconciliation switch are parked (spec §10): no table here.
 *
 * D167 (spec §13.1): `bank_standard` is the one narrow form of D-A39.5 that was un-parked. A standard
 * says "this counterparty, in this direction, books to this account and MWST code"; it PREFILLS a line
 * (the ladder's rung (c2)) and never posts. Append-only like a decision: no DELETE, an UPDATE may only
 * stamp `superseded_at`/`superseded_by` once, and a partial unique index keeps at most ONE live standard
 * per (workspace, counterparty key, direction). `superseded_by` is the actor, as on a decision, so the
 * table holds no self-reference a G04 restore would have to order.
 */

export const BANK_INBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bank_line_decision (
  link_id              TEXT PRIMARY KEY REFERENCES bank_txn_link(id),
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id          TEXT NOT NULL REFERENCES bank_txn(id),
  state                TEXT NOT NULL,
  target_kind          TEXT NOT NULL,
  entry_id             TEXT REFERENCES journal_entry(id),
  payment_id           TEXT REFERENCES payment(id),
  journal_line_id      TEXT REFERENCES journal_line(id),
  ignore_reason        TEXT,
  note                 TEXT,
  remainder_mode       TEXT,
  remainder_minor      INTEGER,
  accept_difference    INTEGER NOT NULL DEFAULT 0,
  difference_minor     INTEGER,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  superseded_at        TEXT,
  superseded_by        TEXT,
  supersede_reason     TEXT,
  -- D175 (critic D175-C5, generation 15): the Buchungsregel a \`rule\` target booked the line by, NULL for
  -- every other decision. Listed in ADDITIVE_COLUMNS (store/schema.ts) for a book written before it.
  rule_id              TEXT REFERENCES bank_standard(id),
  -- D178 E3 (A39 §17.7): the contact a \`contact\` target booked the line to, NULL for every other decision.
  -- Listed in ADDITIVE_COLUMNS (store/schema.ts) for a book written before it.
  contact_id           TEXT REFERENCES contact(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_line_decision_one_active
  ON bank_line_decision (workspace_id, bank_txn_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS bank_line_decision_entry
  ON bank_line_decision (workspace_id, entry_id);

CREATE INDEX IF NOT EXISTS bank_line_decision_payment
  ON bank_line_decision (workspace_id, payment_id);

CREATE INDEX IF NOT EXISTS bank_txn_link_by_txn
  ON bank_txn_link (workspace_id, bank_txn_id);

CREATE TRIGGER IF NOT EXISTS bank_txn_link_one_active
BEFORE INSERT ON bank_txn_link
WHEN EXISTS (
  SELECT 1 FROM bank_line_decision d JOIN bank_txn_link l ON l.id = d.link_id
   WHERE d.workspace_id = NEW.workspace_id AND d.bank_txn_id = NEW.bank_txn_id AND d.superseded_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'bank_txn_link: this bank line already has an active link; supersede it first');
END;

CREATE TRIGGER IF NOT EXISTS bank_txn_link_no_delete
BEFORE DELETE ON bank_txn_link
BEGIN
  SELECT RAISE(ABORT, 'bank_txn_link rows are never deleted: supersede the link instead');
END;

CREATE TRIGGER IF NOT EXISTS bank_txn_link_no_update
BEFORE UPDATE ON bank_txn_link
BEGIN
  SELECT RAISE(ABORT, 'bank_txn_link rows are immutable: the supersession lives on bank_line_decision');
END;

CREATE TRIGGER IF NOT EXISTS bank_line_decision_no_delete
BEFORE DELETE ON bank_line_decision
BEGIN
  SELECT RAISE(ABORT, 'bank_line_decision rows are never deleted');
END;

CREATE TRIGGER IF NOT EXISTS bank_line_decision_supersede_only
BEFORE UPDATE ON bank_line_decision
WHEN OLD.superseded_at IS NOT NULL
  OR NEW.superseded_at IS NULL
  OR NEW.link_id IS NOT OLD.link_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.bank_txn_id IS NOT OLD.bank_txn_id
  OR NEW.state IS NOT OLD.state
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.entry_id IS NOT OLD.entry_id
  OR NEW.payment_id IS NOT OLD.payment_id
  OR NEW.journal_line_id IS NOT OLD.journal_line_id
  OR NEW.ignore_reason IS NOT OLD.ignore_reason
  OR NEW.note IS NOT OLD.note
  OR NEW.remainder_mode IS NOT OLD.remainder_mode
  OR NEW.remainder_minor IS NOT OLD.remainder_minor
  OR NEW.accept_difference IS NOT OLD.accept_difference
  OR NEW.difference_minor IS NOT OLD.difference_minor
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'bank_line_decision: only the supersession stamp may be written, and only once');
END;

-- D175: the rule a decision was booked by is as immutable as the rest of the row. A second trigger, so the
-- A39 trigger in every existing book stays as it is (the \`bank_standard_recipe_frozen\` precedent); SQLite
-- resolves the column when the trigger fires, after ADDITIVE_COLUMNS added it.
CREATE TRIGGER IF NOT EXISTS bank_line_decision_rule_frozen
BEFORE UPDATE ON bank_line_decision
WHEN NEW.rule_id IS NOT OLD.rule_id
BEGIN
  SELECT RAISE(ABORT, 'bank_line_decision: only the supersession stamp may be written, and only once');
END;

-- D178 E3: the contact a decision booked the line to is as immutable as the rest of the row, by its own
-- trigger for the same reason as the rule's (every existing book keeps its A39 trigger as it is).
CREATE TRIGGER IF NOT EXISTS bank_line_decision_contact_frozen
BEFORE UPDATE ON bank_line_decision
WHEN NEW.contact_id IS NOT OLD.contact_id
BEGIN
  SELECT RAISE(ABORT, 'bank_line_decision: only the supersession stamp may be written, and only once');
END;

-- D178 E3 (owner, 21.10.2026): each clearing of a received Anzahlung's VAT when A14 applies the Guthaben
-- to an invoice (anzahlungVat.ts). One row per clearing entry, append-only, so \`reopen_bank_line\` finds and
-- reverses every clearing of a payment it undoes, and a replayed application clears nothing twice.
CREATE TABLE IF NOT EXISTS bank_anzahlung_vat_clearing (
  entry_id          TEXT PRIMARY KEY REFERENCES journal_entry(id),
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  payment_id        TEXT NOT NULL REFERENCES payment(id),
  receipt_entry_id  TEXT NOT NULL REFERENCES journal_entry(id),
  gross_minor       INTEGER NOT NULL,
  -- The Guthaben cash this clearing covers (an application's allocated cash, a refund's share), so the next
  -- clearing takes its share on the cumulative figure and the last one clears exactly what is left.
  applied_minor     INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('application', 'refund')),
  -- A refund correction (Entgeltsminderung): the refund line's decision, whose reopen reverses it.
  link_id           TEXT REFERENCES bank_txn_link(id),
  created_by        TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bank_anzahlung_vat_clearing_payment
  ON bank_anzahlung_vat_clearing (workspace_id, payment_id);

CREATE TRIGGER IF NOT EXISTS bank_anzahlung_vat_clearing_no_update
BEFORE UPDATE ON bank_anzahlung_vat_clearing
BEGIN
  SELECT RAISE(ABORT, 'bank_anzahlung_vat_clearing rows are immutable: a clearing is undone by its reversal');
END;

CREATE TRIGGER IF NOT EXISTS bank_anzahlung_vat_clearing_no_delete
BEFORE DELETE ON bank_anzahlung_vat_clearing
BEGIN
  SELECT RAISE(ABORT, 'bank_anzahlung_vat_clearing rows are never deleted');
END;

CREATE TABLE IF NOT EXISTS bank_line_claim (
  link_id          TEXT NOT NULL REFERENCES bank_txn_link(id),
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id      TEXT NOT NULL REFERENCES bank_txn(id),
  journal_line_id  TEXT NOT NULL REFERENCES journal_line(id),
  entry_id         TEXT NOT NULL REFERENCES journal_entry(id),
  amount_minor     INTEGER NOT NULL,
  released_at      TEXT,
  PRIMARY KEY (link_id, journal_line_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_line_claim_one_active
  ON bank_line_claim (workspace_id, journal_line_id) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS bank_line_claim_entry
  ON bank_line_claim (workspace_id, entry_id);

CREATE INDEX IF NOT EXISTS bank_line_claim_txn
  ON bank_line_claim (workspace_id, bank_txn_id);

CREATE TRIGGER IF NOT EXISTS bank_line_claim_release
AFTER UPDATE OF superseded_at ON bank_line_decision
WHEN OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
BEGIN
  UPDATE bank_line_claim SET released_at = NEW.superseded_at
   WHERE link_id = NEW.link_id AND released_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS bank_line_claim_no_delete
BEFORE DELETE ON bank_line_claim
BEGIN
  SELECT RAISE(ABORT, 'bank_line_claim rows are never deleted: a claim is released with its decision');
END;

CREATE TRIGGER IF NOT EXISTS bank_line_claim_release_only
BEFORE UPDATE ON bank_line_claim
WHEN OLD.released_at IS NOT NULL
  OR NEW.released_at IS NULL
  OR NEW.link_id IS NOT OLD.link_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.bank_txn_id IS NOT OLD.bank_txn_id
  OR NEW.journal_line_id IS NOT OLD.journal_line_id
  OR NEW.entry_id IS NOT OLD.entry_id
  OR NEW.amount_minor IS NOT OLD.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'bank_line_claim: only the release stamp may be written, and only once');
END;

CREATE TABLE IF NOT EXISTS bank_txn_detail (
  bank_txn_id        TEXT PRIMARY KEY REFERENCES bank_txn(id),
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  counterparty_name  TEXT,
  counterparty_iban  TEXT,
  remittance_text    TEXT,
  end_to_end_id      TEXT
);

CREATE INDEX IF NOT EXISTS bank_txn_detail_iban
  ON bank_txn_detail (workspace_id, counterparty_iban);

CREATE TABLE IF NOT EXISTS bank_standard (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  counterparty_key    TEXT NOT NULL,
  counterparty_label  TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  account_id          TEXT NOT NULL REFERENCES account(id),
  tax_code            TEXT,
  set_by              TEXT,
  set_at              TEXT NOT NULL,
  superseded_at       TEXT,
  superseded_by       TEXT,
  -- D175 (A39 §14.1, generation 15): the Buchungsregel. All four nullable: a row with legs_json NULL is a
  -- D167 standard and reads as the one-leg recipe (account_id, tax_code, the rest). A book written before
  -- generation 14 gains them through ADDITIVE_COLUMNS (store/schema.ts), where they are listed too.
  label               TEXT,
  match_text          TEXT,
  legs_json           TEXT,
  via_account_id      TEXT REFERENCES account(id),
  -- D176 (A39 §15.1, generation 16): a Buchungsregel has a SCOPE (\`bank\`: proposed on a matching bank line;
  -- \`manual\`: a Vorlage picked in the composer) and an OUTCOME (\`legs\`: book the recipe; \`ignore\`: propose
  -- "Nicht buchen" with a reason and a note), and may name a follow-up Vorlage. A MANUAL row has no
  -- counterparty: it is keyed \`vorlage:<the label's folded tokens>\` with direction 'out' and no match text, so
  -- the one-live index above keeps one live Vorlage per folded label (a real key is always \`iban:\` or
  -- \`name:\`, so the two can never meet). An IGNORE row has no legs; its NOT NULL \`account_id\` holds the
  -- Bankkonto ledger account of the line it was saved from, which nothing books to (the API answers null).
  -- A book written before generation 16 gains these through ADDITIVE_COLUMNS (store/schema.ts).
  scope               TEXT NOT NULL DEFAULT 'bank' CHECK (scope IN ('bank', 'manual')),
  outcome             TEXT NOT NULL DEFAULT 'legs' CHECK (outcome IN ('legs', 'ignore')),
  ignore_reason       TEXT,
  ignore_note         TEXT,
  follow_up_standard_id TEXT REFERENCES bank_standard(id)
);

-- D175: the one-live index is \`bank_standard_one_live_rule\` over (workspace, key, direction,
-- COALESCE(match_text, '')), created in ADDITIVE_INDEXES (store/schema.ts) because it names an additive
-- column. The D167 index \`bank_standard_one_live\` is no longer created; generation 15 drops it.

CREATE TRIGGER IF NOT EXISTS bank_standard_no_delete
BEFORE DELETE ON bank_standard
BEGIN
  SELECT RAISE(ABORT, 'bank_standard rows are never deleted: supersede the standard instead');
END;

CREATE TRIGGER IF NOT EXISTS bank_standard_supersede_only
BEFORE UPDATE ON bank_standard
WHEN OLD.superseded_at IS NOT NULL
  OR NEW.superseded_at IS NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.counterparty_key IS NOT OLD.counterparty_key
  OR NEW.counterparty_label IS NOT OLD.counterparty_label
  OR NEW.direction IS NOT OLD.direction
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.tax_code IS NOT OLD.tax_code
  OR NEW.set_by IS NOT OLD.set_by
  OR NEW.set_at IS NOT OLD.set_at
BEGIN
  SELECT RAISE(ABORT, 'bank_standard: only the supersession stamp may be written, and only once');
END;

-- D175: the recipe columns are as immutable as the rest of the row (an edit supersedes). A SECOND trigger
-- rather than a widened \`bank_standard_supersede_only\`, so the D167 trigger in every existing book stays
-- exactly as it is and no generation step has to drop and re-create it. SQLite resolves NEW/OLD column
-- names when the trigger fires, not when it is created, so on a pre-generation-15 book this CREATE runs
-- before ADDITIVE_COLUMNS adds the columns, and nothing updates the table in between.
CREATE TRIGGER IF NOT EXISTS bank_standard_recipe_frozen
BEFORE UPDATE ON bank_standard
WHEN NEW.label IS NOT OLD.label
  OR NEW.match_text IS NOT OLD.match_text
  OR NEW.legs_json IS NOT OLD.legs_json
  OR NEW.via_account_id IS NOT OLD.via_account_id
BEGIN
  SELECT RAISE(ABORT, 'bank_standard: only the supersession stamp may be written, and only once');
END;

-- D176: the scope, the outcome and the follow-up are as immutable as the recipe (an edit supersedes). A
-- THIRD trigger, for the reason the second one is separate: every existing trigger stays exactly as it is.
CREATE TRIGGER IF NOT EXISTS bank_standard_outcome_frozen
BEFORE UPDATE ON bank_standard
WHEN NEW.scope IS NOT OLD.scope
  OR NEW.outcome IS NOT OLD.outcome
  OR NEW.ignore_reason IS NOT OLD.ignore_reason
  OR NEW.ignore_note IS NOT OLD.ignore_note
  OR NEW.follow_up_standard_id IS NOT OLD.follow_up_standard_id
BEGIN
  SELECT RAISE(ABORT, 'bank_standard: only the supersession stamp may be written, and only once');
END;

`;
