/**
 * D02's seven tables (spec §4 data model), kept in D02's OWN schema file and DISJOINT from A17's
 * `schema.ts` (which owns `vendor_bill` alone): the pattern every capability follows, so concurrent
 * branches never all edit one long string, and A17's file is not touched by D02 at all.
 *
 * D02 IS OFF THE MONEY PATH BY CONSTRUCTION (spec §1/§7, Pattern P3). Nothing here stores a
 * `posted_entry_id`: the only ledger-touching event in the whole PO -> receipt -> bill -> match chain
 * is A17's bill posting via A02, and D02 merely LINKS to the A17 bill id (`po_match.bill_id`) and to
 * the D01 movement id a receipt minted (`goods_receipt_line.stock_movement_id`). Money is integer
 * Rappen throughout (P2); a foreign-currency PO stores txn + CHF base + rate (§H-FX). §H-TENANT:
 * every table carries `workspace_id`, and every query scopes by it.
 *
 * NO CHECK CONSTRAINT on `status`: the vocabulary lives at the single §H-ENUM source (`poEnums.ts`),
 * validated at the verb boundary, so `PO_STATUS`/`MATCH_STATUS` stay in exactly one place (spec §7).
 * `po_revision` and `po_match` are APPEND-ONLY audit tables (§H-AUDIT): a superseded PO version is
 * snapshotted, never overwritten, and a blocked variance persists as a visible `po_match` exception
 * rather than vanishing on retry. `supplier_item_price` is append-only history keyed by `valid_from`,
 * mirroring D00's price-list discipline row for row.
 */

