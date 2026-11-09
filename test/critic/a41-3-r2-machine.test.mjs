// Critic A41.3 r2 (non-author), probe group M: "only a PERSON ends a person's receipt assignment" (I-D, and
// the r1 R2 fix's own rule, `intakeSeat.ts#isMachineAct`). Every machine door that could end a person row:
// a plugin call, a person's approval of an agent's draft, and the other capture verbs beside discard.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

function world(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  at(t, '2026-07-20T08:00:00.000Z');
  const [line] = debits(t, [2110], { from: '2026-04-01' });
  const r = receipt(t, { amount: 2110, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  return { t, line, r };
}
const rowsOf = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);
const PERSON_ACTIVE = [['person', 'active', null]];
const draftAndApprove = (t, tool, payload, k) => {
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const d = must(enqueueDraftedAction(agentCtx, { actionTool: tool, payload: { workspaceId: t.workspaceId, ...payload, idempotencyKey: k }, dialCapability: null, idempotencyKey: `${k}-row` }));
  return getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: d.actionId });
};

test('M1 (held): a plugin running as the person, and a person approving an agent\'s drafted discard, are both refused receipt_assigned', () => {
  const { t, line, r } = world('m1');
  const plugin = withinPluginCall('user_1', () => getAction('capture_discard').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId, reason: 'x', idempotencyKey: 'm1-p' }));
  assert.equal(plugin.error, 'receipt_assigned', JSON.stringify(plugin));
  const approved = draftAndApprove(t, 'capture_discard', { captureId: r.captureId, reason: 'x' }, 'm1-d');
  assert.equal(approved.ok, false, JSON.stringify(approved));
  assert.equal(approved.error, 'receipt_assigned');
  assert.deepEqual(rowsOf(t, line), PERSON_ACTIVE);
  assert.equal(t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(r.captureId).status, 'needs_review');
});

test('M2: a person approving an AGENT\'s drafted figure edit releases the person\'s row (the edit counts as the person\'s)', () => {
  const { t, line, r } = world('m2');
  const approved = draftAndApprove(t, 'capture_extract', { captureId: r.captureId, source: 'agent', fields: [{ key: 'amount', value: { minor: 2111, currency: 'CHF' }, confidence: 'high' }] }, 'm2-x');
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(rowsOf(t, line), PERSON_ACTIVE, 'an approved agent edit is the agent\'s act (isMachineAct), so the person row must stand as a governed edit does');
});

test('M3: an agent moves a person-assigned receipt off its line and commits it into a vendor bill: a machine act ends the person\'s row', () => {
  const { t, line, r } = world('m3');
  for (const capability of ['close-period', 'post', 'customize']) {
    must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability, level: 'auto', idempotencyKey: `m3-dial-${capability}` }));
  }
  const vendor = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: TELCO, idempotencyKey: 'm3-v' })).contact.id;
  const moved = handleRest('files_link', { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'contact', entityId: vendor, idempotencyKey: 'm3-mv' }, { ...t.deps, actor: 'agent' }).body;
  // Author, v3 (spec point 4): the premise changes. The machine MOVE of an assigned row is now refused itself;
  // the intent (a machine never ends a person row) is enforced one step earlier, and the commit stays refused.
  assert.equal(moved.error, 'receipt_assigned', JSON.stringify(moved));
  const commit = handleRest(
    'capture_commit',
    { workspaceId: t.workspaceId, captureId: r.captureId, target: { kind: 'vendor_bill', vendorId: vendor, billDate: '2026-04-01', expenseAccountId: t.acc('6570') }, idempotencyKey: 'm3-c' },
    { ...t.deps, actor: 'agent' },
  ).body;
  assert.deepEqual(
    { rows: rowsOf(t, line), commit: commit.ok === true ? 'executed' : commit.error ?? (commit.actionId ? 'drafted' : JSON.stringify(commit).slice(0, 80)) },
    { rows: PERSON_ACTIVE, commit: 'receipt_assigned' },
    'only a person ends a person\'s receipt assignment; a machine commit of the receipt must be refused like a machine discard',
  );
});
