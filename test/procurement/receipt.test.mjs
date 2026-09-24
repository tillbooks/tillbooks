// I02, the goods receipt: the money-path invariants, each asserted on real ROW COUNTS and summed
// quantities rather than on a returned `ok:true`.
//
//   (a) IDEMPOTENT ON ROWS: a replayed post writes exactly one document, one movement and one trail
//       row, and a second post under a DIFFERENT key is refused by the status machine.
//   (b) APPEND-ONLY: a posted receipt is never edited; the correction is a compensating J02 `return`
//       movement plus a negative trail row, and the original movement row is byte-identical after.
//   (c) NO SILENT CLAMP and NO SILENT ACCEPT: by default an over-delivery posts at its FULL
//       quantity and the excess is recorded (line, header flag, append-only event); a workspace that
//       configures a hard ceiling still gets a refusal, and the whole receipt rolls back.
//   (d) §H-PERIOD against the period the receipt BELONGS to: the MONTH of the receipt is locked while
//       the month the CLOCK sits in stays open, so only a guard reading the document's own date can
//       make the refusal, and there is no date parameter to dodge with.
//   (e) §H-TENANT: workspace A and workspace B in ONE store, probed with A's REAL ids.
//   (f) ATOMICITY: a multi-line receipt whose second line trips a guard leaves NOTHING behind.
//
// Plus the trail equality that makes the whole design safe: SUM(goods_receipt_line.qty for a po_line)
// == po_line.received_qty, which is what keeps B03's dated derivation and D02's counter agreeing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem, createContact } from '../../dist/core/sales/index.js';
import { poUpsert, poSend, poCancel } from '../../dist/core/purchase/purchaseOrders.js';
import { makePeriodPort, lockPeriod } from '../../dist/core/ledger/index.js';
import {
  inventoryEnsureDefaultLocation,
  itemSetTrackingMode,
  lotCreate,
  serialCreate,
} from '../../dist/core/inventory/index.js';
import { createProject } from '../../dist/core/projects/index.js';
import { costingProjectPl } from '../../dist/core/costing/index.js';
import {
  goodsReceiptCreate,
  goodsReceiptUpsertLines,
  goodsReceiptPreview,
  goodsReceiptPost,
  goodsReceiptAcceptLines,
  goodsReceiptRejectLines,
  goodsReceiptReverse,
  goodsReceiptCancel,
  goodsReceiptGet,
  goodsReceiptList,
  goodsReceiptLinesForMatch,
  goodsReceiptSetConfig,
  goodsReceiptGetConfig,
} from '../../dist/core/procurement/index.js';

const AT = '2026-08-11T00:00:00.000Z';
const RECEIVED_AT = '2026-03-04';

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
}

/**
 * One store, one workspace, with the REAL A03 period port wired (so the lock tests are not stubs).
 * `at` is injectable because B03's dated derivation also cuts on `purchase_order.created_at`, so a
 * test about a March receipt needs the order to have been created in March too.
 */
function freshCtx(at = AT) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    periods: makePeriodPort({ store, workspaceId }),
  });
  return { ctx, store, workspaceId, deps, clock, ids };
}

/** A SENT purchase order for `qty` units at CHF 100.00 each, plus the world it needs. */
function sentPo(ctx, { qty = 6, seed = 'p', trackStock = true, unitPriceRappen = 10000 } = {}) {
  const vendorId = must(
    createContact(ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${seed}-v` }),
    'createContact',
  ).contact.id;
  const itemId = must(
    createItem(ctx, { name: `Rohstoff ${seed}`, defaultUnitPriceMinor: 12000, trackStock, idempotencyKey: `${seed}-i` }),
    'createItem',
  ).item.id;
  // `.location.id`, NOT `.locationId`: the verb returns { warehouse, location }, and reading the
  // wrong field handed `undefined` to every `defaultLocationId` below, so the explicit-location
  // path and its `invalid_reference` guard were never once exercised (critic finding 6).
  const locationId = must(inventoryEnsureDefaultLocation(ctx), 'ensureDefaultLocation').location.id;
  const po = must(
    poUpsert(ctx, {
      supplierContactId: vendorId,
      lines: [{ itemId, qty, unitPriceRappen }],
      idempotencyKey: `${seed}-po`,
    }),
    'poUpsert',
  );
  must(poSend(ctx, { poId: po.poId, idempotencyKey: `${seed}-send` }), 'poSend');
  const lineId = ctx.store.db
    .prepare('SELECT id FROM po_line WHERE workspace_id = ? AND po_id = ?')
    .get(ctx.workspaceId, po.poId).id;
  return { vendorId, itemId, locationId, poId: po.poId, poLineId: lineId };
}

function draft(ctx, world, seed) {
  return must(
    goodsReceiptCreate(ctx, {
      poId: world.poId,
      receivedAt: RECEIVED_AT,
      defaultLocationId: world.locationId,
      idempotencyKey: `${seed}-create`,
    }),
    'goodsReceiptCreate',
  ).goodsReceipt;
}

function addLine(ctx, grId, poLineId, qty, seed, over = {}) {
  return must(
    goodsReceiptUpsertLines(ctx, {
      grId,
      ops: [{ op: 'add', poLineId, qty, ...over }],
      idempotencyKey: `${seed}-line`,
    }),
    'upsertLines',
  ).goodsReceipt;
}

// --- row-level probes ---------------------------------------------------------------------------

const count = (ctx, table, where = '1=1', ...params) =>
  ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND ${where}`).get(ctx.workspaceId, ...params).n;

const movements = (ctx, grId) =>
  ctx.store.db
    .prepare(
      `SELECT id, qty, movement_type, unit_cost_minor, moved_at, ref_kind, ref_id
         FROM stock_movement WHERE workspace_id = ? AND ref_id = ? ORDER BY id`,
    )
    .all(ctx.workspaceId, grId);

const receivedQty = (ctx, poLineId) =>
  ctx.store.db.prepare('SELECT received_qty FROM po_line WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, poLineId).received_qty;

const trailSum = (ctx, poLineId) =>
  ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM goods_receipt_line WHERE workspace_id = ? AND po_line_id = ?')
    .get(ctx.workspaceId, poLineId).n;

/** The DATES on the shared trail headers, oldest first. B03's dated derivation reads exactly this. */
const trailDates = (ctx) =>
  ctx.store.db
    .prepare('SELECT received_at FROM goods_receipt WHERE workspace_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId)
    .map((r) => r.received_at);

const poStatus = (ctx, poId) =>
  ctx.store.db.prepare('SELECT status FROM purchase_order WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, poId).status;

/** The equality the whole trail design rests on, asserted wherever quantity moves. */
function assertTrailAgreesWithCounter(ctx, poLineId, label) {
  assert.equal(
    trailSum(ctx, poLineId),
    receivedQty(ctx, poLineId),
    `${label}: SUM(trail.qty) must equal po_line.received_qty`,
  );
}

// --- the happy path -----------------------------------------------------------------------------

test('I02: posting a receipt writes ONE movement, ONE trail row and raises received_qty by exactly the line quantity', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'h' });
  const gr = draft(ctx, w, 'h');
  addLine(ctx, gr.id, w.poLineId, 4, 'h');

  // Nothing physical has happened yet.
  assert.equal(count(ctx, 'stock_movement'), 0, 'a draft moves no stock');
  assert.equal(receivedQty(ctx, w.poLineId), 0);

  const posted = must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'h-post' }), 'post').goodsReceipt;
  assert.equal(posted.status, 'posted');

  const mv = movements(ctx, gr.id);
  assert.equal(mv.length, 1, 'exactly one movement');
  assert.equal(mv[0].qty, 4);
  assert.equal(mv[0].movement_type, 'receipt');
  assert.equal(mv[0].unit_cost_minor, 10000, 'the CHF base cost snapshot from the PO line');
  assert.equal(mv[0].moved_at, RECEIVED_AT, 'the movement is dated to the receipt own received_at, never to now');
  assert.equal(mv[0].ref_kind, 'goods_receipt');

  assert.equal(count(ctx, 'goods_receipt'), 1, 'one shared trail header');
  assert.equal(count(ctx, 'goods_receipt_line'), 1, 'one shared trail line');
  assert.equal(receivedQty(ctx, w.poLineId), 4);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after post');
  assert.equal(poStatus(ctx, w.poId), 'sent', 'a partial receipt does not advance the PO');
  assert.equal(posted.lines[0].movementId, mv[0].id, 'the line links the movement it minted');
});

