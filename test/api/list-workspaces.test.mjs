// D12: a reloaded Studio must be able to RE-FIND an existing workspace, not only mint a new one.
// `list_workspaces` is the pre-workspace (deps-based) read that makes a workspace picker possible.
// It is the one read that legitimately crosses the tenant boundary, because it IS the tenant list.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps } from './support.mjs';

test('list_workspaces is registered as a pre-workspace read tool', () => {
  const action = getAction('list_workspaces');
  assert.ok(action, 'list_workspaces is in the registry');
  assert.equal(action.kind, 'read');
  assert.ok(
    !action.inputSchema.required.includes('workspaceId'),
    'list_workspaces must not require a workspaceId: it is how you find one',
  );
});

test('list_workspaces on an empty database is an empty list, not a rejection', () => {
  const deps = freshDeps();
  const res = getAction('list_workspaces').run(deps, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.workspaces, []);
  deps.store.close();
});

test('list_workspaces returns enough for a human to choose: id, name, currency, fiscal start, created', () => {
  const deps = freshDeps();
  getAction('create_workspace').run(deps, {
    name: 'Acme GmbH',
    baseCurrency: 'CHF',
    fiscalYearStart: '01-01',
    legalForm: 'gmbh',
    idempotencyKey: 'ws-a',
  });

  const res = getAction('list_workspaces').run(deps, {});
  assert.equal(res.ok, true);
  assert.equal(res.workspaces.length, 1);

  const [ws] = res.workspaces;
  assert.match(ws.workspaceId, /^ws_/);
  assert.equal(ws.name, 'Acme GmbH');
  assert.equal(ws.baseCurrency, 'CHF');
  assert.equal(ws.fiscalYearStart, '01-01');
  assert.equal(ws.legalForm, 'gmbh');
  assert.equal(typeof ws.createdAt, 'string');
  deps.store.close();
});

test('list_workspaces lists every workspace, newest first, with a stable tiebreak', () => {
  const deps = freshDeps();
  // The pinned clock stamps all three with the SAME created_at, so ordering falls to the tiebreak.
  // Without one, the order would be whatever SQLite felt like, and a picker would reshuffle on reload.
  for (const name of ['One AG', 'Two AG', 'Three AG']) {
    getAction('create_workspace').run(deps, { name, idempotencyKey: `ws-${name}` });
  }

  const first = getAction('list_workspaces').run(deps, {});
  const second = getAction('list_workspaces').run(deps, {});
  assert.equal(first.workspaces.length, 3);
  assert.deepEqual(
    first.workspaces.map((w) => w.workspaceId),
    second.workspaces.map((w) => w.workspaceId),
    'two identical calls return the same order',
  );
  // Newest first: the last minted id sorts ahead of the first.
  assert.equal(first.workspaces[0].name, 'Three AG');
  assert.equal(first.workspaces[2].name, 'One AG');
  deps.store.close();
});

test('list_workspaces ignores a stray workspaceId rather than filtering on it', () => {
  const deps = freshDeps();
  getAction('create_workspace').run(deps, { name: 'Solo AG', idempotencyKey: 'ws-solo' });

  const res = getAction('list_workspaces').run(deps, { workspaceId: 'ws_does_not_exist' });
  assert.equal(res.ok, true, 'a deps action never runs the tenant-existence guard');
  assert.equal(res.workspaces.length, 1);
  deps.store.close();
});
