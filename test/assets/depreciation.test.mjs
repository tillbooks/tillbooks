// H03, the depreciation engine: the money-path invariants a NON-AUTHOR critic mutation-tests, plus
// the golden fixtures the spec (§2/§8) names by their exact Rappen amounts.
//
// The engine POSTS NOTHING (H04 posts), but it is money-path because H04 books exactly the amounts
// `calculateDepreciation` returns. The load-bearing invariants, each asserted so it BITES:
//
//   1. SUM-TO-DEPRECIABLE-BASE. Over a full life a straight-line schedule sums to EXACTLY
//      (cost - residual), to the Rappen, and the final period residual-adjusts. A calculator that
//      dropped or double-counted the rounding tail fails this. Proven on a deliberately NON-divisible
//      base so the tail is real, not zero.
//   2. RESIDUAL FLOOR. projected NBV is never driven below residual, across methods and random bases.
//   3. RAPPEN ROUNDING. amounts are integer Rappen, commercial (half away from zero), rounded once.
//   4. §H-TENANT. a foreign-workspace asset id is rejected (not_found) BEFORE any number is computed.
//   5. PURITY. identical inputs give identical outputs and the pure calculators write no database.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createAssetCategory } from '../../dist/core/assets/index.js';
import {
  calculateDepreciation,
  calculateDepreciationBatch,
  projectDepreciationSchedule,
  listDepreciationMethods,
  setMethodEnabled,
  previewDepreciation,
  scheduleDepreciation,
  nextPeriod,
} from '../../dist/core/assets/index.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-08-07T00:00:00.000Z';

/** A pure snapshot, cost/residual/life overridable, straight_line by default, freshly acquired. */
function snap(over = {}) {
  const cost = over.acquisitionCostRappen ?? 1_250_000;
  const residual = over.residualValueRappen ?? 125_000;
  return {
    id: 'as_1',
    workspaceId: 'ws_1',
    status: 'active',
    acquisitionDate: '2026-01-15',
    acquisitionCostRappen: cost,
    residualValueRappen: residual,
    usefulLifeMonths: 60,
    depreciationMethod: 'straight_line',
    decliningRateBp: null,
    totalEstimatedUnits: null,
    accumulatedDeprRappen: 0,
    netBookValueRappen: cost,
    lastDepreciationPeriod: null,
    ...over,
  };
}

// --- 1. Golden: straight-line first period (§2 US-H03.1) -------------------------------------------

test('straight_line: the spec golden amount is exact', () => {
  const r = calculateDepreciation(snap(), { period: '2026-07' });
  assert.equal(r.amountRappen, 18_750); // (1_250_000 - 125_000) / 60
  assert.equal(r.isFinal, false);
  assert.equal(r.remainingLifeMonths, 59);
  assert.equal(r.projectedNbvAfterRappen, 1_250_000 - 18_750);
});

test('straight_line: the final period lands NBV exactly on residual and is flagged final', () => {
  // 59 periods already posted at 18_750 each.
  const accum = 59 * 18_750;
  const a = snap({ accumulatedDeprRappen: accum, netBookValueRappen: 1_250_000 - accum, lastDepreciationPeriod: '2026-06' });
  const r = calculateDepreciation(a, { period: '2026-07' });
  assert.equal(r.isFinal, true);
  assert.equal(r.projectedNbvAfterRappen, 125_000); // exactly residual
  assert.equal(r.amountRappen, 18_750);
});

// --- 2. THE money-path invariant: sum-to-depreciable-base over a full life (BITES) -----------------

function runFullLife(a, opts = {}) {
  let period = opts.from ?? '2026-01';
  let rolling = { ...a };
  let sum = 0;
  let lines = 0;
  let sawFinal = false;
  for (let i = 0; i < 400; i += 1) {
    const r = calculateDepreciation(rolling, { period });
    if (r.amountRappen === 0 && (r.reason === 'already_at_residual' || r.reason === 'non_depreciable')) break;
    sum += r.amountRappen;
    lines += 1;
    rolling = {
      ...rolling,
      accumulatedDeprRappen: rolling.accumulatedDeprRappen + r.amountRappen,
      netBookValueRappen: r.projectedNbvAfterRappen,
      lastDepreciationPeriod: period,
    };
    if (r.isFinal) {
      sawFinal = true;
      break;
    }
    period = nextPeriod(period);
  }
  return { sum, lines, sawFinal, endNbv: rolling.netBookValueRappen };
}

