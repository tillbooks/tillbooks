/**
 * C03, sales forecasting: the engine behaviours the spec's §7/§8 promise.
 *
 * Everything drives through the REGISTRY (`getAction(...).run`), never the engine functions bare,
 * so every claim here is made about the same boundary MCP, REST and the Studio share. The suite
 * carries the spec's four named disciplines:
 *
 *   1. READ-ONLY, structurally (P5): the forecast module is INCAPABLE of writing, not merely
 *      polite about it ('C03 P5: read-only' below).
 *   2. §H-TENANT on every read ('C03 §H-TENANT').
 *   3. Clean degradation (P9): an empty pipeline is zeros, never an error ('C03 P9').
 *   4. Round-once weighting that RECONCILES with C01's own board figure ('C03 P2').
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { weightedMinor } from '../../dist/core/deals/index.js';
import { freshDeps, mintWorkspace, AT } from '../api/support.mjs';

const call = (deps, name, workspaceId, input) => getAction(name).run(deps, { workspaceId, ...input });

/** A workspace with one customer contact, ready for deals. */
function world(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Prognose AG', `${seed}-ws`);
  const contact = call(deps, 'create_contact', workspaceId, {
    partyRole: 'customer',
    name: 'Muster AG',
    idempotencyKey: `${seed}-contact`,
  });
  return { deps, workspaceId, accId, contactId: contact.contact.id };
}

function deal(deps, workspaceId, contactId, seed, fields = {}) {
  const created = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: `Deal ${seed}`,
    valueMinor: 100000,
    idempotencyKey: `${seed}-deal`,
    ...fields,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.dealId;
}

// ================================================================================================
// 1. READ-ONLY, structurally and behaviourally (P5, the spec's §7 validator)
// ================================================================================================

const FORECAST_DIR = fileURLToPath(new URL('../../src/core/forecast/', import.meta.url));
const ACTIONS_FILE = fileURLToPath(new URL('../../src/api/forecast-actions.ts', import.meta.url));

/** Every import statement of one source, so a docblock MENTIONING a symbol cannot trip the probe. */
function importsOf(text) {
  return [...text.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]);
}

