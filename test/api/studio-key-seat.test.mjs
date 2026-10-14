/**
 * CRITIC PROBES P6 AND R3-B2 (2026-10-12): THE STUDIO SEAT IS A PER-LAUNCH KEY, AND THE KEY NEVER
 * SITS IN THE SERVED PAGE.
 *
 * P6: over `/mcp`, a client declaring `clientInfo.name: 'till-studio'` was seated as the human Studio,
 * unauthenticated, and `till up` served `/api/*` as `studio` to any local process.
 *
 * R3-B2: the first fix wrote the key into the Studio page as a `<meta>` tag, so any local HTTP client
 * (a fetch tool, a browser-driving agent, curl) could GET `/`, read it, and POST `/api/issue_invoice`
 * with it: the invoice issued with 0 Vorschläge. Owner decision, the Jupyter-token pattern: the page
 * carries no key in any mode; `till up` prints and opens `http://HOST:PORT/#k=<key>`, and a fragment
 * is never sent to a server.
 *
 * Every case is driven over a real loopback listener, against `till up` itself where the host is the
 * subject, or against the exact composition the R3-B2 probe used (the router plus `serveStudio`). The
 * browser half (fragment to sessionStorage, the no-key notice) is `app/src/lib/studio-key.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer, request } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import * as up from '../../dist/api/up.js';
import { startHttpServer } from '../../dist/api/serve.js';
import { createLocalHttpRouter } from '../../dist/api/local-http.js';
import { rejectNonLocal } from '../../dist/api/local-guard.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { acquireLock, lockPath } from '../../dist/api/up-lock.js';
import { spawn } from 'node:child_process';
import * as session from '../../dist/api/session.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { SCENARIOS, fixture } from './conformance-contract.mjs';
import { keyShapedRuns, listenStudioRouter, mintStudioKey, studioHeaders, studioKeyFromLink } from './studio-key-support.mjs';

const KEY_HEADER = 'x-till-studio-key';
/** A well-formed key that is not the host's: what a guesser or a stale tab presents. */
const WRONG_KEY = 'W'.repeat(43);

// --- the hosts --------------------------------------------------------------------------------

/** A Studio build with more than a shell: assets, a nested chunk, a stylesheet. */
function studioFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'till-r3-studio-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>TILL Studio</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index.js'), 'console.log("studio");');
  writeFileSync(join(dir, 'assets', 'index.css'), 'body { margin: 0; }');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return dir;
}

async function startStudioUp({ supportDir = mkdtempSync(join(tmpdir(), 'till-r3-up-')), studioDir = studioFixture(), log } = {}) {
  resetDeliveryRuntime();
  const lines = [];
  const handle = await up.startUp({
    dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir, open: false, tickMs: 60_000,
    log: log ?? ((line) => lines.push(line)),
  });
  assert.equal(handle.started, true);
  return { handle, supportDir, studioDir, lines };
}

async function withUp(run) {
  const { handle, ...rest } = await startStudioUp();
  try {
    await run(handle, rest);
  } finally {
    await handle.close();
  }
}

// --- the wire helpers --------------------------------------------------------------------------

async function connect(url, clientName, headers = {}) {
  const client = new Client({ name: clientName, version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
  return client;
}

async function callVerb(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
}

/** A raw HTTP request, because `fetch` cannot forge Host (the DNS-rebinding case needs it). */
function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

const initialize = (name) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '0.0.0' } },
});

// --- the ledger helpers ------------------------------------------------------------------------

function seed(store, label) {
  const res = createWorkspace(
    { store, clock: fixedClock('2026-10-12T08:00:00.000Z'), ids: systemIdGen, actor: 'studio' },
    { name: `P6 ${label} GmbH`, idempotencyKey: `p6-${label}` },
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const accId = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  return { workspaceId, accId };
}

function postArgs(workspaceId, accId, key) {
  return {
    workspaceId,
    date: '2026-10-01',
    description: 'P6 probe',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 4200 },
      { account: accId('1020'), credit: 4200 },
    ],
  };
}

const entryCount = (store, workspaceId) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
const pendingVorschlaege = (store, workspaceId) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'").get(workspaceId).n;

// --- R3-B2: no key in anything served ----------------------------------------------------------

