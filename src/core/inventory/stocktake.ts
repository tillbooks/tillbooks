/**
 * J04, cycle count / stocktake (enhanced). A scoped stocktake session that freezes a book-quantity
 * snapshot from the J02 append-only movement ledger, accepts counts (blind or open), surfaces variance
 * against configurable thresholds, and commits every non-zero variance EXCLUSIVELY as an OP13 / J02
 * movement through `inventoryMove` (movement_type `adjustment`, description `stocktake` | `cycle_count`,
 * ref_kind `stocktake_session`). It owns only its own session / line tables (`cycle_count_session`,
 * `cycle_count_line` in `stocktakeSchema.ts`); it NEVER writes a stock quantity itself, so on-hand
 * stays `SUM(stock_movement.qty)` and §H-STOCK-AUDIT is never broken.
 *
 * THE MONEY-PATH INVARIANTS THIS FILE HOLDS (spec §7, asserted in `test/inventory/stocktake.test.mjs`):
 *  (a) APPEND-ONLY VIA J02: every quantity change is a NEW `inventoryMove` row; a stocktake never
 *      UPDATEs or DELETEs a movement. The session / line tables are mutable through the status machine
 *      while open, but the LEDGER effect is append-only, and a committed session + its `book_qty`
 *      snapshot are frozen by the triggers in `stocktakeSchema.ts`.
 *  (b) IDEMPOTENT ON ROWS: a replay of commit posts NO second movement. Each variance line mints under
 *      a movement key derived from (session, line), so `inventoryMove`'s own (workspace, key) unique
 *      index dedupes it even underneath the commit-level idempotency cache.
 *  (c) §H-TENANT: a foreign workspace's session / line / item / warehouse id is not_found before any
 *      read or mint.
 *  (d) REVERSAL: a committed stocktake is corrected by a COMPENSATING J02 movement (an opposite-sign
 *      `inventory_move` naming the same session), never a destructive edit; the committed session
 *      stays immutable (§H-AUDIT).
 *  (e) SIGN / DIRECTION: variance_qty = counted - book. A positive variance mints a positive
 *      adjustment (stock found), a negative variance a negative one (shrinkage). The sign flows
 *      straight to `inventoryMove` (the `adjustment` type carries the caller's sign).
 *  (f) PERIOD LOCK: commit into a locked period is refused (`period_locked`); the movement is stamped
 *      with the session's freeze date, so a sealed year cannot be back-dated into.
 *
 * THE PARTIAL-WRITE TRAP (money-path). `ctx.store.tx` COMMITS a `{ok:false}` returned from inside it,
 * so the commit loop THROWS a carrier on any `inventoryMove` rejection to roll the whole transaction
 * back: either every variance movement lands and the session is marked committed, or none does.
 *
 * WHY NEW TABLES (not D01's `stocktake_session`): see `stocktakeSchema.ts`. Legacy D01 committed
 * stocktakes stay queryable through the read-through in `stocktakeList` / `stocktakeGet` (spec §2
 * US-J04.8): J04 never mutates them, it only surfaces them read-only alongside its own sessions.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { inventoryMove } from './movement.js';

// --- §H-ENUM: the session and line vocabularies, single-sourced and validated at the verb boundary --

export const STOCKTAKE_SESSION_TYPES = ['full', 'cycle'] as const;
export type StocktakeSessionType = (typeof STOCKTAKE_SESSION_TYPES)[number];
const SESSION_TYPE_SET: ReadonlySet<string> = new Set(STOCKTAKE_SESSION_TYPES);

export const STOCKTAKE_SESSION_STATUSES = ['open', 'review', 'committed', 'cancelled'] as const;
export type StocktakeSessionStatus = (typeof STOCKTAKE_SESSION_STATUSES)[number];

export const STOCKTAKE_LINE_STATUSES = ['pending', 'counted', 'review_required', 'approved'] as const;
export type StocktakeLineStatus = (typeof STOCKTAKE_LINE_STATUSES)[number];

// --- row shapes -------------------------------------------------------------------------------------

interface SessionRow {
  id: string;
  type: string;
  status: string;
  freeze_at: string;
  blind_count: number;
  warehouse_id: string | null;
  selection_hash: string | null;
  variance_qty_threshold: number;
  variance_pct_threshold: number;
  notes: string | null;
  total_lines: number;
  inventar_document_id: string | null;
  committed_at: string | null;
  committed_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: string;
}

interface LineRow {
  id: string;
  session_id: string;
  item_id: string;
  location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  book_qty: number;
  counted_qty: number | null;
  status: string;
  counted_at: string | null;
  counted_by: string | null;
  movement_id: string | null;
}

const SESSION_COLUMNS = `id, type, status, freeze_at, blind_count, warehouse_id, selection_hash,
  variance_qty_threshold, variance_pct_threshold, notes, total_lines, inventar_document_id,
  committed_at, committed_by, cancelled_at, cancel_reason, created_by, created_at`;

const LINE_COLUMNS = `id, session_id, item_id, location_id, lot_id, serial_id, book_qty, counted_qty,
  status, counted_at, counted_by, movement_id`;

// --- small tenant-scoped reads ----------------------------------------------------------------------

function findSession(ctx: WorkspaceContext, sessionId: unknown): SessionRow | undefined {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  return ctx.store.db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM cycle_count_session WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, sessionId) as SessionRow | undefined;
}

function sessionByKey(ctx: WorkspaceContext, key: string): SessionRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM cycle_count_session WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, key) as SessionRow | undefined;
}

function linesOf(ctx: WorkspaceContext, sessionId: string): (LineRow & { itemName: string; locationName: string })[] {
  return ctx.store.db
    .prepare(
      `SELECT ${LINE_COLUMNS.split(',')
        .map((c) => `l.${c.trim()}`)
        .join(', ')}, i.name AS itemName, loc.name AS locationName
         FROM cycle_count_line l
         JOIN item i ON i.id = l.item_id
         JOIN stock_location loc ON loc.id = l.location_id
        WHERE l.workspace_id = ? AND l.session_id = ?
        ORDER BY i.name, loc.name`,
    )
    .all(ctx.workspaceId, sessionId) as (LineRow & { itemName: string; locationName: string })[];
}

function itemExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT 1 AS x FROM item WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !==
    undefined
  );
}

function locationExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT 1 AS x FROM stock_location WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) !== undefined
  );
}

function warehouseExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT 1 AS x FROM warehouse WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !==
    undefined
  );
}

// --- variance arithmetic (integer thousandths; no float) --------------------------------------------

/** variance_qty = counted - book (spec §4). */
function varianceQty(book: number, counted: number): number {
  return counted - book;
}

