/**
 * D01 movements: the OP2 quantity ledger and its read models. On-hand, the insufficient-stock guard,
 * transfers, the reason/qty enum guards, and the low-stock reorder crossing that feeds the automation
 * event.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordStockMove, stockOnHand, lowStockList, upsertStockLocation } from '../../dist/core/stock/index.js';
import { setup } from './support.mjs';

function move(t, patch) {
  return recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, reason: 'receipt', movedAt: '2026-03-01', ...patch });
}

test('on-hand is the signed sum of movements, per item x location', () => {
  const t = setup();
  assert.equal(move(t, { qty: 10, idempotencyKey: 'a' }).ok, true);
  assert.equal(move(t, { qty: 4, reason: 'issue', idempotencyKey: 'b' }).ok, true);
  const oh = stockOnHand(t.ctx, {});
  assert.equal(oh.rows.length, 1);
  assert.equal(oh.rows[0].onHand, 6);
});

test('an issue that would drive on-hand negative is refused with insufficient_stock and the available qty', () => {
  const t = setup();
  move(t, { qty: 3, idempotencyKey: 'a' });
  const r = move(t, { qty: 5, reason: 'issue', idempotencyKey: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'insufficient_stock');
  assert.equal(r.available, 3);
  // NON-VACUOUS: nothing was written, on-hand is still 3.
  assert.equal(stockOnHand(t.ctx, {}).rows[0].onHand, 3);
});

test('allowNegative lets on-hand go negative (the allow_negative_stock posture)', () => {
  const t = setup();
  move(t, { qty: 3, idempotencyKey: 'a' });
  const r = move(t, { qty: 5, reason: 'issue', allowNegative: true, idempotencyKey: 'b' });
  assert.equal(r.ok, true);
  assert.equal(stockOnHand(t.ctx, {}).rows[0].onHand, -2);
});

test('a transfer writes a paired issue+receipt and nets zero on total on-hand', () => {
  const t = setup();
  move(t, { qty: 10, idempotencyKey: 'a' });
  const dest = upsertStockLocation(t.ctx, { name: 'Aussenlager', idempotencyKey: 'loc-dest' });
  const r = recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, toLocationId: dest.location.id, qty: 4, reason: 'transfer', movedAt: '2026-03-02', idempotencyKey: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.movements.length, 2);
  const oh = stockOnHand(t.ctx, {});
  const byLoc = Object.fromEntries(oh.rows.map((x) => [x.locationId, x.onHand]));
  assert.equal(byLoc[t.locId], 6);
  assert.equal(byLoc[dest.location.id], 4);
  assert.equal(r.lowStockReachedItemId, null, 'a transfer never crosses the reorder point');
});

test('the enum guards bite: an unknown reason and a zero qty are refused', () => {
  const t = setup();
  assert.equal(move(t, { qty: 5, reason: 'destroy', idempotencyKey: 'a' }).error, 'invalid_reason');
  assert.equal(move(t, { qty: 0, idempotencyKey: 'b' }).error, 'invalid_qty');
});

test('low-stock crossing: a move to at/below the reorder point flags the item ONCE, a later low move does not re-flag', () => {
  const t = setup({ reorder: 5 });
  const up = move(t, { qty: 10, idempotencyKey: 'a' });
  assert.equal(up.lowStockReachedItemId, null, '10 > 5, no crossing');
  const cross = move(t, { qty: 6, reason: 'issue', idempotencyKey: 'b' }); // 10 -> 4, crosses 5
  assert.equal(cross.lowStockReachedItemId, t.itemId, 'crossing from above 5 to 4 flags the item');
  const stillLow = move(t, { qty: 1, reason: 'issue', idempotencyKey: 'c' }); // 4 -> 3, already low
  assert.equal(stillLow.lowStockReachedItemId, null, 'already below the point is not a NEW crossing');

  const low = lowStockList(t.ctx);
  assert.equal(low.items.length, 1);
  assert.equal(low.items[0].itemId, t.itemId);
  assert.equal(low.items[0].onHand, 3);
});

test('low-stock list is empty (not an error) when nothing is below its reorder point', () => {
  const t = setup({ reorder: 5 });
  move(t, { qty: 10, idempotencyKey: 'a' });
  assert.deepEqual(lowStockList(t.ctx).items, []);
});
