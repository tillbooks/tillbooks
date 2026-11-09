/**
 * F-08 (b): `close_month`, `reopen_month` and `unlock_period` are dial-governed under `close-period`.
 *
 * Until 2026-09-05 the map governed only the HARD seals (`close_year`, a `lock_period`), on the
 * reading that a soft close "carries no engine consequence". J4.6 measured what that reading cost: the
 * agent soft-closed August with no Vorschlag while a drafted revaluation waited, and the human's own
 * approval then failed `period_locked`. Sealing a month against posting, and undoing a human's seal,
 * are governed acts either way, so all three draft at `ask` and carry a consequence sentence.
 *
 * Driven through the REAL transport dispatch (`callTool`), never `action.run`, because the seam IS the
 * thing under test. HOW IT BITES: delete the three entries from `DIAL_CAPABILITY_FOR_ACTION` and the
 * agent's close_month executes (`drafted` undefined, `list_period_locks` shows the month closed at
 * once, zero Vorschläge), which is exactly the J4.6 measurement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function mcp(deps, name, args) {
  return JSON.parse(callTool(deps, name, args).content[0].text);
}

/** The human decider (studio) acts through the registry directly: no session, no dial. */
function human(deps, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, input);
}

function locksOf(deps, workspaceId) {
  const res = human(deps, 'list_period_locks', { workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

function isClosed(deps, workspaceId, period) {
  const locks = locksOf(deps, workspaceId);
  const rows = locks.locks ?? locks.periods ?? locks.items ?? [];
  return rows.some((l) => (l.period ?? l.month) === period && (l.status ?? l.kind ?? 'closed') !== 'open');
}

test('the three soft period verbs are mapped under close-period and carry a sentence', () => {
  for (const name of ['close_month', 'reopen_month', 'unlock_period']) {
    const action = getAction(name);
    assert.ok(action, name);
    assert.equal(typeof action.consequence, 'string', `${name}: the engine sentence exists (DESIGN.md C4 shares it)`);
    assert.ok(action.consequence.length > 20);
  }
});

test('an agent close_month at ask DRAFTS: the month stays open, one Vorschlag, one trace row; approval closes it', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  assert.equal(isClosed(deps, workspaceId, '2026-06'), false, 'premise: June is open');

  const closed = mcp(deps, 'close_month', { workspaceId, period: '2026-06', idempotencyKey: 'agent-close-06' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.drafted, true, 'close_month is governed: it drafts at ask, never executes');
  assert.equal(closed.dialCapability, 'close-period');
  assert.equal(isClosed(deps, workspaceId, '2026-06'), false, 'the ungoverned close of J4.6 must not happen: June is still open');

  const rows = deps.store.db
    .prepare("SELECT verb, mode, dial_capability FROM agent_call WHERE workspace_id = ? AND verb = 'close_month'")
    .all(workspaceId);
  assert.deepEqual(rows, [{ verb: 'close_month', mode: 'draft', dial_capability: 'close-period' }]);

  // A human approves: the replay runs as the approver and the month closes ONCE.
  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: closed.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(isClosed(deps, workspaceId, '2026-06'), true, 'the approved close seals June');
  const again = human(deps, 'approve_drafted_action', { workspaceId, actionId: closed.actionId });
  assert.equal(again.ok, true, 'approve-twice settles');

  // Reopening the human's seal is governed too: the agent drafts, June stays closed.
  const reopened = mcp(deps, 'reopen_month', { workspaceId, period: '2026-06', idempotencyKey: 'agent-reopen-06' });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.drafted, true, 'reopen_month drafts at ask');
  assert.equal(isClosed(deps, workspaceId, '2026-06'), true, 'the agent cannot undo a seal on its own');
});

test('an agent unlock_period at ask DRAFTS: a soft lock a human set stays in place', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const locked = human(deps, 'lock_period', { workspaceId, period: '2026-05', kind: 'soft', idempotencyKey: 'h-lock-05' });
  assert.equal(locked.ok, true, JSON.stringify(locked));
  const unlocked = mcp(deps, 'unlock_period', { workspaceId, period: '2026-05', idempotencyKey: 'agent-unlock-05' });
  assert.equal(unlocked.ok, true, JSON.stringify(unlocked));
  assert.equal(unlocked.drafted, true, 'unlock_period drafts at ask');
  assert.equal(isClosed(deps, workspaceId, '2026-05'), true, 'the human lock survives the agent call');
  deps.store.close();
});

test('the human path is untouched: studio close_month executes at once and opens no session', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const closed = mcp({ ...deps, actor: 'studio' }, 'close_month', { workspaceId, period: '2026-04', idempotencyKey: 'studio-close-04' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.notEqual(closed.drafted, true);
  assert.equal(isClosed(deps, workspaceId, '2026-04'), true);
  const rows = deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(rows, 0);
  deps.store.close();
});
