// J02, the inventory movement ledger: the MONEY-PATH invariants a non-author critic must see bite.
//
// This is the append-only quantity truth every later inventory capability (J03 valuation, J04
// stocktake, J05 adjustments, J06 GL link, I02 goods receipt, D03 delivery) writes through. Each test
// below is written to FAIL if its invariant were removed:
//   (a) APPEND-ONLY: a raw UPDATE or DELETE on a movement row is aborted by the DB trigger.
//   (b) ON-HAND == SUM: the balance a verb returns equals the explicit SUM of the rows, and a
//       movement is the only thing that moves it.
//   (c) IDEMPOTENT ON ROWS: a replayed idempotency key writes exactly one row (a transfer, one pair).
//   (d) §H-TENANT: a movement never crosses a workspace; a foreign id returns empty / not-found.
//   (e) TRACKING ENFORCEMENT: a tracked item's movement without the required lot / serial is refused.
//   (f) NEGATIVE-STOCK POLICY: an issue that would overdraw is refused before any row is written, and
//       the workspace opt-out lifts the guard.
//   (g) A SERIAL IS A UNIT OF ONE: an inbound movement for a serial already in stock is refused
//       before any write, so SUM(qty) for one serial can never reach 2.
// Plus the transfer atomicity / zero-sum invariant (§7.7) and the sign / enum guards.

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
  inventoryTransfer,
  inventoryBalance,
  inventoryMovementList,
  inventoryMovementGet,
  inventoryGetConfig,
  inventorySetConfig,
  itemSetTrackingMode,
  lotCreate,
  serialCreate,
  serialSetStatus,
  inventoryEnsureDefaultLocation,
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
      idempotencyKey: over.key ?? `it-${over.name ?? 'w'}`,
    }),
    'createItem',
  ).item.id;
}

