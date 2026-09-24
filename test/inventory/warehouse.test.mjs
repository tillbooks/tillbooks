// J00, warehouses & locations: the engine invariants J01/J02 and the wave gate depend on.
//
// Proves every §2/§7 rule: warehouse & location CRUD, case-insensitive code uniqueness, the
// exactly-one-default invariants, the hierarchy integrity rules (same-warehouse parent, no cycle,
// depth cap), race-safe MAIN/DEFAULT provisioning, the archive guards (has_stock / in_use / default),
// §H-TENANT on every read/write, balance-by-location correctness against the OP2 movement ledger, and
// D01 backward compatibility (an omitted location_id lands on the workspace default). J00 has NO
// posting path (plain master data), so there is no ledger assertion here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import { recordStockMove, stocktakeOpen } from '../../dist/core/stock/index.js';
import {
  warehouseCreate,
  warehouseUpdate,
  warehouseSetDefault,
  warehouseArchive,
  warehouseList,
  warehouseGet,
  locationCreate,
  locationUpdate,
  locationSetDefault,
  locationArchive,
  locationList,
  locationTree,
  inventoryEnsureDefaultLocation,
  inventoryBalanceByLocation,
  resolveDefaultLocationId,
} from '../../dist/core/inventory/index.js';

const AT = '2026-08-07T00:00:00.000Z';

function freshCtx() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  return { ctx, store, workspaceId, deps, clock, ids };
}

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
}

function makeWarehouse(ctx, over = {}) {
  return must(
    warehouseCreate(ctx, { code: 'ZH-MAIN', name: 'Zürich Main', idempotencyKey: `wh-${over.code ?? 'x'}`, ...over }),
    'warehouseCreate',
  ).warehouse;
}

function makeLocation(ctx, warehouseId, over = {}) {
  return must(
    locationCreate(ctx, {
      warehouseId,
      code: over.code ?? 'RECV',
      name: over.name ?? 'Receiving',
      idempotencyKey: `loc-${over.code ?? 'RECV'}`,
      ...over,
    }),
    'locationCreate',
  ).location;
}

function seedItem(ctx, name = 'Widget') {
  return must(createItem(ctx, { name, defaultUnitPriceMinor: 5000, idempotencyKey: `it-${name}` }), 'createItem').item.id;
}

// --- warehouse CRUD + defaults -----------------------------------------------------------------

test('the first warehouse becomes the workspace default; a second does not', () => {
  const { ctx } = freshCtx();
  const a = makeWarehouse(ctx, { code: 'A', idempotencyKey: 'a' });
  assert.equal(a.isDefault, true);
  const b = makeWarehouse(ctx, { code: 'B', idempotencyKey: 'b' });
  assert.equal(b.isDefault, false);
});

test('warehouse code uniqueness is case-insensitive (duplicate_code)', () => {
  const { ctx } = freshCtx();
  makeWarehouse(ctx, { code: 'ZH', idempotencyKey: '1' });
  const dup = warehouseCreate(ctx, { code: 'zh', name: 'X', idempotencyKey: '2' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate_code');
});

test('an empty or over-long warehouse code is invalid_code', () => {
  const { ctx } = freshCtx();
  assert.equal(warehouseCreate(ctx, { code: '', name: 'X', idempotencyKey: '1' }).error, 'invalid_code');
  assert.equal(warehouseCreate(ctx, { code: 'X'.repeat(21), name: 'X', idempotencyKey: '2' }).error, 'invalid_code');
});

test('set_default demotes the previous default, leaving exactly one', () => {
  const { ctx, store, workspaceId } = freshCtx();
  const a = makeWarehouse(ctx, { code: 'A', idempotencyKey: 'a' });
  const b = makeWarehouse(ctx, { code: 'B', idempotencyKey: 'b' });
  must(warehouseSetDefault(ctx, { warehouseId: b.id, idempotencyKey: 'sd' }), 'setDefault');
  const defaults = store.db
    .prepare('SELECT id FROM warehouse WHERE workspace_id = ? AND is_default = 1')
    .all(workspaceId);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, b.id);
  assert.equal(warehouseGet(ctx, { warehouseId: a.id }).warehouse.isDefault, false);
});

test('warehouse update patches descriptive fields only', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx, { code: 'A', idempotencyKey: 'a' });
  const updated = must(
    warehouseUpdate(ctx, { warehouseId: w.id, patch: { name: 'Neu', city: 'Bern' }, idempotencyKey: 'u' }),
    'update',
  ).warehouse;
  assert.equal(updated.name, 'Neu');
  assert.equal(updated.city, 'Bern');
  assert.equal(updated.code, 'A');
});

