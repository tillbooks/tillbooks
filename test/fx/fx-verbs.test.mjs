// §H-FX, the verb surface: engine verb -> MCP tool -> REST twin, all three, on the same registry.
//
// The tri-mapping rule is not a formality. A rate the engine can reach but no shipped surface can is
// a private field, and a multi-currency ledger whose rates can only be seeded from a test is not a
// shipped capability. The generic conformance gate already double-calls every write verb and
// compares the database; what this suite adds is the FX-specific evidence: the two faces return the
// identical Result, the read verbs are genuinely read-only, and the write verb settles on ROWS.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const FX_VERBS = [
  'record_exchange_rate',
  'list_exchange_rates',
  'get_exchange_rate',
  'set_fx_method',
  'get_fx_method',
  'describe_rate_feed',
  'import_exchange_rates',
];

const RATE = (workspaceId, over = {}) => ({
  workspaceId,
  baseCurrency: 'EUR',
  rate: '0.9412',
  asOf: '2026-07-16',
  source: 'manual',
  method: 'daily',
  provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
  idempotencyKey: 'fx-verb-1',
  ...over,
});

function viaMcp(deps, name, input) {
  const res = callTool(deps, name, input);
  assert.equal(res.content[0].type, 'text');
  return JSON.parse(res.content[0].text);
}

