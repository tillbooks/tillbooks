/**
 * D204 (A03 §11): the shared assertions a "no reason needed" test makes. An act that once refused a
 * blank reason must now succeed AND its trail must still say who, when, what and with which permission.
 * Who and when are read from the hash-chained `audit_log` row (A03) or the domain trail row the caller
 * names; the permission is the verb's fixed A24 rule in `CAPABILITY_FOR_ACTION`.
 */
import assert from 'node:assert/strict';

import { CAPABILITY_FOR_ACTION } from '../../dist/core/access/actionCapabilities.js';
import { isCapability } from '../../dist/core/access/capabilities.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The newest `audit_log` row for one entity and action, asserted to name an actor and a time. */
export function assertAuditRow(store, workspaceId, { entityKind, entityId, action, actor }) {
  const row = store.db
    .prepare(
      'SELECT actor, at FROM audit_log WHERE workspace_id = ? AND entity_kind = ? AND entity_id = ? AND action = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(workspaceId, entityKind, entityId, action);
  assert.ok(row !== undefined, `no audit_log row for ${entityKind}/${entityId} ${action}`);
  assertWhoWhen(row.actor, row.at, actor);
  return row;
}

/** A trail row's actor and time: an actor is named (the expected one when given) and the time is ISO. */
export function assertWhoWhen(actorValue, atValue, expectedActor) {
  assert.ok(typeof actorValue === 'string' && actorValue.length > 0, 'the trail names who acted');
  if (expectedActor !== undefined) assert.equal(actorValue, expectedActor, 'the trail names the acting person');
  assert.match(String(atValue), ISO, 'the trail carries when');
}

/** The verb's permission: a declared, real A24 capability (or every member of a capability list). */
export function assertPermission(verb, input = {}) {
  const declared = CAPABILITY_FOR_ACTION[verb];
  assert.ok(declared !== undefined, `${verb} declares no capability rule`);
  const rule = typeof declared === 'function' ? declared(input) : declared;
  const caps = Array.isArray(rule) ? rule : [rule];
  for (const c of caps) assert.ok(typeof c === 'string' && isCapability(c), `${verb} names a real capability, got ${JSON.stringify(c)}`);
  return caps;
}
