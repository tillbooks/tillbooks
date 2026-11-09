// Critic A41.3 r4 (non-author), I-E over the merged card change (`chat-belege-actions.ts` withReceiptHolders,
// 05876f9bd): a seat that reads drafted actions (read_books) but not receipts (read_master_data) must not be handed
// an assignment row (I-E: "assignment rows never appear for it").
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg, activeOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

test('C1 (I-E): an agent seat without read_master_data reads the assignment (line, id, source) off a drafted card', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'c1-rb' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const [held] = debits(t, [1950], { from: '2026-04-01' });
  const r = receipt(t, { amount: 1950, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, held, [r.fileId]));
  const [booked] = debits(t, [1950], { from: '2026-05-01' });
  bookAsProposed(t, booked);
  // At the default dial the agent's link is DRAFTED: the card stores its holders.
  const drafted = handleRest('files_link', { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: booked, idempotencyKey: 'c1-l' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(typeof drafted.actionId, 'string', `precondition: drafted ${JSON.stringify(drafted).slice(0, 160)}`);
  // The agent seat holds the books and the bank lines, not the receipts.
  const owner = { ...t.deps, actor: 'studio' };
  const role = must(getAction('define_role').run(owner, { workspaceId: t.workspaceId, name: 'Ohne Belege', capabilities: ['read_books', 'read_sales'], idempotencyKey: 'c1-role' }));
  // The e3-permissions shape: the first invite turns on members, which seats the local agent as a member.
  must(getAction('invite_member').run(owner, { workspaceId: t.workspaceId, email: 'c1@muster.ch', role: 'bookkeeper', idempotencyKey: 'c1-inv' }));
  const members = getAction('list_members').run(owner, { workspaceId: t.workspaceId });
  const seat = (members.members ?? []).find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, `precondition: the agent is a member ${JSON.stringify(members).slice(0, 400)}`);
  must(getAction('set_role').run(owner, { workspaceId: t.workspaceId, memberId: seat.memberId, role: role.roleId }));
  assert.equal(handleRest('list_bank_inbox', { workspaceId: t.workspaceId, bankTxnId: held, status: 'all' }, { ...t.deps, actor: 'agent' }).body.lines?.[0]?.belegAssignment ?? null, null, 'precondition: the inbox hides the assignment from this seat');
  const listed = handleRest('list_drafted_actions', { workspaceId: t.workspaceId }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 200));
  const card = (listed.actions ?? []).find((a) => a.actionId === drafted.actionId);
  const leaked = (card?.receiptHolders ?? []).filter((h) => h.entityKind === 'beleg_assignment');
  assert.deepEqual(leaked, [], `the card hands this seat the assignment the inbox hides (assignment ${activeOf(t, held)?.id} on ${held}): ${JSON.stringify(leaked)}`);
});
