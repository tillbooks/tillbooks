// D203, the Umsatz figures from the books: `turnover_summary` and `settlement_periods` (A42 section 16).
// SYNTHETIC BY CONSTRUCTION: the platform "Kurswerk", the processor "Zahlfix", the customers, every id, document
// number and amount below is invented from scratch for these tests. Nothing is derived from any real book.
//
// THE FOUR MONEY-PATH INVARIANTS (a non-author confirms they bite, CLAUDE.md "The money path is unforgiving"):
//   [INVARIANT summary-equals-erfolgsrechnung] the turnover equals the Erfolgsrechnung's 3xxx lines to the Rappen
//   [INVARIANT payout-never-turnover]          a payout-only period sums to zero turnover
//   [INVARIANT book-idempotent]                re-running the review and Buchen does not double-count
//   [INVARIANT tenant]                         every new query names the workspace

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { importSettlement, settlementReview, turnoverSummary, settlementPeriods, compareWindowOf, setSettlementTemplate } from '../../dist/core/settlement/index.js';
import { computeIncomeStatement } from '../../dist/core/reports/statements.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { saveDraft } from '../../dist/core/ledger/draft.js';
import { reverseOwnedEntry } from '../../dist/core/ledger/reverseEntry.js';
import { hardCloseYear } from '../../dist/core/ledger/yearClose.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { issueInvoice, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, setTemplate, templateKinds, must, refused, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const ev = (id, kind, day, amount, net, vat, refs = {}) => ({
  id,
  kind,
  day,
  currency: 'CHF',
  amount,
  net,
  vat: vat === null ? null : { amount: vat, code: 'PRODUCER-CODE', rate: 8.1 },
  refs,
});
const docOf = (events) => ({ schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, currency: 'CHF', generatedAt: '2026-10-05T06:00:00.000Z', events });

// July: three sales, a refund, two card fees, a payout the template skips.
const SALE1 = ev('kw:sale:5001', 'sale', '2026-07-03', '108.10', '100.00', '8.10', { counterpartyEmail: 'anna.erfunden@example.ch', counterpartyName: 'Anna Erfunden' });
const SALE2 = ev('kw:sale:5002', 'sale', '2026-07-12', '216.20', '200.00', '16.20', { counterpartyEmail: 'bruno.beispiel@example.ch', counterpartyName: 'Bruno Beispiel' });
const SALE3 = ev('kw:sale:5003', 'sale', '2026-07-20', '54.05', '50.00', '4.05', { counterpartyEmail: 'anna.erfunden@example.ch', counterpartyName: 'Anna Erfunden' });
const REFUND = ev('kw:refund:5004', 'refund', '2026-07-22', '-10.81', '-10.00', '-0.81', { counterpartyEmail: 'bruno.beispiel@example.ch' });
const FEE1 = ev('zf_fee_5001', 'processing_fee', '2026-07-03', '-3.24', '-3.00', '-0.24');
const FEE2 = ev('zf_fee_5002', 'processing_fee', '2026-07-12', '-6.49', '-6.00', '-0.49');
const PAYOUT = ev('zf_po_5001', 'bank_payout', '2026-07-28', '-300.00', '-300.00', null);
// A coach transfer with input VAT: booked, but no FEE (critic r3: its input VAT is not the processor's fee).
const TRANSFER = ev('zf_tr_5001', 'third_party_payout', '2026-07-05', '-86.48', '-80.00', '-6.48');
const JULY = [SALE1, SALE2, SALE3, REFUND, FEE1, FEE2, TRANSFER, PAYOUT];
// August: only a payout reaches the books (the bank's booking 1020 against 1095), and the import's skipped payout.
const AUG_PAYOUT = ev('zf_po_5002', 'bank_payout', '2026-08-04', '-57.82', '-57.82', null);

const JULY_WINDOW = { from: '2026-07-01', to: '2026-07-31' };

/**
 * The oracle: the Erfolgsrechnung's position 1 Nettoerlöse (`netto_erloese`, 30xx to 38xx) for a window, computed
 * by A08 and not by this capability. Since critic r1 L1 the summary reads the same section map, so the oracle is
 * the section's subtotal, never a hand-written account range.
 */
function erfolgsrechnung3xxx(ctx, from, to) {
  const res = must(computeIncomeStatement(ctx, { periodStart: from, periodEnd: to }));
  const section = res.sections.find((x) => x.key === 'netto_erloese');
  return section === undefined ? 0 : section.subtotalMinor;
}

function bookWorld() {
  const t = settlementWorld();
  setTemplate(t);
  return t;
}

