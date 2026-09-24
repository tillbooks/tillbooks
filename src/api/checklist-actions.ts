/**
 * G22's eight verbs (3 reads + 5 writes), defined here and spread into `ACTIONS` as one line (the
 * `migrationProjectActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * ALL EIGHT ARE ctx verbs (every one takes `workspaceId`, §H-TENANT). The five writes gate on
 * `manage_checklists` (A24, new, granted to the built-in bundles that hold `post`: a checklist moves
 * no money); the three reads ride `read_books`. Item 8 of the MWST template acts through
 * `vat_mark_filed`, which keeps its own `vat_file` gate: this module never wraps it. The gate rows live
 * in `actionCapabilities.ts`. Leg 2 (spec §10.10) moves no signature but two shapes: `period` on
 * `checklist_start` is optional (the last ended period of the template's kind), and
 * `checklist_item_complete` admits `evidence.kind = choice`. The posting rows of the close templates
 * act through the domain verbs under their own gates, never through this module.
 *
 * As with the migration action modules, the helpers arrive as a parameter rather than an import, so
 * the module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import {
  listChecklistTemplates,
  checklistStart,
  checklistGet,
  checklistList,
  checklistItemComplete,
  checklistItemSkip,
  checklistItemReopen,
  checklistAbandon,
} from '../core/checklists/index.js';

export interface ChecklistActionHelpers {
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

/** The G22 verbs, in append order (the spec §5 table order). */
export function checklistActions(h: ChecklistActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const EVIDENCE = {
    type: 'object',
    properties: { kind: STR, ref: STR, reason: STR },
  } as const;

  return [
    ctxAction(
      'checklist_templates',
      'read',
      'List the shipped checklist templates (vat_period, the MWST-Periode from open books to a filed, locked, paid return; the close templates month_close and year_close as they land): id, kind, label, description, period kind (vat_period | month | year), anchor (vat_return | statements) and item count. Describes the software, not the workspace. Gates on read_books.',
      ctxSchema({}, []),
      () => ok({ templates: listChecklistTemplates() }),
    ),
    ctxAction(
      'checklist_start',
      'write',
      'Start a checklist run for a template and a period. period is OPTIONAL: omitted, the engine picks the last ENDED period of the template\'s kind (an A07 label such as 2026-Q2 for vat_period, YYYY-MM for month, the fiscal year YYYY for year), which is what the seeded daily auto-start rule relies on. Creates every item with its owner, prerequisites and due date (the ESTV filing and payment items at period end + 60 days, Art. 71 Abs. 1 and Art. 86 Abs. 1 MWSTG; on a year the Umsatzabstimmung at + 180 days, the Berichtigung at + 240 days and the GV six months on, Art. 699 Abs. 2 OR). Idempotent on workspace + template + period: a second start returns the existing run with created:false. Refuses needs_vat_config without an A05 configuration and period_not_filable for a vat_period label that is not one of the year\'s filing periods (naming them); period_not_ended while a month or year has not ended; year_already_closed on a sealed fiscal year; year_close_in_progress for the last fiscal month while a year_close run for that year exists (the year run covers it; an existing December run is still returned). Gates on manage_checklists.',
      ctxSchema({ templateId: STR, period: STR, idempotencyKey: STR }, ['templateId', 'idempotencyKey']),
      (ctx, input) => checklistStart(ctx, as(input)),
    ),
    ctxAction(
      'checklist_get',
      'read',
      'Read one checklist run with every item derived LIVE: a system check item is done while its check passes (drafts, bank reconciliation, tax codes, the vat_filed lock, the month or year lock), a verb or preview item is done while the hash the engine bound still equals the live read (stale otherwise), a posting item is done while its probe finds a live, unreversed artefact in the ledger, a validation item is done on pass (a warn needs a live acknowledgement), a choice item is done while a human answered or the books derive the answer, a sign-off item is done while a live sign-off stands, and an item whose governing choice carries another answer reads excluded. Returns the items in journey order, the next actionable item (nextItemId), the counts, the anchor hash and the derived run status (open | done | abandoned). Gates on read_books.',
      ctxSchema({ runId: STR }, ['runId']),
      (ctx, input) => checklistGet(ctx, as(input)),
    ),
    ctxAction(
      'checklist_list',
      'read',
      'List this workspace\'s checklist runs as metadata rows (template, period, derived status, next item, counts), open first, then done, then abandoned, newest period first. Optional templateId and status (open | done | abandoned) filters. Abandoned runs are listed, never deleted. Gates on read_books.',
      ctxSchema({ templateId: STR, status: STR }, []),
      (ctx, input) => checklistList(ctx, as(input)),
    ),
    ctxAction(
      'checklist_item_complete',
      'write',
      'Complete one checklist item. A verb or preview item is completed by the ENGINE re-running the read and binding its hash as evidence; a caller-supplied evidence.ref must agree (evidence_mismatch otherwise); a preview whose read refuses answers read_refused. A choice item stores the answer given as evidence {kind: choice, ref: <optionId>} (invalid_choice names the options; choice_locked when a governed posting or sign-off is already done). A warn validation records the acknowledgement as evidence {kind: signoff, ref: <reason>} bound to the figures (acknowledge_needs_reason without one); a block validation refuses check_not_passed. A sign-off item records an append-only sign-off: abstimmung_reviewed needs the live bridge check to pass (check_not_passed) and binds the return hash, statements_signoff binds the statements hash, settlement_booked needs evidence.ref naming the bank transaction or entry (evidence_required), eportal_filed needs evidence {kind: filed_attestation, ref: YYYY-MM-DD} not before the export (attestation_before_export) and a gv_attestation needs evidence {kind: gv_attestation, ref: YYYY-MM-DD} (a date before the statements sign-off needs evidence.reason); both refuse a second live attestation (already_attested). A system check or a posting item cannot be completed by hand (check_item_live: the domain verb is the act); an excluded item refuses item_excluded. Refuses prerequisite_open naming the blocking item and run_abandoned on an abandoned run. Gates on manage_checklists.',
      ctxSchema({ runId: STR, itemId: STR, evidence: EVIDENCE, idempotencyKey: STR }, ['runId', 'itemId', 'idempotencyKey']),
      (ctx, input) => checklistItemComplete(ctx, as(input)),
    ),
    ctxAction(
      'checklist_item_skip',
      'write',
      'Mark one checklist item as not applicable, with a recorded reason (skip_needs_reason without one). The undeletable items (the computed return, the period lock, the payment, the statements sign-off, the seal) refuse (undeletable): the canon is waived consciously, never dropped. An excluded item refuses item_excluded. A live sign-off on the item is voided, never deleted. Gates on manage_checklists.',
      ctxSchema({ runId: STR, itemId: STR, reason: STR, idempotencyKey: STR }, ['runId', 'itemId', 'reason', 'idempotencyKey']),
      (ctx, input) => checklistItemSkip(ctx, as(input)),
    ),
    ctxAction(
      'checklist_item_reopen',
      'write',
      'Return a done or skipped checklist item to open. A live sign-off on it (the bridge review, the ePortal attestation, the payment, an acknowledgement) is voided with reason reopened and kept as history; a bound verb or preview evidence is cleared; a human choice answer is cleared back to the derived one (choice_locked while a governed posting or sign-off is done). A system check or posting item cannot be reopened by hand (check_item_live): it flips with its check or probe. Gates on manage_checklists.',
      ctxSchema({ runId: STR, itemId: STR, idempotencyKey: STR }, ['runId', 'itemId', 'idempotencyKey']),
      (ctx, input) => checklistItemReopen(ctx, as(input)),
    ),
    ctxAction(
      'checklist_abandon',
      'write',
      'Abandon a checklist run with a reason (a wrong period was started). The run stays listed under the abandoned filter and contributes nothing to the attention hub; it is never deleted, and every write on it afterwards refuses run_abandoned. Start the right period with checklist_start. Gates on manage_checklists.',
      ctxSchema({ runId: STR, reason: STR, idempotencyKey: STR }, ['runId', 'reason', 'idempotencyKey']),
      (ctx, input) => checklistAbandon(ctx, as(input)),
    ),
  ];
}
