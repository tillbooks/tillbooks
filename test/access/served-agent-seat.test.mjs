/**
 * F-08 (d) / M01 US-M01.3: THE SERVED AGENT MEMBER IS GOVERNED. Over the served door every member
 * stamps `member:<user_id>`, person or machine alike, and the pre-F-08 seat rule (`actor === 'agent'`)
 * therefore seated a served agent OUTSIDE the dial and the trace: its `post_entry` executed at `ask`,
 * untraced, and a real reverse proxy would not have changed that (the seating is engine code). The
 * rule now reads the member's KIND (`user.kind`, set by the inviter, never by the session), so the
 * agent member drafts, is traced, and never holds its governor, while a human member is untouched.
 *
 * Driven over the REAL served transport: `till up` (both faces) with `TILL_SERVED_MODE=proxy` resolved
 * exactly as a deployment resolves it, the subject header set per request, the agent accepting its
 * own invite through the proxy and then acting on a fresh session (identity is pinned per session at
 * `initialize`). The migration half proves a pre-F-08 file gains the column with every existing
 * identity reading as a person.
 *
 * HOW IT BITES: change `isGovernedSeat` back to `actor === AGENT_ACTOR` and the served agent's write
 * executes with zero trace rows (`drafted` undefined, one journal_entry), `whoami` advertises
 * `manage_agent_dial`, and `get_agent_dial` answers. The human-member test stays green under that
 * mutation, which is the point: the human path is what a regression would NOT show.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startUp } from '../../dist/api/up.js';
import { resolveServedMode } from '../../dist/api/served-mode.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { isGovernedSeat, MEMBER_KINDS } from '../../dist/core/access/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

/** The deployment's own resolution: the env var, not a hand-built config. */
const SERVED = resolveServedMode({ TILL_SERVED_MODE: 'proxy' });
const HEADER = SERVED.headerName;
const AGENT_SUBJECT = 'bot@seeblick.example';
const HUMAN_SUBJECT = 'reto@seeblick.example';

async function connect(url, subject, clientName = 'till-cli') {
  const client = new Client({ name: clientName, version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { [HEADER]: subject } } }),
  );
  return client;
}

async function callVerb(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
}

