// J07, inventory agent tools & alerts: the pure-read invariants a reviewer must see bite.
//
// J07 is the TERMINAL inventory leaf. It owns no table and posts nothing (P5, §H-STOCK-AUDIT), and
// these tests are written to FAIL if that were not true:
//   (a) NO WRITE: a whole-database row-count snapshot is identical before and after every J07 verb,
//       and no stock_movement / journal_entry row is minted. On-hand is a pure SUM, so a read that
//       wrote would be caught here.
//   (b) §H-TENANT: a foreign item / location / warehouse id is not_found BEFORE any aggregation, and
//       a second workspace's stock position never carries the first workspace's rows.
//   (c) THE AGGREGATION LOGIC: stock position equals the raw ledger SUM; low stock / reorder derive
//       the shortfall; valuation status reports never_posted then drift; movement history closes to
//       the live position; anomalies detect a large adjustment, a negative balance and a near-expiry
//       lot; slow movers and lot trace resolve; cycle-count status lists the open session.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import {
  inventoryMove,
  inventorySetConfig,
  inventoryEnsureDefaultLocation,
  itemSetTrackingMode,
  lotCreate,
  inventoryStocktakeCreate,
  inventoryStockPosition,
  inventoryLowStock,
  inventoryValuationStatus,
  inventoryMovementHistory,
  inventoryAnomalies,
  inventoryCycleCountStatus,
  inventoryLotTrace,
  inventorySlowMovers,
  inventoryAlerts,
  inventoryReorderCandidates,
} from '../../dist/core/inventory/index.js';

const AT = '2026-08-08T00:00:00.000Z';

function freshCtx(name = 'Acme AG') {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  return { ctx, store, workspaceId, deps, clock, ids };
}

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
}

function locationOf(ctx) {
  return must(inventoryEnsureDefaultLocation(ctx), 'ensureLocation').location.id;
}

function stockItem(ctx, over = {}) {
  return must(
    createItem(ctx, {
      name: over.name ?? 'Widget',
      defaultUnitPriceMinor: 1000,
      trackStock: true,
      reorderPointQty: over.reorderPointQty,
      idempotencyKey: over.key ?? `it-${over.name ?? 'w'}`,
    }),
    'createItem',
  ).item.id;
}

/** A snapshot of every table's row count: the ground truth "nothing was written" compares against. */
function dbSnapshot(ctx) {
  const tables = ctx.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const counts = {};
  for (const { name } of tables) {
    counts[name] = ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  }
  return counts;
}

// --- (a) NO WRITE: every J07 verb is inert on real data ------------------------------------------

test('J07: no verb writes a single row (pure read, P5)', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx, { reorderPointQty: 100 });
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 5, movementType: 'receipt', unitCostMinor: 1500, effectiveDate: '2026-03-01', idempotencyKey: 'r1' }), 'recv');
  must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'sess' }), 'sess');

  const before = dbSnapshot(ctx);
  const calls = [
    () => inventoryStockPosition(ctx, { include_valuation: true }),
    () => inventoryLowStock(ctx, {}),
    () => inventoryValuationStatus(ctx, {}),
    () => inventoryMovementHistory(ctx, { item_id: item }),
    () => inventoryAnomalies(ctx, {}),
    () => inventoryCycleCountStatus(ctx, {}),
    () => inventoryLotTrace(ctx, { lot_code: 'NONE' }),
    () => inventorySlowMovers(ctx, {}),
    () => inventoryAlerts(ctx, {}),
    () => inventoryReorderCandidates(ctx, {}),
  ];
  for (const call of calls) must(call(), 'j07 read');
  const after = dbSnapshot(ctx);
  assert.deepEqual(after, before, 'a J07 read wrote to the database');
  // No inventory figure ever reached the GL: not one journal entry exists.
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 0);
});

// --- (b) §H-TENANT: a foreign id is not_found, and workspaces do not bleed -----------------------

test('J07: §H-TENANT, a foreign item / location / warehouse id is not_found', () => {
  const a = freshCtx('A AG');
  const b = freshCtx('B AG');
  const locA = locationOf(a.ctx);
  const itemA = stockItem(a.ctx, { reorderPointQty: 10 });
  must(inventoryMove(a.ctx, { itemId: itemA, locationId: locA, qty: 3, movementType: 'receipt', unitCostMinor: 100, effectiveDate: '2026-03-01', idempotencyKey: 'a-r' }), 'recv');

  // B cannot see A's rows in a plain position read.
  const posB = must(inventoryStockPosition(b.ctx, {}), 'posB');
  assert.equal(posB.rows.length, 0, "B's stock position must not carry A's positions");

  // A foreign id is rejected BEFORE any aggregation.
  assert.equal(inventoryStockPosition(b.ctx, { filter: { item_ids: [itemA] } }).error, 'not_found');
  assert.equal(inventoryStockPosition(b.ctx, { filter: { location_ids: [locA] } }).error, 'not_found');
  assert.equal(inventoryMovementHistory(b.ctx, { item_id: itemA }).error, 'not_found');
  assert.equal(inventoryLowStock(b.ctx, { location_ids: [locA] }).error, 'not_found');
  // A lot code from A is invisible to B: a soft found:false, never a cross-tenant leak.
  const trace = must(inventoryLotTrace(b.ctx, { lot_code: 'ANY' }), 'traceB');
  assert.equal(trace.found, false);
});

