/**
 * G00 OP7, custom fields: typed, validated, per-workspace columns on any OP3-registered entity.
 *
 * NOTHING IN HERE SWITCHES ON AN ENTITY KIND. Every entity-specific fact comes from the OP3 registry
 * (`entities.ts`), so a capability that lands next month gets custom fields by adding a row there and
 * changing not one line of this file. That is the whole design: sixty-two specs reference G00, and a
 * framework that needed a case per consumer would be sixty-two edits pretending to be a framework.
 *
 * THE RESERVED-KEY LIST IS DERIVED, NEVER HAND-MAINTAINED. §6b demanded that a custom field can never
 * shadow a real column, "derived, not hand-maintained, from each entity's own §H-ENUM registry, so it
 * can never silently drift out of sync". The honest way to do that is to ask the database: the columns
 * of the entity's own base table, read from `PRAGMA table_info` at call time. A hand-written list would
 * be correct on the day it was written and wrong on the first migration, and nobody would notice
 * because the failure is silent (a custom field quietly shadowing `status` or `vat_code`).
 *
 * A `money`-TYPED FIELD IS DATA, NEVER A POSTING. This module imports nothing from `core/ledger` or
 * `core/payments` and must not: a custom field holding Rappen is a note about a record, and the moment
 * it could move a figure G00 would be a second posting path (P3). The import scan in §8 is what makes
 * that structural rather than a promise, and the absence of those imports here is the thing it scans.
 *
 * G00 WRITES NO AUDIT ROW, and that is the spec's own call rather than an oversight. §7 says
 * "§H-LEDGER/§H-AUDIT untouched" and §6b says defining a field or setting a value is CONFIGURATION,
 * not a business event worth recording or triggering on. An earlier draft of this module stamped
 * `custom_field_def` rows into the audit log; `app/src/surfaces/Periods/audit-vocabulary.test.ts`
 * caught it immediately, because every token the engine emits owes a translation in A03's Objekt
 * filter, which G00 does not own. Auditing a schema change is a defensible idea and a good follow-up;
 * it belongs to a change that owns the A03 vocabulary and both its catalogues, not to this one.
 *
 * A VALUE IS NEVER TRUNCATED AND NEVER DELETED. Custom data reaches the audit trail, the exports and
 * the backups, so every limit below is a REFUSAL: silently shortening something a person typed is a
 * data-loss bug wearing a validation costume. Archiving a def leaves every value in place and readable
 * through `listFieldValues`, which is why archive is a flag and there is no cascade in the schema.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { entityKindDef, tenantColumnOf } from './entities.js';
import { ENTITY_KIND_IDS } from './entities.js';

/**
 * The nine field types (§H-ENUM, fixed by §6b).
 *
 * A tenth type is a core capability addition (a new validator here, a new renderer in
 * `CustomFieldRow`, a new formatter in F01), not a per-workspace toggle. Single-sourcing it is what
 * lets every consumer trust "typed and validated" without re-checking.
 */
export const FIELD_TYPES: readonly string[] = [
  'text',
  'number',
  'money',
  'date',
  'bool',
  'select',
  'multiselect',
  'contact_ref',
  'entity_ref',
];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

/** Types whose `options` list is the value domain, and therefore may not be empty. */
const OPTION_TYPES: ReadonlySet<string> = new Set(['select', 'multiselect']);

/** The machine name shape. Lowercase snake, so it can be a column alias and a `cf:` suffix safely. */
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The limits, each a refusal rather than a truncation. See the module note. */
export const MAX_KEY_LENGTH = 64;
export const MAX_LABEL_LENGTH = 200;
export const MAX_OPTIONS = 100;
export const MAX_VALUE_BYTES = 8192;
export const MAX_FIELDS_PER_KIND = 200;

/** The locales a label must be legible in. `de-CH` is required: this product ships in German first. */
const REQUIRED_LABEL_LOCALES: readonly string[] = ['de-CH', 'en'];

