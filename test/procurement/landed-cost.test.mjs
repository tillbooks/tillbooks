// I03, landed cost allocation: the money-path invariants, each asserted on real ROW COUNTS, summed
// quantities and the J03 valuation figure rather than on a returned `ok:true`. Every assertion here
// is written to BITE: break the guarded line it names and this suite goes red.
//
//   (a) THE SEAM WORKS END TO END: allocate_confirm posts ONE balanced A02 entry (Dr inventory,
//       Cr clearing) AND the J03 valuation of the affected item rises by EXACTLY the allocated cost,
//       while on-hand SUM(qty) is unchanged (the landed_cost movement carries qty 0).
//   (b) IDEMPOTENT ON ROWS: a replayed confirm writes no second movement and no second journal; a
//       second confirm under a DIFFERENT key is refused by the status machine.
//   (c) APPEND-ONLY: the confirm's landed_cost movement is immutable (the J02 trigger aborts UPDATE).
//   (d) REVERSE NETS FLAT: reverse writes negated-cost movements + a reversing entry, and both the
//       J03 valuation and the GL return to exactly their pre-allocation figures.
//   (e) §H-PERIOD: a confirm whose effective date is in a locked period is refused, nothing written.
//   (f) §H-TENANT: workspace B cannot confirm, reverse, read or allocate A's voucher.
//   (g) POST ONLY THROUGH A02, MOVEMENTS ONLY THROUGH J02: exactly one journal_entry and N
//       landed_cost stock_movement rows per confirm, and the pure allocator is residual-free.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem, createContact } from '../../dist/core/sales/index.js';
import { poUpsert, poSend } from '../../dist/core/purchase/purchaseOrders.js';
import { makePeriodPort, lockPeriod } from '../../dist/core/ledger/index.js';
import { inventoryEnsureDefaultLocation } from '../../dist/core/inventory/index.js';
import {
  inventoryValuationPreview,
  inventoryMove,
  inventoryValuationMethodSetEnabled,
  inventoryValuationSetItemMethod,
} from '../../dist/core/inventory/index.js';
import {
  goodsReceiptCreate,
  goodsReceiptUpsertLines,
  goodsReceiptPost,
  goodsReceiptGet,
  landedCostVoucherCreate,
  landedCostAllocatePreview,
  landedCostAllocateConfirm,
  landedCostReverse,
  landedCostList,
  landedCostGet,
  allocateLandedCost,
} from '../../dist/core/procurement/index.js';

const AT = '2026-08-11T00:00:00.000Z';
const RECEIVED_AT = '2026-03-04';
const ACC_INVENTORY = '1200';
const ACC_CLEARING = '2300';
const ACC_VARIANCE = '4200';

function must(result, label) {
  assert.equal(result.ok, true, `${label} should succeed: ${JSON.stringify(result)}`);
  return result;
}

function freshCtx(at = AT) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    periods: makePeriodPort({ store, workspaceId }),
  });
  return { ctx, store, workspaceId, deps, clock, ids };
}

const accId = (ctx, number) =>
  ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number).id;

