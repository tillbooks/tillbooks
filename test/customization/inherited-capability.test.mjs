/**
 * G00 is not a side door: a custom field on a record is exactly as hard to write as the record.
 *
 * THE CLAIM, AND WHY IT IS THE ONE WORTH TESTING HARDEST. G00 attaches typed data to journal entries,
 * payments and documents. If `set_field_value` carried a policy of its own, then whoever held
 * `manage_custom_fields` could annotate the money path regardless of whether they may touch it, and
 * every one of the sixty-two capabilities that later depends on G00 would inherit that hole. The
 * engine's answer is to resolve the capability THROUGH the OP3 registry
 * (`editCapabilityForKind` / `readCapabilityForKind`), so the gate is the owning capability's own.
 *
 * DRIVEN FROM `ENTITY_KINDS`, NEVER FROM A LIST HERE. Each case computes what the gate should be from
 * the registry row and then measures what the gate is, so a kind added next month is held to the same
 * rule with nobody editing this file. A hand-written expectation table would be the second
 * enumeration point the whole design exists to avoid.
 *
 * THE DECISIVE CASE IS THE ONE THAT LOOKS BACKWARDS. A role holding BOTH of G00's own capabilities
 * and nothing else can define a field on a journal entry and still cannot put a value on one. That is
 * the side door being closed, and it is the assertion that would fail first if `set_field_value` ever
 * grew a `manage_custom_fields` gate "for consistency".
 *
 * BOTH DOORS, EVERY TIME. MCP stdio and the REST twins each resolve an `ActionDef` and call
 * `action.run`, so a gate proven on one door is a gate proven on neither. REST answers 422 on a
 * refusal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { ENTITY_KINDS } from '../../dist/core/customization/index.js';
import { CAPABILITY_FOR_ACTION, isUngated } from '../../dist/core/access/index.js';
import { assertEveryKindHasAFactory, call, count, label, makeRecord, workspace } from './support.mjs';

const VALUES = 'SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ?';
const VIEWS = 'SELECT COUNT(*) AS n FROM saved_view WHERE workspace_id = ?';

/**
 * A workspace past the D50 provisioning flip in which `agent` holds a CUSTOM role of exactly
 * `capabilities`, with one record and one live field per registered kind already in place.
 *
 * The records and the fields are created BEFORE the narrowing, as `studio` the owner, so every
 * refusal below is a refusal about the value write and never about the setup.
 */
function narrowedWorkspace(capabilities, seed) {
  const { deps, workspaceId, accId } = workspace(seed, 'studio');

  const records = {};
  for (const entity of ENTITY_KINDS) {
    records[entity.kind] = makeRecord(deps, workspaceId, entity.kind, seed, accId);
    // A kind may declare a narrower admissible type slice on its registry row (E04's mail-thread
    // kind refuses free-form types by §6b); a bounded `select` whose one option IS the value the
    // suite later writes keeps this setup valid for every kind without weakening what it proves.
    const bounded = entity.fieldTypes !== undefined && !entity.fieldTypes.includes('text');
    const defined = call(deps, 'define_field', {
      workspaceId,
      entityKind: entity.kind,
      key: 'segment',
      labelI18n: label('Segment'),
      ...(bounded ? { type: 'select', options: ['Wert'] } : { type: 'text' }),
      idempotencyKey: `${seed}-${entity.kind}-def`,
    });
    assert.equal(defined.ok, true, `setup define_field failed on ${entity.kind}: ${JSON.stringify(defined)}`);
  }

  // The provisioning flip, then the narrowing, both through the product's own flow.
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: `${seed}@muster.ch`,
    role: 'viewer',
    idempotencyKey: `${seed}-invite`,
  });
  assert.equal(invited.ok, true, `invite_member failed: ${JSON.stringify(invited)}`);

  const role = call(deps, 'define_role', {
    workspaceId,
    name: `Rolle ${seed}`,
    capabilities,
    idempotencyKey: `${seed}-role`,
  });
  assert.equal(role.ok, true, `define_role failed: ${JSON.stringify(role)}`);

  const listed = call(deps, 'list_members', { workspaceId });
  const seat = listed.members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the flip did not seat the agent, so there is no row to narrow');
  const narrowed = call(deps, 'set_role', { workspaceId, memberId: seat.memberId, role: role.roleId });
  assert.equal(narrowed.ok, true, `set_role failed: ${JSON.stringify(narrowed)}`);

  deps.actor = 'agent';
  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.ok, true, JSON.stringify(me));
  assert.deepEqual([...me.capabilities].sort(), [...capabilities].sort(), 'the narrowing did not take');

  return { deps, workspaceId, accId, records };
}

