/**
 * The MCP `initialize` answer names the running package's version. It said '0.0.0' through
 * 1.0.0-beta.1, which is what every MCP directory scanning the server displayed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildMcpServer } from '../../dist/api/mcp.js';
import { freshDeps } from './support.mjs';

test('MCP serverInfo carries the package.json version, never a placeholder', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const server = buildMcpServer(freshDeps(), { pinnedActor: 'agent' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'version-probe', version: '1' }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, 'tillbooks');
    assert.equal(info?.version, pkg.version);
    assert.notEqual(info?.version, '0.0.0');
  } finally {
    await client.close();
    await server.close();
  }
});