/** The raw SUM of a filter, straight from SQL: the ground truth on-hand must equal. */
function rawSum(ctx, where = '', params = []) {
  const clause = where.length > 0 ? ` AND ${where}` : '';
  const row = ctx.store.db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ?${clause}`)
    .get(ctx.workspaceId, ...params);
  return row.n;
}

function rowCount(ctx) {
  return ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?')
    .get(ctx.workspaceId).n;
}

// --- (a) APPEND-ONLY ---------------------------------------------------------------------------

test('J02 (a): a movement row is immutable, the UPDATE trigger aborts', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  const m = must(
    inventoryMove(ctx, { itemId, locationId, qty: 10, movementType: 'receipt', unitCostMinor: 500, effectiveDate: '2026-03-01', idempotencyKey: 'a-1' }),
    'move',
  ).movement;

  assert.throws(
    () => ctx.store.db.prepare('UPDATE stock_movement SET qty = 999 WHERE id = ?').run(m.id),
    /stock_movement_immutable/,
    'a raw UPDATE on a movement must be aborted by the trigger',
  );
  // The quantity did not move, so on-hand is still the original.
  assert.equal(rawSum(ctx), 10);
});

test('J02 (a): a movement row is immutable, the DELETE trigger aborts', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  const m = must(
    inventoryMove(ctx, { itemId, locationId, qty: 10, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'a-2' }),
    'move',
  ).movement;

  assert.throws(
    () => ctx.store.db.prepare('DELETE FROM stock_movement WHERE id = ?').run(m.id),
    /stock_movement_immutable/,
    'a raw DELETE on a movement must be aborted by the trigger',
  );
  assert.equal(rowCount(ctx), 1);
});

// --- (b) ON-HAND == SUM ------------------------------------------------------------------------

test('J02 (b): on-hand is the pure SUM of movements after any sequence', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);

  must(inventoryMove(ctx, { itemId, locationId: a, qty: 100, movementType: 'opening', unitCostMinor: 500, effectiveDate: '2026-01-01', idempotencyKey: 'b-open' }), 'open');
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 30, movementType: 'receipt', unitCostMinor: 550, effectiveDate: '2026-02-01', idempotencyKey: 'b-recv' }), 'recv');
  must(inventoryMove(ctx, { itemId, locationId: a, qty: -20, movementType: 'issue', effectiveDate: '2026-03-01', idempotencyKey: 'b-iss' }), 'iss');
  must(inventoryMove(ctx, { itemId, locationId: a, qty: -5, movementType: 'scrap', effectiveDate: '2026-03-05', idempotencyKey: 'b-scr' }), 'scr');
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 7, movementType: 'adjustment', effectiveDate: '2026-03-10', idempotencyKey: 'b-adj' }), 'adj');

  const expected = 100 + 30 - 20 - 5 + 7; // 112
  assert.equal(rawSum(ctx), expected);
  const bal = must(inventoryBalance(ctx, { itemId, locationId: a }), 'balance');
  assert.equal(bal.qtyOnHand, expected, 'inventory_balance must equal the explicit SUM');

  // As-of cut-off is inclusive: everything up to 2026-03-01 is 100 + 30 - 20 = 110.
  const asOf = must(inventoryBalance(ctx, { itemId, locationId: a, asOf: '2026-03-01' }), 'asOf');
  assert.equal(asOf.qtyOnHand, 110);
});

test('J02 (b): a movement is the ONLY way on-hand changes (no mutable balance column)', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 40, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'b2-1' }), 'move');
  // There is no quantity column on item or a balance table to poke: the balance is recomputed every
  // read, so it can only equal the SUM. Prove it tracks a further movement exactly.
  assert.equal(must(inventoryBalance(ctx, { itemId }), 'bal1').qtyOnHand, 40);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: -15, movementType: 'issue', effectiveDate: '2026-03-02', idempotencyKey: 'b2-2' }), 'move2');
  assert.equal(must(inventoryBalance(ctx, { itemId }), 'bal2').qtyOnHand, 25);
});

// --- (c) IDEMPOTENT ON ROWS --------------------------------------------------------------------

test('J02 (c): a replayed move writes exactly one row and returns the original', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  const first = must(inventoryMove(ctx, { itemId, locationId: a, qty: 12, movementType: 'receipt', unitCostMinor: 700, effectiveDate: '2026-03-01', idempotencyKey: 'c-1' }), 'first');
  assert.equal(rowCount(ctx), 1);
  const second = inventoryMove(ctx, { itemId, locationId: a, qty: 12, movementType: 'receipt', unitCostMinor: 700, effectiveDate: '2026-03-01', idempotencyKey: 'c-1' });
  assert.equal(second.ok, true);
  assert.equal(rowCount(ctx), 1, 'a replay must not write a second row');
  assert.equal(second.movement.id, first.movement.id, 'a replay returns the original movement id');
  assert.equal(rawSum(ctx), 12, 'a replay does not double-count');
});

test('J02 (c): a replayed transfer writes exactly one pair', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  const b = ctx.store.db.prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND id != ? LIMIT 1').get(ctx.workspaceId, a)?.id
    ?? seedSecondLocation(ctx);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 50, movementType: 'receipt', unitCostMinor: 500, effectiveDate: '2026-03-01', idempotencyKey: 'c2-recv' }), 'recv');
  must(inventoryTransfer(ctx, { itemId, fromLocationId: a, toLocationId: b, qty: 20, effectiveDate: '2026-03-02', idempotencyKey: 'c2-x' }), 'xfer');
  assert.equal(rowCount(ctx), 3, 'receipt + two transfer legs');
  const replay = inventoryTransfer(ctx, { itemId, fromLocationId: a, toLocationId: b, qty: 20, effectiveDate: '2026-03-02', idempotencyKey: 'c2-x' });
  assert.equal(replay.ok, true);
  assert.equal(rowCount(ctx), 3, 'a replayed transfer must not write a second pair');
});

// --- (d) §H-TENANT -----------------------------------------------------------------------------

/**
 * Two workspaces inside ONE store, the way test/inventory/warehouse.test.mjs does it.
 *
 * This matters more than it looks. Building Alpha and Beta with two freshCtx() calls gives each its
 * own SqliteStore, so Beta's database holds no Alpha rows at all and a movement query that had LOST
 * its workspace filter entirely would still read zero. The assertions would stay green while the
 * invariant was gone. One store is what makes the filter the only thing standing between them.
 */
function twoWorkspaces() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'Alpha AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'Beta AG' }).workspaceId;
  return {
    store,
    a: { ctx: makeContext(store, { workspaceId: wsA, actor: 'user_1', clock, ids }), store, workspaceId: wsA },
    b: { ctx: makeContext(store, { workspaceId: wsB, actor: 'user_2', clock, ids }), store, workspaceId: wsB },
  };
}

test('J02 (d): a foreign workspace cannot see or reach another workspace movements', () => {
  const { store, a, b } = twoWorkspaces();
  const itemA = stockItem(a.ctx, { name: 'Alpha Widget', key: 'a-it' });
  const locA = locationOf(a.ctx);
  const locB = locationOf(b.ctx);
  const m = must(inventoryMove(a.ctx, { itemId: itemA, locationId: locA, qty: 33, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'd-1' }), 'move').movement;

  // The one store really does hold Alpha's row: without this the rest could pass on an empty database.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 1);
  assert.equal(rowCount(a.ctx), 1);
  assert.equal(rowCount(b.ctx), 0);

  // Beta sees nothing of Alpha's, through every read path.
  assert.equal(must(inventoryBalance(b.ctx, { itemId: itemA }), 'bBal').qtyOnHand, 0);
  assert.equal(must(inventoryMovementList(b.ctx, { itemId: itemA }), 'bList').total, 0);
  assert.equal(must(inventoryMovementList(b.ctx, {}), 'bListAll').total, 0);
  assert.equal(inventoryMovementGet(b.ctx, { movementId: m.id }).error, 'not_found');

  // Beta cannot WRITE against Alpha's item or Alpha's location either.
  assert.equal(inventoryMove(b.ctx, { itemId: itemA, locationId: locA, qty: 5, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'd-2' }).ok, false);
  assert.equal(inventoryTransfer(b.ctx, { itemId: itemA, fromLocationId: locA, toLocationId: locB, qty: 1, effectiveDate: '2026-03-01', idempotencyKey: 'd-3' }).ok, false);
  // No refused write left a row behind, in either workspace.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 1);

  // Alpha still holds its own.
  assert.equal(must(inventoryBalance(a.ctx, { itemId: itemA }), 'aBal').qtyOnHand, 33);
});

// --- (e) TRACKING ENFORCEMENT ------------------------------------------------------------------

test('J02 (e): a lot-tracked item refuses a movement with no lotId', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx, { name: 'Lot Widget', key: 'lot-it' });
  const a = locationOf(ctx);
  must(itemSetTrackingMode(ctx, { itemId, mode: 'lot', idempotencyKey: 'e-mode' }), 'mode');

  const refused = inventoryMove(ctx, { itemId, locationId: a, qty: 5, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'e-1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'lot_required');
  assert.equal(rowCount(ctx), 0, 'a refused tracked move writes nothing');

  const lotId = must(lotCreate(ctx, { itemId, number: 'L-1', idempotencyKey: 'e-lot' }), 'lot').lot.id;
  const okMove = must(inventoryMove(ctx, { itemId, locationId: a, qty: 5, movementType: 'receipt', lotId, effectiveDate: '2026-03-01', idempotencyKey: 'e-2' }), 'okMove');
  assert.equal(okMove.movement.lotId, lotId);
});

test('J02 (e): a serial-tracked item refuses a movement with no serialId', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx, { name: 'Serial Widget', key: 'ser-it' });
  const a = locationOf(ctx);
  must(itemSetTrackingMode(ctx, { itemId, mode: 'serial', idempotencyKey: 'e2-mode' }), 'mode');

  const refused = inventoryMove(ctx, { itemId, locationId: a, qty: 1, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'e2-1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'serial_required');

  const serialId = must(serialCreate(ctx, { itemId, number: 'SN-1', idempotencyKey: 'e2-ser' }), 'serial').serial.id;
  const okMove = must(inventoryMove(ctx, { itemId, locationId: a, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'e2-2' }), 'okMove');
  assert.equal(okMove.movement.serialId, serialId);
  // The serial projection followed the movement: the unit now sits at the location and is available.
  const s = ctx.store.db.prepare('SELECT current_location_id, status FROM serial WHERE id = ?').get(serialId);
  assert.equal(s.current_location_id, a);
  assert.equal(s.status, 'available');
});

// --- (f) NEGATIVE-STOCK POLICY -----------------------------------------------------------------

test('J02 (f): an overdrawing issue is refused before any row is written, then allowed on opt-out', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 10, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'f-recv' }), 'recv');
  const before = rowCount(ctx);

  const refused = inventoryMove(ctx, { itemId, locationId: a, qty: -15, movementType: 'issue', effectiveDate: '2026-03-02', idempotencyKey: 'f-over' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'insufficient_stock');
  assert.equal(refused.available, 10);
  assert.equal(rowCount(ctx), before, 'a refused issue must write nothing (no partial movement)');

  // Opt out: the guard lifts and the same issue succeeds, driving on-hand negative.
  assert.equal(must(inventoryGetConfig(ctx), 'cfg0').allowNegativeStock, false);
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'f-cfg' }), 'setCfg');
  assert.equal(must(inventoryGetConfig(ctx), 'cfg1').allowNegativeStock, true);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: -15, movementType: 'issue', effectiveDate: '2026-03-02', idempotencyKey: 'f-over2' }), 'nowOk');
  assert.equal(rawSum(ctx), -5, 'with negative stock allowed, on-hand may go below zero');
});

// --- (g) A SERIAL IS A UNIT OF ONE -------------------------------------------------------------

/**
 * A serial number identifies ONE physical unit, so the movement ledger must never hold two of it.
 * Receiving a serial that is already in stock leaves `SUM(qty)` = 2 for that serial, which is a
 * quantity the world cannot contain: every later reader (J03 valuation, J04 stocktake, J06 GL link)
 * then values, counts and books a unit that does not exist.
 *
 * WHAT "IN STOCK" MEANS IS J01'S RULE, NOT A NEW ONE. `serialArchive`
 * (`src/core/inventory/tracking.ts`) refuses to archive a serial whose status is `available` OR
 * `reserved`, on the stated grounds that both are still notionally in stock. The other three live
 * statuses (`issued`, `returned`, `scrapped`) are NOT in stock, and receiving such a unit back is a
 * legitimate inbound, so the guard must let them through. Filtering on `available` alone is the
 * exact mistake a neighbouring capability shipped twice, and the reserved test below is what makes
 * that mistake fail here.
 *
 * THE LEDGER IS WHERE THAT RULE IS TESTED, NOT THE STATUS COLUMN. Two tests below pin why. The
 * birth state: `serialCreate` writes status `available` with a NULL location and no movement at all
 * (J01 spec US-J01.3 creates the serial BEFORE the receipt), so a status test would refuse the very
 * FIRST receipt of every serial ever created, and each test below therefore receives its serial once
 * and asserts that first receipt succeeded. And the drifted projection: a unit whose status still
 * reads `issued` while the ledger holds it must be refused anyway. A J01 status transition never
 * writes a movement, so sum and status agree on the two statuses the archive path cares about; where
 * they drift, the ledger wins, because the sum is the truth and the status is a projection of it.
 */

/** The raw SUM of one serial's movements, across every location: the quantity that must stay 1. */
function serialSum(ctx, serialId) {
  return ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ? AND serial_id = ?')
    .get(ctx.workspaceId, serialId).n;
}

/** A serial-tracked item plus one serial on it, the setup every (g) test starts from. */
function serialSetup(ctx, { itemName, itemKey, number, prefix }) {
  const itemId = stockItem(ctx, { name: itemName, key: itemKey });
  must(itemSetTrackingMode(ctx, { itemId, mode: 'serial', idempotencyKey: `${prefix}-mode` }), 'mode');
  const serialId = must(serialCreate(ctx, { itemId, number, idempotencyKey: `${prefix}-ser` }), 'serial').serial.id;
  return { itemId, serialId, locationId: locationOf(ctx) };
}

test('J02 (g): receiving a serial that is already in stock (available) is refused, nothing is written', () => {
  const { ctx } = freshCtx();
  const { itemId, serialId, locationId } = serialSetup(ctx, {
    itemName: 'Serial Widget',
    itemKey: 'g1-it',
    number: 'SN-001',
    prefix: 'g1',
  });

  // The birth state (status available, no location, no movement) IS receivable: this must succeed.
  must(
    inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g1-r1' }),
    'first receipt',
  );
  assert.equal(serialSum(ctx, serialId), 1);
  const rowsBefore = rowCount(ctx);

  // The same unit received a second time, under a NEW key so idempotency cannot mask it.
  const refused = inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g1-r2' });
  assert.equal(refused.ok, false, 'a serial already in stock must not be received again');
  assert.equal(refused.error, 'serial_already_in_stock');
  assert.equal(refused.serialId, serialId, 'the rejection names the serial');
  assert.equal(refused.number, 'SN-001', 'the rejection names the serial number');
  assert.equal(refused.status, 'available');
  assert.equal(refused.onHand, 1);
  assert.equal(rowCount(ctx), rowsBefore, 'a refused inbound writes no row (the partial-write trap)');
  assert.equal(serialSum(ctx, serialId), 1, 'the quantity for one serial can never be 2');
  assert.equal(must(inventoryBalance(ctx, { serialId }), 'bal').qtyOnHand, 1);

  // And not at a SECOND location either: one unit cannot be in two warehouses, so the guard sums
  // the serial across the whole workspace. A per-location balance would wave this one through.
  const b = seedSecondLocation(ctx);
  const elsewhere = inventoryMove(ctx, { itemId, locationId: b, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g1-r3' });
  assert.equal(elsewhere.ok, false, 'the same unit cannot be received at a second location');
  assert.equal(elsewhere.error, 'serial_already_in_stock');
  assert.equal(rowCount(ctx), rowsBefore);
  assert.equal(serialSum(ctx, serialId), 1);
});

test('J02 (g): a RESERVED serial is still in stock, so receiving it again is refused', () => {
  const { ctx } = freshCtx();
  const { itemId, serialId, locationId } = serialSetup(ctx, {
    itemName: 'Reserved Widget',
    itemKey: 'g2-it',
    number: 'SN-A',
    prefix: 'g2',
  });
  must(
    inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g2-r1' }),
    'first receipt',
  );
  // Sales reserves the unit: no movement, only a J01 status transition.
  must(serialSetStatus(ctx, { serialId, status: 'reserved', idempotencyKey: 'g2-res' }), 'reserve');
  assert.equal(serialSum(ctx, serialId), 1);
  const rowsBefore = rowCount(ctx);

  const refused = inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g2-r2' });
  assert.equal(refused.ok, false, 'reserved is still notionally in stock (J01 serialArchive rule)');
  assert.equal(refused.error, 'serial_already_in_stock');
  assert.equal(refused.serialId, serialId);
  assert.equal(refused.status, 'reserved');
  assert.equal(rowCount(ctx), rowsBefore);
  assert.equal(serialSum(ctx, serialId), 1);
});

test('J02 (g): an issued, scrapped or returned serial is NOT in stock and stays receivable', () => {
  const { ctx } = freshCtx();

  // issued: the unit left on an issue movement, so it can come back.
  const issued = serialSetup(ctx, { itemName: 'Issued Widget', itemKey: 'g3-it', number: 'SN-I', prefix: 'g3' });
  must(inventoryMove(ctx, { itemId: issued.itemId, locationId: issued.locationId, qty: 1, movementType: 'receipt', serialId: issued.serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g3-r1' }), 'recv');
  must(inventoryMove(ctx, { itemId: issued.itemId, locationId: issued.locationId, qty: -1, movementType: 'issue', serialId: issued.serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g3-iss' }), 'issue');
  assert.equal(serialSum(ctx, issued.serialId), 0);
  must(inventoryMove(ctx, { itemId: issued.itemId, locationId: issued.locationId, qty: 1, movementType: 'receipt', serialId: issued.serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g3-r2' }), 'an issued serial may be received back');
  assert.equal(serialSum(ctx, issued.serialId), 1);

  // scrapped: written off, and a scrapped unit recovered is a legitimate inbound.
  const scrapped = serialSetup(ctx, { itemName: 'Scrapped Widget', itemKey: 'g4-it', number: 'SN-S', prefix: 'g4' });
  must(inventoryMove(ctx, { itemId: scrapped.itemId, locationId: scrapped.locationId, qty: 1, movementType: 'receipt', serialId: scrapped.serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g4-r1' }), 'recv');
  must(inventoryMove(ctx, { itemId: scrapped.itemId, locationId: scrapped.locationId, qty: -1, movementType: 'scrap', serialId: scrapped.serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g4-scr' }), 'scrap');
  assert.equal(ctx.store.db.prepare('SELECT status FROM serial WHERE id = ?').get(scrapped.serialId).status, 'scrapped');
  assert.equal(serialSum(ctx, scrapped.serialId), 0);
  must(inventoryMove(ctx, { itemId: scrapped.itemId, locationId: scrapped.locationId, qty: 1, movementType: 'receipt', serialId: scrapped.serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g4-r2' }), 'a scrapped serial may be received back');
  assert.equal(serialSum(ctx, scrapped.serialId), 1);

  // returned: sent back to the vendor (status returned, ledger balance 0), then re-received.
  const returned = serialSetup(ctx, { itemName: 'Returned Widget', itemKey: 'g5-it', number: 'SN-R', prefix: 'g5' });
  must(inventoryMove(ctx, { itemId: returned.itemId, locationId: returned.locationId, qty: 1, movementType: 'receipt', serialId: returned.serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g5-r1' }), 'recv');
  must(inventoryMove(ctx, { itemId: returned.itemId, locationId: returned.locationId, qty: -1, movementType: 'return', serialId: returned.serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g5-ret' }), 'return to vendor');
  assert.equal(ctx.store.db.prepare('SELECT status FROM serial WHERE id = ?').get(returned.serialId).status, 'returned');
  assert.equal(serialSum(ctx, returned.serialId), 0);
  must(inventoryMove(ctx, { itemId: returned.itemId, locationId: returned.locationId, qty: 1, movementType: 'receipt', serialId: returned.serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g5-r2' }), 'a returned serial may be received back');
  assert.equal(serialSum(ctx, returned.serialId), 1);
});

test('J02 (g): the guard follows the LEDGER, so a stale serial status cannot let a double through', () => {
  const { ctx } = freshCtx();
  const { itemId, serialId, locationId } = serialSetup(ctx, {
    itemName: 'Drifted Widget',
    itemKey: 'g10-it',
    number: 'SN-D',
    prefix: 'g10',
  });
  must(inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g10-r1' }), 'receipt');
  must(inventoryMove(ctx, { itemId, locationId, qty: -1, movementType: 'issue', serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g10-iss' }), 'issue');
  // A stocktake finds the unit again: an adjustment re-parks it without touching the status, which
  // is why `status` is a projection and the SUM is the truth.
  must(inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'adjustment', serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g10-adj' }), 'adjustment back in');
  assert.equal(ctx.store.db.prepare('SELECT status FROM serial WHERE id = ?').get(serialId).status, 'issued', 'the status column has drifted');
  assert.equal(serialSum(ctx, serialId), 1, 'but the ledger holds the unit');
  const rowsBefore = rowCount(ctx);

  // A guard reading the status column would read `issued`, wave this through and leave SUM = 2.
  const refused = inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-04', idempotencyKey: 'g10-r2' });
  assert.equal(refused.ok, false, 'the ledger holds the unit, so it cannot be received again');
  assert.equal(refused.error, 'serial_already_in_stock');
  assert.equal(refused.status, 'issued', 'the rejection reports the status it found, stale or not');
  assert.equal(rowCount(ctx), rowsBefore);
  assert.equal(serialSum(ctx, serialId), 1);
});

test('J02 (g): the guard covers every inbound type and is not lifted by allow_negative_stock', () => {
  const { ctx } = freshCtx();
  const { itemId, serialId, locationId } = serialSetup(ctx, {
    itemName: 'Inbound Widget',
    itemKey: 'g6-it',
    number: 'SN-IN',
    prefix: 'g6',
  });
  must(inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g6-r1' }), 'first receipt');
  const rowsBefore = rowCount(ctx);

  // Negative stock is a policy about aggregate quantity, not a licence to hold one unit twice.
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'g6-cfg' }), 'setCfg');

  for (const movementType of ['receipt', 'opening', 'transfer_in', 'adjustment', 'return']) {
    const refused = inventoryMove(ctx, { itemId, locationId, qty: 1, movementType, serialId, effectiveDate: '2026-03-02', idempotencyKey: `g6-${movementType}` });
    assert.equal(refused.ok, false, `${movementType} of an in-stock serial must be refused`);
    assert.equal(refused.error, 'serial_already_in_stock', `${movementType} must be refused by the serial guard`);
  }
  assert.equal(rowCount(ctx), rowsBefore, 'no refused inbound wrote a row');
  assert.equal(serialSum(ctx, serialId), 1);

  // An OUTBOUND for the same in-stock serial is untouched by the guard.
  must(inventoryMove(ctx, { itemId, locationId, qty: -1, movementType: 'issue', serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g6-iss' }), 'issue');
  assert.equal(serialSum(ctx, serialId), 0);
});

test('J02 (g): the guard is idempotent on ROWS, a replayed serial receipt still writes exactly one row', () => {
  const { ctx } = freshCtx();
  const { itemId, serialId, locationId } = serialSetup(ctx, {
    itemName: 'Replay Widget',
    itemKey: 'g7-it',
    number: 'SN-REPLAY',
    prefix: 'g7',
  });
  const args = { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g7-r1' };
  const first = must(inventoryMove(ctx, args), 'first receipt');
  assert.equal(rowCount(ctx), 1);

  // The SAME key replayed: the guard must not turn a replay into a rejection, and must not write a
  // second row either. A replay is the original, not a new inbound.
  const replay = inventoryMove(ctx, { ...args });
  assert.equal(replay.ok, true, 'a replayed serial receipt still returns the original, not the new guard');
  assert.equal(replay.movement.id, first.movement.id);
  assert.equal(rowCount(ctx), 1, 'a replay writes exactly one row');
  assert.equal(serialSum(ctx, serialId), 1, 'a replay does not double-count the unit');
});

/**
 * Put a raw movement row into ONE workspace's ledger, bypassing the verbs.
 *
 * A §H-TENANT assertion has to be falsifiable, and the verbs cannot produce the state that
 * falsifies this one: `inventory_move` refuses a foreign serial at `validateTracking` long before
 * the serial guard is reached, so Beta can never legitimately write a row naming Alpha's serial. A
 * test that only drives the verbs therefore gets its `not_found` from code that predates the guard,
 * and the guard's OWN workspace filter is never exercised: drop `workspace_id` from its SUM and
 * every such test still passes. That hollow shape is what this exists to avoid. The row below is
 * the state a missing filter would let matter, planted directly so the filter is the only thing
 * that decides the outcome.
 */
function plantMovement(ctx, { itemId, locationId, serialId, qty, key }) {
  ctx.store.db
    .prepare(
      `INSERT INTO stock_movement
         (id, workspace_id, item_id, location_id, serial_id, qty, reason, movement_type, moved_at, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, 'issue', 'issue', '2026-03-01', ?, ?)`,
    )
    .run(ctx.ids.next('planted'), ctx.workspaceId, itemId, locationId, serialId, qty, ctx.clock.now(), key);
}

test('J02 (g): §H-TENANT, the serial guard sums its OWN workspace only', () => {
  // ONE store, two workspaces (the warehouse.test.mjs pattern): with two stores Beta's database
  // would hold no Alpha rows at all and a guard that had lost its workspace filter would still
  // look clean. One store is what makes the filter the only thing between them.
  const { store, a, b } = twoWorkspaces();

  const alpha = serialSetup(a.ctx, { itemName: 'Alpha Serial', itemKey: 'g8-a-it', number: 'SN-X', prefix: 'g8a' });
  must(inventoryMove(a.ctx, { itemId: alpha.itemId, locationId: alpha.locationId, qty: 1, movementType: 'receipt', serialId: alpha.serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g8-a-r1' }), 'alpha receipt');
  assert.equal(serialSum(a.ctx, alpha.serialId), 1, 'Alpha holds the unit');

  // Beta owns an identically numbered serial on its own item: the number is unique per item, not
  // globally, so this is a different physical unit and Beta must be able to receive it.
  const beta = serialSetup(b.ctx, { itemName: 'Beta Serial', itemKey: 'g8-b-it', number: 'SN-X', prefix: 'g8b' });
  must(inventoryMove(b.ctx, { itemId: beta.itemId, locationId: beta.locationId, qty: 1, movementType: 'receipt', serialId: beta.serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g8-b-r1' }), 'beta receipt');

  // Beta probes with Alpha's REAL serial id (a fabricated id would prove nothing): it is invisible,
  // so the answer is not_found, never a leak of Alpha's serial state through the new guard.
  const foreign = inventoryMove(b.ctx, { itemId: beta.itemId, locationId: beta.locationId, qty: 1, movementType: 'receipt', serialId: alpha.serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g8-b-r2' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found', 'a foreign serial is invisible, not "already in stock"');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 2, 'the refused probe wrote nothing');

  // Now plant a Beta row of -1 naming ALPHA's serial. Nothing in Beta's own ledger changes for
  // Beta's own unit, but the workspace-blind SUM over that serial is now 1 + (-1) = 0.
  plantMovement(b.ctx, { itemId: beta.itemId, locationId: beta.locationId, serialId: alpha.serialId, qty: -1, key: 'g8-planted' });
  assert.equal(store.db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE serial_id = ?').get(alpha.serialId).n, 0, 'workspace-blind, the two rows cancel');
  assert.equal(serialSum(a.ctx, alpha.serialId), 1, 'inside Alpha, the unit is still held');

  // THE BITE. Alpha receiving its own unit a second time must still be refused, and refused with an
  // on-hand of 1: Beta's row is not Alpha's business. A guard summing without the workspace filter
  // reads 0 here, accepts the receipt, and leaves Alpha holding the same unit twice.
  const again = inventoryMove(a.ctx, { itemId: alpha.itemId, locationId: alpha.locationId, qty: 1, movementType: 'receipt', serialId: alpha.serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g8-a-r2' });
  assert.equal(again.ok, false, "another workspace's rows cannot make a held unit receivable");
  assert.equal(again.error, 'serial_already_in_stock');
  assert.equal(again.onHand, 1, 'the guard sums Alpha only, so the planted Beta row is invisible to it');
  assert.equal(serialSum(a.ctx, alpha.serialId), 1, 'Alpha still holds exactly one');

  // And the filter does not cut the other way either: Beta's own first receipt of its own serial
  // stayed legitimate throughout, and Beta can still move its own unit out.
  must(inventoryMove(b.ctx, { itemId: beta.itemId, locationId: beta.locationId, qty: -1, movementType: 'issue', serialId: beta.serialId, effectiveDate: '2026-03-03', idempotencyKey: 'g8-b-iss' }), 'beta issue');
  assert.equal(serialSum(b.ctx, beta.serialId), 0);
});

test('J02 (g): a transfer of an in-stock serial still works and keeps the unit at one', () => {
  const { ctx } = freshCtx();
  const { itemId, serialId, locationId } = serialSetup(ctx, {
    itemName: 'Transfer Widget',
    itemKey: 'g9-it',
    number: 'SN-T',
    prefix: 'g9',
  });
  const b = seedSecondLocation(ctx);
  must(inventoryMove(ctx, { itemId, locationId, qty: 1, movementType: 'receipt', serialId, effectiveDate: '2026-03-01', idempotencyKey: 'g9-r1' }), 'receipt');

  // A transfer is a zero-sum pair for the SAME unit, so it can never raise the serial above one:
  // guarding its inbound leg would break every legitimate serial relocation.
  const t = must(inventoryTransfer(ctx, { itemId, fromLocationId: locationId, toLocationId: b, qty: 1, serialId, effectiveDate: '2026-03-02', idempotencyKey: 'g9-x' }), 'transfer');
  assert.equal(t.out.qty + t.in.qty, 0);
  assert.equal(serialSum(ctx, serialId), 1, 'a transfer leaves the unit at one');
  assert.equal(ctx.store.db.prepare('SELECT current_location_id FROM serial WHERE id = ?').get(serialId).current_location_id, b);
});

// --- transfer atomicity / zero-sum (§7.7) ------------------------------------------------------

test('J02: a transfer writes exactly two zero-sum rows under one transfer_group_id', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  const b = seedSecondLocation(ctx);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 60, movementType: 'receipt', unitCostMinor: 400, effectiveDate: '2026-03-01', idempotencyKey: 't-recv' }), 'recv');

  const t = must(inventoryTransfer(ctx, { itemId, fromLocationId: a, toLocationId: b, qty: 25, effectiveDate: '2026-03-02', idempotencyKey: 't-1' }), 'xfer');
  assert.equal(t.out.qty, -25);
  assert.equal(t.in.qty, 25);
  assert.equal(t.out.transferGroupId, t.in.transferGroupId);
  assert.ok(t.out.transferGroupId, 'both legs share a transfer_group_id');
  assert.equal(t.out.qty + t.in.qty, 0, 'the pair sums to zero');
  assert.equal(must(inventoryBalance(ctx, { itemId, locationId: a }), 'balA').qtyOnHand, 35);
  assert.equal(must(inventoryBalance(ctx, { itemId, locationId: b }), 'balB').qtyOnHand, 25);
  // The item TOTAL is unchanged by a transfer.
  assert.equal(must(inventoryBalance(ctx, { itemId }), 'balTot').qtyOnHand, 60);
});

test('J02: a transfer that would overdraw the source writes neither leg', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  const b = seedSecondLocation(ctx);
  must(inventoryMove(ctx, { itemId, locationId: a, qty: 5, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 't2-recv' }), 'recv');
  const before = rowCount(ctx);

  const refused = inventoryTransfer(ctx, { itemId, fromLocationId: a, toLocationId: b, qty: 20, effectiveDate: '2026-03-02', idempotencyKey: 't2-x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'insufficient_stock');
  assert.equal(rowCount(ctx), before, 'neither transfer leg is written when the source is insufficient');
});

// --- sign / enum guards ------------------------------------------------------------------------

test('J02: sign and enum guards reject before any write', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const a = locationOf(ctx);
  assert.equal(inventoryMove(ctx, { itemId, locationId: a, qty: 0, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'g-0' }).error, 'invalid_qty');
  assert.equal(inventoryMove(ctx, { itemId, locationId: a, qty: -5, movementType: 'receipt', effectiveDate: '2026-03-01', idempotencyKey: 'g-1' }).error, 'invalid_qty');
  assert.equal(inventoryMove(ctx, { itemId, locationId: a, qty: 5, movementType: 'issue', effectiveDate: '2026-03-01', idempotencyKey: 'g-2' }).error, 'invalid_qty');
  assert.equal(inventoryMove(ctx, { itemId, locationId: a, qty: 5, movementType: 'nonsense', effectiveDate: '2026-03-01', idempotencyKey: 'g-3' }).error, 'invalid_movement_type');
  assert.equal(rowCount(ctx), 0);
});

/** A second stock_location for transfer tests (D01's table, minimal columns). */
function seedSecondLocation(ctx) {
  const id = ctx.ids.next('loc2');
  ctx.store.db
    .prepare('INSERT INTO stock_location (id, workspace_id, name, type, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, ctx.workspaceId, 'Lager B', 'warehouse', ctx.clock.now());
  return id;
}