/** Set a value on `kind` through the registry, MCP stdio and the REST twin. Returns the three. */
function setValueThroughEveryDoor(deps, workspaceId, kind, entityId, seed) {
  const input = {
    workspaceId,
    entityKind: kind,
    entityId,
    fieldKey: 'segment',
    value: 'Wert',
    idempotencyKey: `${seed}-${kind}-set`,
  };
  return {
    registry: call(deps, 'set_field_value', input),
    mcp: JSON.parse(callTool(deps, 'set_field_value', input).content[0].text),
    rest: handleRest('set_field_value', input, deps),
  };
}

test('G00: set_field_value resolves the OWNING capability, per kind, derived from the registry', () => {
  assertEveryKindHasAFactory();
  // The map is a function of the input for this verb, which is the mechanism under test.
  const rule = CAPABILITY_FOR_ACTION.set_field_value;
  assert.equal(typeof rule, 'function', 'set_field_value no longer resolves its capability from its input');
  for (const entity of ENTITY_KINDS) {
    assert.equal(
      rule({ entityKind: entity.kind }),
      entity.editCapability,
      `set_field_value on ${entity.kind} does not inherit that entity own edit capability`,
    );
  }
  // An unknown kind fails CLOSED to a capability no built-in role holds, so the pre-verb gate can
  // never be more permissive than the real answer would have been.
  assert.equal(rule({ entityKind: 'unicorn' }), 'manage_custom_fields');
});

test("G00: holding BOTH of G00's own capabilities does not let you write a value anywhere", () => {
  // The decisive case. `manage_custom_fields` defines the SHAPE of what a workspace records;
  // it must never be a grant over the DATA, or a custom field is a back door onto the money path.
  const capabilities = ['manage_custom_fields', 'manage_saved_views'];
  const { deps, workspaceId, records } = narrowedWorkspace(capabilities, 'ic-shape');

  for (const entity of ENTITY_KINDS) {
    const doors = setValueThroughEveryDoor(deps, workspaceId, entity.kind, records[entity.kind], 'ic-shape');
    assert.equal(doors.registry.ok, false, `manage_custom_fields alone wrote a value on ${entity.kind}`);
    assert.equal(doors.registry.error, 'permission_denied');
    assert.equal(doors.mcp.ok, false, `the MCP door wrote a value on ${entity.kind}`);
    assert.equal(doors.mcp.error, 'permission_denied');
    assert.equal(doors.rest.status, 422, `the REST door answered ${doors.rest.status} on ${entity.kind}`);
    assert.equal(doors.rest.body.error, 'permission_denied');
  }

  assert.equal(count(deps, VALUES, workspaceId), 0, 'a refused value write landed in the table anyway');

  // And the same role CAN still shape the schema, which is what makes the refusal above about the
  // DATA rather than about the role being empty.
  const defined = call(deps, 'define_field', {
    workspaceId,
    entityKind: 'journal_entry',
    key: 'beleg_nr',
    labelI18n: label('Belegnummer'),
    type: 'text',
    idempotencyKey: 'ic-shape-define',
  });
  assert.equal(defined.ok, true, `manage_custom_fields cannot define a field: ${JSON.stringify(defined)}`);
});

