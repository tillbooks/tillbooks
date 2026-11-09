/**
 * D00 §H-ENUM: the single source for the item master's closed enumerations.
 *
 * These are the values D01 stock movements, D02 purchasing and D03 orders branch on, so they are
 * FIXED (spec §6b): a customization must never fork them, and the Studio MIRRORS them rather than
 * re-inventing them (`test/style/studio-mirrors-engine-enums.test.mjs`). One module, one export per
 * enum, both the readonly array (for iteration and the boundary check) and the union type (for the
 * engine's own field types).
 *
 * `kind` decides whether an item can carry stock at all (a service is never stockable); `unit` is the
 * quantity dimension a document line and a stock movement both count in; a price list's scope is
 * either a single contact OR a segment, never both (the XOR is checked in `priceLists.ts`).
 */

/** What an item IS: a physical product (stockable) or a service (never stockable). */
export const ITEM_KINDS = ['product', 'service'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export function isItemKind(value: unknown): value is ItemKind {
  return typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * The unit an item is quantified in. `piece`/`flat` are counts; the rest are the SI-ish dimensions a
 * Swiss SME actually invoices and stocks in. `reorder_point_qty` and D01's `stock_movements.qty` are
 * integer thousandths, so a divisible unit (kg, l, m) still counts exactly with no float.
 */
export const ITEM_UNITS = ['piece', 'hour', 'day', 'kg', 'g', 'l', 'm', 'm2', 'm3', 'flat'] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];
export function isItemUnit(value: unknown): value is ItemUnit {
  return typeof value === 'string' && (ITEM_UNITS as readonly string[]).includes(value);
}

/** A price list is scoped to exactly one of these (spec §4, XOR with the concrete id/segment value). */
export const PRICE_LIST_SCOPES = ['contact', 'segment'] as const;
export type PriceListScope = (typeof PRICE_LIST_SCOPES)[number];
