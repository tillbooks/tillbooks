/**
 * D01 §H-PERIOD: the stock quantity ledger must refuse a movement dated into a hard-sealed period.
 *
 * The on-hand-as-of a sealed date is a statutory Bestandesnachweis (OR 958c): once the fiscal year is
 * year-close sealed, no `stock_movement` may be minted into it, or the filed quantity could be altered
 * after the seal. Both write paths that reach `insertMovement` (a direct `stock_move`, and a
 * `stocktake` commit stamped with the session freeze date) must assert the period is OPEN against the
 * movement date BEFORE any row is written, returning the same structured `period_locked` refusal the
 * inventory path uses and minting ZERO rows. A move dated in an OPEN period is unaffected.
 *
 * These tests are the money-path invariant for the fix: they FAIL against the pre-fix engine (the move
 * succeeds and mints a row into the sealed year) and PASS once the guard is in place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordStockMove, stocktakeOpen, stocktakeCount, stocktakeCommit, upsertStockLocation } from '../../dist/core/stock/index.js';
import { lockPeriod } from '../../dist/core/ledger/index.js';
import { setup, counts } from './support.mjs';

// A hard year-close seal on fiscal year 2026 (default fiscal_year_start 01-01), the strongest legal
// seal. Any date whose fiscal year is 2026 is then closed.
function sealYear2026(t) {
  const sealed = lockPeriod(t.ctx, { period: '2026', kind: 'hard', reason: 'year_close', idempotencyKey: 'seal-2026' });
  assert.equal(sealed.ok, true, `seal failed: ${JSON.stringify(sealed)}`);
}

test('stock_move dated into a hard-sealed year is refused with period_locked and mints ZERO rows', () => {
  const t = setup();
  sealYear2026(t);
  const before = counts(t.store, t.workspaceId).movements;

  const r = recordStockMove(t.ctx, {
    itemId: t.itemId,
    locationId: t.locId,
    qty: 10,
    reason: 'receipt',
    movedAt: '2026-03-01',
    idempotencyKey: 'mv-into-sealed',
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(r.period, '2026');
  assert.equal(r.kind, 'hard');
  assert.equal(r.reason, 'year_close');
  // NON-VACUOUS: the refusal wrote nothing. A sealed Bestandesnachweis cannot be moved after the seal.
  assert.equal(counts(t.store, t.workspaceId).movements, before);
});

test('a transfer dated into a hard-sealed year is refused before EITHER leg is written', () => {
  const t = setup();
  // Seed on-hand in the (still open) fiscal year 2025 so a transfer has stock to move, then seal 2026.
  const seed = recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, qty: 20, reason: 'receipt', movedAt: '2025-11-01', idempotencyKey: 'seed-2025' });
  assert.equal(seed.ok, true);
  const loc2 = upsertStockLocation(t.ctx, { name: 'Aussenlager', idempotencyKey: 'loc-2' });
  assert.equal(loc2.ok, true);
  sealYear2026(t);
  const before = counts(t.store, t.workspaceId).movements;

  const r = recordStockMove(t.ctx, {
    itemId: t.itemId,
    locationId: t.locId,
    toLocationId: loc2.location.id,
    qty: 5,
    reason: 'transfer',
    movedAt: '2026-06-15',
    idempotencyKey: 'xfer-into-sealed',
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  // A transfer mints TWO legs: neither may exist, so the count is unchanged (not off-by-one).
  assert.equal(counts(t.store, t.workspaceId).movements, before);
});

test('stocktake commit stamped with a freeze date in a sealed year is refused and mints ZERO rows', () => {
  const t = setup();
  // Seed on-hand while the year is OPEN, freeze a session at 2026-03-31, count a variance, THEN seal.
  const seed = recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, qty: 14, reason: 'receipt', movedAt: '2026-03-01', idempotencyKey: 'seed' });
  assert.equal(seed.ok, true);
  const open = stocktakeOpen(t.ctx, { frozenAt: '2026-03-31', idempotencyKey: 'st1' });
  assert.equal(open.ok, true);
  const ln = open.lines[0];
  assert.equal(stocktakeCount(t.ctx, { sessionId: open.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 12 }).ok, true);

  sealYear2026(t);
  const before = counts(t.store, t.workspaceId).movements;

  const commit = stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });

  assert.equal(commit.ok, false);
  assert.equal(commit.error, 'period_locked');
  assert.equal(commit.period, '2026');
  assert.equal(commit.reason, 'year_close');
  // NON-VACUOUS: the variance adjustment was NOT minted into the sealed year.
  assert.equal(counts(t.store, t.workspaceId).movements, before);
});

test('a stock_move dated in an OPEN period still succeeds while another year is sealed', () => {
  const t = setup();
  sealYear2026(t);
  const before = counts(t.store, t.workspaceId).movements;

  const r = recordStockMove(t.ctx, {
    itemId: t.itemId,
    locationId: t.locId,
    qty: 7,
    reason: 'receipt',
    movedAt: '2027-02-01',
    idempotencyKey: 'mv-open',
  });

  assert.equal(r.ok, true, `open-period move should succeed: ${JSON.stringify(r)}`);
  assert.equal(counts(t.store, t.workspaceId).movements, before + 1);
});
