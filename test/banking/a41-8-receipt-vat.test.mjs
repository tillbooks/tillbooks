// A41.8 (D193): the VAT a TRUSTED receipt states picks the input code of a bank line's proposal. Per trust level, per
// account class, per rate variant and era, a receipt without VAT, a disagreeing rule, a credit line untouched,
// `compare_only` reproducing the ladder exactly, the inbox's `vatCheck`, the evidence, and the autobook wait.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, IBANs, amounts and dates (a41-beleg-support.mjs); the QR bill below
// is spelled by hand with an invented creditor and the published SIX sample IBAN the A39 suite already uses.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { proposalContext, proposeForLine, receiptInputCode } from '../../dist/core/banking/bankProposals.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { receiptRateClass } from '../../dist/core/banking/receiptVat.js';
import { receiptVatCheck } from '../../dist/core/banking/belegEvidence.js';
import { assignmentVerdict } from '../../dist/core/banking/belegVerdict.js';
import { captureExtract } from '../../dist/core/purchase/index.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { bankInboxAttention } from '../../dist/core/banking/bankInbox.js';
import { staleNamedWaitingByAccount } from '../../dist/core/banking/attentionProviders.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { seedRate } from '../payments/support.mjs';
import { must, world, assertClaimInvariantHolds, importLines, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { receipt, lines, confirmFigures, assignBeleg, verb } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

let k = 0;
const set = (t, key, value) => must(settingsSet(t.ctx, { key, value, reason: 'A41.8 probe', idempotencyKey: `a418-set-${(k += 1)}` }), `settings_set ${key}`);
const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];
/** The ladder's own proposal, with no receipt reader attached: what the inbox showed before A41.8. */
const ladderOf = (t, id) => proposeForLine(t.ctx, proposalContext(t.ctx), readBankTxn(t.ctx, id), readBankTxnDetail(t.ctx, id));
const legOf = (p) => p.target.legs[0];
/** The bulk-safety cap (critic r1): a sure or learned proposal whose receipt VAT differs reads check. */
const capped = (p) => (p.certainty === 'sure' || p.certainty === 'learned' ? { ...p, certainty: 'check' } : p);

/** A Buchungsregel for the default counterparty ("WOLKENHAUS AG 8001"): `number` with `taxCode`. */
function rule(t, number, taxCode, date = '2026-06-02', name = undefined) {
  const [first] = lines(t, [{ amount: 999, date, ...(name !== undefined ? { name } : {}) }]);
  must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc(number), taxCode, idempotencyKey: `a418-rule-${(k += 1)}` }), 'rule');
}

/** A receipt with extra stated fields (`vat_rate`, `vat_breakdown`), as the agent states them. */
function receiptWith(t, spec, extra = []) {
  const r = receipt(t, spec);
  if (extra.length > 0) must(captureExtract(t.ctx, { captureId: r.captureId, source: 'agent', fields: extra.map(([key, value]) => ({ key, value, confidence: 'high' })), idempotencyKey: `a418-x-${(k += 1)}` }), 'extract');
  return r;
}

// --- The reading's pieces ------------------------------------------------------------------------------------

test('rate classes are era-aware: the line\'s era first, then every era; 0 is no VAT; a foreign rate is none', () => {
  assert.equal(receiptRateClass(810, '2026-07-20'), 'normal');
  assert.equal(receiptRateClass(260, '2026-07-20'), 'reduced');
  assert.equal(receiptRateClass(380, '2026-07-20'), 'accommodation');
  assert.equal(receiptRateClass(770, '2023-07-20'), 'normal');
  assert.equal(receiptRateClass(250, '2023-07-20'), 'reduced');
  assert.equal(receiptRateClass(370, '2023-07-20'), 'accommodation');
  // A 7.7 % receipt on a 2024 line still names the Normalsatz class (TILL then prices the line's era: vatCheck shows it).
  assert.equal(receiptRateClass(770, '2026-07-20'), 'normal');
  assert.equal(receiptRateClass(0, '2026-07-20'), 'zero');
  assert.equal(receiptRateClass(1900, '2026-07-20'), null);
});

test('account classes: 4xxx and 12xx take VST-M, 5xxx/6xxx and 15xx to 17xx take VST-I; VAT accounts, the bank ledger and income take nothing', () => {
  const t = world();
  assert.equal(receiptInputCode(t.ctx, t.acc('4200'), 'normal'), 'VST-M');
  assert.equal(receiptInputCode(t.ctx, t.acc('4200'), 'reduced'), 'VST-M26');
  assert.equal(receiptInputCode(t.ctx, t.acc('4000'), 'accommodation'), 'VST-M38');
  assert.equal(receiptInputCode(t.ctx, t.acc('1200'), 'normal'), 'VST-M');
  assert.equal(receiptInputCode(t.ctx, t.acc('6570'), 'normal'), 'VST-I');
  assert.equal(receiptInputCode(t.ctx, t.acc('6570'), 'accommodation'), 'VST-I38');
  assert.equal(receiptInputCode(t.ctx, t.acc('5000'), 'reduced'), 'VST-I26');
  assert.equal(receiptInputCode(t.ctx, t.acc('1500'), 'reduced'), 'VST-I26');
  assert.equal(receiptInputCode(t.ctx, t.acc('6570'), 'zero'), null, 'a receipt without VAT: no code');
  for (const n of ['1170', '1171', '2200', '1020', '3200', '2000']) {
    assert.equal(receiptInputCode(t.ctx, t.acc(n), 'normal'), undefined, `${n} takes nothing`);
  }
});

