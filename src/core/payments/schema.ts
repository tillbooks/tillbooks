/**
 * A14's tables (data model §D0, extended with the A07-Ist seam and the counterparty).
 *
 * Kept in A14's own module and concatenated onto `SCHEMA_SQL` at the store, so the money-path DDL
 * this capability owns sits beside the code that writes it and the §H-FX foundation landing in
 * `core/store/**` at the same time does not collide with it.
 *
 * TWO THINGS ARE DERIVED, NOT STORED, and both are deliberate:
 *
 *  1. **The unallocated remainder (the Guthaben).** It is `payment.amount_minor` minus the sum of
 *     its allocations, never a column. Storing it would mean `allocate_payment` had to UPDATE a
 *     money column on a posted payment, which is precisely the mutation §H-AUDIT forbids. Deriving
 *     it makes allocating a credit a pure INSERT and lets the immutability trigger below be
 *     absolute rather than carrying an exception it would then have to police.
 *  2. **A document's open amount and its paid status.** They are recomputed from the allocations of
 *     NON-reversed payments (A14 §4: derived, not a second source of truth). A reversal therefore
 *     re-opens every document it touched by flipping one status word, with no allocation row
 *     rewritten and nothing deleted.
 *
 * The counterparty on `payment` is A14 §4's missing piece, filed as spec defect 1: the spec
 * described a customer credit while its own row carried no customer, so an over-payment created
 * money belonging to nobody, A16 could not net it into a customer balance, and a later allocation
 * could not be scoped to that customer's open items. It is NOT NULL in spirit and nullable in the
 * column only because an outgoing payment may name a supplier instead; the engine requires one
 * whenever a remainder is parked (`needs_counterparty`).
 */

export const PAYMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payment (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  direction          TEXT NOT NULL,
  date               TEXT NOT NULL,
  amount_minor       INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'CHF',
  base_amount_minor  INTEGER NOT NULL,
  fx_rate            TEXT,
  bank_account_id    TEXT NOT NULL REFERENCES account(id),
  counterparty_kind  TEXT,
  counterparty_id    TEXT REFERENCES contact(id),
  reference_kind     TEXT,
  reference_value    TEXT,
  status             TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'manual',
  journal_entry_id   TEXT REFERENCES journal_entry(id),
  reversal_entry_id  TEXT REFERENCES journal_entry(id),
  reversed_at        TEXT,
  idempotency_key    TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL
);

-- One row per settled item. The target is polymorphic (Pattern OP3): a customer document today, an
-- A17 vendor bill when A17 lands. skonto_vat_minor is stored beside skonto_minor because the two
-- are ONE Entgeltsminderung under MWSTG Art. 41 and a reader who has to re-derive the VAT half from
-- a rate would be re-deriving money the ledger already booked.
CREATE TABLE IF NOT EXISTS payment_allocation (
  id                TEXT PRIMARY KEY,
  payment_id        TEXT NOT NULL REFERENCES payment(id),
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  target_kind       TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  -- THREE amounts, because a cross-currency settlement genuinely has three (§H-FX):
  --   amount_minor          what this settles on the DOCUMENT, in the document's currency;
  --   payment_amount_minor  the cash it consumes, in the PAYMENT's currency;
  --   base_amount_minor     the base-currency value the receivable was RELEASED at, which is the
  --                         document's own booked base and not the payment-date conversion. The gap
  --                         between the two conversions is the realised FX difference the settlement
  --                         entry posts.
  -- For a single-currency settlement all three are the same integer and nothing above applies.
  amount_minor      INTEGER NOT NULL,
  payment_amount_minor INTEGER NOT NULL,
  base_amount_minor INTEGER NOT NULL,
  skonto_minor      INTEGER NOT NULL DEFAULT 0,
  skonto_vat_minor  INTEGER NOT NULL DEFAULT 0,
  writeoff_minor    INTEGER NOT NULL DEFAULT 0,
  tax_base_minor    INTEGER,
  tax_amount_minor  INTEGER,
  recognized_at     TEXT,
  journal_entry_id  TEXT REFERENCES journal_entry(id),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_allocation_target
ON payment_allocation (workspace_id, target_kind, target_id);

CREATE INDEX IF NOT EXISTS payment_by_workspace ON payment (workspace_id, date);

-- §H-IDEMPOTENT, at the DB layer as well as the verb layer: one payment per (workspace, key), so
-- even a cross-process race cannot mint a second payment under a key that already minted one.
CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency
ON payment (workspace_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- The write-off threshold that decides whether the one-click "Differenz ausbuchen" offer appears
-- (design decision P4, default CHF 1.00). A14 READS it and owns no editor for it: the value belongs
-- beside the write-off account on A05's settings surface, and P4 is still with the owner. Absent
-- row means the default, so a workspace that never configures one behaves correctly.
CREATE TABLE IF NOT EXISTS payment_config (
  workspace_id              TEXT PRIMARY KEY REFERENCES workspace(id),
  write_off_threshold_minor INTEGER NOT NULL
);

-- §H-AUDIT at the DB layer, the same posture the journal already takes: no code path, plugin, or
-- raw statement may edit or delete a payment. The ONLY permitted update is the reversal stamp
-- (status + reversal entry + reversed_at); every identity or money column is frozen, so there is no
-- edit path on a posted payment anywhere in the engine, by construction rather than by review.
CREATE TRIGGER IF NOT EXISTS payment_no_money_update
BEFORE UPDATE ON payment
WHEN OLD.direction        <> NEW.direction
  OR OLD.date             <> NEW.date
  OR OLD.amount_minor     <> NEW.amount_minor
  OR OLD.currency         <> NEW.currency
  OR OLD.base_amount_minor<> NEW.base_amount_minor
  OR OLD.bank_account_id  <> NEW.bank_account_id
  OR OLD.workspace_id     <> NEW.workspace_id
  OR IFNULL(OLD.counterparty_kind, '') <> IFNULL(NEW.counterparty_kind, '')
  OR IFNULL(OLD.counterparty_id, '')   <> IFNULL(NEW.counterparty_id, '')
  OR IFNULL(OLD.journal_entry_id, '')  <> IFNULL(NEW.journal_entry_id, '')
  OR IFNULL(OLD.idempotency_key, '')   <> IFNULL(NEW.idempotency_key, '')
BEGIN
  SELECT RAISE(ABORT, 'payment_immutable');
END;

CREATE TRIGGER IF NOT EXISTS payment_no_delete
BEFORE DELETE ON payment
BEGIN
  SELECT RAISE(ABORT, 'payment_immutable');
END;

-- An allocation row IS the accounting record of one settlement (A14 §6b fixes its columns), so it
-- is append-only outright: no update, no delete, no exception. Reversal re-opens a document by
-- flipping the PAYMENT's status, which is why nothing here ever needs to change.
CREATE TRIGGER IF NOT EXISTS payment_allocation_no_update
BEFORE UPDATE ON payment_allocation
BEGIN
  SELECT RAISE(ABORT, 'payment_allocation_immutable');
END;

CREATE TRIGGER IF NOT EXISTS payment_allocation_no_delete
BEFORE DELETE ON payment_allocation
BEGIN
  SELECT RAISE(ABORT, 'payment_allocation_immutable');
END;
`;
