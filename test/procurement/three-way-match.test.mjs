/**
 * I04 three-way match money-path invariants (spec §7/§8). Written to BITE, on real ROW COUNTS and
 * summed quantities rather than a returned `ok:true`, because I04 gates payment and touches the
 * authoritative `po_line.billed_qty` counter.
 *
 * Covered:
 *  - NO POSTING (P3): a create/override/reverse writes ZERO journal_entry and ZERO stock_movement
 *    rows. A17 -> A02 stays the sole posting path.
 *  - BILLED-QTY IDENTITY: after a create, SUM(match_line.billed_qty) equals the rise in
 *    po_line.billed_qty for every affected line, and billed_qty never exceeds received_qty.
 *  - IDEMPOTENT ON ROWS (§H-IDEMPOTENT): a replayed create returns the same match id and increments
 *    billed_qty exactly once; a second create under a DIFFERENT key is refused (match_already_exists).
 *  - TOLERANCE BOUNDARY: at 2.0% passes (matched); one Rappen over blocks (out_of_tolerance).
 *  - OVERRIDE: a variance + reason is overridden and permanent; a missing reason is reason_required;
 *    the override capability is required.
 *  - REVERSE restores billed_qty to the EXACT pre-match value and cannot be re-run (match_not_reversible).
 *  - APPEND-ONLY (§H-AUDIT): the match header and lines are immutable (the schema triggers abort).
 *  - §H-TENANT: a cross-tenant bill/match is refused.
 *  - PAYMENT GATE: matchStatusForBill is canPay false until matched, true after.
 *  - I02 RECEIPT MARKING: a create marks the goods_receipt_doc_line billed, reverse un-marks it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import {
  matchThreeWayCreate,
  matchThreeWayOverride,
  matchThreeWayReverse,
} from '../../dist/core/procurement/index.js';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}
function refused(res, code, what) {
  assert.equal(res.ok, false, `${what} should be refused`);
  if (code !== undefined) assert.equal(res.error, code, `${what}: wrong error code (${JSON.stringify(res)})`);
  return res;
}

const count = (deps, table, workspaceId) =>
  deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
const billedQty = (deps, workspaceId, lineId) =>
  deps.store.db.prepare('SELECT billed_qty FROM po_line WHERE workspace_id = ? AND id = ?').get(workspaceId, lineId).billed_qty;

/** A workspace + vendor + stock item + location. */
function seed(key) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Einkauf AG', `i04-${key}`);
  const vendor = must(call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${key}-v` }), 'create_contact').contact.id;
  const item = must(call(deps, 'create_item', { workspaceId, name: 'Rohstoff', defaultUnitPriceMinor: 12000, idempotencyKey: `${key}-i` }), 'create_item').item.id;
  deps.store.db.prepare('UPDATE item SET track_stock = 1, cost_price_minor = ? WHERE workspace_id = ? AND id = ?').run(9000, workspaceId, item);
  const location = must(call(deps, 'stock_location_upsert', { workspaceId, name: 'Wareneingang', idempotencyKey: `${key}-l` }), 'stock_location_upsert').location.id;
  return { deps, workspaceId, accId, vendor, item, location };
}

/** A sent PO for `qty` units at net `unit` Rappen; returns po + first line id. */
function sentPo(s, key, qty, unit) {
  const po = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, lines: [{ itemId: s.item, qty, unitPriceRappen: unit }], idempotencyKey: `${key}-po` }), 'po_upsert');
  must(call(s.deps, 'po_send', { workspaceId: s.workspaceId, poId: po.poId, idempotencyKey: `${key}-send` }), 'po_send');
  const lineId = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: po.poId }).lines[0].id;
  return { poId: po.poId, lineId };
}

/** A CHF bill (amountIsGross false, no VAT) whose net is its base: convertible without posting. */
function chfBill(s, key, netRappen) {
  return must(
    call(s.deps, 'create_vendor_bill', { workspaceId: s.workspaceId, vendorId: s.vendor, billDate: '2026-03-05', amountMinor: netRappen, amountIsGross: false, expenseAccountId: s.accId('6500'), idempotencyKey: `${key}-bill` }),
    'create_vendor_bill',
  ).vendorBillId;
}

/** Receive `qty` via the D02 receipt path (increments po_line.received_qty). */
function receive(s, key, poId, lineId, qty) {
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty }], idempotencyKey: `${key}-r` }), 'receipt_record');
}

// --- happy path: create is inside tolerance and posts nothing -----------------------------------

test('I04 create: an in-tolerance match increments billed_qty exactly once and posts NOTHING', () => {
  const s = seed('happy');
  const { poId, lineId } = sentPo(s, 'happy', 10, 10000); // net total 100'000
  receive(s, 'happy', poId, lineId, 10);
  const billId = chfBill(s, 'happy', 100000); // exact PO value

  const jBefore = count(s.deps, 'journal_entry', s.workspaceId);
  const mBefore = count(s.deps, 'stock_movement', s.workspaceId);

  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  assert.equal(evaluation.status, 'matched', 'exact-value bill is matched');

  const created = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'happy-m' }), 'create');
  assert.equal(created.match.status, 'matched');

  // billed_qty rose by exactly the open qty, and equals the summed match-line billed_qty.
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 10, 'po_line.billed_qty == received');
  const lineSum = s.deps.store.db.prepare('SELECT COALESCE(SUM(billed_qty),0) AS n FROM three_way_match_line WHERE workspace_id = ? AND match_id = ?').get(s.workspaceId, created.match.id).n;
  assert.equal(lineSum, 10, 'SUM(match_line.billed_qty) == increase in po_line.billed_qty');

  // No posting: I04 wrote no journal entry and no stock movement.
  assert.equal(count(s.deps, 'journal_entry', s.workspaceId), jBefore, 'I04 posts no journal entry');
  assert.equal(count(s.deps, 'stock_movement', s.workspaceId), mBefore, 'I04 mints no stock movement');
  assert.equal(count(s.deps, 'three_way_match', s.workspaceId), 1, 'exactly one match header');
});

// --- idempotency on rows ------------------------------------------------------------------------

test('I04 create: a replay under the same key returns the same match and does NOT double-increment', () => {
  const s = seed('idem');
  const { poId, lineId } = sentPo(s, 'idem', 10, 10000);
  receive(s, 'idem', poId, lineId, 10);
  const billId = chfBill(s, 'idem', 100000);
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;

  const a = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'k1' }), 'create a');
  const b = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'k1' }), 'create b (replay)');
  assert.equal(a.match.id, b.match.id, 'replay returns the identical match id');
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 10, 'billed_qty incremented exactly once');
  assert.equal(count(s.deps, 'three_way_match', s.workspaceId), 1, 'no second header');
  assert.equal(count(s.deps, 'three_way_match_line', s.workspaceId), 1, 'no second line');

  // A second create under a DIFFERENT key is refused: a bill has at most one active match.
  refused(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'k2' }), 'match_already_exists', 'second create, new key');
});

// --- tolerance boundary -------------------------------------------------------------------------

test('I04 tolerance: at 2.0% the match passes; one Rappen over is out_of_tolerance', () => {
  const s = seed('tol');
  const { poId, lineId } = sentPo(s, 'tol', 10, 10000); // expected 100'000
  receive(s, 'tol', poId, lineId, 10);

  // 102'000 is exactly +2.0% -> inside -> matched.
  const atBill = chfBill(s, 'tolA', 102000);
  const atEval = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId: atBill }), 'evaluate at').evaluation;
  assert.equal(atEval.status, 'matched', 'exactly 2.0% is inside tolerance');
  must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId: atBill, evaluation: atEval, idempotencyKey: 'tolA-m' }), 'create at boundary');

  // A fresh PO/bill: 102'001 is +2.001% -> variance -> create refused.
  const s2 = seed('tol2');
  const po2 = sentPo(s2, 'tol2', 10, 10000);
  receive(s2, 'tol2', po2.poId, po2.lineId, 10);
  const overBill = chfBill(s2, 'tol2', 102001);
  const overEval = must(call(s2.deps, 'match_three_way_evaluate', { workspaceId: s2.workspaceId, billId: overBill }), 'evaluate over').evaluation;
  assert.equal(overEval.status, 'variance', 'one Rappen over 2.0% is a variance');
  refused(call(s2.deps, 'match_three_way_create', { workspaceId: s2.workspaceId, billId: overBill, evaluation: overEval, idempotencyKey: 'tol2-m' }), 'out_of_tolerance', 'create over tolerance');
  assert.equal(billedQty(s2.deps, s2.workspaceId, po2.lineId), 0, 'a refused create increments nothing');
});

// --- override -----------------------------------------------------------------------------------

test('I04 override: a variance needs a reason and the override capability, and is permanent', () => {
  const s = seed('ovr');
  const { poId, lineId } = sentPo(s, 'ovr', 10, 10000);
  receive(s, 'ovr', poId, lineId, 10);
  const billId = chfBill(s, 'ovr', 120000); // +20% variance
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  assert.equal(evaluation.status, 'variance');

  // Missing reason -> reason_required, nothing written.
  refused(call(s.deps, 'match_three_way_override', { workspaceId: s.workspaceId, billId, evaluation, reason: '', idempotencyKey: 'ovr-x' }), 'reason_required', 'override without reason');
  assert.equal(count(s.deps, 'three_way_match', s.workspaceId), 0, 'no header after reason_required');

  const ovr = must(call(s.deps, 'match_three_way_override', { workspaceId: s.workspaceId, billId, evaluation, reason: 'Preisdifferenz vereinbart', idempotencyKey: 'ovr-1' }), 'override');
  assert.equal(ovr.match.status, 'overridden');
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 10, 'override still consumes the open qty');
  // Permanent: no clean re-match of the same bill.
  refused(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'ovr-2' }), 'match_already_exists', 'clean create over an overridden bill');
});

test('I04 override: the engine gate requires purchasing.match_override (engine-level port)', () => {
  const s = seed('ovrcap');
  const { poId, lineId } = sentPo(s, 'ovrcap', 10, 10000);
  receive(s, 'ovrcap', poId, lineId, 10);
  const billId = chfBill(s, 'ovrcap', 120000);

  // A context that holds purchasing.match but NOT purchasing.match_override.
  const ctx = makeContext(s.deps.store, {
    workspaceId: s.workspaceId,
    actor: 'studio',
    clock: s.deps.clock,
    ids: s.deps.ids,
    capabilities: { assert: (cap) => (cap === 'purchasing.match_override' ? { ok: false, error: 'permission_denied' } : { ok: true }) },
  });
  refused(matchThreeWayOverride(ctx, { billId, reason: 'Preisdifferenz vereinbart', idempotencyKey: 'cap-1' }), 'permission_denied', 'override without the override capability');
  // And create is denied without purchasing.match.
  const ctx2 = makeContext(s.deps.store, {
    workspaceId: s.workspaceId,
    actor: 'studio',
    clock: s.deps.clock,
    ids: s.deps.ids,
    capabilities: { assert: (cap) => (cap === 'purchasing.match' ? { ok: false, error: 'permission_denied' } : { ok: true }) },
  });
  refused(matchThreeWayCreate(ctx2, { billId, idempotencyKey: 'cap-2' }), 'permission_denied', 'create without the match capability');
});

// --- reverse ------------------------------------------------------------------------------------

test('I04 reverse: restores billed_qty to the EXACT pre-match value and cannot be re-run', () => {
  const s = seed('rev');
  const { poId, lineId } = sentPo(s, 'rev', 10, 10000);
  receive(s, 'rev', poId, lineId, 10);
  const billId = chfBill(s, 'rev', 100000);
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  const created = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'rev-m' }), 'create');
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 10);

  const rev = must(call(s.deps, 'match_three_way_reverse', { workspaceId: s.workspaceId, matchId: created.match.id, reason: 'Falsche Zuordnung', idempotencyKey: 'rev-r' }), 'reverse');
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 0, 'billed_qty restored to the pre-match value');
  assert.equal(rev.reversing.status, 'reversed');

  // Idempotent replay: no second reversing record, billed_qty unchanged.
  must(call(s.deps, 'match_three_way_reverse', { workspaceId: s.workspaceId, matchId: created.match.id, reason: 'Falsche Zuordnung', idempotencyKey: 'rev-r' }), 'reverse replay');
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 0, 'replay does not double-adjust');
  assert.equal(count(s.deps, 'three_way_match', s.workspaceId), 2, 'exactly the original + one reversing record');

  // A reversed match cannot be reversed again, and the bill can be freshly re-matched.
  refused(call(s.deps, 'match_three_way_reverse', { workspaceId: s.workspaceId, matchId: created.match.id, reason: 'Nochmal', idempotencyKey: 'rev-r2' }), 'match_not_reversible', 're-reverse');
  const eval2 = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate 2').evaluation;
  must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation: eval2, idempotencyKey: 'rev-m2' }), 're-create after reverse');
  assert.equal(billedQty(s.deps, s.workspaceId, lineId), 10, 'the fresh match consumes the open qty again');
});

// --- append-only (the triggers bite) ------------------------------------------------------------

test('I04 append-only: the match header and lines are immutable (schema triggers abort)', () => {
  const s = seed('imm');
  const { poId, lineId } = sentPo(s, 'imm', 10, 10000);
  receive(s, 'imm', poId, lineId, 10);
  const billId = chfBill(s, 'imm', 100000);
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  const created = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'imm-m' }), 'create');

  assert.throws(
    () => s.deps.store.db.prepare("UPDATE three_way_match SET status = 'reversed' WHERE workspace_id = ? AND id = ?").run(s.workspaceId, created.match.id),
    /append-only/,
    'a status rewrite on the header is refused',
  );
  assert.throws(
    () => s.deps.store.db.prepare('UPDATE three_way_match_line SET billed_qty = 999 WHERE workspace_id = ? AND match_id = ?').run(s.workspaceId, created.match.id),
    /append-only/,
    'a line edit is refused',
  );
  assert.throws(
    () => s.deps.store.db.prepare('DELETE FROM three_way_match_line WHERE workspace_id = ? AND match_id = ?').run(s.workspaceId, created.match.id),
    /append-only/,
    'a line delete is refused',
  );
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('I04 tenant: a bill in another workspace is invisible to create/evaluate', () => {
  // Two workspaces in ONE store.
  const deps = freshDeps();
  deps.actor = 'studio';
  const a = mintWorkspace(deps, 'A GmbH', 'i04-tenant-a');
  const b = mintWorkspace(deps, 'B GmbH', 'i04-tenant-b');
  const vendorA = must(call(deps, 'create_contact', { workspaceId: a.workspaceId, partyRole: 'vendor', name: 'Lieferant A', idempotencyKey: 'ta-v' }), 'contact A').contact.id;
  const itemA = must(call(deps, 'create_item', { workspaceId: a.workspaceId, name: 'Rohstoff A', defaultUnitPriceMinor: 12000, idempotencyKey: 'ta-i' }), 'item A').item.id;
  deps.store.db.prepare('UPDATE item SET track_stock = 1 WHERE workspace_id = ? AND id = ?').run(a.workspaceId, itemA);
  const locA = must(call(deps, 'stock_location_upsert', { workspaceId: a.workspaceId, name: 'WE', idempotencyKey: 'ta-l' }), 'loc A').location.id;
  const poA = must(call(deps, 'po_upsert', { workspaceId: a.workspaceId, supplierContactId: vendorA, lines: [{ itemId: itemA, qty: 5, unitPriceRappen: 10000 }], idempotencyKey: 'ta-po' }), 'po A');
  must(call(deps, 'po_send', { workspaceId: a.workspaceId, poId: poA.poId, idempotencyKey: 'ta-send' }), 'send A');
  const lineA = call(deps, 'po_get', { workspaceId: a.workspaceId, poId: poA.poId }).lines[0].id;
  must(call(deps, 'receipt_record', { workspaceId: a.workspaceId, poId: poA.poId, locationId: locA, lines: [{ poLineId: lineA, qty: 5 }], idempotencyKey: 'ta-r' }), 'receive A');
  const billA = must(call(deps, 'create_vendor_bill', { workspaceId: a.workspaceId, vendorId: vendorA, billDate: '2026-03-05', amountMinor: 50000, amountIsGross: false, expenseAccountId: a.accId('6500'), idempotencyKey: 'ta-bill' }), 'bill A').vendorBillId;

  // Workspace B cannot see A's bill.
  refused(call(deps, 'match_three_way_evaluate', { workspaceId: b.workspaceId, billId: billA }), 'not_found', 'B evaluates A bill');
  refused(call(deps, 'match_three_way_create', { workspaceId: b.workspaceId, billId: billA, idempotencyKey: 'tb-m' }), 'not_found', 'B creates over A bill');
  assert.equal(billedQty(deps, a.workspaceId, lineA), 0, 'A billed_qty untouched by B');
});

// --- payment gate -------------------------------------------------------------------------------

test('I04 payment gate: match_status_for_bill is canPay false until matched, then true', () => {
  const s = seed('pay');
  const { poId, lineId } = sentPo(s, 'pay', 10, 10000);
  receive(s, 'pay', poId, lineId, 10);
  const billId = chfBill(s, 'pay', 100000);

  const before = must(call(s.deps, 'match_status_for_bill', { workspaceId: s.workspaceId, billId }), 'status before');
  assert.equal(before.status, 'unmatched');
  assert.equal(before.canPay, false, 'an unmatched bill is not payable through the gate');

  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'pay-m' }), 'create');

  const after = must(call(s.deps, 'match_status_for_bill', { workspaceId: s.workspaceId, billId }), 'status after');
  assert.equal(after.status, 'matched');
  assert.equal(after.canPay, true, 'a matched bill is payable');
});

// --- exceptions ---------------------------------------------------------------------------------

test('I04 exceptions: a posted variance bill appears with the amount at risk', () => {
  const s = seed('exc');
  const { poId, lineId } = sentPo(s, 'exc', 10, 10000);
  receive(s, 'exc', poId, lineId, 10);
  const billId = chfBill(s, 'exc', 120000); // +20'000 variance
  const list = must(call(s.deps, 'match_three_way_exceptions', { workspaceId: s.workspaceId }), 'exceptions');
  const row = list.exceptions.find((e) => e.billId === billId);
  assert.ok(row, 'the variance bill is listed');
  assert.equal(row.status, 'variance');
  assert.equal(row.amountAtRiskRappen, 20000, 'the amount at risk is the value variance');
});

// --- I02 receipt-line marking -------------------------------------------------------------------

test('I04 marks the I02 receipt line billed on create and un-marks it on reverse', () => {
  const s = seed('gr');
  const { poId, lineId } = sentPo(s, 'gr', 10, 10000);
  // Receive through the I02 goods-receipt document path so a goods_receipt_doc_line exists.
  const gr = must(call(s.deps, 'goods_receipt_create', { workspaceId: s.workspaceId, poId, receivedAt: '2026-03-04', defaultLocationId: s.location, idempotencyKey: 'gr-c' }), 'gr create').goodsReceipt;
  must(call(s.deps, 'goods_receipt_upsert_lines', { workspaceId: s.workspaceId, grId: gr.id, ops: [{ op: 'add', poLineId: lineId, qty: 10 }], idempotencyKey: 'gr-l' }), 'gr lines');
  must(call(s.deps, 'goods_receipt_post', { workspaceId: s.workspaceId, grId: gr.id, idempotencyKey: 'gr-p' }), 'gr post');

  const grLineBilled = () => s.deps.store.db.prepare('SELECT billed_qty FROM goods_receipt_doc_line WHERE workspace_id = ? AND po_line_id = ?').get(s.workspaceId, lineId).billed_qty;
  assert.equal(grLineBilled(), 0, 'receipt line starts un-billed');

  const billId = chfBill(s, 'gr', 100000);
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  const created = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'gr-m' }), 'create');
  assert.equal(grLineBilled(), 10, 'create marks the I02 receipt line billed');

  must(call(s.deps, 'match_three_way_reverse', { workspaceId: s.workspaceId, matchId: created.match.id, reason: 'Rückabwicklung', idempotencyKey: 'gr-rv' }), 'reverse');
  assert.equal(grLineBilled(), 0, 'reverse un-marks the receipt line');
});

// --- advisory quantity tolerance (owner decision 2026-08-16, spec §0.8) -------------------------

test('I04 advisory quantity tolerance: a correctly-priced over-delivery stays matched and payable, and the line surfaces the variance', () => {
  const s = seed('over');
  const { poId, lineId } = sentPo(s, 'over', 10, 10000); // ordered 10 @ 10'000 -> expected 100'000
  // An over-delivery through the I02 goods-receipt path: 12 received vs 10 ordered (+20%, far past the
  // 2.0% quantity tolerance). The I02 path accepts and flags an over-delivery by default (owner decision
  // 11.08.2026) and writes po_line.received_qty = 12, the authoritative accepted quantity (spec §0.3).
  const gr = must(call(s.deps, 'goods_receipt_create', { workspaceId: s.workspaceId, poId, receivedAt: '2026-03-04', defaultLocationId: s.location, idempotencyKey: 'over-c' }), 'gr create').goodsReceipt;
  must(call(s.deps, 'goods_receipt_upsert_lines', { workspaceId: s.workspaceId, grId: gr.id, ops: [{ op: 'add', poLineId: lineId, qty: 12 }], idempotencyKey: 'over-l' }), 'gr lines');
  must(call(s.deps, 'goods_receipt_post', { workspaceId: s.workspaceId, grId: gr.id, idempotencyKey: 'over-p' }), 'gr post');
  const receivedQty = s.deps.store.db.prepare('SELECT received_qty FROM po_line WHERE workspace_id = ? AND id = ?').get(s.workspaceId, lineId).received_qty;
  assert.equal(receivedQty, 12, 'the over-delivery is accepted onto po_line.received_qty');

  // The vendor bills the RECEIVED quantity at the correct unit price: 12 * 10'000 = 120'000. The value leg
  // is exact, so the header is matched even though the quantity is 20% over (advisory tolerance, spec §0.8).
  const billId = chfBill(s, 'over', 120000);
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  assert.equal(evaluation.status, 'matched', 'a correctly-priced over-delivery is matched at the header');
  assert.equal(evaluation.valueVarianceRappen, 0, 'the value leg is exact');

  // The over-delivery is NOT swallowed: the line carries a visible variance with the right percentage.
  const line = evaluation.lines[0];
  assert.equal(line.lineStatus, 'variance', 'the over-delivered line is flagged variance even under a matched header');
  assert.equal(line.qtyVariance, 2, 'qtyVariance = received - ordered');
  assert.equal(line.qtyVariancePct, 20, 'qtyVariancePct = |received - ordered| / ordered * 100');

  // The correctly-priced bill auto-matches WITHOUT an override.
  const created = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: 'over-m' }), 'create');
  assert.equal(created.match.status, 'matched', 'the header persists as matched, no override needed');

  // The persisted match line keeps the variance (surfaced, not dropped).
  const persistedLineStatus = s.deps.store.db.prepare('SELECT line_status FROM three_way_match_line WHERE workspace_id = ? AND match_id = ?').get(s.workspaceId, created.match.id).line_status;
  assert.equal(persistedLineStatus, 'variance', 'the persisted match line keeps line_status = variance');

  // The payment gate opens: an advisory quantity variance does not block payment.
  const gate = must(call(s.deps, 'match_status_for_bill', { workspaceId: s.workspaceId, billId }), 'gate');
  assert.equal(gate.status, 'matched');
  assert.equal(gate.canPay, true, 'a correctly-priced over-delivery is payable without an override');
});

// --- explicit poId is honoured (secondary bug fix) ----------------------------------------------

test('I04 poId: create honours the pinned PO instead of auto-discovering the supplier oldest open PO', () => {
  const s = seed('pin');
  // Two open POs for the SAME supplier. PO-A is created first, so it is the auto-discovery default.
  const poA = sentPo(s, 'pinA', 10, 10000);
  receive(s, 'pinA', poA.poId, poA.lineId, 10);
  const poB = sentPo(s, 'pinB', 5, 10000);
  receive(s, 'pinB', poB.poId, poB.lineId, 5);

  // Baseline: with NO poId the engine auto-discovers the oldest open PO (PO-A), not PO-B.
  const autoEval = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId: chfBill(s, 'pinAuto', 100000) }), 'auto evaluate').evaluation;
  assert.equal(autoEval.poId, poA.poId, 'auto-discovery picks the oldest open PO (PO-A)');

  // Pin the evaluation to PO-B and bill its value (5 * 10'000 = 50'000).
  const billId = chfBill(s, 'pin', 50000);
  const pinnedEval = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId, poId: poB.poId }), 'pinned evaluate').evaluation;
  assert.equal(pinnedEval.poId, poB.poId, 'the evaluation is pinned to PO-B');
  assert.equal(pinnedEval.status, 'matched');

  // Create pinned to PO-B: the persisted match must reference PO-B, not the auto-discovered PO-A.
  const created = must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, poId: poB.poId, evaluation: pinnedEval, idempotencyKey: 'pin-m' }), 'create pinned');
  assert.equal(created.match.poId, poB.poId, 'create landed against the pinned PO-B');
  assert.notEqual(created.match.poId, poA.poId, 'create did NOT auto-discover PO-A');

  const persistedPo = s.deps.store.db.prepare('SELECT po_id FROM three_way_match WHERE workspace_id = ? AND id = ?').get(s.workspaceId, created.match.id).po_id;
  assert.equal(persistedPo, poB.poId, 'the persisted header references PO-B');

  // PO-B is billed; PO-A is untouched (the bug would have billed PO-A instead).
  assert.equal(billedQty(s.deps, s.workspaceId, poB.lineId), 5, 'PO-B line is billed');
  assert.equal(billedQty(s.deps, s.workspaceId, poA.lineId), 0, 'PO-A line is untouched');
});
