// D177 non-author critic probes, engine half, round 4 (critic/d177-engine-r4-2026-10-16, reviewed tip
// 4e4f5927): `reopen_bank_line` revives the Vorschläge its decision closed (`closed_by_link_id`).
// [PROBE] tests pass and record what was checked. Synthetic data only.
//
// Copied onto claude/d177-engine with the round-4 remediation (16.10.2026). Two [PROBE] tests recorded
// behaviour the remediation changed by design and now assert the remedied contract, saying so: R4-1 (the
// round trip is kept in the row's history; the trace describes the current state; still no A03 row, since a
// new chain entity kind needs the Studio-owned audit vocabulary) and R4-2 (one Vorschlag per seat comes
// back).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox, bookBankLine, ignoreBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { getAuditLog } from '../../dist/core/ledger/auditLog.js';
import { makeContext } from '../../dist/core/context.js';
import { world, importLines, must, postedBill } from './bank-inbox-support.mjs';
import { assertClaimInvariantHolds } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (t, id) => must(listBankInbox(t.ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const deps = (t, actor) => ({ store: t.store, clock: t.clock, ids: t.ids, actor });
const governed = (t, name, input, actor = 'agent') => runGoverned(deps(t, actor), getAction(name), { workspaceId: t.workspaceId, ...input });
const approve = (t, actionId) => getAction('approve_drafted_action').run(deps(t, 'studio'), { workspaceId: t.workspaceId, actionId });
const rowOf = (t, id) => t.store.db.prepare('SELECT status, reject_reason, resolved_by, resolved_at, closed_by_link_id, pin_digest FROM agent_action WHERE id = ?').get(id);
const accounts = (t, amountMinor, number = '6500') => ({ kind: 'accounts', legs: [{ accountId: t.acc(number), amountMinor }] });
const addSecondSeat = (t) => t.store.db.prepare("INSERT INTO user (actor_id, kind, display_name, created_at) VALUES ('agent-zwei', 'agent', 'Zweiter Agent', '2026-07-01T00:00:00.000Z')").run();

function fee(t, key, amountMinor = 470) {
  return importLines(t, { statementId: `BS-${key}`, entries: [{ ref: key, amountMinor, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: `TERMINAL ${key}` }] }).lines[key];
}

test('[PROBE R4] a person approves ANOTHER seat\'s Vorschlag, then undoes it: the first seat\'s is revived (pin kept), the approved one stays executed, the line books once more and only once', () => {
  const t = world();
  addSecondSeat(t);
  const line = fee(t, 'A');
  const x = must(governed(t, 'book_bank_line', { bankTxnId: line, target: accounts(t, 470), idempotencyKey: 'x' }));
  const y = must(governed(t, 'book_bank_line', { bankTxnId: line, target: accounts(t, 470, '6800'), idempotencyKey: 'y' }, 'agent-zwei'));
  const pinBefore = rowOf(t, x.actionId).pin_digest;
  must(approve(t, y.actionId));
  assert.equal(rowOf(t, x.actionId).reject_reason, 'Zeile entschieden');
  const r = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'doch anders (synthetisch)', idempotencyKey: 'r' }));
  assert.deepEqual(r.revivedActionIds, [x.actionId]);
  assert.equal(rowOf(t, y.actionId).status, 'executed', 'the approved Vorschlag is history, never revived');
  assert.equal(rowOf(t, x.actionId).pin_digest, pinBefore, 'D162: the revived draft keeps the pin it was drafted under');
  must(approve(t, x.actionId));
  const live = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_claim WHERE workspace_id = ? AND bank_txn_id = ? AND released_at IS NULL').get(t.workspaceId, line).n;
  assert.equal(live, 1, 'one live decision on the line');
  const entries = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  approve(t, y.actionId); // an executed Vorschlag answers its stored result
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n, entries, 'the executed one never runs again');
  assert.equal(rowOf(t, y.actionId).status, 'executed');
});

