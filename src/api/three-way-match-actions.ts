/**
 * I04's eight three-way-match verbs (3 writes + 5 reads), defined here and spread into `ACTIONS` as
 * ONE line (the `receiptActions` / `requisitionActions` / `movementActions` precedent), so several
 * agents appending to the append-only registry at once collide over a line rather than a block.
 *
 * As with `receipt-actions.ts`, the registry helpers arrive as a parameter rather than an import, so
 * the module graph stays acyclic: `registry.ts` imports this file and this file must not import it
 * back. Every field is camelCase and maps straight through to the engine verb. The three writes carry
 * `idempotencyKey` (§H-IDEMPOTENT); the five reads advertise `readOnlyHint`.
 *
 * I04 posts NOTHING: these verbs gate payment and increment `po_line.billed_qty`, but the bill's own
 * expense/Vorsteuer posting stays A17 -> A02.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  matchThreeWayEvaluate,
  matchThreeWayCreate,
  matchThreeWayOverride,
  matchThreeWayReverse,
  matchThreeWayGet,
  matchThreeWayList,
  matchThreeWayExceptions,
  matchStatusForBill,
} from '../core/procurement/index.js';

export interface ThreeWayMatchActionHelpers {
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

const OBJ = { type: 'object' } as const;

/** The I04 verbs, in append order (the three writes, then the five reads). */
export function threeWayMatchActions(h: ThreeWayMatchActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  const STR_OR_LIST = { anyOf: [{ type: 'string' }, { type: 'array', items: STR }] } as const;

  return [
    ctxAction(
      'match_three_way_create',
      'write',
      'AGENT-FIRST. Persist a three-way match for a vendor bill (A17) against its purchase order (I01) and goods receipts (I02) when the evaluation is inside tolerance. Pass poId to pin the SAME candidate PO the evaluation was run against; otherwise the supplier oldest open PO is chosen, so an evaluate pinned to one PO and a create with no poId can land against a different PO. The engine RE-COMPUTES the evaluation under a row guard (the evaluation snapshot passed in is stored for audit but never trusted for the decision), writes an immutable match header + one line per PO line, increments billed_qty on every matched PO line exactly once, and marks the consumed I02 receipt lines. It POSTS NOTHING: the bill posting stays A17 -> A02. Refused when there is no candidate PO (no_candidate_po), nothing is open to bill (nothing_received), the bill has no CHF base figure yet (bill_not_convertible), the evaluation is out of tolerance (out_of_tolerance: use match_three_way_override), or the bill already has an active match (match_already_exists). allowPartial defaults to the workspace policy. Idempotent under idempotencyKey. Needs the purchasing.match capability.',
      ctxSchema({ billId: STR, poId: STR, evaluation: OBJ, allowPartial: BOOL, idempotencyKey: STR }, ['billId', 'idempotencyKey']),
      (ctx, input) => matchThreeWayCreate(ctx, as(input)),
    ),
    ctxAction(
      'match_three_way_override',
      'write',
      'Force a match on an out-of-tolerance evaluation with a MANDATORY reason (min 5 chars). Pass poId to pin the SAME candidate PO the evaluation was run against; otherwise the supplier oldest open PO is chosen. Writes a permanent match header with status overridden, the reason and the overriding actor, and still increments billed_qty and marks the receipt lines. An override without a reason is refused (reason_required). The override is permanent: it can only ever be undone by match_three_way_reverse, never silently turned back into a clean match. Refused with no_candidate_po / nothing_received / bill_not_convertible / match_already_exists exactly as create. Idempotent under idempotencyKey. Needs BOTH purchasing.match AND purchasing.match_override.',
      ctxSchema({ billId: STR, poId: STR, evaluation: OBJ, reason: STR, idempotencyKey: STR }, ['billId', 'reason', 'idempotencyKey']),
      (ctx, input) => matchThreeWayOverride(ctx, as(input)),
    ),
    ctxAction(
      'match_three_way_reverse',
      'write',
      'Reverse a matched / partial / overridden match when a material error is found. Writes a compensating record (status reversed) linked to the original, restores billed_qty on every affected PO line to its exact pre-match value, and un-marks the I02 receipt lines. It never mutates the original header or its lines (§H-AUDIT) beyond stamping the one-way reverse link. A reversed match cannot be re-activated: a fresh evaluate + create is required. A non-empty reason (min 5 chars) is mandatory (reason_required); a match that is already reversed or in a non-reversible state is refused (match_not_reversible). Idempotent under idempotencyKey. Needs the purchasing.match_override capability.',
      ctxSchema({ matchId: STR, reason: STR, idempotencyKey: STR }, ['matchId', 'reason', 'idempotencyKey']),
      (ctx, input) => matchThreeWayReverse(ctx, as(input)),
    ),
    ctxAction(
      'match_three_way_evaluate',
      'read',
      'PURE. Evaluate (never write) a three-way match for a vendor bill against its purchase order and goods receipts. Returns a structured MatchEvaluation: per PO line the ordered / received / already-billed / open-for-billing quantities, the PO unit price and extended value, the quantity variance and a line status; and at the header the summed expected value, the bill base-net that was billed, the aggregate price / value variance, the exact tolerances applied and an overall status suggestion (matched | partial | variance | nothing_received | no_candidate_po). Pass poId to pin the candidate; otherwise the supplier oldest open PO is chosen. Callable repeatedly; it writes no rows.',
      ctxSchema({ billId: STR, poId: STR, receiptIds: STR_ARRAY, asOf: STR }, ['billId']),
      (ctx, input) => matchThreeWayEvaluate(ctx, as(input)),
    ),
    ctxAction(
      'match_three_way_get',
      'read',
      'Fetch one persisted three-way match: the header, its per-PO-line rows, and the stored evaluation snapshot (the exact numbers the GUI showed when the match was accepted).',
      ctxSchema({ matchId: STR }, ['matchId']),
      (ctx, input) => matchThreeWayGet(ctx, as(input)),
    ),
    ctxAction(
      'match_three_way_list',
      'read',
      'List persisted three-way matches, newest first, filtered by billId, poId, status (one value or a list) and a created-at from / to window.',
      ctxSchema({ billId: STR, poId: STR, status: STR_OR_LIST, from: STR, to: STR }, []),
      (ctx, input) => matchThreeWayList(ctx, as(input)),
    ),
    ctxAction(
      'match_three_way_exceptions',
      'read',
      'The open exception list for prioritisation or human hand-off: posted, unmatched vendor bills whose live evaluation is variance or nothing_received, with the amount at risk (the value variance in Rappen), the supplier, and the age in days. Filter by supplierId and olderThanDays. Computed live (variance evaluations are never persisted).',
      ctxSchema({ supplierId: STR, olderThanDays: INT }, []),
      (ctx, input) => matchThreeWayExceptions(ctx, as(input)),
    ),
    ctxAction(
      'match_status_for_bill',
      'read',
      'The read-only payment gate A18 / the mark-paid UI consult before settling a vendor bill. Returns the match status (unmatched | matched | partial | overridden | reversed), the active matchId when there is one, the total still-open quantity on the PO, and canPay: true only for an active matched / partial / overridden match. An unmatched bill returns canPay false (I04 default policy: a bill is not payable through the gate until matched). Writes nothing.',
      ctxSchema({ billId: STR }, ['billId']),
      (ctx, input) => matchStatusForBill(ctx, as(input)),
    ),
  ];
}
