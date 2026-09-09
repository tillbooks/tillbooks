// D03, sales orders & delivery notes: the money-path discipline, asserted rather than documented.
//
// D03 creates A11 invoices, carries invoiced-quantity figures, and issues D01 stock, so these tests
// prove the laws a money-path critic checks actually BITE:
//   1. NO DOUBLE-BILLING: invoicing a line twice yields exactly ONE A11 invoice for the qty; the
//      second call is refused (nothing_to_invoice), and Sum(so_line_invoice.qty) <= delivered_qty.
//   2. IDEMPOTENT ISSUE: a retried delivery issue double-issues no stock and re-creates no invoice.
//   3. §H-TENANT: a cross-tenant id can neither read, mutate, deliver nor invoice another book's order.
//   4. STOCK INTEGRITY: issuing decrements stock through D01 stock.move exactly once; D03 posts NOTHING.
//   5. TX-ATOMICITY: a REFUSED invoice/delivery leaves the row count UNCHANGED (the C02 bug guard).
//   6. SERVICE AUTO-DELIVERY: a pure-service order reaches invoiced with ZERO stock movements.
//   7. BACKORDER + PARTIAL: backorder = max(0, ordered - on_hand); a partial->full sequence sums right.
//   8. THE BELEG: delivery_note_render is idempotent, one E00 doc, retention-locked, and carries NO VAT.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import {
  createItem,
  createContact,
  createQuote,
  sendQuote,
  acceptQuote,
  getDocument,
  createSalesOrder,
  salesOrderFromQuote,
  confirmSalesOrder,
  cancelSalesOrder,
  salesOrderInvoice,
  listSalesOrders,
  getSalesOrder,
  listBackorders,
  createDeliveryNote,
  issueDeliveryNote,
  renderDeliveryNote,
} from '../../dist/core/sales/index.js';
import { upsertStockLocation, recordStockMove } from '../../dist/core/stock/index.js';
import { deleteFile, getFileContent } from '../../dist/core/files/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function ctxFor(store, deps, name) {
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock: fixedClock(AT), ids: deps.ids });
  const contact = createContact(ctx, { partyRole: 'customer', name: `${name} Kundin`, idempotencyKey: `${name}-c` });
  return { ctx, workspaceId, contactId: contact.contact.id };
}

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const a = ctxFor(store, deps, 'AcmeA');
  return { store, deps, ...a };
}

