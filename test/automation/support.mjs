/**
 * Shared fixture for the G01 suites.
 *
 * NOT A `.test.mjs`, so the one-level-deep glob `npm test` runs does not pick it up as a suite. That
 * is the precedent `test/api/support.mjs` and `test/vat/support.mjs` already set. (The glob itself is
 * not written out here: it ends in a star-slash, which closes a block comment, and it did.)
 *
 * WHY THE PROVISIONING FLIP IS IN HERE AND NOT COPIED INTO FIVE FILES. Every G01 permission claim
 * needs a workspace that is past the D50 flip with a NAMED role on a NAMED actor, and getting that
 * wrong is silent: an unprovisioned workspace grants everything to everyone, so a permission test
 * written against one measures the ungated default and reports it as policy. `workspaceWhereActorHolds`
 * is the single flow, taken from the product (`invite_member` seats every D13 actor, `set_role`
 * narrows the seat), so a change to that flow reddens one fixture rather than leaving five suites
 * asserting against a world the engine no longer produces.
 */

import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** Run a verb through the shared registry, which is the same door both adapters go through. */
export const call = (deps, name, input) => getAction(name).run(deps, input);

/** A scalar row count. Every idempotency claim in these suites is one of these, never a Result field. */
export const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

/**
 * The run log as plain rows, oldest first: what fired, on which occurrence, and how it ended.
 *
 * `redeliveries` is selected because a refused claim is now a durable fact rather than an absence
 * (G3). A helper that omitted the column would let a test read `undefined` and compare it happily
 * against nothing, which is how a counter nobody increments passes for a counter that works.
 */
export function runRows(deps, workspaceId) {
  return deps.store.db
    .prepare(
      `SELECT rule_id, trigger_event, event_ref, status, error_code, action_tool, actor, redeliveries
         FROM automation_run WHERE workspace_id = ? ORDER BY started_at, id`,
    )
    .all(workspaceId);
}

/** A fresh workspace on its own store, claimed by `actor`. */
export function workspace(seed, actor = 'studio') {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId, accId } = mintWorkspace(deps, 'Automat GmbH', `${seed}-ws`);
  return { deps, workspaceId, accId };
}

/**
 * Define a rule and return its id, failing loudly rather than handing back an undefined id.
 *
 * A helper that returned `undefined` on a refused save would make every later assertion in the test
 * an assertion about nothing, which is how a suite goes green while proving zero.
 */
export function defineRule(deps, workspaceId, spec, idempotencyKey) {
  const res = call(deps, 'create_automation_rule', {
    workspaceId,
    name: spec.name,
    trigger: { event: spec.event },
    action: { tool: spec.tool, inputTemplate: spec.template ?? {} },
    ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
    ...(spec.enabled !== undefined ? { enabled: spec.enabled } : {}),
    idempotencyKey,
  });
  assert.equal(res.ok, true, `create_automation_rule refused: ${JSON.stringify(res)}`);
  return res.rule.ruleId;
}

/** A balanced two-line posting template, as a rule's `inputTemplate`. */
export function postTemplate(accId, amount = 2500, date = '2026-03-01') {
  return {
    date,
    source: 'manual',
    lines: [
      { account: accId('6500'), debit: amount },
      { account: accId('1000'), credit: amount },
    ],
  };
}

/**
 * A workspace past the D50 provisioning flip in which `actor` holds `role`.
 *
 * The flip is `invite_member`: it seats every D13 actor as an accepted owner and writes the invitee's
 * pending row. Narrowing a seat is therefore `set_role` on the row the flip already wrote, which is
 * US-A24.5 after D50 and the only route left (a seated actor answers `actor_already_member` to
 * `accept_invite`). Nothing here writes a row by hand.
 */
export function workspaceWhereActorHolds(role, seed, actor = 'agent') {
  const { deps, workspaceId, accId } = workspace(seed, 'studio');

  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: `${seed}@muster.ch`,
    role,
    idempotencyKey: `${seed}-invite`,
  });
  assert.equal(invited.ok, true, `invite_member failed: ${JSON.stringify(invited)}`);

  const listed = call(deps, 'list_members', { workspaceId });
  assert.equal(listed.ok, true, `list_members failed: ${JSON.stringify(listed)}`);
  const seat = listed.members.find((m) => m.actorId === actor);
  assert.ok(seat !== undefined, `the flip did not seat ${actor}, so there is no row to narrow`);

  const narrowed = call(deps, 'set_role', { workspaceId, memberId: seat.memberId, role });
  assert.equal(narrowed.ok, true, `set_role failed: ${JSON.stringify(narrowed)}`);

  return { deps, workspaceId, accId, memberId: seat.memberId };
}