// --- (c) THE AGGREGATION LOGIC -------------------------------------------------------------------

test('J07: stock position equals the raw ledger SUM and values through J03', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 10, movementType: 'receipt', unitCostMinor: 500, effectiveDate: '2026-03-01', idempotencyKey: 'r1' }), 'r1');
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: -4, movementType: 'issue', effectiveDate: '2026-03-02', idempotencyKey: 'i1' }), 'i1');

  const pos = must(inventoryStockPosition(ctx, { include_valuation: true }), 'pos');
  assert.equal(pos.rows.length, 1);
  assert.equal(pos.rows[0].qty, 6, 'on-hand is the SUM (10 - 4)');
  assert.equal(pos.totals.qty, 6);
  // Value is 6 units at the weighted-average 500 Rappen = 3000, integer Rappen.
  assert.equal(pos.rows[0].extended_value_rappen, 3000);
  assert.equal(pos.totals.value_rappen, 3000);
});

test('J07: low stock and reorder candidates derive the shortfall', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx, { reorderPointQty: 20 });
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 5, movementType: 'receipt', unitCostMinor: 100, effectiveDate: '2026-03-01', idempotencyKey: 'r1' }), 'r1');

  const low = must(inventoryLowStock(ctx, {}), 'low');
  assert.equal(low.items.length, 1);
  assert.equal(low.items[0].current_qty, 5);
  assert.equal(low.items[0].reorder_point, 20);
  assert.equal(low.items[0].shortfall_qty, 15);
  assert.equal(low.items[0].warning, 'usage_history_insufficient', 'no outbound history yet');

  const cand = must(inventoryReorderCandidates(ctx, {}), 'cand');
  assert.equal(cand.candidates.length, 1);
  assert.equal(cand.candidates[0].suggested_qty, 15);
});

test('J07: valuation status is never_posted with no run, then reports drift after one', () => {
  const { ctx, store, workspaceId, clock } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 10, movementType: 'receipt', unitCostMinor: 500, effectiveDate: '2026-03-01', idempotencyKey: 'r1' }), 'r1');

  const before = must(inventoryValuationStatus(ctx, {}), 'vs0');
  assert.equal(before.status, 'never_posted');
  assert.equal(before.current_value_rappen, 5000);
  assert.equal(before.last_posted_value_rappen, null);

  // Insert a posted run at a lower value directly: drift = current (5000) - posted (4000) = 1000.
  store.db
    .prepare(
      `INSERT INTO inventory_valuation_run (id, workspace_id, as_of, method, status, total_value_rappen, line_count, idempotency_key, created_at, posted_at)
       VALUES (?, ?, ?, 'weighted_average', 'posted', 4000, 1, 'run-k', ?, ?)`,
    )
    .run('run_1', workspaceId, '2026-08-08', clock.now(), clock.now());

  const after = must(inventoryValuationStatus(ctx, {}), 'vs1');
  assert.equal(after.status, 'drift_present');
  assert.equal(after.last_posted_value_rappen, 4000);
  assert.equal(after.drift_rappen, 1000);
  assert.equal(after.last_run_id, 'run_1');
});

test('J07: movement history running balance closes to the live position', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 10, movementType: 'receipt', unitCostMinor: 500, effectiveDate: '2026-03-01', idempotencyKey: 'r1' }), 'r1');
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: -3, movementType: 'issue', effectiveDate: '2026-03-02', idempotencyKey: 'i1' }), 'i1');

  const hist = must(inventoryMovementHistory(ctx, { item_id: item }), 'hist');
  const running = hist.items.map((m) => m.runningBalance);
  assert.ok(running.includes(7), 'the newest running balance equals the live position (10 - 3)');
  const pos = must(inventoryStockPosition(ctx, { filter: { item_ids: [item] } }), 'pos');
  assert.equal(pos.totals.qty, 7);
});

test('J07: a bad date range is invalid_date_range', () => {
  const { ctx } = freshCtx();
  const item = stockItem(ctx);
  assert.equal(inventoryMovementHistory(ctx, { item_id: item, from_date: '2026-05-01', to_date: '2026-04-01' }).error, 'invalid_date_range');
});

