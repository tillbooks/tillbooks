// A43 section 5, the contract on the MCP wire: the prompt settlement_from_source and the resource
// till://formats/till-settlement-v1, over an in-memory MCP client around buildMcpServer. SYNTHETIC DATA ONLY.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildMcpServer } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const SCHEMA_FILE = new URL('../../schemas/till-settlement-v1.schema.json', import.meta.url);

async function connected(deps) {
  const server = buildMcpServer(deps, { pinnedActor: 'agent' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'contract-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('resources/list offers the schema and resources/read serves exactly the committed file', async () => {
  const deps = freshDeps();
  const { client, close } = await connected(deps);
  try {
    const { resources } = await client.listResources();
    const r = resources.find((x) => x.uri === 'till://formats/till-settlement-v1');
    assert.ok(r, 'the schema resource is listed');
    assert.equal(r.mimeType, 'application/schema+json');
    const read = await client.readResource({ uri: 'till://formats/till-settlement-v1' });
    assert.equal(read.contents[0].text, readFileSync(SCHEMA_FILE, 'utf8'));
    // The brief resources still work beside it.
    await assert.rejects(() => client.readResource({ uri: 'till://formats/nope' }));
  } finally {
    await close();
  }
});

test('prompts/list offers settlement_from_source beside the checklist prompts, and prompts/get walks the agent', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Prompt GmbH', 'sfs-ws');
  const { client, close } = await connected(deps);
  try {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'checklist_vat_period'), 'the checklist prompts stay');
    const p = prompts.find((x) => x.name === 'settlement_from_source');
    assert.ok(p, 'the prompt is listed');
    assert.deepEqual(p.arguments.filter((a) => a.required).map((a) => a.name), ['workspaceId', 'system', 'processor']);
    const res = await client.getPrompt({ name: 'settlement_from_source', arguments: { workspaceId, system: 'Demoshop', processor: 'Demopay', from: '2026-07-01', to: '2026-07-31' } });
    const text = res.messages[0].content.text;
    // The walk, in order: schema, validate, template, review, import with the review digest.
    const order = ['till://formats/till-settlement-v1', 'validate_settlement', 'get_settlement_template', 'settlement_review', 'import_settlement', 'expectReviewSha256', 'Vorschlag'].map((k) => text.indexOf(k));
    assert.ok(order.every((i) => i >= 0), `the prompt names every step: ${order}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in this order');
    assert.match(text, /Demoshop \/ Demopay/);
    // A prompt that names a verb that does not exist would teach an agent a dead end.
    for (const verb of ['validate_settlement', 'get_settlement_template', 'settlement_review', 'import_settlement', 'set_settlement_template']) {
      assert.ok(getAction(verb), `${verb} exists in the registry`);
    }
    await assert.rejects(() => client.getPrompt({ name: 'settlement_from_source', arguments: {} }), 'workspaceId is required');
  } finally {
    await close();
  }
});

test('validate_settlement runs over the wire as a tool and answers the reader', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Wire GmbH', 'sfs-wire');
  const { client, close } = await connected(deps);
  try {
    const doc = { schema: 'till-settlement/v1', source: { system: 'Demoshop', processor: 'Demopay' }, events: [{ id: 'w1', kind: 'sale', day: '2026-07-03', currency: 'CHF', amount: '108.10', net: '100.00', vat: { amount: '8.10' } }] };
    const res = await client.callTool({ name: 'validate_settlement', arguments: { workspaceId, settlement: doc } });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.valid, true);
    assert.equal(body.events.readable, 1);
  } finally {
    await close();
  }
});
