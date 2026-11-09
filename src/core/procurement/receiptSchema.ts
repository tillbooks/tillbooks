/**
 * I02, the GOODS RECEIPT document tables (Wave 14, cluster I, MONEY PATH by way of J02).
 *
 * The DDL sits in its own module and is joined into the applied schema by `core/store/schema.ts`
 * (the A14/A19/B00/H00/I00 module-owned pattern), so concurrent capability branches never edit one
 * giant string. Columns are snake_case; the engine and MCP/REST interfaces are camelCase and map at
 * the `receipt.ts` boundary only. Money is INTEGER Rappen and quantity is a whole-unit INTEGER, the
 * D02 `po_line` / J02 `stock_movement` convention (NOT I00's milli-units). Every row carries
 * `workspace_id` (§H-TENANT).
 *
 * WHY THESE TABLES ARE NAMED `goods_receipt_doc*` AND NOT `goods_receipt*`. D02 has owned
 * `goods_receipt` + `goods_receipt_line` since it shipped (`purchase/purchaseOrderSchema.ts`), and
 * those two tables are read by three live consumers: `purchase/purchaseOrders.ts` lists a PO's
 * receipts off the header, `costing/costing.ts` (B03) re-derives a project's DATED received quantity
 * as `SUM(goods_receipt_line.qty)` joined through `goods_receipt.received_at`, and D02's own
 * `receipt_record` writes them. I02 therefore does not seize the name. It adds the document layer
 * above and keeps the D02 pair as the SHARED RECEIVED-QUANTITY TRAIL that both writers append to:
 *
 *   - every quantity I02 RECOGNISES (post, or a later accept of a held line) appends a trail row,
 *   - every quantity I02 REVERSES appends a NEGATIVE trail row,
 *   - nothing in the trail is ever UPDATEd or DELETEd.
 *
 * which keeps `SUM(goods_receipt_line.qty for a po_line) == po_line.received_qty` literally true no
 * matter which writer produced the row, and keeps B03's `asOf` figure correct with no edit to a file
 * I02 does not own. That equality is asserted in `test/procurement/receipt.test.mjs`.
 *
 * NOTHING HERE POSTS TO THE GENERAL LEDGER (spec §1). Inventory valuation flows J03 -> J06 -> A02
 * and input tax arises on the A17 vendor bill, never on the physical receipt. What I02 does touch is
 * the J02 movement ledger, which is why it is a money-path capability: a wrong receipt is a wrong
 * Bestandesnachweis (OR 958c) and a wrong valuation base.
 */

