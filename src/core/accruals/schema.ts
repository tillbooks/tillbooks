/**
 * A38's four tables, kept in A38's own module and concatenated onto `SCHEMA_SQL` at the store (the
 * A14 / G22 pattern: a capability's DDL sits beside the code that writes it).
 *
 * FOUR TABLES, ALL §H-TENANT (every row carries `workspace_id`), ALL ON THE MONEY PATH, and every
 * money column ends `_minor` (integer base-currency Rappen, Pattern P2). None of them holds a
 * posting: every financial effect lives in `journal_entry` / `journal_line` through `postEntry` and
 * `reverseEntry` (P3, the ONLY posting path), and these rows LINK to those entries so a run is fully
 * reconstructable from the ledger it points at.
 *
 *   - `accrual`: one Abgrenzung (OR 958b), drafted, then posted as a PAIR (the accrual entry and its
 *     next-period reversal, atomically), then optionally reverted as a second pair (the Storno C and
 *     its reversal D). Three idempotency keys per row: the create key (unique per workspace), the
 *     post key and the reverse key, so each act replays from the row and a second key is refused
 *     `already_posted` / `already_reversed` rather than silently double-counted.
 *   - `provision`: one Rückstellung (OR 960e), drafted, posted as ONE entry (no auto-reversal: Abs. 4,
 *     a provision is not released by the calendar), released in parts, or reversed.
 *   - `provision_release`: one partial or full Auflösung, each its own entry. A release is undone
 *     through A02 `reverse_entry` on its entry, so the open balance is DERIVED from the releases whose
 *     entry carries no reversal, never stored.
 *   - `vat_settlement` (one period's MWST-Saldierung) lives in `vatSettlementSchema.ts`, the N3 half of
 *     the spec, and concatenates right after this fragment in `store/schema.ts`.
 *
 * IMMUTABILITY (§H-AUDIT, the H04 run-header shape). Once an `accrual` / `provision`
 * row has left `draft`, its economic columns (kind or reason, period, amount, accounts) are frozen at
 * the DB layer: an UPDATE that changes any of them, or that is not a legal forward status move,
 * aborts. DELETE is refused on every table, in every status: a discarded draft is a status, not a
 * missing row. The journal's own posted-immutability triggers protect the entries these rows link to.
 *
 * NO CHECK on any enum column: the kind, reason and status enums live at their single §H-ENUM source
 * in `lines.ts`. NO CASCADE: a missing parent refuses.
 */

export const ACCRUALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accrual (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspace(id),
  -- prepaid_expense | accrued_income | accrued_expense | deferred_income (lines.ts, ACCRUAL_KINDS)
  kind                      TEXT NOT NULL,
  -- The balance-sheet date the accrual is dated (any ISO day: a month end or a year end).
  period_end                TEXT NOT NULL,
  -- The first day after period_end: the date of the automatic reversal (Rückbuchung).
  reversal_date             TEXT NOT NULL,
  amount_minor              INTEGER NOT NULL,
  -- 1300 (an active Abgrenzung) or 2300 (a passive one), resolved from the kind at create time.
  balance_account_id        TEXT NOT NULL REFERENCES account(id),
  -- The P&L account the accrual is booked against (income or expense, matched to the kind).
  contra_account_id         TEXT NOT NULL REFERENCES account(id),
  cost_center_id            TEXT REFERENCES cost_center(id),
  description               TEXT NOT NULL,
  source_ref                TEXT,
  -- draft | posted | reversed | discarded (lines.ts, ACCRUAL_STATUSES)
  status                    TEXT NOT NULL DEFAULT 'draft',
  -- The pair the post writes: A (source='accrual', dated period_end) and B = reverseEntry(A).
  entry_id                  TEXT REFERENCES journal_entry(id),
  reversal_entry_id         TEXT REFERENCES journal_entry(id),
  -- The pair the Storno writes: C (the mirror of A, dated period_end) and D = reverseEntry(C).
  storno_entry_id           TEXT REFERENCES journal_entry(id),
  storno_reversal_entry_id  TEXT REFERENCES journal_entry(id),
  idempotency_key           TEXT NOT NULL,
  post_idempotency_key      TEXT,
  reverse_idempotency_key   TEXT,
  created_by                TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  posted_at                 TEXT,
  posted_by                 TEXT,
  reversed_at               TEXT,
  reversed_by               TEXT,
  reverse_reason            TEXT,
  discarded_at              TEXT,
  discard_reason            TEXT,
  updated_at                TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS accrual_ws_period ON accrual(workspace_id, period_end);

-- A posted, reversed or discarded accrual keeps its economics: only the status may move forward and
-- only the Storno / audit columns may fill in. The entry links are frozen once set.
CREATE TRIGGER IF NOT EXISTS accrual_frozen_after_draft
BEFORE UPDATE ON accrual
WHEN OLD.status <> 'draft' AND (
     NEW.workspace_id <> OLD.workspace_id
  OR NEW.kind <> OLD.kind
  OR NEW.period_end <> OLD.period_end
  OR NEW.reversal_date <> OLD.reversal_date
  OR NEW.amount_minor <> OLD.amount_minor
  OR NEW.balance_account_id <> OLD.balance_account_id
  OR NEW.contra_account_id <> OLD.contra_account_id
  OR NEW.cost_center_id IS NOT OLD.cost_center_id
  OR NEW.description <> OLD.description
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.entry_id IS NOT OLD.entry_id
  OR NEW.reversal_entry_id IS NOT OLD.reversal_entry_id
  OR (OLD.storno_entry_id IS NOT NULL AND NEW.storno_entry_id IS NOT OLD.storno_entry_id)
  OR (OLD.storno_reversal_entry_id IS NOT NULL AND NEW.storno_reversal_entry_id IS NOT OLD.storno_reversal_entry_id)
  OR (OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'reversed'))
  OR (OLD.status = 'reversed' AND NEW.status <> 'reversed')
  OR (OLD.status = 'discarded' AND NEW.status <> 'discarded')
)
BEGIN
  SELECT RAISE(ABORT, 'accrual_immutable');
