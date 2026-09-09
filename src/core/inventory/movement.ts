/**
 * J02, the inventory movement ledger: the append-only quantity truth every other inventory capability
 * (J03 valuation, J04 stocktake, J05 adjustments, J06 GL link, I02 goods receipt, D03 delivery) writes
 * through and reads from. It owns the ONE write path (`inventoryMove`, plus the `inventoryTransfer`
 * convenience that expands to a paired move) and the pure balance / movement read models over D01's
 * `stock_movement` table (spec §4). On-hand is NEVER a stored column: it is always the live
 * `SUM(stock_movement.qty)` for a filter (OP13 / §H-STOCK-AUDIT). §H-TENANT on every query.
 *
 * THE MONEY-PATH INVARIANTS THIS FILE HOLDS (spec §7, asserted in `test/inventory/`):
 *  (a) APPEND-ONLY: a movement row is insert-only; the DB triggers in `movementSchema.ts` abort any
 *      UPDATE or DELETE. This file only ever INSERTs.
 *  (b) ON-HAND == SUM: a movement is the only thing that changes on-hand, and on-hand is the SUM of
 *      matching rows, never a cached balance.
 *  (c) IDEMPOTENT ON ROWS (§H-IDEMPOTENT): a replayed idempotency_key writes exactly one row (a
 *      transfer, exactly one pair) and returns the original; the unique (workspace, key) index is the
 *      race guard underneath the pre-check.
 *  (d) §H-TENANT: a movement never crosses a workspace; a foreign id is invisible.
 *  (e) TRACKING ENFORCEMENT (J01 contract): when the item's tracking_mode demands a lot or a serial,
 *      a movement without it is refused (`lot_required` / `serial_required`).
 *  (f) NEGATIVE-STOCK POLICY: with `allow_negative_stock` false (the default), a write that would
 *      drive a balance below zero is refused with `insufficient_stock` BEFORE any row is written.
 *  (g) A SERIAL IS A UNIT OF ONE: an INBOUND movement for a serial the workspace already holds is
 *      refused with `serial_already_in_stock` before any write, so `SUM(qty)` for one serial can
 *      never reach 2. "Already held" is J01's own rule (see `serialAlreadyInStock` below), and the
 *      negative-stock opt-out does not lift it: that policy is about aggregate quantity, not a
 *      licence to hold one physical unit twice.
 *
 * THE PARTIAL-WRITE TRAP (money-path). `ctx.store.tx` COMMITS a `{ok:false}` returned from inside it,
 * so every guard that could reject runs BEFORE the first INSERT: inside the transaction the negative
 * check comes first and nothing is written until it passes, and a transfer writes both legs or (via a
 * thrown abort on the second leg) neither. A partial movement is corrupt stock truth, so there is no
 * path here that writes one row and then returns a rejection.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/**
 * §H-ENUM, the movement types (spec §4). Core types are fixed and validated at the verb boundary,
 * never a CHECK constraint (the D01 convention). Signs: `opening`/`receipt`/`transfer_in` increase,
 * `issue`/`transfer_out`/`scrap` decrease, `adjustment`/`return` carry the caller's sign.
 */
export const MOVEMENT_TYPES = [
  'opening',
  'receipt',
  'issue',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'return',
  'scrap',
  // J02/J03 cost-adjustment seam (I03 landed cost). A VALUE-ONLY movement: it carries a signed
  // `cost_amount_minor` (Rappen) and NO quantity (qty is exactly 0), so on-hand `SUM(qty)` is
  // UNCHANGED by it. `unit_cost_minor` stays NULL (there is no unit here, only a lump of cost bound to
  // the receipt movement it names through `ref_movement_id`). J03 folds the cost into the pool
  // (weighted average), the referenced layer (FIFO) or the purchase-price variance (standard cost).
  // It is the ONLY type admitted at qty 0; every quantity-moving type still requires qty != 0.
  'landed_cost',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
const MOVEMENT_TYPE_SET: ReadonlySet<string> = new Set(MOVEMENT_TYPES);
export function isMovementType(x: unknown): x is MovementType {
  return typeof x === 'string' && MOVEMENT_TYPE_SET.has(x);
}

/** The cost-only type: moves no quantity, carries a signed `cost_amount_minor` instead. */
export const COST_ONLY_TYPES: ReadonlySet<string> = new Set(['landed_cost']);
export function isCostOnlyType(x: unknown): x is MovementType {
  return typeof x === 'string' && COST_ONLY_TYPES.has(x);
}

const MUST_BE_POSITIVE: ReadonlySet<string> = new Set(['opening', 'receipt', 'transfer_in']);
const MUST_BE_NEGATIVE: ReadonlySet<string> = new Set(['issue', 'transfer_out', 'scrap']);
// `adjustment` and `return` carry whatever sign the caller gave (a stocktake shrink is negative, a
// customer return is positive, a return-to-vendor is negative). `landed_cost` moves no quantity at
// all (qty is exactly 0); its sign lives on `cost_amount_minor`.

/**
 * The D01 `stock_movement.reason` a J02 type maps to. `reason` is NOT NULL and is what D01's own reads
 * and OR-957a audit vocabulary carry; `movement_type` (the additive column) is J02's authoritative
 * type. Valuation (`core/stock/valuation.ts`) layers on `qty` sign, not `reason`, so this mapping
 * never disturbs a FIFO / weighted-average run.
 */
const REASON_FOR_TYPE: Record<MovementType, string> = {
  opening: 'receipt',
  receipt: 'receipt',
  issue: 'issue',
  transfer_out: 'transfer',
  transfer_in: 'transfer',
  adjustment: 'adjust',
  return: 'return',
  scrap: 'issue',
  // A cost adjustment is neither a receipt nor an issue of goods, so it maps to D01's `adjust`
  // reason. Valuation keys on `movement_type` and `qty`, never on `reason`, so this mapping never
  // disturbs a FIFO / weighted-average run: a `landed_cost` row reads back as `landed_cost` because
  // its `movement_type` column is set.
  landed_cost: 'adjust',
};

// --- small tenant-scoped reads -----------------------------------------------------------------

interface ItemRow {
  id: string;
  name: string;
  track_stock: number;
  tracking_mode: string;
}

function readItem(ctx: WorkspaceContext, id: string): ItemRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, name, track_stock, tracking_mode FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ItemRow | undefined;
}