/** A posted goods receipt for `qty` units at `unitPriceRappen`. Returns { itemId, grLineId, movementId, locationId }. */
function postedReceipt(ctx, { qty = 10, unitPriceRappen = 10000, seed = 'p' } = {}) {
  const vendorId = must(createContact(ctx, { partyRole: 'vendor', name: 'Lieferant', idempotencyKey: `${seed}-v` }), 'contact').contact.id;
  const itemId = must(createItem(ctx, { name: `Ware ${seed}`, defaultUnitPriceMinor: 12000, trackStock: true, idempotencyKey: `${seed}-i` }), 'item').item.id;
  const locationId = must(inventoryEnsureDefaultLocation(ctx), 'loc').location.id;
  const po = must(poUpsert(ctx, { supplierContactId: vendorId, lines: [{ itemId, qty, unitPriceRappen }], idempotencyKey: `${seed}-po` }), 'po');
  must(poSend(ctx, { poId: po.poId, idempotencyKey: `${seed}-send` }), 'send');
  const poLineId = ctx.store.db.prepare('SELECT id FROM po_line WHERE workspace_id = ? AND po_id = ?').get(ctx.workspaceId, po.poId).id;
  const gr = must(goodsReceiptCreate(ctx, { poId: po.poId, receivedAt: RECEIVED_AT, defaultLocationId: locationId, idempotencyKey: `${seed}-gr` }), 'gr').goodsReceipt;
  must(goodsReceiptUpsertLines(ctx, { grId: gr.id, ops: [{ op: 'add', poLineId, qty }], idempotencyKey: `${seed}-ln` }), 'ln');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: `${seed}-post` }), 'post');
  const line = must(goodsReceiptGet(ctx, { grId: gr.id }), 'get').goodsReceipt.lines[0];
  return { itemId, grLineId: line.id, movementId: line.movementId, locationId };
}

function draftVoucher(ctx, gr, { seed = 'p', freight = 45000, method = 'by_value' } = {}) {
  return must(
    landedCostVoucherCreate(ctx, {
      costLines: [{ componentType: 'freight', amountMinor: freight, description: 'Seefracht' }],
      targetGrLineIds: [gr.grLineId],
      inventoryAccountId: accId(ctx, ACC_INVENTORY),
      clearingAccountId: accId(ctx, ACC_CLEARING),
      allocationMethod: method,
      idempotencyKey: `${seed}-v`,
    }),
    'voucher_create',
  ).voucher;
}

const onHand = (ctx, itemId) =>
  ctx.store.db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM stock_movement WHERE workspace_id = ? AND item_id = ?').get(ctx.workspaceId, itemId).n;

const itemValue = (ctx, itemId) => {
  const r = must(inventoryValuationPreview(ctx, { itemIds: [itemId] }), 'valuation');
  return r.items[0].totalValueMinor;
};