test('I02: a second receipt that completes the order advances the PO to received', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'f' });
  const one = draft(ctx, w, 'f1');
  addLine(ctx, one.id, w.poLineId, 2, 'f1');
  must(goodsReceiptPost(ctx, { grId: one.id, idempotencyKey: 'f1-post' }), 'post one');
  assert.equal(poStatus(ctx, w.poId), 'sent');

  const two = draft(ctx, w, 'f2');
  addLine(ctx, two.id, w.poLineId, 4, 'f2');
  must(goodsReceiptPost(ctx, { grId: two.id, idempotencyKey: 'f2-post' }), 'post two');

  assert.equal(receivedQty(ctx, w.poLineId), 6);
  assert.equal(count(ctx, 'stock_movement'), 2, 'one movement per receipt, never a merged one');
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after the completing receipt');
  assert.equal(poStatus(ctx, w.poId), 'received');
});

test('I02: reversing a full receipt walks the ORDER back to sent, so the status stops claiming received', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'ro', qty: 6 });
  const gr = draft(ctx, w, 'ro');
  addLine(ctx, gr.id, w.poLineId, 6, 'ro');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'ro-post' }), 'post');
  assert.equal(poStatus(ctx, w.poId), 'received');

  must(goodsReceiptReverse(ctx, { grId: gr.id, reason: 'Fehllieferung', idempotencyKey: 'ro-rev' }), 'reverse');

  // The lines say nothing is received, so the header must say `sent` (the widened D02 edge). Reading
  // the counter alone would not catch this: it is the STATUS column every downstream reader trusts.
  assert.equal(poStatus(ctx, w.poId), 'sent');
  assert.equal(receivedQty(ctx, w.poLineId), 0);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after the reopen');
});

test('I02: a PARTIAL reversal also reopens the order, and the guards that hang off sent come back with it', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'rp', qty: 6 });
  // Two receipts fill the order; reversing ONE leaves it short, so the order must reopen.
  const one = draft(ctx, w, 'rp1');
  addLine(ctx, one.id, w.poLineId, 2, 'rp1');
  must(goodsReceiptPost(ctx, { grId: one.id, idempotencyKey: 'rp1-post' }), 'post one');
  const two = draft(ctx, w, 'rp2');
  addLine(ctx, two.id, w.poLineId, 4, 'rp2');
  must(goodsReceiptPost(ctx, { grId: two.id, idempotencyKey: 'rp2-post' }), 'post two');
  assert.equal(poStatus(ctx, w.poId), 'received');

  must(goodsReceiptReverse(ctx, { grId: two.id, reason: 'Fehlmenge', idempotencyKey: 'rp2-rev' }), 'reverse two');
  assert.equal(poStatus(ctx, w.poId), 'sent');
  assert.equal(receivedQty(ctx, w.poLineId), 2, 'the surviving receipt is untouched');

  // A PO that still has 2 units received may NOT be cancelled (D02's has_receipts guard), which is
  // what proves the reopen re-enabled the sent-hung guards rather than bypassing them.
  assert.equal(poCancel(ctx, { poId: w.poId, idempotencyKey: 'rp-cancel' }).error, 'has_receipts');

  // Reverse the other one too: now nothing is net received, and cancelling becomes legitimate again.
  must(goodsReceiptReverse(ctx, { grId: one.id, reason: 'Fehlmenge', idempotencyKey: 'rp1-rev' }), 'reverse one');
  assert.equal(poStatus(ctx, w.poId), 'sent');
  must(poCancel(ctx, { poId: w.poId, idempotencyKey: 'rp-cancel-2' }), 'cancel after a full walk-back');
  assert.equal(poStatus(ctx, w.poId), 'cancelled');
});

// --- (a) IDEMPOTENT ON ROWS ----------------------------------------------------------------------

test('I02 (a): a replayed post writes exactly one set of movements and trail rows, and never double-counts stock', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'i' });
  const gr = draft(ctx, w, 'i');
  addLine(ctx, gr.id, w.poLineId, 3, 'i');

  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'i-post' }), 'post');
  const replay = must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'i-post' }), 'replay');

  assert.equal(replay.goodsReceipt.id, gr.id, 'the replay returns the original document');
  assert.equal(count(ctx, 'goods_receipt_doc'), 1);
  assert.equal(count(ctx, 'stock_movement'), 1, 'no second movement');
  assert.equal(count(ctx, 'goods_receipt_line'), 1, 'no second trail row');
  assert.equal(count(ctx, 'goods_receipt'), 1, 'no second trail header');
  assert.equal(receivedQty(ctx, w.poLineId), 3, 'received_qty counted once');
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after replay');
});

test('I02 (a): a second post under a DIFFERENT key is refused by the status machine, so a forgotten key cannot double-count', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'i2' });
  const gr = draft(ctx, w, 'i2');
  addLine(ctx, gr.id, w.poLineId, 3, 'i2');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'i2-post-a' }), 'post');

  const again = goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'i2-post-b' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'invalid_transition');
  assert.equal(count(ctx, 'stock_movement'), 1);
  assert.equal(count(ctx, 'goods_receipt_line'), 1);
  assert.equal(receivedQty(ctx, w.poLineId), 3);
});

test('I02 (a): a replayed reverse writes exactly one compensation', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'ir' });
  const gr = draft(ctx, w, 'ir');
  addLine(ctx, gr.id, w.poLineId, 5, 'ir');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'ir-post' }), 'post');

  must(goodsReceiptReverse(ctx, { grId: gr.id, reason: 'Fehllieferung', idempotencyKey: 'ir-rev' }), 'reverse');
  must(goodsReceiptReverse(ctx, { grId: gr.id, reason: 'Fehllieferung', idempotencyKey: 'ir-rev' }), 'reverse replay');

  assert.equal(count(ctx, 'stock_movement'), 2, 'the receipt and exactly one compensation');
  assert.equal(count(ctx, 'goods_receipt_line'), 2, 'the trail row and exactly one negative twin');
  assert.equal(receivedQty(ctx, w.poLineId), 0);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after a replayed reverse');
});

// --- (b) APPEND-ONLY -----------------------------------------------------------------------------

test('I02 (b): a reversal compensates and never edits: the original movement row is unchanged and the trail nets to zero', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'b' });
  const gr = draft(ctx, w, 'b');
  addLine(ctx, gr.id, w.poLineId, 5, 'b');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'b-post' }), 'post');
  const before = movements(ctx, gr.id)[0];

  const reversed = must(goodsReceiptReverse(ctx, { grId: gr.id, reason: 'Falsche Ware', idempotencyKey: 'b-rev' }), 'reverse')
    .goodsReceipt;
  assert.equal(reversed.status, 'reversed');
  assert.equal(reversed.reversedBy, 'user_1');

  const after = movements(ctx, gr.id);
  assert.equal(after.length, 2);
  const original = after.find((m) => m.id === before.id);
  assert.deepEqual(original, before, 'the original movement row is byte-identical after the reversal');
  const compensation = after.find((m) => m.id !== before.id);
  assert.equal(compensation.qty, -5, 'equal magnitude, opposite sign');
  assert.equal(compensation.movement_type, 'return');
  assert.equal(compensation.moved_at, RECEIVED_AT, 'the compensation is dated to the receipt own date');
  assert.equal(compensation.ref_id, gr.id, 'the pair shares one source document');

  assert.equal(trailSum(ctx, w.poLineId), 0, 'the trail nets to zero');
  assert.equal(receivedQty(ctx, w.poLineId), 0);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after reverse');

  // The document and its decision trail survive: nothing was deleted.
  const detail = must(goodsReceiptGet(ctx, { grId: gr.id }), 'get').goodsReceipt;
  assert.equal(detail.lines[0].movementId, before.id, 'the original movement link is preserved');
  assert.equal(detail.lines[0].reversalMovementId, compensation.id);
  assert.ok(detail.events.some((e) => e.eventType === 'posted'));
  assert.ok(detail.events.some((e) => e.eventType === 'reversed' && e.reason === 'Falsche Ware'));
});

test('I02 (b): a posted receipt cannot be edited or cancelled, and a reversed one cannot be reversed twice', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'b2' });
  const gr = draft(ctx, w, 'b2');
  addLine(ctx, gr.id, w.poLineId, 2, 'b2');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'b2-post' }), 'post');

  const edited = goodsReceiptUpsertLines(ctx, {
    grId: gr.id,
    ops: [{ op: 'add', poLineId: w.poLineId, qty: 1 }],
    idempotencyKey: 'b2-edit',
  });
  assert.equal(edited.error, 'invalid_transition');
  assert.equal(goodsReceiptCancel(ctx, { grId: gr.id, idempotencyKey: 'b2-cancel' }).error, 'invalid_transition');
  assert.equal(count(ctx, 'goods_receipt_doc_line'), 1, 'the refused edit added nothing');

  must(goodsReceiptReverse(ctx, { grId: gr.id, reason: 'x', idempotencyKey: 'b2-rev' }), 'reverse');
  const twice = goodsReceiptReverse(ctx, { grId: gr.id, reason: 'x', idempotencyKey: 'b2-rev2' });
  assert.equal(twice.error, 'invalid_transition');
  assert.equal(count(ctx, 'stock_movement'), 2, 'the refused second reversal wrote nothing');
});

