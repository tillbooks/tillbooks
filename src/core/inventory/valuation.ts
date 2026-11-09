/**
 * J03, the PURE inventory valuation calculators (OP12). This file has no `ctx`, opens no database and
 * calls no clock: it takes a snapshot of J02 movements and returns the value of what is left. That is
 * the whole point of the split. The money arithmetic can be read, and refuted, without a store in
 * scope, and every §H-TENANT filter lives one file over in `valuationPolicy.ts`, which is the only
 * half that touches SQL.
 *
 * WHAT THIS PRODUCES IS A BALANCE-SHEET FIGURE. J03 never posts: J06 takes these numbers to A02. But
 * the number it takes is decided here, so the four rules below are load-bearing.
 *
 *  (1) NO FLOATING POINT, ANYWHERE. Every intermediate is an integer Rappen or an exact `bigint`
 *      ratio. `commercialRound` divides two bigints half-away-from-zero, so a quantity times a cost
 *      cannot silently lose precision above 2^53 the way `number` arithmetic would.
 *  (2) ROUNDING HAPPENS ONCE PER REPORTED FIGURE AND NEVER FEEDS ANOTHER. The weighted-average total
 *      is the EXACT cost pool scaled to the quantity, not `qty x roundedUnitCost`: rounding a unit
 *      cost by half a Rappen and then multiplying by 10'000 units is CHF 50 of drift in a filed
 *      figure. FIFO totals exactly by construction (a sum of layer qty x layer cost, no division at
 *      all), so exact-total is also the only way the two methods mean the same thing by "the value".
 *  (3) AN IMPOSSIBLE INPUT IS REFUSED, NOT COMPUTED. A negative unit cost, a negative on-hand, a
 *      missing standard cost: each returns a value of zero WITH a `reason`, never an arithmetic
 *      answer derived from corrupt input and never a silent clamp.
 *  (4) THE OR 960c CLAMP IS COMPULSORY. "Liegt ... der Veräusserungswert unter Berücksichtigung noch
 *      anfallender Kosten am Bilanzstichtag unter den Anschaffungs- oder Herstellungskosten, so muss
 *      dieser Wert eingesetzt werden." When a net realisable value is supplied and is below cost, it
 *      is used. There is no flag that turns that off. The write-down is surfaced, never posted.
 *
 * OR 960a Abs. 2's cost cap (a later valuation may not exceed acquisition cost) is STRUCTURAL here
 * rather than checked: no path below can return more than the cost pool, because the only inputs to a
 * value are movement unit costs, a standard cost the operator set, and a clamp that can only lower.
 */

/**
 * §H-ENUM, the valuation methods. The registry point: a localisation or industry pack adding a method
 * adds it here and nowhere else, and `test/style/studio-mirrors-engine-enums.test.mjs` holds the
 * Studio picker to this list.
 */
export const VALUATION_METHODS = ['weighted_average', 'fifo', 'standard_cost'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];
const METHOD_SET: ReadonlySet<string> = new Set(VALUATION_METHODS);

/** The methods a fresh workspace may choose. `standard_cost` is registered but off until asked for. */
export const DEFAULT_ENABLED_METHODS: readonly ValuationMethod[] = ['weighted_average', 'fifo'];

/** The method a workspace that has never recorded an assignment values at. */
export const BUILTIN_DEFAULT_METHOD: ValuationMethod = 'weighted_average';

/**
 * D01 wrote `weighted_avg` (OP2, `core/stock/enums.ts`). It is accepted as a READ-TIME alias so a
 * pre-J03 valuation run resolves, and it is never written: `normaliseMethod` is the only door in, so
 * there is no dual storage to keep in step.
 */
export function normaliseMethod(key: unknown): ValuationMethod | undefined {
  if (typeof key !== 'string') return undefined;
  if (key === 'weighted_avg') return 'weighted_average';
  return METHOD_SET.has(key) ? (key as ValuationMethod) : undefined;
}

export function isValuationMethod(x: unknown): x is ValuationMethod {
  return typeof x === 'string' && METHOD_SET.has(x);
}

/** Whether a method cannot be valued without a per-item standard cost. */
export function requiresStandardCost(method: ValuationMethod): boolean {
  return method === 'standard_cost';
}

// --- the shapes ---------------------------------------------------------------------------------

/** One J02 movement, reduced to what a valuation needs. `movedAt` is a DATE (`YYYY-MM-DD`). */
export interface MovementLine {
  id: string;
  movedAt: string;
  qty: number;
  unitCostMinor: number | null;
  /**
   * I03 cost-adjustment seam: the signed Rappen a `landed_cost` movement carries. Null on every
   * quantity-moving movement. Folded into the value (weighted-average pool, FIFO referenced layer,
   * standard-cost variance) WITHOUT changing quantity, see `tally` and `landedForLayers`.
   */
  costAmountMinor: number | null;
  /** I03: the receipt movement a `landed_cost` movement adjusts, so cost follows the goods. */
  refMovementId: string | null;
  movementType: string;
  locationId: string;
  /**
   * The id that binds the two legs of a transfer. J02 writes a real `transfer_group_id`; D01's older
   * pairs have none, so the policy layer synthesises one from the `X` / `X#in` idempotency-key
   * convention both verbs use. Null on everything that is not a transfer leg.
   */
  transferGroupId: string | null;
}

/**
 * One item's stream, filtered to `movedAt <= asOf` and sorted by `(movedAt, created_at, id)`.
 *
 * THE STREAM IS ALWAYS THE WHOLE ITEM'S, ACROSS EVERY LOCATION, even when only one location is being
 * valued. That is not an oversight: a `transfer_in` carries no cost of its own, and the only place its
 * cost basis exists is in the layers its paired `transfer_out` consumed at the OTHER end. Filter the
 * stream in SQL and that partner disappears, and with it the cost of everything that ever moved
 * between locations. `locationId` below says which location to REPORT, never which rows to read.
 */
export interface ItemSnapshot {
  itemId: string;
  itemName: string;
  method: ValuationMethod;
  standardCostMinor: number | null;
  movements: MovementLine[];
  /** Report this location only. Null (the default) reports the item across every location. */
  locationId?: string | null;
}

/** A FIFO cost layer: an inbound movement's unconsumed remainder. */
export interface CostLayer {
  sourceMovementId: string;
  receiptDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostMinor: number;
}

export interface ValuationContext {
  asOf: string;
  /** Per unit, OR 960c: the Veräusserungswert LESS the costs still to be incurred. */
  netRealisableValueMinor?: number | null;
}

