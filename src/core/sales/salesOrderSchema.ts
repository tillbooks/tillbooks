/**
 * D03's five tables (data model §4), kept in D03's own module and concatenated onto `SCHEMA_SQL` at
 * the store, the pattern A14/A19/A24/G00/C00/E00/B00/D01 established: the DDL a capability writes sits
 * beside the code that writes it, so concurrent capability branches never all edit one long string in
 * `store/schema.ts`.
 *
 * D03 OPENS NO POSTING PATH (§H-LEDGER, P3). A sales order and its delivery notes are OPERATIONAL
 * records: the only money that ever moves is the A11 draft invoice `sales_order_invoice` mints through
 * A10 `createDocument`, and the only stock that moves is a D01 `stock.move` issue. Neither table below
 * holds a `posted_entry_id`, a total, or any VAT amount, because those are A11's to own; a `so_line`
 * carries the frozen `tax_code` and the transaction-currency `unit_price_rappen`, nothing derived.
 *
 * NO CHECK CONSTRAINT on `status`: the `SO_STATUS`/`DN_STATUS` enums live at the single §H-ENUM source
 * (`salesOrderEnums.ts`), validated at the verb boundary through Pattern P7's transition table, so the
 * vocabulary and the legal transitions stay in exactly one place (§6b, the D01 precedent).
 *
 * §H-TENANT: every table carries `workspace_id`, and every query scopes by it. Quantities are integer
 * thousandths (`*_qty`, the A10 `quantity_milli` unit, so a quote line copies byte-for-byte); a
 * stock-tracked line's thousandths must be a whole multiple of 1000 because D01 counts integer units.
 * Money is integer Rappen (P2).
 *
 * THE DOUBLE-BILLING GUARD IS STRUCTURAL. `so_line_invoice` is one row per invoiced PORTION of a line
 * (two partial invoices leave two rows, never one overwritten FK), and its `UNIQUE(workspace_id,
 * so_line_id, invoice_line_id)` plus the write's `idempotency_key` make a replay a no-op. The engine
 * pre-checks `Σ qty` over a line's rows against `delivered_qty` BEFORE any write, so an over-invoice
 * writes ZERO rows; the sum can never exceed what was delivered.
 */

export const SALES_ORDER_SCHEMA_SQL = `
-- D03: a confirmed demand. number is a gap-free workspace sequence (AU-YYYY-NNNN); quote_id links an
-- accepted C02 quote this order was raised from (NULL for a from-scratch order). status is D03's own
-- SO_STATUS enum (draft -> confirmed -> partially_delivered -> delivered -> invoiced | cancelled),
-- NOT A10's document.status. fx_rate is the CHF/txn rate snapshotted at create for a foreign order
-- (H-FX). No total, no tax: A11 owns both.
CREATE TABLE IF NOT EXISTS sales_order (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  number        TEXT NOT NULL,
  contact_id    TEXT REFERENCES contact(id),
  quote_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  currency      TEXT NOT NULL,
  fx_rate       TEXT,
  order_date    TEXT NOT NULL,
  expected_on   TEXT,
  notes         TEXT,
  actor         TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sales_order_by_workspace
ON sales_order (workspace_id, status, order_date);

-- One order per converted quote (idempotent from_quote): a second conversion returns the first order.
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_by_quote
ON sales_order (workspace_id, quote_id)
WHERE quote_id IS NOT NULL;

-- D03: an ordered line. qty/unit_price_rappen are the AUTHORITATIVE line data (A11 recomputes totals
-- and VAT at issue). unit_price_base_rappen + fx_rate are the CHF snapshot for a foreign order (H-FX).
-- tax_code is the frozen A05 resolution (H-VAT-TRACE, resolved once at create). delivered_qty rises
-- through delivery-note issues (and at confirm for a non-stock service line); backorder_qty is the
-- confirm-time snapshot; invoiced_qty is the derived cache of Sum(so_line_invoice.qty). All thousandths.
CREATE TABLE IF NOT EXISTS so_line (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  sales_order_id         TEXT NOT NULL REFERENCES sales_order(id),
  item_id                TEXT REFERENCES item(id),
  description            TEXT,
  qty                    INTEGER NOT NULL,
  unit_price_rappen      INTEGER NOT NULL,
  unit_price_base_rappen INTEGER,
  fx_rate                TEXT,
  tax_code               TEXT,
  delivered_qty          INTEGER NOT NULL DEFAULT 0,
  backorder_qty          INTEGER NOT NULL DEFAULT 0,
  invoiced_qty           INTEGER NOT NULL DEFAULT 0,
  sort                   INTEGER NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS so_line_by_order
ON so_line (workspace_id, sales_order_id, sort);

-- D03: a delivery note (Lieferschein). number is a gap-free workspace sequence (LS-YYYY-NNNN); status
-- is D03's DN_STATUS enum (draft -> issued | cancelled(draft-only)). location_id is the D01 location
-- goods leave from. artifact_document_id links the rendered PDF filed in E00 (OR 958f retention rides
-- E00). issued_at is stamped when the note is issued (stock leaves the shelf).
CREATE TABLE IF NOT EXISTS delivery_note (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  sales_order_id       TEXT NOT NULL REFERENCES sales_order(id),
  number               TEXT NOT NULL,
  location_id          TEXT REFERENCES stock_location(id),
  status               TEXT NOT NULL DEFAULT 'draft',
  issued_at            TEXT,
  artifact_document_id TEXT,
  actor                TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS delivery_note_by_order
ON delivery_note (workspace_id, sales_order_id, status);

-- D03: a delivery-note line (stock-tracked so_lines only; a service line is auto-delivered at confirm
-- and never carries one). qty is thousandths; stock_movement_id is the ONE D01 issue movement this
-- line minted through stock.move (OP2, NULL until issued). The engine never writes stock_movement.
CREATE TABLE IF NOT EXISTS dn_line (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  delivery_note_id  TEXT NOT NULL REFERENCES delivery_note(id),
  so_line_id        TEXT NOT NULL REFERENCES so_line(id),
  qty               INTEGER NOT NULL,
  stock_movement_id TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dn_line_by_note
ON dn_line (workspace_id, delivery_note_id);

-- D03: THE DOUBLE-BILLING GUARD. One row per invoiced portion of a line: invoice_id is the A10
-- document, invoice_line_id its document_line, qty the thousandths this row billed. UNIQUE
-- (workspace, so_line_id, invoice_line_id) plus the write idempotency_key make a replay a no-op; the
-- engine pre-checks Sum(qty) <= delivered_qty BEFORE any write, so an over-invoice writes zero rows.
CREATE TABLE IF NOT EXISTS so_line_invoice (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  so_line_id       TEXT NOT NULL REFERENCES so_line(id),
  invoice_id       TEXT NOT NULL,
  invoice_line_id  TEXT NOT NULL,
  qty              INTEGER NOT NULL,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS so_line_invoice_by_line
ON so_line_invoice (workspace_id, so_line_id);

CREATE UNIQUE INDEX IF NOT EXISTS so_line_invoice_unique
ON so_line_invoice (workspace_id, so_line_id, invoice_line_id);

-- D03: gap-free per-(workspace, kind, year) number sequences for orders and delivery notes, the A10
-- document_number_seq shape. next_value is spent only on a committed create.
CREATE TABLE IF NOT EXISTS d03_number_seq (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind         TEXT NOT NULL,
  year         TEXT NOT NULL,
  next_value   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, kind, year)
);
`;
