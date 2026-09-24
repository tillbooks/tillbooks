/**
 * D00 US-D00.4: price lists and the single `resolvePrice` read model.
 *
 * A price list is scoped to exactly one contact OR one segment (the XOR is checked here, not by a DB
 * CHECK). Its prices are APPEND-ONLY history: `set_price` writes a new `price_list_item` row keyed by
 * `valid_from`, never updating a past one, so `resolvePrice` at any `at` selects a stored integer with
 * no arithmetic and no rounding point (Pattern P2/P5).
 *
 * `resolvePrice` is the ONE place a price is resolved (the OP1/P6 single-resolver discipline): the
 * precedence is **contact -> segment -> base**, and within a scope the latest `valid_from <= at` wins.
 * The item's own `default_unit_price_minor` is the base and is always defined, so resolution never
 * returns "not found" for an existing active item. Segment matching reads the contact's C00 segment;
 * C00 is being built concurrently, so `contactSegments` degrades gracefully (P9): until the
 * `contact.segment` attribute exists, the segment tier is inert and resolution is exact over
 * contact -> base.
 *
 * Every row and every query carries workspace_id (§H-TENANT); writes take an idempotencyKey
 * (§H-IDEMPOTENT).
 *
 * ## EVERY DATE IN THIS FILE IS A VALIDATED, NORMALISED ISO DAY (F2/F3, 2026-07-29)
 *
 * `valid_from <= at` is a STRING comparison, which is exactly right for `YYYY-MM-DD` and silently
 * wrong for anything else, and "silently wrong" here means a resolved price that is not the price the
 * operator set, snapshotted onto a document line that becomes an invoice. Both defects were real:
 *
 *  - `at` was accepted as any non-empty string. `'16.07.2026'`, the de-CH format this capability's own
 *    surface renders, sorts BELOW every `'2026-…'` row, so every contact price was skipped and the
 *    call fell back to the base price with `ok:true`. `'heute'` sorts ABOVE every row, so a price with
 *    `valid_from` in 2099 won.
 *  - `validFrom` was checked with an UNANCHORED, calendar-blind `/^\d{4}-\d{2}-\d{2}/`, so
 *    `'2026-13-99'` and `'2026-01-01-GARBAGE'` stored verbatim. A month-13 row sorts after every real
 *    date of its year, so the price the operator meant to set was inert for over a year while the
 *    surface showed the row as set, and history is append-only so it could only be shadowed.
 *
 * So both go through A05's `isValidRateDate` / `toIsoDay`, the validator this repo already owns for
 * exactly this hazard: rejected at the boundary, and stored and compared as the bare day, so a full
 * ISO instant and the day it names resolve to the same answer.
 *
 * ## A PRICE ROW CAN BE REMOVED, AND WHY THAT IS NOT A HOLE IN THE HISTORY (F6, 2026-07-30)
 *
 * Until now nothing removed a `price_list_item` row or a `price_list`. `deleteItem`'s reference census
 * counts `price_list_item`, so an item that had ever been priced could never be hard-deleted, and the
 * §8 browser flow ("falls back to base after list removal") described a step no verb could perform.
 * The fence was intended; that consequence was not.
 *
 * `unsetPriceListPrice` and `deletePriceList` close it, and the reason it is safe is specific rather
 * than general: **a document line SNAPSHOTS the price it resolved** (spec §2 US-D00.4), so the price
 * ROW is not the history any statutory claim rests on, unlike an A11 invoice line or a D01 movement.
 * Removing it changes what a FUTURE resolve answers and nothing that was ever issued. That is exactly
 * the property `document_line` does not have, and it is why these two verbs exist and no equivalent
 * ever will for a posted line.
 *
 * `deletePriceList` CASCADES its rows, deliberately. `price_list_item.price_list_id` is NOT NULL and
 * there is no verb and no query that reads a row except through its list, so a list deleted without
 * its rows would leave unreachable orphans that still count in `deleteItem`'s census: the precise hole
 * being closed, reopened one level down.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { CURRENCIES } from '../setup/enums.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { isValidRateDate, toIsoDay } from '../vat/rateEras.js';

interface PriceListRow {
  id: string;
  workspace_id: string;
  name: string;
  contact_id: string | null;
  segment: string | null;
  created_at: string;
}

interface PriceRow {
  id: string;
  price_list_id: string;
  item_id: string;
  price_minor: number;
  currency: string;
  valid_from: string;
  created_at: string;
}

interface ItemPriceFields {
  default_unit_price_minor: number;
  currency: string;
  archived: number;
}

function mapPriceList(row: PriceListRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    contactId: row.contact_id,
    segment: row.segment,
    createdAt: row.created_at,
  };
}

function readPriceList(ctx: WorkspaceContext, priceListId: string): PriceListRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM price_list WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, priceListId) as PriceListRow | undefined;
}

function contactExists(ctx: WorkspaceContext, contactId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { id: string } | undefined;
  return row !== undefined;
}

function readItemPriceFields(ctx: WorkspaceContext, itemId: string): ItemPriceFields | undefined {
  return ctx.store.db
    .prepare('SELECT default_unit_price_minor, currency, archived FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, itemId) as ItemPriceFields | undefined;
}

function columnExists(ctx: WorkspaceContext, table: string, column: string): boolean {
  const cols = ctx.store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Whether a table exists, so a census over a not-yet-installed capability's table degrades (P9). */
