/**
 * §H-IDEMPOTENT for G00's seven write verbs, asserted on ROWS.
 *
 * WHY NOT ON THE RETURNED RESULT. `rememberIdempotent` replays a stored answer, so a matching id
 * proves the RECEIPT was replayed and says nothing about what the body did on the way there. A verb
 * that returns the same id twice while writing twice is exactly the defect this phrasing exists to
 * catch, and it is invisible to a return-value assertion by construction. Every claim below is a count
 * of rows in the table the verb writes, named, so the failure message is one a person can act on.
 *
 * THE UPSERT VERBS ARE THE INTERESTING ONES. `define_field` patches an existing key rather than
 * refusing it, and `set_field_value` updates the one row per (def, record) that the
 * `custom_field_value_one` UNIQUE index allows. For both, the replay is not the only risk: a
 * genuinely NEW request naming the same key must ALSO leave one row, or the index is doing work the
 * code believes it is doing itself. Both shapes are driven here.
 *
 * AND `set_field_value` WITH A NULL IS A DELETE, which makes its idempotency claim the opposite shape:
 * the second call must find nothing to delete and settle rather than fail. Counted, because "settled"
 * and "deleted somebody else's row" look identical from the outside.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { call, count, label, makeRecord, workspace } from './support.mjs';

const DEFS = 'SELECT COUNT(*) AS n FROM custom_field_def WHERE workspace_id = ?';
const VALUES = 'SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ?';
const VIEWS = 'SELECT COUNT(*) AS n FROM saved_view WHERE workspace_id = ?';

/** A workspace with one contact and one live text field on `contact`. */
function withField(seed, type = 'text', extra = {}) {
  const { deps, workspaceId, accId } = workspace(seed);
  const entityId = makeRecord(deps, workspaceId, 'contact', seed, accId);
  const defined = call(deps, 'define_field', {
    workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: label('Segment'),
    type,
    ...extra,
    idempotencyKey: `${seed}-def`,
  });
  assert.equal(defined.ok, true, `define_field failed: ${JSON.stringify(defined)}`);
  return { deps, workspaceId, accId, entityId, fieldDefId: defined.fieldDef.fieldDefId };
}

test('H-IDEMPOTENT: define_field twice on one key writes ONE def', () => {
  const { deps, workspaceId, accId } = workspace('ci-define');
  makeRecord(deps, workspaceId, 'contact', 'ci-define', accId);
  const input = {
    workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: label('Segment'),
    type: 'text',
    idempotencyKey: 'ci-define-1',
  };

  const first = call(deps, 'define_field', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.created, true);
  const second = call(deps, 'define_field', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.fieldDef.fieldDefId, first.fieldDef.fieldDefId);

  assert.equal(count(deps, DEFS, workspaceId), 1, 'the replay minted a SECOND def under a new id');
});

