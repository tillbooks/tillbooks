/**
 * J00's fifteen warehouse & location verbs, defined here and spread into `ACTIONS` as ONE line (the
 * `fxActions` / `assetActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * As with `asset-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back. Every
 * field is camelCase and maps straight through to the engine verb. The nine writes carry
 * `idempotencyKey` (§H-IDEMPOTENT), except `inventory_ensure_default_location`, which is idempotent by
 * construction (it takes no input beyond the workspace); the six reads advertise `readOnlyHint`.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  warehouseCreate,
  warehouseUpdate,
  warehouseSetDefault,
  warehouseArchive,
  warehouseList,
  warehouseGet,
  locationCreate,
  locationUpdate,
  locationSetDefault,
  locationArchive,
  locationList,
  locationGet,
  locationTree,
  inventoryEnsureDefaultLocation,
  inventoryBalanceByLocation,
} from '../core/inventory/index.js';

export interface InventoryActionHelpers {
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

/** The J00 verbs, in append order. */
export function inventoryActions(h: InventoryActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  const WAREHOUSE_PATCH = {
    type: 'object',
    properties: {
      name: STR,
      description: STR,
      addressLine1: STR,
      addressLine2: STR,
      postalCode: STR,
      city: STR,
      countryCode: STR,
    },
  } as const;

  const LOCATION_PATCH = {
    type: 'object',
    properties: { name: STR, description: STR, locationType: STR, parentId: STR },
  } as const;

  return [
    ctxAction(
      'warehouse_create',
      'write',
      'Create a warehouse (a physical or logical site stock lives at). code is 1-20 chars, unique per workspace case-insensitively (duplicate_code); an empty or over-long code is invalid_code. The FIRST warehouse a workspace creates becomes the workspace default; pass isDefault to force it, which demotes the previous default. Plain master data: posts no journal entry.',
      ctxSchema(
        {
          code: STR,
          name: STR,
          description: STR,
          addressLine1: STR,
          addressLine2: STR,
          postalCode: STR,
          city: STR,
          countryCode: STR,
          isDefault: BOOL,
          idempotencyKey: STR,
        },
        ['code', 'name', 'idempotencyKey'],
      ),
      (ctx, input) => warehouseCreate(ctx, as(input)),
    ),
    ctxAction(
      'warehouse_update',
      'write',
      'Edit a warehouse through a patch object (name, description, address fields, countryCode). code and the default flag are not changed here (use warehouse_set_default for the default). Only the fields present in patch change.',
      ctxSchema({ warehouseId: STR, patch: WAREHOUSE_PATCH, idempotencyKey: STR }, ['warehouseId', 'idempotencyKey']),
      (ctx, input) => warehouseUpdate(ctx, as(input)),
    ),
    ctxAction(
      'warehouse_set_default',
      'write',
      'Make this warehouse the workspace default, demoting the previous default in the same transaction (exactly one default per workspace). An archived warehouse is refused with warehouse_archived. Omitted-location callers resolve to the default warehouse.',
      ctxSchema({ warehouseId: STR, idempotencyKey: STR }, ['warehouseId', 'idempotencyKey']),
      (ctx, input) => warehouseSetDefault(ctx, as(input)),
    ),
    ctxAction(
      'warehouse_archive',
      'write',
      'Soft-archive a warehouse (active=false). Refused with cannot_archive_default while it is the workspace default; refused with location_has_stock or location_in_use when any location under it still holds stock or is referenced by an open stocktake. On success its empty locations are archived too. Deletion is never offered.',
      ctxSchema({ warehouseId: STR, idempotencyKey: STR }, ['warehouseId', 'idempotencyKey']),
      (ctx, input) => warehouseArchive(ctx, as(input)),
    ),
    ctxAction(
      'warehouse_list',
      'read',
      'List the workspace warehouses, default first then by code. Optional active filter (true = only live, false = only archived) and a case-insensitive search over code and name. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema({ active: BOOL, search: STR, savedViewId: STR }),
      (ctx, input) => warehouseList(ctx, as(input)),
    ),
    ctxAction(
      'warehouse_get',
      'read',
      'Read one warehouse by id, archived or not.',
      ctxSchema({ warehouseId: STR }, ['warehouseId']),
      (ctx, input) => warehouseGet(ctx, as(input)),
    ),
    ctxAction(
      'location_create',
      'write',
      'Create a location under a warehouse. code is 1-30 chars, unique within the warehouse case-insensitively (duplicate_code). parentId nests it (null = root under the warehouse); the parent must belong to the SAME warehouse (parent_warehouse_mismatch) and the depth is capped at 8 (max_depth_exceeded). locationType is one of zone|aisle|shelf|bin|staging|other (invalid_location_type). The FIRST location in a warehouse becomes its default; pass isDefaultForWarehouse to force it.',
      ctxSchema(
        {
          warehouseId: STR,
          code: STR,
          name: STR,
          description: STR,
          parentId: STR,
          locationType: STR,
          isDefaultForWarehouse: BOOL,
          idempotencyKey: STR,
        },
        ['warehouseId', 'code', 'name', 'idempotencyKey'],
      ),
      (ctx, input) => locationCreate(ctx, as(input)),
    ),
    ctxAction(
      'location_update',
      'write',
      'Edit a location through a patch object (name, description, locationType, parentId). Re-parenting via parentId is allowed only within the same warehouse (parent_warehouse_mismatch) and never into the location itself or a descendant (location_cycle); the whole subtree moves and its materialised paths and depths are rewritten. Only the fields present in patch change.',
      ctxSchema({ locationId: STR, patch: LOCATION_PATCH, idempotencyKey: STR }, ['locationId', 'idempotencyKey']),
      (ctx, input) => locationUpdate(ctx, as(input)),
    ),
    ctxAction(
      'location_set_default',
      'write',
      'Make this location the default for its warehouse, demoting the previous default in the same transaction. An archived location is refused with location_archived.',
      ctxSchema({ locationId: STR, idempotencyKey: STR }, ['locationId', 'idempotencyKey']),
      (ctx, input) => locationSetDefault(ctx, as(input)),
    ),
    ctxAction(
      'location_archive',
      'write',
      'Soft-archive a location (and its empty descendants). Refused with location_has_stock when the location or any descendant still has non-zero on-hand, location_in_use when an open stocktake references it, or cannot_archive_default when it is a default. Deletion is never offered; historical movements keep their location_id.',
      ctxSchema({ locationId: STR, idempotencyKey: STR }, ['locationId', 'idempotencyKey']),
      (ctx, input) => locationArchive(ctx, as(input)),
    ),
    ctxAction(
      'location_list',
      'read',
      'List locations (flat), filterable by warehouseId, parentId (null = roots), active, and a case-insensitive search over code and name. includeDescendants=true with a parentId returns the whole subtree. Accepts a savedViewId (G00 saved-view seam).',
      ctxSchema(
        { warehouseId: STR, parentId: STR, active: BOOL, search: STR, includeDescendants: BOOL, savedViewId: STR },
      ),
      (ctx, input) => locationList(ctx, as(input)),
    ),
    ctxAction(
      'location_get',
      'read',
      'Read one location by id, archived or not, including its warehouse, parent, materialised path and depth.',
      ctxSchema({ locationId: STR }, ['locationId']),
      (ctx, input) => locationGet(ctx, as(input)),
    ),
    ctxAction(
      'location_tree',
      'read',
      'Return the nested location tree for one warehouse (roots with recursive children), for the GUI tree view.',
      ctxSchema({ warehouseId: STR }, ['warehouseId']),
      (ctx, input) => locationTree(ctx, as(input)),
    ),
    ctxAction(
      'inventory_ensure_default_location',
      'write',
      'Return the workspace default warehouse + location, creating the MAIN / DEFAULT pair if none exists yet. Idempotent and race-safe: concurrent calls produce exactly one pair. This is how a legacy D01 single-location workspace gains a default with no migration.',
      ctxSchema({}),
      (ctx) => inventoryEnsureDefaultLocation(ctx),
    ),
    ctxAction(
      'inventory_balance_by_location',
      'read',
      'On-hand quantity broken down by location, plus a warehouse roll-up. A pure read model over the OP2 stock_movement ledger (SUM of signed qty per item x location), never a cached column. Filter by itemId, warehouseId or locationId; includeZero returns pairs that net to zero. Quantities are integer units.',
      ctxSchema({ itemId: STR, warehouseId: STR, locationId: STR, includeZero: BOOL }),
      (ctx, input) => inventoryBalanceByLocation(ctx, as(input)),
    ),
  ];
}
