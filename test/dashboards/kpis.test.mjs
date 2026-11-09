// D186, the Übersicht's new key figures, held to the F00 anti-drift contract: each figure is a source's own
// answer, and the two money claims the owner asked for are measured against the act they predict.
//
//  - The ESTIMATED turnover of an open line equals, to the Rappen, what booking that line then adds to the
//    revenue tile (the preview IS the booking), and it is gone once the line is booked.
//  - The BANK figure is A39's balance line: bank = booked + open + difference, the same numbers the Bank
//    page's Abgleich shows (`list_bank_inbox` summary).
//  - Comparisons are like for like: the running month against the same days of the month before / the
//    year before.
//
// Synthetic by construction: the A39 suite's hand-spelled statements and invented names.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, bookBankLine, setBankStandard } from '../../dist/core/banking/index.js';
import { dashboardOverview, dashboardTile, dashboardRevenueEstimate, TILE_REGISTRY, DASHBOARD_TILES } from '../../dist/core/dashboards/index.js';
import { compareWindow, comparedThrough } from '../../dist/core/dashboards/compare.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { assertClaimInvariantHolds, world, importLines, must, issueInvoice, rowCounts } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const PAYOUT = 'Zahlwerk Beispiel Ltd';

const tileOf = (overview, id) => {
  const tile = overview.tiles.find((t) => t.tile === id);
  assert.ok(tile !== undefined, `the ${id} tile is missing`);
  return tile;
};
const overviewOf = (t, ctx = t.ctx, extra = {}) => must(dashboardOverview(ctx, { ...RANGE, ...extra }), 'overview');