/**
 * variance_pct as an integer percent (rounded), matching the integer-threshold comparison. book === 0
 * with a non-zero count is treated as 100% (a full surplus over nothing), 0 when both are zero.
 */
function variancePct(book: number, counted: number): number {
  if (book === 0) return counted === 0 ? 0 : 100;
  return Math.round((varianceQty(book, counted) * 100) / book);
}

/** A counted line's status: zero variance auto-approves; a material variance needs review; else counted. */
function classifyLine(session: SessionRow, book: number, counted: number): StocktakeLineStatus {
  const vq = varianceQty(book, counted);
  if (vq === 0) return 'approved';
  const vp = variancePct(book, counted);
  const exceeds = Math.abs(vq) > session.variance_qty_threshold || Math.abs(vp) > session.variance_pct_threshold;
  return exceeds ? 'review_required' : 'counted';
}

// --- projections to the wire shape ------------------------------------------------------------------

function progressOf(lines: LineRow[]): {
  totalLines: number;
  countedLines: number;
  reviewRequiredLines: number;
  approvedLines: number;
  pendingLines: number;
  progressPct: number;
} {
  const total = lines.length;
  const counted = lines.filter((l) => l.counted_qty !== null).length;
  const review = lines.filter((l) => l.status === 'review_required').length;
  const approved = lines.filter((l) => l.status === 'approved').length;
  const pending = lines.filter((l) => l.status === 'pending').length;
  return {
    totalLines: total,
    countedLines: counted,
    reviewRequiredLines: review,
    approvedLines: approved,
    pendingLines: pending,
    progressPct: total === 0 ? 100 : Math.round((counted * 100) / total),
  };
}

function mapSession(row: SessionRow, lines: LineRow[]): Record<string, unknown> {
  const p = progressOf(lines);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    freezeAt: row.freeze_at,
    blindCount: row.blind_count === 1,
    warehouseId: row.warehouse_id,
    varianceQtyThreshold: row.variance_qty_threshold,
    variancePctThreshold: row.variance_pct_threshold,
    notes: row.notes,
    totalLines: p.totalLines,
    countedLines: p.countedLines,
    reviewRequiredLines: p.reviewRequiredLines,
    approvedLines: p.approvedLines,
    pendingLines: p.pendingLines,
    progressPct: p.progressPct,
    inventarDocumentId: row.inventar_document_id,
    committedAt: row.committed_at,
    committedBy: row.committed_by,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Map a line to the wire shape. `book_qty` is hidden (null) while the session is a blind count and has
 * not yet reached review or commit (spec §2 US-J04.3): the counter must not see book to keep the count
 * honest. Variance is only exposed once book is visible, for the same reason.
 */
function mapLine(row: LineRow & { itemName?: string; locationName?: string }, hideBook: boolean): Record<string, unknown> {
  const showBook = !hideBook;
  const variance = showBook && row.counted_qty !== null ? varianceQty(row.book_qty, row.counted_qty) : null;
  const variancePctValue = showBook && row.counted_qty !== null ? variancePct(row.book_qty, row.counted_qty) : null;
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.itemName ?? null,
    locationId: row.location_id,
    locationName: row.locationName ?? null,
    lotId: row.lot_id,
    serialId: row.serial_id,
    bookQty: showBook ? row.book_qty : null,
    countedQty: row.counted_qty,
    varianceQty: variance,
    variancePct: variancePctValue,
    status: row.status,
    countedAt: row.counted_at,
    countedBy: row.counted_by,
    movementId: row.movement_id,
  };
}

