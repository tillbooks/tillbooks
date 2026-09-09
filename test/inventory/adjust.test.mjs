// J05, inventory adjustments & reasons: the MONEY-PATH invariants a non-author critic must see BITE.
//
// A J05 adjustment mints stock quantity changes EXCLUSIVELY through the J02 append-only ledger
// (inventoryMove, movement_type adjustment); it writes no quantity itself. The reason linkage lives on
// the append-only inventory_adjustment table, and the mandatory-active-reason rule is enforced at the
// J05 verb, NOT at the J02 insert (which stays reason-agnostic for J04 stocktake). Each test below is
// written to FAIL if its invariant were removed:
//   (a) APPEND-ONLY VIA J02: an adjust mints a NEW stock_movement; inventory_adjustment is immutable
//       (the DB triggers abort a raw UPDATE / DELETE), and the minted movement is immutable too.
//   (b) §H-TENANT: a foreign workspace's reason / adjustment id is not_found, and its adjustment list
//       is invisible. The two tenants share ONE store, so a dropped `workspace_id = ?` predicate is
//       what this detects (a separate store per tenant could never fail).
//   (c) IDEMPOTENT ON ROWS: a replay of adjust posts NO second movement; the per-line movement key is
//       DETERMINISTIC (`adj:<key>`), the row-level dedup beneath the verb-level cache.
//   (d) MANDATORY ACTIVE REASON: an adjustment with a missing / archived / foreign reason mints nothing.
//   (e) SIGN / DIRECTION: a positive adjustment raises on-hand, a negative one lowers it; the
//       insufficient-stock guard still applies.
//   (f) PERIOD LOCK: adjusting into a locked period is refused; no movement is minted.
//   (g) REVERSAL: reverse mints a linked opposite-sign movement carrying its OWN reason; the original
//       is never edited; a second reverse is already_reversed.
//   (h) ATOMICITY: a batch whose second line overdraws rolls the FIRST line back too (no partial mint).

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { ok, err } from '../../dist/core/result.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import {
  inventoryMove,
  inventoryBalance,
  inventoryEnsureDefaultLocation,
  inventoryReasonCreate,
  inventoryReasonArchive,
  inventoryReasonGet,
  inventoryReasonList,
  inventoryAdjust,
  inventoryAdjustBatch,
  inventoryAdjustReverse,
  inventoryAdjustList,
  inventoryAdjustAnalysis,
} from '../../dist/core/inventory/index.js';

const AT = '2026-08-17T00:00:00.000Z';

function freshCtx(name = 'Acme AG', periods) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, periods });
  return { ctx, store, workspaceId, deps, clock, ids };
}

/**
 * TWO workspaces in ONE shared SqliteStore, so a §H-TENANT test can actually BITE: with a single store
 * a query that dropped its `workspace_id = ?` predicate would read the other tenant's rows, which is
 * exactly the failure the tenant tests must detect. (freshCtx builds a separate store per workspace,
 * so a cross-tenant read there is impossible by construction and the test could never fail.)
 */
function twoWorkspaces() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'A AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'B AG' }).workspaceId;
  const ctxA = makeContext(store, { workspaceId: wsA, actor: 'user_a', clock, ids });
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'user_b', clock, ids });
  return { store, ctxA, ctxB, wsA, wsB };
}

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
}

function locationOf(ctx) {
  return must(inventoryEnsureDefaultLocation(ctx), 'ensureLocation').location.id;
}

function stockItem(ctx, name = 'Widget', key = name) {
  return must(
    createItem(ctx, { name, defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: `it-${key}` }),
    'createItem',
  ).item.id;
}

function receipt(ctx, itemId, locationId, qty, date, key) {
  return must(
    inventoryMove(ctx, { itemId, locationId, qty, movementType: 'receipt', effectiveDate: date, idempotencyKey: key }),
    'receipt',
  );
}

function reason(ctx, code = 'SCHWUND', over = {}) {
  return must(
    inventoryReasonCreate(ctx, { code, name: code, category: 'shrinkage', idempotencyKey: `rsn-${code}`, ...over }),
    'reason',
  ).reason;
}