const count = (ctx, table, where = '1=1', ...params) =>
  ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND ${where}`).get(ctx.workspaceId, ...params).n;

const landedMovements = (ctx, voucherId) =>
  ctx.store.db
    .prepare(`SELECT id, qty, cost_amount_minor, ref_movement_id, movement_type FROM stock_movement WHERE workspace_id = ? AND ref_id = ? AND movement_type = 'landed_cost' ORDER BY id`)
    .all(ctx.workspaceId, voucherId);

// --- (a) the seam works end to end -------------------------------------------------------------

test('I03 (a): confirm lifts J03 valuation by EXACTLY the allocated cost, on-hand unchanged', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 10, unitPriceRappen: 10000 });
  const before = itemValue(ctx, gr.itemId);
  assert.equal(before, 100000, 'weighted-average value before landed cost is 10 x 100.00');
  assert.equal(onHand(ctx, gr.itemId), 10);

  const v = draftVoucher(ctx, gr);
  const confirmed = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-1' }), 'confirm');
  assert.equal(confirmed.voucher.status, 'allocated');

  // The J03 figure rose by exactly the freight. If `tally` stopped folding cost_amount into the
  // pool (valuation.ts), this equality breaks.
  assert.equal(itemValue(ctx, gr.itemId), 145000, 'value rose by exactly the 450.00 freight');
  // On-hand is untouched: the landed_cost movement carries qty 0. If movement.ts admitted a non-zero
  // qty for the cost-only type, this would move.
  assert.equal(onHand(ctx, gr.itemId), 10, 'on-hand SUM(qty) is unchanged by a landed_cost movement');

  // ONE balanced A02 entry, Dr inventory 1200 / Cr clearing 2300, for exactly the total.
  const entryId = confirmed.journalEntryId;
  const lines = ctx.store.db.prepare('SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ?').all(entryId);
  const dr = lines.reduce((s, l) => s + l.debit_minor, 0);
  const cr = lines.reduce((s, l) => s + l.credit_minor, 0);
  assert.equal(dr, cr, 'the entry balances');
  assert.equal(dr, 45000, 'debit total equals the allocated cost');
  const invLine = lines.find((l) => l.account_id === accId(ctx, ACC_INVENTORY));
  const clrLine = lines.find((l) => l.account_id === accId(ctx, ACC_CLEARING));
  assert.equal(invLine.debit_minor, 45000, 'Dr inventory control');
  assert.equal(clrLine.credit_minor, 45000, 'Cr landed-cost clearing');

  // Exactly ONE landed_cost movement, qty 0, cost 45000, bound to the receipt movement.
  const mv = landedMovements(ctx, v.id);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].qty, 0);
  assert.equal(mv[0].cost_amount_minor, 45000);
  assert.equal(mv[0].ref_movement_id, gr.movementId, 'the cost is bound to the receipt movement');
});

// --- (b) idempotent on rows --------------------------------------------------------------------

test('I03 (b): a replayed confirm writes no second movement and no second journal', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx);
  const v = draftVoucher(ctx, gr);
  must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-1' }), 'confirm-1');

  const movesAfterFirst = count(ctx, 'stock_movement', "movement_type = 'landed_cost'");
  const journalsAfterFirst = count(ctx, 'journal_entry', "source = 'landed_cost'");
  assert.equal(movesAfterFirst, 1);
  assert.equal(journalsAfterFirst, 1);

  // Same key: returns the stored result, writes nothing. runTx/rememberIdempotent is the guard.
  const replay = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-1' }), 'replay');
  assert.equal(replay.voucher.status, 'allocated');
  assert.equal(count(ctx, 'stock_movement', "movement_type = 'landed_cost'"), 1, 'no second movement');
  assert.equal(count(ctx, 'journal_entry', "source = 'landed_cost'"), 1, 'no second journal');

  // A DIFFERENT key is refused by the status machine (already allocated).
  const second = landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-2' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'invalid_transition');
  assert.equal(count(ctx, 'stock_movement', "movement_type = 'landed_cost'"), 1, 'still no second movement');
});

// --- (c) append-only ---------------------------------------------------------------------------

test('I03 (c): the landed_cost movement is immutable (J02 trigger aborts UPDATE)', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx);
  const v = draftVoucher(ctx, gr);
  must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-1' }), 'confirm');
  const mv = landedMovements(ctx, v.id)[0];
  assert.throws(
    () => ctx.store.db.prepare('UPDATE stock_movement SET cost_amount_minor = 1 WHERE id = ?').run(mv.id),
    /stock_movement_immutable/,
    'a landed_cost movement is append-only like every other',
  );
});

// --- (d) reverse nets flat ---------------------------------------------------------------------

test('I03 (d): reverse returns J03 valuation AND the GL to their pre-allocation figures', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx);
  const v = draftVoucher(ctx, gr);
  must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-1' }), 'confirm');
  assert.equal(itemValue(ctx, gr.itemId), 145000);

  const rev = must(landedCostReverse(ctx, { voucherId: v.id, reason: 'Falsche Zuordnung', idempotencyKey: 'rev-1' }), 'reverse');
  assert.equal(rev.voucher.status, 'reversed');

  // J03 value is back to the base: the negated landed_cost movement nets the layer's landed cost to 0.
  assert.equal(itemValue(ctx, gr.itemId), 100000, 'valuation flat after reverse');
  // The GL nets flat: every posting on the two accounts sums to zero.
  const net = (number) =>
    ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor),0) AS n FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id
          WHERE e.workspace_id = ? AND l.account_id = ?`,
      )
      .get(ctx.workspaceId, accId(ctx, number)).n;
  assert.equal(net(ACC_INVENTORY), 0, 'inventory control nets flat');
  assert.equal(net(ACC_CLEARING), 0, 'clearing nets flat');

  // A reversing movement exists per target, linked on the target row; two landed_cost movements now.
  assert.equal(count(ctx, 'stock_movement', "movement_type = 'landed_cost'"), 2, 'forward + reverse movement');
  const target = must(landedCostGet(ctx, { voucherId: v.id }), 'get').voucher.targets[0];
  assert.ok(target.reversalMovementId, 'the target records its reversing movement');

  // Idempotent: a replayed reverse writes nothing further.
  must(landedCostReverse(ctx, { voucherId: v.id, reason: 'Falsche Zuordnung', idempotencyKey: 'rev-1' }), 'reverse-replay');
  assert.equal(count(ctx, 'stock_movement', "movement_type = 'landed_cost'"), 2, 'no third movement');
});

