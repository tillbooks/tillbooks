/**
 * THE MIGRATION AREA'S HUMAN-ONLY CHECKS READ THE ONE GOVERNED-SEAT RULE (D156 follow-up).
 *
 * `actorIsHuman` compared the actor string with `agent` alone, so a SERVED agent member
 * (`member:<user_id>`, its `user` row of kind `agent`) read as human and recorded G20 sign-offs:
 * every kind, `go_nogo` and `source_cancellation` included, the acts the cutover's safety case rests
 * on. The same string test staged `go_productive` for the local agent only, and labelled a map's
 * provenance. All three now read `isGovernedSeat` (`src/core/access/capability.ts`), the rule the
 * dial, the trace and the statement-gap acknowledgement already read.
 *
 * Driven past the transport seam on purpose (`action.run`): these are the in-verb belts, the part that
 * still holds for an embedder that never meets the dial. HOW IT BITES: revert `actorIsHuman` to the
 * string comparison and the served agent member's sign-offs record (the first test names each kind).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { SIGNOFF_KINDS, actorIsHuman } from '../../dist/core/migration/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

/** Seat a served member of `kind` with the `owner` role and return its deps (resolved after accept). */
function servedMember(deps, workspaceId, email, kind) {
  const invite = human(deps, 'invite_member', { workspaceId, email, role: 'owner', kind, idempotencyKey: `inv-${email}` });
  assert.equal(invite.ok, true, JSON.stringify(invite));
  const served = () => {
    const id = resolveServedActor(deps.store, email);
    return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
  };
  assert.equal(getAction('accept_invite').run(served(), { token: invite.token }).ok, true);
  return served();
}

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Mandat GmbH', 'sa-ws');
  const bot = servedMember(deps, workspaceId, 'bot@mandat.example', 'agent');
  const person = servedMember(deps, workspaceId, 'treuhand@mandat.example', 'human');
  assert.match(bot.actor, /^member:/, 'premise: the served agent stamps member:<id>, not agent');
  return { deps, workspaceId, bot, person };
}

test('actorIsHuman: the governed seats and the system seat are not human; a served human member is', () => {
  const { deps, bot, person } = world();
  assert.equal(actorIsHuman(deps.store, 'agent'), false, 'the local agent');
  assert.equal(actorIsHuman(deps.store, bot.actor), false, 'a served agent member');
  assert.equal(actorIsHuman(deps.store, 'system'), false, 'the system seat');
  assert.equal(actorIsHuman(deps.store, ''), false);
  assert.equal(actorIsHuman(deps.store, undefined), false);
  assert.equal(actorIsHuman(deps.store, 'studio'), true, 'a person at the Studio');
  assert.equal(actorIsHuman(deps.store, person.actor), true, 'a served human member');
  deps.store.close();
});

test('implementation_signoff_record refuses a served agent member on every kind, and the local agent; a served human signs', () => {
  const { deps, workspaceId, bot, person } = world();
  const project = human(deps, 'implementation_project_create', {
    workspaceId,
    sourceSystem: 'bexio',
    cutoverDate: '2027-06-30',
    mwstMethod: 'effektiv',
    idempotencyKey: 'proj',
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  const projectId = project.projectId ?? project.project?.id;
  assert.equal(typeof projectId, 'string', JSON.stringify(project));
  const sign = (who, kind, key) =>
    getAction('implementation_signoff_record').run(who, { workspaceId, projectId, kind, evidenceRef: 'beleg', idempotencyKey: key });

  for (const kind of SIGNOFF_KINDS) {
    const viaVerb = sign(bot, kind, `bot-${kind}`);
    assert.equal(viaVerb.ok, false, `${kind}: ${JSON.stringify(viaVerb)}`);
    assert.equal(viaVerb.error, 'signoff_needs_human', `${kind}: a served agent member is not a person`);
    const viaSeam = handleRest('implementation_signoff_record', { workspaceId, projectId, kind, evidenceRef: 'beleg', idempotencyKey: `bot-rest-${kind}` }, bot).body;
    assert.equal(viaSeam.error, 'signoff_needs_human', `${kind}: refused over the transport too, never staged`);
    assert.equal(sign({ ...deps, actor: 'agent' }, kind, `agent-${kind}`).error, 'signoff_needs_human', `${kind}: the local agent`);
  }
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM implementation_signoff WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'no agent sign-off row was written',
  );
  const signed = sign(person, 'conversion_date', 'person-1');
  assert.equal(signed.ok, true, `a served human member signs: ${JSON.stringify(signed)}`);
  deps.store.close();
});

test('go_productive stages a served agent member without the confirming name, like the local agent', () => {
  const { deps, workspaceId, bot } = world();
  const plan = human(deps, 'migration_create_plan', { workspaceId, sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'plan' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const t = human(deps, 'migration_create_testmandant', { workspaceId, planId: plan.planId, idempotencyKey: 't' });
  assert.equal(t.ok, true, JSON.stringify(t));
  const res = getAction('go_productive').run(bot, { workspaceId, planId: plan.planId, confirmedName: 'nope', idempotencyKey: 'gp' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.staged, true, 'a served agent member is staged, not refused as if it were a person who mistyped');
  assert.equal(deps.store.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(t.workspaceId).kind, 'sandbox');
  deps.store.close();
});
