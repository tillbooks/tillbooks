/**
 * A17's one table, kept in A17's own module (the pattern A14/A19/A24/G00/D00 established: a
 * capability's DDL sits beside the code that writes it and is concatenated onto `SCHEMA_SQL` at the
 * store, so concurrent capability branches never all edit one long string).
 *
 * TWO THINGS ARE DERIVED, NOT STORED, and both are deliberate.
 *
 *  1. **The settlement half of the status.** `status` carries the lifecycle A17 owns
 *     (`draft` / `posted` / `void`) and NOTHING about payment. `partly_paid` and `paid` are computed
 *     per read from `payment_allocation`, which is where A14 writes them. There is therefore no
 *     column for A14 to update on a posted, immutable row, and no second source of truth that could
 *     disagree with the ledger. A16 §4 says "status derivation, not stored twice" about the
 *     receivable side and A14 still writes `document.status` because A10's state machine owns that
 *     column; the payable side has no such machine, so it takes the stronger option.
 *  2. **The open amount.** `payable_minor` minus the allocations of non-reversed payments. Storing it
 *     would mean a settlement had to UPDATE a money column on a posted bill, which is exactly the
 *     mutation §H-AUDIT forbids, and a reversal would have to restore a remembered figure instead of
 *     simply ceasing to count.
 *
 * `payable_minor` IS ITS OWN COLUMN AND IS NOT `gross_minor`, and the difference is statutory rather
 * than tidy. What a bill's counter leg credits to 2000 Kreditoren depends on the tax kind:
 *
 *  - ordinary Vorsteuer (Art. 28) credits the GROSS: the supplier billed net plus Swiss VAT;
 *  - Bezugsteuer (Art. 45) credits the NET: a foreign supplier charges no Swiss VAT at all, and the
 *    tax is owed to the ESTV rather than to the creditor;
 *  - Einfuhrsteuer (Art. 50) credits the assessed TAX: the customs bill IS the amount.
 *
 * A Kreditoren list that showed `gross_minor` would overstate what is owed on every Bezugsteuer bill
 * and understate the reconciliation to 2000, so the amount the ledger actually credited is stored as
 * the one figure a payment settles against. Both figures are kept: `net`/`tax`/`gross` are the
 * §H-VAT-TRACE arithmetic A07 reads, `payable` is the debt.
 *
 * The `base_*` columns are NULL on a draft and filled on post, READ BACK OFF THE POSTED ENTRY rather
 * than recomputed (§H-FX allocates base amounts per SIDE, so a per-line multiplication is not what
 * the ledger holds). A draft has no base figures because it has no rate: it has not been converted.
 */

