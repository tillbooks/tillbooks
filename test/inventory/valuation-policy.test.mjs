// J03, the valuation POLICY layer: the money-path invariants a non-author critic must see bite.
//
// The pure arithmetic is proven in `valuation.test.mjs` with no database in scope. This suite is the
// other half: what happens when a method assignment meets a period lock, a replay, a second
// workspace, or a closed year somebody would like restated. Each test is written to FAIL if its
// invariant were removed.
//
//   (a) APPEND-ONLY: a raw UPDATE or DELETE on an assignment row is aborted by the DB trigger, and
//       a correction is another row.
//   (b) IDEMPOTENT ON ROWS: a replayed idempotency key writes exactly ONE row. Asserted on real row
//       COUNTS and on the resolved method, never on a returned `ok:true`.
//   (c) §H-PERIOD: the period the change TAKES EFFECT IN is the one that answers, not the call date.
//       A hard-sealed year is not back-restatable by moving the effective date into it.
//   (d) §H-TENANT: workspace A and workspace B in ONE SqliteStore, probing with A's REAL item.
//   (e) STETIGKEIT: resolution at a past as-of returns the method that was in force THEN.
//   (f) The valuation reconciles to the J02 ledger to the Rappen, and the preview writes nothing.

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
  inventoryEnsureDefaultLocation,
  inventoryValuationMethods,
  inventoryValuationPreview,
  inventoryValuationLayers,
  inventoryValuationMethodHistory,
  inventoryValuationMethodSetEnabled,
  inventorySetConfig,
  inventoryValuationSetDefault,
  inventoryValuationSetItemMethod,
  resolveMethodAt,
  enabledMethods,
} from '../../dist/core/inventory/index.js';

const AT = '2026-08-11T00:00:00.000Z';

/**
 * Everything on or before 2025-12-31 is a hard-closed year. This is the shape the §H-PERIOD tests
 * need: a real boundary, so a refusal on one side and an acceptance on the other are both observed
 * from the SAME context and the guard cannot pass by refusing everything.
 */
const sealedThrough2025 = {
  assertOpen: (date) =>
    date <= '2025-12-31' ? { ok: false, error: 'period_locked', period: '2025', kind: 'hard' } : { ok: true },
};

function freshCtx(over = {}) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: over.name ?? 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...(over.periods ? { periods: over.periods } : {}) });
  return { ctx, store, workspaceId };
}

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
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

function locationOf(ctx) {
  return must(inventoryEnsureDefaultLocation(ctx), 'ensureLocation').location.id;
}

function receipt(ctx, itemId, locationId, qty, cost, date, key) {
  return must(
    inventoryMove(ctx, { itemId, locationId, qty, movementType: 'receipt', unitCostMinor: cost, effectiveDate: date, idempotencyKey: key }),
    'receipt',
  );
}

function issue(ctx, itemId, locationId, qty, date, key) {
  return must(
    inventoryMove(ctx, { itemId, locationId, qty, movementType: 'issue', effectiveDate: date, idempotencyKey: key }),
    'issue',
  );
}

/** The assignment row count, straight from SQL: what "exactly one row" is measured against. */
function assignmentCount(ctx) {
  return ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM inventory_valuation_method WHERE workspace_id = ?')
    .get(ctx.workspaceId).n;
}

/** A whole-database fingerprint, for proving a read really wrote nothing. */
function fingerprint(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return tables
    .map((t) => `${t.name}:${store.db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n}`)
    .join('|');
}

// --- (a) APPEND-ONLY ----------------------------------------------------------------------------

test('J03 (a): a method assignment is immutable, the UPDATE trigger aborts', () => {
  const { ctx } = freshCtx();
  const a = must(
    inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'a-1' }),
    'setDefault',
  ).assignment;

  assert.throws(
    () => ctx.store.db.prepare("UPDATE inventory_valuation_method SET method = 'weighted_average' WHERE id = ?").run(a.id),
    /inventory_valuation_method_immutable/,
    'a raw UPDATE on an assignment must be aborted by the trigger',
  );
  assert.equal(resolveMethodAt(ctx, 'anything', '2026-06-01').method, 'fifo', 'the basis did not move');
});

test('J03 (a): a method assignment is immutable, the DELETE trigger aborts', () => {
  const { ctx } = freshCtx();
  const a = must(
    inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'a-2' }),
    'setDefault',
  ).assignment;

  assert.throws(
    () => ctx.store.db.prepare('DELETE FROM inventory_valuation_method WHERE id = ?').run(a.id),
    /inventory_valuation_method_immutable/,
    'a raw DELETE on an assignment must be aborted by the trigger',
  );
  assert.equal(assignmentCount(ctx), 1);
});

test('J03 (a): a correction is another row, and the history keeps both', () => {
  const { ctx } = freshCtx();
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', reason: 'erste Wahl', idempotencyKey: 'a3-1' }), 'first');
  must(inventoryValuationSetDefault(ctx, { method: 'weighted_average', effectiveFrom: '2026-01-01', reason: 'Korrektur', idempotencyKey: 'a3-2' }), 'second');

  assert.equal(assignmentCount(ctx), 2, 'the superseded decision is still on the record');
  // Same effective date, so the one recorded LAST wins: that is the correction the operator meant.
  assert.equal(resolveMethodAt(ctx, 'x', '2026-06-01').method, 'weighted_average');
  const history = must(inventoryValuationMethodHistory(ctx, {}), 'history');
  assert.equal(history.total, 2);
  assert.deepEqual(history.assignments.map((r) => r.reason), ['Korrektur', 'erste Wahl']);
});

// --- (b) IDEMPOTENT ON ROWS ---------------------------------------------------------------------

test('J03 (b): a replayed default change writes exactly ONE row', () => {
  const { ctx } = freshCtx();
  const input = { method: 'fifo', effectiveFrom: '2026-04-01', reason: 'Quartalswechsel', idempotencyKey: 'b-1' };
  const first = must(inventoryValuationSetDefault(ctx, input), 'first');
  assert.equal(assignmentCount(ctx), 1);

  const second = inventoryValuationSetDefault(ctx, input);
  assert.equal(second.ok, true);
  assert.equal(assignmentCount(ctx), 1, 'a replay must not write a second row');
  assert.equal(second.assignment.id, first.assignment.id, 'a replay returns the original row');
});

