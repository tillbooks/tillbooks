/**
 * The tax-codes fixture-versus-engine drift guard.
 *
 * The browser flows (UX gate, 2026-07-20) found every VAT dropdown outside the Journal empty
 * against a live engine: `vat_codes` answers `{ok, taxCodes: [...]}` while Items and Accounts read
 * `body.vatCodes` and VatSettings read `body.codes ?? body.vatCodes`. The jsdom fixtures used the
 * same wrong keys, the two mistakes cancelled, and 216 green tests proved nothing about the live
 * shape: the fourth member of the assumed-shape bug family.
 *
 * Same contract as test/setup/profile-fixture.test.mjs: the app suite renders
 * `tax-codes.fixture.json` and NOTHING else, and this test pins that fixture to the real engine
 * response, keys AND kinds (null its own kind), against the LIVE seeded set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat, listTaxCodes } from '../../dist/core/vat/index.js';
import { setup } from '../setup/support.mjs';

const FIXTURE_PATH = new URL('../../app/src/surfaces/VatSettings/tax-codes.fixture.json', import.meta.url);

function keysOf(obj) {
  return Object.keys(obj).sort();
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

test('the tax-codes fixture matches the live seeded engine response, keys and kinds', () => {
  const { deps, ctxFor } = setup();
  const ctx = ctxFor(createWorkspace(deps, { name: 'Muster Grafik' }).workspaceId);
  assert.equal(
    configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'guard' }).ok,
    true,
  );
  const live = listTaxCodes(ctx);
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  // The envelope: the list is under `taxCodes`, and a fixture using `vatCodes` or `codes` is the
  // original defect.
  assert.deepEqual(keysOf(fixture), keysOf(live), 'the fixture envelope drifted from vat_codes');
  assert.equal(fixture.ok, true);
  assert.equal(kindOf(fixture.taxCodes), 'array');

  assert.equal(fixture.taxCodes.length, live.taxCodes.length, 'seeded code count drifted');
  for (let i = 0; i < live.taxCodes.length; i += 1) {
    const liveRow = live.taxCodes[i];
    const fixtureRow = fixture.taxCodes[i];
    assert.deepEqual(keysOf(fixtureRow), keysOf(liveRow), `row ${i} (${liveRow.code}) key drift`);
    for (const key of Object.keys(liveRow)) {
      assert.equal(
        kindOf(fixtureRow[key]),
        kindOf(liveRow[key]),
        `kind drift at taxCodes[${i}].${key}: fixture ${kindOf(fixtureRow[key])}, engine ${kindOf(liveRow[key])}`,
      );
    }
    assert.equal(fixtureRow.code, liveRow.code, `row ${i} code drifted`);
  }
});
