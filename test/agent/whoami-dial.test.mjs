/**
 * F-08 / A35 critic F1: THE GOVERNED SEAT CAN READ THE DIAL LEVELS THAT GOVERN IT, AND NOTHING MORE.
 *
 * `get_agent_dial` is the owner's view and rides `manage_agent_dial`, which the governed seat never
 * holds ("the governed seat never holds its own governor", `capability.ts` step 0). J3.10 measured the
 * consequence: the agent could not predict whether its next write would post or draft. The honest
 * route the critic named is a levels-only read, and it is `whoami.agentDial`: the EFFECTIVE level per
 * capability, attached to the one read every agent makes first, present for the governed seat only.
 *
 * HOW IT BITES: drop the `...dial` spread from `whoami`'s member branch and the first assertion fails;
 * make `agentDial` unconditional and the human-seat assertion fails; report the STORED level instead
 * of the effective one and the unattributed-auto case fails (a row the agent seat signed must read
 * `ask`, exactly as the dispatch will treat it).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { startUp } from '../../dist/api/up.js';
import { resolveServedMode } from '../../dist/api/served-mode.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { DIAL_CAPABILITIES } from '../../dist/core/agent/index.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { fixedClock, systemClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function mcp(deps, name, args) {
  return JSON.parse(callTool(deps, name, args).content[0].text);
}
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

test('the agent seat reads every governed capability at its effective level; humans see no agentDial', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  const me = mcp(deps, 'whoami', { workspaceId });
  assert.equal(me.ok, true);
  assert.equal(typeof me.agentDial, 'object', 'the governed seat carries agentDial');
  assert.deepEqual(Object.keys(me.agentDial).sort(), [...DIAL_CAPABILITIES].sort(), 'every governed capability, the closed set');
  for (const c of DIAL_CAPABILITIES) assert.equal(me.agentDial[c], 'ask', `${c} defaults to ask`);
  assert.ok(!me.capabilities.includes('manage_agent_dial'), 'still never the governor');

  // The governor itself stays denied to the seat it governs (A35 critic F1 is untouched).
  const dial = mcp(deps, 'get_agent_dial', { workspaceId });
  assert.equal(dial.ok, false);
  assert.equal(dial.error, 'permission_denied');

  // The Studio (a human) reads no dial on whoami: its payload is byte-compatible with before.
  const studio = mcp({ ...deps, actor: 'studio' }, 'whoami', { workspaceId });
  assert.equal(studio.ok, true);
  assert.equal('agentDial' in studio, false, 'agentDial is the governed seat\'s field only');
  deps.store.close();
});

test('the level the agent reads is the level the dispatch applies: a human grant flips it, an agent-signed row does not', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // The human grants `post`: whoami reads auto, and the next post EXECUTES, exactly as predicted.
  const granted = human(deps, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'grant-post' });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const after = mcp(deps, 'whoami', { workspaceId });
  assert.equal(after.agentDial.post, 'auto');
  assert.equal(after.agentDial.issue, 'ask', 'one row, one capability: nothing else moved');
  const posted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'predicted-auto', 900) });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.notEqual(posted.drafted, true, 'whoami said auto, and auto it was');

  // An `auto` row nobody attributed (or the agent seat signed, pre-hardening data) is EFFECTIVE ask:
  // whoami must say ask, because that is what the dispatch will do (a stored-level read would lie).
  deps.store.db
    .prepare("UPDATE agent_dial SET updated_by = 'agent' WHERE workspace_id = ? AND capability = 'post'")
    .run(workspaceId);
  const unattributed = mcp(deps, 'whoami', { workspaceId });
  assert.equal(unattributed.agentDial.post, 'ask', 'effective, never stored: an unattributed auto reads ask');
  const drafted = mcp(deps, 'post_entry', { workspaceId, ...manualPost(accId, 'predicted-ask', 900) });
  assert.equal(drafted.drafted, true, 'and the dispatch agrees');
  deps.store.close();
});

test('a served member of kind agent reads agentDial too; the served human does not', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const inviteAgent = human(deps, 'invite_member', { workspaceId, email: 'bot@x.ch', role: 'agent', kind: 'agent', idempotencyKey: 'i-bot' });
  const inviteHuman = human(deps, 'invite_member', { workspaceId, email: 'ann@x.ch', role: 'bookkeeper', idempotencyKey: 'i-ann' });
  assert.equal(inviteAgent.ok, true, JSON.stringify(inviteAgent));
  assert.equal(inviteHuman.ok, true, JSON.stringify(inviteHuman));
  const served = (subject) => {
    const id = resolveServedActor(deps.store, subject);
    return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
  };
  assert.equal(getAction('accept_invite').run(served('bot@x.ch'), { token: inviteAgent.token }).ok, true);
  assert.equal(getAction('accept_invite').run(served('ann@x.ch'), { token: inviteHuman.token }).ok, true);

  const bot = mcp(served('bot@x.ch'), 'whoami', { workspaceId });
  assert.match(bot.actor, /^member:/);
  assert.equal(typeof bot.agentDial, 'object', 'the served agent member reads the levels that govern it');
  assert.equal(bot.agentDial.post, 'ask');
  const ann = mcp(served('ann@x.ch'), 'whoami', { workspaceId });
  assert.equal('agentDial' in ann, false, 'a served human reads no dial');
  deps.store.close();
});

/**
 * Governance critic F2 (2026-09-05): `agentDial` is attached on the SEATED branches only. A governed
 * seat that is a member of mandate A and reads `whoami` on mandate B, where it holds nothing, used to
 * get B's full dial beside `role: null` (a real grant included), on `/mcp` and on the REST twin.
 * Driven over `till up` in served mode exactly as a deployment resolves it, the subject header set per
 * request. HOW IT BITES: spread the dial on the not-a-member branch of `whoami` again and the two
 * "holds nothing, reads nothing" assertions below fail with B's `post: auto` in hand.
 */
