/**
 * D161.2: the agent cannot approve its own purchase requisition.
 *
 * The defect: `requisition_approve` checked only the status and the open task, so the agent seat
 * could raise a requisition, submit it and approve it itself, and the "who asked, who authorised"
 * trail the I00 spec promises named the same machine twice.
 *
 * The rule (I00 spec): segregation of requester and approver is "supported by role checks", and the
 * spec itself allows a requester who is a self-approver (US-I00.2), so a PERSON approving their own
 * request stays allowed (the owner of a small company often is both). What is refused is a GOVERNED
 * seat (the local agent, a served agent member, a plugin's call) approving a requisition it raised:
 * created, named as requester, or submitted. Refused with `self_approval`, writing nothing.
 *
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function world() {
  const deps = freshDeps(); // actor: 'agent'
  const { workspaceId } = mintWorkspace(deps);
  const as = (actor) => (name, input) => getAction(name).run({ ...deps, actor }, { workspaceId, ...input });
  const raise = (actor, key, extra = {}) => {
    const r = as(actor)('requisition_upsert', {
      neededBy: '2026-09-01',
      urgency: 'normal',
      lines: [{ description: 'Druckerpapier', qtyMilli: 2000, estimatedUnitCostRappen: 2500 }],
      idempotencyKey: `${key}-up`,
      ...extra,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.requisition.id;
  };
  const submit = (actor, id, key) => {
    const s = as(actor)('requisition_submit', { requisitionId: id, idempotencyKey: `${key}-sub` });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.requisition.status, 'pending_approval');
  };
  const status = (id) => deps.store.db.prepare('SELECT status FROM requisition WHERE id = ?').get(id).status;
  const events = (id) => deps.store.db.prepare("SELECT COUNT(*) AS n FROM requisition_approval_event WHERE requisition_id = ? AND decision = 'approved'").get(id).n;
  return { deps, as, raise, submit, status, events };
}

test('repro: the agent raises, submits and approves its own requisition: refused self_approval, nothing written', () => {
  const w = world();
  const id = w.raise('agent', 'a');
  w.submit('agent', id, 'a');
  const res = w.as('agent')('requisition_approve', { requisitionId: id, idempotencyKey: 'a-app' });
  assert.equal(res.ok, false, `the agent approved its own requisition: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'self_approval');
  assert.equal(w.status(id), 'pending_approval');
  assert.equal(w.events(id), 0);
  // A person approves it.
  const human = w.as('studio')('requisition_approve', { requisitionId: id, idempotencyKey: 'a-app-h' });
  assert.equal(human.ok, true, JSON.stringify(human));
  assert.equal(w.status(id), 'approved');
  w.deps.store.close();
});

test('the agent cannot launder its request through a person named as requester, or by submitting a person\'s draft', () => {
  const w = world();
  // Raised by the agent on a person's behalf.
  const onBehalf = w.raise('agent', 'b', { requesterId: 'studio' });
  w.submit('studio', onBehalf, 'b');
  assert.equal(w.as('agent')('requisition_approve', { requisitionId: onBehalf, idempotencyKey: 'b-app' }).error, 'self_approval');
  // A person's draft the agent submitted.
  const submitted = w.raise('studio', 'c');
  w.submit('agent', submitted, 'c');
  assert.equal(w.as('agent')('requisition_approve', { requisitionId: submitted, idempotencyKey: 'c-app' }).error, 'self_approval');
  // A person's draft that names the agent as requester.
  const named = w.raise('studio', 'd', { requesterId: 'agent' });
  w.submit('studio', named, 'd');
  assert.equal(w.as('agent')('requisition_approve', { requisitionId: named, idempotencyKey: 'd-app' }).error, 'self_approval');
  w.deps.store.close();
});

test('what stays allowed: the agent approves a person\'s request; a person approves their own (the spec\'s self-approver)', () => {
  const w = world();
  const persons = w.raise('studio', 'e');
  w.submit('studio', persons, 'e');
  assert.equal(w.as('agent')('requisition_approve', { requisitionId: persons, idempotencyKey: 'e-app' }).ok, true);
  const own = w.raise('studio', 'f');
  w.submit('studio', own, 'f');
  assert.equal(w.as('studio')('requisition_approve', { requisitionId: own, idempotencyKey: 'f-app' }).ok, true);
  w.deps.store.close();
});