test('vatCheck through compareVat (r3 rule): one covering receipt matches or differs; everything else differs or is unread', () => {
  const r = (over) => ({ source: 'assigned', captureId: 'c', fileId: 'f', trusted: true, states: 'vat', rateBp: 810, rateClass: 'normal', rateTrusted: true, amountMinor: 769, grossMinor: 10260, currency: 'CHF', covers: true, ...over });
  const chf = { currency: 'CHF' };
  const taxed = { booksAccounts: true, vatMinor: 769 };
  const check = (readings, booking = taxed, row = chf) => receiptVatCheck(readings, row, 'CHF', booking, 5).vatCheck;
  assert.equal(check([]), 'none', 'no receipt');
  assert.equal(check([r({ states: 'silent', amountMinor: null })]), 'none', 'a silent receipt');
  assert.equal(check([r({})], taxed, { currency: 'EUR' }), 'none', 'a line outside the base currency');
  assert.equal(check([r({})], { booksAccounts: false, vatMinor: null }), 'none', 'a booking without accounts');
  assert.equal(check([r({ trusted: false })]), 'unread');
  const caps = (readings) => receiptVatCheck(readings, chf, 'CHF', taxed, 5).caps;
  assert.equal(caps([r({ trusted: false })]), false, 'a lone covering receipt, merely unconfirmed: no cap');
  assert.equal(caps([r({ trusted: false }), r({})]), true, 'unconfirmed among several: cap');
  assert.equal(caps([r({ trusted: false, covers: false })]), true, 'unconfirmed and not covering: cap');
  assert.equal(caps([r({ amountMinor: 775 })]), true, 'differs: cap');
  assert.equal(caps([r({})]), false, 'match: no cap');
  assert.equal(caps([r({ amountMinor: 400 }), r({ amountMinor: 369 })]), true, 'several, agreeing: unread, cap');
  assert.equal(check([r({ rateTrusted: false })]), 'unread', 'a typed rate under confirmed');
  // One covering receipt in the line's currency: the real comparison.
  assert.equal(check([r({})]), 'match');
  assert.equal(check([r({ amountMinor: 774 })]), 'match', 'within the tolerance');
  assert.equal(check([r({ amountMinor: 775 })]), 'differs');
  const untaxed = receiptVatCheck([r({})], chf, 'CHF', { booksAccounts: true, vatMinor: null }, 5);
  assert.equal(untaxed.vatCheck, 'differs', 'VAT on the receipt, none booked');
  assert.equal(untaxed.comparison.untaxed, true);
  assert.equal(check([r({ states: 'zero', rateBp: 0, rateClass: 'zero', amountMinor: 0 })], { booksAccounts: true, vatMinor: null }), 'match');
  // Every other case never matches: differs when the trusted comparison disagrees, else unread.
  assert.equal(check([r({ covers: false, amountMinor: 0 })]), 'differs', 'a receipt that does not cover the line, disagreeing');
  assert.equal(check([r({ covers: false })]), 'unread', 'a receipt that does not cover the line, agreeing by chance');
  assert.equal(check([r({ currency: 'EUR' })]), 'unread', 'a receipt in another currency than the line');
  assert.equal(check([r({ amountMinor: 400 }), r({ amountMinor: 369 })]), 'unread', 'two receipts whose sum agrees');
  assert.equal(check([r({ amountMinor: 400 }), r({ amountMinor: 0 })]), 'differs', 'two receipts whose sum disagrees');
  assert.equal(check([r({}), r({ currency: 'EUR' })]), 'unread', 'mixed currency');
  assert.equal(check([r({}), r({ states: 'silent', amountMinor: null })]), 'unread', 'a silent receipt beside a stating one');
  assert.equal(check([r({ states: 'silent', amountMinor: null }), r({ states: 'silent', amountMinor: null })]), 'none', 'only silent receipts');
});

// --- The code on the proposal --------------------------------------------------------------------------------

