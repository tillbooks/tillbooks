/**
 * J02 §H-PERIOD (D160.5, defect 2): `inventory_move` and `inventory_transfer` must refuse a movement
 * dated into a locked or sealed period.
 *
 * Classification found that the J02 write path, the one way on-hand ever changes, minted a
 * `stock_movement` into a closed month: the D01 twin (`stock_move`), the J04 stocktake commit, the
 * J05 adjustment, the I02 goods receipt and the I03 landed-cost confirm all assert the period, but the
 * two bare J02 verbs did not, so an agent (or a person) could back-date a receipt or an issue into a
 * month whose Bestandesnachweis was already closed. The guard is the same one every sibling uses
 * (`ctx.periods.assertOpen`, A03's `assertPeriodOpen`), with the same structured `period_locked`
 * refusal, placed AFTER the idempotency replay (a replay of a move made while the month was open still
 * answers its original row) and BEFORE any insert (a refusal mints ZERO rows).
 *
 * Each refusal test FAILS against the pre-fix engine: the move succeeds and the row count rises.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import { ledgerPorts, softCloseMonth, lockPeriod } from '../../dist/core/ledger/index.js';
import { lockPeriodSealed } from '../../dist/core/ledger/periods.js';
import { inventoryMove, inventoryTransfer, inventoryEnsureDefaultLocation } from '../../dist/core/inventory/index.js';
import { upsertStockLocation } from '../../dist/core/stock/index.js';
import { getAction } from '../../dist/api/registry.js';
import { fixture } from '../api/conformance-contract.mjs';

const AT = '2026-08-08T00:00:00.000Z';

/** A workspace with REAL A03 period locks (the default context stub answers every period open). */
function world() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Lager AG' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'u1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const item = createItem(ctx, { name: 'Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'it-1' });
  assert.equal(item.ok, true, JSON.stringify(item));
  const loc = inventoryEnsureDefaultLocation(ctx);
  assert.equal(loc.ok, true, JSON.stringify(loc));
  return { ctx, store, workspaceId, itemId: item.item.id, locationId: loc.location.id };
}

function rows(w) {
  return w.store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?').get(w.workspaceId).n;
}

function secondLocation(w) {
  const created = upsertStockLocation(w.ctx, { name: 'Aussenlager', idempotencyKey: 'loc-2' });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.location.id;
}

const move = (w, over = {}) =>
  inventoryMove(w.ctx, {
    itemId: w.itemId,
    locationId: w.locationId,
    qty: 10,
    movementType: 'receipt',
    unitCostMinor: 1500,
    effectiveDate: '2026-03-15',
    idempotencyKey: 'mv-1',
    ...over,
  });

test('inventory_move into a soft-closed month is refused with period_locked and mints ZERO rows', () => {
  const w = world();
  assert.equal(softCloseMonth(w.ctx, { period: '2026-03', idempotencyKey: 'close-03' }).ok, true);
  const before = rows(w);
  const r = move(w);
  assert.equal(r.ok, false, `the move into the closed month ran: ${JSON.stringify(r)}`);
  assert.equal(r.error, 'period_locked');
  assert.equal(r.period, '2026-03');
  assert.equal(r.kind, 'soft');
  assert.equal(rows(w), before, 'a refusal mints nothing');
});

test('inventory_move into a hard-locked month and into a sealed year is refused the same way', () => {
  const w = world();
  assert.equal(lockPeriod(w.ctx, { period: '2026-04', kind: 'hard', idempotencyKey: 'lock-04' }).ok, true);
  const before = rows(w);
  const hard = move(w, { effectiveDate: '2026-04-30', idempotencyKey: 'mv-hard' });
  assert.equal(hard.ok, false);
  assert.equal(hard.error, 'period_locked');
  assert.equal(hard.kind, 'hard');

  assert.equal(lockPeriodSealed(w.ctx, { period: '2025', reason: 'year_close', idempotencyKey: 'seal-2025' }).ok, true);
  const sealed = move(w, { effectiveDate: '2025-12-31', idempotencyKey: 'mv-sealed' });
  assert.equal(sealed.ok, false);
  assert.equal(sealed.error, 'period_locked');
  assert.equal(sealed.reason, 'year_close');
  assert.equal(rows(w), before, 'neither refusal minted a row');
});

test('inventory_move in an open month passes beside a closed one', () => {
  const w = world();
  assert.equal(softCloseMonth(w.ctx, { period: '2026-03', idempotencyKey: 'close-03' }).ok, true);
  const before = rows(w);
  const r = move(w, { effectiveDate: '2026-04-01', idempotencyKey: 'mv-open' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.movement.effectiveDate, '2026-04-01');
  assert.equal(rows(w), before + 1);
});

test('a replay of a move made while the month was open still answers its original row after the close', () => {
  const w = world();
  const first = move(w, { idempotencyKey: 'mv-before-close' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(softCloseMonth(w.ctx, { period: '2026-03', idempotencyKey: 'close-03' }).ok, true);
  const before = rows(w);
  const replay = move(w, { idempotencyKey: 'mv-before-close' });
  assert.equal(replay.ok, true, `the replay was refused: ${JSON.stringify(replay)}`);
  assert.equal(replay.movement.id, first.movement.id);
  assert.equal(rows(w), before, 'the replay wrote nothing');
});

test('inventory_transfer into a locked month is refused before EITHER leg is written; an open month passes', () => {
  const w = world();
  const to = secondLocation(w);
  assert.equal(move(w, { qty: 20, effectiveDate: '2026-02-01', idempotencyKey: 'seed' }).ok, true);
  assert.equal(softCloseMonth(w.ctx, { period: '2026-03', idempotencyKey: 'close-03' }).ok, true);
  const before = rows(w);

  const locked = inventoryTransfer(w.ctx, {
    itemId: w.itemId,
    fromLocationId: w.locationId,
    toLocationId: to,
    qty: 5,
    effectiveDate: '2026-03-20',
    idempotencyKey: 'xfer-locked',
  });
  assert.equal(locked.ok, false, `the transfer into the closed month ran: ${JSON.stringify(locked)}`);
  assert.equal(locked.error, 'period_locked');
  assert.equal(locked.period, '2026-03');
  assert.equal(rows(w), before, 'neither leg was written');

  const open = inventoryTransfer(w.ctx, {
    itemId: w.itemId,
    fromLocationId: w.locationId,
    toLocationId: to,
    qty: 5,
    effectiveDate: '2026-04-02',
    idempotencyKey: 'xfer-open',
  });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.equal(rows(w), before + 2, 'the open-month transfer wrote its pair');
});

test('over the registry (the wire an agent uses), inventory_move and inventory_transfer refuse a closed month', () => {
  const fx = fixture();
  const item = fx.call('create_item', { name: 'Wire Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'w-item' });
  const a = fx.call('stock_location_upsert', { name: 'Lager A', idempotencyKey: 'w-a' });
  const b = fx.call('stock_location_upsert', { name: 'Lager B', idempotencyKey: 'w-b' });
  assert.equal(
    fx.call('inventory_move', { itemId: item.item.id, locationId: a.location.id, qty: 9, movementType: 'receipt', effectiveDate: '2026-02-01', idempotencyKey: 'w-seed' }).ok,
    true,
  );
  const closed = fx.call('close_month', { period: '2026-03', idempotencyKey: 'w-close' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const count = () => fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?').get(fx.workspaceId).n;
  const before = count();

  const mv = getAction('inventory_move').run(fx.deps, {
    workspaceId: fx.workspaceId,
    itemId: item.item.id,
    locationId: a.location.id,
    qty: -2,
    movementType: 'issue',
    effectiveDate: '2026-03-31',
    idempotencyKey: 'w-mv',
  });
  assert.equal(mv.ok, false);
  assert.equal(mv.error, 'period_locked');
  const xf = fx.call('inventory_transfer', {
    itemId: item.item.id,
    fromLocationId: a.location.id,
    toLocationId: b.location.id,
    qty: 1,
    effectiveDate: '2026-03-31',
    idempotencyKey: 'w-xf',
  });
  assert.equal(xf.ok, false);
  assert.equal(xf.error, 'period_locked');
  assert.equal(count(), before);
});
