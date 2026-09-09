/**
 * G10's eight verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent),
 * so several agents appending to the append-only registry at once collide over a line rather than a
 * block.
 *
 * Six are `ctxAction` registrations. The two catalog reads (`migration_list_source_adapters`,
 * `migration_list_locale_packs`) are `depsAction`s and take NO `workspaceId`, because they describe
 * the SOFTWARE (which formats TILL can read, which locales are registered) rather than any
 * workspace's data: the G04 §2 US-G04.4 reasoning, restated in `actionCapabilities.ts` where their
 * `ungated(...)` rows live. There is deliberately no tenant on the input, so there is nothing to
 * resolve a capability against and nothing to leak.
 *
 * Every OTHER verb here gates on `manage_import` (A24), reads included: a migration map names how a
 * client's whole chart and tax world will land in the books, which is import-scoped work, not a
 * general bookkeeping read (the spec's own permission-denied states cover `suggest`/`get`/`list`).
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import {
  applyMapTemplate,
  getMap,
  listMapTemplates,
  saveMapTemplate,
  setMap,
  suggestMap,
  LOCALE_PACKS,
  SOURCE_ADAPTERS,
} from '../core/migration/index.js';

export interface MigrationMapActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

// The registry's own documented cast: the JSON input is handed to the verb as its typed input; the
// engine reads the fields it needs and ignores the rest, `workspaceId` included.
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G10 verbs, in append order. */
export function migrationMapActions(h: MigrationMapActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR } = h;
  const STR_LIST = { type: 'array', items: STR } as const;
  const ENTRIES = { type: 'array' } as const;

  return [
    depsAction(
      'migration_list_source_adapters',
      'read',
      'List the source formats TILL can read for a Datenübernahme, each with the published documentation it was written from (cleanRoomSource). Describes the software, not any workspace.',
      depsSchema({}, []),
      () =>
        ok({
          adapters: SOURCE_ADAPTERS.map((a) => ({
            id: a.id,
            label: a.label,
            mediaTypes: [...a.mediaTypes],
            dataClasses: [...a.dataClasses],
            cleanRoomSource: a.cleanRoomSource,
          })),
        }),
    ),
    depsAction(
      'migration_list_locale_packs',
      'read',
      'List the registered locale packs (target chart, tax-code set, parse conventions, statutory anchors). Switzerland (ch) always ships. Describes the software, not any workspace.',
      depsSchema({}, []),
      () =>
        ok({
          packs: LOCALE_PACKS.map((p) => ({
            id: p.id,
            label: p.label,
            targetChartSeed: p.targetChartSeed.id,
            taxCodeSet: [...p.taxCodeSet],
            parseConventions: p.parseConventions,
            statutoryAnchors: [...p.statutoryAnchors],
          })),
        }),
    ),
    ctxAction(
      'migration_suggest_map',
      'read',
      'Propose a migration map (column, account, tax or currency) for a plan, naming which source produced it (adapter preset, locale pack, saved template or fuzzy match). Writes nothing: the caller always confirms via migration_set_map.',
      ctxSchema({ planId: STR, kind: STR, dataClass: STR, headers: STR_LIST }, ['planId', 'kind']),
      (ctx, input) => suggestMap(ctx, as(input)),
    ),
    ctxAction(
      'migration_set_map',
      'write',
      'Persist a migration map for a plan. Every target is validated against the live chart (A01) and tax codes (A05) before anything is written; one unknown target rejects the whole map, and overlapping tax validity windows are refused naming both.',
      ctxSchema({ planId: STR, kind: STR, entries: ENTRIES, ruleDefault: STR, idempotencyKey: STR }, ['planId', 'kind', 'entries', 'idempotencyKey']),
      (ctx, input) => setMap(ctx, as(input)),
    ),
    ctxAction(
      'migration_get_map',
      'read',
      "Read a plan's map and its completeness: blocking unmapped accounts (non-zero balance), ignorable ones (zero balance), many-to-one collapses and template conflicts. complete:true is what lets the Datenübernahme step advance.",
      ctxSchema({ planId: STR, kind: STR }, ['planId', 'kind']),
      (ctx, input) => getMap(ctx, as(input)),
    ),
    ctxAction(
      'migration_save_map_template',
      'write',
      "Save a plan's finished maps as a Zuordnungsvorlage for this operator, reusable across client workspaces. Balances and every other client figure are stripped: a template carries only source labels, source account numbers and target ids.",
      ctxSchema({ planId: STR, name: STR, sourceSystem: STR, kinds: STR_LIST, idempotencyKey: STR }, ['planId', 'name', 'sourceSystem', 'kinds', 'idempotencyKey']),
      (ctx, input) => saveMapTemplate(ctx, as(input)),
    ),
    ctxAction(
      'migration_list_map_templates',
      'read',
      "List this operator's Zuordnungsvorlagen, optionally filtered by source system or map kind. Accepts a saved view (savedViewId) over the template list; an explicit filter wins over the stored one.",
      ctxSchema({ sourceSystem: STR, kind: STR, savedViewId: STR }),
      (ctx, input) => listMapTemplates(ctx, as(input)),
    ),
    ctxAction(
      'migration_apply_map_template',
      'write',
      "Apply a Zuordnungsvorlage to a plan's maps and report the deltas: applied, unmatched (targets this workspace lacks), new (source accounts the template does not cover) and conflicts. A hand-set entry is never overwritten; the hand-set value wins.",
      ctxSchema({ planId: STR, templateId: STR, idempotencyKey: STR }, ['planId', 'templateId', 'idempotencyKey']),
      (ctx, input) => applyMapTemplate(ctx, as(input)),
    ),
  ];
}