test('a confirmed 2.6 % receipt on a VST-M rule: the proposal takes VST-M26, records why, keeps its certainty; vatCheck match', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  const before = ladderOf(t, line);
  assert.equal(legOf(before).taxCode, 'VST-M');
  confirmFigures(t, receipt(t, { amount: 10260, vat: 260 }));
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M26');
  assert.equal(l.proposal.vatCode, 'VST-M26');
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 260, amountMinor: 260, overrode: 'VST-M' });
  assert.equal(l.proposal.certainty, before.certainty, 'the certainty is unchanged');
  assert.equal(l.proposal.reasonCode, 'standard');
  assert.equal(legOf(l.proposal).accountId, t.acc('4200'), 'the ladder still picks the account');
  assert.equal(l.vatCheck, 'match');
  assert.equal(l.receiptVat.source, 'candidate');
  assert.equal(l.receiptVat.rateBp, 260);
  assert.equal(l.receiptVat.comparison.computedMinor, 260, 'TILL computes 2.6 % of the gross');
});

test('trust levels: an agent-read receipt changes nothing under confirmed (unread), and picks the code under agent', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  receipt(t, { amount: 10260, vat: 260 });
  let l = lineOf(t, line);
  assert.deepEqual(l.proposal, ladderOf(t, line), 'one covering receipt below the trust level: the ladder exactly, no cap');
  assert.equal(l.vatCheck, 'unread');
  assert.equal(l.receiptVat.trusted, false);
  set(t, 'belege.autobook_figure_trust', 'agent');
  l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M26');
  assert.equal(l.vatCheck, 'match');
});

test('a rate an agent typed is never trusted under confirmed, even after the person confirmed the figures; under agent it is', () => {
  const t = world();
  rule(t, '6570', null);
  const [line] = lines(t, [{ amount: 10380 }]);
  confirmFigures(t, receiptWith(t, { amount: 10380 }, [['vat_rate', '3.8']]));
  let l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, undefined, 'the confirmation does not cover vat_rate');
  assert.equal(l.vatCheck, 'unread');
  set(t, 'belege.autobook_figure_trust', 'agent');
  l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-I38', '6570 with 3.8 %: Investitionen und übriger Betriebsaufwand, Beherbergung');
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 380, amountMinor: 380, overrode: null }, 'the rule had no code: nothing overridden');
});

test('a QR bill a person brought in (Swico tag 32) is trusted: its rate picks the code', () => {
  const t = world();
  const name = 'Lieferant Beispiel GmbH';
  rule(t, '4200', 'VST-M', '2026-06-02', name);
  const [line] = lines(t, [{ amount: 10260, name }]);
  const spc = [
    'SPC', '0200', '1', 'CH4431999123000889012',
    'S', name, 'Musterweg', '7', '8000', 'Zürich', 'CH',
    '', '', '', '', '', '', '',
    '102.60', 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', 'Rechnung 4711', 'EPD',
    '//S1/10/4711/11/260718/32/2.6',
  ].join('\n');
  const cap = must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc, 'utf8').toString('base64'), mime: 'application/pdf', filename: 'qr.pdf', idempotencyKey: 'a418-qr' }));
  assert.equal(must(getAction('get_capture').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: cap.captureId })).capture.figuresTrust, 'qr');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M26');
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 260, amountMinor: 260, overrode: 'VST-M' });
  assert.equal(l.vatCheck, 'match');
});

test('rate variants and eras: 8.1 keeps VST-M (recorded, nothing overridden); a 2023 line with a 2.5 % receipt takes VST-M26', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10810 }]);
  confirmFigures(t, receipt(t, { amount: 10810, vat: 810 }));
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M');
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 810, amountMinor: 810, overrode: null });
  assert.equal(l.vatCheck, 'match');

  const old = world();
  rule(old, '4200', 'VST-M', '2023-06-02');
  const [line23] = lines(old, [{ amount: 10250, date: '2023-07-20' }]);
  confirmFigures(old, receipt(old, { amount: 10250, vat: 250, date: '2023-07-18' }));
  const l23 = lineOf(old, line23);
  assert.equal(legOf(l23.proposal).taxCode, 'VST-M26', '2.5 % is the reduced class of the 2018 era');
  assert.equal(l23.vatCheck, 'match', 'TILL prices the 2023 line at 2.5 %');
});

test('a VAT figure that fits no Swiss rate, or a mixed list, picks nothing; the comparison still runs', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [foreignRate, mixed] = lines(t, [{ amount: 11900 }, { amount: 15000, date: '2026-07-21' }]);
  confirmFigures(t, receipt(t, { amount: 11900, vat: 1900 }));
  let l = lineOf(t, foreignRate);
  assert.deepEqual(l.proposal, capped(ladderOf(t, foreignRate)), 'the ladder, capped at check (bulk safety)');
  assert.equal(l.vatCheck, 'differs', 'CHF 19.00 printed, TILL computes 8.1 %');
  set(t, 'belege.autobook_figure_trust', 'agent');
  receiptWith(t, { amount: 15000, date: '2026-07-19' }, [['vat_breakdown', '8.1:100.00;2.6:36.30']]);
  l = lineOf(t, mixed);
  assert.deepEqual(l.proposal, capped(ladderOf(t, mixed)), 'two rates: no code from the receipt');
  assert.equal(l.receiptVat.rateBp, null);
  assert.equal(l.receiptVat.amountMinor, 810 + 94, 'the VAT summed from the nets');
});

