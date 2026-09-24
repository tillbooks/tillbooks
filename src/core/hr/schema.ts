/**
 * E02's four tables, in E02's own module (the A17/A14/D01 pattern: a capability's DDL sits beside
 * the code that writes it and is concatenated onto `SCHEMA_SQL` at the store, so concurrent
 * capability branches never all edit one long string).
 *
 * `employee.ahv_nr` STORES THE AHV NUMBER GATED, NOT ENCRYPTED IN THE OSS CORE. AHVG Art. 50e and
 * revDSG Art. 6 govern it; the enforceable protections the engine ships are the `hr.sensitive`
 * access gate, masking everywhere else, and never exporting it (`employees.ts`). Field-level
 * encryption with real key management is a host/cloud-tier concern (the same OSS-core-stops-here
 * posture as pain.001 transmission): the OSS core never stores it in a queryable index and never
 * returns it without `hr.sensitive`. `actor_ref` links an employee to the member id whose calls are
 * that employee's own, which is what the self-scoping read filter resolves against.
 *
 * `expense_claim.total_base_minor` is a SNAPSHOT taken at submit (the sum of line base amounts), the
 * figure the posting must equal and the payment must clear. `posted_entry_id` is set once and frozen
 * by a trigger; the claim is corrected only by a reversing entry plus a fresh claim (§H-AUDIT), never
 * by editing a posted one. `expense_line` carries the §H-FX trio (txn amount, base amount, rate) and
 * the §H-VAT-TRACE (code, base, tax) as VALUES resolved once by A05 at line time.
 */

export const HR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS employee (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  contact_id      TEXT REFERENCES contact(id),
  actor_ref       TEXT,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  ahv_nr          TEXT,
  employment_pct  INTEGER NOT NULL,
  starts_on       TEXT NOT NULL,
  ends_on         TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_by_workspace ON employee (workspace_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS employee_by_actor ON employee (workspace_id, actor_ref);
CREATE UNIQUE INDEX IF NOT EXISTS employee_idempotency
  ON employee (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS absence (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  employee_id     TEXT NOT NULL REFERENCES employee(id),
  kind            TEXT NOT NULL,
  from_date       TEXT NOT NULL,
  to_date         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'recorded',
  notes           TEXT,
  idempotency_key TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS absence_by_employee ON absence (workspace_id, employee_id, from_date);
CREATE UNIQUE INDEX IF NOT EXISTS absence_idempotency
  ON absence (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS expense_claim (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  employee_id       TEXT NOT NULL REFERENCES employee(id),
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',
  currency          TEXT NOT NULL DEFAULT 'CHF',
  total_base_minor  INTEGER,
  posted_entry_id   TEXT REFERENCES journal_entry(id),
  reversal_entry_id TEXT REFERENCES journal_entry(id),
  payment_id        TEXT REFERENCES payment(id),
  reject_reason     TEXT,
  idempotency_key   TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  submitted_at      TEXT,
  approved_at       TEXT,
  reimbursed_at     TEXT
);
CREATE INDEX IF NOT EXISTS expense_claim_by_employee ON expense_claim (workspace_id, employee_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS expense_claim_idempotency
  ON expense_claim (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS expense_line (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  claim_id            TEXT NOT NULL REFERENCES expense_claim(id),
  expense_date        TEXT NOT NULL,
  category            TEXT NOT NULL,
  description         TEXT,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'CHF',
  amount_base_minor   INTEGER NOT NULL,
  fx_rate             TEXT,
  tax_code            TEXT,
  tax_base_minor      INTEGER,
  tax_amount_minor    INTEGER,
  expense_account_id  TEXT REFERENCES account(id),
  cost_center_id      TEXT REFERENCES cost_center(id),
  receipt_document_id TEXT REFERENCES stored_file(id),
  project_id          TEXT REFERENCES project(id),
  idempotency_key     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expense_line_by_claim ON expense_line (workspace_id, claim_id);
CREATE UNIQUE INDEX IF NOT EXISTS expense_line_idempotency
  ON expense_line (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- §H-AUDIT: a claim is never deleted. A draft is cancelled (a status flip that leaves the record),
-- a posted claim is corrected by a reversing entry plus a fresh claim.
CREATE TRIGGER IF NOT EXISTS expense_claim_no_delete
BEFORE DELETE ON expense_claim
BEGIN
  SELECT RAISE(ABORT, 'expense_claim_immutable');
END;

-- The posting id is set ONCE at approve and can never move: a claim whose posted_entry_id changed
-- would point at an entry that is not the one it booked, the exact substitution the read-back guard
-- in claims.ts exists to prevent, made impossible at the storage layer too.
CREATE TRIGGER IF NOT EXISTS expense_claim_posted_entry_immutable
BEFORE UPDATE ON expense_claim
WHEN OLD.posted_entry_id IS NOT NULL
 AND IFNULL(OLD.posted_entry_id, '') <> IFNULL(NEW.posted_entry_id, '')
BEGIN
  SELECT RAISE(ABORT, 'expense_claim_posted_entry_immutable');
END;

-- A terminal state is terminal, with ONE system exception: reversing the reimbursement PAYMENT (A14
-- reverse_payment) reopens the 2260 employee-payable liability, so the claim must walk back
-- reimbursed -> approved to match it (the state the reopened liability is in: posted, not yet paid).
-- That single walk-back is permitted here; every OTHER move off a terminal state is refused, so
-- rejected and cancelled stay fully one-way and reimbursed can go nowhere but approved. The revert
-- itself is written only by hr/reimbursementReversal.ts, called inside reverse_payment's own tx.
CREATE TRIGGER IF NOT EXISTS expense_claim_terminal_is_one_way
BEFORE UPDATE OF status ON expense_claim
WHEN OLD.status IN ('reimbursed', 'rejected', 'cancelled')
 AND NEW.status <> OLD.status
 AND NOT (OLD.status = 'reimbursed' AND NEW.status = 'approved')
BEGIN
  SELECT RAISE(ABORT, 'expense_claim_terminal_is_one_way');
END;

-- A line is never deleted and never edited once its claim has left draft: the figures a submitted or
-- posted claim was built on are frozen. Draft edits go through the engine's own upsert.
CREATE TRIGGER IF NOT EXISTS expense_line_frozen_after_draft
BEFORE UPDATE ON expense_line
WHEN (SELECT status FROM expense_claim WHERE id = OLD.claim_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'expense_line_frozen');
END;

CREATE TRIGGER IF NOT EXISTS expense_line_no_delete_after_draft
BEFORE DELETE ON expense_line
WHEN (SELECT status FROM expense_claim WHERE id = OLD.claim_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'expense_line_frozen');
END;
`;
