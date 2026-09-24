/**
 * B01's thirteen verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `projectActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Ten writes (the entry lifecycle start/stop/log/update/delete, the timesheet chain
 * submit/approve/lock, and the rate-card pair upsert/end) and three reads (the timesheet list, the
 * OP1 rate resolution, and the rate-card register). Every write carries `workspaceId` + an
 * idempotency key; the sign-off pair gates on A24 `time.approve`, the rest of the entry lifecycle
 * on `time.write`, and the rate cards on `manage_master_data` (billing master data, the D00
 * price-list precedent). B01 POSTS NOTHING: time is pre-financial, and the one money-ish figure
 * (`billableMinor` on `time_list`) is derived round-once at read from the snapshotted rate.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  timeStart,
  timeStop,
  timeLog,
  timeUpdate,
  timeDelete,
  timeSubmit,
  timeApprove,
  timeLock,
  timeList,
  timeResolveRate,
  rateCardUpsert,
  rateCardEnd,
  rateCardList,
} from '../core/time/index.js';

export interface TimeActionHelpers {
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

/** The patch `time_update` accepts: the editable half of an entry, validated in the engine. */
const TIME_ENTRY_PATCH_FIELDS = {
  minutes: { type: 'integer' },
  billable: { type: 'boolean' },
  notes: { type: 'string' },
  startedAt: { type: 'string' },
  projectId: { type: 'string' },
  phaseId: { type: 'string' },
} as const;