test('a receipt that states no VAT removes the code; a silent receipt changes nothing', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [zero, silent] = lines(t, [{ amount: 5000 }, { amount: 5100, date: '2026-07-21' }]);
  confirmFigures(t, receipt(t, { amount: 5000, vat: 0 }));
  let l = lineOf(t, zero);
  assert.equal('taxCode' in legOf(l.proposal), false, 'no code');
  assert.equal(l.proposal.vatCode, null);
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 0, amountMinor: 0, overrode: 'VST-M' });
  assert.equal(l.vatCheck, 'match', 'no VAT on the receipt, none booked');
  confirmFigures(t, receipt(t, { amount: 5100, date: '2026-07-19' }));
  l = lineOf(t, silent);
  assert.deepEqual(l.proposal, ladderOf(t, silent));
  assert.equal(l.vatCheck, 'none');
});

test('an assigned receipt comes before candidates; two candidate groups are no receipt', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  const a = receipt(t, { amount: 10260, vat: 260, vendor: 'Wolkenhaus AG' });
  const b = receipt(t, { amount: 10260, vat: 260, vendor: 'Wolkenhaus Zweig' });
  confirmFigures(t, a);
  confirmFigures(t, b);
  let l = lineOf(t, line);
  assert.equal(l.belegCandidates.length, 2, 'precondition: two groups');
  assert.deepEqual(l.proposal, ladderOf(t, line), 'TILL does not guess which');
  assert.equal(l.vatCheck, 'none');
  must(assignBeleg(t, line, [a.fileId]), 'assign');
  l = lineOf(t, line);
  assert.equal(l.receiptVat.source, 'assigned');
  assert.equal(legOf(l.proposal).taxCode, 'VST-M26');
});

test('a credit line is untouched; compare_only reproduces the ladder exactly and shows differs', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [debit] = lines(t, [{ amount: 10260 }]);
  const [credit] = lines(t, [{ amount: 10260, cd: 'CRDT', date: '2026-07-22' }]);
  confirmFigures(t, receipt(t, { amount: 10260, vat: 260 }));
  const c = lineOf(t, credit);
  assert.deepEqual(c.proposal, ladderOf(t, credit));
  assert.equal(c.vatCheck, 'none');
  set(t, 'belege.vat_from_receipt', 'compare_only');
  const l = lineOf(t, debit);
  assert.deepEqual(l.proposal, capped(ladderOf(t, debit)), 'compare_only: the ladder, its certainty capped because the receipt differs');
  assert.equal(l.bulkBookable, false);
  assert.equal('vatFromReceipt' in l.proposal, false);
  assert.equal(l.vatCheck, 'differs', 'the receipt says 2.6 %, the rule books 8.1 %');
  assert.equal(l.receiptVat.comparison.belegMinor, 260);
  assert.equal(l.receiptVat.comparison.computedMinor, 769);
  // And back: the code is the receipt's again.
  set(t, 'belege.vat_from_receipt', 'propose');
  assert.equal(legOf(lineOf(t, debit).proposal).taxCode, 'VST-M26');
});

test('a booked line compares its filed receipt with the entry\'s stored VAT', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  const r = receipt(t, { amount: 10260, vat: 260 });
  confirmFigures(t, r);
  const proposal = lineOf(t, line).proposal;
  // Through the verb: the attach seam lives in the action (`files/attach.ts`), around the engine's booking.
  must(verb(t, 'book_bank_line', { bankTxnId: line, target: proposal.target, attach: [{ fileId: r.fileId }] }), 'book');
  const l = lineOf(t, line);
  assert.equal(l.state, 'booked');
  assert.equal(l.receiptVat.source, 'filed');
  assert.equal(l.vatCheck, 'match', 'the entry carries 2.60 at VST-M26');
});

test('the evidence: an agent who books the receipt\'s code agrees with TILL', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  confirmFigures(t, receipt(t, { amount: 10260, vat: 260 }));
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('4200'), amountMinor: 10260, taxCode: 'VST-M26' }] };
  const body = handleRest('book_bank_line', { workspaceId: t.workspaceId, bankTxnId: line, target, idempotencyKey: 'a418-ag', agentReason: 'Beleg 2.6 %' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(body.drafted, true, JSON.stringify(body).slice(0, 300));
  const listed = must(getAction('list_drafted_actions').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId }));
  const ev = listed.actions.find((a) => a.actionId === body.actionId).evidence;
  assert.equal(ev.agrees, true, JSON.stringify(ev.reasons));
  assert.equal(lineOf(t, line).vorschlagEvidence.agrees, true);
});

