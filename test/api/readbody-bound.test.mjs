/**
 * G18 US-G18.4 (the named prerequisite): the REST body reader is BOUNDED. Before the E00 chunk lane
 * ships, a request body over the cap is refused with a structured 413-shaped Result rather than
 * buffered without bound. The cap is injectable so this test can trigger the refusal cheaply; the
 * production default (MAX_BODY_BYTES) admits exactly one chunk-lane payload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createLocalHttpRouter, MAX_BODY_BYTES } from '../../dist/api/local-http.js';
import { makeApiDeps } from '../../dist/api/mcp.js';

async function withBridge(maxBodyBytes, body) {
  const { deps, store } = makeApiDeps();
  const router = createLocalHttpRouter(deps, { rest: true, maxBodyBytes });
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
    await body(port);
  } finally {
    await router.closeAll();
    await new Promise((resolve) => http.close(resolve));
    store.close();
  }
}

const post = (port, action, raw) =>
  fetch(`http://127.0.0.1:${port}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: raw,
  });

test('a REST body over the cap is refused 413, not buffered', async () => {
  await withBridge(1024, async (port) => {
    const oversized = JSON.stringify({ blob: 'x'.repeat(4096) });
    const res = await post(port, 'list_workspaces', oversized);
    assert.equal(res.status, 413, 'an over-cap body is a 413');
    const body = await res.json();
    assert.equal(body.error, 'request_body_too_large');
    assert.equal(body.max, 1024, 'the refusal names the cap');
    assert.ok(body.bytes > 1024, 'the refusal names the observed size');
  });
});

test('a REST body under the cap is served normally', async () => {
  await withBridge(1024, async (port) => {
    const res = await post(port, 'list_workspaces', JSON.stringify({}));
    assert.notEqual(res.status, 413, 'a small body is not refused for size');
  });
});

test('the production body cap admits a full chunk-lane payload', () => {
  // A chunk is at most 25 MiB of binary, ~1.34x as base64; the default cap must exceed that.
  assert.ok(MAX_BODY_BYTES >= Math.ceil(25 * 1024 * 1024 * (4 / 3)) + 4096, 'the cap admits one 25 MiB chunk as base64 plus envelope');
});