/** The synthetic July book: the settlement import, an A11 invoice, a manual 3200 sale, a reversal, the bank payout. */
function julyBook() {
  const t = bookWorld();
  const report = must(importSettlement(t.ctx, { settlement: docOf(JULY), idempotencyKey: 'imp-july' }));
  const entryOf = (id) => report.events.find((e) => e.id === id).entryId;
  const invoice = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 40000, key: 'inv-1' });
  must(postEntry(t.ctx, { date: '2026-07-25', source: 'manual', description: 'Barverkauf Workshop (erfunden)', idempotencyKey: 'manual-3200', lines: [{ account: t.acc('1020'), debit: 7500 }, { account: t.acc('3200'), credit: 7500 }] }));
  must(reverseEntry(t.ctx, { entryId: entryOf(SALE3.id), date: '2026-07-26', reason: 'Storno (erfunden)', idempotencyKey: 'rev-sale3' }));
  must(postEntry(t.ctx, { date: '2026-07-29', source: 'manual', description: 'Auszahlung Zahlfix (erfunden)', idempotencyKey: 'bank-payout-july', lines: [{ account: t.acc('1020'), debit: 30000 }, { account: t.acc('1095'), credit: 30000 }] }));
  return { t, report, invoice };
}

const summary = (t, input = {}, ctx = t.ctx) => turnoverSummary(ctx, { ...JULY_WINDOW, ...input });

// --- invariant 1 -------------------------------------------------------------------------------------------

test('[INVARIANT summary-equals-erfolgsrechnung] the turnover equals the Erfolgsrechnung 3xxx lines to the Rappen (sales, a refund, a fee, an invoice, a reversal)', () => {
  const { t } = julyBook();
  const s = must(summary(t));
  const oracle = erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to);
  assert.notEqual(oracle, 0, 'the oracle reads a real book');
  assert.equal(s.totals.turnoverNetMinor, oracle);
  // By hand: settlement 100 + 200 + 50 - 10 - 50 (the reversal) = 290.00; invoice 400.00; manual 75.00.
  assert.equal(s.totals.turnoverNetMinor, 29000 + 40000 + 7500);
  // The sources and the months each sum to the total (one attribution per entry).
  assert.equal(s.bySource.reduce((a, x) => a + x.turnoverNetMinor, 0), s.totals.turnoverNetMinor);
  assert.equal(s.byMonth.reduce((a, x) => a + x.turnoverNetMinor, 0), s.totals.turnoverNetMinor);
  const by = Object.fromEntries(s.bySource.map((x) => [x.key, x.turnoverNetMinor]));
  // The import keeps a source's system and processor folded to lower case.
  assert.deepEqual(by, { [`settlement:${SYSTEM.toLowerCase()}:${PROCESSOR.toLowerCase()}`]: 29000, invoices: 40000, other: 7500 });
  // Output VAT (re-cut): the settlement sales and refunds only, the reversal mirrored, the invoice's 32.40 not:
  // 8.10 + 16.20 + 4.05 - 0.81 - 4.05 = 23.49; Ziffer 303.
  assert.equal(s.totals.outputVat.amountMinor, 810 + 1620 + 405 - 81 - 405);
  // The settlement subset: the settlement source's own row, at most the turnover.
  assert.equal(s.totals.settlementTurnoverMinor, 29000);
  assert.equal(s.totals.settlementTurnoverMinor, s.bySource.filter((x) => x.kind === 'settlement').reduce((a, x) => a + x.turnoverNetMinor, 0));
  assert.ok(s.totals.settlementTurnoverMinor <= s.totals.turnoverNetMinor);
  assert.equal(s.vatMethod, 'effektiv');
  assert.deepEqual(s.totals.outputVat.formLines, ['303']);
  // The fee input VAT: 0.24 + 0.49, the processor's fees only; the coach transfer's 6.48 is no fee.
  assert.equal(s.totals.feeInputVat.amountMinor, 73);
  assert.ok(s.totals.feeInputVat.formLines.length > 0);
  // Sales (re-cut): ONE set from settlement_event: SALE1 and SALE2; SALE3 was reversed in the window; the invoice
  // and the manual sale are turnover but no settlement sale; the refund lowers.
  assert.equal(s.totals.sales.count, 2);
  assert.equal(s.totals.sales.netMinor, 10000 + 20000);
  assert.equal(s.totals.sales.averageMinor, 15000);
  assert.equal(s.totals.reductionsMinor, -1000 - 5000);
  // Customers: Anna (100 + 50 - 50), Bruno (200 - 10), the invoice contact, and the manual sale without one.
  const anna = s.byCustomer.top.find((c) => c.email === 'anna.erfunden@example.ch');
  assert.equal(anna.turnoverNetMinor, 10000);
  const bruno = s.byCustomer.top.find((c) => c.email === 'bruno.beispiel@example.ch');
  assert.equal(bruno.turnoverNetMinor, 19000);
  assert.equal(s.byCustomer.top.reduce((a, c) => a + c.turnoverNetMinor, 0) + s.byCustomer.rest.turnoverNetMinor, s.totals.turnoverNetMinor);
});