test('I02 (b): a receipt line a three-way match has already billed cannot be reversed', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'bb' });
  const gr = draft(ctx, w, 'bb');
  addLine(ctx, gr.id, w.poLineId, 4, 'bb');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'bb-post' }), 'post');
  // I04 will maintain this column; simulate the billed state it produces.
  ctx.store.db
    .prepare('UPDATE goods_receipt_doc_line SET billed_qty = 4 WHERE workspace_id = ? AND gr_id = ?')
    .run(ctx.workspaceId, gr.id);

  const refused = goodsReceiptReverse(ctx, { grId: gr.id, reason: 'zu spät', idempotencyKey: 'bb-rev' });
  assert.equal(refused.error, 'line_already_billed');
  assert.equal(count(ctx, 'stock_movement'), 1, 'nothing was compensated');
  assert.equal(receivedQty(ctx, w.poLineId), 4, 'received_qty untouched');
});

// --- (c) OVER-RECEIPT: accepted and RECORDED by default, refused above a configured ceiling -------

test('I02 (c): an over-delivery is accepted at its FULL quantity and recorded as an exception, never clamped', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'c', qty: 6 });
  const gr = draft(ctx, w, 'c');
  const withLine = addLine(ctx, gr.id, w.poLineId, 10, 'c');

  // The default posture: no config row at all.
  assert.deepEqual(
    (({ allowOverReceipt, overReceiptPct }) => ({ allowOverReceipt, overReceiptPct }))(must(goodsReceiptGetConfig(ctx), 'cfg')),
    { allowOverReceipt: true, overReceiptPct: null },
  );

  const posted = must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'c-post' }), 'post').goodsReceipt;

  // FULL quantity, not the 6 that fit: the goods physically arrived, so the ledger says 10.
  const mv = movements(ctx, gr.id);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].qty, 10, 'the movement carries what arrived, never what was ordered');
  assert.equal(receivedQty(ctx, w.poLineId), 10);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after an accepted over-delivery');

  // And the discrepancy is a STORED fact, in all three places a reader might look.
  assert.equal(posted.hasOverReceipt, true, 'the header carries the flag');
  assert.equal(posted.lines[0].overReceiptQty, 4, 'the line carries the over-delivered quantity');
  const flagged = posted.events.filter((e) => e.eventType === 'over_receipt');
  assert.equal(flagged.length, 1, 'exactly one append-only exception event');
  assert.equal(flagged[0].actor, 'user_1');
  assert.match(flagged[0].reason, /\+4/, 'the event names the excess');
  assert.equal(withLine.lines[0].overReceiptQty, 0, 'a draft line carries no exception until it is recognised');

  // The exception cut a buyer actually asks for. A SECOND, CLEAN receipt has to exist before this
  // means anything: with only the flagged one in the workspace, a filter that had stopped filtering
  // at all would return the same single row and the assertion would pass on nothing.
  const clean = sentPo(ctx, { seed: 'cc', qty: 5 });
  const cleanGr = draft(ctx, clean, 'cc');
  addLine(ctx, cleanGr.id, clean.poLineId, 5, 'cc');
  must(goodsReceiptPost(ctx, { grId: cleanGr.id, idempotencyKey: 'cc-post' }), 'post the clean one');
  assert.equal(must(goodsReceiptList(ctx, {}), 'list all').goodsReceipts.length, 2, 'both are in the workspace');

  const only = must(goodsReceiptList(ctx, { hasOverReceipt: true }), 'list flagged').goodsReceipts;
  assert.equal(only.length, 1);
  assert.equal(only[0].id, gr.id);
  assert.equal(only[0].overReceiptQty, 4);
  const none = must(goodsReceiptList(ctx, { hasOverReceipt: false }), 'list clean').goodsReceipts;
  assert.equal(none.length, 1);
  assert.equal(none[0].id, cleanGr.id);
  assert.equal(none[0].overReceiptQty, 0);
});

test('I02 (c): a workspace that wants a HARD CEILING still gets one, and the whole receipt rolls back', () => {
  const { ctx } = freshCtx();
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: false, idempotencyKey: 'c1-cfg' }), 'setConfig');
  const w = sentPo(ctx, { seed: 'c1', qty: 6 });
  const gr = draft(ctx, w, 'c1');
  addLine(ctx, gr.id, w.poLineId, 10, 'c1');

  const refused = goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'c1-post' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'qty_exceeds_open');
  assert.equal(refused.open, 6);
  assert.equal(refused.requested, 10);

  assert.equal(count(ctx, 'stock_movement'), 0, 'no movement');
  assert.equal(count(ctx, 'goods_receipt'), 0, 'no trail header');
  assert.equal(count(ctx, 'goods_receipt_line'), 0, 'no trail line');
  assert.equal(receivedQty(ctx, w.poLineId), 0, 'received_qty NOT clamped to 6 either');
  assert.equal(must(goodsReceiptGet(ctx, { grId: gr.id }), 'get').goodsReceipt.status, 'draft');
});

test('I02 (c): a percentage tolerance is honoured exactly: within it the excess is flagged, above it refused', () => {
  const { ctx } = freshCtx();
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: true, overReceiptPct: 50, idempotencyKey: 'c2-cfg' }), 'setConfig');
  assert.deepEqual(
    (({ allowOverReceipt, overReceiptPct }) => ({ allowOverReceipt, overReceiptPct }))(must(goodsReceiptGetConfig(ctx), 'cfg')),
    { allowOverReceipt: true, overReceiptPct: 50 },
  );

  // Ordered SEVEN, not six, so the documented DOWNWARD rounding is actually under test:
  // floor(7 * 50 / 100) = 3 while ceil would give 4, and the ceiling is therefore 10 and not 11.
  const w = sentPo(ctx, { seed: 'c2', qty: 7 });
  const tooMuch = draft(ctx, w, 'c2a');
  addLine(ctx, tooMuch.id, w.poLineId, 11, 'c2a');
  const refused = goodsReceiptPost(ctx, { grId: tooMuch.id, idempotencyKey: 'c2a-post' });
  assert.equal(refused.error, 'over_receipt');
  assert.equal(refused.ceiling, 10, 'rounded DOWN, so the tolerance is never wider than granted');
  assert.equal(count(ctx, 'stock_movement'), 0);

  const allowed = draft(ctx, w, 'c2b');
  addLine(ctx, allowed.id, w.poLineId, 8, 'c2b');
  const posted = must(goodsReceiptPost(ctx, { grId: allowed.id, idempotencyKey: 'c2b-post' }), 'post within tolerance')
    .goodsReceipt;
  assert.equal(receivedQty(ctx, w.poLineId), 8, 'the over-receipt is RECORDED, above the ordered 7');
  assert.equal(posted.lines[0].overReceiptQty, 1);
  assert.equal(posted.hasOverReceipt, true);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after an allowed over-receipt');

  // Clearing the cap is done by OMITTING the percentage, and then 10 posts.
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: true, idempotencyKey: 'c2-uncap' }), 'clear the cap');
  assert.equal(must(goodsReceiptGetConfig(ctx), 'cfg').overReceiptPct, null);
});

test('I02 (c): a partial receipt leaves the residual open, and a concurrent second receipt is serialised on the LIVE quantity', () => {
  const { ctx } = freshCtx();
  // A hard ceiling, so the concurrency guard is what the second post trips rather than the flag.
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: false, idempotencyKey: 'c3-cfg' }), 'setConfig');
  const w = sentPo(ctx, { seed: 'c3', qty: 6 });
  // Both drafts are prepared against an open quantity of 6; the first one consumes 5.
  const first = draft(ctx, w, 'c3a');
  addLine(ctx, first.id, w.poLineId, 5, 'c3a');
  const second = draft(ctx, w, 'c3b');
  addLine(ctx, second.id, w.poLineId, 5, 'c3b');

  must(goodsReceiptPost(ctx, { grId: first.id, idempotencyKey: 'c3a-post' }), 'post first');
  // The second re-reads the LIVE open quantity (now 1) inside the transaction and is refused.
  const refused = goodsReceiptPost(ctx, { grId: second.id, idempotencyKey: 'c3b-post' });
  assert.equal(refused.error, 'qty_exceeds_open');
  assert.equal(refused.open, 1);
  assert.equal(receivedQty(ctx, w.poLineId), 5, 'the loser changed nothing');
  assert.equal(count(ctx, 'stock_movement'), 1);

  // Under the DEFAULT posture the same second post lands, and the 4 units of excess are recorded.
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: true, idempotencyKey: 'c3-open' }), 'accept-and-flag');
  const landed = must(goodsReceiptPost(ctx, { grId: second.id, idempotencyKey: 'c3b-post-2' }), 'post second').goodsReceipt;
  assert.equal(receivedQty(ctx, w.poLineId), 10);
  assert.equal(landed.lines[0].overReceiptQty, 4);
  assert.equal(landed.hasOverReceipt, true);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after the flagged second receipt');
});

