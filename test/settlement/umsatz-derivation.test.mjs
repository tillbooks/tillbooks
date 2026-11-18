// A42, how a turnover booking is derived: the optional derivation refs (till-settlement/v1, additive 13.11.2026)
// read into each Umsatz row, TILL's own stateless re-check, quiet degradation, and check (a) on a payout its
// members leave a gap in.
//
// SYNTHETIC BY CONSTRUCTION: `derivation.sample.json` is the producer's synthetic contract fixture (invented ids,
// amounts and example.invalid addresses, generated, never derived from a real settlement), copied verbatim except
// three `description` texts replaced with invented ones (the private-data scan matched them to booking texts of a
// real ledger: generic words, but the rule is replace, never allowlist); the tests below move
// its days into July 2026 and give it the invented source of the settlement suites. Every other figure is invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { makeAuditPort } from '../../dist/core/ledger/auditLog.js';
import { settlementReview, importSettlement, derivationOf, readSettlementDocument, setSettlementTemplate } from '../../dist/core/settlement/index.js';
import { assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, setTemplate, must, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const NOW = '2026-10-05T08:00:00.000Z';
const SAMPLE_TEXT = readFileSync(new URL('./derivation.sample.json', import.meta.url), 'utf8');

/** The producer's sample, its days in July 2026, its source the invented one the template knows. */
function sample() {
  const doc = JSON.parse(SAMPLE_TEXT.replaceAll('2031-03-', '2026-07-').replaceAll('2031-04-01', '2026-08-01'));
  return { ...doc, source: { ...doc.source, system: SYSTEM, processor: PROCESSOR } };
}

/**
 * The sample with sale 1's VAT made exact at 8.1 % (the producer's sample states 9.00 on a net of 111.00; 8.1 % of it
 * is 8.99, so TILL's VAT gate refuses that event, pinned below). Gross and refs unchanged.
 */
function consistent() {
  const doc = sample();
  const s1 = doc.events.find((e) => e.id === SALE_1);
  s1.net = 111.01;
  s1.vat = { ...s1.vat, amount: 8.99 };
  return doc;
}

function derivationWorld() {
  const t = settlementWorld();
  const ctx = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: fixedClock(NOW),
    ids: t.ids,
    audit: makeAuditPort({ store: t.store, workspaceId: t.workspaceId, ids: t.ids }),
    periods: t.ctx.periods,
  });
  setTemplate(t);
  return { ...t, rctx: ctx };
}

const rowOf = (res, id) => res.rows.find((r) => r.eventId === id);
const SALE_1 = 'bondigoo:000000000000000000000a01';
const SALE_2 = 'bondigoo:000000000000000000000a02';
const REFUND = 'bondigoo:000000000000000000000a03';

test('the sample fixture is synthetic and the reader keeps every derivation ref', () => {
  const doc = sample();
  assert.match(doc._sample, /SYNTHETIC/);
  for (const e of doc.events) {
    const email = e.refs?.counterpartyEmail;
    if (typeof email === 'string') assert.match(email, /@example\.invalid$/, 'only reserved example addresses');
  }
  const read = readSettlementDocument(doc, 'CHF');
  assert.equal(read.ok, true);
  assert.equal(read.document.refused.length, 0, 'no ref refuses an event');
  const refs = JSON.parse(read.document.events.find((e) => e.id === SALE_1).refsJson);
  assert.equal(refs.platformFeeAmount, 10.99);
  assert.equal(refs.derivationOk, true);
});

