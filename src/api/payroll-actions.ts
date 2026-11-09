/**
 * A34's four verbs (3 writes + 1 read; the third write is D171's `wage_journal_reverse`), defined here and spread into `ACTIONS` as ONE line (the
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
import { validateSupplementary, validateRunKindStatic, runKindReasonRequired, payrollHandoffExport, wageJournalPost, wageJournalReverse, listPayrollHandoffs } from '../core/payroll/index.js';
import type { ActionKind } from './actionKind.js';

export interface PayrollActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
  /** D173: attach the verb's pure pre-draft validation (`ActionDef.prevalidate`). */
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const ARR = { type: 'array' } as const;
const OBJ = { type: 'object' } as const;

/**
 * D173 (critic r3): whether `wage_journal_post` already answered this key, either as a stored result
 * (it ran) or as a Vorschlag the seam queued under it (a draft replay answers the same Vorschlag). Such a
 * call is a replay, so the setting-dependent reason check must not refuse it. §H-TENANT.
 */
function keyAlreadyUsed(ctx: WorkspaceContext, key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (ctx.store.recallIdempotent(ctx.workspaceId, key, 'wage_journal_post') !== undefined) return true;
  const drafted = ctx.store.db
    .prepare(
      `SELECT 1 FROM agent_action
        WHERE workspace_id = ? AND action_tool = 'wage_journal_post' AND idempotency_key = ? AND status <> 'stale' LIMIT 1`,
    )
    .get(ctx.workspaceId, key);
  return drafted !== undefined;
}

/** The A34 verbs, in append order. */
export function payrollActions(h: PayrollActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR, BOOL } = h;

  return [
    ctxAction(
      'payroll_handoff_export',
      'write:correctable:derived',
      "Export the employee master (E02) plus the mutations since the last export, as a LOCAL artifact for an external payroll provider. format is csv or json (default json). The artifact is stored via E00 and linked to a payroll_handoff record; it NEVER transmits (OP4). AHV numbers are included only when the actor holds hr.sensitive; when they are not, the artifact is produced WITHOUT them and both the artifact header and the result say so ({ahvIncluded:false, ahvExcludedReason:'missing_hr_sensitive'}), never a silent omission (revDSG Art. 6). The first export is the full master with an empty mutations section; a re-run with no changes yields mutationCount:0. Refuses with no_employees when the roster is empty. Posts nothing.",
      ctxSchema({ format: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => payrollHandoffExport(ctx, as(input)),
    ),
    withPrevalidate(ctxAction(
      'wage_journal_post',
      'write:correctable:books',
      "Preview then post the month's externally-computed aggregate wage journal as ONE balanced entry through A02 (source=import). Supply exactly one of lines[] (agent path: each {accountNumber|accountId, debitMinor|creditMinor, costCenter?, description?} in integer Rappen) or fileRef (a stored provider CSV, columns account_number/debit_rappen/credit_rappen/cost_center?/description?, translated through an optional columnMap of canonical->provider header). entryDate is YYYY-MM-DD. Without confirm it returns the full-entry preview and writes NOTHING, without consuming the idempotency key (P8); an unbalanced set is refused at preview time with diffRappen, before A02 is asked. With confirm:true it posts once (requiring the post capability) and records a wage_journal_posts row; a re-post with the same idempotencyKey returns the original posted entry and never posts a second one. One wage journal stands per month (D173, the YYYY-MM of entryDate): while an earlier posting for that month stands, a confirm under a new key is refused month_already_posted naming the standing wageJournalPostId and postedEntryId; reverse it with wage_journal_reverse first, which frees the month. The workspace setting payroll.month_guard decides this: refuse (default), warn (the post goes through and the result carries warnings[] naming the standing posting(s)), or off (no check); the preview names the standing posting(s) in warnings[] under refuse and warn. supplementary:true with a non-blank supplementaryReason skips the guard for that one call (reason_required without a reason, also on the preview), writes the reason into the entry description and an audit row. Only wage_journal_post is guarded: a raw post_entry is not. runKind is regular (default), bonus, thirteenth or correction; the guard counts only regular postings, so a bonus, 13th-salary or correction run never blocks and is never blocked, and list_payroll_handoffs shows each posting's runKind. runKindReason (only on a non-regular run, else invalid_input) is written into the entry description; the setting payroll.nonregular_reason decides when it is required: none, correction (default: a correction run needs one) or all (every non-regular run), refused reason_required without it, also on the preview. Every non-regular post writes an audit row naming its kind. A wrong journal is reversed by wage_journal_reverse (the raw reverse_entry refuses it owned_by) and the corrected one re-imported, never edited. TILL computes no wage: amounts arrive from the provider and are only summed for the balance check.",
      ctxSchema(
        { lines: ARR, fileRef: STR, columnMap: OBJ, mappingId: STR, entryDate: STR, description: STR, ref: STR, confirm: BOOL, supplementary: BOOL, supplementaryReason: STR, runKind: { type: 'string', enum: ['regular', 'bonus', 'thirteenth', 'correction'] }, runKindReason: STR, idempotencyKey: STR },
        ['entryDate', 'idempotencyKey'],
      ),
      (ctx, input) => wageJournalPost(ctx, as(input)),
    ), (ctx, input) =>
      validateSupplementary(input) ??
      validateRunKindStatic(input) ??
      // Setting-dependent: only for a call whose key holds no stored result, so a replay answers its
      // original (critic r3 HIGH); a fresh call without a required reason is still never drafted.
      (keyAlreadyUsed(ctx, input.idempotencyKey) ? undefined : runKindReasonRequired(ctx, input))),
    ctxAction(
      'wage_journal_reverse',
      'write:correctable:books',
      "Storniere a posted wage journal (D171), the ONE correction of a wage_journal_post booking: posts the faithful A02 reversing entry of its single entry (OR 957a, dated today) through the owned path, and list_payroll_handoffs then names the mirror as reversalEntryId on the posting row. The wage_journal_posts row stays (append-only); the corrected journal is re-imported with wage_journal_post under a new key. TILL computes no wage and sees no salary payment, AHV/BVG/Quellensteuer declaration or Lohnausweis by row: those live in the payroll system and at the bank, stand as they are, and are corrected there. Refusals write nothing: an unknown or foreign posting is not_found; a blank reason is reason_required; a journal already reversed, also by a raw Storno from before this verb, is already_reversed naming the mirror; a bank line that booked or matched the entry is owned_by reopen_bank_line naming the line (reopen it first); period_locked when today is sealed. The raw reverse_entry refuses a wage journal entry (owned_by wage_journal_reverse); other import-sourced entries (opening balances) are not affected. Requires post. Idempotent: a replay under the same key answers the stored result.",
      ctxSchema({ wageJournalPostId: STR, reason: STR, idempotencyKey: STR }, ['wageJournalPostId', 'reason', 'idempotencyKey']),
      (ctx, input) => wageJournalReverse(ctx, as(input)),
    ),
    ctxAction(
      'list_payroll_handoffs',
      'read',
      'The payroll hand-off history: the union of exports and wage-journal postings, each row typed export or posting, newest first. An export row carries counts, the AHV-inclusion state and the artifact link; a posting row carries the entry date, the posted entry id and reversalEntryId (the mirror once wage_journal_reverse took it back, else null). from/to filter on the record date; savedViewId applies a G00 saved view.',
      ctxSchema({ from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listPayrollHandoffs(ctx, as(input)),
    ),
  ];
}
