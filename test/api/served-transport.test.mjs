/**
 * M01, the served-mode trust boundary over a REAL listener. This is the half `served-identity.test.mjs`
 * cannot reach: that suite drives `action.run` directly with an already-resolved identity, so it proves
 * the ENGINE behaviour; this proves the TRANSPORT actually strips-and-resets the trust decision.
 *
 * The four assertions, all over 127.0.0.1 on an ephemeral port, offline:
 *  - a served /mcp request with NO subject header is refused `missing_subject` BEFORE any tool lists;
 *  - a spoofed subject header on a LOCAL (unconfigured) server grants nothing: `whoami` reads
 *    `local_client`, subject null (the header was never even read);
 *  - a served /mcp request WITH a subject header is refused `create_workspace` when the subject is a
 *    stranger (D111) yet threads the identity into `whoami` (`served_subject` + subject);
 *  - a reused mcp-session-id carrying a DIFFERENT subject is refused `subject_changed`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpServer } from '../../dist/api/serve.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const SERVED = { enabled: true, headerName: 'till-authenticated-subject' };

/** A raw JSON-RPC initialize body (no MCP client needed to probe the pre-session refusals). */
function initBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
  });
}

const RPC_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

test('served /mcp with no subject header is refused missing_subject before any tool lists', async () => {
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0, servedMode: SERVED });
  try {
    const resp = await fetch(`${handle.url}/mcp`, { method: 'POST', headers: RPC_HEADERS, body: initBody() });
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.equal(body.error, 'missing_subject');
  } finally {
    await handle.close();
  }
});

test('a spoofed subject header on a LOCAL server grants nothing (the header is never read)', async () => {
  // Served mode OFF (default). A client-supplied identity header must not grant identity on a laptop.
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0 });
  const client = new Client({ name: 'local-probe', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
        requestInit: { headers: { 'till-authenticated-subject': 'attacker@evil.example' } },
      }),
    );
    const created = JSON.parse(
      (await client.callTool({ name: 'create_workspace', arguments: { name: 'Local GmbH', idempotencyKey: 'ws-1' } })).content[0].text,
    );
    const me = JSON.parse(
      (await client.callTool({ name: 'whoami', arguments: { workspaceId: created.workspaceId } })).content[0].text,
    );
    // D13 resolution applied; the header was ignored entirely.
    assert.equal(me.identitySource, 'local_client');
    assert.equal(me.subject, null);
  } finally {
    await client.close();
    await handle.close();
  }
});

test('served /mcp threads the proxy-attested subject into whoami', async () => {
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0, servedMode: SERVED });
  const client = new Client({ name: 'served-probe', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
        requestInit: { headers: { 'till-authenticated-subject': 'dominic@example.ch' } },
      }),
    );

    // D111: a served STRANGER (a subject seated in no workspace) can no longer MINT one. Since M01 F1
    // it cannot access what it creates, so an ungated create is a spam/DoS door: the transport must
    // refuse it (permission_denied), and this asserts the gate is reached over a real listener.
    const denied = JSON.parse(
      (await client.callTool({ name: 'create_workspace', arguments: { name: 'Served GmbH', idempotencyKey: 'ws-1' } })).content[0].text,
    );
    assert.equal(denied.ok, false, 'a served stranger must be refused create_workspace (D111)');
    assert.equal(denied.error, 'permission_denied');

    // The THREADING is still what this test proves: seed a workspace by the LOCAL trust boundary (the
    // SQLite-file holder, identitySource absent, unaffected by D111), then have the served stranger read
    // it. whoami names the attested subject, reports the served source, and holds nothing (not a member,
    // never auto-provisioned).
    const seeded = createWorkspace(
      { store: handle.store, clock: fixedClock('2026-08-18T00:00:00.000Z'), ids: sequenceIdGen(), actor: 'studio' },
      { name: 'Local Seed GmbH', idempotencyKey: 'seed-1' },
    );
    assert.equal(seeded.ok, true, `local seed must succeed: ${JSON.stringify(seeded)}`);

    const me = JSON.parse(
      (await client.callTool({ name: 'whoami', arguments: { workspaceId: seeded.workspaceId } })).content[0].text,
    );
    assert.equal(me.identitySource, 'served_subject');
    assert.equal(me.subject, 'dominic@example.ch');
    assert.equal(me.isMember, false);
  } finally {
    await client.close();
    await handle.close();
  }
});

test('a reused mcp-session-id carrying a different subject is refused subject_changed', async () => {
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0, servedMode: SERVED });
  try {
    // Open a session as subject A.
    const opened = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { ...RPC_HEADERS, 'till-authenticated-subject': 'alice@example.ch' },
      body: initBody(),
    });
    assert.equal(opened.status, 200);
    const sessionId = opened.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize must mint an mcp-session-id');

    // Reuse that session id, but with subject B (a stolen session id under a different attested subject).
    const reused = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: {
        ...RPC_HEADERS,
        'mcp-session-id': sessionId,
        'till-authenticated-subject': 'mallory@example.ch',
        // A plain tools/list; the subject check fires before the session even serves it.
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(reused.status, 401);
    const body = await reused.json();
    assert.equal(body.error, 'subject_changed');
  } finally {
    await handle.close();
  }
});