test('a sale with a taken platform fee: every figure, both verdicts true', () => {
  const t = derivationWorld();
  const res = must(settlementReview(t.rctx, { settlement: sample() }));
  const d = rowOf(res, SALE_1).derivation;
  assert.deepEqual(d.platformFee, { bp: 990, amountMinor: 1099, waived: false, waiverReason: null });
  assert.equal(d.processingFeeMinor, 378);
  assert.equal(d.processingFeeSource, 'fee_transaction');
  assert.equal(d.payoutNetMinor, 11100);
  assert.equal(d.coachPayoutExpectedMinor, 9623);
  assert.deepEqual(d.selfBill, { number: 'B2B-2031-00001', amountMinor: 9623, hasVat: null });
  assert.equal(d.coachTransferMinor, 9623);
  assert.equal(d.vatRatePercent, '8.1');
  assert.equal(d.vatRule, 'ch_standard_8_1');
  assert.equal(d.sellerRole, 'deemed_supplier');
  assert.deepEqual(d.stated, { ok: true, diffMinor: 0 });
  assert.equal(d.till, true, 'TILL re-checks 111.00 - 10.99 - 3.78 = 96.23 = the self-bill');
  assert.equal(d.ok, true);
  assert.equal(d.ids.bookingId, '000000000000000000000c01');
  assert.equal(d.ids.transferId, 'tr_SAMPLE0001');
});

test('a sale with a waived fee and no transfer yet: the waiver reason, no verdict, no fake check', () => {
  const t = derivationWorld();
  const res = must(settlementReview(t.rctx, { settlement: sample() }));
  const d = rowOf(res, SALE_2).derivation;
  assert.deepEqual(d.platformFee, { bp: 0, amountMinor: 0, waived: true, waiverReason: 'new_coach_window' });
  assert.equal(d.processingFeeSource, 'stripe_balance_transaction');
  assert.equal(d.coachTransferMinor, null);
  assert.equal(d.stated.ok, null);
  assert.equal(d.till, null, 'no self-bill and no transfer: nothing to compare the expected payout with');
  assert.equal(d.ok, null);
});

test('a refund states where it comes from; its sale-only fields are null', () => {
  const t = derivationWorld();
  const res = must(settlementReview(t.rctx, { settlement: sample() }));
  const d = rowOf(res, REFUND).derivation;
  assert.equal(d.derivedFrom, 'bondigoo_refund_transaction');
  assert.equal(d.platformFee.amountMinor, null);
  assert.equal(d.ok, null);
});

test('TILL contradicts a producer verdict the figures do not carry', () => {
  const off = derivationOf({ payoutNet: 111, platformFeeAmount: 10.99, processingFeeAmount: 3.78, coachPayoutExpected: 96.24, selfBillAmount: 96.24, derivationOk: true }, '8.1');
  assert.equal(off.stated.ok, true);
  assert.equal(off.till, false, '111.00 - 10.99 - 3.78 is 96.23, not 96.24');
  assert.equal(off.ok, false);
  const payout = derivationOf({ payoutNet: 111, platformFeeAmount: 10.99, processingFeeAmount: 3.78, coachPayoutExpected: 96.23, selfBillAmount: 96.2, derivationOk: true }, '8.1');
  assert.equal(payout.till, false, 'the self-bill differs from the expected payout');
  const waived = derivationOf({ feeWaived: true, platformFeeAmount: 2.5 }, null);
  assert.equal(waived.till, false, 'a waived fee is 0 by the contract');
  const clawback = derivationOf({ payoutNet: 100, platformFeeAmount: 0, processingFeeAmount: 3, coachPayoutExpected: 97, coachTransferAmount: 90, coachPayoutAdjustment: -7 }, null);
  assert.equal(clawback.till, true, 'no self-bill: the transfer plus the clawback netted into it');
  const producerFalse = derivationOf({ derivationOk: false, derivationDiff: -0.01 }, null);
  assert.deepEqual([producerFalse.ok, producerFalse.stated.diffMinor], [false, -1]);
});

test('quiet degradation: refs without derivation fields, truncated or malformed refs never refuse and show nothing invented', () => {
  assert.equal(derivationOf({}, '8.1'), null);
  assert.equal(derivationOf({ chargeId: 'ch_x', payoutId: 'po_x', counterpartyEmail: 'a@example.invalid' }, '8.1'), null, 'the base refs alone are no derivation');
  assert.equal(derivationOf({ truncated: true }, null), null);
  const bad = derivationOf(
    { derivedFrom: 42, platformFeeBp: 99999, platformFeeAmount: 'abc', feeWaived: 'yes', platformFeeWaiverReason: 'bogus', processingFeeAmount: 1.234, payoutNet: {}, derivationOk: 'true', bookingId: 'x'.repeat(500), refsTrimmed: true },
    null,
  );
  assert.deepEqual(bad.platformFee, { bp: null, amountMinor: null, waived: null, waiverReason: null });
  assert.equal(bad.processingFeeMinor, null, 'more than two decimals is no amount');
  assert.equal(bad.payoutNetMinor, null);
  assert.equal(bad.derivedFrom, null);
  assert.equal(bad.ids.bookingId, null, 'an over-long id is dropped');
  assert.deepEqual([bad.stated.ok, bad.till, bad.ok, bad.refsTrimmed], [null, null, null, true]);
});