test('autobook verdict: an assigned receipt whose VAT the rule\'s leg contradicts waits beleg_vat_differs', () => {
  const t = world();
  set(t, 'belege.autobook_figure_trust', 'agent');
  const [line] = lines(t, [{ amount: 10260 }]);
  // A rate only (no printed VAT amount), so A41.4's amount check alone would not stop the booking.
  const r = receiptWith(t, { amount: 10260 }, [['vat_rate', '2.6']]);
  must(assignBeleg(t, line, [r.fileId]), 'assign');
  const row = readBankTxn(t.ctx, line);
  const ruleCode = { kind: 'accounts', legs: [{ accountId: t.acc('4200'), amountMinor: 10260, taxCode: 'VST-M' }] };
  const receiptCode = { kind: 'accounts', legs: [{ accountId: t.acc('4200'), amountMinor: 10260, taxCode: 'VST-M26' }] };
  assert.deepEqual(assignmentVerdict(t.ctx, row, ruleCode), { kind: 'wait', reason: 'beleg_vat_differs', assignmentId: assignmentVerdict(t.ctx, row, receiptCode).assignmentId });
  assert.equal(assignmentVerdict(t.ctx, row, receiptCode).kind, 'book');
  // The comparison is kept under compare_only, and nothing books unattended that the receipt contradicts.
  set(t, 'belege.vat_from_receipt', 'compare_only');
  assert.equal(assignmentVerdict(t.ctx, row, ruleCode).kind, 'wait', 'compare_only: still waits on a differing receipt');
  assert.equal(assignmentVerdict(t.ctx, row, receiptCode).kind, 'book');
});

test('belege.vat_from_receipt is human-only: an agent seat is refused', () => {
  const t = world();
  const res = getAction('settings_set').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, key: 'belege.vat_from_receipt', value: 'compare_only', reason: 'probe', idempotencyKey: 'a418-agent-set' });
  assert.equal(res.ok, false);
});

// --- Critic round 1 (docs/critique/d193-receipt-vat-r1.md) --------------------------------------------------

for (const code of ['BEZUG', 'IMPORT']) {
  test(`F1: a ${code} code is never replaced: a receipt without VAT, or with 8.1 %, leaves it`, () => {
    const t = world();
    rule(t, '6570', code);
    const [zero, normal] = lines(t, [{ amount: 50000 }, { amount: 10810, date: '2026-07-21' }]);
    confirmFigures(t, receipt(t, { amount: 50000, vat: 0 }));
    confirmFigures(t, receipt(t, { amount: 10810, vat: 810, date: '2026-07-19' }));
    for (const id of [zero, normal]) {
      const l = lineOf(t, id);
      assert.equal(legOf(l.proposal).taxCode, code, `${code} stays`);
      assert.equal('vatFromReceipt' in l.proposal, false);
    }
    // The self-assessed tax is not the vendor's: a receipt without Swiss VAT fits it (the rule stays sure), a
    // receipt that charges Swiss VAT on a self-assessed booking differs (and reads check).
    const z = lineOf(t, zero);
    assert.equal(z.vatCheck, 'match');
    assert.equal(z.proposal.certainty, 'sure');
    const n = lineOf(t, normal);
    assert.equal(n.vatCheck, 'differs');
    assert.equal(n.proposal.certainty, 'check');
  });
}

test('F2: two receipts at 8.1 and 2.6 % on one line pick nothing; the line differs and reads check', () => {
  const t = world();
  rule(t, '4200', 'VST-M26');
  const [line] = lines(t, [{ amount: 10810 + 10260 }]);
  const a = receipt(t, { amount: 10810, vat: 810, vendor: 'Alpha AG' });
  const b = receipt(t, { amount: 10260, vat: 260, vendor: 'Beta AG', date: '2026-07-17' });
  confirmFigures(t, a);
  confirmFigures(t, b);
  must(assignBeleg(t, line, [a.fileId, b.fileId]), 'assign');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M26', 'the ladder\'s code: no single rate');
  assert.equal('vatFromReceipt' in l.proposal, false);
  assert.equal(l.receiptVat.rateBp, null);
  assert.equal(l.receiptVat.amountMinor, 810 + 260, 'both receipts\' VAT');
  assert.equal(l.vatCheck, 'differs');
  assert.equal(l.proposal.certainty, 'check');
  assert.equal(l.bulkBookable, false);
});

test('r3: two receipts at the same rate pick nothing either (exactly one receipt picks); the line reads check', () => {
  const t = world();
  rule(t, '4200', 'VST-M26');
  const [line] = lines(t, [{ amount: 10810 + 5405 }]);
  const a = receipt(t, { amount: 10810, vat: 810, vendor: 'Alpha AG' });
  const b = receipt(t, { amount: 5405, vat: 405, vendor: 'Beta AG', date: '2026-07-17' });
  confirmFigures(t, a);
  confirmFigures(t, b);
  must(assignBeleg(t, line, [a.fileId, b.fileId]), 'assign');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M26', 'the ladder\'s code');
  assert.equal('vatFromReceipt' in l.proposal, false);
  assert.equal(l.vatCheck, 'differs', '12.15 on the receipts, 4.11 at 2.6 %');
  assert.equal(l.proposal.certainty, 'check');
});

