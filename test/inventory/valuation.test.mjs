// J03, the PURE valuation calculators. No store, no ctx: this suite is the arithmetic on its own.
//
// It exists so a critic can refute the money maths without a database in scope. What it holds:
//   - the three §2 golden fixtures, at the corrected numbers (the import's FIFO example did not
//     survive its own arithmetic; §2 records the correction)
//   - the exact-total rule: the weighted-average value is the cost pool scaled to the quantity, NOT
//     the rounded unit cost multiplied by it, and the test below measures the drift the other way
//     round rather than asserting the rule in prose
//   - the FIFO layer identity, to the Rappen, over randomised streams
//   - purity: same input, same bytes, twice
//   - the refusals: a negative unit cost, a negative on-hand, a missing standard cost, a negative
//     net realisable value. Each returns a REASON, never an arithmetic answer.
//   - the OR 960c clamp, decided on the ITEM POSITION (a per-layer round was reverted against the
//     sources: see the spec's US-J03.7), including the case where clamping on raw on-hand instead of
//     the costed quantity would RAISE the value above cost (which OR 960a Abs. 2 forbids)
//   - FIFO never valuing more units than the ledger holds, which a backdated issue could produce

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateItemValue,
  calculateItemByLocation,
  calculateValuationBatch,
  buildFifoLayers,
  commercialRound,
  normaliseMethod,
  VALUATION_METHODS,
} from '../../dist/core/inventory/valuation.js';

/** A movement line. `unitCostMinor` defaults to null so an omission is visibly uncosted. */
function mv(id, movedAt, qty, unitCostMinor = null, locationId = 'loc_a') {
  return {
    id,
    movedAt,
    qty,
    unitCostMinor,
    movementType: qty > 0 ? 'receipt' : 'issue',
    locationId,
    transferGroupId: null,
  };
}

/** The two legs of one atomic J02 transfer, exactly as `inventory_transfer` writes them: no cost. */
function transferPair(group, movedAt, qty, from, to, unitCostMinor = null) {
  return [
    { id: `${group}-out`, movedAt, qty: -qty, unitCostMinor, movementType: 'transfer_out', locationId: from, transferGroupId: group },
    { id: `${group}-in`, movedAt, qty, unitCostMinor, movementType: 'transfer_in', locationId: to, transferGroupId: group },
  ];
}

function snap(method, movements, over = {}) {
  return { itemId: 'it_1', itemName: 'Widget', method, standardCostMinor: null, movements, ...over };
}

const CTX = { asOf: '2026-12-31' };

// --- §2 golden fixtures -------------------------------------------------------------------------

test('J03 US-J03.1: weighted average over two receipts and an issue', () => {
  const r = calculateItemValue(
    snap('weighted_average', [
      mv('m1', '2026-01-10', 100, 1250),
      mv('m2', '2026-02-10', 50, 1400),
      mv('m3', '2026-03-10', -80),
    ]),
    CTX,
  );
  // 100x1250 + 50x1400 = 195_000 over 150 units, so the average is exactly 1300.
  assert.equal(r.unitCostMinor, 1300);
  assert.equal(r.qtyOnHand, 70);
  assert.equal(r.totalValueMinor, 91_000);
  assert.equal(r.reason, null);
  assert.deepEqual(r.warnings, []);
});

test('J03 US-J03.1: an as_of cut-off excludes the later receipt from the cost pool', () => {
  // The caller filters the stream; the calculator sees only what happened up to the date.
  const r = calculateItemValue(
    snap('weighted_average', [mv('m1', '2026-01-10', 100, 1250), mv('m3', '2026-01-20', -80)]),
    { asOf: '2026-01-31' },
  );
  assert.equal(r.unitCostMinor, 1250);
  assert.equal(r.qtyOnHand, 20);
  assert.equal(r.totalValueMinor, 25_000);
});

test('J03 US-J03.2: FIFO consumes oldest first and leaves ONE layer of 70 at 1200', () => {
  const r = calculateItemValue(
    snap('fifo', [
      mv('m1', '2026-01-01', 100, 1000),
      mv('m2', '2026-01-03', -60),
      mv('m3', '2026-01-05', 80, 1200),
      mv('m4', '2026-01-07', -50),
    ]),
    CTX,
  );
  assert.equal(r.qtyOnHand, 70, '100 + 80 - 60 - 50');
  assert.equal(r.layers.length, 1, 'the 1000-cost layer is fully consumed by the second issue');
  assert.equal(r.layers[0].remainingQty, 70);
  assert.equal(r.layers[0].unitCostMinor, 1200);
  assert.equal(r.totalValueMinor, 84_000);
  assert.equal(r.unitCostMinor, 1200);
  assert.equal(r.reason, null);
});

test('J03 US-J03.3: standard cost carries inventory at standard and exposes the variance', () => {
  const r = calculateItemValue(
    snap('standard_cost', [mv('m1', '2026-01-01', 200, 1150)], { standardCostMinor: 1100 }),
    CTX,
  );
  assert.equal(r.qtyOnHand, 200);
  assert.equal(r.unitCostMinor, 1100);
  assert.equal(r.totalValueMinor, 220_000, '200 x 1100');
  // Paid 230_000 for 200 units that stand at 220_000: a positive purchase-price variance.
  assert.equal(r.varianceMinor, 10_000);
});

// --- the exact-total rule -----------------------------------------------------------------------

