/**
 * A09 items EXTENDED into the D00 products/items master (a reusable line default, now a real catalog
 * row). D00 does not fork A09: the same `item` table and the same `create_item`/`update_item`/
 * `archive_item`/`unarchive_item` verbs gain the master-data fields (`sku`, `kind`, `category_id`,
 * `cost_price_minor`, `variant_of_id`, `track_stock`, `reorder_point_qty`), which reach the engine
 * because the ctx boundary schema is `additionalProperties: true`. `delete_item` (hard-delete with a
 * reference census) is the one genuinely new item-lifecycle verb, defined here and registered from
 * `src/api/item-actions.ts`.
 *
 * The three money-path references stay fixed (spec §6b): prices are integer Rappen (Pattern P2, never
 * a float), the tax code resolves against the single A05 enum (Pattern P6), and the revenue account
 * must be an A01 income account. There is no ledger posting here (master data only); archive is a soft
 * flag, delete is fenced by the census so posted history stays resolvable forever (§H-AUDIT spirit).
 * Every write accepts an idempotencyKey (§H-IDEMPOTENT); every row and every query carries
 * workspace_id (§H-TENANT).
 *
 * ## `unit` NARROWED, and why that is a validation rule rather than a migration (F1, 2026-07-29)
 *
 * A09 shipped `unit` as free text, so a pre-D00 row may hold anything an operator typed ('Stunde',
 * 'Std.', 'Einheit'). D00 narrows it to the `ITEM_UNITS` enum because D01 movements and D02/D03
 * quantities branch on the exact values. Narrowing it for EVERY write turned every such row into a
 * row that cannot be edited at all: `updateItem` re-validated `unit` even when the patch was only
 * changing a price, and the Studio editor resends every loaded field, so an operator got
 * `invalid_unit` on a field he never touched, on an item he could no longer use as a variant parent.
 *
 * So the enum is enforced on the value being INTRODUCED, never on the value already stored:
 * `updateItem` validates `unit` only when the patch actually CHANGES it, and `createItem` validates
 * only a unit that is not carried over from the variant parent. A legacy value therefore round-trips
 * untouched, and the only way to move it is to move it to an enum member.
 *
 * A rewriting migration was the alternative and was rejected: it can only map the free-text values
 * someone thought to enumerate, so it would need this rule underneath it anyway for the leftovers,
 * and it would silently rewrite an operator's own word on a guess ('Einheit' is not obviously
 * `piece`). Data an operator typed is not the engine's to reinterpret; refusing to break it is.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { CURRENCIES } from '../setup/enums.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { applySavedView } from '../customization/views.js';
import { isItemKind, isItemUnit } from './itemEnums.js';

export interface CreateItemInput {
  name: string;
  /** The SALES price, integer Rappen (D00's `sales_price_rappen`). */
  defaultUnitPriceMinor: number;
  /**
   * What `defaultUnitPriceMinor` (and `costPriceMinor`) is priced in. Absent means the workspace base
   * currency, resolved at write time, never a literal (a base currency is a SETTING; `CURRENCIES`
   * admits CHF, EUR and USD).
   */
  currency?: string;
  defaultTaxCode?: string | null;
  revenueAccountId?: string | null;
  unit?: string | null;
  /** D00: a stable per-workspace article number. Optional; unique across the workspace when set. */
  sku?: string | null;
  /** D00: `product` (stockable) or `service` (never stockable). Null when unset (A09 back-compat). */
  kind?: string | null;
  /** D00: the two-level category tree id (`item_category`), or null for uncategorised. */
  categoryId?: string | null;
  /** D00: the Einstandspreis, integer Rappen. Null when not tracked. */
  costPriceMinor?: number | null;
  /** D00: the parent item this is a variant of. Exactly one level (a variant of a variant is refused). */
  variantOfId?: string | null;
  /** D00: whether D01 tracks stock for this item (products only). */
  trackStock?: boolean;
  /** D00: the low-stock threshold in thousandths (matches D01's qty convention). */
  reorderPointQty?: number | null;
  idempotencyKey?: string;
}

export interface ItemPatch {
  name?: string;
  defaultUnitPriceMinor?: number;
  currency?: string;
  defaultTaxCode?: string | null;
  revenueAccountId?: string | null;
  unit?: string | null;
  sku?: string | null;
  kind?: string | null;
  categoryId?: string | null;
  costPriceMinor?: number | null;
  trackStock?: boolean;
  reorderPointQty?: number | null;
}

