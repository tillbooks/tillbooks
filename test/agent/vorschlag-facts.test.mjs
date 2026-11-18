// D197: the facts list_drafted_actions adds at READ time for the Vorschläge screen (src/api/vorschlag-facts.ts):
// a bank-line decision's signed amount, date and counterparty; a supplier IBAN change's old and new IBAN; a
// settings change's name; the batch reach. Read-only and tenant-bound.
//
// SYNTHETIC BY CONSTRUCTION: every workspace, supplier, IBAN, amount and date below is invented here (the
// IBANs are the published sample numbers and invented ones the bank suites already use); nothing is derived
// from a real book or a real export.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { withVorschlagFacts, lineFactsOf, bankDetailOf } from '../../dist/api/vorschlag-facts.js';
import { setCreditorBankProfile } from '../../dist/core/banking/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { must, world, secondWorkspace } from '../banking/bank-inbox-support.mjs';
import { lines } from '../banking/a41-beleg-support.mjs';

const accounts = (t, number, amount) => ({ kind: 'accounts', legs: [{ accountId: t.acc(number), amountMinor: amount }] });

/** The agent's call, drafted into a Vorschlag by the dial. */
function agentCalls(t, verb, input) {
  const body = handleRest(verb, { workspaceId: t.workspaceId, ...input }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(body.drafted, true, JSON.stringify(body).slice(0, 400));
  return body.actionId;
}

function listed(t, input = {}) {
  const res = getAction('list_drafted_actions').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, ...input });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300));
  return res;
}

test('a bank-line Vorschlag carries the line\'s signed amount, date and counterparty; money out is negative', () => {
  const t = world();
  const [out, inn] = lines(t, [
    { amount: 4500, date: '2026-06-10', name: 'Velowerkstatt Beispiel GmbH', cd: 'DBIT' },
    { amount: 120000, date: '2026-06-11', name: 'Kundin Muster AG', cd: 'CRDT' },
  ]);
  const outId = agentCalls(t, 'book_bank_line', { bankTxnId: out, target: accounts(t, '6570', 4500), idempotencyKey: 'vf-out' });
  const inId = agentCalls(t, 'book_bank_line', { bankTxnId: inn, target: accounts(t, '3200', 120000), idempotencyKey: 'vf-in' });
  const res = listed(t);
  const byId = new Map(res.actions.map((a) => [a.actionId, a]));
  assert.deepEqual(byId.get(outId).lineFacts, { date: '2026-06-10', counterparty: 'Velowerkstatt Beispiel GmbH', text: null, amountMinor: -4500, currency: 'CHF' });
  assert.equal(byId.get(inId).lineFacts.amountMinor, 120000);
  assert.equal(byId.get(inId).lineFacts.counterparty, 'Kundin Muster AG');
  // The batch reach: a pending, unchanged bank-line decision; the setting rides on the answer.
  assert.equal(byId.get(outId).batchable, true);
  assert.equal(res.approvalBatchMode, 'tick');
  // The payload the approval replays is untouched.
  assert.equal(byId.get(outId).payload.bankTxnId, out);
  assert.equal('lineFacts' in byId.get(outId).payload, false);
});

test('a line that is gone, or a line of ANOTHER workspace, yields null facts (§H-TENANT)', () => {
  const t = world();
  const [line] = lines(t, [{ amount: 990, date: '2026-06-12', name: 'Papeterie Beispiel', cd: 'DBIT' }]);
  // Workspace A reads its own line.
  assert.equal(lineFactsOf(t.ctx, line)?.amountMinor, -990);
  // Workspace B names A's line id: nothing of A crosses.
  const b = secondWorkspace(t);
  assert.equal(lineFactsOf(b.ctx, line), null);
  const fake = { ok: true, actions: [{ actionId: 'x1', actionTool: 'book_bank_line', status: 'pending', payload: { bankTxnId: line } }] };
  const decorated = withVorschlagFacts(b.ctx, fake);
  assert.equal(decorated.actions[0].lineFacts, null);
  // A line id no workspace knows.
  const gone = withVorschlagFacts(t.ctx, { ok: true, actions: [{ actionId: 'x2', actionTool: 'ignore_bank_line', status: 'pending', payload: { bankTxnId: 'bt_gone' } }] });
  assert.equal(gone.actions[0].lineFacts, null);
  // A refusal passes through untouched.
  const refused = { ok: false, error: 'invalid_input' };
  assert.equal(withVorschlagFacts(t.ctx, refused), refused);
});

test('a resolved or changed bank-line row is never batchable; a non-bank verb never', () => {
  const t = world();
  const rows = [
    { actionId: 'a', actionTool: 'book_bank_line', status: 'executed', payload: {} },
    { actionId: 'b', actionTool: 'confirm_match', status: 'pending', changedSinceProposal: true, payload: {} },
    { actionId: 'c', actionTool: 'post_entry', status: 'pending', payload: {} },
    { actionId: 'd', actionTool: 'set_creditor_bank_profile', status: 'pending', payload: {} },
    { actionId: 'e', actionTool: 'confirm_match', status: 'pending', payload: {} },
  ];
  const out = withVorschlagFacts(t.ctx, { ok: true, actions: rows }).actions;
  assert.deepEqual(out.map((r) => r.batchable), [false, false, false, false, true]);
});