test('[INVARIANT summary-equals-erfolgsrechnung] every fence of the query is held by a fact (critic r1 F1, L1)', () => {
  const t = bookWorld();
  const manual = (date, key, lines) => must(postEntry(t.ctx, { date, source: 'manual', description: 'Erfunden', idempotencyKey: key, lines }));
  const sale = (date, key, minor, account = '3200') => manual(date, key, [{ account: t.acc('1020'), debit: minor }, { account: t.acc(account), credit: minor }]);
  // The close fence: a December sale, then the year closed (its sweep debits 3200 on 31.12).
  sale('2025-12-15', 'dec-sale', 20000);
  must(importSettlement(t.ctx, { settlement: docOf([ev('kw:sale:4512', 'sale', '2025-12-10', '108.10', '100.00', '8.10')]), idempotencyKey: 'imp-dec' }));
  must(hardCloseYear(t.ctx, { year: 2025, idempotencyKey: 'close-2025' }));
  for (const [from, to] of [['2025-12-01', '2025-12-31'], ['2025-01-01', '2025-12-31']]) {
    const s = must(turnoverSummary(t.ctx, { from, to, compare: 'none' }));
    assert.equal(s.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, from, to), `${from}..${to}`);
    assert.equal(s.totals.turnoverNetMinor, 30000, 'the closing sweep is no turnover movement');
    assert.equal(s.totals.sales.count, 1, 'the settlement sale; the manual one is turnover, no settlement sale');
    assert.equal(s.totals.outputVat.amountMinor, 810);
  }
  // The posted fence: a draft on 3400 in the window never counts.
  must(saveDraft(t.ctx, { date: '2026-07-10', description: 'Entwurf (erfunden)', idempotencyKey: 'draft-1', lines: [{ account: t.acc('1020'), debit: 99900 }, { account: t.acc('3400'), credit: 99900 }] }));
  // The window's edges: a sale on its first and on its last day.
  sale('2026-07-01', 'edge-from', 500);
  sale('2026-07-31', 'edge-to', 700);
  // The count's window is the ENTRY's date: a settlement sale on each edge.
  must(importSettlement(t.ctx, { settlement: docOf([ev('kw:sale:4701', 'sale', '2026-07-01', '108.10', '100.00', '8.10'), ev('kw:sale:4731', 'sale', '2026-07-31', '108.10', '100.00', '8.10')]), idempotencyKey: 'imp-edges' }));
  // A 38xx Erlösminderung of type expense lowers the turnover; a 39xx Bestandesänderung is not turnover.
  must(createAccount(t.ctx, { number: '3810', name: 'Erlösminderung (erfunden)', type: 'expense', idempotencyKey: 'acc-3810' }));
  must(createAccount(t.ctx, { number: '3940', name: 'Bestandesänderung (erfunden)', type: 'income', idempotencyKey: 'acc-3940' }));
  manual('2026-07-15', 'rebate', [{ account: t.acc('3810'), debit: 300 }, { account: t.acc('1020'), credit: 300 }]);
  sale('2026-07-16', 'stock-change', 4000, '3940');
  // Critic r2 L1: the Erfolgsrechnung reads an account number by its leading integer, so "03200" and " 3210" are
  // Nettoerlöse; the summary must read them the same way (no `LIKE '3%'` prefilter).
  const padded = must(createAccount(t.ctx, { number: '03200', name: 'Erlöse mit Nullstelle (erfunden)', type: 'income', idempotencyKey: 'acc-03200' }));
  const spaced = must(createAccount(t.ctx, { number: ' 3210', name: 'Erlöse mit Leerstelle (erfunden)', type: 'income', idempotencyKey: 'acc-3210' }));
  manual('2026-07-17', 'padded-sale', [{ account: t.acc('1020'), debit: 1000 }, { account: padded.accountId ?? padded.account?.id, credit: 1000 }]);
  manual('2026-07-18', 'spaced-sale', [{ account: t.acc('1020'), debit: 2000 }, { account: spaced.accountId ?? spaced.account?.id, credit: 2000 }]);
  // Critic r2 M7: input VAT from any other entry (a purchase on 1170) is no fee input VAT of a settlement source.
  manual('2026-07-19', 'purchase-vat', [{ account: t.acc('6500'), debit: 10000 }, { account: t.acc('1170'), debit: 810 }, { account: t.acc('1020'), credit: 10810 }]);
  // Critic r2 M6: an MWST-Saldierung-shaped entry (2200 to 2201, source vat_settlement) moves no output VAT.
  must(postEntry(t.ctx, { date: '2026-07-20', source: 'vat_settlement', description: 'MWST-Saldierung (erfunden)', idempotencyKey: 'saldierung', lines: [{ account: t.acc('2200'), debit: 5000 }, { account: t.acc('2201'), credit: 5000 }] }));
  const s = must(summary(t, { compare: 'none' }));
  assert.equal(s.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to));
  assert.equal(s.totals.turnoverNetMinor, 500 + 700 - 300 + 1000 + 2000 + 10000 + 10000, 'both edges in, 03200 and " 3210" in, the draft and the 39xx line out, the rebate lowers');
  assert.equal(s.totals.sales.count, 2, 'the two settlement sales on the edges; manual entries are no settlement sale');
  assert.equal(s.totals.reductionsMinor, -300);
  assert.equal(s.totals.outputVat.amountMinor, 1620, 'the edge sales; the Saldierung moves 2200 but is no settlement event');
  assert.equal(s.totals.feeInputVat.amountMinor, 0, 'a purchase on 1170 is no fee input VAT of a settlement source');
  // The comparison window over the closed year reads the same oracle.
  const y = must(turnoverSummary(t.ctx, { from: '2026-12-01', to: '2026-12-31', compare: 'previous_year' }));
  assert.equal(y.previous.turnoverNetMinor, 30000);
});

