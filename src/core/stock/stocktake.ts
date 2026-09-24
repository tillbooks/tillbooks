/**
 * D01 stocktake (Inventur): the OR 958c Abs. 2 Bestandesnachweis. `open` freezes book quantities per
 * item x location at the balance-sheet date; `count` records what was physically counted; `report` is
 * the diff read model (P5); `commit` posts every difference in ONE batch, each minting a
 * `stock_movement` through the SAME movement path (`reason:'adjust'`, `moved_at = frozen_at`,
 * `ref_kind:'stocktake'`) so there is NO new stock path and NO ledger reach. Any financial effect
 * arrives later through J06 `inventory_valuation_post` -> A02 (P3); since K68 `stock_run_valuation`
 * is report-only and posts no journal entry.
 *
 * A committed session is TERMINAL and IMMUTABLE (§H-AUDIT spirit): it is the Bestandesnachweis, and
 * it is what a valuation at `frozen_at` links as its evidence. The committed session is the OP3-kind
 * `stocktake` an operator files as an E00 Inventar via `files_link` (reachable because D01 registers
 * that kind). §H-TENANT on every query; §H-IDEMPOTENT on open, count and commit.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { findItem, findLocation } from './shared.js';
import { insertMovement } from './movements.js';

interface SessionRow {
  id: string;
  frozen_at: string;
  location_id: string | null;
  status: string;
  committed_by: string | null;
  inventar_document_id: string | null;
  idempotency_key: string;
  committed_at: string | null;
}

interface LineRow {
  id: string;
  item_id: string;
  location_id: string;
  book_qty: number;
  counted_qty: number | null;
}

function findSession(ctx: WorkspaceContext, sessionId: unknown): SessionRow | undefined {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  return ctx.store.db
    .prepare(
      'SELECT id, frozen_at, location_id, status, committed_by, inventar_document_id, idempotency_key, committed_at FROM stocktake_session WHERE workspace_id = ? AND id = ?',
    )
    .get(ctx.workspaceId, sessionId) as SessionRow | undefined;
}

function linesOf(ctx: WorkspaceContext, sessionId: string): (LineRow & { itemName: string; locationName: string })[] {
  return ctx.store.db
    .prepare(
      `SELECT sl.id AS id, sl.item_id AS item_id, sl.location_id AS location_id, sl.book_qty AS book_qty,
              sl.counted_qty AS counted_qty, i.name AS itemName, l.name AS locationName
         FROM stocktake_line sl
         JOIN item i ON i.id = sl.item_id
         JOIN stock_location l ON l.id = sl.location_id
        WHERE sl.workspace_id = ? AND sl.session_id = ?
        ORDER BY i.name, l.name`,
    )
    .all(ctx.workspaceId, sessionId) as (LineRow & { itemName: string; locationName: string })[];
}

function mapSession(row: SessionRow): Record<string, unknown> {
  return {
    id: row.id,
    frozenAt: row.frozen_at,
    locationId: row.location_id,
    status: row.status,
    committedBy: row.committed_by,
    inventarDocumentId: row.inventar_document_id,
    committedAt: row.committed_at,
  };
}

export interface StocktakeOpenInput {
  frozenAt?: string;
  locationId?: string;
  idempotencyKey?: string;
}

export function stocktakeOpen(ctx: WorkspaceContext, input: StocktakeOpenInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.frozenAt !== 'string' || input.frozenAt.length < 10) return err('invalid_input', { field: 'frozenAt' });
  const frozenAt = input.frozenAt.slice(0, 10);
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (input.locationId !== undefined && findLocation(ctx, input.locationId) === undefined) {
    return err('not_found', { locationId: input.locationId });
  }

  // §H-IDEMPOTENT: a replay returns the original session and its frozen lines.
  const existing = ctx.store.db
    .prepare('SELECT id FROM stocktake_session WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (existing !== undefined) {
    const row = findSession(ctx, existing.id) as SessionRow;
    return ok({ session: mapSession(row), lines: linesOf(ctx, existing.id) });
  }

  // Freeze the book qty of every item x location that has moved as of frozen_at (optionally one
  // location). Book qty IS the on-hand read model captured at this instant (P5).
  const params: unknown[] = [ctx.workspaceId, frozenAt];
  let locClause = '';
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    locClause = 'AND m.location_id = ?';
    params.push(input.locationId);
  }
  const pairs = ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, m.location_id AS locationId, COALESCE(SUM(m.qty), 0) AS bookQty
         FROM stock_movement m
        WHERE m.workspace_id = ? AND m.moved_at <= ? ${locClause}
        GROUP BY m.item_id, m.location_id
        ORDER BY m.item_id, m.location_id`,
    )
    .all(...params) as { itemId: string; locationId: string; bookQty: number }[];

  return ctx.store.tx(() => {
    const sessionId = ctx.ids.next('stktake');
    ctx.store.db
      .prepare(
        `INSERT INTO stocktake_session (id, workspace_id, frozen_at, location_id, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(sessionId, ctx.workspaceId, frozenAt, input.locationId ?? null, input.idempotencyKey, ctx.clock.now());
    const insertLine = ctx.store.db.prepare(
      `INSERT INTO stocktake_line (id, workspace_id, session_id, item_id, location_id, book_qty, counted_qty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    for (const p of pairs) {
      insertLine.run(ctx.ids.next('stktakeln'), ctx.workspaceId, sessionId, p.itemId, p.locationId, p.bookQty, ctx.clock.now());
    }
    const row = findSession(ctx, sessionId) as SessionRow;
    return ok({ session: mapSession(row), lines: linesOf(ctx, sessionId) });
  });
}

export interface StocktakeCountInput {
  sessionId?: string;
  itemId?: string;
  locationId?: string;
  countedQty?: number;
  idempotencyKey?: string;
}

export function stocktakeCount(ctx: WorkspaceContext, input: StocktakeCountInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });
  if (session.status !== 'open') return err('stocktake_not_open', { sessionId: session.id, status: session.status });
  if (findItem(ctx, input.itemId) === undefined) return err('not_found', { itemId: input.itemId });
  if (typeof input.countedQty !== 'number' || !Number.isInteger(input.countedQty) || input.countedQty < 0) {
    return err('invalid_input', { field: 'countedQty' });
  }
  const line = ctx.store.db
    .prepare('SELECT id FROM stocktake_line WHERE workspace_id = ? AND session_id = ? AND item_id = ? AND location_id = ?')
    .get(ctx.workspaceId, session.id, input.itemId, input.locationId) as { id: string } | undefined;
  if (line === undefined) return err('not_found', { reason: 'line not in session', itemId: input.itemId, locationId: input.locationId });

  ctx.store.db
    .prepare('UPDATE stocktake_line SET counted_qty = ? WHERE workspace_id = ? AND id = ?')
    .run(input.countedQty, ctx.workspaceId, line.id);
  return ok({ sessionId: session.id, lineId: line.id, countedQty: input.countedQty });
}

/** The diff read model (P5): book vs counted per line, and the uncounted/over/under tallies. */
export function stocktakeReport(ctx: WorkspaceContext, input: { sessionId?: string }): Result {
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });
  const lines = linesOf(ctx, session.id).map((l) => ({
    lineId: l.id,
    itemId: l.item_id,
    itemName: l.itemName,
    locationId: l.location_id,
    locationName: l.locationName,
    bookQty: l.book_qty,
    countedQty: l.counted_qty,
    diffQty: l.counted_qty === null ? null : l.counted_qty - l.book_qty,
  }));
  const uncounted = lines.filter((l) => l.countedQty === null).length;
  const over = lines.filter((l) => l.diffQty !== null && l.diffQty > 0).length;
  const under = lines.filter((l) => l.diffQty !== null && l.diffQty < 0).length;
  return ok({ session: mapSession(session), lines, uncounted, over, under });
}

