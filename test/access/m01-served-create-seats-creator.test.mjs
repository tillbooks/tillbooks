/**
 * M01/D111, the P3 security critic's F6: a served MEMBER's `create_workspace` seats the creator.
 *
 * D111 allows a served member (a subject seated in at least one workspace) to create another, the
 * Treuhänder remote new-mandate flow. Before this fix the verb minted the row and seated nobody: a
 * served identity gets no unprovisioned-workspace grant (M01 F1), so the creator's own `whoami` on
 * the new tenant was `isMember:false` and every read and invite was `permission_denied`. The tenant
 * was reachable by no one, and every member could mint them without limit.
 *
 * Driven through the SERVED TRANSPORT (a real listener with `servedMode` on, an MCP client carrying
 * the subject header), the way the drill's agent seat reaches the engine, and once more at the
 * engine seam for the audit row. The LOCAL path is asserted unchanged: a bare local create still
 * leaves the book unprovisioned (the persona-F solo case A24 step 1 depends on).
 *
 * BITE: remove the `identitySource === 'served_subject'` seating block from `createWorkspace`
 * (`dist/core/setup/workspace.js`) and the first test reddens at `isMember`: the creator is a
 * stranger on its own mandate and `list_accounts` is refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttpServer } from '../../dist/api/serve.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const SERVED = { enabled: true, headerName: 'till-authenticated-subject' };
const BOB = 'bob@treuhand.example';

const call = (deps, name, input) => getAction(name).run(deps, input);
const text = (r) => JSON.parse(r.content[0].text);

async function connectAs(url, subject) {
  const client = new Client({ name: 'served-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { 'till-authenticated-subject': subject } },
    }),
  );
  return client;
}

test('served transport: a member who creates a workspace is its owner, and can read it', async () => {
  // A file-backed store, so the LOCAL seed (a second connection, the drill's own pattern) and the
  // served listener share one ledger.
  const dir = mkdtempSync(join(tmpdir(), 'till-f6-'));
  const dbPath = join(dir, 'till.db');
  const handle = await startHttpServer({ dbPath, port: 0, servedMode: SERVED });
  const local = makeApiDeps(dbPath);
  let client = null;
  try {
    // LOCAL provisioning: mandate one exists and Bob is invited as a bookkeeper (M01 order).
    const w1 = call(local.deps, 'create_workspace', { name: 'Mandate One', idempotencyKey: 'ws1' });
    assert.equal(w1.ok, true, JSON.stringify(w1));
    const invited = call(local.deps, 'invite_member', { workspaceId: w1.workspaceId, email: BOB, role: 'bookkeeper', idempotencyKey: 'inv-bob' });
    assert.equal(invited.ok, true, JSON.stringify(invited));

    // SERVED: Bob redeems through the door, then reconnects (identity is pinned at initialize).
    client = await connectAs(handle.url, BOB);
    const accepted = text(await client.callTool({ name: 'accept_invite', arguments: { token: invited.token } }));
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    await client.close();
    client = await connectAs(handle.url, BOB);

    // D111: the member may create. F6: the member is SEATED on what it created.
    const created = text(await client.callTool({ name: 'create_workspace', arguments: { name: 'Bob New Mandate', idempotencyKey: 'bob-new' } }));
    assert.equal(created.ok, true, `a served member must be allowed to create: ${JSON.stringify(created)}`);
    const me = text(await client.callTool({ name: 'whoami', arguments: { workspaceId: created.workspaceId } }));
    assert.equal(me.identitySource, 'served_subject');
    assert.equal(me.isMember, true, `the creator must be a member of its own mandate: ${JSON.stringify(me)}`);
    assert.equal(me.role, 'owner', 'the creator is the owner');
    assert.match(String(me.actor), /^member:/);

    // And the mandate is usable: a read, and the picker lists it.
    const accounts = text(await client.callTool({ name: 'list_accounts', arguments: { workspaceId: created.workspaceId } }));
    assert.equal(accounts.ok, true, `the owner must be able to read the new mandate: ${JSON.stringify(accounts)}`);
    const listed = text(await client.callTool({ name: 'list_workspaces', arguments: {} }));
    assert.ok(listed.workspaces.some((w) => w.workspaceId === created.workspaceId), 'the new mandate is in the creator\'s picker');

    // Idempotent replay returns the SAME workspace and seats nobody twice.
    const again = text(await client.callTool({ name: 'create_workspace', arguments: { name: 'Bob New Mandate', idempotencyKey: 'bob-new' } }));
    assert.equal(again.workspaceId, created.workspaceId);
    const owners = local.store.db
      .prepare("SELECT COUNT(*) AS n FROM workspace_member m JOIN user u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?")
      .get(created.workspaceId, BOB);
    assert.equal(owners.n, 1, 'one member row for the creator, not one per replay');
  } finally {
    if (client) await client.close();
    local.store.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine seam: the seating lands on the A03 audit chain as claim_owner, by the served actor', () => {
  const deps = freshDeps();
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const invited = call(deps, 'invite_member', { workspaceId: w1, email: BOB, role: 'bookkeeper', idempotencyKey: 'inv' });
  assert.equal(invited.ok, true);
  const asBobStranger = { ...deps, ...resolveServedActor(deps.store, BOB) };
  assert.equal(call(asBobStranger, 'accept_invite', { token: invited.token }).ok, true);
  const bob = resolveServedActor(deps.store, BOB);
  const asBob = { ...deps, actor: bob.actor, subject: bob.subject, identitySource: bob.identitySource };

  const created = call(asBob, 'create_workspace', { name: 'Bob Mandate Two', idempotencyKey: 'two' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const rows = deps.store.db
    .prepare("SELECT action, actor FROM audit_log WHERE workspace_id = ? AND action = 'claim_owner'")
    .all(created.workspaceId);
  assert.ok(rows.length >= 1, 'the seating must be audited as claim_owner');
  assert.ok(rows.every((r) => r.actor === bob.actor), `the audit actor is the served creator, got ${JSON.stringify(rows)}`);
});

test('local unchanged: a bare local create still leaves the book unprovisioned', () => {
  const deps = freshDeps();
  const created = call(deps, 'create_workspace', { name: 'Solo Books', idempotencyKey: 'solo' });
  assert.equal(created.ok, true);
  const members = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?')
    .get(created.workspaceId);
  assert.equal(members.n, 0, 'a local bare create seats nobody (A24 step 1 covers the solo case)');
});