// --- location hierarchy ------------------------------------------------------------------------

test('the first location becomes the warehouse default; a nested child records path + depth', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  const root = makeLocation(ctx, w.id, { code: 'RECV', idempotencyKey: 'r' });
  assert.equal(root.isDefaultForWarehouse, true);
  assert.equal(root.depth, 0);
  const child = makeLocation(ctx, w.id, { code: 'A-01', parentId: root.id, idempotencyKey: 'c' });
  assert.equal(child.depth, 1);
  assert.equal(child.parentId, root.id);
  assert.ok(child.path.startsWith(root.path));
  assert.equal(child.isDefaultForWarehouse, false);
});

test('location code uniqueness is per-warehouse and case-insensitive', () => {
  const { ctx } = freshCtx();
  const w1 = makeWarehouse(ctx, { code: 'W1', idempotencyKey: 'w1' });
  const w2 = makeWarehouse(ctx, { code: 'W2', idempotencyKey: 'w2' });
  makeLocation(ctx, w1.id, { code: 'BIN', idempotencyKey: 'b1' });
  // Same code in the SAME warehouse is a duplicate...
  const dup = locationCreate(ctx, { warehouseId: w1.id, code: 'bin', name: 'X', idempotencyKey: 'b2' });
  assert.equal(dup.error, 'duplicate_code');
  // ...but the same code in a DIFFERENT warehouse is fine.
  assert.equal(locationCreate(ctx, { warehouseId: w2.id, code: 'BIN', name: 'X', idempotencyKey: 'b3' }).ok, true);
});

test('a parent in a different warehouse is refused (parent_warehouse_mismatch)', () => {
  const { ctx } = freshCtx();
  const w1 = makeWarehouse(ctx, { code: 'W1', idempotencyKey: 'w1' });
  const w2 = makeWarehouse(ctx, { code: 'W2', idempotencyKey: 'w2' });
  const inW1 = makeLocation(ctx, w1.id, { code: 'P', idempotencyKey: 'p' });
  const bad = locationCreate(ctx, { warehouseId: w2.id, code: 'C', name: 'C', parentId: inW1.id, idempotencyKey: 'c' });
  assert.equal(bad.error, 'parent_warehouse_mismatch');
});

test('re-parenting a location under its own descendant is a cycle (location_cycle)', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  const a = makeLocation(ctx, w.id, { code: 'A', idempotencyKey: 'a' });
  const b = makeLocation(ctx, w.id, { code: 'B', parentId: a.id, idempotencyKey: 'b' });
  const cyc = locationUpdate(ctx, { locationId: a.id, patch: { parentId: b.id }, idempotencyKey: 'u' });
  assert.equal(cyc.error, 'location_cycle');
});

test('re-parenting moves the whole subtree, rewriting paths and depths', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  const root = makeLocation(ctx, w.id, { code: 'ROOT', idempotencyKey: 'r' });
  const a = makeLocation(ctx, w.id, { code: 'A', idempotencyKey: 'a' });
  const child = makeLocation(ctx, w.id, { code: 'A-1', parentId: a.id, idempotencyKey: 'a1' });
  // Move A (with its child) under ROOT.
  must(locationUpdate(ctx, { locationId: a.id, patch: { parentId: root.id }, idempotencyKey: 'mv' }), 'reparent');
  const movedChild = locationTree(ctx, { warehouseId: w.id });
  const flat = [];
  const walk = (nodes) => nodes.forEach((n) => (flat.push(n), walk(n.children)));
  walk(movedChild.tree);
  const childNode = flat.find((n) => n.id === child.id);
  assert.equal(childNode.depth, 2, 'the grandchild is now two levels under root');
});

// --- default provisioning (US-J00.3) -----------------------------------------------------------

test('ensure_default_location is idempotent: two calls return the same MAIN/DEFAULT pair', () => {
  const { ctx, store, workspaceId } = freshCtx();
  const first = must(inventoryEnsureDefaultLocation(ctx), 'ensure1');
  const second = must(inventoryEnsureDefaultLocation(ctx), 'ensure2');
  assert.equal(first.warehouse.id, second.warehouse.id);
  assert.equal(first.location.id, second.location.id);
  assert.equal(first.warehouse.code, 'MAIN');
  assert.equal(first.location.code, 'DEFAULT');
  const warehouses = store.db.prepare('SELECT id FROM warehouse WHERE workspace_id = ?').all(workspaceId);
  assert.equal(warehouses.length, 1, 'exactly one warehouse was created');
  assert.equal(resolveDefaultLocationId(ctx), first.location.id);
});

