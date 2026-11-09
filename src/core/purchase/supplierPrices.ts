/**
 * D02 US-D02.7: per-supplier item prices (append-only `valid_from` history) and the pure
 * `resolveSupplierPrice` read model that lets the D01 low-stock -> D02 reorder loop price a PO with no
 * human. Mirrors D00's price-list discipline row for row: append-only history, integer money, and NO
 * arithmetic in resolution (it selects a stored integer, so P2 holds trivially).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { runTx, contactExists, readItemRow } from './poShared.js';

export interface SupplierPriceUpsertInput {
  supplierContactId?: string;
  itemId?: string;
  supplierSku?: string | null;
  priceRappen?: number;
  currency?: string;
  validFrom?: string;
  leadTimeDays?: number | null;
  idempotencyKey?: string;
}

interface SupplierPriceRow {
  id: string;
  supplier_contact_id: string;
  item_id: string;
  supplier_sku: string | null;
  price_rappen: number;
  currency: string;
  valid_from: string;
  lead_time_days: number | null;
}

export interface ResolvedSupplierPrice {
  priceRappen: number;
  currency: string;
  source: 'supplier' | 'item_cost';
  leadTimeDays: number | null;
}

/**
 * The read model (P5), no write twin. The latest `valid_from <= at` supplier row wins; absent one,
 * the D00 item's `cost_price_minor` is the fallback (`source:'item_cost'`), so an active item never
 * resolves to "not found" and the agent reorder loop cannot stall on pricing. Returns null ONLY when
 * the item itself does not exist (a reference error the caller reports).
 */
export function resolveSupplierPrice(
  ctx: WorkspaceContext,
  input: { supplierContactId: string; itemId: string; at?: string },
): ResolvedSupplierPrice | null {
  const item = readItemRow(ctx, input.itemId);
  if (item === undefined) return null;
  const at = typeof input.at === 'string' && input.at.length > 0 ? input.at.slice(0, 10) : ctx.clock.now().slice(0, 10);
  const row = ctx.store.db
    .prepare(
      `SELECT * FROM supplier_item_price
        WHERE workspace_id = ? AND supplier_contact_id = ? AND item_id = ? AND valid_from <= ?
        ORDER BY valid_from DESC, created_at DESC
        LIMIT 1`,
    )
    .get(ctx.workspaceId, input.supplierContactId, input.itemId, at) as SupplierPriceRow | undefined;
  if (row !== undefined) {
    return { priceRappen: row.price_rappen, currency: row.currency, source: 'supplier', leadTimeDays: row.lead_time_days };
  }
  return { priceRappen: item.cost_price_minor ?? 0, currency: 'CHF', source: 'item_cost', leadTimeDays: null };
}

/** Upsert (really append) a supplier price row. Append-only history: a new `valid_from` is a new row. */
export function supplierPriceUpsert(ctx: WorkspaceContext, input: SupplierPriceUpsertInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (!contactExists(ctx, input.supplierContactId)) return err('invalid_reference', { supplierContactId: input.supplierContactId });
  if (readItemRow(ctx, input.itemId) === undefined) return err('invalid_reference', { itemId: input.itemId });
  if (typeof input.priceRappen !== 'number' || !Number.isInteger(input.priceRappen) || input.priceRappen < 0) {
    return err('invalid_input', { field: 'priceRappen' });
  }
  if (typeof input.validFrom !== 'string' || input.validFrom.length < 10) {
    return err('invalid_input', { field: 'validFrom' });
  }
  if (input.leadTimeDays !== undefined && input.leadTimeDays !== null && (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0)) {
    return err('invalid_input', { field: 'leadTimeDays' });
  }

  const supplierContactId = input.supplierContactId as string;
  const itemId = input.itemId as string;
  const validFrom = input.validFrom.slice(0, 10);

  const run = (): Result => {
    const id = ctx.ids.next('supprice');
    ctx.store.db
      .prepare(
        `INSERT INTO supplier_item_price
           (id, workspace_id, supplier_contact_id, item_id, supplier_sku, price_rappen, currency, valid_from, lead_time_days, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        supplierContactId,
        itemId,
        input.supplierSku ?? null,
        input.priceRappen,
        input.currency ?? 'CHF',
        validFrom,
        input.leadTimeDays ?? null,
        ctx.clock.now(),
      );
    return ok({
      price: {
        id,
        supplierContactId,
        itemId,
        supplierSku: input.supplierSku ?? null,
        priceRappen: input.priceRappen,
        currency: input.currency ?? 'CHF',
        validFrom,
        leadTimeDays: input.leadTimeDays ?? null,
      },
    });
  };

  return runTx(ctx, 'supplier_price_upsert', input.idempotencyKey, run);
}

/** The read (P5): the price history for a supplier/item, plus the resolved effective price when both are given. */
export function supplierPriceList(
  ctx: WorkspaceContext,
  input: { supplierContactId?: string; itemId?: string; at?: string },
): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.supplierContactId === 'string' && input.supplierContactId.length > 0) {
    clauses.push('supplier_contact_id = ?');
    params.push(input.supplierContactId);
  }
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('item_id = ?');
    params.push(input.itemId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM supplier_item_price WHERE ${clauses.join(' AND ')} ORDER BY supplier_contact_id, item_id, valid_from DESC`)
    .all(...params) as SupplierPriceRow[];

  const prices = rows.map((r) => ({
    id: r.id,
    supplierContactId: r.supplier_contact_id,
    itemId: r.item_id,
    supplierSku: r.supplier_sku,
    priceRappen: r.price_rappen,
    currency: r.currency,
    validFrom: r.valid_from,
    leadTimeDays: r.lead_time_days,
  }));

  // When BOTH a supplier and an item are named, the caller (or the agent reorder loop) wants the ONE
  // effective price at `at`, including the item_cost fallback, so the resolver rides the read.
  const resolved =
    typeof input.supplierContactId === 'string' && input.supplierContactId.length > 0 && typeof input.itemId === 'string' && input.itemId.length > 0
      ? resolveSupplierPrice(ctx, { supplierContactId: input.supplierContactId, itemId: input.itemId, ...(input.at !== undefined ? { at: input.at } : {}) })
      : null;

  return ok({ prices, resolved });
}
