/**
 * G00's ten verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent).
 *
 * Seven writes and three reads. The four that four shipped capabilities have been waiting on,
 * `define_field`, `set_field_value`, `create_saved_view` and `list_saved_views`, sat in
 * `PENDING_TOOLS` in `test/specs/spec-code-drift.test.mjs` while A09, A10, A11 and A14 named them in
 * their own §5 tables. Registering them here is what turns those four spec claims from a promise into
 * a checked fact, and the pending list shrinks in the same commit.
 *
 * As with `fx-actions.ts`, `support-actions.ts` and `permission-actions.ts`, the helpers arrive as a
 * parameter rather than an import, so the module graph stays acyclic: `registry.ts` imports this file
 * and this file must not import it back.
 *
 * THE `value` FIELD ON `set_field_value` IS DELIBERATELY UNTYPED IN THE SCHEMA. Its legal shape is
 * whatever the field's own `type` says, which is a row in the database and not something a static
 * JSON Schema can express. Declaring it `string` would make the boundary type check in `registry.ts`
 * reject every legitimate `bool`, `number` and `multiselect` value before the engine ever saw it, so
 * the schema stays open and `fields.ts` is the single validator. That is the same division every
 * other verb uses: the schema catches shape, the engine catches meaning.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  archiveField,
  confirmField,
  createSavedView,
  defineField,
  deleteSavedView,
  listFieldDefs,
  listFieldValues,
  listSavedViews,
  setFieldValue,
  updateSavedView,
} from '../core/customization/index.js';

export interface CustomizationActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
  INT: { readonly type: 'integer' };
}

/** The G00 verbs, in append order. */
export function customizationActions(h: CustomizationActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL, INT } = h;
  const OBJ = { type: 'object' } as const;
  // A custom value's legal shape is whatever its field's `type` row says, which no static schema can
  // express. `anyOf` declares the union the conformance gate requires while leaving the boundary type
  // check in `registry.ts` with nothing to reject (it reads `.type`, which is absent here), so
  // `fields.ts` stays the single validator: the schema catches shape, the engine catches meaning.
  const ANY_VALUE = {
    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array' }],
  } as const;
  const STR_LIST = { type: 'array', items: STR } as const;
  const ANY_LIST = { type: 'array' } as const;

  return [
    ctxAction(
      'define_field',
      'write',
      'Define a typed custom field on any registered entity, or patch an existing one by its key. The key may not shadow a column the entity already has, and once any value is stored the type is frozen (changing it would silently corrupt what is already there). A field defined by the agent actor lands as a draft and is invisible until confirm_field releases it.',
      ctxSchema(
        {
          entityKind: STR,
          key: STR,
          labelI18n: OBJ,
          type: STR,
          options: STR_LIST,
          required: BOOL,
          defaultValue: ANY_VALUE,
          sort: INT,
          idempotencyKey: STR,
        },
        ['entityKind', 'key', 'labelI18n', 'type'],
      ),
      (ctx, input) => defineField(ctx, input as unknown as Parameters<typeof defineField>[1]),
    ),
    ctxAction(
      'confirm_field',
      'write',
      'Release a draft custom field so every screen and every caller can see it: the human half of draft-by-default. Confirming a field that is already live is a successful no-op.',
      ctxSchema({ fieldDefId: STR, idempotencyKey: STR }, ['fieldDefId']),
      (ctx, input) => confirmField(ctx, input as unknown as { fieldDefId: string; idempotencyKey?: string }),
    ),
    ctxAction(
      'archive_field',
      'write',
      'Archive a custom field so it stops being offered as an input. Never a delete: every value already stored survives and stays readable through list_field_values. Returns how many saved views still name the field, so the caller can warn rather than be surprised later.',
      ctxSchema({ fieldDefId: STR, idempotencyKey: STR }, ['fieldDefId']),
      (ctx, input) => archiveField(ctx, input as unknown as { fieldDefId: string; idempotencyKey?: string }),
    ),
    ctxAction(
      'list_field_defs',
      'read',
      'List the custom fields defined on an entity kind, in display order. Archived fields and unconfirmed drafts are excluded unless asked for.',
      ctxSchema({ entityKind: STR, includeArchived: BOOL, includeDrafts: BOOL }, ['entityKind']),
      (ctx, input) =>
        listFieldDefs(ctx, input as unknown as { entityKind: string; includeArchived?: boolean; includeDrafts?: boolean }),
    ),
    ctxAction(
      'set_field_value',
      'write',
      'Set one custom field value on one record, validated against the field type (a money value is an integer Rappen count, a date is ISO-8601, a select value is one of its options). Passing null clears the value. Requires whatever capability editing that entity itself requires, never a G00 capability: a custom field is not a side door.',
      ctxSchema({ entityKind: STR, entityId: STR, fieldKey: STR, value: ANY_VALUE, idempotencyKey: STR }, [
        'entityKind',
        'entityId',
        'fieldKey',
      ]),
      (ctx, input) => setFieldValue(ctx, input as unknown as Parameters<typeof setFieldValue>[1]),
    ),
    ctxAction(
      'list_field_values',
      'read',
      "Read every custom field value stored on one record, archived fields included and labelled as archived. This is how a retired field's data stays reachable after it stops rendering as an input.",
      ctxSchema({ entityKind: STR, entityId: STR }, ['entityKind', 'entityId']),
      (ctx, input) => listFieldValues(ctx, input as unknown as { entityKind: string; entityId: string }),
    ),
    ctxAction(
      'create_saved_view',
      'write',
      'Save a named filter, sort, column set and layout over an entity list. The view belongs to the calling session unless shared is true, which publishes it to everyone in the workspace and requires manage_saved_views.',
      ctxSchema(
        {
          entityKind: STR,
          name: STR,
          filters: OBJ,
          sort: ANY_LIST,
          columns: STR_LIST,
          layout: STR,
          shared: BOOL,
          isDefault: BOOL,
          idempotencyKey: STR,
        },
        ['entityKind', 'name'],
      ),
      (ctx, input) => createSavedView(ctx, input as unknown as Parameters<typeof createSavedView>[1]),
    ),
    ctxAction(
      'update_saved_view',
      'write',
      'Patch a saved view. A personal view may only be changed by the session that owns it; a workspace-shared one, and publishing a personal one, require manage_saved_views.',
      ctxSchema({ viewId: STR, patch: OBJ, idempotencyKey: STR }, ['viewId', 'patch']),
      (ctx, input) => updateSavedView(ctx, input as unknown as Parameters<typeof updateSavedView>[1]),
    ),
    ctxAction(
      'delete_saved_view',
      'write',
      'Delete a saved view outright. A true delete rather than an archive, because a view mints no state and holds no history; deleting a shared one requires manage_saved_views.',
      ctxSchema({ viewId: STR, idempotencyKey: STR }, ['viewId']),
      (ctx, input) => deleteSavedView(ctx, input as unknown as { viewId: string; idempotencyKey?: string }),
    ),
    ctxAction(
      'list_saved_views',
      'read',
      "List the saved views available for an entity kind: this session's own first, then the workspace-shared ones. Another session's personal views are never returned.",
      ctxSchema({ entityKind: STR }, ['entityKind']),
      (ctx, input) => listSavedViews(ctx, input as unknown as { entityKind: string }),
    ),
  ];
}
