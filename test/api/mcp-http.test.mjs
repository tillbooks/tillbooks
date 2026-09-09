// D12 + D13: the Studio speaks MCP over StreamableHTTP, and the audit actor is declared ONCE per
// session at `initialize` and inherited by every call in it.
//
// These drive the REAL SDK client against the REAL SDK server transport over a real loopback HTTP
// server, because the point of D12 is the wire, and a fake would prove nothing about it. Nothing
// leaves 127.0.0.1, so the suite stays offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpHandler, STUDIO_CLIENT_NAME, resolveSessionActor } from '../../dist/api/mcp-http.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';

/** Start the MCP HTTP handler on an ephemeral port. Returns the base URL and a teardown. */
async function startHttp(deps) {
  const handler = createMcpHttpHandler(deps);
  const http = createServer((req, res) => {
    void handler.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    async stop() {
      await handler.closeAll();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/**
 * Run `body` against a live MCP HTTP server and tear EVERYTHING down afterwards, pass or fail.
 * Without the finally, a failed assertion leaves the loopback server and its sessions open and the
 * whole node:test run hangs on the open handles instead of reporting the failure.
 */
async function withServer(body) {
  const { deps, store } = makeApiDeps();
  const server = await startHttp(deps);
  const clients = [];
  const open = async (clientName) => {
    const client = await connect(server.url, clientName);
    clients.push(client);
    return client;
  };
  try {
    await body({ deps, open });
  } finally {
    for (const c of clients) await c.close();
    await server.stop();
    store.close();
  }
}

/** Connect an MCP client that declares `clientName` at initialize. */
async function connect(url, clientName) {
  const client = new Client({ name: clientName, version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

/** Call a tool and parse the single JSON text block back into a verb Result. */
async function callVerb(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
}

test('resolveSessionActor maps the declared client to an actor string, and every other name is agent', () => {
  assert.equal(resolveSessionActor({ name: STUDIO_CLIENT_NAME }), 'studio');
  assert.equal(resolveSessionActor({ name: 'claude-ai' }), 'agent');
  assert.equal(resolveSessionActor(undefined), 'agent');
  assert.equal(resolveSessionActor({}), 'agent');
  // F-08: there is NO host-supplied fallback any more. A second argument used to let a host seat an
  // unknown client as anything (till up passed `studio`, so Claude Desktop bypassed the dial); the
  // seating rule is the transport's and admits exactly the two closed-map seats.
  assert.equal(resolveSessionActor({ name: 'unknown' }, 'treuhand:mueller'), 'agent');
  assert.equal(resolveSessionActor({ name: 'unknown' }, 'studio'), 'agent');
});

test('the MCP HTTP transport lists the same tools the registry defines', async () => {
  await withServer(async ({ open }) => {
    const client = await open('probe');
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 51, `expected the full registry surface, saw ${tools.length}`);
    assert.ok(tools.some((t) => t.name === 'list_workspaces'));
    assert.equal(tools.find((t) => t.name === 'get_entry').annotations.readOnlyHint, true);
  });
});

test('a verb Result crosses the wire intact: ok, domain rejection, and unknown action', async () => {
  await withServer(async ({ open }) => {
    const client = await open(STUDIO_CLIENT_NAME);
    const created = await callVerb(client, 'create_workspace', { name: 'Wire GmbH', idempotencyKey: 'w1' });
    assert.equal(created.ok, true);
    assert.match(created.workspaceId, /^ws_/);

    // A domain rejection is a normal result the caller reads, never an MCP protocol error.
    const rejected = await callVerb(client, 'get_company_profile', { workspaceId: 'ws_nope' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'workspace_not_found');

    const unknown = await callVerb(client, 'no_such_tool', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'unknown_action');
  });
});

test('D13: a Studio session is NOT recorded as agent, and an agent session still is', async () => {
  await withServer(async ({ deps, open }) => {
    // One session declaring the Studio, one declaring nothing in particular.
    const studio = await open(STUDIO_CLIENT_NAME);
    const agent = await open('some-agent');
    const ws = await callVerb(studio, 'create_workspace', { name: 'Audit GmbH', idempotencyKey: 'a1' });
    const workspaceId = ws.workspaceId;
    const accId = (number) =>
      deps.store.db
        .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
        .get(workspaceId, number).id;

    const entry = (key) => ({
      workspaceId,
      date: '2026-03-01',
      description: 'Büromaterial',
      source: 'manual',
      idempotencyKey: key,
      lines: [
        { account: accId('6500'), debit: 5000 },
        { account: accId('1000'), credit: 5000 },
      ],
    });

    const byStudio = await callVerb(studio, 'post_entry', entry('s-1'));
    // A35: the transport dispatch routes the agent seat's post through the dial, and every dial
    // ships at ask, so the STUDIO (holding manage_agent_dial) grants post -> auto first: the D103
    // ceremony, which is how a real workspace arms its agent. The attribution claim is unchanged.
    const granted = await callVerb(studio, 'set_agent_dial', {
      workspaceId,
      capability: 'post',
      level: 'auto',
      idempotencyKey: 'd13-grant',
    });
    assert.equal(granted.ok, true);
    const byAgent = await callVerb(agent, 'post_entry', entry('a-2'));
    assert.equal(byStudio.ok, true);
    assert.equal(byAgent.ok, true);

    const rows = deps.store.db
      .prepare('SELECT entity_id, actor FROM audit_log WHERE workspace_id = ? AND entity_kind = ?')
      .all(workspaceId, 'entry');
    const actorOf = (entryId) => rows.find((r) => r.entity_id === entryId).actor;

    assert.equal(actorOf(byStudio.entryId), 'studio', 'a human action stamped as agent corrupts the trail');
    assert.notEqual(actorOf(byStudio.entryId), 'agent');
    assert.equal(actorOf(byAgent.entryId), 'agent');
  });
});

test('two MCP sessions write to ONE database: the agent sees what the Studio posted', async () => {
  await withServer(async ({ open }) => {
    const studio = await open(STUDIO_CLIENT_NAME);
    const agent = await open('some-agent');
    const ws = await callVerb(studio, 'create_workspace', { name: 'Shared GmbH', idempotencyKey: 's1' });
    const seen = await callVerb(agent, 'list_workspaces', {});
    assert.equal(seen.ok, true);
    assert.ok(
      seen.workspaces.some((w) => w.workspaceId === ws.workspaceId),
      'the agent session must see the workspace the Studio session minted',
    );
  });
});

test('stdio deps keep the agent actor, so `till mcp` is unchanged', () => {
  const { deps, store } = makeApiDeps();
  assert.equal(deps.actor, 'agent');
  // And the in-process registry path (what the parity test drives) is untouched by the session work.
  const res = getAction('create_workspace').run(deps, { name: 'Stdio GmbH', idempotencyKey: 'k' });
  assert.equal(res.ok, true);
  store.close();
});