test('INVARIANT: a full straight-line life sums to EXACTLY (cost - residual), divisible base', () => {
  const a = snap(); // 1_125_000 depreciable over 60 => 18_750 flat
  const out = runFullLife(a);
  assert.equal(out.sum, 1_125_000);
  assert.equal(out.lines, 60);
  assert.equal(out.sawFinal, true);
  assert.equal(out.endNbv, 125_000);
});

test('INVARIANT: a full straight-line life sums to EXACTLY (cost - residual), NON-divisible base', () => {
  // 1_000_000 / 7 = 142857.14..., a real rounding tail. The nominal 7th month absorbs it.
  const a = snap({ acquisitionCostRappen: 1_000_000, residualValueRappen: 0, usefulLifeMonths: 7, netBookValueRappen: 1_000_000 });
  const out = runFullLife(a);
  assert.equal(out.sum, 1_000_000, 'the tail Rappen must not be lost or duplicated');
  assert.equal(out.lines, 7, 'a 7-month asset finishes in exactly 7 months');
  assert.equal(out.sawFinal, true);
  assert.equal(out.endNbv, 0);
});

test('INVARIANT: sum-to-base holds for a swept range of non-divisible lives and residuals', () => {
  for (const cost of [1_000_000, 999_997, 1_234_567, 7_777_777]) {
    for (const life of [3, 7, 11, 13, 24, 37]) {
      for (const residual of [0, 1, 333, 100_000]) {
        if (residual >= cost) continue;
        const a = snap({ acquisitionCostRappen: cost, residualValueRappen: residual, usefulLifeMonths: life, netBookValueRappen: cost, accumulatedDeprRappen: 0 });
        const out = runFullLife(a);
        assert.equal(out.sum, cost - residual, `sum mismatch for cost=${cost} life=${life} residual=${residual}`);
        assert.equal(out.endNbv, residual, `NBV must land on residual for cost=${cost} life=${life} residual=${residual}`);
        assert.equal(out.lines, life, `must finish in exactly ${life} months (cost=${cost} residual=${residual})`);
      }
    }
  }
});

// --- 3. Rappen rounding: integer, half away from zero, once ----------------------------------------

test('straight_line amounts are always integer Rappen', () => {
  const a = snap({ acquisitionCostRappen: 1_000_000, residualValueRappen: 0, usefulLifeMonths: 7, netBookValueRappen: 1_000_000 });
  const r = calculateDepreciation(a, { period: '2026-07' });
  assert.ok(Number.isInteger(r.amountRappen));
  assert.equal(r.amountRappen, 142_857); // round(142857.14) half-away
});

test('half-away rounding rounds .5 up in magnitude', () => {
  // depreciable=5, life=2 => 2.5 => 3 (half away from zero)
  const a = snap({ acquisitionCostRappen: 5, residualValueRappen: 0, usefulLifeMonths: 2, netBookValueRappen: 5 });
  const r = calculateDepreciation(a, { period: '2026-07' });
  assert.equal(r.amountRappen, 3);
});

// --- 4. Declining balance golden (§2 US-H03.2) -----------------------------------------------------

test('declining_balance: the spec golden amount and residual clamp', () => {
  const a = snap({ depreciationMethod: 'declining_balance', decliningRateBp: 2000, netBookValueRappen: 800_000, residualValueRappen: 100_000, acquisitionCostRappen: 1_000_000 });
  const r = calculateDepreciation(a, { period: '2026-07' });
  assert.equal(r.amountRappen, 13_333); // round(800000 * 0.20 / 12) = round(13333.33)
  assert.equal(r.isFinal, false);
});

test('declining_balance: clamps to (nbv - residual) and marks final when it would undershoot', () => {
  const a = snap({ depreciationMethod: 'declining_balance', decliningRateBp: 2000, netBookValueRappen: 101_000, residualValueRappen: 100_000, acquisitionCostRappen: 1_000_000 });
  const r = calculateDepreciation(a, { period: '2026-07' });
  assert.equal(r.amountRappen, 1_000); // raw would be 1683, clamped to remaining 1000
  assert.equal(r.projectedNbvAfterRappen, 100_000);
  assert.equal(r.isFinal, true);
});