// --- create -----------------------------------------------------------------------------------------

export interface StocktakeCreateInput {
  type?: string;
  freezeAt?: string;
  warehouseId?: string;
  locationIds?: string[];
  itemIds?: string[];
  abcClasses?: string[];
  includeZeroQty?: boolean;
  blindCount?: boolean;
  varianceQtyThreshold?: number;
  variancePctThreshold?: number;
  notes?: string;
  idempotencyKey?: string;
}

/** A stable hash of the selection, for audit and for detecting a same-selection re-open (spec §4). */
function selectionHash(input: StocktakeCreateInput, freezeAt: string, type: string): string {
  const norm = {
    type,
    freezeAt,
    warehouseId: input.warehouseId ?? null,
    locationIds: [...(input.locationIds ?? [])].sort(),
    itemIds: [...(input.itemIds ?? [])].sort(),
    abcClasses: [...(input.abcClasses ?? [])].sort(),
    includeZeroQty: input.includeZeroQty === true,
  };
  return JSON.stringify(norm);
}

/**
 * Open a session (spec §2 US-J04.1 / US-J04.2). Freezes one line per (item, location [, lot, serial])
 * whose J02 balance-as-of `freeze_at` is non-zero (or every group, when includeZeroQty), scoped by the
 * optional warehouse / location / item filters. `book_qty` IS the canonical J02 read model
 * `SUM(stock_movement.qty) WHERE moved_at <= freeze_at`, so the snapshot is bit-identical to a direct
 * balance query (spec §8). §H-IDEMPOTENT: a replay of the key returns the original session.
 */
