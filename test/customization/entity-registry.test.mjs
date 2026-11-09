/**
 * G00's central design claim, tested rather than restated: ONE row in `ENTITY_KINDS` is the whole
 * opt-in, and nothing in `fields.ts` or `views.ts` switches on an entity kind.
 *
 * WHY A PROSE CLAIM NEEDED A SUITE. Sixty-two specs reference G00. If the framework grows a case per
 * consumer it stops being a framework and becomes sixty-two edits pretending to be one, and that
 * decay is invisible: each individual `if (kind === 'payment')` looks reasonable on the day it lands.
 * So the claim is checked two ways, and both have to hold.
 *
 *   BEHAVIOURALLY. Every registered kind is driven through the full custom-field lifecycle (define,
 *   confirm, set, read) and the full saved-view lifecycle, using each capability's OWN creation verb
 *   to mint the record. `assertEveryKindHasAFactory` makes a kind added tomorrow redden this file
 *   until it is exercised, so the suite covers the registry rather than a snapshot of it.
 *
 *   STRUCTURALLY. The two modules are read off disk and checked for a quoted entity-kind literal.
 *   That is the check that catches the decay early, because the first branch is added long before it
 *   changes any behaviour a functional test would see. It matches a QUOTED literal rather than a
 *   substring on purpose: `contact_ref` is a legitimate field TYPE in `fields.ts` and a substring
 *   probe for `contact` would flag it, which is the probe over-matching and the code being right.
 *
 * THE RESERVED-KEY RULE IS CHECKED AGAINST THE DATABASE, NOT AGAINST A LIST. §6b asked for a derived
 * list "so it can never silently drift out of sync", and the engine answers `PRAGMA table_info` at
 * call time. This suite asks the same `PRAGMA` and requires every column it names to be refused, so a
 * migration that adds a column is covered on the day it lands with nobody editing anything.
 *
 * AND ARCHIVING DESTROYS NOTHING. There is no `ON DELETE CASCADE` anywhere in G00's schema and there
 * is not supposed to be; a test holds that, because the failure it prevents (a careless DELETE taking
 * every stored value in the workspace with it) is silent and total.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ENTITY_KINDS, ENTITY_KIND_IDS } from '../../dist/core/customization/index.js';
import {
  assertEveryKindHasAFactory,
  call,
  count,
  label,
  makeRecord,
  workspace,
} from './support.mjs';

const SRC = (name) => fileURLToPath(new URL(`../../src/core/customization/${name}`, import.meta.url));

test('G00: the registry is non-empty and every kind in it is exercised below', () => {
  assertEveryKindHasAFactory();
  // Every row carries the four facts the framework reads, and `editCapability` is never a G00
  // capability: a custom field must not be a side door around another capability's RBAC.
  for (const entity of ENTITY_KINDS) {
    assert.equal(typeof entity.kind, 'string');
    assert.equal(typeof entity.table, 'string');
    assert.equal(typeof entity.idColumn, 'string');
    assert.notEqual(
      entity.editCapability,
      'manage_custom_fields',
      `${entity.kind} inherits a G00 capability, which makes a custom field easier to write than the record`,
    );
    assert.notEqual(entity.editCapability, 'manage_saved_views');
  }
});

test('G00: nothing in fields.ts or views.ts switches on an entity kind', () => {
  // The structural half. A quoted literal, not a substring: see the module note.
  for (const file of ['fields.ts', 'views.ts']) {
    const source = readFileSync(SRC(file), 'utf8');
    const offenders = ENTITY_KIND_IDS.filter((kind) => new RegExp(`['"\`]${kind}['"\`]`).test(source));
    assert.deepEqual(
      offenders,
      [],
      `${file} names ${offenders.join(', ')} directly, so the framework has started growing a case per consumer`,
    );
  }
  // Non-vacuous: the same probe MUST find the kinds where they legitimately live, or it is matching
  // nothing anywhere and the assertion above is empty.
  const registry = readFileSync(SRC('entities.ts'), 'utf8');
  const found = ENTITY_KIND_IDS.filter((kind) => new RegExp(`['"\`]${kind}['"\`]`).test(registry));
  assert.deepEqual(found, [...ENTITY_KIND_IDS], 'the probe cannot find a kind literal even in the registry itself');
});

test('G00: define, confirm, set and read a field on EVERY registered kind', () => {
  // The behavioural half, and the one that would catch a kind whose table or id column is wrong: the
  // value write proves the record through `entityExists`, which reads the registry row's own SQL.
  assertEveryKindHasAFactory();
  const { deps, workspaceId, accId } = workspace('er-all');

  for (const entity of ENTITY_KINDS) {
    const kind = entity.kind;
    const entityId = makeRecord(deps, workspaceId, kind, 'er-all', accId);

    const defined = call(deps, 'define_field', {
      workspaceId,
      entityKind: kind,
      key: 'segment',
      labelI18n: label('Segment'),
      type: 'select',
      options: ['Gross', 'Klein'],
      idempotencyKey: `er-all-${kind}-def`,
    });
    assert.equal(defined.ok, true, `define_field refused ${kind}: ${JSON.stringify(defined)}`);
    assert.equal(defined.created, true);
    // The `studio` actor is a human, so the def is live rather than a P8 draft.
    assert.equal(defined.fieldDef.draft, false, `a studio-authored field on ${kind} landed as a draft`);

    const confirmed = call(deps, 'confirm_field', {
      workspaceId,
      fieldDefId: defined.fieldDef.fieldDefId,
      idempotencyKey: `er-all-${kind}-conf`,
    });
    assert.equal(confirmed.ok, true, `confirm_field refused ${kind}: ${JSON.stringify(confirmed)}`);
    // Confirming a live field is a successful no-op: "make sure this is live" is a state assertion.
    assert.equal(confirmed.confirmed, false);

    const set = call(deps, 'set_field_value', {
      workspaceId,
      entityKind: kind,
      entityId,
      fieldKey: 'segment',
      value: 'Gross',
      idempotencyKey: `er-all-${kind}-set`,
    });
    assert.equal(set.ok, true, `set_field_value refused ${kind}: ${JSON.stringify(set)}`);

    const read = call(deps, 'list_field_values', { workspaceId, entityKind: kind, entityId });
    assert.equal(read.ok, true, `list_field_values refused ${kind}: ${JSON.stringify(read)}`);
    assert.deepEqual(
      read.values.map((v) => [v.key, v.value, v.type, v.archived]),
      [['segment', 'Gross', 'select', false]],
      `the value did not round-trip on ${kind}`,
    );

    // And a saved view over the same kind, which is the other half of the one-row opt-in.
    const view = call(deps, 'create_saved_view', {
      workspaceId,
      entityKind: kind,
      name: 'Meine Ansicht',
      filters: { includeArchived: true },
      columns: ['cf:segment'],
      idempotencyKey: `er-all-${kind}-view`,
    });
    assert.equal(view.ok, true, `create_saved_view refused ${kind}: ${JSON.stringify(view)}`);
    const views = call(deps, 'list_saved_views', { workspaceId, entityKind: kind });
    assert.deepEqual(views.savedViews.map((v) => v.viewId), [view.savedView.viewId]);
  }

  // One def and one view per kind, and not one more: a framework that wrote a spare row somewhere
  // would still pass every per-kind assertion above.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM custom_field_def WHERE workspace_id = ?', workspaceId), ENTITY_KINDS.length);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ?', workspaceId), ENTITY_KINDS.length);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM saved_view WHERE workspace_id = ?', workspaceId), ENTITY_KINDS.length);
});

test('G00: an UNREGISTERED kind is refused by every verb that takes one, and names the real set', () => {
  const { deps, workspaceId } = workspace('er-unknown');
  const attempts = [
    ['define_field', { entityKind: 'unicorn', key: 'x', labelI18n: label('X'), type: 'text', idempotencyKey: 'er-u-1' }],
    ['list_field_defs', { entityKind: 'unicorn' }],
    ['set_field_value', { entityKind: 'unicorn', entityId: 'x', fieldKey: 'y', value: 'z', idempotencyKey: 'er-u-2' }],
    ['list_field_values', { entityKind: 'unicorn', entityId: 'x' }],
    ['create_saved_view', { entityKind: 'unicorn', name: 'X', idempotencyKey: 'er-u-3' }],
    ['list_saved_views', { entityKind: 'unicorn' }],
  ];
  for (const [name, input] of attempts) {
    const res = call(deps, name, { workspaceId, ...input });
    assert.equal(res.ok, false, `${name} accepted an unregistered kind`);
    assert.equal(res.error, 'unknown_entity_kind', `${name} answered ${res.error}`);
    assert.deepEqual(res.known, [...ENTITY_KIND_IDS], `${name} reported a stale set of known kinds`);
  }
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM custom_field_def WHERE workspace_id = ?', workspaceId), 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM saved_view WHERE workspace_id = ?', workspaceId), 0);
});

test('G00: the reserved-key list is DERIVED from the real columns, per kind, live', () => {
  // Asked of the same `PRAGMA table_info` the engine asks, so a migration that adds a column is
  // covered the day it lands. A hand-written list here would drift in exactly the way §6b forbids.
  const { deps, workspaceId } = workspace('er-reserved');

  for (const entity of ENTITY_KINDS) {
    const columns = deps.store.db.prepare(`PRAGMA table_info(${entity.table})`).all().map((r) => r.name);
    assert.ok(columns.length > 0, `PRAGMA returned nothing for ${entity.table}, so this loop proves nothing`);

    for (const column of columns) {
      const snake = column.toLowerCase();
      const camel = snake.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
      // Only the spellings a custom key could legally take: the shape rule is lowercase snake.
      if (!/^[a-z][a-z0-9_]*$/.test(snake)) continue;

      const res = call(deps, 'define_field', {
        workspaceId,
        entityKind: entity.kind,
        key: snake,
        labelI18n: label('Kollision'),
        type: 'text',
        idempotencyKey: `er-res-${entity.kind}-${snake}`,
      });
      assert.equal(res.ok, false, `${entity.kind}.${snake} shadows a real column and was accepted`);
      assert.equal(res.error, 'reserved_key');
      assert.equal(res.entityKind, entity.kind);

      // The camelCase spelling is reserved too, because the collision that matters is at the READ
      // edge, where a `cf:` column sits next to a base column and the two spellings are one name.
      if (camel !== snake) {
        const camelRes = call(deps, 'define_field', {
          workspaceId,
          entityKind: entity.kind,
          key: camel,
          labelI18n: label('Kollision'),
          type: 'text',
          idempotencyKey: `er-res-${entity.kind}-${camel}`,
        });
        // A camelCase key is refused by the SHAPE rule before the reserved list is consulted, so the
        // claim here is that it never lands, not which of the two guards caught it.
        assert.equal(camelRes.ok, false, `${entity.kind}.${camel} shadows a real column and was accepted`);
        assert.ok(
          camelRes.error === 'reserved_key' || camelRes.error === 'invalid_key',
          `expected reserved_key or invalid_key for ${camel}, got ${camelRes.error}`,
        );
      }
    }
  }

  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM custom_field_def WHERE workspace_id = ?', workspaceId),
    0,
    'a refused reserved key was stored anyway',
  );
});

// --- Archiving destroys nothing -----------------------------------------------------------------

test('G00: an ARCHIVED field keeps every stored value readable, and refuses a new one', () => {
  const { deps, workspaceId, accId } = workspace('er-archive');
  const entityId = makeRecord(deps, workspaceId, 'contact', 'er-archive', accId);

  const defined = call(deps, 'define_field', {
    workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: label('Segment'),
    type: 'text',
    idempotencyKey: 'er-arch-def',
  });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const fieldDefId = defined.fieldDef.fieldDefId;

  assert.equal(
    call(deps, 'set_field_value', {
      workspaceId,
      entityKind: 'contact',
      entityId,
      fieldKey: 'segment',
      value: 'Grosskunde',
      idempotencyKey: 'er-arch-set',
    }).ok,
    true,
  );

  const archived = call(deps, 'archive_field', { workspaceId, fieldDefId, idempotencyKey: 'er-arch-1' });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.archived, true);

  // THE VALUE SURVIVES. This is the difference between retiring a field and destroying what people
  // put in it, and it is asserted through the read verb AND on the row.
  const read = call(deps, 'list_field_values', { workspaceId, entityKind: 'contact', entityId });
  assert.equal(read.ok, true);
  assert.deepEqual(
    read.values.map((v) => [v.key, v.value, v.archived]),
    [['segment', 'Grosskunde', true]],
    'archiving a field destroyed or hid its stored values',
  );
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM custom_field_value WHERE field_def_id = ?', fieldDefId), 1);

  // And it stops being an INPUT, loudly: the GUI renders no field for it, so this path is agent-only
  // and a silent accept would be a write that looks like it worked.
  const refused = call(deps, 'set_field_value', {
    workspaceId,
    entityKind: 'contact',
    entityId,
    fieldKey: 'segment',
    value: 'Kleinkunde',
    idempotencyKey: 'er-arch-set-2',
  });
  assert.equal(refused.ok, false, 'an archived field accepted a new value');
  assert.equal(refused.error, 'field_archived');
  assert.equal(
    JSON.parse(deps.store.db.prepare('SELECT value FROM custom_field_value WHERE field_def_id = ?').get(fieldDefId).value),
    'Grosskunde',
    'the refused write changed the stored value anyway',
  );

  // The def itself is a flag, never a delete, so a historical value still resolves to a label.
  assert.deepEqual(
    deps.store.db.prepare('SELECT archived FROM custom_field_def WHERE id = ?').all(fieldDefId),
    [{ archived: 1 }],
  );
  // And it is gone from the default list, which is what stops it being offered.
  const listed = call(deps, 'list_field_defs', { workspaceId, entityKind: 'contact' });
  assert.deepEqual(listed.fieldDefs, []);
  const withArchived = call(deps, 'list_field_defs', { workspaceId, entityKind: 'contact', includeArchived: true });
  assert.deepEqual(withArchived.fieldDefs.map((d) => [d.key, d.archived]), [['segment', true]]);
});

test('G00 and G01: there is no ON DELETE CASCADE anywhere in either schema', () => {
  // A cascade would turn a future careless DELETE into silent data loss across every record in the
  // workspace. Read off `sqlite_master`, which is the DDL the database really holds rather than the
  // string the module exports.
  const { deps } = workspace('er-cascade');
  const tables = [
    'custom_field_def',
    'custom_field_value',
    'saved_view',
    'automation_rule',
    'automation_run',
  ];
  for (const table of tables) {
    const row = deps.store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.ok(row !== undefined, `${table} does not exist, so this assertion is vacuous`);
    assert.equal(/on\s+delete\s+cascade/i.test(row.sql), false, `${table} carries an ON DELETE CASCADE`);
    assert.ok(/REFERENCES/i.test(row.sql), `${table} has no foreign key at all, so nothing refuses a stray delete`);
  }

  // And the FK really refuses, rather than merely being declared: an archived def with values cannot
  // be deleted out from under them.
  const { deps: live, workspaceId, accId } = workspace('er-cascade-live');
  const entityId = makeRecord(live, workspaceId, 'contact', 'er-cascade', accId);
  const defined = call(live, 'define_field', {
    workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: label('Segment'),
    type: 'text',
    idempotencyKey: 'er-cascade-def',
  });
  assert.equal(defined.ok, true);
  assert.equal(
    call(live, 'set_field_value', {
      workspaceId,
      entityKind: 'contact',
      entityId,
      fieldKey: 'segment',
      value: 'Grosskunde',
      idempotencyKey: 'er-cascade-set',
    }).ok,
    true,
  );
  assert.throws(
    () => live.store.db.prepare('DELETE FROM custom_field_def WHERE id = ?').run(defined.fieldDef.fieldDefId),
    /FOREIGN KEY/i,
    'a def carrying values could be deleted, which would orphan every value it holds',
  );
  assert.equal(count(live, 'SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ?', workspaceId), 1);
});