interface ItemRow {
  id: string;
  workspace_id: string;
  name: string;
  default_unit_price_minor: number;
  currency: string;
  default_tax_code: string | null;
  revenue_account_id: string | null;
  unit: string | null;
  archived: number;
  created_at: string;
  item_sku: string | null;
  kind: string | null;
  category_id: string | null;
  cost_price_minor: number | null;
  variant_of_id: string | null;
  track_stock: number;
  reorder_point_qty: number | null;
}

function mapItem(row: ItemRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    defaultUnitPriceMinor: row.default_unit_price_minor,
    currency: row.currency,
    defaultTaxCode: row.default_tax_code,
    revenueAccountId: row.revenue_account_id,
    unit: row.unit,
    archived: row.archived === 1,
    createdAt: row.created_at,
    sku: row.item_sku,
    kind: row.kind,
    categoryId: row.category_id,
    costPriceMinor: row.cost_price_minor,
    variantOfId: row.variant_of_id,
    trackStock: row.track_stock === 1,
    reorderPointQty: row.reorder_point_qty,
  };
}

function readItem(ctx: WorkspaceContext, itemId: string): ItemRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, itemId) as ItemRow | undefined;
}

function taxCodeExists(ctx: WorkspaceContext, code: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT code FROM tax_code WHERE workspace_id = ? AND code = ?')
    .get(ctx.workspaceId, code) as { code: string } | undefined;
  return row !== undefined;
}

function isIncomeAccount(ctx: WorkspaceContext, accountId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as { type: string } | undefined;
  return row !== undefined && row.type === 'income';
}

function categoryExists(ctx: WorkspaceContext, categoryId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM item_category WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, categoryId) as { id: string } | undefined;
  return row !== undefined;
}

