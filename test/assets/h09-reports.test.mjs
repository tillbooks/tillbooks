// H09, Asset Reports & Agent Tools: the READ-ONLY report surface over the H00-H08 fixed-asset cluster.
// H09 posts NOTHING and creates no table, so the load-bearing assertions are:
//
//   1. READ-ONLY BY ABSENCE (P3/P5). Every one of the six report verbs, called across a full
//      acquire -> depreciate -> dispose world, moves not one row: the posted-journal count and the
//      asset_transaction count are identical before and after, and no new asset row appears. This is the
//      spec's "posts nothing" claim, asserted rather than documented.
//   2. THE MONEY IDENTITY (§7). The register totals equal the summed asset convenience columns under the
//      same filter (sum(nbv) == sum(asset.net_book_value_rappen)); the NBV summary's grand total equals the
//      register total; the forecast for a single asset over a one-period window equals the live
//      asset_depreciation_preview for that period (the OP12 single-source tripwire).
//   3. §H-TENANT. A foreign asset/account never enters a total: a second workspace's asset is invisible to
//      the first workspace's reports, and a foreign assetId in the forecast filter is not_found before any
//      projection.
//   4. THE REPORT MATH. Disposal gain/loss = proceeds - NBV at disposal; acquisition cost sums; the
//      end-of-life list finds an asset that reaches residual inside the window; invalid period ranges and
//      missing units-of-production data are reported as the spec says.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetDispose,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  previewDepreciation,
  assetRegisterReport,
  assetDepreciationForecast,
  assetDisposalSummary,
  assetAcquisitionSummary,
  assetNbvSummary,
  assetEndOfLifeList,
} from '../../dist/core/assets/index.js';

const AT = '2026-08-16T00:00:00.000Z';

/** Build a workspace. Pass an existing `env` (store/clock/ids) to seat a SECOND workspace in the SAME
 * database, which is what a real §H-TENANT test needs: separate stores with fresh id generators would
 * hand both workspaces colliding ids and prove nothing. */