function readLocation(ctx: WorkspaceContext, id: string): { id: string } | undefined {
  return ctx.store.db
    .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { id: string } | undefined;
}

function readLot(ctx: WorkspaceContext, id: string): { id: string; item_id: string } | undefined {
  return ctx.store.db
    .prepare('SELECT id, item_id FROM lot WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { id: string; item_id: string } | undefined;
}

interface SerialRow {
  id: string;
  item_id: string;
  lot_id: string | null;
  number: string;
  status: string;
  current_location_id: string | null;
}

function readSerial(ctx: WorkspaceContext, id: string): SerialRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT id, item_id, lot_id, number, status, current_location_id FROM serial WHERE workspace_id = ? AND id = ?',
    )
    .get(ctx.workspaceId, id) as SerialRow | undefined;
}

/**
 * The ledger balance for ONE serial across every location, workspace-scoped. A serial is a unit of
 * one, so this is the number that must never exceed 1: `balanceFor` is narrowed to a single
 * location and would happily let the same unit be received at a second one.
 */
function serialOnHand(ctx: WorkspaceContext, serialId: string): number {
  const row = ctx.store.db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE workspace_id = ? AND serial_id = ?')
    .get(ctx.workspaceId, serialId) as { n: number };
  return row.n;
}

/**
 * Refuse an INBOUND movement for a serial the workspace already holds (invariant g). A serial number
 * identifies one physical unit, so a second receipt of the same unit leaves `SUM(qty)` = 2 for a
 * thing there is only one of, and every later reader (J03 valuation, J04 stocktake, J06 GL link)
 * then values, counts and books stock that does not exist.
 *
 * WHAT "IN STOCK" MEANS, AND WHY THE LEDGER IS THE TEST.
 *
 * J01 states the rule in `serialArchive` (`tracking.ts`): a serial whose status is `available` OR
 * `reserved` is still notionally in stock and may not be archived; `issued`, `returned` and
 * `scrapped` are out, and such a unit may legitimately be received back. Reading `available` alone
 * is the mistake a neighbouring capability shipped twice, because a reserved unit is held, not gone.
 *
 * That rule cannot be applied to the STATUS COLUMN here, for a reason the archive path never meets:
 * `serialCreate` writes status `available` with a NULL location and no movement at all (J01 spec
 * US-J01.3 creates the serial BEFORE the receipt), so a status test would refuse the FIRST receipt
 * of every serial ever created. The ledger has no such hole. A J01 status transition never writes a
 * movement, so a unit that is `available` or `reserved` still carries its inbound row and sums to 1:
 * sum and status agree on the two statuses the archive path cares about.
 *
 * WHERE THEY DRIFT, THE LEDGER WINS, and they do drift. A customer return (`return` with a positive
 * qty) sets the status to `returned` while the ledger sum goes to 1, and that unit is genuinely back
 * on the shelf: the status says out, the sum says held, and refusing a further receipt is the right
 * answer. On-hand is always `SUM(stock_movement.qty)` and never a stored column (invariant b), while
 * `serial.status` is a projection, so the SUM is the one that cannot be stale. (The same drift lets
 * `serialArchive` archive a serial the ledger still holds. That is J01's hole to close, filed
 * against J01; this guard is unaffected by it, because it never reads the status to decide.) The
 * status is carried in the rejection so the caller sees what J01 believed at the time.
 *
 * Returns a Result, never a throw: the caller is inside `ctx.store.tx`, which COMMITS what it has
 * when a rejection is returned, so this runs BEFORE the INSERT, and a thrown FK error is not a
 * substitute for a structured refusal.
 */
function serialAlreadyInStock(
  ctx: WorkspaceContext,
  serial: SerialRow,
  qty: number,
  locationId: string,
): Result | undefined {
  const onHand = serialOnHand(ctx, serial.id);
  // A unit of one can never sum above one, whatever the movement type or the location.
  if (onHand + qty <= 1) return undefined;
  return err('serial_already_in_stock', {
    serialId: serial.id,
    number: serial.number,
    itemId: serial.item_id,
    status: serial.status,
    onHand,
    currentLocationId: serial.current_location_id,
    locationId,
  });
}

function modeHasLot(mode: string): boolean {
  return mode === 'lot' || mode === 'lot_and_serial';
}
function modeHasSerial(mode: string): boolean {
  return mode === 'serial' || mode === 'lot_and_serial';
}

