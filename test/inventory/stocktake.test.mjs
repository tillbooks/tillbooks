// J04, cycle count / stocktake: the MONEY-PATH invariants a non-author critic must see BITE.
//
// A stocktake mints stock quantity changes EXCLUSIVELY through the J02 append-only ledger
// (inventoryMove, movement_type adjustment); it never writes a quantity itself. Each test below is
// written to FAIL if its invariant were removed:
//   (a) APPEND-ONLY VIA J02: commit mints NEW stock_movement rows; the frozen book_qty snapshot and a
//       committed session are immutable (the DB triggers abort a raw UPDATE / DELETE).
//   (b) IDEMPOTENT ON ROWS: a replay of commit posts NO second movement (row count before == after).
//   (c) §H-TENANT: a foreign workspace's session / line / item id is not_found before any read or mint.
//   (d) REVERSAL: a committed stocktake is corrected by a COMPENSATING J02 movement, never an edit.
//   (e) SIGN / DIRECTION: a positive variance mints a positive adjustment, a negative one a negative.
//   (f) PERIOD LOCK: commit into a locked period is refused; no movement is minted.
//   (g) ATOMICITY: a commit whose second variance line would overdraw rolls the FIRST line back too.
// Plus the commit gate, blind mode, threshold classification, cancel and empty-selection states.

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
  inventoryStocktakeCreate,
  inventoryStocktakeCount,
  inventoryStocktakeReport,
  inventoryStocktakeApproveLines,
  inventoryStocktakeRequestRecount,
  inventoryStocktakeCommit,
  inventoryStocktakeCancel,
  inventoryStocktakeGet,
  inventoryStocktakeList,
} from '../../dist/core/inventory/index.js';

const AT = '2026-08-08T00:00:00.000Z';

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

/** Seed one receipt so the item x location has a frozen book quantity as of `date`. */
function receipt(ctx, itemId, locationId, qty, date, key) {
  return must(
    inventoryMove(ctx, { itemId, locationId, qty, movementType: 'receipt', effectiveDate: date, idempotencyKey: key }),
    'receipt',
  );
}

