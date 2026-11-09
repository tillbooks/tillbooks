/**
 * J00, warehouses & locations: the Wave-13 inventory ROOT. The one table J00 owns is `warehouse`; the
 * location HIERARCHY is added to D01's existing `stock_location` table through `ADDITIVE_COLUMNS`
 * (`src/core/store/schema.ts`), NOT a second `location` table, so the `stock_movement.location_id ->
 * stock_location(id)` foreign key stays intact and every D01 movement / on-hand / valuation /
 * stocktake verb keeps working unchanged (spec §4 Reconciliation).
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts`
 * (the A14/A19/B00/H00 module-owned pattern), which keeps concurrent capability branches from all
 * editing one long string. Columns are snake_case; the engine and MCP/REST interfaces are camelCase
 * and map at the `warehouse.ts` / `location.ts` boundary only. Every row carries `workspace_id`
 * (§H-TENANT).
 *
 * `is_default` is the workspace default warehouse: EXACTLY ONE per workspace, enforced by a partial
 * UNIQUE index over `(workspace_id) WHERE is_default = 1`, so even a cross-process race cannot seat
 * two defaults. `active` is the soft-archive flag; a warehouse is never deleted (spec §6: deletion is
 * never offered), because a movement written against a location under it must stay resolvable.
 *
 * Code uniqueness is CASE-INSENSITIVE per workspace, enforced at the DB layer by a UNIQUE index over
 * `(workspace_id, lower(code))`; the engine additionally checks it first for a friendly
 * `duplicate_code` (the `create_account` / `asset_category` shape).
 */

export const INVENTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS warehouse (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code   TEXT,
  city          TEXT,
  -- ISO 3166-1 alpha-2, defaulted 'CH': a Swiss warehouse is the overwhelming default and there is no
  -- wrong answer hidden behind it (the workspace.base_currency reasoning).
  country_code  TEXT NOT NULL DEFAULT 'CH',
  -- Exactly one true per workspace, enforced by the partial UNIQUE index below.
  is_default    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT
);

-- CASE-INSENSITIVE code uniqueness per workspace (spec §4). The engine checks it first for a friendly
-- duplicate_code; this is the race guard underneath.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_code_unique_per_workspace
ON warehouse (workspace_id, lower(code));

-- EXACTLY ONE default warehouse per workspace. Partial so only the default row participates: setting a
-- new default clears the previous in the same transaction, and the index makes two defaults impossible
-- to seat even under a race.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_one_default_per_workspace
ON warehouse (workspace_id) WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS warehouse_by_workspace
ON warehouse (workspace_id, active, code);
`;
