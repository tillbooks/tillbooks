/**
 * J06's nine inventory valuation-run / reconciliation verbs (4 writes + 5 reads), defined here and
 * spread into `ACTIONS` as ONE line (the `valuationActions` / `landedCostActions` precedent), so
 * several agents appending to the append-only registry at once collide over a line rather than a block.
 *
 * As with `valuation-actions.ts`, the engine helpers arrive as an import and the registry helpers as a
 * parameter, so the module graph stays acyclic. Every field is camelCase and maps straight through to
 * the engine verb.
 *
 * THE MONEY PATH IS THE FOUR WRITES. `inventory_valuation_create` computes and stores a DRAFT (no
 * journal); `_post` books the delta to the GL through A02, `_reverse` mirrors it, `_opening` posts a
 * migration baseline. There is no second posting path: the figure reaches the books here and nowhere
 * else. The five reads (get, list, report, reconciliation_report, reconciliation_check) write nothing;
 * `reconciliation_check` is the hard gate a period close calls and returns a structured drift or
 * valuation_missing error when the sub-ledger and the GL disagree.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  inventoryValuationCreate,
  inventoryValuationPost,
  inventoryValuationReverse,
  inventoryValuationOpening,
  inventoryValuationGet,
  inventoryValuationList,
  inventoryValuationReport,
  inventoryReconciliationReport,
  inventoryReconciliationCheck,
} from '../core/inventory/index.js';

export interface ValuationRunActionHelpers {
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

/** The J06 verbs, in append order (four money-path writes, then five reads). */
export function valuationRunActions(h: ValuationRunActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  const NRV_MAP = { type: 'object', additionalProperties: INT } as const;
  const OPENING_LINE = {
    type: 'object',
    properties: {
      itemId: STR,
      locationId: STR,
      qty: INT,
      valueRappen: INT,
    },
    required: ['itemId', 'qty', 'valueRappen'],
  } as const;

  return [
    ctxAction(
      'inventory_valuation_create',
      'write',
      'Create a DRAFT inventory valuation run for a cut-off (asOf ISO date, or period YYYY-MM for the period end) and return it with its proposed adjusting journal for review. Computes the FULL inventory valuation through the J03 engine (each item under the method in force on that date), writes one immutable line per (item, location) that carries a quantity or a value, and stores the run total. Posts NO journal: that is inventory_valuation_post. netRealisableValues maps itemId to the OR 960c per-unit Veraeusserungswert less costs to come; where it is below cost the J03 clamp writes the line down and marks it. inventoryAccountId / changeAccountId override the default 1200 / 4200 control accounts. A run always values the complete position (a filtered run cannot hold the sub-ledger = GL identity; use inventory_valuation_report for a filtered view). A cut-off in a soft- or hard-closed period is refused with period_locked before anything is written. Idempotent: a replay of the key returns the same draft and recomputes nothing.',
      ctxSchema(
        {
          asOf: STR,
          period: STR,
          method: STR,
          netRealisableValues: NRV_MAP,
          inventoryAccountId: STR,
          changeAccountId: STR,
          notes: STR,
          idempotencyKey: STR,
        },
        ['idempotencyKey'],
      ),
      (ctx, input) => inventoryValuationCreate(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_post',
      'write',
      'Post a reviewed DRAFT run so the balance-sheet inventory figure is updated in one atomic, auditable step. In one transaction it re-checks the cut-off period is open and the draft is not stale (the movement ledger has not changed since it was calculated, else stale_draft), computes the delta between the sub-ledger valuation and the current GL balance of each control account, posts ONE balanced A02 entry (source inventory_valuation, Dr/Cr inventory control vs the change account) for that delta, and marks the run posted with its journal reference. After the post the OP11 identity holds: GL inventory control balance equals the sub-ledger valuation at the cut-off. All posting is through A02 postEntry and no second path exists. Idempotent on rows: a replay returns the posted run and mints no second journal. A zero delta posts nothing yet records the baseline.',
      ctxSchema({ runId: STR, changeAccountId: STR, idempotencyKey: STR }, ['runId', 'idempotencyKey']),
      (ctx, input) => inventoryValuationPost(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_reverse',
      'write',
      'Reverse a posted valuation run. Posts the exact A02 mirror of the run journal via reverseEntry (which moves the GL back by the delta and restores the baseline every later run measures against), marks the original run reversed and records the reversing journal. The original run and its journal are never mutated: a correction is a reverse plus a fresh run. A reason is required. Idempotent: a replay returns the already-reversed run and posts no second compensation. A run that posted no journal (zero delta) is marked reversed with nothing to reverse.',
      ctxSchema({ runId: STR, reason: STR, idempotencyKey: STR }, ['runId', 'reason', 'idempotencyKey']),
      (ctx, input) => inventoryValuationReverse(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_opening',
      'write',
      'Record an OPENING inventory valuation for a migration or a new workspace so the sub-ledger = GL identity holds from day one. The caller states the known item values directly (lines of itemId, optional locationId, qty and valueRappen), and the verb posts the opening delta against the current GL through A02 exactly as an ordinary run does, writing a posted run in one step (no draft review: an opening baseline is a stated figure, not a computed one). inventoryAccountId / changeAccountId override the default 1200 / 4200. A cut-off in a locked period is refused before any write. Idempotent on the key.',
      ctxSchema(
        {
          asOf: STR,
          lines: { type: 'array', items: OPENING_LINE },
          inventoryAccountId: STR,
          changeAccountId: STR,
          notes: STR,
          idempotencyKey: STR,
        },
        ['asOf', 'lines', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryValuationOpening(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_get',
      'read',
      'One valuation run by id, with its header (as_of, method, status, total value, delta posted, journal link, posted-by) and its frozen lines (item, location, qty, unit cost, value, control account, any OR 960c write-down). A foreign or unknown run id is not_found (H-TENANT), never cross-tenant data.',
      ctxSchema({ runId: STR }, ['runId']),
      (ctx, input) => inventoryValuationGet(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_list',
      'read',
      'The valuation runs for this workspace, newest cut-off first: id, as_of, method, status, total value, delta, line count and journal link. Filter by status (draft, posted, reversed), and by an as_of from/to date range. Tenant-scoped; returns headers only (use inventory_valuation_get for the lines).',
      ctxSchema({ status: STR_ARRAY, from: STR, to: STR, limit: INT }),
      (ctx, input) => inventoryValuationList(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_report',
      'read',
      'The authoritative detailed valuation report: the single source of truth for what inventory is worth at a cut-off. With runId it returns the FROZEN lines of that posted run; otherwise it computes the LIVE valuation at asOf (or period end) through the J03 engine, grouped by control account, with each line item, location, quantity, unit cost and value plus any OR 960c write-down. Optional accountIds narrows the account grouping; method projects a what-if under another method; netRealisableValues applies the lower-of-cost-or-market clamp. Writes nothing.',
      ctxSchema(
        {
          asOf: STR,
          period: STR,
          runId: STR,
          method: STR,
          groupBy: STR_ARRAY,
          accountIds: STR_ARRAY,
          netRealisableValues: NRV_MAP,
        },
      ),
      (ctx, input) => inventoryValuationReport(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reconciliation_report',
      'read',
      'The OP11 reconciliation: per inventory control account, the live sub-ledger valuation at the cut-off (period YYYY-MM or asOf date), the GL balance of the same account at the same cut-off, the delta between them, and a status of balanced (delta 0), drift (a delta remains though a run was posted at the cut-off, e.g. an external GL-only posting) or unposted (the live valuation differs from the GL and no run has closed the gap; the delta is what a new run would post). Returns balanced/drift/unposted counts and the total unposted delta. Optional accountIds narrows the accounts. Writes nothing.',
      ctxSchema({ period: STR, asOf: STR, accountIds: STR_ARRAY }),
      (ctx, input) => inventoryReconciliationReport(ctx, as(input)),
    ),
    ctxAction(
      'inventory_reconciliation_check',
      'read',
      'The hard reconciliation check a period close calls before it hard-locks a period (YYYY-MM). Returns { status: balanced } when a valuation has been posted at the period end and every inventory control account shows delta 0. Returns a structured valuation_missing error when a non-zero inventory value exists at the period end but no run was ever posted, or a reconciliation_drift error listing the offending accounts and amounts when a delta remains. The period cannot be hard-locked until the difference is explained or a corrective valuation is posted and re-checked. Writes nothing.',
      ctxSchema({ period: STR }, ['period']),
      (ctx, input) => inventoryReconciliationCheck(ctx, as(input)),
    ),
  ];
}