test('R3-B2 the probe: a local client that GETs the page finds no key, and its scraped POST /api/issue_invoice is refused', async () => {
  // The probe's own composition: the router `till up` builds, plus `serveStudio`, plus the guard.
  const fx = fixture();
  const input = SCENARIOS.issue_invoice(fx);
  const studioDir = studioFixture();
  const studioKey = mintStudioKey();
  const router = createLocalHttpRouter(fx.deps, { rest: true, studioKey });
  const server = createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    if (rejectNonLocal(req) !== null) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (await up.serveStudio(req, res, studioDir, studioKey)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /till-studio-key/, 'the shell names no key');
    assert.ok(!html.includes(studioKey), 'the shell carries no key');
    // A scraper tries everything key-shaped it can find; none of it is the key.
    const guesses = [...keyShapedRuns(html), /name="till-studio-key" content="([^"]+)"/.exec(html)?.[1] ?? ''];
    for (const guess of guesses) {
      const res = await postJson(`${base}/api/issue_invoice`, input, { [KEY_HEADER]: guess });
      assert.equal(res.status, 401, `a scraped "${guess.slice(0, 8)}..." is refused`);
    }
    const doc = fx.deps.store.db.prepare('SELECT status, number FROM document WHERE id = ?').get(input.invoiceId);
    assert.deepEqual(doc, { status: 'draft', number: null }, 'nothing was issued');
    assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action').get().n, 0);
    // The person, holding the key from the link, still issues it.
    const keyed = await postJson(`${base}/api/issue_invoice`, input, studioHeaders(studioKey));
    assert.equal(keyed.status, 200);
  } finally {
    await router.closeAll();
    await new Promise((resolve) => server.close(resolve));
    fx.deps.store.close();
  }
});

test('R3-B2 till up: the shell, every client route and every Studio asset are served without the key', async () => {
  await withUp(async (handle, { studioDir }) => {
    const key = handle.studioKey;
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    const routes = ['/', '/index.html', '/overview', '/invoices/new', '/approvals?x=1'];
    const walk = (dir) =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [`/${relative(studioDir, full).split('\\').join('/')}`];
      });
    for (const path of [...routes, ...walk(studioDir)]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await fetch(`${handle.url}${path}`, { method });
        assert.equal(res.status, 200, `${method} ${path}`);
        const text = await res.text();
        assert.ok(!text.includes(key), `${method} ${path} must not carry the key`);
        for (const [name, value] of res.headers) assert.ok(!value.includes(key), `${path}: header ${name} must not carry the key`);
      }
    }
  });
});

test('R3-B2 till up over the BUILT Studio (when built): no served file carries the key', async (t) => {
  const built = up.resolveStudioDir({});
  if (built === null) {
    t.skip('no built Studio in this checkout (npm run build:studio); the fixture case above still runs');
    return;
  }
  const { handle } = await startStudioUp({ studioDir: built });
  try {
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(`/${relative(built, full).split('\\').join('/')}`);
      }
    };
    walk(built);
    for (const path of ['/', '/overview', ...files]) {
      const text = await (await fetch(`${handle.url}${path}`)).text();
      assert.ok(!text.includes(handle.studioKey), `${path} must not carry the key`);
    }
  } finally {
    await handle.close();
  }
});

test('R3-B2 till up hands the key out of band: it prints and returns the #k= link, and a second till up reopens it', async () => {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-r3-link-'));
  const { handle, lines } = await startStudioUp({ supportDir });
  try {
    assert.equal(handle.studioUrl, `${handle.url}/#k=${handle.studioKey}`);
    assert.equal(studioKeyFromLink(handle.studioUrl), handle.studioKey);
    assert.ok(lines.some((l) => l.includes(handle.studioUrl)), `the link is printed: ${JSON.stringify(lines)}`);

    // Kept for a second `till up` beside the lock, owner-only, and NOT in the lock `till mcp` reads.
    const linkFile = up.studioLinkPath(supportDir);
    assert.equal(statSync(linkFile).mode & 0o777, 0o600);
    const lock = readFileSync(lockPath(supportDir), 'utf8');
    assert.ok(!lock.includes(handle.studioKey), 'the lock an agent reads carries no key');

    assert.equal(up.readStudioLink(supportDir, process.pid), handle.studioUrl, 'the file names this process and its link');
    assert.equal(up.readStudioLink(supportDir, process.pid + 1), null, 'a link left by another pid is never handed out');
  } finally {
    await handle.close();
  }
  assert.equal(existsSync(up.studioLinkPath(supportDir)), false, 'the link file goes with the process');
});

