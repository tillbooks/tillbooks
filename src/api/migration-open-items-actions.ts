/**
 * G21's two verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `migrationCheckActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * `import_open_items` is the money-path WRITE: it carries open AR/AP items across from an old system
 * as `origin='migrated'` documents / vendor bills that post NOTHING (their only ledger effect is
 * A04's opening 1100 / 2000 line). It takes `workspaceId` + `idempotencyKey`, is DENYLISTED from
 * automation (a rule must not import an opening position, G01), and its registry-boundary capability
 * is `commit_migration` (the same right that commits every money-path migration step, spec §3), which
 * the engine also asserts. `preview_open_items` is the READ twin: it computes the ar/ap control delta
 * without writing, so an operator (or agent) sees the tie-out before committing.
 *
 * As with the sibling migration action files, the helpers arrive as a parameter rather than an
 * import, so the module graph stays acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { importOpenItems, previewOpenItems } from '../core/migration/index.js';

export interface MigrationOpenItemsActionHelpers {
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

/** The G21 verbs, in append order (the §5 table order: preview then import). */
export function migrationOpenItemsActions(h: MigrationOpenItemsActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const ARR = { type: 'array' } as const;

  return [
    ctxAction(
      'preview_open_items',
      'read',
      'Preview an open-items migration for one plan and side (ar Debitoren or ap Kreditoren): compute the control tie-out the batch WOULD produce (the migrated open total against the opening 1100 Debitoren or 2000 Kreditoren line, integer Rappen, zero tolerance, G11 three-status honesty) and surface every refusal (open_item_total_mismatch, contact_unmapped/vendor_unmapped, tax_unresolved, needs_fx_rate) naming the offending row, WITHOUT writing anything. priorYearDetail (live or archive, default archive) governs whether an already-settled prior-year row is carried live or belongs in the G13 archive.',
      ctxSchema({ planId: STR, side: STR, rows: ARR, priorYearDetail: STR }, ['planId', 'side', 'rows']),
      (ctx, input) => previewOpenItems(ctx, as(input)),
    ),
    ctxAction(
      'import_open_items',
      'write',
      'Import open items (ar or ap) for a migration plan: each already-mapped row becomes an origin=migrated document (AR, at issued) or vendor bill (AP, at posted) that posts NOTHING of its own (posted_entry_id/entry_id NULL). Its only ledger effect is A04 opening 1100/2000 line; the migrated open total must tie to that line to the Rappen (a nonzero difference is a red control, never a plug posting). Atomic and idempotent: a single refused row imports nothing, and a re-run with the same idempotencyKey replays the original outcome (no duplicate rows). Rides commit_migration; denylisted from automation. priorYearDetail live carries an already-settled prior-year row as a settled migrated item that nets to zero open; archive (default) refuses it toward the G13 archive.',
      ctxSchema({ planId: STR, side: STR, rows: ARR, priorYearDetail: STR, idempotencyKey: STR }, ['planId', 'side', 'rows', 'idempotencyKey']),
      (ctx, input) => importOpenItems(ctx, as(input)),
    ),
  ];
}