test('J03: the weighted-average total is the exact cost pool, not qty x rounded unit cost', () => {
  // 3 units at 1000 and 3 at 1001: the pool is 6003 over 6, an average of 1000.5 which commercial
  // rounding lifts to 1001. Rounding first and multiplying gives 6006; the pool gives 6003.
  const r = calculateItemValue(
    snap('weighted_average', [mv('m1', '2026-01-01', 3, 1000), mv('m2', '2026-01-02', 3, 1001)]),
    CTX,
  );
  assert.equal(r.unitCostMinor, 1001, 'the displayed unit cost is the rounded average');
  assert.equal(r.totalValueMinor, 6003, 'the value is the exact pool, not 6 x 1001');
  // And the §7 bound still holds: the two never differ by more than ceil(qty/2).
  assert.ok(Math.abs(r.totalValueMinor - r.qtyOnHand * r.unitCostMinor) <= Math.ceil(r.qtyOnHand / 2));
});

test('J03: at scale, rounding the unit cost first would drift a filed figure by CHF 100', () => {
  // 10_000 units whose pool averages exactly x.5 Rappen. This is the case the reconcile note cites.
  const movements = [mv('m1', '2026-01-01', 10_000, 1000), mv('m2', '2026-01-02', 10_000, 1001)];
  const r = calculateItemValue(snap('weighted_average', movements), CTX);
  const poolTotal = 10_000 * 1000 + 10_000 * 1001;
  assert.equal(r.totalValueMinor, poolTotal, 'the exact pool, to the Rappen');
  const naive = r.qtyOnHand * r.unitCostMinor;
  assert.equal(naive - r.totalValueMinor, 10_000, 'the discarded approach drifts by 10_000 Rappen (CHF 100)');
});

test('J03: commercialRound is half AWAY FROM ZERO, which Math.round is not', () => {
  assert.equal(commercialRound(5n, 2n), 3);
  assert.equal(commercialRound(-5n, 2n), -3, 'Math.round(-2.5) is -2; commercial rounding is -3');
  assert.equal(commercialRound(1n, 3n), 0);
  assert.equal(commercialRound(2n, 3n), 1);
  // Above 2^53 the bigint path still answers exactly, which a number path would not.
  assert.equal(commercialRound(90071992547409910n, 10n), 9007199254740991);
});

// --- FIFO layer identity ------------------------------------------------------------------------

test('J03: FIFO layers reconcile to the Rappen and never go negative, over randomised streams', () => {
  // Deterministic pseudo-random so a failure reproduces.
  let seed = 20260811;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };

  for (let run = 0; run < 300; run += 1) {
    const movements = [];
    let received = 0;
    let receivedCost = 0;
    let issued = 0;
    for (let i = 0; i < 12; i += 1) {
      const day = String(i + 1).padStart(2, '0');
      if (next(2) === 0 || received - issued <= 0) {
        const qty = 1 + next(50);
        const cost = 1 + next(5000);
        received += qty;
        receivedCost += qty * cost;
        movements.push(mv(`r${run}-${i}`, `2026-01-${day}`, qty, cost));
      } else {
        const qty = 1 + next(received - issued);
        issued += qty;
        movements.push(mv(`i${run}-${i}`, `2026-01-${day}`, -qty));
      }
    }

    const r = calculateItemValue(snap('fifo', movements), CTX);
    const layerQty = r.layers.reduce((s, l) => s + l.remainingQty, 0);
    const layerValue = r.layers.reduce((s, l) => s + l.remainingQty * l.unitCostMinor, 0);

    assert.equal(layerQty, r.qtyOnHand, 'every unit on hand sits in exactly one layer');
    assert.equal(layerValue, r.totalValueMinor, 'the value IS the layers, to the Rappen');
    assert.ok(Number.isInteger(r.totalValueMinor));
    assert.ok(
      r.layers.every((l) => l.remainingQty > 0 && l.remainingQty <= l.originalQty),
      'no layer is empty, negative, or larger than it started',
    );
    // The reconciliation the brief asks for: what is left plus what was consumed is what came in,
    // valued at the same layer costs. Consumed cost is derived, never stored.
    const consumedCost = receivedCost - layerValue;
    assert.ok(consumedCost >= 0 && consumedCost <= receivedCost, 'consumption never exceeds the cost pool');
  }
});

test('J03: buildFifoLayers reports a shortfall rather than driving a layer negative', () => {
  const { layers, shortfall } = buildFifoLayers([mv('m1', '2026-01-01', 10, 500), mv('m2', '2026-01-02', -25)]);
  assert.equal(layers.length, 0);
  assert.equal(shortfall, 15);
});

test('J03 F1: buildFifoLayers (the J06 seam) caps to on-hand, per location AND item-net', () => {
  // The exported helper is the fourth layer-emitting site. Two ways it could over-report, both closed:
  // a location holding more layers than on-hand, and the item net position when a location is short.
  // Single-location backdated issue: on-hand 40, layers must total 40 not 100.
  const oneLoc = buildFifoLayers([mv('i', '2026-01-01', -60, null, 'loc_a'), mv('r', '2026-01-02', 100, 1000, 'loc_a')]);
  assert.equal(oneLoc.layers.reduce((s, l) => s + l.remainingQty, 0), 40);

  // loc_a holds 100 at 1000, loc_b is minus 20: the item nets to 80, so the merged layers must too.
  const netShort = buildFifoLayers([mv('a', '2026-01-10', 100, 1000, 'loc_a'), mv('bi', '2026-01-15', -20, null, 'loc_b')]);
  assert.equal(netShort.layers.reduce((s, l) => s + l.remainingQty, 0), 80, 'item-net capped, not 100');
});