test('declining_balance never drives NBV below residual across many periods', () => {
  let a = snap({ depreciationMethod: 'declining_balance', decliningRateBp: 3000, netBookValueRappen: 1_000_000, residualValueRappen: 50_000, acquisitionCostRappen: 1_000_000 });
  let period = '2026-01';
  for (let i = 0; i < 240; i += 1) {
    const r = calculateDepreciation(a, { period });
    assert.ok(r.projectedNbvAfterRappen >= 50_000, `residual floor breached at period ${period}`);
    assert.ok(r.amountRappen >= 0);
    if (r.isFinal || (r.amountRappen === 0 && r.reason === 'already_at_residual')) break;
    a = { ...a, accumulatedDeprRappen: a.accumulatedDeprRappen + r.amountRappen, netBookValueRappen: r.projectedNbvAfterRappen, lastDepreciationPeriod: period };
    period = nextPeriod(period);
  }
});

// --- 5. Units of production golden (§2 US-H03.3) ---------------------------------------------------

test('units_of_production: the spec golden amount', () => {
  const a = snap({ depreciationMethod: 'units_of_production', totalEstimatedUnits: 100_000, acquisitionCostRappen: 1_000_000, residualValueRappen: 100_000, netBookValueRappen: 1_000_000 });
  const r = calculateDepreciation(a, { period: '2026-07', unitsProduced: 2_500 });
  assert.equal(r.amountRappen, 22_500); // 900000 * 2500 / 100000
});

test('units_of_production: missing production data yields zero with a structured reason, never a throw', () => {
  const a = snap({ depreciationMethod: 'units_of_production', totalEstimatedUnits: 100_000, acquisitionCostRappen: 1_000_000, residualValueRappen: 100_000, netBookValueRappen: 1_000_000 });
  const noUnits = calculateDepreciation(a, { period: '2026-07' });
  assert.equal(noUnits.amountRappen, 0);
  assert.equal(noUnits.reason, 'missing_production_data');
  const noTotal = calculateDepreciation({ ...a, totalEstimatedUnits: null }, { period: '2026-07', unitsProduced: 10 });
  assert.equal(noTotal.reason, 'missing_production_data');
});

test('units_of_production: cumulative units cannot depreciate below residual', () => {
  const a = snap({ depreciationMethod: 'units_of_production', totalEstimatedUnits: 100, acquisitionCostRappen: 1_000_000, residualValueRappen: 100_000, netBookValueRappen: 1_000_000 });
  const r = calculateDepreciation(a, { period: '2026-07', unitsProduced: 1_000_000 }); // absurd overrun
  assert.equal(r.projectedNbvAfterRappen, 100_000);
  assert.equal(r.isFinal, true);
});

// --- 6. none + boundary reasons --------------------------------------------------------------------

test("method 'none' never depreciates", () => {
  const r = calculateDepreciation(snap({ depreciationMethod: 'none', usefulLifeMonths: null }), { period: '2026-07' });
  assert.equal(r.amountRappen, 0);
  assert.equal(r.reason, 'non_depreciable');
});

test('already-at-residual and period-already-processed are distinct structured reasons', () => {
  const atResidual = calculateDepreciation(snap({ netBookValueRappen: 125_000 }), { period: '2026-07' });
  assert.equal(atResidual.reason, 'already_at_residual');
  const reprocessed = calculateDepreciation(snap({ lastDepreciationPeriod: '2026-07' }), { period: '2026-07' });
  assert.equal(reprocessed.reason, 'period_already_processed');
  const earlier = calculateDepreciation(snap({ lastDepreciationPeriod: '2026-08' }), { period: '2026-07' });
  assert.equal(earlier.reason, 'period_already_processed');
});

test('an unknown method surfaces unknown_method and never a default formula', () => {
  const r = calculateDepreciation(snap({ depreciationMethod: 'sum_of_years_digits' }), { period: '2026-07' });
  assert.equal(r.amountRappen, 0);
  assert.equal(r.reason, 'unknown_method');
});

// --- 7. Residual floor + non-negativity, random sweep ----------------------------------------------

