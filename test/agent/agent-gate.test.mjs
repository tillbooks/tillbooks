/**
 * A35 the governed transport dispatch: trace completeness, the dial routing, the backlink on BOTH
 * paths, and §H-TENANT over the trace, all driven through the REAL transport faces (`handleRest` /
 * `callTool`), never by calling the recorder directly. These are the assertions the trust view rests
 * on, and each one is paired with the probe that proves it can fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** REST as the agent seat: the connectionless face (the idle-gap session rule applies). */
function rest(deps, name, input) {
  return handleRest(name, input, deps).body;
}

function callCount(deps, workspaceId) {
  return deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ?').get(workspaceId).n;
}

function postArgs(workspaceId, accId, key) {
  return {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 120000 },
      { account: accId('1020'), credit: 120000 },
    ],
  };
}

test('trace completeness: every agent-seat call over REST lands exactly one agent_call row, reads and refusals included', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  assert.equal(callCount(deps, workspaceId), 0);

  // A read.
  const read = rest(deps, 'list_accounts', { workspaceId });
  assert.equal(read.ok, true);
  assert.equal(callCount(deps, workspaceId), 1, 'a question is not a lesser event: the read is one row');

  // A refusal (invalid input) is a row too, never a silent no-op.
  const refused = rest(deps, 'get_entry', { workspaceId, entryId: '' });
  assert.equal(refused.ok, false);
  assert.equal(callCount(deps, workspaceId), 2);
  const refusedRow = deps.store.db
    .prepare('SELECT ok, error_code FROM agent_call WHERE workspace_id = ? ORDER BY at DESC, seq DESC LIMIT 1')
    .get(workspaceId);
  assert.equal(refusedRow.ok, 0);
  assert.equal(typeof refusedRow.error_code, 'string');

  // A write whose MODULE NEVER CALLS ctx.audit.record (G00's saved views) is in the trace anyway,
  // because the recorder sits at the seam every call passes, not in any module (design row 10.2).
  const view = rest(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Meine Sicht',
    idempotencyKey: 'sv-1',
  });
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(callCount(deps, workspaceId), 3);
  const audited = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'saved_view'")
    .get(workspaceId);
  assert.equal(audited.n, 0, 'the premise: this module writes no audit row, so ONLY the trace covers it');

  // Exactly one row per call: the same verb again is a second row, never a merge and never a third.
  rest(deps, 'list_accounts', { workspaceId });
  assert.equal(callCount(deps, workspaceId), 4);
  deps.store.close();
});

test('humans open no session: the studio seat over the same faces lands zero trace rows', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const asStudio = { ...deps, actor: 'studio' };
  rest(asStudio, 'list_accounts', { workspaceId });
  const mcp = callTool(asStudio, 'list_accounts', { workspaceId });
  assert.equal(JSON.parse(mcp.content[0].text).ok, true);
  assert.equal(callCount(deps, workspaceId), 0, 'a human via the GUI or any transport opens no session');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_session').get().n, 0);
  deps.store.close();
});

test('the dial routes at the seam: an ungranted agent post drafts, a granted one executes, on ROWS', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // Default ask: the write drafts. NOTHING reaches the journal.
  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'gate-1'));
  assert.equal(drafted.ok, true);
  assert.equal(drafted.drafted, true);
  assert.equal(drafted.dialCapability, 'post');
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'a drafted post writes NO journal row',
  );
  const draftRow = deps.store.db
    .prepare("SELECT * FROM agent_call WHERE workspace_id = ? AND mode = 'draft'")
    .get(workspaceId);
  assert.equal(draftRow.verb, 'post_entry');
  assert.equal(draftRow.agent_action_id, drafted.actionId);
  assert.equal(draftRow.entity_ref, null, 'at draft time nothing was created, so no entity_ref');

  // The attributed HUMAN grant (F1: the agent seat may never write its own dial), then the same
  // write executes and carries its entity_ref immediately.
  const grant = rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'gate-g' });
  assert.equal(grant.ok, true);
  const executed = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'gate-2'));
  assert.equal(executed.ok, true);
  assert.equal(executed.drafted, undefined);
  const execRow = deps.store.db
    .prepare("SELECT * FROM agent_call WHERE workspace_id = ? AND mode = 'execute' AND verb = 'post_entry'")
    .get(workspaceId);
  assert.equal(execRow.entity_ref, executed.entryId, 'the auto path carries the created object immediately');
  deps.store.close();
});