test('I02: an explicit defaultLocationId is used, and a foreign or unknown one is refused before anything is written', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'loc' });
  const detail = must(
    goodsReceiptCreate(ctx, { poId: w.poId, receivedAt: RECEIVED_AT, defaultLocationId: w.locationId, idempotencyKey: 'loc-1' }),
    'create with an explicit location',
  ).goodsReceipt;
  assert.equal(detail.defaultLocationId, w.locationId, 'the named location is the one stored');

  const refused = goodsReceiptCreate(ctx, {
    poId: w.poId,
    receivedAt: RECEIVED_AT,
    defaultLocationId: 'stockloc_does_not_exist',
    idempotencyKey: 'loc-2',
  });
  assert.equal(refused.error, 'invalid_reference');
  assert.equal(count(ctx, 'goods_receipt_doc'), 1, 'the refused create wrote nothing');
});

// --- (d) §H-PERIOD -------------------------------------------------------------------------------

test('I02 (d): a receipt cannot be created into a locked period', () => {
  const { ctx } = freshCtx();
  must(lockPeriod(ctx, { period: '2026-03', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'd-lock' }), 'lockPeriod');
  const w = sentPo(ctx, { seed: 'd' });
  const refused = goodsReceiptCreate(ctx, {
    poId: w.poId,
    receivedAt: RECEIVED_AT,
    defaultLocationId: w.locationId,
    idempotencyKey: 'd-create',
  });
  assert.equal(refused.error, 'period_locked');
  assert.equal(count(ctx, 'goods_receipt_doc'), 0);
});

test('I02 (d): a draft created while the period was open cannot be POSTED once the year is sealed, and there is no date to shift', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'd2' });
  const gr = draft(ctx, w, 'd2');
  addLine(ctx, gr.id, w.poLineId, 4, 'd2');

  // THE MONTH the receipt belongs to (2026-03) is sealed, and NOTHING ELSE is. The fixed clock is
  // 2026-08-11, so `assertOpen(now)` would pass here: locking the whole YEAR (as this test used to)
  // made both dates fail and the assertion could not tell them apart, which is exactly how a sibling
  // capability shipped a back-chargeable sealed year. Only a guard reading the DOCUMENT's own date
  // can make this refusal.
  must(lockPeriod(ctx, { period: '2026-03', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'd2-lock' }), 'lockPeriod');
  assert.equal(must(goodsReceiptCreate(ctx, { poId: w.poId, receivedAt: '2026-08-11', idempotencyKey: 'd2-probe' }), 'the clock month is OPEN').goodsReceipt.status, 'draft');

  const refused = goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'd2-post' });
  assert.equal(refused.error, 'period_locked');
  assert.equal(refused.period, '2026-03', 'the period named is the one the RECEIPT belongs to');
  assert.equal(count(ctx, 'stock_movement'), 0, 'a sealed year is not back-chargeable');
  assert.equal(receivedQty(ctx, w.poLineId), 0);

  // The verb takes NO date, so there is nothing a caller can move into an open period: passing one
  // is ignored by the schema-free engine input and the stored received_at still governs.
  const sneaky = goodsReceiptPost(ctx, { grId: gr.id, receivedAt: '2027-01-05', effectiveDate: '2027-01-05', idempotencyKey: 'd2-post-2' });
  assert.equal(sneaky.error, 'period_locked');
  assert.equal(count(ctx, 'stock_movement'), 0);
});

test('I02 (d): a held line cannot be ACCEPTED into a sealed period either', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'd4', qty: 6 });
  const gr = draft(ctx, w, 'd4');
  const withLine = addLine(ctx, gr.id, w.poLineId, 3, 'd4', { inspectionStatus: 'pending' });
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'd4-post' }), 'post');
  assert.equal(count(ctx, 'stock_movement'), 0, 'the held line moved nothing yet');

  // Acceptance is where the held quantity finally becomes stock, so it is a WRITE into the receipt's
  // own period and owes the same guard the post does. Invariant (d) claims all four verbs assert it;
  // this is the fourth.
  must(lockPeriod(ctx, { period: '2026-03', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'd4-lock' }), 'lockPeriod');
  const refused = goodsReceiptAcceptLines(ctx, {
    grId: gr.id,
    lineIds: [withLine.lines[0].id],
    idempotencyKey: 'd4-accept',
  });
  assert.equal(refused.error, 'period_locked');
  assert.equal(refused.period, '2026-03');
  assert.equal(count(ctx, 'stock_movement'), 0, 'no movement slipped into the sealed period');
  assert.equal(count(ctx, 'goods_receipt_line'), 0, 'and no trail row either');
  assert.equal(receivedQty(ctx, w.poLineId), 0);
});

test('I02 (d): a sealed period cannot be UN-received either', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'd3' });
  const gr = draft(ctx, w, 'd3');
  addLine(ctx, gr.id, w.poLineId, 4, 'd3');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'd3-post' }), 'post');
  must(lockPeriod(ctx, { period: '2026-03', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'd3-lock' }), 'lockPeriod');

  const refused = goodsReceiptReverse(ctx, { grId: gr.id, reason: 'Irrtum', idempotencyKey: 'd3-rev' });
  assert.equal(refused.error, 'period_locked');
  assert.equal(count(ctx, 'stock_movement'), 1, 'the sealed period stock history is untouched');
  assert.equal(receivedQty(ctx, w.poLineId), 4);
});

// --- (f) ATOMICITY -------------------------------------------------------------------------------

test('I02 (f): a multi-line receipt whose SECOND line trips a guard leaves nothing at all behind', () => {
  const { ctx } = freshCtx();
  // A hard ceiling, so an over-quantity is a REFUSAL rather than a recorded exception: this test is
  // about what survives a refusal that lands after line one has already written.
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: false, idempotencyKey: 'a-cfg' }), 'setConfig');
  const vendorId = must(createContact(ctx, { partyRole: 'vendor', name: 'Lieferant', idempotencyKey: 'a-v' }), 'contact').contact.id;
  const itemA = must(createItem(ctx, { name: 'Teil A', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'a-i1' }), 'item').item.id;
  const itemB = must(createItem(ctx, { name: 'Teil B', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'a-i2' }), 'item').item.id;
  // `.location.id`, NOT `.locationId`: the verb returns { warehouse, location }, and reading the
  // wrong field handed `undefined` to every `defaultLocationId` below, so the explicit-location
  // path and its `invalid_reference` guard were never once exercised (critic finding 6).
  const locationId = must(inventoryEnsureDefaultLocation(ctx), 'ensureDefaultLocation').location.id;
  const po = must(
    poUpsert(ctx, {
      supplierContactId: vendorId,
      lines: [
        { itemId: itemA, qty: 5, unitPriceRappen: 1000 },
        { itemId: itemB, qty: 5, unitPriceRappen: 1000 },
      ],
      idempotencyKey: 'a-po',
    }),
    'poUpsert',
  );
  must(poSend(ctx, { poId: po.poId, idempotencyKey: 'a-send' }), 'poSend');
  const poLines = ctx.store.db
    .prepare('SELECT id, item_id FROM po_line WHERE workspace_id = ? AND po_id = ? ORDER BY sort, id')
    .all(ctx.workspaceId, po.poId);

  const gr = must(
    goodsReceiptCreate(ctx, { poId: po.poId, receivedAt: RECEIVED_AT, defaultLocationId: locationId, idempotencyKey: 'a-gr' }),
    'create',
  ).goodsReceipt;
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: gr.id,
      ops: [
        { op: 'add', poLineId: poLines[0].id, qty: 5 },
        // Line two asks for more than its order line has open, so the post must refuse AFTER line one
        // has already been written inside the transaction. Nothing may survive that.
        { op: 'add', poLineId: poLines[1].id, qty: 99 },
      ],
      idempotencyKey: 'a-lines',
    }),
    'upsert',
  );

  const refused = goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'a-post' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'qty_exceeds_open');

  assert.equal(count(ctx, 'stock_movement'), 0, 'line one movement was rolled back too');
  assert.equal(count(ctx, 'goods_receipt'), 0, 'no trail header survived');
  assert.equal(count(ctx, 'goods_receipt_line'), 0, 'no trail line survived');
  assert.equal(receivedQty(ctx, poLines[0].id), 0, 'line one quantity was rolled back');
  assert.equal(receivedQty(ctx, poLines[1].id), 0);
  assert.equal(must(goodsReceiptGet(ctx, { grId: gr.id }), 'get').goodsReceipt.status, 'draft', 'the document is still a draft');
});