/** The B01 verbs, in append order. */
export function timeActions(h: TimeActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'time_start',
      'write',
      'Starte einen Timer auf einem Projekt (B00): creates an open time_entry with started_at now and the rate snapshotted through resolveRate (OP1: client, then project, then employee, then default card). One running timer per user (timer_already_running names the running entry); with no valid rate card it refuses with no_rate_defined rather than minting a 0-rate entry.',
      ctxSchema(
        { userId: STR, projectId: STR, phaseId: STR, notes: STR, billable: BOOL, idempotencyKey: STR },
        ['userId', 'projectId'],
      ),
      (ctx, input) => timeStart(ctx, as(input)),
    ),
    ctxAction(
      'time_stop',
      'write',
      'Stoppe den laufenden Timer: stamps ended_at and computes the full elapsed minutes, midnight crossings included (the entry keeps its started_at day; day-splitting is a report concern). The entry stays status open and editable.',
      ctxSchema({ entryId: STR, idempotencyKey: STR }, ['entryId']),
      (ctx, input) => timeStop(ctx, as(input)),
    ),
    ctxAction(
      'time_log',
      'write',
      'Erfasse Zeit manuell (nachtragen): a finished entry with startedAt and minutes (1 to 1440), billable by default, priced by the rate card valid on the entry day (OP1 snapshot; no_rate_defined with no card, invalid_minutes outside the bound).',
      ctxSchema(
        {
          userId: STR,
          projectId: STR,
          phaseId: STR,
          startedAt: STR,
          minutes: INT,
          billable: BOOL,
          notes: STR,
          idempotencyKey: STR,
        },
        ['userId', 'projectId', 'startedAt', 'minutes'],
      ),
      (ctx, input) => timeLog(ctx, as(input)),
    ),
    ctxAction(
      'time_update',
      'write',
      'Bearbeite einen Zeiteintrag from a patch (minutes, billable, notes, startedAt, projectId, phaseId): allowed while open or submitted; from approval onward the record is frozen and refuses with entry_locked. Re-pointing to another project re-resolves the rate snapshot at the entry own capture day; a later rate-card edit never reprices captured time.',
      ctxSchema(
        { entryId: STR, patch: { type: 'object', properties: TIME_ENTRY_PATCH_FIELDS }, idempotencyKey: STR },
        ['entryId', 'patch'],
      ),
      (ctx, input) => timeUpdate(ctx, as(input)),
    ),
    ctxAction(
      'time_delete',
      'write',
      'Lösche einen Zeiteintrag: allowed while open or submitted only; approved, locked or billed time is an ArG working-time record and refuses with entry_locked.',
      ctxSchema({ entryId: STR, idempotencyKey: STR }, ['entryId']),
      (ctx, input) => timeDelete(ctx, as(input)),
    ),
    ctxAction(
      'time_submit',
      'write',
      'Reiche die Zeit einer Periode ein (YYYY-MM, optional one project): every finished open entry of the period moves open to submitted; a period with nothing open refuses with nothing_to_submit. A still-running timer is not swept up.',
      ctxSchema({ period: STR, projectId: STR, idempotencyKey: STR }, ['period']),
      (ctx, input) => timeSubmit(ctx, as(input)),
    ),
    ctxAction(
      'time_approve',
      'write',
      'Gib eingereichte Zeiteinträge frei (Freigeben): the named submitted entries move to approved, stamped with the approving session actor. All-or-nothing: an unknown id or a non-submitted entry refuses the whole call. Gated on the A24 time.approve capability.',
      ctxSchema({ entryIds: { type: 'array', items: STR }, idempotencyKey: STR }, ['entryIds']),
      (ctx, input) => timeApprove(ctx, as(input)),
    ),
    ctxAction(
      'time_lock',
      'write',
      'Sperre eine Periode (YYYY-MM, optional one project): every approved entry of the period moves to locked, the immutable ArG working-time record billing (B02) reads from. Nothing approved refuses with nothing_to_lock. Gated on the A24 time.approve capability.',
      ctxSchema({ period: STR, projectId: STR, idempotencyKey: STR }, ['period']),
      (ctx, input) => timeLock(ctx, as(input)),
    ),
    ctxAction(
      'time_list',
      'read',
      'The timesheet read model (P5): entries filtered by project, user, status, billable, unbilled (everything not yet billed) or a started_at range, plus { totalMinutes, billableMinor } with the money figure derived round-once from each entry snapshotted rate, never stored. This slice (status approved, billable, unbilled) is B02 invoicing input. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({
        projectId: STR,
        userId: STR,
        status: STR,
        billable: BOOL,
        unbilled: BOOL,
        from: STR,
        to: STR,
        savedViewId: STR,
      }),
      (ctx, input) => timeList(ctx, as(input)),
    ),
    ctxAction(
      'time_resolve_rate',
      'read',
      'Resolve which hourly rate WOULD price time for a user/project/client at a date (OP1, the single resolver): answers the winning card (rateMinor, currency, sourceScope, rateCardId) by precedence client, project, employee, default, or no_rate_defined when no card is valid at that day.',
      ctxSchema({ userId: STR, projectId: STR, contactId: STR, at: STR }),
      (ctx, input) => timeResolveRate(ctx, as(input)),
    ),
    ctxAction(
      'rate_card_upsert',
      'write',
      'Lege einen Tarif an (rate card): scope default, employee, project or client (scoped cards name their scopeRef), integer-Rappen rateMinor, valid from a day. costRateMinor is the optional INTERNAL cost rate (same currency) that values the B03 Projekterfolg cost basis; entries snapshot it at capture like the bill rate, and without one the cost basis degrades honestly (basisDegraded). A new card for the same scope VERSIONS the previous one: the open predecessor is end-dated at the new validFrom and its rate is never mutated, so snapshotted entries keep their price (OP1). Overlapping validity refuses with rate_card_overlap.',
      ctxSchema(
        { scope: STR, scopeRef: STR, rateMinor: INT, costRateMinor: INT, currency: STR, validFrom: STR, idempotencyKey: STR },
        ['scope', 'rateMinor', 'validFrom'],
      ),
      (ctx, input) => rateCardUpsert(ctx, as(input)),
    ),
    ctxAction(
      'rate_card_end',
      'write',
      'Beende einen Tarif ohne Nachfolger (a client override lapses): writes valid_to on an open card. An already-ended card refuses with rate_card_already_ended; validTo must be after validFrom.',
      ctxSchema({ rateCardId: STR, validTo: STR, idempotencyKey: STR }, ['rateCardId', 'validTo']),
      (ctx, input) => rateCardEnd(ctx, as(input)),
    ),
    ctxAction(
      'rate_card_list',
      'read',
      'List the rate cards (P5): every version with scope, scopeRef, rateMinor, currency and validity, optionally one scope or only the cards active at a day.',
      ctxSchema({ scope: STR, activeAt: STR }),
      (ctx, input) => rateCardList(ctx, as(input)),
    ),
  ];
}
