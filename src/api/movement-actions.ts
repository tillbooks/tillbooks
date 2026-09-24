/**
 * J02's seven inventory movement-ledger verbs (2 writes + 3 reads + 1 policy read + 1 policy write),
 * defined here and spread into `ACTIONS` as ONE line (the `fxActions` / `trackingActions` /
 * `inventoryActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * As with `tracking-actions.ts`, the engine helpers arrive as an import and the registry helpers as a
 * parameter, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back. Every field is camelCase and maps straight through to the engine verb. The three
 * writes carry `idempotencyKey` (§H-IDEMPOTENT); the four reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  inventoryMove,
  inventoryTransfer,
  inventoryBalance,
  inventoryMovementList,
  inventoryMovementGet,
  inventoryGetConfig,
  inventorySetConfig,
} from '../core/inventory/index.js';

export interface MovementActionHelpers {
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

/** The J02 verbs, in append order (the two writes, the three ledger reads, then the two config verbs). */
export function movementActions(h: MovementActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'inventory_move',
      'write',
      "Record ONE append-only inventory movement, the only way on-hand ever changes (on-hand is always the live SUM of movements, never a stored column). movementType is one of opening|receipt|issue|transfer_out|transfer_in|adjustment|return|scrap; qty is signed integer units (opening/receipt/transfer_in must be positive, issue/transfer_out/scrap negative, adjustment/return carry the caller's sign) and must be non-zero (invalid_qty). unitCostMinor is the integer-Rappen cost snapshot for later valuation. The item must be stockable (item_not_stockable) and, when its tracking_mode demands it, carry a lotId (lot_required) and/or serialId (serial_required); a serial movement is a unit of one, so an INBOUND movement for a serial the workspace already holds is refused with serial_already_in_stock before any row is written (issue, return or scrap it first; use inventory_transfer to relocate it). When allow_negative_stock is false (default) an issue that would drive the balance below zero is refused with insufficient_stock before any row is written. Rows are immutable; a correction is another movement, never an edit.",
      ctxSchema(
        {
          itemId: STR,
          locationId: STR,
          qty: INT,
          movementType: STR,
          unitCostMinor: INT,
          effectiveDate: STR,
          lotId: STR,
          serialId: STR,
          sourceDocumentType: STR,
          sourceDocumentId: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['itemId', 'locationId', 'qty', 'movementType', 'effectiveDate', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryMove(ctx, as(input)),
    ),
    ctxAction(
      'inventory_transfer',
      'write',
      'Move stock between two locations as an ATOMIC pair: a transfer_out at fromLocationId and a transfer_in at toLocationId, both under one transferGroupId, equal absolute quantity, summing to zero. qty is always POSITIVE (the helper applies the sign). Either both legs land or neither does. When allow_negative_stock is false a transfer that would overdraw the source is refused with insufficient_stock and nothing is written. Same tracking rules as inventory_move; a serial transfer moves one unit and re-parks it at the destination. Idempotent under idempotencyKey (a replay returns the original pair).',
      ctxSchema(
        {
          itemId: STR,
          fromLocationId: STR,
          toLocationId: STR,
          qty: INT,
          unitCostMinor: INT,
          effectiveDate: STR,
          lotId: STR,
          serialId: STR,
          sourceDocumentType: STR,
          sourceDocumentId: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['itemId', 'fromLocationId', 'toLocationId', 'qty', 'effectiveDate', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryTransfer(ctx, as(input)),
    ),
    ctxAction(
      'inventory_balance',
      'read',
      'On-hand quantity as the pure SUM of matching movements (never a cached column). Filter by any subset of itemId, locationId, lotId, serialId, and an inclusive asOf date (effective_date <= asOf); omit asOf for now. Returns qtyOnHand for the whole filter plus a per item x location breakdown. A guessed foreign workspace id returns zero / empty, never data.',
      ctxSchema({ itemId: STR, locationId: STR, lotId: STR, serialId: STR, asOf: STR }),
      (ctx, input) => inventoryBalance(ctx, as(input)),
    ),
    ctxAction(
      'inventory_movement_list',
      'read',
      'The chronological movement history (newest first), filterable by itemId, locationId, lotId, serialId, a movementType list, a fromDate/toDate range, sourceDocumentType/sourceDocumentId and transferGroupId, with limit/offset pagination. When a single itemId is filtered each row also carries a server-computed runningBalance (oldest to newest). History is never purged.',
      ctxSchema({
        itemId: STR,
        locationId: STR,
        lotId: STR,
        serialId: STR,
        movementType: STR_ARRAY,
        fromDate: STR,
        toDate: STR,
        sourceDocumentType: STR,
        sourceDocumentId: STR,
        transferGroupId: STR,
        limit: INT,
        offset: INT,
      }),
      (ctx, input) => inventoryMovementList(ctx, as(input)),
    ),
    ctxAction(
      'inventory_movement_get',
      'read',
      'Read one movement by id, with its full cost snapshot, type, effective date, location, lot/serial, source document link, description and actor. A foreign or unknown id is not_found, never cross-tenant data.',
      ctxSchema({ movementId: STR }, ['movementId']),
      (ctx, input) => inventoryMovementGet(ctx, as(input)),
    ),
    ctxAction(
      'inventory_get_config',
      'read',
      'Read the workspace inventory policy: allowNegativeStock (default false). When false, an issue or transfer that would drive a balance below zero is refused with insufficient_stock.',
      ctxSchema(),
      (ctx) => inventoryGetConfig(ctx),
    ),
    ctxAction(
      'inventory_set_config',
      'write',
      'Set the workspace negative-stock posture. allowNegativeStock true disables the insufficient_stock guard (a warning posture for backorder workflows); false (default) enforces it. Plain policy: posts no journal entry and never rewrites history, so flipping the flag changes only future writes.',
      ctxSchema({ allowNegativeStock: BOOL, idempotencyKey: STR }, ['allowNegativeStock', 'idempotencyKey']),
      (ctx, input) => inventorySetConfig(ctx, as(input)),
    ),
  ];
}