test('F3: a 7.7 % receipt on a 2026 line picks no code (VST-M would book 8.07, not 7.70); it differs and reads check', () => {
  const t = world();
  rule(t, '4200', null);
  const [line] = lines(t, [{ amount: 10770 }]);
  confirmFigures(t, receipt(t, { amount: 10770, vat: 770 }));
  const l = lineOf(t, line);
  assert.deepEqual(l.proposal, capped(ladderOf(t, line)));
  assert.equal(legOf(l.proposal).taxCode, undefined);
  assert.equal(l.vatCheck, 'differs');
  assert.equal(l.bulkBookable, false);
});

test('bulk safety: a differing line leaves "sure" in the band and in the attention facet', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10770 }]);
  const before = bankInboxAttention(t.ctx).total;
  confirmFigures(t, receipt(t, { amount: 10770, vat: 770 }));
  const l = lineOf(t, line);
  assert.equal(l.vatCheck, 'differs');
  assert.equal(l.attention, 'needs');
  const after = bankInboxAttention(t.ctx).total;
  assert.equal(after.sure, before.sure - 1, 'the band counts it as needing the person');
  assert.equal(after.needs, before.needs + 1);
});

test('F4/F5: the method is read at the line\'s date: an effektiv 2026 line picks, a Saldo 2027 line keeps the ladder', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [y2026] = lines(t, [{ amount: 10260 }]);
  const [y2027] = lines(t, [{ amount: 20520, date: '2027-02-10' }]);
  confirmFigures(t, receipt(t, { amount: 10260, vat: 260 }));
  confirmFigures(t, receipt(t, { amount: 20520, vat: 520, date: '2027-02-08' }));
  must(configureVat(t.ctx, { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], methodChange: { validFrom: '2027-01-01' }, idempotencyKey: 'a418-saldo' }), 'to Saldo from 2027');
  assert.equal(legOf(lineOf(t, y2026).proposal).taxCode, 'VST-M26', 'effektiv on the line\'s date (the workspace row says saldo now)');
  const l = lineOf(t, y2027);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M', 'Saldo: the receipt picks no Vorsteuer code');
  assert.equal('vatFromReceipt' in l.proposal, false);
});

test('F4: a line outside the base currency keeps the ladder exactly, even with a reader that would pick', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'a418-eur' })).bankAccountId;
  const l = importLines(t, { statementId: 'A418-EUR', iban: SAVINGS_IBAN, currency: 'EUR', entries: [{ ref: 'A', amountMinor: 10260, cd: 'DBIT', name: 'Wolkenhaus AG' }, { ref: 'B', amountMinor: 10810, cd: 'DBIT', name: 'Wolkenhaus AG' }] }, { bankAccountId: eur }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.A, accountId: t.acc('4200'), taxCode: null, idempotencyKey: 'a418-eur-rule' }));
  confirmFigures(t, receipt(t, { amount: 10810, vat: 810, currency: 'EUR' }));
  assert.deepEqual(lineOf(t, l.B).proposal, ladderOf(t, l.B), 'the public read');
  // The guard itself, with a reader that would always pick: the code step never runs on a foreign line.
  const pc = proposalContext(t.ctx);
  pc.receiptVat = {
    propose: true,
    hintFor: () => ({ rateBp: 810, rateClass: 'normal', amountMinor: 810, currency: 'EUR' }),
    fits: () => true,
    capsFor: () => false,
  };
  const row = readBankTxn(t.ctx, l.B);
  assert.deepEqual(proposeForLine(t.ctx, pc, row, readBankTxnDetail(t.ctx, l.B)), ladderOf(t, l.B));
});

// --- Critic round 2 (docs/critique/d193-receipt-vat-r2.md): the regressions ----------------------------------

for (const order of ['zeroFirst', 'vatFirst']) {
  test(`PA ${order}: two vendors' invoices of one total, one 0 %, one 8.1 %: no pick, differs, check, no bulk`, () => {
    const t = world();
    rule(t, '4200', 'VST-M');
    const [line] = lines(t, [{ amount: 20000 }]);
    const zero = receipt(t, { amount: 10000, vat: 0, vendor: 'Kleinfirma Muster' });
    const vat = receipt(t, { amount: 10000, vat: 749, vendor: 'Wolkenhaus AG', date: '2026-07-17' });
    confirmFigures(t, zero);
    confirmFigures(t, vat);
    must(assignBeleg(t, line, order === 'zeroFirst' ? [zero.fileId, vat.fileId] : [vat.fileId, zero.fileId]), 'assign');
    const l = lineOf(t, line);
    assert.equal(legOf(l.proposal).taxCode, 'VST-M', 'the rule\'s code stays');
    assert.equal('vatFromReceipt' in l.proposal, false);
    assert.equal(l.vatCheck, 'differs', '7.49 on the receipts, 14.99 booked');
    assert.equal(l.proposal.certainty, 'check');
    assert.equal(l.attention, 'needs');
    assert.equal(l.bulkBookable, false);
    const row = readBankTxn(t.ctx, line);
    const ruleTarget = { kind: 'accounts', legs: [{ accountId: t.acc('4200'), amountMinor: 20000, taxCode: 'VST-M' }] };
    assert.equal(assignmentVerdict(t.ctx, row, ruleTarget).kind, 'wait', 'autobook waits too');
  });
}

