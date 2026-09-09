/**
 * §H-TENANT for G00: field defs, field values, saved views, and the entity registry itself.
 *
 * THE TRAP THIS SUITE IS BUILT AROUND. Two workspaces in TWO databases prove nothing at all: every
 * assertion below passes with the `workspace_id` predicate deleted from every query in the engine,
 * because the other tenant's rows are in a file the query could never have reached. So both
 * workspaces here are minted on ONE `ApiDeps`, sharing one store AND one id sequence, and the second
 * workspace is a real co-tenant rather than a second universe.
 *
 * G00's SHARPEST CASE IS `set_field_value` ON A FOREIGN RECORD ID. The value table denormalises
 * `entity_kind` and `entity_id` and never joins back to the base table on read, so a value hung on
 * another tenant's record id would be reachable from that tenant's `list_field_values` for ever. The
 * guard is one `AND workspace_id = ?` in the existence check, and the only thing that proves it is
 * there is counting the other tenant's values afterwards.
 *
 * AND THE INNER BOUNDARY, which §H-TENANT does not cover. A PERSONAL saved view belongs to its actor
 * and nobody else, not even an owner: it is a preference, not workspace data. That is a second
 * containment inside the first, and it is asserted here because the two failures look the same from
 * the outside (a view you should not see, on your screen).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ENTITY_KIND_IDS } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { call, count, label, makeRecord } from './support.mjs';

const DEFS = 'SELECT COUNT(*) AS n FROM custom_field_def WHERE workspace_id = ?';
const VALUES = 'SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ?';
const VIEWS = 'SELECT COUNT(*) AS n FROM saved_view WHERE workspace_id = ?';

/**
 * Two workspaces in ONE store, each with its own contact, its own `segment` field and one value.
 *
 * The SAME key in both is deliberate: `custom_field_def_key` is unique per (workspace, kind, key), so
 * a lost tenant predicate would either collapse the two defs or make the second insert fail outright,
 * and both are visible in the counts below.
 */
function twoTenants() {
  const deps = freshDeps();
  deps.actor = 'studio';

  const alpha = mintWorkspace(deps, 'Alpha GmbH', 'ct-alpha-ws');
  const beta = mintWorkspace(deps, 'Beta GmbH', 'ct-beta-ws');

  const seed = (ws, tag, value) => {
    const entityId = makeRecord(deps, ws.workspaceId, 'contact', `ct-${tag}`, ws.accId);
    const defined = call(deps, 'define_field', {
      workspaceId: ws.workspaceId,
      entityKind: 'contact',
      key: 'segment',
      labelI18n: label(`Segment ${tag}`),
      type: 'text',
      idempotencyKey: `ct-${tag}-def`,
    });
    assert.equal(defined.ok, true, `define_field failed for ${tag}: ${JSON.stringify(defined)}`);
    const set = call(deps, 'set_field_value', {
      workspaceId: ws.workspaceId,
      entityKind: 'contact',
      entityId,
      fieldKey: 'segment',
      value,
      idempotencyKey: `ct-${tag}-set`,
    });
    assert.equal(set.ok, true, `set_field_value failed for ${tag}: ${JSON.stringify(set)}`);
    return { ...ws, entityId, fieldDefId: defined.fieldDef.fieldDefId };
  };

  const a = seed(alpha, 'alpha', 'Alpha Grosskunde');
  const b = seed(beta, 'beta', 'Beta Kleinkunde');

  assert.equal(
    deps.store.db.prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM custom_field_def').get().n,
    2,
    'the two workspaces must be co-tenants of ONE store, or nothing below is a leak test',
  );
  return { deps, alpha: a, beta: b };
}

test('H-TENANT: list_field_defs answers one workspace, never the store', () => {
  const { deps, alpha, beta } = twoTenants();

  const inAlpha = call(deps, 'list_field_defs', { workspaceId: alpha.workspaceId, entityKind: 'contact' });
  assert.equal(inAlpha.ok, true, JSON.stringify(inAlpha));
  assert.deepEqual(
    inAlpha.fieldDefs.map((d) => [d.fieldDefId, d.labelI18n['de-CH']]),
    [[alpha.fieldDefId, 'Segment alpha']],
    "Alpha's field list carried Beta's def",
  );

  const inBeta = call(deps, 'list_field_defs', { workspaceId: beta.workspaceId, entityKind: 'contact' });
  assert.deepEqual(
    inBeta.fieldDefs.map((d) => [d.fieldDefId, d.labelI18n['de-CH']]),
    [[beta.fieldDefId, 'Segment beta']],
  );
});