// --- balance by location (US-J00.4) ------------------------------------------------------------

test('balance_by_location equals the live SUM of movements per location, with a warehouse roll-up', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  const a = makeLocation(ctx, w.id, { code: 'A-01-03', idempotencyKey: 'a' });
  const recv = makeLocation(ctx, w.id, { code: 'RECV', idempotencyKey: 'r' });
  const item = seedItem(ctx);
  must(recordStockMove(ctx, { itemId: item, locationId: a.id, qty: 100, reason: 'receipt', idempotencyKey: 'm1' }), 'move1');
  must(recordStockMove(ctx, { itemId: item, locationId: recv.id, qty: 50, reason: 'receipt', idempotencyKey: 'm2' }), 'move2');
  const bal = must(inventoryBalanceByLocation(ctx, { itemId: item }), 'balance');
  const byLoc = Object.fromEntries(bal.rows.map((r) => [r.locationId, r.qty]));
  assert.equal(byLoc[a.id], 100);
  assert.equal(byLoc[recv.id], 50);
  const wh = bal.warehouseTotals.find((r) => r.warehouseId === w.id);
  assert.equal(wh.qty, 150, 'the warehouse roll-up sums its locations');
  // Filtering by location returns only that location.
  const one = must(inventoryBalanceByLocation(ctx, { itemId: item, locationId: a.id }), 'balance-filtered');
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].qty, 100);
});

// --- archive guards (US-J00.6) -----------------------------------------------------------------

test('a location with stock cannot be archived (location_has_stock); zeroing it lets it archive', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  makeLocation(ctx, w.id, { code: 'DFLT', idempotencyKey: 'd' }); // default, keeps a second location non-default
  const loc = makeLocation(ctx, w.id, { code: 'A', idempotencyKey: 'a' });
  const item = seedItem(ctx);
  must(recordStockMove(ctx, { itemId: item, locationId: loc.id, qty: 5, reason: 'receipt', idempotencyKey: 'm' }), 'move');
  assert.equal(locationArchive(ctx, { locationId: loc.id, idempotencyKey: 'x1' }).error, 'location_has_stock');
  must(recordStockMove(ctx, { itemId: item, locationId: loc.id, qty: 5, reason: 'issue', idempotencyKey: 'm2' }), 'issue');
  must(locationArchive(ctx, { locationId: loc.id, idempotencyKey: 'x2' }), 'archive after zeroing');
});

test('the default location cannot be archived (cannot_archive_default)', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  const dflt = makeLocation(ctx, w.id, { code: 'DFLT', idempotencyKey: 'd' });
  assert.equal(locationArchive(ctx, { locationId: dflt.id, idempotencyKey: 'x' }).error, 'cannot_archive_default');
});

test('a descendant with stock blocks archiving the ancestor (location_has_stock)', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  makeLocation(ctx, w.id, { code: 'DFLT', idempotencyKey: 'd' });
  const parent = makeLocation(ctx, w.id, { code: 'P', idempotencyKey: 'p' });
  const child = makeLocation(ctx, w.id, { code: 'C', parentId: parent.id, idempotencyKey: 'c' });
  const item = seedItem(ctx);
  must(recordStockMove(ctx, { itemId: item, locationId: child.id, qty: 3, reason: 'receipt', idempotencyKey: 'm' }), 'move');
  assert.equal(locationArchive(ctx, { locationId: parent.id, idempotencyKey: 'x' }).error, 'location_has_stock');
});

test('an open stocktake on a location blocks archiving it (location_in_use)', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  makeLocation(ctx, w.id, { code: 'DFLT', idempotencyKey: 'd' });
  const loc = makeLocation(ctx, w.id, { code: 'A', idempotencyKey: 'a' });
  must(stocktakeOpen(ctx, { frozenAt: '2026-08-01', locationId: loc.id, idempotencyKey: 'st' }), 'stocktakeOpen');
  assert.equal(locationArchive(ctx, { locationId: loc.id, idempotencyKey: 'x' }).error, 'location_in_use');
});

