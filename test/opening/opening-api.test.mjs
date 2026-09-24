// A04 at the API edge: the tri-mapping, and the properties that only exist once a verb is reachable.
//
// TRI-MAPPING means engine verb + MCP tool in the registry + REST twin over `handleRest`. All three
// or the capability is not shipped, because a verb that exists only in the engine is a verb no agent
// and no Studio can call, and the two faces drifting apart is the exact failure the shared registry
// exists to make impossible.
//
// The REST assertions here compare the REST body against the MCP result for the SAME input rather
// than against a hand-written expectation. A twin that returns the right shape while calling a
// different code path would satisfy a shape assertion and fail this one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const OPENING_VERBS = [
  'set_opening_balances',
  'preview_opening_import',
  'import_opening_balances',
  'get_opening_balances',
];

/** A workspace plus a `call` bound to it, and a raw `deps` for the REST twin. */
function fixture() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const rest = (name, input) => handleRest(name, { workspaceId, ...input }, deps);
  return { deps, workspaceId, accId, call, rest };
}

function balancedSet(accId) {
  return [
    { account: accId('1020'), debitMinor: 1250000 },
    { account: accId('1100'), debitMinor: 340000 },
    { account: accId('2000'), creditMinor: 190000 },
    { account: accId('2800'), creditMinor: 1400000 },
  ];
}

const TWO_COLUMN_ROWS = [
  { Konto: '1020', Soll: "12'500.00", Haben: '' },
  { Konto: '2800', Soll: '', Haben: "12'500.00" },
];
const MAPPING = { account: 'Konto', debit: 'Soll', credit: 'Haben' };

// --- the registry half of the tri-mapping --------------------------------------------------------

test('all four A04 verbs are registered, with the read/write split the spec declares', () => {
  const kinds = Object.fromEntries(OPENING_VERBS.map((n) => [n, getAction(n)?.kind]));
  assert.deepEqual(kinds, {
    set_opening_balances: 'write',
    preview_opening_import: 'read',
    import_opening_balances: 'write',
    get_opening_balances: 'read',
  });
  for (const name of OPENING_VERBS) {
    const action = getAction(name);
    assert.equal(action.inputSchema.type, 'object', `${name} has an object schema`);
    assert.ok(action.inputSchema.required.includes('workspaceId'), `${name} is workspace-scoped`);
  }
});

test('both A04 writes require an idempotencyKey in the schema, and neither read does', () => {
  assert.ok(getAction('set_opening_balances').inputSchema.required.includes('idempotencyKey'));
  assert.ok(getAction('import_opening_balances').inputSchema.required.includes('idempotencyKey'));
  assert.ok(!getAction('preview_opening_import').inputSchema.required.includes('idempotencyKey'));
  assert.ok(!getAction('get_opening_balances').inputSchema.required.includes('idempotencyKey'));
});

// --- the REST half -------------------------------------------------------------------------------

