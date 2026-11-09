// @ts-nocheck
/**
 * N01 US-N01.9: THE TOOL PROFILE of `till mcp`. `full` (the default, D183 rule 5) lists every verb;
 * `essentials` lists about forty, every one a registered verb, including the two doors to the rest
 * (`get_api_catalog { query }`, `call_tool`). The profile changes what is LISTED, never what may run.
 * The measured `tools/list` sizes are printed (tokens estimated at four characters each).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import {
  ESSENTIALS_TOOLS,
  TOOL_PROFILE_ENV,
  actionsForProfile,
  buildMcpServer,
  instructionsFor,
  resolveToolProfile,
  toolFor,
} from '../../dist/api/mcp.js';
import { freshDeps, mintWorkspace } from './support.mjs';

async function listed(profile) {
  const deps = freshDeps();
  const server = buildMcpServer(deps, { pinnedActor: 'agent', profile });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'profile-test', version: '1.0.0' });
  await client.connect(clientSide);
  const tools = (await client.listTools()).tools;
  const instructions = client.getInstructions();
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { deps, tools, instructions, call, close: async () => { await client.close(); await server.close(); deps.store.close(); } };
}

test('every essentials name is a registered verb, listed once, and the two doors are among them', () => {
  const names = new Set(ACTIONS.map((a) => a.name));
  assert.deepEqual(ESSENTIALS_TOOLS.filter((n) => !names.has(n)), [], 'an essentials name the registry does not carry');
  assert.equal(new Set(ESSENTIALS_TOOLS).size, ESSENTIALS_TOOLS.length, 'no name twice');
  for (const door of ['workspace_brief', 'get_api_catalog', 'call_tool', 'whoami']) assert.ok(ESSENTIALS_TOOLS.includes(door), door);
  assert.ok(ESSENTIALS_TOOLS.length >= 35 && ESSENTIALS_TOOLS.length <= 50, `about forty (${ESSENTIALS_TOOLS.length})`);
  assert.equal(actionsForProfile('full'), ACTIONS);
  assert.equal(actionsForProfile('essentials').length, ESSENTIALS_TOOLS.length);
});

test('tools/list follows the process profile, and a verb outside the list still runs', async () => {
  const full = await listed('full');
  const lean = await listed('essentials');
  try {
    assert.equal(full.tools.length, ACTIONS.length);
    assert.deepEqual(lean.tools.map((t) => t.name).sort(), [...ESSENTIALS_TOOLS].sort());
    assert.match(lean.instructions, /call_tool/);
    assert.doesNotMatch(full.instructions, /essential tools only/);
    const fullChars = JSON.stringify(full.tools).length;
    const leanChars = JSON.stringify(lean.tools).length;
    console.log(`tools/list full: ${full.tools.length} tools, ${fullChars} chars (~${Math.round(fullChars / 4)} tokens); essentials: ${lean.tools.length} tools, ${leanChars} chars (~${Math.round(leanChars / 4)} tokens)`);
    assert.ok(leanChars * 5 < fullChars, 'the essentials list is a fraction of the full one');
    // A profile changes what is LISTED, never what may run: an unlisted verb answers a direct call.
    const { workspaceId } = mintWorkspace(lean.deps);
    const unlisted = await lean.call('list_cost_centers', { workspaceId });
    assert.equal(unlisted.ok, true, JSON.stringify(unlisted));
    const viaDoor = await lean.call('call_tool', { name: 'list_cost_centers', args: { workspaceId } });
    assert.equal(viaDoor.ok, true, JSON.stringify(viaDoor));
    const found = await lean.call('get_api_catalog', { query: 'cost center list' });
    assert.ok(Object.keys(found.openapi.paths).includes('/api/list_cost_centers'), Object.keys(found.openapi.paths).join(','));
    assert.ok(Object.keys(found.openapi.paths).length < 20, 'the query narrows the catalog');
  } finally {
    await full.close();
    await lean.close();
  }
});

test('resolveToolProfile: --profile wins over TILL_MCP_PROFILE, full is the default, a typo is refused', () => {
  assert.equal(resolveToolProfile([], {}), 'full');
  assert.equal(resolveToolProfile([], { [TOOL_PROFILE_ENV]: 'essentials' }), 'essentials');
  assert.equal(resolveToolProfile(['--profile', 'essentials'], {}), 'essentials');
  assert.equal(resolveToolProfile(['--profile=full'], { [TOOL_PROFILE_ENV]: 'essentials' }), 'full');
  assert.throws(() => resolveToolProfile(['--profile', 'essential'], {}), /Unknown tool profile "essential"/);
  assert.throws(() => resolveToolProfile([], { [TOOL_PROFILE_ENV]: 'lean' }), /Unknown tool profile/);
  assert.match(instructionsFor('essentials'), /get_api_catalog/);
});

test('call_tool advertises its own class: a final write the dial does not govern (its item is governed)', () => {
  const tool = toolFor(getAction('call_tool'));
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.idempotentHint, true, 'keyless: the named verb keys itself');
});