export function inventoryStocktakeCreate(ctx: WorkspaceContext, input: StocktakeCreateInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  const type = input.type ?? 'full';
  if (!SESSION_TYPE_SET.has(type)) {
    return err('invalid_input', { field: 'type', allowed: [...STOCKTAKE_SESSION_TYPES] });
  }
  const freezeAt = (input.freezeAt ?? ctx.clock.now()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(freezeAt)) return err('invalid_input', { field: 'freezeAt' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const qtyThreshold = normaliseThreshold(input.varianceQtyThreshold);
  if (qtyThreshold === undefined) return err('invalid_input', { field: 'varianceQtyThreshold' });
  const pctThreshold = normaliseThreshold(input.variancePctThreshold);
  if (pctThreshold === undefined) return err('invalid_input', { field: 'variancePctThreshold' });

  // Normalise the filter arrays defensively: a non-array (hostile input) is treated as absent, so the
  // faces stay in agreement rather than one throwing on a `for..of` over a number.
  const inputLocationIds = Array.isArray(input.locationIds) ? input.locationIds : [];
  const inputItemIds = Array.isArray(input.itemIds) ? input.itemIds : [];

  // §H-TENANT on every selection id: a foreign warehouse / location / item is not_found, never a
  // silent empty selection that leaks the existence of another workspace's ids by omission.
  if (input.warehouseId !== undefined && !warehouseExists(ctx, input.warehouseId)) {
    return err('not_found', { warehouseId: input.warehouseId });
  }
  for (const id of inputLocationIds) {
    if (typeof id === 'string' && !locationExists(ctx, id)) return err('not_found', { locationId: id });
  }
  for (const id of inputItemIds) {
    if (typeof id === 'string' && !itemExists(ctx, id)) return err('not_found', { itemId: id });
  }

  // §H-IDEMPOTENT: a replay returns the original session and its frozen lines.
  const existing = sessionByKey(ctx, input.idempotencyKey);
  if (existing !== undefined) {
    const lines = linesOf(ctx, existing.id);
    return ok({ session: mapSession(existing, lines), lines: lines.map((l) => mapLine(l, existing.blind_count === 1)) });
  }

  // Freeze the book qty of every matching (item, location, lot, serial) key as of freeze_at. This IS
  // the J02 balance-as-of read (SUM over the append-only ledger), so the snapshot cannot drift from a
  // direct balance query executed at this instant (spec §8 live contract).
  const clauses = ['m.workspace_id = ?', 'm.moved_at <= ?'];
  const params: unknown[] = [ctx.workspaceId, freezeAt];
  if (typeof input.warehouseId === 'string' && input.warehouseId.length > 0) {
    clauses.push('m.location_id IN (SELECT id FROM stock_location WHERE workspace_id = ? AND warehouse_id = ?)');
    params.push(ctx.workspaceId, input.warehouseId);
  }
  const locIds = inputLocationIds.filter((s) => typeof s === 'string' && s.length > 0);
  if (locIds.length > 0) {
    clauses.push(`m.location_id IN (${locIds.map(() => '?').join(', ')})`);
    params.push(...locIds);
  }
  const itemIds = inputItemIds.filter((s) => typeof s === 'string' && s.length > 0);
  if (itemIds.length > 0) {
    clauses.push(`m.item_id IN (${itemIds.map(() => '?').join(', ')})`);
    params.push(...itemIds);
  }
  const having = input.includeZeroQty === true ? '' : 'HAVING COALESCE(SUM(m.qty), 0) != 0';
  const pairs = ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, m.location_id AS locationId, m.lot_id AS lotId, m.serial_id AS serialId,
              COALESCE(SUM(m.qty), 0) AS bookQty
         FROM stock_movement m
        WHERE ${clauses.join(' AND ')}
        GROUP BY m.item_id, m.location_id, m.lot_id, m.serial_id
        ${having}
        ORDER BY m.item_id, m.location_id`,
    )
    .all(...params) as { itemId: string; locationId: string; lotId: string | null; serialId: string | null; bookQty: number }[];

  const blind = input.blindCount === true ? 1 : 0;
  const hash = selectionHash(input, freezeAt, type);

  return ctx.store.tx(() => {
    // The race the fast path cannot see: a concurrent create with the same key trips the unique index.
    const raced = sessionByKey(ctx, input.idempotencyKey as string);
    if (raced !== undefined) {
      const lines = linesOf(ctx, raced.id);
      return ok({ session: mapSession(raced, lines), lines: lines.map((l) => mapLine(l, raced.blind_count === 1)) });
    }
    const sessionId = ctx.ids.next('cyclect');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO cycle_count_session
           (id, workspace_id, type, status, freeze_at, blind_count, warehouse_id, selection_hash,
            variance_qty_threshold, variance_pct_threshold, notes, total_lines, created_by,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        ctx.workspaceId,
        type,
        freezeAt,
        blind,
        input.warehouseId ?? null,
        hash,
        qtyThreshold,
        pctThreshold,
        input.notes ?? null,
        pairs.length,
        ctx.actor,
        input.idempotencyKey,
        now,
        now,
      );
    const insertLine = ctx.store.db.prepare(
      `INSERT INTO cycle_count_line
         (id, session_id, workspace_id, item_id, location_id, lot_id, serial_id, book_qty, counted_qty,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`,
    );
    for (const p of pairs) {
      insertLine.run(
        ctx.ids.next('cyclctln'),
        sessionId,
        ctx.workspaceId,
        p.itemId,
        p.locationId,
        p.lotId,
        p.serialId,
        p.bookQty,
        now,
        now,
      );
    }
    ctx.audit.record({ entityKind: 'cycle_count_session', entityId: sessionId, action: 'create', actor: ctx.actor, at: now });
    const row = findSession(ctx, sessionId) as SessionRow;
    const lines = linesOf(ctx, sessionId);
    return ok({
      session: mapSession(row, lines),
      lines: lines.map((l) => mapLine(l, blind === 1)),
      warning: pairs.length === 0 ? 'empty_selection' : undefined,
    });
  });
}

function normaliseThreshold(v: number | undefined): number | undefined {
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined;
  return v;
}

// --- count ------------------------------------------------------------------------------------------

export interface StocktakeCountInput {
  sessionId?: string;
  lines?: Array<{ itemId?: string; locationId?: string; lotId?: string | null; serialId?: string | null; countedQty?: number }>;
  idempotencyKey?: string;
}

/**
 * Record counted quantities for one or more lines of an open session (spec §2 US-J04.3). Last write
 * wins while the session is open; a counted quantity may be 0 (an explicit empty bin). Each counted
 * line is classified against the session thresholds: zero variance auto-approves, a material variance
 * enters review_required, else counted. Blind mode still hides book_qty in the response.
 */
export function inventoryStocktakeCount(ctx: WorkspaceContext, input: StocktakeCountInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });
  if (session.status !== 'open' && session.status !== 'review') {
    return err('stocktake_not_open', { sessionId: session.id, status: session.status });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return err('invalid_input', { field: 'lines' });
  }
  for (const l of input.lines) {
    if (typeof l.countedQty !== 'number' || !Number.isInteger(l.countedQty) || l.countedQty < 0) {
      return err('invalid_input', { field: 'countedQty', itemId: l.itemId });
    }
  }

  // Resolve every target line BEFORE the idempotent write, so a bad line is a clean not_found rather
  // than a cached error or a partial update (the money-path partial-write discipline, one register up).
  const resolved: { row: LineRow; counted: number; status: StocktakeLineStatus }[] = [];
  for (const l of input.lines) {
    const row = findLine(ctx, session.id, l);
    if (row === undefined) {
      return err('not_found', { reason: 'line_not_in_session', itemId: l.itemId, locationId: l.locationId });
    }
    const counted = l.countedQty as number;
    resolved.push({ row, counted, status: classifyLine(session, row.book_qty, counted) });
  }

  // §H-IDEMPOTENT: a replay of the same count returns the original result and writes nothing.
  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_count');
  if (cached !== undefined) return cached;

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_count', () => {
    const now = ctx.clock.now();
    const updatedIds: string[] = [];
    for (const { row, counted, status } of resolved) {
      ctx.store.db
        .prepare(
          `UPDATE cycle_count_line SET counted_qty = ?, status = ?, counted_at = ?, counted_by = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
        )
        .run(counted, status, now, ctx.actor, now, ctx.workspaceId, row.id);
      updatedIds.push(row.id);
    }
    // A session with any counted line that needs attention sits in 'review'; otherwise it stays open.
    // (Purely a header hint for list views; the commit gate re-derives from the lines regardless.)
    const lines = linesOf(ctx, session.id);
    const anyReview = lines.some((x) => x.status === 'review_required');
    const nextStatus = anyReview ? 'review' : 'open';
    if (nextStatus !== session.status) {
      ctx.store.db
        .prepare("UPDATE cycle_count_session SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(nextStatus, now, ctx.workspaceId, session.id);
    }
    const fresh = findSession(ctx, session.id) as SessionRow;
    const updated = lines.filter((x) => updatedIds.includes(x.id));
    return ok({
      session: mapSession(fresh, lines),
      updatedLines: updated.map((l) => mapLine(l, session.blind_count === 1)),
    });
  });
}

