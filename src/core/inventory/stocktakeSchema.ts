/**
 * J04, the cycle-count / stocktake DDL. Two J04-owned tables (`cycle_count_session`,
 * `cycle_count_line`), concatenated onto `SCHEMA_SQL` after `RECONCILIATION_SCHEMA_SQL` (the
 * module-owned pattern J00-J06 use), so `workspace`, `item`, `warehouse`, `stock_location` and
 * `stock_movement` all exist by the time these are created.
 *
 * WHY NEW TABLES AND NOT D01's `stocktake_session` / `stocktake_line`. D01 already owns a pair of
 * tables by exactly those names (`src/core/stock/schema.ts`), still written by the live D01 verbs
 * (`stock_stocktake_open` / `_count` / `_commit`) and referenced by the location/warehouse archive
 * guards and the OP3 `stocktake` entity kind. J04 is a strictly richer model (session type, blind
 * mode, a line status machine, per-line variance thresholds, the frozen movement link) and it is a
 * MONEY-PATH capability, so it wants immutability triggers it fully controls rather than triggers
 * bolted onto tables a second engine also mutates. New names give J04 that clean ownership; the D01
 * data stays queryable through the read-through in `stocktake.ts` (spec §2 US-J04.8). A `CREATE TABLE
 * IF NOT EXISTS stocktake_session (...)` here would have silently no-opped against D01's existing
 * table and never created J04's extra columns, which is the trap this avoids.
 *
 * WHY THE SNAPSHOT AND THE COMMITTED SESSION ARE IMMUTABLE (spec §7, §H-STOCK-AUDIT / §H-AUDIT).
 * On-hand is always `SUM(stock_movement.qty)` (J02, OP13): J04 NEVER writes a quantity itself. A
 * committed session is the Bestandesnachweis (OR 958c Abs. 2) that a valuation at `freeze_at` links
 * as its evidence, so once it leaves `open`/`review` it is frozen: the BEFORE UPDATE trigger aborts
 * any change to a `committed` or `cancelled` session, exactly as `inventory_valuation_run` freezes
 * after post. The line's `book_qty` is the frozen snapshot and is immutable for the LIFE of the line
 * (a separate always-on trigger), because a book quantity that could be edited is a variance that
 * could be silently rewritten. `recursive_triggers = ON` (set by the store) means an
 * `INSERT OR REPLACE` fires the DELETE trigger and aborts too, so the guards cannot be routed around.
 * A correction after commit is a COMPENSATING J02 movement (spec §2 US-J04.6), never an edit.
 *
 * NO CHECK CONSTRAINT on `type`, `status` (session or line): the enums live at the verb boundary in
 * `stocktake.ts` (the D01 / J02 / J03 convention), validated once there. §H-TENANT: `workspace_id`
 * is on both tables and every read and write filters on it.
 */