// --- (e) §H-PERIOD -----------------------------------------------------------------------------

test('I03 (e): a confirm whose effective date is in a locked period is refused, nothing written', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx);
  const v = draftVoucher(ctx, gr);
  // The voucher's effective date defaults to the clock (2026-08), which is the month the confirm
  // posts into. Lock THAT month: a confirm into a sealed valuation period must be refused.
  must(lockPeriod(ctx, { period: '2026-08', kind: 'soft', idempotencyKey: 'lock-aug' }), 'lock');

  const blocked = landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'conf-1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'period_locked');
  assert.equal(count(ctx, 'stock_movement', "movement_type = 'landed_cost'"), 0, 'no movement written');
  assert.equal(count(ctx, 'journal_entry', "source = 'landed_cost'"), 0, 'no journal written');
});

// --- (f) §H-TENANT -----------------------------------------------------------------------------

test('I03 (f): workspace B cannot confirm, reverse, read or allocate A workspace A voucher', () => {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'A AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'B AG' }).workspaceId;
  const ctxA = makeContext(store, { workspaceId: wsA, actor: 'a', clock, ids, periods: makePeriodPort({ store, workspaceId: wsA }) });
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'b', clock, ids, periods: makePeriodPort({ store, workspaceId: wsB }) });

  const gr = postedReceipt(ctxA, { seed: 'a' });
  const v = draftVoucher(ctxA, gr, { seed: 'a' });

  // B probes with A's REAL voucher id: every verb answers not_found, never cross-tenant data.
  assert.equal(landedCostGet(ctxB, { voucherId: v.id }).error, 'not_found');
  assert.equal(landedCostAllocatePreview(ctxB, { voucherId: v.id }).error, 'not_found');
  assert.equal(landedCostAllocateConfirm(ctxB, { voucherId: v.id, idempotencyKey: 'b-conf' }).error, 'not_found');
  assert.equal(landedCostReverse(ctxB, { voucherId: v.id, reason: 'x', idempotencyKey: 'b-rev' }).error, 'not_found');
  // And B's list never shows A's voucher.
  assert.equal(must(landedCostList(ctxB, {}), 'listB').total, 0);
  // A confirm was NOT written by B's failed attempt.
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM stock_movement WHERE movement_type = 'landed_cost'").get().n,
    0,
    'B wrote no movement',
  );
});

// --- (g) the pure allocator: residual-free over every method -----------------------------------