test('[INVARIANT summary-equals-erfolgsrechnung] the comparison window reads the same oracle (previous period and previous year)', () => {
  const { t } = julyBook();
  must(importSettlement(t.ctx, { settlement: docOf([ev('kw:sale:4001', 'sale', '2026-06-10', '27.03', '25.00', '2.03')]), idempotencyKey: 'imp-june' }));
  const s = must(summary(t));
  assert.deepEqual(s.compare, { mode: 'previous_period', from: '2026-06-01', to: '2026-06-30' });
  assert.equal(s.previous.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, '2026-06-01', '2026-06-30'));
  assert.equal(s.previous.turnoverNetMinor, 2500);
  const y = must(summary(t, { compare: 'previous_year' }));
  assert.deepEqual(y.compare, { mode: 'previous_year', from: '2025-07-01', to: '2025-07-31' });
  assert.equal(y.previous.turnoverNetMinor, 0);
  assert.equal(must(summary(t, { compare: 'none' })).previous, null);
});

test('the comparison window has the same length: whole months step by months, other ranges by days', () => {
  assert.deepEqual(compareWindowOf('2026-07-01', '2026-09-30', 'previous_period'), { from: '2026-04-01', to: '2026-06-30' });
  assert.deepEqual(compareWindowOf('2026-01-01', '2026-03-31', 'previous_period'), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(compareWindowOf('2026-03-01', '2026-03-31', 'previous_period'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(compareWindowOf('2026-07-10', '2026-07-19', 'previous_period'), { from: '2026-06-30', to: '2026-07-09' });
  assert.deepEqual(compareWindowOf('2024-02-01', '2024-02-29', 'previous_year'), { from: '2023-02-01', to: '2023-02-28' });
  assert.deepEqual(compareWindowOf('2025-02-01', '2025-02-28', 'previous_year'), { from: '2024-02-01', to: '2024-02-29' });
  assert.equal(compareWindowOf('2026-07-01', '2026-07-31', 'none'), null);
});

// --- invariant 2 -------------------------------------------------------------------------------------------

test('[INVARIANT payout-never-turnover] a payout-only period sums to zero turnover; the payout is counted as a payout', () => {
  const t = bookWorld();
  must(importSettlement(t.ctx, { settlement: docOf([AUG_PAYOUT]), idempotencyKey: 'imp-aug' }));
  must(postEntry(t.ctx, { date: '2026-08-05', source: 'manual', description: 'Auszahlung Zahlfix (erfunden)', idempotencyKey: 'bank-payout-aug', lines: [{ account: t.acc('1020'), debit: 5782 }, { account: t.acc('1095'), credit: 5782 }] }));
  const s = must(turnoverSummary(t.ctx, { from: '2026-08-01', to: '2026-08-31' }));
  assert.equal(s.totals.turnoverNetMinor, 0);
  assert.equal(s.totals.outputVat.amountMinor, 0);
  assert.equal(s.totals.sales.count, 0);
  assert.equal(s.totals.sales.averageMinor, null);
  assert.deepEqual(s.bySource, []);
  assert.deepEqual(s.totals.payouts, { count: 1, amountMinor: 5782 });
  assert.deepEqual(s.accounts.clearing, ['1095']);
  assert.equal(erfolgsrechnung3xxx(t.ctx, '2026-08-01', '2026-08-31'), 0);
});

test('[INVARIANT payout-never-turnover] a template that BOOKS its payouts still adds nothing to turnover', () => {
  const t = settlementWorld();
  const kinds = { ...templateKinds(t), bank_payout: { action: 'book', accountId: t.acc('1020'), taxCode: null } };
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: 'tpl-books-payout' }));
  must(importSettlement(t.ctx, { settlement: docOf(JULY), idempotencyKey: 'imp-july-payout' }));
  const s = must(summary(t));
  assert.equal(s.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to));
  assert.equal(s.totals.turnoverNetMinor, 10000 + 20000 + 5000 - 1000);
  assert.deepEqual(s.totals.payouts, { count: 1, amountMinor: 30000 });
});