test('PB: two 8.1 % vendors of one total: no pick, never match: unread caps at check', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 20000 }]);
  const a = receipt(t, { amount: 10000, vat: 749, vendor: 'Alpha AG' });
  const b = receipt(t, { amount: 10000, vat: 749, vendor: 'Beta AG', date: '2026-07-17' });
  confirmFigures(t, a);
  confirmFigures(t, b);
  must(assignBeleg(t, line, [a.fileId, b.fileId]), 'assign');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M');
  assert.equal(l.vatCheck, 'unread', 'the sum agrees, but two receipts are never a match');
  assert.equal(l.proposal.certainty, 'check');
  assert.equal(l.bulkBookable, false);
});

test('PH: one CHF 50 zero-VAT receipt on a CHF 200 line does not cover it: no pick, differs, check', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 20000 }]);
  const z = receipt(t, { amount: 5000, vat: 0, vendor: 'Kleinfirma Muster' });
  confirmFigures(t, z);
  must(assignBeleg(t, line, [z.fileId]), 'assign');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M', 'VST-M stays');
  assert.equal('vatFromReceipt' in l.proposal, false);
  assert.equal(l.vatCheck, 'differs');
  assert.equal(l.proposal.certainty, 'check');
  assert.equal(l.bulkBookable, false);
});

test('PD: a CHF and a EUR receipt on one CHF line: no pick, unread, check (mixed currency no longer silences the cap)', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 15000 }]);
  const a = receipt(t, { amount: 10260, vat: 260, vendor: 'Alpha AG' });
  const b = receipt(t, { amount: 5000, vat: 0, vendor: 'Beta GmbH', currency: 'EUR', date: '2026-07-17' });
  confirmFigures(t, a);
  confirmFigures(t, b);
  must(assignBeleg(t, line, [a.fileId, b.fileId]), 'assign');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M');
  assert.equal(l.vatCheck, 'unread');
  assert.equal(l.proposal.certainty, 'check');
});

test('r3 rule 1: an invoice and its receipt of one payment (two files, one total) pick nothing; the line reads check', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  const invoice = receipt(t, { amount: 10260, vat: 260 });
  const paid = receipt(t, { amount: 10260, vat: 260, date: '2026-07-19' });
  confirmFigures(t, invoice);
  confirmFigures(t, paid);
  must(assignBeleg(t, line, [invoice.fileId, paid.fileId]), 'assign');
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M', 'two receipts: no pick, even when the first covers the line');
  assert.equal('vatFromReceipt' in l.proposal, false);
  assert.equal(l.receiptVat.receipts, 2);
  assert.equal(l.vatCheck, 'differs', '5.20 summed on the receipts, 7.69 booked');
  assert.equal(l.proposal.certainty, 'check');
});

test('M10: the hub classes a stale Vorschlag\'s line as the inbox lists it, the receipt cap included', () => {
  const t = world();
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10770 }]);
  confirmFigures(t, receipt(t, { amount: 10770, vat: 770 }));
  assert.equal(lineOf(t, line).attention, 'needs', 'precondition: the receipt caps the sure rule');
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('4200'), amountMinor: 10770, taxCode: 'VST-M' }] };
  const body = handleRest('book_bank_line', { workspaceId: t.workspaceId, bankTxnId: line, target, idempotencyKey: 'a418-stale', agentReason: 'wie immer' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(body.drafted, true, JSON.stringify(body).slice(0, 200));
  t.store.db.prepare("UPDATE agent_action SET status = 'stale', resolved_at = ? WHERE workspace_id = ? AND id = ?").run(t.deps.clock.now(), t.workspaceId, body.actionId);
  assert.equal(staleNamedWaitingByAccount(t.ctx).get(t.bankAccountId), 1, 'the capped line waits for the person');
});

test('M13: a booked BEZUG line with a zero-VAT filed receipt reads match (the self-assessed tax is not the vendor\'s)', () => {
  const t = world();
  rule(t, '6570', 'BEZUG');
  const [line] = lines(t, [{ amount: 50000 }]);
  const r = receipt(t, { amount: 50000, vat: 0 });
  confirmFigures(t, r);
  const proposal = lineOf(t, line).proposal;
  must(verb(t, 'book_bank_line', { bankTxnId: line, target: proposal.target, attach: [{ fileId: r.fileId }] }), 'book');
  const l = lineOf(t, line);
  assert.equal(l.state, 'booked');
  assert.equal(l.receiptVat.source, 'filed');
  assert.equal(l.vatCheck, 'match');
});

