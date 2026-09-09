/**
 * J05, the inventory-adjustment DDL. Two J05-owned tables, concatenated onto `SCHEMA_SQL` after
 * `STOCKTAKE_SCHEMA_SQL` (the module-owned J00-J06 pattern), so `workspace`, `item`, `stock_location`,
 * `lot`, `serial` and `stock_movement` all exist by the time these are created.
 *
 *   1. `inventory_reason_code`, the workspace-scoped catalog of structured reason codes (category,
 *      requires_note, active lifecycle). MUTABLE: an update flips is_active / requires_note / name,
 *      an archive soft-deletes (is_active = 0). Historical adjustments keep the foreign key forever.
 *   2. `inventory_adjustment`, one APPEND-ONLY row per minted manual-adjustment movement. It is the
 *      reason linkage: it names the J02 `stock_movement` it explains and the active reason code that
 *      classified it. A reverse is a NEW row pointing at the original through `reverses_adjustment_id`,
 *      never an edit, so the table is frozen by no-UPDATE / no-DELETE triggers.
 *
 * WHY THE REASON LIVES HERE AND NOT ON `stock_movement` (spec §1 reconcile, 2026-08-17). J02's
 * `stock_movement` is reason-agnostic on purpose: J04 stocktake mints reason-free `adjustment`
 * movements, and a "every adjustment movement carries a reason" column on the J02 insert would refuse
 * every one of them. J05 links its reason through `inventory_adjustment.movement_id` instead, and
 * enforces the mandatory-active-reason rule at its OWN verb (`adjust.ts`), before any movement is
 * minted. On-hand stays `SUM(stock_movement.qty)` (OP13); J05 writes no quantity of its own.
 *
 * NO CHECK CONSTRAINT on `category` (§H-ENUM): the enum lives at the verb boundary in `reason.ts` (the
 * D01 / J02 / J04 convention), validated once there. §H-TENANT: `workspace_id` is on both tables and
 * every read and write filters on it.
 */

export const ADJUST_SCHEMA_SQL = `
-- J05: the workspace-scoped reason-code catalog. code is stored upper-normalised and is unique per
-- workspace, case-insensitively (the verb normalises before insert). category is one of the §H-ENUM
-- ReasonCategory values, validated in reason.ts. requires_note forces a non-empty note on any
-- adjustment that cites this code. default_for_stocktake marks the code a stocktake commit may adopt.
-- is_active is the soft-archive flag: an archived code disappears from pickers but stays queryable for
-- historical joins (archived_at records when). This table is MUTABLE (update / archive edit it).
CREATE TABLE IF NOT EXISTS inventory_reason_code (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  category              TEXT NOT NULL,
  requires_note         INTEGER NOT NULL DEFAULT 0,
  default_for_stocktake INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  created_by            TEXT,
  updated_at            TEXT,
  archived_at           TEXT
);

-- Case-insensitive uniqueness of the code within a workspace (the verb upper-normalises; this index
-- lower-folds so a stored 'SCHWUND' cannot be shadowed by a second 'schwund').
CREATE UNIQUE INDEX IF NOT EXISTS inventory_reason_code_unique
  ON inventory_reason_code (workspace_id, lower(code));

-- §H-IDEMPOTENT on create: a replayed create key cannot mint a second reason code; the winner returns.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_reason_code_key
  ON inventory_reason_code (workspace_id, idempotency_key);

CREATE INDEX IF NOT EXISTS inventory_reason_code_lookup
  ON inventory_reason_code (workspace_id, is_active, category);

-- J05: one APPEND-ONLY row per minted manual-adjustment movement. movement_id is the J02
-- stock_movement this row explains; reason_code_id is the active reason that classified it (NOT NULL,
-- enforced at the verb). qty_delta mirrors the movement's signed qty. batch_id is shared across the
-- lines of one inventory_adjust_batch (NULL for a single adjust). reverses_adjustment_id is set on a
-- reversal row and points at the original, so "already reversed" is a query for such a row, never a
-- mutation of the original.
CREATE TABLE IF NOT EXISTS inventory_adjustment (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  batch_id               TEXT,
  movement_id            TEXT NOT NULL REFERENCES stock_movement(id),
  reason_code_id         TEXT NOT NULL REFERENCES inventory_reason_code(id),
  item_id                TEXT NOT NULL REFERENCES item(id),
  location_id            TEXT NOT NULL REFERENCES stock_location(id),
  lot_id                 TEXT REFERENCES lot(id),
  serial_id              TEXT REFERENCES serial(id),
  qty_delta              INTEGER NOT NULL,
  note                   TEXT,
  unit_cost_minor        INTEGER,
  effective_date         TEXT NOT NULL,
  reverses_adjustment_id TEXT REFERENCES inventory_adjustment(id),
  idempotency_key        TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  created_by             TEXT
);

CREATE INDEX IF NOT EXISTS inventory_adjustment_lookup
  ON inventory_adjustment (workspace_id, created_at);

CREATE INDEX IF NOT EXISTS inventory_adjustment_by_reason
  ON inventory_adjustment (workspace_id, reason_code_id);

CREATE INDEX IF NOT EXISTS inventory_adjustment_by_batch
  ON inventory_adjustment (workspace_id, batch_id);

-- The reversal lookup: given an original id, is there a row that reverses it? (the append-only
-- "already reversed" test, no UPDATE required).
CREATE INDEX IF NOT EXISTS inventory_adjustment_by_reverses
  ON inventory_adjustment (workspace_id, reverses_adjustment_id);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_adjustment_movement
  ON inventory_adjustment (movement_id);

-- APPEND-ONLY (§H-AUDIT). An adjustment record explains why a movement happened; editing or deleting
-- it would rewrite that explanation. A correction is a NEW reversal row, so nothing here ever changes.
-- recursive_triggers = ON (set by the store) means an INSERT OR REPLACE fires the DELETE trigger and
-- aborts too, so the guards cannot be routed around.
CREATE TRIGGER IF NOT EXISTS inventory_adjustment_no_update
BEFORE UPDATE ON inventory_adjustment
BEGIN
  SELECT RAISE(ABORT, 'inventory_adjustment_immutable');
END;

CREATE TRIGGER IF NOT EXISTS inventory_adjustment_no_delete
BEFORE DELETE ON inventory_adjustment
BEGIN
  SELECT RAISE(ABORT, 'inventory_adjustment_immutable');
END;
`;
