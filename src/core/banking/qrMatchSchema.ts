/**
 * A21's two tables, kept in A21's own module and concatenated onto `SCHEMA_SQL` at the store, the
 * pattern A14/A19/A15/E00 established: a capability's DDL sits beside the code that writes it, so
 * concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * `reconciliation_match` is ONE ROW PER INCOMING CREDIT, and that is a decision rather than an
 * accident of A20 being unbuilt (spec §0 reconcile note 1). §D0 sketched the row as a link between
 * a `bank_txn` and an invoice, but `bank_txn` does not exist yet, and a queue whose rows cannot
 * exist until a later capability lands is a queue nobody can use. So the row CARRIES the credit's
 * facts (account, amount, currency, value date, reference, payer name) and `bank_txn_id` is a
 * nullable link A20 fills for imported credits when it lands. A manually recorded credit and an
 * imported one are then the same row shape with one column's difference, which is exactly what lets
 * A20 register its imports through the same engine seam instead of minting a second queue.
 *
 * THE MATCHING COLUMNS ARE THE AUDIT RECORD (§H-AUDIT, spec §6b fixed): `confidence`, `reason`,
 * `status`, `payment_id`, `decided_by`, `decided_at` say which credit settled which invoice, why,
 * and on whose decision. The money itself NEVER lives here: an applied row points at an A14
 * `payment`, and reversing that payment (an override) appends its id to `reversed_payment_ids`
 * rather than erasing anything.
 *
 * `bank_txn_id` uniqueness is scoped to the workspace and partial (NULLs exempt): re-registering a
 * txn a statement re-import already brought in must find the existing row, while manual entries,
 * which have no txn id, may accumulate freely. IBAN-style global uniqueness would leak tenant
 * existence (§H-TENANT, the A19 reasoning).
 */

export const QR_MATCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reconciliation_match (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id           TEXT,
  bank_account_id       TEXT NOT NULL REFERENCES bank_account(id),
  amount_minor          INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  value_date            TEXT NOT NULL,
  reference_kind        TEXT NOT NULL,
  reference_value       TEXT,
  payer_name            TEXT,
  invoice_id            TEXT REFERENCES document(id),
  confidence            TEXT NOT NULL,
  reason                TEXT,
  status                TEXT NOT NULL DEFAULT 'open',
  applied_mode          TEXT,
  payment_id            TEXT REFERENCES payment(id),
  reversed_payment_ids  TEXT NOT NULL DEFAULT '[]',
  decided_by            TEXT,
  decided_at            TEXT,
  created_by            TEXT,
  created_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_match_txn_per_workspace
  ON reconciliation_match (workspace_id, bank_txn_id)
  WHERE bank_txn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reconciliation_match_queue
  ON reconciliation_match (workspace_id, status, value_date);

CREATE TABLE IF NOT EXISTS qr_match_config (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  auto_apply   INTEGER NOT NULL DEFAULT 0
);
`;