test('a payout and its reversal net: no payout is counted for a chain that sums to zero (critic r1 L2)', () => {
  const t = bookWorld();
  const payout = (date, key, minor) => must(postEntry(t.ctx, { date, source: 'manual', description: 'Auszahlung (erfunden)', idempotencyKey: key, lines: [{ account: t.acc('1020'), debit: minor }, { account: t.acc('1095'), credit: minor }] }));
  const wrong = payout('2026-08-05', 'po-wrong', 4200);
  must(reverseEntry(t.ctx, { entryId: wrong.entryId, date: '2026-08-06', reason: 'Falsch erfasst (erfunden)', idempotencyKey: 'po-wrong-rev' }));
  payout('2026-08-07', 'po-right', 4100);
  const s = must(turnoverSummary(t.ctx, { from: '2026-08-01', to: '2026-08-31' }));
  assert.deepEqual(s.totals.payouts, { count: 1, amountMinor: 4100 });
  assert.equal(s.totals.turnoverNetMinor, 0);
});

test('the template refuses a payout booked to a revenue account: a payout is never turnover (critic r1 L3)', () => {
  const t = settlementWorld();
  for (const kind of ['bank_payout', 'bank_payout_summary']) {
    const kinds = { ...templateKinds(t), [kind]: { action: 'book', accountId: t.acc('3400'), taxCode: null } };
    const res = setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: `tpl-${kind}-3400` });
    refused(res, 'payout_not_turnover');
    assert.equal(res.field, `kinds.${kind}.accountId`);
    assert.match(res.reason, /never turnover/);
  }
  const toBank = { ...templateKinds(t), bank_payout: { action: 'book', accountId: t.acc('1020'), taxCode: null } };
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: toBank, idempotencyKey: 'tpl-bank' }));
});

// --- the re-cut (critic r3, three FAILs): the VAT and the count are the settlement events' own -------------

const oneSale = (t, id, day, key) => {
  const r = must(importSettlement(t.ctx, { settlement: docOf([ev(id, 'sale', day, '108.10', '100.00', '8.10')]), idempotencyKey: key }));
  return r.events.find((e) => e.id === id).entryId;
};

test('re-cut: an A-B-C re-reversal counts the sale once, with its VAT once', () => {
  const t = bookWorld();
  const a = oneSale(t, 'kw:sale:6001', '2026-07-05', 'imp-abc');
  const b = must(reverseEntry(t.ctx, { entryId: a, date: '2026-07-06', reason: 'Storno (erfunden)', idempotencyKey: 'rev-a' }));
  must(reverseEntry(t.ctx, { entryId: b.reversalId, date: '2026-07-07', reason: 'Storno des Stornos (erfunden)', idempotencyKey: 'rev-b' }));
  const s = must(summary(t));
  assert.equal(s.totals.sales.count, 1);
  assert.equal(s.totals.sales.averageMinor, 10000);
  assert.equal(s.totals.turnoverNetMinor, 10000);
  assert.equal(s.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to));
  assert.equal(s.totals.outputVat.amountMinor, 810, 'sale +8.10, reversal -8.10, re-reversal +8.10');
});

test('re-cut: a reversal of an attributed sale lowers the output VAT (its lines are mirrored, never flipped again)', () => {
  const t = bookWorld();
  const a = oneSale(t, 'kw:sale:6101', '2026-07-05', 'imp-rev');
  oneSale(t, 'kw:sale:6102', '2026-07-08', 'imp-keep');
  must(reverseEntry(t.ctx, { entryId: a, date: '2026-07-20', reason: 'Storno (erfunden)', idempotencyKey: 'rev-6101' }));
  const s = must(summary(t));
  assert.equal(s.totals.outputVat.amountMinor, 810, 'two sales of 8.10, one reversed');
  assert.equal(s.totals.sales.count, 1);
  assert.equal(s.totals.reductionsMinor, -10000);
});

test('re-cut: a reversal across the window edge: the sale counts in its month, the reversal lowers the next', () => {
  const t = bookWorld();
  const a = oneSale(t, 'kw:sale:6201', '2026-07-30', 'imp-edge');
  must(reverseEntry(t.ctx, { entryId: a, date: '2026-08-02', reason: 'Storno (erfunden)', idempotencyKey: 'rev-edge' }));
  const july = must(summary(t, { compare: 'none' }));
  assert.equal(july.totals.sales.count, 1, 'it stood through 31.07');
  assert.equal(july.totals.outputVat.amountMinor, 810);
  const aug = must(turnoverSummary(t.ctx, { from: '2026-08-01', to: '2026-08-31', compare: 'none' }));
  assert.equal(aug.totals.sales.count, 0);
  assert.equal(aug.totals.turnoverNetMinor, -10000);
  assert.equal(aug.totals.reductionsMinor, -10000);
  assert.equal(aug.totals.outputVat.amountMinor, -810, 'the reversal inherits the sale attribution and is mirrored');
  assert.equal(aug.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, '2026-08-01', '2026-08-31'));
});