async function rest(url, subject, action, input) {
  const resp = await fetch(`${url}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HEADER]: subject },
    body: JSON.stringify(input),
  });
  return resp.json();
}

/** The LOCAL operator (the file holder) seeds the books and invites: served provisioning is local-first. */
function localDeps(store) {
  return { store, clock: fixedClock('2026-09-05T08:00:00.000Z'), ids: sequenceIdGen(), actor: 'studio' };
}

function seedAndInvite(store) {
  const deps = localDeps(store);
  const ws = createWorkspace(deps, { name: 'Seeblick GmbH', idempotencyKey: 'ws-served' });
  assert.equal(ws.ok, true, JSON.stringify(ws));
  const workspaceId = ws.workspaceId;
  const accId = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const agent = getAction('invite_member').run(deps, {
    workspaceId, email: AGENT_SUBJECT, role: 'agent', kind: 'agent', idempotencyKey: 'inv-agent',
  });
  assert.equal(agent.ok, true, JSON.stringify(agent));
  assert.equal(agent.kind, 'agent', 'the invite answers with the kind it recorded');
  const human = getAction('invite_member').run(deps, {
    workspaceId, email: HUMAN_SUBJECT, role: 'bookkeeper', idempotencyKey: 'inv-human',
  });
  assert.equal(human.ok, true, JSON.stringify(human));
  assert.equal(human.kind, 'human', 'kind defaults to human');
  return { workspaceId, accId, agentToken: agent.token, humanToken: human.token, deps };
}

function postArgs(workspaceId, accId, key, description) {
  return {
    workspaceId,
    date: '2026-09-02',
    description,
    source: 'agent',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 10000 },
      { account: accId('1020'), credit: 10000 },
    ],
  };
}

const traceFor = (store, workspaceId, actor) =>
  store.db
    .prepare(
      `SELECT c.verb, c.mode, c.dial_capability FROM agent_call c JOIN agent_turn t ON t.id = c.turn_id
        JOIN agent_session s ON s.id = t.session_id WHERE c.workspace_id = ? AND s.actor = ?`,
    )
    .all(workspaceId, actor);

const entryCount = (store, workspaceId) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;

async function withServedUp(run) {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-served-seat-'));
  resetDeliveryRuntime();
  const up = await startUp({
    dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false, tickMs: 60_000, servedMode: SERVED,
  });
  assert.equal(up.started, true);
  try {
    await run(up);
  } finally {
    await up.close();
  }
}

test('served agent member: drafts at ask, is traced, never holds its governor, on /mcp AND the REST twin', async () => {
  await withServedUp(async (up) => {
    const { workspaceId, accId, agentToken } = seedAndInvite(up.store);

    // The agent redeems its invite through the proxy. Its identity is pinned per session, so the
    // seat resolves on the NEXT session (the J6.6 measurement's fourth round trip).
    const first = await connect(up.url, AGENT_SUBJECT);
    const accepted = await callVerb(first, 'accept_invite', { token: agentToken });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    await first.close();

    const agent = await connect(up.url, AGENT_SUBJECT);
    try {
      const me = await callVerb(agent, 'whoami', { workspaceId });
      assert.equal(me.identitySource, 'served_subject');
      assert.equal(me.subject, AGENT_SUBJECT);
      assert.match(me.actor, /^member:/, 'US-M01.3: the agent member stamps as ITS member actor, never as a human');
      assert.equal(me.role, 'agent');
      assert.equal(isGovernedSeat(up.store, me.actor), true, 'the kind, not the actor string, makes the seat governed');
      assert.ok(!me.capabilities.includes('manage_agent_dial'), 'whoami never advertises the governor to the governed seat');

      // The governed write at the default ask: drafted, traced, nothing in the ledger.
      const posted = await callVerb(agent, 'post_entry', postArgs(workspaceId, accId, 'served-agent-mcp', 'Served agent over /mcp'));
      assert.equal(posted.ok, true, JSON.stringify(posted));
      assert.equal(posted.drafted, true, 'the served agent member drafts at ask (it used to execute, untraced)');
      assert.equal(entryCount(up.store, workspaceId), 0);
      const rows = traceFor(up.store, workspaceId, me.actor);
      assert.deepEqual(
        rows.filter((r) => r.verb === 'post_entry'),
        [{ verb: 'post_entry', mode: 'draft', dial_capability: 'post' }],
        'exactly one draft row in the trace, under the member actor',
      );
      assert.ok(rows.some((r) => r.verb === 'whoami' && r.mode === 'execute'), 'reads are traced too');

      // The governor stays denied (A35 critic F1), now for THIS seat as well.
      const dial = await callVerb(agent, 'get_agent_dial', { workspaceId });
      assert.equal(dial.ok, false);
      assert.equal(dial.error, 'permission_denied');
      const grant = await callVerb(agent, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'self-grant' });
      assert.equal(grant.ok, false, 'the served agent cannot grant itself auto');
      const pending = await callVerb(agent, 'list_drafted_actions', { workspaceId });
      assert.equal(pending.ok, true);
      const mine = pending.actions.find((a) => a.actionTool === 'post_entry');
      assert.ok(mine, 'the Vorschlag is in the inbox');
      assert.equal(mine.actor, me.actor);
      const self = await callVerb(agent, 'approve_drafted_action', { workspaceId, actionId: mine.actionId });
      assert.equal(self.ok, false, 'the served agent cannot approve its own draft');

      // The REST twin under the same served identity is the same seat: drafted and traced, not executed.
      const viaRest = await rest(up.url, AGENT_SUBJECT, 'post_entry', postArgs(workspaceId, accId, 'served-agent-rest', 'Served agent over REST'));
      assert.equal(viaRest.ok, true, JSON.stringify(viaRest));
      assert.equal(viaRest.drafted, true, 'the REST twin drafts for the served agent member too');
      assert.equal(entryCount(up.store, workspaceId), 0);
      assert.equal(traceFor(up.store, workspaceId, me.actor).filter((r) => r.verb === 'post_entry').length, 2);
    } finally {
      await agent.close();
    }
  });
});

test('served HUMAN member: unaffected, executes at once and opens no session', async () => {
  await withServedUp(async (up) => {
    const { workspaceId, accId, humanToken } = seedAndInvite(up.store);
    const first = await connect(up.url, HUMAN_SUBJECT);
    const accepted = await callVerb(first, 'accept_invite', { token: humanToken });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    await first.close();

    const human = await connect(up.url, HUMAN_SUBJECT);
    try {
      const me = await callVerb(human, 'whoami', { workspaceId });
      assert.match(me.actor, /^member:/);
      assert.equal(me.role, 'bookkeeper');
      assert.equal(isGovernedSeat(up.store, me.actor), false);
      const posted = await callVerb(human, 'post_entry', postArgs(workspaceId, accId, 'served-human', 'Reto over /mcp'));
      assert.equal(posted.ok, true, JSON.stringify(posted));
      assert.notEqual(posted.drafted, true, 'a human member is never drafted');
      assert.equal(typeof posted.entryId, 'string');
      assert.equal(entryCount(up.store, workspaceId), 1);
      assert.equal(traceFor(up.store, workspaceId, me.actor).length, 0, 'a human opens no agent session');
      // The owner (the local file holder) reads the roster: `read_members` is not a bookkeeper's.
      const members = getAction('list_members').run(localDeps(up.store), { workspaceId });
      assert.equal(members.ok, true, JSON.stringify(members));
      const kinds = Object.fromEntries(members.members.map((m) => [m.email ?? m.actorId, m.kind]));
      assert.equal(kinds[HUMAN_SUBJECT], 'human');
      assert.equal(kinds[AGENT_SUBJECT], 'agent', 'list_members names the kind, so the Members surface can show it');
    } finally {
      await human.close();
    }
  });
});

test('invite_member: kind is a closed enum, and an identity cannot be re-declared across mandates', () => {
  const store = new SqliteStore({ clock: fixedClock('2026-09-05T08:00:00.000Z') });
  const deps = localDeps(store);
  const a = createWorkspace(deps, { name: 'A GmbH', idempotencyKey: 'a' }).workspaceId;
  const b = createWorkspace(deps, { name: 'B GmbH', idempotencyKey: 'b' }).workspaceId;
  const bad = getAction('invite_member').run(deps, { workspaceId: a, email: 'x@example.ch', role: 'viewer', kind: 'robot', idempotencyKey: 'k1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_input');
  assert.deepEqual(bad.allowed, [...MEMBER_KINDS]);
  const asAgent = getAction('invite_member').run(deps, { workspaceId: a, email: 'x@example.ch', role: 'viewer', kind: 'agent', idempotencyKey: 'k2' });
  assert.equal(asAgent.ok, true, JSON.stringify(asAgent));
  // The same email invited into a SECOND mandate as a person: refused, the identity is one principal.
  const flipped = getAction('invite_member').run(deps, { workspaceId: b, email: 'x@example.ch', role: 'viewer', kind: 'human', idempotencyKey: 'k3' });
  assert.equal(flipped.ok, false);
  assert.equal(flipped.error, 'member_kind_mismatch');
  // Without a kind the existing identity's kind simply carries.
  const carried = getAction('invite_member').run(deps, { workspaceId: b, email: 'x@example.ch', role: 'viewer', idempotencyKey: 'k4' });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  assert.equal(carried.kind, 'agent');
  store.close();
});

test('a pre-F-08 file gains user.kind on open, and every existing identity reads as a person', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-kind-migration-'));
  const file = join(dir, 'till.db');
  try {
    const fresh = new SqliteStore({ location: file, clock: fixedClock('2026-09-05T08:00:00.000Z') });
    const deps = localDeps(fresh);
    const ws = createWorkspace(deps, { name: 'Alt GmbH', idempotencyKey: 'alt' }).workspaceId;
    // Provision (seats studio + agent as owners) so the file holds identity rows to migrate.
    const inv = getAction('invite_member').run(deps, { workspaceId: ws, email: 'old@example.ch', role: 'viewer', idempotencyKey: 'old' });
    assert.equal(inv.ok, true);
    fresh.close();

    // Make it a pre-F-08 file: drop the column the way a file written before this commit lacks it.
    const raw = new Database(file);
    raw.exec('ALTER TABLE user DROP COLUMN kind');
    assert.ok(!raw.prepare('PRAGMA table_info(user)').all().some((c) => c.name === 'kind'));
    raw.close();

    const reopened = new SqliteStore({ location: file, clock: fixedClock('2026-09-05T08:00:00.000Z') });
    const cols = reopened.db.prepare('PRAGMA table_info(user)').all();
    assert.ok(cols.some((c) => c.name === 'kind'), 'ADDITIVE_COLUMNS widened the old file on open');
    const kinds = reopened.db.prepare('SELECT actor_id, email, kind FROM user').all();
    assert.ok(kinds.length >= 3);
    for (const row of kinds) assert.equal(row.kind, 'human', `${row.actor_id ?? row.email}: a pre-existing identity is a person`);
    // The LOCAL agent actor stays the governed seat by its actor string, kind or no kind.
    assert.equal(isGovernedSeat(reopened, 'agent'), true);
    assert.equal(isGovernedSeat(reopened, 'studio'), false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