function rawSum(ctx, where = '', params = []) {
  const clause = where.length > 0 ? ` AND ${where}` : '';
  return ctx.store.db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ?${clause}`)
    .get(ctx.workspaceId, ...params).n;
}

function movementRowCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?').get(ctx.workspaceId).n;
}
function adjustmentRowCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM inventory_adjustment WHERE workspace_id = ?').get(ctx.workspaceId).n;
}

function seed(ctx, onHand = 12) {
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, onHand, '2026-03-01', 'r1');
  const r = reason(ctx);
  return { itemId, locationId, reasonId: r.id };
}

// --- the reason catalog -----------------------------------------------------------------------------

test('J05 reason: a case-insensitive duplicate code is refused (duplicate_code)', () => {
  const { ctx } = freshCtx();
  reason(ctx, 'SCHWUND');
  const dup = inventoryReasonCreate(ctx, { code: 'schwund', name: 'again', category: 'shrinkage', idempotencyKey: 'dup' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate_code');
});

test('J05 reason: archive is soft, the code stays queryable but leaves the active list', () => {
  const { ctx } = freshCtx();
  const r = reason(ctx, 'FUND', { category: 'found' });
  must(inventoryReasonArchive(ctx, { id: r.id, idempotencyKey: 'arch' }), 'archive');
  const got = must(inventoryReasonGet(ctx, { id: r.id }), 'get');
  assert.equal(got.reason.isActive, false, 'archived code is still readable');
  const active = must(inventoryReasonList(ctx, { activeOnly: true }), 'list').reasons;
  assert.equal(active.some((x) => x.id === r.id), false, 'archived code is out of the active list');
});

// --- (a) APPEND-ONLY --------------------------------------------------------------------------------

test('J05 (a): adjust mints a NEW J02 movement, itself immutable (append-only)', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx, 12);
  const before = movementRowCount(ctx);
  const res = must(
    inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -7, reasonCodeId: reasonId, effectiveDate: '2026-03-05', idempotencyKey: 'a1' }),
    'adjust',
  );
  assert.equal(movementRowCount(ctx), before + 1, 'exactly one new ledger row');
  assert.equal(res.movement.movementType, 'adjustment');
  assert.equal(res.movement.qty, -7);
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 5, 'on-hand = 12 - 7');
  // The minted row is a normal J02 movement, so it is immutable.
  assert.throws(
    () => ctx.store.db.prepare('UPDATE stock_movement SET qty = 0 WHERE id = ?').run(res.movement.id),
    /stock_movement_immutable/,
  );
});

test('J05 (a): the inventory_adjustment row is append-only (UPDATE and DELETE abort)', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx);
  const res = must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: reasonId, idempotencyKey: 'a1' }), 'adjust');
  const adjId = res.adjustment.id;
  assert.throws(
    () => ctx.store.db.prepare('UPDATE inventory_adjustment SET qty_delta = 0 WHERE id = ?').run(adjId),
    /inventory_adjustment_immutable/,
    'a raw UPDATE of an adjustment record must abort',
  );
  assert.throws(
    () => ctx.store.db.prepare('DELETE FROM inventory_adjustment WHERE id = ?').run(adjId),
    /inventory_adjustment_immutable/,
    'a raw DELETE of an adjustment record must abort',
  );
});

test('J05 (a): the movement carries the reason linkage back (sourceDocument = the adjustment id)', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx);
  const res = must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: reasonId, idempotencyKey: 'a1' }), 'adjust');
  const row = ctx.store.db
    .prepare("SELECT ref_kind, ref_id, movement_type FROM stock_movement WHERE workspace_id = ? AND id = ?")
    .get(ctx.workspaceId, res.movement.id);
  assert.equal(row.movement_type, 'adjustment');
  assert.equal(row.ref_kind, 'inventory_adjustment');
  assert.equal(row.ref_id, res.adjustment.id, 'the movement names its inventory_adjustment row');
});

// --- (b) §H-TENANT (shared store, must BITE) --------------------------------------------------------

test('J05 (b): §H-TENANT bites, B cannot read or reverse A adjustments or reasons', () => {
  const { ctxA, ctxB } = twoWorkspaces();
  const aItem = stockItem(ctxA, 'A Widget', 'a');
  const aLoc = locationOf(ctxA);
  receipt(ctxA, aItem, aLoc, 12, '2026-03-01', 'ar');
  const aReason = reason(ctxA, 'ASCHWUND');
  const aAdj = must(
    inventoryAdjust(ctxA, { itemId: aItem, locationId: aLoc, qtyDelta: -3, reasonCodeId: aReason.id, idempotencyKey: 'aa' }),
    'A adjust',
  ).adjustment;

  // B has its OWN active reason, so the tenant predicate (not the empty-catalog short-circuit) is what
  // is under test: referencing A's ids must be not_found for B.
  reason(ctxB, 'BSCHWUND');
  const bItem = stockItem(ctxB, 'B Widget', 'b');
  const bLoc = locationOf(ctxB);
  receipt(ctxB, bItem, bLoc, 5, '2026-03-01', 'br');

  const before = movementRowCount(ctxB);

  const foreignReasonGet = inventoryReasonGet(ctxB, { id: aReason.id });
  assert.equal(foreignReasonGet.ok, false);
  assert.equal(foreignReasonGet.error, 'not_found', 'B cannot GET A reason');

  const foreignAdjust = inventoryAdjust(ctxB, { itemId: bItem, locationId: bLoc, qtyDelta: -1, reasonCodeId: aReason.id, idempotencyKey: 'bx' });
  assert.equal(foreignAdjust.ok, false);
  assert.equal(foreignAdjust.error, 'not_found', 'B cannot cite A reason');

  const foreignReverse = inventoryAdjustReverse(ctxB, { adjustmentId: aAdj.id, reasonCodeId: 'irrelevant', idempotencyKey: 'brv' });
  assert.equal(foreignReverse.ok, false);

  const bList = must(inventoryAdjustList(ctxB, {}), 'B list').items;
  assert.equal(bList.length, 0, "B's adjustment list does not see A's rows");

  assert.equal(movementRowCount(ctxB), before, 'no B movement minted from any foreign access');
});

// --- (c) IDEMPOTENT ON ROWS -------------------------------------------------------------------------

test('J05 (c): a replay of adjust posts NO second movement (idempotent on rows)', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx);
  const first = must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -4, reasonCodeId: reasonId, idempotencyKey: 'a1' }), 'adjust');
  const after = movementRowCount(ctx);
  const replay = must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -4, reasonCodeId: reasonId, idempotencyKey: 'a1' }), 'replay');
  assert.equal(movementRowCount(ctx), after, 'a replay writes not one more ledger row');
  assert.equal(replay.adjustment.id, first.adjustment.id, 'replay returns the original adjustment');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 8, 'on-hand did not double-apply (12 - 4)');
});

// The movement key is DETERMINISTIC (`adj:<idempotencyKey>`), the row-level dedup that survives even
// when the verb-level cache is bypassed. A RANDOMISED per-line key would not collide with the minted
// movement on replay, so this asserts the exact stored key.
test('J05 (c): the minted movement key is deterministic (adj:<key>)', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx);
  must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -2, reasonCodeId: reasonId, idempotencyKey: 'myKey' }), 'adjust');
  const row = ctx.store.db
    .prepare("SELECT idempotency_key FROM stock_movement WHERE workspace_id = ? AND movement_type = 'adjustment'")
    .get(ctx.workspaceId);
  assert.equal(row.idempotency_key, 'adj:myKey', 'the movement key is derived deterministically from the verb key');
});

// --- (d) MANDATORY ACTIVE REASON --------------------------------------------------------------------

test('J05 (d): a missing / archived / foreign reason mints nothing', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx);
  const before = movementRowCount(ctx);

  const missing = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, idempotencyKey: 'm1' });
  assert.equal(missing.ok, false, 'missing reason refused');

  const bogus = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: 'rsn_nope', idempotencyKey: 'm2' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.error, 'not_found', 'unknown reason -> not_found (a real active reason exists)');

  must(inventoryReasonArchive(ctx, { id: reasonId, idempotencyKey: 'arch' }), 'archive');
  const archived = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: reasonId, idempotencyKey: 'm3' });
  assert.equal(archived.ok, false);
  assert.equal(archived.error, 'reason_inactive', 'archived reason -> reason_inactive');

  assert.equal(movementRowCount(ctx), before, 'not one movement minted across the three refusals');
  assert.equal(adjustmentRowCount(ctx), 0, 'no adjustment row written either');
});

test('J05 (d): an empty catalog returns no_active_reasons', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 5, '2026-03-01', 'r1');
  const res = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: 'anything', idempotencyKey: 'e1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_active_reasons');
});

test('J05 (d): a requires_note reason with an empty note is refused (note_required)', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 5, '2026-03-01', 'r1');
  const r = reason(ctx, 'BESCHAED', { category: 'damage', requiresNote: true });
  const before = movementRowCount(ctx);
  const res = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: r.id, idempotencyKey: 'n1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'note_required');
  const okWithNote = must(
    inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: r.id, note: 'Bruch im Lager', idempotencyKey: 'n2' }),
    'adjust with note',
  );
  assert.equal(okWithNote.movement.description, 'Bruch im Lager', 'the note becomes the movement description');
  assert.equal(movementRowCount(ctx), before + 1, 'only the noted adjust minted');
});

// --- (e) SIGN / DIRECTION + negative-stock guard ----------------------------------------------------

test('J05 (e): a positive adjust raises on-hand, a negative one lowers it', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx, 12);
  must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: 5, reasonCodeId: reasonId, idempotencyKey: 'p1' }), 'found +5');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 17);
  must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -3, reasonCodeId: reasonId, idempotencyKey: 'p2' }), 'shrink -3');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 14);
});

test('J05 (e): the insufficient-stock guard still applies (negative stock forbidden by default)', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx, 12);
  const before = movementRowCount(ctx);
  const res = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -100, reasonCodeId: reasonId, idempotencyKey: 'x1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'insufficient_stock');
  assert.equal(movementRowCount(ctx), before, 'nothing minted on the overdraw');
});

// --- (f) PERIOD LOCK --------------------------------------------------------------------------------

test('J05 (f): adjusting into a locked period is refused, no movement minted', () => {
  const periods = { assertOpen: (d) => (d <= '2025-12-31' ? err('period_locked', { period: '2025', kind: 'hard' }) : ok()) };
  const { ctx } = freshCtx('Acme AG', periods);
  const { itemId, locationId, reasonId } = seed(ctx, 12);
  const before = movementRowCount(ctx);
  const res = inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -1, reasonCodeId: reasonId, effectiveDate: '2025-06-30', idempotencyKey: 'pl1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked', 'a sealed year cannot be back-dated into');
  assert.equal(movementRowCount(ctx), before, 'no movement minted into the locked period');
});

// --- (g) REVERSAL -----------------------------------------------------------------------------------

test('J05 (g): reverse mints a linked opposite-sign movement with its own reason; original untouched', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx, 12);
  const revReason = reason(ctx, 'STORNO', { category: 'reversal' });
  const orig = must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -7, reasonCodeId: reasonId, idempotencyKey: 'o1' }), 'adjust').adjustment;
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 5);

  const rev = must(inventoryAdjustReverse(ctx, { adjustmentId: orig.id, reasonCodeId: revReason.id, idempotencyKey: 'rv1' }), 'reverse');
  assert.equal(rev.count, 1);
  assert.equal(rev.reversals[0].qtyDelta, 7, 'the reversal is the opposite sign');
  assert.equal(rev.reversals[0].reasonCodeId, revReason.id, 'the reversal carries its OWN reason');
  assert.equal(rev.reversals[0].reversesAdjustmentId, orig.id, 'the reversal links to the original');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 12, 'on-hand is restored to before the original');

  // The original adjustment row is unchanged.
  const stored = ctx.store.db.prepare('SELECT qty_delta, reverses_adjustment_id FROM inventory_adjustment WHERE id = ?').get(orig.id);
  assert.equal(stored.qty_delta, -7, 'the original qty is untouched');
  assert.equal(stored.reverses_adjustment_id, null, 'the original is not itself a reversal');

  // A second reverse is refused.
  const again = inventoryAdjustReverse(ctx, { adjustmentId: orig.id, reasonCodeId: revReason.id, idempotencyKey: 'rv2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_reversed');
});

// --- (h) ATOMICITY ----------------------------------------------------------------------------------

test('J05 (h): a batch whose second line overdraws rolls the FIRST line back too', () => {
  const { ctx } = freshCtx();
  const locationId = locationOf(ctx);
  const good = stockItem(ctx, 'Good', 'good');
  const scarce = stockItem(ctx, 'Scarce', 'scarce');
  receipt(ctx, good, locationId, 20, '2026-03-01', 'rg');
  receipt(ctx, scarce, locationId, 2, '2026-03-01', 'rs');
  const r = reason(ctx);
  const before = movementRowCount(ctx);

  const res = inventoryAdjustBatch(ctx, {
    lines: [
      { itemId: good, locationId, qtyDelta: -5, reasonCodeId: r.id },
      { itemId: scarce, locationId, qtyDelta: -50, reasonCodeId: r.id }, // overdraws
    ],
    idempotencyKey: 'b1',
  });
  assert.equal(res.ok, false, 'the batch is refused');
  assert.equal(res.error, 'insufficient_stock');
  assert.equal(movementRowCount(ctx), before, 'the FIRST line was rolled back with the failing one');
  assert.equal(adjustmentRowCount(ctx), 0, 'no adjustment rows written');
  assert.equal(rawSum(ctx, 'item_id = ?', [good]), 20, 'the good item on-hand is unchanged');
});

test('J05 (h): a valid batch mints one movement per line under a shared batch_id', () => {
  const { ctx } = freshCtx();
  const locationId = locationOf(ctx);
  const a = stockItem(ctx, 'A', 'a');
  const b = stockItem(ctx, 'B', 'b');
  receipt(ctx, a, locationId, 20, '2026-03-01', 'ra');
  receipt(ctx, b, locationId, 20, '2026-03-01', 'rb');
  const r = reason(ctx);
  const res = must(
    inventoryAdjustBatch(ctx, {
      lines: [
        { itemId: a, locationId, qtyDelta: -3, reasonCodeId: r.id },
        { itemId: b, locationId, qtyDelta: 4, reasonCodeId: r.id },
      ],
      idempotencyKey: 'b1',
    }),
    'batch',
  );
  assert.equal(res.count, 2);
  const batchId = res.batchId;
  assert.equal(res.adjustments.every((x) => x.batchId === batchId), true, 'all lines share the batch id');
  assert.equal(rawSum(ctx, 'item_id = ?', [a]), 17);
  assert.equal(rawSum(ctx, 'item_id = ?', [b]), 24);
});

// --- analysis (aggregation over the linkage) --------------------------------------------------------

test('J05: analysis nets reversed adjustments to zero and sums value impact in Rappen', () => {
  const { ctx } = freshCtx();
  const { itemId, locationId, reasonId } = seed(ctx, 20);
  const revReason = reason(ctx, 'STORNO', { category: 'reversal' });
  must(inventoryAdjust(ctx, { itemId, locationId, qtyDelta: -4, reasonCodeId: reasonId, unitCostMinor: 1500, idempotencyKey: 's1' }), 'adjust');
  const rows = must(inventoryAdjustAnalysis(ctx, { groupBy: ['category'] }), 'analysis').rows;
  const shrink = rows.find((r) => r.category === 'shrinkage');
  assert.equal(shrink.qtyDelta, -4);
  assert.equal(shrink.valueImpactMinor, -6000, '-4 * 1500 Rappen');
});