/** The negative-stock posture (spec §4): absent row means the default false. */
export function allowNegativeStock(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT allow_negative_stock FROM inventory_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { allow_negative_stock: number } | undefined;
  return row?.allow_negative_stock === 1;
}

/**
 * On-hand for the EXACT filter a movement touches, as an inclusive SUM (invariant b). Used by the
 * negative-stock guard: the balance that must not go below zero is the one for this item x location,
 * further narrowed by lot / serial when the movement carries them, so a lot-tracked issue cannot
 * overdraw one lot even while the location total is positive.
 */
function balanceFor(
  ctx: WorkspaceContext,
  f: { itemId: string; locationId: string; lotId: string | null; serialId: string | null },
): number {
  const clauses = ['workspace_id = ?', 'item_id = ?', 'location_id = ?'];
  const params: unknown[] = [ctx.workspaceId, f.itemId, f.locationId];
  if (f.lotId !== null) {
    clauses.push('lot_id = ?');
    params.push(f.lotId);
  }
  if (f.serialId !== null) {
    clauses.push('serial_id = ?');
    params.push(f.serialId);
  }
  const row = ctx.store.db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS n FROM stock_movement WHERE ${clauses.join(' AND ')}`)
    .get(...params) as { n: number };
  return row.n;
}

// --- the movement row shape and its mapping ----------------------------------------------------

export interface InventoryMovement {
  id: string;
  itemId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  unitCostMinor: number | null;
  /**
   * J02/J03 cost-adjustment seam (I03). A signed lump of cost in Rappen, carried ONLY by a
   * `landed_cost` movement (null on every quantity-moving type). J03 folds it into the value without
   * touching the quantity. Positive adds cost, negative reverses it.
   */
  costAmountMinor: number | null;
  /**
   * The receipt movement this row adjusts (I03). A `landed_cost` movement names the original inbound
   * movement whose FIFO layer / cost pool receives the extra cost, so cost still follows the goods
   * across a transfer. Null on every ordinary movement.
   */
  refMovementId: string | null;
  movementType: MovementType;
  effectiveDate: string;
  sourceDocumentType: string | null;
  sourceDocumentId: string | null;
  transferGroupId: string | null;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
  idempotencyKey: string;
}

interface MovementDbRow {
  id: string;
  item_id: string;
  location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  qty: number;
  unit_cost_minor: number | null;
  cost_amount_minor: number | null;
  ref_movement_id: string | null;
  movement_type: string | null;
  reason: string;
  moved_at: string;
  ref_kind: string | null;
  ref_id: string | null;
  transfer_group_id: string | null;
  description: string | null;
  created_at: string;
  created_by: string | null;
  idempotency_key: string;
}

/**
 * Map a row to the wire shape. `movement_type` is COALESCEd to `reason` for rows D01 wrote before J02
 * (their `movement_type` is NULL): a D01 `receipt` reads as `receipt`, an `adjust` as `adjustment`, a
 * `transfer` as `transfer_out` / `transfer_in` from the sign, so the history has one type vocabulary.
 */
function mapMovement(r: MovementDbRow): InventoryMovement {
  let type: MovementType;
  if (r.movement_type !== null && isMovementType(r.movement_type)) {
    type = r.movement_type;
  } else if (r.reason === 'transfer') {
    type = r.qty >= 0 ? 'transfer_in' : 'transfer_out';
  } else if (r.reason === 'adjust') {
    type = 'adjustment';
  } else if (isMovementType(r.reason)) {
    type = r.reason;
  } else {
    type = 'adjustment';
  }
  return {
    id: r.id,
    itemId: r.item_id,
    locationId: r.location_id,
    lotId: r.lot_id,
    serialId: r.serial_id,
    qty: r.qty,
    unitCostMinor: r.unit_cost_minor,
    costAmountMinor: r.cost_amount_minor,
    refMovementId: r.ref_movement_id,
    movementType: type,
    effectiveDate: r.moved_at,
    sourceDocumentType: r.ref_kind,
    sourceDocumentId: r.ref_id,
    transferGroupId: r.transfer_group_id,
    description: r.description,
    createdAt: r.created_at,
    createdBy: r.created_by,
    idempotencyKey: r.idempotency_key,
  };
}

const MOVEMENT_COLUMNS = `id, item_id, location_id, lot_id, serial_id, qty, unit_cost_minor,
  cost_amount_minor, ref_movement_id, movement_type, reason, moved_at, ref_kind, ref_id,
  transfer_group_id, description, created_at, created_by, idempotency_key`;

function movementByKey(ctx: WorkspaceContext, key: string): InventoryMovement | undefined {
  const row = ctx.store.db
    .prepare(`SELECT ${MOVEMENT_COLUMNS} FROM stock_movement WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, key) as MovementDbRow | undefined;
  return row === undefined ? undefined : mapMovement(row);
}