/** True when `sku` is already used by a DIFFERENT item in this workspace (uniqueness, §H-TENANT). */
function skuTaken(ctx: WorkspaceContext, sku: string, exceptItemId: string | null): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM item WHERE workspace_id = ? AND item_sku = ? AND id != ?')
    .get(ctx.workspaceId, sku, exceptItemId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

/** Whether a table exists in this database, so a D01-dependent check degrades gracefully when absent. */
function tableExists(ctx: WorkspaceContext, table: string): boolean {
  const row = ctx.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * D01 on-hand for one item, or 0 when D01 is not installed (P9 graceful degradation: the stock table
 * simply does not exist yet, so the check that would gate turning `track_stock` off cannot fire).
 */
function stockOnHand(ctx: WorkspaceContext, itemId: string): number {
  if (!tableExists(ctx, 'stock_movement')) return 0;
  const row = ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS onHand FROM stock_movement WHERE workspace_id = ? AND item_id = ?')
    .get(ctx.workspaceId, itemId) as { onHand: number } | undefined;
  return row?.onHand ?? 0;
}

/**
 * Reject a `unit` that is being INTRODUCED and is not an `ITEM_UNITS` member.
 *
 * `stored` is the value this write is replacing (the patched row's current unit, or the variant
 * parent's). A write that leaves it where it is passes untouched, which is what keeps a pre-D00
 * free-text unit editable (see the header). Clearing to null is always allowed.
 */
function rejectIntroducedUnit(next: string | null | undefined, stored: string | null): Result | null {
  if (next === undefined || next === null) return null;
  if (next === stored) return null;
  if (!isItemUnit(next)) return err('invalid_unit', { unit: next });
  return null;
}

/**
 * Validate the item fields shared by create and update. Each is validated only when defined, so a
 * patch that omits a field is not forced to resend it. Returns the first rejection, or null.
 *
 * `unit` is deliberately NOT here: it is the one field whose admissible set narrowed after rows were
 * already written, so it needs the stored value to judge against and is checked by
 * `rejectIntroducedUnit` at each call site instead.
 */
function validateItemFields(
  ctx: WorkspaceContext,
  fields: {
    defaultUnitPriceMinor?: number | undefined;
    currency?: string | undefined;
    defaultTaxCode?: string | null | undefined;
    revenueAccountId?: string | null | undefined;
    kind?: string | null | undefined;
    categoryId?: string | null | undefined;
    costPriceMinor?: number | null | undefined;
    reorderPointQty?: number | null | undefined;
  },
): Result | null {
  if (
    fields.defaultUnitPriceMinor !== undefined &&
    (!Number.isInteger(fields.defaultUnitPriceMinor) || fields.defaultUnitPriceMinor < 0)
  ) {
    return err('invalid_price');
  }
  if (
    fields.costPriceMinor !== undefined &&
    fields.costPriceMinor !== null &&
    (!Number.isInteger(fields.costPriceMinor) || fields.costPriceMinor < 0)
  ) {
    return err('invalid_cost_price', { costPriceMinor: fields.costPriceMinor });
  }
  if (
    fields.reorderPointQty !== undefined &&
    fields.reorderPointQty !== null &&
    (!Number.isInteger(fields.reorderPointQty) || fields.reorderPointQty < 0)
  ) {
    return err('invalid_reorder_point', { reorderPointQty: fields.reorderPointQty });
  }
  if (fields.currency !== undefined && !CURRENCIES.has(fields.currency)) {
    return err('invalid_currency', { currency: fields.currency });
  }
  if (fields.kind !== undefined && fields.kind !== null && !isItemKind(fields.kind)) {
    return err('invalid_kind', { kind: fields.kind });
  }
  if (
    fields.defaultTaxCode !== undefined &&
    fields.defaultTaxCode !== null &&
    !taxCodeExists(ctx, fields.defaultTaxCode)
  ) {
    return err('unknown_tax_code', { taxCode: fields.defaultTaxCode });
  }
  if (
    fields.revenueAccountId !== undefined &&
    fields.revenueAccountId !== null &&
    !isIncomeAccount(ctx, fields.revenueAccountId)
  ) {
    return err('invalid_revenue_account', { revenueAccountId: fields.revenueAccountId });
  }
  if (
    fields.categoryId !== undefined &&
    fields.categoryId !== null &&
    !categoryExists(ctx, fields.categoryId)
  ) {
    return err('category_not_found', { categoryId: fields.categoryId });
  }
  return null;
}

export function createItem(ctx: WorkspaceContext, input: CreateItemInput): Result {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err('invalid_input', { field: 'name' });
  }

  // Variant inheritance (US-D00.2): a snapshot of the parent's defaults at creation time, never a
  // live link, so later parent edits never silently mutate a variant. Exactly one level deep.
  let parent: ItemRow | undefined;
  if (input.variantOfId !== undefined && input.variantOfId !== null) {
    parent = readItem(ctx, input.variantOfId);
    if (parent === undefined) return err('parent_not_found', { variantOfId: input.variantOfId });
    if (parent.variant_of_id !== null) return err('variant_chain_not_allowed', { variantOfId: input.variantOfId });
  }

  const resolved = {
    unit: input.unit !== undefined ? input.unit : parent?.unit ?? null,
    defaultTaxCode: input.defaultTaxCode !== undefined ? input.defaultTaxCode : parent?.default_tax_code ?? null,
    categoryId: input.categoryId !== undefined ? input.categoryId : parent?.category_id ?? null,
    kind: input.kind !== undefined ? input.kind : parent?.kind ?? null,
    defaultUnitPriceMinor:
      input.defaultUnitPriceMinor !== undefined ? input.defaultUnitPriceMinor : parent?.default_unit_price_minor ?? 0,
    costPriceMinor: input.costPriceMinor !== undefined ? input.costPriceMinor : parent?.cost_price_minor ?? null,
    trackStock: input.trackStock !== undefined ? input.trackStock : parent?.track_stock === 1,
    reorderPointQty:
      input.reorderPointQty !== undefined ? input.reorderPointQty : parent?.reorder_point_qty ?? null,
    revenueAccountId: input.revenueAccountId !== undefined ? input.revenueAccountId : parent?.revenue_account_id ?? null,
  };

  const invalid = validateItemFields(ctx, {
    defaultUnitPriceMinor: resolved.defaultUnitPriceMinor,
    currency: input.currency,
    defaultTaxCode: resolved.defaultTaxCode,
    revenueAccountId: resolved.revenueAccountId,
    kind: resolved.kind,
    categoryId: resolved.categoryId,
    costPriceMinor: resolved.costPriceMinor,
    reorderPointQty: resolved.reorderPointQty,
  });
  if (invalid) return invalid;

  // The unit a variant CARRIES OVER from its parent is already-stored data, so it passes even when the
  // parent predates the enum; a unit this call introduces must be an ITEM_UNITS member. Without a
  // parent the carried-over value is null, so a plain create is still validated strictly.
  const badUnit = rejectIntroducedUnit(resolved.unit, parent?.unit ?? null);
  if (badUnit) return badUnit;

  // A service is never stockable (US-D00.5). Only refuse when the kind is definitely a service; an
  // un-kinded A09 item may still carry the flag inertly.
  if (resolved.trackStock && resolved.kind === 'service') return err('services_not_stockable');

  const sku = typeof input.sku === 'string' && input.sku.trim().length > 0 ? input.sku.trim() : null;
  if (sku !== null && skuTaken(ctx, sku, null)) return err('sku_taken', { sku });

  const run = (): Result => {
    const id = ctx.ids.next('item');
    ctx.store.db
      .prepare(
        `INSERT INTO item (
           id, workspace_id, name, default_unit_price_minor, currency,
           default_tax_code, revenue_account_id, unit, created_at,
           item_sku, kind, category_id, cost_price_minor, variant_of_id, track_stock, reorder_point_qty
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.name.trim(),
        resolved.defaultUnitPriceMinor,
        // Resolved, not defaulted: the single place an unnamed item currency is decided, agreeing with
        // what postEntry will book the resulting document line in.
        input.currency ?? baseCurrencyOf(ctx),
        resolved.defaultTaxCode,
        resolved.revenueAccountId,
        resolved.unit,
        ctx.clock.now(),
        sku,
        resolved.kind,
        resolved.categoryId,
        resolved.costPriceMinor,
        input.variantOfId ?? null,
        resolved.trackStock ? 1 : 0,
        resolved.reorderPointQty,
      );
    return ok({ item: mapItem(readItem(ctx, id) as ItemRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_item', run);
  }
  return run();
}

export function updateItem(ctx: WorkspaceContext, input: { itemId: string; patch: ItemPatch }): Result {
  const existing = readItem(ctx, input.itemId);
  if (existing === undefined) return err('not_found', { itemId: input.itemId });

  const patch = input.patch ?? {};
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return err('invalid_input', { field: 'name' });
  }
  const invalid = validateItemFields(ctx, patch);
  if (invalid) return invalid;

  // Only a unit the patch actually CHANGES is held to the enum, so a pre-D00 free-text unit survives
  // an edit to any other field (F1: the Studio editor resends every loaded field on save).
  const badUnit = rejectIntroducedUnit(patch.unit, existing.unit);
  if (badUnit) return badUnit;

  // The kind the item WILL have after this patch, and the track_stock it will carry. A service is
  // never stockable, whichever half of the pair the patch is setting (US-D00.5).
  const nextKind = patch.kind !== undefined ? patch.kind : existing.kind;
  const nextTrackStock = patch.trackStock !== undefined ? patch.trackStock : existing.track_stock === 1;
  if (nextTrackStock && nextKind === 'service') return err('services_not_stockable');

  // Turning stock tracking OFF while D01 still reports on-hand is refused (P9: if D01 is absent the
  // check degrades and the flag is inert).
  if (patch.trackStock === false && existing.track_stock === 1 && stockOnHand(ctx, input.itemId) !== 0) {
    return err('stock_on_hand_nonzero', { itemId: input.itemId });
  }

  if (patch.sku !== undefined && patch.sku !== null && patch.sku.trim().length > 0) {
    if (skuTaken(ctx, patch.sku.trim(), input.itemId)) return err('sku_taken', { sku: patch.sku.trim() });
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const push = (col: string, value: string | number | null): void => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) push('name', patch.name.trim());
  if (patch.defaultUnitPriceMinor !== undefined) push('default_unit_price_minor', patch.defaultUnitPriceMinor);
  if (patch.currency !== undefined) push('currency', patch.currency);
  if (patch.defaultTaxCode !== undefined) push('default_tax_code', patch.defaultTaxCode);
  if (patch.revenueAccountId !== undefined) push('revenue_account_id', patch.revenueAccountId);
  if (patch.unit !== undefined) push('unit', patch.unit);
  if (patch.sku !== undefined) {
    const trimmed = typeof patch.sku === 'string' && patch.sku.trim().length > 0 ? patch.sku.trim() : null;
    push('item_sku', trimmed);
  }
  if (patch.kind !== undefined) push('kind', patch.kind);
  if (patch.categoryId !== undefined) push('category_id', patch.categoryId);
  if (patch.costPriceMinor !== undefined) push('cost_price_minor', patch.costPriceMinor);
  if (patch.trackStock !== undefined) push('track_stock', patch.trackStock ? 1 : 0);
  if (patch.reorderPointQty !== undefined) push('reorder_point_qty', patch.reorderPointQty);

  if (sets.length > 0) {
    ctx.store.db
      .prepare(`UPDATE item SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
      .run(...params, ctx.workspaceId, input.itemId);
  }
  return ok({ item: mapItem(readItem(ctx, input.itemId) as ItemRow) });
}

export function archiveItem(ctx: WorkspaceContext, input: { itemId: string }): Result {
  const result = ctx.store.db
    .prepare('UPDATE item SET archived = 1 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.itemId);
  if (result.changes === 0) return err('not_found', { itemId: input.itemId });
  return ok({ item: mapItem(readItem(ctx, input.itemId) as ItemRow) });
}

export function unarchiveItem(ctx: WorkspaceContext, input: { itemId: string }): Result {
  const result = ctx.store.db
    .prepare('UPDATE item SET archived = 0 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.itemId);
  if (result.changes === 0) return err('not_found', { itemId: input.itemId });
  return ok({ item: mapItem(readItem(ctx, input.itemId) as ItemRow) });
}

/**
 * D00 US-D00.6 hard-delete, fenced by a reference census: an item referenced ANYWHERE (a document
 * line, a price-list row, a variant, a D01 stock movement, or a G00 custom-field value) can never be
 * hard-deleted, so posted history stays resolvable forever. The verb returns `item_referenced` with
 * the reference kinds, and the caller offers archive instead. Only a truly orphan item is removed.
 *
 * `custom_field_value` is in the census because spec §6b makes `item` the headline custom-field
 * attachment point (F9). Its rows key on (`entity_kind`, `entity_id`) rather than on an `item_id`
 * column, so a hard delete without this check leaves an operator's own typed values stranded on a
 * dead `entity_id`, invisible to every screen and undeletable through any verb.
 */
export function deleteItem(ctx: WorkspaceContext, input: { itemId: string; idempotencyKey?: string }): Result {
  const run = (): Result => {
    const existing = readItem(ctx, input.itemId);
    if (existing === undefined) return err('not_found', { itemId: input.itemId });

    const refs: string[] = [];
    const count = (table: string, column: string): number => {
      if (!tableExists(ctx, table)) return 0;
      const row = ctx.store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND ${column} = ?`)
        .get(ctx.workspaceId, input.itemId) as { n: number };
      return row.n;
    };
    // The G00 attachment point, counted on the (entity_kind, entity_id) pair the table is actually
    // keyed by. `tableExists` guards it the same way the D01 probe is guarded (P9).
    const customFieldValues = (): number => {
      if (!tableExists(ctx, 'custom_field_value')) return 0;
      const row = ctx.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ? AND entity_kind = 'item' AND entity_id = ?",
        )
        .get(ctx.workspaceId, input.itemId) as { n: number };
      return row.n;
    };

    if (count('document_line', 'item_id') > 0) refs.push('document_line');
    if (count('price_list_item', 'item_id') > 0) refs.push('price_list_item');
    if (count('item', 'variant_of_id') > 0) refs.push('variant');
    if (count('stock_movement', 'item_id') > 0) refs.push('stock_movement');
    if (customFieldValues() > 0) refs.push('custom_field_value');
    if (refs.length > 0) return err('item_referenced', { itemId: input.itemId, refs });

    ctx.store.db.prepare('DELETE FROM item WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, input.itemId);
    return ok({ itemId: input.itemId, deleted: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'delete_item', run);
  }
  return run();
}

export function getItem(ctx: WorkspaceContext, input: { itemId: string }): Result {
  const row = readItem(ctx, input.itemId);
  if (row === undefined) return err('not_found', { itemId: input.itemId });
  return ok({ item: mapItem(row) });
}

export function listItems(
  ctx: WorkspaceContext,
  filter: {
    query?: string;
    includeArchived?: boolean;
    kind?: string;
    categoryId?: string;
    savedViewId?: string;
  } = {},
): Result {
  // The G00 seam, one unconditional call, exactly as `listDocuments` makes it (F5 retrofit).
  const viewed = applySavedView(ctx, 'item', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (!filter.includeArchived) clauses.push('archived = 0');
  if (filter.query !== undefined && filter.query.length > 0) {
    clauses.push('(name LIKE ? OR item_sku LIKE ?)');
    params.push(`%${filter.query}%`, `%${filter.query}%`);
  }
  if (filter.kind !== undefined && filter.kind.length > 0) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.categoryId !== undefined && filter.categoryId.length > 0) {
    clauses.push('category_id = ?');
    params.push(filter.categoryId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM item WHERE ${clauses.join(' AND ')} ORDER BY name`)
    .all(...params) as ItemRow[];
  return ok({ items: rows.map(mapItem) });
}
