/**
 * A35 CRITIC REGRESSIONS (the 18.08.2026 FAIL, `docs/critique/a35-critic.md`): the critic's probes,
 * adopted as permanent gate tests with the polarity FLIPPED to assert the fixes. Where a probe
 * asserted a defect ("the agent grants itself autonomy"), this suite asserts the repaired contract
 * ("a self-grant is refused, on every path"), so the exact attacks that broke the branch stay
 * standing against every later change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { handleRest } from '../../dist/api/rest.js';
import { buildMcpServer } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { STUDIO_CLIENT_NAME } from '../../dist/api/session.js';
import { registerRuntime, resetRuntimeRegistration } from '../../dist/core/voice/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { stubAdapter, stubManifest } from '../voice/fixtures.mjs';

const QUESTION = 'Wie hoch ist der Umsatz im Juni?';
const rest = (deps, name, input) => handleRest(name, input, deps).body;

function postArgs(workspaceId, accId, key) {
  return {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 120000 },
      { account: accId('1020'), credit: 120000 },
    ],
  };
}

/* ------------------------------------------------------------------------- F1: the grant model */

test('F1a UNPROVISIONED: the agent seat cannot grant itself anything, and its post still drafts', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  assert.equal(deps.actor, 'agent', 'the premise: the agent seat, over the real REST door');

  const grant = rest(deps, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'self-1' });
  assert.equal(grant.ok, false, 'the self-grant is refused');
  assert.ok(
    grant.error === 'permission_denied' || grant.error === 'cannot_self_grant',
    `refused with the governor denial, got ${grant.error}`,
  );
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_dial WHERE workspace_id = ?').get(workspaceId).n, 0);

  const posted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'self-p1'));
  assert.equal(posted.drafted, true, 'the ungranted agent still drafts');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n, 0);
  deps.store.close();
});

test('F1b the strong-default pair is not self-grantable, and vat_mark_filed keeps drafting', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  for (const capability of ['vat-file', 'plugin-install']) {
    const grant = rest(deps, 'set_agent_dial', { workspaceId, capability, level: 'auto', idempotencyKey: `sg-${capability}` });
    assert.equal(grant.ok, false, `${capability}: self-grant refused`);
  }
  const filed = rest(deps, 'vat_mark_filed', { workspaceId, period: '2026-06', idempotencyKey: 'sg-file' });
  assert.equal(filed.drafted, true, 'the filing mark still asks');
  assert.equal(filed.reason, 'force_ask');
  deps.store.close();
});

test('F1c PROVISIONED: the agent seat is an owner and STILL never holds manage_agent_dial', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const invited = getAction('invite_member').run(
    { ...deps, actor: 'studio' },
    { workspaceId, email: 'chef@example.ch', role: 'bookkeeper', idempotencyKey: 'inv-1' },
  );
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const seat = deps.store.db
    .prepare(
      `SELECT m.role FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.actor_id = 'agent'`,
    )
    .get(workspaceId);
  assert.equal(seat?.role, 'owner', 'the premise: seatFirstOwner really seats the agent as owner');

  const grant = rest(deps, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'prov-1' });
  assert.equal(grant.ok, false, 'ownership does not include the governor: step 0 runs before the role');
  const posted = rest(deps, 'post_entry', postArgs(workspaceId, accId, 'prov-p'));
  assert.equal(posted.drafted, true);
  deps.store.close();
});

test('F1d the agent cannot revoke or overwrite a HUMAN grant: the control is one-way', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  rest({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'h-1' });
  const back = rest(deps, 'set_agent_dial', { workspaceId, capability: 'post', level: 'ask', idempotencyKey: 'a-1' });
  assert.equal(back.ok, false, 'the agent cannot touch the row in either direction');
  const row = deps.store.db
    .prepare("SELECT level, updated_by FROM agent_dial WHERE workspace_id = ? AND capability = 'post'")
    .get(workspaceId);
  assert.equal(row.level, 'auto');
  assert.equal(row.updated_by, 'studio', 'the human attribution survives');
  deps.store.close();
});

/* --------------------------------------------------------------- F2: prose deletion, every copy */

