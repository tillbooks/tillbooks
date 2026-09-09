/**
 * J03, the valuation POLICY layer: the half of the capability that touches a database. The pure
 * calculators live in `valuation.ts` and never see a `ctx`; everything here builds the snapshots they
 * eat, resolves which method applies on a given date, and records a method change.
 *
 * THE MONEY-PATH INVARIANTS THIS FILE HOLDS (spec §7, asserted in `test/inventory/valuation*.test.mjs`):
 *  (a) APPEND-ONLY: a method assignment is insert-only; the DB triggers in `valuationSchema.ts` abort
 *      any UPDATE or DELETE. This file only ever INSERTs. A correction is another assignment.
 *  (b) IDEMPOTENT ON ROWS (§H-IDEMPOTENT): a replayed idempotency_key writes exactly ONE row and
 *      returns the original; the unique (workspace, key) index is the race guard under the pre-check.
 *  (c) §H-PERIOD: a method change is refused when the period it TAKES EFFECT IN is locked, whatever
 *      the call date is. Checked before any write, so a refusal leaves nothing behind. Without this
 *      a hard-sealed year stays back-restatable by picking an old effective date, which is exactly
 *      the shape of bug a sibling capability shipped once.
 *  (d) §H-TENANT: every read and write scopes by workspace_id, and an item is resolved through a
 *      workspace-scoped lookup, so a foreign id is not_found rather than a leak.
 *  (e) STETIGKEIT (OR 958c): resolution at an as-of date returns the assignment that was in force
 *      THEN. A policy change recorded today does not move a figure that was filed last year.
 *
 * J03 POSTS NOTHING. There is no `postEntry` call in this file and there is not meant to be: the
 * valuation figure reaches the books through J06, which takes these numbers to A02. That is why none
 * of the three writes gates on `post`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import {
  BUILTIN_DEFAULT_METHOD,
  DEFAULT_ENABLED_METHODS,
  VALUATION_METHODS,
  calculateItemValue,
  calculateItemByLocation,
  calculateValuationBatch,
  buildLayersByLocation,
  capLayersToQty,
  landedForLayers,
  normaliseMethod,
  requiresStandardCost,
} from './valuation.js';
import type { ItemSnapshot, MovementLine, ValuationMethod, ValuationResult } from './valuation.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Far enough forward that an omitted `asOf` means "everything recorded so far". */
const OPEN_ENDED = '9999-12-31';

// --- enablement ---------------------------------------------------------------------------------

interface ConfigRow {
  enabled_methods: string;
}

/**
 * The methods this workspace may choose. Absent config means the built-in default (weighted_average
 * and fifo on, standard_cost off). A stored list is filtered through the §H-ENUM on the way out, so a
 * key that stopped existing cannot resurrect itself from an old row.
 */
export function enabledMethods(ctx: WorkspaceContext): ValuationMethod[] {
  const row = ctx.store.db
    .prepare('SELECT enabled_methods FROM inventory_valuation_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as ConfigRow | undefined;
  if (row === undefined) return [...DEFAULT_ENABLED_METHODS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.enabled_methods);
  } catch {
    return [...DEFAULT_ENABLED_METHODS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_ENABLED_METHODS];
  const out: ValuationMethod[] = [];
  for (const key of parsed) {
    const method = normaliseMethod(key);
    if (method !== undefined && !out.includes(method)) out.push(method);
  }
  return out;
}

// --- the dated assignment -----------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  scope: string;
  item_id: string | null;
  method: string;
  standard_cost_minor: number | null;
  effective_from: string;
  reason: string | null;
  force_revaluation: number;
  created_at: string;
  created_by: string | null;
}

const ASSIGNMENT_COLUMNS = `id, scope, item_id, method, standard_cost_minor, effective_from, reason,
  force_revaluation, created_at, created_by`;

/**
 * The assignment in force on `asOf` for one scope. Ordered by `(effective_from, created_at, id)`
 * DESC, so two changes recorded for the same effective date resolve to the one recorded LAST, which
 * is the correction the operator meant (the earlier row stays in the history, being append-only).
 */