test('H-IDEMPOTENT: a genuinely NEW define_field on the same key PATCHES the one row', () => {
  // Not a replay: a different key, a different request. `define_field` is an upsert on
  // (workspace, entityKind, key), so the claim is that a second request edits rather than appends.
  const { deps, workspaceId, accId } = workspace('ci-patch');
  makeRecord(deps, workspaceId, 'contact', 'ci-patch', accId);
  const base = { workspaceId, entityKind: 'contact', key: 'segment', type: 'text' };

  const first = call(deps, 'define_field', { ...base, labelI18n: label('Segment'), idempotencyKey: 'ci-patch-1' });
  assert.equal(first.ok, true, JSON.stringify(first));

  const patched = call(deps, 'define_field', {
    ...base,
    labelI18n: label('Kundensegment'),
    required: true,
    sort: 5,
    idempotencyKey: 'ci-patch-2',
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.equal(patched.created, false, 'the second request minted a new def instead of patching');
  assert.equal(patched.fieldDef.fieldDefId, first.fieldDef.fieldDefId);

  const rows = deps.store.db.prepare('SELECT label_i18n, required, sort FROM custom_field_def WHERE workspace_id = ?').all(workspaceId);
  assert.equal(rows.length, 1, 'two defs now share one key, so the UNIQUE index is the only thing holding');
  assert.equal(JSON.parse(rows[0].label_i18n)['de-CH'], 'Kundensegment');
  assert.deepEqual([rows[0].required, rows[0].sort], [1, 5]);
});

test('H-IDEMPOTENT: confirm_field twice releases one draft once', () => {
  // The AGENT actor is what makes a def a draft (P8), so the fixture uses the real mechanism.
  const { deps, workspaceId, accId } = workspace('ci-confirm', 'agent');
  makeRecord(deps, workspaceId, 'contact', 'ci-confirm', accId);
  const defined = call(deps, 'define_field', {
    workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: label('Segment'),
    type: 'text',
    idempotencyKey: 'ci-confirm-def',
  });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  assert.equal(defined.fieldDef.draft, true, 'an agent-authored def did not land as a draft, so P8 is not being tested');

  const input = { workspaceId, fieldDefId: defined.fieldDef.fieldDefId, idempotencyKey: 'ci-confirm-1' };
  const first = call(deps, 'confirm_field', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.confirmed, true);
  const second = call(deps, 'confirm_field', input);
  assert.equal(second.ok, true, 'a replayed confirm must settle, not reject');

  assert.deepEqual(
    deps.store.db.prepare('SELECT draft FROM custom_field_def WHERE id = ?').all(defined.fieldDef.fieldDefId),
    [{ draft: 0 }],
  );
  assert.equal(count(deps, DEFS, workspaceId), 1);
});

test('H-IDEMPOTENT: archive_field twice leaves the def archived once, and never deletes it', () => {
  const { deps, workspaceId, fieldDefId } = withField('ci-archive');

  const input = { workspaceId, fieldDefId, idempotencyKey: 'ci-archive-1' };
  const first = call(deps, 'archive_field', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.archived, true);
  const second = call(deps, 'archive_field', input);
  assert.equal(second.ok, true, JSON.stringify(second));

  assert.deepEqual(
    deps.store.db.prepare('SELECT archived, key FROM custom_field_def WHERE id = ?').all(fieldDefId),
    [{ archived: 1, key: 'segment' }],
    'archive is a soft flag on ONE row and never a delete',
  );
  assert.equal(count(deps, DEFS, workspaceId), 1);
});

test('H-IDEMPOTENT: set_field_value twice writes ONE value row, and a second request updates it', () => {
  const { deps, workspaceId, entityId, fieldDefId } = withField('ci-value');
  const input = {
    workspaceId,
    entityKind: 'contact',
    entityId,
    fieldKey: 'segment',
    value: 'Grosskunde',
    idempotencyKey: 'ci-value-1',
  };

  assert.equal(call(deps, 'set_field_value', input).ok, true);
  assert.equal(call(deps, 'set_field_value', input).ok, true);
  assert.equal(count(deps, VALUES, workspaceId), 1, 'the replay wrote a SECOND value row for one field');

  // A genuinely new request on the same (def, record) is an UPDATE, not an append.
  const changed = call(deps, 'set_field_value', { ...input, value: 'Kleinkunde', idempotencyKey: 'ci-value-2' });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const rows = deps.store.db.prepare('SELECT value FROM custom_field_value WHERE field_def_id = ?').all(fieldDefId);
  assert.equal(rows.length, 1, 'two values now exist for one field on one record');
  assert.equal(JSON.parse(rows[0].value), 'Kleinkunde');
});

test('H-IDEMPOTENT: clearing a value twice deletes one row and settles the second time', () => {
  // The opposite shape: the second call finds nothing to delete. "Settled" and "deleted something
  // else" look identical from the outside, so a second record's value is in the store as the control.
  const { deps, workspaceId, accId, entityId } = withField('ci-clear');
  const otherId = makeRecord(deps, workspaceId, 'contact', 'ci-clear-other', accId);

  for (const [id, key] of [[entityId, 'ci-clear-a'], [otherId, 'ci-clear-b']]) {
    assert.equal(
      call(deps, 'set_field_value', {
        workspaceId,
        entityKind: 'contact',
        entityId: id,
        fieldKey: 'segment',
        value: 'Grosskunde',
        idempotencyKey: key,
      }).ok,
      true,
    );
  }
  assert.equal(count(deps, VALUES, workspaceId), 2);

  const clear = { workspaceId, entityKind: 'contact', entityId, fieldKey: 'segment', value: null };
  const first = call(deps, 'set_field_value', { ...clear, idempotencyKey: 'ci-clear-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.cleared, true);
  assert.equal(count(deps, VALUES, workspaceId), 1);

  const second = call(deps, 'set_field_value', { ...clear, idempotencyKey: 'ci-clear-2' });
  assert.equal(second.ok, true, 'a repeated clear must settle, not reject');
  assert.equal(count(deps, VALUES, workspaceId), 1, 'the repeated clear removed the OTHER record value');
});

test('H-IDEMPOTENT: create_saved_view twice on one key writes ONE view', () => {
  const { deps, workspaceId } = workspace('ci-view');
  const input = {
    workspaceId,
    entityKind: 'contact',
    name: 'Grosskunden',
    filters: { query: 'AG' },
    columns: ['name'],
    idempotencyKey: 'ci-view-1',
  };

  const first = call(deps, 'create_saved_view', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = call(deps, 'create_saved_view', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.savedView.viewId, first.savedView.viewId);

  assert.equal(count(deps, VIEWS, workspaceId), 1, 'the replay minted a SECOND view under a new id');
});

test('H-IDEMPOTENT: update_saved_view twice leaves ONE row with ONE shape, and one default', () => {
  const { deps, workspaceId } = workspace('ci-view-update');
  const created = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Vorher',
    idempotencyKey: 'ci-vu-create',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const other = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Andere',
    isDefault: true,
    idempotencyKey: 'ci-vu-other',
  });
  assert.equal(other.ok, true, JSON.stringify(other));

  const input = {
    workspaceId,
    viewId: created.savedView.viewId,
    patch: { name: 'Nachher', isDefault: true },
    idempotencyKey: 'ci-vu-1',
  };
  assert.equal(call(deps, 'update_saved_view', input).ok, true);
  assert.equal(call(deps, 'update_saved_view', input).ok, true);

  assert.equal(count(deps, VIEWS, workspaceId), 2, 'the replay appended a view');
  // At most ONE default per (actor, kind), because two would make "which view opens" a race.
  assert.deepEqual(
    deps.store.db
      .prepare('SELECT name, is_default FROM saved_view WHERE workspace_id = ? ORDER BY name')
      .all(workspaceId),
    [
      { name: 'Andere', is_default: 0 },
      { name: 'Nachher', is_default: 1 },
    ],
  );
});

test('H-IDEMPOTENT: delete_saved_view twice removes one view and settles the second time', () => {
  const { deps, workspaceId } = workspace('ci-view-delete');
  const created = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Weg damit',
    idempotencyKey: 'ci-vd-create',
  });
  const kept = call(deps, 'create_saved_view', {
    workspaceId,
    entityKind: 'contact',
    name: 'Bleibt',
    idempotencyKey: 'ci-vd-kept',
  });
  assert.equal(kept.ok, true);
  assert.equal(count(deps, VIEWS, workspaceId), 2);

  const input = { workspaceId, viewId: created.savedView.viewId, idempotencyKey: 'ci-vd-1' };
  const first = call(deps, 'delete_saved_view', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(count(deps, VIEWS, workspaceId), 1);

  const second = call(deps, 'delete_saved_view', input);
  assert.equal(second.ok, true, 'a replayed delete must settle on its receipt, not reject');
  assert.equal(count(deps, VIEWS, workspaceId), 1, 'the replayed delete removed the OTHER view');
  assert.deepEqual(
    deps.store.db.prepare('SELECT name FROM saved_view WHERE workspace_id = ?').all(workspaceId),
    [{ name: 'Bleibt' }],
  );
});

test('H-IDEMPOTENT: the SAME key delivered to the two different doors still writes once', () => {
  const { deps, workspaceId, accId } = workspace('ci-doors');
  makeRecord(deps, workspaceId, 'contact', 'ci-doors', accId);
  const input = {
    workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: label('Segment'),
    type: 'text',
    idempotencyKey: 'ci-doors-1',
  };

  const viaMcp = JSON.parse(callTool(deps, 'define_field', input).content[0].text);
  assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
  const viaRest = handleRest('define_field', input, deps);
  assert.equal(viaRest.status, 200);
  assert.equal(viaRest.body.fieldDef.fieldDefId, viaMcp.fieldDef.fieldDefId, 'the REST retry minted a new def');

  assert.equal(count(deps, DEFS, workspaceId), 1);
});
