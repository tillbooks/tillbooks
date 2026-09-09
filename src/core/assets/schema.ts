/**
 * H00, the fixed-asset CATEGORY table: the single place a workspace's depreciation and GL-account
 * defaults live, so creating an asset (H01) becomes "pick category, enter name, date and cost".
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts`
 * (the A14/A19/B00 module-owned pattern), which keeps concurrent capability branches from all
 * editing one 300-line string. Columns are snake_case; the engine and MCP/REST interfaces are
 * camelCase and map at the `category.ts` boundary only. Money is stored as INTEGER Rappen and basis
 * points, never a float (P2). Every row carries `workspace_id` (§H-TENANT).
 *
 * The three GL accounts and the optional cost centre are REFERENCES into A01's own tables, so a
 * category can never name an account that does not exist, and A01's archive/delete guards see the
 * category as a live reference. `active` is the soft-archive flag: a category is never deleted (§5),
 * because an asset created under it must stay resolvable for its whole depreciable life.
 *
 * Code uniqueness is CASE-INSENSITIVE per workspace, enforced at the DB layer by a UNIQUE index over
 * `(workspace_id, lower(code))` so even a cross-process race cannot seat two `MACH`/`mach` rows. The
 * engine additionally checks it first for a friendly `duplicate_code`, the `create_account` shape.
 */

export const ASSETS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_category (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspace(id),
  code                       TEXT NOT NULL,
  name                       TEXT NOT NULL,
  description                TEXT,
  -- The registered depreciation method (§H-ENUM: straight_line | declining_balance |
  -- units_of_production | none). Enforced by the engine against DEPRECIATION_METHODS, not a CHECK,
  -- so H03 can register a further method in one place without a migration (the journal_entry.source
  -- convention).
  depreciation_method        TEXT NOT NULL,
  -- Required unless the method is 'none'; enforced in the verb, NULL only for a non-depreciating
  -- category.
  useful_life_months         INTEGER,
  -- Basis points 0..10000 (10000 = 100%). Default 0: nothing is retained at end of life unless the
  -- category says so.
  residual_value_pct         INTEGER NOT NULL DEFAULT 0,
  -- An ABSOLUTE residual in Rappen, when a category fixes the salvage value as a figure rather than
  -- a fraction of cost. When present it OVERRIDES residual_value_pct (§4). NULL is the ordinary case.
  residual_value_rappen      INTEGER,
  gl_asset_account_id        TEXT NOT NULL REFERENCES account(id),
  gl_accum_depr_account_id   TEXT NOT NULL REFERENCES account(id),
  gl_depr_expense_account_id TEXT NOT NULL REFERENCES account(id),
  default_cost_center_id     TEXT REFERENCES cost_center(id),
  active                     INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  created_by                 TEXT
);

-- CASE-INSENSITIVE code uniqueness per workspace (§4: unique (workspace_id, lower(code))). The
-- engine checks it first for a friendly duplicate_code; this is the race guard underneath, so two
-- concurrent writers cannot both seat a category with the same code in different letter case.
CREATE UNIQUE INDEX IF NOT EXISTS asset_category_code_unique_per_workspace
ON asset_category (workspace_id, lower(code));

-- §H-TENANT + the archived filter the Settings list and resolve path both read.
CREATE INDEX IF NOT EXISTS asset_category_workspace_active
ON asset_category (workspace_id, active);
`;
