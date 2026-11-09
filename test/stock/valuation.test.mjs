/**
 * D01 valuation: FIFO vs weighted-average golden values (they must DIFFER, so the method is a real
 * choice), round-once integer arithmetic (no float drift), the OR 960c lower-of-cost-or-market flag,
 * and the Stetigkeit (method-change) warning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordStockMove, computeInventoryValue, runValuation, valuationReport } from '../../dist/core/stock/index.js';
import { setup } from './support.mjs';

function move(t, qty, reason, movedAt, key, unitCostMinor) {
  const r = recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, qty, reason, movedAt, idempotencyKey: key, ...(unitCostMinor !== undefined ? { unitCostMinor } : {}) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('FIFO consumes the oldest layers first (golden fixture)', () => {
  const t = setup();
  move(t, 10, 'receipt', '2026-03-01', 'a', 2000);
  move(t, 5, 'receipt', '2026-03-10', 'b', 3000);
  move(t, 12, 'issue', '2026-03-15', 'c'); // consumes 10@2000 + 2@3000, leaves 3@3000

  const v = computeInventoryValue(t.ctx, 'fifo', '2026-03-31');
  assert.equal(v.perItem.length, 1);
  assert.equal(v.perItem[0].qty, 3);
  assert.equal(v.perItem[0].valueMinor, 9000, '3 units left at the 3000 layer');
  assert.equal(v.totalMinor, 9000);
});

test('weighted-average deducts at the moving average, rounded ONCE, and differs from FIFO', () => {
  const t = setup();
  move(t, 10, 'receipt', '2026-03-01', 'a', 2000);
  move(t, 5, 'receipt', '2026-03-10', 'b', 3000); // runQty 15, runValue 35000, avg round(35000/15)=2333
  move(t, 12, 'issue', '2026-03-15', 'c'); // consume 12*2333=27996, runValue 7004, runQty 3

  const v = computeInventoryValue(t.ctx, 'weighted_avg', '2026-03-31');
  assert.equal(v.perItem[0].qty, 3);
  assert.equal(v.perItem[0].valueMinor, 7004);
  assert.ok(Number.isInteger(v.perItem[0].valueMinor), 'value is integer Rappen, no float drift');
  // The two methods give DIFFERENT numbers on the same movements, which is the whole reason the
  // choice is a workspace Stetigkeit decision and not an implementation detail.
  const fifo = computeInventoryValue(t.ctx, 'fifo', '2026-03-31');
  assert.notEqual(v.totalMinor, fifo.totalMinor);
});

test('as_of filters movements: a later receipt is not valued at an earlier date', () => {
  const t = setup();
  move(t, 10, 'receipt', '2026-03-01', 'a', 2000);
  move(t, 10, 'receipt', '2026-05-01', 'b', 2000);
  assert.equal(computeInventoryValue(t.ctx, 'fifo', '2026-03-31').totalMinor, 20000);
  assert.equal(computeInventoryValue(t.ctx, 'fifo', '2026-05-31').totalMinor, 40000);
});

test('falls back to the D00 item cost when a receipt carries no unit cost', () => {
  const t = setup({ costMinor: 2500 });
  move(t, 4, 'receipt', '2026-03-01', 'a'); // no unitCostMinor -> item cost 2500
  assert.equal(computeInventoryValue(t.ctx, 'fifo', '2026-03-31').totalMinor, 10000);
});

test('the valuation report carries the OR 960c flag and the Stetigkeit warning on a method change', () => {
  const t = setup();
  move(t, 10, 'receipt', '2026-03-01', 'a', 2000);
  runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'v1' });

  const rep = valuationReport(t.ctx, { method: 'fifo', asOf: '2026-06-30' });
  assert.equal(rep.ok, true);
  assert.equal(rep.methodChanged, true, 'reporting fifo after a weighted_avg run warns on Stetigkeit');
  assert.equal(rep.priorMethod, 'weighted_avg');
  assert.equal(rep.perItem[0].lowerOfCostOrMarket, false, 'no market feed, so the clamp is at cost (OR 960c)');
});

test('a first run over zero movements posts nothing and records a zero-value run', () => {
  const t = setup();
  const v = runValuation(t.ctx, { method: 'fifo', asOf: '2026-03-31', idempotencyKey: 'v0' });
  assert.equal(v.ok, true);
  assert.equal(v.totalValueMinor, 0);
  assert.equal(v.deltaMinor, 0);
  assert.equal(v.postedEntryId, null, 'a zero-delta run posts no journal entry');
});