/** Seed a stock-tracked item with `units` on hand at one location. */
function seedStock(ctx, units, seed) {
  const item = createItem(ctx, { name: `Widget-${seed}`, defaultUnitPriceMinor: 5000, idempotencyKey: `${seed}-item` });
  ctx.store.db.prepare('UPDATE item SET track_stock = 1 WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, item.item.id);
  const loc = upsertStockLocation(ctx, { name: `Lager-${seed}`, idempotencyKey: `${seed}-loc` });
  if (units > 0) {
    const mv = recordStockMove(ctx, {
      itemId: item.item.id,
      locationId: loc.location.id,
      qty: units,
      reason: 'receipt',
      unitCostMinor: 2000,
      movedAt: '2026-03-01',
      idempotencyKey: `${seed}-recv`,
    });
    assert.equal(mv.ok, true, 'seed receipt');
  }
  return { itemId: item.item.id, locationId: loc.location.id };
}

const count = (ctx, sql, ...p) => ctx.store.db.prepare(sql).get(ctx.workspaceId, ...p).n;
const journalCount = (ctx) => count(ctx, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?');
const onHand = (ctx, itemId) =>
  ctx.store.db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM stock_movement WHERE workspace_id = ? AND item_id = ?').get(ctx.workspaceId, itemId).n;
const issueMovements = (ctx) =>
  count(ctx, "SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ? AND reason = 'issue'");
const invoiceDocs = (ctx) =>
  count(ctx, "SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'invoice'");

function deliverFully(ctx, orderId, locationId, seed) {
  const note = createDeliveryNote(ctx, { salesOrderId: orderId, locationId, idempotencyKey: `${seed}-dnc` });
  assert.equal(note.ok, true, `create note: ${JSON.stringify(note)}`);
  const issued = issueDeliveryNote(ctx, { deliveryNoteId: note.deliveryNote.id, idempotencyKey: `${seed}-dni` });
  assert.equal(issued.ok, true, `issue note: ${JSON.stringify(issued)}`);
  return note.deliveryNote.id;
}

// --- 1. NO DOUBLE-BILLING ----------------------------------------------------------------------

test('D03: invoicing a delivered line twice yields ONE invoice; the second is refused', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'db');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'db-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'db-c' });
  deliverFully(ctx, order.salesOrder.id, s.locationId, 'db');

  const first = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'db-i1' });
  assert.equal(first.ok, true, `first invoice: ${JSON.stringify(first)}`);
  assert.equal(invoiceDocs(ctx), 1, 'exactly one A11 invoice');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM so_line_invoice WHERE workspace_id = ?'), 1, 'one link row');

  const second = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'db-i2' });
  assert.equal(second.ok, false, 'the second invoice is refused');
  assert.equal(second.error, 'nothing_to_invoice');
  assert.equal(invoiceDocs(ctx), 1, 'still exactly one invoice: no double-bill');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM so_line_invoice WHERE workspace_id = ?'), 1, 'still one link row');

  // Sum of link rows can never exceed delivered_qty.
  const line = ctx.store.db.prepare('SELECT delivered_qty, invoiced_qty FROM so_line WHERE workspace_id = ? AND sales_order_id = ?').get(ctx.workspaceId, order.salesOrder.id);
  assert.equal(line.invoiced_qty, line.delivered_qty, 'invoiced never exceeds delivered');
  assert.equal(journalCount(ctx), 0, 'D03 posted nothing: the draft invoice has no journal entry');
});

test('D03: a second invoice replays its idempotency key without minting a second invoice', () => {
  const { ctx, contactId } = setup();
  const order = createSalesOrder(ctx, { contactId, lines: [{ description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 15000 }], idempotencyKey: 'rp-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'rp-c' });
  const a = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'rp-i' });
  const b = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'rp-i' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'a replay of the same key succeeds');
  assert.equal(a.invoiceId, b.invoiceId, 'the replay returns the ORIGINAL invoice id');
  assert.equal(invoiceDocs(ctx), 1, 'one invoice from a double call');
});

// --- 2. IDEMPOTENT ISSUE + STOCK INTEGRITY -----------------------------------------------------

test('D03: issuing a delivery decrements stock exactly once, and a retry double-issues nothing', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'is');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'is-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'is-c' });
  const note = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, idempotencyKey: 'is-dnc' });

  const first = issueDeliveryNote(ctx, { deliveryNoteId: note.deliveryNote.id, idempotencyKey: 'is-k' });
  assert.equal(first.ok, true);
  assert.equal(onHand(ctx, s.itemId), 7, '10 received minus 3 issued');
  assert.equal(issueMovements(ctx), 1, 'exactly one issue movement');

  const retry = issueDeliveryNote(ctx, { deliveryNoteId: note.deliveryNote.id, idempotencyKey: 'is-k' });
  assert.equal(retry.ok, true, 'a replay of the same key succeeds');
  assert.equal(onHand(ctx, s.itemId), 7, 'a retry did NOT double-issue');
  assert.equal(issueMovements(ctx), 1, 'still exactly one issue movement');

  // Re-issuing an already-issued note under a DIFFERENT key is refused, and moves no stock.
  const again = issueDeliveryNote(ctx, { deliveryNoteId: note.deliveryNote.id, idempotencyKey: 'is-k2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'invalid_transition');
  assert.equal(issueMovements(ctx), 1, 'the refused re-issue moved no stock');
});