test('[PROBE R4, remedied R4-1] a revive keeps the round trip in the row\'s history; the row and the trace describe the current (pending) state; A03 holds only the line\'s reopen', () => {
  const t = world();
  const line = fee(t, 'T');
  const x = must(governed(t, 'book_bank_line', { bankTxnId: line, target: accounts(t, 470), idempotencyKey: 'x' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'duplicate', idempotencyKey: 'i' }));
  const closed = rowOf(t, x.actionId);
  assert.equal(closed.reject_reason, 'Zeile entschieden');
  assert.ok(closed.resolved_by !== null && closed.resolved_at !== null, 'the closure is traceable on the row');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'Rückgängig (synthetisch)', idempotencyKey: 'r' }));
  const revived = rowOf(t, x.actionId);
  assert.deepEqual([revived.status, revived.reject_reason, revived.resolved_by, revived.resolved_at], ['pending', null, null, null], 'the current state is pending');
  const history = JSON.parse(t.store.db.prepare('SELECT history_json FROM agent_action WHERE id = ?').get(x.actionId).history_json);
  assert.deepEqual(history.map((e) => e.event), ['closed', 'revived'], 'R4-1: closed by the decision, revived by its undo, on record');
  assert.equal(history[0].by, closed.resolved_by);
  assert.equal(history[0].at, closed.resolved_at);
  const call = t.store.db.prepare('SELECT resolved_by, resolved_at FROM agent_call WHERE agent_action_id = ?').get(x.actionId);
  assert.deepEqual(call, { resolved_by: null, resolved_at: null }, 'recorded: the trace says it was never resolved');
  const log = must(getAuditLog(makeContext(t.store, { workspaceId: t.workspaceId })));
  assert.equal(log.rows.filter((r) => r.entityKind === 'agent_action').length, 0, 'recorded: no A03 row for the closure or the revive');
  // The only durable record of the revive is the reopen's memo.
  const memo = t.store.db.prepare("SELECT result_json FROM idempotency WHERE workspace_id = ? AND verb = 'reopen_bank_line'").get(t.workspaceId);
  assert.match(memo.result_json, new RegExp(x.actionId), 'the reopen memo names the revived id');
});

test('[PROBE R4, remedied R4-2] legacy duplicates of ONE seat closed by one decision come back as ONE pending Vorschlag (the newest); the older is ersetzt', () => {
  const t = world();
  const line = fee(t, 'L');
  const raw = (id, at) =>
    t.store.db
      .prepare(
        `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
         VALUES (?, ?, 'agent', 'post', 'book_bank_line', ?, 'pending', ?, ?)`,
      )
      .run(id, t.workspaceId, JSON.stringify({ workspaceId: t.workspaceId, bankTxnId: line, target: accounts(t, 470), idempotencyKey: id }), id, at);
  raw('aa_l1', '2026-07-01T08:00:00.000Z');
  raw('aa_l2', '2026-07-02T08:00:00.000Z');
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'duplicate', idempotencyKey: 'i' }));
  const r = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'Rückgängig (synthetisch)', idempotencyKey: 'r' }));
  assert.deepEqual(r.revivedActionIds, ['aa_l2'], 'R4-2: one per seat, the newest');
  assert.equal(rowOf(t, 'aa_l1').reject_reason, 'ersetzt');
  assert.equal(lineOf(t, line).vorschlagActionId, 'aa_l2', 'the inbox still names the newest');
});

test('[PROBE R4] the re-screen nests inside the reopen: a settlement Vorschlag (dry run in a savepoint) is revived after the payment is reversed, and approves cleanly', () => {
  const t = world();
  const bill = postedBill(t, { grossMinor: 21500, seed: 'r4' });
  const line = importLines(t, { statementId: 'BS-R4S', entries: [{ ref: 'P', amountMinor: 21500, cd: 'DBIT', name: 'Druckerei Tannenbach AG', ustrd: 'RECHNUNG R4' }] }).lines.P;
  const target = { kind: 'open_item', documentId: bill.vendorBillId };
  const x = must(governed(t, 'book_bank_line', { bankTxnId: line, target, idempotencyKey: 'x' }));
  must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'person' }));
  assert.equal(rowOf(t, x.actionId).reject_reason, 'Zeile entschieden');
  const c0 = t.store.changeCount();
  const r = must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'Rückgängig (synthetisch)', idempotencyKey: 'r' }));
  assert.deepEqual(r.revivedActionIds, [x.actionId], 'the dry run inside the reopen saw the bill open again');
  assert.ok(t.store.changeCount() > c0, 'the reopen\'s own writes still count');
  assert.equal(t.store.db.inTransaction, false);
  must(approve(t, x.actionId));
  assert.equal(lineOf(t, line).state, 'booked');
});

test('[PROBE R4] a reopen approved from an agent Vorschlag (commit mark armed) revives too, and the approval executes', () => {
  const t = world();
  addSecondSeat(t);
  const line = fee(t, 'M');
  const x = must(governed(t, 'book_bank_line', { bankTxnId: line, target: accounts(t, 470), idempotencyKey: 'x' }, 'agent-zwei'));
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'duplicate', idempotencyKey: 'i' }));
  const reopen = governed(t, 'reopen_bank_line', { bankTxnId: line, reason: 'Agent: doch buchen (synthetisch)', idempotencyKey: 'ro' });
  assert.equal(reopen.drafted, true, JSON.stringify(reopen).slice(0, 200));
  const ran = must(approve(t, reopen.actionId));
  assert.ok(ran.ok);
  assert.equal(rowOf(t, reopen.actionId).status, 'executed', 'the commit mark saw the reopen run (nested dry runs discarded)');
  assert.equal(rowOf(t, x.actionId).status, 'pending');
  assert.equal(lineOf(t, line).state, 'open');
});