test('J03 (b): a replayed item override writes exactly ONE row, and does not double the basis', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const input = { itemId, method: 'fifo', effectiveFrom: '2026-04-01', idempotencyKey: 'b2-1' };
  must(inventoryValuationSetItemMethod(ctx, input), 'first');
  must(inventoryValuationSetItemMethod(ctx, input), 'replay');
  must(inventoryValuationSetItemMethod(ctx, input), 'replay again');
  assert.equal(assignmentCount(ctx), 1, 'three calls, one key, one row');
  const rows = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM inventory_valuation_method WHERE workspace_id = ? AND item_id = ?')
    .get(ctx.workspaceId, itemId).n;
  assert.equal(rows, 1);
});

test('J03 (b): a replayed enablement re-asserts the same list rather than accumulating', () => {
  const { ctx } = freshCtx();
  const input = { method: 'standard_cost', enabled: true, idempotencyKey: 'b3-1' };
  must(inventoryValuationMethodSetEnabled(ctx, input), 'first');
  must(inventoryValuationMethodSetEnabled(ctx, input), 'replay');
  assert.deepEqual(enabledMethods(ctx), ['weighted_average', 'fifo', 'standard_cost']);
  const configRows = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM inventory_valuation_config WHERE workspace_id = ?')
    .get(ctx.workspaceId).n;
  assert.equal(configRows, 1);
});

// --- (c) §H-PERIOD ------------------------------------------------------------------------------

test('J03 (c): a method change dated into a sealed year is refused, whatever the call date is', () => {
  const { ctx } = freshCtx({ periods: sealedThrough2025 });

  // The clock says 2026 and 2025 is hard-closed. Back-dating the basis into it would restate the
  // signed Bilanz, so it is refused BEFORE anything is written.
  const refused = inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2025-06-30', idempotencyKey: 'c-1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'period_locked');
  assert.equal(assignmentCount(ctx), 0, 'a refused change writes nothing');

  // The SAME context accepts an open date, so the guard is a boundary and not a blanket refusal.
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'c-2' }), 'open');
  assert.equal(assignmentCount(ctx), 1);
});

test('J03 (c): an item override cannot be back-dated into a sealed year either', () => {
  const { ctx } = freshCtx({ periods: sealedThrough2025 });
  const itemId = stockItem(ctx);
  const refused = inventoryValuationSetItemMethod(ctx, {
    itemId,
    method: 'fifo',
    effectiveFrom: '2025-01-01',
    forceRevaluation: true,
    reason: 'Rückwirkend',
    idempotencyKey: 'c2-1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'period_locked');
  assert.equal(assignmentCount(ctx), 0);
});

test('J03 (c): the lock answers to effectiveFrom, NOT to the call date', () => {
  // This is the bug shape the guard exists to prevent: a capability that checked the DATE PASSED for
  // the transaction rather than the period the figure BELONGS to was back-chargeable into a sealed
  // year. Here the call happens in an open period (the clock is 2026-08) and the change is aimed at
  // a closed one, so a lock keyed on the call date would let it straight through.
  const { ctx } = freshCtx({ periods: sealedThrough2025 });
  assert.equal(ctx.periods.assertOpen('2026-08-11').ok, true, 'the day of the call IS open');
  const refused = inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2025-12-31', idempotencyKey: 'c3-1' });
  assert.equal(refused.error, 'period_locked', 'and the change is refused anyway, because 2025 is not');
  assert.equal(assignmentCount(ctx), 0);
});

test('J03 (c): a replay of an accepted change still returns, even after the period closes', () => {
  // The row already exists. Refusing the replay would change nothing about the books and would break
  // at-least-once callers, so the idempotency pre-check deliberately runs before the period guard.
  const { ctx } = freshCtx();
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'c4-1' }), 'first');
  const sealedCtx = makeContext(ctx.store, {
    workspaceId: ctx.workspaceId,
    actor: 'user_1',
    clock: fixedClock(AT),
    ids: sequenceIdGen(),
    periods: { assertOpen: () => ({ ok: false, error: 'period_locked', period: '2026', kind: 'hard' }) },
  });
  const replay = inventoryValuationSetDefault(sealedCtx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'c4-1' });
  assert.equal(replay.ok, true);
  assert.equal(assignmentCount(ctx), 1, 'and it still writes nothing');
});

// --- the Stetigkeit guard -----------------------------------------------------------------------

test('J03 F4: the inventory.setup gate on the three writes actually bites', () => {
  // A ctx that grants read but refuses `inventory.setup`. Every valuation POLICY write must be
  // refused; the reads must still answer. Mutating the capability check to a no-op survived every
  // suite before this existed, so the gate was declared and unproven.
  const base = freshCtx();
  const denied = makeContext(base.store, {
    workspaceId: base.workspaceId,
    actor: 'user_1',
    clock: fixedClock(AT),
    ids: sequenceIdGen(),
    capabilities: {
      assert: (cap) => (cap === 'inventory.setup' ? { ok: false, error: 'forbidden', capability: cap } : { ok: true }),
    },
  });
  const itemId = stockItem(base.ctx);

  assert.equal(inventoryValuationMethodSetEnabled(denied, { method: 'fifo', enabled: true, idempotencyKey: 'd-1' }).error, 'forbidden');
  assert.equal(inventoryValuationSetDefault(denied, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'd-2' }).error, 'forbidden');
  assert.equal(
    inventoryValuationSetItemMethod(denied, { itemId, method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'd-3' }).error,
    'forbidden',
  );
  assert.equal(assignmentCount(base.ctx), 0, 'a refused write leaves no row');

  // The reads gate on read_master_data, not inventory.setup, so they still answer for this caller.
  assert.equal(must(inventoryValuationMethods(denied), 'methods').defaultMethod, 'weighted_average');
});

test('J03: an override over movements it would restate is blocked without force AND a reason', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 100, 1000, '2026-05-10', 'sg-r1');

  const blocked = inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '2026-05-01', idempotencyKey: 'sg-1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'method_change_blocked_open_period');
  assert.equal(blocked.affectedMovements, 1);
  assert.equal(assignmentCount(ctx), 0);

  // Force alone is not enough: an unexplained restatement is the thing the history exists to prevent.
  const noReason = inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '2026-05-01', forceRevaluation: true, idempotencyKey: 'sg-2' });
  assert.equal(noReason.error, 'method_change_blocked_open_period');
  const blankReason = inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '2026-05-01', forceRevaluation: true, reason: '   ', idempotencyKey: 'sg-3' });
  assert.equal(blankReason.error, 'method_change_blocked_open_period', 'whitespace is not a reason');
  assert.equal(assignmentCount(ctx), 0);

  const forced = must(
    inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '2026-05-01', forceRevaluation: true, reason: 'Umstellung nach Prüfung', idempotencyKey: 'sg-4' }),
    'forced',
  );
  assert.equal(forced.assignment.forceRevaluation, true);
  assert.equal(forced.assignment.reason, 'Umstellung nach Prüfung');
});