// --- (e) §H-TENANT -------------------------------------------------------------------------------

/**
 * Two workspaces inside ONE store, the pattern `test/inventory/movement-ledger.test.mjs` was rewritten
 * to. Two separate stores would make this unfalsifiable: B's database would hold no A rows, so an
 * engine with NO workspace filter at all would still read zero. One store is what makes the filter
 * the only thing standing between them.
 */
function twoWorkspaces() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'Alpha AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'Beta AG' }).workspaceId;
  const mk = (workspaceId, actor) => ({
    ctx: makeContext(store, { workspaceId, actor, clock, ids, periods: makePeriodPort({ store, workspaceId }) }),
    store,
    workspaceId,
  });
  return { store, a: mk(wsA, 'user_a'), b: mk(wsB, 'user_b') };
}

test('I02 (e): an unknown lot or serial is a structured refusal, and a FOREIGN one never reaches the draft', () => {
  const { store, a, b } = twoWorkspaces();
  const wa = sentPo(a.ctx, { seed: 'lr' });
  const grA = draft(a.ctx, wa, 'lr');

  // An unknown id used to reach the INSERT and come back as `unexpected_error` from the throw guard
  // ("FOREIGN KEY constraint failed"), which an agent cannot act on.
  const unknownLot = goodsReceiptUpsertLines(a.ctx, {
    grId: grA.id,
    ops: [{ op: 'add', poLineId: wa.poLineId, qty: 1, lotId: 'lot_bogus' }],
    idempotencyKey: 'lr-1',
  });
  assert.equal(unknownLot.error, 'invalid_reference');
  assert.equal(unknownLot.lotId, 'lot_bogus', 'the refusal names the offending field');

  const unknownSerial = goodsReceiptUpsertLines(a.ctx, {
    grId: grA.id,
    ops: [{ op: 'add', poLineId: wa.poLineId, qty: 1, serialId: 'serial_bogus' }],
    idempotencyKey: 'lr-2',
  });
  assert.equal(unknownSerial.error, 'invalid_reference');
  assert.equal(unknownSerial.serialId, 'serial_bogus');

  // §H-TENANT at the point of entry: workspace B mints a REAL lot, whose id satisfies the foreign
  // key perfectly well. It must still never be storable on workspace A's document.
  const itemB = must(createItem(b.ctx, { name: 'Fremdteil', defaultUnitPriceMinor: 100, trackStock: true, idempotencyKey: 'lr-bi' }), 'item B').item.id;
  must(itemSetTrackingMode(b.ctx, { itemId: itemB, mode: 'lot', idempotencyKey: 'lr-bm' }), 'trackingMode');
  const lotB = must(lotCreate(b.ctx, { itemId: itemB, number: 'CH-2026-01', idempotencyKey: 'lr-bl' }), 'lotCreate').lot.id;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM lot').get().n, 1, "B's lot really exists in the one store");

  const foreign = goodsReceiptUpsertLines(a.ctx, {
    grId: grA.id,
    ops: [{ op: 'add', poLineId: wa.poLineId, qty: 1, lotId: lotB }],
    idempotencyKey: 'lr-3',
  });
  assert.equal(foreign.error, 'invalid_reference');
  assert.equal(foreign.lotId, lotB);
  assert.equal(count(a.ctx, 'goods_receipt_doc_line'), 0, 'no refused op left a line behind');
});

test('I02 (e): workspace B cannot see, post against or reverse workspace A real receipts', () => {
  const { store, a, b } = twoWorkspaces();

  const wa = sentPo(a.ctx, { seed: 'ta' });
  const grA = draft(a.ctx, wa, 'ta');
  addLine(a.ctx, grA.id, wa.poLineId, 3, 'ta');
  must(goodsReceiptPost(a.ctx, { grId: grA.id, idempotencyKey: 'ta-post' }), 'post A');

  const wb = sentPo(b.ctx, { seed: 'tb' });
  const grB = draft(b.ctx, wb, 'tb');
  addLine(b.ctx, grB.id, wb.poLineId, 2, 'tb');
  must(goodsReceiptPost(b.ctx, { grId: grB.id, idempotencyKey: 'tb-post' }), 'post B');

  // The one store really holds both, so the probes below cannot pass on an empty database.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM goods_receipt_doc').get().n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 2);

  // Every READ path, probed with A's REAL ids, never a fabricated one.
  assert.equal(goodsReceiptGet(b.ctx, { grId: grA.id }).error, 'not_found');
  assert.equal(goodsReceiptPreview(b.ctx, { grId: grA.id }).error, 'not_found');
  assert.deepEqual(must(goodsReceiptLinesForMatch(b.ctx, { poLineIds: [wa.poLineId] }), 'match').lines, []);

  // The UNFILTERED sweep in B returns only B's rows.
  const sweep = must(goodsReceiptList(b.ctx, {}), 'list B').goodsReceipts;
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].id, grB.id);
  assert.equal(sweep.some((r) => r.id === grA.id), false);
  // And filtering B's list by A's PO id yields nothing rather than A's receipt.
  assert.deepEqual(must(goodsReceiptList(b.ctx, { poId: wa.poId }), 'list B by A po').goodsReceipts, []);

  // Every WRITE path is invisible to B too.
  assert.equal(goodsReceiptCreate(b.ctx, { poId: wa.poId, receivedAt: RECEIVED_AT, idempotencyKey: 'tb-x1' }).error, 'not_found');
  assert.equal(goodsReceiptPost(b.ctx, { grId: grA.id, idempotencyKey: 'tb-x2' }).error, 'not_found');
  assert.equal(goodsReceiptReverse(b.ctx, { grId: grA.id, reason: 'x', idempotencyKey: 'tb-x3' }).error, 'not_found');
  assert.equal(goodsReceiptCancel(b.ctx, { grId: grA.id, idempotencyKey: 'tb-x4' }).error, 'not_found');
  assert.equal(
    goodsReceiptUpsertLines(b.ctx, { grId: grA.id, ops: [{ op: 'add', poLineId: wa.poLineId, qty: 1 }], idempotencyKey: 'tb-x5' }).error,
    'not_found',
  );

  // No refused write moved anything, in either workspace.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 2);
  assert.equal(receivedQty(a.ctx, wa.poLineId), 3);
  assert.equal(receivedQty(b.ctx, wb.poLineId), 2);
  // A's own view is unchanged and still complete.
  assert.equal(must(goodsReceiptList(a.ctx, {}), 'list A').goodsReceipts.length, 1);
});

// --- inspection hold, non-stock lines, preview purity, and the I04 read ---------------------------

test('I02: a line held for inspection mints no movement until it is accepted, and a rejected one never does', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'q', qty: 10 });
  const gr = draft(ctx, w, 'q');
  const withLines = must(
    goodsReceiptUpsertLines(ctx, {
      grId: gr.id,
      ops: [
        { op: 'add', poLineId: w.poLineId, qty: 4 },
        { op: 'add', poLineId: w.poLineId, qty: 3, inspectionStatus: 'pending' },
      ],
      idempotencyKey: 'q-lines',
    }),
    'upsert',
  ).goodsReceipt;
  const heldId = withLines.lines[1].id;

  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'q-post' }), 'post');
  assert.equal(count(ctx, 'stock_movement'), 1, 'only the un-held line moved stock');
  assert.equal(receivedQty(ctx, w.poLineId), 4, 'the held quantity did not advance the order');
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after a post with a held line');

  const accepted = must(
    goodsReceiptAcceptLines(ctx, { grId: gr.id, lineIds: [heldId], idempotencyKey: 'q-accept' }),
    'accept',
  ).goodsReceipt;
  assert.equal(count(ctx, 'stock_movement'), 2);
  assert.equal(receivedQty(ctx, w.poLineId), 7);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after accept');
  assert.equal(accepted.lines[1].inspectionStatus, 'accepted');
  assert.ok(accepted.events.some((e) => e.eventType === 'accepted'));

  // An already-decided line cannot be decided again.
  assert.equal(goodsReceiptAcceptLines(ctx, { grId: gr.id, lineIds: [heldId], idempotencyKey: 'q-accept2' }).error, 'invalid_transition');
});

test('I02: a rejected line moves no stock and leaves the ordered quantity open', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'r', qty: 5 });
  const gr = draft(ctx, w, 'r');
  const withLines = addLine(ctx, gr.id, w.poLineId, 5, 'r', { inspectionStatus: 'pending' });
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'r-post' }), 'post');

  const rejected = must(
    goodsReceiptRejectLines(ctx, {
      grId: gr.id,
      lineIds: [withLines.lines[0].id],
      reason: 'Transportschaden',
      idempotencyKey: 'r-reject',
    }),
    'reject',
  ).goodsReceipt;

  assert.equal(count(ctx, 'stock_movement'), 0, 'a rejected quantity never entered stock');
  assert.equal(receivedQty(ctx, w.poLineId), 0, 'the ordered quantity stays open for a later delivery');
  assert.equal(rejected.lines[0].inspectionStatus, 'rejected');
  assert.equal(rejected.lines[0].rejectReason, 'Transportschaden');
  assert.equal(goodsReceiptRejectLines(ctx, { grId: gr.id, lineIds: [withLines.lines[0].id], idempotencyKey: 'r-r2' }).error, 'invalid_input');
});