test('H-TENANT: list_field_values answers one workspace, even for a record id that exists elsewhere', () => {
  const { deps, alpha, beta } = twoTenants();

  const own = call(deps, 'list_field_values', {
    workspaceId: alpha.workspaceId,
    entityKind: 'contact',
    entityId: alpha.entityId,
  });
  assert.deepEqual(own.values.map((v) => v.value), ['Alpha Grosskunde']);

  // Naming BETA's record from inside Alpha. The value row exists in the store, so only the tenant
  // clause on the read stands between the caller and another company's data.
  const across = call(deps, 'list_field_values', {
    workspaceId: alpha.workspaceId,
    entityKind: 'contact',
    entityId: beta.entityId,
  });
  assert.equal(across.ok, true, 'the read degrades to empty rather than erroring, which is the P9 answer');
  assert.deepEqual(across.values, [], "Alpha read Beta's custom field values by naming Beta's record id");
});

test("H-TENANT: set_field_value cannot hang a value on ANOTHER workspace's record", () => {
  // The sharp one. `custom_field_value` denormalises `entity_id` and never joins back on read, so a
  // value written here would be reachable from Beta's own reads for ever.
  const { deps, alpha, beta } = twoTenants();
  const betaBefore = count(deps, VALUES, beta.workspaceId);

  const res = call(deps, 'set_field_value', {
    workspaceId: alpha.workspaceId,
    entityKind: 'contact',
    entityId: beta.entityId,
    fieldKey: 'segment',
    value: 'Untergeschoben',
    idempotencyKey: 'ct-cross-set',
  });
  assert.equal(res.ok, false, "a value was hung on another workspace's record");
  assert.equal(res.error, 'entity_not_found');

  assert.equal(count(deps, VALUES, beta.workspaceId), betaBefore, "Alpha wrote a value row into Beta");
  assert.equal(count(deps, VALUES, alpha.workspaceId), 1, 'the refused write landed in Alpha under a foreign record id');
  // And Beta's own read is untouched, through the verb rather than the table.
  const inBeta = call(deps, 'list_field_values', {
    workspaceId: beta.workspaceId,
    entityKind: 'contact',
    entityId: beta.entityId,
  });
  assert.deepEqual(inBeta.values.map((v) => v.value), ['Beta Kleinkunde']);
});

test("H-TENANT: confirm_field and archive_field cannot reach another workspace's def", () => {
  const { deps, alpha, beta } = twoTenants();
  const betaRow = () =>
    deps.store.db.prepare('SELECT archived, draft FROM custom_field_def WHERE id = ?').get(beta.fieldDefId);
  const before = betaRow();

  for (const name of ['confirm_field', 'archive_field']) {
    const res = call(deps, name, {
      workspaceId: alpha.workspaceId,
      fieldDefId: beta.fieldDefId,
      idempotencyKey: `ct-cross-${name}`,
    });
    assert.equal(res.ok, false, `${name} accepted a cross-tenant fieldDefId`);
    assert.equal(res.error, 'not_found', `${name} answered ${res.error}`);
  }

  assert.deepEqual(betaRow(), before, "a verb issued in Alpha changed Beta's def");
  assert.equal(count(deps, DEFS, alpha.workspaceId), 1);
  assert.equal(count(deps, DEFS, beta.workspaceId), 1);
});

test("H-TENANT: no saved-view verb can read, edit or delete another workspace's view", () => {
  const { deps, alpha, beta } = twoTenants();
  const betaView = call(deps, 'create_saved_view', {
    workspaceId: beta.workspaceId,
    entityKind: 'contact',
    name: 'Beta Ansicht',
    filters: { query: 'Beta' },
    idempotencyKey: 'ct-beta-view',
  });
  assert.equal(betaView.ok, true, JSON.stringify(betaView));
  const viewId = betaView.savedView.viewId;
  const betaRow = () => deps.store.db.prepare('SELECT name, filters FROM saved_view WHERE id = ?').get(viewId);
  const before = betaRow();

  const listed = call(deps, 'list_saved_views', { workspaceId: alpha.workspaceId, entityKind: 'contact' });
  assert.deepEqual(listed.savedViews, [], "Alpha's view list carried Beta's view");

  const updated = call(deps, 'update_saved_view', {
    workspaceId: alpha.workspaceId,
    viewId,
    patch: { name: 'Übernommen' },
    idempotencyKey: 'ct-cross-view-update',
  });
  assert.equal(updated.ok, false);
  assert.equal(updated.error, 'not_found');

  const deleted = call(deps, 'delete_saved_view', {
    workspaceId: alpha.workspaceId,
    viewId,
    idempotencyKey: 'ct-cross-view-delete',
  });
  assert.equal(deleted.ok, false, "Alpha deleted Beta's saved view");
  assert.equal(deleted.error, 'not_found');

  assert.deepEqual(betaRow(), before, "a verb issued in Alpha changed Beta's view");
  assert.equal(count(deps, VIEWS, beta.workspaceId), 1);
  assert.equal(count(deps, VIEWS, alpha.workspaceId), 0);
});