test('J03 Q3: the workspace default carries the SAME guard as an item override', () => {
  // Before this, set_default was the wider of the two doors: the item override refused to restate a
  // period that already had movements, while a back-dated DEFAULT restated every item in the
  // workspace with an optional reason and nothing in the history to say why. Automation is allowed to
  // fire both, so an unattended rule could have done it at 03:00.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 100, 1000, '2026-05-10', 'wg-r1');

  const blocked = inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-05-01', idempotencyKey: 'wg-1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'method_change_blocked_open_period');
  assert.equal(blocked.scope, 'workspace');
  assert.equal(blocked.affectedMovements, 1);
  assert.equal(assignmentCount(ctx), 0, 'a refused default change writes nothing');

  // Force alone is not enough, and neither is whitespace: an unexplained restatement is exactly what
  // the history exists to prevent.
  assert.equal(
    inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-05-01', forceRevaluation: true, idempotencyKey: 'wg-2' }).error,
    'method_change_blocked_open_period',
  );
  assert.equal(
    inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-05-01', forceRevaluation: true, reason: '   ', idempotencyKey: 'wg-3' }).error,
    'method_change_blocked_open_period',
    'whitespace is not a reason',
  );
  assert.equal(assignmentCount(ctx), 0);

  const forced = must(
    inventoryValuationSetDefault(ctx, {
      method: 'fifo',
      effectiveFrom: '2026-05-01',
      forceRevaluation: true,
      reason: 'Umstellung nach Prüfung des Abschlusses',
      idempotencyKey: 'wg-4',
    }),
    'forced',
  );
  assert.equal(forced.assignment.forceRevaluation, true);
  assert.equal(forced.assignment.reason, 'Umstellung nach Prüfung des Abschlusses');
  // And the reason is what the Stetigkeit history shows, which is the whole point of demanding it.
  assert.equal(must(inventoryValuationMethodHistory(ctx, { scope: 'workspace' }), 'history').assignments[0].reason, 'Umstellung nach Prüfung des Abschlusses');
});

test('J03 Q3: a default change on an empty ledger, or ahead of every movement, needs no force', () => {
  const { ctx } = freshCtx();
  // Nothing has ever moved: there is no figure to restate, so the guard must not stand in the way.
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'wg2-1' }), 'empty ledger');

  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 10, 500, '2026-01-15', 'wg2-r1');
  must(inventoryValuationSetDefault(ctx, { method: 'weighted_average', effectiveFrom: '2026-07-01', idempotencyKey: 'wg2-2' }), 'future');
  assert.equal(assignmentCount(ctx), 2);
});

test('J03: a change dated ahead of every movement needs no force', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 10, 500, '2026-01-15', 'sg2-r1');
  must(inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '2026-07-01', idempotencyKey: 'sg2-1' }), 'future');
  assert.equal(assignmentCount(ctx), 1);
});

// --- (e) STETIGKEIT: the dated lookup -----------------------------------------------------------

test('J03 (e): a valuation at a past date uses the method that was in force THEN', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  // Two receipts at different costs, then an issue: the two methods give DIFFERENT answers, which is
  // what makes this test able to fail at all.
  receipt(ctx, itemId, loc, 100, 1000, '2026-01-10', 'e-r1');
  receipt(ctx, itemId, loc, 100, 2000, '2026-02-10', 'e-r2');
  issue(ctx, itemId, loc, -100, '2026-03-10', 'e-i1');

  must(inventoryValuationSetDefault(ctx, { method: 'weighted_average', effectiveFrom: '2026-01-01', forceRevaluation: true, reason: 'Basisfestlegung über bestehende Bewegungen', idempotencyKey: 'e-1' }), 'wa');
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-07-01', reason: 'Umstellung', idempotencyKey: 'e-2' }), 'fifo');

  assert.equal(resolveMethodAt(ctx, itemId, '2026-06-30').method, 'weighted_average');
  assert.equal(resolveMethodAt(ctx, itemId, '2026-07-01').method, 'fifo');

  // Weighted average on 100 units left out of a 300_000 pool over 200 units: 150_000.
  const before = must(inventoryValuationPreview(ctx, { itemIds: [itemId], asOf: '2026-06-30' }), 'before');
  assert.equal(before.items[0].method, 'weighted_average');
  assert.equal(before.items[0].totalValueMinor, 150_000);

  // FIFO consumes the cheap layer first, so what is left is the expensive one: 200_000.
  const after = must(inventoryValuationPreview(ctx, { itemIds: [itemId], asOf: '2026-07-31' }), 'after');
  assert.equal(after.items[0].method, 'fifo');
  assert.equal(after.items[0].totalValueMinor, 200_000);

  // And the point of the whole mechanism: recording the July change did NOT move the June figure.
  const stillBefore = must(inventoryValuationPreview(ctx, { itemIds: [itemId], asOf: '2026-06-30' }), 'stillBefore');
  assert.equal(stillBefore.items[0].totalValueMinor, 150_000, 'a filed figure does not move because policy changed later');
});

test('J03 (e): an item override beats the workspace default, and both are dated', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  must(inventoryValuationSetDefault(ctx, { method: 'weighted_average', effectiveFrom: '2026-01-01', idempotencyKey: 'e2-1' }), 'ws');
  must(inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '2026-05-01', idempotencyKey: 'e2-2' }), 'item');

  assert.equal(resolveMethodAt(ctx, itemId, '2026-04-30').source, 'workspace');
  assert.equal(resolveMethodAt(ctx, itemId, '2026-04-30').method, 'weighted_average');
  assert.equal(resolveMethodAt(ctx, itemId, '2026-05-01').source, 'item');
  assert.equal(resolveMethodAt(ctx, itemId, '2026-05-01').method, 'fifo');
  // An unrelated item still follows the workspace default.
  assert.equal(resolveMethodAt(ctx, 'other_item', '2026-05-01').method, 'weighted_average');
});

test('J03 (e): a workspace that has recorded nothing values at the built-in default', () => {
  const { ctx } = freshCtx();
  const resolved = resolveMethodAt(ctx, 'anything', '2026-05-01');
  assert.equal(resolved.method, 'weighted_average');
  assert.equal(resolved.source, 'builtin');
  const methods = must(inventoryValuationMethods(ctx), 'methods');
  assert.equal(methods.defaultSource, 'builtin');
  assert.deepEqual(
    methods.methods.filter((m) => m.enabled).map((m) => m.method),
    ['weighted_average', 'fifo'],
    'standard_cost is registered and off until asked for',
  );
});