test('every A04 verb has a REST twin whose body IS the registry result', () => {
  const fx = fixture();

  // A read, before anything exists.
  const readMcp = fx.call('get_opening_balances', {});
  const readRest = fx.rest('get_opening_balances', {});
  assert.equal(readRest.status, 200);
  assert.deepEqual(readRest.body, readMcp);

  // A preview, which must stay a dry run on both faces.
  const previewInput = { format: 'csv', mapping: MAPPING, rows: TWO_COLUMN_ROWS };
  assert.deepEqual(fx.rest('preview_opening_import', previewInput).body, fx.call('preview_opening_import', previewInput));

  // A rejection is 422 with the verb's own Result as the body, never a 500.
  const bad = fx.rest('set_opening_balances', {
    lines: [{ account: '1020', debitMinor: 100 }, { account: '2800', creditMinor: 40 }],
    idempotencyKey: 'rest-unb',
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'unbalanced');
  assert.equal(bad.body.differenceMinor, 60);

  // A write, through REST, lands in the ledger.
  const written = fx.rest('set_opening_balances', {
    lines: balancedSet(fx.accId),
    idempotencyKey: 'rest-ok',
  });
  assert.equal(written.status, 200);
  assert.equal(written.body.ok, true);
  assert.equal(fx.call('get_opening_balances', {}).entryId, written.body.entryId);
});

test('preview_opening_import cannot be turned into a write, and the write cannot be turned into a read', () => {
  const fx = fixture();

  // A caller passing dryRun:false to the READ verb must not post: the annotation would be a lie.
  const forced = fx.call('preview_opening_import', {
    format: 'csv',
    mapping: MAPPING,
    rows: TWO_COLUMN_ROWS,
    dryRun: false,
    idempotencyKey: 'forced',
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.dryRun, true, 'the read verb pins dryRun true regardless of the input');
  assert.equal(fx.call('get_opening_balances', {}).source, 'none', 'nothing was posted');

  // And the WRITE verb cannot be reduced to a preview by passing dryRun:true, which would let a
  // caller believe it had imported when it had not.
  const notPreviewed = fx.call('import_opening_balances', {
    format: 'csv',
    mapping: MAPPING,
    rows: TWO_COLUMN_ROWS,
    dryRun: true,
    idempotencyKey: 'not-prev',
  });
  assert.equal(notPreviewed.ok, true);
  assert.equal(notPreviewed.dryRun, false);
  assert.equal(fx.call('get_opening_balances', {}).entryId, notPreviewed.entryId, 'it really posted');
});

// --- boundary type validation, the shared registry guard ----------------------------------------

test('a wrong-typed field is invalid_input at the boundary, not a driver error', () => {
  const fx = fixture();
  assert.equal(fx.call('set_opening_balances', { lines: 'nope', idempotencyKey: 'k' }).error, 'invalid_input');
  assert.equal(fx.call('get_opening_balances', { year: 2026 }).error, 'invalid_input');
  assert.equal(fx.rest('import_opening_balances', { rows: {}, idempotencyKey: 'k' }).body.error, 'invalid_input');
  // An unknown tenant is named as such on both faces, never a silent ok and never a crash.
  assert.equal(handleRest('get_opening_balances', { workspaceId: 'ws_nope' }, fx.deps).body.error, 'workspace_not_found');
  assert.equal(handleRest('no_such_opening_verb', {}, fx.deps).status, 404);
});

test('get_opening_balances takes the year as a string, the way the schema declares it', () => {
  const fx = fixture();
  fx.call('set_opening_balances', { lines: balancedSet(fx.accId), idempotencyKey: 'y' });
  assert.equal(fx.call('get_opening_balances', { year: '2026' }).source, 'entry');
  assert.equal(fx.call('get_opening_balances', { year: '2029' }).source, 'none');
});

// --- the agent's own loop, US-A04.5 --------------------------------------------------------------

test("US-A04.5: an agent previews, imports, reads back, and a retry never doubles the position", () => {
  const fx = fixture();
  const input = { format: 'csv', mapping: MAPPING, rows: TWO_COLUMN_ROWS };

  const preview = fx.call('preview_opening_import', input);
  assert.equal(preview.preview.balanced, true);
  assert.deepEqual(preview.preview.unmapped, []);

  const imported = fx.call('import_opening_balances', { ...input, idempotencyKey: 'agent-1' });
  assert.equal(imported.ok, true, JSON.stringify(imported));

  // The agent asserts the seeded totals equal the source file to the Rappen, which is what the spec
  // asks of it: the read model's totals against the preview's, both derived independently.
  const read = fx.call('get_opening_balances', {});
  assert.equal(read.totalDebitMinor, preview.preview.totalDebitMinor);
  assert.equal(read.totalCreditMinor, preview.preview.totalCreditMinor);
  assert.equal(read.entryId, imported.entryId);

  const retried = fx.call('import_opening_balances', { ...input, idempotencyKey: 'agent-1' });
  assert.equal(retried.entryId, imported.entryId);
  const entries = fx.deps.store.db
    .prepare('SELECT COUNT(*) AS c FROM journal_entry WHERE workspace_id = ?')
    .get(fx.workspaceId).c;
  assert.equal(entries, 1, 'asserted on ROWS: the retry posted nothing');
});