test("H-TENANT: a saved view cannot be applied from another workspace, whichever list asks", () => {
  // `applySavedView` is the ONE seam every consuming list verb calls, so a leak there is a leak in
  // `list_documents`, `list_payments` and `list_automation_rules` at once. Driven across all three.
  const { deps, alpha, beta } = twoTenants();
  const betaView = call(deps, 'create_saved_view', {
    workspaceId: beta.workspaceId,
    entityKind: 'document',
    name: 'Beta Belege',
    filters: { type: 'invoice' },
    idempotencyKey: 'ct-beta-doc-view',
  });
  assert.equal(betaView.ok, true, JSON.stringify(betaView));

  const listed = call(deps, 'list_documents', {
    workspaceId: alpha.workspaceId,
    savedViewId: betaView.savedView.viewId,
  });
  assert.equal(listed.ok, false, "Alpha applied Beta's saved view to its own document list");
  assert.equal(listed.error, 'not_found');
});

test('G00: a PERSONAL saved view belongs to its actor and to nobody else, owner included', () => {
  // The inner boundary. Not §H-TENANT: both actors are in the same workspace, and the containment is
  // ownership rather than tenancy. Asserted because the two failures look identical from the outside.
  const deps = freshDeps();
  deps.actor = 'studio';
  const ws = mintWorkspace(deps, 'Anpassung GmbH', 'ct-own-ws');

  const mine = call(deps, 'create_saved_view', {
    workspaceId: ws.workspaceId,
    entityKind: 'contact',
    name: 'Meine Ansicht',
    idempotencyKey: 'ct-own-mine',
  });
  assert.equal(mine.ok, true, JSON.stringify(mine));
  assert.equal(mine.savedView.shared, false);
  assert.equal(mine.savedView.ownerActor, 'studio');

  deps.actor = 'agent';
  const listed = call(deps, 'list_saved_views', { workspaceId: ws.workspaceId, entityKind: 'contact' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.savedViews, [], "another actor's personal view is on this actor's list");

  const edited = call(deps, 'update_saved_view', {
    workspaceId: ws.workspaceId,
    viewId: mine.savedView.viewId,
    patch: { name: 'Fremd' },
    idempotencyKey: 'ct-own-edit',
  });
  assert.equal(edited.ok, false, "another actor edited a personal view");
  assert.equal(edited.error, 'not_owner');

  const removed = call(deps, 'delete_saved_view', {
    workspaceId: ws.workspaceId,
    viewId: mine.savedView.viewId,
    idempotencyKey: 'ct-own-delete',
  });
  assert.equal(removed.ok, false, "another actor deleted a personal view");
  assert.equal(removed.error, 'not_owner');

  assert.equal(count(deps, VIEWS, ws.workspaceId), 1);
  assert.equal(
    deps.store.db.prepare('SELECT name FROM saved_view WHERE id = ?').get(mine.savedView.viewId).name,
    'Meine Ansicht',
  );

  // And applying it is refused too, which is the seam a list verb would otherwise walk straight past.
  const applied = call(deps, 'list_documents', {
    workspaceId: ws.workspaceId,
    savedViewId: mine.savedView.viewId,
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.error, 'view_kind_mismatch', 'a contact view applied to a document list must say so');
});

test('H-TENANT: the entity registry itself is global, and every kind is refused across the boundary', () => {
  // The registry is CODE, so it is the same in both workspaces by construction. What must not be
  // shared is the rows keyed against it, and that is checked for every kind rather than for one.
  const { deps, alpha, beta } = twoTenants();

  for (const kind of ENTITY_KIND_IDS) {
    const inAlpha = call(deps, 'list_field_defs', { workspaceId: alpha.workspaceId, entityKind: kind });
    assert.equal(inAlpha.ok, true, `${kind} is registered in Alpha but list_field_defs refused it`);
    const inBeta = call(deps, 'list_field_defs', { workspaceId: beta.workspaceId, entityKind: kind });
    assert.equal(inBeta.ok, true, `${kind} is registered in Beta but list_field_defs refused it`);

    const alphaIds = inAlpha.fieldDefs.map((d) => d.fieldDefId);
    const betaIds = inBeta.fieldDefs.map((d) => d.fieldDefId);
    assert.deepEqual(
      alphaIds.filter((id) => betaIds.includes(id)),
      [],
      `a def on ${kind} is visible in both workspaces`,
    );
  }
});
