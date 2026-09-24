/**
 * F-08 (a): THE SEATING RULE HOLDS ON EVERY HOST. An MCP client whose declared name is not in the
 * closed D13 map is the governed `agent` seat over `/mcp`, whether it connects to `till up`, to
 * `till serve`, or to the Vite dev bridge's router; a `till-studio` client keeps the `studio` seat;
 * and the REST bridge (the Studio's own door) stays `studio`, because the Studio is the human.
 *
 * WHY THREE HOSTS AND NOT ONE. The rule lives in `src/api/session.ts`, but the DEFECT lived in the
 * hosts: `till up` and the dev bridge passed `actor: 'studio'` (their REST actor) and the MCP face
 * used it as its fallback, so a Claude Desktop session on `till up` was seated as the Studio and
 * bypassed the A35 dial and the trace. `till serve` happened to fall back to `agent`. A test on one
 * host therefore proves nothing about the others; each composition is driven for real here, over a
 * loopback listener, and each asserts the same three facts about an unknown client's governed write
 * at the default `ask`: it is DRAFTED (never executed), it is TRACED (one `agent_call` row, mode
 * `draft`), and the ledger holds no entry for it.
 *
 * HOW IT BITES: restore the second parameter of `resolveSessionActor` and pass `deps.actor` from
 * `buildMcpServer` (the pre-F-08 line) and the `till up` and dev-bridge cases execute the write as
 * `studio` with zero trace rows, failing every assertion below except the `till serve` one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startUp } from '../../dist/api/up.js';
import { startHttpServer } from '../../dist/api/serve.js';
import { createLocalHttpRouter } from '../../dist/api/local-http.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { STUDIO_CLIENT_NAME } from '../../dist/api/session.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

/** The name Claude Desktop (and every other third-party client) declares: NOT in the closed map. */
const UNKNOWN_CLIENT = 'claude-desktop';

async function connect(url, clientName, headers = {}) {
  const client = new Client({ name: clientName, version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
  return client;
}

async function callVerb(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
}

/** Seed a workspace through the LOCAL trust boundary (the file holder), so the agent has books to write. */
function seed(store) {
  const res = createWorkspace(
    { store, clock: fixedClock('2026-09-05T08:00:00.000Z'), ids: sequenceIdGen(), actor: 'studio' },
    { name: 'Seat GmbH', idempotencyKey: 'seat-ws' },
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
    date: '2026-09-01',
    description: 'Seat probe',
    source: 'agent',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 12000 },
      { account: accId('1020'), credit: 12000 },
    ],
  };
}

function traceRows(store, workspaceId) {
  return store.db.prepare('SELECT verb, mode, dial_capability FROM agent_call WHERE workspace_id = ?').all(workspaceId);
}

function entryCount(store, workspaceId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
}

/**
 * The three facts an unknown client's governed write must show on a host: drafted, traced, not posted.
 * `label` names the host in every assertion so a failure says WHICH composition regressed.
 */
async function assertUnknownClientIsGoverned(url, store, label) {
  const { workspaceId, accId } = seed(store);
  const agent = await connect(url, UNKNOWN_CLIENT);
  try {
    const me = await callVerb(agent, 'whoami', { workspaceId });
    assert.equal(me.actor, 'agent', `${label}: an unrecognised client is seated as the governed agent`);

    const posted = await callVerb(agent, 'post_entry', postArgs(workspaceId, accId, `${label}-k1`));
    assert.equal(posted.ok, true, `${label}: ${JSON.stringify(posted)}`);
    assert.equal(posted.drafted, true, `${label}: the governed write at ask must DRAFT, never execute`);
    assert.equal(posted.status, 'pending');
    assert.equal(entryCount(store, workspaceId), 0, `${label}: nothing may reach the ledger before a human approves`);

    const rows = traceRows(store, workspaceId).filter((r) => r.verb === 'post_entry');
    assert.equal(rows.length, 1, `${label}: exactly one trace row for the drafted write`);
    assert.equal(rows[0].mode, 'draft');
    assert.equal(rows[0].dial_capability, 'post');

    const pending = store.db
      .prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = 'pending'")
      .get(workspaceId).n;
    assert.equal(pending, 1, `${label}: one Vorschlag waits in the inbox`);
  } finally {
    await agent.close();
  }
  return { workspaceId, accId };
}

/** The other half of the closed map: `till-studio` keeps the human seat and opens no session. */
async function assertStudioClientKeepsItsSeat(url, store, workspaceId, accId, label) {
  const studio = await connect(url, STUDIO_CLIENT_NAME);
  try {
    const me = await callVerb(studio, 'whoami', { workspaceId });
    assert.equal(me.actor, 'studio', `${label}: the closed map keeps the Studio's seat`);
    const before = traceRows(store, workspaceId).length;
    const posted = await callVerb(studio, 'post_entry', postArgs(workspaceId, accId, `${label}-studio`));
    assert.equal(posted.ok, true, `${label}: ${JSON.stringify(posted)}`);
    assert.notEqual(posted.drafted, true, `${label}: the human's own write is not drafted`);
    assert.equal(typeof posted.entryId, 'string');
    assert.equal(traceRows(store, workspaceId).length, before, `${label}: a human opens no agent session`);
  } finally {
    await studio.close();
  }
}

test('till up: an unrecognised MCP client (Claude Desktop) is the governed seat; till-studio is not', async () => {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-seat-up-'));
  const studioDir = mkdtempSync(join(tmpdir(), 'till-seat-studio-'));
  writeFileSync(join(studioDir, 'index.html'), '<!doctype html><title>TILL Studio</title>');
  resetDeliveryRuntime();
  const up = await startUp({ dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir, open: false, tickMs: 60_000 });
  assert.equal(up.started, true);
  try {
    const { workspaceId, accId } = await assertUnknownClientIsGoverned(up.url, up.store, 'till up');
    await assertStudioClientKeepsItsSeat(up.url, up.store, workspaceId, accId, 'till up');
  } finally {
    await up.close();
  }
});

test('till serve: an unrecognised MCP client is the governed seat', async () => {
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0 });
  try {
    const { workspaceId, accId } = await assertUnknownClientIsGoverned(handle.url, handle.store, 'till serve');
    await assertStudioClientKeepsItsSeat(handle.url, handle.store, workspaceId, accId, 'till serve');
  } finally {
    await handle.close();
  }
});

test('the dev bridge composition (REST actor studio, rest:true): /mcp seats the unknown client as agent, /api stays studio', async () => {
  // EXACTLY what app/dev-api.ts assembles: the shared deps with the REST face's `studio` actor and
  // both faces mounted. The bridge is a Vite plugin, so its router is driven here over a bare
  // listener; the composition (and the defect it used to carry) is the deps + options, not Vite.
  const { deps, store } = makeApiDeps();
  const router = createLocalHttpRouter({ ...deps, actor: 'studio' }, { rest: true });
  const server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { workspaceId, accId } = await assertUnknownClientIsGoverned(url, store, 'dev bridge');
    await assertStudioClientKeepsItsSeat(url, store, workspaceId, accId, 'dev bridge');

    // The REST twin is the Studio's own bridge: it stays the human seat, executes, and opens no session.
    const before = traceRows(store, workspaceId).length;
    const resp = await fetch(`${url}/api/post_entry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(postArgs(workspaceId, accId, 'dev-rest')),
    });
    const body = await resp.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.notEqual(body.drafted, true, 'the REST bridge is the human: its write executes');
    assert.equal(traceRows(store, workspaceId).length, before, 'the REST bridge opens no agent session');
  } finally {
    await router.closeAll();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