function findLine(
  ctx: WorkspaceContext,
  sessionId: string,
  key: { itemId?: string; locationId?: string; lotId?: string | null; serialId?: string | null },
): LineRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT ${LINE_COLUMNS} FROM cycle_count_line
        WHERE workspace_id = ? AND session_id = ? AND item_id = ? AND location_id = ?
          AND COALESCE(lot_id, '') = ? AND COALESCE(serial_id, '') = ?`,
    )
    .get(
      ctx.workspaceId,
      sessionId,
      key.itemId ?? '',
      key.locationId ?? '',
      key.lotId ?? '',
      key.serialId ?? '',
    ) as LineRow | undefined;
}

// --- report (pure read model, P5) -------------------------------------------------------------------

export function inventoryStocktakeReport(ctx: WorkspaceContext, input: { sessionId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });
  const lines = linesOf(ctx, session.id);
  // Once the session reaches review or is terminal, book is revealed even for a blind count.
  const hideBook = session.blind_count === 1 && session.status === 'open';

  let totalOver = 0;
  let totalUnder = 0;
  let absVariance = 0;
  let exceeding = 0;
  for (const l of lines) {
    if (l.counted_qty === null) continue;
    const vq = varianceQty(l.book_qty, l.counted_qty);
    if (vq > 0) totalOver += vq;
    if (vq < 0) totalUnder += vq;
    absVariance += Math.abs(vq);
    if (l.status === 'review_required') exceeding += 1;
  }
  return ok({
    session: mapSession(session, lines),
    lines: lines.map((l) => mapLine(l, hideBook)),
    totals: { over: totalOver, under: totalUnder, absVariance, exceedingThreshold: exceeding },
  });
}

// --- approve / request recount ----------------------------------------------------------------------

export interface StocktakeApproveInput {
  sessionId?: string;
  lineIds?: string[] | 'all_review_required';
  idempotencyKey?: string;
}

/** Approve review-required (or counted) lines so they may commit (spec §2 US-J04.5). */
export function inventoryStocktakeApproveLines(ctx: WorkspaceContext, input: StocktakeApproveInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });
  if (session.status !== 'open' && session.status !== 'review') {
    return err('stocktake_not_open', { sessionId: session.id, status: session.status });
  }

  // Resolve the target lines and validate BEFORE the idempotent write (no cached error, no partial).
  const lines = linesOf(ctx, session.id);
  const targetIds = new Set(
    input.lineIds === 'all_review_required'
      ? lines.filter((l) => l.status === 'review_required').map((l) => l.id)
      : Array.isArray(input.lineIds)
        ? input.lineIds
        : [],
  );
  for (const l of lines) {
    if (!targetIds.has(l.id)) continue;
    // Only a counted line can be approved; approving an uncounted line would approve nothing.
    if (l.counted_qty === null) return err('uncounted_or_unapproved_lines', { lineId: l.id, status: l.status });
  }

  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_approve_lines');
  if (cached !== undefined) return cached;

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_approve_lines', () => {
    const now = ctx.clock.now();
    for (const l of lines) {
      if (!targetIds.has(l.id)) continue;
      if (l.status === 'review_required' || l.status === 'counted') {
        ctx.store.db
          .prepare("UPDATE cycle_count_line SET status = 'approved', updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(now, ctx.workspaceId, l.id);
      }
    }
    return finaliseHeaderStatus(ctx, session.id, now);
  });
}

export interface StocktakeRecountInput {
  sessionId?: string;
  lineIds?: string[];
  reason?: string;
  idempotencyKey?: string;
}

/** Send lines back to pending, clearing their count so they must be recounted (spec §2 US-J04.5). */
export function inventoryStocktakeRequestRecount(ctx: WorkspaceContext, input: StocktakeRecountInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!Array.isArray(input.lineIds) || input.lineIds.length === 0) {
    return err('invalid_input', { field: 'lineIds' });
  }
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });
  if (session.status !== 'open' && session.status !== 'review') {
    return err('stocktake_not_open', { sessionId: session.id, status: session.status });
  }

  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_request_recount');
  if (cached !== undefined) return cached;

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_request_recount', () => {
    const now = ctx.clock.now();
    const ids = new Set(input.lineIds as string[]);
    const lines = linesOf(ctx, session.id);
    for (const l of lines) {
      if (!ids.has(l.id)) continue;
      ctx.store.db
        .prepare(
          `UPDATE cycle_count_line SET status = 'pending', counted_qty = NULL, counted_at = NULL, counted_by = NULL, updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
        )
        .run(now, ctx.workspaceId, l.id);
    }
    return finaliseHeaderStatus(ctx, session.id, now);
  });
}

