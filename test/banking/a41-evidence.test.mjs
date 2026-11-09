// A41.2 and A41.4 (D184): the ENGINE's evidence on an agent's book_bank_line Vorschlag, computed at read
// time. Agree with TILL's own proposal: its certainty; differ, or TILL has none: check. A receipt whose
// amount does not fit the line: check. The receipt's printed VAT beside the computed VAT: a note within
// belege.vat_delta_tolerance_rappen, check beyond it; the booking books the computed VAT either way.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, IBANs, amounts and dates (a41-beleg-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, world, assertClaimInvariantHolds, legs } from './bank-inbox-support.mjs';
import { receipt, lines } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const accounts = (t, number, amount, taxCode) => ({ kind: 'accounts', legs: [{ accountId: t.acc(number), amountMinor: amount, ...(taxCode ? { taxCode } : {}) }] });
/** The agent's call, drafted into a Vorschlag by the dial. */
function agentBooks(t, bankTxnId, target, extra = {}) {
  const body = handleRest('book_bank_line', { workspaceId: t.workspaceId, bankTxnId, target, idempotencyKey: `ag-${bankTxnId}`, agentReason: 'Sieht aus wie immer', ...extra }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(body.drafted, true, JSON.stringify(body).slice(0, 400));
  return body.actionId;
}
const evidenceOf = (t, actionId) => {
  const listed = getAction('list_drafted_actions').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId });
  assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 300));
  return listed.actions.find((a) => a.actionId === actionId).evidence;
};
const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];

/** A counterparty with a complete Buchungsregel: its next line's engine proposal is `sure` (standard). */
function ruled(t, { number = '6570', taxCode = null, name = 'Netzwerk Beispiel AG', iban = 'CH4431999123000889012' } = {}) {
  const [first] = lines(t, [{ amount: 1000, date: '2026-06-02', name, iban }]);
  must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc(number), taxCode, idempotencyKey: `rule-${name}` }));
  return { name, iban };
}

test('agrees: the agent books what the rule proposes; the evidence carries the ENGINE\'s certainty, sure', () => {
  const t = world();
  const cp = ruled(t);
  const [line] = lines(t, [{ amount: 4500, date: '2026-06-10', ...cp }]);
  const id = agentBooks(t, line, accounts(t, '6570', 4500));
  const ev = evidenceOf(t, id);
  assert.equal(ev.agrees, true);
  assert.equal(ev.certainty, 'sure');
  assert.deepEqual(ev.reasons, ['agrees']);
  assert.equal(ev.engine.reasonCode, 'standard');
  // The same object on the inbox line, beside the line's own proposal.
  assert.deepEqual(lineOf(t, line).vorschlagEvidence, ev);
  // The rule as a rule target is the same booking.
  const [again] = lines(t, [{ amount: 4600, date: '2026-06-11', ...cp }]);
  const ruleId = lineOf(t, again).proposal.reasonParams.standardId;
  assert.equal(evidenceOf(t, agentBooks(t, again, { kind: 'rule', standardId: ruleId, asks: {} })).agrees, true);
});

test('differs: another account than the rule is check, naming what TILL would book', () => {
  const t = world();
  const cp = ruled(t);
  const [line] = lines(t, [{ amount: 4500, date: '2026-06-12', ...cp }]);
  const ev = evidenceOf(t, agentBooks(t, line, accounts(t, '6500', 4500)));
  assert.equal(ev.agrees, false);
  assert.equal(ev.certainty, 'check');
  assert.deepEqual(ev.reasons, ['differs_from_engine']);
  assert.equal(ev.engine.certainty, 'sure');
  assert.equal(ev.engine.target.legs[0].accountId, t.acc('6570'));
  // The same account with another VAT code differs too.
  const [vat] = lines(t, [{ amount: 4400, date: '2026-06-13', ...cp }]);
  assert.equal(evidenceOf(t, agentBooks(t, vat, accounts(t, '6570', 4400, 'VST-M'))).agrees, false);
});

test('no engine proposal: a new counterparty with nothing to go by is check; the agent\'s reason is not evidence', () => {
  const t = world();
  const [line] = lines(t, [{ amount: 2300, date: '2026-06-14', name: 'Ganz Neu GmbH', iban: 'CH5800791123000889012' }]);
  const ev = evidenceOf(t, agentBooks(t, line, accounts(t, '6570', 2300)));
  assert.equal(ev.certainty, 'check');
  assert.deepEqual(ev.reasons, ['no_engine_proposal']);
  assert.equal(ev.engine.certainty, 'open');
});