// --- 3. §H-TENANT ------------------------------------------------------------------------------

test('D03: a cross-tenant id can neither read, mutate, deliver nor invoice another book`s order', () => {
  const { store, deps, ctx, contactId } = setup();
  const b = ctxFor(store, deps, 'AcmeB');
  const s = seedStock(ctx, 10, 'ht');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'ht-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'ht-c' });
  const noteId = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, idempotencyKey: 'ht-dnc' }).deliveryNote.id;

  assert.equal(getSalesOrder(b.ctx, { salesOrderId: order.salesOrder.id }).error, 'not_found', 'B cannot read A`s order');
  assert.equal(confirmSalesOrder(b.ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'ht-bc' }).error, 'not_found', 'B cannot confirm A`s order');
  assert.equal(cancelSalesOrder(b.ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'ht-bx' }).error, 'not_found', 'B cannot cancel A`s order');
  assert.equal(salesOrderInvoice(b.ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'ht-bi' }).error, 'not_found', 'B cannot invoice A`s order');
  assert.equal(issueDeliveryNote(b.ctx, { deliveryNoteId: noteId, idempotencyKey: 'ht-bd' }).error, 'not_found', 'B cannot issue A`s note');
  assert.deepEqual(listSalesOrders(b.ctx, {}).salesOrders, [], 'A`s order never appears on B`s list');
});

// --- 4/5. TX-ATOMICITY: a refused write leaves the row count UNCHANGED --------------------------

test('D03: an over-delivery is refused and writes ZERO delivery-note rows', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'od');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'od-o' });
  const soLineId = getSalesOrder(ctx, { salesOrderId: order.salesOrder.id }).lines[0].id;
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'od-c' });

  const over = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, lines: [{ soLineId, qty: 5000 }], idempotencyKey: 'od-dnc' });
  assert.equal(over.ok, false);
  assert.equal(over.error, 'over_delivery');
  assert.equal(over.outstanding, 3000, 'the refusal names the outstanding qty');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM delivery_note WHERE workspace_id = ?'), 0, 'a refused create wrote zero notes');
});

test('D03: an insufficient-stock issue is refused, leaving the note draft and moving no stock', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 2, 'in'); // only 2 on hand
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'in-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'in-c' });
  const note = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, idempotencyKey: 'in-dnc' });

  const issued = issueDeliveryNote(ctx, { deliveryNoteId: note.deliveryNote.id, idempotencyKey: 'in-dni' });
  assert.equal(issued.ok, false);
  assert.equal(issued.error, 'insufficient_stock');
  assert.equal(issueMovements(ctx), 0, 'a refused issue moved no stock');
  const noteRow = ctx.store.db.prepare('SELECT status FROM delivery_note WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, note.deliveryNote.id);
  assert.equal(noteRow.status, 'draft', 'the note is still a draft after the refusal');
  const line = ctx.store.db.prepare('SELECT delivered_qty FROM so_line WHERE workspace_id = ? AND sales_order_id = ?').get(ctx.workspaceId, order.salesOrder.id);
  assert.equal(line.delivered_qty, 0, 'nothing was delivered');
});

test('D03: invoicing an order with nothing delivered is refused and writes no invoice', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'nti');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'nti-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'nti-c' });
  const res = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'nti-i' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'nothing_to_invoice');
  assert.equal(invoiceDocs(ctx), 0, 'a refused invoice wrote no document');
});

// --- 6. SERVICE AUTO-DELIVERY, ZERO MOVEMENTS --------------------------------------------------