export const RECEIPT_SCHEMA_SQL = `
-- I02: the goods-receipt document header. status is I02's own §H-ENUM (receiptEnums.ts), validated
-- at the verb boundary rather than by a CHECK constraint (the D02/J02 convention). received_at is
-- THE date: every J02 movement this document ever writes is stamped with it, and every mutating verb
-- asserts that period is open, so there is no date parameter anywhere downstream to shift.
CREATE TABLE IF NOT EXISTS goods_receipt_doc (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  number              TEXT NOT NULL,
  -- draft | posted | reversed | cancelled
  status              TEXT NOT NULL,
  po_id               TEXT NOT NULL REFERENCES purchase_order(id),
  supplier_contact_id TEXT NOT NULL REFERENCES contact(id),
  received_at         TEXT NOT NULL,
  expected_at         TEXT,
  default_location_id TEXT REFERENCES stock_location(id),
  note                TEXT,
  created_at          TEXT NOT NULL,
  created_by          TEXT,
  updated_at          TEXT NOT NULL,
  posted_at           TEXT,
  posted_by           TEXT,
  -- WHO reversed this receipt and WHEN. There is deliberately NO link to a second document: an I02
  -- reversal is IN PLACE on the original (status -> reversed, plus the compensating movements and the
  -- negative trail rows), not a reversing twin, so a reverse_of_id / reversed_by_doc_id pair would be
  -- permanently NULL on every row and would advertise a navigation that does not exist. What makes
  -- the reversal reconstructable is the per-line reversal_movement_id / reversal_trail_line_id pair
  -- below, plus the append-only reversed event, and none of those is ever rewritten (§H-AUDIT).
  reversed_at         TEXT,
  reversed_by         TEXT,
  idempotency_key     TEXT,
  -- The queryable exception flag (owner decision, 11.08.2026). An over-receipt is ACCEPTED and
  -- RECORDED rather than refused, so the discrepancy has to be findable without reading every line:
  -- goods_receipt_list filters on this column and the Studio badges it. Set at recognition time and
  -- never cleared, because it records what happened, not what is currently true.
  has_over_receipt    INTEGER NOT NULL DEFAULT 0,
  cancelled_at        TEXT,
  cancel_reason       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_doc_number ON goods_receipt_doc (workspace_id, number);
CREATE INDEX IF NOT EXISTS goods_receipt_doc_by_po ON goods_receipt_doc (workspace_id, po_id, received_at);
CREATE INDEX IF NOT EXISTS goods_receipt_doc_by_status ON goods_receipt_doc (workspace_id, status, received_at);

-- I02: one receipt line. qty is the WHOLE-UNIT quantity this line receives (> 0, never a milli
-- figure). unit_cost_rappen is the CHF BASE cost snapshot taken from the PO line at line entry
-- (§H-FX), which is what J03 later values the layer at; a later I03 landed cost writes ADDITIONAL
-- cost movements and never mutates this snapshot. movement_id / trail_line_id are populated the
-- moment the quantity is RECOGNISED (post, or a later accept); the reversal_* pair the moment it is
-- reversed. billed_qty is maintained solely by I04 and is 0 here.
CREATE TABLE IF NOT EXISTS goods_receipt_doc_line (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspace(id),
  gr_id                   TEXT NOT NULL REFERENCES goods_receipt_doc(id),
  po_id                   TEXT NOT NULL REFERENCES purchase_order(id),
  po_line_id              TEXT NOT NULL REFERENCES po_line(id),
  item_id                 TEXT REFERENCES item(id),
  description             TEXT,
  line_no                 INTEGER NOT NULL,
  qty                     INTEGER NOT NULL,
  unit_cost_rappen        INTEGER NOT NULL,
  location_id             TEXT REFERENCES stock_location(id),
  lot_id                  TEXT REFERENCES lot(id),
  serial_id               TEXT REFERENCES serial(id),
  -- none | pending | accepted | rejected. 'none' and 'accepted' are RECOGNISED at post; 'pending' is
  -- held (no movement, no PO quantity) until goods_receipt_accept_lines decides it.
  inspection_status       TEXT NOT NULL DEFAULT 'none',
  movement_id             TEXT REFERENCES stock_movement(id),
  trail_line_id           TEXT REFERENCES goods_receipt_line(id),
  reversal_movement_id    TEXT REFERENCES stock_movement(id),
  reversal_trail_line_id  TEXT REFERENCES goods_receipt_line(id),
  billed_qty              INTEGER NOT NULL DEFAULT 0,
  -- How much of this line's quantity exceeded the order's OPEN quantity at the moment it was
  -- recognised, or 0. The over-delivered quantity itself, not a boolean, because "we took 3 more
  -- than we ordered" is the fact a buyer has to act on and it cannot be re-derived later (the open
  -- quantity has moved on by then).
  over_receipt_qty        INTEGER NOT NULL DEFAULT 0,
  note                    TEXT,
  recognised_at           TEXT,
  rejected_at             TEXT,
  reject_reason           TEXT
);

CREATE INDEX IF NOT EXISTS goods_receipt_doc_line_by_doc ON goods_receipt_doc_line (workspace_id, gr_id, line_no);
CREATE INDEX IF NOT EXISTS goods_receipt_doc_line_by_po_line ON goods_receipt_doc_line (workspace_id, po_line_id);

-- I02: the APPEND-ONLY decision trail (§H-AUDIT). A create, a line edit, a post, an acceptance, a
-- rejection, a reversal and a cancellation are each a NEW row; nothing here is ever updated or
-- deleted, so who decided what, and when, is reconstructable for the full OR 958f retention window.
CREATE TABLE IF NOT EXISTS goods_receipt_doc_event (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  gr_id        TEXT NOT NULL REFERENCES goods_receipt_doc(id),
  line_id      TEXT,
  -- created | line_changed | posted | accepted | rejected | reversed | cancelled | over_receipt
  event_type   TEXT NOT NULL,
  reason       TEXT,
  actor        TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS goods_receipt_doc_event_by_doc ON goods_receipt_doc_event (workspace_id, gr_id, created_at);

-- I02: the per-workspace over-receipt posture (spec §4), the J02 inventory_config precedent. An
-- absent row means the default: accept an over-delivery and flag it, with no percentage cap.
CREATE TABLE IF NOT EXISTS goods_receipt_config (
  workspace_id       TEXT PRIMARY KEY REFERENCES workspace(id),
  -- Default 1: an over-delivery is ACCEPTED and flagged (owner decision, 11.08.2026). Blocking it
  -- at the loading dock hides a discrepancy that has already physically happened; the goods are in
  -- the warehouse either way, and a ledger that refuses to say so is the worse of the two. Set to 0
  -- by a workspace that genuinely wants a hard ceiling at the ordered quantity.
  allow_over_receipt INTEGER NOT NULL DEFAULT 1,
  -- NULL means NO CAP, which is the default. When set (and allow_over_receipt is 1) it is an integer
  -- percentage of the ORDERED quantity above which the receipt is refused instead of flagged.
  over_receipt_pct   INTEGER,
  updated_at         TEXT NOT NULL,
  updated_by         TEXT
);
`;