function movementsByTransferGroup(ctx: WorkspaceContext, groupId: string): InventoryMovement[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT ${MOVEMENT_COLUMNS} FROM stock_movement WHERE workspace_id = ? AND transfer_group_id = ? ORDER BY qty`,
    )
    .all(ctx.workspaceId, groupId) as MovementDbRow[];
  return rows.map(mapMovement);
}

// --- the single row insert + the serial projection ---------------------------------------------

interface RawMovement {
  itemId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  movementType: MovementType;
  unitCostMinor: number | null;
  costAmountMinor: number | null;
  refMovementId: string | null;
  effectiveDate: string;
  sourceDocumentType: string | null;
  sourceDocumentId: string | null;
  transferGroupId: string | null;
  description: string | null;
  idempotencyKey: string;
}

/** The ONE INSERT (append-only): callers validate and guard first, this only writes one row. */
function insertMovement(ctx: WorkspaceContext, m: RawMovement): InventoryMovement {
  const id = ctx.ids.next('stockmv');
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO stock_movement
         (id, workspace_id, item_id, location_id, lot_id, serial_id, qty, unit_cost_minor,
          cost_amount_minor, ref_movement_id, movement_type, reason, moved_at, ref_kind, ref_id,
          transfer_group_id, description, created_at, created_by, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      m.itemId,
      m.locationId,
      m.lotId,
      m.serialId,
      m.qty,
      m.unitCostMinor,
      m.costAmountMinor,
      m.refMovementId,
      m.movementType,
      REASON_FOR_TYPE[m.movementType],
      m.effectiveDate,
      m.sourceDocumentType,
      m.sourceDocumentId,
      m.transferGroupId,
      m.description,
      now,
      ctx.actor,
      m.idempotencyKey,
    );
  updateSerialProjection(ctx, m);
  const row = ctx.store.db
    .prepare(`SELECT ${MOVEMENT_COLUMNS} FROM stock_movement WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id) as MovementDbRow;
  return mapMovement(row);
}

/**
 * Keep the J01 serial projection (`serial.current_location_id` / `serial.status`) in step with the
 * latest movement that referenced the unit (spec §1, and the trackingSchema comment). A serial is a
 * unit of one, so this is a projection of "where is it now and what state is it in", never a count.
 * Inbound legs park the unit at the movement's location and make it available; `issue` / `scrap`
 * remove it from a location and set the terminal status; `return` marks it returned. `transfer_out`
 * is left untouched because its paired `transfer_in` re-parks the unit at the destination.
 */