test('an older document without derivation refs reviews as before: every row, derivation null', () => {
  const t = derivationWorld();
  const doc = sample();
  const KEEP = new Set(['paymentId', 'chargeId', 'invoiceNumber', 'payoutId', 'test', 'transferId']);
  for (const e of doc.events) e.refs = Object.fromEntries(Object.entries(e.refs ?? {}).filter(([k]) => KEEP.has(k)));
  const res = must(settlementReview(t.rctx, { settlement: doc }));
  assert.equal(res.rows.length, doc.events.length);
  for (const r of res.rows) assert.equal(r.derivation, null, r.eventId);
});

test('[booking unchanged] the derivation refs change no figure the import books', () => {
  const t = derivationWorld();
  const withRefs = must(settlementReview(t.rctx, { settlement: sample() }));
  const bare = sample();
  for (const e of bare.events) {
    for (const k of ['derivedFrom', 'sellerRole', 'vatRule', 'platformFeeAmount', 'platformFeeWaiverReason', 'processingFeeAmount', 'processingFeeSource', 'payoutNet', 'coachPayoutExpected', 'selfBillAmount', 'coachTransferAmount', 'coachPayoutAdjustment', 'derivationOk', 'derivationDiff']) {
      if (e.refs !== undefined) delete e.refs[k];
    }
  }
  const without = must(settlementReview(t.rctx, { settlement: bare }));
  const figures = (res) => res.rows.map((r) => [r.eventId, r.status, r.amountMinor, r.netMinor, r.vatMinor, r.vatPostedMinor]);
  assert.deepEqual(figures(withRefs), figures(without));
  assert.deepEqual(withRefs.totals, without.totals);
  assert.equal(withRefs.toBook, without.toBook);
});

test('[privacy] the derivation never carries the payer, and an agent seat still sees it with the payer masked', () => {
  const t = derivationWorld();
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids });
  const res = must(settlementReview(agent, { settlement: sample() }));
  const row = rowOf(res, SALE_1);
  assert.equal(row.counterparty.masked, true);
  assert.equal(row.derivation.ok, true, 'the derivation is no personal data');
  for (const r of res.rows) assert.doesNotMatch(JSON.stringify(r.derivation), /example\.invalid|Sample Client/);
});

test('check (a): a payout its stated members explain is ok; one with a gap is never passed silently', () => {
  const t = derivationWorld();
  const exact = must(settlementReview(t.rctx, { settlement: consistent() }));
  
  assert.equal(exact.checks.payouts.state, 'ok', '120.00 - 3.78 - 96.23 - 5.00 = 14.99, the payout');
  assert.deepEqual(
    exact.checks.payouts.payouts.map((p) => [p.basis, p.restMinor, p.skippedRestMinor, p.unexplainedMinor]),
    [['refs', 0, -500, null]],
    'the reserve hold of 5.00 the template leaves on the clearing account is reported apart, never a gap',
  );

  // A second payout on the same processor account carries a movement the producer does not emit (another product's
  // subscription charge of 7.26 on the account), and the producer warns about it.
  const doc = consistent();
  doc.events.push(
    { id: 'txn_SAMPLE_X1:fee', kind: 'processing_fee', day: '2026-07-20', date: '2026-07-20T09:00:00.000Z', currency: 'CHF', amount: -0.66, net: -0.66, vat: null, refs: { payoutId: 'po_SAMPLE0002', paymentId: null } },
    { id: 'payout:po_SAMPLE0002', kind: 'bank_payout', day: '2026-07-22', date: '2026-07-22T00:00:00.000Z', currency: 'CHF', amount: -6.6, net: -6.6, vat: null, refs: { payoutId: 'po_SAMPLE0002' } },
  );
  doc.warnings = ['Zahlung ch_SAMPLE_X1 vom 20.07.2026 (CHF 7.26) hat keinen Datensatz des Produzenten (erfunden).'];
  const gap = must(settlementReview(t.rctx, { settlement: doc }));
  assert.equal(gap.checks.payouts.state, 'unknown', 'never ok while a payout is unexplained, and never differs on a gap TILL cannot attribute');
  const second = gap.checks.payouts.payouts.find((p) => p.eventId === 'payout:po_SAMPLE0002');
  assert.deepEqual([second.basis, second.restMinor, second.unexplainedMinor], ['partial', null, -726]);
  assert.match(gap.warnings.join(' '), /7\.26/, 'the producer\'s stated cause travels with the answer');

  // The same gap without a warning: still unknown with its figure, never ok, never red.
  doc.warnings = [];
  const silent = must(settlementReview(t.rctx, { settlement: doc }));
  assert.equal(silent.checks.payouts.state, 'unknown');
  assert.doesNotMatch(silent.warnings.join(' '), /7\.26/, 'no stated cause: the gap shows alone');
});