function makeWorkspace(name, env) {
  const clock = env?.clock ?? fixedClock(AT);
  const ids = env?.ids ?? sequenceIdGen();
  const store = env?.store ?? new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
  const acc = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;

  let n = 0;
  const category = (over = {}) => {
    const cat = createAssetCategory(ctx, {
      code: `MACH-${(n += 1)}`,
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 12,
      glAssetAccountId: acc('1500'),
      glAccumDeprAccountId: acc('1510'),
      glDeprExpenseAccountId: acc('6800'),
      idempotencyKey: `cat-${n}`,
      ...over,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    return cat.category.id;
  };
  const activeAsset = (cost, over = {}, categoryId = category()) => {
    const created = createAsset(ctx, {
      categoryId,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: cost,
      idempotencyKey: `as-${(n += 1)}`,
      ...over,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const acq = assetAcquire(ctx, {
      assetId: created.asset.id,
      date: '2026-01-10',
      acquisitionCostRappen: cost,
      creditAccountId: acc('1020'),
      idempotencyKey: `acq-${n}`,
    });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return created.asset.id;
  };
  const depreciate = (assetId, period) => {
    const draft = assetDepreciationRunCreate(ctx, { period, assetIds: [assetId], idempotencyKey: `dr-${(n += 1)}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    const posted = assetDepreciationRunPost(ctx, { runId: draft.run.id, idempotencyKey: `dp-${n}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
  };
  const dispose = (assetId, proceeds) => {
    const d = assetDispose(ctx, {
      assetId,
      disposalDate: '2026-07-20',
      proceedsRappen: proceeds,
      proceedsAccountId: acc('1020'),
      gainLossAccountId: acc('6900'),
      idempotencyKey: `disp-${(n += 1)}`,
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    return d;
  };

  return { ctx, store, clock, ids, workspaceId, acc, category, activeAsset, depreciate, dispose };
}

const posted = (store, ws) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
const txnCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(ws).n;
const assetCount = (store, ws) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM asset WHERE workspace_id = ?').get(ws).n;

// --- 1. READ-ONLY BY ABSENCE ----------------------------------------------------------------------

test('H09 posts nothing: no report verb moves the ledger or the sub-ledger', () => {
  const { ctx, store, workspaceId, category, activeAsset, depreciate, dispose } = makeWorkspace('Acme AG');
  const cat = category();
  const a = activeAsset(1_200_000, {}, cat);
  const b = activeAsset(600_000, {}, cat);
  depreciate(a, '2026-02');
  dispose(b, 500_000);

  const j0 = posted(store, workspaceId);
  const t0 = txnCount(store, workspaceId);
  const a0 = assetCount(store, workspaceId);

  // Every report, on real data.
  assert.equal(assetRegisterReport(ctx, {}).ok, true);
  assert.equal(assetDepreciationForecast(ctx, { fromPeriod: '2026-08', toPeriod: '2026-12' }).ok, true);
  assert.equal(assetDisposalSummary(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' }).ok, true);
  assert.equal(assetAcquisitionSummary(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' }).ok, true);
  assert.equal(assetNbvSummary(ctx, { groupBy: 'category' }).ok, true);
  assert.equal(assetEndOfLifeList(ctx, { withinMonths: 60 }).ok, true);

  assert.equal(posted(store, workspaceId), j0, 'a report posted a journal');
  assert.equal(txnCount(store, workspaceId), t0, 'a report wrote a sub-ledger row');
  assert.equal(assetCount(store, workspaceId), a0, 'a report created an asset');
});

// --- 2. THE MONEY IDENTITY ------------------------------------------------------------------------

test('register totals equal the summed asset convenience columns (money identity)', () => {
  const { ctx, store, workspaceId, category, activeAsset, depreciate } = makeWorkspace('Acme AG');
  const cat = category();
  const a = activeAsset(1_200_000, {}, cat);
  const b = activeAsset(600_000, {}, cat);
  depreciate(a, '2026-02'); // a nbv -> 1'100'000
  depreciate(b, '2026-02'); // b nbv -> 550'000

  const report = assetRegisterReport(ctx, { filter: { status: ['active'] } });
  assert.equal(report.ok, true, JSON.stringify(report));
  const sum = store.db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(acquisition_cost_rappen),0) AS cost, COALESCE(SUM(accumulated_depr_rappen),0) AS accum, COALESCE(SUM(net_book_value_rappen),0) AS nbv FROM asset WHERE workspace_id = ? AND status = 'active'",
    )
    .get(workspaceId);
  assert.equal(report.totals.count, sum.count);
  assert.equal(report.totals.costRappen, sum.cost);
  assert.equal(report.totals.accumRappen, sum.accum);
  assert.equal(report.totals.nbvRappen, sum.nbv);
  assert.equal(report.totals.nbvRappen, 1_650_000);
});

test('the NBV summary grand total equals the register total under the same base', () => {
  const { ctx, category, activeAsset, depreciate } = makeWorkspace('Acme AG');
  const cat = category();
  const a = activeAsset(1_200_000, {}, cat);
  activeAsset(600_000, {}, cat);
  depreciate(a, '2026-02');

  const reg = assetRegisterReport(ctx, {});
  const nbv = assetNbvSummary(ctx, { groupBy: 'category' });
  assert.equal(nbv.ok, true, JSON.stringify(nbv));
  assert.equal(nbv.grandTotal.sumNbvRappen, reg.totals.nbvRappen);
  assert.equal(nbv.grandTotal.count, reg.totals.count);
  // One category -> exactly one group carrying the whole total.
  assert.equal(nbv.groups.length, 1);
  assert.equal(nbv.groups[0].sumNbvRappen, reg.totals.nbvRappen);
});

test('the forecast for a single asset over a one-period window equals the live preview (OP12 tripwire)', () => {
  const { ctx, category, activeAsset } = makeWorkspace('Acme AG');
  const cat = category();
  const a = activeAsset(1_200_000, {}, cat);

  const preview = previewDepreciation(ctx, { period: '2026-03', assetIds: [a] });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const previewAmount = preview.results[0].amountRappen;

  const forecast = assetDepreciationForecast(ctx, { fromPeriod: '2026-03', toPeriod: '2026-03', filter: { assetIds: [a] } });
  assert.equal(forecast.ok, true, JSON.stringify(forecast));
  assert.equal(forecast.periods.length, 1);
  assert.equal(forecast.periods[0].totalAmountRappen, previewAmount);
  assert.equal(forecast.periods[0].totalAmountRappen, 100_000);
});

// --- 3. §H-TENANT ---------------------------------------------------------------------------------

test('§H-TENANT: a second workspace asset never enters the first workspace reports', () => {
  const w1 = makeWorkspace('Acme AG');
  // A SECOND workspace in the SAME store (shared clock/ids), so ids do not collide and the tenant scope
  // is the only thing separating the two.
  const w2 = makeWorkspace('Other GmbH', { store: w1.store, clock: w1.clock, ids: w1.ids });
  w1.activeAsset(1_200_000);
  const foreign = w2.activeAsset(999_000);

  const reg = assetRegisterReport(w1.ctx, {});
  assert.equal(reg.totals.count, 1);
  assert.equal(reg.totals.costRappen, 1_200_000);
  assert.ok(!reg.rows.some((r) => r.acquisitionCostRappen === 999_000), 'a foreign asset leaked into the register');

  // A foreign assetId in the forecast filter is not_found before any projection.
  const cross = assetDepreciationForecast(w1.ctx, {
    fromPeriod: '2026-08',
    toPeriod: '2026-10',
    filter: { assetIds: [foreign] },
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found');
});

// --- 4. THE REPORT MATH ---------------------------------------------------------------------------

test('disposal summary: gain/loss is proceeds minus NBV at disposal, and totals split gain from loss', () => {
  const { ctx, category, activeAsset, dispose } = makeWorkspace('Acme AG');
  const cat = category();
  const gainAsset = activeAsset(600_000, {}, cat); // NBV 600'000, sell for 700'000 -> +100'000
  const lossAsset = activeAsset(600_000, {}, cat); // NBV 600'000, sell for 500'000 -> -100'000
  dispose(gainAsset, 700_000);
  dispose(lossAsset, 500_000);

  const summary = assetDisposalSummary(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.disposals.length, 2);
  for (const d of summary.disposals) {
    assert.equal(d.gainLossRappen, d.proceedsRappen - d.nbvAtDisposalRappen, 'gain/loss identity');
    assert.equal(d.nbvAtDisposalRappen, d.originalCostRappen - d.accumDeprAtDisposalRappen);
  }
  assert.equal(summary.totals.count, 2);
  assert.equal(summary.totals.gainRappen, 100_000);
  assert.equal(summary.totals.lossRappen, 100_000);
  assert.equal(summary.totals.netGainLossRappen, 0);
  assert.equal(summary.totals.proceedsRappen, 1_200_000);
});

test('acquisition summary sums the capitalised cost in the range', () => {
  const { ctx, category, activeAsset } = makeWorkspace('Acme AG');
  const cat = category();
  activeAsset(1_200_000, {}, cat);
  activeAsset(300_000, {}, cat);

  const inRange = assetAcquisitionSummary(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' });
  assert.equal(inRange.ok, true, JSON.stringify(inRange));
  assert.equal(inRange.totals.count, 2);
  assert.equal(inRange.totals.costRappen, 1_500_000);

  // A range before the acquisitions is an empty success, not an error.
  const empty = assetAcquisitionSummary(ctx, { fromDate: '2020-01-01', toDate: '2020-12-31' });
  assert.equal(empty.ok, true);
  assert.equal(empty.acquisitions.length, 0);
  assert.equal(empty.totals.count, 0);
});

test('end-of-life: a 12-month asset reaches residual inside a 12-month window', () => {
  const { ctx, category, activeAsset } = makeWorkspace('Acme AG');
  // A 12-month straight-line asset acquired 2026-01, clock at 2026-08: it fully depreciates by 2027-01,
  // which is 5 months out from the current period. It must appear in a 12-month window and not a 3-month.
  const a = activeAsset(1_200_000, {}, category());

  const wide = assetEndOfLifeList(ctx, { withinMonths: 12 });
  assert.equal(wide.ok, true, JSON.stringify(wide));
  assert.ok(wide.assets.some((x) => x.assetId === a), 'the maturing asset is missing from the 12-month window');
  const row = wide.assets.find((x) => x.assetId === a);
  assert.ok(row.remainingMonths > 0 && row.remainingMonths <= 12);
  assert.ok(row.nextDepreciationRappen > 0);

  const narrow = assetEndOfLifeList(ctx, { withinMonths: 3 });
  assert.equal(narrow.assets.some((x) => x.assetId === a), false, 'a 5-month asset should not be in a 3-month window');
});

test('forecast: a reversed or over-long window is invalid_period_range', () => {
  const { ctx } = makeWorkspace('Acme AG');
  const reversed = assetDepreciationForecast(ctx, { fromPeriod: '2026-10', toPeriod: '2026-05' });
  assert.equal(reversed.ok, false);
  assert.equal(reversed.error, 'invalid_period_range');

  const tooLong = assetDepreciationForecast(ctx, { fromPeriod: '2026-01', toPeriod: '2031-06' }); // 66 months
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error, 'invalid_period_range');
});

test('forecast: a units-of-production asset with no unitsForecast raises production_data_required', () => {
  const { ctx, category, activeAsset } = makeWorkspace('Acme AG');
  const uopCat = category({ depreciationMethod: 'units_of_production', usefulLifeMonths: 60 });
  activeAsset(1_000_000, { depreciationMethod: 'units_of_production', totalEstimatedUnits: 10_000, usefulLifeMonths: 60 }, uopCat);

  const forecast = assetDepreciationForecast(ctx, { fromPeriod: '2026-08', toPeriod: '2026-12' });
  assert.equal(forecast.ok, true, JSON.stringify(forecast));
  assert.ok(forecast.warnings.includes('production_data_required'), 'the UoP warning is missing');
  // No invented usage: every projected period is zero.
  assert.ok(forecast.periods.every((p) => p.totalAmountRappen === 0));
});
