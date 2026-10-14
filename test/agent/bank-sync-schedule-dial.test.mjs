/**
 * D142, critic F4: `set_bank_sync_schedule` decides when TILL fetches the owner's bank statements and,
 * since critic F1, WHO the unattended fetch runs as. So it is neither automatable nor an agent act:
 *
 *  - it sits on the G01 denylist beside `bank_sync` (a stored rule cannot switch an owner's `off` back
 *    to `daily`);
 *  - for a governed seat it takes the path the repo already uses for the workspace's other governing
 *    settings (the membership verbs, D123): it is dial-governed under `customize`, so the agent PROPOSES
 *    the change, a human approves it, and the approval replays AS the human, who then becomes the actor
 *    the automatic fetch runs as. A human's own call executes at once, as before.
 *
 * Driven through the real transport dispatch (`callTool`) for the agent and through the registry for
 * the human, the split the Studio makes. Synthetic by construction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/index.js';
import { NOT_AUTOMATABLE, isNotAutomatable } from '../../dist/core/automation/denylist.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { syntheticIban } from '../banking/ebics-support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace({ ...deps, actor: 'studio' }, 'Synthetische Dial GmbH', 'ws-dial');
  const account = human(deps, 'create_bank_account', { workspaceId, name: 'Konto Dial', iban: syntheticIban(6161), ledgerAccountId: accId('1020'), idempotencyKey: 'ba-dial' });
  assert.equal(account.ok, true, JSON.stringify(account));
  const connected = human(deps, 'bank_channel_connect', {
    workspaceId,
    host: { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHDIA', partnerId: 'PARTNER61', userId: 'USER0061' },
    routeBankAccountIds: [account.bankAccountId],
    confirm: true,
    idempotencyKey: 'c-dial',
  });
  assert.equal(typeof connected.connectionId, 'string', JSON.stringify(connected));
  const schedule = () =>
    deps.store.db.prepare('SELECT auto_sync_mode AS mode, auto_sync_at AS at, auto_sync_actor AS actor FROM ebics_connection WHERE id = ?').get(connected.connectionId);
  return { deps, workspaceId, connectionId: connected.connectionId, schedule };
}

test('F4: set_bank_sync_schedule is on the G01 denylist beside bank_sync: no stored rule changes the schedule', () => {
  assert.equal(NOT_AUTOMATABLE.has('set_bank_sync_schedule'), true);
  assert.equal(isNotAutomatable('set_bank_sync_schedule'), true);
  assert.equal(NOT_AUTOMATABLE.has('bank_sync'), true);
});

test('F4: the agent seat PROPOSES a schedule change; the human approves and becomes the actor the fetch runs as', () => {
  const w = world();
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.set_bank_sync_schedule, 'customize');
  assert.equal(typeof getAction('set_bank_sync_schedule').consequence, 'string');

  const drafted = mcp(w.deps, 'set_bank_sync_schedule', { workspaceId: w.workspaceId, connectionId: w.connectionId, mode: 'off', idempotencyKey: 'ag-off' });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  assert.equal(drafted.drafted, true, 'a governed seat proposes, it does not change the owner schedule');
  assert.equal(drafted.dialCapability, 'customize');
  assert.deepEqual(w.schedule(), { mode: null, at: null, actor: null }, 'nothing moved');

  assert.equal(mcp(w.deps, 'approve_drafted_action', { workspaceId: w.workspaceId, actionId: drafted.actionId }).error, 'permission_denied', 'the agent cannot approve its own proposal');
  const approved = human(w.deps, 'approve_drafted_action', { workspaceId: w.workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(w.schedule(), { mode: 'off', at: null, actor: 'studio' }, 'the approval replays as the human, who is now the schedule\'s actor');
});

test('F4: a human sets the schedule at once, through the registry and over MCP as the Studio seat', () => {
  const w = world();
  const direct = human(w.deps, 'set_bank_sync_schedule', { workspaceId: w.workspaceId, connectionId: w.connectionId, mode: 'daily', atTime: '06:45', idempotencyKey: 'h-1' });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.notEqual(direct.drafted, true);
  assert.deepEqual(w.schedule(), { mode: 'daily', at: '06:45', actor: 'studio' });
  const viaStudio = mcp({ ...w.deps, actor: 'studio' }, 'set_bank_sync_schedule', { workspaceId: w.workspaceId, connectionId: w.connectionId, mode: 'off', idempotencyKey: 'h-2' });
  assert.notEqual(viaStudio.drafted, true, JSON.stringify(viaStudio));
  assert.equal(w.schedule().mode, 'off');
});
