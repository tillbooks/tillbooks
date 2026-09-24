/**
 * A38 (D129 leg 2), the MWST-Saldierung table: one row per POSTED settlement of a filed MWST period.
 *
 * A settlement is the transfer of a filed period's 2200 / 1170 / 1171 balances to 2201, dated the
 * period end, so that the three tax accounts read zero at year end and 2201 carries exactly what the
 * ESTV is owed (research §8 step 11, the Nomadik year-end fact). The journal entry is the money; this
 * row is the RECORD that a period was settled, which figures were moved, and how to undo it
 * (`reversal_entry_id`). It carries no figure the ledger does not, so it is reconstructable from the
 * entry it links to.
 *
 * WHY ITS OWN FILE and not `schema.ts` beside the accrual and provision tables: the two halves of
 * A38 were built by two agents on one file-ownership split (the leg 2 build graph), and one schema
 * file with two authors is a union-merge hazard on every landing. `SCHEMA_SQL` concatenates this
 * fragment immediately after `ACCRUALS_SCHEMA_SQL` and before `CHECKLISTS_SCHEMA_SQL`.
 *
 * §H-IDEMPOTENT: the partial unique index on `(workspace_id, period_start) WHERE status = 'posted'`
 * is the single source of "a period is settled at most once": a second post under the SAME key
 * replays, under a DIFFERENT key answers `already_posted`, and after a reversal a fresh post creates a
 * NEW row (the reversed row keeps its history). §H-AUDIT: a row admits UPDATE of the status and the
 * reversal columns only (the H04 run-immutability shape) and DELETE never.
 */

export const VAT_SETTLEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vat_settlement (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  period_label       TEXT NOT NULL,
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  method             TEXT NOT NULL,
  output_minor       INTEGER NOT NULL,
  input_minor        INTEGER NOT NULL,
  net_minor          INTEGER NOT NULL,
  entry_id           TEXT NOT NULL REFERENCES journal_entry(id),
  reversal_entry_id  TEXT REFERENCES journal_entry(id),
  status             TEXT NOT NULL CHECK (status IN ('posted', 'reversed')),
  idempotency_key    TEXT NOT NULL,
  posted_by          TEXT,
  posted_at          TEXT NOT NULL,
  reversed_at        TEXT,
  reversed_by        TEXT,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS vat_settlement_one_posted_per_period
ON vat_settlement (workspace_id, period_start)
WHERE status = 'posted';

CREATE INDEX IF NOT EXISTS vat_settlement_by_workspace_period
ON vat_settlement (workspace_id, period_start);

-- §H-AUDIT: a posted settlement is corrected by a reversing entry, never by an edit. The only UPDATE
-- admitted is the reversal itself (status posted -> reversed with its reversal columns); every other
-- column is frozen at insert, and DELETE is refused outright (\`accrual_append_only\`, spec §4.3).
CREATE TRIGGER IF NOT EXISTS vat_settlement_append_only_update
BEFORE UPDATE ON vat_settlement
WHEN NEW.id <> OLD.id
  OR NEW.workspace_id <> OLD.workspace_id
  OR NEW.period_label <> OLD.period_label
  OR NEW.period_start <> OLD.period_start
  OR NEW.period_end <> OLD.period_end
  OR NEW.method <> OLD.method
  OR NEW.output_minor <> OLD.output_minor
  OR NEW.input_minor <> OLD.input_minor
  OR NEW.net_minor <> OLD.net_minor
  OR NEW.entry_id <> OLD.entry_id
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.posted_at <> OLD.posted_at
  OR NOT (
    (OLD.status = 'posted' AND NEW.status IN ('posted', 'reversed'))
    OR (OLD.status = 'reversed' AND NEW.status = 'reversed')
  )
BEGIN
  SELECT RAISE(ABORT, 'accrual_append_only');
END;

CREATE TRIGGER IF NOT EXISTS vat_settlement_append_only_delete
BEFORE DELETE ON vat_settlement
BEGIN
  SELECT RAISE(ABORT, 'accrual_append_only');
END;
`;
