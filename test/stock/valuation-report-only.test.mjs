/**
 * K68: D01 `stock_run_valuation` is REPORT-ONLY. J06 (`inventory_valuation_post`) is the SOLE path
 * inventory value reaches the General Ledger. These are the two reproducing tests for the confirmed
 * double-count defect and the dropped landed cost (code-f1 + code-f2); both FAIL on the pre-fix engine.
 *
 *   (1) After a J06 post has carried the full inventory value to GL 1200/4200, calling D01
 *       `stock_run_valuation` must post ZERO journal entries (so the Vorräte asset is not doubled),
 *       yet still COMPUTE and RETURN its valuation figure and record its run row.
 *   (2) `computeInventoryValue` must fold a capitalised `landed_cost` movement (qty 0, a signed
 *       `cost_amount_minor`) into the returned figure, mirroring inventory/valuation.ts `tally`, so the
 *       report-only figure no longer silently understates capitalised landed cost.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runValuation, computeInventoryValue } from '../../dist/core/stock/index.js';
import { inventoryMove, inventoryValuationCreate, inventoryValuationPost } from '../../dist/core/inventory/index.js';
import { CAPABILITY_FOR_ACTION } from '../../dist/core/access/index.js';
import { setup, counts, accountNet } from './support.mjs';

test('report-only capability: stock_run_valuation gates on read_master_data, NOT post (K68b code-f1)', () => {
  // Report-only since K68: it mints no journal entry, so requiring `post` would wrongly deny a
  // read-only actor a harmless valuation report. It must ride the SAME right as its D01 sibling
  // read `stock_valuation_report`, which reports the OP2 stock position without opening the journal.
  assert.equal(
    CAPABILITY_FOR_ACTION.stock_run_valuation,
    'read_master_data',
    'stock_run_valuation is report-only and must gate on the D01 stock read capability',
  );
  assert.notEqual(
    CAPABILITY_FOR_ACTION.stock_run_valuation,
    'post',
    'the report-only verb must no longer require the money-path post capability',
  );
  // It matches its closest sibling READ verb exactly.
  assert.equal(
    CAPABILITY_FOR_ACTION.stock_run_valuation,
    CAPABILITY_FOR_ACTION.stock_valuation_report,
    'it carries the same right as the sibling stock valuation READ',
  );
});

test('report-only: after a J06 post, stock_run_valuation posts ZERO journal entries yet still returns the computed figure (K68 code-f1)', () => {
  const t = setup();
  // 12 units at 1500 = 18'000 Rappen, written through the J02 movement ledger both engines read.
  const mv = inventoryMove(t.ctx, {
    itemId: t.itemId,
    locationId: t.locId,
    qty: 12,
    movementType: 'receipt',
    unitCostMinor: 1500,
    effectiveDate: '2026-03-02',
    idempotencyKey: 'r1',
  });
  assert.equal(mv.ok, true, JSON.stringify(mv));

  // J06 is the authoritative poster: create then post carries the full value to GL 1200 / 4200.
  const draft = inventoryValuationCreate(t.ctx, { asOf: '2026-03-31', idempotencyKey: 'c1' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const posted = inventoryValuationPost(t.ctx, { runId: draft.run.id, idempotencyKey: 'p1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(accountNet(t.store, t.workspaceId, '1200'), 18000, 'J06 posted the full inventory value to 1200');
  const entriesAfterJ06 = counts(t.store, t.workspaceId).entries;

  // D01 now runs REPORT-ONLY: it computes the same figure but writes NO journal entry, so the Vorräte
  // asset is not doubled. The pre-fix engine posted a second ~full value here (delta against its own
  // empty run table), roughly DOUBLING 1200.
  const run = runValuation(t.ctx, { method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'sv1' });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.totalValueMinor, 18000, 'D01 still COMPUTES and RETURNS the figure');
  assert.equal(run.postedEntryId, null, 'D01 mints no journal entry');
  assert.equal(counts(t.store, t.workspaceId).stockEntries, 0, 'D01 posts ZERO source=stock journal entries');
  assert.equal(counts(t.store, t.workspaceId).entries, entriesAfterJ06, 'no new journal entry of any source');
  assert.equal(accountNet(t.store, t.workspaceId, '1200'), 18000, 'the Vorräte asset is NOT doubled');
  // The run row is still recorded, so the report history survives.
  assert.equal(counts(t.store, t.workspaceId).runs, 1, 'the report run row is recorded');
});

test('report-only figure folds capitalised landed cost: a qty=0 landed_cost of 6000 raises computeInventoryValue by 6000 (K68 code-f2)', () => {
  const t = setup();
  const receipt = inventoryMove(t.ctx, {
    itemId: t.itemId,
    locationId: t.locId,
    qty: 10,
    movementType: 'receipt',
    unitCostMinor: 1000,
    effectiveDate: '2026-03-02',
    idempotencyKey: 'r1',
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const receiptId = receipt.movement.id;

  const base = computeInventoryValue(t.ctx, 'fifo', '2026-03-31');
  assert.equal(base.totalMinor, 10000, '10 units at 1000 before any landed cost');

  // A capitalised landed cost bound to the receipt (I03 seam): qty 0, signed cost_amount_minor 6000.
  const landed = inventoryMove(t.ctx, {
    itemId: t.itemId,
    locationId: t.locId,
    qty: 0,
    movementType: 'landed_cost',
    costAmountMinor: 6000,
    refMovementId: receiptId,
    effectiveDate: '2026-03-03',
    idempotencyKey: 'lc1',
  });
  assert.equal(landed.ok, true, JSON.stringify(landed));

  // FIFO and weighted-average both fold the signed lump into the item value (mirroring J03 `tally`).
  assert.equal(
    computeInventoryValue(t.ctx, 'fifo', '2026-03-31').totalMinor,
    16000,
    'the report-only FIFO figure now includes the 6000 capitalised landed cost',
  );
  assert.equal(
    computeInventoryValue(t.ctx, 'weighted_avg', '2026-03-31').totalMinor,
    16000,
    'weighted-average folds the same lump into the pool',
  );
});