test('a supplier IBAN change carries the supplier, the IBAN in force now and the new one, tenant-bound', () => {
  const t = world();
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Rahmenbau Beispiel AG', idempotencyKey: 'vf-v' }), 'vendor').contact.id;
  must(setCreditorBankProfile(t.ctx, { vendorId: vendor, iban: 'CH9300762011623852957', idempotencyKey: 'vf-old' }), 'old iban');
  const id = agentCalls(t, 'set_creditor_bank_profile', { vendorId: vendor, iban: 'CH4431999123000889012', idempotencyKey: 'vf-new' });
  const row = listed(t).actions.find((a) => a.actionId === id);
  assert.deepEqual(row.bankDetail, { contactName: 'Rahmenbau Beispiel AG', oldIban: 'CH9300762011623852957', newIban: 'CH4431999123000889012' });
  assert.equal(row.batchable, false);
  // Another workspace naming the same vendor id learns neither the name nor the IBAN.
  const b = secondWorkspace(t);
  assert.deepEqual(bankDetailOf(b.ctx, { vendorId: vendor, iban: 'CH4431999123000889012' }), { contactName: null, oldIban: null, newIban: 'CH4431999123000889012' });
});

test('a supplier with no IBAN yet reads oldIban null', () => {
  const t = world();
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Neulieferant Beispiel', idempotencyKey: 'vf-v2' }), 'vendor').contact.id;
  assert.deepEqual(bankDetailOf(t.ctx, { vendorId: vendor, iban: 'CH5800791123000889012' }), { contactName: 'Neulieferant Beispiel', oldIban: null, newIban: 'CH5800791123000889012' });
});

test('a settings change carries the setting\'s name in both languages, the proposed and the current value', () => {
  const t = world();
  const out = withVorschlagFacts(t.ctx, { ok: true, actions: [{ actionId: 's', actionTool: 'settings_set', status: 'pending', payload: { key: 'attention.approval_batch_mode', value: 'single', reason: 'test' } }] });
  const s = out.actions[0].setting;
  assert.equal(s.key, 'attention.approval_batch_mode');
  assert.equal(s.label['de-CH'], 'Mehrere Bank-Vorschläge genehmigen');
  assert.equal(s.value, 'single');
  assert.equal(s.current, 'tick');
  // An unknown key keeps its key and no label, never a crash.
  const unknown = withVorschlagFacts(t.ctx, { ok: true, actions: [{ actionId: 'u', actionTool: 'settings_set', status: 'pending', payload: { key: 'no.such', value: 1 } }] });
  assert.equal(unknown.actions[0].setting.label, null);
});

test('the history statuses decorate too: an executed bank-line row keeps its facts, not batchable', () => {
  const t = world();
  const [line] = lines(t, [{ amount: 2500, date: '2026-06-14', name: 'Kaffeerösterei Beispiel', cd: 'DBIT' }]);
  const id = agentCalls(t, 'book_bank_line', { bankTxnId: line, target: accounts(t, '6570', 2500), idempotencyKey: 'vf-ex' });
  const approved = getAction('approve_drafted_action').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, actionId: id });
  assert.equal(approved.ok, true, JSON.stringify(approved).slice(0, 300));
  const row = listed(t, { status: 'executed' }).actions.find((a) => a.actionId === id);
  assert.equal(row.lineFacts.amountMinor, -2500);
  assert.equal(row.batchable, false);
});

test('security review: a seat without read_master_data learns neither the supplier nor its current IBAN, only the new one', () => {
  const t = world();
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Rahmenbau Beispiel AG', idempotencyKey: 'vf-mr-v' }), 'vendor').contact.id;
  must(setCreditorBankProfile(t.ctx, { vendorId: vendor, iban: 'CH9300762011623852957', idempotencyKey: 'vf-mr-old' }), 'old iban');
  const booksOnly = { ...t.ctx, capabilities: { assert: (c) => (c === 'read_master_data' ? { ok: false, error: 'permission_denied', capability: c } : { ok: true }) } };
  const answer = withVorschlagFacts(booksOnly, { ok: true, actions: [{ actionId: 'aa_x', actionTool: 'set_creditor_bank_profile', status: 'pending', payload: { vendorId: vendor, iban: 'CH4431999123000889012' } }] });
  assert.deepEqual(answer.actions[0].bankDetail, { contactName: null, oldIban: null, newIban: 'CH4431999123000889012', withheld: true });
  // The same row read by a seat that holds it says all three.
  const full = withVorschlagFacts(t.ctx, { ok: true, actions: [{ actionId: 'aa_x', actionTool: 'set_creditor_bank_profile', status: 'pending', payload: { vendorId: vendor, iban: 'CH4431999123000889012' } }] });
  assert.equal(full.actions[0].bankDetail.oldIban, 'CH9300762011623852957');
});