test('learned: agreeing with the history rung carries learned', () => {
  const t = world();
  const cp = { name: 'Kaffeerösterei Beispiel', iban: 'CH5800791123000889012' };
  const [earlier] = lines(t, [{ amount: 1800, date: '2026-06-03', ...cp }]);
  must(bookBankLine(t.ctx, { bankTxnId: earlier, target: accounts(t, '6570', 1800), idempotencyKey: 'h1' }));
  const [line] = lines(t, [{ amount: 1900, date: '2026-06-15', ...cp }]);
  const ev = evidenceOf(t, agentBooks(t, line, accounts(t, '6570', 1900)));
  assert.equal(ev.certainty, 'learned');
  assert.equal(ev.engine.reasonCode, 'history');
});

test('a receipt whose captured amount does not fit the line makes the evidence check', () => {
  const t = world();
  const cp = ruled(t);
  const wrong = receipt(t, { amount: 9900, vendor: cp.name, date: '2026-06-16' });
  const right = receipt(t, { amount: 4500, vendor: cp.name, date: '2026-06-16' });
  const [a, b] = lines(t, [
    { amount: 4500, date: '2026-06-16', ...cp },
    { amount: 4500, date: '2026-06-17', ...cp },
  ]);
  const bad = evidenceOf(t, agentBooks(t, a, accounts(t, '6570', 4500), { attach: [{ fileId: wrong.fileId }] }));
  assert.equal(bad.certainty, 'check');
  assert.deepEqual(bad.reasons, ['agrees', 'beleg_amount_differs']);
  assert.deepEqual(bad.belege.map((x) => [x.fileId, x.amountMinor, x.amountAgrees]), [[wrong.fileId, 9900, false]]);
  const good = evidenceOf(t, agentBooks(t, b, accounts(t, '6570', 4500), { attach: [{ fileId: right.fileId }] }));
  assert.equal(good.certainty, 'sure');
  assert.deepEqual(good.belege.map((x) => x.amountAgrees), [true]);
});

test('A41.4: the printed VAT within the tolerance is a note, beyond it check; the booking books the computed VAT', () => {
  const t = world();
  const cp = ruled(t, { taxCode: 'VST-M', name: 'Mietwerk Beispiel AG', iban: 'CH5800791123000889012' });
  // Gross 133.45 at 8.1 %: the engine computes 10.00; the receipt prints 9.98 (2 Rappen off).
  const rounded = receipt(t, { amount: 13345, vendor: cp.name, date: '2026-06-20', vat: 998 });
  const [line, other] = lines(t, [
    { amount: 13345, date: '2026-06-20', ...cp },
    { amount: 13345, date: '2026-06-28', ...cp },
  ]);
  const ev = evidenceOf(t, agentBooks(t, line, accounts(t, '6570', 13345, 'VST-M'), { attach: [{ fileId: rounded.fileId }] }));
  assert.deepEqual(ev.vat, { belegMinor: 998, computedMinor: 1000, deltaMinor: -2, toleranceMinor: 5, withinTolerance: true });
  assert.equal(ev.certainty, 'sure', 'a difference within the tolerance changes no certainty');
  assert.deepEqual(ev.reasons, ['agrees', 'vat_rounding']);
  // The inbox's candidate group carries the same comparison against the proposal it would book.
  const group = lineOf(t, line).belegCandidates.find((g) => g.files.some((f) => f.fileId === rounded.fileId));
  assert.deepEqual(group.vat, ev.vat);
  must(settingsSet(t.ctx, { key: 'belege.vat_delta_tolerance_rappen', value: 1, reason: 'A41 test', idempotencyKey: 'tol-1' }));
  const strict = evidenceOf(t, agentBooks(t, other, accounts(t, '6570', 13345, 'VST-M'), { attach: [{ fileId: rounded.fileId }] }));
  assert.equal(strict.certainty, 'check');
  assert.equal(strict.vat.withinTolerance, false);
  assert.deepEqual(strict.reasons, ['agrees', 'vat_differs']);
  // Approving books the COMPUTED VAT (the recompute in postEntry is untouched).
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target: accounts(t, '6570', 13345, 'VST-M'), idempotencyKey: 'own' }));
  const tax = legs(t.store, booked.entryId).find((l) => l.taxCode === 'VST-M');
  assert.equal(tax.taxAmount, 1000);
});