test('G00: a role holding ONE edit capability may write values on exactly the kinds it owns', () => {
  // The positive half, and the one that proves the refusals above are per kind rather than blanket.
  // `post` owns `journal_entry` and nothing else in the registry.
  const capabilities = ['post', 'read_books', 'read_master_data', 'read_sales', 'read_automations'];
  const { deps, workspaceId, records } = narrowedWorkspace(capabilities, 'ic-post');

  const owned = ENTITY_KINDS.filter((e) => capabilities.includes(e.editCapability)).map((e) => e.kind);
  assert.ok(owned.length > 0, 'the chosen capability owns no kind, so this test proves nothing');
  assert.ok(owned.length < ENTITY_KINDS.length, 'the chosen capability owns every kind, so there is no boundary');

  for (const entity of ENTITY_KINDS) {
    const doors = setValueThroughEveryDoor(deps, workspaceId, entity.kind, records[entity.kind], 'ic-post');
    const shouldPass = owned.includes(entity.kind);
    assert.equal(
      doors.registry.ok,
      shouldPass,
      `${entity.kind} needs ${entity.editCapability} and answered ${JSON.stringify(doors.registry)}`,
    );
    assert.equal(doors.rest.status, shouldPass ? 200 : 422, `the REST door disagreed on ${entity.kind}`);
    assert.equal(doors.mcp.ok, shouldPass, `the MCP door disagreed on ${entity.kind}`);
    if (!shouldPass) assert.equal(doors.registry.error, 'permission_denied');
  }

  // One value row per owned kind: the three doors share one idempotency key, so a passing kind writes
  // once however many times it is asked.
  assert.equal(count(deps, VALUES, workspaceId), owned.length);
});

test('G00: the READ verbs inherit the owning capability too, so a field is not a side door inward', () => {
  // A viewer holds every read domain but `read_members`, so the reads must all pass; a role holding
  // only G00's own capabilities holds no read domain at all, so they must all refuse.
  const { deps, workspaceId, records } = narrowedWorkspace(['manage_custom_fields', 'manage_saved_views'], 'ic-read');

  for (const entity of ENTITY_KINDS) {
    const listed = call(deps, 'list_field_defs', { workspaceId, entityKind: entity.kind });
    const values = call(deps, 'list_field_values', {
      workspaceId,
      entityKind: entity.kind,
      entityId: records[entity.kind],
    });
    // `manage_custom_fields` is exactly what the two reads must NOT resolve to for a registered kind.
    assert.equal(listed.ok, false, `list_field_defs on ${entity.kind} was answered on a G00 capability alone`);
    assert.equal(listed.error, 'permission_denied');
    assert.equal(values.ok, false, `list_field_values on ${entity.kind} was answered on a G00 capability alone`);
    assert.equal(values.error, 'permission_denied');

    const rest = handleRest('list_field_defs', { workspaceId, entityKind: entity.kind }, deps);
    assert.equal(rest.status, 422, `the REST door answered ${rest.status} on ${entity.kind}`);
  }
});

