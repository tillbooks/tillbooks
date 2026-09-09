/**
 * G13's six verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `migrationActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * All six are `ctxAction` registrations (§H-TENANT). Four are reads carrying `readOnlyHint`; the
 * two writes are `gl_archive_import` (idempotent: a re-run replaces the step's rows wholesale and
 * lands the identical archive) and `gl_archive_purge` (destructive, confirm-gated, denylisted from
 * automation: destroying records, even lawfully, is a human act).
 *
 * THE HARD PARTITION IS IN THE DESCRIPTIONS on purpose: an agent quoting them must never present an
 * archive figure as a TILL-computed one. Every read's payload carries the provenance facts (source
 * system, covered range), so a client that drops the label has to do it deliberately.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  archivePreview,
  archiveImport,
  archiveQuery,
  archiveAccountHistory,
  archivePeriods,
  archivePurge,
} from '../core/migration/index.js';

export interface GlArchiveActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G13 verbs, in append order (the §5 table order). */
export function glArchiveActions(h: GlArchiveActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const INT = { type: 'integer' } as const;
  const BOOL = { type: 'boolean' } as const;

  return [
    ctxAction(
      'gl_archive_preview',
      'read',
      "Preview a gl_history step's archive import without writing anything: per-period entry and line counts, per-account totals, the unmapped source accounts (they would import flagged, never refused) and the internally unbalanced entry count.",
      ctxSchema({ planId: STR, stepId: STR }, ['planId', 'stepId']),
      (ctx, input) => archivePreview(ctx, as(input)),
    ),
    ctxAction(
      'gl_archive_import',
      'write',
      "Import the prior system's journal into the read-only GL archive (GeBüV Art. 10: readable across the system change). Writes gl_archive rows ONLY, posts NOTHING to the live ledger, and never mixes with it: archive rows are outside the TILL Belegkette and say so. Unmapped accounts import with a null target; unbalanced source entries import flagged, never corrected. Idempotent: a re-run replaces the step's rows wholesale.",
      ctxSchema({ planId: STR, stepId: STR, idempotencyKey: STR }, ['planId', 'stepId', 'idempotencyKey']),
      (ctx, input) => archiveImport(ctx, as(input)),
    ),
    ctxAction(
      'gl_archive_query',
      'read',
      "Query the prior-system archive by account (target or source), period, text and amount range, paginated. Returns ARCHIVE rows only, labelled with their provenance (source system, covered range): a live journal row can never appear here, and an archive row never appears in list_journal. savedViewId applies a saved view (G00).",
      ctxSchema(
        {
          account: STR,
          sourceAccount: STR,
          from: STR,
          to: STR,
          text: STR,
          amountMinMinor: INT,
          amountMaxMinor: INT,
          balancedOnly: BOOL,
          savedViewId: STR,
          page: INT,
        },
        [],
      ),
      (ctx, input) => archiveQuery(ctx, as(input)),
    ),
    ctxAction(
      'gl_archive_account_history',
      'read',
      'Aggregate one account\'s archived history per month, quarter or year (debit, credit, running balance), by live target account id or by the source system\'s own account number. Aggregates only: at 300000 entries the archive answers with periods, not rows.',
      ctxSchema({ accountId: STR, sourceAccount: STR, groupBy: STR }, []),
      (ctx, input) => archiveAccountHistory(ctx, as(input)),
    ),
    ctxAction(
      'gl_archive_periods',
      'read',
      'List the archived periods with their entry counts, their OR 958f retention dates, and any purge records (completed purges AND refusals on retention grounds, each citing the statute).',
      ctxSchema({}, []),
      (ctx, input) => archivePeriods(ctx, as(input)),
    ),
    ctxAction(
      'gl_archive_purge',
      'write',
      "Purge archived periods whose OR 958f ten-year retention has expired, with a recorded reason. Deletes ARCHIVE data only (structurally incapable of touching a live journal row), keeps a purge record where the periods were, and refuses inside the retention window with the date, recording the refusal: that record is the answer a data subject receives. Requires confirmed:true.",
      ctxSchema({ periodFrom: STR, periodTo: STR, reason: STR, confirmed: BOOL, idempotencyKey: STR }, ['periodFrom', 'periodTo', 'reason', 'idempotencyKey']),
      (ctx, input) => archivePurge(ctx, as(input)),
    ),
  ];
}