test('re-cut: only sale and refund events carry the VAT tile and the count; an other event booked to revenue is turnover only', () => {
  const t = settlementWorld();
  const kinds = { ...templateKinds(t), other: { action: 'book', accountId: t.acc('3200'), taxCode: 'UST81' } };
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: 'tpl-other' }));
  must(importSettlement(t.ctx, { settlement: docOf([ev('kw:sale:9101', 'sale', '2026-07-11', '108.10', '100.00', '8.10'), ev('zf_oth_9101', 'other', '2026-07-12', '10.81', '10.00', '0.81')]), idempotencyKey: 'imp-other' }));
  const s = must(summary(t));
  assert.equal(s.totals.turnoverNetMinor, 10000 + 1000);
  assert.equal(s.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to));
  assert.equal(s.totals.sales.count, 1, 'the other event is no sale');
  assert.equal(s.totals.outputVat.amountMinor, 810, 'the VAT tile sums sale and refund events only');
});

test('re-cut: a Gutschein sale booked to 2030 is no sale and no turnover', () => {
  const t = settlementWorld();
  must(createAccount(t.ctx, { number: '2030', name: 'Gutscheine (erfunden)', type: 'liability', idempotencyKey: 'acc-2030' }));
  const kinds = { ...templateKinds(t), sale: { action: 'book', accountId: t.acc('2030'), taxCode: null } };
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: 'tpl-voucher' }));
  must(importSettlement(t.ctx, { settlement: docOf([ev('kw:voucher:7001', 'sale', '2026-07-09', '50.00', '50.00', null)]), idempotencyKey: 'imp-voucher' }));
  const s = must(summary(t));
  assert.equal(s.totals.sales.count, 0);
  assert.equal(s.totals.turnoverNetMinor, 0);
  assert.equal(s.totals.settlementTurnoverMinor, 0);
});

test('re-cut: a Saldo book: the VAT tile is billed VAT, no fee input VAT, and a Saldierung with its 3809 difference and its reversal move neither VAT nor the count', () => {
  const t = settlementWorld();
  must(configureVat(t.ctx, { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620, formLine: '322' }], idempotencyKey: 'vat-saldo' }));
  setTemplate(t, t.ctx, t.acc, 'tpl-saldo');
  must(importSettlement(t.ctx, { settlement: docOf([ev('kw:sale:8001', 'sale', '2026-07-05', '108.10', '100.00', '8.10')]), idempotencyKey: 'imp-saldo' }));
  const oracle = () => erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to);
  const before = { ...must(summary(t)), oracle: oracle() };
  // The Saldo form of the MWST-Saldierung: 2200 out, the Saldo debt to 2201, the difference to 3809.
  const saldierung = must(postEntry(t.ctx, { date: '2026-07-31', source: 'vat_settlement', description: 'MWST-Saldierung (erfunden)', idempotencyKey: 'saldierung-saldo', lines: [{ account: t.acc('2200'), debit: 810 }, { account: t.acc('2201'), credit: 620 }, { account: t.acc('3809'), credit: 190 }] }));
  const mid = { ...must(summary(t)), oracle: oracle() };
  // Reversed the way vat_settlement_reverse does it (the owned reversal, A38).
  must(reverseOwnedEntry(t.ctx, { entryId: saldierung.entryId, date: '2026-07-31', description: 'Storno MWST-Saldierung (erfunden)', idempotencyKey: 'rev-saldierung' }, 'vat_settlement_reverse'));
  const after = { ...must(summary(t)), oracle: oracle() };
  for (const s of [before, mid, after]) {
    assert.equal(s.vatMethod, 'saldo');
    assert.equal(s.totals.feeInputVat, null, 'Saldo deducts no input VAT');
    assert.equal(s.totals.outputVat.amountMinor, 810, 'only the sale; the Saldierung and its reversal are no settlement event');
    assert.equal(s.totals.sales.count, 1);
    assert.equal(s.totals.turnoverNetMinor, s.oracle, 'the 3809 difference is turnover in both');
  }
  assert.equal(mid.totals.turnoverNetMinor, 10000 + 190);
  assert.equal(after.totals.turnoverNetMinor, 10000);
});

