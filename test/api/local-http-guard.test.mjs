// BLOCKER-2: ONE localhost guard in front of EVERY registry-reaching HTTP face.
//
// The M-4 remediation put DNS-rebinding protection on `/mcp` and claimed it covered "till serve and
// the Studio bridge alike". It did not. The Studio bridge mounts a SECOND face on the same port,
// `POST /api/:action`, which resolves the SAME 60-action registry, and that face had no check at
// all: a page on any website could POST /api/post_entry at the dev server and land an immutable
// journal entry in the real ledger. Changing four characters in the URL bypassed the whole guard.
//
// These tests exercise the REAL mounted router (`createLocalHttpRouter`), the one both faces are
// dispatched from, over a real HTTP listener, and read the ledger afterwards. A unit test on the
// guard function would have passed throughout the vulnerable window, which is exactly why there is
// none here. The last test is structural: it fails if the dev bridge ever reaches the registry
// again by any route other than the shared router.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';

import { createLocalHttpRouter } from '../../dist/api/local-http.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';

const EVIL_ORIGIN = 'https://evil.example';
const EVIL_HOST = 'evil.example';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
});

/**
 * Mount the bridge exactly as the Studio dev bridge mounts it: BOTH faces, one router, one listener.
 * `handled === false` falls through to a 404, the way Vite would fall through to the SPA.
 */
async function withBridge(body) {
  const { deps, store } = makeApiDeps();
  const router = createLocalHttpRouter(deps, { rest: true });
  const http = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  try {
    await body({ port, store, deps, router });
  } finally {
    await router.closeAll();
    await new Promise((resolve) => http.close(resolve));
    store.close();
  }
}

/** POST JSON at the bridge with whatever headers the caller wants to forge. */
function post(port, path, payload, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/**
 * `fetch` refuses to set Host, so a rebound request is spoken as raw HTTP: the TCP connection is
 * loopback (that is what the browser gives the attacker), the Host header is the attacker's domain.
 */
function rawPost(port, path, host, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
          `Accept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n${body}`,
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

const countOf = (store, table) => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('BLOCKER-2: a foreign Origin cannot mint a workspace through the REST face', async () => {
  await withBridge(async ({ port, store }) => {
    const res = await post(port, '/api/create_workspace', { name: 'PWNED', idempotencyKey: 'evil-1' }, { origin: EVIL_ORIGIN });
    assert.equal(res.status, 403, `the REST face must refuse a foreign Origin, got ${res.status}`);
    assert.equal((await res.json()).error, 'forbidden_origin');
    assert.equal(countOf(store, 'workspace'), 0, 'no workspace may exist after a rejected request');
  });
});

test('BLOCKER-2: a foreign Origin cannot post an immutable journal entry through the REST face', async () => {
  await withBridge(async ({ port, store, deps }) => {
    // The workspace is minted in-process (not over the wire): the attacker's own reconnaissance is
    // not what is under test, the write is.
    const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Acme GmbH', idempotencyKey: 'ws' });
    const accId = (n) =>
      store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;

    const res = await post(
      port,
      '/api/post_entry',
      {
        workspaceId,
        date: '2026-03-01',
        description: `posted by ${EVIL_ORIGIN}`,
        source: 'manual',
        idempotencyKey: 'evil-post-1',
        lines: [
          { account: accId('6500'), debit: 100000 },
          { account: accId('1000'), credit: 100000 },
        ],
      },
      { origin: EVIL_ORIGIN },
    );
    assert.equal(res.status, 403, `post_entry must be refused a foreign Origin, got ${res.status}`);
    assert.equal(countOf(store, 'journal_entry'), 0, 'the ledger must be untouched: a posted entry is immutable');
    assert.equal(countOf(store, 'journal_line'), 0);
  });
});

test('BLOCKER-2: a rebound Host cannot reach the REST face either', async () => {
  await withBridge(async ({ port, store }) => {
    const raw = await rawPost(port, '/api/create_workspace', EVIL_HOST, { name: 'PWNED', idempotencyKey: 'evil-2' });
    assert.match(raw, /^HTTP\/1\.1 403/, `a rebound Host must be refused, got: ${raw.slice(0, 90)}`);
    assert.equal(countOf(store, 'workspace'), 0);
  });
});

test('BLOCKER-2: EVERY face the router declares is behind the same guard', async () => {
  await withBridge(async ({ port, router }) => {
    assert.ok(router.faces.length >= 2, `expected both faces mounted, saw ${router.faces.length}`);
    for (const face of router.faces) {
      const origin = await post(port, face.probePath, INITIALIZE, { origin: EVIL_ORIGIN });
      assert.equal(origin.status, 403, `face "${face.name}" (${face.probePath}) accepted a foreign Origin`);
      const host = await rawPost(port, face.probePath, EVIL_HOST, INITIALIZE);
      assert.match(host, /^HTTP\/1\.1 403/, `face "${face.name}" (${face.probePath}) accepted a rebound Host`);
    }
  });
});

test('BLOCKER-2: the guard does not break the faces it protects', async () => {
  await withBridge(async ({ port, store }) => {
    // An agent or the CLI sends no Origin at all.
    const cli = await post(port, '/api/create_workspace', { name: 'Acme GmbH', idempotencyKey: 'ok-1' });
    assert.equal(cli.status, 200, `a loopback request must still work, got ${cli.status}`);
    // The Studio speaks from its dev-server origin.
    const studio = await post(port, '/api/create_workspace', { name: 'Beta AG', idempotencyKey: 'ok-2' }, { origin: 'http://localhost:5173' });
    assert.equal(studio.status, 200);
    assert.equal(countOf(store, 'workspace'), 2);
    // And the MCP face still initialises.
    const mcp = await post(port, '/mcp', INITIALIZE);
    assert.equal(mcp.status, 200, `the MCP face must still initialise, got ${mcp.status}`);
  });
});

test('BLOCKER-2: the dev bridge reaches the registry ONLY through the shared router', () => {
  // The defect was structural, so the regression test is too: the bridge mounted a second, unguarded
  // door beside the guarded one. If this file ever imports the registry adapters directly again, or
  // grows a second middleware mount, the guard can be bypassed the same way and this fails.
  const src = readFileSync(new URL('../../app/dev-api.ts', import.meta.url), 'utf8');
  // Prose is not code: the file's own security note names the modules it must not import, so the
  // comments are stripped before anything is asserted about what the file actually does.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /api\/local-http\.js/, 'the dev bridge must mount the shared local HTTP router');
  for (const direct of ['rest', 'mcp-http']) {
    assert.doesNotMatch(
      code,
      new RegExp(`['"\`][^'"\`]*api/${direct}\\.js`),
      `the dev bridge must not reach api/${direct}.js directly: that is how the guard was bypassed`,
    );
  }
  const mounts = code.match(/middlewares\.use\(/g) ?? [];
  assert.equal(mounts.length, 1, `the dev bridge must have exactly ONE mount, found ${mounts.length}`);
});
