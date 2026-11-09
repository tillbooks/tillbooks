/**
 * J01, lot & serial tracking: the two master tables (`lot`, `serial`) that hang off J00's inventory
 * root and D00's item. Kept in J01's own module and concatenated onto `SCHEMA_SQL` at the store (the
 * A14/A19/J00 module-owned DDL pattern), so concurrent capability branches never all edit one long
 * string.
 *
 * NEITHER TABLE CARRIES A QUANTITY COLUMN (spec §4, §H-STOCK-AUDIT / OP13). On-hand for a lot is
 * always the live `SUM(stock_movement.qty)` filtered by `lot_id`, and a serial is a unit of one whose
 * availability is derived from its `status`, never a stored count. The one thing stored is descriptive
 * master data plus the status lifecycle. §H-TENANT: every row carries `workspace_id`, and every query
 * scopes by it.
 *
 * Number uniqueness is CASE-INSENSITIVE and PER ITEM, not global (spec §4): two different products may
 * reuse the same lot or serial numbering scheme, so the unique index is over `(workspace_id, item_id,
 * lower(number))`. The engine additionally checks it first for a friendly `lot_number_taken` /
 * `serial_number_taken` (the `warehouse` / `create_account` shape); the DB index is the race guard
 * underneath.
 *
 * The J02 movement ledger reads these two tables: it attaches an optional nullable `lot_id` /
 * `serial_id` to `stock_movement` (added via `ADDITIVE_COLUMNS` in `core/store/schema.ts`, since
 * `stock_movement` is D01's existing table) and enforces the reference when the item's `tracking_mode`
 * demands it. J01 defines the masters and the on-hand-by-lot read model; J02 owns the enforcement.
 */

export const TRACKING_SCHEMA_SQL = `
-- J01: a batch of a lot-tracked item. NO quantity column (on-hand is SUM(stock_movement.qty) by
-- lot_id). status is the §H-ENUM open|held|expired|closed|archived, validated at the verb boundary,
-- never a CHECK constraint (the D01 convention). expiry_date / manufactured_date are inclusive ISO
-- days. Custom fields and saved views attach via the OP3 kind 'lot', registered in
-- customization/entities.ts.
CREATE TABLE IF NOT EXISTS lot (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  item_id            TEXT NOT NULL REFERENCES item(id),
  number             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  expiry_date        TEXT,
  manufactured_date  TEXT,
  supplier_reference TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT
);

-- CASE-INSENSITIVE lot number uniqueness PER ITEM (spec §4). The engine checks it first for a friendly
-- lot_number_taken; this is the race guard underneath.
CREATE UNIQUE INDEX IF NOT EXISTS lot_number_unique_per_item
ON lot (workspace_id, item_id, lower(number));

CREATE INDEX IF NOT EXISTS lot_by_item
ON lot (workspace_id, item_id, status);

-- J01: an individually identified unit of a serial-tracked item. NO quantity column (a serial is a
-- unit of one; availability is derived from status). lot_id is mandatory when the item is
-- lot_and_serial (enforced at the verb boundary). current_location_id is a PROJECTION of the latest
-- movement that referenced the serial, updated by J02's movement verbs, never a stored balance. status
-- is the §H-ENUM available|reserved|issued|returned|scrapped|archived. Custom fields and saved views
-- attach via the OP3 kind 'serial', registered in customization/entities.ts.
CREATE TABLE IF NOT EXISTS serial (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  item_id             TEXT NOT NULL REFERENCES item(id),
  lot_id              TEXT REFERENCES lot(id),
  number              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'available',
  current_location_id TEXT REFERENCES stock_location(id),
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  created_by          TEXT
);

-- CASE-INSENSITIVE serial number uniqueness PER ITEM (spec §4). The engine checks it first for a
-- friendly serial_number_taken; this is the race guard underneath.
CREATE UNIQUE INDEX IF NOT EXISTS serial_number_unique_per_item
ON serial (workspace_id, item_id, lower(number));

CREATE INDEX IF NOT EXISTS serial_by_item
ON serial (workspace_id, item_id, status);

CREATE INDEX IF NOT EXISTS serial_by_location
ON serial (workspace_id, current_location_id) WHERE current_location_id IS NOT NULL;
`;