/** Drop comments, so prose about what the module does NOT do cannot trip the SQL probe. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('C03 P5: read-only, structurally: no posting import, no write SQL, no schema, four read verbs', () => {
  const sources = readdirSync(FORECAST_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(sources.length >= 2, `the probe found only ${sources.length} forecast sources; the path is wrong`);
  const FORBIDDEN = ['postEntry', 'recordPayment', '/ledger/', '/payments/'];
  for (const file of [...sources.map((f) => `${FORECAST_DIR}${f}`), ACTIONS_FILE]) {
    const text = readFileSync(file, 'utf8');
    const imports = importsOf(text).join('\n');
    for (const forbidden of FORBIDDEN) {
      assert.equal(imports.includes(forbidden), false, `${file} imports ${forbidden}: the read model grew a money path`);
    }
    // Every SQL the module prepares is a SELECT: no INSERT/UPDATE/DELETE, anywhere, ever.
    const code = stripComments(text);
    for (const m of code.matchAll(/\.prepare\(\s*(?:'([^']*)'|`([^`]*)`)/g)) {
      const sql = (m[1] ?? m[2] ?? '').trim();
      assert.match(sql, /^SELECT/i, `${file} prepares non-SELECT SQL: ${sql.slice(0, 60)}`);
    }
    assert.equal(code.includes('SCHEMA_SQL'), false, `${file} declares DDL: C03 owns zero tables`);
  }
  // Non-vacuous: the SAME probes find writes where they legitimately live.
  const dealsSource = readFileSync(
    fileURLToPath(new URL('../../src/core/deals/deals.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(/\.prepare\(\s*[`']\s*INSERT/i.test(stripComments(dealsSource)), 'the SQL probe cannot see C01 writing');

  // And the registry claims: all four are kind 'read', none takes an idempotencyKey.
  for (const name of ['forecast_weighted_pipeline', 'forecast_sales_kpis', 'forecast_revenue', 'forecast_vs_actual']) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name} is not registered`);
    assert.equal(action.kind, 'read', `${name} must be a read`);
    assert.equal('idempotencyKey' in (action.inputSchema.properties ?? {}), false, `${name} must not take a key`);
  }
});

test('C03 P5: a full forecast pass writes NOT ONE row (journal, audit, business tables alike)', () => {
  const { deps, workspaceId, contactId } = world('ro');
  deal(deps, workspaceId, contactId, 'ro-1', { expectedCloseOn: '2026-08-15' });
  const dumpCounts = () => {
    const tables = deps.store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all();
    return tables.map((t) => `${t.name}:${deps.store.db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n}`).join('|');
  };
  const before = dumpCounts();
  assert.equal(call(deps, 'forecast_weighted_pipeline', workspaceId, {}).ok, true);
  assert.equal(call(deps, 'forecast_sales_kpis', workspaceId, { from: '2026-01-01', to: '2026-12-31' }).ok, true);
  assert.equal(call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 6 }).ok, true);
  assert.equal(call(deps, 'forecast_vs_actual', workspaceId, { period: '2026-07' }).ok, true);
  assert.equal(dumpCounts(), before, 'a forecast read changed a row count somewhere');
});

// ================================================================================================
// 2. §H-TENANT: every read is fenced to its workspace
// ================================================================================================

test('C03 §H-TENANT: workspace A never sees workspace B deals, quotes or actuals', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Mandant A', 'ht-a').workspaceId;
  const b = mintWorkspace(deps, 'Mandant B', 'ht-b').workspaceId;
  const contactB = call(deps, 'create_contact', b, { partyRole: 'customer', name: 'B AG', idempotencyKey: 'ht-cb' });
  const dealB = call(deps, 'deals_create', b, {
    contactId: contactB.contact.id,
    title: 'Nur B',
    valueMinor: 77700,
    idempotencyKey: 'ht-db',
  });
  assert.equal(dealB.ok, true);
  call(deps, 'deals_mark', b, { dealId: dealB.dealId, status: 'won', idempotencyKey: 'ht-win' });
  const quoteB = call(deps, 'quotes_create', b, {
    contactId: contactB.contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 55500 }],
    idempotencyKey: 'ht-qb',
  });
  assert.equal(quoteB.ok, true);
  call(deps, 'quotes_send', b, { quoteId: quoteB.document.id, idempotencyKey: 'ht-qs' });

  const pipeline = call(deps, 'forecast_weighted_pipeline', a, {});
  assert.equal(pipeline.ok, true);
  assert.deepEqual(pipeline.rows, []);
  assert.equal(pipeline.totalWeightedMinor, 0);

  const kpis = call(deps, 'forecast_sales_kpis', a, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(kpis.ok, true);
  assert.equal(kpis.sample, 0, "workspace B's won deal leaked into A's KPI sample");

  const rev = call(deps, 'forecast_revenue', a, { horizonMonths: 3 });
  assert.equal(rev.ok, true);
  assert.equal(rev.totalMinor, 0, "workspace B's pipeline leaked into A's revenue forecast");
  assert.deepEqual(rev.excluded, []);

  const vs = call(deps, 'forecast_vs_actual', a, { period: '2026-07' });
  assert.equal(vs.ok, true);
  assert.equal(vs.wonInPeriodMinor, 0);
  assert.equal(vs.sample, 0);
});

// ================================================================================================
// 3. Clean degradation (P9): empty answers zeros/nulls, invalid inputs answer NAMED errors
// ================================================================================================

test('C03 P9: an empty pipeline is a zero forecast on all four verbs, never an error', () => {
  const { deps, workspaceId } = world('empty');
  const pipeline = call(deps, 'forecast_weighted_pipeline', workspaceId, {});
  assert.equal(pipeline.ok, true, JSON.stringify(pipeline));
  assert.deepEqual(pipeline.rows, []);
  assert.equal(pipeline.totalWeightedMinor, 0);
  assert.equal(pipeline.totalDealCount, 0);

  const kpis = call(deps, 'forecast_sales_kpis', workspaceId, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(kpis.ok, true);
  assert.equal(kpis.conversionRateBp, null, 'no sample must answer null, never a fake 0 %');
  assert.equal(kpis.avgDealSizeMinor, null);
  assert.equal(kpis.avgCycleDays, null);
  assert.equal(kpis.sample, 0);

  const rev = call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 3 });
  assert.equal(rev.ok, true);
  assert.equal(rev.rows.length, 3, 'the horizon renders its periods even when everything is zero');
  assert.equal(rev.totalMinor, 0);

  const vs = call(deps, 'forecast_vs_actual', workspaceId, { period: '2026-07' });
  assert.equal(vs.ok, true);
  assert.equal(vs.actualRevenueMinor, 0);
  assert.equal(vs.deltaMinor, 0);
  assert.equal(vs.sample, 0);
});

test('C03 P9: invalid inputs answer their NAMED rejections, never a 500', () => {
  const { deps, workspaceId } = world('invalid');
  assert.equal(call(deps, 'forecast_weighted_pipeline', workspaceId, { pipelineId: 'no-such' }).error, 'not_found');
  assert.equal(call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'vibes' }).error, 'invalid_group_by');
  assert.equal(call(deps, 'forecast_weighted_pipeline', workspaceId, { horizonMonths: 0 }).error, 'invalid_horizon');
  assert.equal(call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 25 }).error, 'invalid_horizon');
  assert.equal(call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 0 }).error, 'invalid_horizon');
  assert.equal(
    call(deps, 'forecast_sales_kpis', workspaceId, { from: '2026-06-01', to: '2026-01-01' }).error,
    'invalid_range',
  );
  assert.equal(call(deps, 'forecast_sales_kpis', workspaceId, { from: 'gestern', to: '2026-01-01' }).error, 'invalid_range');
  assert.equal(call(deps, 'forecast_sales_kpis', workspaceId, { from: '2026-01-01', to: '2026-12-31', pipelineId: 'no-such' }).error, 'not_found');
  assert.equal(call(deps, 'forecast_vs_actual', workspaceId, { period: '2026-13' }).error, 'invalid_period');
  assert.equal(call(deps, 'forecast_vs_actual', workspaceId, { period: 'Q1' }).error, 'invalid_period');
  assert.equal(call(deps, 'forecast_vs_actual', workspaceId, { period: '1899' }).error, 'invalid_period');
});

// ================================================================================================
// 4. The weighted math (P2): round-once, bounded, and RECONCILING with C01's board
// ================================================================================================

test('C03 P2: weighting is round-once, 0 <= weighted <= value, and the total EQUALS the C01 board pill', () => {
  const { deps, workspaceId, contactId } = world('math');
  // A spread of probabilities including the rounding edge (odd Rappen x odd probability).
  const board0 = call(deps, 'deals_list', workspaceId, {});
  deal(deps, workspaceId, contactId, 'math-1', { valueMinor: 33333 });
  deal(deps, workspaceId, contactId, 'math-2', { valueMinor: 99999 });
  const d3 = deal(deps, workspaceId, contactId, 'math-3', { valueMinor: 12345 });
  call(deps, 'deals_update', workspaceId, { dealId: d3, patch: { probability: 33 }, idempotencyKey: 'math-pin' });
  void board0;

  const res = call(deps, 'forecast_weighted_pipeline', workspaceId, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const board = call(deps, 'deals_list', workspaceId, {});
  assert.equal(
    res.totalWeightedMinor,
    board.weightedTotalMinor,
    'the forecast total and the C01 board pill must be ONE figure',
  );
  assert.equal(res.totalValueBaseMinor >= res.totalWeightedMinor, true, 'weighted can never exceed unweighted');
  // The pinned deal reproduces the shared round-once helper exactly.
  const pinned = board.deals.find((d) => d.id === d3);
  assert.equal(pinned.weightedMinor, weightedMinor(12345, 33));
  // Re-reads are stable: a pure function over the same rows answers byte-identically (no cache).
  assert.deepEqual(call(deps, 'forecast_weighted_pipeline', workspaceId, {}), res);
});

test('C03: probability 0 still counts, probability 100 open counts full, dateless deals bucket under none', () => {
  const { deps, workspaceId, contactId } = world('edges');
  const d1 = deal(deps, workspaceId, contactId, 'edges-1', { valueMinor: 50000 });
  call(deps, 'deals_update', workspaceId, { dealId: d1, patch: { probability: 0 }, idempotencyKey: 'e-p0' });
  const d2 = deal(deps, workspaceId, contactId, 'edges-2', { valueMinor: 40000, expectedCloseOn: '2026-09-10' });
  call(deps, 'deals_update', workspaceId, { dealId: d2, patch: { probability: 100 }, idempotencyKey: 'e-p100' });

  const byMonth = call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'month' });
  assert.equal(byMonth.ok, true);
  const none = byMonth.rows.find((r) => r.key === 'none');
  assert.ok(none !== undefined, 'the dateless deal must appear in an explicit none bucket, never dropped');
  assert.equal(none.dealCount, 1);
  assert.equal(none.weightedMinor, 0, 'probability 0 contributes zero value');
  const sept = byMonth.rows.find((r) => r.key === '2026-09');
  assert.equal(sept.weightedMinor, 40000, 'probability 100 while open contributes full value');
});

// ================================================================================================
// 5. groupBy: the base enum, a custom field, and the §7 invariance
// ================================================================================================

test('C03 §7 groupBy invariance: totals are byte-identical across stage, month, quarter and a custom field', () => {
  const { deps, workspaceId, contactId } = world('inv');
  const defined = call(deps, 'define_field', workspaceId, {
    entityKind: 'deal',
    key: 'leadquelle',
    labelI18n: { 'de-CH': 'Lead-Quelle', en: 'Lead source' },
    type: 'select',
    options: ['Empfehlung', 'Website'],
    idempotencyKey: 'inv-def',
  });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  // The agent actor defines drafts (P8): confirm to make it live for the groupBy seam.
  call(deps, 'confirm_field', workspaceId, { fieldDefId: defined.fieldDef.fieldDefId });

  const d1 = deal(deps, workspaceId, contactId, 'inv-1', { valueMinor: 33333, expectedCloseOn: '2026-08-01' });
  const d2 = deal(deps, workspaceId, contactId, 'inv-2', { valueMinor: 44444, expectedCloseOn: '2026-11-20' });
  deal(deps, workspaceId, contactId, 'inv-3', { valueMinor: 55555 });
  call(deps, 'set_field_value', workspaceId, { entityKind: 'deal', entityId: d1, fieldKey: 'leadquelle', value: 'Empfehlung', idempotencyKey: 'inv-v1' });
  call(deps, 'set_field_value', workspaceId, { entityKind: 'deal', entityId: d2, fieldKey: 'leadquelle', value: 'Website', idempotencyKey: 'inv-v2' });

  const totalsOf = (res) => ({
    dealCount: res.totalDealCount,
    valueBaseMinor: res.totalValueBaseMinor,
    weightedMinor: res.totalWeightedMinor,
  });
  const byStage = call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'stage' });
  const byMonth = call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'month' });
  const byQuarter = call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'quarter' });
  const byField = call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'leadquelle' });
  for (const res of [byStage, byMonth, byQuarter, byField]) assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(totalsOf(byMonth), totalsOf(byStage));
  assert.deepEqual(totalsOf(byQuarter), totalsOf(byStage));
  assert.deepEqual(totalsOf(byField), totalsOf(byStage), 'a custom grouping reshapes rows, never figures');

  // The custom grouping bucketed correctly: two named values plus none for the unset deal.
  assert.deepEqual(new Set(byField.rows.map((r) => r.key)), new Set(['Empfehlung', 'Website', 'none']));
  // For a single-valued select, the rows SUM to the totals too (no deal in two buckets).
  assert.equal(byField.rows.reduce((s, r) => s + r.weightedMinor, 0), byField.totalWeightedMinor);
  // The quarter view bucketed the two dated deals into their quarters.
  assert.deepEqual(new Set(byQuarter.rows.map((r) => r.key)), new Set(['2026-Q3', '2026-Q4', 'none']));

  // An archived or draft field key is not a valid grouping (the §H-ENUM extension is registered keys only).
  assert.equal(call(deps, 'forecast_weighted_pipeline', workspaceId, { groupBy: 'nichtda' }).error, 'invalid_group_by');
});

// ================================================================================================
// 6. Sales KPIs (US-C03.2)
// ================================================================================================

test('C03 KPIs: conversion in basis points, average won size round-once, cycle from the OP5 note', () => {
  const { deps, workspaceId, contactId } = world('kpi');
  const won1 = deal(deps, workspaceId, contactId, 'kpi-1', { valueMinor: 100001 });
  const won2 = deal(deps, workspaceId, contactId, 'kpi-2', { valueMinor: 100000 });
  const lost = deal(deps, workspaceId, contactId, 'kpi-3', { valueMinor: 70000 });
  call(deps, 'deals_mark', workspaceId, { dealId: won1, status: 'won', idempotencyKey: 'kpi-w1' });
  call(deps, 'deals_mark', workspaceId, { dealId: won2, status: 'won', idempotencyKey: 'kpi-w2' });
  call(deps, 'deals_mark', workspaceId, { dealId: lost, status: 'lost', lostReason: 'Preis', idempotencyKey: 'kpi-l' });
  // A fourth deal stays open: it must not enter the closed-deal sample.
  deal(deps, workspaceId, contactId, 'kpi-4', { valueMinor: 999999 });

  const kpis = call(deps, 'forecast_sales_kpis', workspaceId, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(kpis.ok, true, JSON.stringify(kpis));
  assert.equal(kpis.wonCount, 2);
  assert.equal(kpis.lostCount, 1);
  assert.equal(kpis.sample, 3);
  assert.equal(kpis.conversionRateBp, 6667, '2 of 3 is 6667 bp, rounded once, an integer and never a float');
  assert.equal(kpis.avgDealSizeMinor, 100001, '(100001 + 100000) / 2 rounds half away from zero ONCE');
  assert.equal(kpis.avgCycleDays, 0, 'created and won at the same pinned instant is a zero-day cycle');

  // The window fences on the OP5 close timestamp: a window elsewhere answers the honest null.
  const outside = call(deps, 'forecast_sales_kpis', workspaceId, { from: '2025-01-01', to: '2025-12-31' });
  assert.equal(outside.sample, 0);
  assert.equal(outside.conversionRateBp, null);

  // Wins with no losses: 100 % as 10000 bp, integer.
  const { deps: deps2, workspaceId: ws2, contactId: c2 } = world('kpi-allwin');
  const w = deal(deps2, ws2, c2, 'kpi-aw', { valueMinor: 5000 });
  call(deps2, 'deals_mark', ws2, { dealId: w, status: 'won', idempotencyKey: 'kpi-aw-w' });
  assert.equal(call(deps2, 'forecast_sales_kpis', ws2, { from: '2026-07-01', to: '2026-07-31' }).conversionRateBp, 10000);
});

// ================================================================================================
// 7. The revenue forecast: three components, dedup, liveness, FX degradation (US-C03.3/US-C03.5)
// ================================================================================================

test('C03 revenue: the three components land in their periods and nothing double-counts', () => {
  const { deps, workspaceId, contactId } = world('rev');
  // (a) an open deal expected to close next month.
  deal(deps, workspaceId, contactId, 'rev-open', { valueMinor: 80000, expectedCloseOn: '2026-08-20' });
  // (a) an OVERDUE open deal: lands in the first period, never dropped.
  deal(deps, workspaceId, contactId, 'rev-overdue', { valueMinor: 60000, expectedCloseOn: '2026-01-05' });
  // (b) a won deal, no invoice: 100 % of base value, first period (dateless).
  const won = deal(deps, workspaceId, contactId, 'rev-won', { valueMinor: 50000 });
  call(deps, 'deals_mark', workspaceId, { dealId: won, status: 'won', idempotencyKey: 'rev-w' });
  // (c) a deal-less sent quote valid into next month.
  const quote = call(deps, 'quotes_create', workspaceId, {
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 30000 }],
    validUntil: '2026-08-31',
    idempotencyKey: 'rev-q',
  });
  assert.equal(quote.ok, true, JSON.stringify(quote));
  assert.equal(call(deps, 'quotes_send', workspaceId, { quoteId: quote.document.id, idempotencyKey: 'rev-qs' }).ok, true);

  const rev = call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 3 });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.deepEqual(rev.rows.map((r) => r.periodKey), ['2026-07', '2026-08', '2026-09']);
  const [july, august] = rev.rows;
  const board = call(deps, 'deals_list', workspaceId, {});
  const openWeighted = (id) => {
    const d = board.deals.find((x) => x.id === id);
    return d.weightedMinor;
  };
  void openWeighted;
  assert.equal(august.weightedOpenMinor > 0, true, 'the August close weights into August');
  assert.equal(july.weightedOpenMinor > 0, true, 'the overdue close weights into the FIRST period');
  assert.equal(july.wonUninvoicedMinor, 50000, 'a won deal counts at 100 %, no longer a probability');
  assert.equal(august.openQuotesMinor, 30000, 'the deal-less quote buckets by its validUntil month');
  for (const row of rev.rows) {
    assert.equal(row.totalMinor, row.weightedOpenMinor + row.wonUninvoicedMinor + row.openQuotesMinor);
  }
  assert.equal(rev.totalMinor, rev.totalWeightedOpenMinor + rev.totalWonUninvoicedMinor + rev.totalOpenQuotesMinor);
});

test('C03 dedup: a deal-seeded quote is represented by its DEAL, never counted twice', () => {
  const { deps, workspaceId, contactId } = world('dedup');
  const d = deal(deps, workspaceId, contactId, 'dedup-1', { valueMinor: 90000, expectedCloseOn: '2026-08-01' });
  const seeded = call(deps, 'deals_to_quote', workspaceId, { dealId: d, idempotencyKey: 'dedup-q' });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  // Send the seeded quote so it would qualify for (c) if the dedup failed.
  const sent = call(deps, 'quotes_send', workspaceId, { quoteId: seeded.quoteId, idempotencyKey: 'dedup-s' });
  assert.equal(sent.ok, true, JSON.stringify(sent));

  const rev = call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 3 });
  assert.equal(rev.ok, true);
  assert.equal(rev.totalOpenQuotesMinor, 0, 'the deal-linked quote must be excluded from the open-quote component');
  assert.equal(rev.totalWeightedOpenMinor > 0, true, 'its deal carries the expectation instead');
});

test('C03 liveness: accept/decline/expiry removes a quote; the minted invoice removes a won deal', () => {
  const { deps, workspaceId, contactId } = world('live');
  call(deps, 'vat_seed_defaults', workspaceId, {});
  call(deps, 'set_vat_method', workspaceId, { vatMethod: 'effektiv', vatAccounting: 'soll' });
  call(deps, 'set_creditor_profile', workspaceId, {
    creditorName: 'Prognose AG',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });

  // A deal-less quote that gets DECLINED leaves component (c) on the next read.
  const declined = call(deps, 'quotes_create', workspaceId, {
    contactId,
    lines: [{ description: 'Variante A', unitPriceMinor: 20000 }],
    idempotencyKey: 'live-q1',
  });
  call(deps, 'quotes_send', workspaceId, { quoteId: declined.document.id, idempotencyKey: 'live-q1s' });
  assert.equal(call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 2 }).totalOpenQuotesMinor, 20000);
  call(deps, 'quotes_decline', workspaceId, { quoteId: declined.document.id, idempotencyKey: 'live-q1d' });
  assert.equal(call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 2 }).totalOpenQuotesMinor, 0);

  // A won deal leaves component (b) the moment its quote chain reaches an invoice, with no cache step.
  const d = deal(deps, workspaceId, contactId, 'live-d', { valueMinor: 100000 });
  const seeded = call(deps, 'deals_to_quote', workspaceId, { dealId: d, idempotencyKey: 'live-dq' });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  call(deps, 'quotes_send', workspaceId, { quoteId: seeded.quoteId, idempotencyKey: 'live-ds' });
  call(deps, 'quotes_accept', workspaceId, { quoteId: seeded.quoteId, idempotencyKey: 'live-da' });
  call(deps, 'deals_mark', workspaceId, { dealId: d, status: 'won', idempotencyKey: 'live-dw' });
  assert.equal(call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 2 }).totalWonUninvoicedMinor, 100000);
  const converted = call(deps, 'quotes_convert', workspaceId, { quoteId: seeded.quoteId, to: 'invoice', idempotencyKey: 'live-dc' });
  assert.equal(converted.ok, true, JSON.stringify(converted));
  assert.equal(
    call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 2 }).totalWonUninvoicedMinor,
    0,
    'the minted invoice must remove the deal from won-uninvoiced on the NEXT read (P5, nothing to un-cache)',
  );
});

test('C03 §H-FX: a foreign-currency deal-less quote degrades into excluded[], never a wrong total', () => {
  const { deps, workspaceId, contactId } = world('fx');
  const eur = call(deps, 'quotes_create', workspaceId, {
    contactId,
    currency: 'EUR',
    lines: [{ description: 'Beratung EU', unitPriceMinor: 40000 }],
    idempotencyKey: 'fx-q',
  });
  assert.equal(eur.ok, true, JSON.stringify(eur));
  assert.equal(call(deps, 'quotes_send', workspaceId, { quoteId: eur.document.id, idempotencyKey: 'fx-qs' }).ok, true);

  const rev = call(deps, 'forecast_revenue', workspaceId, { horizonMonths: 2 });
  assert.equal(rev.ok, true);
  assert.equal(rev.totalOpenQuotesMinor, 0, 'an unconverted EUR total must never be summed into a CHF figure');
  assert.deepEqual(rev.excluded, [{ quoteId: eur.document.id, reason: 'needs_fx_rate' }]);
});

test('C03 §H-FX: a EUR deal aggregates its FROZEN CHF base, and the totals stay in one currency', () => {
  const { deps, workspaceId, contactId } = world('fxdeal');
  const rate = call(deps, 'record_exchange_rate', workspaceId, {
    baseCurrency: 'EUR',
    rate: '0.95',
    asOf: '2026-07-16',
    idempotencyKey: 'fxd-rate',
  });
  assert.equal(rate.ok, true, JSON.stringify(rate));
  const created = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: 'EU-Projekt',
    valueMinor: 100000,
    currency: 'EUR',
    idempotencyKey: 'fxd-deal',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.deal.valueBaseMinor, 95000, 'the §H-FX trio froze at capture');

  const res = call(deps, 'forecast_weighted_pipeline', workspaceId, {});
  assert.equal(res.totalValueBaseMinor, 95000, 'aggregates consume the stored CHF base, never the txn amount');
  assert.equal(res.baseCurrency, 'CHF');
});

// ================================================================================================
// 8. Forecast vs actual: the golden reconciliation fixture (§8, in lieu of a Swiss anchor)
// ================================================================================================

test('C03 golden reconciliation: actual = wonInPeriod - wonNotInvoiced + invoicedWithoutDeal, to the Rappen', () => {
  const { deps, workspaceId, contactId } = world('golden');
  call(deps, 'vat_seed_defaults', workspaceId, {});
  call(deps, 'set_vat_method', workspaceId, { vatMethod: 'effektiv', vatAccounting: 'soll' });
  call(deps, 'set_creditor_profile', workspaceId, {
    creditorName: 'Golden AG',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });

  // Deal A: won AND invoiced in the period, at exactly its value (the fixture's construction).
  const dealA = deal(deps, workspaceId, contactId, 'golden-a', { valueMinor: 100000 });
  const quoteA = call(deps, 'quotes_create', workspaceId, {
    contactId,
    dealId: dealA,
    lines: [{ description: 'Projekt A', unitPriceMinor: 100000 }],
    idempotencyKey: 'golden-qa',
  });
  assert.equal(quoteA.ok, true, JSON.stringify(quoteA));
  call(deps, 'quotes_send', workspaceId, { quoteId: quoteA.document.id, idempotencyKey: 'golden-qas' });
  call(deps, 'quotes_accept', workspaceId, { quoteId: quoteA.document.id, idempotencyKey: 'golden-qaa' });
  call(deps, 'deals_mark', workspaceId, { dealId: dealA, status: 'won', idempotencyKey: 'golden-aw' });
  const invA = call(deps, 'quotes_convert', workspaceId, { quoteId: quoteA.document.id, to: 'invoice', idempotencyKey: 'golden-qac' });
  assert.equal(invA.ok, true, JSON.stringify(invA));
  const issuedA = call(deps, 'issue_invoice', workspaceId, { invoiceId: invA.document.id, idempotencyKey: 'golden-ia' });
  assert.equal(issuedA.ok, true, JSON.stringify(issuedA));

  // Deal B: won in the period, NOT yet invoiced (revenue still to come).
  const dealB = deal(deps, workspaceId, contactId, 'golden-b', { valueMinor: 50000 });
  call(deps, 'deals_mark', workspaceId, { dealId: dealB, status: 'won', idempotencyKey: 'golden-bw' });

  // Invoice C: posted revenue that never went through the pipeline.
  const docC = call(deps, 'create_document', workspaceId, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Direktauftrag', unitPriceMinor: 30000 }],
    idempotencyKey: 'golden-c',
  });
  assert.equal(docC.ok, true, JSON.stringify(docC));
  const issuedC = call(deps, 'issue_invoice', workspaceId, { invoiceId: docC.document.id, idempotencyKey: 'golden-ic' });
  assert.equal(issuedC.ok, true, JSON.stringify(issuedC));

  const vs = call(deps, 'forecast_vs_actual', workspaceId, { period: '2026-07' });
  assert.equal(vs.ok, true, JSON.stringify(vs));
  assert.equal(vs.wonInPeriodMinor, 150000, 'deals A + B closed in the period');
  assert.equal(vs.wonNotInvoicedMinor, 50000, 'deal B is the revenue still to come');
  assert.equal(vs.invoicedWithoutDealMinor, 30000, 'invoice C never went through the pipeline');
  assert.equal(vs.actualRevenueMinor, 130000, 'A08 posted net revenue: A (100000) + C (30000)');
  // The identity a Treuhänder checks first, and every component non-zero so it can actually fail:
  assert.equal(
    vs.actualRevenueMinor,
    vs.wonInPeriodMinor - vs.wonNotInvoicedMinor + vs.invoicedWithoutDealMinor,
    'the reconciliation identity must tie out to the Rappen',
  );
  assert.equal(vs.deltaMinor, -20000, 'under pipeline: the ▼ case');

  // The quarter and year spellings of the same window answer the same reconciliation.
  const q3 = call(deps, 'forecast_vs_actual', workspaceId, { period: '2026-Q3' });
  assert.equal(q3.actualRevenueMinor, vs.actualRevenueMinor);
  const year = call(deps, 'forecast_vs_actual', workspaceId, { period: '2026' });
  assert.equal(year.wonInPeriodMinor, vs.wonInPeriodMinor);
});

// ================================================================================================
// 9. The A24 gate (US-C03.6): read_books on every face, uniformly
// ================================================================================================

test('C03 A24: without read_books every forecast verb answers permission_denied, uniformly', () => {
  // The A24 fixture flow the permission-boundary suite uses (D50): the studio owner defines a
  // deals-only role, the invite flip seats the agent, and set_role narrows the agent's own seat.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Verkauf ohne Berichte GmbH', 'gate-ws');
  const contact = call(deps, 'create_contact', workspaceId, { partyRole: 'customer', name: 'Gate AG', idempotencyKey: 'gate-c' });
  const created = call(deps, 'deals_create', workspaceId, {
    contactId: contact.contact.id,
    title: 'Sichtbar am Board',
    valueMinor: 10000,
    idempotencyKey: 'gate-d',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const role = call(deps, 'define_role', workspaceId, {
    name: 'Verkauf ohne Berichte',
    capabilities: ['deals.read', 'deals.write'],
    idempotencyKey: 'gate-role',
  });
  assert.equal(role.ok, true, JSON.stringify(role));
  const invited = call(deps, 'invite_member', workspaceId, {
    email: 'verkauf@muster.ch',
    role: role.roleId,
    idempotencyKey: 'gate-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const seat = call(deps, 'list_members', workspaceId, {}).members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the flip did not seat the agent, so there is no row to narrow');
  assert.equal(call(deps, 'set_role', workspaceId, { memberId: seat.memberId, role: role.roleId }).ok, true);

  deps.actor = 'agent';
  // The board is readable, the aggregate reporting is not: exactly the US-C03.6 boundary.
  assert.equal(call(deps, 'deals_list', workspaceId, {}).ok, true, 'deals.read must still open the board');
  const inputs = {
    forecast_weighted_pipeline: {},
    forecast_sales_kpis: { from: '2026-01-01', to: '2026-12-31' },
    forecast_revenue: { horizonMonths: 3 },
    forecast_vs_actual: { period: '2026-07' },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const res = call(deps, name, workspaceId, input);
    assert.equal(res.ok, false, `${name} must be gated`);
    assert.equal(res.error, 'permission_denied', `${name} must deny uniformly: ${JSON.stringify(res)}`);
  }
});
