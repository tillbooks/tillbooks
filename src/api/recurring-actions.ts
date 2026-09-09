/**
 * A12's eight verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `purchaseActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * SIX WRITES AND TWO READS. `create_recurring_schedule` carries the key (it MINTS a schedule); the
 * four state-setting writes are ABSOLUTE and key-exempt (the conformance contract records each
 * reason); and `run_due_recurring` is SELF-KEYED: every occurrence derives
 * `recurring:<scheduleId>:<periodKey>` for the verb it invokes, so the key that must not repeat is
 * per occurrence, never per tick, exactly the `run_due_automations` exemption.
 *
 * `run_due_recurring` IS THE ONE VERB HERE THAT HOLDS AN `ActionInvoker` (G01's fire-path shape):
 * generation happens by invoking the registered `create_document` / `issue_invoice` through the
 * shared dispatch as the schedule's author, never by a second write path.
 * `assertActionInvokersAreGated` is called over it at module load, the same handshake
 * `automation-actions.ts` performs, so it can never become ungated without a crash on import.
 *
 * As with the sibling modules, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import type { ActionInvoker } from '../core/automation/index.js';
import { assertActionInvokersAreGated } from '../core/access/index.js';
import {
  createRecurringSchedule,
  updateRecurringSchedule,
  pauseRecurringSchedule,
  resumeRecurringSchedule,
  endRecurringSchedule,
  listRecurringSchedules,
  getRecurringSchedule,
  runDueRecurring,
} from '../core/recurring/index.js';

export interface RecurringActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** Builds the invoker that reaches the shared dispatch. Supplied by `registry.ts`, which owns it. */
  invokerFor(deps: ApiDeps): ActionInvoker;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The A12 verbs, in append order. */