test('R3-B2 a second till up (the redirect) is handed the live instance\'s working link, not the bare URL', async () => {
  // Two `till up` are two processes: seat a live child as the holder, as `up.test.mjs` does.
  const supportDir = mkdtempSync(join(tmpdir(), 'till-r3-redirect-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const bare = 'http://127.0.0.1:8799';
    assert.equal(acquireLock(supportDir, { pid: child.pid, host: '127.0.0.1', port: 8799, url: bare, startedAt: '2026-10-12T00:00:00.000Z' }).acquired, true);
    const redirect = () => up.startUp({ dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false, log: () => {} });

    const withoutLink = await redirect();
    assert.equal(withoutLink.started, false);
    assert.equal(withoutLink.holder.url, bare, 'no link left: the bare URL, and the Studio shows its hint');

    const link = `${bare}/#k=${mintStudioKey()}`;
    writeFileSync(up.studioLinkPath(supportDir), JSON.stringify({ pid: child.pid, link }), { mode: 0o600 });
    const withLink = await redirect();
    assert.equal(withLink.started, false);
    assert.equal(withLink.holder.url, link, 'the redirect opens the working link');
    assert.ok(!readFileSync(lockPath(supportDir), 'utf8').includes('#k='), 'the lock on disk keeps the bare URL');
  } finally {
    child.kill('SIGKILL');
  }
});

test('R3-B2 a restart rotates the key: the old link\'s key is refused on both faces, the new link works', async () => {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-r3-restart-'));
  const first = await startStudioUp({ supportDir });
  const oldKey = studioKeyFromLink(first.handle.studioUrl);
  await first.handle.close();
  const second = await startStudioUp({ supportDir });
  try {
    const newKey = studioKeyFromLink(second.handle.studioUrl);
    assert.notEqual(newKey, oldKey);
    const mcpOld = await postJson(`${second.handle.url}/mcp`, initialize('till-studio'), studioHeaders(oldKey));
    assert.equal(mcpOld.status, 401);
    assert.equal((await mcpOld.json()).error, 'studio_key_invalid');
    const apiOld = await postJson(`${second.handle.url}/api/delivery_status`, {}, studioHeaders(oldKey));
    assert.equal(apiOld.status, 401);
    assert.equal((await apiOld.json()).error, 'studio_key_invalid');
    const apiNew = await postJson(`${second.handle.url}/api/delivery_status`, {}, studioHeaders(newKey));
    assert.equal(apiNew.status, 200);
  } finally {
    await second.handle.close();
  }
});

// --- /mcp ---------------------------------------------------------------------------------------

test('P6 /mcp: till-studio WITHOUT the key is refused; any other keyless client is the agent and its governed write drafts', async () => {
  await withUp(async (handle) => {
    const { workspaceId, accId } = seed(handle.store, 'named');
    await assert.rejects(connect(handle.url, 'till-studio'), /studio_key_required/, 'the Studio name without the key opens nothing');
    const raw = await postJson(`${handle.url}/mcp`, initialize('till-studio'));
    assert.equal(raw.status, 401);
    assert.equal((await raw.json()).error, 'studio_key_required');

    const agent = await connect(handle.url, 'claude-desktop');
    try {
      assert.equal((await callVerb(agent, 'whoami', { workspaceId })).actor, 'agent');
      const posted = await callVerb(agent, 'post_entry', postArgs(workspaceId, accId, 'p6-agent'));
      assert.equal(posted.ok, true, JSON.stringify(posted));
      assert.equal(posted.drafted, true, 'a governed write from the agent seat is DRAFTED at ask');
      assert.equal(entryCount(handle.store, workspaceId), 0);
      assert.equal(pendingVorschlaege(handle.store, workspaceId), 1, 'one Vorschlag waits for the person');
    } finally {
      await agent.close();
    }
  });
});

test('P6 /mcp: the Studio with the key from its link is the human seat, and its write executes', async () => {
  await withUp(async (handle) => {
    const { workspaceId, accId } = seed(handle.store, 'studio');
    const studioKey = studioKeyFromLink(handle.studioUrl);
    const studio = await connect(handle.url, 'till-studio', studioHeaders(studioKey));
    try {
      assert.equal((await callVerb(studio, 'whoami', { workspaceId })).actor, 'studio');
      const posted = await callVerb(studio, 'post_entry', postArgs(workspaceId, accId, 'p6-studio'));
      assert.equal(posted.ok, true, JSON.stringify(posted));
      assert.notEqual(posted.drafted, true, 'the person\'s own write is not drafted');
      assert.equal(entryCount(handle.store, workspaceId), 1);
      assert.equal(pendingVorschlaege(handle.store, workspaceId), 0);
    } finally {
      await studio.close();
    }
  });
});

test('P6 /mcp: a WRONG key is refused before any session opens, and so is a repeated key header', async () => {
  await withUp(async (handle) => {
    await assert.rejects(connect(handle.url, 'till-studio', studioHeaders(WRONG_KEY)), /studio_key_invalid/);
    const almost = handle.studioKey.slice(0, -1) + (handle.studioKey.endsWith('A') ? 'B' : 'A');
    assert.equal((await postJson(`${handle.url}/mcp`, initialize('till-studio'), studioHeaders(almost))).status, 401);
    const twice = await rawRequest(`${handle.url}/mcp`, {
      method: 'POST',
      headers: {
        host: new URL(handle.url).host,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [KEY_HEADER]: [handle.studioKey, WRONG_KEY],
      },
      body: JSON.stringify(initialize('till-studio')),
    });
    assert.equal(twice.status, 401);
  });
});

test('P6 /mcp: a Studio session id replayed WITHOUT the key is refused, not served as the Studio', async () => {
  await withUp(async (handle) => {
    const { workspaceId } = seed(handle.store, 'replay');
    const opened = await postJson(`${handle.url}/mcp`, initialize('till-studio'), studioHeaders(handle.studioKey));
    assert.equal(opened.status, 200);
    const sessionId = opened.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: { workspaceId } } };
    const replay = await postJson(`${handle.url}/mcp`, call, { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error, 'studio_key_required');
  });
});

