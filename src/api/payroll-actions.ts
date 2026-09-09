/**
 * A34's three verbs (2 writes + 1 read), defined here and spread into `ACTIONS` as ONE line (the
 * `fxActions` / `captureActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * Both writes carry `idempotencyKey` and none belongs in the conformance gate's key-exemption list.
 * `wage_journal_post` is the ONE posting in this lane (P8: it returns a preview and stops unless
 * `confirm` is set); `payroll_handoff_export` produces a LOCAL artifact and transmits nothing (OP4).
 *
 * As with `capture-actions.ts`, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { payrollHandoffExport, wageJournalPost, listPayrollHandoffs } from '../core/payroll/index.js';

export interface PayrollActionHelpers {
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

/** The A34 verbs, in append order. */
export function payrollActions(h: PayrollActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'payroll_handoff_export',
      'write',
      "Export the employee master (E02) plus the mutations since the last export, as a LOCAL artifact for an external payroll provider. format is csv or json (default json). The artifact is stored via E00 and linked to a payroll_handoff record; it NEVER transmits (OP4). AHV numbers are included only when the actor holds hr.sensitive; when they are not, the artifact is produced WITHOUT them and both the artifact header and the result say so ({ahvIncluded:false, ahvExcludedReason:'missing_hr_sensitive'}), never a silent omission (revDSG Art. 6). The first export is the full master with an empty mutations section; a re-run with no changes yields mutationCount:0. Refuses with no_employees when the roster is empty. Posts nothing.",
      ctxSchema({ format: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => payrollHandoffExport(ctx, as(input)),
    ),
    ctxAction(
      'wage_journal_post',
      'write',
      "Preview then post the month's externally-computed aggregate wage journal as ONE balanced entry through A02 (source=import). Supply exactly one of lines[] (agent path: each {accountNumber|accountId, debitMinor|creditMinor, costCenter?, description?} in integer Rappen) or fileRef (a stored provider CSV, columns account_number/debit_rappen/credit_rappen/cost_center?/description?, translated through an optional columnMap of canonical->provider header). entryDate is YYYY-MM-DD. Without confirm it returns the full-entry preview and writes NOTHING, without consuming the idempotency key (P8); an unbalanced set is refused at preview time with diffRappen, before A02 is asked. With confirm:true it posts once (requiring the post capability) and records a wage_journal_posts row; a re-post with the same idempotencyKey returns the original posted entry and never posts a second one. A wrong journal is corrected in the payroll system and re-imported, or reversed via A02, never edited. TILL computes no wage: amounts arrive from the provider and are only summed for the balance check.",
      ctxSchema(
        { lines: ARR, fileRef: STR, columnMap: OBJ, mappingId: STR, entryDate: STR, description: STR, ref: STR, confirm: BOOL, idempotencyKey: STR },
        ['entryDate', 'idempotencyKey'],
      ),
      (ctx, input) => wageJournalPost(ctx, as(input)),
    ),
    ctxAction(
      'list_payroll_handoffs',
      'read',
      'The payroll hand-off history: the union of exports and wage-journal postings, each row typed export or posting, newest first. An export row carries counts, the AHV-inclusion state and the artifact link; a posting row carries the entry date and the posted entry id. from/to filter on the record date; savedViewId applies a G00 saved view.',
      ctxSchema({ from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listPayrollHandoffs(ctx, as(input)),
    ),
  ];
}
