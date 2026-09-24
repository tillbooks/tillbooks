/**
 * F-08 / D118 C3: `list_agent_sessions { entityRef }` finds the conversation an object came from, on
 * BOTH paths the backlink is written on: the auto path (the execute row carries `entity_ref` at once)
 * and the approval path (`approveDraftedAction` back-fills it onto the drafting call). This is the
 * read the Journal drawer's provenance line uses to link into the trace (J5.4: one click from the
 * posting to the conversation), so it has to be exact: the one session, never another tenant's.
 *
 * HOW IT BITES: drop the `AND (? IS NULL OR EXISTS (...))` clause and the filter is ignored: the
 * "unknown ref" assertion (expects zero) and the two-sessions assertion (expects one) both fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);
/** One MCP connection = one session: the transport key pins it (A35 §2a). */
const mcp = (deps, key, name, args) =>
  JSON.parse(callTool({ ...deps, agentTransportKey: key }, name, args).content[0].text);
const sessionsFor = (deps, workspaceId, entityRef) => human(deps, 'list_agent_sessions', { workspaceId, entityRef });

test('the auto path: the execute row names the entry, and entityRef finds exactly its session', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  assert.equal(human(deps, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'g' }).ok, true);

  const posted = mcp(deps, 'conn-A', 'post_entry', { workspaceId, ...manualPost(accId, 'auto-1', 1000) });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(typeof posted.entryId, 'string');
  // A second, unrelated session so the filter has something to exclude.
  mcp(deps, 'conn-B', 'list_accounts', { workspaceId });

  const all = human(deps, 'list_agent_sessions', { workspaceId });
  assert.equal(all.sessions.length, 2, 'premise: two sessions exist');
  const found = sessionsFor(deps, workspaceId, posted.entryId);
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.sessions.length, 1, 'exactly the session that posted it');
  assert.equal(found.sessions[0].writes, 1);
  assert.equal(sessionsFor(deps, workspaceId, 'entry_nope').sessions.length, 0, 'an unknown ref finds nothing');
  assert.equal(human(deps, 'list_agent_sessions', { workspaceId, entityRef: '' }).sessions.length, 2, 'a blank ref is no filter');
  deps.store.close();
});

test('the approval path: the back-filled drafting call is found by the entry the approver created', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const drafted = mcp(deps, 'conn-A', 'post_entry', { workspaceId, ...manualPost(accId, 'ask-1', 1000) });
  assert.equal(drafted.drafted, true);
  assert.equal(sessionsFor(deps, workspaceId, 'anything').sessions.length, 0, 'before approval no object exists');

  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const entryId = approved.result.entryId;
  assert.equal(typeof entryId, 'string');
  const found = sessionsFor(deps, workspaceId, entryId);
  assert.equal(found.sessions.length, 1, 'the drafting session, found by the object the APPROVER created');
  assert.equal(found.sessions[0].drafts, 1);
  deps.store.close();
});

test('§H-TENANT: an entry ref never finds another workspace\'s session', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'A GmbH', 'wa');
  const b = mintWorkspace(deps, 'B GmbH', 'wb');
  assert.equal(human(deps, 'set_agent_dial', { workspaceId: a.workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'ga' }).ok, true);
  const posted = mcp(deps, 'conn-A', 'post_entry', { workspaceId: a.workspaceId, ...manualPost(a.accId, 'a-1', 1000) });
  assert.equal(typeof posted.entryId, 'string', JSON.stringify(posted));
  assert.equal(sessionsFor(deps, a.workspaceId, posted.entryId).sessions.length, 1);
  assert.equal(sessionsFor(deps, b.workspaceId, posted.entryId).sessions.length, 0, 'workspace B sees nothing of A');
  deps.store.close();
});