/** Recompute the header status (open vs review) and return the fresh session + lines. */
function finaliseHeaderStatus(ctx: WorkspaceContext, sessionId: string, now: string): Result {
  const lines = linesOf(ctx, sessionId);
  const session = findSession(ctx, sessionId) as SessionRow;
  const anyReview = lines.some((l) => l.status === 'review_required');
  const nextStatus = anyReview ? 'review' : 'open';
  if (nextStatus !== session.status && session.status !== 'committed' && session.status !== 'cancelled') {
    ctx.store.db
      .prepare('UPDATE cycle_count_session SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(nextStatus, now, ctx.workspaceId, sessionId);
  }
  const fresh = findSession(ctx, sessionId) as SessionRow;
  return ok({ session: mapSession(fresh, lines), lines: lines.map((l) => mapLine(l, fresh.blind_count === 1 && fresh.status === 'open')) });
}

// --- commit (the money path) ------------------------------------------------------------------------

/** A carrier that rolls the commit transaction back with a structured Result (the partial-write trap). */
class CommitAbort {
  constructor(public readonly result: Result) {}
}

export interface StocktakeCommitInput {
  sessionId?: string;
  idempotencyKey?: string;
}

/**
 * Commit a reviewed session (spec §2 US-J04.6). For every line with a non-zero variance, mint ONE J02
 * `inventoryMove` (movement_type `adjustment`, signed qty = counted - book, dated at freeze_at,
 * ref_kind `stocktake_session`), record the movement id on the line, and mark the session committed:
 * all atomically. No quantity is written by J04; on-hand is the SUM over the movements J02 holds.
 *
 * §H-IDEMPOTENT twice over: the commit result is cached under (workspace, key), AND each variance line
 * mints under a movement key derived from (session, line), so `inventoryMove`'s own unique index posts
 * no second row even if the cache were bypassed. Period lock is asserted for the movement date before
 * anything is minted; a locked or sealed period is refused with `period_locked`.
 */
export function inventoryStocktakeCommit(ctx: WorkspaceContext, input: StocktakeCommitInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });

  // §H-IDEMPOTENT: a replay returns the original commit result; variances never post twice.
  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_commit');
  if (cached !== undefined) return cached;

  if (session.status === 'committed') return err('already_committed', { sessionId: session.id });
  if (session.status !== 'open' && session.status !== 'review') {
    return err('stocktake_not_open', { sessionId: session.id, status: session.status });
  }

  const lines = linesOf(ctx, session.id);
  const blocking = lines.filter((l) => l.status === 'pending' || l.status === 'review_required');
  if (blocking.length > 0) {
    return err('uncounted_or_unapproved_lines', {
      sessionId: session.id,
      lines: blocking.map((l) => ({ lineId: l.id, itemId: l.item_id, locationId: l.location_id, status: l.status })),
    });
  }

  // Period lock, before any mint: the movement is stamped with freeze_at, so a sealed year cannot be
  // back-dated into (spec §7). This also covers a soft-locked open period.
  const movedAt = session.freeze_at.slice(0, 10);
  const periodOpen = ctx.periods.assertOpen(movedAt);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_commit', () => {
      const now = ctx.clock.now();
      const description = session.type === 'full' ? 'stocktake' : 'cycle_count';
      const movementIds: string[] = [];
      for (const l of lines) {
        const counted = l.counted_qty as number; // every remaining line is counted/approved
        const variance = varianceQty(l.book_qty, counted);
        if (variance === 0) continue;
        // The ONE quantity path (OP13): a NEW append-only movement, never a stock-table write. The
        // `adjustment` type carries the signed variance straight through. unit_cost is left to J06 /
        // J03 (spec §4): quantity correctness does not depend on it, so it is null here.
        const res = inventoryMove(ctx, {
          itemId: l.item_id,
          locationId: l.location_id,
          lotId: l.lot_id,
          serialId: l.serial_id,
          qty: variance,
          movementType: 'adjustment',
          effectiveDate: movedAt,
          description,
          sourceDocumentType: 'stocktake_session',
          sourceDocumentId: session.id,
          idempotencyKey: `stk:${session.id}:${l.id}`,
        });
        if (!res.ok) throw new CommitAbort(res);
        const movementId = (res as { movement?: { id?: string } }).movement?.id ?? null;
        ctx.store.db
          .prepare('UPDATE cycle_count_line SET movement_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
          .run(movementId, now, ctx.workspaceId, l.id);
        if (movementId !== null) movementIds.push(movementId);
      }
      // Mark the session committed (this UPDATE runs while OLD.status is still open/review, so the
      // freeze trigger passes; every later edit aborts). A full session names itself as the
      // Bestandesnachweis (OR 958c Abs. 2); a full E00 Inventar document is filed on top via the
      // files layer, and the reference is returned so an operator can link it.
      ctx.store.db
        .prepare(
          `UPDATE cycle_count_session SET status = 'committed', committed_at = ?, committed_by = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ?`,
        )
        .run(now, ctx.actor, now, ctx.workspaceId, session.id);
      ctx.audit.record({ entityKind: 'cycle_count_session', entityId: session.id, action: 'commit', actor: ctx.actor, at: now });
      const fresh = findSession(ctx, session.id) as SessionRow;
      const freshLines = linesOf(ctx, session.id);
      return ok({
        session: mapSession(fresh, freshLines),
        movementIds,
        movementsMinted: movementIds.length,
        inventarDocumentId: fresh.inventar_document_id,
        bestandesnachweis: session.type === 'full' ? session.id : null,
        inventarWarning: session.type === 'full' && fresh.inventar_document_id === null ? 'inventar_document_pending' : undefined,
      });
    });
  } catch (e) {
    if (e instanceof CommitAbort) return e.result;
    throw e;
  }
}

