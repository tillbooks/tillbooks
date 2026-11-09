// Critic A41.3 r5 (non-author): the one redaction (`holdersForSeat`) on the REFUSAL path, the emitter beside the
// card that r4 named by code reading. A seat without read_master_data that is refused receipt_assigned learns
// "held" and nothing more: no line, no assignment id, no source.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

test('X1 (held): an agent seat without read_master_data, refused receipt_assigned at an open dial, sees one receipt_held marker', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'x1-rb' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const [held] = debits(t, [1960], { from: '2026-04-01' });
  const r = receipt(t, { amount: 1960, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, held, [r.fileId]));
  const [booked] = debits(t, [1960], { from: '2026-05-01' });
  bookAsProposed(t, booked);
  const owner = { ...t.deps, actor: 'studio' };
  for (const capability of ['post', 'pay', 'close-period', 'customize']) {
    must(getAction('set_agent_dial').run(owner, { workspaceId: t.workspaceId, capability, level: 'auto', idempotencyKey: `x1-dial-${capability}` }));
  }
  must(getAction('invite_member').run(owner, { workspaceId: t.workspaceId, email: 'x1@muster.ch', role: 'bookkeeper', idempotencyKey: 'x1-inv' }));
  const role = must(getAction('define_role').run(owner, { workspaceId: t.workspaceId, name: 'Ohne Belege', capabilities: ['read_books', 'read_sales', 'pay', 'manage_files'], idempotencyKey: 'x1-role' }));
  const seat = getAction('list_members').run(owner, { workspaceId: t.workspaceId }).members.find((m) => m.actorId === 'agent');
  must(getAction('set_role').run(owner, { workspaceId: t.workspaceId, memberId: seat.memberId, role: role.roleId }));
  const res = handleRest('files_link', { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: booked, idempotencyKey: 'x1-l' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(res.error, 'receipt_assigned', JSON.stringify(res).slice(0, 300));
  assert.deepEqual(res.holders, [{ entityKind: 'receipt_held', entityId: null, reservedBy: null }], JSON.stringify(res));
  assert.equal(JSON.stringify(res).includes(held), false, 'the line is named nowhere in the refusal');
  assert.deepEqual(assignmentsOf(t, held).map((a) => [a.source, a.state]), [['person', 'active']]);
});