test('property: amount >= 0 and projected NBV >= residual for random valid snapshots', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 500; i += 1) {
    const cost = 10_000 + rnd(9_000_000);
    const residual = rnd(cost);
    const nbv = residual + rnd(Math.max(1, cost - residual));
    const life = 1 + rnd(120);
    const methods = ['straight_line', 'declining_balance', 'units_of_production', 'none'];
    const method = methods[rnd(4)];
    const a = snap({
      depreciationMethod: method,
      acquisitionCostRappen: cost,
      residualValueRappen: residual,
      usefulLifeMonths: method === 'none' ? null : life,
      netBookValueRappen: nbv,
      accumulatedDeprRappen: cost - nbv,
      decliningRateBp: 1500,
      totalEstimatedUnits: 50_000,
    });
    const r = calculateDepreciation(a, { period: '2026-07', unitsProduced: rnd(5_000) });
    assert.ok(r.amountRappen >= 0, `negative amount for ${method}`);
    assert.ok(Number.isInteger(r.amountRappen), `non-integer amount for ${method}`);
    assert.ok(r.projectedNbvAfterRappen >= residual, `residual floor breached for ${method}`);
  }
});

// --- 8. Purity ------------------------------------------------------------------------------------

test('identical inputs give identical outputs (referential transparency)', () => {
  const a = snap({ depreciationMethod: 'declining_balance', decliningRateBp: 1750, netBookValueRappen: 543_210 });
  const one = calculateDepreciation(a, { period: '2026-07' });
  const two = calculateDepreciation(a, { period: '2026-07' });
  assert.deepEqual(one, two);
  // batch is the same map, order preserving
  const batch = calculateDepreciationBatch([a, snap()], { period: '2026-07' });
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], one);
});

// --- 9. Schedule projection -----------------------------------------------------------------------

test('projectDepreciationSchedule sums to base and finishes on a final line', () => {
  const a = snap({ acquisitionCostRappen: 1_000_000, residualValueRappen: 0, usefulLifeMonths: 7, netBookValueRappen: 1_000_000 });
  const p = projectDepreciationSchedule(a, '2026-01');
  assert.equal(p.complete, true);
  assert.equal(p.lines.length, 7);
  const sum = p.lines.reduce((s, l) => s + l.amountRappen, 0);
  assert.equal(sum, 1_000_000);
  assert.equal(p.lines[p.lines.length - 1].isFinal, true);
  assert.equal(p.lines[p.lines.length - 1].projectedNbvRappen, 0);
});

test('a units schedule with no forecast returns incomplete with units_forecast_required', () => {
  const a = snap({ depreciationMethod: 'units_of_production', totalEstimatedUnits: 100_000 });
  const p = projectDepreciationSchedule(a, '2026-01');
  assert.equal(p.complete, false);
  assert.equal(p.warning, 'units_forecast_required');
  assert.equal(p.lines.length, 0);
});