test('I03 (g): the pure allocator splits exactly (residual 0) across value/qty/equal', () => {
  const targets = [
    { id: 't1', itemId: 'i1', originalMovementId: 'm1', baseValueMinor: 250000, baseQty: 200 },
    { id: 't2', itemId: 'i2', originalMovementId: 'm2', baseValueMinor: 80000, baseQty: 100 },
  ];
  for (const method of ['by_value', 'by_qty', 'equal']) {
    const preview = allocateLandedCost({ totalCostMinor: 45000, method }, targets);
    assert.ok(!('error' in preview), `${method} allocates`);
    const sum = preview.lines.reduce((s, l) => s + l.allocatedMinor, 0);
    assert.equal(sum, 45000, `${method}: Σ allocated equals the total`);
    assert.equal(preview.residualMinor, 0, `${method}: residual is 0`);
  }

  // by_value split of 45000 across weights 250000 : 80000. The exact share is 250000/330000 =
  // 75.76%, so 45000 splits [34091, 10909] (largest-remainder gives the stray Rappen to t1). NOTE:
  // the spec §2 example claims 71.43% / 28.57% here, which is 250000/350000, inconsistent with the
  // 80000 base it also states (that would need a 100000 base). The arithmetic below is the correct
  // one; the spec's worked figure is an internal inconsistency reported to the owner.
  const byValue = allocateLandedCost({ totalCostMinor: 45000, method: 'by_value' }, targets);
  assert.deepEqual(byValue.lines.map((l) => l.allocatedMinor), [34091, 10909]);
  assert.equal(byValue.lines.reduce((s, l) => s + l.allocatedMinor, 0), 45000);

  // manual shares must sum to 1, and residual is forced onto the last line.
  const manual = allocateLandedCost({ totalCostMinor: 100, method: 'manual', manualShares: { t1: 1 / 3, t2: 2 / 3 } }, targets);
  assert.ok(!('error' in manual));
  assert.equal(manual.lines.reduce((s, l) => s + l.allocatedMinor, 0), 100, 'manual residual-free');

  const bad = allocateLandedCost({ totalCostMinor: 100, method: 'manual', manualShares: { t1: 0.3, t2: 0.3 } }, targets);
  assert.ok('error' in bad, 'manual shares that do not sum to 1 are refused');
});

// --- (h) THE MONEY-PATH SPLIT (the reason this critic FAILed) ----------------------------------
// J03 only capitalises what stays on the balance sheet: the on-hand share for weighted-average and
// FIFO, and ZERO for a standard-cost item. Before this fix, confirm debited the WHOLE allocated cost
// to inventory control regardless, so the GL inventory-control account diverged from the sub-ledger
// (OP11 break, OR 960 overstatement). Every test below asserts the OP11 identity explicitly:
//   GL inventory-control delta  ==  J03 valuation delta.

const journalLines = (ctx, entryId) =>
  ctx.store.db.prepare('SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ?').all(entryId);
const debitOn = (lines, accountId) => lines.filter((l) => l.account_id === accountId).reduce((s, l) => s + l.debit_minor, 0);
const creditOn = (lines, accountId) => lines.filter((l) => l.account_id === accountId).reduce((s, l) => s + l.credit_minor, 0);

function issueUnits(ctx, gr, qty, seed) {
  return must(
    inventoryMove(ctx, {
      itemId: gr.itemId,
      locationId: gr.locationId,
      qty: -qty,
      movementType: 'issue',
      effectiveDate: '2026-03-05',
      idempotencyKey: `${seed}-iss`,
    }),
    'issue',
  );
}

function draftVoucherV(ctx, gr, { seed = 'p', freight = 10000, method = 'by_value', variancePolicy, withVarianceAccount = true } = {}) {
  const input = {
    costLines: [{ componentType: 'freight', amountMinor: freight, description: 'Seefracht' }],
    targetGrLineIds: [gr.grLineId],
    inventoryAccountId: accId(ctx, ACC_INVENTORY),
    clearingAccountId: accId(ctx, ACC_CLEARING),
    allocationMethod: method,
    idempotencyKey: `${seed}-v`,
  };
  if (withVarianceAccount) input.varianceAccountId = accId(ctx, ACC_VARIANCE);
  if (variancePolicy !== undefined) input.variancePolicy = variancePolicy;
  return must(landedCostVoucherCreate(ctx, input), 'voucher_create').voucher;
}

function makeItemFifo(ctx, gr, seed) {
  must(inventoryValuationMethodSetEnabled(ctx, { method: 'fifo', enabled: true, idempotencyKey: `${seed}-en` }), 'enable fifo');
  must(
    inventoryValuationSetItemMethod(ctx, {
      itemId: gr.itemId,
      method: 'fifo',
      effectiveFrom: '2026-01-01',
      forceRevaluation: true,
      reason: 'test fixture',
      idempotencyKey: `${seed}-m`,
    }),
    'set fifo',
  );
}