function tableExists(ctx: WorkspaceContext, table: string): boolean {
  const row = ctx.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * The segments a contact belongs to. C00 owns the segment attribute and is not landed yet, so this
 * reads `contact.segment` only when the column exists and returns [] otherwise (P9 graceful
 * degradation): the segment tier of `resolvePrice` is simply inert until C00 ships the attribute.
 */
function contactSegments(ctx: WorkspaceContext, contactId: string): string[] {
  if (!columnExists(ctx, 'contact', 'segment')) return [];
  const row = ctx.store.db
    .prepare('SELECT segment FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { segment: string | null } | undefined;
  return row?.segment !== undefined && row.segment !== null && row.segment !== '' ? [row.segment] : [];
}

export interface UpsertPriceListInput {
  priceListId?: string | null;
  name?: string;
  contactId?: string | null;
  segment?: string | null;
  idempotencyKey?: string;
}

/**
 * An OTHER price list already holding this exact scope, or undefined.
 *
 * Two lists in one scope made `resolvePrice` pick by insertion order (F4). It was deterministic,
 * `rowid` broke the tie, and that is the whole problem: which of two prices an agent quotes was
 * decided by which row was typed second, and nothing on the surface or in the payload said so. The
 * spec fixes precedence BETWEEN scopes (contact then segment then base) and says nothing about within
 * one, so the ambiguity is refused at the door rather than resolved by an invisible rule, mirroring
 * the `scope_ambiguous` discipline three lines up. One scope, at most one list, and the within-list
 * `valid_from` history stays the only thing that decides.
 */
function otherListInScope(
  ctx: WorkspaceContext,
  scope: { contactId: string | null; segment: string | null },
  exceptId: string | null,
): PriceListRow | undefined {
  const sql =
    scope.contactId !== null
      ? 'SELECT * FROM price_list WHERE workspace_id = ? AND contact_id = ? AND id != ? LIMIT 1'
      : 'SELECT * FROM price_list WHERE workspace_id = ? AND segment = ? AND id != ? LIMIT 1';
  return ctx.store.db
    .prepare(sql)
    .get(ctx.workspaceId, scope.contactId ?? scope.segment, exceptId ?? '') as PriceListRow | undefined;
}

export function upsertPriceList(ctx: WorkspaceContext, input: UpsertPriceListInput): Result {
  const editing = typeof input.priceListId === 'string' && input.priceListId.length > 0;
  const current = editing ? readPriceList(ctx, input.priceListId as string) : undefined;
  if (editing && current === undefined) return err('not_found', { priceListId: input.priceListId });

  const name = input.name !== undefined ? input.name.trim() : current?.name;
  if (name === undefined || name.length === 0) return err('invalid_input', { field: 'name' });

  const contactId = input.contactId !== undefined ? input.contactId : current?.contact_id ?? null;
  const segment =
    input.segment !== undefined ? (input.segment === '' ? null : input.segment) : current?.segment ?? null;

  // Scope is contact XOR segment: exactly one is set (spec §4, scope_ambiguous otherwise).
  const hasContact = typeof contactId === 'string' && contactId.length > 0;
  const hasSegment = typeof segment === 'string' && segment.length > 0;
  if (hasContact === hasSegment) return err('scope_ambiguous', { contactId, segment });
  if (hasContact && !contactExists(ctx, contactId as string)) return err('contact_not_found', { contactId });

  const run = (): Result => {
    // INSIDE `run`, so a replay under the same idempotencyKey still returns the stored success:
    // `rememberIdempotent` recalls before it computes, and the row this call itself wrote would
    // otherwise make its own replay look like a duplicate.
    const clash = otherListInScope(
      ctx,
      { contactId: hasContact ? (contactId as string) : null, segment: hasSegment ? (segment as string) : null },
      editing ? (input.priceListId as string) : null,
    );
    if (clash !== undefined) {
      return err('scope_taken', {
        contactId: hasContact ? contactId : null,
        segment: hasSegment ? segment : null,
        priceListId: clash.id,
      });
    }

    if (editing) {
      ctx.store.db
        .prepare('UPDATE price_list SET name = ?, contact_id = ?, segment = ? WHERE workspace_id = ? AND id = ?')
        .run(name, hasContact ? contactId : null, hasSegment ? segment : null, ctx.workspaceId, input.priceListId);
      return ok({ priceList: mapPriceList(readPriceList(ctx, input.priceListId as string) as PriceListRow) });
    }
    const id = ctx.ids.next('price_list');
    ctx.store.db
      .prepare('INSERT INTO price_list (id, workspace_id, name, contact_id, segment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ctx.workspaceId, name, hasContact ? contactId : null, hasSegment ? segment : null, ctx.clock.now());
    return ok({ priceList: mapPriceList(readPriceList(ctx, id) as PriceListRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'price_lists_upsert', run);
  }
  return run();
}

export interface SetPriceInput {
  priceListId: string;
  itemId: string;
  priceMinor: number;
  currency?: string;
  validFrom: string;
  idempotencyKey?: string;
}

export function setPriceListPrice(ctx: WorkspaceContext, input: SetPriceInput): Result {
  const list = readPriceList(ctx, input.priceListId);
  if (list === undefined) return err('not_found', { priceListId: input.priceListId });

  const item = readItemPriceFields(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });

  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) return err('invalid_price');
  if (input.currency !== undefined && !CURRENCIES.has(input.currency)) {
    return err('invalid_currency', { currency: input.currency });
  }
  // A real calendar day, anchored at both ends (see the header): the previous pattern let
  // '2026-13-99' and '2026-01-01-GARBAGE' through and both sort after every real date of their year.
  if (!isValidRateDate(input.validFrom)) return err('invalid_input', { field: 'validFrom' });
  const validFrom = toIsoDay(input.validFrom);
  const currency = input.currency ?? item.currency ?? baseCurrencyOf(ctx);

  const run = (): Result => {
    const id = ctx.ids.next('price_list_item');
    ctx.store.db
      .prepare(
        `INSERT INTO price_list_item (id, workspace_id, price_list_id, item_id, price_minor, currency, valid_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.priceListId, input.itemId, input.priceMinor, currency, validFrom, ctx.clock.now());
    return ok({
      priceListItem: {
        id,
        priceListId: input.priceListId,
        itemId: input.itemId,
        priceMinor: input.priceMinor,
        currency,
        validFrom,
      },
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'price_lists_set_price', run);
  }
  return run();
}

export interface UnsetPriceInput {
  priceListId: string;
  itemId: string;
  /** Remove only the row effective from this day. Absent removes the item's whole history in the list. */
  validFrom?: string | null;
  idempotencyKey?: string;
}

/**
 * Remove an item's price from a list: one dated row, or the item's whole history in that list.
 *
 * The two granularities are one verb because they are one intent expressed at two scales. Without
 * `validFrom` the meaning is "this list no longer prices this item", which is what makes `resolvePrice`
 * fall through to the next scope and what lets `deleteItem`'s census reach zero. With `validFrom` the
 * meaning is "that dated row was a mistake", which is the only way to retract an append-only history
 * row that would otherwise have to be shadowed by a later one for ever.
 *
 * Idempotent ON ROWS rather than on the answer: `removed` reports how many rows this call took away,
 * so a replay under the same key returns the stored count and a second call without a key returns
 * `removed: 0`. Either way the row count afterwards is the same, which is the invariant that matters.
 */
export function unsetPriceListPrice(ctx: WorkspaceContext, input: UnsetPriceInput): Result {
  const list = readPriceList(ctx, input.priceListId);
  if (list === undefined) return err('not_found', { priceListId: input.priceListId });
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) {
    return err('invalid_input', { field: 'itemId' });
  }

  // Same validator as `setPriceListPrice`, for the same reason: a `validFrom` that does not sort
  // would silently match no row and read as a successful removal (see the header).
  const given = typeof input.validFrom === 'string' && input.validFrom.length > 0 ? input.validFrom : null;
  if (given !== null && !isValidRateDate(given)) return err('invalid_input', { field: 'validFrom' });
  const validFrom = given === null ? null : toIsoDay(given);

  const run = (): Result => {
    const result =
      validFrom === null
        ? ctx.store.db
            .prepare('DELETE FROM price_list_item WHERE workspace_id = ? AND price_list_id = ? AND item_id = ?')
            .run(ctx.workspaceId, input.priceListId, input.itemId)
        : ctx.store.db
            .prepare(
              'DELETE FROM price_list_item WHERE workspace_id = ? AND price_list_id = ? AND item_id = ? AND valid_from = ?',
            )
            .run(ctx.workspaceId, input.priceListId, input.itemId, validFrom);
    return ok({
      priceListId: input.priceListId,
      itemId: input.itemId,
      validFrom,
      removed: result.changes,
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'price_lists_unset_price', run);
  }
  return run();
}

/**
 * Delete a price list and, with it, its price rows.
 *
 * The census mirrors `deleteItem`'s: anything that still POINTS AT the list refuses the delete with
 * `price_list_referenced` and its reference kinds, so nothing is ever stranded on a dead id. Today the
 * only candidate is a G00 `custom_field_value` keyed on (`entity_kind`, `entity_id`), and spec §6b
 * registers `price_list` as an OP3 entity kind, which is deferred to G00's own wiring pass. The check
 * is here BEFORE that line lands rather than after: it is guarded by `tableExists` exactly as
 * `deleteItem`'s is, so it costs nothing today and cannot be forgotten the day the enum line arrives.
 *
 * `price_list_item` is NOT in the census; it is cascaded (see the header). That asymmetry is the whole
 * decision: a price row has no reader apart from its list, and a document line already holds the
 * snapshot of whatever it resolved.
 */
export function deletePriceList(
  ctx: WorkspaceContext,
  input: { priceListId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const existing = readPriceList(ctx, input.priceListId);
    if (existing === undefined) return err('not_found', { priceListId: input.priceListId });

    const refs: string[] = [];
    if (tableExists(ctx, 'custom_field_value')) {
      const row = ctx.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM custom_field_value WHERE workspace_id = ? AND entity_kind = 'price_list' AND entity_id = ?",
        )
        .get(ctx.workspaceId, input.priceListId) as { n: number };
      if (row.n > 0) refs.push('custom_field_value');
    }
    if (refs.length > 0) return err('price_list_referenced', { priceListId: input.priceListId, refs });

    const removed = ctx.store.db
      .prepare('DELETE FROM price_list_item WHERE workspace_id = ? AND price_list_id = ?')
      .run(ctx.workspaceId, input.priceListId).changes;
    ctx.store.db
      .prepare('DELETE FROM price_list WHERE workspace_id = ? AND id = ?')
      .run(ctx.workspaceId, input.priceListId);
    return ok({ priceListId: input.priceListId, deleted: true, removedPrices: removed });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    // `rememberIdempotent` already runs `compute` inside one transaction, so the cascade and the list
    // row commit together on this path.
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'price_lists_delete', run);
  }
  // Without a key there is no surrounding transaction, and this verb writes TWO statements: a crash
  // between them would leave the list gone and its rows orphaned, which is the state the cascade
  // exists to prevent.
  return ctx.store.tx(run);
}

export function listPriceLists(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare('SELECT * FROM price_list WHERE workspace_id = ? ORDER BY name')
    .all(ctx.workspaceId) as PriceListRow[];
  return ok({ priceLists: rows.map(mapPriceList) });
}

export function getPriceList(ctx: WorkspaceContext, input: { priceListId: string }): Result {
  const list = readPriceList(ctx, input.priceListId);
  if (list === undefined) return err('not_found', { priceListId: input.priceListId });
  const prices = ctx.store.db
    .prepare(
      'SELECT id, price_list_id, item_id, price_minor, currency, valid_from, created_at FROM price_list_item WHERE workspace_id = ? AND price_list_id = ? ORDER BY item_id, valid_from DESC',
    )
    .all(ctx.workspaceId, input.priceListId) as PriceRow[];
  return ok({
    priceList: mapPriceList(list),
    prices: prices.map((p) => ({
      id: p.id,
      itemId: p.item_id,
      priceMinor: p.price_minor,
      currency: p.currency,
      validFrom: p.valid_from,
    })),
  });
}

/**
 * The effective price_list_item for one item across a set of lists at `at`: the latest
 * `valid_from <= at`, or undefined when no list in the set carries the item yet.
 *
 * `at` is a normalised ISO day by the time it gets here (see the header), so the comparison is a
 * total order over real dates. The remaining tie is TWO ROWS IN ONE LIST SHARING A `valid_from`,
 * where the later-written row wins: that is append-only price history correcting itself, the
 * `created_at`/`rowid` order says which correction is current, and it is asserted in
 * `test/sales/item-d00.test.mjs`. `upsertPriceList` refuses a second list in one scope, so the tie
 * can no longer span two lists, where nothing would have said which one was answering.
 */
function effectiveIn(
  ctx: WorkspaceContext,
  listIds: string[],
  itemId: string,
  at: string,
): PriceRow | undefined {
  if (listIds.length === 0) return undefined;
  const placeholders = listIds.map(() => '?').join(', ');
  return ctx.store.db
    .prepare(
      `SELECT * FROM price_list_item
       WHERE workspace_id = ? AND item_id = ? AND valid_from <= ? AND price_list_id IN (${placeholders})
       ORDER BY valid_from DESC, created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(ctx.workspaceId, itemId, at, ...listIds) as PriceRow | undefined;
}

export interface ResolvePriceInput {
  itemId: string;
  contactId?: string | null;
  at?: string | null;
}

export function resolvePrice(ctx: WorkspaceContext, input: ResolvePriceInput): Result {
  const item = readItemPriceFields(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });
  // Agents must not quote dead SKUs (spec §2, US-D00.4 error case).
  if (item.archived === 1) return err('item_archived', { itemId: input.itemId });

  // `at` decides which stored price is quoted, so a malformed one is refused rather than compared
  // (see the header: '16.07.2026' silently fell back to base, 'heute' silently won the future).
  // Absent means today, and both paths normalise to the bare day so the comparison is total.
  const given = typeof input.at === 'string' && input.at.length > 0 ? input.at : null;
  if (given !== null && !isValidRateDate(given)) return err('invalid_input', { field: 'at' });
  const at = toIsoDay(given ?? ctx.clock.now());
  const contactId = typeof input.contactId === 'string' && input.contactId.length > 0 ? input.contactId : null;

  if (contactId !== null) {
    // Contact scope: the contact's own lists win over everything.
    const contactLists = (
      ctx.store.db
        .prepare('SELECT id FROM price_list WHERE workspace_id = ? AND contact_id = ?')
        .all(ctx.workspaceId, contactId) as { id: string }[]
    ).map((r) => r.id);
    const contactHit = effectiveIn(ctx, contactLists, input.itemId, at);
    if (contactHit !== undefined) {
      return ok({
        priceMinor: contactHit.price_minor,
        currency: contactHit.currency,
        source: 'contact',
        priceListId: contactHit.price_list_id,
      });
    }

    // Segment scope: the lists for any segment the contact belongs to (inert until C00, see header).
    const segments = contactSegments(ctx, contactId);
    if (segments.length > 0) {
      const placeholders = segments.map(() => '?').join(', ');
      const segmentLists = (
        ctx.store.db
          .prepare(`SELECT id FROM price_list WHERE workspace_id = ? AND segment IN (${placeholders})`)
          .all(ctx.workspaceId, ...segments) as { id: string }[]
      ).map((r) => r.id);
      const segmentHit = effectiveIn(ctx, segmentLists, input.itemId, at);
      if (segmentHit !== undefined) {
        return ok({
          priceMinor: segmentHit.price_minor,
          currency: segmentHit.currency,
          source: 'segment',
          priceListId: segmentHit.price_list_id,
        });
      }
    }
  }

  // Base: the item's own sales price, always defined.
  return ok({ priceMinor: item.default_unit_price_minor, currency: item.currency, source: 'base' });
}
