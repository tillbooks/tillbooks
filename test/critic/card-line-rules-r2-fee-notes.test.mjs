// Critic r2 on D188 (A39 §21, card-line rules), probe group 2: the fee phrase plus `namesCardOrAccount`
// (r1 L-a), the hausbuch_notes `counterparty.bankTxnId` input (r1 L-c), and the three by-design readers.
//
// F1 (LOW). `namesCardOrAccount` accepts any token that ENDS with "karte" or "konto", and the whole word
// "visa". "Gebühr für Tageskarte", "Preis für Konzertkarte", "Preis für Geschenkkarte", "Fee for visa
// application" are not the bank's own fee, yet a line that names nobody (every CSV gap-fill line) and starts
// so is keyed as the account's own bank and takes the bank-fee rule.
//
// SYNTHETIC BY CONSTRUCTION: every text, amount and date is invented here.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { lineCounterpartyOf } from '../../dist/core/banking/bankProposals.js';
import { feePatternsOf, matchesFeeText } from '../../dist/core/banking/derivedCounterparty.js';
import { BANK_FEE_TEXTS_DEFAULT } from '../../dist/core/banking/feeTexts.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { bankLineDecisionState } from '../../dist/core/banking/bankModelRung.js';
import { listNotes, setNote } from '../../dist/core/hausbuch/notes.js';
import { ok, err } from '../../dist/core/result.js';
import { world, importLines, must, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const CARD = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711';

let n = 0;
function stmt(t, specs, opts) {
  n += 1;
  const dates = specs.map((s) => s.date).sort();
  const res = importLines(
    t,
    {
      statementId: `CR2F-${n}`,
      seqNb: String(n),
      from: dates[0],
      to: dates[dates.length - 1],
      entries: specs.map((s, i) => ({ ref: `CR2F${n}L${i + 1}`, cd: 'DBIT', amountMinor: s.amount, date: s.date, ustrd: s.text })),
    },
    opts,
  );
  return specs.map((_, i) => res.lines[`CR2F${n}L${i + 1}`]);
}
const keyOf = (t, id) => lineCounterpartyOf(t.ctx, readBankTxn(t.ctx, id), readBankTxnDetail(t.ctx, id))?.key ?? null;
// Re-cut (closed-world rule, A39 §21.1): the fee key is a closed list of WHOLE-text patterns.
const isBankFee = (text) => matchesFeeText(text, feePatternsOf(BANK_FEE_TEXTS_DEFAULT));

test('[FINDING F1, LOW] a fee phrase plus a compound ending in -karte, or "visa", is read as the bank\'s own fee', () => {
  const wrong = ['Gebühr für Tageskarte', 'Preis für Konzertkarte Tonhalle', 'Preis für Geschenkkarte Muster', 'Fee for visa application'].filter(isBankFee);
  assert.deepEqual(wrong, [], 'none of these is the bank keeping the account');
});

test('[FINDING F1, LOW, end to end] an unnamed "Preis für Konzertkarte" debit is proposed SURE by the bank-fee rule', () => {
  const t = world();
  const [fee, ticket] = stmt(t, [
    { text: 'Account maintenance', amount: 500, date: '2026-07-02' },
    { text: 'Preis für Konzertkarte Tonhalle', amount: 12000, date: '2026-07-04' },
  ]);
  must(setBankStandard(t.ctx, { bankTxnId: fee, accountId: t.acc('6900'), taxCode: null, idempotencyKey: 'fee-rule' }));
  const p = must(listBankInbox(t.ctx, { bankTxnId: ticket, status: 'all' })).lines[0].proposal;
  assert.ok(!(p?.reasonCode === 'standard' && p?.certainty === 'sure'), `the concert ticket is proposed ${JSON.stringify(p)} (key ${keyOf(t, ticket)})`);
});

test('[HELD] r1 L-a: the plain fee phrases without the card or the account are no bank fee; the bank\'s own wording still is', () => {
  for (const s of ['Fee for parking', 'Charges for repair Garage Muster', 'Preis für Bilder Atelier Muster', 'Gebühr für Parkplatz Stadt']) assert.equal(isBankFee(s), false, s);
  for (const s of ['Account maintenance', 'Kontoführung', 'Fee for Beispielbank Visa Debit Card no. xxxx 4711']) assert.equal(isBankFee(s), true, s);
  // Re-cut: a text the closed list does not hold whole is no fee key (the person books it, or extends the list).
  for (const s of ['Kontoführung Juli', 'Gebühr für Kontoauszug']) assert.equal(isBankFee(s), false, s);
});

// --- hausbuch_notes counterparty.bankTxnId ---------------------------------------------------------

test('[HELD] hausbuch_notes bankTxnId: §H-TENANT (another workspace\'s line finds nothing) and the bank read right refused BEFORE the line is read', () => {
  const t = world();
  const b = secondWorkspace(t);
  const [card] = stmt(t, [{ text: `${CARD}, WOLKENRECHNER`, amount: 1900, date: '2026-07-02' }]);
  must(setNote(t.ctx, { text: 'Immer 6570', scope: { kind: 'counterparty', ref: 'card:WOLKENRECHNER' }, idempotencyKey: 'n1' }));
  assert.deepEqual(must(listNotes(t.ctx, { counterparty: { bankTxnId: card } })).notes.map((x) => x.text), ['Immer 6570']);
  // The same key noted in workspace B: B asking with A's line id finds neither A's nor B's note.
  must(setNote(b.ctx, { text: 'B-Notiz', scope: { kind: 'counterparty', ref: 'card:WOLKENRECHNER' }, idempotencyKey: 'n2' }));
  assert.deepEqual(must(listNotes(b.ctx, { counterparty: { bankTxnId: card } })).notes, []);
  // A seat without read_sales: refused, whatever the id (no existence oracle).
  const noBank = { ...t.ctx, capabilities: { assert: (c) => (c === 'read_sales' ? err('permission_denied', { capability: c }) : ok()) } };
  for (const id of [card, 'btxn_does_not_exist']) {
    const r = listNotes(noBank, { counterparty: { bankTxnId: id } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'permission_denied');
  }
  // Malformed input is refused, never thrown.
  assert.equal(listNotes(t.ctx, { counterparty: { bankTxnId: 42 } }).error, 'invalid_input');
});

// --- The three by-design readers ----------------------------------------------------------------------

test('[HELD] the model state reads the STATED counterparty only; it is not a key and the rule rung ignores it', () => {
  const t = world();
  const [card] = stmt(t, [{ text: `${CARD}, WOLKENRECHNER`, amount: 1900, date: '2026-07-02' }]);
  const state = JSON.parse(bankLineDecisionState(readBankTxn(t.ctx, card), readBankTxnDetail(t.ctx, card)));
  assert.equal(state.counterparty ?? null, null);
  assert.match(state.remittance, /WOLKENRECHNER/);
});
