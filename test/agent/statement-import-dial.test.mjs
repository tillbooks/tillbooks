/**
 * D178 (A20 §11.4), agent governance of the statement door (security review, D161/D162).
 *
 * 1. `set_bank_csv_mapping` decides how every later CSV import reads amounts and signs, so an agent's
 *    change of it is drafted under `pay` and the saved mapping stays as it was until a person approves.
 * 2. An agent's CSV import must carry its mapping IN THE PAYLOAD: without one it is refused at draft time
 *    (`csv_mapping_required`, the saved mapping handed back to embed) and nothing queues. With one, the
 *    approval runs exactly the mapping the person saw, even when the saved mapping changed in between
 *    (the time-of-check/time-of-use hole a saved-mapping import would leave open).
 * 3. A governed import is validated like a direct call before it is drafted (an archived Bankkonto, an
 *    unreadable MT940 never queue), and an MT940 import drafts and runs on approval.
 *
 * SYNTHETIC DATA ONLY: the IBAN is the published PostFinance sample; files are spelled here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/dialMap.js';
import { consequenceFor } from '../../dist/core/agent/consequences.js';
import { NOT_PINNED } from '../../dist/core/agent/vorschlagPin.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const IBAN = 'CH9300762011623852957';
const MAPPING = { columns: { bookingDate: 'Datum', text: 'Text', debit: 'Belastung', credit: 'Gutschrift' }, dateFormat: 'dd.mm.yyyy' };
const SWAPPED = { columns: { bookingDate: 'Datum', text: 'Text', debit: 'Gutschrift', credit: 'Belastung' }, dateFormat: 'dd.mm.yyyy' };
const CSV = 'Datum;Text;Belastung;Gutschrift\n02.10.2026;Miete Oktober;1500.00;\n03.10.2026;Kundenzahlung;;820.00\n';
const MT940 = [':20:AG', `:25:${IBAN}`, ':28C:3', ':60F:C261001CHF100,', ':61:2610021002D12,50NMSCNONREF//AG-1', ':86:Gebühr', ':62F:C261002CHF87,50'].join('\n');

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const person = { ...deps, actor: 'studio' };
  const agent = { ...deps, actor: 'agent' };
  const bank = getAction('create_bank_account').run(person, { workspaceId, name: 'Geschäftskonto', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const bankAccountId = bank.bankAccount?.id ?? bank.bankAccountId;
  const saved = () => deps.store.db.prepare('SELECT mapping_json FROM bank_csv_mapping WHERE workspace_id = ? AND bank_account_id = ?').get(workspaceId, bankAccountId)?.mapping_json;
  const drafts = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?').get(workspaceId).n;
  const lines = () => deps.store.db.prepare('SELECT amount_minor AS a, credit_debit AS cd FROM bank_txn WHERE workspace_id = ? ORDER BY amount_minor').all(workspaceId).map((r) => ({ ...r }));
  const approve = (actionId) => getAction('approve_drafted_action').run(person, { workspaceId, actionId });
  return { deps, workspaceId, person, agent, bankAccountId, saved, drafts, lines, approve };
}

test('set_bank_csv_mapping is governed under pay, with its own consequence and pin reason', () => {
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.set_bank_csv_mapping, 'pay');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.import_bank_statement, 'pay');
  for (const verb of ['set_bank_csv_mapping', 'import_bank_statement']) {
    const c = consequenceFor(verb);
    assert.ok(c !== undefined && c !== null, `${verb}: a consequence`);
    assert.doesNotMatch(c['de-CH'], /\bSie\b|\bIhr(e|en|em|er)?\b/, 'de-CH never addresses the person with Sie');
    assert.ok(c.en.length <= 220 && c['de-CH'].length <= 220, 'the consequence card rule: at most 220 characters');
    for (const text of [c.en, c['de-CH']]) assert.equal(text.includes(String.fromCharCode(0x2014)), false, 'no em dash');
    assert.equal(NOT_PINNED[verb]?.reason, 'payload', `${verb}: the payload states the act`);
  }
  assert.equal(consequenceFor('set_bank_csv_mapping').reversibility, 'reversible');
});

test("an agent's mapping change is drafted and the saved mapping survives until a person approves", () => {
  const w = world();
  const first = getAction('set_bank_csv_mapping').run(w.person, { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, mapping: MAPPING, idempotencyKey: 'p-map' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const drafted = handleRest('set_bank_csv_mapping', { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, mapping: SWAPPED, idempotencyKey: 'a-map' }, w.agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'pay');
  assert.deepEqual(JSON.parse(w.saved()), MAPPING, 'the proposal changes nothing yet');
  const approved = w.approve(drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(JSON.parse(w.saved()), SWAPPED, 'the approval saves the proposed mapping');
  w.deps.store.close();
});

test("an agent's CSV import without a mapping in the payload is refused at draft time, nothing queues", () => {
  const w = world();
  getAction('set_bank_csv_mapping').run(w.person, { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, mapping: MAPPING, idempotencyKey: 'p-map' });
  const res = handleRest('import_bank_statement', { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, content: CSV, idempotencyKey: 'a-imp' }, w.agent).body;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'csv_mapping_required');
  assert.deepEqual(res.savedMapping, MAPPING, 'the saved mapping is handed back to embed');
  assert.equal(w.drafts(), 0, 'no Vorschlag queued');
  assert.deepEqual(w.lines(), []);
  w.deps.store.close();
});

test("an agent's CSV import with its mapping runs exactly that mapping on approval, even after the saved one changed", () => {
  const w = world();
  getAction('set_bank_csv_mapping').run(w.person, { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, mapping: MAPPING, idempotencyKey: 'p-map' });
  const drafted = handleRest('import_bank_statement', { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, content: CSV, mapping: MAPPING, idempotencyKey: 'a-imp' }, w.agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'pay');
  assert.deepEqual(w.lines(), [], 'nothing imported by the proposal');
  // Between the proposal and the approval, the saved mapping is swapped (debit read as credit).
  const swap = getAction('set_bank_csv_mapping').run(w.person, { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, mapping: SWAPPED, idempotencyKey: 'p-swap' });
  assert.equal(swap.ok, true);
  const approved = w.approve(drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(w.lines(), [{ a: 82000, cd: 'CRDT' }, { a: 150000, cd: 'DBIT' }], 'the rent is money out and the customer payment money in, as the approved mapping reads them');
  w.deps.store.close();
});

test('a governed import is validated before it is drafted; an MT940 import drafts and runs on approval', () => {
  const w = world();
  const bad = handleRest('import_bank_statement', { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, content: ':20:X\n:25:CH93\n:28C:1\n', format: 'mt940', idempotencyKey: 'a-bad' }, w.agent).body;
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'schema_invalid');
  assert.equal(w.drafts(), 0, 'an unreadable MT940 never queues');
  const drafted = handleRest('import_bank_statement', { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, content: MT940, idempotencyKey: 'a-mt' }, w.agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(w.approve(drafted.actionId).ok, true);
  assert.deepEqual(w.lines(), [{ a: 1250, cd: 'DBIT' }]);
  const archived = getAction('archive_bank_account').run(w.person, { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, idempotencyKey: 'arch' });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  const refusedArchived = handleRest('import_bank_statement', { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, content: MT940, idempotencyKey: 'a-arch' }, w.agent).body;
  assert.equal(refusedArchived.error, 'bank_account_archived');
  assert.equal(w.drafts(), 1, 'only the good import was ever drafted');
  w.deps.store.close();
});

test('D178 point 19: an agent may PROPOSE a duplicate answer (post dial), never book a flagged line, and a person approves the answer', () => {
  const w = world();
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.resolve_possible_duplicate, 'post');
  const c = consequenceFor('resolve_possible_duplicate');
  assert.ok(c !== undefined && c !== null && c.reversibility === 'reversible');
  assert.doesNotMatch(c['de-CH'], /\bSie\b|\bIhr(e|en|em|er)?\b/);
  assert.ok(c.en.length <= 220 && c['de-CH'].length <= 220);
  assert.equal(NOT_PINNED.resolve_possible_duplicate?.reason, 'state');
  // The MT940 brings a CHF 12.50 line; a CSV brings the same money the same day: the CSV line is flagged.
  const mt = getAction('import_bank_statement').run(w.person, { workspaceId: w.workspaceId, bankAccountId: w.bankAccountId, content: MT940, idempotencyKey: 'p-mt' });
  assert.equal(mt.ok, true, JSON.stringify(mt));
  const csv = getAction('import_bank_statement').run(w.person, {
    workspaceId: w.workspaceId,
    bankAccountId: w.bankAccountId,
    content: 'Datum;Text;Betrag\n02.10.2026;Gebühr;-12.50\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' },
    idempotencyKey: 'p-csv',
  });
  assert.equal(csv.ok, true, JSON.stringify(csv));
  const flagged = w.deps.store.db.prepare('SELECT bank_txn_id AS id FROM bank_txn_possible_duplicate WHERE workspace_id = ?').get(w.workspaceId).id;
  const fee = w.deps.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '6900'").get(w.workspaceId).id;
  // The agent's booking of the flagged line is refused at draft time: nothing queues.
  const book = handleRest('book_bank_line', { workspaceId: w.workspaceId, bankTxnId: flagged, target: { kind: 'accounts', legs: [{ accountId: fee, amountMinor: 1250 }] }, idempotencyKey: 'a-book' }, w.agent).body;
  assert.equal(book.ok, false);
  assert.equal(book.error, 'duplicate_decision_pending');
  assert.equal(w.drafts(), 0);
  // The agent proposes "Duplikat"; nothing is decided until a person approves.
  const drafted = handleRest('resolve_possible_duplicate', { workspaceId: w.workspaceId, bankTxnId: flagged, decision: 'duplicate', idempotencyKey: 'a-dup' }, w.agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'post');
  const decisions = () => w.deps.store.db.prepare('SELECT decision FROM bank_txn_duplicate_decision WHERE workspace_id = ?').all(w.workspaceId).map((r) => r.decision);
  assert.deepEqual(decisions(), []);
  // The pending proposal marks the line in the inbox (its Vorschlag, and a person decides it there).
  const listed = getAction('list_bank_inbox').run(w.person, { workspaceId: w.workspaceId, bankTxnId: flagged, status: 'all' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.lines[0].vorschlagActionId, drafted.actionId, 'the line names the pending resolve_possible_duplicate proposal');
  assert.equal(listed.lines[0].attention, 'needs');
  const approved = w.approve(drafted.actionId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(decisions(), ['duplicate']);
  w.deps.store.close();
});