test('all three §H-FX verbs are on the shared registry, with honest read/write kinds', () => {
  for (const name of FX_VERBS) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name} is registered`);
    assert.ok(action.inputSchema.required.includes('workspaceId'), `${name} is tenant-scoped (§H-TENANT)`);
    assert.ok(action.summary.length > 30, `${name} tells an agent what it does`);
  }
  assert.equal(getAction('record_exchange_rate').kind, 'write');
  assert.equal(getAction('list_exchange_rates').kind, 'read');
  assert.equal(getAction('get_exchange_rate').kind, 'read');
  assert.equal(getAction('set_fx_method').kind, 'write');
  assert.equal(getAction('get_fx_method').kind, 'read');
  assert.equal(getAction('describe_rate_feed').kind, 'read');
  assert.equal(getAction('import_exchange_rates').kind, 'write');
  assert.equal(new Set(ACTIONS.map((a) => a.name)).size, ACTIONS.length, 'no duplicate tool name');
});

test('MCP and REST return the IDENTICAL Result for every §H-FX verb', () => {
  const mcp = freshDeps();
  const rest = freshDeps();
  const a = mintWorkspace(mcp).workspaceId;
  const b = mintWorkspace(rest).workspaceId;
  assert.equal(a, b, 'the two deterministic stores mint the same workspace id');

  const step = (name, input) => {
    const m = viaMcp(mcp, name, input);
    const r = handleRest(name, input, rest).body;
    assert.deepEqual(m, r, `parity mismatch for ${name}: ${JSON.stringify({ m, r })}`);
    return m;
  };

  const recorded = step('record_exchange_rate', RATE(a));
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.rate, '0.9412');

  const listed = step('list_exchange_rates', { workspaceId: a, baseCurrency: 'EUR' });
  assert.equal(listed.rates.length, 1);
  assert.equal(listed.rates[0].method, 'daily');

  const got = step('get_exchange_rate', { workspaceId: a, currency: 'EUR', date: '2026-07-16' });
  assert.equal(got.rate, '0.9412');
  assert.equal(got.baseCurrency, 'CHF');

  // A domain rejection is a Result on both faces, never a protocol error on one of them.
  const refused = step('get_exchange_rate', { workspaceId: a, currency: 'JPY', date: '2026-07-16' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_fx_rate');
  assert.equal(handleRest('get_exchange_rate', { workspaceId: a, currency: 'JPY' }, rest).status, 422);
});

test('record_exchange_rate is idempotent on ROWS through the shipped surface', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const rows = () => deps.store.db.prepare('SELECT * FROM exchange_rate ORDER BY id').all();

  const first = handleRest('record_exchange_rate', RATE(workspaceId), deps).body;
  const after = JSON.stringify(rows());
  const second = handleRest('record_exchange_rate', RATE(workspaceId), deps).body;

  assert.deepEqual(first, second, 'the replay returns the original result');
  assert.equal(JSON.stringify(rows()), after, 'and not one row differs');
  assert.equal(rows().length, 1);
});

test('the read verbs do not write: the whole database is unchanged after calling them', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  handleRest('record_exchange_rate', RATE(workspaceId), deps);

  const snapshot = () => {
    const tables = deps.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    return JSON.stringify(
      Object.fromEntries(tables.map((t) => [t, deps.store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()])),
    );
  };

  // A35: the transport dispatch records an AGENT seat's calls in the trace (agent_call rows), by
  // design and asserted in test/agent/. This test's claim is about the READ VERBS, so it drives
  // them as the studio seat, which the seam leaves byte-identical to action.run.
  const asStudio = { ...deps, actor: 'studio' };
  const before = snapshot();
  handleRest('list_exchange_rates', { workspaceId }, asStudio);
  handleRest('get_exchange_rate', { workspaceId, currency: 'EUR' }, asStudio);
  handleRest('get_exchange_rate', { workspaceId, currency: 'JPY' }, asStudio);
  handleRest('get_fx_method', { workspaceId }, asStudio);
  handleRest('get_fx_method', { workspaceId, taxPeriod: '2029' }, asStudio);
  handleRest('describe_rate_feed', { workspaceId }, asStudio);
  assert.equal(snapshot(), before);
});

test('an unknown tenant is workspace_not_found, never a silent ok on a typo', () => {
  const deps = freshDeps();
  mintWorkspace(deps);
  for (const name of FX_VERBS) {
    const res = handleRest(name, { workspaceId: 'ws_nope', currency: 'EUR', ...RATE('ws_nope') }, deps).body;
    assert.equal(res.ok, false, name);
    assert.equal(res.error, 'workspace_not_found', `${name}: ${JSON.stringify(res)}`);
  }
});

test('garbage in gives a stable code, never a throw and never unexpected_error', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const hostile = [
    { workspaceId, baseCurrency: [], rate: '1', asOf: '2026-07-16', idempotencyKey: 'h1' },
    { workspaceId, baseCurrency: 'EUR', rate: 0.9412, asOf: '2026-07-16', idempotencyKey: 'h2' },
    { workspaceId, baseCurrency: 'EUR', rate: '1', asOf: { a: 1 }, idempotencyKey: 'h3' },
    { workspaceId },
    {},
  ];
  for (const input of hostile) {
    const res = handleRest('record_exchange_rate', input, deps).body;
    assert.equal(res.ok, false, JSON.stringify(input));
    assert.notEqual(res.error, 'unexpected_error', `an exception escaped: ${JSON.stringify(res)}`);
    assert.equal(typeof res.error, 'string');
  }
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM exchange_rate').get().n, 0);
});

test('the recorded rate is immediately usable by the posting path, through the surface', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  assert.ok(handleRest('record_exchange_rate', RATE(workspaceId), deps).body.ok);
  // A35: the agent seat's post_entry routes through the dial at the transports and every dial ships
  // at ask, so the fixture grants post -> auto first (the D103 ceremony); the drafting path has its
  // own suite in test/agent/.
  assert.ok(handleRest('set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'fx-dial' }, { ...deps, actor: 'studio' }).body.ok);

  const posted = handleRest(
    'post_entry',
    {
      workspaceId,
      date: '2026-07-16',
      source: 'manual',
      idempotencyKey: 'fx-post-1',
      currency: 'EUR',
      lines: [
        { account: accId('6500'), debit: 108100 },
        { account: accId('1000'), credit: 108100 },
      ],
    },
    deps,
  ).body;
  assert.ok(posted.ok, JSON.stringify(posted));
  assert.equal(posted.currency, 'EUR');
  assert.equal(posted.fxRate, '0.9412');

  const line = deps.store.db
    .prepare('SELECT * FROM journal_line WHERE entry_id = ? AND debit_minor > 0')
    .get(posted.entryId);
  assert.equal(line.debit_minor, 108100, "EUR 1'081.00");
  assert.equal(line.base_debit_minor, 101744, "CHF 1'017.44");
  assert.equal(line.fx_rate, '0.9412');
});
