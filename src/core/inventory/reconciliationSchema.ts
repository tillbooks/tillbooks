/**
 * J06, the valuation-run / GL-link DDL. Two tables, concatenated onto `SCHEMA_SQL` after
 * `LANDED_COST_SCHEMA_SQL` (the module-owned pattern J00-J03 use), so `workspace`, `item`, `account`,
 * `stock_location` and `journal_entry` all exist by the time these are created.
 *
 * WHY A RUN IS A DURABLE, APPEND-ONLY RECORD AND NOT A CACHE. `inventory_valuation_run` is the proof
 * that on a given cut-off the inventory sub-ledger was valued at a stated figure and that exactly that
 * figure was carried to the General Ledger through A02. The monetary effect lives in the journal (A02
 * seals it); the run is the Bestandesnachweis that ties the journal to the movement ledger and the
 * method that produced it (OR 957a orderly records, OR 958c Stetigkeit). So the LINES are immutable
 * (both BEFORE triggers ABORT, exactly as `inventory_valuation_method` and `stock_movement` do), and a
 * run's financial identity is frozen the instant it leaves `draft`: the trigger below forbids changing
 * `as_of`, `method`, `total_value_rappen`, `journal_entry_id` or `line_count` once posted, and permits
 * only the one-way `posted -> reversed` transition that records the reversing journal. A correction is
 * a reverse plus a fresh run, never an edit of a posted row.
 *
 * `recursive_triggers = ON` (set by the store) means an `INSERT OR REPLACE` fires the DELETE trigger
 * and aborts too, so the immutability of a line cannot be routed around. §H-TENANT: `workspace_id` is
 * on both tables and every read and write filters on it.
 */

export const RECONCILIATION_SCHEMA_SQL = `
-- J06: the durable header of one period-end or as-of valuation. status is 'draft' | 'posted' |
-- 'reversed' (validated at the verb boundary, never a CHECK, the D01/J03 convention). total_value_rappen
-- is the signed sum of the run's line values; delta_rappen is what was actually posted to the GL
-- (subledger minus the GL balance at the cut-off). journal_entry_id links the ONE A02 entry.
CREATE TABLE IF NOT EXISTS inventory_valuation_run (
  id                            TEXT PRIMARY KEY,
  workspace_id                  TEXT NOT NULL REFERENCES workspace(id),
  as_of                         TEXT NOT NULL,
  period                        TEXT,
  method                        TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'draft',
  total_value_rappen            INTEGER NOT NULL DEFAULT 0,
  delta_rappen                  INTEGER NOT NULL DEFAULT 0,
  line_count                    INTEGER NOT NULL DEFAULT 0,
  journal_entry_id              TEXT REFERENCES journal_entry(id),
  reversing_journal_entry_id    TEXT REFERENCES journal_entry(id),
  prior_run_id                  TEXT REFERENCES inventory_valuation_run(id),
  filters_json                  TEXT,
  ledger_fingerprint            TEXT,
  notes                         TEXT,
  is_opening                    INTEGER NOT NULL DEFAULT 0,
  idempotency_key               TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  created_by                    TEXT,
  posted_at                     TEXT,
  posted_by                     TEXT
);

-- §H-IDEMPOTENT: the race guard underneath the pre-check. A replayed key cannot mint a second run.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_valuation_run_key
  ON inventory_valuation_run (workspace_id, idempotency_key);

-- The list/report lookups: by status, and by cut-off (newest first).
CREATE INDEX IF NOT EXISTS inventory_valuation_run_lookup
  ON inventory_valuation_run (workspace_id, as_of, status);

-- J06: one frozen valuation line per (item, location) of a run. qty is integer thousandths of the
-- base unit (the movement-ledger convention); every *_rappen is integer Rappen. control_account_id is
-- the resolved GL inventory control account this line's value lands under. No mutable field exists
-- after the row is written: the snapshot is the evidence.
CREATE TABLE IF NOT EXISTS inventory_valuation_line (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES inventory_valuation_run(id),
  workspace_id          TEXT NOT NULL REFERENCES workspace(id),
  item_id               TEXT NOT NULL REFERENCES item(id),
  item_name             TEXT,
  location_id           TEXT REFERENCES stock_location(id),
  lot_id                TEXT,
  serial_id             TEXT,
  qty                   INTEGER NOT NULL DEFAULT 0,
  unit_cost_rappen      INTEGER,
  value_rappen          INTEGER NOT NULL DEFAULT 0,
  control_account_id    TEXT NOT NULL REFERENCES account(id),
  market_value_rappen   INTEGER,
  is_market_write_down  INTEGER NOT NULL DEFAULT 0,
  valuation_basis       TEXT,
  reason                TEXT
);

CREATE INDEX IF NOT EXISTS inventory_valuation_line_run
  ON inventory_valuation_line (workspace_id, run_id);

CREATE INDEX IF NOT EXISTS inventory_valuation_line_item
  ON inventory_valuation_line (workspace_id, item_id);

-- The line snapshot is immutable. A valuation line that could be edited is a filed Bestandesnachweis
-- that could be silently rewritten, which OR 957a forbids. A correction is a fresh run.
CREATE TRIGGER IF NOT EXISTS inventory_valuation_line_no_update
BEFORE UPDATE ON inventory_valuation_line
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_line_immutable');
END;

CREATE TRIGGER IF NOT EXISTS inventory_valuation_line_no_delete
BEFORE DELETE ON inventory_valuation_line
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_line_immutable');
END;

-- A run is never deleted (it is the durable record).
CREATE TRIGGER IF NOT EXISTS inventory_valuation_run_no_delete
BEFORE DELETE ON inventory_valuation_run
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_run_immutable');
END;

-- Once a run leaves 'draft' its financial identity is frozen. The ONLY change a posted run may take
-- is the one-way transition to 'reversed' that records the reversing journal; every other field that
-- decides money (the cut-off, the method, the posted total, the original journal, the line count) is
-- sealed. A draft is still freely updatable (the WHEN gate excludes it), which is how post flips it.
CREATE TRIGGER IF NOT EXISTS inventory_valuation_run_frozen_after_post
BEFORE UPDATE ON inventory_valuation_run
WHEN OLD.status IN ('posted', 'reversed')
  AND (
       NEW.as_of <> OLD.as_of
    OR NEW.method <> OLD.method
    OR NEW.total_value_rappen <> OLD.total_value_rappen
    OR NEW.line_count <> OLD.line_count
    OR NEW.journal_entry_id IS NOT OLD.journal_entry_id
    OR (OLD.status = 'reversed')
  )
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_run_posted_immutable');
END;
`;