test('the backlink on the DEFAULT path: approval replays as the approver and back-fills the drafting call row', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'bl-1'));
  assert.equal(drafted.drafted, true);

  // The approver is a DIFFERENT actor (the self-approve ban is real underneath).
  const approve = getAction('approve_drafted_action').run(
    { ...deps, actor: 'studio' },
    { workspaceId, actionId: drafted.actionId },
  );
  assert.equal(approve.ok, true, JSON.stringify(approve));

  // The created entry is stamped with the APPROVER, which is exactly why created_by can never be the
  // backlink: the drafting call row is the only place object and turn meet.
  const entry = deps.store.db
    .prepare('SELECT id, created_by FROM journal_entry WHERE workspace_id = ?')
    .get(workspaceId);
  assert.equal(entry.created_by, 'studio');

  const row = deps.store.db
    .prepare('SELECT * FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?')
    .get(workspaceId, drafted.actionId);
  assert.equal(row.entity_ref, entry.id, 'the approve back-filled the created object onto the drafting row');
  assert.equal(row.resolved_by, 'studio');
  assert.ok(row.resolved_at !== null);

  // BOTH paths resolve to exactly one turn: the entity_ref join finds one call row, hence one turn.
  const resolving = deps.store.db
    .prepare('SELECT COUNT(DISTINCT turn_id) AS n FROM agent_call WHERE workspace_id = ? AND entity_ref = ?')
    .all(workspaceId, entry.id);
  assert.equal(resolving[0].n, 1);
  deps.store.close();
});

test('the self-approve ban bites through the seam: the drafting seat approving its own draft moves nothing', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'sa-1'));
  const selfApprove = rest(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId });
  assert.equal(selfApprove.ok, false);
  // Post-F1 the A24 boundary denies the agent seat `manage_agent_dial` before the verb's own actor
  // rule runs; the engine-level cannot_self_approve stands behind it (test/agent/drafted-actions).
  assert.ok(
    selfApprove.error === 'permission_denied' || selfApprove.error === 'cannot_self_approve',
    selfApprove.error,
  );
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'zero ledger writes on a refused self-approve',
  );
  deps.store.close();
});

test('D103 grant ceremony at the seam: vat_mark_filed drafts even after an UNATTRIBUTED auto row, executes after the real grant', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'vf-g0' });
  rest(deps, 'post_entry', postArgs(workspaceId, accId, 'vf-p'));

  // An unattributed auto row (the pre-D103 escape): the seam still drafts. FAIL-CLOSED.
  deps.store.db
    .prepare(`INSERT INTO agent_dial (workspace_id, capability, level, updated_at) VALUES (?, 'vat-file', 'auto', ?)`)
    .run(workspaceId, deps.clock.now());
  const still = rest(deps, 'vat_mark_filed', { workspaceId, period: '2026-06', idempotencyKey: 'vf-1' });
  assert.equal(still.ok, true);
  assert.equal(still.drafted, true, 'an unsigned auto row is not a grant');
  assert.equal(still.reason, 'force_ask');

  // The explicit attributed act (the ceremony): now the verb EXECUTES (whatever the engine then
  // says about the period): the routing fact is `drafted` absent, and the engine's own answer is
  // the engine's own business.
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'vat-file', level: 'auto', idempotencyKey: 'vf-g1' });
  const filed = rest(deps, 'vat_mark_filed', { workspaceId, period: '2026-06', idempotencyKey: 'vf-2' });
  assert.equal(filed.drafted, undefined, 'a granted strong-default capability executes at auto');
  const execRow = deps.store.db
    .prepare("SELECT mode FROM agent_call WHERE workspace_id = ? AND verb = 'vat_mark_filed' ORDER BY at DESC, seq DESC LIMIT 1")
    .get(workspaceId);
  assert.equal(execRow.mode, 'execute');
  deps.store.close();
});