test('I03 (h): partial-issue WEIGHTED-AVERAGE capitalises only the on-hand share, the rest to variance', () => {
  const { ctx } = freshCtx();
  // Receipt 100 @ 10.00; issue 50 before the voucher is confirmed. On-hand 50, value 500.00.
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000 });
  issueUnits(ctx, gr, 50, 'wa');
  const before = itemValue(ctx, gr.itemId);
  assert.equal(before, 50000, 'on-hand 50 @ 10.00 = 500.00 before landed cost');

  const v = draftVoucherV(ctx, gr, { seed: 'wa', freight: 10000 });
  const confirmed = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'wa-c' }), 'confirm');

  // J03 lifts value by only the on-hand share: 100.00 freight x 50/100 = 50.00.
  const after = itemValue(ctx, gr.itemId);
  const valuationDelta = after - before;
  assert.equal(valuationDelta, 5000, 'weighted-average carries only remaining/original of the freight');

  const lines = journalLines(ctx, confirmed.journalEntryId);
  const invDelta = debitOn(lines, accId(ctx, ACC_INVENTORY)) - creditOn(lines, accId(ctx, ACC_INVENTORY));
  // THE OP11 IDENTITY. If the split regresses (whole cost to inventory), invDelta becomes 10000 and
  // this bites.
  assert.equal(invDelta, valuationDelta, 'GL inventory-control delta == J03 valuation delta (OP11)');
  assert.equal(invDelta, 5000, 'Dr inventory control is exactly the capitalizable share');
  assert.equal(debitOn(lines, accId(ctx, ACC_VARIANCE)), 5000, 'the already-issued units go to the variance account');
  assert.equal(creditOn(lines, accId(ctx, ACC_CLEARING)), 10000, 'Cr clearing is the whole voucher total');
  assert.equal(debitOn(lines, accId(ctx, ACC_INVENTORY)) + debitOn(lines, accId(ctx, ACC_VARIANCE)), 10000, 'the split sums to the total');
  assert.equal(confirmed.voucher.capitalizedMinor, 5000);
  assert.equal(confirmed.voucher.varianceMinor, 5000);
});

test('I03 (i): partial-issue FIFO capitalises only the on-hand layer share, the rest to variance', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'ff' });
  makeItemFifo(ctx, gr, 'ff');
  issueUnits(ctx, gr, 50, 'ff');
  const before = itemValue(ctx, gr.itemId);
  assert.equal(before, 50000, 'FIFO: one layer, 50 of 100 remain @ 10.00 = 500.00');

  const v = draftVoucherV(ctx, gr, { seed: 'ff', freight: 10000 });
  const confirmed = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'ff-c' }), 'confirm');

  const after = itemValue(ctx, gr.itemId);
  const valuationDelta = after - before;
  assert.equal(valuationDelta, 5000, 'FIFO landedForLayers scales the freight by remaining/original');

  const lines = journalLines(ctx, confirmed.journalEntryId);
  const invDelta = debitOn(lines, accId(ctx, ACC_INVENTORY)) - creditOn(lines, accId(ctx, ACC_INVENTORY));
  assert.equal(invDelta, valuationDelta, 'GL inventory-control delta == J03 valuation delta (OP11)');
  assert.equal(invDelta, 5000, 'Dr inventory control is exactly the layer-carried share');
  assert.equal(debitOn(lines, accId(ctx, ACC_VARIANCE)), 5000, 'the consumed layer share goes to variance (it left with the goods)');
  assert.equal(creditOn(lines, accId(ctx, ACC_CLEARING)), 10000);
});