test('I02: a non-stock PO line advances the ordered quantity and mints no movement', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'n', qty: 3, trackStock: false });
  const gr = draft(ctx, w, 'n');
  addLine(ctx, gr.id, w.poLineId, 3, 'n');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'n-post' }), 'post');

  assert.equal(count(ctx, 'stock_movement'), 0, 'nothing physical to move');
  assert.equal(receivedQty(ctx, w.poLineId), 3);
  assert.equal(count(ctx, 'goods_receipt_line'), 1, 'the trail still records the receipt');
  assert.equal(
    ctx.store.db.prepare('SELECT stock_movement_id FROM goods_receipt_line WHERE workspace_id = ?').get(ctx.workspaceId).stock_movement_id,
    null,
  );
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after a non-stock receipt');
});

test('I02: TWO doc lines against ONE order line preview exactly as they post, under a hard ceiling', () => {
  const { ctx } = freshCtx();
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: false, idempotencyKey: 'm1-cfg' }), 'setConfig');
  const w = sentPo(ctx, { seed: 'm1', qty: 8 });
  const gr = draft(ctx, w, 'm1');
  // The routine shape: one delivery split across two lots / locations / serials, so two receipt
  // lines land on ONE order line. 5 + 5 against an open 8 must NOT preview clean.
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: gr.id,
      ops: [
        { op: 'add', poLineId: w.poLineId, qty: 5 },
        { op: 'add', poLineId: w.poLineId, qty: 5 },
      ],
      idempotencyKey: 'm1-lines',
    }),
    'upsert',
  );

  const preview = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview');
  assert.equal(preview.postable, false, 'the second line cannot fit once the first has taken 5');
  assert.deepEqual(preview.lines[0].issues, [], 'the first line fits');
  assert.deepEqual(preview.lines[1].issues, ['qty_exceeds_open'], 'the second does not');
  assert.equal(preview.lines[1].alreadyReceived, 5, 'the tally carries the first line forward');
  assert.equal(preview.lines[1].open, 3);

  // And the post agrees, line for line, which is the whole contract the Studio leans on.
  const refused = goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'm1-post' });
  assert.equal(refused.error, 'qty_exceeds_open');
  assert.equal(refused.lineId, preview.lines[1].lineId, 'the same line the preview named');
  assert.equal(refused.open, 3);

  // A line the post would REFUSE consumes NOTHING, because the post never gets past it and the whole
  // receipt rolls back. Ordered 8 with lines [9, 2] is the shape that shows it: if the refused 9 were
  // tallied anyway, the second line would be judged against an open of -1 and reported as a second
  // failure that the post will never actually reach.
  const second = draft(ctx, w, 'm1b');
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: second.id,
      ops: [
        { op: 'add', poLineId: w.poLineId, qty: 9 },
        { op: 'add', poLineId: w.poLineId, qty: 2 },
      ],
      idempotencyKey: 'm1b-lines',
    }),
    'upsert',
  );
  const spill = must(goodsReceiptPreview(ctx, { grId: second.id }), 'preview [9, 2]');
  assert.deepEqual(spill.lines[0].issues, ['qty_exceeds_open'], 'the 9 does not fit into 8');
  assert.deepEqual(spill.lines[1].issues, [], 'and the 2 behind it is not blamed for it');
  assert.deepEqual(
    spill.lines.map((l) => l.alreadyReceived),
    [0, 0],
    'the refused line tallied nothing',
  );
  assert.deepEqual(
    spill.lines.map((l) => l.open),
    [8, 8],
    'so no line is ever judged against a negative open quantity',
  );
  assert.equal(count(ctx, 'stock_movement'), 0);
});

test('I02: TWO doc lines against ONE order line agree under the accept-and-flag posture too', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'm2', qty: 8 });
  const gr = draft(ctx, w, 'm2');
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: gr.id,
      ops: [
        { op: 'add', poLineId: w.poLineId, qty: 5 },
        { op: 'add', poLineId: w.poLineId, qty: 5 },
      ],
      idempotencyKey: 'm2-lines',
    }),
    'upsert',
  );

  // The default posture accepts both, and the SECOND line is where the excess lands (5 fits into 8,
  // the next 5 takes 3 more than the 3 that were left). A preview that judged both against the
  // stored counter would report no exception at all and be wrong twice over.
  const preview = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview');
  assert.equal(preview.postable, true);
  assert.deepEqual(
    preview.lines.map((l) => l.overReceiptQty),
    [0, 2],
  );

  const posted = must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'm2-post' }), 'post').goodsReceipt;
  assert.deepEqual(
    posted.lines.map((l) => l.overReceiptQty),
    [0, 2],
    'the post records exactly what the preview promised',
  );
  assert.equal(posted.hasOverReceipt, true);
  assert.equal(receivedQty(ctx, w.poLineId), 10);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after two lines on one order line');
});

test('I02: preview is pure, and it names exactly the code the post would refuse with', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'p2', qty: 6 });
  const gr = draft(ctx, w, 'p2');
  addLine(ctx, gr.id, w.poLineId, 9, 'p2');

  const rowsBefore = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n;
  const preview = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview');
  const again = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview twice');
  assert.deepEqual(preview.lines, again.lines, 'a pure read answers the same twice');
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, rowsBefore, 'preview writes nothing');

  // Under the DEFAULT posture the over-delivery is REPORTED but is not an issue, because it posts.
  assert.equal(preview.postable, true);
  assert.deepEqual(preview.lines[0].issues, []);
  assert.equal(preview.lines[0].ordered, 6);
  assert.equal(preview.lines[0].open, 6);
  assert.equal(preview.lines[0].ceiling, null, 'uncapped');
  assert.equal(preview.lines[0].proposed, 9);
  assert.equal(preview.lines[0].overReceipt, true);
  assert.equal(preview.lines[0].overReceiptQty, 3);

  // With a hard ceiling the SAME draft becomes unpostable, and the preview names exactly the code
  // the post refuses with. That equality is the whole contract a Studio leans on.
  must(goodsReceiptSetConfig(ctx, { allowOverReceipt: false, idempotencyKey: 'p2-cfg' }), 'setConfig');
  const capped = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview capped');
  assert.equal(capped.postable, false);
  assert.deepEqual(capped.lines[0].issues, ['qty_exceeds_open']);
  assert.equal(capped.lines[0].overReceiptQty, 0, 'nothing is flagged for a line that will not post');
  assert.equal(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'p2-post' }).error, 'qty_exceeds_open');

  // Correct the line and the preview flips, with the value total in Rappen.
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: gr.id,
      ops: [{ op: 'change', lineId: preview.lines[0].lineId, qty: 6 }],
      idempotencyKey: 'p2-fix',
    }),
    'change',
  );
  const fixed = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview fixed');
  assert.equal(fixed.postable, true);
  assert.equal(fixed.lines[0].overReceiptQty, 0);
  assert.deepEqual(fixed.lines[0].issues, []);
  assert.equal(fixed.valueRappen, 60000, '6 units at CHF 100.00 base');
});

test('I02: lines_for_match returns only recognised, non-reversed, not-yet-billed lines (the I04 contract)', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'm', qty: 12 });
  const gr = draft(ctx, w, 'm');
  const withLines = must(
    goodsReceiptUpsertLines(ctx, {
      grId: gr.id,
      ops: [
        { op: 'add', poLineId: w.poLineId, qty: 4 },
        { op: 'add', poLineId: w.poLineId, qty: 2, inspectionStatus: 'pending' },
      ],
      idempotencyKey: 'm-lines',
    }),
    'upsert',
  ).goodsReceipt;
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'm-post' }), 'post');

  const open = must(goodsReceiptLinesForMatch(ctx, { poLineIds: [w.poLineId] }), 'match').lines;
  assert.equal(open.length, 1, 'the held line is not billable');
  assert.equal(open[0].id, withLines.lines[0].id);
  assert.equal(open[0].openQty, 4);
  assert.equal(open[0].unitCostRappen, 10000);

  // A fully billed line drops out, and a reversed receipt drops out entirely.
  ctx.store.db
    .prepare('UPDATE goods_receipt_doc_line SET billed_qty = 4 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, withLines.lines[0].id);
  assert.deepEqual(must(goodsReceiptLinesForMatch(ctx, { poLineIds: [w.poLineId] }), 'match billed').lines, []);

  const second = draft(ctx, w, 'm2');
  addLine(ctx, second.id, w.poLineId, 3, 'm2');
  must(goodsReceiptPost(ctx, { grId: second.id, idempotencyKey: 'm2-post' }), 'post second');
  assert.equal(must(goodsReceiptLinesForMatch(ctx, { poLineIds: [w.poLineId] }), 'match second').lines.length, 1);
  must(goodsReceiptReverse(ctx, { grId: second.id, reason: 'Irrtum', idempotencyKey: 'm2-rev' }), 'reverse second');
  assert.deepEqual(must(goodsReceiptLinesForMatch(ctx, { poLineIds: [w.poLineId] }), 'match reversed').lines, []);
});

