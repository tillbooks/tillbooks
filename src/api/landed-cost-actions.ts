/**
 * I03's six landed-cost verbs (three writes + three reads), defined here and spread into `ACTIONS` as
 * ONE line (the `receiptActions` / `movementActions` precedent), so several agents appending to the
 * append-only registry at once collide over a line rather than a block.
 *
 * As with `receipt-actions.ts`, the registry helpers arrive as a parameter rather than an import, so
 * the module graph stays acyclic: `registry.ts` imports this file and this file must not import it
 * back. Every field is camelCase and maps straight through to the engine verb. The three writes carry
 * `idempotencyKey` (§H-IDEMPOTENT); the three reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  landedCostVoucherCreate,
  landedCostAllocatePreview,
  landedCostAllocateConfirm,
  landedCostReverse,
  landedCostList,
  landedCostGet,
} from '../core/procurement/index.js';

export interface LandedCostActionHelpers {
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

function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const ARR = { type: 'array' } as const;
const OBJ = { type: 'object' } as const;

/** The I03 verbs, in append order (the three writes, then the three reads). */
export function landedCostActions(h: LandedCostActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  const STR_OR_LIST = { anyOf: [{ type: 'string' }, { type: 'array', items: STR }] } as const;

  return [
    ctxAction(
      'landed_cost_voucher_create',
      'write',
      'AGENT-FIRST. Open a DRAFT landed-cost voucher that collects freight, duty, insurance, handling or brokerage against one or more POSTED goods-receipt lines, so the extra cost can be capitalised onto the inventory that incurred it (OR 960 acquisition cost). costLines is a list of { componentType (freight | duty | insurance | handling | brokerage | other), amountMinor (> 0 Rappen), description?, vendorId?, taxCodeId? }. targetGrLineIds are the recognised goods_receipt_doc_line ids (each must be on a posted, non-reversed receipt and not already allocated under a live voucher, else already_allocated). inventoryAccountId and clearingAccountId are the two GL accounts a later confirm posts between (Dr inventory control, Cr landed-cost clearing / accrued costs). varianceAccountId (optional) receives the NON-capitalizable share when a receipt has been partly issued or the item is standard-cost (J03 carries only the on-hand share onto inventory); it is required at confirm only if such a remainder actually arises. variancePolicy is expense_excess (default: route the remainder to varianceAccountId) or strict (refuse a confirm that would leave a remainder). allocationMethod defaults to by_value. Nothing physical happens yet: no stock movement, no journal. Idempotent under idempotencyKey.',
      ctxSchema(
        {
          costLines: ARR,
          targetGrLineIds: STR_ARRAY,
          inventoryAccountId: STR,
          clearingAccountId: STR,
          varianceAccountId: STR,
          variancePolicy: STR,
          allocationMethod: STR,
          isEstimated: BOOL,
          currency: STR,
          fxRate: STR,
          sourceBillIds: STR_ARRAY,
          effectiveDate: STR,
          notes: STR,
          idempotencyKey: STR,
        },
        ['costLines', 'targetGrLineIds', 'inventoryAccountId', 'clearingAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => landedCostVoucherCreate(ctx, as(input)),
    ),
    ctxAction(
      'landed_cost_allocate_confirm',
      'write',
      'Confirm the allocation of a DRAFT voucher, in ONE atomic transaction: re-run the pure allocator (verifying the residual is 0), write one value-only J02 landed_cost movement per target (qty 0, the allocated Rappen as cost_amount, ref_movement_id = the receipt movement, so J03 folds the cost onto that exact layer and on-hand is unchanged), post ONE balanced A02 entry, read it back to verify it balances, and move the voucher draft -> allocated. The GL entry SPLITS the cost by what J03 actually carries: Dr inventory control for the CAPITALIZABLE share (the on-hand fraction for weighted-average and FIFO, ZERO for a standard-cost item), Dr the variance account for the remainder (already-issued units, and a standard-cost item whole cost), Cr landed-cost clearing for the total, so the inventory-control debit equals the J03 valuation rise exactly (OP11). variancePolicy strict refuses a remainder (landed_cost_variance_not_permitted); expense_excess needs varianceAccountId set (variance_account_required). method and effectiveDate default to the voucher. A replay under the same idempotencyKey returns the allocated voucher and writes nothing; a second confirm under a different key is invalid_transition. period_locked when the effective date is in a sealed period.',
      ctxSchema({ voucherId: STR, method: STR, manualShares: OBJ, effectiveDate: STR, idempotencyKey: STR }, [
        'voucherId',
        'idempotencyKey',
      ]),
      (ctx, input) => landedCostAllocateConfirm(ctx, as(input)),
    ),
    ctxAction(
      'landed_cost_reverse',
      'write',
      'Reverse an ALLOCATED voucher, the ONE correction for a confirmed allocation. Nothing about the original voucher, its movements or its journal is edited or deleted. What is written is the compensation: a value-only J02 landed_cost movement per target with the NEGATED cost against the same receipt layer (so J03 nets the layer landed cost back to zero, inventory value flat), and a reversing A02 entry that is the exact mirror of the confirm entry (so the GL nets flat). The voucher becomes reversed and is permanently linked to the reverse journal and reverse movements. reason is required. Idempotent under idempotencyKey. period_locked when the effective period is sealed.',
      ctxSchema({ voucherId: STR, reason: STR, idempotencyKey: STR }, ['voucherId', 'reason', 'idempotencyKey']),
      (ctx, input) => landedCostReverse(ctx, as(input)),
    ),
    ctxAction(
      'landed_cost_allocate_preview',
      'read',
      'PURE allocation preview of a voucher: per target the base value and quantity, the share (0..1), the allocated Rappen and the per-unit impact, the effective method actually used (a fallback swaps by_weight / by_volume to by_value when an attribute is missing, reported in warnings), and the residual (always 0 after commercial rounding). method defaults to the voucher method; manualShares supplies per-target fractions for the manual method (must sum to 1). Writes nothing and is safe to call repeatedly; changing the method immediately re-computes.',
      ctxSchema({ voucherId: STR, method: STR, manualShares: OBJ }, ['voucherId']),
      (ctx, input) => landedCostAllocatePreview(ctx, as(input)),
    ),
    ctxAction(
      'landed_cost_list',
      'read',
      'List landed-cost vouchers with filters: status (one value or an array of draft | allocated | reversed), itemId (vouchers that touch that item), and an effectiveDate range (fromDate / toDate). Each row carries the number, status, estimated flag, currency, total cost in Rappen, allocation method, effective date and the linked journal entry id. Newest effective date first. A foreign workspace sees only its own vouchers (§H-TENANT).',
      ctxSchema({ status: STR_OR_LIST, itemId: STR, fromDate: STR, toDate: STR }),
      (ctx, input) => landedCostList(ctx, as(input)),
    ),
    ctxAction(
      'landed_cost_get',
      'read',
      'One landed-cost voucher with its header, cost-component lines and allocation targets (each with the goods-receipt line, the original receipt movement, the allocated amount and unit impact, and the J02 movement / reversal movement it minted). A foreign or unknown id is not_found, never cross-tenant data.',
      ctxSchema({ voucherId: STR }, ['voucherId']),
      (ctx, input) => landedCostGet(ctx, as(input)),
    ),
  ];
}