/** One payout line on a factor rule (gross on 3400 with UST81 computed, the rest a fee on 4400), one invoice paid by QR, one fee. */
function scene() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'k1' });
  const { lines } = importLines(t, {
    statementId: 'KPI-A',
    openingMinor: 500000,
    entries: [
      { ref: 'P1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG P1' },
      { ref: 'Q1', amountMinor: 108100, cd: 'CRDT', qrr: buildQrrReference(inv.number), name: 'Muster AG' },
      { ref: 'FEE', amountMinor: 500, cd: 'DBIT', name: 'Kontoführung', ustrd: 'Preis für die Kontoführung Juli' },
    ],
  });
  const recipe = [
    { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
  // The D177 worked recipe (the payout service's shape): the gross turnover is 1081/180 of the payout, its
  // MWST computed by the UST81 code, and the rest (negative: the fee kept back) on 4400, via 1095.
  const rule = must(setBankStandard(t.ctx, { bankTxnId: lines.P1, legs: recipe, viaAccountId: t.acc('1095'), label: 'Plattform', idempotencyKey: 'rule' })).standard;
  return { t, lines, inv, rule };
}

test('the registry: every D186 tile is registered once, with gates its sources hold', () => {
  for (const id of ['bank_balance', 'free_cash', 'runway', 'low_point', 'expense', 'result', 'margin', 'revenue_ltm', 'dso', 'top_customer', 'auto_rate', 'receipt_rate']) {
    assert.ok(DASHBOARD_TILES.includes(id), id);
    assert.equal(TILE_REGISTRY.filter((d) => d.tile === id).length, 1, id);
  }
  assert.equal(TILE_REGISTRY.length, DASHBOARD_TILES.length, 'every enum id has its one registry row');
  assert.equal(DASHBOARD_TILES[0], 'bank_balance', 'the money on the bank leads the default order');
  const bank = TILE_REGISTRY.find((d) => d.tile === 'bank_balance');
  for (const cap of requiredCapabilitiesFor('list_bank_inbox', {})) assert.ok(bank.requires.includes(cap), `bank_balance holds list_bank_inbox's ${cap}`);
  const est = requiredCapabilitiesFor('dashboard_revenue_estimate', {});
  assert.deepEqual([...est].sort(), ['read_books', 'read_sales']);
});

test('[money] the estimate of an open line equals what booking it adds to the revenue tile, and it is gone once booked', () => {
  const { t, lines } = scene();
  const before = overviewOf(t);
  const revenue = tileOf(before, 'revenue');
  const est = must(dashboardRevenueEstimate(t.ctx, RANGE), 'estimate');
  assert.equal(est.lines.length, 1, JSON.stringify(est));
  const [line] = est.lines;
  assert.equal(line.bankTxnId, lines.P1);
  assert.equal(line.basis, 'rule');
  // The computed-factor rule is `check` in the inbox until it earns `sure`; the `rules` basis counts it
  // anyway, because a Buchungsregel is the person's own instruction (a sure/learned-only basis would drop it).
  assert.equal(line.certainty, 'check');
  assert.deepEqual(line.accountNumbers, ['3400']);
  // 30.00 x 1081/180 = 180.17 gross on 3400 with UST81: its net is the Nettoerlös the line adds.
  assert.equal(line.revenueMinor, 16667, 'the gross 180.17 less MWST 8.1 % (13.50), as the composer splits it');
  assert.equal(est.revenueMinor, line.revenueMinor);
  assert.equal(revenue.estimate.revenueMinor, est.revenueMinor, 'the tile carries the verb\'s figure');
  assert.equal(revenue.estimate.lineCount, 1);
  // The QR payment settles the invoice (its turnover was booked at issue); the fee is no revenue.
  assert.equal(est.excluded.settles_document, 1, JSON.stringify(est.excluded));
  assert.equal(est.openLines, 3);
  assert.equal(est.lines.length + Object.values(est.excluded).reduce((a, b) => a + b, 0), est.openLines, 'every open line is counted or excluded');

  // Book the line exactly as its proposal says: the revenue tile moves by the estimate, to the Rappen.
  const p1 = must(listBankInbox(t.ctx, { status: 'open', limit: 200 }), 'inbox').lines.find((l) => l.bankTxnId === lines.P1);
  must(bookBankLine(t.ctx, { bankTxnId: lines.P1, target: p1.proposal.target, idempotencyKey: 'book-p1' }), 'book');
  const after = tileOf(overviewOf(t), 'revenue');
  assert.equal(after.valueRappen - revenue.valueRappen, line.revenueMinor, 'the preview is the booking');
  assert.equal(after.estimate.revenueMinor, 0, 'a booked line leaves the estimate');
  assert.equal(after.estimate.lineCount, 0);
});

test('[money] the estimate counts only the lines dated inside the range', () => {
  const { t } = scene();
  importLines(t, {
    statementId: 'KPI-B',
    from: '2026-08-01',
    to: '2026-08-31',
    openingMinor: 500000 + 3000 + 108100 - 500,
    entries: [{ ref: 'P2', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG P2', date: '2026-08-05' }],
  });
  const july = must(dashboardRevenueEstimate(t.ctx, RANGE), 'july');
  assert.equal(july.openLines, 3, 'the August line is not July\'s');
  assert.equal(july.lines.length, 1);
  const august = must(dashboardRevenueEstimate(t.ctx, { from: '2026-08-01', to: '2026-08-31' }), 'august');
  assert.equal(august.openLines, 1);
  assert.equal(august.revenueMinor, 16667, 'the same rule on the August payout');
});

test('[money] the estimate reads, never writes: a full row census around the verb and the overview', () => {
  const { t } = scene();
  const before = rowCounts(t.store, t.workspaceId);
  must(dashboardRevenueEstimate(t.ctx, RANGE), 'estimate');
  must(dashboardRevenueEstimate(t.ctx, { ...RANGE, basis: 'all' }), 'estimate all');
  overviewOf(t);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

test('the estimate basis is a choice: an unknown one is refused naming the allowed set', () => {
  const { t } = scene();
  const r = dashboardRevenueEstimate(t.ctx, { ...RANGE, basis: 'everything' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_input');
  assert.deepEqual(r.allowed, ['rules', 'all']);
  assert.equal(dashboardOverview(t.ctx, { ...RANGE, runwayMonths: 5 }).error, 'invalid_input');
});

test('[money] bank_balance is A39\'s balance line: bank = booked + open + difference, the Abgleich\'s own numbers', () => {
  const { t } = scene();
  const tile = tileOf(overviewOf(t), 'bank_balance');
  const summary = must(listBankInbox(t.ctx, { status: 'open', limit: 200 }), 'inbox').summary[0];
  const [acc] = tile.accounts;
  assert.equal(acc.bankMinor, summary.bankBalanceMinor);
  assert.equal(acc.bankMinor, 500000 + 3000 + 108100 - 500, 'the statement\'s closing booked balance');
  assert.equal(acc.bookedMinor, summary.ledgerBalanceMinor);
  assert.equal(acc.openMinor, summary.openSumMinor);
  assert.equal(acc.openCount, 3);
  assert.equal(acc.differenceMinor, summary.differenceMinor);
  assert.equal(acc.bankMinor, acc.bookedMinor + acc.openMinor + acc.differenceMinor);
  assert.equal(acc.statementDate, '2026-07-31');
  assert.equal(acc.ibanLast4, '2957');
  assert.equal(tile.valueRappen, acc.bankMinor);
  assert.equal(tile.complete, true);
  assert.equal(tile.asOf, '2026-07-31');
});

test('an account with no statement shows its books and says why, never a bank figure', () => {
  const t = world();
  const tile = tileOf(overviewOf(t), 'bank_balance');
  const [acc] = tile.accounts;
  assert.equal(acc.bankMinor, null);
  assert.equal(acc.reason, 'no_statement');
  assert.equal(tile.complete, false);
  assert.equal(tile.valueRappen, acc.bookedMinor);
});

test('comparisons are like for like: the running month against the same days before', () => {
  const month = { from: '2026-11-01', to: '2026-11-30' };
  const through = comparedThrough(month, '2026-11-09');
  assert.equal(through, '2026-11-09');
  assert.deepEqual(compareWindow('previous_period', month, through), { from: '2026-10-01', to: '2026-10-09' });
  assert.deepEqual(compareWindow('previous_year', month, through), { from: '2025-11-01', to: '2025-11-09' });
  // A finished range compares whole with whole.
  assert.deepEqual(compareWindow('previous_period', { from: '2026-07-01', to: '2026-09-30' }, '2026-09-30'), { from: '2026-04-01', to: '2026-06-30' });
  // A 31st falls to the shorter month's last day; a leap day to the 28th.
  assert.deepEqual(compareWindow('previous_period', { from: '2026-03-01', to: '2026-03-31' }, '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(compareWindow('previous_year', { from: '2028-02-01', to: '2028-02-29' }, '2028-02-29'), { from: '2027-02-01', to: '2027-02-28' });
  // A range that is not whole months keeps the equal-length window before it, cut at the same offset.
  assert.deepEqual(compareWindow('previous_period', { from: '2026-07-10', to: '2026-07-19' }, '2026-07-14'), { from: '2026-06-30', to: '2026-07-04' });
});

test('the cut is a setting: whole_period compares the whole range with the whole earlier one', () => {
  const { t } = scene();
  const revenue = tileOf(overviewOf(t, t.ctx, { compareCut: 'whole_period' }), 'revenue');
  assert.equal(revenue.comparedThrough, '2026-07-31');
  assert.deepEqual([revenue.comparisons.previous_period.from, revenue.comparisons.previous_period.to], ['2026-06-01', '2026-06-30']);
  assert.equal(dashboardOverview(t.ctx, { ...RANGE, compareCut: 'sometimes' }).error, 'invalid_input');
});

test('the revenue tile answers both comparisons, and trendBp is the previous period\'s change', () => {
  const { t } = scene();
  const revenue = tileOf(overviewOf(t), 'revenue');
  assert.equal(revenue.comparedThrough, '2026-07-19', 'the fixture clock\'s today');
  assert.deepEqual([revenue.comparisons.previous_period.from, revenue.comparisons.previous_period.to], ['2026-06-01', '2026-06-19']);
  assert.deepEqual([revenue.comparisons.previous_year.from, revenue.comparisons.previous_year.to], ['2025-07-01', '2025-07-19']);
  assert.equal(revenue.trendBp, revenue.comparisons.previous_period.changeBp);
});

test('expense, result and margin are the Erfolgsrechnung\'s, and agree with each other', () => {
  const { t, lines } = scene();
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 500 }] }, idempotencyKey: 'fee' }), 'fee');
  const o = overviewOf(t);
  const revenue = tileOf(o, 'revenue').valueRappen;
  const expense = tileOf(o, 'expense');
  const result = tileOf(o, 'result');
  const margin = tileOf(o, 'margin');
  assert.ok(expense.valueRappen >= 500, 'the fee is an expense');
  assert.equal(result.valueRappen, tileOf(o, 'revenue').detail.reingewinnMinor);
  assert.equal(margin.valueBp, revenue === 0 ? null : Math.round((result.valueRappen * 10000) / revenue));
  assert.equal(margin.changeUnit, 'points');
});

test('auto_rate and receipt_rate count the window\'s decided lines by the inbox\'s own facts', () => {
  const { t, lines } = scene();
  const p1 = must(listBankInbox(t.ctx, { status: 'open', limit: 200 }), 'inbox').lines.find((l) => l.bankTxnId === lines.P1);
  must(bookBankLine(t.ctx, { bankTxnId: lines.P1, target: p1.proposal.target, idempotencyKey: 'p1' }), 'p1');
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 500 }] }, idempotencyKey: 'fee' }), 'fee');
  const o = overviewOf(t);
  const auto = tileOf(o, 'auto_rate');
  assert.equal(auto.detail.decided, 2);
  assert.equal(auto.valueBp, 5000, 'one of two lines booked by its Buchungsregel');
  const receipts = tileOf(o, 'receipt_rate');
  assert.equal(receipts.detail.needing, 1, 'the fee is an outgoing line booked to accounts');
  assert.equal(receipts.detail.missing, 1);
  assert.equal(receipts.valueBp, 0);
});

