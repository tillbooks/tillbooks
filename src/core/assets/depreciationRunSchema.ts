/**
 * H04, the Depreciation RUN tables: the controlled, auditable period-end process that turns H03's pure
 * calculated amounts into real GL entries and keeps the asset sub-ledger reconciled to the GL control
 * accounts (OP11). Two tables:
 *
 *  - `asset_depreciation_run`   the run HEADER: one row per (workspace, period, selection) run, carrying
 *                               its status (draft | posted | reversed), the posting granularity, the
 *                               deterministic selection hash, the totals, and the GL journal links.
 *  - `asset_depreciation_line`  one row per asset the run touched: the calculated amount and the
 *                               accumulated-before / accumulated-after / nbv-after / is_final figures,
 *                               so the run is the verifiable chain OR 957a requires (run -> line ->
 *                               asset, and run -> journal_entry).
 *
 * THE MONEY PATH IS UNFORGIVING, so the append-only discipline is enforced at the DB layer:
 *
 *  - A `line` is written ONCE at draft-create with every figure it will ever carry (amount and the
 *    before/after balances). Post never rewrites a line; it re-validates the asset still matches the
 *    line (else `stale_draft`) and then posts. So the line table is fully append-only: two BEFORE
 *    triggers abort every UPDATE and every DELETE, exactly as `asset_transaction` and `journal_line`
 *    do. A recorded line is the sub-ledger audit fact and can never be silently re-figured.
 *  - The `run` HEADER's amounts (period, granularity, selection_hash, total, asset_count, the lines
 *    it computed) are immutable; only its STATUS advances (draft -> posted -> reversed) and its
 *    journal links fill in on post / reverse. A single BEFORE UPDATE trigger enforces exactly that: an
 *    UPDATE that touches any amount column, or that is not a legal status transition, aborts. A BEFORE
 *    DELETE trigger aborts every delete. So history is never rewritten (§H-AUDIT); a reversal is a NEW
 *    reversing journal plus compensating asset movements, never a mutation of the original run.
 *
 * The real GL immutability lives where it always did: the posted `journal_entry` (A02's triggers) and
 * the `asset_transaction` depreciation rows this run writes (their own triggers, `transactionSchema.ts`).
 * These two run tables are the sub-ledger bookkeeping that names them.
 *
 * Its own module so a concurrent asset-cluster branch never edits H00/H01/H02's schema string. Columns
 * are snake_case; the engine and MCP/REST interfaces are camelCase and map at the `depreciationRun.ts`
 * boundary only. Money is stored as INTEGER Rappen, never a float (P2). Every row carries `workspace_id`
 * (§H-TENANT) and references its `asset` / `journal_entry`, so a row can never name one that does not
 * exist.
 */