// --- enablement ---------------------------------------------------------------------------------

test('J03: a disabled method cannot be chosen, previewed or defaulted to', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  assert.equal(inventoryValuationSetDefault(ctx, { method: 'standard_cost', effectiveFrom: '2026-01-01', idempotencyKey: 'd-1' }).error, 'method_disabled');
  assert.equal(inventoryValuationSetItemMethod(ctx, { itemId, method: 'standard_cost', effectiveFrom: '2026-01-01', standardCostMinor: 900, idempotencyKey: 'd-2' }).error, 'method_disabled');
  assert.equal(inventoryValuationPreview(ctx, { methodOverride: 'standard_cost' }).error, 'method_disabled');
  assert.equal(assignmentCount(ctx), 0);

  must(inventoryValuationMethodSetEnabled(ctx, { method: 'standard_cost', enabled: true, idempotencyKey: 'd-3' }), 'enable');
  must(inventoryValuationSetItemMethod(ctx, { itemId, method: 'standard_cost', effectiveFrom: '2026-01-01', standardCostMinor: 900, idempotencyKey: 'd-4' }), 'now allowed');
});

test('J03: standard_cost without a standard cost is refused at the boundary', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  must(inventoryValuationMethodSetEnabled(ctx, { method: 'standard_cost', enabled: true, idempotencyKey: 'sc-1' }), 'enable');
  const refused = inventoryValuationSetItemMethod(ctx, { itemId, method: 'standard_cost', effectiveFrom: '2026-01-01', idempotencyKey: 'sc-2' });
  assert.equal(refused.error, 'missing_standard_cost');
  assert.equal(inventoryValuationSetItemMethod(ctx, { itemId, method: 'standard_cost', effectiveFrom: '2026-01-01', standardCostMinor: 0, idempotencyKey: 'sc-3' }).error, 'invalid_input');
  assert.equal(assignmentCount(ctx), 0);
});

test('J03: the method in force as default cannot be disabled out from under itself', () => {
  const { ctx } = freshCtx();
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'md-1' }), 'default');
  const refused = inventoryValuationMethodSetEnabled(ctx, { method: 'fifo', enabled: false, idempotencyKey: 'md-2' });
  assert.equal(refused.error, 'method_is_default');
  assert.deepEqual(enabledMethods(ctx), ['weighted_average', 'fifo']);
});

test('J03: an unknown method key never falls through to a default formula', () => {
  const { ctx } = freshCtx();
  assert.equal(inventoryValuationSetDefault(ctx, { method: 'lifo', effectiveFrom: '2026-01-01', idempotencyKey: 'um-1' }).error, 'unknown_method');
  assert.equal(inventoryValuationPreview(ctx, { methodOverride: 'nonsense' }).error, 'unknown_method');
  // The D01 alias is the ONE exception, and it resolves rather than being refused.
  must(inventoryValuationSetDefault(ctx, { method: 'weighted_avg', effectiveFrom: '2026-01-01', idempotencyKey: 'um-2' }), 'alias');
  assert.equal(resolveMethodAt(ctx, 'x', '2026-02-01').method, 'weighted_average');
});

// --- (f) the ledger reconciliation, and the pure reads ------------------------------------------

test('J03 (f): the valuation reconciles to the J02 ledger to the Rappen', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 100, 1250, '2026-01-10', 'f-r1');
  receipt(ctx, itemId, loc, 50, 1400, '2026-02-10', 'f-r2');
  issue(ctx, itemId, loc, -80, '2026-03-10', 'f-i1');

  const preview = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'preview');
  const row = preview.items[0];

  // The quantity is the ledger's own SUM, taken straight from SQL rather than from the verb.
  const ledgerQty = ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ? AND item_id = ?')
    .get(ctx.workspaceId, itemId).n;
  assert.equal(row.qtyOnHand, ledgerQty);
  assert.equal(ledgerQty, 70);

  // And the value is the ledger's own cost pool, scaled: 195_000 over 150 units, 70 units left.
  const pool = ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty * unit_cost_minor), 0) AS n FROM stock_movement WHERE workspace_id = ? AND item_id = ? AND qty > 0')
    .get(ctx.workspaceId, itemId).n;
  assert.equal(pool, 195_000);
  assert.equal(row.totalValueMinor, Math.round((70 * pool) / 150));
  assert.equal(row.totalValueMinor, 91_000);
  assert.equal(preview.totalValueMinor, 91_000, 'the roll-up is exactly its rows');
});

test('J03 (f): the four reads write NOTHING, proven on a whole-database fingerprint', () => {
  const { ctx, store } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 40, 700, '2026-02-01', 'p-r1');
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', forceRevaluation: true, reason: 'Basisfestlegung', idempotencyKey: 'p-1' }), 'default');

  const before = fingerprint(store);
  must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'preview');
  must(inventoryValuationPreview(ctx, { methodOverride: 'weighted_average' }), 'what-if');
  must(inventoryValuationLayers(ctx, { itemId }), 'layers');
  must(inventoryValuationMethods(ctx), 'methods');
  must(inventoryValuationMethodHistory(ctx, {}), 'history');
  assert.equal(fingerprint(store), before, 'valuing inventory must not write a single row anywhere');
});

test('J03 (f): a what-if override leaves the stored policy untouched', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 100, 1000, '2026-01-10', 'w-r1');
  receipt(ctx, itemId, loc, 100, 2000, '2026-02-10', 'w-r2');
  issue(ctx, itemId, loc, -100, '2026-03-10', 'w-i1');
  must(inventoryValuationSetDefault(ctx, { method: 'weighted_average', effectiveFrom: '2026-01-01', forceRevaluation: true, reason: 'Basisfestlegung', idempotencyKey: 'w-1' }), 'default');

  const whatIf = must(inventoryValuationPreview(ctx, { itemIds: [itemId], methodOverride: 'fifo' }), 'what-if');
  assert.equal(whatIf.items[0].totalValueMinor, 200_000);
  assert.equal(whatIf.items[0].methodSource, 'override');
  assert.equal(resolveMethodAt(ctx, itemId, '2026-12-31').method, 'weighted_average', 'the stored policy did not move');
  assert.equal(must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'stored').items[0].totalValueMinor, 150_000);
});

