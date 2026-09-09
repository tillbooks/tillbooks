/**
 * B04's seven verbs, defined here and spread into `ACTIONS` as one line (the `billingActions` /
 * `timeActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * Five writes (`retainer_create/update/close/generate_invoice/run_due`) gate on A24 `retainer.manage`;
 * two reads (`retainer_burndown/list`) on `billing.read`. B04 POSTS NOTHING: generation delegates to
 * A10 `createDocument` (a draft), and A11 -> A02 own the only journal entry, at issue (P3, P8
 * draft-only output). `retainer_run_due` is self-keyed (its idempotency is the per-period fee-draw
 * guard, the `run_due_recurring` shape), so it declares NO idempotencyKey and is listed in the
 * conformance gate's `IDEMPOTENCY_KEY_EXEMPT`.
 *
 * As with `billing-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createRetainer,
  updateRetainer,
  closeRetainer,
  listRetainers,
  generateInvoice,
  runDue,
  burnDown,
} from '../core/retainers/index.js';

export interface RetainerActionHelpers {
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

/** The B04 verbs, in append order. */
export function retainerActions(h: RetainerActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'retainer_create',
      'write',
      'Mandat anlegen (B04): define a recurring retainer for a C00 contact (monthly|quarterly fee, included hours, optional cap, rollover). Validates feeRappen>0 (invalid_fee) and includedHours>=0 (invalid_hours) as structured refusals (P9). Returns warning:cap_below_included when the cap undercuts the included hours at the resolved rate (OP1), never an error. Mints an active retainer; posts nothing. Gated on A24 retainer.manage.',
      ctxSchema(
        {
          contactId: STR,
          projectId: STR,
          period: STR,
          feeRappen: INT,
          includedHours: INT,
          capRappen: INT,
          rollover: BOOL,
          currency: STR,
          startsOn: STR,
          idempotencyKey: STR,
        },
        ['contactId', 'period', 'feeRappen', 'startsOn', 'idempotencyKey'],
      ),
      (ctx, input) => createRetainer(ctx, as(input)),
    ),
    ctxAction(
      'retainer_update',
      'write',
      'Mandat bearbeiten (B04): patch a retainer. Coverage terms (feeRappen, includedHours, capRappen, rollover) apply to FUTURE periods only, which is structural: a generated period stored its own draws and generation reads the row live, so an edit never rewrites history. The identity fields (period, contactId, projectId) freeze once any draw exists (retainer_has_draws). Gated on A24 retainer.manage.',
      ctxSchema({ retainerId: STR, patch: { type: 'object' }, idempotencyKey: STR }, ['retainerId', 'idempotencyKey']),
      (ctx, input) => updateRetainer(ctx, as(input)),
    ),
    ctxAction(
      'retainer_close',
      'write',
      'Mandat beenden (B04): end a mandate (active to ended). OR 404 Abs. 1 makes a mandate terminable at any time, so close is always reachable: it refuses period_pending only while a closed period is still unbilled, and skipFinal:true overrides even that. Closing an already-ended retainer settles to the same answer (idempotent). Gated on A24 retainer.manage.',
      ctxSchema({ retainerId: STR, skipFinal: BOOL, idempotencyKey: STR }, ['retainerId', 'idempotencyKey']),
      (ctx, input) => closeRetainer(ctx, as(input)),
    ),
    ctxAction(
      'retainer_generate_invoice',
      'write',
      'Rechnung erzeugen (B04): turn one ENDED retainer period into an A11 invoice DRAFT (one Pauschale line plus one Zusatzaufwand line per over-cap entry), record the drawdown ledger, flip consumed B01 time to billed, and mint the rollover carryover rows, all in one transaction. Delegates to A10 createDocument (P3: no journal entry, no VAT amount, no total minted here). Idempotent per period by the (retainer, period, fee) uniqueness guard: a period already invoiced returns the existing draft with existing:true. Refuses period_not_closed, retainer_not_active, invalid_period_key, currency_mismatch before any write. Always stops at a draft (P8); gated on A24 retainer.manage.',
      ctxSchema({ retainerId: STR, periodKey: STR, actor: STR, idempotencyKey: STR }, ['retainerId', 'periodKey', 'idempotencyKey']),
      (ctx, input) => generateInvoice(ctx, as(input)),
    ),
    ctxAction(
      'retainer_run_due',
      'write',
      'Alle fälligen abrechnen (B04): bill every active retainer whose period ended before asOf, iterating the retainer table directly (never an A12 recurring_schedule). SELF-KEYED (no idempotencyKey): idempotent per period via the (retainer, period, fee) uniqueness guard, so re-running the tick at any cadence bills each period exactly once; each period is its own transaction. Agent/scheduler/bulk-action oriented. Gated on A24 retainer.manage; denylisted from automation (a bulk generation tick a human or cron owns).',
      ctxSchema({ asOf: STR, actor: STR }),
      (ctx, input) => runDue(ctx, as(input)),
    ),
    ctxAction(
      'retainer_burndown',
      'read',
      'Mandats-Verbrauch (B04): the drawdown/burn-down read model (P5), computed live, never a cached counter. Returns includedMinutes, carryoverInMinutes, consumedMinutes, coveredMinutes, remainingMinutes, coverageValueRappen, capRappen and overCapMinutes for a period. For a generated period it reads the frozen draw ledger; for the current in-flight period it simulates the coverage split over live approved time. An unknown retainerId returns retainer_not_found. Gated on A24 billing.read.',
      ctxSchema({ retainerId: STR, periodKey: STR }, ['retainerId']),
      (ctx, input) => burnDown(ctx, as(input)),
    ),
    ctxAction(
      'retainer_list',
      'read',
      'Mandate anzeigen (B04): the Mandate list (P5), tenant-scoped, filterable by contactId and status, with the G00 saved-view seam (OP10, savedViewId). Gated on A24 billing.read.',
      ctxSchema({ contactId: STR, status: STR, savedViewId: STR }),
      (ctx, input) => listRetainers(ctx, as(input)),
    ),
  ];
}