const SERVED = resolveServedMode({ TILL_SERVED_MODE: 'proxy' });
const BOT = 'bot@seeblick.example';

async function connectServed(url, subject) {
  const client = new Client({ name: 'claude-desktop', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { [SERVED.headerName]: subject } } }),
  );
  return client;
}

async function viaRest(url, subject, action, input) {
  const resp = await fetch(`${url}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SERVED.headerName]: subject },
    body: JSON.stringify(input),
  });
  return resp.json();
}

test('a governed seat that is NOT a member of the workspace reads no agentDial, on /mcp and on /api', async () => {
  const supportDir = mkdtempSync(join(tmpdir(), 'till-whoami-dial-'));
  resetDeliveryRuntime();
  const up = await startUp({
    dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false, tickMs: 60_000, servedMode: SERVED,
  });
  assert.equal(up.started, true);
  try {
    // The LOCAL file holder seeds two mandates, seats the bot in A only, and grants B's `post` to auto.
    // The invite is redeemed through the served `up` process below (real system clock), so mint on the
    // same clock: a fixed past mint date gave the token a life that had already lapsed by run time and
    // `accept_invite` failed `invite_expired`. Nothing here asserts on a timestamp.
    const local = { store: up.store, clock: systemClock, ids: sequenceIdGen(), actor: 'studio' };
    const a = createWorkspace(local, { name: 'A GmbH', idempotencyKey: 'ws-a' }).workspaceId;
    const b = createWorkspace(local, { name: 'B GmbH', idempotencyKey: 'ws-b' }).workspaceId;
    const invite = getAction('invite_member').run(local, { workspaceId: a, email: BOT, role: 'agent', kind: 'agent', idempotencyKey: 'inv-bot' });
    assert.equal(invite.ok, true, JSON.stringify(invite));
    const grant = getAction('set_agent_dial').run(local, { workspaceId: b, capability: 'post', level: 'auto', idempotencyKey: 'grant-b-post' });
    assert.equal(grant.ok, true, JSON.stringify(grant));

    const first = await connectServed(up.url, BOT);
    const accepted = JSON.parse((await first.callTool({ name: 'accept_invite', arguments: { token: invite.token } })).content[0].text);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    await first.close();

    const bot = await connectServed(up.url, BOT);
    try {
      const onA = JSON.parse((await bot.callTool({ name: 'whoami', arguments: { workspaceId: a } })).content[0].text);
      assert.equal(onA.isMember, true);
      assert.equal(typeof onA.agentDial, 'object', 'seated in A: the levels that govern it there');
      assert.equal(onA.agentDial.post, 'ask');

      const onB = JSON.parse((await bot.callTool({ name: 'whoami', arguments: { workspaceId: b } })).content[0].text);
      assert.equal(onB.ok, true, JSON.stringify(onB));
      assert.equal(onB.isMember, false);
      assert.equal(onB.role, null);
      assert.deepEqual(onB.capabilities, []);
      assert.equal('agentDial' in onB, false, 'holds nothing in B, reads none of B\'s configuration (/mcp)');

      const onBRest = await viaRest(up.url, BOT, 'whoami', { workspaceId: b });
      assert.equal(onBRest.ok, true, JSON.stringify(onBRest));
      assert.equal(onBRest.isMember, false);
      assert.equal('agentDial' in onBRest, false, 'holds nothing in B, reads none of B\'s configuration (/api)');
      const onARest = await viaRest(up.url, BOT, 'whoami', { workspaceId: a });
      assert.equal(typeof onARest.agentDial, 'object', 'the REST twin still carries the dial where the seat is seated');
    } finally {
      await bot.close();
    }
  } finally {
    await up.close();
  }
});
