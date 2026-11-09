// A41.6 and A41.7 (D184 points 5 and 6): "Gelernt" lines join the bulk Buchen at a threshold the person
// answers first (bank.bulk_learned_min, ask first). One engine definition (isBulkBookable), carried on the
// inbox line as bulkBookable. Unanswered: learned lines never bulk. check never bulks. A line with a pending
// Vorschlag bulks only on its engine evidence.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { must, world, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { lines } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const CP = { name: 'Kaffeerösterei Beispiel', iban: 'CH5800791123000889012' };
const inbox = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' }));
const answer = (t, value, key = `bl-${value}`) =>
  must(getAction('settings_set').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, key: 'bank.bulk_learned_min', value, reason: 'A41 test', idempotencyKey: key }));
const to6570 = (t, amount) => ({ kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: amount }] });

/** A counterparty booked `times` times to 6570 before: its next line is learned with count = times. */
function learned(t, times, date = '2026-06-20') {
  const earlier = lines(t, Array.from({ length: times }, (_, i) => ({ amount: 1000 + i, date: `2026-05-${String(10 + i * 3).padStart(2, '0')}`, ...CP })));
  for (const id of earlier) must(bookBankLine(t.ctx, { bankTxnId: id, target: to6570(t, Math.abs(must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0].amountMinor)), idempotencyKey: `h-${id}` }));
  const [line] = lines(t, [{ amount: 2000, date, ...CP }]);
  return line;
}

test('unanswered: a learned line never bulks and the inbox says the question is open', () => {
  const t = world();
  const line = learned(t, 2);
  const res = inbox(t, line);
  assert.equal(res.lines[0].proposal.certainty, 'learned');
  assert.equal(res.lines[0].proposal.reasonParams.count, 2);
  assert.equal(res.bulkLearnedMin, null);
  assert.equal(res.lines[0].bulkBookable, false);
  assert.equal(res.lines[0].attention, 'learned', 'attention keeps its meaning');
});

test('answered: learned bulks from the threshold on; 0 means only sure lines; a sure line always bulks', () => {
  const t = world();
  const line = learned(t, 2);
  answer(t, 1);
  assert.equal(inbox(t, line).bulkLearnedMin, 1);
  assert.equal(inbox(t, line).lines[0].bulkBookable, true, 'count 2 >= 1');
  answer(t, 3);
  assert.equal(inbox(t, line).lines[0].bulkBookable, false, 'count 2 < 3');
  answer(t, 0, 'bl-zero');
  assert.equal(inbox(t, line).lines[0].bulkBookable, false, 'Nur sichere');
  // A complete rule makes another counterparty's line sure: it bulks whatever the answer.
  const cp = { name: 'Netzwerk Beispiel AG', iban: 'CH4431999123000889012' };
  const [first] = lines(t, [{ amount: 1000, date: '2026-06-02', ...cp }]);
  must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'rule-sure' }));
  const [sure] = lines(t, [{ amount: 4500, date: '2026-06-25', ...cp }]);
  assert.equal(inbox(t, sure).lines[0].proposal.certainty, 'sure');
  assert.equal(inbox(t, sure).lines[0].bulkBookable, true);
});

test('a check line never bulks; a line with a Vorschlag bulks only when the engine evidence agrees', () => {
  const t = world();
  answer(t, 1);
  // check: a new counterparty with only a journal hint or nothing.
  const [none] = lines(t, [{ amount: 3100, date: '2026-06-03', name: 'Ganz Neu GmbH', iban: 'CH9300762011623852957' }]);
  assert.equal(inbox(t, none).lines[0].bulkBookable, false);
  const line = learned(t, 2, '2026-06-28');
  const draft = (target, key) => handleRest('book_bank_line', { workspaceId: t.workspaceId, bankTxnId: line, target, idempotencyKey: key }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(draft(to6570(t, 2000), 'ag-same').drafted, true);
  const agreed = inbox(t, line).lines[0];
  assert.equal(agreed.vorschlagEvidence.certainty, 'learned');
  assert.equal(agreed.bulkBookable, true, 'the agent books what TILL learned: approvable in the bulk');
  // A newer Vorschlag to another account replaces it: the evidence differs, no bulk.
  assert.equal(draft({ kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 2000 }] }, 'ag-other').drafted, true);
  const differs = inbox(t, line).lines[0];
  assert.equal(differs.vorschlagEvidence.agrees, false);
  assert.equal(differs.bulkBookable, false);
});
