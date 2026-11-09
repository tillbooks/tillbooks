// I05, supplier performance: the spec's §4/§7 guarantees, proven three ways.
//
//   1. THE METRIC MATH, hand-calculable, over `computeMetrics` fed row arrays directly, so every
//      definition (OTIF, on-time, in-full, delay, qty variance, price variance, override rate,
//      rejection rate, weighted score) is pinned to an exact expected number a human can re-derive.
//   2. THE LIVE PATH, over REAL seeded I02 receipts and a D02 po_match fixture, driven through the
//      engine verbs, proving the loaders, the tenant fence, the empty-state and the no-mutation
//      posture end to end.
//   3. READ-ONLY, structurally (P5, the C03 forecast precedent): the module is INCAPABLE of writing,
//      not merely polite about it: no writer import, no non-SELECT SQL, no DDL, five read verbs.
//
// The pure guarantee (spec §4 core): a scorecard is a pure function of the non-reversed receipts and
// matches in the window plus the config, and re-evaluation with identical data yields the identical
// result. That referential transparency is asserted directly ('I05 pure: identical inputs ...').

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createItem, createContact } from '../../dist/core/sales/index.js';
import { poUpsert, poSend } from '../../dist/core/purchase/purchaseOrders.js';
import { makePeriodPort } from '../../dist/core/ledger/index.js';
import { inventoryEnsureDefaultLocation } from '../../dist/core/inventory/index.js';
import {
  goodsReceiptCreate,
  goodsReceiptUpsertLines,
  goodsReceiptPost,
  goodsReceiptReverse,
  computeMetrics,
  DEFAULT_PERFORMANCE_CONFIG,
  supplierScorecardGet,
  supplierPerformanceRank,
  supplierPerformanceTrend,
  supplierPerformanceExplain,
  supplierPerformanceAlerts,
} from '../../dist/core/procurement/index.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-08-11T00:00:00.000Z';

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
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, periods: makePeriodPort({ store, workspaceId }) });
  return { ctx, store, workspaceId };
}

/** A SENT purchase order for `qty` units at `unitPriceRappen`, plus a fresh vendor and item. */
function sentPo(ctx, { qty = 6, seed = 'p', unitPriceRappen = 1000, vendorId } = {}) {
  const vId =
    vendorId ??
    must(createContact(ctx, { partyRole: 'vendor', name: `Lieferant ${seed}`, idempotencyKey: `${seed}-v` }), 'contact').contact.id;
  const itemId = must(createItem(ctx, { name: `Rohstoff ${seed}`, defaultUnitPriceMinor: 12000, trackStock: true, idempotencyKey: `${seed}-i` }), 'item').item.id;
  const locationId = must(inventoryEnsureDefaultLocation(ctx), 'loc').location.id;
  const po = must(poUpsert(ctx, { supplierContactId: vId, lines: [{ itemId, qty, unitPriceRappen }], idempotencyKey: `${seed}-po` }), 'poUpsert');
  must(poSend(ctx, { poId: po.poId, idempotencyKey: `${seed}-send` }), 'poSend');
  const lineId = ctx.store.db.prepare('SELECT id FROM po_line WHERE workspace_id = ? AND po_id = ?').get(ctx.workspaceId, po.poId).id;
  return { vendorId: vId, itemId, locationId, poId: po.poId, poLineId: lineId };
}

/** Seed and POST one receipt line against `world`, with a chosen received/expected date and qty. */
function postReceipt(ctx, world, { seed, receivedAt, expectedAt, qty }) {
  const gr = must(
    goodsReceiptCreate(ctx, { poId: world.poId, receivedAt, expectedAt, defaultLocationId: world.locationId, idempotencyKey: `${seed}-c` }),
    'grCreate',
  ).goodsReceipt;
  must(goodsReceiptUpsertLines(ctx, { grId: gr.id, ops: [{ op: 'add', poLineId: world.poLineId, qty }], idempotencyKey: `${seed}-l` }), 'grLines');
  must(goodsReceiptPost(ctx, { grId: gr.id, idempotencyKey: `${seed}-p` }), 'grPost');
  return gr.id;
}