export interface ValuationResult {
  itemId: string;
  itemName: string;
  asOf: string;
  method: ValuationMethod;
  /** The location reported, or null for the item across every location. */
  locationId: string | null;
  qtyOnHand: number;
  costedQty: number;
  uncostedQty: number;
  unitCostMinor: number | null;
  totalValueMinor: number;
  layers: CostLayer[];
  lcmApplied: boolean;
  writeDownMinor: number;
  varianceMinor: number | null;
  reason: string | null;
  warnings: string[];
  /**
   * The movements whose quantity arrived with no cost snapshot. Computing this and then dropping it
   * was the reason an operator could not see WHY a figure looked light: the bare `missing_unit_cost`
   * warning said that something was uncosted without saying what, which is exactly the diagnostic the
   * transfer defect needed. Empty unless `missing_unit_cost` is among the warnings.
   */
  missingCostMovementIds: string[];
  /**
   * How the location figure was arrived at, and it is not decoration (owner decision, 2026-08-11).
   *
   * `direct`  the figure was computed from this scope's own movements. Always the case at item level.
   *           For FIFO at a location it holds while the location rows really are additive, which they
   *           stop being when one location is net short or the item position has been written down;
   *           in either case the rows are reconciled by allocation and say so.
   * `allocated` the figure is this location's SHARE of the item's figure. Weighted average has ONE
   *           cost pool per item by definition, so a location cannot be valued on its own receipts
   *           without inventing a second pool: value each location on its own average and the rows
   *           stop summing to the item total, which would let a display toggle move the workspace
   *           inventory figure. A per-location weighted average is therefore a decomposition, never
   *           an independent valuation, and this field says so rather than leaving a reader to assume.
   */
  valuationBasis: 'direct' | 'allocated';
  explanation: string;
}

// --- exact money arithmetic ---------------------------------------------------------------------

/**
 * Divide two bigints and round HALF AWAY FROM ZERO (commercial rounding, P2). The
 * `roundHalfAwayFromZero` shape A06/A07/A14 already use, widened to bigint so `qty x cost` cannot
 * exceed what the arithmetic can represent: at `number` precision a 2'000'000-unit position at
 * CHF 50'000'000 a unit would start losing whole Rappen, and a silent loss of precision in a
 * balance-sheet figure is precisely what P2 exists to forbid.
 *
 * `Math.round` is NOT this function: it rounds half toward +Infinity, so it disagrees on every
 * negative half (`Math.round(-0.5)` is `-0`, commercial rounding gives `-1`). Valuation figures reach
 * zero from both sides (a write-down, a variance), so the difference is not academic.
 */
export function commercialRound(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) throw new Error('valuation: division by zero');
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  // (2*abs + d) / (2*d) is floor(abs/d + 1/2), which is half-UP on the magnitude, and applying the
  // sign afterwards makes it half-AWAY-FROM-ZERO.
  const rounded = (2n * abs + d) / (2n * d);
  const signed = negative ? -rounded : rounded;
  return Number(signed);
}

// --- FIFO layers --------------------------------------------------------------------------------

const TRANSFER_TYPES: ReadonlySet<string> = new Set(['transfer_in', 'transfer_out']);

/** A layer with its creation order, so the item-level view can merge the per-location queues. */
interface SeqLayer extends CostLayer {
  seq: number;
}

/** Take `demand` units off the front of a queue, returning what came off and what could not. */
function consume(queue: SeqLayer[], demand: number): { taken: SeqLayer[]; unmet: number } {
  const taken: SeqLayer[] = [];
  let left = demand;
  while (left > 0 && queue.length > 0) {
    const oldest = queue[0] as SeqLayer;
    const take = Math.min(oldest.remainingQty, left);
    oldest.remainingQty -= take;
    left -= take;
    taken.push({ ...oldest, originalQty: take, remainingQty: take });
    if (oldest.remainingQty === 0) queue.shift();
  }
  return { taken, unmet: left };
}

export interface LocationLayers {
  /** The remaining layers per location, oldest first within each. */
  byLocation: Map<string, CostLayer[]>;
  /** Every remaining layer across all locations, oldest first. The item-level view. */
  merged: CostLayer[];
  /** Outbound demand that outlived the layers, anywhere. */
  shortfall: number;
  /**
   * The same figure PER LOCATION. A location-scoped result must answer for its own shortfall and no
   * one else's: before this existed the item-wide number was applied to every location, so a store
   * holding 100 fully costed units reported `insufficient_layers` because a DIFFERENT store had gone
   * short, and an empty location said `insufficient_layers` where the truth was `zero_quantity`. The
   * value was right and the reason lied, which is the worse of the two failures to ship.
   */
  shortfallByLocation: Map<string, number>;
  /** Movement ids of transfer legs whose two halves were both present and handled as a pair. */
  pairedLegIds: Set<string>;
  /** For a paired `transfer_in`, what it inherited. Keyed by that leg's movement id. */
  inheritedByLeg: Map<string, CostLayer[]>;
  /** Transfer legs whose partner is missing from the stream, handled as ordinary movements. */
  orphanTransferLegIds: string[];
  /** Paired transfer legs that carried a `unit_cost_minor`, which valuation deliberately ignores. */
  ignoredTransferCostLegIds: string[];
}

/**
 * Build the remaining FIFO cost layers PER LOCATION, moving cost with the goods across transfers
 * (US-J03.2, US-J03.7). Inbound movements that carry a cost open a layer at their location; every
 * outbound consumes the OLDEST layer AT THAT LOCATION first. Demand that outlives the layers
 * accumulates into `shortfall` rather than driving a layer negative: a cost layer that could go
 * negative is a stock position that costs less than nothing, which is not a thing.
 *
 * WHY A TRANSFER IS NOT AN ISSUE FOLLOWED BY A RECEIPT, which is the defect this replaced. J02's
 * `inventory_transfer` leaves `unit_cost_minor` NULL on both legs, and rightly so: an operator moving
 * their own pallet from Bern to Zürich is not buying anything, so there is no new cost to state.
 * Treating the legs as ordinary movements made FIFO consume the oldest layer on the way out and open
 * NO layer on the way in, so an internal relocation destroyed cost basis and understated the balance
 * sheet: a single receipt of 100 at 1000, then a transfer of 30, reported CHF 700.00 where nothing had
 * been bought, sold or scrapped, with `reason: null` so the number looked clean. J06 is specified to
 * take that number to the general ledger.
 *
 * So a PAIR is processed atomically, at the position of whichever leg is met first (both legs share
 * `moved_at`, so the order between them carries no meaning): the source location gives up its oldest
 * layers, and those exact layers, at their own unit costs, are what the destination receives. Value is
 * conserved by construction, which is the property an internal move has to have. A `unit_cost_minor`
 * on a transfer leg is IGNORED and reported: cost follows the goods, and honouring a restated cost on
 * one leg while the other consumed the real layers would change an item's value by moving it.
 *
 * A leg whose partner is absent (a hand-written row, a half-migrated ledger) is not silently paired
 * with something else. It falls back to being an ordinary movement and is named in
 * `orphanTransferLegIds`, so the caller can say so rather than guess.
 *
 * Movements with no cost snapshot open NO layer. They still move the J02 on-hand SUM, which is why
 * the caller compares the layer quantity against that SUM and reports the gap as `uncostedQty`
 * instead of quietly valuing those units at the neighbours' price.
 */
