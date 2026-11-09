/**
 * A25 P8: the agent prepares, the Treuhänder signs and exports.
 *
 * The derived boundary suites (test/access/) already hold every A25 verb to "a viewer is refused
 * what it lacks" and "a non-member is refused everything". This suite holds the asymmetry that is
 * A25's own design (US-A25.5): the `agent` built-in role can `prepare_period` (it holds `post`, and
 * prepare only annotates the books) and CANNOT `approve_entry` or export (it holds neither `review`
 * nor `export`), while `treuhaender` can do all of it. The fixture narrows the agent seat through
 * the product's own set_role flow, never a hand-written row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function workspaceWhereAgentHolds(role, seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Mandat AG', `${seed}-ws`);

  // Seed the period BEFORE narrowing, as the studio owner.
  const posted = getAction('post_entry').run(deps, { workspaceId, ...manualPost(accId, `${seed}-post`) });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // The provisioning flip: invite_member seats every D13 actor as owner, then the agent seat is
  // narrowed to the role under test (the test/access fixture's own flow).
  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: `${seed}@muster.ch`,
    role: 'bookkeeper',
    idempotencyKey: `${seed}-invite`,
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const listed = getAction('list_members').run(deps, { workspaceId });
  const seat = listed.members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the flip did not seat the agent');
  const narrowed = getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role });
  assert.equal(narrowed.ok, true, JSON.stringify(narrowed));

  deps.actor = 'agent';
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { call, entryId: posted.entryId };
}

test('A25 P8: the agent role prepares and reads, and is refused sign-off and export', () => {
  const fx = workspaceWhereAgentHolds('agent', 'p8a');

  const prepared = fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'p8a-prep' });
  assert.equal(prepared.ok, true, `the agent could not prepare: ${JSON.stringify(prepared)}`);
  const status = fx.call('review_status', { period: '2026-03' });
  assert.equal(status.ok, true, 'the agent could not read the coverage it prepared');

  for (const [verb, input] of [
    ['approve_entry', { entryId: fx.entryId, idempotencyKey: 'p8a-a' }],
    ['comment_entry', { entryId: fx.entryId, text: 'x', idempotencyKey: 'p8a-c' }],
    ['flag_entry', { entryId: fx.entryId, reason: 'x', idempotencyKey: 'p8a-f' }],
    ['export_journal', { period: '2026-03' }],
    ['export_statements', { period: '2026-03', format: 'csv' }],
    ['export_vat', { period: '2026-03' }],
  ]) {
    const refused = fx.call(verb, input);
    assert.equal(refused.ok, false, `${verb} let the agent through`);
    assert.equal(refused.error, 'permission_denied', `${verb}: ${JSON.stringify(refused)}`);
  }
});

test('A25 P8: the treuhaender role holds the whole review-and-export mandate', () => {
  const fx = workspaceWhereAgentHolds('treuhaender', 'p8t');

  assert.equal(fx.call('flag_entry', { entryId: fx.entryId, reason: 'Beleg?', idempotencyKey: 'p8t-f' }).ok, true);
  assert.equal(fx.call('approve_entry', { entryId: fx.entryId, idempotencyKey: 'p8t-a' }).ok, true);
  assert.equal(fx.call('prepare_period', { period: '2026-03', idempotencyKey: 'p8t-p' }).ok, true);
  assert.equal(fx.call('export_journal', { period: '2026-03' }).ok, true);
  assert.equal(fx.call('export_statements', { period: '2026-03', format: 'csv' }).ok, true);
  // export_vat needs read_vat + export: treuhaender holds both, and the unconfigured-VAT rejection
  // it passes through is A07's, which proves the gate opened.
  const vat = fx.call('export_vat', { period: '2026-03' });
  assert.notEqual(vat.error, 'permission_denied');
});

test('A25 P8: the bookkeeper reads the coverage and is refused the sign-off', () => {
  const fx = workspaceWhereAgentHolds('bookkeeper', 'p8b');
  assert.equal(fx.call('review_status', { period: '2026-03' }).ok, true);
  const refused = fx.call('approve_entry', { entryId: fx.entryId, idempotencyKey: 'p8b-a' });
  assert.equal(refused.error, 'permission_denied');
});
