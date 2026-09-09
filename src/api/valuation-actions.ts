/**
 * J03's seven inventory valuation verbs (4 reads + 3 writes), defined here and spread into `ACTIONS`
 * as ONE line (the `fxActions` / `movementActions` / `trackingActions` precedent), so several agents
 * appending to the append-only registry at once collide over a line rather than a block.
 *
 * As with `movement-actions.ts`, the engine helpers arrive as an import and the registry helpers as a
 * parameter, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back. Every field is camelCase and maps straight through to the engine verb.
 *
 * THE FOUR READS ARE GENUINELY PURE. They mint no journal entry, cache no figure and write no run
 * row: every number is derived from the J02 ledger on the spot. That is what lets an agent project a
 * what-if under an alternate method without touching the item's stored policy, and the conformance
 * harness's whole-database snapshot is what proves it rather than this comment.
 *
 * THE THREE WRITES TOUCH ONLY POLICY. J03 posts nothing; the valuation figure reaches the books
 * through J06. The two dated writes append an immutable assignment row whose `effectiveFrom` is what
 * the period lock is checked against, which is the whole reason a method change cannot restate a
 * year that is already closed.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  inventoryValuationMethods,
  inventoryValuationPreview,
  inventoryValuationLayers,
  inventoryValuationMethodHistory,
  inventoryValuationMethodSetEnabled,
  inventoryValuationSetDefault,
  inventoryValuationSetItemMethod,
} from '../core/inventory/index.js';

export interface ValuationActionHelpers {
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

/** The J03 verbs, in append order (the four pure reads, then the three policy writes). */
export function valuationActions(h: ValuationActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;
  const NRV_MAP = { type: 'object', additionalProperties: INT } as const;

  return [
    ctxAction(
      'inventory_valuation_preview',
      'read',
      'Value inventory at a date WITHOUT writing anything: no journal entry, no run row, no cached figure. Returns one row per item with the method that applied on that date (item override beats workspace default beats the built-in weighted_average, each as it stood on the asOf date, so a later policy change never restates a filed figure), qtyOnHand, the rounded unitCostMinor a human reads, and totalValueMinor computed from the exact cost pool. Omit itemIds to value every item with ledger history; omit asOf for everything recorded so far. methodOverride projects a what-if under another method and leaves the stored policy untouched (a disabled method is refused). netRealisableValues maps itemId to the OR 960c per-unit Veräusserungswert LESS the costs still to come; where it is below cost the clamp is applied, lcmApplied is set and writeDownMinor reports the difference. Uncosted receipts are valued at zero, counted in uncostedQty and named in missingCostMovementIds, never valued at the neighbours price. An internal transfer between locations is value-neutral: cost follows the goods. LOCATION SCOPE: locationId alone values that one location, valueByLocation alone returns one row per location, both together narrow the breakdown; an unknown or foreign locationId is not_found, never an empty result. Per-location rows always sum to the item total, and each says how it got there in valuationBasis: direct for FIFO and standard cost, allocated for weighted average, which has one cost pool per item and so shows each location its own quantity at the item pooled average rather than inventing a second pool. A negative on-hand, a negative unit cost or a missing standard cost returns a reason and a value of zero rather than an arithmetic answer.',
      ctxSchema({
        asOf: STR,
        itemIds: STR_ARRAY,
        methodOverride: STR,
        netRealisableValues: NRV_MAP,
        valueByLocation: BOOL,
        locationId: STR,
      }),
      (ctx, input) => inventoryValuationPreview(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_methods',
      'read',
      'The valuation method registry: weighted_average, fifo and standard_cost, each with whether this workspace has it enabled and whether it needs a per-item standard cost. Also returns the method in force as the workspace default today, where it came from (a recorded assignment or the built-in weighted_average) and the date it took effect. weighted_average and fifo are enabled out of the box; standard_cost is registered and off until a workspace turns it on. A disabled method can neither be the default nor be chosen on an item.',
      ctxSchema(),
      (ctx) => inventoryValuationMethods(ctx),
    ),
    ctxAction(
      'inventory_valuation_layers',
      'read',
      'The remaining FIFO cost layers for one item, oldest first: each carries the receipt date, the source movement, the quantity originally received and what is left of it, and its unit cost. Layers are derived from the J02 ledger on demand rather than cached, so they cannot drift from it. Returns the layer quantity, the exact total (the sum of remaining qty times layer cost, to the Rappen) and shortfall, the demand that outlived the layers when stock went short. Filter by locationId to inspect one location; a foreign or unknown item OR location is not_found, never cross-tenant data and never an empty list that would read as "this location holds nothing". NOT A STOCK-AGEING REPORT: when stock is transferred the layer moves with its own unit cost but its receiptDate becomes the date it reached that location, because that is what drives consumption order there. For how long goods have really been held, read the J02 movement history, which rewrites nothing.',
      ctxSchema({ itemId: STR, asOf: STR, locationId: STR }, ['itemId']),
      (ctx, input) => inventoryValuationLayers(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_method_history',
      'read',
      'The append-only trail of valuation-method changes, newest effective date first: scope (workspace or item), the method, the standard cost where one was set, the date it took effect, the reason the operator stated, whether it was forced over open-period movements, and who recorded it. This is the OR 958c Stetigkeit evidence: it is what a Treuhänder reads when asked why an inventory figure moved between two years. Filter by itemId or by scope. Rows are immutable at the database layer, so the trail cannot be tidied after the fact.',
      ctxSchema({ itemId: STR, scope: STR }),
      (ctx, input) => inventoryValuationMethodHistory(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_method_set_enabled',
      'write',
      'Turn one valuation method on or off for the workspace. Enablement gates what may be CHOSEN from here on; it is deliberately not dated, because a past figure is determined by the assignment that was in force then and not by what is switched on today. Disabling the method that is currently the workspace default is refused with method_is_default: change the default first, so no future valuation points at a method the workspace says it does not use. Absolute state-setting, so a replay of the idempotency key re-asserts the same list and writes nothing new. Posts no journal entry.',
      ctxSchema({ method: STR, enabled: BOOL, idempotencyKey: STR }, ['method', 'enabled', 'idempotencyKey']),
      (ctx, input) => inventoryValuationMethodSetEnabled(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_set_default',
      'write',
      'Set the workspace default valuation method from effectiveFrom on. Appends an immutable assignment row rather than overwriting a setting, so the history of what applied when survives (OR 958c Stetigkeit) and a valuation at an earlier date still resolves to the method that was in force then. effectiveFrom is what the period lock is checked against, NOT the day you call it: a change dated into a soft- or hard-closed period is refused with period_locked before anything is written, so a sealed year cannot be restated by picking an old date. When the workspace already has movements dated on or after effectiveFrom, the change would restate their valuation for every item without an override of its own, so it is refused with method_change_blocked_open_period unless you pass forceRevaluation true AND a reason (a blank reason does not count). A disabled method is refused. Posts no journal entry.',
      ctxSchema({ method: STR, effectiveFrom: STR, forceRevaluation: BOOL, reason: STR, idempotencyKey: STR }, ['method', 'effectiveFrom', 'idempotencyKey']),
      (ctx, input) => inventoryValuationSetDefault(ctx, as(input)),
    ),
    ctxAction(
      'inventory_valuation_set_item_method',
      'write',
      'Override the valuation method for one item from effectiveFrom on, with standardCostMinor when the method is standard_cost (required, integer Rappen, above zero). Appends an immutable assignment row; effectiveFrom is what the period lock answers to, never the call date. When the item already carries movements dated on or after effectiveFrom, those are exactly the movements this change restates, so it is refused with method_change_blocked_open_period unless you pass forceRevaluation true AND a reason: the reason is the sentence that appears in the Stetigkeit history when someone asks why the figure moved, so a force without one is refused rather than recorded blank. The revaluation itself belongs to J06. A disabled method is refused; a foreign item is not_found. Posts no journal entry.',
      ctxSchema(
        {
          itemId: STR,
          method: STR,
          effectiveFrom: STR,
          standardCostMinor: INT,
          forceRevaluation: BOOL,
          reason: STR,
          idempotencyKey: STR,
        },
        ['itemId', 'method', 'effectiveFrom', 'idempotencyKey'],
      ),
      (ctx, input) => inventoryValuationSetItemMethod(ctx, as(input)),
    ),
  ];
}
