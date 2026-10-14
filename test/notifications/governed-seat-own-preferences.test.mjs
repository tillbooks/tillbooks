/**
 * CRITIC N4 (claude/rmap-land, coordinator ruling): `notifications_set_preference` is tagged `ui-state`,
 * the person's OWN UI state, and that is the only reason it is exempt from the dial. The agent seat used it
 * to switch off a person's inbox and email channels. A governed seat (the agent, a plugin call) now sets
 * its own preferences only; another user's answers `capability_forbidden` / `needs_a_person` and writes
 * nothing. A person (with manage_members for a teammate) is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { runPluginToolCall } from '../../dist/core/plugins/sandbox.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const prefs = (deps) => deps.store.db.prepare('SELECT user_id, channel, enabled FROM notification_pref ORDER BY user_id, channel').all().map((r) => ({ ...r }));

test('the agent seat cannot mute a person, over REST, MCP or a plugin call; nothing is written', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const agent = { ...deps, actor: 'agent' };
  for (const channel of ['inbox', 'email']) {
    const viaRest = handleRest('notifications_set_preference', { workspaceId, userId: 'studio', channel, enabled: false, idempotencyKey: `r-${channel}` }, agent).body;
    assert.equal(viaRest.ok, false, JSON.stringify(viaRest));
    assert.equal(viaRest.error, 'capability_forbidden');
    assert.equal(viaRest.reason, 'needs_a_person');
    const viaMcp = JSON.parse(callTool(agent, 'notifications_set_preference', { workspaceId, userId: 'studio', channel, enabled: false, idempotencyKey: `m-${channel}` }).content[0].text);
    assert.equal(viaMcp.reason, 'needs_a_person', JSON.stringify(viaMcp));
  }
  const invoke = (tool, input, actor) => getAction(tool).run({ ...deps, actor }, input);
  // A plugin call runs as the member who installed it, so it has no preferences of its own: neither the
  // installer's nor another user's may be set by it.
  for (const userId of ['studio', 'someone-else']) {
    const viaPlugin = runPluginToolCall(invoke, {
      grantedScopes: ['mcp_tool:notifications_set_preference'],
      pluginActor: 'studio',
      tool: 'notifications_set_preference',
      input: { workspaceId, userId, channel: 'inbox', enabled: false, idempotencyKey: `pl-${userId}` },
    });
    assert.equal(viaPlugin.ok, false, JSON.stringify(viaPlugin));
    assert.equal(viaPlugin.reason, 'needs_a_person', userId);
  }
  assert.deepEqual(prefs(deps), []);
  deps.store.close();
});

test('the agent seat sets its own preference, and a person sets their own', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const own = handleRest('notifications_set_preference', { workspaceId, userId: 'agent', channel: 'email', enabled: false, idempotencyKey: 'own' }, { ...deps, actor: 'agent' }).body;
  assert.equal(own.ok, true, JSON.stringify(own));
  const person = getAction('notifications_set_preference').run({ ...deps, actor: 'studio' }, { workspaceId, userId: 'studio', channel: 'inbox', enabled: false, idempotencyKey: 'p' });
  assert.equal(person.ok, true, JSON.stringify(person));
  assert.deepEqual(prefs(deps), [
    { user_id: 'agent', channel: 'email', enabled: 0 },
    { user_id: 'studio', channel: 'inbox', enabled: 0 },
  ]);
  deps.store.close();
});