test('approve and allow in future (D103): one approve executes AND records the same attributed dial write', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const drafted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'af-1'));
  assert.equal(drafted.drafted, true);

  const approve = getAction('approve_drafted_action').run(
    { ...deps, actor: 'studio' },
    { workspaceId, actionId: drafted.actionId, allowFuture: true },
  );
  assert.equal(approve.ok, true, JSON.stringify(approve));
  assert.deepEqual(approve.granted, { capability: 'post', level: 'auto' });

  const dialRow = deps.store.db
    .prepare("SELECT level, updated_by FROM agent_dial WHERE workspace_id = ? AND capability = 'post'")
    .get(workspaceId);
  assert.equal(dialRow.level, 'auto');
  assert.equal(dialRow.updated_by, 'studio', 'the grant is attributed to the approving human');

  // The NEXT agent post executes without asking: the grant took effect through the same store.
  const next = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'af-2'));
  assert.equal(next.ok, true);
  assert.equal(next.drafted, undefined);

  // Idempotent on ROWS: replaying the approve changes neither the queue nor the dial.
  const again = getAction('approve_drafted_action').run(
    { ...deps, actor: 'studio' },
    { workspaceId, actionId: drafted.actionId, allowFuture: true },
  );
  assert.equal(again.ok, true);
  const dialRows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?').get(workspaceId);
  assert.equal(dialRows.n, 1);
  deps.store.close();
});

test('a pre-validated draft: an input the verb would reject NEVER reaches the queue', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  // post_entry with its required fields missing: it falls through to the verb, whose OWN boundary
  // rejects with its own code (face parity, rule 7), and nothing is drafted.
  const bad = rest(deps, 'post_entry', { workspaceId });
  assert.equal(bad.ok, false);
  assert.equal(bad.drafted, undefined);
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'the queue holds no payload its verb would refuse at replay',
  );
  deps.store.close();
});

test('H-TENANT: the trace is workspace-keyed, and the guard (not absence) is what refuses a foreign read', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Mandant A', 'ws-a');
  const b = getAction('create_workspace').run(deps, { name: 'Mandant B', idempotencyKey: 'ws-b' });

  rest(deps, 'list_accounts', { workspaceId: a.workspaceId });
  const sessions = rest(deps, 'list_agent_sessions', { workspaceId: a.workspaceId });
  assert.equal(sessions.ok, true);
  assert.equal(sessions.sessions.length, 1);
  const sessionId = sessions.sessions[0].sessionId;

  // The row EXISTS (proven in A), and B still reads not_found: the tenant guard is what refused.
  const foreign = rest(deps, 'get_agent_session', { workspaceId: b.workspaceId, sessionId });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');

  // NON-VACUITY, the mutation probe: run the same lookup WITHOUT the tenant key and it resolves,
  // which is exactly the leak the guard exists to prevent. If this ever stops resolving, the tenant
  // assertion above has gone vacuous and must be re-examined.
  const unguarded = deps.store.db.prepare('SELECT id FROM agent_session WHERE id = ?').get(sessionId);
  assert.ok(unguarded !== undefined, 'the row is really there: only the workspace key refused it');

  // B's own trace is empty: nothing leaked across.
  const bSessions = rest(deps, 'list_agent_sessions', { workspaceId: b.workspaceId });
  // The list read itself just became B's first trace row, so filter to sessions with foreign ids.
  assert.equal(bSessions.sessions.some((s) => s.sessionId === sessionId), false);
  deps.store.close();
});