test('I03 (j): a STANDARD-COST item capitalises ZERO, the whole landed cost is variance', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'sc' });
  must(inventoryValuationMethodSetEnabled(ctx, { method: 'standard_cost', enabled: true, idempotencyKey: 'sc-en' }), 'enable std');
  must(
    inventoryValuationSetItemMethod(ctx, {
      itemId: gr.itemId,
      method: 'standard_cost',
      standardCostMinor: 1000,
      effectiveFrom: '2026-01-01',
      forceRevaluation: true,
      reason: 'test fixture',
      idempotencyKey: 'sc-m',
    }),
    'set std',
  );
  const before = itemValue(ctx, gr.itemId);
  assert.equal(before, 100000, 'standard cost: 100 @ std 10.00 = 1000.00');

  const v = draftVoucherV(ctx, gr, { seed: 'sc', freight: 10000 });
  const confirmed = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'sc-c' }), 'confirm');

  const after = itemValue(ctx, gr.itemId);
  const valuationDelta = after - before;
  // Standard cost never moves inventory on a landed cost: it is purchase-price variance.
  assert.equal(valuationDelta, 0, 'standard-cost inventory value is unchanged by landed cost');

  const lines = journalLines(ctx, confirmed.journalEntryId);
  const invDelta = debitOn(lines, accId(ctx, ACC_INVENTORY)) - creditOn(lines, accId(ctx, ACC_INVENTORY));
  assert.equal(invDelta, valuationDelta, 'GL inventory-control delta == 0 == J03 valuation delta (OP11)');
  assert.equal(invDelta, 0, 'NOTHING is debited to inventory control for a standard-cost item');
  assert.equal(lines.some((l) => l.account_id === accId(ctx, ACC_INVENTORY)), false, 'no inventory-control line at all');
  assert.equal(debitOn(lines, accId(ctx, ACC_VARIANCE)), 10000, 'the WHOLE landed cost is purchase-price variance');
  assert.equal(creditOn(lines, accId(ctx, ACC_CLEARING)), 10000);
  assert.equal(confirmed.voucher.capitalizedMinor, 0);
  assert.equal(confirmed.voucher.varianceMinor, 10000);
});

test('I03 (k): reverse mirrors the split and nets inventory value AND the GL flat', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'rv' });
  issueUnits(ctx, gr, 50, 'rv');
  const before = itemValue(ctx, gr.itemId);

  const v = draftVoucherV(ctx, gr, { seed: 'rv', freight: 10000 });
  const confirmed = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'rv-c' }), 'confirm');
  assert.equal(itemValue(ctx, gr.itemId), before + 5000, 'value rose by the capitalizable share');

  const reversed = must(landedCostReverse(ctx, { voucherId: v.id, reason: 'wrong voucher', idempotencyKey: 'rv-r' }), 'reverse');
  assert.equal(reversed.voucher.status, 'reversed');
  // Sub-ledger nets back to exactly the pre-allocation value.
  assert.equal(itemValue(ctx, gr.itemId), before, 'J03 value returns to the pre-allocation figure');

  // GL nets flat on EVERY account touched by the pair (confirm + reverse), including the variance one.
  for (const acc of [ACC_INVENTORY, ACC_VARIANCE, ACC_CLEARING]) {
    const id = accId(ctx, acc);
    const net =
      debitOn(journalLines(ctx, confirmed.journalEntryId), id) - creditOn(journalLines(ctx, confirmed.journalEntryId), id) +
      debitOn(journalLines(ctx, reversed.reverseJournalEntryId), id) - creditOn(journalLines(ctx, reversed.reverseJournalEntryId), id);
    assert.equal(net, 0, `${acc}: confirm + reverse net to zero`);
  }
});