// --- cancel -----------------------------------------------------------------------------------------

export interface StocktakeCancelInput {
  sessionId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** Cancel an open / review session (spec §2 US-J04.7). No movements are written; the snapshot is kept. */
export function inventoryStocktakeCancel(ctx: WorkspaceContext, input: StocktakeCancelInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });

  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_cancel');
  if (cached !== undefined) return cached;

  if (session.status === 'committed') return err('already_committed', { sessionId: session.id });
  if (session.status === 'cancelled') {
    const lines = linesOf(ctx, session.id);
    return ok({ session: mapSession(session, lines) });
  }

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'inventory_stocktake_cancel', () => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `UPDATE cycle_count_session SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
      )
      .run(now, input.reason ?? null, now, ctx.workspaceId, session.id);
    ctx.audit.record({ entityKind: 'cycle_count_session', entityId: session.id, action: 'cancel', actor: ctx.actor, at: now });
    const fresh = findSession(ctx, session.id) as SessionRow;
    const lines = linesOf(ctx, session.id);
    return ok({ session: mapSession(fresh, lines) });
  });
}

// --- get / list -------------------------------------------------------------------------------------

export function inventoryStocktakeGet(ctx: WorkspaceContext, input: { sessionId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const session = findSession(ctx, input.sessionId);
  if (session !== undefined) {
    const lines = linesOf(ctx, session.id);
    const hideBook = session.blind_count === 1 && session.status === 'open';
    return ok({ session: mapSession(session, lines), lines: lines.map((l) => mapLine(l, hideBook)), legacy: false });
  }
  // Read-through to a legacy D01 stocktake (spec §2 US-J04.8): still queryable, never mutated by J04.
  const legacy = readLegacySession(ctx, input.sessionId);
  if (legacy !== undefined) return ok(legacy);
  return err('not_found', { sessionId: input.sessionId });
}

export interface StocktakeListInput {
  type?: string;
  status?: string | string[];
  from?: string;
  to?: string;
  warehouseId?: string;
  includeLegacy?: boolean;
}

export function inventoryStocktakeList(ctx: WorkspaceContext, input: StocktakeListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.type === 'string' && SESSION_TYPE_SET.has(input.type)) {
    clauses.push('type = ?');
    params.push(input.type);
  }
  const statuses = Array.isArray(input.status) ? input.status : typeof input.status === 'string' ? [input.status] : [];
  const validStatuses = statuses.filter((s): s is StocktakeSessionStatus =>
    (STOCKTAKE_SESSION_STATUSES as readonly string[]).includes(s),
  );
  if (validStatuses.length > 0) {
    clauses.push(`status IN (${validStatuses.map(() => '?').join(', ')})`);
    params.push(...validStatuses);
  }
  if (typeof input.from === 'string' && input.from.length > 0) {
    clauses.push('freeze_at >= ?');
    params.push(input.from.slice(0, 10));
  }
  if (typeof input.to === 'string' && input.to.length > 0) {
    clauses.push('freeze_at <= ?');
    params.push(input.to.slice(0, 10));
  }
  if (typeof input.warehouseId === 'string' && input.warehouseId.length > 0) {
    clauses.push('warehouse_id = ?');
    params.push(input.warehouseId);
  }

  const rows = ctx.store.db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM cycle_count_session WHERE ${clauses.join(' AND ')} ORDER BY freeze_at DESC, created_at DESC`)
    .all(...params) as SessionRow[];

  const sessions = rows.map((r) => {
    const lines = linesOf(ctx, r.id);
    return mapSession(r, lines);
  });

  // Legacy D01 committed stocktakes, surfaced read-only alongside the J04 sessions (spec §2 US-J04.8).
  // Off by default so the common list stays a single-table read; opt in with includeLegacy.
  const legacy = input.includeLegacy === true ? listLegacySessions(ctx, input) : [];
  return ok({ sessions, legacy });
}

