/**
 * `till up` (M00): the one loopback process serving the built Studio + REST + /mcp + the scheduler.
 *
 * These drive the REAL composition over an ephemeral loopback port: the built-Studio static serve,
 * the guarded API faces, `delivery_status` reporting `mode:'up'`, the single-instance redirect, and
 * the bind refusals `till up` inherits from `till serve`. No browser is opened (`open:false`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';

import { startUp, resolveStudioDir, serveStudio } from '../../dist/api/up.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { acquireLock } from '../../dist/api/up-lock.js';

/** A raw HTTP request (fetch forbids spoofing the Host header, which the rebinding test needs). */
function rawRequest(url, { method = 'GET', headers = {} } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function studioFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'till-studio-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>TILL Studio</title><div id="root">ready</div>');
  writeFileSync(join(dir, 'app.js'), 'console.log("studio");');
  return dir;
}

async function withUp(run, opts = {}) {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-up-support-'));
  const studioDir = studioFixture();
  resetDeliveryRuntime();
  const res = await startUp({
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0, // ephemeral: the handle reports the bound port
    supportDir,
    studioDir,
    open: false,
    ...opts,
  });
  assert.equal(res.started, true, JSON.stringify(res));
  try {
    await run(res, { supportDir, studioDir });
  } finally {
    await res.close();
  }
  return { supportDir, studioDir };
}

test('till up serves the built Studio at / and falls back to index.html for a client route', async () => {
  await withUp(async (up) => {
    const root = await fetch(`${up.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await root.text(), /TILL Studio/);

    // A deep client route (no extension) is the SPA, so it returns index.html, not a 404.
    const route = await fetch(`${up.url}/invoices/new`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /TILL Studio/);

    // A concrete asset is served with its own content-type.
    const asset = await fetch(`${up.url}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);

    // A missing asset WITH an extension is a real 404 (not an SPA route).
    assert.equal((await fetch(`${up.url}/nope.js`)).status, 404);
  });
});

test('till up mounts the REST twin, and delivery_status reports mode=up with the bound port', async () => {
  await withUp(async (up) => {
    const port = Number(new URL(up.url).port);
    const r = await fetch(`${up.url}/api/delivery_status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'up');
    assert.equal(body.studioServed, true);
    assert.equal(body.host, '127.0.0.1');
    assert.equal(body.port, port);
    assert.equal(body.scheduler.enabled, true);
  });
});

test('till up guards BOTH the API face and the static face against a rebound Host (DNS-rebinding)', async () => {
  await withUp(async (up) => {
    // The API twin: a rebound page must never reach the registry.
    const api = await rawRequest(`${up.url}/api/delivery_status`, { method: 'POST', headers: { host: 'evil.example.com', 'content-type': 'application/json' } });
    assert.equal(api.status, 403);
    // The static Studio shell is guarded too (the value M00 adds over the router-only faces).
    const studio = await rawRequest(`${up.url}/`, { headers: { host: 'evil.example.com' } });
    assert.equal(studio.status, 403);
    // A loopback Host still passes.
    const ok = await rawRequest(`${up.url}/`, { headers: { host: '127.0.0.1' } });
    assert.equal(ok.status, 200);
  });
});

test('a second till up finds a live instance holding the lock and redirects instead of starting', async () => {
  // Two `till up` are two PROCESSES with two pids; a test runs in one, so a real foreign pid is
  // needed to exercise the redirect. Spawn a live child, seat it as the lock holder, then start up.
  const supportDir = mkdtempSync(join(tmpdir(), 'till-up-2nd-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 50)); // let the child come alive
    const holder = { pid: child.pid, host: '127.0.0.1', port: 8788, url: 'http://127.0.0.1:8788', startedAt: '2026-07-16T00:00:00.000Z' };
    assert.equal(acquireLock(supportDir, holder).acquired, true);

    const second = await startUp({ dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false });
    assert.equal(second.started, false, 'a second till up must not start while a live instance holds the lock');
    assert.equal(second.holder.url, 'http://127.0.0.1:8788');
    assert.equal(second.holder.pid, child.pid);
    if (second.started) await second.close();
  } finally {
    child.kill('SIGKILL');
  }
});

test('till up refuses a non-loopback bind exactly as till serve does', async () => {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-up-refuse-'));
  await assert.rejects(
    startUp({ dbPath: ':memory:', host: '0.0.0.0', port: 0, supportDir, studioDir: null, open: false, allowNonLoopback: false }),
    /not a loopback address/,
  );
});

test('till up starts even with no Studio built, and says so on a Studio GET', async () => {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-up-nostudio-'));
  resetDeliveryRuntime();
  const up = await startUp({ dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false });
  assert.equal(up.started, true);
  try {
    assert.equal(up.studioServed, false);
    const r = await fetch(`${up.url}/`);
    assert.equal(r.status, 501);
    assert.match(await r.text(), /not built/);
    // The API face still works with no Studio.
    const api = await fetch(`${up.url}/api/delivery_status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await api.json()).mode, 'up');
  } finally {
    await up.close();
  }
});

test('resolveStudioDir honours an explicit override and returns null when nothing is built there', () => {
  const dir = studioFixture();
  assert.equal(resolveStudioDir({ TILL_STUDIO_DIR: dir }), dir);
  const empty = mkdtempSync(join(tmpdir(), 'till-empty-'));
  // An override that has no index.html falls through; with no vendored/app build present it is null.
  const resolved = resolveStudioDir({ TILL_STUDIO_DIR: empty });
  assert.ok(resolved === null || resolved !== empty);
});

test('serveStudio refuses a path-traversal attempt by falling back to index.html', async () => {
  const dir = studioFixture();
  const chunks = [];
  const res = {
    writeHead() {},
    end(b) { if (b) chunks.push(b); },
  };
  const handled = await serveStudio({ method: 'GET', url: '/../../etc/passwd' }, res, dir);
  assert.equal(handled, true);
  assert.match(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), /TILL Studio/);
});