test('I02: a draft can be cancelled and a cancelled receipt is inert', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'x' });
  const gr = draft(ctx, w, 'x');
  addLine(ctx, gr.id, w.poLineId, 2, 'x');

  const cancelled = must(goodsReceiptCancel(ctx, { grId: gr.id, reason: 'Lieferung storniert', idempotencyKey: 'x-c' }), 'cancel')
    .goodsReceipt;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(count(ctx, 'stock_movement'), 0);
  assert.equal(receivedQty(ctx, w.poLineId), 0);
  assert.equal(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'x-p' }).error, 'invalid_transition');
});

test('I02: a receipt against an order with nothing open is refused, and the numbering is a gap-free per-year series', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'z', qty: 2 });
  const one = draft(ctx, w, 'z1');
  assert.equal(one.number, 'GR-2026-0001');
  addLine(ctx, one.id, w.poLineId, 2, 'z1');
  must(goodsReceiptPost(ctx, { grId: one.id, idempotencyKey: 'z1-post' }), 'post');

  const refused = goodsReceiptCreate(ctx, { poId: w.poId, receivedAt: RECEIVED_AT, idempotencyKey: 'z2-create' });
  assert.equal(refused.error, 'nothing_open');

  // Reversing reopens the quantity, and the next document takes the next number.
  must(goodsReceiptReverse(ctx, { grId: one.id, reason: 'Irrtum', idempotencyKey: 'z1-rev' }), 'reverse');
  const two = must(goodsReceiptCreate(ctx, { poId: w.poId, receivedAt: RECEIVED_AT, idempotencyKey: 'z3-create' }), 'create again')
    .goodsReceipt;
  assert.equal(two.number, 'GR-2026-0002');
});

// --- the shared trail carries the RECEIPT's date, which is the whole reason I02 writes it ----------

test('I02: both trail headers are dated to the RECEIPT, and B03 dated derivation follows it and its reversal', () => {
  // The clock is 2026-03-01 and the RECEIPT is 2026-03-04: deliberately DIFFERENT, so a trail header
  // written with `now` instead of the receipt's own date is visible to the assertions below rather
  // than hidden behind two dates that happen to coincide.
  const { ctx } = freshCtx('2026-03-01T00:00:00.000Z');
  const vendorId = must(createContact(ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'tp-v' }), 'contact').contact.id;
  const projectId = must(
    createProject(ctx, { name: 'Umbau Werkhalle', contactId: vendorId, idempotencyKey: 'tp-proj' }),
    'createProject',
  ).project.id;
  const itemId = must(createItem(ctx, { name: 'Rohstoff TP', defaultUnitPriceMinor: 12000, trackStock: true, idempotencyKey: 'tp-i' }), 'item').item.id;
  const locationId = must(inventoryEnsureDefaultLocation(ctx), 'ensureDefaultLocation').location.id;
  // A PROJECT-TAGGED order line, which is what B03 re-derives a DATED received quantity for.
  const po = must(
    poUpsert(ctx, {
      supplierContactId: vendorId,
      lines: [{ itemId, qty: 6, unitPriceRappen: 10000, projectId }],
      idempotencyKey: 'tp-po',
    }),
    'poUpsert',
  );
  must(poSend(ctx, { poId: po.poId, idempotencyKey: 'tp-send' }), 'poSend');
  const poLineId = ctx.store.db.prepare('SELECT id FROM po_line WHERE workspace_id = ? AND po_id = ?').get(ctx.workspaceId, po.poId).id;

  const gr = must(
    goodsReceiptCreate(ctx, { poId: po.poId, receivedAt: RECEIVED_AT, defaultLocationId: locationId, idempotencyKey: 'tp-gr' }),
    'create',
  ).goodsReceipt;
  must(goodsReceiptUpsertLines(ctx, { grId: gr.id, ops: [{ op: 'add', poLineId, qty: 6 }], idempotencyKey: 'tp-line' }), 'upsert');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: 'tp-post' }), 'post');

  // (1) The recognition header is dated to the RECEIPT (2026-03-04), never to this test's clock
  // (2026-03-01), which is why the two were set to different days.
  assert.deepEqual(trailDates(ctx), [RECEIVED_AT], 'the recognition trail header carries the receipt date');

  // (2) And that date is what B03's asOf derivation actually reads: 6 units at CHF 100.00 base. This
  // is the assertion that makes writing D02's tables at all worth anything.
  const march = must(costingProjectPl(ctx, { projectId, asOf: '2026-03-31' }), 'pl at 2026-03-31');
  assert.equal(march.costBreakdown.accruedPurchasesMinor, 60000, 'the March receipt is inside a March cut');
  // A cut on 2026-03-02 still includes the ORDER (created 2026-03-01) but not the RECEIPT
  // (2026-03-04), so this discriminates on the trail header's date and nothing else.
  const before = must(costingProjectPl(ctx, { projectId, asOf: '2026-03-02' }), 'pl at 2026-03-02');
  assert.equal(before.costBreakdown.accruedPurchasesMinor, 0, 'and outside a cut that predates it');

  must(goodsReceiptReverse(ctx, { grId: gr.id, reason: 'Fehllieferung', idempotencyKey: 'tp-rev' }), 'reverse');

  // (3) The REVERSAL header carries the same receipt date, so the negative row lands in the same
  // period as the positive one it compensates. Dating it "now" would leave B03's March figure
  // permanently claiming goods that were handed back, while the J02 compensating movement (also
  // dated to the receipt) said otherwise: the two would disagree for good.
  assert.deepEqual(trailDates(ctx), [RECEIVED_AT, RECEIVED_AT], 'the reversal trail header carries it too');
  const afterReversal = must(costingProjectPl(ctx, { projectId, asOf: '2026-03-31' }), 'pl after the reversal');
  assert.equal(afterReversal.costBreakdown.accruedPurchasesMinor, 0, 'the March cut follows the reversal');
  assertTrailAgreesWithCounter(ctx, poLineId, 'after the reversal');
});

// --- the preview's `issues` contract: EVERY code the post can refuse with, or the claim is false --

/**
 * The guard against the one real cost of `previewTrackingIssue` being a MIRROR of a J02 function
 * this module may not call: drift. Every case below drives the preview AND the post and asserts they
 * name the same code, so a change to J02's rules reddens `receipt.ts` rather than silently making
 * the preview optimistic again.
 */
function assertPreviewMatchesPost(ctx, grId, expected, label) {
  const preview = must(goodsReceiptPreview(ctx, { grId }), `${label}: preview`);
  const lineIssues = preview.lines.flatMap((l) => l.issues);
  const all = [...preview.issues, ...lineIssues];
  assert.equal(preview.postable, false, `${label}: preview must not call this postable`);
  assert.ok(all.includes(expected), `${label}: preview should name ${expected}, got ${JSON.stringify(all)}`);
  const posted = goodsReceiptPost(ctx, { grId, idempotencyKey: `${label}-post` });
  assert.equal(posted.ok, false, `${label}: the post must refuse`);
  assert.equal(posted.error, expected, `${label}: the post refuses with the code the preview named`);
  assert.equal(count(ctx, 'stock_movement'), 0, `${label}: and nothing was written`);
}

function trackedWorld(ctx, seed, mode) {
  const vendorId = must(createContact(ctx, { partyRole: 'vendor', name: 'Lieferant', idempotencyKey: `${seed}-v` }), 'contact').contact.id;
  const itemId = must(createItem(ctx, { name: `Teil ${seed}`, defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: `${seed}-i` }), 'item').item.id;
  must(itemSetTrackingMode(ctx, { itemId, mode, idempotencyKey: `${seed}-m` }), 'trackingMode');
  const locationId = must(inventoryEnsureDefaultLocation(ctx), 'ensureDefaultLocation').location.id;
  const po = must(
    poUpsert(ctx, { supplierContactId: vendorId, lines: [{ itemId, qty: 4, unitPriceRappen: 1000 }], idempotencyKey: `${seed}-po` }),
    'poUpsert',
  );
  must(poSend(ctx, { poId: po.poId, idempotencyKey: `${seed}-send` }), 'poSend');
  const poLineId = ctx.store.db.prepare('SELECT id FROM po_line WHERE workspace_id = ? AND po_id = ?').get(ctx.workspaceId, po.poId).id;
  const gr = must(
    goodsReceiptCreate(ctx, { poId: po.poId, receivedAt: RECEIVED_AT, defaultLocationId: locationId, idempotencyKey: `${seed}-gr` }),
    'create',
  ).goodsReceipt;
  return { vendorId, itemId, locationId, poId: po.poId, poLineId, grId: gr.id };
}