test('I03 (k2): reverse of a STANDARD-COST allocation (no inventory line) also nets flat', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'r2' });
  must(inventoryValuationMethodSetEnabled(ctx, { method: 'standard_cost', enabled: true, idempotencyKey: 'r2-en' }), 'enable std');
  must(
    inventoryValuationSetItemMethod(ctx, {
      itemId: gr.itemId,
      method: 'standard_cost',
      standardCostMinor: 1000,
      effectiveFrom: '2026-01-01',
      forceRevaluation: true,
      reason: 'test fixture',
      idempotencyKey: 'r2-m',
    }),
    'set std',
  );
  const before = itemValue(ctx, gr.itemId);

  const v = draftVoucherV(ctx, gr, { seed: 'r2', freight: 10000 });
  const confirmed = must(landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'r2-c' }), 'confirm');
  const reversed = must(landedCostReverse(ctx, { voucherId: v.id, reason: 'undo', idempotencyKey: 'r2-r' }), 'reverse');
  assert.equal(itemValue(ctx, gr.itemId), before, 'standard-cost value unchanged across confirm+reverse');
  for (const acc of [ACC_VARIANCE, ACC_CLEARING]) {
    const id = accId(ctx, acc);
    const net =
      debitOn(journalLines(ctx, confirmed.journalEntryId), id) - creditOn(journalLines(ctx, confirmed.journalEntryId), id) +
      debitOn(journalLines(ctx, reversed.reverseJournalEntryId), id) - creditOn(journalLines(ctx, reversed.reverseJournalEntryId), id);
    assert.equal(net, 0, `${acc}: confirm + reverse net to zero`);
  }
});

test('I03 (l): variance policy STRICT refuses a confirm that would leave a remainder', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'st' });
  issueUnits(ctx, gr, 50, 'st');
  const v = draftVoucherV(ctx, gr, { seed: 'st', freight: 10000, variancePolicy: 'strict' });
  const refused = landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'st-c' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'landed_cost_variance_not_permitted', 'strict refuses rather than expensing');
  // Nothing was written: no movement, no journal, still draft.
  assert.equal(count(ctx, 'stock_movement', "movement_type = 'landed_cost'"), 0, 'strict refusal writes no cost movement');
  assert.equal(count(ctx, 'journal_entry', "source = 'landed_cost'"), 0, 'strict refusal posts no journal');
  assert.equal(must(landedCostGet(ctx, { voucherId: v.id }), 'get').voucher.status, 'draft');
});

test('I03 (m): expense_excess with NO variance account configured is refused when a remainder arises', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'na' });
  issueUnits(ctx, gr, 50, 'na');
  const v = draftVoucherV(ctx, gr, { seed: 'na', freight: 10000, withVarianceAccount: false });
  const refused = landedCostAllocateConfirm(ctx, { voucherId: v.id, idempotencyKey: 'na-c' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'variance_account_required');
  // A full-on-hand voucher (no remainder) still confirms without a variance account.
  const gr2 = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'nb' });
  const v2 = draftVoucherV(ctx, gr2, { seed: 'nb', freight: 10000, withVarianceAccount: false });
  const okConfirm = must(landedCostAllocateConfirm(ctx, { voucherId: v2.id, idempotencyKey: 'nb-c' }), 'full on-hand confirm');
  assert.equal(okConfirm.voucher.capitalizedMinor, 10000, 'whole cost capitalised when nothing was issued');
  assert.equal(okConfirm.voucher.varianceMinor, 0);
});

test('I03 (n): absorb_remaining is refused at CREATE (needs a J03 change out of scope)', () => {
  const { ctx } = freshCtx();
  const gr = postedReceipt(ctx, { qty: 100, unitPriceRappen: 1000, seed: 'ab' });
  const refused = landedCostVoucherCreate(ctx, {
    costLines: [{ componentType: 'freight', amountMinor: 10000 }],
    targetGrLineIds: [gr.grLineId],
    inventoryAccountId: accId(ctx, ACC_INVENTORY),
    clearingAccountId: accId(ctx, ACC_CLEARING),
    variancePolicy: 'absorb_remaining',
    idempotencyKey: 'ab-v',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'invalid_input');
});