function updateSerialProjection(ctx: WorkspaceContext, m: RawMovement): void {
  if (m.serialId === null) return;
  let location: string | null | undefined;
  let status: string | undefined;
  switch (m.movementType) {
    case 'opening':
    case 'receipt':
    case 'transfer_in':
      location = m.locationId;
      status = 'available';
      break;
    case 'issue':
      location = null;
      status = 'issued';
      break;
    case 'scrap':
      location = null;
      status = 'scrapped';
      break;
    case 'return':
      location = m.qty >= 0 ? m.locationId : null;
      status = 'returned';
      break;
    case 'adjustment':
      location = m.qty >= 0 ? m.locationId : null;
      break;
    case 'transfer_out':
    default:
      return;
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (location !== undefined) {
    sets.push('current_location_id = ?');
    params.push(location);
  }
  if (status !== undefined) {
    sets.push('status = ?');
    params.push(status);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(ctx.clock.now());
  params.push(ctx.workspaceId, m.serialId);
  ctx.store.db
    .prepare(`UPDATE serial SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
    .run(...params);
}

// --- validation shared by move + transfer ------------------------------------------------------

/** Validate the tracking references against the item's mode (invariant e) and their ownership. */
function validateTracking(
  ctx: WorkspaceContext,
  item: ItemRow,
  lotId: string | null,
  serialId: string | null,
): Result | undefined {
  if (modeHasLot(item.tracking_mode) && lotId === null) return err('lot_required', { itemId: item.id });
  if (modeHasSerial(item.tracking_mode) && serialId === null) {
    return err('serial_required', { itemId: item.id });
  }
  if (lotId !== null) {
    const lot = readLot(ctx, lotId);
    if (lot === undefined) return err('not_found', { lotId });
    if (lot.item_id !== item.id) return err('lot_item_mismatch', { lotId, itemId: item.id });
  }
  if (serialId !== null) {
    const serial = readSerial(ctx, serialId);
    if (serial === undefined) return err('not_found', { serialId });
    if (serial.item_id !== item.id) return err('serial_item_mismatch', { serialId, itemId: item.id });
    // A serial that carries a lot must move with THAT lot, so the two projections cannot disagree.
    if (lotId !== null && serial.lot_id !== null && serial.lot_id !== lotId) {
      return err('lot_item_mismatch', { serialId, lotId });
    }
  }
  return undefined;
}

// --- inventoryMove: the one write path ---------------------------------------------------------

export interface InventoryMoveInput {
  itemId?: string;
  locationId?: string;
  qty?: number;
  movementType?: string;
  unitCostMinor?: number | null;
  /** I03 cost-adjustment seam: the signed Rappen a `landed_cost` movement carries (see the type). */
  costAmountMinor?: number | null;
  /** I03: the original receipt movement a `landed_cost` movement adjusts. */
  refMovementId?: string | null;
  effectiveDate?: string;
  lotId?: string | null;
  serialId?: string | null;
  sourceDocumentType?: string | null;
  sourceDocumentId?: string | null;
  description?: string | null;
  idempotencyKey?: string;
}

/**
 * Record one movement (spec §5). The only way on-hand ever changes. Every guard runs before the
 * INSERT; a replay of the idempotency key returns the original row and writes nothing (invariant c).
 */
export function inventoryMove(ctx: WorkspaceContext, input: InventoryMoveInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  const guard = validateMoveInput(input);
  if (!guard.ok) return guard.err;
  const { qty, movementType, unitCostMinor, costAmountMinor, refMovementId, effectiveDate, lotId, serialId, key } =
    guard.value;

  const item = readItem(ctx, input.itemId as string);
  if (item === undefined) return err('not_found', { itemId: input.itemId });
  if (item.track_stock !== 1) return err('item_not_stockable', { itemId: item.id });

  const location = readLocation(ctx, input.locationId as string);
  if (location === undefined) return err('not_found', { locationId: input.locationId });

  // A cost-only movement (I03 landed cost) attaches a lump of cost to a receipt LAYER, not to a lot or
  // a serial: it moves no quantity, so J01's lot/serial requirement (which exists to keep on-hand-by-
  // lot honest) has nothing to bite on. It carries lot_id / serial_id NULL and skips the tracking
  // reference check that would otherwise demand a lot on a lot-tracked item. `ref_movement_id` must
  // name a real receipt movement for THIS item, so cost cannot be pinned to goods it never costed.
  if (isCostOnlyType(movementType)) {
    if (refMovementId === null) return err('invalid_input', { field: 'refMovementId' });
    const ref = ctx.store.db
      .prepare('SELECT id, item_id FROM stock_movement WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, refMovementId) as { id: string; item_id: string } | undefined;
    if (ref === undefined) return err('not_found', { refMovementId });
    if (ref.item_id !== item.id) return err('ref_movement_item_mismatch', { refMovementId, itemId: item.id });
  } else {
    const trackingErr = validateTracking(ctx, item, lotId, serialId);
    if (trackingErr !== undefined) return trackingErr;
  }

  // §H-IDEMPOTENT fast path: a replay returns the original, never a second row.
  const replay = movementByKey(ctx, key);
  if (replay !== undefined) return ok(replayResult(ctx, replay));

  const raw: RawMovement = {
    itemId: item.id,
    locationId: location.id,
    lotId,
    serialId,
    qty,
    movementType,
    unitCostMinor,
    costAmountMinor,
    refMovementId,
    effectiveDate,
    sourceDocumentType: input.sourceDocumentType ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    transferGroupId: null,
    description: input.description ?? null,
    idempotencyKey: key,
  };

  try {
    return ctx.store.tx(() => {
      // Re-check under the transaction (the race the fast path cannot see).
      const raced = movementByKey(ctx, key);
      if (raced !== undefined) return ok(replayResult(ctx, raced));
      // A serial is a unit of one: an INBOUND for a unit already held is refused before any write,
      // so SUM(qty) for one serial can never reach 2 (invariant g). This sits AFTER the replay
      // checks on purpose: a replay is the original movement, not a second receipt.
      if (serialId !== null && qty > 0) {
        const serial = readSerial(ctx, serialId);
        if (serial !== undefined) {
          const held = serialAlreadyInStock(ctx, serial, qty, location.id);
          if (held !== undefined) return held;
        }
      }
      // Negative-stock guard, before any write, so a rejection commits nothing (the trap).
      if (qty < 0 && !allowNegativeStock(ctx)) {
        const available = balanceFor(ctx, { itemId: item.id, locationId: location.id, lotId, serialId });
        if (available + qty < 0) {
          return err('insufficient_stock', {
            itemId: item.id,
            locationId: location.id,
            lotId,
            serialId,
            available,
            requested: qty,
          });
        }
      }
      const movement = insertMovement(ctx, raw);
      return ok({
        movement,
        onHand: balanceFor(ctx, { itemId: item.id, locationId: location.id, lotId: null, serialId: null }),
      });
    });
  } catch (e) {
    // A lost idempotency race trips the unique (workspace, key) index; replay the winner's row.
    const winner = movementByKey(ctx, key);
    if (winner !== undefined) return ok(replayResult(ctx, winner));
    throw e;
  }
}

function replayResult(ctx: WorkspaceContext, movement: InventoryMovement): Record<string, unknown> {
  return {
    movement,
    onHand: balanceFor(ctx, {
      itemId: movement.itemId,
      locationId: movement.locationId,
      lotId: null,
      serialId: null,
    }),
  };
}

interface ValidMove {
  qty: number;
  movementType: MovementType;
  unitCostMinor: number | null;
  costAmountMinor: number | null;
  refMovementId: string | null;
  effectiveDate: string;
  lotId: string | null;
  serialId: string | null;
  key: string;
}

function validateMoveInput(input: InventoryMoveInput): { ok: true; value: ValidMove } | { ok: false; err: Result } {
  if (!isMovementType(input.movementType)) {
    return { ok: false, err: err('invalid_movement_type', { movementType: input.movementType, allowed: [...MOVEMENT_TYPES] }) };
  }
  const movementType = input.movementType;
  const costOnly = isCostOnlyType(movementType);
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) {
    return { ok: false, err: err('invalid_input', { field: 'itemId' }) };
  }
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return { ok: false, err: err('invalid_input', { field: 'locationId' }) };
  }
  // THE QTY RULE, SPLIT BY WHETHER THE TYPE MOVES QUANTITY. Every quantity-moving type still refuses
  // qty 0 (`invalid_qty`), exactly as before. A cost-only `landed_cost` movement is the mirror: it
  // moves NO quantity, so qty MUST be exactly 0 and a non-zero qty is refused. This is the one place
  // the qty-0 rejection is relaxed, and only for the cost-only type.
  if (typeof input.qty !== 'number' || !Number.isInteger(input.qty)) {
    return { ok: false, err: err('invalid_qty', { qty: input.qty }) };
  }
  if (costOnly) {
    if (input.qty !== 0) return { ok: false, err: err('invalid_qty', { qty: input.qty, movementType, reason: 'cost_only_moves_no_qty' }) };
  } else if (input.qty === 0) {
    return { ok: false, err: err('invalid_qty', { qty: input.qty }) };
  }
  const qty = input.qty;
  if (MUST_BE_POSITIVE.has(movementType) && qty < 0) {
    return { ok: false, err: err('invalid_qty', { qty, movementType, reason: 'must_be_positive' }) };
  }
  if (MUST_BE_NEGATIVE.has(movementType) && qty > 0) {
    return { ok: false, err: err('invalid_qty', { qty, movementType, reason: 'must_be_negative' }) };
  }
  const serialId = input.serialId ?? null;
  // A serial is a unit of one, so a serial movement moves exactly one unit. A cost-only movement
  // carries no serial (it attaches to a layer, not a unit), so the rule does not apply to it.
  if (!costOnly && serialId !== null && Math.abs(qty) !== 1) {
    return { ok: false, err: err('invalid_qty', { qty, reason: 'serial_is_unit_of_one' }) };
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return { ok: false, err: err('invalid_input', { field: 'idempotencyKey' }) };
  }
  // Cost-only and quantity-moving types are mutually exclusive about which cost field they carry: a
  // `landed_cost` movement carries a signed `cost_amount_minor` and NO `unit_cost_minor`; every other
  // type is the reverse. Enforcing both directions keeps a caller from smuggling a per-unit cost onto
  // a cost adjustment (which J03 would double-count) or a lump onto a receipt (which nothing reads).
  if (costOnly) {
    if (input.unitCostMinor !== undefined && input.unitCostMinor !== null) {
      return { ok: false, err: err('invalid_input', { field: 'unitCostMinor', reason: 'cost_only_uses_cost_amount' }) };
    }
    if (
      typeof input.costAmountMinor !== 'number' ||
      !Number.isInteger(input.costAmountMinor) ||
      input.costAmountMinor === 0
    ) {
      return { ok: false, err: err('invalid_input', { field: 'costAmountMinor' }) };
    }
    if (typeof input.refMovementId !== 'string' || input.refMovementId.length === 0) {
      return { ok: false, err: err('invalid_input', { field: 'refMovementId' }) };
    }
  } else {
    if (input.costAmountMinor !== undefined && input.costAmountMinor !== null) {
      return { ok: false, err: err('invalid_input', { field: 'costAmountMinor', reason: 'only_landed_cost_carries_it' }) };
    }
    if (
      input.unitCostMinor !== undefined &&
      input.unitCostMinor !== null &&
      (!Number.isInteger(input.unitCostMinor) || input.unitCostMinor < 0)
    ) {
      return { ok: false, err: err('invalid_input', { field: 'unitCostMinor' }) };
    }
  }
  const effectiveDate = (input.effectiveDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    return { ok: false, err: err('invalid_input', { field: 'effectiveDate' }) };
  }
  return {
    ok: true,
    value: {
      qty,
      movementType,
      unitCostMinor: input.unitCostMinor ?? null,
      costAmountMinor: costOnly ? (input.costAmountMinor as number) : null,
      refMovementId: costOnly ? (input.refMovementId as string) : null,
      effectiveDate,
      lotId: costOnly ? null : input.lotId ?? null,
      serialId: costOnly ? null : serialId,
      key: input.idempotencyKey,
    },
  };
}

// --- inventoryTransfer: the atomic pair --------------------------------------------------------

export interface InventoryTransferInput {
  itemId?: string;
  fromLocationId?: string;
  toLocationId?: string;
  qty?: number;
  unitCostMinor?: number | null;
  effectiveDate?: string;
  lotId?: string | null;
  serialId?: string | null;
  sourceDocumentType?: string | null;
  sourceDocumentId?: string | null;
  description?: string | null;
  idempotencyKey?: string;
}

/**
 * Move stock between two locations as an ATOMIC pair (spec §2 US-J02.2): a `transfer_out` at the
 * source and a `transfer_in` at the destination, both under one `transfer_group_id`, equal absolute
 * quantity, summing to zero (invariant 7). Either both legs land or neither does: the two INSERTs run
 * in one `ctx.store.tx`, and a lost idempotency race on either leg throws and rolls the whole thing
 * back. `qty` is always positive; the helper applies the sign.
 */
export function inventoryTransfer(ctx: WorkspaceContext, input: InventoryTransferInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;

  if (typeof input.itemId !== 'string' || input.itemId.length === 0) return err('invalid_input', { field: 'itemId' });
  if (typeof input.fromLocationId !== 'string' || input.fromLocationId.length === 0) {
    return err('invalid_input', { field: 'fromLocationId' });
  }
  if (typeof input.toLocationId !== 'string' || input.toLocationId.length === 0) {
    return err('invalid_input', { field: 'toLocationId' });
  }
  if (input.fromLocationId === input.toLocationId) {
    return err('invalid_input', { field: 'toLocationId', reason: 'same_location' });
  }
  if (typeof input.qty !== 'number' || !Number.isInteger(input.qty) || input.qty <= 0) {
    return err('invalid_qty', { qty: input.qty });
  }
  const magnitude = input.qty;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (
    input.unitCostMinor !== undefined &&
    input.unitCostMinor !== null &&
    (!Number.isInteger(input.unitCostMinor) || input.unitCostMinor < 0)
  ) {
    return err('invalid_input', { field: 'unitCostMinor' });
  }
  const effectiveDate = (input.effectiveDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return err('invalid_input', { field: 'effectiveDate' });

  const serialId = input.serialId ?? null;
  if (serialId !== null && magnitude !== 1) return err('invalid_qty', { qty: magnitude, reason: 'serial_is_unit_of_one' });

  const item = readItem(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });
  if (item.track_stock !== 1) return err('item_not_stockable', { itemId: item.id });

  const from = readLocation(ctx, input.fromLocationId);
  if (from === undefined) return err('not_found', { locationId: input.fromLocationId });
  const to = readLocation(ctx, input.toLocationId);
  if (to === undefined) return err('not_found', { locationId: input.toLocationId });

  const lotId = input.lotId ?? null;
  const trackingErr = validateTracking(ctx, item, lotId, serialId);
  if (trackingErr !== undefined) return trackingErr;

  const outKey = input.idempotencyKey;
  const inKey = `${input.idempotencyKey}#in`;

  // §H-IDEMPOTENT fast path: a replay returns the original pair, never a second one.
  const replayOut = movementByKey(ctx, outKey);
  if (replayOut !== undefined && replayOut.transferGroupId !== null) {
    return ok(transferResult(ctx, movementsByTransferGroup(ctx, replayOut.transferGroupId)));
  }

  const groupId = ctx.ids.next('xfer');
  const shared = {
    itemId: item.id,
    lotId,
    serialId,
    unitCostMinor: input.unitCostMinor ?? null,
    // A transfer moves quantity, never a cost lump: both legs carry these null (the cost follows the
    // goods through the FIFO layers, see valuation.ts).
    costAmountMinor: null,
    refMovementId: null,
    effectiveDate,
    sourceDocumentType: input.sourceDocumentType ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    transferGroupId: groupId,
    description: input.description ?? null,
  };

  try {
    return ctx.store.tx(() => {
      const raced = movementByKey(ctx, outKey);
      if (raced !== undefined && raced.transferGroupId !== null) {
        return ok(transferResult(ctx, movementsByTransferGroup(ctx, raced.transferGroupId)));
      }
      // Negative-stock guard on the SOURCE leg first, before any write (the trap).
      if (!allowNegativeStock(ctx)) {
        const available = balanceFor(ctx, { itemId: item.id, locationId: from.id, lotId, serialId });
        if (available - magnitude < 0) {
          return err('insufficient_stock', { itemId: item.id, locationId: from.id, lotId, serialId, available, requested: -magnitude });
        }
      }
      const out = insertMovement(ctx, {
        ...shared,
        locationId: from.id,
        qty: -magnitude,
        movementType: 'transfer_out',
        idempotencyKey: outKey,
      });
      const into = insertMovement(ctx, {
        ...shared,
        locationId: to.id,
        qty: magnitude,
        movementType: 'transfer_in',
        idempotencyKey: inKey,
      });
      return ok(transferResult(ctx, [out, into]));
    });
  } catch (e) {
    const winner = movementByKey(ctx, outKey);
    if (winner !== undefined && winner.transferGroupId !== null) {
      return ok(transferResult(ctx, movementsByTransferGroup(ctx, winner.transferGroupId)));
    }
    throw e;
  }
}

function transferResult(ctx: WorkspaceContext, pair: InventoryMovement[]): Record<string, unknown> {
  const out = pair.find((m) => m.qty < 0) ?? pair[0];
  const into = pair.find((m) => m.qty > 0) ?? pair[1];
  return {
    out,
    in: into,
    transferGroupId: out?.transferGroupId ?? null,
    fromOnHand:
      out === undefined
        ? 0
        : balanceFor(ctx, { itemId: out.itemId, locationId: out.locationId, lotId: null, serialId: null }),
    toOnHand:
      into === undefined
        ? 0
        : balanceFor(ctx, { itemId: into.itemId, locationId: into.locationId, lotId: null, serialId: null }),
  };
}

// --- pure read models --------------------------------------------------------------------------

export interface InventoryBalanceInput {
  itemId?: string;
  locationId?: string;
  lotId?: string;
  serialId?: string;
  asOf?: string;
}

/** On-hand as the pure SUM of matching movements (invariant b). Never a stored column. */
export function inventoryBalance(ctx: WorkspaceContext, input: InventoryBalanceInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['m.workspace_id = ?'];
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
  if (typeof input.serialId === 'string' && input.serialId.length > 0) {
    clauses.push('m.serial_id = ?');
    params.push(input.serialId);
  }
  const asOf = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf.slice(0, 10) : undefined;
  if (asOf !== undefined) {
    clauses.push('m.moved_at <= ?');
    params.push(asOf);
  }

  const total = ctx.store.db
    .prepare(`SELECT COALESCE(SUM(m.qty), 0) AS qty FROM stock_movement m WHERE ${clauses.join(' AND ')}`)
    .get(...params) as { qty: number };

  // The per item x location breakdown, so a caller filtering by item alone still gets a location map.
  const breakdown = ctx.store.db
    .prepare(
      `SELECT m.item_id AS itemId, i.name AS itemName, m.location_id AS locationId, l.name AS locationName,
              COALESCE(SUM(m.qty), 0) AS qty
         FROM stock_movement m
         JOIN item i ON i.id = m.item_id
         JOIN stock_location l ON l.id = m.location_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY m.item_id, m.location_id
       HAVING COALESCE(SUM(m.qty), 0) != 0
        ORDER BY i.name, l.name`,
    )
    .all(...params) as { itemId: string; itemName: string; locationId: string; locationName: string; qty: number }[];

  return ok({ qtyOnHand: total.qty, asOf: asOf ?? null, rows: breakdown });
}

export interface InventoryMovementListInput {
  itemId?: string;
  locationId?: string;
  lotId?: string;
  serialId?: string;
  movementType?: string[];
  fromDate?: string;
  toDate?: string;
  sourceDocumentType?: string;
  sourceDocumentId?: string;
  transferGroupId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The chronological movement history (spec §2 US-J02.3). Filterable, paginated, and when a single
 * item is in the filter it carries a server-computed running balance (oldest to newest) so the
 * Movements tab does not have to re-derive it. History is never purged.
 */
export function inventoryMovementList(ctx: WorkspaceContext, input: InventoryMovementListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  const eq = (col: string, v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) {
      clauses.push(`${col} = ?`);
      params.push(v);
    }
  };
  eq('item_id', input.itemId);
  eq('location_id', input.locationId);
  eq('lot_id', input.lotId);
  eq('serial_id', input.serialId);
  eq('ref_kind', input.sourceDocumentType);
  eq('ref_id', input.sourceDocumentId);
  eq('transfer_group_id', input.transferGroupId);
  if (Array.isArray(input.movementType) && input.movementType.length > 0) {
    const valid = input.movementType.filter((t): t is MovementType => isMovementType(t));
    if (valid.length > 0) {
      clauses.push(`COALESCE(movement_type, reason) IN (${valid.map(() => '?').join(', ')})`);
      params.push(...valid);
    }
  }
  if (typeof input.fromDate === 'string' && input.fromDate.length > 0) {
    clauses.push('moved_at >= ?');
    params.push(input.fromDate.slice(0, 10));
  }
  if (typeof input.toDate === 'string' && input.toDate.length > 0) {
    clauses.push('moved_at <= ?');
    params.push(input.toDate.slice(0, 10));
  }
  const where = clauses.join(' AND ');

  const total = (
    ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM stock_movement WHERE ${where}`).get(...params) as { n: number }
  ).n;

  const limit = Number.isInteger(input.limit) && (input.limit as number) > 0 ? Math.min(input.limit as number, 500) : 100;
  const offset = Number.isInteger(input.offset) && (input.offset as number) > 0 ? (input.offset as number) : 0;

  const rows = ctx.store.db
    .prepare(
      `SELECT ${MOVEMENT_COLUMNS} FROM stock_movement WHERE ${where}
        ORDER BY moved_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as MovementDbRow[];
  const items = rows.map(mapMovement);

  // A running balance only makes sense for a single item's timeline (optionally one location), so it
  // is computed only then. It runs oldest to newest over the FULL filtered set, so page 2 is correct.
  let withRunning: (InventoryMovement & { runningBalance?: number })[] = items;
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    const asc = ctx.store.db
      .prepare(`SELECT id, qty FROM stock_movement WHERE ${where} ORDER BY moved_at ASC, created_at ASC, id ASC`)
      .all(...params) as { id: string; qty: number }[];
    const running = new Map<string, number>();
    let acc = 0;
    for (const r of asc) {
      acc += r.qty;
      running.set(r.id, acc);
    }
    withRunning = items.map((m) => ({ ...m, runningBalance: running.get(m.id) ?? 0 }));
  }

  return ok({ items: withRunning, total, limit, offset });
}

export function inventoryMovementGet(ctx: WorkspaceContext, input: { movementId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  if (typeof input.movementId !== 'string' || input.movementId.length === 0) {
    return err('invalid_input', { field: 'movementId' });
  }
  const row = ctx.store.db
    .prepare(`SELECT ${MOVEMENT_COLUMNS} FROM stock_movement WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, input.movementId) as MovementDbRow | undefined;
  if (row === undefined) return err('not_found', { movementId: input.movementId });
  return ok({ movement: mapMovement(row) });
}

// --- negative-stock policy config --------------------------------------------------------------

export function inventoryGetConfig(ctx: WorkspaceContext): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  return ok({ allowNegativeStock: allowNegativeStock(ctx) });
}

export interface SetConfigInput {
  allowNegativeStock?: boolean;
  idempotencyKey?: string;
}

/**
 * Set the workspace negative-stock posture (spec §4). Plain policy: posts no journal entry. History
 * is never rewritten, so flipping the flag changes only future writes, never a movement already made.
 */
export function inventorySetConfig(ctx: WorkspaceContext, input: SetConfigInput): Result {
  const capable = ctx.capabilities.assert('manage_master_data');
  if (!capable.ok) return capable;
  if (typeof input.allowNegativeStock !== 'boolean') return err('invalid_input', { field: 'allowNegativeStock' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const value = input.allowNegativeStock ? 1 : 0;
  const now = ctx.clock.now();
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'inventory_set_config', () => {
    ctx.store.db
      .prepare(
        `INSERT INTO inventory_config (workspace_id, allow_negative_stock, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET allow_negative_stock = excluded.allow_negative_stock,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(ctx.workspaceId, value, now, ctx.actor);
    return ok({ allowNegativeStock: value === 1 });
  });
}