test('J03 F1: a NET-NEGATIVE item holds no FIFO value, on every seam, not just the scalar', () => {
  // The sixth-critic case: loc_a keeps a real layer while the ITEM nets below zero, so the item-net
  // cap runs on a negative on-hand. capLayersToQty used to hand back the raw queue for a negative
  // on-hand, so the layers verb, the J06 seam AND preview's own layers array over-reported (5652)
  // while the balance-sheet scalar correctly read 0. A net-short position is worth nothing; every
  // surface must say so, not just the number.
  const movements = [mv('r', '2026-01-01', 3, 1884, 'loc_a'), mv('bi', '2026-01-05', -20, null, 'loc_b')];

  // The J06 seam: no layer survives a net-short item.
  const seam = buildFifoLayers(movements);
  assert.equal(seam.layers.reduce((s, l) => s + l.remainingQty, 0), 0, 'J06 seam: a net-short item holds no layers');

  // The full calculator: the scalar and its own layers array must AGREE, both at zero. Before the
  // fix the scalar was 0 (negative_quantity guard) but the layers array summed to 5652, the exact
  // split this asserts against.
  const r = calculateItemValue(snap('fifo', movements), CTX);
  assert.equal(r.qtyOnHand, -17, 'the real net position is still reported');
  assert.equal(r.totalValueMinor, 0, 'a net-short item books zero on the balance sheet');
  assert.equal(r.reason, 'negative_quantity');
  assert.equal(r.layers.reduce((s, l) => s + l.remainingQty, 0), 0, 'the layers array agrees with the scalar, never over-reports');
});

test('J03: FIFO over-consumption surfaces insufficient_layers, never a negative value', () => {
  const r = calculateItemValue(
    snap('fifo', [mv('m1', '2026-01-01', 10, 500), mv('m2', '2026-01-02', -25), mv('m3', '2026-01-03', 20, 600)]),
    CTX,
  );
  assert.equal(r.reason, 'insufficient_layers');
  assert.ok(r.warnings.includes('insufficient_layers'));
  assert.ok(r.totalValueMinor >= 0);
  assert.equal(r.totalValueMinor, r.layers.reduce((s, l) => s + l.remainingQty * l.unitCostMinor, 0));
});

// --- internal transfers: value must survive moving your own stock -------------------------------
//
// THE DEFECT THIS BLOCK EXISTS FOR. J02's `inventory_transfer` leaves `unit_cost_minor` NULL on both
// legs, which is right: relocating a pallet is not a purchase. Valuation used to read the raw stream,
// so FIFO consumed the oldest layer on the way out and opened nothing on the way in. Reproduced end
// to end with the real verbs before the fix: one receipt of 100 at 1000, then a transfer of 30, and
// the item-level figure fell from CHF 1'000.00 to CHF 700.00 with `reason: null`, so Studio rendered
// a clean number and J06 is specified to take it to the general ledger. Nothing had been bought,
// sold, consumed or scrapped.

test('J03 F1: an internal transfer does not move the item-level figure, under ANY enabled method', () => {
  const receipt = mv('m1', '2026-01-10', 100, 1000, 'loc_a');
  const before = [receipt];
  const after = [receipt, ...transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b')];

  for (const method of ['weighted_average', 'fifo', 'standard_cost']) {
    const opts = { standardCostMinor: 900 };
    const b = calculateItemValue(snap(method, before, opts), CTX);
    const a = calculateItemValue(snap(method, after, opts), CTX);
    assert.equal(a.qtyOnHand, b.qtyOnHand, `${method}: a transfer is quantity-neutral at item level`);
    assert.equal(
      a.totalValueMinor,
      b.totalValueMinor,
      `${method}: moving your own stock must not change what it is worth`,
    );
    assert.equal(a.reason, b.reason, `${method}: and it must not invent a reason either`);
    assert.deepEqual(a.warnings, b.warnings, `${method}: nor a warning about a cost that was never missing`);
  }
});

test('J03 F1: the exact numbers from the reproduction, pinned', () => {
  const after = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), ...transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b')];
  const r = calculateItemValue(snap('fifo', after), CTX);
  assert.equal(r.qtyOnHand, 100);
  assert.equal(r.totalValueMinor, 100_000, 'CHF 1000.00, not the CHF 700.00 the defect reported');
  assert.equal(r.reason, null);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.missingCostMovementIds, [], 'a transfer leg is not a missing cost');
});

test('J03 F1: cost follows the goods, so each location carries what it actually holds', () => {
  const stream = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), ...transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b')];
  const a = calculateItemValue(snap('fifo', stream, { locationId: 'loc_a' }), CTX);
  const b = calculateItemValue(snap('fifo', stream, { locationId: 'loc_b' }), CTX);

  assert.equal(a.qtyOnHand, 70);
  assert.equal(a.totalValueMinor, 70_000);
  assert.equal(b.qtyOnHand, 30);
  assert.equal(b.totalValueMinor, 30_000, 'the destination inherits the cost the source gave up');
  assert.equal(b.layers.length, 1);
  assert.equal(b.layers[0].unitCostMinor, 1000, 'at the ORIGINAL unit cost, not at nothing');
  assert.deepEqual(b.warnings, [], 'and the destination is not reported as uncosted');
  // The two locations partition the item, so the breakdown reconciles to the total exactly.
  const whole = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(a.totalValueMinor + b.totalValueMinor, whole.totalValueMinor);
  assert.equal(a.qtyOnHand + b.qtyOnHand, whole.qtyOnHand);
});

test('J03 F1: weighted average at a location also inherits, rather than seeing an uncosted receipt', () => {
  // Through `calculateItemByLocation`, which is the only door to a pooled method's location figure.
  const stream = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), ...transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b')];
  const [a, b] = calculateItemByLocation(snap('weighted_average', stream), CTX, ['loc_a', 'loc_b']);
  assert.equal(b.qtyOnHand, 30);
  assert.equal(b.unitCostMinor, 1000);
  assert.equal(b.totalValueMinor, 30_000, 'the destination carries what it inherited, not nothing');
  assert.deepEqual(b.warnings, [], 'a transfer leg is not a missing cost');
  assert.equal(a.totalValueMinor + b.totalValueMinor, 100_000, 'and the two sides still sum to the item');
});