test('free_cash is the books (bank ledger less 2000 less MWST owed); runway divides the bank figure', () => {
  const { t } = scene();
  const o = overviewOf(t);
  const bank = tileOf(o, 'bank_balance').valueRappen;
  const free = tileOf(o, 'free_cash');
  assert.equal(free.basis, 'books');
  assert.deepEqual(free.detail.bankAccounts, ['1020']);
  assert.equal(free.valueRappen, free.detail.bankMinor - free.detail.payablesMinor - free.detail.vatDueMinor);
  const runway = tileOf(o, 'runway');
  assert.equal(runway.detail.bankMinor, bank);
  assert.equal(runway.detail.months, 6);
  assert.equal(tileOf(overviewOf(t, t.ctx, { runwayMonths: 12 }), 'runway').detail.months, 12);
});

test('RBAC: without read_sales the bank tiles are omitted and the revenue tile carries no estimate', () => {
  const { t } = scene();
  const narrow = { ...t.ctx, capabilities: { ...t.ctx.capabilities, assert: (cap) => (cap === 'read_sales' ? { ok: false, error: 'permission_denied' } : t.ctx.capabilities.assert(cap)) } };
  const o = overviewOf(t, narrow);
  const omitted = o.omitted.map((x) => x.tile);
  for (const id of ['bank_balance', 'free_cash', 'runway', 'auto_rate', 'receipt_rate', 'dso', 'top_customer']) assert.ok(omitted.includes(id), id);
  const revenue = tileOf(o, 'revenue');
  assert.equal('estimate' in revenue, false);
  assert.equal(dashboardTile(narrow, { tile: 'bank_balance', ...RANGE }).error, 'permission_denied');
});