function assignmentAt(
  ctx: WorkspaceContext,
  scope: 'workspace' | 'item',
  itemId: string | null,
  asOf: string,
): AssignmentRow | undefined {
  const clause = scope === 'item' ? 'item_id = ?' : 'item_id IS NULL';
  const params: unknown[] = scope === 'item' ? [ctx.workspaceId, scope, itemId, asOf] : [ctx.workspaceId, scope, asOf];
  return ctx.store.db
    .prepare(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM inventory_valuation_method
        WHERE workspace_id = ? AND scope = ? AND ${clause} AND effective_from <= ?
        ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(...params) as AssignmentRow | undefined;
}

export interface ResolvedMethod {
  method: ValuationMethod;
  source: 'item' | 'workspace' | 'builtin';
  effectiveFrom: string | null;
  standardCostMinor: number | null;
  assignmentId: string | null;
}

/**
 * Which method values `itemId` at `asOf` (invariant e). Item override beats workspace default beats
 * the built-in, and each is the row that was in force ON THAT DATE, never the current one. A stored
 * key that is no longer in the §H-ENUM falls back rather than throwing: a value that cannot be
 * computed is worse than one computed by the documented default.
 */
export function resolveMethodAt(ctx: WorkspaceContext, itemId: string, asOf: string): ResolvedMethod {
  const item = assignmentAt(ctx, 'item', itemId, asOf);
  if (item !== undefined) {
    const method = normaliseMethod(item.method);
    if (method !== undefined) {
      return {
        method,
        source: 'item',
        effectiveFrom: item.effective_from,
        standardCostMinor: item.standard_cost_minor,
        assignmentId: item.id,
      };
    }
  }
  const ws = assignmentAt(ctx, 'workspace', null, asOf);
  if (ws !== undefined) {
    const method = normaliseMethod(ws.method);
    if (method !== undefined) {
      return { method, source: 'workspace', effectiveFrom: ws.effective_from, standardCostMinor: null, assignmentId: ws.id };
    }
  }
  return { method: BUILTIN_DEFAULT_METHOD, source: 'builtin', effectiveFrom: null, standardCostMinor: null, assignmentId: null };
}

// --- the snapshot builder over J02's ledger -----------------------------------------------------

interface ItemRow {
  id: string;
  name: string;
}

interface MovementDbRow {
  id: string;
  qty: number;
  unit_cost_minor: number | null;
  cost_amount_minor: number | null;
  ref_movement_id: string | null;
  moved_at: string;
  movement_type: string | null;
  reason: string;
  location_id: string;
  transfer_group_id: string | null;
  idempotency_key: string;
}

/** §H-TENANT: the ONE item lookup, workspace-scoped, so a foreign id is simply absent. */
function readItem(ctx: WorkspaceContext, id: string): ItemRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, name FROM item WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ItemRow | undefined;
}

/**
 * The stockable items that actually have a movement at or before `asOf`. Valuing an item with no
 * ledger history would report a confident zero for something nobody has ever stocked.
 */
function itemsWithMovements(ctx: WorkspaceContext, asOf: string, locationId: string | null): ItemRow[] {
  const clauses = ['i.workspace_id = ?', 'm.workspace_id = ?', 'm.moved_at <= ?'];
  const params: unknown[] = [ctx.workspaceId, ctx.workspaceId, asOf];
  if (locationId !== null) {
    clauses.push('m.location_id = ?');
    params.push(locationId);
  }
  return ctx.store.db
    .prepare(
      `SELECT DISTINCT i.id AS id, i.name AS name
         FROM item i JOIN stock_movement m ON m.item_id = i.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY i.name, i.id`,
    )
    .all(...params) as ItemRow[];
}

const TRANSFER_REASONS: ReadonlySet<string> = new Set(['transfer', 'transfer_in', 'transfer_out']);

/**
 * J02's own type vocabulary, applied to a row that may predate it. `movement_type` is NULL on every
 * row D01 wrote, and D01 spelled both legs of a transfer `transfer`, so the direction comes from the
 * sign, exactly as `movement.ts` `mapMovement` does it. Getting this wrong would leave a legacy
 * transfer looking like an ordinary issue, which is the defect this whole change exists to remove.
 */
function movementTypeOf(r: MovementDbRow): string {
  if (r.movement_type !== null && r.movement_type.length > 0) return r.movement_type;
  if (r.reason === 'transfer') return r.qty >= 0 ? 'transfer_in' : 'transfer_out';
  if (r.reason === 'adjust') return 'adjustment';
  return r.reason;
}

/**
 * What binds the two legs of a transfer. J02 writes a real `transfer_group_id`; D01's older pairs
 * have none, so this falls back to the idempotency-key convention BOTH verbs share (the out leg
 * carries `X`, the in leg `X#in`), which pairs a legacy transfer just as deterministically. A row
 * that is not a transfer leg gets null and is never paired with anything.
 */
