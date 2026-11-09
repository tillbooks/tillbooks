/**
 * H05, the fixed-asset LOCATION master and the append-only TRANSFER history.
 *
 * A transfer moves an asset between physical locations, custodians (responsible users) or both. It is
 * NON-POSTING by design (spec §1/§4): it changes no financial field and creates no General-Ledger
 * journal entry. That is why H05 does NOT ride H02's `asset_transaction` table, whose whole contract is
 * that every row names a balanced GL entry (`journal_entry_id TEXT NOT NULL`, transactionSchema.ts):
 *
 *  - a transfer moves zero Rappen, so it has no journal to name, and forcing it onto a table whose
 *    invariant is "one row, one balanced journal" would break that table's meaning;
 *  - H01's `financialEventsExist` (master.ts) treats ANY `asset_transaction` row as a posted financial
 *    event that locks the asset's baseline, so a transfer written there would silently freeze a draft
 *    asset's editable financials, which §4 forbids;
 *  - the DoD tripwire "no `journal_entry_id` is ever written for a transfer" is satisfied here
 *    STRUCTURALLY: the `asset_transfer` table has no such column at all, so no call path can write one.
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts` (the
 * H00/H01/H02 module-owned pattern), so a concurrent asset-cluster branch never edits one shared
 * string. Columns are snake_case; the engine and MCP/REST interfaces are camelCase and map at the
 * `transfer.ts` boundary only. Every row carries `workspace_id` (§H-TENANT).
 *
 * THE TRANSFER ROW IS APPEND-ONLY AT THE DB LAYER (§H-AUDIT). Two BEFORE triggers abort every UPDATE
 * and every DELETE: the location/responsible history is the practical evidence of control OR 957a asks
 * for, so a recorded move is never mutated, exactly as a posted journal entry is corrected by a
 * reversing entry rather than an edit. The enforcement is the trigger, not a TypeScript check.
 *
 * The `asset_location` master is ordinary soft-archived master data (`active = 0` archives it, it is
 * never deleted, so an asset's history stays resolvable). `parent_id` is an optional self-reference for
 * a light hierarchy; a cycle is forbidden in the verb. Location code is CASE-INSENSITIVELY unique per
 * workspace, enforced at the DB layer by a UNIQUE index so even a cross-process race cannot seat two
 * `ZH-HQ`/`zh-hq` rows; the engine additionally checks it first for a friendly `duplicate_code`.
 */

export const ASSET_TRANSFER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_location (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  -- Optional light hierarchy. Self-referential; a cycle is forbidden in the verb (location_cycle).
  parent_id     TEXT REFERENCES asset_location(id),
  -- Soft-archive flag: 0 = archived. A location is never deleted (an asset's history must stay
  -- resolvable), and it cannot be archived while a non-disposed asset still references it.
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT
);

-- CASE-INSENSITIVE code uniqueness per workspace (§4). The engine checks it first for a friendly
-- duplicate_code; this is the race guard underneath, so two concurrent writers cannot both seat a
-- location with the same code in different letter case.
CREATE UNIQUE INDEX IF NOT EXISTS asset_location_code_unique_per_workspace
ON asset_location (workspace_id, lower(code));

-- §H-TENANT + the two commonest reads: the active filter and the parent grouping.
CREATE INDEX IF NOT EXISTS asset_location_workspace_active
ON asset_location (workspace_id, active);
CREATE INDEX IF NOT EXISTS asset_location_workspace_parent
ON asset_location (workspace_id, parent_id);

CREATE TABLE IF NOT EXISTS asset_transfer (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspace(id),
  asset_id                  TEXT NOT NULL REFERENCES asset(id),
  -- The effective date of the physical move (ISO YYYY-MM-DD), which may differ from created_at.
  date                      TEXT NOT NULL,
  -- The values BEFORE the move, captured on the row so history reads need no join to a prior row.
  from_location_id          TEXT,
  to_location_id            TEXT,
  from_responsible_user_id  TEXT,
  to_responsible_user_id    TEXT,
  -- Free-text reason (spec: reason / description).
  description               TEXT,
  -- Groups the rows of one bulk transfer for the UI; NULL for a single transfer. Not a foreign key,
  -- it is a correlation id minted per bulk request.
  bulk_id                   TEXT,
  created_at                TEXT NOT NULL,
  created_by                TEXT,
  idempotency_key           TEXT
);

-- §H-TENANT + the per-asset history read, the one query the timeline runs.
CREATE INDEX IF NOT EXISTS asset_transfer_workspace_asset
ON asset_transfer (workspace_id, asset_id);

-- §H-AUDIT: the transfer history is append-only. A recorded move can be neither updated nor deleted;
-- the database refuses before any verb gets a say, exactly as asset_transaction / journal_entry do.
CREATE TRIGGER IF NOT EXISTS asset_transfer_no_update
BEFORE UPDATE ON asset_transfer
BEGIN
  SELECT RAISE(ABORT, 'asset_transfer_immutable');
END;

CREATE TRIGGER IF NOT EXISTS asset_transfer_no_delete
BEFORE DELETE ON asset_transfer
BEGIN
  SELECT RAISE(ABORT, 'asset_transfer_immutable');
END;
`;