// --- 10. §H-TENANT + verbs over a real store ------------------------------------------------------

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'Other AG' }).workspaceId;
  const ctxA = makeContext(store, { workspaceId: wsA, actor: 'user_1', clock, ids });
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'user_2', clock, ids });
  const acc = (ws, number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;
  let seq = 0;
  const mkAsset = (ctx, ws, over = {}) => {
    seq += 1;
    const cat = createAssetCategory(ctx, {
      code: `M${seq}`,
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: acc(ws, '1500'),
      glAccumDeprAccountId: acc(ws, '1510'),
      glDeprExpenseAccountId: acc(ws, '6800'),
      idempotencyKey: `c-${seq}`,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const r = getAction('asset_create').run(deps, {
      workspaceId: ws,
      categoryId: cat.category.id,
      name: 'CNC',
      acquisitionDate: '2026-01-15',
      acquisitionCostRappen: 1_250_000,
      residualValueRappen: 125_000,
      idempotencyKey: `a-${seq}`,
      ...over,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.asset;
  };
  return { store, deps, wsA, wsB, ctxA, ctxB, mkAsset };
}

test('§H-TENANT: previewing a foreign-workspace asset id is rejected with not_found, no leak', () => {
  const { deps, wsA, wsB, ctxA, mkAsset } = setup();
  const asset = mkAsset(ctxA, wsA);
  // wsB cannot preview wsA's asset by id.
  const foreign = getAction('asset_depreciation_preview').run(deps, { workspaceId: wsB, period: '2026-07', assetIds: [asset.id] });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  // wsA sees it.
  const own = getAction('asset_depreciation_preview').run(deps, { workspaceId: wsA, period: '2026-07', assetIds: [asset.id] });
  assert.equal(own.ok, true);
  assert.equal(own.results.length, 1);
  assert.equal(own.results[0].amountRappen, 18_750);
});

test('§H-TENANT: scheduling a foreign asset id is not_found', () => {
  const { deps, wsA, wsB, ctxA, mkAsset } = setup();
  const asset = mkAsset(ctxA, wsA);
  const r = getAction('asset_depreciation_schedule').run(deps, { workspaceId: wsB, assetId: asset.id, fromPeriod: '2026-07' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
});

test('preview over the whole workspace computes only its own assets and writes nothing', () => {
  const { store, deps, wsA, wsB, ctxA, ctxB, mkAsset } = setup();
  mkAsset(ctxA, wsA);
  mkAsset(ctxA, wsA);
  mkAsset(ctxB, wsB);
  const snapshotBefore = store.db.prepare('SELECT count(*) AS n FROM asset').get().n;
  const a = getAction('asset_depreciation_preview').run(deps, { workspaceId: wsA, period: '2026-07' });
  assert.equal(a.ok, true);
  assert.equal(a.results.length, 2, 'only wsA assets');
  const snapshotAfter = store.db.prepare('SELECT count(*) AS n FROM asset').get().n;
  assert.equal(snapshotBefore, snapshotAfter, 'a read verb wrote rows');
});

test('preview rejects a malformed period without throwing', () => {
  const { deps, wsA } = setup();
  const r = getAction('asset_depreciation_preview').run(deps, { workspaceId: wsA, period: '2026-13' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_period');
});

// --- 11. Method enablement ------------------------------------------------------------------------

test('methods list defaults to all enabled; disabling one is reflected and idempotent', () => {
  const { deps, wsA } = setup();
  const before = getAction('asset_depreciation_methods').run(deps, { workspaceId: wsA });
  assert.equal(before.ok, true);
  assert.equal(before.methods.length, 4);
  assert.ok(before.methods.every((m) => m.enabled));

  const set1 = getAction('asset_depreciation_method_set_enabled').run(deps, { workspaceId: wsA, methodKey: 'declining_balance', enabled: false, idempotencyKey: 'k1' });
  assert.equal(set1.ok, true);
  assert.equal(set1.method.enabled, false);

  const after = getAction('asset_depreciation_methods').run(deps, { workspaceId: wsA });
  const db = after.methods.find((m) => m.key === 'declining_balance');
  assert.equal(db.enabled, false);

  // idempotent replay: same key, no second effect, same result
  const replay = getAction('asset_depreciation_method_set_enabled').run(deps, { workspaceId: wsA, methodKey: 'declining_balance', enabled: false, idempotencyKey: 'k1' });
  assert.deepEqual(replay, set1);
});

test("the 'none' method can never be disabled, and an unknown method is unknown_method", () => {
  const { deps, wsA } = setup();
  const locked = getAction('asset_depreciation_method_set_enabled').run(deps, { workspaceId: wsA, methodKey: 'none', enabled: false, idempotencyKey: 'k2' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'method_locked');
  const unknown = getAction('asset_depreciation_method_set_enabled').run(deps, { workspaceId: wsA, methodKey: 'nope', enabled: true, idempotencyKey: 'k3' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_method');
});

// listDepreciationMethods / setMethodEnabled / previewDepreciation / scheduleDepreciation engine
// exports are exercised above through the registry; a direct call keeps them covered too.
test('direct engine exports are callable', () => {
  const { ctxA } = setup();
  assert.equal(listDepreciationMethods(ctxA).ok, true);
  assert.equal(setMethodEnabled(ctxA, { methodKey: 'straight_line', enabled: true, idempotencyKey: 'd1' }).ok, true);
  assert.equal(previewDepreciation(ctxA, { period: '2026-07' }).ok, true);
  assert.equal(scheduleDepreciation(ctxA, { assetId: 'nope', fromPeriod: '2026-07' }).ok, false);
});
