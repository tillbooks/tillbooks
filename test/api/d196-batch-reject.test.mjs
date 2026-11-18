// @ts-nocheck
/**
 * D196 item 9: `reject_drafted_actions`, the batch reject under the owner's grant, measured on rows.
 *
 * Written for a NON-AUTHOR critic to read: each test names the invariant it holds and counts the rows that
 * prove it, never a returned `ok` alone.
 *
 *  - grant OFF: the agent's batch refuses before any row is read; nothing changes.
 *  - grant `reject` and `decide`: a batch of N rejects N, one trace row and one `decided_under_grant` entry per
 *    row, the one reason stored on every row.
 *  - per item, never all or nothing: TILL's own offer `offer_human_only`, an executed row `already_executed`,
 *    a rejected row `already_rejected` (its reason kept), an unknown or another workspace's id `not_found`, a
 *    duplicate `duplicate_in_batch`; the others are still rejected.
 *  - the reason: optional under the grant by default since D204 (`agent.reject_reason`); `required` refuses per item, in the SINGLE verb too;
 *    `optional` lifts it; a person never needs one and keeps full reach (an offer included).
 *  - revoke MID-BATCH: the items after it answer `not_permitted` and stay pending.
 *  - the in-transaction re-read: a revoke committed between the single verb's checks and its transaction
 *    writes nothing (`grant_revoked`); the approve path's flip does the same when the act wrote nothing.
 *  - a demoted grantor fails closed for the whole batch.
 *
 * All data is synthetic (the seeded KMU chart of a fresh in-memory workspace).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { rejectOutcomeOf } from '../../dist/api/batch-actions.js';
import { makeContext } from '../../dist/core/context.js';
import { approveDraftedAction, rejectDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { AT, freshDeps, mintWorkspace, manualPost } from './support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const rowOf = (w, id) => w.deps.store.db.prepare('SELECT status, resolved_by, reject_reason, history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const grantEntries = (w, id) => JSON.parse(rowOf(w, id).history_json ?? '[]').filter((e) => e.event === 'decided_under_grant');
const traceRows = (w, verb) => count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND verb = ?', w.ws, verb);
const REASON = 'Neue Regeln: ich schlage alles neu vor.';

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  return { deps, ws: workspaceId, accId, seed };
}

/**
 * A SECOND workspace in the SAME store: the real tenant shape (one book file, many workspaces). Two fresh worlds
 * are not two tenants: each mints `ws_1` from its own id sequence (the cause of two test defects on 13.11.2026).
 */
function secondWorkspace(w, seed) {
  const { workspaceId, accId } = mintWorkspace(w.deps, 'Andere AG', `${seed}-ws2`);
  assert.notEqual(workspaceId, w.ws);
  return { deps: w.deps, ws: workspaceId, accId, seed: `${seed}-2` };
}

