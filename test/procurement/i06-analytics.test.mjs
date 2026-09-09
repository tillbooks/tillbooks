// I06, procurement analytics & agent tools: the spec's §4/§7 guarantees, proven three ways.
//
//   1. THE MONEY IDENTITIES, over REAL seeded PO / receipt / bill / match documents driven through
//      the registered verbs: open-commitment residual == recomputed (ordered - billed) x base price,
//      GR/IR RNI residual == (received - billed) x base price, spend == the counters x base price,
//      and PO-history running open == the live commitment.
//   2. TENANT ISOLATION (§H-TENANT): a foreign po_id is not_found before any computation, and one
//      workspace's analytics never see another's documents.
//   3. READ-ONLY, structurally (P5, the I05 / C03 precedent): the module is INCAPABLE of writing
//      (no writer import, no non-SELECT SQL, no DDL), and every verb leaves the whole database byte
//      for byte unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refused = (res, code, what) => {
  assert.equal(res.ok, false, `${what} should be refused`);
  if (code !== undefined) assert.equal(res.error, code, `${what}: wrong error (${JSON.stringify(res)})`);
  return res;
};

/** A whole-database fingerprint, the conformance snapshot shape, to prove a read wrote nothing. */
function snapshot(deps) {
  const tables = deps.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) {
    out[t] = deps.store.db.prepare(`SELECT * FROM "${t}"`).all();
  }
  return JSON.stringify(out);
}

