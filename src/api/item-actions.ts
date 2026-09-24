/**
 * D00's NEW verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `permissionActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * D00 EXTENDS A09: the item CRUD stays on `create_item` / `update_item` / `archive_item` /
 * `unarchive_item` (they gain the master-data fields through the `additionalProperties: true`
 * boundary, validated in the engine). This module owns only what A09 did not have: `delete_item`
 * (hard-delete with a reference census), the category tree (`item_categories_*`), the price lists
 * (`price_lists_*`), and the agent-primary resolver `price_resolve`.
 *
 * As with `fx-actions.ts` and `permission-actions.ts`, the helpers arrive as a parameter rather than
 * an import, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  deleteItem,
  upsertItemCategory,
  deleteItemCategory,
  listItemCategories,
  upsertPriceList,
  setPriceListPrice,
  unsetPriceListPrice,
  deletePriceList,
  listPriceLists,
  getPriceList,
  resolvePrice,
} from '../core/sales/index.js';

export interface ItemActionHelpers {
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

/** The D00 verbs, in append order. */
export function itemActions(h: ItemActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  return [
    ctxAction(
      'delete_item',
      'write',
      'Hard-delete an item that is referenced nowhere (no document line, price-list row, variant, or stock movement). A referenced item is refused with item_referenced and its reference kinds; archive it instead so posted history stays resolvable.',
      ctxSchema({ itemId: STR, idempotencyKey: STR }, ['itemId']),
      (ctx, input) => deleteItem(ctx, as(input)),
    ),
    ctxAction(
      'item_categories_upsert',
      'write',
      'Create or edit an item category (two-level tree: the parent of a child must itself be a root). Pass categoryId to edit, omit it to create.',
      ctxSchema({ categoryId: STR, name: STR, parentId: STR, sort: INT, idempotencyKey: STR }),
      (ctx, input) => upsertItemCategory(ctx, as(input)),
    ),
    ctxAction(
      'item_categories_delete',
      'write',
      'Delete an item category. Refused (category_in_use) while any item or child category still points at it; reassign or empty it first.',
      ctxSchema({ categoryId: STR, idempotencyKey: STR }, ['categoryId']),
      (ctx, input) => deleteItemCategory(ctx, as(input)),
    ),
    ctxAction(
      'item_categories_list',
      'read',
      'List the item categories in the workspace, ordered by sort then name.',
      ctxSchema(),
      (ctx) => listItemCategories(ctx),
    ),
    ctxAction(
      'price_lists_upsert',
      'write',
      'Create or edit a price list, scoped to exactly one contact OR one segment (scope_ambiguous otherwise). One scope holds at most one list: a second list for a contact or segment that already has one is refused with scope_taken naming the existing list, so no price is ever resolved by insertion order. Pass priceListId to edit, omit it to create.',
      ctxSchema({ priceListId: STR, name: STR, contactId: STR, segment: STR, idempotencyKey: STR }),
      (ctx, input) => upsertPriceList(ctx, as(input)),
    ),
    ctxAction(
      'price_lists_set_price',
      'write',
      'Set a list price for an item from a validFrom date (ISO YYYY-MM-DD; anything else is refused with invalid_input, never coerced). Price history is append-only: this adds a row rather than editing a past one, so a resolve at any date reads a stored integer Rappen amount.',
      ctxSchema({ priceListId: STR, itemId: STR, priceMinor: INT, currency: STR, validFrom: STR, idempotencyKey: STR }, [
        'priceListId',
        'itemId',
        'priceMinor',
        'validFrom',
      ]),
      (ctx, input) => setPriceListPrice(ctx, as(input)),
    ),
    ctxAction(
      'price_lists_list',
      'read',
      'List the workspace price lists with their scope (contact or segment).',
      ctxSchema(),
      (ctx) => listPriceLists(ctx),
    ),
    ctxAction(
      'price_lists_get',
      'read',
      'Read one price list and its price rows (the validFrom history per item).',
      ctxSchema({ priceListId: STR }, ['priceListId']),
      (ctx, input) => getPriceList(ctx, as(input)),
    ),
    ctxAction(
      'price_resolve',
      'read',
      'Resolve the effective price of an item for a contact at a date: precedence contact then segment then base (the item base sales price), the latest validFrom that is in force winning within a scope. `at` is an ISO YYYY-MM-DD day (or a full ISO instant) and defaults to today; any other format is refused with invalid_input rather than compared, because a date that does not sort silently resolves the wrong price. Returns priceMinor, currency, and the source.',
      ctxSchema({ itemId: STR, contactId: STR, at: STR }, ['itemId']),
      (ctx, input) => resolvePrice(ctx, as(input)),
    ),
    // Appended after `price_resolve` rather than filed beside `price_lists_set_price`, because
    // `ACTIONS` is append-only: inserting mid-array reorders every verb below it in a file three
    // capability branches are editing at once.
    ctxAction(
      'price_lists_unset_price',
      'write',
      'Remove an item price from a list: pass validFrom to retract exactly that dated row, omit it to remove the item from the list entirely. Removing the item entirely is what makes price_resolve fall through to the next scope and what lets delete_item stop counting the list as a reference. Answers how many rows it took away, so a replay reports the same count and a repeat reports none.',
      ctxSchema({ priceListId: STR, itemId: STR, validFrom: STR, idempotencyKey: STR }, ['priceListId', 'itemId']),
      (ctx, input) => unsetPriceListPrice(ctx, as(input)),
    ),
    ctxAction(
      'price_lists_delete',
      'write',
      'Delete a price list together with its price rows. A price row has no reader apart from its list and a document line already snapshots the price it resolved, so the cascade removes nothing any issued document depends on. Refused with price_list_referenced if anything still points at the list.',
      ctxSchema({ priceListId: STR, idempotencyKey: STR }, ['priceListId']),
      (ctx, input) => deletePriceList(ctx, as(input)),
    ),
  ];
}