export const PURCHASE_ORDER_SCHEMA_SQL = `
-- D02: the purchase order header. status is D02's OWN PO_STATUS enum (poEnums.ts), NOT an A10
-- document kind: a PO is its own document reusing Pattern P7's transition discipline on this column.
-- revision starts at 1 and only increments (US-D02.6). total_rappen is the txn-currency order total;
-- total_base_rappen is the CHF conversion at creation (H-FX); fx_rate is the stored rate (NULL for a
-- base-currency PO). expected_on is the derived lead-time date; sent_artifact_ref is the P8 PDF.
CREATE TABLE IF NOT EXISTS purchase_order (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  number              TEXT NOT NULL,
  supplier_contact_id TEXT NOT NULL REFERENCES contact(id),
  status              TEXT NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 1,
  currency            TEXT NOT NULL DEFAULT 'CHF',
  total_rappen        INTEGER NOT NULL DEFAULT 0,
  total_base_rappen   INTEGER NOT NULL DEFAULT 0,
  fx_rate             TEXT,
  expected_on         TEXT,
  sent_artifact_ref   TEXT,
  note                TEXT,
  -- I01 provenance (spec §0 reconciliation): the source document a PO was minted from, for real
  -- bidirectional drill-back (an I00 requisition -> PO link no longer rides only the note). Both NULL
  -- for a directly-created PO. Also in ADDITIVE_COLUMNS (store/schema.ts) so a pre-I01 file widens on
  -- open, and the two paths stay identical. Off the money path: I01 posts nothing (P3).
  source_document_type TEXT,
  source_document_id   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS purchase_order_by_workspace ON purchase_order (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS purchase_order_by_supplier ON purchase_order (workspace_id, supplier_contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_number ON purchase_order (workspace_id, number);

-- D02: a PO line. qty is a positive integer in the item's own unit (D01's convention). unit_price_rappen
-- is the NET purchase price per unit in the PO currency; unit_price_base_rappen is its CHF conversion
-- (H-FX). tax_code is the RESOLVED expected code (H-VAT-TRACE): D02 carries the expected code only and
-- never touches the VAT ledger (that is A17->A06). received_qty and billed_qty belong to receipts and
-- matches, never to the edit: a revise leaves them untouched (US-D02.6). Both start at 0 and only rise.
CREATE TABLE IF NOT EXISTS po_line (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  po_id                  TEXT NOT NULL REFERENCES purchase_order(id),
  item_id                TEXT REFERENCES item(id),
  description            TEXT,
  qty                    INTEGER NOT NULL,
  unit_price_rappen      INTEGER NOT NULL,
  unit_price_base_rappen INTEGER NOT NULL,
  tax_code               TEXT,
  received_qty           INTEGER NOT NULL DEFAULT 0,
  billed_qty             INTEGER NOT NULL DEFAULT 0,
  -- B03 (the project cost dimension): which B00 project this ordered line is for, or NULL. A
  -- REPORTING dimension only (D02 stays off the money path): B03's accrued_purchases and committed
  -- components read it. Also in ADDITIVE_COLUMNS for pre-existing files.
  project_id             TEXT REFERENCES project(id),
  sort                   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS po_line_by_po ON po_line (workspace_id, po_id, sort);

-- D02: a goods-receipt header. location_id is the D01 location goods land in. One PO may have many
-- receipts (partial deliveries). idempotency_key is stored so an agent retry (H-IDEMPOTENT) is
-- resolvable at the row layer as well as through the idempotency table.
CREATE TABLE IF NOT EXISTS goods_receipt (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id),
  po_id           TEXT NOT NULL REFERENCES purchase_order(id),
  location_id     TEXT NOT NULL REFERENCES stock_location(id),
  received_at     TEXT NOT NULL,
  note            TEXT,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS goods_receipt_by_po ON goods_receipt (workspace_id, po_id, received_at);

-- D02: one goods-receipt line. stock_movement_id is the D01 movement THIS receipt line minted (OP2,
-- 1:1 traceability): D02 never writes stock_movement itself, so there is exactly one stock path. NULL
-- only for a non-stock-tracked item line (nothing to mint), which the receipt still records for the trail.
CREATE TABLE IF NOT EXISTS goods_receipt_line (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  receipt_id        TEXT NOT NULL REFERENCES goods_receipt(id),
  po_line_id        TEXT NOT NULL REFERENCES po_line(id),
  qty               INTEGER NOT NULL,
  stock_movement_id TEXT REFERENCES stock_movement(id)
);

CREATE INDEX IF NOT EXISTS goods_receipt_line_by_receipt ON goods_receipt_line (workspace_id, receipt_id);
CREATE INDEX IF NOT EXISTS goods_receipt_line_by_po_line ON goods_receipt_line (workspace_id, po_line_id);

-- D02: an APPEND-ONLY 3-way-match record (§H-AUDIT). status is MATCH_STATUS (matched|variance|overridden).
-- expected_base_rappen is the CHF value of the received-not-yet-billed goods at PO price; bill_base_rappen
-- is the A17 bill's base net; price_variance_rappen is (bill - expected). A blocked variance persists as a
-- row so the exception is visible, never lost. overridden_by is the actor who forced a variance match
-- (needs the stronger capability). A17 bill_id is a LINK only: D02 posts nothing, the ledger link lives on
-- the A17 bill (its entry_id), which is the journal entry A17's own post produced.
CREATE TABLE IF NOT EXISTS po_match (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  po_id                  TEXT NOT NULL REFERENCES purchase_order(id),
  bill_id                TEXT NOT NULL REFERENCES vendor_bill(id),
  status                 TEXT NOT NULL,
  qty_variance           INTEGER NOT NULL DEFAULT 0,
  price_variance_rappen  INTEGER NOT NULL DEFAULT 0,
  expected_base_rappen   INTEGER NOT NULL DEFAULT 0,
  bill_base_rappen       INTEGER NOT NULL DEFAULT 0,
  overridden_by          TEXT,
  matched_at             TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS po_match_by_po ON po_match (workspace_id, po_id, matched_at);
CREATE INDEX IF NOT EXISTS po_match_by_bill ON po_match (workspace_id, bill_id);

-- D02: an APPEND-ONLY snapshot of a superseded PO version (§H-AUDIT, US-D02.6). snapshot_json is the
-- frozen header + line state (incl. its sent_artifact_ref) at the moment of a revise. A revision is
-- DATA (revision + this row), never a status fork: a second revise never mutates the first snapshot.
CREATE TABLE IF NOT EXISTS po_revision (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  po_id         TEXT NOT NULL REFERENCES purchase_order(id),
  revision      INTEGER NOT NULL,
  revised_by    TEXT,
  revised_at    TEXT NOT NULL,
  reason        TEXT,
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS po_revision_by_po ON po_revision (workspace_id, po_id, revision);

-- D02: per-supplier item price, APPEND-ONLY history keyed by valid_from (mirrors D00 price_list_items).
-- price_rappen is the NET purchase price in the row's currency; a foreign-currency row converts once at
-- PO creation (H-FX). lead_time_days (>= 0) drives the PO's expected_on. Resolution does NO arithmetic:
-- it selects the latest valid_from <= at (P2 trivially holds).
CREATE TABLE IF NOT EXISTS supplier_item_price (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  supplier_contact_id TEXT NOT NULL REFERENCES contact(id),
  item_id             TEXT NOT NULL REFERENCES item(id),
  supplier_sku        TEXT,
  price_rappen        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'CHF',
  valid_from          TEXT NOT NULL,
  lead_time_days      INTEGER,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS supplier_item_price_lookup
ON supplier_item_price (workspace_id, supplier_contact_id, item_id, valid_from);
`;