test('re-cut: two settlement events on one entry refuse the summary, never a guess (one event per entry)', () => {
  const t = bookWorld();
  const a = oneSale(t, 'kw:sale:9001', '2026-07-05', 'imp-dup');
  t.store.db
    .prepare(
      `INSERT INTO settlement_event (id, workspace_id, source_system, source_processor, event_id, kind, day, currency, amount_minor, net_minor, vat_minor, entry_id, created_by, created_at)
       VALUES ('stl_dup', ?, 'kurswerk', 'zahlfix', 'kw:sale:9002', 'refund', '2026-07-05', 'CHF', -10810, -10000, -810, ?, 'test', '2026-07-05T00:00:00.000Z')`,
    )
    .run(t.workspaceId, a);
  const res = turnoverSummary(t.ctx, JULY_WINDOW);
  refused(res, 'settlement_event_ambiguous');
  assert.equal(res.entryId, a);
});

// --- invariant 3 -------------------------------------------------------------------------------------------

test('[INVARIANT book-idempotent] re-running the review and Buchen does not double-count', () => {
  const t = bookWorld();
  const entries = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  const bookOnce = (key) => {
    const r = must(settlementReview(t.ctx, { settlement: docOf(JULY), ...JULY_WINDOW }));
    return must(importSettlement(t.ctx, { settlement: docOf(JULY), expectReviewSha256: r.reviewSha256, idempotencyKey: key }));
  };
  const first = bookOnce('buchen-1');
  assert.ok(first.events.filter((e) => e.outcome === 'booked').length > 0);
  const after1 = must(summary(t));
  const n1 = entries();
  const second = bookOnce('buchen-2');
  assert.equal(second.events.filter((e) => e.outcome === 'booked').length, 0, 'the second Buchen books nothing');
  // The same key replays, a new key meets already_imported.
  must(importSettlement(t.ctx, { settlement: docOf(JULY), idempotencyKey: 'buchen-1' }));
  const after2 = must(summary(t));
  assert.equal(entries(), n1, 'no entry was added');
  assert.deepEqual(after2.totals, after1.totals);
  assert.equal(after2.totals.turnoverNetMinor, 34000);
  assert.equal(after2.totals.turnoverNetMinor, erfolgsrechnung3xxx(t.ctx, JULY_WINDOW.from, JULY_WINDOW.to));
  // After Buchen the review of the period has nothing left to book.
  assert.equal(must(settlementReview(t.ctx, { settlement: docOf(JULY), ...JULY_WINDOW })).toBook, 0);
});

// --- invariant 4 -------------------------------------------------------------------------------------------

// Behavioural (critic r1 L4): the line query names the workspace once, on the entry, and joins the account to the
// entry's own workspace, so dropping `e.workspace_id = ?` lets the other book's same-shaped entries in and this fails.
test('[INVARIANT tenant] another workspace books its own turnover; neither read sees the other', () => {
  const { t } = julyBook();
  const before = must(summary(t));
  const periodsBefore = must(settlementPeriods(t.ctx, { unit: 'month', around: '2026-07-15', before: 1, after: 1 }));
  const b = secondWorkspace(t);
  must(createAccount(b.ctx, { number: '1095', name: 'Durchlaufkonto Nachbar', type: 'asset', idempotencyKey: 'b-1095' }));
  must(createAccount(b.ctx, { number: '6940', name: 'Gebühren Nachbar', type: 'expense', idempotencyKey: 'b-6940' }));
  setTemplate(t, b.ctx, b.acc, 'tpl-b');
  must(importSettlement(b.ctx, { settlement: docOf([ev('kw:sale:5001', 'sale', '2026-07-03', '1081.00', '1000.00', '81.00', { counterpartyName: 'Nachbarskundin' })]), idempotencyKey: 'imp-b' }));
  must(postEntry(b.ctx, { date: '2026-07-29', source: 'manual', description: 'Auszahlung (erfunden)', idempotencyKey: 'b-payout', lines: [{ account: b.acc('1020'), debit: 99900 }, { account: b.acc('1095'), credit: 99900 }] }));
  const after = must(summary(t));
  assert.deepEqual(after, before, 'workspace A reads exactly what it read before');
  assert.deepEqual(must(settlementPeriods(t.ctx, { unit: 'month', around: '2026-07-15', before: 1, after: 1 })), periodsBefore);
  const sb = must(turnoverSummary(b.ctx, JULY_WINDOW));
  assert.equal(sb.totals.turnoverNetMinor, 100000);
  assert.equal(sb.totals.turnoverNetMinor, erfolgsrechnung3xxx(b.ctx, JULY_WINDOW.from, JULY_WINDOW.to));
  assert.deepEqual(sb.totals.payouts, { count: 1, amountMinor: 99900 });
  assert.equal(sb.byCustomer.top[0].name, 'Nachbarskundin');
  // The same event id 'kw:sale:5001' is a sale in both books: each counts its own once (§H-TENANT on
  // settlement_event and journal_entry).
  assert.equal(sb.totals.sales.count, 1);
  assert.equal(sb.totals.outputVat.amountMinor, 8100);
  assert.equal(after.totals.sales.count, 2);
  assert.ok(!sb.byCustomer.top.some((c) => c.email === 'anna.erfunden@example.ch'));
});