test('D03: a pure-service order reaches invoiced with ZERO stock movements, and posts nothing', () => {
  const { ctx, contactId } = setup();
  const order = createSalesOrder(ctx, { contactId, lines: [{ description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 15000 }], idempotencyKey: 'sv-o' });
  const confirmed = confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'sv-c' });
  assert.equal(confirmed.salesOrder.status, 'delivered', 'a pure-service order is delivered on confirm');
  const inv = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'sv-i' });
  assert.equal(inv.ok, true);
  assert.equal(getSalesOrder(ctx, { salesOrderId: order.salesOrder.id }).salesOrder.status, 'invoiced');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?'), 0, 'no stock ever moved');
  assert.equal(journalCount(ctx), 0, 'D03 posted nothing');

  // The figures handed to A11 match, in integer Rappen.
  const invoice = getDocument(ctx, { documentId: inv.invoiceId });
  assert.equal(invoice.lines[0].unitPriceMinor, 15000, 'unit price flows through unchanged');
  assert.equal(invoice.lines[0].quantityMilli, 2000, 'quantity flows through unchanged');
  assert.equal(invoice.document.status, 'draft', 'the A11 invoice lands as a DRAFT');
});

// --- 7. BACKORDER + PARTIAL SEQUENCE -----------------------------------------------------------

test('D03: backorder = max(0, ordered - on_hand), with the on_hand == ordered boundary at zero', () => {
  const { ctx, contactId } = setup();
  const exact = seedStock(ctx, 3, 'bo1');
  const o1 = createSalesOrder(ctx, { contactId, lines: [{ itemId: exact.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'bo1-o' });
  confirmSalesOrder(ctx, { salesOrderId: o1.salesOrder.id, idempotencyKey: 'bo1-c' });
  assert.equal(getSalesOrder(ctx, { salesOrderId: o1.salesOrder.id }).lines[0].backorderQty, 0, 'on_hand == ordered yields no backorder');

  const short = seedStock(ctx, 2, 'bo2');
  const o2 = createSalesOrder(ctx, { contactId, lines: [{ itemId: short.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'bo2-o' });
  confirmSalesOrder(ctx, { salesOrderId: o2.salesOrder.id, idempotencyKey: 'bo2-c' });
  assert.equal(getSalesOrder(ctx, { salesOrderId: o2.salesOrder.id }).lines[0].backorderQty, 1000, 'ordered 3, on_hand 2 -> backorder 1');
  const bl = listBackorders(ctx, {});
  assert.ok(bl.backorders.some((b) => b.salesOrderId === o2.salesOrder.id), 'the short order shows in the backorder list');
});

test('D03: a partial then a second delivery sum to the ordered qty, one movement per dn_line', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'pt');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 5000, unitPriceMinor: 5000 }], idempotencyKey: 'pt-o' });
  const soLineId = getSalesOrder(ctx, { salesOrderId: order.salesOrder.id }).lines[0].id;
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'pt-c' });

  const n1 = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, lines: [{ soLineId, qty: 2000 }], idempotencyKey: 'pt-n1' });
  issueDeliveryNote(ctx, { deliveryNoteId: n1.deliveryNote.id, idempotencyKey: 'pt-i1' });
  assert.equal(getSalesOrder(ctx, { salesOrderId: order.salesOrder.id }).salesOrder.status, 'partially_delivered');

  const n2 = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, idempotencyKey: 'pt-n2' });
  issueDeliveryNote(ctx, { deliveryNoteId: n2.deliveryNote.id, idempotencyKey: 'pt-i2' });

  const view = getSalesOrder(ctx, { salesOrderId: order.salesOrder.id });
  assert.equal(view.salesOrder.status, 'delivered');
  assert.equal(view.lines[0].deliveredQty, 5000, 'delivered_qty == ordered qty');
  const sumDn = ctx.store.db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM dn_line WHERE workspace_id = ?').get(ctx.workspaceId).n;
  assert.equal(sumDn, 5000, 'Sum(dn_line.qty) == delivered_qty == ordered');
  assert.equal(issueMovements(ctx), 2, 'exactly one issue movement per dn_line');
  assert.equal(onHand(ctx, s.itemId), 5, '10 received minus 5 issued');
});

// --- 8. THE BELEG: render idempotent, retention-locked, no VAT ----------------------------------