test('P6 till serve: no Studio, no key; a presented key is refused, and so is the Studio name without one', async () => {
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0 });
  try {
    const { workspaceId } = seed(handle.store, 'serve');
    assert.equal((await postJson(`${handle.url}/mcp`, initialize('till-studio'), studioHeaders(WRONG_KEY))).status, 401);
    await assert.rejects(connect(handle.url, 'till-studio'), /studio_key_required/);
    const agent = await connect(handle.url, 'some-agent');
    try {
      assert.equal((await callVerb(agent, 'whoami', { workspaceId })).actor, 'agent');
    } finally {
      await agent.close();
    }
  } finally {
    await handle.close();
  }
});

// --- /api ---------------------------------------------------------------------------------------

test('P6 /api/issue_invoice: refused without the key, refused with a wrong one, issued with it', async () => {
  const fx = fixture();
  const input = SCENARIOS.issue_invoice(fx);
  const host = await listenStudioRouter(fx.deps);
  const docOf = () => fx.deps.store.db.prepare('SELECT status, number FROM document WHERE id = ?').get(input.invoiceId);
  try {
    const bare = await postJson(`${host.url}/api/issue_invoice`, input);
    assert.equal(bare.status, 401);
    assert.equal((await bare.json()).error, 'studio_key_required');
    const named = await postJson(`${host.url}/api/issue_invoice`, input, { 'user-agent': 'till-studio', 'x-till-client': 'till-studio' });
    assert.equal(named.status, 401);
    const wrong = await postJson(`${host.url}/api/issue_invoice`, input, studioHeaders(WRONG_KEY));
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'studio_key_invalid');
    assert.deepEqual(docOf(), { status: 'draft', number: null });
    const keyed = await postJson(`${host.url}/api/issue_invoice`, input, studioHeaders(host.studioKey));
    assert.equal(keyed.status, 200);
    assert.equal(docOf().status, 'issued');
  } finally {
    await host.close();
    fx.deps.store.close();
  }
});