test('G00: saving ANY view requires the read access the exemption used to merely assume', () => {
  // THE SECOND FALSE EXEMPTION, pinned as a regression. `create_saved_view` was ungated on the
  // reasoning that "a private filter needs only the read access the caller already has", which
  // assumed an access nothing anywhere checked. Measured: an actor holding `capabilities: []`, refused
  // both `list_documents` and `list_saved_views`, wrote a `saved_view` row naming
  // `entity_kind='document'` and got `ok` back. The boundary now resolves
  // `readCapabilityForKind(input.entityKind)` unconditionally, which is the same lookup the LIST verb
  // uses, so "you may save a filter over what you may read" is enforced rather than asserted.
  assert.equal(
    typeof CAPABILITY_FOR_ACTION.create_saved_view,
    'function',
    'create_saved_view stopped resolving its capability from the entity kind',
  );
  assert.equal(
    isUngated(CAPABILITY_FOR_ACTION.create_saved_view),
    false,
    'create_saved_view is exempt again, on a reason nothing checks',
  );

  // Saving and LISTING must resolve the SAME capability for every kind, derived rather than listed.
  // If they could differ, "save a filter over a list you cannot open" becomes reachable again.
  for (const entity of ENTITY_KINDS) {
    assert.equal(
      CAPABILITY_FOR_ACTION.create_saved_view({ entityKind: entity.kind }),
      CAPABILITY_FOR_ACTION.list_saved_views({ entityKind: entity.kind }),
      `saving and listing views on ${entity.kind} resolve different capabilities`,
    );
  }

  // The two conditional ones stay at the boundary and assert inside the engine, because ownership is
  // state the boundary cannot see. `create_saved_view` could be moved out precisely because the
  // access question it got wrong is answerable from the INPUT alone.
  for (const name of ['update_saved_view', 'delete_saved_view']) {
    assert.equal(isUngated(CAPABILITY_FOR_ACTION[name]), true, `${name} is no longer ungated at the boundary`);
    assert.equal(
      CAPABILITY_FOR_ACTION[name].shape,
      'asserted_in_engine',
      `${name} claims an exemption shape that is not the ownership one`,
    );
  }

  // And the behaviour, from the actor the defect was measured with: nothing at all.
  const { deps, workspaceId } = narrowedWorkspace([], 'ic-none');

  const listed = call(deps, 'list_saved_views', { workspaceId, entityKind: 'document' });
  assert.equal(listed.ok, false, 'an actor holding nothing could read the view list');
  assert.equal(listed.error, 'permission_denied');

  const created = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'document',
    name: 'Heimlich',
    idempotencyKey: 'ic-none-1',
  });
  assert.equal(created.ok, false, 'an actor refused the list nonetheless wrote a view over it');
  assert.equal(created.error, 'permission_denied');

  const rest = handleRest(
    'create_saved_view',
    { workspaceId, entityKind: 'document', name: 'Heimlich', idempotencyKey: 'ic-none-2' },
    deps,
  );
  assert.equal(rest.status, 422, 'the REST door wrote a view the MCP door refused');
  assert.equal(rest.body.error, 'permission_denied');

  assert.equal(count(deps, VIEWS, workspaceId), 0, 'the refused view landed in the table anyway');
});

test('G00: publishing a SHARED view is gated on top of the read the save already needs', () => {
  // Both halves, because a test of only the refusal passes over a verb that refuses everything, and a
  // test of only the save passes over one that publishes freely. The read gate is now the floor and
  // `manage_saved_views` is the step above it.
  const { deps, workspaceId } = narrowedWorkspace(['post', 'read_books', 'read_master_data', 'read_sales', 'read_automations'], 'ic-view');

  // A PERSONAL view needs the read domain for that kind, which this role holds for `contact`
  // (`read_master_data`), and nothing more.
  const personal = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Meine Ansicht',
    idempotencyKey: 'ic-view-personal',
  });
  assert.equal(personal.ok, true, `a personal view was refused: ${JSON.stringify(personal)}`);
  assert.equal(personal.savedView.shared, false);

  // Publishing one to the whole workspace is an administrative act, on both doors.
  const shared = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Alle sehen das',
    shared: true,
    idempotencyKey: 'ic-view-shared',
  });
  assert.equal(shared.ok, false, 'a view was published without manage_saved_views');
  assert.equal(shared.error, 'permission_denied');

  const sharedRest = handleRest(
    'create_saved_view',
    { workspaceId, entityKind: 'contact', name: 'Alle sehen das', shared: true, idempotencyKey: 'ic-view-shared-rest' },
    deps,
  );
  assert.equal(sharedRest.status, 422);
  assert.equal(sharedRest.body.error, 'permission_denied');

  // And PUBLISHING an existing personal view is the same gated act, whichever direction it started in.
  const published = call(deps, 'update_saved_view', {
    workspaceId,
    viewId: personal.savedView.viewId,
    patch: { shared: true },
    idempotencyKey: 'ic-view-publish',
  });
  assert.equal(published.ok, false, 'a personal view was published without manage_saved_views');
  assert.equal(published.error, 'permission_denied');

  assert.equal(count(deps, VIEWS, workspaceId), 1, 'a refused publish wrote a view row');
  assert.equal(
    deps.store.db.prepare('SELECT owner_actor FROM saved_view WHERE id = ?').get(personal.savedView.viewId).owner_actor,
    'agent',
    'the refused publish un-owned the view anyway, which is what shared means in this schema',
  );
});
