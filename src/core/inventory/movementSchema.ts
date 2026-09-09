/**
 * J02, the inventory movement ledger: the DDL that turns D01's existing `stock_movement` table into
 * the AUTHORITATIVE append-only movement ledger (spec §4). Kept in J02's own module and concatenated
 * onto `SCHEMA_SQL` at the store AFTER `STOCK_SCHEMA_SQL` (the A14/A19/J00/J01 module-owned pattern),
 * so `stock_movement` exists by the time these triggers are created.
 *
 * WHY THIS EXTENDS `stock_movement` INSTEAD OF ADDING A TABLE (spec §4 Reconciliation). J00's
 * `balance.ts` and J01's `tracking.ts` already derive on-hand as `SUM(stock_movement.qty)` (J01
 * attached the `lot_id` / `serial_id` FKs to it). A second `inventory_movement` table would split
 * on-hand truth in two and break both of them the moment J02 wrote a row. J02 owns the ENFORCEMENT
 * instead: the append-only immutability guarantee (OP13 / §H-STOCK-AUDIT) and the negative-stock
 * policy, both on the one table every inventory read already sums.
 *
 * APPEND-ONLY IS A LOAD-BEARING RUNTIME GUARD, NOT A CONVENTION. A movement row is insert-only: the
 * two BEFORE triggers ABORT any UPDATE or DELETE, exactly as `journal_entry_no_update_posted` does
 * for a posted journal (spec §7, invariant 6). On-hand is a pure SUM over these rows, so a row that
 * could be edited is a quantity that could be silently rewritten, which is the failure mode OR 957a
 * orderly bookkeeping and the OR 958c Bestandesnachweis forbid. `recursive_triggers = ON` (set by the
 * store) means an `INSERT OR REPLACE` would fire the DELETE trigger and abort too, so the guard cannot
 * be routed around. A correction is another movement (reversing quantity), never an edit.
 *
 * `inventory_config` is the per-workspace negative-stock posture (spec §4): `allow_negative_stock`
 * defaults to 0 (false), so an issue or transfer that would drive a balance below zero is refused
 * with `insufficient_stock` until an operator opts out through `inventory_set_config`. A row is
 * absent until first set; the reader treats absent as the default false. §H-TENANT: workspace_id is
 * the primary key, and every query scopes by it.
 */

export const MOVEMENT_SCHEMA_SQL = `
-- J02: the append-only immutability of the movement ledger, enforced at the DB layer (spec §7, the
-- journal_entry_no_update_posted pattern). on-hand is SUM(stock_movement.qty), so an editable row is
-- an editable quantity: forbidden.
CREATE TRIGGER IF NOT EXISTS stock_movement_no_update
BEFORE UPDATE ON stock_movement
BEGIN
  SELECT RAISE(ABORT, 'stock_movement_immutable');
END;

CREATE TRIGGER IF NOT EXISTS stock_movement_no_delete
BEFORE DELETE ON stock_movement
BEGIN
  SELECT RAISE(ABORT, 'stock_movement_immutable');
END;

-- J02: the per-workspace negative-stock policy (spec §4). Absent until first set; the reader defaults
-- allow_negative_stock to 0 (false). Never a CHECK constraint (the D01 convention): the boolean is
-- validated at the verb boundary.
CREATE TABLE IF NOT EXISTS inventory_config (
  workspace_id        TEXT PRIMARY KEY REFERENCES workspace(id),
  allow_negative_stock INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT
);
`;

// The transfer-pair lookup index lives in ADDITIVE_INDEXES (`core/store/schema.ts`), not here: it
// names `transfer_group_id`, a column J02 adds through ADDITIVE_COLUMNS, and a fresh database runs
// SCHEMA_SQL (this string) BEFORE applyAdditiveSchema adds that column, so a CREATE INDEX over it
// here would fail with "no such column". The (workspace, item, location, moved_at) index D01 already
// ships covers the balance SUM and the chronological history.