function transferGroupOf(r: MovementDbRow, type: string): string | null {
  if (!TRANSFER_REASONS.has(type)) return null;
  if (r.transfer_group_id !== null && r.transfer_group_id.length > 0) return r.transfer_group_id;
  // The `#in` strip is a LEGACY fallback and is applied only to rows that predate J02, which are
  // exactly the rows with a NULL `movement_type`. Every J02 transfer carries a real group id and
  // reaches this line never. Narrowing it matters because a D01-era key that itself ended in `#in`
  // would otherwise be stripped and pair the wrong two legs, and a mis-pair puts the original
  // cost-destruction defect straight back with only a `unpaired_transfer_leg` warning to show for it.
  if (r.movement_type !== null && r.movement_type.length > 0) return r.idempotency_key;
  return r.idempotency_key.endsWith('#in') ? r.idempotency_key.slice(0, -3) : r.idempotency_key;
}

/**
 * One item's movement stream up to `asOf`, oldest first (§H-TENANT on every column of the filter).
 * The ORDER BY is `(moved_at, created_at, id)`: FIFO consumption depends on the order, so it has to
 * be total and stable rather than merely by date, or two receipts on one day could swap between two
 * runs and change the layer costs.
 *
 * THE STREAM IS NEVER FILTERED BY LOCATION IN SQL, and that is a deliberate reversal. It used to be,
 * and the cost of it was that valuing one location could not see the other end of a transfer: a
 * `transfer_in` carries no cost of its own, and the only record of what those units cost is the
 * layers its partner gave up somewhere else. The whole item's stream comes back and the calculator
 * decides which location to REPORT.
 */
