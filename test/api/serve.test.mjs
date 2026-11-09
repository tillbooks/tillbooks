// `till serve` (D23 / G1): the production /mcp StreamableHTTP host. The smoke test binds the real
// listener on an ephemeral loopback port, connects a real MCP client over HTTP, and proves the host
// answers tools/list and one read verb over the wire, so the A11 demo can run without Vite. Offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpServer } from '../../dist/api/serve.js';

test('till serve: hosts /mcp over HTTP and answers tools/list + a read verb', async () => {
  // An ephemeral in-memory ledger on a loopback port: nothing leaves 127.0.0.1.
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0 });
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const client = new Client({ name: 'serve-smoke', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`)));

    // tools/list over the wire advertises the registry, including the A11 verbs.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('issue_invoice'), 'issue_invoice advertised over HTTP');
    assert.ok(names.includes('send_invoice'), 'send_invoice advertised over HTTP');
    assert.ok(names.includes('create_workspace'));

    // A write then a read verb, driven entirely over HTTP: mint a workspace, then list documents.
    const created = JSON.parse(
      (await client.callTool({ name: 'create_workspace', arguments: { name: 'Serve GmbH', idempotencyKey: 'ws-1' } })).content[0].text,
    );
    assert.equal(created.ok, true);
    const listed = JSON.parse(
      (await client.callTool({ name: 'list_documents', arguments: { workspaceId: created.workspaceId, type: 'invoice' } })).content[0].text,
    );
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.documents, []);
  } finally {
    await client.close();
    await handle.close();
  }
});