let n = 0;
function setting(w, key, value) {
  n += 1;
  const r = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key, value, reason: 'D196 item 9 test', idempotencyKey: `set-${key}-${value}-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
}
const grant = (w, value) => setting(w, 'agent.decide_proposals', value);

/** N agent-drafted post_entry Vorschläge (the dial is at ask by default, so the agent's write drafts). */
function drafts(w, howMany) {
  return Array.from({ length: howMany }, (_, i) => {
    const d = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, `${w.seed}-d${i}`) });
    assert.equal(d.drafted, true, JSON.stringify(d));
    return d.actionId;
  });
}

/** A synthetic Vorschlag TILL drafted itself (the actor its offers carry). */
function systemOffer(w, id) {
  w.deps.store.db
    .prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES (?, ?, 'system', 'post', 'post_entry', ?, 'pending', '2026-03-01T00:00:00Z')")
    .run(id, w.ws, JSON.stringify({ workspaceId: w.ws, ...manualPost(w.accId, `${id}-p`) }));
  return id;
}

test('grant off: the agent\'s batch refuses before any row is read, on both doors, and names where the owner grants it', () => {
  const w = world('off');
  const ids = drafts(w, 3);
  for (const call of [rest, mcp]) {
    const r = call(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids, reason: REASON });
    assert.equal(r.error, 'permission_denied', JSON.stringify(r));
    assert.equal(r.ownerCanGrant?.setting, 'agent.decide_proposals');
  }
  for (const id of ids) assert.equal(rowOf(w, id).status, 'pending');
  assert.equal(traceRows(w, 'reject_drafted_action'), 0, 'no single reject ran');
  w.deps.store.close();
});

for (const scope of ['reject', 'decide']) {
  test(`grant ${scope}: a batch of 5 rejects all 5, one trace row and one decided_under_grant entry per row, the reason on every row`, () => {
    const w = world(`g-${scope}`);
    const ids = drafts(w, 5);
    grant(w, scope);
    const traceBefore = traceRows(w, 'reject_drafted_action');
    const r = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids, reason: `  ${REASON}  ` });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.outcomes, { rejected: 5 });
    assert.deepEqual([r.count, r.okCount, r.refusedCount], [5, 5, 0]);
    assert.deepEqual(r.items.map((i) => [i.index, i.actionId, i.outcome]), ids.map((id, i) => [i, id, 'rejected']));
    for (const id of ids) {
      const row = rowOf(w, id);
      assert.deepEqual([row.status, row.resolved_by, row.reject_reason], ['rejected', 'agent', REASON]);
      const entries = grantEntries(w, id);
      assert.equal(entries.length, 1);
      assert.deepEqual([entries[0].decision, entries[0].scope, entries[0].grantedBy], ['rejected', scope, 'studio']);
    }
    assert.equal(traceRows(w, 'reject_drafted_action'), traceBefore + 5, 'each id is one single reject in the trace');
    // Idempotent: the same batch again rejects nothing new, runs nothing, rewrites no reason.
    const again = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids, reason: 'ein anderer Grund' });
    assert.deepEqual(again.outcomes, { already_rejected: 5 });
    assert.ok(again.items.every((i) => i.ok === true && i.result.alreadyRejected === true && i.result.reason === REASON));
    // Every id is still one single call (code critic M1: the batch has no read of its own), so it is traced.
    assert.equal(traceRows(w, 'reject_drafted_action'), traceBefore + 10);
    for (const id of ids) assert.equal(grantEntries(w, id).length, 1);
    w.deps.store.close();
  });
}

test('per item, never all or nothing: offer, executed, rejected, unknown, another workspace, duplicate; the rest is rejected', () => {
  const w = world('mix');
  const [a, b, c, d] = drafts(w, 4);
  const offer = systemOffer(w, 'agent_action_sys_mix');
  // c executed (a person approved it), d rejected by a person with their own reason.
  assert.equal(rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: c }).ok, true);
  assert.equal(rest(asStudio(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: d, reason: 'Person: nein' }).ok, true);
  const other = secondWorkspace(w, 'mix');
  const [foreign] = drafts(other, 1);
  grant(w, 'reject');
  const r = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: [a, offer, c, d, 'agent_action_nope', foreign, a, b], reason: REASON });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.items.map((i) => i.outcome), ['rejected', 'offer_human_only', 'already_executed', 'already_rejected', 'not_found', 'not_found', 'duplicate_in_batch', 'rejected']);
  assert.deepEqual([r.okCount, r.refusedCount], [3, 5]);
  assert.equal(r.items[1].refusal.grantExclusion, 'system_offer');
  assert.equal(r.items[3].result.reason, 'Person: nein', 'the person\'s reason is kept, never rewritten');
  assert.deepEqual([rowOf(w, a).status, rowOf(w, b).status], ['rejected', 'rejected']);
  assert.equal(rowOf(w, offer).status, 'pending', 'TILL\'s offer waits for the person');
  assert.equal(rowOf(w, c).status, 'executed');
  assert.deepEqual([rowOf(w, d).reject_reason, grantEntries(w, d).length], ['Person: nein', 0]);
  assert.equal(rowOf(other, foreign).status, 'pending', '§H-TENANT: another workspace\'s Vorschlag is untouched');
  w.deps.store.close();
});

test('D204 the reason: optional under the grant by default; required (the team choice) refuses per item and in the single verb; a person never needs one', async () => {
  const { assertWhoWhen } = await import('../support/d204.mjs');
  const w = world('reason');
  const ids = drafts(w, 4);
  grant(w, 'reject');
  // The default (D204): the agent rejects under the grant without a reason; the row names who and when.
  assert.deepEqual(rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: [ids[3]] }).outcomes, { rejected: 1 });
  const bare = w.deps.store.db.prepare('SELECT status, resolved_by, resolved_at, reject_reason FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, ids[3]);
  assert.equal(bare.status, 'rejected');
  assert.equal(bare.reject_reason, null);
  assertWhoWhen(bare.resolved_by, bare.resolved_at, 'agent');
  // A team that wants the reason sets required: then it refuses per item and in the single verb.
  setting(w, 'agent.reject_reason', 'required');
  const r = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: ids.slice(0, 2) });
  assert.deepEqual(r.outcomes, { reason_required: 2 });
  assert.equal(r.items[0].refusal.setting, 'agent.reject_reason');
  const single = rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: ids[0], reason: '   ' });
  assert.deepEqual([single.error, single.reason], ['invalid_input', 'reason_required'], 'looping the single verb gets no further');
  for (const id of ids.slice(0, 3)) assert.equal(rowOf(w, id).status, 'pending');
  // Too long refuses the whole call before any id runs.
  const long = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: ids.slice(0, 3), reason: 'x'.repeat(501) });
  assert.deepEqual([long.error, long.field], ['invalid_input', 'reason']);
  setting(w, 'agent.reject_reason', 'optional');
  assert.deepEqual(rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: [ids[0]] }).outcomes, { rejected: 1 });
  assert.equal(rowOf(w, ids[0]).reject_reason, null);
  // The setting is the owner's: the agent never changes it; D202 lets it propose it to a person.
  setting(w, 'agent.reject_reason', 'required');
  const agentSet = rest(asAgent(w.deps), 'settings_set', { workspaceId: w.ws, key: 'agent.reject_reason', value: 'optional', reason: 'x', idempotencyKey: 'reason-agent' });
  assert.ok(agentSet.ok === false || (agentSet.drafted === true && agentSet.reason === 'person_only'), JSON.stringify(agentSet));
  assert.equal(w.deps.store.db.prepare("SELECT value_json FROM workspace_setting WHERE workspace_id = ? AND key = 'agent.reject_reason'").get(w.ws).value_json, '"required"');
  // A person: no reason needed, full reach, TILL's offer included.
  setting(w, 'agent.reject_reason', 'required');
  const offer = systemOffer(w, 'agent_action_sys_reason');
  const person = rest(asStudio(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: [ids[1], offer] });
  assert.deepEqual(person.outcomes, { rejected: 2 });
  assert.deepEqual([rowOf(w, ids[1]).resolved_by, rowOf(w, offer).status, grantEntries(w, offer).length], ['studio', 'rejected', 0]);
  w.deps.store.close();
});

test('revoke MID-BATCH: the ids after the revoke answer not_permitted and stay pending; the ones before stay rejected under the grant', () => {
  const w = world('mid');
  const ids = drafts(w, 5);
  grant(w, 'decide');
  // The revoke commits inside the second rejection's own transaction: the shape of a person switching the
  // grant off while the batch runs. Every later id meets the revoked grant.
  w.deps.store.db.exec(`CREATE TRIGGER test_revoke_mid_batch AFTER UPDATE OF status ON agent_action
    WHEN NEW.status = 'rejected' AND (SELECT COUNT(*) FROM agent_action WHERE workspace_id = NEW.workspace_id AND status = 'rejected') = 2
    BEGIN UPDATE workspace_setting SET value_json = '"off"' WHERE workspace_id = NEW.workspace_id AND key = 'agent.decide_proposals'; END`);
  const r = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids, reason: REASON });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.items.map((i) => i.outcome), ['rejected', 'rejected', 'not_permitted', 'not_permitted', 'not_permitted']);
  assert.deepEqual(ids.map((id) => rowOf(w, id).status), ['rejected', 'rejected', 'pending', 'pending', 'pending']);
  assert.deepEqual(ids.map((id) => grantEntries(w, id).length), [1, 1, 0, 0, 0]);
  w.deps.store.close();
});

test('the in-transaction re-read: a revoke committed between the single reject\'s checks and its transaction writes nothing (grant_revoked)', () => {
  const w = world('intx');
  const [id] = drafts(w, 1);
  grant(w, 'reject');
  const real = w.deps.store;
  // The store as the engine sees it, whose transaction first lets "another process" commit the revoke.
  const racing = Object.create(real);
  racing.tx = (fn) => {
    real.db.prepare("UPDATE workspace_setting SET value_json = '\"off\"' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(w.ws);
    return real.tx(fn);
  };
  const ctx = makeContext(racing, { workspaceId: w.ws, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids });
  const r = rejectDraftedAction(ctx, { actionId: id, reason: REASON });
  assert.deepEqual([r.error, r.reason], ['permission_denied', 'grant_revoked'], JSON.stringify(r));
  assert.deepEqual([rowOf(w, id).status, grantEntries(w, id).length], ['pending', 0]);
  real.close();
});

test('the approve flip: when the act committed no transaction, a revoke meanwhile leaves the row pending (grant_revoked)', () => {
  // A FILE-backed book, so a second connection (the other process) commits the revoke: the commit mark of the
  // approval's own connection must not see it as the act's write (the d196-revoke-in-tx.test.mjs shape).
  const dir = mkdtempSync(join(tmpdir(), 'till-d196-flip-'));
  const location = join(dir, 'book.db');
  const deps = { store: new SqliteStore({ location, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', 'flip-ws');
  const w = { deps, ws: workspaceId, accId, seed: 'flip' };
  const [id] = drafts(w, 1);
  grant(w, 'decide');
  // Turned into a bank decision the grant approves (no pin); the invoker below writes nothing, the "spent key
  // replays its memo" shape, so no transaction of the act ever reads the grant.
  deps.store.db
    .prepare("UPDATE agent_action SET action_tool = 'ignore_bank_line', dial_capability = 'post', pin_digest = NULL, payload_json = ? WHERE id = ?")
    .run(JSON.stringify({ workspaceId: w.ws, bankTxnId: 'bank_txn_x', idempotencyKey: 'flip-1' }), id);
  const other = new Database(location);
  const ctx = makeContext(deps.store, { workspaceId: w.ws, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const invoke = () => {
    other.prepare("UPDATE workspace_setting SET value_json = '\"off\"' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(w.ws);
    return { ok: true, replayed: true };
  };
  const r = approveDraftedAction(ctx, invoke, { actionId: id });
  assert.deepEqual([r.error, r.reason], ['permission_denied', 'grant_revoked'], JSON.stringify(r));
  assert.deepEqual([rowOf(w, id).status, grantEntries(w, id).length], ['pending', 0]);
  other.close();
  deps.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a demoted grantor fails closed for the whole batch: a grant signed by someone without manage_agent_dial grants nothing', () => {
  const w = world('demoted');
  const ids = drafts(w, 2);
  grant(w, 'reject');
  // Provision the book first (an unprovisioned one grants every actor every write, F1): the first invite seats
  // the local actors as owners. Then the stored grant names a signer who is no member.
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'demoted@muster.example', role: 'viewer', idempotencyKey: 'demoted-inv' }).ok, true);
  w.deps.store.db.prepare("UPDATE workspace_setting SET updated_by = 'member:gone' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(w.ws);
  const r = rest(asAgent(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids, reason: REASON });
  assert.equal(r.error, 'permission_denied', JSON.stringify(r));
  for (const id of ids) assert.equal(rowOf(w, id).status, 'pending');
  w.deps.store.close();
});

test('the list bound: an empty list and more ids than agent.batch_max_items refuse before any id runs', () => {
  const w = world('bound');
  const ids = drafts(w, 3);
  setting(w, 'agent.batch_max_items', 2);
  assert.equal(rest(asStudio(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: [] }).error, 'invalid_input');
  const big = rest(asStudio(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids });
  assert.deepEqual([big.error, big.max], ['batch_too_large', 2]);
  for (const id of ids) assert.equal(rowOf(w, id).status, 'pending');
  w.deps.store.close();
});

test('paper critic L1: the single verb says when it rejected nothing, and the batch maps that answer, never infers it', () => {
  // The race: the batch read a row pending, a person rejected it before the batch's dispatch reached it. The
  // dispatch then meets the single verb's idempotent branch, whose answer must read already_rejected.
  const w = world('race');
  const [id] = drafts(w, 1);
  assert.equal(rest(asStudio(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: id, reason: 'Person: nein' }).ok, true);
  grant(w, 'reject');
  const answer = rest(asAgent(w.deps), 'reject_drafted_action', { workspaceId: w.ws, actionId: id, reason: REASON });
  assert.deepEqual([answer.ok, answer.alreadyRejected, answer.reason], [true, true, 'Person: nein']);
  assert.equal(rejectOutcomeOf(answer), 'already_rejected');
  assert.equal(grantEntries(w, id).length, 0, 'the agent is not recorded as the decider');
  w.deps.store.close();
});

// Code critic LOW-1: the history names the grant read INSIDE the decision's transaction (paper critic L2b, N2).
// "Another process" re-signs the grant (a new signer who holds the right, a new moment) between the checks and
// the transaction; the row must name the re-signed grant, never the one read before.
const RESIGNER = 'member:resigner';
const RESIGNED_AT = '2026-03-05T09:00:00.000Z';
const resign = (db, ws) =>
  db.prepare("UPDATE workspace_setting SET updated_by = ?, updated_at = ? WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(RESIGNER, RESIGNED_AT, ws);

test('code critic LOW-1, reject: the history names the grant re-signed between the checks and the transaction', () => {
  const w = world('resign-rej');
  const [id] = drafts(w, 1);
  grant(w, 'reject');
  const real = w.deps.store;
  const racing = Object.create(real);
  racing.tx = (fn) => {
    resign(real.db, w.ws);
    return real.tx(fn);
  };
  const ctx = makeContext(racing, { workspaceId: w.ws, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids });
  const r = rejectDraftedAction(ctx, { actionId: id, reason: REASON });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [entry] = grantEntries(w, id);
  assert.deepEqual([entry.grantedBy, entry.grantedAt], [RESIGNER, RESIGNED_AT]);
  real.close();
});

/** A file-backed book with one imported bank line, so a second connection can commit beside the approval. */
function fileWorld(seed) {
  const dir = mkdtempSync(join(tmpdir(), `till-d196-${seed}-`));
  const location = join(dir, 'book.db');
  const deps = { store: new SqliteStore({ location, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  const created = getAction('create_bank_account').run(asStudio(deps), {
    workspaceId, name: 'Testbank', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: `${seed}-bank`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const imported = getAction('import_bank_statement').run(asStudio(deps), {
    workspaceId, bankAccountId: created.bankAccountId, content: 'Datum;Text;Betrag\n02.03.2026;Lieferant Beispiel;-25.00\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: `${seed}-csv`,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const txn = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ?').get(workspaceId).id;
  return { w: { deps, ws: workspaceId, accId, seed }, txn, location, dir };
}

test('code critic LOW-1, approve: the history names the grant read inside the act\'s own transaction', () => {
  const { w, txn, location, dir } = fileWorld('resign-app');
  const d = rest(asAgent(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: txn, idempotencyKey: 'resign-app-1' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  grant(w, 'decide');
  const other = new Database(location);
  const ctx = makeContext(w.deps.store, { workspaceId: w.ws, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids });
  // The re-sign commits after the approval's checks and before the act opens its transaction.
  const invoke = (tool, payload, actor) => {
    resign(other, w.ws);
    return getAction(tool).run({ ...w.deps, actor }, payload);
  };
  const r = approveDraftedAction(ctx, invoke, { actionId: d.actionId });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [entry] = grantEntries(w, d.actionId);
  assert.deepEqual([entry.grantedBy, entry.grantedAt], [RESIGNER, RESIGNED_AT]);
  other.close();
  w.deps.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('code critic LOW-1, approve flip: with no act transaction, the flip names the grant it read itself', () => {
  const { w, location, dir } = fileWorld('resign-flip');
  const [id] = drafts(w, 1);
  grant(w, 'decide');
  w.deps.store.db
    .prepare("UPDATE agent_action SET action_tool = 'ignore_bank_line', dial_capability = 'post', pin_digest = NULL, payload_json = ? WHERE id = ?")
    .run(JSON.stringify({ workspaceId: w.ws, bankTxnId: 'bank_txn_x', idempotencyKey: 'resign-flip-1' }), id);
  const other = new Database(location);
  const ctx = makeContext(w.deps.store, { workspaceId: w.ws, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids });
  const invoke = () => {
    resign(other, w.ws);
    return { ok: true, replayed: true };
  };
  const r = approveDraftedAction(ctx, invoke, { actionId: id });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [entry] = grantEntries(w, id);
  assert.deepEqual([entry.grantedBy, entry.grantedAt], [RESIGNER, RESIGNED_AT]);
  other.close();
  w.deps.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('§H-TENANT: another workspace\'s REJECTED Vorschlag answers not_found and leaks neither its state nor its reason', () => {
  const w = world('tenant');
  const other = secondWorkspace(w, 'tenant');
  const [foreign] = drafts(other, 1);
  assert.equal(rest(asStudio(w.deps), 'reject_drafted_action', { workspaceId: other.ws, actionId: foreign, reason: 'geheimer Grund' }).ok, true);
  grant(w, 'reject');
  for (const seat of [asAgent, asStudio]) {
    const r = rest(seat(w.deps), 'reject_drafted_actions', { workspaceId: w.ws, ids: [foreign], reason: REASON });
    assert.equal(r.items[0].outcome, 'not_found', JSON.stringify(r));
    assert.equal(JSON.stringify(r).includes('geheimer Grund'), false, 'the other workspace\'s reason never leaks');
  }
  assert.equal(rowOf(other, foreign).reject_reason, 'geheimer Grund');
  w.deps.store.close();
});
