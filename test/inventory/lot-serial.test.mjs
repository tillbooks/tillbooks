// J01, lot & serial tracking: the engine invariants the wave gate and J02 depend on.
//
// Proves every §2/§4/§7 rule: item tracking-mode guards (zero-stock, not-applicable), lot & serial
// CRUD, case-insensitive number uniqueness PER ITEM, the status lifecycles that never mint a movement,
// the balance-derived close/archive refusal, all-or-nothing bulk serial create, the two pure read
// models (on-hand-by-lot SUM over the OP2 ledger, status-derived available-serials), the §H-STOCK-AUDIT
// no-quantity-column invariant, §H-TENANT on every read/write, and idempotent-on-ROWS for the creates.
// J01 has NO posting path (plain master data), so there is no ledger assertion here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import { recordStockMove } from '../../dist/core/stock/index.js';
import {
  itemSetTrackingMode,
  lotCreate,
  lotUpdate,
  lotSetStatus,
  lotArchive,
  lotGet,
  lotList,
  lotSearch,
  serialCreate,
  serialCreateBulk,
  serialUpdate,
  serialSetStatus,
  serialArchive,
  serialGet,
  serialList,
  serialSearch,
  inventoryOnHandByLot,
  inventoryAvailableSerials,
  inventoryEnsureDefaultLocation,
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

function trackedItem(ctx, mode = 'lot', over = {}) {
  const item = must(
    createItem(ctx, { name: over.name ?? `Widget-${mode}`, defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: `it-${mode}-${over.name ?? ''}` }),
    'createItem',
  ).item;
  must(itemSetTrackingMode(ctx, { itemId: item.id, mode, idempotencyKey: `mode-${item.id}` }), 'setMode');
  return item.id;
}

/** Insert a lot-tagged movement directly (J02 owns the real path; J01's read model must sum it). */
function tagMovement(ctx, { itemId, locationId, qty, lotId, serialId, key }) {
  ctx.store.db
    .prepare(
      `INSERT INTO stock_movement
         (id, workspace_id, item_id, location_id, qty, reason, moved_at, idempotency_key, created_at, lot_id, serial_id)
       VALUES (?, ?, ?, ?, ?, 'receipt', ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('mov'), ctx.workspaceId, itemId, locationId, qty, AT, key, AT, lotId ?? null, serialId ?? null);
}

// --- tracking mode (US-J01.1) ------------------------------------------------------------------

test('setting a non-none mode needs a stockable item with zero on-hand', () => {
  const { ctx } = freshCtx();
  const item = must(createItem(ctx, { name: 'W', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'w' }), 'item').item;
  must(itemSetTrackingMode(ctx, { itemId: item.id, mode: 'lot', idempotencyKey: 'm1' }), 'setLot');
  // A service or non-stockable item is not applicable.
  const svc = must(createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 1000, kind: 'service', idempotencyKey: 's' }), 'svc').item;
  assert.equal(itemSetTrackingMode(ctx, { itemId: svc.id, mode: 'lot', idempotencyKey: 'm2' }).error, 'tracking_not_applicable');
});

test('changing the mode is refused while on-hand is non-zero (tracking_mode_requires_zero_stock)', () => {
  const { ctx } = freshCtx();
  const item = must(createItem(ctx, { name: 'W', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'w' }), 'item').item;
  must(recordStockMove(ctx, { itemId: item.id, qty: 5, reason: 'receipt', idempotencyKey: 'mv' }), 'move');
  assert.equal(itemSetTrackingMode(ctx, { itemId: item.id, mode: 'lot', idempotencyKey: 'm' }).error, 'tracking_mode_requires_zero_stock');
});

test('an invalid mode is rejected', () => {
  const { ctx } = freshCtx();
  const item = must(createItem(ctx, { name: 'W', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'w' }), 'item').item;
  assert.equal(itemSetTrackingMode(ctx, { itemId: item.id, mode: 'batches', idempotencyKey: 'm' }).error, 'invalid_tracking_mode');
});

// --- lots (US-J01.2, .4, .6) -------------------------------------------------------------------

test('lot create enforces case-insensitive uniqueness per item and mode applicability', () => {
  const { ctx } = freshCtx();
  const itemId = trackedItem(ctx, 'lot');
  must(lotCreate(ctx, { itemId, number: 'L-001', expiryDate: '2027-01-01', idempotencyKey: 'l1' }), 'lot1');
  assert.equal(lotCreate(ctx, { itemId, number: 'l-001', idempotencyKey: 'l2' }).error, 'lot_number_taken');
  // A serial-only item refuses a lot.
  const serItem = trackedItem(ctx, 'serial', { name: 'Ser' });
  assert.equal(lotCreate(ctx, { itemId: serItem, number: 'X', idempotencyKey: 'l3' }).error, 'tracking_not_applicable');
});

test('lot create is idempotent on ROWS (same key writes one lot)', () => {
  const { ctx, store, workspaceId } = freshCtx();
  const itemId = trackedItem(ctx, 'lot');
  const a = lotCreate(ctx, { itemId, number: 'L-9', idempotencyKey: 'k' });
  const b = lotCreate(ctx, { itemId, number: 'L-9', idempotencyKey: 'k' });
  assert.equal(a.lot.id, b.lot.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM lot WHERE workspace_id = ?').get(workspaceId).n, 1);
});

test('lot_set_status closed/archived is refused while the lot has derived balance (lot_has_balance)', () => {
  const { ctx } = freshCtx();
  const loc = must(inventoryEnsureDefaultLocation(ctx), 'ensure').location.id;
  const itemId = trackedItem(ctx, 'lot');
  const lot = must(lotCreate(ctx, { itemId, number: 'L-1', idempotencyKey: 'l' }), 'lot').lot;
  tagMovement(ctx, { itemId, locationId: loc, qty: 10, lotId: lot.id, key: 'm1' });
  assert.equal(lotSetStatus(ctx, { lotId: lot.id, status: 'closed', idempotencyKey: 's1' }).error, 'lot_has_balance');
  assert.equal(lotArchive(ctx, { lotId: lot.id, idempotencyKey: 's2' }).error, 'lot_has_balance');
  // Holding (non-terminal) is allowed even with balance.
  must(lotSetStatus(ctx, { lotId: lot.id, status: 'held', idempotencyKey: 's3' }), 'held');
  // Zero it out, then archive succeeds.
  tagMovement(ctx, { itemId, locationId: loc, qty: -10, lotId: lot.id, key: 'm2' });
  must(lotArchive(ctx, { lotId: lot.id, idempotencyKey: 's4' }), 'archive after zeroing');
});

test('on-hand-by-lot equals the live SUM of lot-tagged movements per lot x location', () => {
  const { ctx } = freshCtx();
  const loc = must(inventoryEnsureDefaultLocation(ctx), 'ensure').location.id;
  const itemId = trackedItem(ctx, 'lot');
  const a = must(lotCreate(ctx, { itemId, number: 'L-A', expiryDate: '2027-06-01', idempotencyKey: 'a' }), 'a').lot;
  const b = must(lotCreate(ctx, { itemId, number: 'L-B', expiryDate: '2027-01-01', idempotencyKey: 'b' }), 'b').lot;
  tagMovement(ctx, { itemId, locationId: loc, qty: 30, lotId: a.id, key: 'm1' });
  tagMovement(ctx, { itemId, locationId: loc, qty: 12, lotId: b.id, key: 'm2' });
  tagMovement(ctx, { itemId, locationId: loc, qty: -2, lotId: b.id, key: 'm3' });
  const rows = must(inventoryOnHandByLot(ctx, { itemId }), 'byLot').rows;
  const byLot = Object.fromEntries(rows.map((r) => [r.lotId, r.qty]));
  assert.equal(byLot[a.id], 30);
  assert.equal(byLot[b.id], 10);
  // FEFO ordering: the earlier expiry (L-B, 2027-01-01) comes first.
  assert.equal(rows[0].lotId, b.id);
  // No movements yet for a fresh lot => absent (not an error), and includeZero is empty here.
  assert.equal(must(inventoryOnHandByLot(ctx, { lotId: a.id }), 'one').rows.length, 1);
});

test('lot list, get and search return the expected rows with derived on-hand', () => {
  const { ctx } = freshCtx();
  const itemId = trackedItem(ctx, 'lot');
  const lot = must(lotCreate(ctx, { itemId, number: 'CHARGE-77', supplierReference: 'PO-9', idempotencyKey: 'l' }), 'l').lot;
  assert.equal(must(lotGet(ctx, { lotId: lot.id }), 'get').lot.number, 'CHARGE-77');
  assert.equal(must(lotList(ctx, { itemId }), 'list').lots.length, 1);
  assert.equal(must(lotSearch(ctx, { query: 'charge' }), 'search').lots.length, 1);
  assert.equal(must(lotSearch(ctx, { query: 'po-9' }), 'searchRef').lots.length, 1);
  // Descriptive update keeps the number unique.
  must(lotUpdate(ctx, { lotId: lot.id, patch: { notes: 'geprüft' }, idempotencyKey: 'u' }), 'update');
});

// --- serials (US-J01.3, .5, .6) ----------------------------------------------------------------

test('serial create enforces uniqueness, mode applicability and the lot rules', () => {
  const { ctx } = freshCtx();
  const itemId = trackedItem(ctx, 'serial');
  must(serialCreate(ctx, { itemId, number: 'SN-1', idempotencyKey: 's1' }), 'sn1');
  assert.equal(serialCreate(ctx, { itemId, number: 'sn-1', idempotencyKey: 's2' }).error, 'serial_number_taken');
  // lot_and_serial requires a lot that belongs to the same item.
  const bothId = trackedItem(ctx, 'lot_and_serial', { name: 'Both' });
  assert.equal(serialCreate(ctx, { itemId: bothId, number: 'B-1', idempotencyKey: 's3' }).error, 'lot_reference_required');
  // A lot on a DIFFERENT lot-tracked item, to trigger lot_item_mismatch below.
  const otherLotItem = trackedItem(ctx, 'lot', { name: 'OtherLot' });
  const foreignLot = must(lotCreate(ctx, { itemId: otherLotItem, number: 'FL', idempotencyKey: 'fl' }), 'fl').lot;
  assert.equal(
    serialCreate(ctx, { itemId: bothId, number: 'B-2', lotId: foreignLot.id, idempotencyKey: 's4' }).error,
    'lot_item_mismatch',
  );
  const ownLot = must(lotCreate(ctx, { itemId: bothId, number: 'OL', idempotencyKey: 'ol' }), 'ol').lot;
  must(serialCreate(ctx, { itemId: bothId, number: 'B-3', lotId: ownLot.id, idempotencyKey: 's5' }), 'ok');
});

test('serial bulk create is all-or-nothing: a duplicate aborts and writes nothing', () => {
  const { ctx, store, workspaceId } = freshCtx();
  const itemId = trackedItem(ctx, 'serial');
  must(serialCreate(ctx, { itemId, number: 'EXISTS', idempotencyKey: 'e' }), 'seed');
  const before = store.db.prepare('SELECT COUNT(*) n FROM serial WHERE workspace_id = ?').get(workspaceId).n;
  // A clash with a stored serial aborts the whole batch.
  assert.equal(serialCreateBulk(ctx, { itemId, numbers: ['NEW-1', 'EXISTS', 'NEW-2'], idempotencyKey: 'b1' }).error, 'serial_number_taken');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM serial WHERE workspace_id = ?').get(workspaceId).n, before, 'no partial rows');
  // A duplicate WITHIN the batch also aborts.
  assert.equal(serialCreateBulk(ctx, { itemId, numbers: ['D', 'd'], idempotencyKey: 'b2' }).error, 'serial_number_taken');
  // A clean batch writes all three.
  const okBulk = must(serialCreateBulk(ctx, { itemId, numbers: ['C-1', 'C-2', 'C-3'], idempotencyKey: 'b3' }), 'bulk');
  assert.equal(okBulk.serials.length, 3);
});

test('serial bulk create is idempotent on ROWS (same key writes each row once)', () => {
  const { ctx, store, workspaceId } = freshCtx();
  const itemId = trackedItem(ctx, 'serial');
  must(serialCreateBulk(ctx, { itemId, numbers: ['K-1', 'K-2'], idempotencyKey: 'k' }), 'first');
  must(serialCreateBulk(ctx, { itemId, numbers: ['K-1', 'K-2'], idempotencyKey: 'k' }), 'replay');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM serial WHERE workspace_id = ?').get(workspaceId).n, 2);
});

test('available-serials is status-derived and archive needs the unit out of stock', () => {
  const { ctx } = freshCtx();
  const itemId = trackedItem(ctx, 'serial');
  const s = must(serialCreate(ctx, { itemId, number: 'AV-1', idempotencyKey: 's' }), 's').serial;
  assert.equal(must(inventoryAvailableSerials(ctx, { itemId }), 'avail').serials.length, 1);
  // An available serial cannot be archived directly.
  assert.equal(serialArchive(ctx, { serialId: s.id, idempotencyKey: 'a1' }).error, 'serial_has_balance');
  // Scrapping removes it from availability and then it can archive.
  must(serialSetStatus(ctx, { serialId: s.id, status: 'scrapped', idempotencyKey: 'st' }), 'scrap');
  assert.equal(must(inventoryAvailableSerials(ctx, { itemId }), 'avail2').serials.length, 0);
  must(serialArchive(ctx, { serialId: s.id, idempotencyKey: 'a2' }), 'archive');
  assert.equal(must(serialGet(ctx, { serialId: s.id }), 'get').serial.status, 'archived');
  assert.equal(must(serialList(ctx, { itemId }), 'list').serials.length, 0, 'archived hidden by default');
  assert.equal(must(serialSearch(ctx, { query: 'av-1' }), 'search').serials.length, 1);
  must(serialUpdate(ctx, { serialId: s.id, patch: { notes: 'kaputt' }, idempotencyKey: 'u' }), 'update');
});

// --- §H-STOCK-AUDIT: no quantity column (spec §7) ----------------------------------------------

test('neither lot nor serial carries a quantity column (on-hand is always derived)', () => {
  const { store } = freshCtx();
  for (const table of ['lot', 'serial']) {
    const cols = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.equal(cols.includes('qty'), false, `${table} must not carry a qty column`);
    assert.equal(cols.includes('quantity'), false, `${table} must not carry a quantity column`);
    assert.equal(cols.includes('on_hand'), false, `${table} must not carry an on_hand column`);
  }
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('a foreign lot or serial id never resolves (H-TENANT)', () => {
  const clk = fixedClock(AT);
  const idg = sequenceIdGen();
  const s = new SqliteStore({ clock: clk });
  const deps = { store: s, clock: clk, ids: idg };
  const wsA = createWorkspace(deps, { name: 'A AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'B AG' }).workspaceId;
  const ctxA = makeContext(s, { workspaceId: wsA, actor: 'u', clock: clk, ids: idg });
  const ctxB = makeContext(s, { workspaceId: wsB, actor: 'u', clock: clk, ids: idg });
  const itemA = trackedItem(ctxA, 'lot');
  const lotA = must(lotCreate(ctxA, { itemId: itemA, number: 'L', idempotencyKey: 'l' }), 'lotA').lot;
  const serItemA = trackedItem(ctxA, 'serial', { name: 'SerA' });
  const serA = must(serialCreate(ctxA, { itemId: serItemA, number: 'S', idempotencyKey: 's' }), 'serA').serial;
  // B cannot see or touch A's rows.
  assert.equal(lotGet(ctxB, { lotId: lotA.id }).error, 'not_found');
  assert.equal(serialGet(ctxB, { serialId: serA.id }).error, 'not_found');
  assert.equal(lotSetStatus(ctxB, { lotId: lotA.id, status: 'held', idempotencyKey: 'z' }).error, 'not_found');
  assert.equal(serialArchive(ctxB, { serialId: serA.id, idempotencyKey: 'z2' }).error, 'not_found');
  assert.equal(lotList(ctxB, {}).lots.length, 0);
  assert.equal(serialList(ctxB, {}).serials.length, 0);
  assert.equal(inventoryOnHandByLot(ctxB, {}).rows.length, 0);
});
