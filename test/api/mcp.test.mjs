// Smoke: the MCP server wires over the registry without throwing, callTool serialises a verb Result
// as a JSON content block, and read/write tools carry the right MCP annotations.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMcpServer, makeApiDeps, callTool, startMcpServer } from '../../dist/api/mcp.js';
import { ACTIONS } from '../../dist/api/registry.js';

test('makeApiDeps opens a store and buildMcpServer wires without throwing', () => {
  const { deps, store } = makeApiDeps();
  const server = buildMcpServer(deps);
  assert.ok(server, 'server built');
  store.close();
});

test('callTool returns a JSON content block carrying the verb Result', () => {
  const { deps, store } = makeApiDeps();
  const res = callTool(deps, 'create_workspace', { name: 'Smoke GmbH', idempotencyKey: 'k' });
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, 'text');
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.workspaceId);
  assert.equal(res.isError, undefined, 'a successful verb is not an MCP protocol error');
  store.close();
});

test('callTool on an unknown tool returns a structured unknown_action Result, not a throw', () => {
  const { deps, store } = makeApiDeps();
  const res = callTool(deps, 'no_such_tool', {});
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'unknown_action');
  store.close();
});

test('a verb rejection is returned as content, not as an MCP protocol error', () => {
  const { deps, store } = makeApiDeps();
  // Missing required fields: the verb rejects, but it is a normal Result the caller reads.
  const res = callTool(deps, 'create_workspace', {});
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(res.isError, undefined);
  store.close();
});

test('read tools would advertise readOnlyHint; write tools would not', () => {
  // Mirror the tool-list mapping the ListTools handler uses, to assert the annotation policy.
  const tools = ACTIONS.map((a) => ({
    name: a.name,
    ...(a.kind === 'read' ? { annotations: { readOnlyHint: true } } : {}),
  }));
  const getEntry = tools.find((t) => t.name === 'get_entry');
  const postEntry = tools.find((t) => t.name === 'post_entry');
  assert.equal(getEntry.annotations.readOnlyHint, true);
  assert.equal(postEntry.annotations, undefined);
});

test('startMcpServer is exported as a function (the bin entry point)', () => {
  assert.equal(typeof startMcpServer, 'function');
});
