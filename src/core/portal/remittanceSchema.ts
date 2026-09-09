/**
 * F03's two tables (data model §D): the remittance advice and its per-bill lines. Kept in the portal
 * module beside the code that writes them (the A14/A19/F02 pattern) and concatenated onto
 * `SCHEMA_SQL` at the store.
 *
 * A REMITTANCE ADVICE IS A POINT-IN-TIME SNAPSHOT, NOT A LIVE VIEW (spec §4 "Money correctness").
 * Every amount is an integer Rappen copied AS A VALUE from the A14 payment and its `payment_allocation`
 * rows at generation time, never recomputed on read. This module opens NO posting path: A14 already
 * posted the payment, and F03 only files a derived document about it (spec §7: the P3 validator
 * asserts no `postEntry`/`recordPayment` in `vendorPortal.ts`).
 *
 * §H-FX AT ROW LEVEL. Every `remittance_advice_line` stores the txn amount, the CHF base amount and
 * the rate, snapshotted from the A14 allocation's `amount_minor`/`base_amount_minor` and the payment's
 * `fx_rate`. For a CHF line `amount_base_rappen = amount_rappen` and `fx_rate = '1'`. The header
 * `total_base_rappen` equals Σ line `amount_base_rappen` BY CONSTRUCTION (integer equality, no
 * re-derivation), which is what the invariant test asserts.
 *
 * §H-TENANT: both tables carry `workspace_id`.
 *
 * §H-AUDIT: the advice is IMMUTABLE. A correction is a NEW advice that supersedes the old one via
 * `supersedes_id` (the E00 versioning spirit), never a destructive edit. The BEFORE-UPDATE trigger
 * makes that structural rather than a matter of review: no money, identity or link column may move
 * once written. A row is never deleted.
 */

export const REMITTANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS remittance_advice (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  payment_id            TEXT NOT NULL REFERENCES payment(id),
  supplier_contact_id   TEXT NOT NULL REFERENCES contact(id),
  payment_date          TEXT NOT NULL,
  total_rappen          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'CHF',
  total_base_rappen     INTEGER NOT NULL,
  fx_rate               TEXT,
  artifact_document_id  TEXT REFERENCES stored_file(id),
  supersedes_id         TEXT REFERENCES remittance_advice(id),
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

-- The supplier/agent token read and the operator preview both list advices per supplier per workspace.
CREATE INDEX IF NOT EXISTS remittance_advice_by_supplier
ON remittance_advice (workspace_id, supplier_contact_id, created_at);

-- The idempotent create looks an advice up by the payment it is about.
CREATE INDEX IF NOT EXISTS remittance_advice_by_payment
ON remittance_advice (workspace_id, payment_id);

CREATE TABLE IF NOT EXISTS remittance_advice_line (
  id                 TEXT PRIMARY KEY,
  advice_id          TEXT NOT NULL REFERENCES remittance_advice(id),
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  bill_id            TEXT NOT NULL REFERENCES vendor_bill(id),
  amount_rappen      INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'CHF',
  -- §H-FX at row level: the CHF base and the rate, snapshotted from the A14 allocation. For a CHF
  -- line amount_base_rappen = amount_rappen and fx_rate = '1'.
  amount_base_rappen INTEGER NOT NULL,
  fx_rate            TEXT NOT NULL,
  sort               INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS remittance_advice_line_by_advice
ON remittance_advice_line (workspace_id, advice_id, sort);

-- §H-AUDIT at the DB layer (the A14 payment posture): a remittance advice is a frozen snapshot. The
-- ONLY permitted update is stamping the E00 artifact id ONCE (NULL -> a value), so the render can
-- file its Beleg after the row is written; every money, identity and link column is otherwise frozen.
-- A correction is a NEW advice with supersedes_id set, never an edit.
CREATE TRIGGER IF NOT EXISTS remittance_advice_immutable
BEFORE UPDATE ON remittance_advice
WHEN OLD.workspace_id        <> NEW.workspace_id
  OR OLD.payment_id          <> NEW.payment_id
  OR OLD.supplier_contact_id <> NEW.supplier_contact_id
  OR OLD.total_rappen        <> NEW.total_rappen
  OR OLD.currency            <> NEW.currency
  OR OLD.total_base_rappen   <> NEW.total_base_rappen
  OR IFNULL(OLD.fx_rate, '')              <> IFNULL(NEW.fx_rate, '')
  OR IFNULL(OLD.supersedes_id, '')        <> IFNULL(NEW.supersedes_id, '')
  OR OLD.created_by          <> NEW.created_by
  OR OLD.created_at          <> NEW.created_at
  OR (OLD.artifact_document_id IS NOT NULL AND IFNULL(OLD.artifact_document_id, '') <> IFNULL(NEW.artifact_document_id, ''))
BEGIN
  SELECT RAISE(ABORT, 'remittance_advice_immutable');
END;

-- A line never changes at all once written.
CREATE TRIGGER IF NOT EXISTS remittance_advice_line_immutable
BEFORE UPDATE ON remittance_advice_line
BEGIN
  SELECT RAISE(ABORT, 'remittance_advice_line_immutable');
END;
`;