test('J03 F1: a transfer moves the layers it really consumed, oldest first, at their own costs', () => {
  const stream = [
    mv('m1', '2026-01-01', 40, 1000, 'loc_a'),
    mv('m2', '2026-01-05', 40, 2000, 'loc_a'),
    ...transferPair('grp1', '2026-02-01', 50, 'loc_a', 'loc_b'),
  ];
  const b = calculateItemValue(snap('fifo', stream, { locationId: 'loc_b' }), CTX);
  // FIFO at the source gives up all 40 of the cheap layer and 10 of the dearer one.
  assert.equal(b.qtyOnHand, 50);
  assert.equal(b.totalValueMinor, 40 * 1000 + 10 * 2000);
  assert.deepEqual(
    b.layers.map((l) => [l.remainingQty, l.unitCostMinor]),
    [
      [40, 1000],
      [10, 2000],
    ],
  );
  const a = calculateItemValue(snap('fifo', stream, { locationId: 'loc_a' }), CTX);
  assert.equal(a.totalValueMinor, 30 * 2000, 'what stayed behind is the dear remainder');
  assert.equal(a.totalValueMinor + b.totalValueMinor, 40 * 1000 + 40 * 2000, 'value is conserved by the move');
});

test('J03 F1: an issue AFTER a transfer consumes the destination layers it inherited', () => {
  const stream = [
    mv('m1', '2026-01-01', 100, 1000, 'loc_a'),
    ...transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b'),
    mv('m4', '2026-03-01', -10, null, 'loc_b'),
  ];
  const r = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(r.qtyOnHand, 90);
  assert.equal(r.totalValueMinor, 90_000, 'the issue costs 1000 a unit, because that is what it cost');
  assert.equal(r.reason, null, 'and it is NOT an over-consumption of an empty queue');
  assert.deepEqual(r.warnings, []);
});

test('J03 F1b: what a transfer DELIVERED is fixed at arrival, not re-read after later issues', () => {
  // THE ALIASING DEFECT. `inheritedByLeg` used to store the live layer objects that stay in the
  // destination queue, and `consume()` mutates those objects as later movements are processed. The
  // tally then read `remainingQty` AFTER the whole stream had run, so a transfer of 100 followed by
  // an issue of 40 at the destination looked like a transfer that had only ever delivered 60. The
  // cost pool shrank, the missing 40 were reported as uncosted, and the location figure came out
  // CHF 133.33 HIGH while the item-level figure for the same stream was right: the engine disagreed
  // with itself. Nothing in the suite moved either way, which is why this test exists.
  const stream = [
    mv('m1', '2026-01-10', 100, 1000, 'loc_a'),
    ...transferPair('grp1', '2026-02-01', 100, 'loc_a', 'loc_b'),
    mv('m4', '2026-03-01', -40, null, 'loc_b'),
    mv('m5', '2026-04-01', 50, 2000, 'loc_b'),
  ];

  const [, atB] = calculateItemByLocation(snap('weighted_average', stream), CTX, ['loc_a', 'loc_b']);
  assert.equal(atB.qtyOnHand, 110);
  // The pool is what ARRIVED (100 at 1000) plus what was bought there (50 at 2000) = 200_000 over
  // 150 units. 110 units of that is 146_667, not the 160_000 the aliased read produced.
  assert.equal(atB.totalValueMinor, 146_667);
  assert.deepEqual(atB.warnings, [], 'nothing here is uncosted');
  assert.deepEqual(atB.missingCostMovementIds, [], 'and the diagnostic must not name an innocent row');

  // The whole point: the two scopes agree about the same stream.
  const whole = calculateItemValue(snap('weighted_average', stream), CTX);
  assert.equal(whole.totalValueMinor, atB.totalValueMinor, 'the engine must not disagree with itself');
});

test('J03 F1b: standard-cost variance at a location is fixed at arrival too', () => {
  // The same aliasing made the variance depend on what was issued LATER, which is not what a
  // purchase-price variance is.
  const stream = [
    mv('m1', '2026-01-10', 100, 1000, 'loc_a'),
    ...transferPair('grp1', '2026-02-01', 100, 'loc_a', 'loc_b'),
    mv('m4', '2026-03-01', -40, null, 'loc_b'),
    mv('m5', '2026-04-01', 50, 2000, 'loc_b'),
  ];
  const [, atB] = calculateItemByLocation(snap('standard_cost', stream, { standardCostMinor: 1500 }), CTX, [
    'loc_a',
    'loc_b',
  ]);
  // Received at B: 100 at 1000 plus 50 at 2000 = 200_000 actual, against 150 x 1500 = 225_000
  // standard, so the variance is -25_000. Re-reading the remainder gave -5_000 and moved with the
  // issue. The variance is a per-location diagnostic and survives the value allocation untouched.
  assert.equal(atB.varianceMinor, -25_000);
});

test('J03 F4: a location answers for its OWN shortfall, not the item-wide one', () => {
  // loc_a is genuinely short (60 issued against 40 received); loc_b holds 100 fully costed units and
  // has nothing to do with it. The item-wide shortfall used to be stamped on every location's result.
  const stream = [
    mv('m1', '2026-01-01', 40, 1000, 'loc_a'),
    mv('m2', '2026-01-02', -60, null, 'loc_a'),
    mv('m3', '2026-01-03', 100, 500, 'loc_b'),
  ];

  const atB = calculateItemValue(snap('fifo', stream, { locationId: 'loc_b' }), CTX);
  assert.equal(atB.qtyOnHand, 100);
  assert.equal(atB.totalValueMinor, 50_000);
  assert.equal(atB.reason, null, "loc_b is not short of anything, so it must not claim to be");
  assert.ok(!atB.warnings.includes('insufficient_layers'));

  const atA = calculateItemValue(snap('fifo', stream, { locationId: 'loc_a' }), CTX);
  assert.equal(atA.reason, 'negative_quantity', 'and loc_a still reports its own trouble');

  // The item as a whole IS short, and says so.
  const whole = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(whole.reason, 'insufficient_layers');
});