test('F2 agent_prose_delete leaves NO copy: turn text, call args and the read face are all clean', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  resetRuntimeRegistration();
  registerRuntime(stubAdapter(), stubManifest());

  const asked = rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'pp-1' });
  assert.equal(asked.ok, true, JSON.stringify(asked));

  const cleared = rest({ ...deps, actor: 'studio' }, 'agent_prose_delete', {
    workspaceId,
    sessionId: asked.sessionId,
    idempotencyKey: 'pp-2',
  });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));

  const texts = deps.store.db
    .prepare('SELECT text FROM agent_turn WHERE workspace_id = ? AND session_id = ?')
    .all(workspaceId, asked.sessionId);
  assert.ok(texts.every((t) => t.text === null), 'the turn text is nulled');

  const survivors = deps.store.db
    .prepare('SELECT verb FROM agent_call WHERE workspace_id = ? AND args_json LIKE ?')
    .all(workspaceId, `%${QUESTION}%`);
  assert.deepEqual(survivors.map((r) => r.verb), [], 'no call row holds the sentence');

  const composer = rest(deps, 'get_agent_session', { workspaceId, sessionId: asked.sessionId });
  assert.equal(JSON.stringify(composer).includes(QUESTION), false, 'the read face hands nothing back');

  // The TRANSPORT row for agent_ask never stored the sentence in the first place (stripped at the
  // seam), so even the rows outside this session are clean by construction.
  const transportRows = deps.store.db
    .prepare("SELECT args_json FROM agent_call WHERE workspace_id = ? AND verb = 'agent_ask'")
    .all(workspaceId);
  for (const row of transportRows) assert.equal(row.args_json.includes(QUESTION), false);
  resetRuntimeRegistration();
  deps.store.close();
});

/* ----------------------------------------------- F7: restore is not a bulk dial flip any more */

test('F7 restore_backup carries NO dial rows into the new tenant: a restored workspace starts at ask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a35-regress-bulk-'));
  const deps = { ...freshDeps(), backupDir: dir };
  const { workspaceId } = mintWorkspace(deps);
  const human = { ...deps, actor: 'studio' };
  for (const capability of ['post', 'vat-file']) {
    const granted = rest(human, 'set_agent_dial', { workspaceId, capability, level: 'auto', idempotencyKey: `bf-${capability}` });
    assert.equal(granted.ok, true, JSON.stringify(granted));
  }

  const backup = rest(deps, 'create_backup', { workspaceId, idempotencyKey: 'bf-b' });
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const restored = rest(deps, 'restore_backup', {
    source: backup.artifactRef,
    newWorkspaceName: 'Kopie',
    confirmed: true,
    idempotencyKey: 'bf-r',
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));

  const rows = deps.store.db
    .prepare('SELECT capability, level, updated_by FROM agent_dial WHERE workspace_id = ?')
    .all(restored.workspaceId);
  assert.deepEqual(rows, [], 'fail-closed: whoever restores re-grants, per capability, attributed');
  deps.store.close();
});

/* ------------------------------------------ F8: the tenant-minting verbs land in the trace now */

test('F8 onboard_client by the agent seat is recorded into the workspace it minted', () => {
  const deps = freshDeps();
  const minted = rest(deps, 'onboard_client', { name: 'Neues Mandat', idempotencyKey: 'ob-1' });
  assert.equal(minted.ok, true, JSON.stringify(minted));

  const rows = deps.store.db
    .prepare("SELECT verb, mode, ok FROM agent_call WHERE workspace_id = ? AND verb = 'onboard_client'")
    .all(minted.workspaceId);
  assert.equal(rows.length, 1, "the agent's first act on a set of books is visible in its trace");
  assert.equal(rows[0].ok, 1);

  const sessions = rest(deps, 'list_agent_sessions', { workspaceId: minted.workspaceId });
  assert.ok(sessions.sessions.length >= 1, 'Gespräche shows the call that created the books');
  deps.store.close();
});

/* ------------------------------- F9: the erasure reaches the trace; the G04 export is by design */

test('F9 contacts_anonymise sweeps the trace: the erased identity survives in no args_json and no prose', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const created = rest(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Erika Muster',
    email: 'erika.muster@example.ch',
    idempotencyKey: 'c-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  // The premise, so the sweep cannot pass vacuously: the trace really holds the email right now.
  assert.ok(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND args_json LIKE ?').get(workspaceId, '%erika.muster@example.ch%').n >= 1,
  );

  const anon = rest(deps, 'contacts_anonymise', {
    workspaceId,
    contactId: created.contact.id,
    confirmed: true,
    idempotencyKey: 'c-2',
  });
  assert.equal(anon.ok, true, JSON.stringify(anon));
  assert.ok(anon.tracePurged.redacted >= 1, 'the erasure reports what it swept in the trace');

  for (const needle of ['erika.muster@example.ch', 'Erika Muster']) {
    const survivors = deps.store.db
      .prepare('SELECT verb FROM agent_call WHERE workspace_id = ? AND args_json LIKE ?')
      .all(workspaceId, `%${needle}%`);
    assert.deepEqual(survivors.map((r) => r.verb), [], `${needle}: swept from every recorded argument`);
  }
  deps.store.close();
});

