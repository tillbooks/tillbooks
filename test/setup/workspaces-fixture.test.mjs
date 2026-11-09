/**
 * The list_workspaces fixture-versus-engine drift guard (D24).
 *
 * The Studio's workspace picker (the rail switcher and the Setup "Arbeitsbereiche" panel) renders
 * `workspaces.fixture.json` in its tests and NOTHING else, exactly as the CompanyProfile suite
 * renders `company-profile.fixture.json`. A hand-written fixture once drifted from the engine in the
 * same direction as the surface and the two mistakes cancelled (see `profile-fixture.test.mjs`), so
 * every app fixture gets one of these: a root-suite test that compares the fixture to a LIVE engine
 * call, keys AND value kinds, `null` counting as its own kind.
 *
 * Add, rename or drop a field in `listWorkspaces` without updating the fixture and this fails by
 * name, in the root suite, before the app suite can pass against a shape that no longer exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWorkspace, listWorkspaces } from '../../dist/core/setup/index.js';
import { setup } from './support.mjs';

const FIXTURE_PATH = new URL('../../app/src/surfaces/Setup/workspaces.fixture.json', import.meta.url);

function keysOf(obj) {
  return Object.keys(obj).sort();
}

/** `null` is a kind of its own, distinct from every `typeof`. Null-ness is part of the shape. */
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

/** Round-trip the fixture's own workspaces through the engine's real create verb. */
function liveFromFixture(fixture) {
  const { deps } = setup();
  // The engine lists newest first with rowid as the tiebreak, so create in REVERSE fixture order:
  // the fixture's first row must be the engine's newest.
  for (const ws of [...fixture.workspaces].reverse()) {
    const created = createWorkspace(deps, {
      name: ws.name,
      legalForm: ws.legalForm,
      baseCurrency: ws.baseCurrency,
      fiscalYearStart: ws.fiscalYearStart,
    });
    assert.equal(created.ok, true, `fixture workspace "${ws.name}" no longer round-trips through createWorkspace`);
  }
  return listWorkspaces(deps);
}

test('the Studio workspaces fixture matches the engine response shape exactly', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const live = liveFromFixture(fixture);

  // The envelope: `{ok: true, workspaces: [...]}`. A fixture that flattens or renames it is the
  // original CompanyProfile defect wearing a new name.
  assert.deepEqual(keysOf(fixture), keysOf(live), 'the fixture envelope drifted from the engine response');
  assert.equal(fixture.ok, true);
  assert.equal(Array.isArray(fixture.workspaces), true);
  assert.equal(fixture.workspaces.length, live.workspaces.length);

  for (let i = 0; i < live.workspaces.length; i += 1) {
    assert.deepEqual(
      keysOf(fixture.workspaces[i]),
      keysOf(live.workspaces[i]),
      `the fixture row ${i} drifted from listWorkspaces: update app/src/surfaces/Setup/workspaces.fixture.json`,
    );
  }
});

test('every workspaces fixture value matches the engine value in kind, null included', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const live = liveFromFixture(fixture);
  assertKindParity(fixture, live, 'response');
});

test('the fixture keeps the engine ordering: newest first, so a picker never reshuffles', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const live = liveFromFixture(fixture);
  assert.deepEqual(
    fixture.workspaces.map((w) => w.name),
    live.workspaces.map((w) => w.name),
    'the fixture row order no longer matches the engine (created_at DESC, rowid DESC)',
  );
});
