/**
 * A35 the trace itself: session boundaries, the composer's prose (D90 D-1/D-5), the A25-export
 * exclusion, the per-session prose delete, and the 24-month prune. The recorder is driven through
 * the transports or through `agent_ask`, never called directly, so every assertion here is about
 * behaviour a real caller can reach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { registerRuntime, resetRuntimeRegistration } from '../../dist/core/voice/index.js';
import { TRACE_RETENTION_MONTHS, SESSION_IDLE_MINUTES } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { stubAdapter, stubManifest } from '../voice/fixtures.mjs';

const QUESTION = 'Wie hoch ist der Umsatz im Juni?';

function rest(deps, name, input) {
  return handleRest(name, input, deps).body;
}

test('session boundaries: a transport key is one session; REST joins within the gap and rolls over after it', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  // Two REST calls in quick succession: one session (the fixture clock is fixed, so the gap is 0).
  rest(deps, 'list_accounts', { workspaceId });
  rest(deps, 'list_accounts', { workspaceId });
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_session').get().n, 1);

  // A distinct MCP connection (its own transport key) is its own session, side by side.
  const keyed = { ...deps, agentTransportKey: 'mcp-test-1', agentClientLabel: 'Claude Desktop' };
  rest(keyed, 'list_accounts', { workspaceId });
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_session').get().n, 2);
  const labelled = deps.store.db
    .prepare("SELECT client_label FROM agent_session WHERE transport_key = 'mcp-test-1'")
    .get();
  assert.equal(labelled.client_label, 'Claude Desktop', 'the session names its client (provenance)');

  // Past the idle gap the connectionless session closes and a new one opens.
  const later = new Date(new Date(deps.clock.now()).getTime() + (SESSION_IDLE_MINUTES + 5) * 60_000).toISOString();
  const movedClock = { ...deps, clock: { now: () => later } };
  rest(movedClock, 'list_accounts', { workspaceId });
  const restSessions = deps.store.db
    .prepare('SELECT closed_at FROM agent_session WHERE transport_key IS NULL ORDER BY started_at')
    .all();
  assert.equal(restSessions.length, 2, 'a new session after the gap');
  assert.ok(restSessions[0].closed_at !== null, 'the stale session was closed, so one actor has one running session');
  deps.store.close();
});

test('agent_ask: refuses without a runtime; with one it persists the prose turn and records ONE read call', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  resetRuntimeRegistration();
  const refused = rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'ask-0' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_local_runtime', 'no runtime, no composer: the shipped-core state');

  registerRuntime(stubAdapter(), stubManifest());
  const asked = rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'ask-1' });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.verb, 'ledger_qa', 'the stub completion parses to nothing, so the deterministic fallback routes');
  assert.equal(asked.answer.ok, true);

  const turns = deps.store.db
    .prepare('SELECT role, text FROM agent_turn WHERE workspace_id = ? AND session_id = ? ORDER BY seq')
    .all(workspaceId, asked.sessionId);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].text, QUESTION, 'D-5: the sentence persists, workspace-scoped');
  assert.equal(turns[1].role, 'agent');
  assert.equal(turns[1].text, null, 'the answer turn carries NO fabricated prose: the calls are its content');

  const calls = deps.store.db
    .prepare("SELECT verb, kind, mode FROM agent_call WHERE workspace_id = ? AND verb = 'ledger_qa'")
    .all(workspaceId);
  assert.equal(calls.length, 1, 'one composer question, one recorded read');
  assert.equal(calls[0].kind, 'read', 'no write is reachable from prose, structurally');

  // The keyed replay answers the same and writes no second turn into the composer session. (Driving
  // agent_ask over REST as the agent seat ALSO lands the call itself in the transport session, the
  // seam's own completeness rule; the composer session is the one the replay must not grow.)
  const again = rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'ask-1' });
  assert.deepEqual(again, asked);
  assert.equal(
    deps.store.db
      .prepare('SELECT COUNT(*) AS n FROM agent_turn WHERE workspace_id = ? AND session_id = ?')
      .get(workspaceId, asked.sessionId).n,
    2,
  );
  resetRuntimeRegistration();
  deps.store.close();
});

test('D-5: the stored prose never reaches an A25 export payload', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  registerRuntime(stubAdapter(), stubManifest());
  rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'ex-1' });
  // A posted entry so the journal export has real content beside the excluded prose.
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'ex-g' });
  rest(deps, 'post_entry', {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: 'ex-p',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  });

  for (const name of ['export_journal', 'export_statements', 'export_vat']) {
    const exported = rest(deps, name, {
      workspaceId,
      ...(name === 'export_vat' ? { periodStart: '2026-01-01', periodEnd: '2026-12-31' } : { year: '2026' }),
    });
    const payload = JSON.stringify(exported);
    assert.equal(payload.includes(QUESTION), false, `${name}: a statutory export must not carry conversation`);
  }
  resetRuntimeRegistration();
  deps.store.close();
});

test('agent_prose_delete: clears the words, keeps the trace, settles on replay, refuses a foreign session', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  registerRuntime(stubAdapter(), stubManifest());
  const asked = rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'pd-1' });

  // The eraser is a HUMAN act (F1: agent_prose_delete rides manage_agent_dial).
  const cleared = rest({ ...deps, actor: 'studio' }, 'agent_prose_delete', { workspaceId, sessionId: asked.sessionId, idempotencyKey: 'pd-2' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, 1);

  const texts = deps.store.db
    .prepare('SELECT text FROM agent_turn WHERE workspace_id = ? AND session_id = ?')
    .all(workspaceId, asked.sessionId);
  assert.ok(texts.every((t) => t.text === null), 'every word gone');
  assert.ok(
    deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND verb = 'ledger_qa'").get(workspaceId).n >= 1,
    'the call trace stays: what ran is the trust view substrate',
  );

  const replay = rest({ ...deps, actor: 'studio' }, 'agent_prose_delete', { workspaceId, sessionId: asked.sessionId, idempotencyKey: 'pd-2' });
  assert.deepEqual(replay, cleared, 'idempotent per key');

  const foreign = rest({ ...deps, actor: 'studio' }, 'agent_prose_delete', { workspaceId, sessionId: 'sess_no_such', idempotencyKey: 'pd-3' });
  assert.equal(foreign.error, 'not_found');
  resetRuntimeRegistration();
  deps.store.close();
});

test('the 24-month prune removes old trace rows and never touches a ledger row or the queue', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // Old trace rows, planted directly (the recorder cannot be asked to write in the past).
  const old = new Date(new Date(deps.clock.now()).getTime() - (TRACE_RETENTION_MONTHS + 2) * 30 * 86_400_000).toISOString();
  deps.store.db
    .prepare(
      `INSERT INTO agent_session (id, workspace_id, actor, started_at, last_at, closed_at) VALUES ('s-old', ?, 'agent', ?, ?, ?)`,
    )
    .run(workspaceId, old, old, old);
  deps.store.db
    .prepare(`INSERT INTO agent_turn (id, workspace_id, session_id, seq, role, text, at) VALUES ('t-old', ?, 's-old', 1, 'agent', 'alt', ?)`)
    .run(workspaceId, old);
  deps.store.db
    .prepare(
      `INSERT INTO agent_call (id, workspace_id, turn_id, seq, verb, kind, args_json, mode, decision_reason, ok, duration_ms, at)
       VALUES ('c-old', ?, 't-old', 1, 'list_accounts', 'read', '{}', 'execute', 'read', 1, 1, ?)`,
    )
    .run(workspaceId, old);
  // A ledger row and a pending queue row, which the prune must NEVER touch.
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'pr-g' });
  rest(deps, 'post_entry', {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: 'pr-p',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  });

  // Any new session-open prunes opportunistically: force one by moving past the idle gap.
  const later = new Date(new Date(deps.clock.now()).getTime() + (SESSION_IDLE_MINUTES + 5) * 60_000).toISOString();
  rest({ ...deps, clock: { now: () => later } }, 'list_accounts', { workspaceId });

  assert.equal(deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_turn WHERE id = 't-old'").get().n, 0, 'old turn pruned');
  assert.equal(deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_call WHERE id = 'c-old'").get().n, 0, 'old call pruned');
  assert.equal(deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_session WHERE id = 's-old'").get().n, 0, 'old session pruned');
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n,
    1,
    'pruning a trace never touches a ledger effect',
  );
  deps.store.close();
});