export function buildLayersByLocation(movements: readonly MovementLine[]): LocationLayers {
  const byLocation = new Map<string, SeqLayer[]>();
  const created: SeqLayer[] = [];
  const pairedLegIds = new Set<string>();
  const inheritedByLeg = new Map<string, CostLayer[]>();
  const orphanTransferLegIds: string[] = [];
  const ignoredTransferCostLegIds: string[] = [];
  let shortfall = 0;
  const shortfallByLocation = new Map<string, number>();
  const addShortfall = (locationId: string, n: number): void => {
    if (n <= 0) return;
    shortfall += n;
    shortfallByLocation.set(locationId, (shortfallByLocation.get(locationId) ?? 0) + n);
  };
  let seq = 0;

  const queueOf = (locationId: string): SeqLayer[] => {
    const existing = byLocation.get(locationId);
    if (existing !== undefined) return existing;
    const fresh: SeqLayer[] = [];
    byLocation.set(locationId, fresh);
    return fresh;
  };

  // Index the legs by group first, so a pair is handled as a pair whatever order the two rows sort
  // in. Both legs share `moved_at` and `created_at`, so the id is what breaks the tie, and an id
  // generator is not obliged to make that meaningful.
  const groups = new Map<string, { out?: MovementLine; into?: MovementLine; oversubscribed?: boolean }>();
  for (const m of movements) {
    const group = m.transferGroupId ?? null;
    if (!TRANSFER_TYPES.has(m.movementType) || group === null) continue;
    const entry = groups.get(group) ?? {};
    // A group is EXACTLY two legs. A third would previously have overwritten one of them silently,
    // pairing two of the three arbitrarily and leaving the odd one to be handled as an ordinary
    // movement, which is the cost-destruction defect again on whichever leg lost the draw. An
    // over-subscribed group is refused as a group: every one of its legs falls back to ordinary
    // handling and is reported, so the result is visibly odd rather than quietly wrong.
    if (m.qty < 0) {
      if (entry.out !== undefined) entry.oversubscribed = true;
      entry.out = m;
    } else {
      if (entry.into !== undefined) entry.oversubscribed = true;
      entry.into = m;
    }
    groups.set(group, entry);
  }
  for (const [, pair] of groups) {
    if (pair.oversubscribed === true) continue;
    if (pair.out === undefined || pair.into === undefined) continue;
    pairedLegIds.add(pair.out.id);
    pairedLegIds.add(pair.into.id);
    if (pair.out.unitCostMinor !== null) ignoredTransferCostLegIds.push(pair.out.id);
    if (pair.into.unitCostMinor !== null) ignoredTransferCostLegIds.push(pair.into.id);
  }

  const handled = new Set<string>();
  for (const m of movements) {
    const isTransfer = TRANSFER_TYPES.has(m.movementType);
    const group = m.transferGroupId ?? null;
    const paired = isTransfer && group !== null && pairedLegIds.has(m.id);

    if (isTransfer && !paired) {
      // The partner is missing. Fall back to ordinary handling and say so, rather than inventing a
      // counterparty for a row whose other half nobody can see.
      orphanTransferLegIds.push(m.id);
    } else if (paired) {
      if (handled.has(group as string)) continue;
      handled.add(group as string);
      const pair = groups.get(group as string) as { out: MovementLine; into: MovementLine };
      const magnitude = Math.abs(pair.out.qty);
      const moved = consume(queueOf(pair.out.locationId), magnitude);
      addShortfall(pair.out.locationId, moved.unmet);
      const destination = queueOf(pair.into.locationId);
      const inherited: CostLayer[] = [];
      for (const slice of moved.taken) {
        // The slice keeps its own unit cost and its provenance; what changes is where it sits and,
        // for consumption order at the destination, when it got there.
        const arrival: SeqLayer = { ...slice, receiptDate: pair.into.movedAt, seq: seq++ };
        destination.push(arrival);
        created.push(arrival);
        // A COPY, deliberately, and the copy is load-bearing. `arrival` stays in the destination
        // queue and `consume()` MUTATES its `remainingQty` as later movements are processed, so
        // storing the live object here would make `inheritedByLeg` report what is LEFT rather than
        // what ARRIVED. The tally reads this after the whole stream has run: a transfer of 100
        // followed by an issue of 40 at the destination would look like a delivery of 60, shrinking
        // the cost pool, reporting the other 40 as uncosted, and putting the location figure
        // CHF 133.33 above the item-level figure for the same stream.
        inherited.push({ ...arrival });
      }
      inheritedByLeg.set(pair.into.id, inherited);
      continue;
    }

    if (m.qty > 0) {
      if (m.unitCostMinor === null) continue;
      const layer: SeqLayer = {
        sourceMovementId: m.id,
        receiptDate: m.movedAt,
        originalQty: m.qty,
        remainingQty: m.qty,
        unitCostMinor: m.unitCostMinor,
        seq: seq++,
      };
      queueOf(m.locationId).push(layer);
      created.push(layer);
      continue;
    }
    addShortfall(m.locationId, consume(queueOf(m.locationId), -m.qty).unmet);
  }

  const strip = (l: SeqLayer): CostLayer => ({
    sourceMovementId: l.sourceMovementId,
    receiptDate: l.receiptDate,
    originalQty: l.originalQty,
    remainingQty: l.remainingQty,
    unitCostMinor: l.unitCostMinor,
  });

  // THE CAP LIVES HERE, IN THE PRODUCER, PER LOCATION. This is the fix for the defect that kept
  // landing on one half of a pair. The layers must never say a location holds more than the ledger
  // does, and a stream can leave them saying exactly that: an issue dated BEFORE the receipt that
  // funds it is accepted by `inventory_move` (the `insufficient_stock` guard tests availability
  // today, not as of the movement date), so it consumes an empty queue as a shortfall and the later
  // receipt opens a layer nobody consumed. `Sigma remainingQty` at that location then exceeds its
  // on-hand SUM. Capping HERE, once, means every consumer (`byLocation`, `merged`, `buildFifoLayers`,
  // `fifo()`, and the `inventory_valuation_layers` verb) reads capped layers by construction, rather
  // than each remembering to cap and one of them forgetting. Per-location because the trim must fall
  // on the SHORT location's own oldest layers, never on another location's stock (which is what a cap
  // on the merged item queue would do, moving value between locations).
  //
  // On-hand per location is the plain SUM of that location's movement quantities, transfer legs
  // included, which is exactly how the tally derives a location's `qtyOnHand`, so the two agree. A
  // negative on-hand caps to nothing here and carries its own `negative_quantity` reason downstream;
  // an uncosted receipt (on-hand above layer quantity) trims nothing, so uncosted stock is still
  // reported rather than valued.
  const onHandByLocation = new Map<string, number>();
  for (const m of movements) {
    onHandByLocation.set(m.locationId, (onHandByLocation.get(m.locationId) ?? 0) + m.qty);
  }

  const publicByLocation = new Map<string, CostLayer[]>();
  const cappedSeq: SeqLayer[] = [];
  for (const [locationId, queue] of byLocation) {
    const live = queue.filter((l) => l.remainingQty > 0);
    const capped = capLayersToQty(live, onHandByLocation.get(locationId) ?? 0);
    cappedSeq.push(...capped);
    publicByLocation.set(
      locationId,
      capped.map(strip),
    );
  }

  return {
    byLocation: publicByLocation,
    // Merged is rebuilt FROM the per-location capped queues, in creation order, so the item view is
    // exactly the union of the location views and cannot over-report where a location was trimmed.
    merged: cappedSeq
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map(strip),
    shortfall,
    shortfallByLocation,
    pairedLegIds,
    inheritedByLeg,
    orphanTransferLegIds,
    ignoredTransferCostLegIds,
  };
}