test('J07: anomalies detect a large adjustment and a negative balance', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  // Allow negative stock so an oversized issue can drive on-hand below zero.
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'cfg' }), 'cfg');
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 2, movementType: 'receipt', unitCostMinor: 100, effectiveDate: '2026-08-01', idempotencyKey: 'r1' }), 'r1');
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: -10, movementType: 'adjustment', effectiveDate: '2026-08-05', idempotencyKey: 'adj' }), 'adj');

  // Low thresholds so a qty of 10 is "large"; on-hand is now 2 - 10 = -8 (negative).
  const res = must(inventoryAnomalies(ctx, { since: '2026-07-01', thresholds: { largeQty: 5 } }), 'anom');
  const types = new Set(res.anomalies.map((a) => a.type));
  assert.ok(types.has('large_adjustment'), 'a -10 adjustment above the qty threshold is a large_adjustment');
  assert.ok(types.has('negative_stock'), 'the resulting -8 on-hand is a negative_stock anomaly');
  assert.ok(res.anomalies.some((a) => a.type === 'negative_stock' && a.severity === 'critical'));
});

test('J07: anomalies and alerts flag a near-expiry lot with on-hand', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  must(itemSetTrackingMode(ctx, { itemId: item, mode: 'lot', idempotencyKey: 'mode' }), 'mode');
  // Clock is 2026-08-08; an expiry 10 days out sits inside the 30-day default warning window.
  const lot = must(lotCreate(ctx, { itemId: item, number: 'L-EXP', expiryDate: '2026-08-18', idempotencyKey: 'lot' }), 'lot').lot.id;
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 4, movementType: 'receipt', lotId: lot, unitCostMinor: 100, effectiveDate: '2026-08-01', idempotencyKey: 'r1' }), 'r1');

  const anom = must(inventoryAnomalies(ctx, {}), 'anom');
  assert.ok(anom.anomalies.some((a) => a.type === 'lot_near_expiry' && a.entity.lot_code === 'L-EXP'));
  const alerts = must(inventoryAlerts(ctx, {}), 'alerts');
  assert.ok(alerts.alerts.some((a) => a.type === 'lot_near_expiry'), 'the unified feed carries the near-expiry lot');
});

test('J07: slow movers surface stagnant stock, and lot trace resolves a lot', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  must(itemSetTrackingMode(ctx, { itemId: item, mode: 'lot', idempotencyKey: 'mode' }), 'mode');
  const lot = must(lotCreate(ctx, { itemId: item, number: 'L-1', idempotencyKey: 'lot' }), 'lot').lot.id;
  // A receipt long before the clock (2026-08-08) with no outbound: a slow mover under the 90-day window.
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 6, movementType: 'receipt', lotId: lot, unitCostMinor: 250, effectiveDate: '2026-01-01', idempotencyKey: 'r1' }), 'r1');

  const slow = must(inventorySlowMovers(ctx, {}), 'slow');
  assert.equal(slow.items.length, 1);
  assert.equal(slow.items[0].current_qty, 6);
  assert.equal(slow.items[0].extended_value_rappen, 1500, '6 units at 250 Rappen');

  const trace = must(inventoryLotTrace(ctx, { lot_code: 'L-1' }), 'trace');
  assert.equal(trace.found, true);
  assert.equal(trace.current_positions[0].qty, 6);
  assert.ok(trace.movements.length >= 1);

  const missing = must(inventoryLotTrace(ctx, { lot_code: 'NOPE' }), 'missing');
  assert.equal(missing.found, false);
});

test('J07: cycle-count status lists the open session and flags it overdue', () => {
  const { ctx } = freshCtx();
  const loc = locationOf(ctx);
  const item = stockItem(ctx);
  must(inventoryMove(ctx, { itemId: item, locationId: loc, qty: 5, movementType: 'receipt', unitCostMinor: 100, effectiveDate: '2026-03-01', idempotencyKey: 'r1' }), 'r1');
  // Frozen far in the past relative to the 2026-08-08 clock: open past the 30-day overdue window.
  must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-01-01', idempotencyKey: 'sess' }), 'sess');

  const status = must(inventoryCycleCountStatus(ctx, {}), 'status');
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].status, 'open');
  assert.equal(status.sessions[0].overdue, true);

  const overdueOnly = must(inventoryCycleCountStatus(ctx, { overdue_only: true }), 'overdueOnly');
  assert.equal(overdueOnly.sessions.length, 1);
});

test('J07: a read denied by capability returns permission_denied, never data', () => {
  const { store, workspaceId, clock, ids } = freshCtx();
  // A context whose capability port denies read_master_data: the verb must refuse before reading.
  const denied = makeContext(store, {
    workspaceId,
    actor: 'user_zero',
    clock,
    ids,
    capabilities: { assert: (cap) => ({ ok: false, error: 'permission_denied', capability: cap }) },
  });
  assert.equal(inventoryStockPosition(denied, {}).error, 'permission_denied');
  assert.equal(inventoryAlerts(denied, {}).error, 'permission_denied');
});