test('J03: the OR 960c clamp reaches through the verb, per item', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 100, 1000, '2026-01-10', 'l-r1');
  const clamped = must(
    inventoryValuationPreview(ctx, { itemIds: [itemId], netRealisableValues: { [itemId]: 750 } }),
    'clamped',
  );
  assert.equal(clamped.items[0].lcmApplied, true);
  assert.equal(clamped.items[0].totalValueMinor, 75_000);
  assert.equal(clamped.totalWriteDownMinor, 25_000);
});

test('J03: layers are derived from the ledger, so they cannot drift from it', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const loc = locationOf(ctx);
  receipt(ctx, itemId, loc, 100, 1000, '2026-01-01', 'y-r1');
  issue(ctx, itemId, loc, -60, '2026-01-03', 'y-i1');
  receipt(ctx, itemId, loc, 80, 1200, '2026-01-05', 'y-r2');
  issue(ctx, itemId, loc, -50, '2026-01-07', 'y-i2');

  const l = must(inventoryValuationLayers(ctx, { itemId }), 'layers');
  assert.equal(l.layers.length, 1);
  assert.equal(l.layers[0].remainingQty, 70);
  assert.equal(l.layers[0].unitCostMinor, 1200);
  assert.equal(l.layerQty, 70);
  assert.equal(l.totalValueMinor, 84_000);
  assert.equal(l.shortfall, 0);

  // One more movement, and the layers move with it. There is no cache to invalidate.
  issue(ctx, itemId, loc, -20, '2026-01-09', 'y-i3');
  assert.equal(must(inventoryValuationLayers(ctx, { itemId }), 'again').layerQty, 50);
});

// --- the internal transfer, driven through the REAL verbs ---------------------------------------

/** A second stock_location, so a transfer has somewhere to go (D01's table, minimal columns). */
function seedLocation(ctx, name) {
  const id = ctx.ids.next('loc');
  ctx.store.db
    .prepare('INSERT INTO stock_location (id, workspace_id, name, type, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, ctx.workspaceId, name, 'warehouse', ctx.clock.now());
  return id;
}

test('J03 F1: an internal transfer does not move the item-level figure, through the real verbs', () => {
  // The critic's reproduction, end to end: create the item, receive stock, run inventory_transfer,
  // and value it the way Studio and J06 would. Before the fix this returned 70_000 with reason null.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'tf-def' }), 'fifo');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'tf-r1');

  const before = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'before').items[0];
  assert.equal(before.totalValueMinor, 100_000);

  const moved = must(
    inventoryTransfer(ctx, { itemId, fromLocationId: locA, toLocationId: locB, qty: 30, effectiveDate: '2026-02-01', idempotencyKey: 'tf-x1' }),
    'transfer',
  );
  // The ledger really did write two uncosted legs: without this the rest could pass vacuously.
  assert.equal(moved.out.unitCostMinor, null);
  assert.equal(moved.in.unitCostMinor, null);

  const after = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'after').items[0];
  assert.equal(after.qtyOnHand, 100, 'a transfer is quantity-neutral');
  assert.equal(after.totalValueMinor, 100_000, 'and it must be value-neutral: nothing was bought or sold');
  assert.equal(after.reason, null);
  assert.deepEqual(after.warnings, [], 'a transfer leg is not a missing cost');
  assert.deepEqual(after.missingCostMovementIds, []);
});

test('J03 F1: the layers verb follows the goods rather than losing them at the border', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'tl-r1');
  must(inventoryTransfer(ctx, { itemId, fromLocationId: locA, toLocationId: locB, qty: 30, effectiveDate: '2026-02-01', idempotencyKey: 'tl-x1' }), 'transfer');

  const whole = must(inventoryValuationLayers(ctx, { itemId }), 'whole');
  assert.equal(whole.layerQty, 100);
  assert.equal(whole.totalValueMinor, 100_000);

  const atB = must(inventoryValuationLayers(ctx, { itemId, locationId: locB }), 'atB');
  assert.equal(atB.layerQty, 30);
  assert.equal(atB.totalValueMinor, 30_000, 'the destination holds real cost, not nothing');
  assert.equal(atB.layers[0].unitCostMinor, 1000);

  const atA = must(inventoryValuationLayers(ctx, { itemId, locationId: locA }), 'atA');
  assert.equal(atA.totalValueMinor, 70_000);
  assert.equal(atA.totalValueMinor + atB.totalValueMinor, whole.totalValueMinor, 'the two sides partition the item');
});

test('J03 F1b: a location read AFTER the destination issues agrees with the item read', () => {
  // The critic's reproduction, end to end. Before the aliasing fix this returned 160_000 with a
  // spurious missing_unit_cost naming the transfer leg, while the item-level read of the same
  // ledger returned 146_667.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'al-r1');
  must(inventoryTransfer(ctx, { itemId, fromLocationId: locA, toLocationId: locB, qty: 100, effectiveDate: '2026-02-01', idempotencyKey: 'al-x1' }), 'transfer');
  issue(ctx, itemId, locB, -40, '2026-03-01', 'al-i1');
  receipt(ctx, itemId, locB, 50, 2000, '2026-04-01', 'al-r2');

  const atB = must(inventoryValuationPreview(ctx, { itemIds: [itemId], locationId: locB }), 'atB').items[0];
  assert.equal(atB.qtyOnHand, 110);
  assert.equal(atB.totalValueMinor, 146_667);
  assert.deepEqual(atB.warnings, []);
  assert.deepEqual(atB.missingCostMovementIds, []);

  const whole = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'whole').items[0];
  assert.equal(whole.totalValueMinor, atB.totalValueMinor, 'A holds nothing, so the two scopes must agree');
});

// --- (F3) valueByLocation actually does something ------------------------------------------------

test('J03 F3: valueByLocation returns one row per location, summing to the item total', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01', idempotencyKey: 'bl-def' }), 'fifo');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'bl-r1');
  must(inventoryTransfer(ctx, { itemId, fromLocationId: locA, toLocationId: locB, qty: 30, effectiveDate: '2026-02-01', idempotencyKey: 'bl-x1' }), 'transfer');

  const whole = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'whole');
  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], valueByLocation: true }), 'split');

  assert.equal(split.valueByLocation, true);
  assert.equal(split.items.length, 2, 'one row per location the item has moved through');
  assert.deepEqual(
    split.items.map((r) => [r.locationId, r.qtyOnHand, r.totalValueMinor]).sort(),
    [
      [locA, 70, 70_000],
      [locB, 30, 30_000],
    ].sort(),
  );
  assert.equal(split.totalValueMinor, whole.totalValueMinor, 'the breakdown reconciles to the total exactly');
  assert.ok(split.items.every((r) => r.valuationBasis === 'direct'), 'FIFO layers belong to their location');
});

