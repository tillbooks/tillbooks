/**
 * The Studio-corpus drift guard: `app/src/lib/guidance-corpus.generated.json` must still be the
 * projection `scripts/generate-guidance-corpus.mjs` produces from the engine's corpus and the
 * era-scoped Saldo limits. The Studio cannot import engine sources, so it ships a copy; a copy is
 * held true rather than trusted (the ESTV_SALDO_LADDER / command-source precedent). Regenerate with
 * `npm run generate:guidance`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CONCEPTS } from '../../dist/core/guidance/corpus.js';
import { SALDO_ELIGIBILITY_ERAS } from '../../dist/core/vat/rateEras.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('the Studio projection matches the engine corpus byte for byte (npm run generate:guidance)', () => {
  const generated = JSON.parse(
    readFileSync(join(ROOT, 'app/src/lib/guidance-corpus.generated.json'), 'utf8'),
  );
  assert.deepEqual(
    generated.concepts,
    JSON.parse(JSON.stringify(CONCEPTS)),
    'the panel a human reads and the payload an agent cites must be ONE wording: regenerate the projection',
  );
  assert.deepEqual(
    generated.saldoEligibilityEras,
    JSON.parse(JSON.stringify(SALDO_ELIGIBILITY_ERAS)),
    'the interpolated limits must be the engine\'s own era table: regenerate the projection',
  );
});