export function recurringActions(h: RecurringActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, invokerFor, STR, INT, BOOL } = h;

  /**
   * The template positions: the line shape `create_document` accepts (P2, integer Rappen), MINUS
   * `supplyDate`. The Leistungsdatum is an occurrence-specific fact and the tick is its single
   * writer; the engine's whitelist additionally strips one that arrives anyway, because this
   * boundary is `additionalProperties: true` repo-wide (critic probe C9).
   */
  const LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        itemId: STR,
        description: STR,
        quantityMilli: INT,
        unitPriceMinor: INT,
        taxCode: STR,
      },
      required: ['unitPriceMinor'],
    },
  } as const;

  const actions: readonly ActionDef[] = [
    ctxAction(
      'create_recurring_schedule',
      'write',
      'Lege eine Serienrechnung an (a recurring invoice schedule): the template (contact + positions, or templateDocumentId to snapshot an existing document), the cadence (interval monthly|quarterly|yearly|custom with customDays, anchorDate ISO YYYY-MM-DD), and optionally endDate, maxOccurrences, dueDays payment terms and autoIssue. Nothing is invoiced yet: run_due_recurring materialises each due period, as a review draft unless autoIssue is on (P8). The template is SNAPSHOTTED, never a live link, and never stores a supply date: the tick stamps each generated line with its own period as the Leistungsdatum.',
      ctxSchema(
        {
          name: STR,
          contactId: STR,
          lines: LINES,
          templateDocumentId: STR,
          currency: STR,
          notes: STR,
          dueDays: INT,
          interval: STR,
          customDays: INT,
          anchorDate: STR,
          endDate: STR,
          maxOccurrences: INT,
          autoIssue: BOOL,
          idempotencyKey: STR,
        },
        ['interval', 'anchorDate', 'idempotencyKey'],
      ),
      (ctx, input) => createRecurringSchedule(ctx, as(input)),
    ),
    ctxAction(
      'update_recurring_schedule',
      'write',
      'Patch a schedule: template, cadence, bounds or autoIssue, as absolute values. Changes affect only FUTURE generations; already produced invoices are A10/A11 documents and stay untouched. A cadence change (interval, customDays, anchorDate) restarts the series at the next occurrence on or after today. An ended schedule refuses with schedule_ended; an end date before the anchor refuses with end_before_anchor.',
      ctxSchema({ scheduleId: STR, patch: { type: 'object' } }, ['scheduleId', 'patch']),
      (ctx, input) => updateRecurringSchedule(ctx, as(input)),
    ),
    ctxAction(
      'pause_recurring_schedule',
      'write',
      'Pause a schedule: the tick stops selecting it, immediately. Already paused settles to the same answer; an ended schedule refuses with schedule_ended.',
      ctxSchema({ scheduleId: STR }, ['scheduleId']),
      (ctx, input) => pauseRecurringSchedule(ctx, as(input)),
    ),
    ctxAction(
      'resume_recurring_schedule',
      'write',
      'Resume a paused schedule. Periods that fell due while paused are generated by the next tick (each period separately idempotent, at most 24 per schedule per tick), which is the accepted cost D66 states. Already active settles to the same answer; ended refuses with schedule_ended.',
      ctxSchema({ scheduleId: STR }, ['scheduleId']),
      (ctx, input) => resumeRecurringSchedule(ctx, as(input)),
    ),
    ctxAction(
      'end_recurring_schedule',
      'write',
      'End a schedule for good: `ended` is terminal and cannot be resumed (create a new schedule instead). Ending an already ended schedule settles to the same answer. Generated invoices are untouched.',
      ctxSchema({ scheduleId: STR }, ['scheduleId']),
      (ctx, input) => endRecurringSchedule(ctx, as(input)),
    ),
    // The one A12 verb holding an invoker: registered through the same handshake G01 uses, below.
    ctxAction(
      'run_due_recurring',
      'write',
      "The tick for Serienrechnungen: settle every due period of every active schedule at asOf (default now; a future asOf is refused; a past one only bounds how far the catch-up reaches, it never dates anything). Each occurrence INVOKES the registered create_document, and issue_invoice when the schedule has autoIssue, through the shared dispatch as the schedule AUTHOR, with a key derived from (scheduleId, periodKey), so a re-tick never double-bills (§H-IDEMPOTENT on rows). Every generated line carries its period as the Leistungsdatum, so a catch-up bills each period at its own VAT era; the due date is the clock day plus dueDays. A locked target period keeps the draft, records skipped_locked and is retried after unlock (§H-PERIOD); a waiting draft a human has since ISSUED settles the period as issued, and one a human has since CANCELLED settles it as discarded, so both operator responses converge and neither can strand a schedule or its siblings. Catch-up generates each missed period, at most 24 per schedule per tick.",
      ctxSchema({ asOf: STR }),
      (ctx, input, deps) => runDueRecurring(ctx, invokerFor(deps), as(input)),
    ),
    ctxAction(
      'list_recurring_schedules',
      'read',
      'List the Serienrechnungen with their cadence, next run, occurrence count, status and the LAST run outcome (so a permanently failing schedule is visible on the list, not only in its history), newest first, filtered by status or contact. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({ status: STR, contactId: STR, savedViewId: STR }),
      (ctx, input) => listRecurringSchedules(ctx, as(input)),
    ),
    ctxAction(
      'get_recurring_schedule',
      'read',
      'Read one schedule in full: its snapshotted template, cadence and bounds, plus the run log (every generated period with its outcome and, where the document still exists, its number and status), which is where a generated invoice states its provenance.',
      ctxSchema({ scheduleId: STR }, ['scheduleId']),
      (ctx, input) => getRecurringSchedule(ctx, as(input)),
    ),
  ];

  // The load-time handshake (A24): a verb that can invoke another verb as a different actor may
  // never be ungated. The fact is supplied here, the rule lives in `actionCapabilities.ts`.
  assertActionInvokersAreGated(['run_due_recurring']);
  return actions;
}