END;

CREATE TRIGGER IF NOT EXISTS accrual_no_delete
BEFORE DELETE ON accrual
BEGIN
  SELECT RAISE(ABORT, 'accrual_append_only');
END;

CREATE TABLE IF NOT EXISTS provision (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspace(id),
  -- garantie | ferien_ueberzeit | prozess | grossreparatur | sanierung | restrukturierung | steuern | sonstige
  reason                    TEXT NOT NULL,
  period_end                TEXT NOT NULL,
  amount_minor              INTEGER NOT NULL,
  -- 2330, 2600, or a liability account the workspace numbers 23xx / 26xx.
  provision_account_id      TEXT NOT NULL REFERENCES account(id),
  -- The P&L account the formation is charged to (income or expense).
  expense_account_id        TEXT NOT NULL REFERENCES account(id),
  description               TEXT NOT NULL,
  -- draft | posted | released | reversed | discarded (lines.ts, PROVISION_STATUSES). The engine no
  -- longer WRITES 'released': it is derived on read from the live releases (provision.ts statusOf),
  -- so a full release undone through reverse_entry reads 'posted' again. The trigger still admits a
  -- stored 'released' (files written before 2026-09-09 carry it) on its way to 'reversed'.
  status                    TEXT NOT NULL DEFAULT 'draft',
  entry_id                  TEXT REFERENCES journal_entry(id),
  reversal_entry_id         TEXT REFERENCES journal_entry(id),
  idempotency_key           TEXT NOT NULL,
  post_idempotency_key      TEXT,
  reverse_idempotency_key   TEXT,
  created_by                TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  posted_at                 TEXT,
  posted_by                 TEXT,
  reversed_at               TEXT,
  reversed_by               TEXT,
  reverse_reason            TEXT,
  discarded_at              TEXT,
  discard_reason            TEXT,
  updated_at                TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS provision_ws_period ON provision(workspace_id, period_end);

CREATE TRIGGER IF NOT EXISTS provision_frozen_after_draft
BEFORE UPDATE ON provision
WHEN OLD.status <> 'draft' AND (
     NEW.workspace_id <> OLD.workspace_id
  OR NEW.reason <> OLD.reason
  OR NEW.period_end <> OLD.period_end
  OR NEW.amount_minor <> OLD.amount_minor
  OR NEW.provision_account_id <> OLD.provision_account_id
  OR NEW.expense_account_id <> OLD.expense_account_id
  OR NEW.description <> OLD.description
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.entry_id IS NOT OLD.entry_id
  OR (OLD.reversal_entry_id IS NOT NULL AND NEW.reversal_entry_id IS NOT OLD.reversal_entry_id)
  OR (OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'released', 'reversed'))
  OR (OLD.status = 'released' AND NEW.status NOT IN ('released', 'reversed'))
  OR (OLD.status = 'reversed' AND NEW.status <> 'reversed')
  OR (OLD.status = 'discarded' AND NEW.status <> 'discarded')
)
BEGIN
  SELECT RAISE(ABORT, 'provision_immutable');
END;

CREATE TRIGGER IF NOT EXISTS provision_no_delete
BEFORE DELETE ON provision
BEGIN
  SELECT RAISE(ABORT, 'provision_append_only');
END;

CREATE TABLE IF NOT EXISTS provision_release (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  provision_id       TEXT NOT NULL REFERENCES provision(id),
  release_date       TEXT NOT NULL,
  amount_minor       INTEGER NOT NULL,
  -- The P&L account the release is credited to (the original expense account, or an income one).
  target_account_id  TEXT NOT NULL REFERENCES account(id),
  entry_id           TEXT NOT NULL REFERENCES journal_entry(id),
  idempotency_key    TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS provision_release_provision ON provision_release(provision_id);

-- A release is a posted fact: never edited, never deleted. Undoing one is a reversal of its entry.
CREATE TRIGGER IF NOT EXISTS provision_release_no_update
BEFORE UPDATE ON provision_release
BEGIN
  SELECT RAISE(ABORT, 'provision_release_immutable');
END;

CREATE TRIGGER IF NOT EXISTS provision_release_no_delete
BEFORE DELETE ON provision_release
BEGIN
  SELECT RAISE(ABORT, 'provision_release_append_only');
END;
`;