interface FieldDefRow {
  id: string;
  workspace_id: string;
  entity_kind: string;
  key: string;
  label_i18n: string;
  type: string;
  options: string | null;
  required: number;
  default_value: string | null;
  sort: number;
  archived: number;
  draft: number;
  created_at: string;
  updated_at: string;
}

interface FieldValueRow {
  id: string;
  field_def_id: string;
  entity_kind: string;
  entity_id: string;
  value: string;
  updated_at: string;
}

export interface FieldDefView {
  fieldDefId: string;
  entityKind: string;
  key: string;
  labelI18n: Record<string, string>;
  type: string;
  options: string[] | null;
  required: boolean;
  defaultValue: unknown;
  sort: number;
  archived: boolean;
  draft: boolean;
}

function mapDef(row: FieldDefRow): FieldDefView {
  return {
    fieldDefId: row.id,
    entityKind: row.entity_kind,
    key: row.key,
    labelI18n: JSON.parse(row.label_i18n) as Record<string, string>,
    type: row.type,
    options: row.options === null ? null : (JSON.parse(row.options) as string[]),
    required: row.required === 1,
    defaultValue: row.default_value === null ? null : JSON.parse(row.default_value),
    sort: row.sort,
    archived: row.archived === 1,
    draft: row.draft === 1,
  };
}

/**
 * The columns of an entity's base table, lowercased, as the reserved-key set.
 *
 * Read live from SQLite rather than from a list, for the reason in the module note. Both the
 * snake_case column and its camelCase wire spelling are reserved, because the collision that matters
 * is at the READ edge (a `cf:` column merged next to a base column in a report or a saved view), and
 * there the two spellings are the same name.
 */
function reservedKeysFor(ctx: WorkspaceContext, table: string): ReadonlySet<string> {
  const rows = ctx.store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const reserved = new Set<string>();
  for (const row of rows) {
    const column = row.name.toLowerCase();
    reserved.add(column);
    reserved.add(column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()));
  }
  return reserved;
}

/** Validate a `label_i18n` object: present, both locales, each a non-empty string within the cap. */
function labelProblem(labelI18n: unknown): string | undefined {
  if (typeof labelI18n !== 'object' || labelI18n === null || Array.isArray(labelI18n)) {
    return 'invalid_label';
  }
  const labels = labelI18n as Record<string, unknown>;
  for (const locale of REQUIRED_LABEL_LOCALES) {
    const value = labels[locale];
    if (typeof value !== 'string' || value.trim().length === 0) return 'invalid_label';
    if (value.length > MAX_LABEL_LENGTH) return 'label_too_long';
  }
  return undefined;
}

/**
 * Is `value` a legal instance of `type`?
 *
 * `money` IS AN INTEGER RAPPEN COUNT AND NOTHING ELSE. A float here would be a rounding error stored
 * permanently, and the one thing this ledger never does is keep money in a type that cannot hold it.
 */
function valueFitsType(type: string, value: unknown, options: readonly string[] | null): boolean {
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'money':
      return typeof value === 'number' && Number.isInteger(value);
    case 'date':
      return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
    case 'bool':
      return typeof value === 'boolean';
    case 'select':
      return typeof value === 'string' && options !== null && options.includes(value);
    case 'multiselect':
      return (
        Array.isArray(value) &&
        options !== null &&
        value.every((v) => typeof v === 'string' && options.includes(v))
      );
    // A reference is an id string. G00 does NOT resolve it: the referenced record may legitimately be
    // archived, and a framework that refused a value because a related row moved would be a foreign
    // key wearing the wrong hat. The consumer resolves it at the read edge and degrades honestly (P9).
    case 'contact_ref':
    case 'entity_ref':
      return typeof value === 'string' && value.length > 0;
    default:
      return false;
  }
}