test('J03 F4: an empty location says zero_quantity, not insufficient_layers', () => {
  const stream = [
    mv('m1', '2026-01-01', 10, 1000, 'loc_a'),
    mv('m2', '2026-01-02', -20, null, 'loc_a'),
    mv('m3', '2026-01-03', 10, 1000, 'loc_a'),
  ];
  // loc_b has never held anything: the honest answer is that it is empty, not that it overdrew.
  const atB = calculateItemValue(snap('fifo', stream, { locationId: 'loc_b' }), CTX);
  assert.equal(atB.qtyOnHand, 0);
  assert.equal(atB.reason, 'zero_quantity');
  assert.ok(!atB.warnings.includes('insufficient_layers'));
});

test('J03 F1: a transfer that carries a stated unit cost is ignored, and reported', () => {
  // Honouring a cost stated on one leg while the other consumed the real layers would change what an
  // item is worth by moving it, which is the whole defect in a different coat.
  const stream = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), ...transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b', 9999)];
  const r = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(r.totalValueMinor, 100_000, 'the stated 9999 does not enter the valuation');
  assert.ok(r.warnings.includes('transfer_cost_ignored'), 'and the caller is told it was ignored');
});

test('J03 F5: a group carrying three legs is refused as a group, not paired two-of-three', () => {
  // Overwriting one leg with another pairs two arbitrarily and hands the loser to ordinary handling,
  // which is the cost-destruction defect again on whichever leg lost the draw. The fixture is built
  // so the WRONG pairing produces a DIFFERENT NUMBER: the stray leg sits at a location holding dearer
  // stock, so pairing it would carry 30 units at 2000 to the destination instead of nothing.
  const [out, into] = transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b');
  const stray = { ...out, id: 'grp1-out2', locationId: 'loc_c' };
  const r = calculateItemValue(
    snap('fifo', [
      mv('m1', '2026-01-10', 100, 1000, 'loc_a'),
      mv('m2', '2026-01-11', 100, 2000, 'loc_c'),
      out,
      stray,
      into,
    ]),
    CTX,
  );
  assert.ok(r.warnings.includes('unpaired_transfer_leg'), 'the whole group is reported, not silently repaired');
  assert.equal(r.qtyOnHand, 170);
  // Every leg fell back to ordinary handling: loc_a keeps 70 at 1000, loc_c keeps 70 at 2000, and the
  // inbound leg opens no layer because nothing was matched to it. Pairing two of the three would
  // report 270_000 instead, by carrying cost that no identified movement released.
  assert.equal(r.totalValueMinor, 210_000);
});

test('J03 F1: a transfer leg whose partner is missing is not silently paired with anything', () => {
  const [out] = transferPair('grp1', '2026-02-01', 30, 'loc_a', 'loc_b');
  const r = calculateItemValue(snap('fifo', [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), out]), CTX);
  assert.ok(r.warnings.includes('unpaired_transfer_leg'));
  // It falls back to ordinary handling, so the quantity still matches the ledger rather than a guess.
  assert.equal(r.qtyOnHand, 70);
  assert.equal(r.totalValueMinor, 70_000);
});

// --- purity -------------------------------------------------------------------------------------

test('J03: the calculators are referentially transparent and do not mutate their input', () => {
  const movements = [mv('m1', '2026-01-01', 40, 700), mv('m2', '2026-01-02', -10), mv('m3', '2026-01-03', 5, 900)];
  const frozen = JSON.stringify(movements);
  const a = calculateItemValue(snap('fifo', movements), CTX);
  const b = calculateItemValue(snap('fifo', movements), CTX);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same input, same bytes');
  assert.equal(JSON.stringify(movements), frozen, 'the snapshot the caller passed is untouched');
});

test('J03: a batch is exactly its rows, so a roll-up cannot disagree with what it sums', () => {
  const snaps = [
    snap('weighted_average', [mv('a1', '2026-01-01', 10, 100)]),
    { ...snap('fifo', [mv('b1', '2026-01-01', 5, 200)]), itemId: 'it_2', itemName: 'Bolt' },
  ];
  const batch = calculateValuationBatch(snaps, CTX);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].totalValueMinor, 1000);
  assert.equal(batch[1].totalValueMinor, 1000);
  assert.equal(
    batch.reduce((s, r) => s + r.totalValueMinor, 0),
    calculateItemValue(snaps[0], CTX).totalValueMinor + calculateItemValue(snaps[1], CTX).totalValueMinor,
  );
});

// --- refusals, never silent answers -------------------------------------------------------------

test('J03: a negative unit cost is refused, not computed', () => {
  const r = calculateItemValue(snap('weighted_average', [mv('m1', '2026-01-01', 10, -500)]), CTX);
  assert.equal(r.reason, 'invalid_unit_cost');
  assert.equal(r.totalValueMinor, 0);
});

test('J03: a negative on-hand carries no positive book value, and says why', () => {
  for (const method of ['weighted_average', 'fifo', 'standard_cost']) {
    const r = calculateItemValue(
      snap(method, [mv('m1', '2026-01-01', 10, 500), mv('m2', '2026-01-02', -15)], { standardCostMinor: 400 }),
      CTX,
    );
    assert.equal(r.qtyOnHand, -5, `${method} still reports the real quantity`);
    assert.equal(r.totalValueMinor, 0, `${method} refuses to book a short position`);
    assert.equal(r.reason, 'negative_quantity');
    assert.ok(r.warnings.includes('negative_on_hand'));
  }
});

