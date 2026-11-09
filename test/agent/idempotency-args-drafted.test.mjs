/**
 * N01 US-N01.5 on the DRAFTED-ACTION path: a governed agent seat's same-key retry used to be answered
 * with the Vorschlag the key minted first, whatever arguments the retry carried (`enqueueDraftedAction`
 * replays by key). A retry with a different amount then looked "drafted" while the queue held the old
 * booking for the human to approve. The draft now replays only the arguments it was drafted with, the
 * same argument hash the idempotency record carries, and the approved act stands for exactly the
 * drafted call (the approval's injected confirm field is transport).
 *
 * "Writes nothing" is asserted on the rows that matter: no second Vorschlag, no stale mark, no entry.
 * The agent-call trace row of the refused attempt is expected: the trace records every agent call,
 * refusals included (`agent-gate.test.mjs`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

function rest(deps, name, input) {
  return handleRest(name, input, deps).body;
}

function count(deps, sql, ...args) {
  return deps.store.db.prepare(sql).get(...args).n;
}

function postArgs(workspaceId, accId, key, amount = 120000) {
  return {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: amount },
      { account: accId('1020'), credit: amount },
    ],
  };
}

test('a drafted Vorschlag replays only its own arguments; a same-key retry with others refuses and writes nothing', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const actions = () => count(deps, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', workspaceId);
  const stale = () => count(deps, "SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'stale'", workspaceId);
  const entries = () => count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);

  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'd-1'));
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(actions(), 1);

  const replay = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'd-1'));
  assert.equal(replay.drafted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.actionId, drafted.actionId, 'the identical retry names the same Vorschlag');

  const other = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'd-1', 99000));
  assert.equal(other.ok, false, 'a different amount under the drafted key must not read as drafted');
  assert.equal(other.error, 'idempotency_key_conflict', JSON.stringify(other));
  assert.equal(other.actionId, drafted.actionId, 'the refusal names the Vorschlag the key stands for');
  assert.equal(actions(), 1, 'no second Vorschlag');
  assert.equal(stale(), 0, 'the old Vorschlag was not voided by the refused call');
  assert.equal(entries(), 0);

  // The human approves the drafted call: it posts once, with the drafted figures.
  const approved = getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(entries(), 1);

  // After execution the key still has one meaning, on the draft path ...
  const afterOther = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'd-1', 99000));
  assert.equal(afterOther.error, 'idempotency_key_conflict', JSON.stringify(afterOther));
  const afterSame = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'd-1'));
  assert.equal(afterSame.ok, true, JSON.stringify(afterSame));
  assert.equal(entries(), 1);
  assert.equal(actions(), 1);
  deps.store.close();
});

test('an approval whose key was spent meanwhile on OTHER arguments refuses rather than replaying that act as the approved one', () => {
  // The approval is a nested dispatch under the CALLER's key (the Vorschlag's), not a system-derived
  // one, so it does not get the system's replay: it refuses, and the act it would have claimed stays
  // the only booking (security review on N01).
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const entries = () => count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);

  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'a-1'));
  assert.equal(drafted.drafted, true);
  // The same key spent directly, by a human, on another amount.
  const direct = getAction('post_entry').run({ ...deps, actor: 'studio' }, postArgs(workspaceId, accId, 'a-1', 777));
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(entries(), 1);

  const approved = getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, false, `the approval answered the other act as its own: ${JSON.stringify(approved)}`);
  assert.equal(approved.error, 'idempotency_key_conflict', JSON.stringify(approved));
  assert.equal(entries(), 1, 'nothing posted');
  const row = deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId);
  assert.notEqual(row.status, 'executed', 'the Vorschlag is not marked executed by an act it did not run');
  deps.store.close();
});

test('CRITIC REPRO: a key a person spent DIRECTLY on a money verb that rescopes its key cannot be drafted again with another amount', () => {
  // record_expense files its memo under `JSON.stringify(['record_expense', K])`. The critic: the person
  // records the bill under K, the agent proposes K with another amount, the person approves, and the
  // approval answers with the FIRST bill (the approved figure never booked). The registry's record of K
  // refuses the proposal itself, before anything is drafted.
  const fx = fixture();
  const deps = fx.deps;
  const workspaceId = fx.workspaceId;
  const input = SCENARIOS.record_expense(fx);
  const entries = () => count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);
  const actions = () => count(deps, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', workspaceId);
  const direct = getAction('record_expense').run({ ...deps, actor: 'studio' }, input);
  assert.equal(direct.ok, true, JSON.stringify(direct));
  const before = { entries: entries(), actions: actions() };

  const proposed = rest(deps, 'record_expense', { ...input, amountMinor: input.amountMinor + 1000 });
  assert.equal(proposed.ok, false, `the agent's other amount was accepted under the spent key: ${JSON.stringify(proposed)}`);
  assert.equal(proposed.error, 'idempotency_key_conflict', JSON.stringify(proposed));
  assert.deepEqual(proposed.fields, ['amountMinor']);
  assert.deepEqual({ entries: entries(), actions: actions() }, before, 'nothing drafted, nothing booked');

  // The same arguments are the same act: drafted (the dial) and, once approved, answered with the one bill.
  const same = rest(deps, 'record_expense', input);
  assert.equal(same.drafted, true, JSON.stringify(same));
  const approved = getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: same.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(entries(), before.entries, 'the approval replayed the one booking, it booked no second');
  deps.store.close();
});

test('CRITIC 6: a re-proposal with OTHER arguments after the record changed voids the stale Vorschlag first, then refuses', () => {
  const fx = fixture();
  const input = SCENARIOS.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const first = handleRest('issue_invoice', input, agent).body;
  assert.equal(first.drafted, true, JSON.stringify(first));
  handleRest(
    'update_document',
    { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { lines: [{ description: 'Beratung', quantity: 1, unitPriceMinor: 250000 }] } },
    agent,
  );
  const other = handleRest('issue_invoice', { ...input, note: 'anders' }, agent).body;
  assert.equal(other.error, 'idempotency_key_conflict', JSON.stringify(other));
  assert.deepEqual(other.fields, ['note']);
  assert.equal(other.status, 'stale');
  const rows = fx.deps.store.db.prepare('SELECT id, status FROM agent_action WHERE workspace_id = ?').all(fx.workspaceId);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: first.actionId, status: 'stale' }], 'voided, and no second Vorschlag');
  fx.deps.store.close();
});

test('the approved act and the drafted call share one identity: a granted retry replays, a changed one refuses', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const entries = () => count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);

  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'g-1'));
  assert.equal(drafted.drafted, true);
  const approved = getAction('approve_drafted_action').run({ ...deps, actor: 'studio' }, { workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));

  // Arm the agent (the D103 ceremony, performed by the human seat), so the next call EXECUTES and meets
  // the idempotency record the approval wrote rather than the Vorschlag.
  const granted = getAction('set_agent_dial').run(
    { ...deps, actor: 'studio' },
    { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'grant-g-1' },
  );
  assert.equal(granted.ok, true, JSON.stringify(granted));

  const same = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'g-1'));
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.drafted, undefined, 'the granted call executed (a replay), it did not draft');
  const changed = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'g-1', 5));
  assert.equal(changed.error, 'idempotency_key_conflict', JSON.stringify(changed));
  assert.equal(entries(), 1, 'one booking, whatever was retried');
  deps.store.close();
});