// --- legacy D01 read-through ------------------------------------------------------------------------

interface LegacySessionRow {
  id: string;
  frozen_at: string;
  location_id: string | null;
  status: string;
  committed_by: string | null;
  inventar_document_id: string | null;
  committed_at: string | null;
}

/** Map a legacy D01 `stocktake_session` row to the J04 summary shape, flagged read-only. */
function mapLegacy(row: LegacySessionRow): Record<string, unknown> {
  return {
    id: row.id,
    type: 'full',
    status: row.status,
    freezeAt: row.frozen_at,
    warehouseId: null,
    locationId: row.location_id,
    inventarDocumentId: row.inventar_document_id,
    committedAt: row.committed_at,
    committedBy: row.committed_by,
    legacy: true,
  };
}

function readLegacySession(ctx: WorkspaceContext, sessionId: unknown): Record<string, unknown> | undefined {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const row = ctx.store.db
    .prepare(
      `SELECT id, frozen_at, location_id, status, committed_by, inventar_document_id, committed_at
         FROM stocktake_session WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, sessionId) as LegacySessionRow | undefined;
  if (row === undefined) return undefined;
  const lines = ctx.store.db
    .prepare(
      `SELECT sl.id AS id, sl.item_id AS itemId, sl.location_id AS locationId, sl.book_qty AS bookQty,
              sl.counted_qty AS countedQty
         FROM stocktake_line sl WHERE sl.workspace_id = ? AND sl.session_id = ?`,
    )
    .all(ctx.workspaceId, sessionId) as Record<string, unknown>[];
  return { session: mapLegacy(row), lines, legacy: true };
}

function listLegacySessions(ctx: WorkspaceContext, input: StocktakeListInput): Record<string, unknown>[] {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.from === 'string' && input.from.length > 0) {
    clauses.push('frozen_at >= ?');
    params.push(input.from.slice(0, 10));
  }
  if (typeof input.to === 'string' && input.to.length > 0) {
    clauses.push('frozen_at <= ?');
    params.push(input.to.slice(0, 10));
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT id, frozen_at, location_id, status, committed_by, inventar_document_id, committed_at
         FROM stocktake_session WHERE ${clauses.join(' AND ')} ORDER BY frozen_at DESC`,
    )
    .all(...params) as LegacySessionRow[];
  return rows.map(mapLegacy);
}