function movementsFor(ctx: WorkspaceContext, itemId: string, asOf: string): MovementLine[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, qty, unit_cost_minor, cost_amount_minor, ref_movement_id, moved_at, movement_type,
              reason, location_id, transfer_group_id, idempotency_key
         FROM stock_movement WHERE workspace_id = ? AND item_id = ? AND moved_at <= ?
        ORDER BY moved_at ASC, created_at ASC, id ASC`,
    )
    .all(ctx.workspaceId, itemId, asOf) as MovementDbRow[];
  return rows.map((r) => {
    const movementType = movementTypeOf(r);
    return {
      id: r.id,
      movedAt: r.moved_at,
      qty: r.qty,
      unitCostMinor: r.unit_cost_minor,
      costAmountMinor: r.cost_amount_minor,
      refMovementId: r.ref_movement_id,
      movementType,
      locationId: r.location_id,
      transferGroupId: transferGroupOf(r, movementType),
    };
  });
}

/** The locations an item has ever moved through, for the per-location breakdown (F3). */
function locationsFor(ctx: WorkspaceContext, itemId: string, asOf: string): { id: string; name: string }[] {
  return ctx.store.db
    .prepare(
      `SELECT DISTINCT l.id AS id, l.name AS name
         FROM stock_movement m JOIN stock_location l ON l.id = m.location_id
        WHERE m.workspace_id = ? AND m.item_id = ? AND m.moved_at <= ?
        ORDER BY l.name, l.id`,
    )
    .all(ctx.workspaceId, itemId, asOf) as { id: string; name: string }[];
}

/**
 * Build the snapshot the pure calculators eat, with the method resolved as of the same date. The
 * stream is the whole item's; `locationId` narrows what gets REPORTED, not what gets read.
 */
function snapshotFor(
  ctx: WorkspaceContext,
  item: ItemRow,
  asOf: string,
  locationId: string | null,
  methodOverride: ValuationMethod | undefined,
  movements?: MovementLine[],
): { snapshot: ItemSnapshot; resolved: ResolvedMethod } {
  const resolved = resolveMethodAt(ctx, item.id, asOf);
  const method = methodOverride ?? resolved.method;
  return {
    snapshot: {
      itemId: item.id,
      itemName: item.name,
      method,
      standardCostMinor: resolved.standardCostMinor,
      movements: movements ?? movementsFor(ctx, item.id, asOf),
      locationId,
    },
    resolved,
  };
}

// --- the four reads -----------------------------------------------------------------------------

export interface ValuationMethodsResult {
  methods: {
    method: ValuationMethod;
    enabled: boolean;
    requiresStandardCost: boolean;
    isDefault: boolean;
  }[];
  defaultMethod: ValuationMethod;
  defaultSource: 'workspace' | 'builtin';
  defaultEffectiveFrom: string | null;
}

/** The registry read (US-J03.3, US-J03.5): what may be chosen, and what is in force today. */
export function inventoryValuationMethods(ctx: WorkspaceContext): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const enabled = enabledMethods(ctx);
  const today = ctx.clock.now().slice(0, 10);
  const ws = assignmentAt(ctx, 'workspace', null, today);
  const defaultMethod = (ws === undefined ? undefined : normaliseMethod(ws.method)) ?? BUILTIN_DEFAULT_METHOD;

  return ok({
    methods: VALUATION_METHODS.map((method) => ({
      method,
      enabled: enabled.includes(method),
      requiresStandardCost: requiresStandardCost(method),
      isDefault: method === defaultMethod,
    })),
    defaultMethod,
    defaultSource: ws === undefined ? 'builtin' : 'workspace',
    defaultEffectiveFrom: ws?.effective_from ?? null,
  });
}

export interface PreviewInput {
  asOf?: string;
  itemIds?: string[];
  methodOverride?: string;
  /** Per item id, the OR 960c net realisable value per unit (Veräusserungswert less costs to come). */
  netRealisableValues?: Record<string, number>;
  valueByLocation?: boolean;
  locationId?: string;
}

/**
 * The pure preview (US-J03.4). Writes NOTHING: no journal, no run row, no cached figure. Every number
 * it returns is derived from the J02 ledger on the spot, which is what lets an agent project a
 * what-if under an alternate method (US-J03.6) without touching the item's stored policy.
 */
export function inventoryValuationPreview(ctx: WorkspaceContext, input: PreviewInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const asOf = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf.slice(0, 10) : OPEN_ENDED;
  if (asOf !== OPEN_ENDED && !DATE_RE.test(asOf)) return err('invalid_input', { field: 'asOf' });

  let methodOverride: ValuationMethod | undefined;
  if (input.methodOverride !== undefined) {
    const normalised = normaliseMethod(input.methodOverride);
    if (normalised === undefined) return err('unknown_method', { method: input.methodOverride, allowed: [...VALUATION_METHODS] });
    // A disabled method is refused even for a what-if: a number nobody may adopt is a number that
    // gets quoted anyway (US-J03.3).
    if (!enabledMethods(ctx).includes(normalised)) return err('method_disabled', { method: normalised });
    methodOverride = normalised;
  }

  // THE THREE LOCATION MODES, each of which now does something (F3). `locationId` used to be dropped
  // unless `valueByLocation` was ALSO true, and `valueByLocation` on its own returned the company-wide
  // figure, so both fields were decoration on most calls.
  //   locationId alone      -> value that one location.
  //   valueByLocation alone -> one row per (item, location), each valued independently.
  //   both                  -> the breakdown, narrowed to that location.
  const onlyLocation = typeof input.locationId === 'string' && input.locationId.length > 0 ? input.locationId : null;
  const breakdown = input.valueByLocation === true;
  if (onlyLocation !== null) {
    const known = ctx.store.db
      .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, onlyLocation) as { id: string } | undefined;
    // §H-TENANT: a foreign location is invisible, so it is not_found rather than an empty valuation
    // that would read as "this location holds nothing".
    if (known === undefined) return err('not_found', { locationId: onlyLocation });
  }

  let items: ItemRow[];
  if (Array.isArray(input.itemIds) && input.itemIds.length > 0) {
    items = [];
    for (const raw of input.itemIds) {
      if (typeof raw !== 'string' || raw.length === 0) return err('invalid_input', { field: 'itemIds' });
      // §H-TENANT: resolved through the workspace-scoped lookup, so a foreign id is not_found and no
      // calculation runs on it (US-J03.7).
      const item = readItem(ctx, raw);
      if (item === undefined) return err('not_found', { itemId: raw });
      items.push(item);
    }
  } else {
    items = itemsWithMovements(ctx, asOf, onlyLocation);
  }

  const nrvMap = input.netRealisableValues ?? {};
  const rows: (ValuationResult & { methodSource: string; methodEffectiveFrom: string | null; locationName: string | null })[] = [];
  let totalValueMinor = 0;
  let totalWriteDownMinor = 0;
  for (const item of items) {
    // Read the stream ONCE per item, whatever the mode: the per-location rows are the same stream
    // reported through different windows, so a breakdown cannot disagree with the total it sums to.
    const movements = movementsFor(ctx, item.id, asOf);
    const { snapshot, resolved } = snapshotFor(ctx, item, asOf, null, methodOverride, movements);
    const nrv = nrvMap[item.id];
    const valuationContext = { asOf, netRealisableValueMinor: typeof nrv === 'number' ? nrv : null };
    const decorate = (r: ValuationResult, locationName: string | null): void => {
      totalValueMinor += r.totalValueMinor;
      totalWriteDownMinor += r.writeDownMinor;
      rows.push({
        ...r,
        methodSource: methodOverride === undefined ? resolved.source : 'override',
        methodEffectiveFrom: resolved.effectiveFrom,
        locationName,
      });
    };

    if (!breakdown && onlyLocation === null) {
      decorate(calculateItemValue(snapshot, valuationContext), null);
      continue;
    }

    // EVERY location-scoped read goes through the same allocation, including a single-location one.
    // Under weighted average a location's figure is a share of the item's pooled total, and a share
    // is only well defined against the whole set, so computing one location on its own would give a
    // different answer from the same location inside a breakdown. Same door, same number.
    const known = locationsFor(ctx, item.id, asOf);
    const scopes =
      onlyLocation !== null && !known.some((l) => l.id === onlyLocation)
        ? [...known, { id: onlyLocation, name: null as string | null }]
        : known;
    const valued = calculateItemByLocation(
      snapshot,
      valuationContext,
      scopes.map((l) => l.id),
    );
    valued.forEach((r, i) => {
      const scope = scopes[i] as { id: string; name: string | null };
      if (onlyLocation !== null && scope.id !== onlyLocation) return;
      decorate(r, scope.name);
    });
  }

  return ok({
    asOf: asOf === OPEN_ENDED ? null : asOf,
    locationId: onlyLocation,
    valueByLocation: breakdown,
    items: rows,
    totalValueMinor,
    totalWriteDownMinor,
  });
}

export interface LayersInput {
  itemId?: string;
  asOf?: string;
  locationId?: string;
}

/** FIFO layer inspection (US-J03.6): what is left, oldest first, and where each remainder came from. */
export function inventoryValuationLayers(ctx: WorkspaceContext, input: LayersInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) return err('invalid_input', { field: 'itemId' });

  const asOf = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf.slice(0, 10) : OPEN_ENDED;
  if (asOf !== OPEN_ENDED && !DATE_RE.test(asOf)) return err('invalid_input', { field: 'asOf' });

  const item = readItem(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });

  const locationId = typeof input.locationId === 'string' && input.locationId.length > 0 ? input.locationId : null;
  // §H-TENANT and the same rule `preview` follows: an unknown or foreign location is not_found, never
  // an empty layer list. This verb used to answer `ok:true, layers: [], totalValueMinor: 0` for a
  // location that does not exist here, which reads as "that store holds nothing" rather than "there
  // is no such store", and the two are very different sentences to put in front of a bookkeeper.
  // Applying the rule to one of the two location-taking verbs and not the other was the gap.
  if (locationId !== null) {
    const known = ctx.store.db
      .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, locationId) as { id: string } | undefined;
    if (known === undefined) return err('not_found', { locationId });
  }
  // The WHOLE item's stream, then the location's queue out of it. Reading only one location's rows
  // would hide the far end of every transfer, and the layers a transfer carried would vanish.
  const movements = movementsFor(ctx, item.id, asOf);
  const built = buildLayersByLocation(movements);
  const rawLayers = locationId === null ? built.merged : (built.byLocation.get(locationId) ?? []);
  // CAP TO ON-HAND, the same discipline `preview` uses, so this verb never reports more units than
  // the ledger holds. The builder already caps each location's queue, so for a location scope this is
  // a no-op; for the item scope it applies the item-net cap the merged queue can still need when a
  // location is net negative. Explicit here rather than assumed, so this verb is correct on its own
  // reading and not only because a shared helper happens to have capped first.
  const scopeOnHand = movements.reduce(
    (s, m) => (locationId === null || m.locationId === locationId ? s + m.qty : s),
    0,
  );
  const layers = capLayersToQty(rawLayers, scopeOnHand);
  const resolved = resolveMethodAt(ctx, item.id, asOf);

  let totalValueMinor = 0n;
  for (const l of layers) totalValueMinor += BigInt(l.remainingQty) * BigInt(l.unitCostMinor);
  // I03: the landed cost still carried by these layers, so this verb's roll-up matches the FIFO
  // preview total for the same scope (both add the receipt's landed cost to its base layer value).
  const landed = landedForLayers(movements, layers);
  totalValueMinor += BigInt(landed);

  return ok({
    itemId: item.id,
    itemName: item.name,
    asOf: asOf === OPEN_ENDED ? null : asOf,
    locationId,
    method: resolved.method,
    layers,
    layerQty: layers.reduce((s, l) => s + l.remainingQty, 0),
    landedCostMinor: landed,
    totalValueMinor: Number(totalValueMinor),
    // A location answers for ITS OWN shortfall, exactly as `preview` does. This verb kept reporting
    // the item-wide figure after the preview side was fixed, so Lager B holding 100 fully costed
    // units said `shortfall: 20` because Lager A was short, while `preview` on the same location
    // correctly said nothing was wrong. The two halves of the same pair disagreed about one ledger.
    shortfall: locationId === null ? built.shortfall : (built.shortfallByLocation.get(locationId) ?? 0),
  });
}

export interface MethodHistoryInput {
  itemId?: string;
  scope?: string;
}

/**
 * The Stetigkeit trail (OR 958c). Without this verb the append-only assignment exists but nobody can
 * see it, and "demonstrable" would mean "we promise". Returns the rows in the order they take effect,
 * newest first, with the reason each change stated and the actor who made it.
 */
export function inventoryValuationMethodHistory(ctx: WorkspaceContext, input: MethodHistoryInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.scope === 'string' && input.scope.length > 0) {
    if (input.scope !== 'workspace' && input.scope !== 'item') return err('invalid_input', { field: 'scope' });
    clauses.push('scope = ?');
    params.push(input.scope);
  }
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    const item = readItem(ctx, input.itemId);
    if (item === undefined) return err('not_found', { itemId: input.itemId });
    clauses.push('item_id = ?');
    params.push(item.id);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM inventory_valuation_method WHERE ${clauses.join(' AND ')}
        ORDER BY effective_from DESC, created_at DESC, id DESC`,
    )
    .all(...params) as AssignmentRow[];

  return ok({
    assignments: rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      itemId: r.item_id,
      method: normaliseMethod(r.method) ?? r.method,
      standardCostMinor: r.standard_cost_minor,
      effectiveFrom: r.effective_from,
      reason: r.reason,
      forceRevaluation: r.force_revaluation === 1,
      createdAt: r.created_at,
      createdBy: r.created_by,
    })),
    total: rows.length,
  });
}

