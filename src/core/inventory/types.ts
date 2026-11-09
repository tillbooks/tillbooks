/**
 * J00 shared row shapes and mappers. The DB is snake_case; the wire is camelCase, and the two meet
 * here so `warehouse.ts` / `location.ts` / `balance.ts` cannot drift on a field name.
 */

export interface WarehouseRow {
  id: string;
  workspace_id: string;
  code: string;
  name: string;
  description: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  country_code: string;
  is_default: number;
  active: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string;
  isDefault: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function mapWarehouse(row: WarehouseRow): Warehouse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    postalCode: row.postal_code,
    city: row.city,
    countryCode: row.country_code,
    isDefault: row.is_default === 1,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A J00 location row. It IS a `stock_location` row (spec §4 Reconciliation), so the D01 columns
 * (`name`, `type`, `archived`, `created_at`) sit beside the J00 hierarchy columns. A row created by
 * D01's flat `stock_location_upsert` before J00 carries NULL warehouse_id / code / path and depth 0.
 */
export interface LocationRow {
  id: string;
  workspace_id: string;
  warehouse_id: string | null;
  parent_id: string | null;
  code: string | null;
  name: string;
  description: string | null;
  location_type: string | null;
  path: string | null;
  depth: number;
  is_default_for_warehouse: number;
  archived: number;
  created_at: string;
}

export interface Location {
  id: string;
  warehouseId: string | null;
  parentId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  locationType: string | null;
  path: string | null;
  depth: number;
  isDefaultForWarehouse: boolean;
  active: boolean;
}

export function mapLocation(row: LocationRow): Location {
  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    description: row.description,
    locationType: row.location_type,
    path: row.path,
    depth: row.depth,
    isDefaultForWarehouse: row.is_default_for_warehouse === 1,
    active: row.archived === 0,
  };
}

/** The full column list a J00 location read selects, so every read returns the same shape. */
export const LOCATION_COLUMNS =
  'id, workspace_id, warehouse_id, parent_id, code, name, description, location_type, path, depth, is_default_for_warehouse, archived, created_at';

/** The registered location types (§H-ENUM). `other` is the escape hatch; a free code is admitted there. */
export const LOCATION_TYPES = ['zone', 'aisle', 'shelf', 'bin', 'staging', 'other'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
const LOCATION_TYPE_SET: ReadonlySet<string> = new Set(LOCATION_TYPES);
export function isLocationType(x: unknown): x is LocationType {
  return typeof x === 'string' && LOCATION_TYPE_SET.has(x);
}