/**
 * The item-level layers, oldest first. Kept as the name J06 and the layer verb call, and now a thin
 * view over the per-location engine so there is one FIFO implementation rather than two that can
 * disagree about what a transfer means.
 */
export function buildFifoLayers(movements: readonly MovementLine[]): { layers: CostLayer[]; shortfall: number } {
  const built = buildLayersByLocation(movements);
  // `merged` is already per-location capped. The one thing left it can over-report is the ITEM's net
  // position when some location is net negative: the merged layers then exceed the item on-hand SUM.
  // Cap to that here too, so this exported helper (J06 is a future consumer) can never hand a caller
  // more units than the item holds.
  const itemOnHand = movements.reduce((s, m) => s + m.qty, 0);
  return { layers: capLayersToQty(built.merged, itemOnHand), shortfall: built.shortfall };
}

// --- the calculators ----------------------------------------------------------------------------

interface Totals {
  qtyOnHand: number;
  costedInQty: number;
  costedInCost: bigint;
  uncostedInQty: number;
  hasNegativeCost: boolean;
  missingCostIds: string[];
}

/**
 * One pass over the stream, shared by all three methods so they cannot disagree about the inputs.
 *
 * A PAIRED TRANSFER LEG IS NOT A PURCHASE AND NOT A LOSS. At item level both legs are skipped for
 * cost entirely: their quantities net to zero and no money entered or left the business, so counting
 * the inbound leg as an uncosted receipt (which is what the raw stream looks like) both warned about
 * a cost that was never missing and, under FIFO, wrote 30 percent of the value off. At LOCATION level
 * the legs are real quantity changes, so the inbound leg contributes the cost it inherited from the
 * layers its partner gave up, which is what keeps weighted average at a location honest too.
 */
function tally(
  movements: readonly MovementLine[],
  scope: { locationId: string | null; built: LocationLayers },
): Totals {
  const { locationId, built } = scope;
  let qtyOnHand = 0;
  let costedInQty = 0;
  let costedInCost = 0n;
  let uncostedInQty = 0;
  let hasNegativeCost = false;
  const missingCostIds: string[] = [];
  for (const m of movements) {
    if (locationId !== null && m.locationId !== locationId) continue;
    qtyOnHand += m.qty;
    if (m.unitCostMinor !== null && m.unitCostMinor < 0) hasNegativeCost = true;

    // I03: a cost adjustment adds VALUE, not QUANTITY (its qty is 0). Fold the signed lump into the
    // cost pool and move on: quantity is untouched, so weighted-average unit cost rises and
    // standard-cost variance widens by exactly this amount, which is §4's contract for those two
    // methods. FIFO does not read the pool for its total (it sums layers), so it reads landed cost
    // separately, by referenced layer, in `landedForLayers`. A negative amount (a reverse) nets it
    // straight back out, which is why the pool is signed and not clamped here.
    if (m.movementType === 'landed_cost') {
      if (m.costAmountMinor !== null) costedInCost += BigInt(m.costAmountMinor);
      continue;
    }

    if (built.pairedLegIds.has(m.id)) {
      // Item level: quantity only, no cost either way (the pair nets to zero).
      if (locationId === null) continue;
      if (m.qty <= 0) continue;
      const inherited = built.inheritedByLeg.get(m.id) ?? [];
      let inheritedQty = 0;
      for (const layer of inherited) {
        inheritedQty += layer.remainingQty;
        costedInCost += BigInt(layer.remainingQty) * BigInt(layer.unitCostMinor);
      }
      costedInQty += inheritedQty;
      // A transfer out of a location that had no layers left arrives carrying nothing.
      if (m.qty > inheritedQty) {
        uncostedInQty += m.qty - inheritedQty;
        missingCostIds.push(m.id);
      }
      continue;
    }

    if (m.qty <= 0) continue;
    if (m.unitCostMinor === null) {
      uncostedInQty += m.qty;
      missingCostIds.push(m.id);
      continue;
    }
    costedInQty += m.qty;
    costedInCost += BigInt(m.qty) * BigInt(m.unitCostMinor);
  }
  return { qtyOnHand, costedInQty, costedInCost, uncostedInQty, hasNegativeCost, missingCostIds };
}

function emptyResult(
  snapshot: ItemSnapshot,
  context: ValuationContext,
  over: Partial<ValuationResult>,
): ValuationResult {
  return {
    itemId: snapshot.itemId,
    itemName: snapshot.itemName,
    asOf: context.asOf,
    method: snapshot.method,
    locationId: snapshot.locationId ?? null,
    qtyOnHand: 0,
    costedQty: 0,
    uncostedQty: 0,
    unitCostMinor: null,
    totalValueMinor: 0,
    layers: [],
    lcmApplied: false,
    writeDownMinor: 0,
    varianceMinor: null,
    reason: null,
    warnings: [],
    missingCostMovementIds: [],
    valuationBasis: 'direct',
    explanation: 'invValuation.explain.none',
    ...over,
  };
}

/**
 * Value one item at `context.asOf` (US-J03.1, .2, .3). Deterministic: the same snapshot and context
 * produce the same bytes every time, and nothing here is stateful, so concurrent previews cannot
 * interfere (US-J03.7).
 *
 * A LOCATION SCOPE IS REFUSED HERE unless the method can answer one directly. Weighted average and
 * standard cost cannot: their location figure is a SHARE of the item's pooled total, and computing
 * one straight from a location's own movements mints a second cost pool. That is not hypothetical
 * arithmetic, it is a different number (100'000 for a location the allocation values at 150'000), and
 * this function is exported, so J06 could reach it. `calculateItemByLocation` is the door for a
 * location figure; refusing loudly here is better than handing a caller a plausible wrong one.
 */
