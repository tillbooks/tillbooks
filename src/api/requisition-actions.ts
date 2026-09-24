/**
 * I00's eleven requisition verbs (eight writes + three reads), defined here and spread into `ACTIONS`
 * as ONE line (the `fxActions` / `assetActions` / `purchaseActions` precedent), so several agents
 * appending to the append-only registry at once collide over a line rather than a block.
 *
 * As with `asset-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back. Every
 * field is camelCase and maps straight through to the engine verb (the boundary is
 * `additionalProperties: true`, validated in the engine). The eight writes carry `idempotencyKey`
 * (§H-IDEMPOTENT); the three reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  requisitionUpsert,
  requisitionSubmit,
  requisitionApprove,
  requisitionReject,
  requisitionReturn,
  requisitionConvertToPo,
  requisitionCancel,
  requisitionClose,
  requisitionGet,
  requisitionList,
  requisitionMyPendingApprovals,
} from '../core/procurement/index.js';

export interface RequisitionActionHelpers {
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
// I00's `requisition_list` summary has always promised status takes "one value or an array", and
// `requisitionList` has always handled both, but the schema declared a bare string, so an array was
// rejected `invalid_input` at the boundary on MCP and REST alike. `anyOf` declares the real union and
// leaves the boundary type check with nothing to reject (it reads `.type`, absent here), so the
// engine stays the single validator. The `customization-actions.ts` ANY_VALUE precedent. I02 carried
// this defect forward by copying the row, and both are corrected together.
const STR_OR_LIST = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } as const;

/** The I00 verbs, in append order. */
export function requisitionActions(h: RequisitionActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'requisition_upsert',
      'write',
      'Create or edit a DRAFT requisition (the controlled internal-demand document that opens the procure-to-pay chain). requesterId defaults to the caller; neededBy (ISO date) and urgency (normal | high | critical) are the header; each line carries an optional itemId (else a required description), qtyMilli (> 0, integer milli-units where 1000 = one whole unit), an optional uom, estimatedUnitCostRappen (>= 0), and an optional preferredSupplierId. The header total is the exact integer sum of the line estimates. Editing is refused once the requisition has left draft (invalid_transition). Posts nothing and emits no outward artifact.',
      ctxSchema(
        {
          id: STR,
          requesterId: STR,
          neededBy: STR,
          urgency: STR,
          costCenterId: STR,
          projectId: STR,
          description: STR,
          currency: STR,
          lines: ARR,
          idempotencyKey: STR,
        },
        ['idempotencyKey'],
      ),
      (ctx, input) => requisitionUpsert(ctx, as(input)),
    ),
    ctxAction(
      'requisition_submit',
      'write',
      'Submit a draft for approval. The policy evaluator decides the required approvers: a zero-estimate requisition auto-approves (status approved) and any positive estimate becomes pending_approval with an open approval task. Submit of an already-pending or terminal document is invalid_transition; a line-less draft is invalid_line.',
      ctxSchema({ requisitionId: STR, idempotencyKey: STR }, ['requisitionId', 'idempotencyKey']),
      (ctx, input) => requisitionSubmit(ctx, as(input)),
    ),
    ctxAction(
      'requisition_approve',
      'write',
      'Approve a pending requisition. Completes the named approval task (or the sole open one when taskId is omitted) and, once every required step is satisfied, moves the requisition to approved. Appends an immutable approval event.',
      ctxSchema({ requisitionId: STR, taskId: STR, comment: STR, idempotencyKey: STR }, ['requisitionId', 'idempotencyKey']),
      (ctx, input) => requisitionApprove(ctx, as(input)),
    ),
    ctxAction(
      'requisition_reject',
      'write',
      'Reject a pending requisition with a reason. Status becomes rejected (terminal), all open approval tasks are closed, and an immutable approval event records the decision.',
      ctxSchema({ requisitionId: STR, taskId: STR, reason: STR, idempotencyKey: STR }, ['requisitionId', 'reason', 'idempotencyKey']),
      (ctx, input) => requisitionReject(ctx, as(input)),
    ),
    ctxAction(
      'requisition_return',
      'write',
      'Return a pending requisition to the requester for revision, with a reason. Status returns to draft, open tasks are cancelled, and the requester can edit and re-submit; the prior approval events stay queryable.',
      ctxSchema({ requisitionId: STR, taskId: STR, reason: STR, idempotencyKey: STR }, ['requisitionId', 'reason', 'idempotencyKey']),
      (ctx, input) => requisitionReturn(ctx, as(input)),
    ),
    ctxAction(
      'requisition_convert_to_po',
      'write',
      'Convert selected open quantities of an approved (or partially converted) requisition into a D02 purchase order. lines is a list of { lineId, qtyMilli } where each qtyMilli is a positive whole-unit multiple (1000 = one unit) and must not exceed the line open quantity (over_conversion). supplierContactId overrides the lines preferred supplier (required when the selection has none in common). createAs is draft | sent. The requisition becomes partially_converted while any open quantity remains, else converted, with an immutable conversion link back to the PO.',
      ctxSchema(
        { requisitionId: STR, lines: ARR, supplierContactId: STR, createAs: STR, idempotencyKey: STR },
        ['requisitionId', 'lines', 'idempotencyKey'],
      ),
      (ctx, input) => requisitionConvertToPo(ctx, as(input)),
    ),
    ctxAction(
      'requisition_cancel',
      'write',
      'Cancel a draft, pending or approved requisition that has no conversion yet (status cancelled). A requisition that already has any conversion is has_conversions and must be closed instead.',
      ctxSchema({ requisitionId: STR, reason: STR, idempotencyKey: STR }, ['requisitionId', 'idempotencyKey']),
      (ctx, input) => requisitionCancel(ctx, as(input)),
    ),
    ctxAction(
      'requisition_close',
      'write',
      'Close a converted or partially-converted requisition (status closed): the demand is settled and no further conversion follows.',
      ctxSchema({ requisitionId: STR, idempotencyKey: STR }, ['requisitionId', 'idempotencyKey']),
      (ctx, input) => requisitionClose(ctx, as(input)),
    ),
    ctxAction(
      'requisition_get',
      'read',
      'Read one requisition: header, lines with open quantities, the full approval-event history, the open approval tasks, and the conversion links to any resulting purchase orders.',
      ctxSchema({ requisitionId: STR }, ['requisitionId']),
      (ctx, input) => requisitionGet(ctx, as(input)),
    ),
    ctxAction(
      'requisition_list',
      'read',
      'List requisitions with filters: status (one value or an array), requesterId, projectId, costCenterId, a neededBy date range (neededByFrom / neededByTo) and a free-text search q over number and description. Accepts a savedViewId (G00 saved-view seam). Ordered by number, newest first.',
      ctxSchema({
        status: STR_OR_LIST,
        requesterId: STR,
        projectId: STR,
        costCenterId: STR,
        neededByFrom: STR,
        neededByTo: STR,
        q: STR,
        savedViewId: STR,
      }),
      (ctx, input) => requisitionList(ctx, as(input)),
    ),
    ctxAction(
      'requisition_my_pending_approvals',
      'read',
      'The open approval tasks the workspace still owes a decision on, each joined to its requisition header (number, requester, needed-by, urgency, estimated total). The approval inbox read. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({ savedViewId: STR }),
      (ctx, input) => requisitionMyPendingApprovals(ctx, as(input)),
    ),
  ];
}
