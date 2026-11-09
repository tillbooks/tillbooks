// Critic D186 (non-author): free_cash, the full row census, comparisons. Synthetic by construction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { listBankInbox, setBankStandard } = await import('../../dist/core/banking/index.js');
const { dashboardOverview, dashboardRevenueEstimate, dashboardSeries, dashboardTile, DASHBOARD_TILES } = await import('../../dist/core/dashboards/index.js');
const { compareWindow, comparedThrough } = await import('../../dist/core/dashboards/compare.js');
const { createAccount } = await import('../../dist/core/accounts/accounts.js');
const { buildQrrReference } = await import('../../dist/core/payments/reference.js');
const ledger = await import('../../dist/core/ledger/index.js');
const { world, importLines, must, postedBill, issueInvoice } = await import('../banking/bank-inbox-support.mjs');

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const tileOf = (o, id) => o.tiles.find((x) => x.tile === id);

test('critic D186-2 (re-cut): an OPEN payment of a bill moves free_cash not at all; free_cash is the books', () => {
  const t = world();
  postedBill(t, { grossMinor: 50000, seed: 'fc', vendorName: 'Druckerei Lindenhof AG' });
  const before = tileOf(must(dashboardOverview(t.ctx, RANGE)), 'free_cash');
  importLines(t, {
    statementId: 'FC',
    openingMinor: 500000,
    entries: [{ ref: 'PAY', amountMinor: 50000, cd: 'DBIT', date: '2026-07-15', name: 'Druckerei Lindenhof AG' }],
  });
  const free = tileOf(must(dashboardOverview(t.ctx, RANGE)), 'free_cash');
  assert.equal(free.basis, 'books');
  assert.equal(free.detail.payablesMinor, 50000, 'the bill is owed on 2000 until the payment is booked');
  assert.equal(free.valueRappen, free.detail.bankMinor - free.detail.payablesMinor - free.detail.vatDueMinor);
  assert.equal(free.valueRappen, before.valueRappen, 'the unbooked payment is counted on neither side');
});

function tableHash(store) {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    const rows = store.db.prepare(`SELECT * FROM "${name}"`).all();
    out[name] = `${rows.length}:${createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 12)}`;
  }
  return out;
}

test('critic D186-3: a FULL census (every table, every row content) around every D186 read', () => {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }));
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'k1' });
  postedBill(t, { grossMinor: 50000, seed: 'cs', vendorName: 'Druckerei Lindenhof AG' });
  const { lines } = importLines(t, {
    statementId: 'CS',
    openingMinor: 500000,
    entries: [
      { ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: 'Zahlwerk Beispiel Ltd', ustrd: 'AUSZAHLUNG P1' },
      { ref: 'Q1', amountMinor: 108100, cd: 'CRDT', qrr: buildQrrReference(inv.number), name: 'Muster AG' },
      { ref: 'PAY', amountMinor: 50000, cd: 'DBIT', name: 'Druckerei Lindenhof AG' },
      { ref: 'FEE', amountMinor: 500, cd: 'DBIT', name: 'Kontoführung', ustrd: 'Preis für die Kontoführung Juli' },
    ],
  });
  const recipe = [
    { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
  must(setBankStandard(t.ctx, { bankTxnId: lines.P1, legs: recipe, viaAccountId: t.acc('1095'), label: 'Plattform', idempotencyKey: 'rule' }));
  const before = tableHash(t.store);
  const changesBefore = t.store.db.prepare('SELECT total_changes() AS n').get().n;
  must(dashboardRevenueEstimate(t.ctx, RANGE));
  must(dashboardRevenueEstimate(t.ctx, { ...RANGE, basis: 'all' }));
  must(dashboardOverview(t.ctx, RANGE));
  must(dashboardOverview(t.ctx, { ...RANGE, runwayMonths: 12, estimateBasis: 'all' }));
  for (const tile of DASHBOARD_TILES) dashboardTile(t.ctx, { tile, ...RANGE });
  must(dashboardSeries(t.ctx, { from: '2026-01-01', to: '2026-12-31' }));
  const changesAfter = t.store.db.prepare('SELECT total_changes() AS n').get().n;
  const after = tableHash(t.store);
  const diff = Object.keys(after).filter((k) => after[k] !== before[k]);
  console.log('total_changes delta', changesAfter - changesBefore, 'changed tables', diff);
  assert.deepEqual(diff, [], 'no table changed');
});

test('critic D186-4: the CURRENT side of a running range is not cut at comparedThrough (a future-dated posting counts on one side only)', () => {
  const t = world();
  const { postEntry } = ledger;
  const post = (date, key) => must(postEntry(t.ctx, { date, source: 'manual', idempotencyKey: key, lines: [{ account: t.acc('1000'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }), key);
  post('2026-06-10', 'jun');
  post('2026-07-10', 'jul');
  post('2026-07-28', 'jul-future'); // after today (fixture clock 19.07.2026), e.g. an invoice dated ahead
  const revenue = tileOf(must(dashboardOverview(t.ctx, RANGE)), 'revenue');
  console.log(revenue.valueRappen, revenue.comparedThrough, JSON.stringify(revenue.comparisons.previous_period));
  // Like for like (both sides up to the 19th): 1000.00 against 1000.00, no change.
  assert.equal(revenue.comparisons.previous_period.changeBp, 0, `current ${revenue.valueRappen} through ${revenue.comparedThrough} vs ${revenue.comparisons.previous_period.value}`);
});

test('critic D186-5: previous_year of a whole leap February cuts the comparison a day short the other way', () => {
  // Feb 2029 (28 days, whole month) against Feb 2028 (29 days): the comparison ends 28.02.2028, the leap
  // day is in neither window.
  const feb = { from: '2029-02-01', to: '2029-02-28' };
  const w = compareWindow('previous_year', feb, comparedThrough(feb, '2029-06-01'));
  assert.deepEqual(w, { from: '2028-02-01', to: '2028-02-29' }, 'a whole month compares with the whole month a year earlier');
});

test('critic D186-8: free_cash is "as of today" but its MWST part follows the PAGE range (a past range subtracts another period\'s VAT)', () => {
  const t = world();
  issueInvoice(t.ctx, { contactId: t.customerId, key: 'vat-inv' }); // 1'000.00 + 81.00 MWST, issued today (19.07.2026)
  const july = tileOf(must(dashboardOverview(t.ctx, RANGE)), 'free_cash');
  const q1 = tileOf(must(dashboardOverview(t.ctx, { from: '2026-01-01', to: '2026-03-31' })), 'free_cash');
  console.log(JSON.stringify({ july: [july.valueRappen, july.asOf, july.detail.vatDueMinor], q1: [q1.valueRappen, q1.asOf, q1.detail.vatDueMinor] }));
  assert.equal(july.asOf, q1.asOf, 'both say they are as of today');
  assert.equal(q1.valueRappen, july.valueRappen, 'a current figure does not depend on the page range');
});