test('J03 F2: with genuinely DIFFERENT unit costs, the breakdown still sums to the item total', () => {
  // THE HOLLOW FIXTURE THIS REPLACES. The additivity test above uses one unit cost throughout, so
  // every average coincides and it would have passed whatever the per-location rule was. This is the
  // case that separates them: 100 at 1000 in one place and 100 at 2000 in another, then an issue.
  // Valuing each location on its OWN receipts gives 250_000 against an item-wide 225_000, so a
  // display toggle would have moved the workspace inventory figure by CHF 250. No transfer needed.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'wa-r1');
  receipt(ctx, itemId, locB, 100, 2000, '2026-01-20', 'wa-r2');
  issue(ctx, itemId, locA, -50, '2026-02-01', 'wa-i1');

  const whole = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'whole').items[0];
  // Pool 300_000 over 200 units, 150 on hand: 225_000, at a pooled average of 1500.
  assert.equal(whole.qtyOnHand, 150);
  assert.equal(whole.unitCostMinor, 1500);
  assert.equal(whole.totalValueMinor, 225_000);
  assert.equal(whole.valuationBasis, 'direct');

  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], valueByLocation: true }), 'split');
  assert.equal(split.items.length, 2);
  assert.equal(
    split.items.reduce((s, r) => s + r.totalValueMinor, 0),
    225_000,
    'the rows sum to the item total, not to 250_000',
  );
  assert.equal(split.totalValueMinor, whole.totalValueMinor);
  // Each location shows ITS quantity at the ITEM's pooled average, and says the figure is a share.
  for (const row of split.items) {
    assert.equal(row.unitCostMinor, 1500, 'one pool per item means one average');
    assert.equal(row.valuationBasis, 'allocated');
  }
  const byLocation = Object.fromEntries(split.items.map((r) => [r.locationId, r.totalValueMinor]));
  assert.equal(byLocation[locA], 75_000, '50 units of the pooled average');
  assert.equal(byLocation[locB], 150_000, '100 units of the pooled average');
});

test('J03 F2: a single-location read gives the same number as that row inside a breakdown', () => {
  // A share is only well defined against the whole set, so the single-location door has to walk
  // through the same allocation or the two would disagree by a Rappen or more.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'sg-r1');
  receipt(ctx, itemId, locB, 100, 2000, '2026-01-20', 'sg-r2');
  issue(ctx, itemId, locA, -50, '2026-02-01', 'sg-i1');

  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], valueByLocation: true }), 'split');
  const insideBreakdown = split.items.find((r) => r.locationId === locB);
  const alone = must(inventoryValuationPreview(ctx, { itemIds: [itemId], locationId: locB }), 'alone').items[0];
  assert.equal(alone.totalValueMinor, insideBreakdown.totalValueMinor);
  assert.equal(alone.unitCostMinor, insideBreakdown.unitCostMinor);
  assert.equal(alone.valuationBasis, 'allocated');
});

test('J03 F2: the allocation is exact even when the pooled average does not divide evenly', () => {
  // 1000 Rappen over 3 units is 333.33 each. Rounding each location independently would give rows
  // summing to one Rappen less than the item total; largest-remainder puts the odd Rappen somewhere.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  const locC = seedLocation(ctx, 'Lager C');
  receipt(ctx, itemId, locA, 1, 1000, '2026-01-10', 'rm-r1');
  receipt(ctx, itemId, locB, 1, 0, '2026-01-11', 'rm-r2');
  receipt(ctx, itemId, locC, 1, 0, '2026-01-12', 'rm-r3');

  const whole = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'whole').items[0];
  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], valueByLocation: true }), 'split');
  assert.equal(split.items.length, 3);
  assert.equal(
    split.items.reduce((s, r) => s + r.totalValueMinor, 0),
    whole.totalValueMinor,
    'to the Rappen, with no remainder quietly dropped',
  );
  assert.ok(split.items.every((r) => Number.isInteger(r.totalValueMinor)));
});

test('J03 F3: locationId ALONE filters, instead of being silently dropped', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'lf-r1');
  must(inventoryTransfer(ctx, { itemId, fromLocationId: locA, toLocationId: locB, qty: 30, effectiveDate: '2026-02-01', idempotencyKey: 'lf-x1' }), 'transfer');

  const atB = must(inventoryValuationPreview(ctx, { itemIds: [itemId], locationId: locB }), 'atB');
  assert.equal(atB.locationId, locB);
  assert.equal(atB.items.length, 1);
  assert.equal(atB.items[0].qtyOnHand, 30, 'not the company-wide 100 the field used to return');
  assert.equal(atB.items[0].totalValueMinor, 30_000);
  assert.equal(atB.totalValueMinor, 30_000);
});

test('J03 F3: a foreign or unknown location is not_found, never an empty valuation', () => {
  const { store, a, b } = twoWorkspaces();
  const itemB = stockItem(b, { name: 'Beta Widget', key: 'lb-it' });
  const locB = locationOf(b);
  receipt(b, itemB, locB, 10, 100, '2026-01-10', 'lb-r1');
  // A silently empty answer would read as "that location holds nothing", which is a different and
  // much more dangerous sentence than "there is no such location here".
  assert.equal(inventoryValuationPreview(a, { locationId: locB }).error, 'not_found');
  assert.equal(inventoryValuationPreview(a, { locationId: 'loc_made_up' }).error, 'not_found');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 1);
});

test('J03 F1: the LAYERS verb never reports more units than the ledger holds (one location)', () => {
  // The exact defect the critic reproduced end to end: capLayersToQty lived only inside fifo(), so
  // the layers verb summed raw layers. Receipt 100 at 10.00 dated day2, issue -60 backdated to day1,
  // on-hand 40. `layers` returned 100000 / layerQty 100 while `preview` said 40000. Two shipped verbs
  // disagreed by CHF 600.00 on one ledger, and the larger number was an overstated Bilanzwert.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'lc-cfg' }), 'allow negative');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-02', 'lc-r1');
  issue(ctx, itemId, locA, -60, '2026-01-01', 'lc-i1');

  const layers = must(inventoryValuationLayers(ctx, { itemId, locationId: locA }), 'layers');
  assert.equal(layers.layerQty, 40, 'the trim falls on the oldest end, capping to on-hand');
  assert.equal(layers.totalValueMinor, 40_000);
  // The two verbs of the pair now agree, to the Rappen, on the same ledger.
  const preview = must(inventoryValuationPreview(ctx, { itemIds: [itemId], locationId: locA }), 'preview').items[0];
  assert.equal(layers.totalValueMinor, preview.totalValueMinor);
});