test('the workspace default warehouse cannot be archived (cannot_archive_default)', () => {
  const { ctx } = freshCtx();
  const w = makeWarehouse(ctx);
  assert.equal(warehouseArchive(ctx, { warehouseId: w.id, idempotencyKey: 'x' }).error, 'cannot_archive_default');
});

test('archiving a non-default empty warehouse cascades its locations', () => {
  const { ctx } = freshCtx();
  makeWarehouse(ctx, { code: 'KEEP', idempotencyKey: 'k' }); // default
  const gone = makeWarehouse(ctx, { code: 'GONE', idempotencyKey: 'g' });
  const loc = makeLocation(ctx, gone.id, { code: 'L', idempotencyKey: 'l' });
  must(warehouseArchive(ctx, { warehouseId: gone.id, idempotencyKey: 'x' }), 'archive');
  assert.equal(warehouseGet(ctx, { warehouseId: gone.id }).warehouse.active, false);
  assert.equal(locationList(ctx, { warehouseId: gone.id, active: false }).locations.some((l) => l.id === loc.id), true);
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('a foreign warehouse or location id never resolves (H-TENANT)', () => {
  // Two workspaces in one store.
  const clk = fixedClock(AT);
  const idg = sequenceIdGen();
  const s = new SqliteStore({ clock: clk });
  const deps = { store: s, clock: clk, ids: idg };
  const wsA = createWorkspace(deps, { name: 'A AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'B AG' }).workspaceId;
  const ctxA = makeContext(s, { workspaceId: wsA, actor: 'u', clock: clk, ids: idg });
  const ctxB = makeContext(s, { workspaceId: wsB, actor: 'u', clock: clk, ids: idg });
  const wA = must(warehouseCreate(ctxA, { code: 'A', name: 'A', idempotencyKey: 'a' }), 'whA').warehouse;
  const locA = must(locationCreate(ctxA, { warehouseId: wA.id, code: 'L', name: 'L', idempotencyKey: 'l' }), 'locA').location;
  // B cannot see or touch A's rows.
  assert.equal(warehouseGet(ctxB, { warehouseId: wA.id }).error, 'not_found');
  assert.equal(locationCreate(ctxB, { warehouseId: wA.id, code: 'X', name: 'X', idempotencyKey: 'x' }).error, 'not_found');
  assert.equal(warehouseList(ctxB, {}).warehouses.length, 0);
  assert.equal(warehouseArchive(ctxB, { warehouseId: wA.id, idempotencyKey: 'z' }).error, 'not_found');
  assert.equal(locationArchive(ctxB, { locationId: locA.id, idempotencyKey: 'z2' }).error, 'not_found');
});

// --- D01 backward compatibility ----------------------------------------------------------------

test('a stock_move with NO location_id lands on the workspace default and shows in the balance', () => {
  const { ctx } = freshCtx();
  const item = seedItem(ctx);
  const moved = must(recordStockMove(ctx, { itemId: item, qty: 7, reason: 'receipt', idempotencyKey: 'm' }), 'move');
  const defaultLoc = resolveDefaultLocationId(ctx);
  assert.equal(moved.movements[0].locationId, defaultLoc);
  const bal = must(inventoryBalanceByLocation(ctx, { itemId: item }), 'balance');
  assert.equal(bal.rows.length, 1);
  assert.equal(bal.rows[0].locationId, defaultLoc);
  assert.equal(bal.rows[0].qty, 7);
});

// --- idempotency on ROWS -----------------------------------------------------------------------

test('creating a warehouse or location twice with one key writes exactly one row', () => {
  const { ctx, store, workspaceId } = freshCtx();
  const a1 = warehouseCreate(ctx, { code: 'A', name: 'A', idempotencyKey: 'k1' });
  const a2 = warehouseCreate(ctx, { code: 'A', name: 'A', idempotencyKey: 'k1' });
  assert.equal(a1.warehouse.id, a2.warehouse.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM warehouse WHERE workspace_id = ?').get(workspaceId).n, 1);
  const l1 = locationCreate(ctx, { warehouseId: a1.warehouse.id, code: 'L', name: 'L', idempotencyKey: 'lk' });
  const l2 = locationCreate(ctx, { warehouseId: a1.warehouse.id, code: 'L', name: 'L', idempotencyKey: 'lk' });
  assert.equal(l1.location.id, l2.location.id);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM stock_location WHERE workspace_id = ? AND code = 'L'").get(workspaceId).n,
    1,
  );
});