test('a booked event the document no longer carries keeps its derivation from the stored refs', () => {
  const t = derivationWorld();
  must(importSettlement(t.rctx, { settlement: consistent(), idempotencyKey: 'imp-1' }));
  const doc = consistent();
  doc.events = doc.events.filter((e) => e.id !== SALE_1);
  const res = must(settlementReview(t.rctx, { settlement: doc, from: '2026-07-01', to: '2026-09-30' }));
  const row = rowOf(res, SALE_1);
  assert.equal(row.reason, 'not_in_document');
  assert.equal(row.derivation.ok, true);
  assert.equal(row.derivation.platformFee.amountMinor, 1099);
});

test('the producer sample as shipped: sale 1 states VAT 9.00 on a net of 111.00, which 8.1 % does not produce; TILL refuses that event, still shows its derivation', () => {
  const t = derivationWorld();
  const res = must(settlementReview(t.rctx, { settlement: sample() }));
  const row = rowOf(res, SALE_1);
  assert.equal(row.status, 'refused');
  assert.equal(row.code, 'vat_not_exact');
  assert.equal(row.derivation.ok, true, 'the payout derivation is a separate question from the VAT the books can carry');
  assert.equal(rowOf(must(settlementReview(t.rctx, { settlement: consistent() })), SALE_1).status, 'to_book');
});

test('check (a): a member the books leave off NOT by design (a kind waiting for a person) still turns the check red', () => {
  const t = derivationWorld();
  const doc = consistent();
  // A template that sends the reserve to a person ("attention") makes it no design skip: its 5.00 is a gap.
  const res = must(settlementReview(t.rctx, { settlement: doc }));
  assert.equal(res.checks.payouts.state, 'ok');
  const kinds = { ...(JSON.parse(t.store.db.prepare('SELECT template_json FROM settlement_template WHERE workspace_id = ?').get(t.workspaceId).template_json).kinds) };
  kinds.reserve = { action: 'attention' };
  must(setSettlementTemplate(t.rctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: 'tpl-attention' }));
  const red = must(settlementReview(t.rctx, { settlement: doc }));
  assert.equal(red.checks.payouts.state, 'differs');
  assert.deepEqual(red.checks.payouts.payouts.map((p) => [p.restMinor, p.skippedRestMinor]), [[500, 0]], 'the payout less what the books carry: the 5.00 a person has not decided');
});

test('[code r2 L5] an id or code field carries no free text: an email or a name there is dropped', () => {
  const d = derivationOf({ derivedFrom: 'lena@kurswerk.example', sellerRole: 'Lena Beispiel', bookingId: 'kw_bk_1', selfBillNumber: 'KW-G 1', payoutNet: 1 }, null);
  assert.deepEqual([d.derivedFrom, d.sellerRole, d.ids.bookingId, d.selfBill.number], [null, null, 'kw_bk_1', null]);
});