test('D03: delivery_note_render is idempotent (one E00 Beleg), retention-locked, and carries NO VAT', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'rd');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'rd-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'rd-c' });
  const noteId = deliverFully(ctx, order.salesOrder.id, s.locationId, 'rd');

  // A draft note has no Beleg.
  const s2 = seedStock(ctx, 5, 'rd2');
  const o2 = createSalesOrder(ctx, { contactId, lines: [{ itemId: s2.itemId, quantityMilli: 1000, unitPriceMinor: 5000 }], idempotencyKey: 'rd2-o' });
  confirmSalesOrder(ctx, { salesOrderId: o2.salesOrder.id, idempotencyKey: 'rd2-c' });
  const draftNote = createDeliveryNote(ctx, { salesOrderId: o2.salesOrder.id, locationId: s2.locationId, idempotencyKey: 'rd2-dnc' });
  const draftRender = renderDeliveryNote(ctx, { deliveryNoteId: draftNote.deliveryNote.id, idempotencyKey: 'rd2-r' });
  assert.equal(draftRender.ok, false);
  assert.equal(draftRender.error, 'not_issued', 'only an issued note is a Beleg worth printing');

  const r1 = renderDeliveryNote(ctx, { deliveryNoteId: noteId, idempotencyKey: 'rd-r1' });
  assert.equal(r1.ok, true, `render: ${JSON.stringify(r1)}`);
  const r2 = renderDeliveryNote(ctx, { deliveryNoteId: noteId, idempotencyKey: 'rd-r2' });
  assert.equal(r2.artifactDocumentId, r1.artifactDocumentId, 'a re-render returns the SAME E00 document');
  assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND entity_kind = 'delivery_note'"), 1, 'exactly one Beleg per note');

  // The Beleg carries NO VAT statement (spec §3): MWST arises only on the invoice.
  const content = getFileContent(ctx, { fileId: r1.artifactDocumentId });
  const pdf = Buffer.from(content.contentBase64, 'base64').toString('latin1');
  assert.ok(!/MWST|Mehrwertsteuer|\bVAT\b|Steuer/i.test(pdf), 'the Lieferschein PDF states no VAT');

  // OR 958f retention lock: a delete before expiry is refused.
  const del = deleteFile(ctx, { fileId: r1.artifactDocumentId, confirmed: true });
  assert.equal(del.ok, false, 'the Beleg cannot be deleted before its retention runs out');
  assert.equal(del.error, 'retention_locked');
});

// --- from_quote + cancel guards ----------------------------------------------------------------

test('D03: from_quote copies the accepted quote`s frozen lines, and a double-convert yields ONE order', () => {
  const { ctx, contactId } = setup();
  const quote = createQuote(ctx, { contactId, validUntil: '2027-01-31', lines: [{ description: 'Leistung', quantityMilli: 2000, unitPriceMinor: 20000 }], idempotencyKey: 'fq-q' });
  sendQuote(ctx, { quoteId: quote.document.id, idempotencyKey: 'fq-s' });
  acceptQuote(ctx, { quoteId: quote.document.id, actor: 'Kundin', idempotencyKey: 'fq-a' });

  const o1 = salesOrderFromQuote(ctx, { quoteId: quote.document.id, idempotencyKey: 'fq-1' });
  assert.equal(o1.ok, true, `from_quote: ${JSON.stringify(o1)}`);
  assert.equal(o1.lines[0].unitPriceMinor, 20000, 'price copied byte-for-byte');
  assert.equal(o1.lines[0].qty, 2000, 'qty copied');

  const o2 = salesOrderFromQuote(ctx, { quoteId: quote.document.id, idempotencyKey: 'fq-2' });
  assert.equal(o2.salesOrder.id, o1.salesOrder.id, 'a second conversion returns the FIRST order');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM sales_order WHERE workspace_id = ? AND quote_id = ?', quote.document.id), 1, 'exactly one order per quote');
});