export function calculateItemValue(snapshot: ItemSnapshot, context: ValuationContext): ValuationResult {
  const scope = snapshot.locationId ?? null;
  if (scope !== null && snapshot.method !== 'fifo') {
    return emptyResult(snapshot, context, {
      reason: 'location_needs_allocation',
      warnings: ['location_needs_allocation'],
      explanation: 'invValuation.explain.locationNeedsAllocation',
    });
  }
  return valueAtScope(snapshot, context);
}

/**
 * The real calculator. Private on purpose: it will happily value any scope it is handed, which is
 * exactly what `calculateItemByLocation` needs when it is about to reconcile the rows, and exactly
 * what no other caller should have.
 */
function valueAtScope(snapshot: ItemSnapshot, context: ValuationContext): ValuationResult {
  const locationId = snapshot.locationId ?? null;
  // The layer engine runs ONCE, over the whole item's stream, and both the tally and the FIFO branch
  // read the same result. Running it twice would let the two disagree about what a transfer did.
  const built = buildLayersByLocation(snapshot.movements);
  const t = tally(snapshot.movements, { locationId, built });

  // (3) An impossible input is refused, not computed. J02's boundary rejects a negative unitCostMinor,
  // but a D01-era row predates that guard, so the calculator refuses rather than trusting it.
  if (t.hasNegativeCost) {
    return emptyResult(snapshot, context, {
      qtyOnHand: t.qtyOnHand,
      reason: 'invalid_unit_cost',
      warnings: ['invalid_unit_cost'],
      explanation: 'invValuation.explain.invalidUnitCost',
    });
  }

  const warnings: string[] = [];
  if (t.uncostedInQty > 0) warnings.push('missing_unit_cost');
  // A transfer leg whose partner is absent, and a transfer leg carrying a unit cost valuation does
  // not honour: both are inputs the caller is entitled to know were treated unusually.
  if (built.orphanTransferLegIds.length > 0) warnings.push('unpaired_transfer_leg');
  if (built.ignoredTransferCostLegIds.length > 0) warnings.push('transfer_cost_ignored');

  const valued =
    snapshot.method === 'standard_cost'
      ? standardCost(snapshot, context, t, warnings)
      : snapshot.method === 'fifo'
        ? fifo(snapshot, context, t, warnings, built, locationId)
        : weightedAverage(snapshot, context, t, warnings);

  // The uncosted movements are named on the way out (F4). Computing this list and then discarding it
  // was why an operator could see that something was uncosted but never which row, which is the one
  // diagnostic that would have made the transfer defect obvious from the screen.
  return { ...withLcm(valued, context, t), missingCostMovementIds: t.missingCostIds };
}

/**
 * Weighted average, periodic over the whole stream up to as_of (US-J03.1). The cost pool is the sum
 * of every costed inbound movement; the value is that pool scaled to the quantity still on hand, in
 * exact integer arithmetic. `unitCostMinor` is the rounded per-unit figure a human reads and is NOT
 * what the total is derived from (rule 2).
 */
function weightedAverage(
  snapshot: ItemSnapshot,
  context: ValuationContext,
  t: Totals,
  warnings: string[],
): ValuationResult {
  const base = emptyResult(snapshot, context, {
    qtyOnHand: t.qtyOnHand,
    costedQty: 0,
    uncostedQty: t.uncostedInQty,
    warnings,
  });

  const poolUnit = t.costedInQty > 0 ? commercialRound(t.costedInCost, BigInt(t.costedInQty)) : null;

  if (t.qtyOnHand < 0) {
    // A short position carries no positive book value (OR 960c prudence), and it is not presented as
    // a clean zero either: the negative quantity and the reason both travel with the result.
    return { ...base, unitCostMinor: poolUnit, reason: 'negative_quantity', warnings: [...warnings, 'negative_on_hand'], explanation: 'invValuation.explain.negativeQuantity' };
  }
  if (t.qtyOnHand === 0) {
    return { ...base, unitCostMinor: poolUnit, reason: 'zero_quantity', explanation: 'invValuation.explain.zeroQuantity' };
  }
  if (t.costedInQty === 0) {
    // Stock on hand, no cost anywhere in the stream: the value is zero and the reason says so.
    return { ...base, reason: 'missing_unit_cost', explanation: 'invValuation.explain.noCostBasis' };
  }

  // The cost pool covers `costedInQty` units and no more, so the quantity it is scaled to is capped
  // there and any excess is valued at zero rather than at the pool average.
  //
  // WHAT THAT CAP ASSUMES, STATED RATHER THAN LEFT IMPLICIT. Capping at `costedInQty` means that when
  // a stream mixes costed and uncosted receipts, whatever has already been issued is treated as
  // having come out of the UNCOSTED units first. With 50 costed at 1000, 50 uncosted and an issue of
  // 60, the 40 that remain are all valued at 1000 (40_000) rather than treated as 40 uncosted units
  // worth nothing. That is the value-maximising reading, not the prudent one. It is bounded: the
  // figure can never exceed the cost pool, so OR 960a Abs. 2 holds either way. It is also visible:
  // any stream where it bites carries `missing_unit_cost` and names the movements. FIFO does not
  // guess at all, because its layers record which units were costed, so an operator who needs the
  // question answered rather than assumed should value that item under FIFO.
  const valuedQty = Math.min(t.qtyOnHand, t.costedInQty);
  const total = commercialRound(BigInt(valuedQty) * t.costedInCost, BigInt(t.costedInQty));

  return {
    ...base,
    costedQty: valuedQty,
    uncostedQty: t.qtyOnHand - valuedQty,
    unitCostMinor: poolUnit,
    totalValueMinor: total,
    explanation: 'invValuation.explain.weightedAverage',
  };
}

/**
 * FIFO (US-J03.2). The layers are the truth: the total is their exact sum, with no division anywhere,
 * so `Σ remainingQty x unitCostMinor === totalValueMinor` holds to the Rappen by construction rather
 * than by rounding luck. `unitCostMinor` is the derived average of what is left, for display.
 */
/**
 * Trim a layer queue from the OLDEST end until it holds no more than `qtyOnHand` units.
 *
 * Generic over the layer shape so it caps a `SeqLayer` queue inside the builder and a bare
 * `CostLayer` queue at the verb boundary with one implementation. Returns the queue untouched when it
 * already fits. A zero or NEGATIVE on-hand holds no positive FIFO value, so it caps to the empty
 * queue: a net-short position is worth zero on the balance sheet (fifo() reports it as
 * `negative_quantity`), and every seam that sums layers (the layers verb, the J06 buildFifoLayers
 * seam, preview's own layers array) reads through here, so returning the raw queue for a negative
 * on-hand made all three over-report while the scalar read zero. Pure: the input is not mutated.
 */
