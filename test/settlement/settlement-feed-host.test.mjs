// D198, the shipped feed host: the child-process fetch, against a loopback server in a worker thread (the
// fetch is synchronous, so a server on this thread could never answer). Nothing leaves 127.0.0.1, and the
// Keychain is never touched here (the child fetch is tested directly; the Keychain half is macOS's own
// `security` tool).
//
// SYNTHETIC DATA ONLY: an invented token and body.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { childFetch, blankToken } from '../../dist/api/settlement-feed-host.js';

const TOKEN = 'kw_host_token_0123456789abcdef';
let worker;
let port;

before(async () => {
  worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      const auth = req.headers['authorization'];
      if (req.url.startsWith('/big')) { res.writeHead(200); res.end('x'.repeat(5000)); return; }
      if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
      if (auth !== 'Bearer ${TOKEN}') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, schema: 'till-settlement/v1' }));
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
    `,
    { eval: true },
  );
  port = await new Promise((resolve) => worker.once('message', resolve));
});

after(async () => {
  await worker.terminate();
});

const job = (path, token = TOKEN, maxBytes = 1_000_000) => ({ url: `http://127.0.0.1:${port}${path}`, token, timeoutMs: 5000, maxBytes });

test('the child sends the bearer token and answers the status and the body', () => {
  const r = childFetch(job('/api/accounting/till-settlement?from=2026-07-01&to=2026-07-31'));
  assert.equal(r.kind, 'response');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { url: '/api/accounting/till-settlement?from=2026-07-01&to=2026-07-31', schema: 'till-settlement/v1' });
});

test('a wrong token is answered 401, as the producer says it', () => {
  const r = childFetch(job('/api/accounting/till-settlement', 'kw_wrong_token_aaaaaaaaaaaaaa'));
  assert.equal(r.kind, 'response');
  assert.equal(r.status, 401);
});

test('a body larger than the cap, a redirect and a closed port are unreachable, never a partial answer', () => {
  assert.equal(childFetch(job('/big', TOKEN, 1000)).kind, 'unreachable');
  assert.equal(childFetch(job('/redirect')).kind, 'unreachable', 'redirects are refused: the token never follows one');
  assert.equal(childFetch({ url: 'http://127.0.0.1:1/', token: TOKEN, timeoutMs: 3000, maxBytes: 1000 }).kind, 'unreachable');
});

test('the host blanks every spelling of the token an echo may use: raw, JSON-escaped and URL-encoded (critic r2 N2)', () => {
  const token = 'kw/test/token/0123456789abcdef+Zq==';
  const body = `raw ${token} json ${token.split('/').join('\\/')} url ${encodeURIComponent(token)}`;
  const out = blankToken(body, token);
  assert.equal(out, 'raw [token] json [token] url [token]');
});