test('J03: standard cost with no standard set refuses instead of guessing one', () => {
  const r = calculateItemValue(snap('standard_cost', [mv('m1', '2026-01-01', 10, 500)]), CTX);
  assert.equal(r.reason, 'missing_standard_cost');
  assert.equal(r.totalValueMinor, 0);
});

test('J03: an uncosted receipt is valued at zero and NAMED, never at the neighbours price', () => {
  const r = calculateItemValue(
    snap('weighted_average', [mv('m1', '2026-01-01', 10, 500), mv('m2', '2026-01-02', 10)]),
    CTX,
  );
  assert.equal(r.qtyOnHand, 20);
  assert.equal(r.costedQty, 10, 'the cost pool covers ten units and no more');
  assert.equal(r.uncostedQty, 10);
  assert.equal(r.totalValueMinor, 5000, 'not 20 x 500');
  assert.ok(r.warnings.includes('missing_unit_cost'));
  // The warning names the row. Without this an operator can see that something is uncosted and never
  // which movement, which is exactly the diagnostic the transfer defect needed.
  assert.deepEqual(r.missingCostMovementIds, ['m2']);
});

test('J03: a clean stream names no movements, so the id list cannot be decoration', () => {
  const r = calculateItemValue(snap('weighted_average', [mv('m1', '2026-01-01', 10, 500)]), CTX);
  assert.deepEqual(r.missingCostMovementIds, []);
  assert.deepEqual(r.warnings, []);
});

test('J03: the weighted-average cap assumes issues took the UNCOSTED units first, and says so', () => {
  // The §2 worked example for the stated assumption (F5). 50 costed at 1000, 50 uncosted, issue 60.
  // The 40 that remain are all valued at 1000 rather than treated as worthless: value-maximising, not
  // prudent. It is bounded by the cost pool, so OR 960a Abs. 2 holds, and it is never silent.
  const r = calculateItemValue(
    snap('weighted_average', [
      mv('m1', '2026-01-01', 50, 1000),
      mv('m2', '2026-01-02', 50),
      mv('m3', '2026-01-03', -60),
    ]),
    CTX,
  );
  assert.equal(r.qtyOnHand, 40);
  assert.equal(r.totalValueMinor, 40_000, 'the documented assumption, pinned so a change is deliberate');
  assert.ok(r.totalValueMinor <= 50_000, 'and it can never exceed the cost pool');
  assert.ok(r.warnings.includes('missing_unit_cost'), 'a stream where the assumption bites always says so');
  assert.deepEqual(r.missingCostMovementIds, ['m2']);
});

test('J03: zero on-hand is zero value with a reason, and still reports the pool average', () => {
  const r = calculateItemValue(
    snap('weighted_average', [mv('m1', '2026-01-01', 10, 500), mv('m2', '2026-01-02', -10)]),
    CTX,
  );
  assert.equal(r.totalValueMinor, 0);
  assert.equal(r.reason, 'zero_quantity');
  assert.equal(r.unitCostMinor, 500);
});

// --- OR 960c ------------------------------------------------------------------------------------

test('J03: the OR 960c clamp lowers to net realisable value and reports the write-down', () => {
  const r = calculateItemValue(snap('weighted_average', [mv('m1', '2026-01-01', 100, 1000)]), {
    asOf: '2026-12-31',
    netRealisableValueMinor: 800,
  });
  assert.equal(r.lcmApplied, true);
  assert.equal(r.unitCostMinor, 800);
  assert.equal(r.totalValueMinor, 80_000);
  assert.equal(r.writeDownMinor, 20_000);
});

test('J03: an NRV at or above cost changes nothing (OR 960a Abs. 2: never write up)', () => {
  for (const nrv of [1000, 1500]) {
    const r = calculateItemValue(snap('weighted_average', [mv('m1', '2026-01-01', 100, 1000)]), {
      asOf: '2026-12-31',
      netRealisableValueMinor: nrv,
    });
    assert.equal(r.lcmApplied, false, `NRV ${nrv} must not raise a value`);
    assert.equal(r.totalValueMinor, 100_000);
    assert.equal(r.writeDownMinor, 0);
  }
});

test('J03: the clamp scales the COSTED quantity, so it can never raise a value above cost', () => {
  // 50 costed units at 1000 (value 50_000) plus 50 uncosted (value 0): on-hand is 100. Clamping the
  // raw on-hand at an NRV of 900 would give 90_000, which is MORE than the cost the pool supports.
  const r = calculateItemValue(
    snap('weighted_average', [mv('m1', '2026-01-01', 50, 1000), mv('m2', '2026-01-02', 50)]),
    { asOf: '2026-12-31', netRealisableValueMinor: 900 },
  );
  assert.ok(r.totalValueMinor <= 50_000, 'a write-down cannot write anything up');
  assert.equal(r.totalValueMinor, 45_000, '50 costed units at the NRV');
  assert.equal(r.writeDownMinor, 5_000);
});

test('J03: the OR 960c comparison is made on the ITEM POSITION, not layer by layer', () => {
  // REVISED 2026-08-11 after reading the sources. An earlier round clamped each layer separately on a
  // truncated reading of OR 960 Abs. 1. The clause that was cut ("und aufgrund ihrer Gleichartigkeit
  // für die Bewertung nicht üblicherweise als Gruppe zusammengefasst werden") is the one that
  // governs interchangeable units of one article, and the commentary calls stock that loses its
  // separate identity the Musterfall of Gleichartigkeit. Within one Bilanzposition a cheap lot may
  // carry a dear one, capped at historical cost.
  //
  // 200 units costing 300_000 in total, sellable at 1600 each: 320_000 realisable against 300_000
  // cost, so nothing is written down even though one layer individually sits above the NRV.
  const stream = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), mv('m2', '2026-01-11', 100, 2000, 'loc_b')];
  const ctx = { asOf: '2026-12-31', netRealisableValueMinor: 1600 };

  const whole = calculateItemValue(snap('fifo', stream), ctx);
  assert.equal(whole.totalValueMinor, 300_000, 'the position is worth more than it cost, so cost stands');
  assert.equal(whole.writeDownMinor, 0);
  assert.equal(whole.lcmApplied, false);
});