test('[INVARIANT tenant] every query of the new reads names the workspace', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/core/settlement/turnover.ts', import.meta.url)), 'utf8');
  const queries = [...src.matchAll(/\.prepare\(\s*(`[^`]*`|'[^']*')/g)].map((m) => m[1]);
  assert.ok(queries.length >= 8, `found ${queries.length} queries`);
  for (const q of queries) {
    const tables = [...q.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]).filter((n) => n !== 'json_each');
    for (const table of tables) assert.match(q, table === 'workspace' ? /\bid = \?/ : /workspace_id/, `a query on ${table} names the workspace: ${q}`);
  }
});

// --- settlement_periods ------------------------------------------------------------------------------------

test('settlement_periods: a booked month, a month with an event waiting for a person, an empty month', () => {
  const t = bookWorld();
  must(importSettlement(t.ctx, { settlement: docOf(JULY), idempotencyKey: 'imp-july-p' }));
  must(importSettlement(t.ctx, { settlement: docOf([ev('zf_oth_6001', 'other', '2026-09-03', '5.00', '5.00', null)]), idempotencyKey: 'imp-sep' }));
  const res = must(settlementPeriods(t.ctx, { unit: 'month', around: '2026-08-15', before: 1, after: 1 }));
  assert.equal(res.unit, 'month');
  assert.deepEqual(res.periods.map((p) => [p.from, p.state]), [['2026-07-01', 'booked'], ['2026-08-01', 'empty'], ['2026-09-01', 'to_book']]);
  assert.equal(res.periods[0].booked, 7, 'seven July events have an entry; the payout is observed, skipped by design');
  assert.equal(res.periods[2].waiting, 1);
  // A quarter, the default unit of settlement.review_period, around a day; eight before and four after by default.
  const q = must(settlementPeriods(t.ctx, { around: '2026-08-15' }));
  assert.equal(q.unit, 'quarter');
  assert.equal(q.periods.length, 13);
  assert.deepEqual(q.periods[8], { from: '2026-07-01', to: '2026-09-30', state: 'to_book', booked: 7, waiting: 1, observed: 9 });
  refused(settlementPeriods(t.ctx, { unit: 'week' }), 'invalid_input');
});

// --- the inputs, the surface ------------------------------------------------------------------------------

test('turnover_summary refuses a bad window and writes nothing', () => {
  const { t } = julyBook();
  refused(turnoverSummary(t.ctx, { from: '2026-07-01' }), 'invalid_input');
  refused(turnoverSummary(t.ctx, { from: '2026-07-31', to: '2026-07-01' }), 'invalid_input');
  refused(turnoverSummary(t.ctx, { from: '2024-01-01', to: '2026-12-31' }), 'invalid_input');
  refused(summary(t, { compare: 'last_week' }), 'invalid_input');
  refused(summary(t, { top: 99 }), 'invalid_input');
  const one = must(summary(t, { top: 1 }));
  assert.equal(one.byCustomer.top.length, 1);
  assert.equal(one.byCustomer.top[0].turnoverNetMinor + one.byCustomer.rest.turnoverNetMinor, one.totals.turnoverNetMinor);
});

test('both reads are registered read verbs, and their REST twins answer the same as the engine', () => {
  const { t } = julyBook();
  for (const name of ['turnover_summary', 'settlement_periods']) assert.equal(getAction(name).kind, 'read', name);
  const viaRest = handleRest('turnover_summary', { workspaceId: t.workspaceId, ...JULY_WINDOW }, t.deps);
  assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
  assert.equal(viaRest.body.totals.turnoverNetMinor, 76500);
  assert.deepEqual(viaRest.body.totals, must(summary(t)).totals);
  const periods = handleRest('settlement_periods', { workspaceId: t.workspaceId, unit: 'month', around: '2026-07-15', before: 0, after: 0 }, t.deps);
  assert.equal(periods.status, 200, JSON.stringify(periods.body));
  assert.equal(periods.body.periods[0].state, 'booked');
  const bad = handleRest('turnover_summary', { workspaceId: t.workspaceId, from: '2026-07-01' }, t.deps);
  assert.equal(bad.body.ok, false);
});

test('a governed seat sees a settlement payer masked (settlement.agent_sees_email masked by default); the figures are the same', () => {
  const { t } = julyBook();
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const person = must(summary(t));
  const seen = must(summary(t, {}, agent));
  assert.equal(seen.totals.turnoverNetMinor, person.totals.turnoverNetMinor);
  assert.ok(!JSON.stringify(seen).includes('anna.erfunden@example.ch'), 'no payer email reaches an agent');
  assert.ok(!JSON.stringify(seen).includes('Anna Erfunden'), 'no payer name reaches an agent');
  const masked = seen.byCustomer.top.find((c) => c.masked);
  assert.equal(masked.turnoverNetMinor, 10000 + 19000);
});
