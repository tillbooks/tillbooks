// M-4: DNS-rebinding protection on the shared MCP HTTP handler (till serve + the Studio bridge).
//
// A malicious page in the user's browser can script fetches to 127.0.0.1 after a DNS rebind, and
// the browser will happily deliver them; the ONLY reliable local defence is validating the Host and
// Origin headers at the endpoint (the MCP spec's local-deployment guidance for StreamableHTTP).
// A request whose Host is not a localhost host, or whose Origin is present and not a localhost
// origin, must be rejected BEFORE it reaches the transport; loopback requests keep working.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createMcpHttpHandler } from '../../dist/api/mcp-http.js';
import { makeApiDeps } from '../../dist/api/mcp.js';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
});

async function withHandler(body) {
  const { deps, store } = makeApiDeps();
  const handler = createMcpHttpHandler(deps);
  const http = createServer((req, res) => {
    void handler.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  try {
    await body({ port });
  } finally {
    await handler.closeAll();
    await new Promise((resolve) => http.close(resolve));
    store.close();
  }
}

function post(port, headers) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INITIALIZE,
  });
}

test('M-4: a foreign Origin is rejected with 403 before the transport sees it', async () => {
  await withHandler(async ({ port }) => {
    const res = await post(port, { origin: 'https://evil.example' });
    assert.equal(res.status, 403, `foreign Origin must be rejected, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error, 'forbidden_origin');
  });
});

test('M-4: a rebound (foreign) Host header is rejected with 403', async () => {
  await withHandler(async ({ port }) => {
    // fetch forbids setting Host directly; speak raw HTTP to spoof it the way a rebound DNS name
    // arrives (the TCP connection is loopback, the Host header is the attacker's domain).
    const { createConnection } = await import('node:net');
    const raw = await new Promise((resolve, reject) => {
      const socket = createConnection(port, '127.0.0.1', () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: evil.example\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(INITIALIZE)}\r\nConnection: close\r\n\r\n${INITIALIZE}`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 403/, `foreign Host must be rejected, got: ${raw.slice(0, 80)}`);
  });
});

test('M-4: an Origin of "null" (sandboxed page) is rejected', async () => {
  await withHandler(async ({ port }) => {
    const res = await post(port, { origin: 'null' });
    assert.equal(res.status, 403);
  });
});

test('M-4: localhost requests are accepted: no Origin (CLI/agent) and a localhost Origin (Studio)', async () => {
  await withHandler(async ({ port }) => {
    // An agent/CLI client sends no Origin at all: must pass.
    const cli = await post(port, {});
    assert.equal(cli.status, 200, `no-Origin initialize must pass, got ${cli.status}`);
    // The Studio dev server speaks from a localhost origin (any port): must pass.
    const studio = await post(port, { origin: 'http://localhost:5173' });
    assert.equal(studio.status, 200, `localhost Origin must pass, got ${studio.status}`);
    const loopback = await post(port, { origin: 'http://127.0.0.1:8788' });
    assert.equal(loopback.status, 200);
  });
});