// --- Critic round 3 (docs/critique/d193-receipt-vat-r3.md): the optional LOWs ----------------------------------

test('F2: the ladder\'s input family is kept, only the rate variant changes (VST-I on 4200, VST-M on 6570)', () => {
  const t = world();
  rule(t, '4200', 'VST-I');
  const [same, reduced] = lines(t, [{ amount: 10810 }, { amount: 10260, date: '2026-07-21' }]);
  confirmFigures(t, receipt(t, { amount: 10810, vat: 810 }));
  confirmFigures(t, receipt(t, { amount: 10260, vat: 260, date: '2026-07-19' }));
  let l = lineOf(t, same);
  assert.equal(legOf(l.proposal).taxCode, 'VST-I', 'the rule\'s Ziffer 405 stays');
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 810, amountMinor: 810, overrode: null });
  l = lineOf(t, reduced);
  assert.equal(legOf(l.proposal).taxCode, 'VST-I26', 'the rate variant of the rule\'s family');
  assert.deepEqual(l.proposal.vatFromReceipt, { rateBp: 260, amountMinor: 260, overrode: 'VST-I' });
  const o = world();
  rule(o, '6570', 'VST-M');
  const [line] = lines(o, [{ amount: 10810 }]);
  confirmFigures(o, receipt(o, { amount: 10810, vat: 810 }));
  assert.equal(legOf(lineOf(o, line).proposal).taxCode, 'VST-M');
});

test('F4 (X14): a learned history proposal whose receipt differs reads check too', () => {
  const t = world();
  const prev = lines(t, [{ amount: 3100, date: '2026-05-04' }, { amount: 3200, date: '2026-05-14' }, { amount: 3300, date: '2026-05-24' }]);
  for (const [i, id] of prev.entries()) {
    must(verb(t, 'book_bank_line', { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc('4200'), amountMinor: [3100, 3200, 3300][i], taxCode: 'VST-M' }] } }), 'book prev');
  }
  const [line] = lines(t, [{ amount: 10260 }]);
  assert.equal(ladderOf(t, line).certainty, 'learned', 'precondition: history');
  confirmFigures(t, receipt(t, { amount: 10260, vat: 777 }));
  const l = lineOf(t, line);
  assert.equal(l.vatCheck, 'differs');
  assert.equal(l.proposal.certainty, 'check');
});

test('F4 (X1, X17, X5): a single receipt in another currency that covers the line by FX picks nothing and caps, trusted or not', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '1.00', asOf: '2026-07-17' });
  rule(t, '4200', 'VST-M');
  const [trusted, unconfirmed] = lines(t, [{ amount: 10260 }, { amount: 20540, date: '2026-07-21' }]);
  confirmFigures(t, receipt(t, { amount: 10260, vat: 260, currency: 'EUR', date: '2026-07-18' }));
  receipt(t, { amount: 20540, vat: 520, currency: 'EUR', date: '2026-07-19' });
  let l = lineOf(t, trusted);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M', 'a EUR figure never picks a CHF line\'s code');
  assert.equal('vatFromReceipt' in l.proposal, false);
  assert.equal(l.vatCheck, 'unread');
  assert.equal(l.proposal.certainty, 'check');
  l = lineOf(t, unconfirmed);
  assert.equal(l.vatCheck, 'unread');
  assert.equal(l.proposal.certainty, 'check', 'another currency is structural: it caps even unconfirmed');
});

test('F4 (X11): a stated rate that disagrees with the stated VAT amount picks nothing', () => {
  const t = world();
  set(t, 'belege.autobook_figure_trust', 'agent');
  rule(t, '4200', 'VST-M');
  const [line] = lines(t, [{ amount: 10260 }]);
  receiptWith(t, { amount: 10260, vat: 260 }, [['vat_rate', '8.1']]);
  const l = lineOf(t, line);
  assert.equal(legOf(l.proposal).taxCode, 'VST-M');
  assert.equal(l.receiptVat.rateBp, null);
  assert.equal(l.vatCheck, 'differs', '2.60 stated, 7.69 booked');
});

test('F4 (X12): a booked line reads the receipt filed on its entry', () => {
  const t = world();
  rule(t, '4200', 'VST-M26');
  const [line] = lines(t, [{ amount: 10260 }]);
  const r = receipt(t, { amount: 10260, vat: 260 });
  confirmFigures(t, r);
  const booked = must(verb(t, 'book_bank_line', { bankTxnId: line, target: lineOf(t, line).proposal.target }), 'book');
  must(verb(t, 'files_link', { fileId: r.fileId, entityKind: 'journal_entry', entityId: booked.entryId }), 'link to the entry');
  const l = lineOf(t, line);
  assert.equal(l.state, 'booked');
  assert.equal(l.receiptVat?.source, 'filed');
  assert.equal(l.vatCheck, 'match');
});
