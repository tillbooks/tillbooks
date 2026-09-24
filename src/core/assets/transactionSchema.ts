/**
 * H02, the fixed-asset SUB-LEDGER transaction table: one append-only row per financial event on an
 * asset (an `acquisition`, an `additional_capitalisation`, and later H04/H06's depreciation and
 * disposal rows). It is the sub-ledger side of the OP11 reconciliation (§H-ASSET): every Rappen that
 * moves the asset's cost or accumulated depreciation is a row here AND a line in the balanced GL
 * journal it names through `journal_entry_id`, so the register can always be reconciled to the GL.
 *
 * The canonical shape and its identity invariants are OWNED BY H07; H02 lands the table because it is
 * the first writer, and populates only the acquisition subset (`type`, `date`, `delta_cost_rappen`,
 * `journal_entry_id`, the source-document link, and the idempotency key). The columns H04/H06 fill
 * (`delta_accum_depr_rappen`, `proceeds_rappen`, `gain_loss_rappen`) exist now with harmless defaults
 * so those specs extend the writer, not the DDL. The DDL sits in its own module and is joined into the
 * applied schema by `core/store/schema.ts` (the H00 / H01 module-owned pattern), so a concurrent
 * asset-cluster branch never edits one shared string.
 *
 * Columns are snake_case; the engine and MCP/REST interfaces are camelCase and map at the
 * `acquisition.ts` boundary only. Money is stored as INTEGER Rappen, never a float (P2). Every row
 * carries `workspace_id` (§H-TENANT), references its `asset` and its `journal_entry`, so a row can
 * never name an asset or an entry that does not exist.
 *
 * THE ROW IS APPEND-ONLY AT THE DB LAYER (§H-AUDIT). Two BEFORE triggers abort every UPDATE and every
 * DELETE: a posted financial event is corrected by a REVERSING entry plus a compensating transaction,
 * never a destructive edit, exactly as a posted journal entry is (THE money path is unforgiving). The
 * enforcement is the trigger, not a TypeScript check, so nothing that reaches the table, now or later,
 * can mutate a recorded event.
 */

export const ASSET_TRANSACTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_transaction (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspace(id),
  asset_id                 TEXT NOT NULL REFERENCES asset(id),
  -- acquisition | additional_capitalisation (H02 writes only these two); H07 registers the rest.
  type                     TEXT NOT NULL,
  date                     TEXT NOT NULL,
  -- The capitalised amount in Rappen (> 0 for the two H02 types). The asset's acquisition_cost_rappen
  -- is the SUM of delta_cost_rappen over acquisition-type rows (OP11 / §H-ASSET), the convenience
  -- column on the asset master is maintained in step.
  delta_cost_rappen        INTEGER NOT NULL,
  -- Always 0 for a pure acquisition; H04's depreciation rows move it.
  delta_accum_depr_rappen  INTEGER NOT NULL DEFAULT 0,
  -- H06 disposal fields; never set by H02.
  proceeds_rappen          INTEGER,
  gain_loss_rappen         INTEGER,
  -- The balanced GL journal entry (A02) this event posted. NEVER null after a successful write: a
  -- cost change with no journal_entry_id would break OP11 by construction.
  journal_entry_id         TEXT NOT NULL REFERENCES journal_entry(id),
  -- The optional link to what triggered the event: 'vendor_bill' | 'project' | 'opening' | 'manual'.
  source_document_type     TEXT,
  source_document_id       TEXT,
  description              TEXT,
  created_at               TEXT NOT NULL,
  created_by               TEXT,
  idempotency_key          TEXT
);

-- §H-TENANT + the two commonest reads: the per-asset transaction history and the type filter.
CREATE INDEX IF NOT EXISTS asset_transaction_workspace_asset
ON asset_transaction (workspace_id, asset_id);
CREATE INDEX IF NOT EXISTS asset_transaction_workspace_type
ON asset_transaction (workspace_id, type);

-- EXACTLY ONE primary acquisition per asset (§4). The engine checks it first for a friendly
-- already_acquired; this partial unique index is the race guard underneath, so two concurrent writers
-- cannot both seat a primary acquisition on the same asset.
CREATE UNIQUE INDEX IF NOT EXISTS asset_transaction_one_acquisition
ON asset_transaction (workspace_id, asset_id)
WHERE type = 'acquisition';

-- EXACTLY ONE disposal per asset (spec 119, US-H06.7: first wins, the second gets
-- asset_already_disposed). H06's engine checks status first for the friendly path AND re-checks it
-- inside the write transaction with a guarded terminal UPDATE (that aborts the second concurrent writer
-- before this index would fire); this partial unique index is the DB-enforced race guard underneath,
-- the acquisition precedent above. Under D12's supported concurrent-writer topology (Studio plus a
-- till-mcp subprocess on one SQLite file) two writers can both read the active status before either
-- commits, so the structural guarantee, not an out-of-tx read, is what makes exactly-one-disposal hold.
CREATE UNIQUE INDEX IF NOT EXISTS asset_transaction_one_disposal
ON asset_transaction (workspace_id, asset_id)
WHERE type = 'disposal';

-- EXACTLY ONE opening baseline per asset (H07). An opening balance seats the migrated carrying cost of
-- an asset that predates the ledger; seeding it twice double-capitalises silently, because OP11
-- reconciliation still reports balanced when both the sub-ledger and the GL move together. H07's engine
-- checks first for the friendly already_baselined path AND re-checks the draft status inside the write
-- transaction with a guarded terminal UPDATE (that aborts the second concurrent writer before this index
-- would fire); this partial unique index is the DB-enforced race guard underneath, the acquisition and
-- disposal precedents above. Under D12's supported concurrent-writer topology (Studio plus a till-mcp
-- subprocess on one SQLite file) two writers can both read the null baseline before either commits, so
-- the structural guarantee, not an out-of-tx read, is what makes exactly-one-opening hold.
CREATE UNIQUE INDEX IF NOT EXISTS asset_transaction_one_opening
ON asset_transaction (workspace_id, asset_id)
WHERE type = 'opening';

-- §H-AUDIT: the sub-ledger event is append-only. A recorded transaction can be neither updated nor
-- deleted; correction is a reversing entry plus a compensating transaction, never a destructive edit.
-- The database refuses before any verb gets a say, exactly as journal_entry / journal_line do.
CREATE TRIGGER IF NOT EXISTS asset_transaction_no_update
BEFORE UPDATE ON asset_transaction
BEGIN
  SELECT RAISE(ABORT, 'asset_transaction_immutable');
END;

CREATE TRIGGER IF NOT EXISTS asset_transaction_no_delete
BEFORE DELETE ON asset_transaction
BEGIN
  SELECT RAISE(ABORT, 'asset_transaction_immutable');
END;
`;