function readDefById(ctx: WorkspaceContext, fieldDefId: string): FieldDefRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM custom_field_def WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, fieldDefId) as FieldDefRow | undefined;
}

function readDefByKey(ctx: WorkspaceContext, entityKind: string, key: string): FieldDefRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM custom_field_def WHERE workspace_id = ? AND entity_kind = ? AND key = ?')
    .get(ctx.workspaceId, entityKind, key) as FieldDefRow | undefined;
}

export interface DefineFieldInput {
  entityKind: string;
  key: string;
  labelI18n: Record<string, string>;
  type: string;
  options?: string[];
  required?: boolean;
  defaultValue?: unknown;
  sort?: number;
  idempotencyKey?: string;
}

/**
 * Define a custom field, or patch an existing one.
 *
 * `entityKind` AND `type` ARE IMMUTABLE ONCE A VALUE EXISTS. Re-defining a live field's type would
 * leave every stored value a legal instance of a type nobody declared, which is silent corruption:
 * the values would read back, and read back wrong. Label, options, required, default and sort stay
 * editable, because none of them can invalidate what is already stored.
 *
 * P8, DRAFT BY DEFAULT FOR THE AGENT ACTOR. A field defined by `agent` (D13) lands `draft = 1` and is
 * invisible to the default `listFieldDefs` read until a human calls `confirmField`. The spec routed
 * this through A26's approval dial; A26 is not built, and a draft with no confirmer would be a field
 * that could never be used, so the confirmer is an explicit verb held by `manage_custom_fields`.
 */