export const PURCHASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vendor_bill (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  contact_id          TEXT NOT NULL REFERENCES contact(id),
  bill_date           TEXT NOT NULL,
  due_date            TEXT,
  -- The Leistungsdatum that PRICES the VAT (A06 resolves the rate era from it), never the booking
  -- date by default: a 2023 supply invoiced in 2024 books 7.7%.
  supply_date         TEXT,
  -- The supplier's own invoice number: what a Kreditoren list is searched by and what a payment
  -- reference quotes. Free text, because a foreign vendor's numbering is not ours to constrain.
  vendor_reference    TEXT,
  currency            TEXT NOT NULL DEFAULT 'CHF',
  -- Which figure the operator ENTERED, kept so a replay of the same input reproduces the same trace
  -- (A06 preserves the entered amount verbatim, and which one that is changes the rounding).
  amount_is_gross     INTEGER NOT NULL DEFAULT 1,
  net_minor           INTEGER NOT NULL,
  tax_code            TEXT,
  tax_amount_minor    INTEGER NOT NULL DEFAULT 0,
  gross_minor         INTEGER NOT NULL,
  -- What the counter leg credits to 2000 Kreditoren, and therefore the debt a payment settles.
  payable_minor       INTEGER NOT NULL,
  expense_account_id  TEXT NOT NULL REFERENCES account(id),
  cost_center_id      TEXT REFERENCES cost_center(id),
  -- B03 (the project cost dimension): which B00 project this purchase belongs to, or NULL for an
  -- untagged bill. A REPORTING dimension only: it prices nothing, posts nothing and never appears
  -- on a journal leg; B03's expenses/purchases components read it. Set at capture, frozen on post
  -- like cost_center_id (the trigger below). Also in ADDITIVE_COLUMNS for pre-existing files.
  project_id          TEXT REFERENCES project(id),
  receipt_ref         TEXT,
  status              TEXT NOT NULL,
  base_net_minor      INTEGER,
  base_tax_minor      INTEGER,
  base_gross_minor    INTEGER,
  base_payable_minor  INTEGER,
  fx_rate             TEXT,
  entry_id            TEXT REFERENCES journal_entry(id),
  reversal_entry_id   TEXT REFERENCES journal_entry(id),
  void_reason         TEXT,
  idempotency_key     TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  posted_at           TEXT,
  -- G21 additive column: the carry-forward origin (native or migrated), the AP mirror of
  -- document.origin. A migrated bill is an open Kreditor brought across at a cutover, created
  -- directly at status='posted' with entry_id NULL and posting NOTHING (its only ledger effect is
  -- A04's aggregate 2000 opening line). Declared here for a FRESH database and repeated in
  -- ADDITIVE_COLUMNS so a pre-G21 file widens on open, reading every existing bill as native. It
  -- selects whether the poster runs, so it is a fixed section-H-ENUM, never a custom field.
  origin              TEXT NOT NULL DEFAULT 'native'
);

CREATE INDEX IF NOT EXISTS vendor_bill_by_workspace ON vendor_bill (workspace_id, bill_date);
CREATE INDEX IF NOT EXISTS vendor_bill_by_vendor ON vendor_bill (workspace_id, contact_id);

-- §H-IDEMPOTENT at the DB layer as well as the verb layer, the guarantee A14's payment table takes:
-- one bill per (workspace, key), so even a cross-process race cannot mint a second bill under a key
-- that already minted one. PARTIAL, because a key is optional on the column and NULL means "no key".
CREATE UNIQUE INDEX IF NOT EXISTS vendor_bill_idempotency
ON vendor_bill (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- §H-AUDIT at the DB layer. A DRAFT is freely editable, which is what a draft is for. Once the bill
-- is POSTED every accounting column is frozen by construction rather than by review: the only
-- permitted updates are the receipt reference (a Buchungsbeleg is filed after the booking at least as
-- often as before it, and OR 958f is about keeping it, not about when it arrives) and the void stamp.
CREATE TRIGGER IF NOT EXISTS vendor_bill_no_accounting_update
BEFORE UPDATE ON vendor_bill
WHEN OLD.status <> 'draft'
 AND (OLD.workspace_id           <> NEW.workspace_id
   OR OLD.contact_id             <> NEW.contact_id
   OR OLD.bill_date              <> NEW.bill_date
   OR IFNULL(OLD.due_date, '')   <> IFNULL(NEW.due_date, '')
   OR IFNULL(OLD.supply_date,'') <> IFNULL(NEW.supply_date, '')
   OR OLD.currency               <> NEW.currency
   OR OLD.amount_is_gross        <> NEW.amount_is_gross
   OR OLD.net_minor              <> NEW.net_minor
   OR IFNULL(OLD.tax_code, '')   <> IFNULL(NEW.tax_code, '')
   OR OLD.tax_amount_minor       <> NEW.tax_amount_minor
   OR OLD.gross_minor            <> NEW.gross_minor
   OR OLD.payable_minor          <> NEW.payable_minor
   OR OLD.expense_account_id     <> NEW.expense_account_id
   OR IFNULL(OLD.cost_center_id, '')     <> IFNULL(NEW.cost_center_id, '')
   OR IFNULL(OLD.project_id, '')         <> IFNULL(NEW.project_id, '')
   OR IFNULL(OLD.base_net_minor, -1)     <> IFNULL(NEW.base_net_minor, -1)
   OR IFNULL(OLD.base_tax_minor, -1)     <> IFNULL(NEW.base_tax_minor, -1)
   OR IFNULL(OLD.base_gross_minor, -1)   <> IFNULL(NEW.base_gross_minor, -1)
   OR IFNULL(OLD.base_payable_minor, -1) <> IFNULL(NEW.base_payable_minor, -1)
   OR IFNULL(OLD.fx_rate, '')            <> IFNULL(NEW.fx_rate, '')
   OR IFNULL(OLD.entry_id, '')           <> IFNULL(NEW.entry_id, '')
   OR IFNULL(OLD.idempotency_key, '')    <> IFNULL(NEW.idempotency_key, '')
   -- G21 (structural no-second-posting, fact c): a posted bill's origin is frozen. A migrated bill
   -- cannot be flipped to 'native' and then re-posted, because its own status is already 'posted'
   -- and this trigger refuses the origin edit outright.
   OR OLD.origin                         <> NEW.origin)
BEGIN
  SELECT RAISE(ABORT, 'vendor_bill_immutable');
END;

-- The lifecycle is one-way. A posted bill may only become void, a void bill may not come back, and
-- nothing may return to draft: an un-posting would leave a posted journal entry with no bill behind
-- it, which is the state the whole reversal discipline exists to avoid.
CREATE TRIGGER IF NOT EXISTS vendor_bill_status_is_one_way
BEFORE UPDATE OF status ON vendor_bill
WHEN (OLD.status = 'void' AND NEW.status <> 'void')
  OR (OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'void'))
BEGIN
  SELECT RAISE(ABORT, 'vendor_bill_status_is_one_way');
END;

-- No code path, plugin or raw statement removes a bill. A draft is discarded by voiding it, which
-- leaves the record and says what happened to it; a posted bill is corrected by a reversing entry.
CREATE TRIGGER IF NOT EXISTS vendor_bill_no_delete
BEFORE DELETE ON vendor_bill
BEGIN
  SELECT RAISE(ABORT, 'vendor_bill_immutable');
END;
`;