export const DEPRECIATION_RUN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_depreciation_run (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspace(id),
  -- The period this run depreciates, 'YYYY-MM'. Lexical order equals chronological order.
  period                      TEXT NOT NULL,
  -- draft | posted | reversed (§H-ENUM, enforced in the verb AND by the status-transition trigger).
  status                      TEXT NOT NULL DEFAULT 'draft',
  -- detailed (one expense + one accum line per asset) | summarised (grouped by account + cost centre).
  posting_granularity         TEXT NOT NULL DEFAULT 'detailed',
  -- A deterministic hash of the selection filters + the eligible asset set, so two runs over the same
  -- (period, selection) are recognised as the same run (the concurrency guard, §4).
  selection_hash              TEXT NOT NULL,
  total_amount_rappen         INTEGER NOT NULL DEFAULT 0,
  asset_count                 INTEGER NOT NULL DEFAULT 0,
  -- The balanced GL journal (A02) this run posted, and the reversing journal if it was reversed. NULL
  -- while draft; NEVER null once posted (a posted run with no journal would break OP11 by construction).
  journal_entry_id            TEXT REFERENCES journal_entry(id),
  reversing_journal_entry_id  TEXT REFERENCES journal_entry(id),
  calculated_at               TEXT NOT NULL,
  posted_at                   TEXT,
  reversed_at                 TEXT,
  created_by                  TEXT,
  idempotency_key             TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

-- §H-TENANT + the list surface's two commonest filters (period, status).
CREATE INDEX IF NOT EXISTS asset_depreciation_run_workspace_period
ON asset_depreciation_run (workspace_id, period);
CREATE INDEX IF NOT EXISTS asset_depreciation_run_workspace_status
ON asset_depreciation_run (workspace_id, status);

-- At most ONE non-reversed run per (workspace, period, selection) (§4 concurrency). The engine checks
-- it first for a friendly run_already_exists / run_already_posted; this partial unique index is the
-- race guard underneath, so two concurrent creators cannot both seat a live run for the same selection.
CREATE UNIQUE INDEX IF NOT EXISTS asset_depreciation_run_one_live
ON asset_depreciation_run (workspace_id, period, selection_hash)
WHERE status != 'reversed';

CREATE TABLE IF NOT EXISTS asset_depreciation_line (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspace(id),
  run_id                      TEXT NOT NULL REFERENCES asset_depreciation_run(id),
  asset_id                    TEXT NOT NULL REFERENCES asset(id),
  amount_rappen               INTEGER NOT NULL,
  accumulated_before_rappen   INTEGER NOT NULL,
  accumulated_after_rappen    INTEGER NOT NULL,
  nbv_after_rappen            INTEGER NOT NULL,
  is_final                    INTEGER NOT NULL DEFAULT 0,
  -- The production figure this line's amount was computed from (units_of_production only, NULL for
  -- every other method). TILL has no production-data capture capability, so the figure arrives on the
  -- run itself and would otherwise leave no trace: recording it is what makes a units charge auditable
  -- (OR 957a verifiability), because the amount alone cannot be re-derived without it.
  units_produced              INTEGER,
  -- The GL accounts this line will post against, snapshotted from the asset at draft time so post books
  -- exactly what the review table showed (the asset baseline is frozen once active anyway, H01).
  gl_depr_expense_account_id  TEXT NOT NULL REFERENCES account(id),
  gl_accum_depr_account_id    TEXT NOT NULL REFERENCES account(id),
  cost_center_id              TEXT,
  -- The asset's last_depreciation_period AT DRAFT TIME, snapshotted so a reversal can roll the asset's
  -- last period back to exactly what it was before this run (NULL when the asset had never depreciated).
  last_period_before          TEXT,
  created_at                  TEXT NOT NULL
);

-- §H-TENANT + the per-run line fetch the detail surface and OP11 reconciliation both read.
CREATE INDEX IF NOT EXISTS asset_depreciation_line_run
ON asset_depreciation_line (workspace_id, run_id);
CREATE INDEX IF NOT EXISTS asset_depreciation_line_asset
ON asset_depreciation_line (workspace_id, asset_id);

-- §H-AUDIT: a run line is append-only. It is written once at draft-create with every figure it carries
-- and is never re-figured; correction is a reversal (a new run + compensating movements), never an edit.
CREATE TRIGGER IF NOT EXISTS asset_depreciation_line_no_update
BEFORE UPDATE ON asset_depreciation_line
BEGIN
  SELECT RAISE(ABORT, 'asset_depreciation_line_immutable');
END;

CREATE TRIGGER IF NOT EXISTS asset_depreciation_line_no_delete
BEFORE DELETE ON asset_depreciation_line
BEGIN
  SELECT RAISE(ABORT, 'asset_depreciation_line_immutable');
END;

-- §H-AUDIT: the run HEADER's amounts are immutable; only its status advances and its journal links fill
-- in. An UPDATE that changes any amount / selection column, or that is not a legal forward status
-- transition (draft -> posted, draft -> reversed, posted -> reversed), aborts. A run is never deleted.
CREATE TRIGGER IF NOT EXISTS asset_depreciation_run_status_only
BEFORE UPDATE ON asset_depreciation_run
WHEN
  NEW.workspace_id != OLD.workspace_id
  OR NEW.period != OLD.period
  OR NEW.posting_granularity != OLD.posting_granularity
  OR NEW.selection_hash != OLD.selection_hash
  OR NEW.total_amount_rappen != OLD.total_amount_rappen
  OR NEW.asset_count != OLD.asset_count
  OR NEW.calculated_at != OLD.calculated_at
  OR NOT (
    (OLD.status = 'draft'  AND NEW.status IN ('draft', 'posted', 'reversed'))
    OR (OLD.status = 'posted' AND NEW.status IN ('posted', 'reversed'))
    OR (OLD.status = 'reversed' AND NEW.status = 'reversed')
  )
BEGIN
  SELECT RAISE(ABORT, 'asset_depreciation_run_immutable');
END;

CREATE TRIGGER IF NOT EXISTS asset_depreciation_run_no_delete
BEFORE DELETE ON asset_depreciation_run
BEGIN
  SELECT RAISE(ABORT, 'asset_depreciation_run_immutable');
END;
`;
