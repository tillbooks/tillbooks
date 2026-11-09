// `baseCurrencyOf` is the accessor a dozen write paths read instead of writing a literal, so what it
// does when it CANNOT answer decides what all of them do.
//
// `workspace.base_currency` is NOT NULL, so the only unanswerable case is a `WorkspaceContext` naming
// a workspace that has no row: not an omitted input, a tenant that does not exist. It used to answer
// 'CHF' there, which is the same invented fact this whole change is about, one layer lower: it would
// have been stamped onto the next document, published as `baseCurrency` by `mapDocument`, and made
// `statesConversionBasis` read every real row as foreign.
//
// These pin three things together, because only all three make the refusal safe:
//
//  1. it refuses instead of guessing,
//  2. no SHIPPED surface can reach the refusal, because the registry answers `workspace_not_found`
//     first (`test/api/conformance.test.mjs` asserts that for every ctx action; this file spot-checks
//     that the guard is what stands in front of the FX and payments verbs specifically), and
//  3. a real workspace still gets its real answer, on every currency the enum allows.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { baseCurrencyOf } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-07-16T00:00:00.000Z';

function freshDeps() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  return { store: new SqliteStore({ clock }), clock, ids, actor: 'user_1' };
}

function ctxFor(deps, workspaceId) {
  return makeContext(deps.store, { workspaceId, actor: 'user_1', clock: deps.clock, ids: deps.ids });
}

test('the accessor reports the currency the workspace was actually opened in', () => {
  const deps = freshDeps();
  for (const base of ['CHF', 'EUR', 'USD']) {
    const { workspaceId } = createWorkspace(deps, { name: `Books ${base}`, baseCurrency: base });
    // Read straight off the row first, so the accessor is checked against SQLite and not against
    // the argument it was created with.
    const stored = deps.store.db
      .prepare('SELECT base_currency FROM workspace WHERE id = ?')
      .get(workspaceId).base_currency;
    assert.equal(stored, base);
    assert.equal(baseCurrencyOf(ctxFor(deps, workspaceId)), base);
  }
  deps.store.close();
});

test('a workspace opened without naming a currency is Swiss, and that IS the default', () => {
  const deps = freshDeps();
  const { workspaceId } = createWorkspace(deps, { name: 'Nomadik GmbH' });
  assert.equal(
    deps.store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(workspaceId).base_currency,
    'CHF',
    'the mint is the one place a CHF literal is a real default: there is no earlier row to inherit from',
  );
  deps.store.close();
});

test('a context naming a workspace that does not exist gets a refusal, never an invented franc', () => {
  const deps = freshDeps();
  createWorkspace(deps, { name: 'Books EUR', baseCurrency: 'EUR' });
  assert.throws(
    () => baseCurrencyOf(ctxFor(deps, 'ws_does_not_exist')),
    /ws_does_not_exist/,
    'the refusal names the tenant it could not find',
  );
  deps.store.close();
});

test('no shipped surface reaches that refusal: the registry answers workspace_not_found first', () => {
  const deps = freshDeps();
  createWorkspace(deps, { name: 'Books EUR', baseCurrency: 'EUR' });
  // The verbs that read the base currency on their way in, one per module that calls the accessor.
  for (const [name, extra] of [
    ['get_exchange_rate', { currency: 'EUR' }],
    ['suggest_payment_matches', {}],
    ['list_documents', {}],
    ['list_journal', {}],
  ]) {
    const res = getAction(name).run(deps, { workspaceId: 'ws_does_not_exist', ...extra });
    assert.equal(res.ok, false, `${name} returned ok for a tenant that does not exist`);
    assert.equal(
      res.error,
      'workspace_not_found',
      `${name} should reject the tenant before the engine reads a currency, saw ${res.error}`,
    );
  }
  deps.store.close();
});
