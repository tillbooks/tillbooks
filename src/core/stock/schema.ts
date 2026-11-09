/**
 * D01's five tables (data model §D), kept in D01's own module and concatenated onto `SCHEMA_SQL` at
 * the store, the pattern A14/A19/A24/G00/C00/E00/B00 established: the DDL a capability writes sits
 * beside the code that writes it, so concurrent capability branches never all edit one long string in
 * `store/schema.ts`.
 *
 * `stock_movement` IS THE OP2 NON-POSTING LEDGER (spec §1): it records quantity, never money on the
 * account ledger. The ONLY path inventory value reaches the books is `stock_valuation_run`, which
 * stores the `posted_entry_id` A02 minted (P3), so the run row is a cached read of a real journal
 * entry and never a second source of truth for money the ledger holds (the A19 `opening_entry_id`
 * argument). §H-TENANT: every table carries `workspace_id`, and every query scopes by it.
 *
 * NO CHECK CONSTRAINT on `reason`, `method` or `status`: the enums live at the single §H-ENUM source
 * (`enums.ts`), validated at the verb boundary, so the vocabulary stays in exactly one place (§6b).
 *
 * `active` on a valuation run is the reverse-and-replace flag (§H-AUDIT): a re-run at the same
 * `as_of` reverses the prior run's posted entry through A02 and supersedes its row (`active = 0`),
 * never edits it. Quantities are integer units in the item's own unit; money is integer Rappen (P2).
 */

export const STOCK_SCHEMA_SQL = `
-- D01: a place inventory sits. type is an organisational tag (warehouse/store/...), never an enum
-- that feeds valuation (spec 6b). Custom fields and saved views attach via the OP3 kind
-- stock_location, registered in customization/entities.ts.
CREATE TABLE IF NOT EXISTS stock_location (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name         TEXT NOT NULL,
  type         TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stock_location_by_workspace
ON stock_location (workspace_id, archived, name);

-- D01: the OP2 non-posting quantity ledger. qty is a SIGNED integer change (never zero): a receipt
-- adds, an issue subtracts, an adjust carries the sign the caller gave (a stocktake shrink is
-- negative), a transfer writes a paired issue+receipt. unit_cost_minor is the CHF Rappen cost basis
-- of a receipt (a foreign purchase cost is converted before storage, H-FX); absent, valuation falls
-- back to the item's D00 cost_price_minor. ref_kind/ref_id tie a movement back to what caused it
-- (e.g. stocktake). Append-only in spirit: a correction is another movement, never an edit.
CREATE TABLE IF NOT EXISTS stock_movement (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  item_id         TEXT NOT NULL REFERENCES item(id),
  location_id     TEXT NOT NULL REFERENCES stock_location(id),
  qty             INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  unit_cost_minor INTEGER,
  moved_at        TEXT NOT NULL,
  ref_kind        TEXT,
  ref_id          TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stock_movement_by_item
ON stock_movement (workspace_id, item_id, location_id, moved_at);

-- D01: the idempotency identity of a movement write is (workspace, key). A transfer writes two rows
-- under (key, key#in), so each leg has its own key; the boundary key is unique per write.
CREATE UNIQUE INDEX IF NOT EXISTS stock_movement_idempotency
ON stock_movement (workspace_id, idempotency_key);

-- D01: a period-end valuation run. total_value_minor is the FULL computed inventory value at as_of;
-- baseline_value_minor is what the ledger held before this run; delta_minor is what was posted
-- (total - baseline). posted_entry_id is the A02 entry (NULL for a zero-delta run). active is 1 for
-- the run the ledger currently reflects; a reverse-and-replace flips the superseded run to 0.
CREATE TABLE IF NOT EXISTS stock_valuation_run (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  method               TEXT NOT NULL,
  as_of                TEXT NOT NULL,
  total_value_minor    INTEGER NOT NULL,
  baseline_value_minor INTEGER NOT NULL,
  delta_minor          INTEGER NOT NULL,
  posted_entry_id      TEXT REFERENCES journal_entry(id),
  reversed_entry_id    TEXT REFERENCES journal_entry(id),
  active               INTEGER NOT NULL DEFAULT 1,
  idempotency_key      TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stock_valuation_run_by_workspace
ON stock_valuation_run (workspace_id, active, as_of);

CREATE UNIQUE INDEX IF NOT EXISTS stock_valuation_run_idempotency
ON stock_valuation_run (workspace_id, idempotency_key);

-- D01: an Inventur session (OR 958c Abs. 2 Bestandesnachweis). frozen_at is the balance-sheet date
-- the book quantities were snapshotted at; status is open|committed|cancelled (committed is terminal
-- and immutable). inventar_document_id links the filed E00 Inventar once committed.
CREATE TABLE IF NOT EXISTS stocktake_session (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  frozen_at            TEXT NOT NULL,
  location_id          TEXT REFERENCES stock_location(id),
  status               TEXT NOT NULL DEFAULT 'open',
  committed_by         TEXT,
  inventar_document_id TEXT,
  idempotency_key      TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  committed_at         TEXT
);

CREATE INDEX IF NOT EXISTS stocktake_session_by_workspace
ON stocktake_session (workspace_id, status, frozen_at);

CREATE UNIQUE INDEX IF NOT EXISTS stocktake_session_idempotency
ON stocktake_session (workspace_id, idempotency_key);

-- D01: one line per item x location frozen at open. book_qty is the on-hand read model captured at
-- frozen_at; counted_qty is what the human counted (NULL until counted). The diff is COMPUTED, never
-- stored (P5).
CREATE TABLE IF NOT EXISTS stocktake_line (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  session_id   TEXT NOT NULL REFERENCES stocktake_session(id),
  item_id      TEXT NOT NULL REFERENCES item(id),
  location_id  TEXT NOT NULL REFERENCES stock_location(id),
  book_qty     INTEGER NOT NULL,
  counted_qty  INTEGER,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stocktake_line_by_session
ON stocktake_line (workspace_id, session_id);
`;