/** Insert a D02 po_match fixture row. FK is toggled off around the insert: the read model joins the */
/** match to its PURCHASE ORDER (a real row), never to the vendor bill, so a synthetic bill_id is safe. */
function insertMatch(ctx, { poId, status, priceVarianceRappen, expectedBaseRappen, overriddenBy = null, matchedAt }) {
  const id = `match_${Math.random().toString(36).slice(2, 10)}`;
  ctx.store.db.pragma('foreign_keys = OFF');
  ctx.store.db
    .prepare(
      `INSERT INTO po_match (id, workspace_id, po_id, bill_id, status, qty_variance, price_variance_rappen,
                             expected_base_rappen, bill_base_rappen, overridden_by, matched_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, poId, `bill_${id}`, status, priceVarianceRappen, expectedBaseRappen, expectedBaseRappen + priceVarianceRappen, overriddenBy, matchedAt, matchedAt);
  ctx.store.db.pragma('foreign_keys = ON');
  return id;
}

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

// ================================================================================================
// 1. THE METRIC MATH, hand-calculable over computeMetrics
// ================================================================================================

test('I05 math: every metric and the weighted score reproduce a hand calculation exactly', () => {
  // Five receipt lines (one rejected) and three matches, chosen so every metric has a clean value.
  const line = (o) => ({
    gr_id: o.gr, gr_number: o.gr, po_id: 'po', po_line_id: o.gr, received_at: o.recv,
    expected_at: o.exp ?? null, qty: o.qty, ordered_qty: o.ord, unit_cost_rappen: 1000, inspection_status: o.insp ?? 'none',
  });
  const lines = [
    line({ gr: 'L1', exp: '2026-03-01', recv: '2026-03-01', qty: 10, ord: 10 }), // on-time, in-full
    line({ gr: 'L2', exp: '2026-03-01', recv: '2026-03-05', qty: 10, ord: 10 }), // 4 days late, in-full
    line({ gr: 'L3', exp: '2026-03-01', recv: '2026-03-02', qty: 8, ord: 10 }), //  on-time (1<=2), short (8<9.8)
    line({ gr: 'L4', exp: null, recv: '2026-03-01', qty: 10, ord: 10 }), //          no due date, in-full
    line({ gr: 'L5', exp: '2026-03-01', recv: '2026-03-01', qty: 5, ord: 10, insp: 'rejected' }), // rejected
  ];
  const match = (o) => ({ id: o.id, po_id: 'po', bill_id: o.id, status: o.st, price_variance_rappen: o.pv, expected_base_rappen: 10000, overridden_by: o.ov ?? null, matched_at: '2026-03-10' });
  const matches = [
    match({ id: 'M1', st: 'matched', pv: 0 }),
    match({ id: 'M2', st: 'overridden', pv: 500, ov: 'u' }),
    match({ id: 'M3', st: 'variance', pv: -1000 }),
  ];

  const m = computeMetrics(lines, matches, DEFAULT_PERFORMANCE_CONFIG);
  const v = m.values;
  assert.equal(v.on_time_pct, 66.7, 'on-time: 2 of 3 due lines');
  assert.equal(v.avg_delay_days, 1.7, 'delay: (0+4+1)/3');
  assert.equal(v.in_full_pct, 75, 'in-full: 3 of 4 evaluated lines');
  assert.equal(v.otif_pct, 33.3, 'otif: 1 of 3 due lines (L1 only)');
  assert.equal(v.qty_variance_pct, 5, 'qty variance: mean(0,0,0.2,0)=0.05');
  assert.equal(v.price_variance_pct, 5, 'price variance: mean(0,0.05,0.1)=0.05');
  assert.equal(v.match_override_rate, 33.3, 'override: 1 of 3 matches');
  assert.equal(v.rejection_rate, 20, 'rejection: 1 of 5 decided lines');
  assert.equal(v.overall_score, 63.4, 'weighted: 33.3*40+95*25+66.7*15+80*10+83*10 over 100');
  assert.equal(m.lines, 4, 'evaluated line count excludes the rejected line');
  assert.equal(m.matches, 3);
  assert.equal(m.spendRappen, 38000, '(10+10+8+10) * 1000');
});

test('I05 math: a metric with no contributing data is null, never a fabricated zero', () => {
  const m = computeMetrics([], [], DEFAULT_PERFORMANCE_CONFIG);
  for (const id of ['otif_pct', 'on_time_pct', 'in_full_pct', 'avg_delay_days', 'qty_variance_pct', 'price_variance_pct', 'match_override_rate', 'rejection_rate', 'overall_score']) {
    assert.equal(m.values[id], null, `${id} on empty data must be null`);
  }
});

test('I05 math: the weighted score renormalises over present metrics when matches are absent', () => {
  // Only delivery data: price and override are null, so their 40 points of weight drop out and the
  // score is computed over otif/rejection/delay alone, not diluted toward zero.
  const lines = [
    { gr_id: 'A', gr_number: 'A', po_id: 'po', po_line_id: 'A', received_at: '2026-03-01', expected_at: '2026-03-01', qty: 10, ordered_qty: 10, unit_cost_rappen: 1000, inspection_status: 'none' },
  ];
  const m = computeMetrics(lines, [], DEFAULT_PERFORMANCE_CONFIG);
  // otif 100 (w40), rejection 0%->norm100 (w10), delay 0->norm100 (w10); price/override absent.
  assert.equal(m.values.price_variance_pct, null);
  assert.equal(m.values.match_override_rate, null);
  assert.equal(m.values.overall_score, 100, 'a perfect delivery record scores 100 with no match data');
});

// ================================================================================================
// 2. THE LIVE PATH: real receipts + a po_match fixture, through the engine verbs
// ================================================================================================

/** One supplier, two POs, two posted receipts (one on-time, one 10 days late), plus one override match. */
function seedSupplier(ctx) {
  const vendorId = must(createContact(ctx, { partyRole: 'vendor', name: 'Haupt Lieferant', idempotencyKey: 'sup-v' }), 'v').contact.id;
  const p1 = sentPo(ctx, { seed: 'r1', qty: 6, vendorId });
  postReceipt(ctx, p1, { seed: 'r1', receivedAt: '2026-03-10', expectedAt: '2026-03-10', qty: 6 }); // on-time, in-full
  const p2 = sentPo(ctx, { seed: 'r2', qty: 4, vendorId });
  postReceipt(ctx, p2, { seed: 'r2', receivedAt: '2026-03-20', expectedAt: '2026-03-10', qty: 4 }); // 10 days late, in-full
  return { vendorId, p1, p2 };
}

test('I05 live: the scorecard delivery metrics match the seeded receipts', () => {
  const { ctx } = freshCtx();
  const { vendorId } = seedSupplier(ctx);
  const sc = must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'scorecard');
  assert.equal(sc.empty, false);
  assert.equal(sc.counts.receipts, 2);
  assert.equal(sc.counts.matches, 0, 'no matches seeded yet');
  const byId = Object.fromEntries(sc.metrics.map((x) => [x.id, x.value]));
  assert.equal(byId.on_time_pct, 50, '1 of 2 on time');
  assert.equal(byId.in_full_pct, 100, 'both in full');
  assert.equal(byId.otif_pct, 50);
  assert.equal(byId.avg_delay_days, 5, '(0 + 10) / 2');
  assert.equal(byId.price_variance_pct, null, 'no match data');
  assert.equal(byId.overall_score, 58.3, 'otif 50*w40 + rejection 100*w10 + delay 50*w10 over 60');
  assert.equal(sc.overallScore, 58.3);
  // The late delivery surfaces as the top exception with its deep-link ids.
  assert.ok(sc.exceptions.some((e) => e.kind === 'late_delivery' && e.detail.delayDays === 10 && typeof e.poId === 'string'));
});

test('I05 live: a po_match feeds the price-variance and override metrics', () => {
  const { ctx } = freshCtx();
  const { p1 } = seedSupplier(ctx);
  insertMatch(ctx, { poId: p1.poId, status: 'overridden', priceVarianceRappen: 200, expectedBaseRappen: 10000, overriddenBy: 'buyer', matchedAt: '2026-03-15' });
  const sc = must(supplierScorecardGet(ctx, { supplierId: p1.vendorId, from: MARCH.from, to: MARCH.to }), 'scorecard');
  assert.equal(sc.counts.matches, 1);
  const byId = Object.fromEntries(sc.metrics.map((x) => [x.id, x.value]));
  assert.equal(byId.price_variance_pct, 2, 'abs(200)/10000 = 2%');
  assert.equal(byId.match_override_rate, 100, '1 of 1 overridden');
  assert.ok(sc.exceptions.some((e) => e.kind === 'price_override' && e.matchId));
});

test('I05 live: a foreign supplier id is not_found (tenant isolation), and B receipts never reach A', () => {
  // Both workspaces in ONE store, the receipt-suite §H-TENANT pattern: workspace A probed with B's
  // REAL id proves the fence, where two separate stores would only prove two databases are distinct.
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const wsA = createWorkspace(deps, { name: 'Mandant A' }).workspaceId;
  const wsB = createWorkspace(deps, { name: 'Mandant B' }).workspaceId;
  const ctxA = makeContext(store, { workspaceId: wsA, actor: 'a', clock, ids, periods: makePeriodPort({ store, workspaceId: wsA }) });
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'b', clock, ids, periods: makePeriodPort({ store, workspaceId: wsB }) });
  const { vendorId: aVendor } = seedSupplier(ctxA);
  const { vendorId: bVendor } = seedSupplier(ctxB);
  assert.notEqual(aVendor, bVendor, 'the two suppliers have distinct ids');
  // A's engine cannot name B's supplier.
  const denied = supplierScorecardGet(ctxA, { supplierId: bVendor, from: MARCH.from, to: MARCH.to });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'not_found');
  // A's own supplier is scored only on A's data.
  const own = must(supplierScorecardGet(ctxA, { supplierId: aVendor, from: MARCH.from, to: MARCH.to }), 'own');
  assert.equal(own.counts.receipts, 2, 'exactly A two receipts, never B');
});

test('I05 live: an empty window answers ok with an empty-state, not an error', () => {
  const { ctx } = freshCtx();
  const vendorId = must(createContact(ctx, { partyRole: 'vendor', name: 'Ruhiger Lieferant', idempotencyKey: 'idle-v' }), 'v').contact.id;
  const sc = must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'scorecard');
  assert.equal(sc.empty, true);
  assert.equal(sc.overallScore, null);
  assert.equal(sc.counts.receipts, 0);
});

test('I05 live: a reversed receipt leaves every subsequent calculation', () => {
  const { ctx } = freshCtx();
  const { vendorId, p1 } = seedSupplier(ctx);
  const before = must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'before').counts.receipts;
  // Reverse the first receipt (find its posted GR doc for p1's PO).
  const grId = ctx.store.db.prepare("SELECT id FROM goods_receipt_doc WHERE workspace_id = ? AND po_id = ? AND status = 'posted'").get(ctx.workspaceId, p1.poId).id;
  must(goodsReceiptReverse(ctx, { grId, reason: 'Fehllieferung', idempotencyKey: 'rev-1' }), 'reverse');
  const after = must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'after').counts.receipts;
  assert.equal(before, 2);
  assert.equal(after, 1, 'the reversed receipt is gone from the scorecard');
});

test('I05 live: rank orders active suppliers and flags thin activity as insufficient', () => {
  const { ctx } = freshCtx();
  seedSupplier(ctx); // supplier with 2 receipts
  const thin = sentPo(ctx, { seed: 'thin', qty: 3 });
  postReceipt(ctx, thin, { seed: 'thin', receivedAt: '2026-03-12', expectedAt: '2026-03-12', qty: 3 }); // 1 receipt
  const ranked = must(supplierPerformanceRank(ctx, { metric: 'overall_score', from: MARCH.from, to: MARCH.to, minActivity: 2 }), 'rank');
  assert.ok(ranked.rows.length >= 1, 'the 2-receipt supplier is ranked');
  assert.ok(ranked.insufficient.some((r) => r.activityCount < 2), 'the 1-receipt supplier is flagged insufficient');
  assert.ok(ranked.rows.every((r) => r.activityCount >= 2));
});

test('I05 live: trend returns one point per window, oldest first, gaps as null', () => {
  const { ctx } = freshCtx();
  const { vendorId } = seedSupplier(ctx);
  const tr = must(supplierPerformanceTrend(ctx, { supplierId: vendorId, metric: 'otif_pct', periods: 3, windowDays: 30, to: '2026-03-31' }), 'trend');
  assert.equal(tr.points.length, 3);
  assert.ok(tr.points[tr.points.length - 1].value !== null, 'the window covering March has data');
  // Oldest first: the from dates ascend.
  assert.ok(tr.points[0].from < tr.points[2].from);
});

test('I05 live: explain returns the formula, the config used and the contributing source ids', () => {
  const { ctx } = freshCtx();
  const { vendorId } = seedSupplier(ctx);
  const ex = must(supplierPerformanceExplain(ctx, { supplierId: vendorId, metric: 'otif_pct', from: MARCH.from, to: MARCH.to }), 'explain');
  assert.match(ex.formula, /on-time/i);
  assert.equal(ex.config.onTimeToleranceDays, 2);
  assert.ok(ex.sources.length >= 2, 'both receipt lines are cited');
  assert.ok(ex.sources.every((s) => typeof s.receiptId === 'string'));
});

test('I05 live: alerts surface a supplier breaching a configured threshold', () => {
  const { ctx } = freshCtx();
  seedSupplier(ctx); // otif is 50, below a 90 threshold
  const al = must(supplierPerformanceAlerts(ctx, { asOf: '2026-03-31', windowDays: 90, configOverride: { alertThresholds: { otif_pct: 90 } } }), 'alerts');
  assert.ok(al.alerts.some((a) => a.metric === 'otif_pct' && a.value === 50 && a.threshold === 90 && a.breached));
});

test('I05 live: a scorecard read mutates NOT ONE row', () => {
  const { ctx, store } = freshCtx();
  const { vendorId } = seedSupplier(ctx);
  const dump = () => {
    const tables = store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all();
    return tables.map((t) => `${t.name}:${store.db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n}`).join('|');
  };
  const before = dump();
  must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'scorecard');
  must(supplierPerformanceRank(ctx, { from: MARCH.from, to: MARCH.to }), 'rank');
  must(supplierPerformanceAlerts(ctx, { asOf: '2026-03-31' }), 'alerts');
  assert.equal(dump(), before, 'a supplier-performance read changed a row count somewhere');
});

test('I05 pure: identical inputs yield the identical scorecard (referential transparency)', () => {
  const { ctx } = freshCtx();
  const { vendorId } = seedSupplier(ctx);
  const one = must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'one');
  const two = must(supplierScorecardGet(ctx, { supplierId: vendorId, from: MARCH.from, to: MARCH.to }), 'two');
  assert.deepEqual(one.metrics, two.metrics);
  assert.equal(one.overallScore, two.overallScore);
});

// ================================================================================================
// 3. READ-ONLY, structurally (P5)
// ================================================================================================

const ENGINE_FILE = fileURLToPath(new URL('../../src/core/procurement/supplier-performance.ts', import.meta.url));
const ACTIONS_FILE = fileURLToPath(new URL('../../src/api/supplier-performance-actions.ts', import.meta.url));

function importsOf(text) {
  return [...text.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]);
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('I05 P5: read-only, structurally: no writer import, no non-SELECT SQL, no DDL, five read verbs', () => {
  const FORBIDDEN = ['postEntry', 'recordPayment', '/ledger/', '/payments/', 'inventoryMove'];
  for (const file of [ENGINE_FILE, ACTIONS_FILE]) {
    const text = readFileSync(file, 'utf8');
    const imports = importsOf(text).join('\n');
    for (const forbidden of FORBIDDEN) {
      assert.equal(imports.includes(forbidden), false, `${file} imports ${forbidden}: the read model grew a money path`);
    }
    const code = stripComments(text);
    for (const m of code.matchAll(/\.prepare\(\s*(?:'([^']*)'|`([^`]*)`)/g)) {
      const sql = (m[1] ?? m[2] ?? '').trim();
      assert.match(sql, /^SELECT/i, `${file} prepares non-SELECT SQL: ${sql.slice(0, 60)}`);
    }
    assert.equal(code.includes('SCHEMA_SQL'), false, `${file} declares DDL: I05 owns zero tables`);
    assert.equal(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i.test(code), false, `${file} carries write SQL`);
  }

  for (const name of ['supplier_scorecard_get', 'supplier_performance_rank', 'supplier_performance_trend', 'supplier_performance_explain', 'supplier_performance_alerts']) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name} is not registered`);
    assert.equal(action.kind, 'read', `${name} must be a read`);
    assert.equal('idempotencyKey' in (action.inputSchema.properties ?? {}), false, `${name} must not take a key`);
  }
});
