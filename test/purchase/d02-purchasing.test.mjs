/**
 * D02 purchasing money-path invariants (spec §7/§8). These are the assertions the capability is not
 * allowed to reach `develop` without, and they are written to BITE: each one is shown failing-closed
 * (a refusal that writes zero rows / moves zero stock) rather than merely returning the right shape.
 *
 * Covered:
 *  - three-way-match integrity / NO over-match (billed_qty never exceeds received_qty; same bill twice);
 *  - NO over-receipt (a receipt cannot exceed the open PO qty), refused with a structured error;
 *  - STOCK RECEIPT ONCE (receipt mints exactly one D01 movement; a retry mints nothing more);
 *  - TX-ATOMICITY (a REFUSED receipt/match writes ZERO rows and moves ZERO stock: the C02/D03 bug class);
 *  - §H-TENANT (a cross-tenant PO/bill is refused);
 *  - the tolerance boundary (AT tolerance passes; ONE Rappen over blocks and persists the exception);
 *  - the override gate (a variance override needs the `post` capability);
 *  - resolveSupplierPrice (latest valid_from wins; item_cost fallback);
 *  - po_revise (snapshot immutability; qty_below_received guard; receipts survive the revision).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function count(deps, table, workspaceId) {
  return deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
}

/** A workspace with a vendor, a stock-tracked item (cost 90.00) and a location. */
function seed(key) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Einkauf AG', `d02-${key}`);
  const vendor = must(call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${key}-v` }), 'create_contact').contact.id;
  const item = must(call(deps, 'create_item', { workspaceId, name: 'Rohstoff', defaultUnitPriceMinor: 12000, idempotencyKey: `${key}-i` }), 'create_item').item.id;
  deps.store.db.prepare('UPDATE item SET track_stock = 1, cost_price_minor = ? WHERE workspace_id = ? AND id = ?').run(9000, workspaceId, item);
  const location = must(call(deps, 'stock_location_upsert', { workspaceId, name: 'Wareneingang', idempotencyKey: `${key}-l` }), 'stock_location_upsert').location.id;
  return { deps, workspaceId, accId, vendor, item, location };
}

/** A PO for `qty` units at net `unit` Rappen, sent. Returns the po id and its first line id. */
function sentPo(s, key, qty, unit) {
  const po = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, lines: [{ itemId: s.item, qty, unitPriceRappen: unit }], idempotencyKey: `${key}-po` }), 'po_upsert');
  must(call(s.deps, 'po_send', { workspaceId: s.workspaceId, poId: po.poId, idempotencyKey: `${key}-send` }), 'po_send');
  const lineId = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: po.poId }).lines[0].id;
  return { poId: po.poId, lineId };
}

/** A CHF vendor bill for `netRappen` (amountIsGross false, no VAT), for the SAME vendor. */
function chfBill(s, key, netRappen) {
  return must(
    call(s.deps, 'create_vendor_bill', {
      workspaceId: s.workspaceId,
      vendorId: s.vendor,
      billDate: '2026-03-05',
      amountMinor: netRappen,
      amountIsGross: false,
      expenseAccountId: s.accId('6500'),
      idempotencyKey: `${key}-bill`,
    }),
    'create_vendor_bill',
  ).vendorBillId;
}

test('D02 happy path: PO -> send -> receive moves D01 stock exactly once -> match closes the PO', () => {
  const s = seed('happy');
  const { poId, lineId } = sentPo(s, 'happy', 10, 10000); // net total 100'000

  assert.equal(count(s.deps, 'stock_movement', s.workspaceId), 0, 'no stock before the receipt');
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 10 }], idempotencyKey: 'happy-r' }), 'receipt_record');

  // Stock rose by exactly 10, through ONE movement, at the PO's CHF base unit cost.
  assert.equal(count(s.deps, 'stock_movement', s.workspaceId), 1, 'exactly one movement minted');
  const onHand = call(s.deps, 'stock_on_hand', { workspaceId: s.workspaceId, itemId: s.item }).rows[0];
  assert.equal(onHand.onHand, 10, 'on-hand rose by exactly the received qty');
  const mv = s.deps.store.db.prepare('SELECT reason, unit_cost_minor, ref_kind, ref_id FROM stock_movement WHERE workspace_id = ?').get(s.workspaceId);
  assert.equal(mv.reason, 'receipt');
  assert.equal(mv.unit_cost_minor, 10000, 'the D01 unit cost is the PO line CHF base cost');
  assert.equal(mv.ref_kind, 'po');
  assert.equal(mv.ref_id, poId);

  // The PO is now fully received.
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).po.status, 'received');

  // A bill whose net equals the received value matches within tolerance and closes the PO.
  const billId = chfBill(s, 'happy', 100000);
  const matched = must(call(s.deps, 'match_bill', { workspaceId: s.workspaceId, poId, billId, idempotencyKey: 'happy-m' }), 'match_bill');
  assert.equal(matched.match.status, 'matched');
  assert.equal(matched.match.priceVarianceRappen, 0);
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).po.status, 'closed');
  // The A17 bill is LINKED, and D02 posted nothing: there is no posted_entry_id anywhere in D02.
  const link = s.deps.store.db.prepare('SELECT bill_id FROM po_match WHERE workspace_id = ?').get(s.workspaceId);
  assert.equal(link.bill_id, billId, 'the match links the A17 bill id, the ledger link lives on the bill');
});

test('D02 STOCK ONCE: receipt_record is idempotent, a retry mints NO second movement', () => {
  const s = seed('once');
  const { poId, lineId } = sentPo(s, 'once', 5, 10000);
  const first = must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 3 }], idempotencyKey: 'once-r' }), 'receipt 1');
  const second = call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 3 }], idempotencyKey: 'once-r' });
  assert.equal(second.ok, true, 'the retry replays rather than refusing');
  assert.deepEqual(second, first, 'the replay is byte-identical to the first receipt');
  assert.equal(count(s.deps, 'stock_movement', s.workspaceId), 1, 'exactly one movement across both calls');
  assert.equal(count(s.deps, 'goods_receipt', s.workspaceId), 1, 'exactly one receipt across both calls');
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].receivedQty, 3, 'received_qty incremented once');
});

test('D02 NO OVER-RECEIPT + TX-ATOMICITY: a receipt over the open qty writes zero rows and moves zero stock', () => {
  const s = seed('over');
  const { poId, lineId } = sentPo(s, 'over', 4, 10000);
  const refused = call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 5 }], idempotencyKey: 'over-r' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'over_receipt');
  assert.equal(refused.openQty, 4, 'the structured error names the open qty');
  // TX-ATOMICITY: the refusal left NOTHING behind.
  assert.equal(count(s.deps, 'stock_movement', s.workspaceId), 0, 'no stock moved on a refused receipt');
  assert.equal(count(s.deps, 'goods_receipt', s.workspaceId), 0, 'no receipt header written on a refusal');
  assert.equal(count(s.deps, 'goods_receipt_line', s.workspaceId), 0, 'no receipt line written on a refusal');
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].receivedQty, 0, 'received_qty untouched');
});

test('D02 NO OVER-MATCH: billed_qty never exceeds received_qty, and the same bill cannot match twice', () => {
  const s = seed('match');
  const { poId, lineId } = sentPo(s, 'match', 10, 10000);
  // Receive only 6 of 10: the received-but-not-billed value is 60'000.
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 6 }], idempotencyKey: 'match-r' }), 'receipt');
  const billId = chfBill(s, 'match', 60000);
  const matched = must(call(s.deps, 'match_bill', { workspaceId: s.workspaceId, poId, billId, idempotencyKey: 'match-m' }), 'match');
  assert.equal(matched.match.status, 'matched');
  const line = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0];
  assert.equal(line.billedQty, 6, 'billed_qty consumed exactly the received-not-billed qty, never above received');
  assert.ok(line.billedQty <= line.receivedQty, 'billed_qty <= received_qty (no over-match)');
  // The PO is only partially received, so it stays open (not closed).
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).po.status, 'sent');

  // The SAME bill cannot be matched to the SAME PO again (no double-consume across a fresh key).
  const again = call(s.deps, 'match_bill', { workspaceId: s.workspaceId, poId, billId, idempotencyKey: 'match-m2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_matched');
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].billedQty, 6, 'billed_qty unchanged after the refused re-match');

  // A second bill with nothing new received is refused with nothing_received (no billing thin air).
  const bill2 = chfBill(s, 'match2', 40000);
  const nothing = call(s.deps, 'match_bill', { workspaceId: s.workspaceId, poId, billId: bill2, idempotencyKey: 'match-m3' });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.error, 'nothing_received');
});

test('D02 tolerance boundary: AT tolerance passes; ONE Rappen over blocks and PERSISTS the variance', () => {
  // expected 100'000, tolerance = round(100000 * 2%) = 2000. Bill net 102'000 is exactly at tolerance.
  const atTol = seed('tolok');
  const a = sentPo(atTol, 'tolok', 10, 10000);
  must(call(atTol.deps, 'receipt_record', { workspaceId: atTol.workspaceId, poId: a.poId, locationId: atTol.location, lines: [{ poLineId: a.lineId, qty: 10 }], idempotencyKey: 'tolok-r' }), 'receipt');
  const billAt = chfBill(atTol, 'tolok', 102000);
  const okMatch = must(call(atTol.deps, 'match_bill', { workspaceId: atTol.workspaceId, poId: a.poId, billId: billAt, idempotencyKey: 'tolok-m' }), 'at-tolerance match');
  assert.equal(okMatch.match.status, 'matched', 'a variance exactly AT tolerance passes (<=)');
  assert.equal(okMatch.match.priceVarianceRappen, 2000);

  // ONE Rappen over: 102'001 -> variance 2001 > 2000 -> blocked and persisted, no billing, no stock touched.
  const over = seed('tolno');
  const b = sentPo(over, 'tolno', 10, 10000);
  must(call(over.deps, 'receipt_record', { workspaceId: over.workspaceId, poId: b.poId, locationId: over.location, lines: [{ poLineId: b.lineId, qty: 10 }], idempotencyKey: 'tolno-r' }), 'receipt');
  const stockBefore = count(over.deps, 'stock_movement', over.workspaceId);
  const billOver = chfBill(over, 'tolno', 102001);
  const blocked = call(over.deps, 'match_bill', { workspaceId: over.workspaceId, poId: b.poId, billId: billOver, idempotencyKey: 'tolno-m' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'variance_exceeded');
  assert.equal(blocked.priceVarianceRappen, 2001);
  // The exception PERSISTS as a visible po_match row (status variance), but nothing was billed or moved.
  const vrow = over.deps.store.db.prepare("SELECT status FROM po_match WHERE workspace_id = ?").get(over.workspaceId);
  assert.equal(vrow.status, 'variance', 'a blocked variance persists as a visible po_match exception');
  assert.equal(call(over.deps, 'po_get', { workspaceId: over.workspaceId, poId: b.poId }).lines[0].billedQty, 0, 'no billing on a blocked variance');
  assert.equal(count(over.deps, 'stock_movement', over.workspaceId), stockBefore, 'a blocked match moves zero stock');
  // Re-attempting the same blocked match does NOT stack a second variance row (idempotent exception).
  call(over.deps, 'match_bill', { workspaceId: over.workspaceId, poId: b.poId, billId: billOver, idempotencyKey: 'tolno-m2' });
  assert.equal(count(over.deps, 'po_match', over.workspaceId), 1, 'a re-attempt does not stack a second variance row');
});

test('D02 override gate: a variance override needs the `post` capability', () => {
  const s = seed('ovr');
  const { poId, lineId } = sentPo(s, 'ovr', 10, 10000);
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 10 }], idempotencyKey: 'ovr-r' }), 'receipt');
  const billId = chfBill(s, 'ovr', 130000); // 30% over: well past tolerance

  // Seat the agent on a role holding manage_master_data but NOT post (the D02 write gate, minus the
  // override authority). The invite performs the D50 flip (seats both D13 actors as owners), then
  // set_role narrows the agent's seat onto the custom bundle.
  must(call(s.deps, 'invite_member', { workspaceId: s.workspaceId, email: 'einkauf@muster.ch', role: 'bookkeeper', idempotencyKey: 'ovr-inv' }), 'invite');
  const role = must(call(s.deps, 'define_role', { workspaceId: s.workspaceId, name: 'Nur Einkauf', capabilities: ['manage_master_data', 'read_master_data'], idempotencyKey: 'ovr-role' }), 'define_role');
  const seat = call(s.deps, 'list_members', { workspaceId: s.workspaceId }).members.find((m) => m.actorId === 'agent');
  must(call(s.deps, 'set_role', { workspaceId: s.workspaceId, memberId: seat.memberId, role: role.roleId }), 'set_role');
  s.deps.actor = 'agent';

  // Without `post`, the override is denied and nothing is billed.
  const denied = call(s.deps, 'match_bill', { workspaceId: s.workspaceId, poId, billId, override: true, idempotencyKey: 'ovr-m1' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied', JSON.stringify(denied));
  assert.equal(count(s.deps, 'po_match', s.workspaceId), 0, 'a denied override writes no match row');

  // The owner (holds post) can force the overridden match.
  s.deps.actor = 'studio';
  const forced = must(call(s.deps, 'match_bill', { workspaceId: s.workspaceId, poId, billId, override: true, idempotencyKey: 'ovr-m2' }), 'override match');
  assert.equal(forced.match.status, 'overridden');
  const row = s.deps.store.db.prepare('SELECT overridden_by FROM po_match WHERE workspace_id = ?').get(s.workspaceId);
  assert.equal(row.overridden_by, 'studio', 'the override records who forced it (audit trail)');
});

test('D02 §H-TENANT: a PO and a bill cannot be reached across the workspace boundary', () => {
  const a = seed('ta');
  const { poId, lineId } = sentPo(a, 'ta', 5, 10000);

  // A second workspace on the SAME deps/actor, so the actor is a member of both but the tenant scoping
  // is what must refuse, not the membership.
  const { workspaceId: wsB, accId: accB } = mintWorkspace(a.deps, 'Fremd AG', 'd02-tb2');
  const vendorB = must(call(a.deps, 'create_contact', { workspaceId: wsB, partyRole: 'vendor', name: 'Fremd Lieferant', idempotencyKey: 'tb-v' }), 'create_contact B').contact.id;

  // Receiving tenant A's PO under tenant B's id is not_found (the PO does not exist in B).
  const crossReceipt = call(a.deps, 'receipt_record', { workspaceId: wsB, poId, locationId: a.location, lines: [{ poLineId: lineId, qty: 1 }], idempotencyKey: 'ta-x' });
  assert.equal(crossReceipt.ok, false);
  assert.equal(crossReceipt.error, 'not_found');

  // A bill created in B cannot be matched against a PO in A: the bill read under A returns nothing.
  const billB = must(call(a.deps, 'create_vendor_bill', { workspaceId: wsB, vendorId: vendorB, billDate: '2026-03-05', amountMinor: 50000, amountIsGross: false, expenseAccountId: accB('6500'), idempotencyKey: 'tb-bill' }), 'bill B').vendorBillId;
  const crossMatch = call(a.deps, 'match_bill', { workspaceId: a.workspaceId, poId, billId: billB, idempotencyKey: 'ta-xm' });
  assert.equal(crossMatch.ok, false);
  assert.equal(crossMatch.error, 'invalid_reference', JSON.stringify(crossMatch));
});

test('D02 resolveSupplierPrice: latest valid_from wins, and the item_cost fallback fires with a source hint', () => {
  const s = seed('price');
  // No supplier price yet -> a PO line pre-fills from the item cost (90.00), source item_cost.
  const fallback = must(call(s.deps, 'supplier_price_list', { workspaceId: s.workspaceId, supplierContactId: s.vendor, itemId: s.item }), 'list');
  assert.equal(fallback.resolved.priceRappen, 9000);
  assert.equal(fallback.resolved.source, 'item_cost');

  // Two supplier prices, different valid_from: the latest effective one wins.
  must(call(s.deps, 'supplier_price_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, itemId: s.item, priceRappen: 8000, currency: 'CHF', validFrom: '2026-01-01', leadTimeDays: 5, idempotencyKey: 'p1' }), 'upsert 1');
  must(call(s.deps, 'supplier_price_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, itemId: s.item, priceRappen: 8500, currency: 'CHF', validFrom: '2026-06-01', leadTimeDays: 9, idempotencyKey: 'p2' }), 'upsert 2');
  const resolved = call(s.deps, 'supplier_price_list', { workspaceId: s.workspaceId, supplierContactId: s.vendor, itemId: s.item, at: '2026-08-01' }).resolved;
  assert.equal(resolved.priceRappen, 8500, 'the latest valid_from <= at wins');
  assert.equal(resolved.source, 'supplier');

  // A PO line with no explicit price pre-fills from the resolver (8500) and its lead time drives expected_on.
  const po = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, lines: [{ itemId: s.item, qty: 2 }], idempotencyKey: 'price-po' }), 'po');
  const detail = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: po.poId });
  assert.equal(detail.lines[0].unitPriceRappen, 8500, 'the PO line pre-filled from resolveSupplierPrice');
  assert.ok(detail.po.expectedOn !== null, 'expected_on derived from the supplier lead time');

  // A negative price is refused.
  const bad = call(s.deps, 'supplier_price_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, itemId: s.item, priceRappen: -1, currency: 'CHF', validFrom: '2026-01-01', idempotencyKey: 'p3' });
  assert.equal(bad.ok, false);
});

test('D02 po_revise: snapshot is append-only, receipts survive, and qty_below_received is refused', () => {
  const s = seed('rev');
  const { poId, lineId } = sentPo(s, 'rev', 10, 10000);
  // Receive 4 of 10, then revise (sent -> draft).
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 4 }], idempotencyKey: 'rev-r' }), 'receipt');
  const revised = must(call(s.deps, 'po_revise', { workspaceId: s.workspaceId, poId, reason: 'Preiskorrektur', idempotencyKey: 'rev-1' }), 'revise');
  assert.equal(revised.revision, 2);
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).po.status, 'draft');
  assert.equal(count(s.deps, 'po_revision', s.workspaceId), 1, 'one snapshot written');
  // received_qty survived the revision untouched (belongs to receipts, not the edit).
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].receivedQty, 4);

  // Editing the revised draft: RAISING qty is fine and preserves received_qty.
  const raised = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, poId, lines: [{ itemId: s.item, qty: 12, unitPriceRappen: 11000 }], idempotencyKey: 'rev-edit1' }), 'raise qty');
  assert.equal(raised.lines[0].receivedQty, 4, 'received_qty carried onto the edited line');
  assert.equal(raised.lines[0].qty, 12);

  // LOWERING qty below the 4 already received is refused (minted D01 movements never orphaned).
  const below = call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, poId, lines: [{ itemId: s.item, qty: 3, unitPriceRappen: 11000 }], idempotencyKey: 'rev-edit2' });
  assert.equal(below.ok, false);
  assert.equal(below.error, 'qty_below_received', JSON.stringify(below));

  // REMOVING the received line entirely is refused too.
  const removed = call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, poId, lines: [], idempotencyKey: 'rev-edit3' });
  assert.equal(removed.ok, false);
  assert.equal(removed.error, 'qty_below_received');

  // A second revise leaves the FIRST snapshot byte-for-byte unchanged (append-only immutability).
  const firstSnap = s.deps.store.db.prepare('SELECT snapshot_json FROM po_revision WHERE workspace_id = ? AND revision = 1').get(s.workspaceId).snapshot_json;
  // Send again, then revise again.
  must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, poId, lines: [{ itemId: s.item, qty: 12, unitPriceRappen: 11000 }], idempotencyKey: 'rev-edit4' }), 're-edit');
  must(call(s.deps, 'po_send', { workspaceId: s.workspaceId, poId, idempotencyKey: 'rev-send2' }), 'send 2');
  must(call(s.deps, 'po_revise', { workspaceId: s.workspaceId, poId, idempotencyKey: 'rev-2' }), 'revise 2');
  const firstSnapAfter = s.deps.store.db.prepare('SELECT snapshot_json FROM po_revision WHERE workspace_id = ? AND revision = 1').get(s.workspaceId).snapshot_json;
  assert.equal(firstSnapAfter, firstSnap, 'a second revise never mutates the first snapshot');
  assert.equal(count(s.deps, 'po_revision', s.workspaceId), 2, 'two snapshots now');
});

test('D02 po_cancel: refused once anything is received (has_receipts), allowed on a receipt-free PO', () => {
  const s = seed('cancel');
  const { poId, lineId } = sentPo(s, 'cancel', 5, 10000);
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 2 }], idempotencyKey: 'cancel-r' }), 'receipt');
  const refused = call(s.deps, 'po_cancel', { workspaceId: s.workspaceId, poId, idempotencyKey: 'cancel-x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'has_receipts');
  // The receipt-free PO can be short-closed instead.
  const closed = must(call(s.deps, 'po_close_short', { workspaceId: s.workspaceId, poId, idempotencyKey: 'cancel-cs' }), 'close_short');
  assert.equal(closed.po.status, 'closed');
});

test('D02 no posting path: no D02 table carries a posted_entry_id column (P3)', () => {
  const s = seed('p3');
  for (const table of ['purchase_order', 'po_line', 'goods_receipt', 'goods_receipt_line', 'po_match', 'po_revision', 'supplier_item_price']) {
    const cols = s.deps.store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(!cols.includes('posted_entry_id'), `${table} must not carry a posted_entry_id: D02 posts nothing (P3)`);
  }
});