// --- whole-unit stock lines: no undeliverable sub-1000 remainder -------------------------------

test('D03: a stock-tracked line with a sub-unit quantityMilli is refused at create (no stranded remainder)', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'wu');
  const bad = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 2500, unitPriceMinor: 5000 }], idempotencyKey: 'wu-o' });
  assert.equal(bad.ok, false, 'a 2.5-unit stock line is refused');
  assert.equal(bad.error, 'invalid_qty');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM sales_order WHERE workspace_id = ?'), 0, 'a refused create wrote no order');
  // A whole-unit stock line, and any fractional SERVICE line, are still fine.
  const okStock = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'wu-ok' });
  assert.equal(okStock.ok, true, 'a whole-unit stock line is accepted');
  const okSvc = createSalesOrder(ctx, { contactId, lines: [{ description: 'Beratung', quantityMilli: 2500, unitPriceMinor: 15000 }], idempotencyKey: 'wu-sv' });
  assert.equal(okSvc.ok, true, 'a fractional service line stays legal');
});

// --- cancel is terminal: a draft note on a cancelled order can never ship or resurrect it ---------

test('D03: a draft delivery note on a CANCELLED order cannot be issued, ships ZERO stock, order stays cancelled', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'cx');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'cx-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'cx-c' });
  // A DRAFT note exists but nothing has shipped, so the order is still cancellable (has_deliveries only
  // counts ISSUED notes).
  const note = createDeliveryNote(ctx, { salesOrderId: order.salesOrder.id, locationId: s.locationId, idempotencyKey: 'cx-dnc' });
  assert.equal(note.ok, true, `create note: ${JSON.stringify(note)}`);

  const cancelled = cancelSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'cx-x' });
  assert.equal(cancelled.ok, true, `cancel: ${JSON.stringify(cancelled)}`);
  assert.equal(getSalesOrder(ctx, { salesOrderId: order.salesOrder.id }).salesOrder.status, 'cancelled', 'the order is cancelled');
  // The draft note is voided with the order (spec §7: DN_STATUS `cancelled(draft-only)`), no orphan draft.
  const voided = ctx.store.db.prepare('SELECT status FROM delivery_note WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, note.deliveryNote.id);
  assert.equal(voided.status, 'cancelled', 'the un-issued draft note is voided on cancel');

  // Issuing the draft note MUST be refused: a cancelled order can never be shipped or un-cancelled.
  const issued = issueDeliveryNote(ctx, { deliveryNoteId: note.deliveryNote.id, idempotencyKey: 'cx-dni' });
  assert.equal(issued.ok, false, 'issuing a note on a cancelled order is refused');
  assert.equal(onHand(ctx, s.itemId), 10, 'ZERO stock shipped: on-hand unchanged');
  assert.equal(issueMovements(ctx), 0, 'no issue movement was minted');
  assert.equal(getSalesOrder(ctx, { salesOrderId: order.salesOrder.id }).salesOrder.status, 'cancelled', 'the order STAYS cancelled, not resurrected to delivered');

  // And a subsequent invoice on the cancelled order mints NOTHING.
  const inv = salesOrderInvoice(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'cx-i' });
  assert.equal(inv.ok, false, 'invoicing a cancelled order is refused');
  assert.equal(invoiceDocs(ctx), 0, 'no A11 invoice was minted for the cancelled order');
});

test('D03: an order with an issued delivery note cannot be cancelled (has_deliveries)', () => {
  const { ctx, contactId } = setup();
  const s = seedStock(ctx, 10, 'hd');
  const order = createSalesOrder(ctx, { contactId, lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'hd-o' });
  confirmSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'hd-c' });
  deliverFully(ctx, order.salesOrder.id, s.locationId, 'hd');
  const res = cancelSalesOrder(ctx, { salesOrderId: order.salesOrder.id, idempotencyKey: 'hd-x' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'has_deliveries', 'shipped goods return through a D01 return move, not by erasing the order');
});
