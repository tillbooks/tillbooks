/**
 * The fixture-versus-engine drift guard.
 *
 * The Studio's CompanyProfile test used a HAND-WRITTEN fixture that was flat (`body.name`) while
 * `get_company_profile` actually answers `{ok: true, profile: {...}}`. The surface read the wrapper
 * as the profile, so every field fell back to its default and the form rendered blank against a
 * workspace that had data. The fixture was wrong in exactly the same way as the surface, the two
 * mistakes cancelled, and the suite stayed green for the surface's whole life.
 *
 * A green app test therefore proves nothing about the engine on its own: something has to compare
 * the two. That is this test. The app suite renders `company-profile.fixture.json` and NOTHING else,
 * and this test asserts that fixture's key set is exactly what the real engine returns. Add, rename
 * or drop a field in `getCompanyProfile` without updating the fixture and this fails by name, in the
 * root suite, before the app suite gets a chance to pass against a shape that no longer exists.
 *
 * Keys AND kinds, not values: a fixture may show any populated workspace it likes, but every value
 * must match the engine's in KIND (`null` being a kind of its own, distinct from every `typeof`),
 * because `null` versus `undefined` was exactly the third fixture bug. Shape is the contract, and
 * null-ness is part of the shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createWorkspace,
  getCompanyProfile,
  setCreditorProfile,
  setVatMethod,
  updateCompanyProfile,
} from '../../dist/core/setup/index.js';
import { setup } from './support.mjs';

const FIXTURE_PATH = new URL('../../app/src/surfaces/Setup/company-profile.fixture.json', import.meta.url);

function keysOf(obj) {
  return Object.keys(obj).sort();
}

test('the Studio profile fixture matches the engine response shape exactly', () => {
  const { deps, ctxFor } = setup();
  const ctx = ctxFor(createWorkspace(deps, { name: 'Muster Grafik' }).workspaceId);
  const live = getCompanyProfile(ctx);

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  // The envelope: the profile is NESTED, and a fixture that flattens it is the original defect.
  assert.deepEqual(keysOf(fixture), keysOf(live), 'the fixture envelope drifted from the engine response');
  assert.equal(fixture.ok, true);
  assert.equal(typeof fixture.profile, 'object');

  assert.deepEqual(
    keysOf(fixture.profile),
    keysOf(live.profile),
    'the fixture profile drifted from getCompanyProfile: update app/src/surfaces/Setup/company-profile.fixture.json',
  );
});

/**
 * The kind of a value for parity purposes: `null` is its own kind, distinct from every `typeof`.
 * The third fixture bug was exactly this distinction: the surface guarded `undefined` where the
 * engine sends SQLite `null`, and a fixture typed by `typeof` alone cannot catch it.
 */
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertKindParity(fixture, live, path) {
  assert.equal(kindOf(fixture), kindOf(live), `kind drift at ${path}: fixture ${kindOf(fixture)}, engine ${kindOf(live)}`);
  if (kindOf(live) === 'object') {
    assert.deepEqual(keysOf(fixture), keysOf(live), `key drift inside ${path}`);
    for (const key of Object.keys(live)) {
      assertKindParity(fixture[key], live[key], `${path}.${key}`);
    }
  }
}

test('every fixture value matches the engine value in kind, null included', () => {
  // The live workspace is populated with the FIXTURE's own values through the engine's real write
  // verbs. If a fixture value cannot round-trip through the engine, that is itself drift. After the
  // writes, every field the fixture shows populated is populated live too, so kind parity covers
  // the whole profile, sub-objects included, not just the always-populated core.
  const { deps, ctxFor } = setup();
  const { profile: fixture } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const ctx = ctxFor(
    createWorkspace(deps, {
      name: fixture.name,
      legalForm: fixture.legalForm,
      baseCurrency: fixture.baseCurrency,
    }).workspaceId,
  );
  assert.equal(setVatMethod(ctx, { vatMethod: fixture.vatMethod, vatAccounting: fixture.vatAccounting }).ok, true);
  assert.equal(
    setCreditorProfile(ctx, {
      creditorName: fixture.creditorName,
      address: fixture.creditorAddress,
      iban: fixture.creditorIban,
    }).ok,
    true,
    'the fixture creditor block no longer round-trips through setCreditorProfile',
  );
  assert.equal(updateCompanyProfile(ctx, { uid: fixture.uid, mwstNo: fixture.mwstNo }).ok, true);

  const { profile: live } = getCompanyProfile(ctx);
  assertKindParity(fixture, live, 'profile');

  // The dead-lock defect's field, asserted by name so a regression fails legibly.
  assert.equal(kindOf(live.ledgerLocked), 'boolean');
});

test('a fresh workspace answers null for every optional field: null, never absent', () => {
  // The SQLite contract the Studio must code against. If the engine ever starts OMITTING an unset
  // field instead of sending null, every `field === null` check in the app goes silently dead, so
  // the omission must fail here first.
  const { deps, ctxFor } = setup();
  const ctx = ctxFor(createWorkspace(deps, { name: 'Muster Grafik' }).workspaceId);
  const { profile: live } = getCompanyProfile(ctx);
  const { profile: fixture } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  const alwaysPopulated = new Set(['workspaceId', 'name', 'baseCurrency', 'fiscalYearStart', 'createdAt', 'ledgerLocked']);
  for (const key of Object.keys(fixture)) {
    assert.equal(key in live, true, `fresh profile omits ${key} instead of sending null`);
    if (!alwaysPopulated.has(key)) {
      assert.equal(live[key], null, `fresh profile sends ${kindOf(live[key])} for unset ${key}, expected null`);
    }
  }
});
