/**
 * C01's nine verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `taskActions` / `contactActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * The eight writes are the pipeline lifecycle (create, update, move, mark, log, convert) plus the
 * §6b configuration pair (pipelines, stages); the one read is the whole board (`deals_list`, P5).
 * REST twins ride the shared registry automatically, as for every other verb.
 *
 * TWO VERBS HOLD AN `ActionInvoker`, which is why `invokerFor` rides along (the G01/A12/A26
 * handshake): `deals_to_quote` reaches the quote-creation verb through the shared dispatch, and
 * `deals_log_activity`'s reminder half reaches `tasks_create` the same way. Both replay as the
 * CALLING actor, so the delegated verb's own A24 gate is re-checked live and C01 can never launder
 * a capability. `assertActionInvokersAreGated` is called over both at module load, the same
 * handshake `run_due_recurring` and `approve_drafted_action` make.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import type { ActionInvoker } from '../core/automation/index.js';
import { assertActionInvokersAreGated } from '../core/access/index.js';
import {
  createDeal,
  updateDeal,
  moveDeal,
  markDeal,
  logDealActivity,
  listDeals,
  dealToQuote,
  upsertPipeline,
  upsertPipelineStage,
} from '../core/deals/index.js';

export interface DealActionHelpers {
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

/** The patch `deals_update` accepts: the editable half of a deal, validated in the engine. */
const DEAL_PATCH_FIELDS = {
  title: { type: 'string' },
  contactId: { type: 'string' },
  valueMinor: { type: 'integer' },
  currency: { type: 'string' },
  expectedCloseOn: { type: 'string' },
  probability: { type: 'integer' },
} as const;