/** The raw SUM of a filter, straight from SQL: the ground-truth on-hand. */
function rawSum(ctx, where = '', params = []) {
  const clause = where.length > 0 ? ` AND ${where}` : '';
  return ctx.store.db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ?${clause}`)
    .get(ctx.workspaceId, ...params).n;
}

function movementRowCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?').get(ctx.workspaceId).n;
}

function stocktakeMovements(ctx, sessionId) {
  return ctx.store.db
    .prepare("SELECT id, qty, movement_type, ref_kind, ref_id, description FROM stock_movement WHERE workspace_id = ? AND ref_kind = 'stocktake_session' AND ref_id = ?")
    .all(ctx.workspaceId, sessionId);
}

// --- the freeze snapshot IS the J02 balance-as-of (spec §8 live contract) ---------------------------

test('J04: book_qty is bit-identical to the J02 balance-as-of at freeze', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  receipt(ctx, itemId, locationId, 4, '2026-06-01', 'r2'); // after the freeze, must NOT count

  const created = must(
    inventoryStocktakeCreate(ctx, { type: 'full', freezeAt: '2026-04-01', idempotencyKey: 'c1' }),
    'create',
  );
  const line = created.lines.find((l) => l.itemId === itemId);
  const balance = must(inventoryBalance(ctx, { itemId, locationId, asOf: '2026-04-01' }), 'balance').qtyOnHand;
  assert.equal(line.bookQty, 10, 'book freezes the as-of-freeze balance, not the later 14');
  assert.equal(line.bookQty, balance, 'book_qty equals the direct J02 balance-as-of');
});

// --- (a) APPEND-ONLY VIA J02: the snapshot and the committed session are immutable -------------------

test('J04 (a): a line book_qty is immutable, the trigger aborts a raw UPDATE', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const lineId = created.lines[0].id;

  assert.throws(
    () => ctx.store.db.prepare('UPDATE cycle_count_line SET book_qty = 999 WHERE id = ?').run(lineId),
    /cycle_count_line_book_immutable/,
    'a raw UPDATE of the frozen book snapshot must be aborted by the trigger',
  );
  const stored = ctx.store.db.prepare('SELECT book_qty FROM cycle_count_line WHERE id = ?').get(lineId);
  assert.equal(stored.book_qty, 10, 'book_qty did not move');
});

test('J04 (a): a committed session is immutable, the trigger aborts a raw UPDATE', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 12 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');

  assert.throws(
    () => ctx.store.db.prepare("UPDATE cycle_count_session SET status = 'open' WHERE id = ?").run(sessionId),
    /cycle_count_session_immutable/,
    'a committed session must take no further update',
  );
});

test('J04 (a): commit mints a NEW J02 movement, itself immutable (append-only)', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 13 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  const before = movementRowCount(ctx);
  const res = must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');

  assert.equal(res.movementsMinted, 1, 'one variance -> one movement');
  assert.equal(movementRowCount(ctx), before + 1, 'exactly one new ledger row');
  const mv = stocktakeMovements(ctx, sessionId);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].qty, 3, 'variance = counted 13 - book 10');
  assert.equal(mv[0].movement_type, 'adjustment');
  assert.equal(mv[0].description, 'stocktake', 'full session -> stocktake reason on the movement');
  // The minted row is a normal J02 movement, so it is immutable too.
  assert.throws(
    () => ctx.store.db.prepare('UPDATE stock_movement SET qty = 0 WHERE id = ?').run(mv[0].id),
    /stock_movement_immutable/,
  );
  // On-hand is the SUM over the ledger and now equals the counted quantity.
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 13);
});

// --- (b) IDEMPOTENT ON ROWS: a replay posts no second movement --------------------------------------

test('J04 (b): re-commit with the same key posts NO second movement (idempotent on rows)', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 15 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  const first = must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');
  const after = movementRowCount(ctx);

  const replay = must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'replay');
  assert.equal(movementRowCount(ctx), after, 'a replay writes not one more ledger row');
  assert.deepEqual(replay.movementIds, first.movementIds, 'the replay returns the original movement ids');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 15, 'on-hand did not double-count');
});

// The per-line movement key is DETERMINISTIC (`stk:<session>:<line>`), which is the row-level dedup
// that survives even when the outer commit-level idempotency cache is bypassed. This test bites a
// RANDOMISED per-line key: the reconstructed deterministic key would then NOT collide with the minted
// movement, so `inventoryMove` below would mint a SECOND row and the "no new row" assertion fails.
test('J04 (b): the per-line movement key is deterministic and the ledger unique index dedups it', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  const lineId = created.lines[0].id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 18 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');

  // The minted movement carries EXACTLY the deterministic key derived from (session, line).
  const derivedKey = `stk:${sessionId}:${lineId}`;
  const mv = ctx.store.db
    .prepare("SELECT id, idempotency_key FROM stock_movement WHERE workspace_id = ? AND ref_kind = 'stocktake_session' AND ref_id = ?")
    .get(ctx.workspaceId, sessionId);
  assert.equal(mv.idempotency_key, derivedKey, 'the per-line movement key is stk:<session>:<line>, not random');

  // Calling the J02 ledger directly with that SAME deterministic key replays the original movement and
  // mints NO second row: the stock_movement_idempotency unique index is the row-level dedup underneath.
  const before = movementRowCount(ctx);
  const replay = must(
    inventoryMove(ctx, {
      itemId,
      locationId,
      qty: 3,
      movementType: 'adjustment',
      effectiveDate: '2026-04-01',
      idempotencyKey: derivedKey,
    }),
    'ledger replay on the derived key',
  );
  assert.equal(movementRowCount(ctx), before, 'the deterministic key dedups at the ledger: no second row');
  assert.equal(replay.movement.id, mv.id, 'the replay returned the ORIGINAL stocktake movement');
});

// --- (c) §H-TENANT ----------------------------------------------------------------------------------

// This is the test the money-path critic requires to BITE. It seeds A and B in ONE shared store, so a
// verb that dropped its `workspace_id = ?` predicate WOULD read A's session from B and this test WOULD
// go red. Verified to bite by temporarily removing the predicate in `findSession` (get/report returned
// A's session to B, this test failed) and restoring it (green).
test('J04 (c): §H-TENANT bites, workspace B cannot read or operate on A\'s session', () => {
  const { store, ctxA, ctxB } = twoWorkspaces();
  const itemA = stockItem(ctxA);
  const locA = locationOf(ctxA);
  receipt(ctxA, itemA, locA, 5, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctxA, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;

  // B (a different tenant in the SAME store) sees A's session as not_found on every access path, and
  // never mints or mutates anything.
  const beforeMovements = store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n;
  const beforeSessions = store.db.prepare('SELECT COUNT(*) AS n FROM cycle_count_session').get().n;

  const foreignGet = inventoryStocktakeGet(ctxB, { sessionId });
  assert.equal(foreignGet.ok, false);
  assert.equal(foreignGet.error, 'not_found', 'B cannot GET A session');

  const foreignReport = inventoryStocktakeReport(ctxB, { sessionId });
  assert.equal(foreignReport.ok, false);
  assert.equal(foreignReport.error, 'not_found', 'B cannot REPORT on A session');

  const foreignCount = inventoryStocktakeCount(ctxB, {
    sessionId,
    lines: [{ itemId: itemA, locationId: locA, countedQty: 99 }],
    idempotencyKey: 'b-count',
  });
  assert.equal(foreignCount.ok, false);
  assert.equal(foreignCount.error, 'not_found', 'B cannot COUNT into A session');

  const foreignCommit = inventoryStocktakeCommit(ctxB, { sessionId, idempotencyKey: 'b-commit' });
  assert.equal(foreignCommit.ok, false);
  assert.equal(foreignCommit.error, 'not_found', 'B cannot COMMIT A session');

  // Nothing crossed the boundary: no movement minted, no session row added, A's session still open.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, beforeMovements, 'no movement minted across tenants');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cycle_count_session').get().n, beforeSessions, 'no session row added across tenants');
  assert.equal(must(inventoryStocktakeGet(ctxA, { sessionId }), 'A get').session.status, 'open', 'A session untouched');
});

test('J04 (c): a foreign-tenant item on create is not_found (no silent empty selection)', () => {
  // Shared store, so B's item genuinely EXISTS in the database but under a different tenant: A's
  // create must reject it by workspace scope, not merely because the id is absent from the store.
  const { ctxA, ctxB } = twoWorkspaces();
  const itemB = stockItem(ctxB);
  const res = inventoryStocktakeCreate(ctxA, { freezeAt: '2026-04-01', itemIds: [itemB], idempotencyKey: 'c1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found', 'A cannot scope a session to B\'s item');
});

// --- (d) REVERSAL by a compensating movement --------------------------------------------------------

test('J04 (d): a committed stocktake is corrected by a compensating J02 movement, not an edit', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 14 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 14, 'the +4 adjustment landed');

  // The correction is a NEW opposite movement naming the same session, never a destructive edit.
  must(
    inventoryMove(ctx, {
      itemId,
      locationId,
      qty: -4,
      movementType: 'adjustment',
      effectiveDate: '2026-04-02',
      description: 'stocktake_reversal',
      sourceDocumentType: 'stocktake_session',
      sourceDocumentId: sessionId,
      idempotencyKey: 'rev1',
    }),
    'compensating move',
  );
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 10, 'on-hand restored by the compensating movement');
  // The committed session is untouched and still immutable.
  const got = must(inventoryStocktakeGet(ctx, { sessionId }), 'get');
  assert.equal(got.session.status, 'committed');
});

// --- (e) SIGN / DIRECTION ---------------------------------------------------------------------------

test('J04 (e): a negative variance mints a negative adjustment (shrinkage)', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { type: 'cycle', freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 7 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');
  const mv = stocktakeMovements(ctx, sessionId);
  assert.equal(mv[0].qty, -3, 'variance 7 - 10 = -3 mints a negative adjustment');
  assert.equal(mv[0].description, 'cycle_count', 'cycle session -> cycle_count reason');
  assert.equal(rawSum(ctx, 'item_id = ?', [itemId]), 7);
});

// --- (f) PERIOD LOCK --------------------------------------------------------------------------------

test('J04 (f): commit into a locked period is refused, no movement minted', () => {
  const periods = { assertOpen: (d) => (d <= '2025-12-31' ? err('period_locked', { period: '2025', kind: 'hard' }) : ok()) };
  const { ctx } = freshCtx('Acme AG', periods);
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2025-06-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2025-06-30', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 12 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  const before = movementRowCount(ctx);
  const res = inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked', 'the sealed year cannot be back-dated into');
  assert.equal(movementRowCount(ctx), before, 'no movement was minted');
  assert.equal(must(inventoryStocktakeGet(ctx, { sessionId }), 'get').session.status !== 'committed', true);
});

// --- (g) ATOMICITY: a mid-loop overdraw rolls the whole commit back ----------------------------------

test('J04 (g): if the second variance line overdraws, the first line rolls back too', () => {
  const { ctx } = freshCtx();
  const locationId = locationOf(ctx);
  const itemA = stockItem(ctx, 'AAA Good', 'a');
  const itemZ = stockItem(ctx, 'ZZZ Overdraw', 'z');
  receipt(ctx, itemA, locationId, 5, '2026-03-01', 'ra');
  receipt(ctx, itemZ, locationId, 10, '2026-03-01', 'rz');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  // itemA: count 8 -> +3 (fine). itemZ: after freeze it is fully issued out, count 1 -> -9 overdraws.
  must(inventoryMove(ctx, { itemId: itemZ, locationId, qty: -10, movementType: 'issue', effectiveDate: '2026-05-01', idempotencyKey: 'iz' }), 'issue');
  must(
    inventoryStocktakeCount(ctx, {
      sessionId,
      lines: [
        { itemId: itemA, locationId, countedQty: 8 },
        { itemId: itemZ, locationId, countedQty: 1 },
      ],
      idempotencyKey: 'cnt1',
    }),
    'count',
  );
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');

  const before = movementRowCount(ctx);
  const res = inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' });
  assert.equal(res.ok, false, 'the overdraw fails the whole commit');
  assert.equal(res.error, 'insufficient_stock');
  assert.equal(movementRowCount(ctx), before, 'itemA\'s +3 was rolled back with itemZ\'s failure (all or nothing)');
  assert.equal(stocktakeMovements(ctx, sessionId).length, 0, 'no stocktake movement survived');
  assert.equal(must(inventoryStocktakeGet(ctx, { sessionId }), 'get').session.status !== 'committed', true, 'session not committed');
});

// --- commit gate: pending / review_required blocks commit -------------------------------------------

test('J04: commit is blocked while a line is uncounted or unapproved', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;

  // Uncounted (pending) blocks.
  let res = inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' });
  assert.equal(res.error, 'uncounted_or_unapproved_lines');

  // Counted with a material variance -> review_required, still blocks until approved.
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 20 }], idempotencyKey: 'cnt1' }), 'count');
  res = inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm2' });
  assert.equal(res.error, 'uncounted_or_unapproved_lines', 'a review_required line blocks commit');

  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm3' }), 'commit now succeeds');
});

// --- threshold classification -----------------------------------------------------------------------

test('J04: thresholds classify a counted line (approved / counted / review_required)', () => {
  const { ctx } = freshCtx();
  const locationId = locationOf(ctx);
  const item = stockItem(ctx, 'Bolt', 'b');
  receipt(ctx, item, locationId, 100, '2026-03-01', 'r1');
  // qty threshold 5, pct threshold 100: a variance up to 5 units is not material.
  const created = must(
    inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', varianceQtyThreshold: 5, variancePctThreshold: 100, idempotencyKey: 'c1' }),
    'create',
  );
  const sessionId = created.session.id;

  // exact -> approved
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ item, itemId: item, locationId, countedQty: 100 }], idempotencyKey: 'cn0' }), 'count exact');
  let line = must(inventoryStocktakeGet(ctx, { sessionId }), 'get').lines[0];
  assert.equal(line.status, 'approved', 'zero variance auto-approves');

  // within threshold (+4) -> counted
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId: item, locationId, countedQty: 104 }], idempotencyKey: 'cn1' }), 'count +4');
  line = must(inventoryStocktakeGet(ctx, { sessionId }), 'get').lines[0];
  assert.equal(line.status, 'counted', 'a small variance within threshold is committable without approval');

  // over threshold (+40) -> review_required
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId: item, locationId, countedQty: 140 }], idempotencyKey: 'cn2' }), 'count +40');
  line = must(inventoryStocktakeGet(ctx, { sessionId }), 'get').lines[0];
  assert.equal(line.status, 'review_required', 'a material variance needs review');
});

// --- blind mode hides book_qty until review ---------------------------------------------------------

test('J04: a blind count hides book_qty in the count response until review', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', blindCount: true, idempotencyKey: 'c1' }), 'create');
  assert.equal(created.lines[0].bookQty, null, 'blind: create hides book');
  const sessionId = created.session.id;

  const counted = must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 8 }], idempotencyKey: 'cnt1' }), 'count');
  assert.equal(counted.updatedLines[0].bookQty, null, 'blind: the count response still hides book');
  // A material variance moved the session to review; the report now reveals book.
  const report = must(inventoryStocktakeReport(ctx, { sessionId }), 'report');
  assert.equal(report.lines[0].bookQty, 10, 'at review the book is revealed');
});

// --- recount loop -----------------------------------------------------------------------------------

test('J04: request_recount clears a count and sends the line back to pending', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 30 }], idempotencyKey: 'cnt1' }), 'count');
  const lineId = must(inventoryStocktakeGet(ctx, { sessionId }), 'get').lines[0].id;
  must(inventoryStocktakeRequestRecount(ctx, { sessionId, lineIds: [lineId], reason: 'looks wrong', idempotencyKey: 'rc1' }), 'recount');
  const line = must(inventoryStocktakeGet(ctx, { sessionId }), 'get').lines[0];
  assert.equal(line.status, 'pending');
  assert.equal(line.countedQty, null, 'the count was cleared');
});

// --- cancel: no movements ---------------------------------------------------------------------------

test('J04: cancel writes zero movements and cannot cancel a committed session', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  const before = movementRowCount(ctx);
  must(inventoryStocktakeCancel(ctx, { sessionId, reason: 'mistake', idempotencyKey: 'cx1' }), 'cancel');
  assert.equal(movementRowCount(ctx), before, 'cancel mints nothing');
  assert.equal(must(inventoryStocktakeGet(ctx, { sessionId }), 'get').session.status, 'cancelled');

  // A cancelled session cannot be counted or committed.
  assert.equal(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 1 }], idempotencyKey: 'z' }).error, 'stocktake_not_open');
});

// --- already_committed on a re-commit under a NEW key -----------------------------------------------

test('J04: a committed session re-committed under a new key is already_committed', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const sessionId = created.session.id;
  must(inventoryStocktakeCount(ctx, { sessionId, lines: [{ itemId, locationId, countedQty: 11 }], idempotencyKey: 'cnt1' }), 'count');
  must(inventoryStocktakeApproveLines(ctx, { sessionId, lineIds: 'all_review_required', idempotencyKey: 'ap1' }), 'approve');
  must(inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'cm1' }), 'commit');
  const res = inventoryStocktakeCommit(ctx, { sessionId, idempotencyKey: 'DIFFERENT' });
  assert.equal(res.error, 'already_committed');
});

// --- empty selection --------------------------------------------------------------------------------

test('J04: an empty selection creates a valid empty session with a warning', () => {
  const { ctx } = freshCtx();
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  assert.equal(created.lines.length, 0);
  assert.equal(created.warning, 'empty_selection');
  // An empty full session still commits cleanly (the count itself is the proof).
  const committed = must(inventoryStocktakeCommit(ctx, { sessionId: created.session.id, idempotencyKey: 'cm1' }), 'commit');
  assert.equal(committed.movementsMinted, 0);
});

// --- idempotent create ------------------------------------------------------------------------------

test('J04: create is idempotent on its key (a replay returns the same session)', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const first = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const again = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'replay');
  assert.equal(again.session.id, first.session.id);
  const count = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM cycle_count_session WHERE workspace_id = ?').get(ctx.workspaceId).n;
  assert.equal(count, 1, 'no second session row');
});

// --- list -------------------------------------------------------------------------------------------

test('J04: list returns sessions with live progress and filters by status', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locationId = locationOf(ctx);
  receipt(ctx, itemId, locationId, 10, '2026-03-01', 'r1');
  const created = must(inventoryStocktakeCreate(ctx, { freezeAt: '2026-04-01', idempotencyKey: 'c1' }), 'create');
  const all = must(inventoryStocktakeList(ctx, {}), 'list');
  assert.equal(all.sessions.length, 1);
  assert.equal(all.sessions[0].progressPct, 0, 'nothing counted yet');
  must(inventoryStocktakeCount(ctx, { sessionId: created.session.id, lines: [{ itemId, locationId, countedQty: 10 }], idempotencyKey: 'cnt1' }), 'count');
  const open = must(inventoryStocktakeList(ctx, { status: 'open' }), 'list open');
  assert.equal(open.sessions[0].progressPct, 100, 'the only line is counted');
});
