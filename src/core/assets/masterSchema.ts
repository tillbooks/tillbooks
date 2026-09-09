/**
 * H01, the fixed-asset MASTER table: one row per capitalised asset, the single source of truth the
 * register, the depreciation base (H03/H04) and the OP11 sub-ledger reconciliation all read from.
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts`
 * (the H00 `ASSETS_SCHEMA_SQL` module-owned pattern), so a concurrent capability branch never edits
 * one shared 300-line string. Columns are snake_case; the engine and MCP/REST interfaces are
 * camelCase and map at the `master.ts` boundary only. Money is stored as INTEGER Rappen, never a
 * float (P2). Every row carries `workspace_id` (§H-TENANT).
 *
 * The category and the three GL accounts are REFERENCES into H00 / A01, so an asset can never name a
 * category or account that does not exist. `number` is CASE-INSENSITIVELY unique per workspace,
 * enforced at the DB layer by a UNIQUE index over `(workspace_id, lower(number))` so even a
 * cross-process race cannot seat two `FA-0001`/`fa-0001` rows; the engine additionally checks it
 * first for a friendly `duplicate_number` (the H00 `duplicate_code` shape).
 *
 * THE FINANCIAL BASELINE IS APPEND-ONLY IN SPIRIT. `acquisition_date`, `acquisition_cost_rappen`,
 * `residual_value_rappen`, `useful_life_months`, `depreciation_method` and the three GL accounts are
 * set at creation and become immutable through `asset_update` the moment a financial event exists
 * (status leaves `draft`, which is exactly what a posted acquisition does): a change then is a
 * correction flow (H02/H05/H06), never a destructive edit (THE money path is unforgiving). The
 * enforcement lives in `master.ts`; this table records the state the enforcement reads.
 *
 * `accumulated_depr_rappen` / `net_book_value_rappen` / `last_depreciation_period` /
 * `disposed_at` / `disposal_proceeds_rappen` are CONVENIENCE columns maintained by later specs
 * (H04/H06); they are never the source of truth for posting. At creation accumulated is 0 and NBV is
 * the cost.
 */

export const ASSET_MASTER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspace(id),
  number                     TEXT NOT NULL,
  name                       TEXT NOT NULL,
  description                TEXT,
  category_id                TEXT NOT NULL REFERENCES asset_category(id),
  -- draft | active | fully_depreciated | disposed | archived (§H-ENUM, enforced in the verb). A
  -- financial event (a posted acquisition, H02) is what moves an asset out of draft, and leaving
  -- draft is what locks the financial baseline below.
  status                     TEXT NOT NULL DEFAULT 'draft',

  -- Financial baseline: set at creation, immutable once status leaves draft.
  acquisition_date           TEXT NOT NULL,
  acquisition_cost_rappen    INTEGER NOT NULL,
  -- The RESOLVED absolute residual in Rappen (a category's pct is resolved against cost at creation).
  residual_value_rappen      INTEGER NOT NULL DEFAULT 0,
  -- NULL only when the method is 'none' (a non-depreciating asset carries no useful life).
  useful_life_months         INTEGER,
  depreciation_method        TEXT NOT NULL,
  -- The two method-specific depreciation parameters H03 needs and H04 posts from. Basis points p.a.
  -- for declining_balance (2000 = 20%); estimated total lifetime units for units_of_production. NULL
  -- for straight_line / none, which need neither. Set at creation from an explicit input (the category
  -- carries no default for them yet); part of the financial baseline, so frozen once the asset leaves
  -- draft, exactly like the depreciation method itself. Declared here for a FRESH database and repeated
  -- in ADDITIVE_COLUMNS so a pre-H04 asset file widens on open (both resolve to NULL, which the H03
  -- engine reads as "no rate / no units", the honest degrade it already handled through the override).
  declining_rate_bp          INTEGER,
  total_estimated_units      INTEGER,
  gl_asset_account_id        TEXT NOT NULL REFERENCES account(id),
  gl_accum_depr_account_id   TEXT NOT NULL REFERENCES account(id),
  gl_depr_expense_account_id TEXT NOT NULL REFERENCES account(id),

  -- Tracking (all descriptive, always editable while non-terminal). location_id / responsible_user_id
  -- are soft references (no location/user master exists yet), so no FK is declared on them.
  location_id                TEXT,
  responsible_user_id        TEXT,
  serial_number              TEXT,
  barcode                    TEXT,
  manufacturer               TEXT,
  model                      TEXT,
  warranty_until             TEXT,
  notes                      TEXT,

  -- Maintained by later specs (H04/H06); default 0 / NULL at creation.
  accumulated_depr_rappen    INTEGER NOT NULL DEFAULT 0,
  net_book_value_rappen      INTEGER NOT NULL,
  last_depreciation_period   TEXT,
  disposed_at                TEXT,
  disposal_proceeds_rappen   INTEGER,

  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  created_by                 TEXT
);

-- CASE-INSENSITIVE number uniqueness per workspace (§4). The engine checks it first for a friendly
-- duplicate_number; this is the race guard underneath, so two concurrent writers cannot both seat an
-- asset with the same number in different letter case.
CREATE UNIQUE INDEX IF NOT EXISTS asset_number_unique_per_workspace
ON asset (workspace_id, lower(number));

-- §H-TENANT + the register's two commonest filters (status, category).
CREATE INDEX IF NOT EXISTS asset_workspace_status ON asset (workspace_id, status);
CREATE INDEX IF NOT EXISTS asset_workspace_category ON asset (workspace_id, category_id);
`;