export interface StocktakeCommitInput {
  sessionId?: string;
  idempotencyKey?: string;
}

export function stocktakeCommit(ctx: WorkspaceContext, input: StocktakeCommitInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const session = findSession(ctx, input.sessionId);
  if (session === undefined) return err('not_found', { sessionId: input.sessionId });

  // §H-IDEMPOTENT: a replay returns the original commit result; differences never post twice.
  const cached = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'stocktake_commit');
  if (cached !== undefined) return cached;

  if (session.status !== 'open') return err('stocktake_not_open', { sessionId: session.id, status: session.status });

  const lines = linesOf(ctx, session.id);
  const uncounted = lines.filter((l) => l.counted_qty === null);
  if (uncounted.length > 0) {
    return err('uncounted_lines', { lines: uncounted.map((l) => ({ itemId: l.item_id, locationId: l.location_id })) });
  }

  // §H-PERIOD, before any mint: every adjustment is stamped with `frozen_at` (the balance-sheet date),
  // so a sealed year cannot be back-dated into. The committed session IS the Bestandesnachweis, and its
  // movements would alter the filed on-hand as-of the seal. This sits AFTER the idempotency recall (a
  // replay must still return its cached result) and BEFORE the mint block, so a refusal writes ZERO
  // rows. Same guard and structured `period_locked` refusal as the inventory stocktake path (spec §7).
  const periodOpen = ctx.periods.assertOpen(session.frozen_at.slice(0, 10));
  if (!periodOpen.ok) return periodOpen;

  return ctx.store.rememberIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'stocktake_commit', () => {
    const movementIds: string[] = [];
    for (const l of lines) {
      const diff = (l.counted_qty as number) - l.book_qty;
      if (diff === 0) continue;
      // Minted through the SAME movement path (spec §2 D01.6, §7): no direct insert of business
      // logic, no ledger reach. The adjustment brings on-hand exactly to the counted qty (>= 0), so
      // it can never drive on-hand negative.
      const m = insertMovement(ctx, {
        itemId: l.item_id,
        locationId: l.location_id,
        qty: diff,
        reason: 'adjust',
        unitCostMinor: null,
        movedAt: session.frozen_at,
        refKind: 'stocktake',
        refId: session.id,
        idempotencyKey: `${input.idempotencyKey}-ln-${l.id}`,
      });
      movementIds.push(m.id);
    }
    ctx.store.db
      .prepare("UPDATE stocktake_session SET status = 'committed', committed_by = ?, committed_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.actor, ctx.clock.now(), ctx.workspaceId, session.id);

    return ok({
      sessionId: session.id,
      status: 'committed',
      movementsMinted: movementIds.length,
      movementIds,
      // The committed session IS the Bestandesnachweis (OR 958c Abs. 2); file it as an E00 Inventar
      // via files_link on entityKind 'stocktake'.
      bestandesnachweis: session.id,
    });
  });
}
