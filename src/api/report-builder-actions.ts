/**
 * F01's ten verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `retainerActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Six writes (`reports_save/update/duplicate/delete/run/schedule`); four reads
 * (`reports_preview/sources/list/runs`). Writes gate on A24 `reports.write`, except `reports_run` on
 * `reports.run`; the metadata reads on `reports.read`. `reports_preview` and `reports_run` ADDITIONALLY
 * assert the composed source's own read gates in the engine, so a report is never a privilege
 * escalation around A24 (the F00 dashboards posture). F01 POSTS NOTHING (P3): every verb composes read
 * models and renders a local artifact (OP4); it never calls A02/A14.
 *
 * As with `retainer-actions.ts`, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  reportsSave,
  reportsUpdate,
  reportsDuplicate,
  reportsDelete,
  reportsRun,
  reportsSchedule,
  reportsPreview,
  reportsSources,
  reportsList,
  reportsRuns,
} from '../core/reportbuilder/index.js';

export interface ReportBuilderActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const ARR = { type: 'array' } as const;
const OBJ = { type: 'object' } as const;

/** The F01 verbs, in append order. */
export function reportBuilderActions(h: ReportBuilderActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'reports_save',
      'write',
      'Bericht speichern (F01): save a report definition over a REPORT_SOURCES read model (source + filters + columns + format csv|pdf). Validates the source (unknown_source), that every filter names a published field with a type-valid operator (invalid_filter_field), and that columns is a non-empty subset of the published columns, base OR cf: custom fields (columns_empty). Posts nothing (P3); renders no artifact (that is reports_run). Idempotent on idempotencyKey. Gated on A24 reports.write.',
      ctxSchema(
        { name: STR, source: STR, filters: ARR, columns: ARR, format: STR, idempotencyKey: STR },
        ['name', 'source', 'columns', 'idempotencyKey'],
      ),
      (ctx, input) => reportsSave(ctx, as(input)),
    ),
    ctxAction(
      'reports_update',
      'write',
      'Bericht bearbeiten (F01): patch name/filters/columns/format on a saved report. Re-validates the definition against its source; changing source to one that no longer exists is refused (unknown_source). Editing a definition never mutates past report_runs artifacts (history is append-only). Idempotent on idempotencyKey. Gated on A24 reports.write.',
      ctxSchema({ reportId: STR, patch: OBJ, idempotencyKey: STR }, ['reportId', 'idempotencyKey']),
      (ctx, input) => reportsUpdate(ctx, as(input)),
    ),
    ctxAction(
      'reports_duplicate',
      'write',
      'Bericht duplizieren (F01): copy a definition with a "(Kopie)" suffix and WITHOUT its schedule or recipients, so a copy never silently starts mailing anyone (P8 spirit). Idempotent on idempotencyKey. Gated on A24 reports.write.',
      ctxSchema({ reportId: STR, idempotencyKey: STR }, ['reportId', 'idempotencyKey']),
      (ctx, input) => reportsDuplicate(ctx, as(input)),
    ),
    ctxAction(
      'reports_delete',
      'write',
      'Bericht löschen (F01): remove a definition and its run history. Refused with retention_locked while any run is retention-linked into E00 and still locked there (E00 owns the OR 958f lock); retained E00 documents are untouched. Deleting also deactivates any schedule, so a deleted report can never fire again. Idempotent on idempotencyKey. Gated on A24 reports.write.',
      ctxSchema({ reportId: STR, idempotencyKey: STR }, ['reportId', 'idempotencyKey']),
      (ctx, input) => reportsDelete(ctx, as(input)),
    ),
    ctxAction(
      'reports_run',
      'write',
      'Bericht ausführen (F01): compute the source read model with the stored filters (P5), project the stored columns, render CSV (RFC-4180, UTF-8 BOM, machine-neutral integer Rappen) or PDF (report header + rows, de-CH money) as a LOCAL artifact (OP4), append a report_runs row and return the content. An empty result set is a valid ok run (row_count 0, header-only CSV). With retain:true an accounting-record source additionally links the artifact into E00 (F01 never computes a retention date; E00 owns OR 958f). Re-running the same idempotencyKey returns the original artifact. Asserts the source own read gates too. Gated on A24 reports.run.',
      ctxSchema({ reportId: STR, format: STR, retain: BOOL, idempotencyKey: STR }, ['reportId', 'idempotencyKey']),
      (ctx, input) => reportsRun(ctx, as(input)),
    ),
    ctxAction(
      'reports_schedule',
      'write',
      'Zeitplan setzen (F01): store a validated cron-subset schedule (freq daily|weekly|monthly + at HH:mm, weekly weekday, monthly dayOfMonth) on a saved report; an unsupported expression is refused (invalid_schedule). Recipients are stored draft-gated (P8); in the OSS core there is no delivery transport, so delivery stays inactive (reason cloud_tier) and the LOCAL run always works. schedule:null clears the schedule and keeps the report. Idempotent on idempotencyKey. Gated on A24 reports.write.',
      ctxSchema({ reportId: STR, schedule: OBJ, recipients: ARR, idempotencyKey: STR }, ['reportId', 'idempotencyKey']),
      (ctx, input) => reportsSchedule(ctx, as(input)),
    ),
    ctxAction(
      'reports_preview',
      'read',
      'Vorschau (F01): read-only ad-hoc compute of a source read model with filters + columns for the builder live preview and agent exploration (P5). Persists nothing. Returns the projected rows (up to limit, default 50), the resolved columns and the full row count. Asserts the source own read gates (a preview never reads past the caller RBAC). Unknown source returns unknown_source; a filter on an unpublished field returns invalid_filter_field.',
      ctxSchema({ source: STR, filters: ARR, columns: ARR, limit: INT }, ['source', 'columns']),
      (ctx, input) => reportsPreview(ctx, as(input)),
    ),
    ctxAction(
      'reports_sources',
      'read',
      'Datenquellen (F01): the REPORT_SOURCES registry as a read model, each source id, title, entity kind, accounting-record flag, module availability, and its published columns, the union of the source own base fields plus any cf: custom fields defined on its entity kind (OP7), so a custom field appears the moment G00 defines it. Gated on A24 reports.read.',
      ctxSchema(),
      (ctx) => reportsSources(ctx),
    ),
    ctxAction(
      'reports_list',
      'read',
      'Berichte anzeigen (F01): the saved-report list (P5), tenant-scoped, newest first, with each definition source, format, schedule, recipients (draft), delivery state and last-run timestamp. Gated on A24 reports.read.',
      ctxSchema(),
      (ctx) => reportsList(ctx),
    ),
    ctxAction(
      'reports_runs',
      'read',
      'Laufverlauf (F01): the append-only run history for one report (P5), newest first, each run status (ok|failed), row count, format, artifact ref, definition-version hash and E00 document link. savedViewId applies a saved view (G00) over the run history: its stored status filter merges underneath an explicit status named here. Gated on A24 reports.read.',
      ctxSchema({ reportId: STR, status: STR, savedViewId: STR }, ['reportId']),
      (ctx, input) => reportsRuns(ctx, as(input)),
    ),
  ];
}
