/**
 * The SALDO LADDER drift guard: the Studio's copy of the ESTV ladder is the engine's current era.
 *
 * `app/src/surfaces/VatSettings/model.ts` hard-codes `ESTV_SALDO_LADDER` so its rate picker has
 * something to render, and it cannot import `src/core/vat/rateEras.ts` because the Studio is a
 * separate Vite build with no path into the engine sources. That leaves a copy of a statutory table
 * with nothing holding it to the original.
 *
 * The copy is not harmless. SR 641.202.62 was REBASED with effect 1.1.2024 and the 2018 ladder
 * differs from the current one on six of its ten rungs, so the two drifting apart is the ordinary
 * consequence of the next rebase rather than a hypothetical. When they drift the picker offers rungs
 * the engine answers with `invalid_saldo_rate`, and omits rungs it would have accepted: the operator
 * sees a rate list that is simply wrong, with nothing failing until a save is refused.
 *
 * This is a TEXT guard on purpose. Importing the Studio module would need the Vite/TSX pipeline in a
 * node:test run; reading the literal is enough, because the literal is the thing that drifts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { VAT_RATE_ERAS } from '../../dist/core/vat/rateEras.js';

const MODEL = new URL('../../app/src/surfaces/VatSettings/model.ts', import.meta.url);

/** The `ESTV_SALDO_LADDER` array literal, read out of the Studio source. */
function studioLadder() {
  const src = readFileSync(MODEL, 'utf8');
  const match = src.match(/export const ESTV_SALDO_LADDER: readonly number\[\] = \[([^\]]*)\]/);
  assert.notEqual(
    match,
    null,
    'ESTV_SALDO_LADDER was renamed or reshaped in app/src/surfaces/VatSettings/model.ts. ' +
      'Update this guard rather than deleting it: the copy still needs holding to the engine.',
  );
  return (match[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
}

/** The era in force today, which is the only one the surface can configure (it sends no `asOf`). */
function currentEra() {
  const today = new Date().toISOString().slice(0, 10);
  const applicable = VAT_RATE_ERAS.filter((e) => e.effectiveFrom <= today);
  assert.ok(applicable.length > 0, 'no VAT rate era is in force today');
  return applicable[applicable.length - 1];
}

test('the Studio ladder is the engine ladder for the era in force', () => {
  const era = currentEra();
  assert.deepEqual(
    studioLadder(),
    [...era.saldoLadderBp],
    `app/src/surfaces/VatSettings/model.ts offers a different Saldosteuersatz ladder than ` +
      `src/core/vat/rateEras.ts holds for the era from ${era.effectiveFrom}. The engine is the law; ` +
      `copy its rungs into the Studio constant.`,
  );
});

test('the ladder guard is reading real values, not an empty match', () => {
  // CHECK YOUR OWN PROBE. A regex that quietly matched nothing would make the assertion above pass
  // by comparing two empty arrays, which is the shape of guard that reports green forever.
  const ladder = studioLadder();
  assert.ok(ladder.length >= 8, `expected a full ESTV ladder, read ${ladder.length} rungs`);
  assert.ok(
    ladder.every((bp) => Number.isInteger(bp) && bp > 0),
    `every rung is a positive integer basis-point value, read ${JSON.stringify(ladder)}`,
  );
  assert.ok(
    ladder.every((bp, i) => i === 0 || bp > ladder[i - 1]),
    `the ladder ascends, read ${JSON.stringify(ladder)}`,
  );
});

test('the engine ladder differs across eras, which is why the copy needs a guard at all', () => {
  // The premise of this file, asserted rather than believed. If every era carried the same rungs a
  // hard-coded copy would be harmless and this guard would be theatre.
  const ladders = VAT_RATE_ERAS.filter((e) => e.saldoLadderBp.length > 0).map((e) => e.saldoLadderBp.join(','));
  assert.ok(ladders.length >= 2, 'expected at least two published eras with a ladder');
  assert.notEqual(ladders[0], ladders[1], 'the 2018 and 2024 ladders are meant to differ (AS 2023 18)');
});
