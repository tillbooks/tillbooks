/**
 * J01, lot & serial tracking (spec §4): the engine for per-item lot and serial master data plus the
 * two pure read models over the OP2 movement ledger. PLAIN MASTER DATA, no money path (nothing here
 * posts a journal entry). Every read and write is scoped to `ctx.workspaceId` (§H-TENANT); every write
 * takes an idempotency key (§H-IDEMPOTENT).
 *
 * THE HARD INVARIANT (spec §4, §H-STOCK-AUDIT / OP13): neither `lot` nor `serial` holds a quantity.
 * On-hand for a lot is `SUM(stock_movement.qty)` filtered by `lot_id`, computed live; a serial is a
 * unit of one whose availability is derived from its `status`. A status transition writes no stock
 * movement and never mutates a quantity.
 *
 * The `stock_movement.lot_id` / `stock_movement.serial_id` columns this read model sums are the
 * EXTENSION POINTS J02 (the movement ledger) fills: J01 defines the masters and the on-hand-by-lot
 * projection, J02 makes the reference mandatory when the item's `tracking_mode` demands it. Until J02
 * lands, no verb writes a lot- or serial-tagged movement, so `inventory_on_hand_by_lot` returns the
 * empty list rather than an error (spec US-J01.4).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

const NUMBER_MAX = 60;

/** The per-item tracking mode (§H-ENUM). `none` is the untracked default every A09/D00 item keeps. */
export const TRACKING_MODES = ['none', 'lot', 'serial', 'lot_and_serial'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
const TRACKING_MODE_SET: ReadonlySet<string> = new Set(TRACKING_MODES);

/** The lot status lifecycle (§H-ENUM). `open` is the default a received batch starts in. */
export const LOT_STATUSES = ['open', 'held', 'expired', 'closed', 'archived'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];
const LOT_STATUS_SET: ReadonlySet<string> = new Set(LOT_STATUSES);

/** The serial status lifecycle (§H-ENUM). `available` is the default a received unit starts in. */
export const SERIAL_STATUSES = ['available', 'reserved', 'issued', 'returned', 'scrapped', 'archived'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];
const SERIAL_STATUS_SET: ReadonlySet<string> = new Set(SERIAL_STATUSES);

function modeHasLot(mode: string): boolean {
  return mode === 'lot' || mode === 'lot_and_serial';
}
function modeHasSerial(mode: string): boolean {
  return mode === 'serial' || mode === 'lot_and_serial';
}

// --- row shapes and mappers --------------------------------------------------------------------

interface LotRow {
  id: string;
  workspace_id: string;
  item_id: string;
  number: string;
  status: string;
  expiry_date: string | null;
  manufactured_date: string | null;
  supplier_reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface Lot {
  id: string;
  itemId: string;
  number: string;
  status: string;
  expiryDate: string | null;
  manufacturedDate: string | null;
  supplierReference: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapLot(row: LotRow): Lot {
  return {
    id: row.id,
    itemId: row.item_id,
    number: row.number,
    status: row.status,
    expiryDate: row.expiry_date,
    manufacturedDate: row.manufactured_date,
    supplierReference: row.supplier_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SerialRow {
  id: string;
  workspace_id: string;
  item_id: string;
  lot_id: string | null;
  number: string;
  status: string;
  current_location_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface Serial {
  id: string;
  itemId: string;
  lotId: string | null;
  number: string;
  status: string;
  currentLocationId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSerial(row: SerialRow): Serial {
  return {
    id: row.id,
    itemId: row.item_id,
    lotId: row.lot_id,
    number: row.number,
    status: row.status,
    currentLocationId: row.current_location_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ItemRow {
  id: string;
  name: string;
  track_stock: number;
  kind: string | null;
  tracking_mode: string;
}

// --- small tenant-scoped reads -----------------------------------------------------------------

function readItem(ctx: WorkspaceContext, id: string): ItemRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, name, track_stock, kind, tracking_mode FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ItemRow | undefined;
}

function readLot(ctx: WorkspaceContext, id: string): LotRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM lot WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as LotRow | undefined;
}

function readSerial(ctx: WorkspaceContext, id: string): SerialRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM serial WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as SerialRow | undefined;
}

/** On-hand for a whole item across every location: the live SUM over the OP2 movement ledger. */
function itemOnHand(ctx: WorkspaceContext, itemId: string): number {
  const row = ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ? AND item_id = ?')
    .get(ctx.workspaceId, itemId) as { n: number };
  return row.n;
}

/** Derived on-hand for one lot: the live SUM(stock_movement.qty) filtered by lot_id (never stored). */
function lotOnHand(ctx: WorkspaceContext, lotId: string): number {
  const row = ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ? AND lot_id = ?')
    .get(ctx.workspaceId, lotId) as { n: number };
  return row.n;
}

function lotNumberTaken(ctx: WorkspaceContext, itemId: string, number: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare(
      'SELECT id FROM lot WHERE workspace_id = ? AND item_id = ? AND lower(number) = lower(?) AND id != ? LIMIT 1',
    )
    .get(ctx.workspaceId, itemId, number, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

function serialNumberTaken(ctx: WorkspaceContext, itemId: string, number: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare(
      'SELECT id FROM serial WHERE workspace_id = ? AND item_id = ? AND lower(number) = lower(?) AND id != ? LIMIT 1',
    )
    .get(ctx.workspaceId, itemId, number, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

// --- item tracking mode (US-J01.1) -------------------------------------------------------------

export interface SetTrackingModeInput {
  itemId?: string;
  mode?: string;
  idempotencyKey?: string;
}

export function itemSetTrackingMode(ctx: WorkspaceContext, input: SetTrackingModeInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'item_set_tracking_mode');
    if (replayed !== undefined) return replayed;
  }
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) {
    return err('invalid_input', { field: 'itemId' });
  }
  if (typeof input.mode !== 'string' || !TRACKING_MODE_SET.has(input.mode)) {
    return err('invalid_tracking_mode', { mode: input.mode, allowed: [...TRACKING_MODES] });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const item = readItem(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });
  const mode = input.mode as TrackingMode;

  if (mode !== 'none') {
    // A non-none mode needs a stockable item and a zero current on-hand (spec US-J01.1): turning on
    // batch/unit awareness while quantity already exists would leave that quantity untraceable.
    if (item.track_stock !== 1 || item.kind === 'service') return err('tracking_not_applicable', { itemId: item.id });
    if (itemOnHand(ctx, item.id) !== 0) return err('tracking_mode_requires_zero_stock', { itemId: item.id });
  } else {
    // Going back to 'none' is allowed only once every lot and serial for the item is balanced and
    // archived (spec US-J01.8): an unarchived tracked record would be orphaned by an untracked item.
    if (itemOnHand(ctx, item.id) !== 0) return err('tracking_mode_requires_zero_stock', { itemId: item.id });
    const liveLot = ctx.store.db
      .prepare("SELECT id FROM lot WHERE workspace_id = ? AND item_id = ? AND status != 'archived' LIMIT 1")
      .get(ctx.workspaceId, item.id) as { id: string } | undefined;
    const liveSerial = ctx.store.db
      .prepare("SELECT id FROM serial WHERE workspace_id = ? AND item_id = ? AND status != 'archived' LIMIT 1")
      .get(ctx.workspaceId, item.id) as { id: string } | undefined;
    if (liveLot !== undefined || liveSerial !== undefined) {
      return err('tracking_mode_requires_zero_stock', { itemId: item.id });
    }
  }

  const run = (): Result => {
    ctx.store.db
      .prepare('UPDATE item SET tracking_mode = ? WHERE workspace_id = ? AND id = ?')
      .run(mode, ctx.workspaceId, item.id);
    const updated = readItem(ctx, item.id) as ItemRow;
    return ok({ item: { id: updated.id, name: updated.name, trackingMode: updated.tracking_mode, trackStock: updated.track_stock === 1 } });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'item_set_tracking_mode', run);
}

// --- lot writes (US-J01.2, .6) -----------------------------------------------------------------

export interface CreateLotInput {
  itemId?: string;
  number?: string;
  expiryDate?: string | null;
  manufacturedDate?: string | null;
  supplierReference?: string | null;
  notes?: string | null;
  status?: string;
  idempotencyKey?: string;
}

export function lotCreate(ctx: WorkspaceContext, input: CreateLotInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'lot_create');
    if (replayed !== undefined) return replayed;
  }
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) {
    return err('invalid_input', { field: 'itemId' });
  }
  const number = typeof input.number === 'string' ? input.number.trim() : '';
  if (number.length === 0 || number.length > NUMBER_MAX) return err('invalid_input', { field: 'number' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const status = input.status ?? 'open';
  if (!LOT_STATUS_SET.has(status)) return err('invalid_lot_status', { status, allowed: [...LOT_STATUSES] });

  const item = readItem(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });
  if (!modeHasLot(item.tracking_mode)) return err('tracking_not_applicable', { itemId: item.id });
  if (lotNumberTaken(ctx, item.id, number)) return err('lot_number_taken', { number });

  const run = (): Result => {
    if (lotNumberTaken(ctx, item.id, number)) return err('lot_number_taken', { number });
    const now = ctx.clock.now();
    const id = ctx.ids.next('lot');
    ctx.store.db
      .prepare(
        `INSERT INTO lot
           (id, workspace_id, item_id, number, status, expiry_date, manufactured_date, supplier_reference, notes,
            created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        item.id,
        number,
        status,
        input.expiryDate ?? null,
        input.manufacturedDate ?? null,
        input.supplierReference ?? null,
        input.notes ?? null,
        now,
        now,
        ctx.actor,
      );
    return ok({ lot: mapLot(readLot(ctx, id) as LotRow) });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'lot_create', run);
}

export interface UpdateLotInput {
  lotId?: string;
  patch?: {
    number?: string;
    expiryDate?: string | null;
    manufacturedDate?: string | null;
    supplierReference?: string | null;
    notes?: string | null;
  };
  idempotencyKey?: string;
}

export function lotUpdate(ctx: WorkspaceContext, input: UpdateLotInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.lotId !== 'string' || input.lotId.length === 0) return err('invalid_input', { field: 'lotId' });
  const current = readLot(ctx, input.lotId);
  if (current === undefined) return err('not_found', { lotId: input.lotId });
  const patch = input.patch ?? {};
  let number = current.number;
  if (patch.number !== undefined) {
    number = patch.number.trim();
    if (number.length === 0 || number.length > NUMBER_MAX) return err('invalid_input', { field: 'number' });
    if (lotNumberTaken(ctx, current.item_id, number, current.id)) return err('lot_number_taken', { number });
  }

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE lot SET number = ?, expiry_date = ?, manufactured_date = ?, supplier_reference = ?, notes = ?,
           updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        number,
        patch.expiryDate !== undefined ? patch.expiryDate : current.expiry_date,
        patch.manufacturedDate !== undefined ? patch.manufacturedDate : current.manufactured_date,
        patch.supplierReference !== undefined ? patch.supplierReference : current.supplier_reference,
        patch.notes !== undefined ? patch.notes : current.notes,
        ctx.clock.now(),
        ctx.workspaceId,
        current.id,
      );
    return ok({ lot: mapLot(readLot(ctx, current.id) as LotRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'lot_update', run);
  }
  return run();
}

export interface SetLotStatusInput {
  lotId?: string;
  status?: string;
  reason?: string;
  idempotencyKey?: string;
}

export function lotSetStatus(ctx: WorkspaceContext, input: SetLotStatusInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.lotId !== 'string' || input.lotId.length === 0) return err('invalid_input', { field: 'lotId' });
  if (typeof input.status !== 'string' || !LOT_STATUS_SET.has(input.status)) {
    return err('invalid_lot_status', { status: input.status, allowed: [...LOT_STATUSES] });
  }
  const status = input.status as LotStatus;

  const run = (): Result => {
    const current = readLot(ctx, input.lotId as string);
    if (current === undefined) return err('not_found', { lotId: input.lotId });
    // A closed or archived lot must first be emptied: its derived on-hand has to be zero, or the
    // quantity would be hidden behind a status that availability queries exclude (spec US-J01.6).
    if ((status === 'closed' || status === 'archived') && lotOnHand(ctx, current.id) !== 0) {
      return err('lot_has_balance', { lotId: current.id });
    }
    ctx.store.db
      .prepare('UPDATE lot SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(status, ctx.clock.now(), ctx.workspaceId, current.id);
    return ok({ lot: mapLot(readLot(ctx, current.id) as LotRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'lot_set_status', run);
  }
  return run();
}

export function lotArchive(ctx: WorkspaceContext, input: { lotId?: string; idempotencyKey?: string }): Result {
  if (typeof input.lotId !== 'string' || input.lotId.length === 0) return err('invalid_input', { field: 'lotId' });
  const args: SetLotStatusInput = { lotId: input.lotId, status: 'archived' };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    args.idempotencyKey = input.idempotencyKey;
  }
  return lotSetStatus(ctx, args);
}

// --- lot reads (US-J01.4, .7) ------------------------------------------------------------------

export function lotGet(ctx: WorkspaceContext, input: { lotId?: string }): Result {
  if (typeof input.lotId !== 'string' || input.lotId.length === 0) return err('invalid_input', { field: 'lotId' });
  const row = readLot(ctx, input.lotId);
  if (row === undefined) return err('not_found', { lotId: input.lotId });
  return ok({ lot: mapLot(row), onHand: lotOnHand(ctx, row.id) });
}

export interface ListLotsInput {
  itemId?: string;
  status?: string;
  search?: string;
  expiryBefore?: string;
  includeArchived?: boolean;
  savedViewId?: string;
}

export function lotList(ctx: WorkspaceContext, input: ListLotsInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('item_id = ?');
    params.push(input.itemId);
  }
  if (typeof input.status === 'string' && LOT_STATUS_SET.has(input.status)) {
    clauses.push('status = ?');
    params.push(input.status);
  } else if (input.includeArchived !== true) {
    clauses.push("status != 'archived'");
  }
  if (typeof input.expiryBefore === 'string' && input.expiryBefore.length > 0) {
    clauses.push('expiry_date IS NOT NULL AND expiry_date < ?');
    params.push(input.expiryBefore);
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('(lower(number) LIKE ? OR lower(supplier_reference) LIKE ?)');
    const like = `%${input.search.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM lot WHERE ${clauses.join(' AND ')} ORDER BY number`)
    .all(...params) as LotRow[];
  return ok({ lots: rows.map((r) => ({ ...mapLot(r), onHand: lotOnHand(ctx, r.id) })) });
}

export function lotSearch(ctx: WorkspaceContext, input: { query?: string }): Result {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length === 0) return ok({ lots: [] });
  const like = `%${query.toLowerCase()}%`;
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM lot WHERE workspace_id = ?
         AND (lower(number) LIKE ? OR lower(supplier_reference) LIKE ?)
        ORDER BY number LIMIT 100`,
    )
    .all(ctx.workspaceId, like, like) as LotRow[];
  return ok({ lots: rows.map(mapLot) });
}

// --- serial writes (US-J01.3, .6) --------------------------------------------------------------

export interface CreateSerialInput {
  itemId?: string;
  number?: string;
  lotId?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
}

/** Shared validation for a single serial create (used by both the single and bulk verbs). */
function validateSerialItemAndLot(ctx: WorkspaceContext, itemId: string, lotId: string | null | undefined): Result<{ item: ItemRow }> {
  const item = readItem(ctx, itemId);
  if (item === undefined) return err('not_found', { itemId });
  if (!modeHasSerial(item.tracking_mode)) return err('tracking_not_applicable', { itemId: item.id });
  if (item.tracking_mode === 'lot_and_serial') {
    if (typeof lotId !== 'string' || lotId.length === 0) return err('lot_reference_required', { itemId: item.id });
  }
  if (typeof lotId === 'string' && lotId.length > 0) {
    const lot = readLot(ctx, lotId);
    if (lot === undefined) return err('not_found', { lotId });
    if (lot.item_id !== item.id) return err('lot_item_mismatch', { lotId, itemId: item.id });
  }
  return ok({ item });
}

export function serialCreate(ctx: WorkspaceContext, input: CreateSerialInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'serial_create');
    if (replayed !== undefined) return replayed;
  }
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) {
    return err('invalid_input', { field: 'itemId' });
  }
  const number = typeof input.number === 'string' ? input.number.trim() : '';
  if (number.length === 0 || number.length > NUMBER_MAX) return err('invalid_input', { field: 'number' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const validated = validateSerialItemAndLot(ctx, input.itemId, input.lotId);
  if (!validated.ok) return validated;
  const item = validated.item;
  if (serialNumberTaken(ctx, item.id, number)) return err('serial_number_taken', { number });

  const run = (): Result => {
    if (serialNumberTaken(ctx, item.id, number)) return err('serial_number_taken', { number });
    const now = ctx.clock.now();
    const id = ctx.ids.next('serial');
    ctx.store.db
      .prepare(
        `INSERT INTO serial
           (id, workspace_id, item_id, lot_id, number, status, current_location_id, notes, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'available', NULL, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, item.id, input.lotId ?? null, number, input.notes ?? null, now, now, ctx.actor);
    return ok({ serial: mapSerial(readSerial(ctx, id) as SerialRow) });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'serial_create', run);
}

export interface CreateSerialBulkInput {
  itemId?: string;
  numbers?: string[];
  lotId?: string | null;
  idempotencyKey?: string;
}

export function serialCreateBulk(ctx: WorkspaceContext, input: CreateSerialBulkInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'serial_create_bulk');
    if (replayed !== undefined) return replayed;
  }
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) {
    return err('invalid_input', { field: 'itemId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!Array.isArray(input.numbers) || input.numbers.length === 0) {
    return err('invalid_input', { field: 'numbers' });
  }
  const numbers: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.numbers) {
    const n = typeof raw === 'string' ? raw.trim() : '';
    if (n.length === 0 || n.length > NUMBER_MAX) return err('invalid_input', { field: 'numbers' });
    // A duplicate WITHIN the batch aborts the whole call (spec §4: all-or-nothing).
    if (seen.has(n.toLowerCase())) return err('serial_number_taken', { number: n });
    seen.add(n.toLowerCase());
    numbers.push(n);
  }
  const validated = validateSerialItemAndLot(ctx, input.itemId, input.lotId);
  if (!validated.ok) return validated;
  const item = validated.item;
  for (const n of numbers) {
    if (serialNumberTaken(ctx, item.id, n)) return err('serial_number_taken', { number: n });
  }

  const run = (): Result => {
    // `rememberIdempotent` already runs this inside one transaction (see sqlite-store.ts), so a
    // duplicate discovered mid-batch by the race re-check THROWS to roll the whole batch back:
    // returning {ok:false} here would COMMIT the rows written so far (the money-path trap). The
    // caller catches the marker below and turns it into a structured serial_number_taken.
    const now = ctx.clock.now();
    const created: Serial[] = [];
    const insert = ctx.store.db.prepare(
      `INSERT INTO serial
         (id, workspace_id, item_id, lot_id, number, status, current_location_id, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'available', NULL, NULL, ?, ?, ?)`,
    );
    for (const n of numbers) {
      if (serialNumberTaken(ctx, item.id, n)) throw new Error(`serial_number_taken:${n}`);
      const id = ctx.ids.next('serial');
      insert.run(id, ctx.workspaceId, item.id, input.lotId ?? null, n, now, now, ctx.actor);
      created.push(mapSerial(readSerial(ctx, id) as SerialRow));
    }
    return ok({ serials: created });
  };
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'serial_create_bulk', run);
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (message.startsWith('serial_number_taken:')) {
      return err('serial_number_taken', { number: message.slice('serial_number_taken:'.length) });
    }
    throw e;
  }
}

export interface UpdateSerialInput {
  serialId?: string;
  patch?: { number?: string; notes?: string | null; lotId?: string | null };
  idempotencyKey?: string;
}

export function serialUpdate(ctx: WorkspaceContext, input: UpdateSerialInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.serialId !== 'string' || input.serialId.length === 0) {
    return err('invalid_input', { field: 'serialId' });
  }
  const current = readSerial(ctx, input.serialId);
  if (current === undefined) return err('not_found', { serialId: input.serialId });
  const patch = input.patch ?? {};
  let number = current.number;
  if (patch.number !== undefined) {
    number = patch.number.trim();
    if (number.length === 0 || number.length > NUMBER_MAX) return err('invalid_input', { field: 'number' });
    if (serialNumberTaken(ctx, current.item_id, number, current.id)) return err('serial_number_taken', { number });
  }
  let lotId = current.lot_id;
  if (patch.lotId !== undefined) {
    lotId = patch.lotId;
    if (typeof lotId === 'string' && lotId.length > 0) {
      const lot = readLot(ctx, lotId);
      if (lot === undefined) return err('not_found', { lotId });
      if (lot.item_id !== current.item_id) return err('lot_item_mismatch', { lotId, itemId: current.item_id });
    }
  }

  const run = (): Result => {
    ctx.store.db
      .prepare('UPDATE serial SET number = ?, notes = ?, lot_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(
        number,
        patch.notes !== undefined ? patch.notes : current.notes,
        lotId,
        ctx.clock.now(),
        ctx.workspaceId,
        current.id,
      );
    return ok({ serial: mapSerial(readSerial(ctx, current.id) as SerialRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'serial_update', run);
  }
  return run();
}

export interface SetSerialStatusInput {
  serialId?: string;
  status?: string;
  reason?: string;
  idempotencyKey?: string;
}

export function serialSetStatus(ctx: WorkspaceContext, input: SetSerialStatusInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.serialId !== 'string' || input.serialId.length === 0) {
    return err('invalid_input', { field: 'serialId' });
  }
  if (typeof input.status !== 'string' || !SERIAL_STATUS_SET.has(input.status)) {
    return err('invalid_serial_status', { status: input.status, allowed: [...SERIAL_STATUSES] });
  }
  const status = input.status as SerialStatus;

  const run = (): Result => {
    const current = readSerial(ctx, input.serialId as string);
    if (current === undefined) return err('not_found', { serialId: input.serialId });
    ctx.store.db
      .prepare('UPDATE serial SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(status, ctx.clock.now(), ctx.workspaceId, current.id);
    return ok({ serial: mapSerial(readSerial(ctx, current.id) as SerialRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'serial_set_status', run);
  }
  return run();
}

export function serialArchive(ctx: WorkspaceContext, input: { serialId?: string; idempotencyKey?: string }): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.serialId !== 'string' || input.serialId.length === 0) {
    return err('invalid_input', { field: 'serialId' });
  }
  const run = (): Result => {
    const current = readSerial(ctx, input.serialId as string);
    if (current === undefined) return err('not_found', { serialId: input.serialId });
    // A serial still notionally in stock (available or reserved) must be issued, returned or scrapped
    // before it can be archived (spec US-J01.8: archive a serial with balance is refused).
    if (current.status === 'available' || current.status === 'reserved') {
      return err('serial_has_balance', { serialId: current.id, status: current.status });
    }
    ctx.store.db
      .prepare("UPDATE serial SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.clock.now(), ctx.workspaceId, current.id);
    return ok({ serial: mapSerial(readSerial(ctx, current.id) as SerialRow) });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'serial_archive', run);
  }
  return run();
}

// --- serial reads (US-J01.5, .7) ---------------------------------------------------------------

export function serialGet(ctx: WorkspaceContext, input: { serialId?: string }): Result {
  if (typeof input.serialId !== 'string' || input.serialId.length === 0) {
    return err('invalid_input', { field: 'serialId' });
  }
  const row = readSerial(ctx, input.serialId);
  if (row === undefined) return err('not_found', { serialId: input.serialId });
  return ok({ serial: mapSerial(row) });
}

export interface ListSerialsInput {
  itemId?: string;
  lotId?: string;
  status?: string;
  locationId?: string;
  search?: string;
  includeArchived?: boolean;
  savedViewId?: string;
}

export function serialList(ctx: WorkspaceContext, input: ListSerialsInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('item_id = ?');
    params.push(input.itemId);
  }
  if (typeof input.lotId === 'string' && input.lotId.length > 0) {
    clauses.push('lot_id = ?');
    params.push(input.lotId);
  }
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    clauses.push('current_location_id = ?');
    params.push(input.locationId);
  }
  if (typeof input.status === 'string' && SERIAL_STATUS_SET.has(input.status)) {
    clauses.push('status = ?');
    params.push(input.status);
  } else if (input.includeArchived !== true) {
    clauses.push("status != 'archived'");
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('lower(number) LIKE ?');
    params.push(`%${input.search.trim().toLowerCase()}%`);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM serial WHERE ${clauses.join(' AND ')} ORDER BY number`)
    .all(...params) as SerialRow[];
  return ok({ serials: rows.map(mapSerial) });
}

export function serialSearch(ctx: WorkspaceContext, input: { query?: string }): Result {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length === 0) return ok({ serials: [] });
  const like = `%${query.toLowerCase()}%`;
  const rows = ctx.store.db
    .prepare('SELECT * FROM serial WHERE workspace_id = ? AND lower(number) LIKE ? ORDER BY number LIMIT 100')
    .all(ctx.workspaceId, like) as SerialRow[];
  return ok({ serials: rows.map(mapSerial) });
}

// --- read models (US-J01.4, .5): pure, no cache mutation ---------------------------------------

export interface OnHandByLotFilter {
  itemId?: string;
  locationId?: string;
  lotId?: string;
  status?: string[];
  expiryBefore?: string;
  includeZero?: boolean;
}

export function inventoryOnHandByLot(ctx: WorkspaceContext, input: OnHandByLotFilter = {}): Result {
  const clauses = ['m.workspace_id = ?', 'm.lot_id IS NOT NULL'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('m.item_id = ?');
    params.push(input.itemId);
  }
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    clauses.push('m.location_id = ?');
    params.push(input.locationId);
  }
  if (typeof input.lotId === 'string' && input.lotId.length > 0) {
    clauses.push('m.lot_id = ?');
    params.push(input.lotId);
  }
  if (Array.isArray(input.status) && input.status.length > 0) {
    const valid = input.status.filter((s) => LOT_STATUS_SET.has(s));
    if (valid.length > 0) {
      clauses.push(`l.status IN (${valid.map(() => '?').join(', ')})`);
      params.push(...valid);
    }
  }
  if (typeof input.expiryBefore === 'string' && input.expiryBefore.length > 0) {
    clauses.push('l.expiry_date IS NOT NULL AND l.expiry_date < ?');
    params.push(input.expiryBefore);
  }
  const having = input.includeZero === true ? '' : 'HAVING COALESCE(SUM(m.qty), 0) != 0';

  const rows = ctx.store.db
    .prepare(
      `SELECT m.lot_id AS lotId, l.number AS lotNumber, m.item_id AS itemId, i.name AS itemName,
              m.location_id AS locationId, loc.code AS locationCode, loc.name AS locationName,
              l.expiry_date AS expiryDate, l.status AS status,
              COALESCE(SUM(m.qty), 0) AS qty
         FROM stock_movement m
         JOIN lot l ON l.id = m.lot_id
         JOIN item i ON i.id = m.item_id
         JOIN stock_location loc ON loc.id = m.location_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY m.lot_id, m.location_id
        ${having}
        ORDER BY l.expiry_date IS NULL, l.expiry_date, l.number`,
    )
    .all(...params) as unknown[];
  return ok({ rows });
}

export interface AvailableSerialsFilter {
  itemId?: string;
  locationId?: string;
  lotId?: string;
  status?: string[];
}

export function inventoryAvailableSerials(ctx: WorkspaceContext, input: AvailableSerialsFilter = {}): Result {
  const statuses = Array.isArray(input.status) && input.status.length > 0
    ? input.status.filter((s) => SERIAL_STATUS_SET.has(s))
    : ['available'];
  const effective = statuses.length > 0 ? statuses : ['available'];
  const clauses = ['workspace_id = ?', `status IN (${effective.map(() => '?').join(', ')})`];
  const params: unknown[] = [ctx.workspaceId, ...effective];
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    clauses.push('item_id = ?');
    params.push(input.itemId);
  }
  if (typeof input.locationId === 'string' && input.locationId.length > 0) {
    clauses.push('current_location_id = ?');
    params.push(input.locationId);
  }
  if (typeof input.lotId === 'string' && input.lotId.length > 0) {
    clauses.push('lot_id = ?');
    params.push(input.lotId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM serial WHERE ${clauses.join(' AND ')} ORDER BY number`)
    .all(...params) as SerialRow[];
  return ok({ serials: rows.map(mapSerial) });
}
