/**
 * The vat_preview fixture-versus-engine drift guard.
 *
 * Same contract as test/vat/tax-codes-fixture.test.mjs and test/setup/profile-fixture.test.mjs: the
 * app's EntryDrawer VAT test renders `vat-preview.fixture.json` as its stand-in for a live
 * `vat_preview` (computeLineTax) response, and this test pins that fixture to the REAL engine output,
 * keys AND kinds (null is its own kind, treated distinctly), plus the load-bearing figures by value.
 * If the engine result shape drifts (a renamed field, a moved trace key), the app fixture and the
 * mistake would otherwise cancel and a green app suite would prove nothing about the live shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeLineTax } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

const FIXTURE_PATH = new URL('../../app/src/surfaces/Vat/vat-preview.fixture.json', import.meta.url);
const ERROR_FIXTURE_PATH = new URL('../../app/src/surfaces/Vat/vat-preview-error.fixture.json', import.meta.url);

function keysOf(obj) {
  return Object.keys(obj).sort();
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

test('the vat-preview fixture matches the live computeLineTax response, keys and kinds', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const live = computeLineTax(ctx, {
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    supplyDate: '2024-06-15',
  });
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  // The envelope: every top-level key and its kind, so a renamed or dropped field is caught.
  assert.deepEqual(keysOf(fixture), keysOf(live), 'the fixture envelope drifted from vat_preview');
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `kind drift at ${key}`);
  }

  // The trace sub-object: keys and kinds too (the columns A07 reads).
  assert.deepEqual(keysOf(fixture.trace), keysOf(live.trace), 'the trace shape drifted');
  for (const key of Object.keys(live.trace)) {
    assert.equal(kindOf(fixture.trace[key]), kindOf(live.trace[key]), `kind drift at trace.${key}`);
  }

  // Pin the load-bearing figures by value, so a wrong number is a failure, not a silent pass.
  assert.equal(fixture.netMinor, live.netMinor);
  assert.equal(fixture.taxMinor, live.taxMinor);
  assert.equal(fixture.grossMinor, live.grossMinor);
  assert.equal(fixture.formLine, live.formLine);
  assert.equal(fixture.trace.taxAmountMinor, live.trace.taxAmountMinor);
});

// m4: the drift guard pinned only the ok:true case; the app's error-state stand-in (the LineVatErr
// shape in app/src/surfaces/Vat/types.ts) was free to drift. Pin the REAL rejection envelope too.
test('the vat-preview ERROR fixture matches the live rejection, keys, kinds and the error code', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const live = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'NOPE' });
  assert.equal(live.ok, false, 'an unknown code on a configured workspace rejects');
  const fixture = JSON.parse(readFileSync(ERROR_FIXTURE_PATH, 'utf8'));

  assert.deepEqual(keysOf(fixture), keysOf(live), 'the error fixture envelope drifted from vat_preview');
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `kind drift at ${key}`);
  }
  assert.equal(fixture.ok, false);
  assert.equal(fixture.error, live.error);
  assert.equal(fixture.error, 'unknown_tax_code');
});