test('P6 till up /api: the REST twin needs the key from the link; without it or with a wrong one it refuses', async () => {
  await withUp(async (handle) => {
    const create = (headers, key) => postJson(`${handle.url}/api/create_workspace`, { name: 'REST GmbH', idempotencyKey: key }, headers);
    const workspaces = () => handle.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
    const before = workspaces();
    assert.equal((await create({}, 'r1')).status, 401);
    assert.equal((await create(studioHeaders(WRONG_KEY), 'r2')).status, 401);
    assert.equal(workspaces(), before);
    assert.equal((await create(studioHeaders(studioKeyFromLink(handle.studioUrl)), 'r3')).status, 200);
    assert.equal(workspaces(), before + 1);
  });
});

// --- the guard ----------------------------------------------------------------------------------

test('P6 the localhost guard still refuses a browser origin first, even with the valid key', async () => {
  await withUp(async (handle) => {
    const keyed = studioHeaders(handle.studioKey);
    const api = await postJson(`${handle.url}/api/create_workspace`, { name: 'Evil', idempotencyKey: 'e1' }, { origin: 'https://evil.example', ...keyed });
    assert.equal(api.status, 403);
    assert.equal((await api.json()).error, 'forbidden_origin');
    assert.equal((await postJson(`${handle.url}/mcp`, initialize('till-studio'), { origin: 'https://evil.example', ...keyed })).status, 403);
    assert.equal((await rawRequest(`${handle.url}/`, { headers: { host: 'evil.example' } })).status, 403);
    const rebound = await rawRequest(`${handle.url}/api/create_workspace`, {
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json', ...keyed },
      body: JSON.stringify({ name: 'Evil', idempotencyKey: 'e2' }),
    });
    assert.equal(rebound.status, 403);
    assert.equal(handle.store.db.prepare("SELECT COUNT(*) AS n FROM workspace WHERE name = 'Evil'").get().n, 0);
  });
});

// --- the key itself -----------------------------------------------------------------------------

test('the key: 32 CSPRNG bytes per mint, checked in constant time, handed out in the #k= fragment', () => {
  const { mintStudioKey: mint, checkStudioKey, isWellFormedStudioKey, resolveSessionActor, studioLink } = session;
  // The names the Studio (`app/src/lib/studio-key.ts`) and these suites mirror.
  assert.equal(session.STUDIO_KEY_HEADER, KEY_HEADER);
  assert.equal(session.STUDIO_KEY_FRAGMENT, 'k');
  assert.equal('STUDIO_KEY_META' in session, false, 'there is no page-borne key any more');
  const studioSide = readFileSync(new URL('../../app/src/lib/studio-key.ts', import.meta.url), 'utf8');
  assert.match(studioSide, new RegExp(`STUDIO_KEY_HEADER = '${session.STUDIO_KEY_HEADER}'`));
  assert.match(studioSide, new RegExp(`STUDIO_KEY_FRAGMENT = '${session.STUDIO_KEY_FRAGMENT}'`));

  const a = mint();
  const b = mint();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.notEqual(a, b);
  assert.equal(studioLink('http://127.0.0.1:4100', a), `http://127.0.0.1:4100/#k=${a}`);
  assert.equal(studioLink('http://127.0.0.1:4100/', a), `http://127.0.0.1:4100/#k=${a}`);
  assert.equal(isWellFormedStudioKey(a), true);
  assert.equal(isWellFormedStudioKey('test'), false);

  assert.equal(checkStudioKey({ [KEY_HEADER]: a }, a), 'valid');
  assert.equal(checkStudioKey({}, a), 'absent');
  assert.equal(checkStudioKey({ [KEY_HEADER]: b }, a), 'invalid');
  assert.equal(checkStudioKey({ [KEY_HEADER]: a.slice(0, 20) }, a), 'invalid');
  assert.equal(checkStudioKey({ [KEY_HEADER]: '' }, a), 'invalid');
  assert.equal(checkStudioKey({ [KEY_HEADER]: [a, a] }, a), 'invalid');
  assert.equal(checkStudioKey({ [KEY_HEADER]: a }, undefined), 'invalid');

  assert.equal(resolveSessionActor({ name: 'till-studio' }), 'agent');
  assert.equal(resolveSessionActor({ name: 'whatever' }, checkStudioKey({ [KEY_HEADER]: a }, a)), 'studio');
});