export const STOCKTAKE_SCHEMA_SQL = `
-- J04: one cycle-count / stocktake session. type is 'full' (an OR 958c Abs. 2 Inventur frozen at a
-- balance-sheet date) or 'cycle' (an ongoing count of a scope without a full freeze). status is
-- 'open' | 'review' | 'committed' | 'cancelled' (committed and cancelled are terminal and immutable).
-- freeze_at is the ISO date the book quantities were snapshotted as-of (the J02 balance-as-of date and
-- the date every committed variance movement is stamped with). blind_count hides book_qty from the
-- count response until review. variance_*_threshold classify a counted line as material: a non-zero
-- variance that exceeds either enters 'review_required' and blocks commit until approved. total_lines
-- is fixed at create; the counted / review / progress figures are computed live from the lines.
CREATE TABLE IF NOT EXISTS cycle_count_session (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspace(id),
  type                    TEXT NOT NULL DEFAULT 'full',
  status                  TEXT NOT NULL DEFAULT 'open',
  freeze_at               TEXT NOT NULL,
  blind_count             INTEGER NOT NULL DEFAULT 0,
  warehouse_id            TEXT REFERENCES warehouse(id),
  selection_hash          TEXT,
  variance_qty_threshold  INTEGER NOT NULL DEFAULT 0,
  variance_pct_threshold  INTEGER NOT NULL DEFAULT 0,
  notes                   TEXT,
  total_lines             INTEGER NOT NULL DEFAULT 0,
  inventar_document_id    TEXT,
  committed_at            TEXT,
  committed_by            TEXT,
  cancelled_at            TEXT,
  cancel_reason           TEXT,
  created_by              TEXT,
  idempotency_key         TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT
);

-- §H-IDEMPOTENT: the race guard underneath the pre-check. A replayed create key cannot mint a second
-- session; the winner is returned.
CREATE UNIQUE INDEX IF NOT EXISTS cycle_count_session_key
  ON cycle_count_session (workspace_id, idempotency_key);

-- The list lookups: by status and freeze date (newest first).
CREATE INDEX IF NOT EXISTS cycle_count_session_lookup
  ON cycle_count_session (workspace_id, status, freeze_at);

-- J04: one frozen line per (item, location [, lot, serial]) of a session. book_qty is the immutable
-- J02 balance-as-of snapshot (integer thousandths, the movement-ledger convention). counted_qty is
-- what was physically counted (NULL until counted; may be 0). variance is COMPUTED, never stored as a
-- source of truth (P5). status walks pending -> counted | review_required -> approved. movement_id is
-- the OP13 adjustment this line minted on commit (NULL for a zero-variance line and before commit).
CREATE TABLE IF NOT EXISTS cycle_count_line (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES cycle_count_session(id),
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  item_id       TEXT NOT NULL REFERENCES item(id),
  location_id   TEXT NOT NULL REFERENCES stock_location(id),
  lot_id        TEXT REFERENCES lot(id),
  serial_id     TEXT REFERENCES serial(id),
  book_qty      INTEGER NOT NULL,
  counted_qty   INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending',
  counted_at    TEXT,
  counted_by    TEXT,
  movement_id   TEXT REFERENCES stock_movement(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- One line per key within a session (nulls folded so a second all-null line cannot slip in).
CREATE UNIQUE INDEX IF NOT EXISTS cycle_count_line_key
  ON cycle_count_line (session_id, item_id, location_id, COALESCE(lot_id, ''), COALESCE(serial_id, ''));

CREATE INDEX IF NOT EXISTS cycle_count_line_by_session
  ON cycle_count_line (workspace_id, session_id, status);

-- A session is never deleted (it is the durable Bestandesnachweis).
CREATE TRIGGER IF NOT EXISTS cycle_count_session_no_delete
BEFORE DELETE ON cycle_count_session
BEGIN
  SELECT RAISE(ABORT, 'cycle_count_session_immutable');
END;

-- Once a session leaves 'open'/'review' it is frozen: a committed or cancelled session takes no
-- further update. The one commit UPDATE runs while OLD.status is still 'open'/'review', so it passes;
-- every later edit aborts. This is the §H-AUDIT immutability of the filed count.
CREATE TRIGGER IF NOT EXISTS cycle_count_session_frozen
BEFORE UPDATE ON cycle_count_session
WHEN OLD.status IN ('committed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'cycle_count_session_immutable');
END;

-- A line is never deleted.
CREATE TRIGGER IF NOT EXISTS cycle_count_line_no_delete
BEFORE DELETE ON cycle_count_line
BEGIN
  SELECT RAISE(ABORT, 'cycle_count_line_immutable');
END;

-- The book snapshot is immutable for the life of the line (always on, independent of session status).
-- book_qty is the frozen J02 balance-as-of; a book quantity that could be edited is a variance that
-- could be silently rewritten (§H-STOCK-AUDIT). Counting, approving and recounting all leave it alone.
CREATE TRIGGER IF NOT EXISTS cycle_count_line_book_immutable
BEFORE UPDATE ON cycle_count_line
WHEN NEW.book_qty <> OLD.book_qty
BEGIN
  SELECT RAISE(ABORT, 'cycle_count_line_book_immutable');
END;

-- After the session commits or cancels, every line is frozen too (the commit sets movement_id and the
-- final status while the session is still open, so that write passes; anything after aborts).
CREATE TRIGGER IF NOT EXISTS cycle_count_line_frozen
BEFORE UPDATE ON cycle_count_line
WHEN (SELECT status FROM cycle_count_session WHERE id = OLD.session_id) IN ('committed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'cycle_count_line_immutable');
END;
`;