export function defineField(ctx: WorkspaceContext, input: DefineFieldInput): Result {
  const run = (): Result => {
    const entity = entityKindDef(input.entityKind);
    if (entity === undefined) {
      return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
    }

    const key = typeof input.key === 'string' ? input.key : '';
    if (key.length > MAX_KEY_LENGTH) return err('key_too_long', { key, max: MAX_KEY_LENGTH });
    if (!KEY_RE.test(key)) return err('invalid_key', { key });
    if (reservedKeysFor(ctx, entity.table).has(key.toLowerCase())) {
      return err('reserved_key', { key, entityKind: entity.kind });
    }

    if (!FIELD_TYPE_SET.has(input.type)) {
      return err('invalid_type', { type: input.type, allowed: [...FIELD_TYPES] });
    }
    // A kind may declare a NARROWER admissible set on its registry row (`fieldTypes`, a per-kind
    // FACT exactly like `tenantColumn`, never a switch in here: the structural scan in
    // `test/customization/entity-registry.test.mjs` holds this file free of any kind literal). The
    // first consumer is E04's mail-thread kind, where a free-form type could smuggle
    // correspondence into the value table and defeat OP6's index-never-copy; the refusal names
    // the kind's own admissible list.
    if (entity.fieldTypes !== undefined && !entity.fieldTypes.includes(input.type)) {
      return err('type_not_allowed_for_kind', {
        type: input.type,
        entityKind: entity.kind,
        allowed: [...entity.fieldTypes],
      });
    }

    const labelIssue = labelProblem(input.labelI18n);
    if (labelIssue !== undefined) return err(labelIssue, { key });

    let options: string[] | null = null;
    if (OPTION_TYPES.has(input.type)) {
      const given = input.options;
      if (!Array.isArray(given) || given.length === 0) return err('options_required', { key });
      if (given.length > MAX_OPTIONS) return err('too_many_options', { key, max: MAX_OPTIONS });
      if (!given.every((o) => typeof o === 'string' && o.length > 0)) return err('invalid_options', { key });
      if (new Set(given).size !== given.length) return err('duplicate_option', { key });
      options = [...given];
    } else if (input.options !== undefined) {
      // Accepting and ignoring it would tell the caller their domain was recorded when it was not.
      return err('options_not_allowed', { key, type: input.type });
    }

    if (input.defaultValue !== undefined && input.defaultValue !== null) {
      if (!valueFitsType(input.type, input.defaultValue, options)) {
        return err('invalid_default', { key, type: input.type });
      }
    }

    const existing = readDefByKey(ctx, entity.kind, key);
    const now = ctx.clock.now();
    const labelJson = JSON.stringify(input.labelI18n);
    const optionsJson = options === null ? null : JSON.stringify(options);
    const defaultJson = input.defaultValue === undefined ? null : JSON.stringify(input.defaultValue);
    const required = input.required === true ? 1 : 0;
    const sort = Number.isInteger(input.sort) ? (input.sort as number) : 0;

    if (existing !== undefined) {
      if (existing.type !== input.type) {
        const valueCount = (
          ctx.store.db
            .prepare('SELECT COUNT(*) AS n FROM custom_field_value WHERE field_def_id = ?')
            .get(existing.id) as { n: number }
        ).n;
        if (valueCount > 0) {
          return err('type_immutable', { key, storedType: existing.type, values: valueCount });
        }
      }
      ctx.store.db
        .prepare(
          `UPDATE custom_field_def
             SET label_i18n = ?, type = ?, options = ?, required = ?, default_value = ?, sort = ?,
                 updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(labelJson, input.type, optionsJson, required, defaultJson, sort, now, ctx.workspaceId, existing.id);
      const updated = readDefById(ctx, existing.id) as FieldDefRow;
      return ok({ fieldDef: mapDef(updated), created: false });
    }

    const liveCount = (
      ctx.store.db
        .prepare(
          'SELECT COUNT(*) AS n FROM custom_field_def WHERE workspace_id = ? AND entity_kind = ? AND archived = 0',
        )
        .get(ctx.workspaceId, entity.kind) as { n: number }
    ).n;
    if (liveCount >= MAX_FIELDS_PER_KIND) {
      return err('too_many_fields', { entityKind: entity.kind, max: MAX_FIELDS_PER_KIND });
    }

    // P8. The actor IS the dial until A26 ships one: 'agent' is the D13 actor every MCP client that
    // is not the Studio resolves to, so an agent reshaping the schema stages the change and a human
    // releases it.
    const draft = ctx.actor === 'agent' ? 1 : 0;
    const id = ctx.ids.next('cfd');
    ctx.store.db
      .prepare(
        `INSERT INTO custom_field_def
           (id, workspace_id, entity_kind, key, label_i18n, type, options, required, default_value,
            sort, archived, draft, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        entity.kind,
        key,
        labelJson,
        input.type,
        optionsJson,
        required,
        defaultJson,
        sort,
        draft,
        now,
        now,
      );
    return ok({ fieldDef: mapDef(readDefById(ctx, id) as FieldDefRow), created: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'define_field', run);
  }
  return run();
}

/**
 * Release a P8 draft field so everyone can see it. The human half of draft-by-default.
 *
 * Idempotent by construction as well as by key: confirming a live field is a successful no-op, because
 * "make sure this field is live" is a state assertion and re-asserting it must not be an error.
 */
export function confirmField(
  ctx: WorkspaceContext,
  input: { fieldDefId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = readDefById(ctx, input.fieldDefId);
    if (row === undefined) return err('not_found', { fieldDefId: input.fieldDefId });
    if (row.draft === 0) return ok({ fieldDef: mapDef(row), confirmed: false });
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE custom_field_def SET draft = 0, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, ctx.workspaceId, row.id);
    return ok({ fieldDef: mapDef(readDefById(ctx, row.id) as FieldDefRow), confirmed: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'confirm_field', run);
  }
  return run();
}

/**
 * Archive a field. A FLAG, NEVER A DELETE, and every stored value survives untouched.
 *
 * The reference count comes back so the surface can warn ("Referenziert in 2 Ansichten") rather than
 * refuse: refusing would strand the operator, and destroying the references would destroy someone
 * else's saved view. Honest degradation at the consumer is the P9 answer.
 */
export function archiveField(
  ctx: WorkspaceContext,
  input: { fieldDefId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = readDefById(ctx, input.fieldDefId);
    if (row === undefined) return err('not_found', { fieldDefId: input.fieldDefId });

    const referencingViews = (
      ctx.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM saved_view
            WHERE workspace_id = ? AND entity_kind = ? AND columns LIKE ?`,
        )
        .get(ctx.workspaceId, row.entity_kind, `%"cf:${row.key}"%`) as { n: number }
    ).n;

    if (row.archived === 1) {
      return ok({ fieldDef: mapDef(row), archived: false, referencingViews });
    }
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE custom_field_def SET archived = 1, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, ctx.workspaceId, row.id);
    return ok({
      fieldDef: mapDef(readDefById(ctx, row.id) as FieldDefRow),
      archived: true,
      referencingViews,
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'archive_field', run);
  }
  return run();
}

/**
 * The defs for an entity kind (P5). The source every entity editor and every column picker calls.
 *
 * Drafts and archived defs are OPT-IN. A default read that included either would put a field nobody
 * approved, or a field somebody retired, onto every screen that renders this kind.
 */
export function listFieldDefs(
  ctx: WorkspaceContext,
  input: { entityKind: string; includeArchived?: boolean; includeDrafts?: boolean },
): Result {
  const entity = entityKindDef(input.entityKind);
  if (entity === undefined) {
    return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
  }
  const clauses = ['workspace_id = ?', 'entity_kind = ?'];
  if (input.includeArchived !== true) clauses.push('archived = 0');
  if (input.includeDrafts !== true) clauses.push('draft = 0');
  const rows = ctx.store.db
    .prepare(`SELECT * FROM custom_field_def WHERE ${clauses.join(' AND ')} ORDER BY sort, key`)
    .all(ctx.workspaceId, entity.kind) as FieldDefRow[];
  return ok({ entityKind: entity.kind, fieldDefs: rows.map(mapDef) });
}

/**
 * Set one custom value on one record.
 *
 * THIS VERB HOLDS NO POLICY OF ITS OWN. Its capability is the one the OWNING entity requires, resolved
 * through the OP3 registry at the registry boundary (`CAPABILITY_FOR_ACTION`), so a custom field on a
 * journal entry is exactly as hard to write as the journal entry. G00 never opens a side door around
 * another capability's RBAC (§4).
 *
 * A DRAFT OR ARCHIVED DEF REFUSES, and refusing loudly is the point: the GUI never renders an input
 * for either, so this path is agent-only, and accepting a value nobody can see would be a write that
 * looks like it worked.
 */
export function setFieldValue(
  ctx: WorkspaceContext,
  input: { entityKind: string; entityId: string; fieldKey: string; value: unknown; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const entity = entityKindDef(input.entityKind);
    if (entity === undefined) {
      return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
    }
    const def = readDefByKey(ctx, entity.kind, input.fieldKey);
    if (def === undefined) return err('not_found', { fieldKey: input.fieldKey, entityKind: entity.kind });
    if (def.archived === 1) return err('field_archived', { fieldKey: input.fieldKey });
    if (def.draft === 1) return err('field_draft', { fieldKey: input.fieldKey });

    // §H-TENANT. The record must exist IN THIS WORKSPACE: without the tenant clause a value could be
    // hung on another tenant's row id, and the value table would then leak across the boundary.
    // `tenantColumnOf` is `workspace_id` for every domain table; for the one self-tenant kind
    // (A23's roster row) it is the primary key itself, so the check degenerates to "the record IS
    // the current workspace", which is the boundary: no mandate annotates another from inside.
    const target = ctx.store.db
      .prepare(`SELECT 1 FROM ${entity.table} WHERE ${entity.idColumn} = ? AND ${tenantColumnOf(entity)} = ?`)
      .get(input.entityId, ctx.workspaceId);
    if (target === undefined) {
      return err('entity_not_found', { entityKind: entity.kind, entityId: input.entityId });
    }

    const options = def.options === null ? null : (JSON.parse(def.options) as string[]);
    if (input.value === null || input.value === undefined) {
      if (def.required === 1) return err('value_required', { fieldKey: def.key });
      ctx.store.db
        .prepare('DELETE FROM custom_field_value WHERE field_def_id = ? AND entity_id = ?')
        .run(def.id, input.entityId);
      return ok({ fieldKey: def.key, entityId: input.entityId, cleared: true });
    }
    if (!valueFitsType(def.type, input.value, options)) {
      return err('invalid_value', { fieldKey: def.key, type: def.type });
    }

    const json = JSON.stringify(input.value);
    if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
      return err('value_too_large', { fieldKey: def.key, max: MAX_VALUE_BYTES });
    }

    const now = ctx.clock.now();
    const existing = ctx.store.db
      .prepare('SELECT id FROM custom_field_value WHERE field_def_id = ? AND entity_id = ?')
      .get(def.id, input.entityId) as { id: string } | undefined;
    if (existing === undefined) {
      ctx.store.db
        .prepare(
          `INSERT INTO custom_field_value
             (id, workspace_id, field_def_id, entity_kind, entity_id, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('cfv'), ctx.workspaceId, def.id, entity.kind, input.entityId, json, now, now);
    } else {
      ctx.store.db
        .prepare('UPDATE custom_field_value SET value = ?, updated_at = ? WHERE id = ?')
        .run(json, now, existing.id);
    }
    return ok({ fieldKey: def.key, entityId: input.entityId, value: input.value, cleared: false });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'set_field_value', run);
  }
  return run();
}

/**
 * Every stored value on one record (P5), ARCHIVED DEFS INCLUDED and labelled.
 *
 * This is the direct read that makes archiving safe to offer. A def stops rendering as an input, and
 * its values remain readable here forever, which is the difference between retiring a field and
 * destroying what people put in it.
 *
 * It also exists so G00 needs no edit in any other capability's module: attaching custom values to
 * `get_contact`'s payload would mean G00 writing code inside A09, and a foundation that has to edit
 * its consumers is not a foundation.
 */
export function listFieldValues(
  ctx: WorkspaceContext,
  input: { entityKind: string; entityId: string },
): Result {
  const entity = entityKindDef(input.entityKind);
  if (entity === undefined) {
    return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT d.id AS def_id, d.key AS key, d.type AS type, d.archived AS archived, d.draft AS draft,
              d.label_i18n AS label_i18n, v.value AS value, v.updated_at AS updated_at
         FROM custom_field_value v
         JOIN custom_field_def d ON d.id = v.field_def_id
        WHERE v.workspace_id = ? AND v.entity_kind = ? AND v.entity_id = ?
        ORDER BY d.sort, d.key`,
    )
    .all(ctx.workspaceId, entity.kind, input.entityId) as {
    def_id: string;
    key: string;
    type: string;
    archived: number;
    draft: number;
    label_i18n: string;
    value: string;
    updated_at: string;
  }[];
  return ok({
    entityKind: entity.kind,
    entityId: input.entityId,
    values: rows.map((r) => ({
      fieldDefId: r.def_id,
      key: r.key,
      type: r.type,
      labelI18n: JSON.parse(r.label_i18n) as Record<string, string>,
      value: JSON.parse(r.value),
      archived: r.archived === 1,
      draft: r.draft === 1,
      updatedAt: r.updated_at,
    })),
  });
}

/** Exported for the value-shape guard and for any consumer that must validate before it writes. */
export function isValidFieldValue(
  type: string,
  value: unknown,
  options: readonly string[] | null,
): boolean {
  return valueFitsType(type, value, options);
}

export type { FieldValueRow };