test('I02: the preview names lot_required, exactly as the post refuses it', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'lq', 'lot');
  must(
    goodsReceiptUpsertLines(ctx, { grId: w.grId, ops: [{ op: 'add', poLineId: w.poLineId, qty: 2 }], idempotencyKey: 'lq-line' }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'lot_required', 'lq');
});

test('I02: the preview names serial_required, exactly as the post refuses it', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'sq', 'serial');
  must(
    goodsReceiptUpsertLines(ctx, { grId: w.grId, ops: [{ op: 'add', poLineId: w.poLineId, qty: 1 }], idempotencyKey: 'sq-line' }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'serial_required', 'sq');
});

test('I02: the preview names lot_item_mismatch for a same-workspace lot of ANOTHER item', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'lm', 'lot');
  // A real lot of THIS workspace, so the draft-time reference check admits it (by design: it checks
  // existence and tenancy, not ownership), belonging to a different item.
  const otherItem = must(createItem(ctx, { name: 'Anderes Teil', defaultUnitPriceMinor: 500, trackStock: true, idempotencyKey: 'lm-oi' }), 'item').item.id;
  must(itemSetTrackingMode(ctx, { itemId: otherItem, mode: 'lot', idempotencyKey: 'lm-om' }), 'trackingMode');
  const foreignLot = must(lotCreate(ctx, { itemId: otherItem, number: 'CH-999', idempotencyKey: 'lm-ol' }), 'lotCreate').lot.id;

  must(
    goodsReceiptUpsertLines(ctx, {
      grId: w.grId,
      ops: [{ op: 'add', poLineId: w.poLineId, qty: 2, lotId: foreignLot }],
      idempotencyKey: 'lm-line',
    }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'lot_item_mismatch', 'lm');
});

test('I02: the preview names period_locked on the DOCUMENT when the receipt month is sealed', () => {
  const { ctx } = freshCtx();
  const w = sentPo(ctx, { seed: 'pl', qty: 4 });
  const gr = draft(ctx, w, 'pl');
  addLine(ctx, gr.id, w.poLineId, 2, 'pl');
  // Clean while the month is open.
  assert.equal(must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview open').postable, true);

  must(lockPeriod(ctx, { period: '2026-03', kind: 'hard', reason: 'vat_filed', idempotencyKey: 'pl-lock' }), 'lockPeriod');

  const preview = must(goodsReceiptPreview(ctx, { grId: gr.id }), 'preview locked');
  // A sealed period is a DOCUMENT-level refusal, not a property of any one line.
  assert.deepEqual(preview.issues, ['period_locked']);
  assert.deepEqual(preview.lines[0].issues, [], 'the line itself is fine');
  assert.equal(preview.postable, false);
  assertPreviewMatchesPost(ctx, gr.id, 'period_locked', 'pl');
});

test('I02: a lot- and serial-tracked line that carries BOTH identifiers previews and posts clean', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'ok', 'lot_and_serial');
  const lotId = must(lotCreate(ctx, { itemId: w.itemId, number: 'CH-2026-07', idempotencyKey: 'ok-lot' }), 'lotCreate').lot.id;
  const serialId = must(serialCreate(ctx, { itemId: w.itemId, number: 'SN-1', lotId, idempotencyKey: 'ok-ser' }), 'serialCreate').serial.id;
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: w.grId,
      // A serial is a unit of one, so the quantity is 1.
      ops: [{ op: 'add', poLineId: w.poLineId, qty: 1, lotId, serialId }],
      idempotencyKey: 'ok-line',
    }),
    'upsert',
  );

  const preview = must(goodsReceiptPreview(ctx, { grId: w.grId }), 'preview');
  assert.deepEqual(preview.issues, []);
  assert.deepEqual(preview.lines[0].issues, []);
  assert.equal(preview.postable, true, 'a complete tracked line is postable, so the mirror is not just refusing everything');
  must(goodsReceiptPost(ctx, { grId: w.grId, idempotencyKey: 'ok-post' }), 'post');
  assert.equal(count(ctx, 'stock_movement'), 1);
  assertTrailAgreesWithCounter(ctx, w.poLineId, 'after a tracked receipt');
});

test('I02: the preview names invalid_qty for a serial line of more than one unit', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'uq', 'serial');
  const serialId = must(serialCreate(ctx, { itemId: w.itemId, number: 'SN-Q', idempotencyKey: 'uq-ser' }), 'serialCreate').serial.id;
  // A serial is a unit of one, but `goods_receipt_upsert_lines` accepts any integer above zero, so
  // this draft is representable and the Studio drawer makes it easy to produce: mint a serial, leave
  // the quantity at the order's open quantity.
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: w.grId,
      ops: [{ op: 'add', poLineId: w.poLineId, qty: 2, serialId }],
      idempotencyKey: 'uq-line',
    }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'invalid_qty', 'uq');
});

test('I02: invalid_qty wins over lot_required, the ORDER the post applies its guards in', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'uo', 'lot_and_serial');
  const lotId = must(lotCreate(ctx, { itemId: w.itemId, number: 'CH-UO', idempotencyKey: 'uo-lot' }), 'lotCreate').lot.id;
  const serialId = must(
    serialCreate(ctx, { itemId: w.itemId, number: 'SN-UO', lotId, idempotencyKey: 'uo-ser' }),
    'serialCreate',
  ).serial.id;
  // BOTH rules are tripped: a serial line of 2, on a lot-tracked item, with no lot named. J02 runs
  // validateMoveInput before validateTracking, so the post says invalid_qty. A mirror that checked
  // the required-identifier rules first would name lot_required and be wrong in the other direction.
  must(
    goodsReceiptUpsertLines(ctx, {
      grId: w.grId,
      ops: [{ op: 'add', poLineId: w.poLineId, qty: 2, serialId }],
      idempotencyKey: 'uo-line',
    }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'invalid_qty', 'uo');
});

test('I02: the preview names serial_item_mismatch for a serial of ANOTHER item', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'sm', 'serial');
  // A real serial of THIS workspace (so the draft-time reference check admits it) on another item.
  const otherItem = must(createItem(ctx, { name: 'Anderes Teil', defaultUnitPriceMinor: 500, trackStock: true, idempotencyKey: 'sm-oi' }), 'item').item.id;
  must(itemSetTrackingMode(ctx, { itemId: otherItem, mode: 'serial', idempotencyKey: 'sm-om' }), 'trackingMode');
  const foreignSerial = must(serialCreate(ctx, { itemId: otherItem, number: 'SN-OTHER', idempotencyKey: 'sm-os' }), 'serialCreate').serial.id;

  must(
    goodsReceiptUpsertLines(ctx, {
      grId: w.grId,
      ops: [{ op: 'add', poLineId: w.poLineId, qty: 1, serialId: foreignSerial }],
      idempotencyKey: 'sm-line',
    }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'serial_item_mismatch', 'sm');
});

test('I02: the preview names lot_item_mismatch when a serial carries a DIFFERENT lot than the line', () => {
  const { ctx } = freshCtx();
  const w = trackedWorld(ctx, 'sl', 'lot_and_serial');
  const lotA = must(lotCreate(ctx, { itemId: w.itemId, number: 'CH-A', idempotencyKey: 'sl-la' }), 'lotCreate').lot.id;
  const lotB = must(lotCreate(ctx, { itemId: w.itemId, number: 'CH-B', idempotencyKey: 'sl-lb' }), 'lotCreate').lot.id;
  // The serial belongs to lot A; the line names lot B. Both belong to the right ITEM, so only J02's
  // last tracking rule catches it, and that rule sat outside the drift guard until now.
  const serialId = must(
    serialCreate(ctx, { itemId: w.itemId, number: 'SN-A', lotId: lotA, idempotencyKey: 'sl-ser' }),
    'serialCreate',
  ).serial.id;

  must(
    goodsReceiptUpsertLines(ctx, {
      grId: w.grId,
      ops: [{ op: 'add', poLineId: w.poLineId, qty: 1, lotId: lotB, serialId }],
      idempotencyKey: 'sl-line',
    }),
    'upsert',
  );
  assertPreviewMatchesPost(ctx, w.grId, 'lot_item_mismatch', 'sl');
});
