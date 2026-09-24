/**
 * J03, the valuation policy DDL. Two tables, concatenated onto `SCHEMA_SQL` after
 * `MOVEMENT_SCHEMA_SQL` (the module-owned pattern J00/J01/J02 use), so `stock_movement` and `item`
 * exist by the time these are created.
 *
 * WHY THE ASSIGNMENT IS DATED AND APPEND-ONLY. A valuation method is not a setting, it is the basis
 * of a filed figure. If it were a mutable column, flipping it would restate every period at once: ask
 * the engine for the inventory value at 31.12.2025 after switching to FIFO in June 2026 and you would
 * get a different number than the one in the signed Bilanz, with nothing anywhere recording that it
 * had moved. So a change is a ROW, carrying the date it takes effect and the reason it was made, and
 * resolution at an as-of date picks the assignment that was in force THEN. That is OR 958c Stetigkeit
 * made demonstrable rather than asserted, and it is why `inventory_valuation_set_default` checks the
 * period lock against `effective_from` and not against the day someone happened to type it.
 *
 * The two BEFORE triggers ABORT any UPDATE or DELETE, exactly as `stock_movement_immutable` does for
 * a movement and `journal_entry_no_update_posted` does for a posted entry. `recursive_triggers = ON`
 * (set by the store) means an `INSERT OR REPLACE` fires the DELETE trigger and aborts too, so the
 * guard cannot be routed around. A correction is another assignment row, never an edit.
 *
 * `inventory_valuation_config` is deliberately NOT dated: it gates which methods may be CHOSEN from
 * here on, never what a past figure was, and the dated assignment is what determines any historical
 * value. A row is absent until first set; the reader treats absent as the built-in default
 * (weighted_average and fifo enabled, standard_cost off). §H-TENANT: workspace_id is the primary key.
 */

export const VALUATION_SCHEMA_SQL = `
-- J03: the APPEND-ONLY dated valuation-method assignment (the OR 958c Stetigkeit trail). scope is
-- 'workspace' (item_id NULL) or 'item'. Never a CHECK constraint on method or scope (the D01
-- convention): both are validated at the verb boundary against the §H-ENUM in valuation.ts.
CREATE TABLE IF NOT EXISTS inventory_valuation_method (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  scope               TEXT NOT NULL,
  item_id             TEXT REFERENCES item(id),
  method              TEXT NOT NULL,
  standard_cost_minor INTEGER,
  effective_from      TEXT NOT NULL,
  reason              TEXT,
  force_revaluation   INTEGER NOT NULL DEFAULT 0,
  idempotency_key     TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT
);

-- §H-IDEMPOTENT: the race guard underneath the pre-check. A replayed key cannot mint a second row
-- even when two callers pass the read at the same instant.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_valuation_method_key
  ON inventory_valuation_method (workspace_id, idempotency_key);

-- The resolution lookup: latest assignment in force at an as-of date, per scope and item.
CREATE INDEX IF NOT EXISTS inventory_valuation_method_lookup
  ON inventory_valuation_method (workspace_id, scope, item_id, effective_from);

-- The immutability guarantee. A valuation basis that could be edited is a filed figure that could be
-- silently rewritten, which is what OR 957a orderly bookkeeping forbids.
CREATE TRIGGER IF NOT EXISTS inventory_valuation_method_no_update
BEFORE UPDATE ON inventory_valuation_method
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_method_immutable');
END;

CREATE TRIGGER IF NOT EXISTS inventory_valuation_method_no_delete
BEFORE DELETE ON inventory_valuation_method
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_method_immutable');
END;

-- J03: the forward-looking per-workspace method enablement. Absent means the built-in default.
-- enabled_methods is a JSON array of §H-ENUM keys; it is not dated, because it constrains what may be
-- chosen next, never what a past figure was.
CREATE TABLE IF NOT EXISTS inventory_valuation_config (
  workspace_id    TEXT PRIMARY KEY REFERENCES workspace(id),
  enabled_methods TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT
);
`;