test('J03: a position genuinely below its cost IS written down, as a position', () => {
  // The complement, so group valuation cannot become a way of never writing anything down: the same
  // 200 units at a net realisable value of 1200 realise 240_000 against 300_000 of cost.
  const stream = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), mv('m2', '2026-01-11', 100, 2000, 'loc_b')];
  const ctx = { asOf: '2026-12-31', netRealisableValueMinor: 1200 };
  const whole = calculateItemValue(snap('fifo', stream), ctx);
  assert.equal(whole.lcmApplied, true);
  assert.equal(whole.totalValueMinor, 240_000);
  assert.equal(whole.writeDownMinor, 60_000);
});

test('J03 F1: FIFO never values more units than the ledger says are on hand', () => {
  // An issue dated BEFORE the receipt that funds it is accepted by inventory_move, because the
  // insufficient_stock guard tests availability today rather than as of the movement date. The issue
  // then consumes an empty queue and the later receipt opens a layer nobody ever consumed, so the
  // layers held 100 while on-hand was 40 and the item was valued at 100_000 against the 40_000 that
  // weighted average and standard cost both returned. Reason `insufficient_layers` was set, and the
  // number was still summed into the workspace total and still handed to J06.
  const stream = [mv('m2', '2026-01-01', -60, null, 'loc_a'), mv('m1', '2026-01-02', 100, 1000, 'loc_a')];

  const r = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(r.qtyOnHand, 40);
  assert.equal(r.totalValueMinor, 40_000, 'the excess is trimmed from the OLDEST end, which is what FIFO means');
  assert.equal(
    r.layers.reduce((s, l) => s + l.remainingQty, 0),
    40,
    'and the layers agree with the quantity they are supposed to explain',
  );
  assert.equal(
    r.layers.reduce((s, l) => s + l.remainingQty * l.unitCostMinor, 0),
    r.totalValueMinor,
  );

  // The three methods now answer the same question the same way, which is the property that broke.
  assert.equal(calculateItemValue(snap('weighted_average', stream), CTX).totalValueMinor, 40_000);
  assert.equal(
    calculateItemValue(snap('standard_cost', stream, { standardCostMinor: 1000 }), CTX).totalValueMinor,
    40_000,
  );
});

test('J03 F1: the trim takes the OLDEST layers, so what is left is the most recent cost', () => {
  const stream = [
    mv('i1', '2026-01-01', -30, null, 'loc_a'),
    mv('m1', '2026-01-02', 20, 1000, 'loc_a'),
    mv('m2', '2026-01-03', 20, 3000, 'loc_a'),
  ];
  const r = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(r.qtyOnHand, 10);
  // 40 units of layers against 10 on hand: the 20 at 1000 go first, then 10 of the 3000.
  assert.equal(r.totalValueMinor, 30_000);
  assert.deepEqual(
    r.layers.map((l) => [l.remainingQty, l.unitCostMinor]),
    [[10, 3000]],
  );
});

test('J03 F3: the exported entry point refuses a location scope it cannot answer directly', () => {
  // It is exported and J06 is the next consumer, so a plausible wrong number is the danger. FIFO can
  // answer a location directly; the pooled methods cannot without minting a second cost pool.
  const stream = [mv('m1', '2026-01-10', 100, 1000, 'loc_a'), mv('m2', '2026-01-11', 100, 2000, 'loc_b')];
  for (const method of ['weighted_average', 'standard_cost']) {
    const r = calculateItemValue(snap(method, stream, { locationId: 'loc_a', standardCostMinor: 900 }), CTX);
    assert.equal(r.reason, 'location_needs_allocation');
    assert.equal(r.totalValueMinor, 0, 'a refusal, not a second pool');
  }
  // FIFO still answers, because its layers really do belong to the location.
  assert.equal(calculateItemValue(snap('fifo', stream, { locationId: 'loc_a' }), CTX).totalValueMinor, 100_000);
});

test('J03 F2: the item cap falls on the SHORT location, not the globally-oldest layer', () => {
  // loc_a is not short (100 at 1000, on-hand 100); loc_b has a backdated issue that leaves it holding
  // more layers than on-hand (receipt 50 at 2000, issue -30 dated before it, on-hand 20). Capping the
  // MERGED item queue against the item total would trim 30 from the oldest = loc_a's cheap stock and
  // report 170_000. The cap must fall on loc_b's own oldest, giving 100 at 1000 + 20 at 2000.
  // DATE ORDER, which is what the policy layer feeds the calculator: the backdated issue (01-15) is
  // processed BEFORE its funding receipt (01-20), so it consumes an empty queue as a shortfall and
  // the receipt then leaves loc_b holding more layers than on-hand. Feeding these in array order
  // instead would let the issue consume its own receipt in place and the bug would not form, so the
  // order is load-bearing to the test, not incidental.
  const stream = [
    mv('a', '2026-01-10', 100, 1000, 'loc_a'),
    mv('bi', '2026-01-15', -30, null, 'loc_b'),
    mv('b', '2026-01-20', 50, 2000, 'loc_b'),
  ];
  const item = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(item.qtyOnHand, 120);
  assert.equal(item.totalValueMinor, 140_000, 'not 170_000: loc_a keeps its cheap stock');

  const rows = calculateItemByLocation(snap('fifo', stream), CTX, ['loc_a', 'loc_b']);
  assert.deepEqual(
    rows.map((r) => [r.locationId, r.totalValueMinor]),
    [
      ['loc_a', 100_000],
      ['loc_b', 40_000],
    ],
  );
  // The item equals the sum of its locations, which is the property F2 broke.
  assert.equal(
    rows.reduce((s, r) => s + r.totalValueMinor, 0),
    item.totalValueMinor,
  );
  // These rows are additive, so the breakdown returns them DIRECT rather than reallocating, which is
  // the case the round-5 anyShort trigger had to leave alone.
  assert.ok(rows.every((r) => r.valuationBasis === 'direct'));
});