/** A workspace + vendor + stock item + location. */
function seed(key) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Einkauf AG', `i06-${key}`);
  const vendor = must(call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${key}-v` }), 'create_contact').contact.id;
  const item = must(call(deps, 'create_item', { workspaceId, name: 'Rohstoff', defaultUnitPriceMinor: 12000, idempotencyKey: `${key}-i` }), 'create_item').item.id;
  deps.store.db.prepare('UPDATE item SET track_stock = 1, cost_price_minor = ? WHERE workspace_id = ? AND id = ?').run(9000, workspaceId, item);
  const location = must(call(deps, 'stock_location_upsert', { workspaceId, name: 'Wareneingang', idempotencyKey: `${key}-l` }), 'stock_location_upsert').location.id;
  return { deps, workspaceId, accId, vendor, item, location };
}

/** A sent PO for `qty` units at net `unit` Rappen; returns po id + first line id. */
function sentPo(s, key, qty, unit) {
  const po = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, lines: [{ itemId: s.item, qty, unitPriceRappen: unit }], idempotencyKey: `${key}-po` }), 'po_upsert');
  must(call(s.deps, 'po_send', { workspaceId: s.workspaceId, poId: po.poId, idempotencyKey: `${key}-send` }), 'po_send');
  const lineId = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: po.poId }).lines[0].id;
  return { poId: po.poId, lineId };
}

/** Receive `qty` via the D02 receipt path (increments po_line.received_qty). Key is unique per call. */
let receiveSeq = 0;
function receive(s, key, poId, lineId, qty) {
  receiveSeq += 1;
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty }], idempotencyKey: `${key}-r-${receiveSeq}` }), 'receipt_record');
}

/** A CHF bill (net == base, no VAT). */
function chfBill(s, key, netRappen) {
  return must(call(s.deps, 'create_vendor_bill', { workspaceId: s.workspaceId, vendorId: s.vendor, billDate: '2026-03-05', amountMinor: netRappen, amountIsGross: false, expenseAccountId: s.accId('6500'), idempotencyKey: `${key}-bill` }), 'create_vendor_bill').vendorBillId;
}

/** Evaluate and CREATE an in-tolerance three-way match (increments billed_qty by the open received qty). */
function matchBill(s, key, billId) {
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId }), 'evaluate').evaluation;
  return must(call(s.deps, 'match_three_way_create', { workspaceId: s.workspaceId, billId, evaluation, idempotencyKey: `${key}-m` }), 'create').match;
}

// ================================================================================================
// 1. MONEY IDENTITIES over real documents
// ================================================================================================

test('I06 open commitments: residual == (ordered - billed) x base price, and the total is the sum', () => {
  const s = seed('oc');
  const { poId, lineId } = sentPo(s, 'oc', 10, 10000); // net total 100'000
  receive(s, 'oc', poId, lineId, 6);
  const bill = chfBill(s, 'oc', 60000); // matches the 6 received units
  matchBill(s, 'oc', bill); // billed_qty -> 6

  const res = must(call(s.deps, 'procurement_open_commitments', { workspaceId: s.workspaceId }), 'open_commitments');
  assert.equal(res.rows.length, 1, 'one open line');
  const row = res.rows[0];
  assert.equal(row.orderedQty, 10);
  assert.equal(row.billedQty, 6);
  assert.equal(row.openQty, 4, 'open == ordered - billed');
  assert.equal(row.openValueRappen, 4 * 10000, 'residual value == open x base price');
  // The tripwire: the footer total equals the recomputed residual under the same filter.
  const recomputed = res.rows.reduce((n, r) => n + r.openValueRappen, 0);
  assert.equal(res.totals.open_value_rappen, recomputed, 'total == sum of residual line values');
  assert.equal(res.totals.count, 1);
});

test('I06 GR/IR: RNI residual == (received - billed) x base price; INR the mirror; net exposure', () => {
  const s = seed('gr');
  const { poId, lineId } = sentPo(s, 'gr', 10, 10000);
  receive(s, 'gr', poId, lineId, 6);
  const bill = chfBill(s, 'gr', 60000);
  matchBill(s, 'gr', bill); // billed 6
  receive(s, 'gr', poId, lineId, 4); // received now 10, billed 6 -> RNI 4

  const res = must(call(s.deps, 'procurement_grir_clearing', { workspaceId: s.workspaceId, include_detail: true }), 'grir');
  assert.equal(res.received_not_invoiced.count, 1, 'one RNI line');
  assert.equal(res.received_not_invoiced.residual_value_rappen, 4 * 10000, 'RNI residual == (recv - billed) x price');
  assert.equal(res.invoiced_not_received.count, 0, 'no INR');
  assert.equal(res.net_exposure_rappen, 4 * 10000, 'net == RNI - INR');
  assert.equal(res.status, 'exposure_present');
  const detail = res.received_not_invoiced.rows[0];
  assert.equal(detail.residualQty, 4);
});

test('I06 spend summary: grouped value == the counters x base price', () => {
  const s = seed('sp');
  const { poId, lineId } = sentPo(s, 'sp', 10, 10000);
  receive(s, 'sp', poId, lineId, 6);
  const bill = chfBill(s, 'sp', 60000);
  matchBill(s, 'sp', bill);

  const res = must(call(s.deps, 'procurement_spend_summary', { workspaceId: s.workspaceId, group_by: 'supplier' }), 'spend');
  assert.equal(res.rows.length, 1);
  const row = res.rows[0];
  assert.equal(row.key, s.vendor);
  assert.equal(row.ordered_rappen, 10 * 10000);
  assert.equal(row.received_rappen, 6 * 10000);
  assert.equal(row.billed_rappen, 6 * 10000);
  assert.equal(row.document_count, 1);
  assert.equal(res.grand_total.billed_rappen, 6 * 10000);
});

test('I06 match status: an in-tolerance match is clean; an override is an exception', () => {
  const s = seed('ms');
  const { poId, lineId } = sentPo(s, 'ms', 10, 10000);
  receive(s, 'ms', poId, lineId, 10);
  const bill = chfBill(s, 'ms', 100000); // exact -> matched
  matchBill(s, 'ms', bill);

  const clean = must(call(s.deps, 'procurement_match_status', { workspaceId: s.workspaceId }), 'match_status clean');
  assert.equal(clean.status, 'clean', 'a fully matched bill is clean');
  assert.equal(clean.summary.matched.count, 1);
  assert.equal(clean.exceptions.length, 0);

  // A second PO+bill forced through as an out-of-tolerance override.
  const p2 = sentPo(s, 'ms2', 10, 10000);
  receive(s, 'ms2', p2.poId, p2.lineId, 10);
  const bill2 = chfBill(s, 'ms2', 120000); // +20% variance
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId: bill2 }), 'evaluate2').evaluation;
  must(call(s.deps, 'match_three_way_override', { workspaceId: s.workspaceId, billId: bill2, evaluation, reason: 'Preisdifferenz vereinbart', idempotencyKey: 'ms2-ovr' }), 'override');

  const withExc = must(call(s.deps, 'procurement_match_status', { workspaceId: s.workspaceId }), 'match_status exc');
  assert.equal(withExc.status, 'exceptions_present');
  const exc = withExc.exceptions.find((e) => e.billId === bill2);
  assert.ok(exc !== undefined, 'the overridden match is surfaced as an exception');
  assert.equal(exc.status, 'overridden');
  assert.equal(exc.suggestedNextAction, 'review_override');
  assert.equal(exc.toleranceBreached, true);
});

test('I06 PO history: the running open figure closes to the live commitment', () => {
  const s = seed('hist');
  const { poId, lineId } = sentPo(s, 'hist', 10, 10000);
  receive(s, 'hist', poId, lineId, 6);
  const bill = chfBill(s, 'hist', 60000);
  matchBill(s, 'hist', bill);

  const res = must(call(s.deps, 'procurement_po_history', { workspaceId: s.workspaceId, po_id: poId }), 'po_history');
  const types = res.events.map((e) => e.event_type);
  assert.ok(types.includes('created'), 'timeline has creation');
  assert.ok(types.includes('goods_received'), 'timeline has the receipt');
  assert.ok(types.includes('matched'), 'timeline has the match');
  assert.equal(res.running_open_qty, 4, 'running open qty == ordered - billed');
  assert.equal(res.running_open_value_rappen, 4 * 10000, 'running open value == live commitment');
});

test('I06 anomalies: an out-of-tolerance override surfaces as a match anomaly', () => {
  const s = seed('anom');
  const { poId, lineId } = sentPo(s, 'anom', 10, 10000);
  receive(s, 'anom', poId, lineId, 10);
  const bill = chfBill(s, 'anom', 120000);
  const evaluation = must(call(s.deps, 'match_three_way_evaluate', { workspaceId: s.workspaceId, billId: bill }), 'evaluate').evaluation;
  must(call(s.deps, 'match_three_way_override', { workspaceId: s.workspaceId, billId: bill, evaluation, reason: 'vereinbart', idempotencyKey: 'anom-ovr' }), 'override');

  const res = must(call(s.deps, 'procurement_anomalies', { workspaceId: s.workspaceId, since: '2026-01-01' }), 'anomalies');
  const kinds = res.anomalies.map((a) => a.type);
  assert.ok(kinds.includes('match_override_high_value'), `expected a match override anomaly, got ${JSON.stringify(kinds)}`);
});

test('I06 requisition pipeline + supplier scorecard + landed-cost + cycle answer ok and count correctly', () => {
  const s = seed('misc');
  must(call(s.deps, 'requisition_upsert', { workspaceId: s.workspaceId, neededBy: '2026-09-01', urgency: 'normal', description: 'Bedarf', lines: [{ description: 'Schmiermittel', qtyMilli: 2000, estimatedUnitCostRappen: 5000 }], idempotencyKey: 'misc-rq' }), 'requisition_upsert');

  const pipe = must(call(s.deps, 'procurement_requisition_pipeline', { workspaceId: s.workspaceId }), 'pipeline');
  assert.equal(pipe.summary.draft.count, 1, 'one draft requisition');
  assert.equal(pipe.conversion.total, 1);

  // A PO so the supplier is active in the window.
  const { poId, lineId } = sentPo(s, 'misc', 5, 10000);
  receive(s, 'misc', poId, lineId, 5);
  const sc = must(call(s.deps, 'procurement_supplier_scorecard', { workspaceId: s.workspaceId }), 'scorecard');
  assert.equal(sc.rows.length, 1, 'one active supplier');
  assert.equal(sc.rows[0].supplierId, s.vendor);

  const lc = must(call(s.deps, 'procurement_landed_cost_variance', { workspaceId: s.workspaceId }), 'landed');
  assert.deepEqual(lc.rows, [], 'no landed-cost activity -> empty ok');
  const cyc = must(call(s.deps, 'procurement_po_cycle', { workspaceId: s.workspaceId, from_date: '2026-01-01', to_date: '2026-12-31' }), 'cycle');
  assert.ok(cyc.ok !== false);
});

// ================================================================================================
// 2. TENANT ISOLATION
// ================================================================================================

test('I06 §H-TENANT: a foreign po_id is not_found and analytics never cross the fence', () => {
  const a = seed('ta');
  const b = seed('tb');
  const pa = sentPo(a, 'ta', 4, 10000);
  receive(a, 'ta', pa.poId, pa.lineId, 4);

  // B cannot read A's PO history: a foreign id is not_found BEFORE any computation.
  refused(call(b.deps, 'procurement_po_history', { workspaceId: b.workspaceId, po_id: pa.poId }), 'not_found', 'B reads A po_history');

  // B's own commitments are empty; A's are not: no leakage.
  const bCommit = must(call(b.deps, 'procurement_open_commitments', { workspaceId: b.workspaceId }), 'B commitments');
  assert.equal(bCommit.rows.length, 0, 'B sees none of A');
  const aCommit = must(call(a.deps, 'procurement_open_commitments', { workspaceId: a.workspaceId }), 'A commitments');
  assert.equal(aCommit.rows.length, 1, 'A sees its own');
});

// ================================================================================================
// 3. READ-ONLY, structurally + by whole-database snapshot
// ================================================================================================

const VERBS = [
  'procurement_open_commitments',
  'procurement_match_status',
  'procurement_spend_summary',
  'procurement_supplier_scorecard',
  'procurement_requisition_pipeline',
  'procurement_grir_clearing',
  'procurement_landed_cost_variance',
  'procurement_po_cycle',
  'procurement_anomalies',
  'procurement_po_history',
];

test('I06 P5: every verb leaves the whole database byte for byte unchanged', () => {
  const s = seed('ro');
  const { poId, lineId } = sentPo(s, 'ro', 10, 10000);
  receive(s, 'ro', poId, lineId, 6);
  const bill = chfBill(s, 'ro', 60000);
  matchBill(s, 'ro', bill);

  const inputs = {
    procurement_open_commitments: {},
    procurement_match_status: {},
    procurement_spend_summary: { group_by: 'supplier' },
    procurement_supplier_scorecard: {},
    procurement_requisition_pipeline: {},
    procurement_grir_clearing: {},
    procurement_landed_cost_variance: {},
    procurement_po_cycle: { from_date: '2026-01-01', to_date: '2026-12-31' },
    procurement_anomalies: { since: '2026-01-01' },
    procurement_po_history: { po_id: poId },
  };
  for (const name of VERBS) {
    const before = snapshot(s.deps);
    must(call(s.deps, name, { workspaceId: s.workspaceId, ...inputs[name] }), name);
    const after = snapshot(s.deps);
    assert.equal(before, after, `${name} mutated the database`);
  }
});

const ENGINE_FILE = fileURLToPath(new URL('../../src/core/procurement/analytics.ts', import.meta.url));
const ACTIONS_FILE = fileURLToPath(new URL('../../src/api/procurement-analytics-actions.ts', import.meta.url));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('I06 P5: read-only, structurally: no writer import, no non-SELECT SQL, no DDL, ten read verbs', () => {
  const FORBIDDEN = ['postEntry', 'recordPayment', '/ledger/', '/payments/', 'inventoryMove'];
  for (const file of [ENGINE_FILE, ACTIONS_FILE]) {
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]).join('\n');
    for (const forbidden of FORBIDDEN) {
      assert.equal(imports.includes(forbidden), false, `${file} imports ${forbidden}: the read model grew a money path`);
    }
    const code = stripComments(text);
    for (const m of code.matchAll(/\.prepare\(\s*(?:'([^']*)'|`([^`]*)`)/g)) {
      const sql = (m[1] ?? m[2] ?? '').trim();
      assert.match(sql, /^SELECT/i, `${file} prepares non-SELECT SQL: ${sql.slice(0, 60)}`);
    }
    assert.equal(code.includes('SCHEMA_SQL'), false, `${file} declares DDL: I06 owns zero tables`);
    assert.equal(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i.test(code), false, `${file} carries write SQL`);
  }

  for (const name of VERBS) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name} is not registered`);
    assert.equal(action.kind, 'read', `${name} must be a read`);
    assert.equal('idempotencyKey' in (action.inputSchema.properties ?? {}), false, `${name} must not take a key`);
  }
});