export function capLayersToQty<T extends { remainingQty: number }>(queue: readonly T[], qtyOnHand: number): T[] {
  if (qtyOnHand <= 0) return [];
  let excess = queue.reduce((s, l) => s + l.remainingQty, 0) - qtyOnHand;
  if (excess <= 0) return [...queue];
  const out: T[] = [];
  for (const layer of queue) {
    if (excess <= 0) {
      out.push(layer);
      continue;
    }
    if (layer.remainingQty <= excess) {
      excess -= layer.remainingQty;
      continue;
    }
    out.push({ ...layer, remainingQty: layer.remainingQty - excess });
    excess = 0;
  }
  return out;
}

/**
 * I03: the landed cost still carried by a set of FIFO layers, in exact integer Rappen.
 *
 * A `landed_cost` movement binds a lump of cost to the receipt movement it names (`refMovementId`).
 * That cost spreads across the receipt's ORIGINAL units, so the cost still on the layers is the lump
 * scaled by how many of those units remain: `cost x remaining / originalQty`. Rounded ONCE per source
 * movement (each is a reported cost component), so when the whole receipt is still on hand the answer
 * is the lump exactly, and when FIFO has issued some of it the issued units' share has left with the
 * goods (to COGS), never lingering on the balance sheet.
 *
 * `layers` is the scope's already-capped queue, so this reads the same units the base total does:
 * cost follows the goods across a transfer because a moved layer keeps its `sourceMovementId`, so its
 * share of the receipt's landed cost shows up wherever the units now sit.
 */
export function landedForLayers(movements: readonly MovementLine[], layers: readonly CostLayer[]): number {
  const refCost = new Map<string, bigint>();
  const sourceQty = new Map<string, number>();
  for (const m of movements) {
    if (m.movementType === 'landed_cost') {
      if (m.refMovementId !== null && m.costAmountMinor !== null) {
        refCost.set(m.refMovementId, (refCost.get(m.refMovementId) ?? 0n) + BigInt(m.costAmountMinor));
      }
    } else if (m.qty > 0) {
      sourceQty.set(m.id, (sourceQty.get(m.id) ?? 0) + m.qty);
    }
  }
  if (refCost.size === 0) return 0;
  const remainingBySource = new Map<string, number>();
  for (const l of layers) {
    remainingBySource.set(l.sourceMovementId, (remainingBySource.get(l.sourceMovementId) ?? 0) + l.remainingQty);
  }
  let landed = 0;
  for (const [movementId, cost] of refCost) {
    const originalQty = sourceQty.get(movementId);
    if (originalQty === undefined || originalQty <= 0) continue;
    const remaining = remainingBySource.get(movementId) ?? 0;
    if (remaining <= 0) continue;
    landed += commercialRound(cost * BigInt(remaining), BigInt(originalQty));
  }
  return landed;
}

function fifo(
  snapshot: ItemSnapshot,
  context: ValuationContext,
  t: Totals,
  warnings: string[],
  built: LocationLayers,
  locationId: string | null,
): ValuationResult {
  // One location's queue, or every remaining layer merged in creation order for the item as a whole.
  const queue = locationId === null ? built.merged : (built.byLocation.get(locationId) ?? []);
  // FIFO MUST NEVER VALUE MORE UNITS THAN ARE ON HAND. A stream can leave more in the layers than the
  // ledger says exists, and it needs nothing exotic to do so: an issue dated BEFORE the receipt that
  // funds it is accepted by `inventory_move`, because the `insufficient_stock` guard tests
  // availability today rather than as of the movement date. That issue consumes an empty queue and is
  // recorded as a shortfall, then the later receipt opens a layer nobody ever consumed. One receipt
  // of 100 at CHF 10.00 on 2026-01-02 with an issue of 60 dated 2026-01-01 left on-hand at 40 and the
  // layers at 100, so the item was valued at CHF 1'000.00 where weighted average and standard cost
  // both said CHF 400.00. Across a random sweep 27 percent of streams hit it. It was an overstated
  // Bilanzwert (OR 960 Abs. 2), returned with `reason: 'insufficient_layers'` set but the number still
  // summed into the workspace total and still handed to J06.
  //
  // Trimming from the OLDEST end is what FIFO means here: the excess is quantity that has already
  // been issued, and under first-in-first-out what went out was the oldest.
  const layers = capLayersToQty(queue, t.qtyOnHand);
  // A location answers for ITS OWN shortfall, never the item's. Using the item-wide figure here made
  // a store holding 100 fully costed units report `insufficient_layers` because a DIFFERENT store had
  // gone short, and made an empty location say `insufficient_layers` where the truth was
  // `zero_quantity`. The value was right and the reason lied, which is the worse failure of the two:
  // a wrong number gets questioned, a wrong explanation gets believed.
  const shortfall = locationId === null ? built.shortfall : (built.shortfallByLocation.get(locationId) ?? 0);
  const layerQty = layers.reduce((s, l) => s + l.remainingQty, 0);
  let total = 0n;
  for (const l of layers) total += BigInt(l.remainingQty) * BigInt(l.unitCostMinor);
  // I03: the landed cost still attached to these very layers (§4 FIFO contract). Added to the total
  // and reflected in the display unit cost; the base layers keep their own receipt unit cost, so the
  // per-layer detail an operator drills into is undisturbed and only the roll-up carries the extra.
  const landed = landedForLayers(snapshot.movements, layers);
  total += BigInt(landed);

  const allWarnings = shortfall > 0 ? [...warnings, 'insufficient_layers'] : warnings;
  const base = emptyResult(snapshot, context, {
    qtyOnHand: t.qtyOnHand,
    costedQty: layerQty,
    uncostedQty: Math.max(t.qtyOnHand - layerQty, 0),
    layers,
    warnings: allWarnings,
  });

  if (t.qtyOnHand < 0) {
    return { ...base, reason: 'negative_quantity', warnings: [...allWarnings, 'negative_on_hand'], explanation: 'invValuation.explain.negativeQuantity' };
  }
  if (layerQty === 0) {
    return {
      ...base,
      reason: shortfall > 0 ? 'insufficient_layers' : t.qtyOnHand === 0 ? 'zero_quantity' : 'missing_unit_cost',
      explanation: shortfall > 0 ? 'invValuation.explain.insufficientLayers' : 'invValuation.explain.zeroQuantity',
    };
  }

  return {
    ...base,
    unitCostMinor: commercialRound(total, BigInt(layerQty)),
    totalValueMinor: Number(total),
    reason: shortfall > 0 ? 'insufficient_layers' : null,
    explanation: 'invValuation.explain.fifo',
  };
}