test('F9 (owner-answered): the G04 full-workspace export INCLUDES the conversation prose, by design', () => {
  // The owner's call (18.08.2026): data freedom means the portability bundle carries EVERYTHING the
  // workspace holds, conversation included; ONLY the A25 statutory exports stay prose-free (D-5).
  const dir = mkdtempSync(join(tmpdir(), 'a35-regress-export-'));
  const deps = { ...freshDeps(), backupDir: dir };
  const { workspaceId } = mintWorkspace(deps);
  resetRuntimeRegistration();
  registerRuntime(stubAdapter(), stubManifest());
  rest(deps, 'agent_ask', { workspaceId, text: QUESTION, idempotencyKey: 'ex-1' });

  const exported = rest(deps, 'export_workspace', { workspaceId, idempotencyKey: 'ex-2' });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const walk = (p) =>
    readdirSync(p, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(p, d.name)) : [join(p, d.name)]));
  const files = walk(exported.artifactRef);
  assert.ok(
    files.some((f) => readFileSync(f, 'utf8').includes(QUESTION)),
    'the data-freedom bundle carries the conversation (the owner decided it does)',
  );
  resetRuntimeRegistration();
  deps.store.close();
});

/* ----------------------------------------------------- F10: inclusive day bounds on the archive */

test('F10 a date-only to bound includes the whole boundary day', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  rest(deps, 'list_accounts', { workspaceId }); // one session at the fixture instant (2026-07-16T00:00Z)
  const day = rest(deps, 'list_agent_sessions', { workspaceId, from: '2026-07-16', to: '2026-07-16' });
  assert.equal(day.ok, true);
  assert.equal(day.sessions.length, 1, 'the session on the boundary day is found');
  const before = rest(deps, 'list_agent_sessions', { workspaceId, from: '2026-07-01', to: '2026-07-15' });
  assert.equal(before.sessions.length, 0, 'and the window before it stays empty');
  deps.store.close();
});

/* ------------------------------------------------------- F11: the consequence field is consumed */

test('F11 the consequence sentence reaches the MCP client and the API catalog', async () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const server = buildMcpServer(deps);
  const client = new Client({ name: 'a35-regress-probe', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const post = tools.find((t) => t.name === 'post_entry');
    assert.ok(post?.description?.includes('CONSEQUENCE:'), 'tools/list carries the consequence to the client');
    const listAccounts = tools.find((t) => t.name === 'list_accounts');
    assert.equal(listAccounts?.description?.includes('CONSEQUENCE:'), false, 'an ungoverned verb advertises none');
  } finally {
    await client.close();
    await server.close();
  }

  const catalog = rest(deps, 'get_api_catalog', { workspaceId });
  assert.equal(catalog.ok, true, JSON.stringify(catalog).slice(0, 300));
  const op = catalog.openapi?.paths?.['/api/post_entry']?.post;
  assert.ok(op !== undefined, 'the catalog lists post_entry');
  assert.ok(String(op.description ?? '').includes('CONSEQUENCE:'), 'the operation carries the consequence');
  const readOp = catalog.openapi?.paths?.['/api/list_accounts']?.post;
  assert.equal(readOp?.description, undefined, 'an ungoverned verb carries none');
  deps.store.close();
});

/* -------------------------------------- F12: the stdio door cannot shed the seat by client name */

test('F12 a stdio client declaring itself till-studio is STILL the agent seat: dialled and traced', async () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // The stdio wiring pins the seat from the transport (startMcpServer passes pinnedActor 'agent').
  const server = buildMcpServer(deps, { pinnedActor: 'agent' });
  const client = new Client({ name: STUDIO_CLIENT_NAME, version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const res = await client.callTool({ name: 'post_entry', arguments: postArgs(workspaceId, accId, 'pin-1') });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.drafted, true, 'the declared studio name does not shed the dial on stdio');
    assert.ok(
      deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ?').get(workspaceId).n >= 1,
      'and does not shed the trace',
    );
  } finally {
    await client.close();
    await server.close();
  }
  deps.store.close();
});

/* --------------------------------------------------- F16: window-straddling proposals count */

test('F16 a proposal made before the window and decided inside it counts as a decision', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  // Planted: proposed long before the default 90-day window, approved at the fixture instant.
  deps.store.db
    .prepare(
      `INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at, resolved_at, resolved_by)
       VALUES ('old-1', ?, 'agent', 'post', 'post_entry', '{}', 'executed', '2025-01-01T00:00:00.000Z', ?, 'studio')`,
    )
    .run(workspaceId, deps.clock.now());
  const trust = rest(deps, 'agent_trust_summary', { workspaceId });
  const post = trust.rows.find((r) => r.capability === 'post');
  assert.equal(post.proposed, 0, 'nothing was PROPOSED inside the window');
  assert.equal(post.approved, 1, 'but the decision made inside the window counts');
  deps.store.close();
});