// --- the three writes ---------------------------------------------------------------------------

export interface SetEnabledInput {
  method?: string;
  enabled?: boolean;
  idempotencyKey?: string;
}

/**
 * Turn a method on or off for the workspace. Absolute state-setting, so a replay re-asserts the same
 * list; the idempotency record is what makes that a row-level guarantee rather than a coincidence.
 *
 * Disabling the method that is currently the workspace default is refused: it would leave every
 * future valuation pointing at a method the workspace says it does not use, and the repair (change
 * the default first) is one call away.
 */
export function inventoryValuationMethodSetEnabled(ctx: WorkspaceContext, input: SetEnabledInput): Result {
  const capable = ctx.capabilities.assert('inventory.setup');
  if (!capable.ok) return capable;

  const method = normaliseMethod(input.method);
  if (method === undefined) return err('unknown_method', { method: input.method, allowed: [...VALUATION_METHODS] });
  if (typeof input.enabled !== 'boolean') return err('invalid_input', { field: 'enabled' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  const current = enabledMethods(ctx);
  if (!input.enabled) {
    const today = ctx.clock.now().slice(0, 10);
    const ws = assignmentAt(ctx, 'workspace', null, today);
    const defaultMethod = (ws === undefined ? undefined : normaliseMethod(ws.method)) ?? BUILTIN_DEFAULT_METHOD;
    if (method === defaultMethod) return err('method_is_default', { method });
  }

  const next = input.enabled
    ? current.includes(method)
      ? current
      : [...current, method]
    : current.filter((m) => m !== method);
  const now = ctx.clock.now();

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'inventory_valuation_method_set_enabled', () => {
    ctx.store.db
      .prepare(
        `INSERT INTO inventory_valuation_config (workspace_id, enabled_methods, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET enabled_methods = excluded.enabled_methods,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(ctx.workspaceId, JSON.stringify(next), now, ctx.actor);
    return ok({ method, enabled: input.enabled === true, enabledMethods: next });
  });
}

interface AssignmentDraft {
  scope: 'workspace' | 'item';
  itemId: string | null;
  method: ValuationMethod;
  standardCostMinor: number | null;
  effectiveFrom: string;
  reason: string | null;
  forceRevaluation: boolean;
  idempotencyKey: string;
}

function assignmentByKey(ctx: WorkspaceContext, key: string): AssignmentRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${ASSIGNMENT_COLUMNS} FROM inventory_valuation_method WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, key) as AssignmentRow | undefined;
}

function assignmentPayload(row: AssignmentRow): Record<string, unknown> {
  return {
    assignment: {
      id: row.id,
      scope: row.scope,
      itemId: row.item_id,
      method: normaliseMethod(row.method) ?? row.method,
      standardCostMinor: row.standard_cost_minor,
      effectiveFrom: row.effective_from,
      reason: row.reason,
      forceRevaluation: row.force_revaluation === 1,
      createdAt: row.created_at,
      createdBy: row.created_by,
    },
  };
}

/** The ONE INSERT (invariant a). Every guard has already run by the time this is called. */
function insertAssignment(ctx: WorkspaceContext, draft: AssignmentDraft): AssignmentRow {
  const id = ctx.ids.next('invval');
  ctx.store.db
    .prepare(
      `INSERT INTO inventory_valuation_method
         (id, workspace_id, scope, item_id, method, standard_cost_minor, effective_from, reason,
          force_revaluation, idempotency_key, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      draft.scope,
      draft.itemId,
      draft.method,
      draft.standardCostMinor,
      draft.effectiveFrom,
      draft.reason,
      draft.forceRevaluation ? 1 : 0,
      draft.idempotencyKey,
      ctx.clock.now(),
      ctx.actor,
    );
  return ctx.store.db
    .prepare(`SELECT ${ASSIGNMENT_COLUMNS} FROM inventory_valuation_method WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id) as AssignmentRow;
}

/**
 * Record an assignment (invariants a, b, c). Shared by both dated writes so the period guard, the
 * replay guard and the single INSERT cannot drift apart between them.
 *
 * ORDER MATTERS. The idempotency pre-check runs first (a replay must not be refused by a period that
 * closed since the original call: the row already exists and returning it changes nothing). Then the
 * §H-PERIOD check against `effectiveFrom`, before any write. Then the insert, inside a transaction
 * that re-checks the replay because the pre-check cannot see a concurrent winner.
 */
function recordAssignment(ctx: WorkspaceContext, draft: AssignmentDraft): Result {
  const replay = assignmentByKey(ctx, draft.idempotencyKey);
  if (replay !== undefined) return ok(assignmentPayload(replay));

  // §H-PERIOD against the date the change TAKES EFFECT, never the call date. A method change dated
  // into a closed year restates that year's inventory figure, so the lock that protects the year is
  // the one that has to answer, and it answers before anything is written.
  const periodOpen = ctx.periods.assertOpen(draft.effectiveFrom);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.tx(() => {
      const raced = assignmentByKey(ctx, draft.idempotencyKey);
      if (raced !== undefined) return ok(assignmentPayload(raced));
      return ok(assignmentPayload(insertAssignment(ctx, draft)));
    });
  } catch (e) {
    // A lost idempotency race trips the unique (workspace, key) index; replay the winner's row.
    const winner = assignmentByKey(ctx, draft.idempotencyKey);
    if (winner !== undefined) return ok(assignmentPayload(winner));
    throw e;
  }
}

export interface SetDefaultInput {
  method?: string;
  effectiveFrom?: string;
  forceRevaluation?: boolean;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Set the workspace default method from `effectiveFrom` on (US-J03.5). Appends; never overwrites.
 *
 * THE STETIGKEIT GUARD, SYMMETRIC WITH `setItemMethod` (owner decision, 2026-08-11). This verb used
 * to have no such guard and an optional reason, which made it the WIDER of the two doors: the item
 * override refused to restate a period that already had movements unless the caller said
 * `forceRevaluation` and why, while a back-dated DEFAULT silently restated every item in the
 * workspace with nothing in the history to say who did it or why. G01 automation is allowed to fire
 * both (the owner's answer to Q2 was to deny nothing), so an unattended rule could have done exactly
 * that at 03:00. It now cannot: the same force-plus-reason is required, and a blank or whitespace
 * reason is refused rather than stored as an empty string, so an unattended restatement always
 * arrives with a sentence attached.
 *
 * The count is over the whole workspace's ledger, because the workspace default reaches every item
 * that has no override of its own.
 */
export function inventoryValuationSetDefault(ctx: WorkspaceContext, input: SetDefaultInput): Result {
  const capable = ctx.capabilities.assert('inventory.setup');
  if (!capable.ok) return capable;

  const method = normaliseMethod(input.method);
  if (method === undefined) return err('unknown_method', { method: input.method, allowed: [...VALUATION_METHODS] });
  if (!enabledMethods(ctx).includes(method)) return err('method_disabled', { method });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const effectiveFrom = (input.effectiveFrom ?? '').slice(0, 10);
  if (!DATE_RE.test(effectiveFrom)) return err('invalid_input', { field: 'effectiveFrom' });

  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : null;
  const force = input.forceRevaluation === true;
  const affected = (
    ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ? AND moved_at >= ?')
      .get(ctx.workspaceId, effectiveFrom) as { n: number }
  ).n;
  if (affected > 0 && !(force && reason !== null)) {
    return err('method_change_blocked_open_period', {
      scope: 'workspace',
      effectiveFrom,
      affectedMovements: affected,
      needs: ['forceRevaluation', 'reason'],
    });
  }

  return recordAssignment(ctx, {
    scope: 'workspace',
    itemId: null,
    method,
    standardCostMinor: null,
    effectiveFrom,
    reason,
    forceRevaluation: force,
    idempotencyKey: input.idempotencyKey,
  });
}

export interface SetItemMethodInput {
  itemId?: string;
  method?: string;
  effectiveFrom?: string;
  standardCostMinor?: number;
  forceRevaluation?: boolean;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Override the method for one item from `effectiveFrom` on (US-J03.5).
 *
 * THE STETIGKEIT GUARD. When the item already carries movements dated on or after `effectiveFrom`,
 * those are exactly the movements whose valuation this change restates, so the write is refused with
 * `method_change_blocked_open_period` unless the caller states `forceRevaluation` AND a reason. The
 * reason is not decoration: it is the sentence the Treuhänder reads in the history when asked why a
 * figure moved, and a force with no reason is refused rather than recorded as an empty string.
 */
export function inventoryValuationSetItemMethod(ctx: WorkspaceContext, input: SetItemMethodInput): Result {
  const capable = ctx.capabilities.assert('inventory.setup');
  if (!capable.ok) return capable;

  if (typeof input.itemId !== 'string' || input.itemId.length === 0) return err('invalid_input', { field: 'itemId' });
  const method = normaliseMethod(input.method);
  if (method === undefined) return err('unknown_method', { method: input.method, allowed: [...VALUATION_METHODS] });
  if (!enabledMethods(ctx).includes(method)) return err('method_disabled', { method });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const effectiveFrom = (input.effectiveFrom ?? '').slice(0, 10);
  if (!DATE_RE.test(effectiveFrom)) return err('invalid_input', { field: 'effectiveFrom' });

  const standardCostMinor = input.standardCostMinor ?? null;
  if (standardCostMinor !== null && (!Number.isInteger(standardCostMinor) || standardCostMinor <= 0)) {
    return err('invalid_input', { field: 'standardCostMinor' });
  }
  if (requiresStandardCost(method) && standardCostMinor === null) {
    return err('missing_standard_cost', { itemId: input.itemId, method });
  }

  // §H-TENANT: a foreign item is invisible, so this is not_found rather than a cross-tenant write.
  const item = readItem(ctx, input.itemId);
  if (item === undefined) return err('not_found', { itemId: input.itemId });

  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : null;
  const force = input.forceRevaluation === true;
  const affected = (
    ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ? AND item_id = ? AND moved_at >= ?')
      .get(ctx.workspaceId, item.id, effectiveFrom) as { n: number }
  ).n;
  if (affected > 0 && !(force && reason !== null)) {
    return err('method_change_blocked_open_period', {
      itemId: item.id,
      effectiveFrom,
      affectedMovements: affected,
      needs: ['forceRevaluation', 'reason'],
    });
  }

  return recordAssignment(ctx, {
    scope: 'item',
    itemId: item.id,
    method,
    standardCostMinor,
    effectiveFrom,
    reason,
    forceRevaluation: force,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * I03 seam (read-only): the total book value of ONE item, in Rappen, via the SAME J03 path the
 * preview uses (method resolved as of today, the pure calculator, no LCM). It exists so
 * `landed_cost_allocate_confirm` can read an item's value BEFORE and AFTER it writes its cost
 * movements and debit inventory control by EXACTLY that delta: the capitalizable share is then, by
 * construction, whatever J03 will actually carry (the on-hand fraction for weighted-average and FIFO,
 * ZERO for standard cost), so the GL inventory move can never diverge from the sub-ledger (OP11).
 * Deriving the split from this shared path rather than re-deriving it is what stops the two drifting.
 *
 * Valued OPEN-ENDED on purpose: the confirm measures the delta of the movements it just wrote, and an
 * open-ended read on both sides isolates exactly that, whatever the movement's effective date. No NRV
 * is supplied, so no OR 960c write-down enters the capitalization figure (that clamp is J06's at
 * period end, not the acquisition-cost split's). A foreign or unknown item id is value 0 (§H-TENANT:
 * `readItem` is workspace-scoped). Asserts no capability of its own: the sole caller has already
 * asserted the `procurement.landed_cost` write capability.
 */
export function itemBookValueMinor(ctx: WorkspaceContext, itemId: string): number {
  const item = readItem(ctx, itemId);
  if (item === undefined) return 0;
  const { snapshot } = snapshotFor(ctx, item, OPEN_ENDED, null, undefined);
  return calculateItemValue(snapshot, { asOf: OPEN_ENDED, netRealisableValueMinor: null }).totalValueMinor;
}

/** Re-exported for J06, which values the same way the preview does or it values differently. */
export { calculateValuationBatch, calculateItemValue };
