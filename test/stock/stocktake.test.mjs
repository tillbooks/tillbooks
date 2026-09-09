/**
 * D01 stocktake (Inventur): the OR 958c Abs. 2 lifecycle. Open freezes book qty; count records the
 * physical count; commit posts every difference as a movement through the SAME movement path
 * (reason:adjust), never a direct insert and never a ledger reach; a committed session is terminal
 * and immutable; commit is idempotent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordStockMove, stocktakeOpen, stocktakeCount, stocktakeReport, stocktakeCommit, stockOnHand } from '../../dist/core/stock/index.js';
import { setup, counts } from './support.mjs';

function seed(t) {
  const r = recordStockMove(t.ctx, { itemId: t.itemId, locationId: t.locId, qty: 14, reason: 'receipt', unitCostMinor: 2000, movedAt: '2026-03-01', idempotencyKey: 'seed' });
  assert.equal(r.ok, true);
}

test('open freezes book qty, count/report shows the diff, commit mints the adjustment through stock.move', () => {
  const t = setup();
  seed(t); // on-hand 14
  const open = stocktakeOpen(t.ctx, { frozenAt: '2026-03-31', idempotencyKey: 'st1' });
  assert.equal(open.ok, true);
  assert.equal(open.lines.length, 1);
  assert.equal(open.lines[0].book_qty, 14);
  const ln = open.lines[0];

  assert.equal(stocktakeCount(t.ctx, { sessionId: open.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 12 }).ok, true);
  const rep = stocktakeReport(t.ctx, { sessionId: open.session.id });
  assert.equal(rep.lines[0].bookQty, 14);
  assert.equal(rep.lines[0].countedQty, 12);
  assert.equal(rep.lines[0].diffQty, -2);
  assert.equal(rep.under, 1);
  assert.equal(rep.uncounted, 0);

  const movesBefore = counts(t.store, t.workspaceId).movements;
  const commit = stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });
  assert.equal(commit.ok, true);
  assert.equal(commit.movementsMinted, 1);
  // The adjustment brings on-hand to the counted qty exactly, minted as a reason:adjust movement.
  assert.equal(stockOnHand(t.ctx, {}).rows[0].onHand, 12);
  assert.equal(counts(t.store, t.workspaceId).movements, movesBefore + 1);
  const adj = t.store.db.prepare("SELECT reason, ref_kind, ref_id, qty FROM stock_movement WHERE id = ?").get(commit.movementIds[0]);
  assert.equal(adj.reason, 'adjust');
  assert.equal(adj.ref_kind, 'stocktake');
  assert.equal(adj.ref_id, open.session.id);
  assert.equal(adj.qty, -2);
  // NO ledger reach: the commit posts no journal entry.
  assert.equal(counts(t.store, t.workspaceId).stockEntries, 0);
});

test('commit refuses while any line is uncounted, naming the offending lines', () => {
  const t = setup();
  seed(t);
  const open = stocktakeOpen(t.ctx, { frozenAt: '2026-03-31', idempotencyKey: 'st1' });
  const r = stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'uncounted_lines');
  assert.equal(r.lines.length, 1);
});

test('a committed session is terminal: counting it is refused with stocktake_not_open', () => {
  const t = setup();
  seed(t);
  const open = stocktakeOpen(t.ctx, { frozenAt: '2026-03-31', idempotencyKey: 'st1' });
  const ln = open.lines[0];
  stocktakeCount(t.ctx, { sessionId: open.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 14 });
  stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });
  const late = stocktakeCount(t.ctx, { sessionId: open.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 99 });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'stocktake_not_open');
});

test('commit is idempotent: a replay mints no second movement', () => {
  const t = setup();
  seed(t);
  const open = stocktakeOpen(t.ctx, { frozenAt: '2026-03-31', idempotencyKey: 'st1' });
  const ln = open.lines[0];
  stocktakeCount(t.ctx, { sessionId: open.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 12 });
  const first = stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });
  const movesAfter = counts(t.store, t.workspaceId).movements;
  const second = stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });
  assert.equal(second.movementsMinted, first.movementsMinted);
  assert.equal(counts(t.store, t.workspaceId).movements, movesAfter, 'a replay mints no second adjustment');
});

test('a zero-diff commit mints nothing but still seals the session (the count is the Bestandesnachweis)', () => {
  const t = setup();
  seed(t);
  const open = stocktakeOpen(t.ctx, { frozenAt: '2026-03-31', idempotencyKey: 'st1' });
  const ln = open.lines[0];
  stocktakeCount(t.ctx, { sessionId: open.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 14 });
  const before = counts(t.store, t.workspaceId).movements;
  const commit = stocktakeCommit(t.ctx, { sessionId: open.session.id, idempotencyKey: 'stc1' });
  assert.equal(commit.movementsMinted, 0);
  assert.equal(counts(t.store, t.workspaceId).movements, before);
  const status = t.store.db.prepare('SELECT status FROM stocktake_session WHERE id = ?').get(open.session.id).status;
  assert.equal(status, 'committed');
});