/** The C01 verbs, in append order. */
export function dealActions(h: DealActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, invokerFor, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'deals_create',
      'write',
      'Lege einen Deal an: a sales opportunity on a C00 contact with an integer-Rappen value, born open in the first open stage of its pipeline (the first write seeds the default funnel Lead, Qualifiziert, Offerte, Gewonnen, Verloren when none exists). A non-base currency is converted ONCE at capture through the §H-FX resolver and frozen on the row (valueBaseMinor + fxRate, never client inputs); the creation lands on the contact timeline (OP5). A deal never posts: its value is an estimate, not a ledger row.',
      ctxSchema(
        {
          contactId: STR,
          title: STR,
          valueMinor: INT,
          currency: STR,
          pipelineId: STR,
          stageId: STR,
          expectedCloseOn: STR,
          idempotencyKey: STR,
        },
        ['contactId', 'title', 'valueMinor'],
      ),
      (ctx, input) => createDeal(ctx, as(input)),
    ),
    ctxAction(
      'deals_update',
      'write',
      'Bearbeite einen offenen Deal from a patch: retitle, re-point the contact, reschedule the expected close, or pin a manual probability (which stage moves then stop re-defaulting). A patch naming valueMinor or currency re-runs the §H-FX capture and re-freezes valueBaseMinor + fxRate; any other patch leaves the frozen trio byte-identical. A closed deal refuses with deal_closed: reopen it through deals_mark first.',
      ctxSchema(
        { dealId: STR, patch: { type: 'object', properties: DEAL_PATCH_FIELDS }, idempotencyKey: STR },
        ['dealId', 'patch'],
      ),
      (ctx, input) => updateDeal(ctx, as(input)),
    ),
    ctxAction(
      'deals_move',
      'write',
      'Verschiebe einen Deal in eine andere Phase of its own pipeline: updates the stage, re-defaults the probability to the target stage unless a hand pinned it, and logs the move on the contact timeline (OP5). A stage outside the deal pipeline refuses with stage_not_in_pipeline; a stage flagged won/lost refuses with terminal_stage_use_mark, because deals_mark is the ONE door to a terminal status. Emits deal.stage_changed.',
      ctxSchema({ dealId: STR, stageId: STR, idempotencyKey: STR }, ['dealId', 'stageId']),
      (ctx, input) => moveDeal(ctx, as(input)),
    ),
    ctxAction(
      'deals_mark',
      'write',
      'Schliesse einen Deal ab oder öffne ihn wieder: the ONE door to status. won moves the deal into the pipeline outcome stage at probability 100; lost requires a lostReason (lost_reason_required otherwise) and lands at 0; open reopens a misclicked deal into the first open stage. A no-change re-mark is a state assertion and emits nothing; a genuine close emits deal.won or deal.lost. Every terminal move lands on the contact timeline (OP5).',
      ctxSchema({ dealId: STR, status: STR, lostReason: STR, idempotencyKey: STR }, ['dealId', 'status']),
      (ctx, input) => markDeal(ctx, as(input)),
    ),
    // Holds an invoker for the reminder half: the E03 task is minted through the shared dispatch as
    // the calling actor, so tasks_create's own gate and reminder validation apply unchanged.
    ctxAction(
      'deals_log_activity',
      'write',
      'Erfasse eine Aktivität auf einem Deal (note, call, email, meeting or task, the single OP5 kind enum): appends to the contact timeline through contacts_log_activity with the dealId stamped, newest-first on read. An optional reminderAt additionally mints one linked E03 task (entityKind deal) through tasks_create, so its assignee polls tasks_reminders_due like every other follow-up; a past reminder refuses with E03s own reminder_in_past. One idempotency key covers note + task together.',
      ctxSchema(
        { dealId: STR, kind: STR, body: STR, occurredAt: STR, reminderAt: STR, idempotencyKey: STR },
        ['dealId', 'kind', 'body'],
      ),
      (ctx, input, deps) => logDealActivity(ctx, invokerFor(deps), as(input)),
    ),
    ctxAction(
      'deals_list',
      'read',
      'The pipeline board in one read (P5): every pipeline for the picker, the selected pipeline stages in sort order, its deals (open only by default; includeClosed or a status filter widens), each with weightedMinor = round-once(valueBaseMinor times probability over 100), and the weightedTotalMinor over open deals in the workspace base currency, so mixed-currency funnels sum in one currency (§H-FX). C03 consumes this read; C01 does not forecast. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({
        pipelineId: STR,
        status: STR,
        contactId: STR,
        includeClosed: BOOL,
        savedViewId: STR,
      }),
      (ctx, input) => listDeals(ctx, as(input)),
    ),
    // Holds an invoker: the quote is created by the registered document verb through the shared
    // dispatch, as the caller, so A10's own gate (C02's, once it lands) is re-checked live.
    ctxAction(
      'deals_to_quote',
      'write',
      'Wandle einen Deal in eine Offerte um: delegation only (US-C01.5). Invokes the registered quote-creation verb (create_document, type quote, until C02 rebinds the seam) through the shared dispatch with the deal contact and value as the single seed line, stores the returned quote id on the deal, and logs the conversion (OP5). Idempotent on the deal: one carrying a quoteId answers it and spawns nothing. The quote verb own capability applies to the caller; C01 never bypasses it.',
      ctxSchema({ dealId: STR, idempotencyKey: STR }, ['dealId']),
      (ctx, input, deps) => dealToQuote(ctx, invokerFor(deps), as(input)),
    ),
    ctxAction(
      'pipelines_upsert',
      'write',
      'Lege eine Pipeline an oder benenne sie um (§6b, the OP10 flexible surface for pipeline shape): pass pipelineId to rename, omit it to create. The stage set itself is edited per stage through pipeline_stages_upsert.',
      ctxSchema({ pipelineId: STR, name: STR, idempotencyKey: STR }, []),
      (ctx, input) => upsertPipeline(ctx, as(input)),
    ),
    ctxAction(
      'pipeline_stages_upsert',
      'write',
      'Lege eine Phase an oder bearbeite sie (§6b): name, sort, the default probability (0 to 100, validated here, the one place a default enters), and the outcome flag (won or lost) that makes entering the stage terminal through deals_mark. Pass stageId to patch, omit it to append. The stage names are workspace data; the stage-to-status derivation stays fixed mechanism (§6b Fixed).',
      ctxSchema(
        { pipelineId: STR, stageId: STR, name: STR, sort: INT, probability: INT, outcome: STR, idempotencyKey: STR },
        ['pipelineId'],
      ),
      (ctx, input) => upsertPipelineStage(ctx, as(input)),
    ),
  ];
}

// The load-time handshake: a verb holding an invoker MUST be gated, or it is a capability-
// laundering machine by construction (the rule that would have caught G1 on day one).
assertActionInvokersAreGated(['deals_to_quote', 'deals_log_activity']);