test('J03 F1: the LAYERS verb caps the ITEM scope to item on-hand when a location is net short', () => {
  // locationId null reads the merged queue, which is per-location capped but can still exceed the
  // item on-hand when another location is net negative. loc_a holds 100 at 1000; loc_b is minus 20,
  // so item on-hand is 80 and the layers must value 80 units, not 100.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'ln-cfg' }), 'allow negative');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'ln-r1');
  issue(ctx, itemId, locB, -20, '2026-01-15', 'ln-i1');

  const whole = must(inventoryValuationLayers(ctx, { itemId }), 'whole');
  assert.equal(whole.layerQty, 80, 'the item nets the short location in');
  assert.equal(whole.totalValueMinor, 80_000);
  assert.equal(must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'pv').items[0].totalValueMinor, 80_000);
});

test('J03 F3b: the LAYERS verb reports the LOCATION shortfall, the way preview does', () => {
  // Verbatim the defect the preview side already fixed, on the other half of the same pair: Lager B
  // holds 100 fully costed units and reported Lager A's shortfall as its own.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'sf-cfg' }), 'allow negative');
  receipt(ctx, itemId, locA, 40, 1000, '2026-01-01', 'sf-r1');
  issue(ctx, itemId, locA, -60, '2026-01-02', 'sf-i1');
  receipt(ctx, itemId, locB, 100, 500, '2026-01-03', 'sf-r2');

  const atB = must(inventoryValuationLayers(ctx, { itemId, locationId: locB }), 'atB');
  assert.equal(atB.layerQty, 100);
  assert.equal(atB.shortfall, 0, 'Lager B is short of nothing');
  const atA = must(inventoryValuationLayers(ctx, { itemId, locationId: locA }), 'atA');
  assert.equal(atA.shortfall, 20, 'and Lager A still owns its own');
  const whole = must(inventoryValuationLayers(ctx, { itemId }), 'whole');
  assert.equal(whole.shortfall, 20, 'the item as a whole is short, and says so');
  // The sibling verb agrees about the same location, which is the property that was broken.
  assert.equal(must(inventoryValuationPreview(ctx, { itemIds: [itemId], locationId: locB }), 'pv').items[0].reason, null);
});

test('J03 F2: standard-cost rows sum to the item total when a location is short', () => {
  // `qty x standard` distributes over a sum, but a SHORT location returns zero rather than a negative
  // book value while the item figure nets the short position in, so the rows came out ABOVE the item
  // total. Reachable through shipped verbs: inventory_move accepts a backdated issue and the
  // insufficient_stock guard tests availability TODAY, not as of the valuation date.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventoryValuationMethodSetEnabled(ctx, { method: 'standard_cost', enabled: true, idempotencyKey: 'sc-en' }), 'enable');
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'sc-cfg' }), 'allow negative');
  must(
    inventoryValuationSetItemMethod(ctx, { itemId, method: 'standard_cost', effectiveFrom: '2026-01-01', standardCostMinor: 1000, idempotencyKey: 'sc-set' }),
    'std',
  );
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'sc-r1');
  issue(ctx, itemId, locB, -20, '2026-01-15', 'sc-i1');

  const whole = must(inventoryValuationPreview(ctx, { itemIds: [itemId], asOf: '2026-03-01' }), 'whole').items[0];
  assert.equal(whole.qtyOnHand, 80);
  assert.equal(whole.totalValueMinor, 80_000, '80 units at the standard');

  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], asOf: '2026-03-01', valueByLocation: true }), 'split');
  assert.equal(
    split.items.reduce((s, r) => s + r.totalValueMinor, 0),
    80_000,
    'the rows sum to the item total, not to 100_000',
  );
  assert.equal(split.totalValueMinor, whole.totalValueMinor);
});

test('J03 F2: standard cost with no short location is unchanged by the allocation', () => {
  // The allocation must not disturb the ordinary case: the division is exact, so each share is
  // still precisely qty x standard.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventoryValuationMethodSetEnabled(ctx, { method: 'standard_cost', enabled: true, idempotencyKey: 'sc2-en' }), 'enable');
  must(
    inventoryValuationSetItemMethod(ctx, { itemId, method: 'standard_cost', effectiveFrom: '2026-01-01', standardCostMinor: 700, idempotencyKey: 'sc2-set' }),
    'std',
  );
  receipt(ctx, itemId, locA, 30, 900, '2026-01-10', 'sc2-r1');
  receipt(ctx, itemId, locB, 20, 900, '2026-01-11', 'sc2-r2');

  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], valueByLocation: true }), 'split');
  const byLocation = Object.fromEntries(split.items.map((r) => [r.locationId, r.totalValueMinor]));
  assert.equal(byLocation[locA], 21_000, '30 x 700');
  assert.equal(byLocation[locB], 14_000, '20 x 700');
  assert.equal(split.totalValueMinor, 35_000);
});

test('J03 F5: a short location takes no share of the item value', () => {
  // The owner-ruled behaviour, previously untested: allocating a positive figure onto a negative
  // position would invent an asset, and the rows would stop summing to the item total.
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  const locA = locationOf(ctx);
  const locB = seedLocation(ctx, 'Lager B');
  must(inventorySetConfig(ctx, { allowNegativeStock: true, idempotencyKey: 'ns-cfg' }), 'allow negative');
  receipt(ctx, itemId, locA, 100, 1000, '2026-01-10', 'ns-r1');
  issue(ctx, itemId, locB, -20, '2026-01-15', 'ns-i1');

  const whole = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'whole').items[0];
  const split = must(inventoryValuationPreview(ctx, { itemIds: [itemId], valueByLocation: true }), 'split');
  const short = split.items.find((r) => r.locationId === locB);
  assert.equal(short.qtyOnHand, -20);
  assert.equal(short.totalValueMinor, 0, 'a short position carries no share');
  assert.equal(short.reason, 'negative_quantity');
  assert.equal(
    split.items.reduce((s, r) => s + r.totalValueMinor, 0),
    whole.totalValueMinor,
    'and the rows still sum to the item total',
  );
});