test('J03 F3: a NET-SHORT location forces the FIFO breakdown through the allocation', () => {
  // loc_b is net negative (issue -20, no receipt), so the item nets it in (on-hand 80) while loc_b
  // itself holds no positive book value. The rows cannot be returned direct: loc_a direct is 100_000
  // and the item is 80_000, so direct rows would not sum to the item. This bites on `anyShort`.
  const stream = [mv('a', '2026-01-10', 100, 1000, 'loc_a'), mv('bi', '2026-01-15', -20, null, 'loc_b')];
  const item = calculateItemValue(snap('fifo', stream), CTX);
  assert.equal(item.qtyOnHand, 80);
  assert.equal(item.totalValueMinor, 80_000);

  const rows = calculateItemByLocation(snap('fifo', stream), CTX, ['loc_a', 'loc_b']);
  assert.ok(rows.every((r) => r.valuationBasis === 'allocated'), 'reconciled, not returned direct');
  const short = rows.find((r) => r.locationId === 'loc_b');
  assert.equal(short.qtyOnHand, -20);
  assert.equal(short.totalValueMinor, 0, 'the short location takes no share');
  assert.equal(
    rows.reduce((s, r) => s + r.totalValueMinor, 0),
    item.totalValueMinor,
    'and the rows sum to the item total',
  );
});

test('J03 F3: a CLAMPED FIFO item forces the breakdown through the allocation', () => {
  // The item is written down as a position (200 units cost 300_000, NRV 1200 gives 240_000), so the
  // per-location FIFO rows at their own layer costs would NOT sum to the clamped item total. This
  // bites on the `!item.lcmApplied` half of the trigger.
  const stream = [mv('a', '2026-01-10', 100, 1000, 'loc_a'), mv('b', '2026-01-11', 100, 2000, 'loc_b')];
  const ctx = { asOf: '2026-12-31', netRealisableValueMinor: 1200 };
  const item = calculateItemValue(snap('fifo', stream), ctx);
  assert.equal(item.lcmApplied, true);
  assert.equal(item.totalValueMinor, 240_000);

  const rows = calculateItemByLocation(snap('fifo', stream), ctx, ['loc_a', 'loc_b']);
  assert.ok(rows.every((r) => r.valuationBasis === 'allocated'), 'a clamped item is reconciled, not direct');
  assert.ok(rows.every((r) => r.lcmApplied === true));
  assert.equal(
    rows.reduce((s, r) => s + r.totalValueMinor, 0),
    240_000,
    'the rows sum to the WRITTEN-DOWN item total',
  );
});

test('J03 F4: the clamp DECISION is exact, never taken against the rounded unit cost', () => {
  // 2 at 1000 and 1 at 1001: the pool is 3001 over 3, an exact average of 1000.333 that DISPLAYS as
  // 1000. An NRV of 1000 therefore looked equal-or-above and suppressed a compulsory write-down. The
  // band scales with quantity, which is the same drift class rule (2) forbids in the total.
  const stream = [mv('m1', '2026-01-01', 2, 1000), mv('m2', '2026-01-02', 1, 1001)];
  const r = calculateItemValue(snap('weighted_average', stream), { asOf: '2026-12-31', netRealisableValueMinor: 1000 });
  assert.equal(r.unitCostMinor, 1000, 'the DISPLAYED cost rounds to exactly the NRV');
  assert.equal(r.lcmApplied, true, 'and the clamp still fires, because the real cost is above it');
  assert.equal(r.totalValueMinor, 3000);
  assert.equal(r.writeDownMinor, 1);
});

test('J03 F4: an NRV genuinely at cost still changes nothing', () => {
  // The complement, so the fix cannot be "always clamp": an exact average of 1000 against an NRV of
  // 1000 must leave the figure alone.
  const r = calculateItemValue(snap('weighted_average', [mv('m1', '2026-01-01', 3, 1000)]), {
    asOf: '2026-12-31',
    netRealisableValueMinor: 1000,
  });
  assert.equal(r.lcmApplied, false);
  assert.equal(r.totalValueMinor, 3000);
  assert.equal(r.writeDownMinor, 0);
});

test('J03: a negative net realisable value is refused, never booked as a negative asset', () => {
  const r = calculateItemValue(snap('weighted_average', [mv('m1', '2026-01-01', 10, 500)]), {
    asOf: '2026-12-31',
    netRealisableValueMinor: -1,
  });
  assert.equal(r.reason, 'invalid_net_realisable_value');
  assert.equal(r.totalValueMinor, 0);
});

// --- the §H-ENUM --------------------------------------------------------------------------------

test('J03: the method enum accepts the D01 alias on read and nothing else', () => {
  assert.deepEqual([...VALUATION_METHODS], ['weighted_average', 'fifo', 'standard_cost']);
  assert.equal(normaliseMethod('weighted_avg'), 'weighted_average', 'the D01 / OP2 key still resolves');
  assert.equal(normaliseMethod('fifo'), 'fifo');
  assert.equal(normaliseMethod('lifo'), undefined, 'OR would tolerate it; TILL does not ship it');
  assert.equal(normaliseMethod(''), undefined);
  assert.equal(normaliseMethod(null), undefined);
});
