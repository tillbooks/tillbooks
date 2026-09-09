/**
 * J01's eighteen lot & serial tracking verbs (10 writes + 8 reads), defined here and spread into
 * `ACTIONS` as ONE line (the `fxActions` / `assetActions` / `inventoryActions` precedent), so several
 * agents appending to the append-only registry at once collide over a line rather than a block.
 *
 * As with `inventory-actions.ts`, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 * Every field is camelCase and maps straight through to the engine verb. The ten writes carry
 * `idempotencyKey` (§H-IDEMPOTENT); the eight reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  itemSetTrackingMode,
  lotCreate,
  lotUpdate,
  lotSetStatus,
  lotArchive,
  lotGet,
  lotList,
  lotSearch,
  serialCreate,
  serialCreateBulk,
  serialUpdate,
  serialSetStatus,
  serialArchive,
  serialGet,
  serialList,
  serialSearch,
  inventoryOnHandByLot,
  inventoryAvailableSerials,
} from '../core/inventory/index.js';

export interface TrackingActionHelpers {
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

/** The J01 verbs, in append order (item tracking mode, lot, serial, then the two read models). */
export function trackingActions(h: TrackingActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;

  const LOT_PATCH = {
    type: 'object',
    properties: {
      number: STR,
      expiryDate: STR,
      manufacturedDate: STR,
      supplierReference: STR,
      notes: STR,
    },
  } as const;

  const SERIAL_PATCH = {
    type: 'object',
    properties: { number: STR, notes: STR, lotId: STR },
  } as const;

  return [
    ctxAction(
      'item_set_tracking_mode',
      'write',
      "Set an item's lot/serial tracking mode: none | lot | serial | lot_and_serial. The item must be stockable (track_stock true) and its current on-hand must be 0 for any non-none mode (else tracking_mode_requires_zero_stock); a service or non-stockable item is tracking_not_applicable. Going back to none needs every lot and serial for the item archived and balanced. Plain master data: posts no journal entry.",
      ctxSchema({ itemId: STR, mode: STR, idempotencyKey: STR }, ['itemId', 'mode', 'idempotencyKey']),
      (ctx, input) => itemSetTrackingMode(ctx, as(input)),
    ),
    ctxAction(
      'lot_create',
      'write',
      'Create a lot (a batch) against a lot-tracked item. number is 1-60 chars, unique per item case-insensitively (lot_number_taken); the item must be lot-tracked (else tracking_not_applicable). Optional expiryDate, manufacturedDate, supplierReference, notes and an initial status (default open). No quantity column: on-hand is always derived from movements.',
      ctxSchema(
        {
          itemId: STR,
          number: STR,
          expiryDate: STR,
          manufacturedDate: STR,
          supplierReference: STR,
          notes: STR,
          status: STR,
          idempotencyKey: STR,
        },
        ['itemId', 'number', 'idempotencyKey'],
      ),
      (ctx, input) => lotCreate(ctx, as(input)),
    ),
    ctxAction(
      'lot_update',
      'write',
      'Edit a lot through a descriptive patch (number if still unique, expiryDate, manufacturedDate, supplierReference, notes). The status is changed via lot_set_status, not here. Only the fields present in patch change.',
      ctxSchema({ lotId: STR, patch: LOT_PATCH, idempotencyKey: STR }, ['lotId', 'idempotencyKey']),
      (ctx, input) => lotUpdate(ctx, as(input)),
    ),
    ctxAction(
      'lot_set_status',
      'write',
      'Change a lot status: open | held | expired | closed | archived, with an optional reason. Setting closed or archived while the lot still has non-zero derived on-hand is refused with lot_has_balance (quarantine or expire it instead, which keeps the quantity). Never mints a stock movement.',
      ctxSchema({ lotId: STR, status: STR, reason: STR, idempotencyKey: STR }, ['lotId', 'status', 'idempotencyKey']),
      (ctx, input) => lotSetStatus(ctx, as(input)),
    ),
    ctxAction(
      'lot_archive',
      'write',
      'Soft-archive a lot (status archived). Refused with lot_has_balance while its derived on-hand is non-zero. Deletion is never offered; the movements that reference it keep their lot_id.',
      ctxSchema({ lotId: STR, idempotencyKey: STR }, ['lotId', 'idempotencyKey']),
      (ctx, input) => lotArchive(ctx, as(input)),
    ),
    ctxAction(
      'lot_get',
      'read',
      'Read one lot by id, plus its derived on-hand (the live SUM of movements for the lot).',
      ctxSchema({ lotId: STR }, ['lotId']),
      (ctx, input) => lotGet(ctx, as(input)),
    ),
    ctxAction(
      'lot_list',
      'read',
      'List lots, filterable by itemId, status, an expiryBefore cutoff (FEFO), and a case-insensitive search over number and supplierReference. Archived lots are hidden unless includeArchived or an explicit status is given. Each row carries its derived on-hand. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({ itemId: STR, status: STR, search: STR, expiryBefore: STR, includeArchived: BOOL, savedViewId: STR }),
      (ctx, input) => lotList(ctx, as(input)),
    ),
    ctxAction(
      'lot_search',
      'read',
      'Full-text lot search over number and supplierReference (case-insensitive), capped at 100 rows. Empty query returns an empty list.',
      ctxSchema({ query: STR }),
      (ctx, input) => lotSearch(ctx, as(input)),
    ),
    ctxAction(
      'serial_create',
      'write',
      'Create one serial (an individually identified unit) against a serial-tracked item. number is 1-60 chars, unique per item case-insensitively (serial_number_taken); the item must be serial-tracked (else tracking_not_applicable). When the item is lot_and_serial a lotId is required (lot_reference_required) and must belong to the same item (lot_item_mismatch). Starts status available.',
      ctxSchema({ itemId: STR, number: STR, lotId: STR, notes: STR, idempotencyKey: STR }, ['itemId', 'number', 'idempotencyKey']),
      (ctx, input) => serialCreate(ctx, as(input)),
    ),
    ctxAction(
      'serial_create_bulk',
      'write',
      'Create many serials at once for one item from a list of numbers (receiving a carton). ALL-OR-NOTHING: any duplicate number (against the store or within the batch) aborts the whole call with serial_number_taken and writes nothing. Same lotId rules as serial_create.',
      ctxSchema({ itemId: STR, numbers: STR_ARRAY, lotId: STR, idempotencyKey: STR }, ['itemId', 'numbers', 'idempotencyKey']),
      (ctx, input) => serialCreateBulk(ctx, as(input)),
    ),
    ctxAction(
      'serial_update',
      'write',
      'Edit a serial through a descriptive patch (number if still unique, notes, lotId which must belong to the same item). The status is changed via serial_set_status, not here. Only the fields present in patch change.',
      ctxSchema({ serialId: STR, patch: SERIAL_PATCH, idempotencyKey: STR }, ['serialId', 'idempotencyKey']),
      (ctx, input) => serialUpdate(ctx, as(input)),
    ),
    ctxAction(
      'serial_set_status',
      'write',
      'Change a serial status: available | reserved | issued | returned | scrapped | archived, with an optional reason. Scrapping an available unit is allowed and removes it from availability. Never mints a stock movement.',
      ctxSchema({ serialId: STR, status: STR, reason: STR, idempotencyKey: STR }, ['serialId', 'status', 'idempotencyKey']),
      (ctx, input) => serialSetStatus(ctx, as(input)),
    ),
    ctxAction(
      'serial_archive',
      'write',
      'Soft-archive a serial (status archived). Refused with serial_has_balance while the unit is still available or reserved (issue, return or scrap it first). Deletion is never offered.',
      ctxSchema({ serialId: STR, idempotencyKey: STR }, ['serialId', 'idempotencyKey']),
      (ctx, input) => serialArchive(ctx, as(input)),
    ),
    ctxAction(
      'serial_get',
      'read',
      'Read one serial by id, including its lot link, status and current-location projection.',
      ctxSchema({ serialId: STR }, ['serialId']),
      (ctx, input) => serialGet(ctx, as(input)),
    ),
    ctxAction(
      'serial_list',
      'read',
      'List serials, filterable by itemId, lotId, current locationId, status, and a case-insensitive search over number. Archived serials are hidden unless includeArchived or an explicit status is given. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({ itemId: STR, lotId: STR, locationId: STR, status: STR, search: STR, includeArchived: BOOL, savedViewId: STR }),
      (ctx, input) => serialList(ctx, as(input)),
    ),
    ctxAction(
      'serial_search',
      'read',
      'Full-text serial search over number (case-insensitive), capped at 100 rows. Empty query returns an empty list.',
      ctxSchema({ query: STR }),
      (ctx, input) => serialSearch(ctx, as(input)),
    ),
    ctxAction(
      'inventory_on_hand_by_lot',
      'read',
      'On-hand quantity broken down by lot x location: a pure read model over the OP2 stock_movement ledger (SUM of signed qty per lot x location, joined to the lot master), never a cached column. Filter by itemId, locationId, lotId, a status list and an expiryBefore cutoff; includeZero returns pairs that net to zero. Empty until J02 movements carry a lot_id.',
      ctxSchema({ itemId: STR, locationId: STR, lotId: STR, status: STR_ARRAY, expiryBefore: STR, includeZero: BOOL }),
      (ctx, input) => inventoryOnHandByLot(ctx, as(input)),
    ),
    ctxAction(
      'inventory_available_serials',
      'read',
      'The serials whose current derived status is available (or a supplied status list), optionally filtered by itemId, current locationId or lotId. A pure read, side-effect free: the allocation/reservation query an agent runs before picking units.',
      ctxSchema({ itemId: STR, locationId: STR, lotId: STR, status: STR_ARRAY }),
      (ctx, input) => inventoryAvailableSerials(ctx, as(input)),
    ),
  ];
}