/**
 * Standard cost (US-J03.3). The inventory is carried at the operator's standard and the purchase
 * price variance is exposed beside it: positive means the workspace paid ABOVE standard. J03 only
 * surfaces the variance; posting it is J06's.
 */
function standardCost(
  snapshot: ItemSnapshot,
  context: ValuationContext,
  t: Totals,
  warnings: string[],
): ValuationResult {
  const std = snapshot.standardCostMinor;
  const base = emptyResult(snapshot, context, {
    qtyOnHand: t.qtyOnHand,
    costedQty: t.qtyOnHand,
    uncostedQty: 0,
    warnings,
  });
  if (std === null || std <= 0) {
    return { ...base, costedQty: 0, reason: 'missing_standard_cost', explanation: 'invValuation.explain.missingStandardCost' };
  }

  const variance = Number(t.costedInCost - BigInt(t.costedInQty) * BigInt(std));

  if (t.qtyOnHand < 0) {
    return {
      ...base,
      costedQty: 0,
      unitCostMinor: std,
      varianceMinor: variance,
      reason: 'negative_quantity',
      warnings: [...warnings, 'negative_on_hand'],
      explanation: 'invValuation.explain.negativeQuantity',
    };
  }

  return {
    ...base,
    unitCostMinor: std,
    // Exact integers: a standard cost times a quantity needs no division and therefore no rounding.
    totalValueMinor: Number(BigInt(t.qtyOnHand) * BigInt(std)),
    varianceMinor: variance,
    reason: t.qtyOnHand === 0 ? 'zero_quantity' : null,
    explanation: 'invValuation.explain.standardCost',
  };
}

/**
 * OR 960c Abs. 1, applied after whichever method produced the cost (rule 4). Compulsory: when a net
 * realisable value is supplied and sits below the calculated unit cost, it IS the value. There is no
 * caller flag that declines it, and the clamp can only ever lower a figure, so it cannot be used to
 * write inventory up past cost (OR 960a Abs. 2).
 */
function withLcm(result: ValuationResult, context: ValuationContext, t: Totals): ValuationResult {
  const nrv = context.netRealisableValueMinor;
  if (nrv === undefined || nrv === null) return result;
  // A negative or fractional net realisable value is an impossible input, so it is refused rather
  // than ignored (rule 3). Ignoring it would answer a question nobody asked with a cost figure while
  // the caller believed a clamp had been applied.
  if (!Number.isInteger(nrv) || nrv < 0) {
    return { ...result, totalValueMinor: 0, reason: 'invalid_net_realisable_value', warnings: [...result.warnings, 'invalid_net_realisable_value'], explanation: 'invValuation.explain.invalidNrv' };
  }
  if (result.reason === 'invalid_unit_cost' || result.reason === 'negative_quantity') return result;
  if (t.qtyOnHand <= 0) return result;

  // NOTE THE ABSENT GUARD. There used to be an `nrv >= result.unitCostMinor` short-circuit here, and
  // it compared the statutory threshold against the ROUNDED display figure. That suppressed a
  // compulsory write-down inside a half-Rappen band, and the band scales with quantity: at 10'000
  // units whose exact average is 1000.4999 the displayed cost is 1000, so an NRV of 1000 looked
  // equal-or-above and nothing was written down, leaving the figure CHF 49.99 above the truth and
  // making a one-Rappen change in the NRV move it by CHF 149.99. That is precisely the drift rule (2)
  // at the top of this file forbids, avoided in the total and then reintroduced in the DECISION. The
  // comparison below is between two whole-Rappen TOTALS, so no rounded PER-UNIT intermediary decides
  // anything and the suppression band is gone. To be exact about what remains rather than overclaim:
  // `totalValueMinor` is itself rounded once, to the Rappen, so the comparison carries that figure's
  // own sub-Rappen residual. A sweep of 411'642 cases found no case where it changed a whole-Rappen
  // outcome, and it cannot, because both sides are compared at the same scale.
  //
  // THE VALUATION UNIT IS THE ITEM POSITION, NOT THE INDIVIDUAL COST LAYER (revised 2026-08-11 after
  // reading the sources rather than reasoning from first principles). A previous round clamped each
  // FIFO layer separately, on the argument that OR 960 Abs. 1 requires Einzelbewertung. That argument
  // rested on a truncated quote. The article reads, in full:
  //
  //   "Aktiven und Verbindlichkeiten werden in der Regel einzeln bewertet, sofern sie wesentlich sind
  //    und aufgrund ihrer Gleichartigkeit für die Bewertung nicht üblicherweise als Gruppe
  //    zusammengefasst werden."
  //
  // The clause that was cut is the one that decides this case. Müller/Henry/Barmettler (OFK-OR,
  // Art. 960) name as gleichartig exactly "vertretbare Sachen ..., die nach der Verkehrsauffassung
  // (üblicherweise) nach Mass, Anzahl oder Gewicht bestimmt werden, wie etwa zehn Tonnen Getreide,
  // hundert Liter Heizöl oder serienmässig hergestellte Sachen" (N 12), add that "auch bei Vorräten
  // können gleichartige Einzelpositionen wie z. B. 500 kg Fisch, eine Tonne Käse etc. als Einheiten
  // betrachtet werden" (N 15), and record that under Gesamtbewertung "Minderwerte und Wertsteigerungen
  // können innerhalb ein- und derselben Bilanzposition miteinander kompensiert und verrechnet werden,
  // soweit die Summe der historischen Kosten der Bilanzposition nicht überschritten wird" (N 18,
  // citing EXPERTsuisse HWP 2014 S. 60). N 24 calls stock that loses its "separate Identität" in the
  // process "der Musterfall der Gleichwertigkeit", and N 15 notes the Botschaft's view that
  // Einzelbewertung "bei Forderungen und Vorräten i. d. R. keine tragende Rolle" plays.
  //
  // Interchangeable units of ONE article, which is precisely what an item's cost layers are, are the
  // textbook case for grouping. So the comparison is position against position: what the item's stock
  // cost against what it can be sold for, and the offsetting of a dear layer against a cheap one is
  // permitted inside the position, capped at its historical cost. That cap is enforced below by
  // clamping only when the result is LOWER, so OR 960a Abs. 2 cannot be breached either way.
  //
  // WHAT SURVIVES FROM THE PER-LAYER ROUND: the requirement that the answer not depend on how it was
  // asked for. It is met the other way round now. The clamp is computed once, on the item, and the
  // per-location rows are an allocation of that clamped figure (`calculateItemByLocation`), so both
  // scopes agree and the rows still sum. N 22's disclosure duty (say in the Anhang which assets are
  // grouped and why) is a J06/A08 reporting concern and is recorded in the spec, not here.
  if (result.unitCostMinor === null) return result;
  // The clamp scales the quantity the VALUE covers, not the raw on-hand: with uncosted units in the
  // stream those differ, and using on-hand would let a write-down RAISE the figure above cost, which
  // is the one thing OR 960a Abs. 2 forbids outright.
  const clamped = Number(BigInt(result.costedQty) * BigInt(nrv));
  if (clamped >= result.totalValueMinor) return result;
  return {
    ...result,
    unitCostMinor: nrv,
    totalValueMinor: clamped,
    lcmApplied: true,
    writeDownMinor: result.totalValueMinor - clamped,
    explanation: 'invValuation.explain.lcm',
  };
}

