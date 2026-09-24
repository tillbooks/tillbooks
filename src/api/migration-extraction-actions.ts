/**
 * G19's five verbs, defined here and spread into `ACTIONS` as one line (the `migrationMapActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block.
 *
 * TWO SHAPES, deliberately. The two guide reads (`migration_list_extraction_guides`,
 * `migration_get_extraction_guide`) are `depsAction`s and take NO `workspaceId`: they describe the
 * SOFTWARE (shipped guide data), not any workspace, the `migration_list_source_adapters` reasoning
 * exactly, so there is no tenant to resolve a capability against and their `ungated(...)` rows live
 * in `actionCapabilities.ts`. The three manifest verbs are `ctxAction`s (every one takes
 * `workspaceId`, §H-TENANT) and gate on `manage_import` like the rest of the import domain.
 *
 * As with `migration-map-actions.ts`, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  listExtractionGuides,
  getExtractionGuide,
  setManifest,
  setManifestItem,
  getManifest,
} from '../core/migration/index.js';

export interface MigrationExtractionActionHelpers {
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

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G19 verbs, in append order (the §5 table order). */
export function migrationExtractionActions(h: MigrationExtractionActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR } = h;
  const INT = { type: 'integer' } as const;
  const BOOL = { type: 'boolean' } as const;
  const STR_LIST = { type: 'array', items: STR } as const;

  return [
    depsAction(
      'migration_list_extraction_guides',
      'read',
      'List the extraction guides TILL ships (one per source system, generic and bexio first), each with its label, item count and whether a browser companion has cleared its gates (hasCompanion). Describes the software, not any workspace.',
      depsSchema({}, []),
      () => listExtractionGuides(),
    ),
    depsAction(
      'migration_get_extraction_guide',
      'read',
      'Read one extraction guide for a source system: every item with what to export, where it lives, the expected formats, the data classes it feeds, quirks and its tactic-ladder rung (1 native export, 2 report-based, 3/4 browser companion (gated), 5 the Datenherausgabe letter). An unknown source system returns the generic guide with fellBack:true; pass strict:true to require an exact match. Includes the deletion clock and the letter template. Describes the software, not any workspace.',
      depsSchema({ sourceSystem: STR, strict: BOOL }, []),
      (_deps, input) => getExtractionGuide(as(input)),
    ),
    ctxAction(
      'migration_set_manifest',
      'write',
      'Instantiate the export-completeness manifest for a plan from its source-system guide, one item per guide row at status open. Idempotent on its key; an existing manifest is not reset (recorded statuses survive), only sourceAccessUntil is refreshed. sourceAccessUntil is the deletion-clock deadline, a contract fact to verify against your own terms.',
      ctxSchema({ planId: STR, sourceAccessUntil: STR, idempotencyKey: STR }, ['planId', 'idempotencyKey']),
      (ctx, input) => setManifest(ctx, as(input)),
    ),
    ctxAction(
      'migration_set_manifest_item',
      'write',
      'Record one manifest item: status (open, exported, not_used, blocked), the E00 fileId(s), a row count, a date range and a note. A cross-workspace fileId refuses (H-TENANT); a date range whose end precedes its start refuses. Idempotent on its key. not_used drops the item from the completeness denominator.',
      ctxSchema(
        { planId: STR, itemId: STR, status: STR, fileIds: STR_LIST, rowCount: INT, dateFrom: STR, dateTo: STR, note: STR, idempotencyKey: STR },
        ['planId', 'itemId', 'status', 'idempotencyKey'],
      ),
      (ctx, input) => setManifestItem(ctx, as(input)),
    ),
    ctxAction(
      'migration_get_manifest',
      'read',
      'Read a plan export manifest: its items with status, counts and evidence, the completeness (open count over the denominator, not_used excluded) and the deletion clock as a date with the days remaining. Accepts a saved view (savedViewId) over the checklist items ("Offene Exporte", "Blockiert"); an explicit status wins over the stored one. Completeness and the deadline are computed over the whole manifest, never the filtered view. A plan with no manifest returns manifest:null so the surface can offer to create one.',
      ctxSchema({ planId: STR, savedViewId: STR, status: STR }, ['planId']),
      (ctx, input) => getManifest(ctx, as(input)),
    ),
  ];
}