test('J03 F3: the LAYERS verb applies the same rule preview does', () => {
  // The rule was applied to one of the two location-taking verbs. `layers` answered ok:true with an
  // empty list for a location that does not exist here, so the two doors disagreed about the same id.
  const { a, b } = twoWorkspaces();
  const itemA = stockItem(a, { name: 'Alpha Widget', key: 'lv-it' });
  const locA = locationOf(a);
  const locB = locationOf(b);
  receipt(a, itemA, locA, 10, 100, '2026-01-10', 'lv-r1');

  assert.equal(inventoryValuationLayers(a, { itemId: itemA, locationId: 'loc_made_up' }).error, 'not_found');
  assert.equal(inventoryValuationLayers(a, { itemId: itemA, locationId: locB }).error, 'not_found', "another workspace's location is invisible");
  // And the real one still answers.
  assert.equal(must(inventoryValuationLayers(a, { itemId: itemA, locationId: locA }), 'own').layerQty, 10);
});

// --- (d) §H-TENANT ------------------------------------------------------------------------------

/**
 * Two workspaces inside ONE store, the way `movement-ledger.test.mjs` does it.
 *
 * Two freshCtx() calls would give each its own SqliteStore, so Beta's database would hold no Alpha
 * rows at all and a query that had LOST its workspace filter entirely would still read zero. The
 * assertions would stay green while the invariant was gone. One store is what makes the filter the
 * only thing standing between them, and every probe below uses Alpha's REAL item id, never an
 * invented one.
 */
function twoWorkspaces() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const wsA = createWorkspace({ store, clock, ids }, { name: 'Alpha AG' }).workspaceId;
  const wsB = createWorkspace({ store, clock, ids }, { name: 'Beta AG' }).workspaceId;
  return {
    store,
    a: makeContext(store, { workspaceId: wsA, actor: 'user_1', clock, ids }),
    b: makeContext(store, { workspaceId: wsB, actor: 'user_2', clock, ids }),
  };
}

test('J03 (d): a foreign workspace cannot value, inspect or reassign another workspace inventory', () => {
  const { store, a, b } = twoWorkspaces();
  const itemA = stockItem(a, { name: 'Alpha Widget', key: 'ta-it' });
  const locA = locationOf(a);
  receipt(a, itemA, locA, 100, 5000, '2026-02-01', 'ta-r1');
  must(inventoryValuationSetDefault(a, { method: 'fifo', effectiveFrom: '2026-01-01', forceRevaluation: true, reason: 'Alpha Politik', idempotencyKey: 'ta-1' }), 'aDefault');
  must(
    inventoryValuationSetItemMethod(a, {
      itemId: itemA,
      method: 'weighted_average',
      effectiveFrom: '2026-01-01',
      // The receipt above is dated after this, so the Stetigkeit guard is genuinely in the way and
      // the force is what gets past it. That the tenant fixture had to satisfy it is itself evidence.
      forceRevaluation: true,
      reason: 'Alpha stellt diesen Artikel um',
      idempotencyKey: 'ta-2',
    }),
    'aItem',
  );

  // The one store really does hold Alpha's rows: without this the rest could pass on an empty database.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM stock_movement').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM inventory_valuation_method').get().n, 2);
  assert.equal(assignmentCount(a), 2);
  assert.equal(assignmentCount(b), 0);

  // Beta, probing with ALPHA'S REAL ids, sees nothing through any read path.
  assert.equal(inventoryValuationPreview(b, { itemIds: [itemA] }).error, 'not_found');
  assert.equal(inventoryValuationLayers(b, { itemId: itemA }).error, 'not_found');
  assert.equal(inventoryValuationMethodHistory(b, { itemId: itemA }).error, 'not_found');
  // Alpha's policy does not leak into Beta's resolution either.
  assert.equal(resolveMethodAt(b, itemA, '2026-06-01').method, 'weighted_average');
  assert.equal(resolveMethodAt(b, itemA, '2026-06-01').source, 'builtin', "Alpha's fifo default is invisible to Beta");
  assert.equal(must(inventoryValuationMethods(b), 'bMethods').defaultSource, 'builtin');

  // The UNFILTERED sweeps in B return only B's rows, which is what a lost filter would betray.
  assert.equal(must(inventoryValuationMethodHistory(b, {}), 'bHistory').total, 0);
  const bPreview = must(inventoryValuationPreview(b, {}), 'bPreview');
  assert.equal(bPreview.items.length, 0, 'a whole-workspace valuation in B values nothing of A');
  assert.equal(bPreview.totalValueMinor, 0);

  // Beta cannot WRITE against Alpha's item either.
  assert.equal(
    inventoryValuationSetItemMethod(b, { itemId: itemA, method: 'fifo', effectiveFrom: '2026-06-01', idempotencyKey: 'tb-1' }).error,
    'not_found',
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM inventory_valuation_method').get().n, 2, 'no refused write left a row behind');

  // Alpha still holds its own, and its numbers did not move.
  const aPreview = must(inventoryValuationPreview(a, {}), 'aPreview');
  assert.equal(aPreview.items.length, 1);
  assert.equal(aPreview.totalValueMinor, 500_000);
  assert.equal(must(inventoryValuationMethodHistory(a, {}), 'aHistory').total, 2);
});

test('J03 (d): two workspaces holding the SAME method key keep separate enablement', () => {
  const { a, b } = twoWorkspaces();
  must(inventoryValuationMethodSetEnabled(a, { method: 'standard_cost', enabled: true, idempotencyKey: 'te-1' }), 'aEnable');
  assert.deepEqual(enabledMethods(a), ['weighted_average', 'fifo', 'standard_cost']);
  assert.deepEqual(enabledMethods(b), ['weighted_average', 'fifo'], "B did not inherit A's enablement");
  assert.equal(must(inventoryValuationMethods(b), 'bMethods').methods.find((m) => m.method === 'standard_cost').enabled, false);
});

// --- input guards -------------------------------------------------------------------------------

test('J03: the date and key guards reject before any write', () => {
  const { ctx } = freshCtx();
  const itemId = stockItem(ctx);
  assert.equal(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: 'gestern', idempotencyKey: 'g-1' }).error, 'invalid_input');
  assert.equal(inventoryValuationSetDefault(ctx, { method: 'fifo', effectiveFrom: '2026-01-01' }).error, 'invalid_input');
  assert.equal(inventoryValuationSetItemMethod(ctx, { itemId, method: 'fifo', effectiveFrom: '', idempotencyKey: 'g-2' }).error, 'invalid_input');
  assert.equal(inventoryValuationPreview(ctx, { asOf: 'irgendwann' }).error, 'invalid_input');
  assert.equal(inventoryValuationLayers(ctx, {}).error, 'invalid_input');
  assert.equal(assignmentCount(ctx), 0);
});