/** The batch J06 and the preview verb both call, so a roll-up cannot disagree with its own rows. */
export function calculateValuationBatch(
  snapshots: readonly ItemSnapshot[],
  context: ValuationContext,
): ValuationResult[] {
  return snapshots.map((s) => calculateItemValue(s, context));
}

/**
 * Split `total` across `weights` so the parts sum to EXACTLY `total` (largest remainder).
 *
 * Each part gets the floor of its exact share, and the Rappen left over by that flooring go to the
 * largest fractional remainders, ties broken by position so the result is deterministic. Rounding
 * each share independently would leave the parts summing to something other than the whole, which is
 * the entire property this exists to guarantee.
 */
function allocateExactly(total: number, weights: readonly number[]): number[] {
  const positive = weights.map((w) => (w > 0 ? w : 0));
  const totalWeight = positive.reduce((s, w) => s + w, 0);
  if (totalWeight === 0 || total === 0) return weights.map(() => 0);

  const T = BigInt(total);
  const W = BigInt(totalWeight);
  const floors = positive.map((w) => (T * BigInt(w)) / W);
  const remainders = positive.map((w, i) => ({ i, rem: T * BigInt(w) - (floors[i] as bigint) * W }));
  let left = T - floors.reduce((s, f) => s + f, 0n);
  // `left` is the number of whole Rappen the flooring dropped; it is always smaller than the number
  // of parts, so one pass in descending remainder order places every one of them.
  remainders.sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1));
  const out = floors.map((f) => Number(f));
  for (const { i } of remainders) {
    if (left <= 0n) break;
    out[i] = (out[i] as number) + 1;
    left -= 1n;
  }
  return out;
}

/**
 * Value one item at EVERY location it has moved through, with the parts guaranteed to sum to the
 * item's own figure (owner decision, 2026-08-11).
 *
 * FIFO is additive by construction: its layers are partitioned across the location queues and the
 * OR 960c clamp is elementwise over them, so those rows are `direct` and are returned as computed.
 *
 * STANDARD COST LOOKS ADDITIVE AND IS NOT, once a location goes short. `qty x standard` does
 * distribute over a sum, but a SHORT location returns zero rather than a negative book value (OR 960
 * Abs. 2 prudence), while the item figure nets that short position in. With 100 units in Bern, minus
 * 20 in Zürich and a standard of 1000, the item is 80'000 and the rows are 100'000 and 0. It is
 * reachable through shipped verbs, because `inventory_move` accepts a backdated issue and the
 * `insufficient_stock` guard tests availability TODAY, not as of the valuation date. So standard cost
 * joins the allocation below, where in the ordinary case the share is exactly `qty x standard`
 * anyway (the division is exact) and the only thing that changes is that a short position is netted
 * instead of dropped.
 *
 * WEIGHTED AVERAGE IS NOT ADDITIVE EITHER, AND CANNOT BE MADE SO BY VALUING EACH LOCATION SEPARATELY. A periodic
 * weighted average has ONE cost pool per item; give each location its own average over its own
 * receipts and the parts stop summing to the whole. Measured, with no transfer involved: 100 at 1000
 * in Bern and 100 at 2000 in Zürich, then an issue of 50 in Bern, gives 225'000 item-wide and 250'000
 * summed per location. A display toggle would have moved the workspace inventory total by CHF 250.
 *
 * So each location shows its own QUANTITY at the ITEM's pooled average, and the exact allocation
 * below distributes the item's total (already carrying any OR 960c write-down) so the Rappen add up.
 * Those rows are marked `allocated`, because a reader is entitled to know the number is a share of a
 * pooled figure rather than a valuation of that location's own goods.
 */
export function calculateItemByLocation(
  snapshot: ItemSnapshot,
  context: ValuationContext,
  locationIds: readonly string[],
): ValuationResult[] {
  const rows = locationIds.map((locationId) => valueAtScope({ ...snapshot, locationId }, context));
  const item = calculateItemValue({ ...snapshot, locationId: null }, context);

  // FIFO rows are additive AS LONG AS nothing forces the item figure away from the plain sum of the
  // location queues, and two things do. A location that is net SHORT contributes zero (it has no
  // layers) while the item figure nets its negative quantity in, and the OR 960c clamp is decided on
  // the item POSITION as a whole, so a clamped item total is not the sum of unclamped location
  // totals. In either case the rows are reconciled by allocation below; otherwise they are returned
  // exactly as each location computed them, which keeps the layer-derived detail that makes FIFO
  // worth having.
  const anyShort = rows.some((r) => r.qtyOnHand < 0);
  if (snapshot.method === 'fifo' && !anyShort && !item.lcmApplied) return rows;

  // WEIGHT BY QUANTITY, which is the owner's ruling stated generally: a location shows ITS quantity
  // at the ITEM's unit figure. That is exactly right for the three cases that reach here. Weighted
  // average has one pooled average by definition. Standard cost has one standard, and the division is
  // exact, so the share is precisely `qty x standard`. And a clamped position has been written down
  // to the net realisable value, so every unit in it now carries the SAME figure whatever it
  // originally cost, which is the case where weighting by the pre-clamp value would have been wrong.
  const weights = rows.map((r) => r.qtyOnHand);
  const shares = allocateExactly(item.totalValueMinor, weights);
  const writeDowns = allocateExactly(item.writeDownMinor, weights);

  return rows.map((r, i) => {
    // A location holding nothing, or short, carries no share and keeps the reason it worked out for
    // itself: allocating a positive figure onto a negative position would invent an asset.
    if (r.qtyOnHand <= 0) return { ...r, unitCostMinor: item.unitCostMinor, valuationBasis: 'allocated' as const };
    return {
      ...r,
      unitCostMinor: item.unitCostMinor,
      totalValueMinor: shares[i] as number,
      writeDownMinor: writeDowns[i] as number,
      lcmApplied: item.lcmApplied,
      valuationBasis: 'allocated' as const,
      explanation: item.lcmApplied ? 'invValuation.explain.lcm' : 'invValuation.explain.allocated',
    };
  });
}
