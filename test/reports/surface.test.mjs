// A08, the tri-mapping: engine verb, MCP tool, REST twin, and the P5 tripwire that says A08 cannot
// write.
//
// The §7 tripwire is the important one here. "A08 adds no mutation" is a claim about code that does
// not exist, and the only honest way to test the absence of something is to look for its effect: so
// every call below is bracketed by a full row census of every table the ledger owns, and the census
// has to be identical afterwards. A read model that quietly memoised a total into a table would
// show up as a row, and a docblock promising it does not would not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { callTool, buildMcpServer, makeApiDeps } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps } from '../api/support.mjs';
import { postEntry } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';

/** The five verbs A08 registers, in registry order. */
const A08_TOOLS = ['trial_balance', 'balance_sheet', 'income_statement', 'general_ledger', 'export_statement'];

const PERIOD = { periodStart: '2026-01-01', periodEnd: '2026-03-31' };

/** A workspace with a handful of postings, driven through the registry's own deps. */
function seeded() {
  const deps = freshDeps();
  const ws = getAction('create_workspace').run(deps, { name: 'Muster GmbH', idempotencyKey: 'ws' });
  const workspaceId = ws.workspaceId;
  const acc = (number) =>
    deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const post = (date, key, lines) => {
    const res = postEntry(ctx, {
      date,
      source: 'manual',
      idempotencyKey: key,
      lines: lines.map((l) => ({ account: acc(l.n), ...(l.debit ? { debit: l.debit } : { credit: l.credit }) })),
    });
    if (!res.ok) throw new Error(JSON.stringify(res));
  };
  post('2025-12-31', 'open', [
    { n: '1020', debit: 1000000 },
    { n: '2800', credit: 1000000 },
  ]);
  post('2026-02-01', 'rev', [
    { n: '1020', debit: 250000 },
    { n: '3400', credit: 250000 },
  ]);
  post('2026-03-01', 'exp', [
    { n: '6500', debit: 40000 },
    { n: '1020', credit: 40000 },
  ]);
  return { deps, workspaceId, acc };
}

/** A valid input for each A08 tool, so one loop can drive all five. */
function inputsFor(workspaceId, acc) {
  return {
    trial_balance: { workspaceId, ...PERIOD },
    balance_sheet: { workspaceId, asOf: '2026-03-31' },
    income_statement: { workspaceId, ...PERIOD },
    general_ledger: { workspaceId, accountId: acc('1020'), ...PERIOD },
    export_statement: { workspaceId, kind: 'trial', format: 'csv', ...PERIOD },
  };
}

/** Every row in every table, so "nothing was written" is a measurement and not a promise. */
function census(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, store.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
}

// --- Registration --------------------------------------------------------------------------------

test('all five A08 verbs are registered, read-only, and workspace-scoped', () => {
  for (const name of A08_TOOLS) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name} is not registered`);
    assert.equal(action.kind, 'read', `${name} must be a read verb: A08 has no write path`);
    assert.ok(action.inputSchema.required.includes('workspaceId'), `${name} must require workspaceId`);
    assert.ok(
      !action.inputSchema.required.includes('idempotencyKey'),
      `${name} must not require an idempotency key: a read needs none (P4)`,
    );
  }
});

test('the five are appended CONTIGUOUSLY, in spec order, never interleaved', () => {
  // This asserted `ACTIONS.slice(-5)` until A04 appended four verbs behind A08 and the case went
  // red on a merge neither branch could see alone. Being LAST was never the property worth holding:
  // the registry is append-only and D10 names it the throughput ceiling, so every future capability
  // appends and every predecessor stops being last. What A08 actually promises is that its five
  // arrive together and in spec order, which is what a reader of the array needs and what a
  // scattered or reordered spread would break.
  const names = ACTIONS.map((a) => a.name);
  const start = names.indexOf(A08_TOOLS[0]);
  assert.notEqual(start, -1, 'the A08 verbs are registered at all');
  assert.deepEqual(names.slice(start, start + A08_TOOLS.length), A08_TOOLS);
});

test('MCP advertises every A08 tool as readOnlyHint, on the real wire', async () => {
  // THIS CASE USED TO BE VACUOUS. Its body was byte-identical to the `kind === 'read'` assertion in
  // the case above, so it never touched `mcp.js` and never read `readOnlyHint` at all: it tested the
  // registry twice under a title that promised the MCP surface. The annotation is built in
  // `buildMcpServer`'s tools/list handler from `kind`, and that derivation was the untested step.
  //
  // An agent deciding whether a call is safe to make unattended reads exactly this field, and MCP
  // defaults it to FALSE, so a read verb that stays silent is under-claiming and gets treated as a
  // write. Driven over a real client/server pair on an in-memory transport, so it stays offline.
  const { deps, store } = makeApiDeps();
  const server = buildMcpServer(deps);
  const client = new Client({ name: 'a08-surface-probe', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const advertised = new Map(tools.map((t) => [t.name, t]));
    for (const name of A08_TOOLS) {
      const tool = advertised.get(name);
      assert.ok(tool !== undefined, `${name} is never advertised over tools/list`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} does not advertise readOnlyHint`);
      assert.equal(tool.description, getAction(name).summary, `${name}: the advertised description drifted`);
    }
    // And the hint is DERIVED, not blanket-applied: a write verb in the same listing must not carry
    // it, or `readOnlyHint: true` would mean nothing.
    assert.notEqual(advertised.get('post_entry')?.annotations?.readOnlyHint, true);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

test('the filed statements expose no groupBy at all, the working papers do (§6b)', () => {
  // A structural claim, not a behavioural one: the Bilanz and the Erfolgsrechnung must not offer the
  // parameter in the first place, so an agent reading the schema never even asks.
  assert.ok(!('groupBy' in getAction('balance_sheet').inputSchema.properties));
  assert.ok(!('groupBy' in getAction('income_statement').inputSchema.properties));
  assert.ok('groupBy' in getAction('trial_balance').inputSchema.properties);
  assert.ok('groupBy' in getAction('general_ledger').inputSchema.properties);
});

// --- Tri-mapping ---------------------------------------------------------------------------------

test('MCP and REST return identical Results for all five A08 verbs', () => {
  const mcp = seeded();
  const rest = seeded();
  const mcpInputs = inputsFor(mcp.workspaceId, mcp.acc);
  const restInputs = inputsFor(rest.workspaceId, rest.acc);
  for (const name of A08_TOOLS) {
    const viaMcp = JSON.parse(callTool(mcp.deps, name, mcpInputs[name]).content[0].text);
    const viaRest = handleRest(name, restInputs[name], rest.deps).body;
    assert.equal(viaMcp.ok, true, `${name}: ${JSON.stringify(viaMcp)}`);
    assert.deepEqual(viaMcp, viaRest, `parity mismatch for ${name}`);
  }
});

test('REST maps a success to 200 and a domain refusal to 422', () => {
  const { deps, workspaceId } = seeded();
  assert.equal(handleRest('trial_balance', { workspaceId, ...PERIOD }, deps).status, 200);
  const refused = handleRest(
    'trial_balance',
    { workspaceId, periodStart: '2026-03-31', periodEnd: '2026-01-01' },
    deps,
  );
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'invalid_period');
});

test('an unknown workspace is workspace_not_found on every A08 verb, never an empty report', () => {
  const { deps, acc } = seeded();
  for (const [name, input] of Object.entries(inputsFor('ws_nope', acc))) {
    const res = handleRest(name, input, deps).body;
    assert.equal(res.ok, false, `${name} answered for a workspace that does not exist`);
    assert.equal(res.error, 'workspace_not_found', name);
  }
});

// --- §7 tripwire: the reporting layer exposes no write path --------------------------------------

test('P5 tripwire: not one row changes across every A08 call, on either face', () => {
  const { deps, workspaceId, acc } = seeded();
  // A35: the transport dispatch records the AGENT seat's calls (agent_call rows, by design, asserted
  // in test/agent/). This tripwire is about A08's VERBS, so it drives them as the studio seat, which
  // the seam leaves byte-identical to action.run.
  const asStudio = { ...deps, actor: 'studio' };
  const before = census(deps.store);
  const inputs = inputsFor(workspaceId, acc);
  for (const name of A08_TOOLS) {
    for (const format of ['csv', 'pdf']) {
      const input = name === 'export_statement' ? { ...inputs[name], format } : inputs[name];
      callTool(asStudio, name, input);
      handleRest(name, input, asStudio);
    }
  }
  assert.deepEqual(census(deps.store), before, 'an A08 call wrote to the database');
  // And the census is not vacuously empty: the fixture really did put rows in there.
  assert.ok(before.journal_entry >= 3);
  assert.ok(before.journal_line >= 6);
});

test('P5 tripwire: A08 records no idempotency key, so nothing about it is replayable', () => {
  // A read that memoised itself under a key would be a write with a friendly name. The count is
  // taken from the table A02/A14 actually use, so a new row would have to come from A08.
  const { deps, workspaceId, acc } = seeded();
  const keys = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n;
  const before = keys();
  for (const [name, input] of Object.entries(inputsFor(workspaceId, acc))) {
    callTool(deps, name, { ...input, idempotencyKey: 'should-be-ignored' });
  }
  assert.equal(keys(), before);
});

// --- §6b: groupBy is refused, not ignored --------------------------------------------------------

test('an unsupported groupBy is refused by name, never silently ignored', () => {
  const { deps, workspaceId, acc } = seeded();
  for (const [name, input] of [
    ['trial_balance', { workspaceId, ...PERIOD }],
    ['general_ledger', { workspaceId, accountId: acc('1020'), ...PERIOD }],
  ]) {
    const res = handleRest(name, { ...input, groupBy: 'Berichtsgruppe' }, deps).body;
    assert.equal(res.ok, false, name);
    assert.equal(res.error, 'unsupported_group_by', name);
    assert.deepEqual(res.supported, ['kmu']);
  }
});

test("groupBy invariance (§7): 'kmu' changes bucketing and nothing else", () => {
  const { deps, workspaceId } = seeded();
  const plain = handleRest('trial_balance', { workspaceId, ...PERIOD }, deps).body;
  const grouped = handleRest('trial_balance', { workspaceId, ...PERIOD, groupBy: 'kmu' }, deps).body;
  assert.deepEqual(grouped.totals, plain.totals);
  assert.equal(grouped.reconciles, plain.reconciles);
  assert.deepEqual(grouped.rows, plain.rows);
  assert.deepEqual(grouped.groups, plain.groups);
  // The grouping really is a bucketing of the same rows, not a second aggregation.
  const grandTotal = grouped.groups.reduce((sum, g) => sum + g.debitMinor, 0);
  assert.equal(grandTotal, grouped.totals.debitMinor);
  assert.deepEqual(
    grouped.groups.flatMap((g) => g.accounts).sort(),
    grouped.rows.map((r) => r.account.number).sort(),
  );
});

// --- P9 degradation reaches the boundary intact --------------------------------------------------

test('needs_chart and invalid input survive the trip through the tool boundary', () => {
  const { deps, workspaceId } = seeded();
  const malformed = handleRest('balance_sheet', { workspaceId, asOf: '31.03.2026' }, deps).body;
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'invalid_input');
  assert.equal(malformed.field, 'asOf');

  // A chartless workspace needs its OWN deps: the seeded one cannot be emptied, because a posted
  // entry is immutable and the schema trigger refuses the DELETE (which is how the first version of
  // this case learned it was probing the wrong thing).
  const bareDeps = freshDeps();
  const bareWs = getAction('create_workspace').run(bareDeps, { name: 'Leer AG', idempotencyKey: 'ws' }).workspaceId;
  bareDeps.store.db.prepare('DELETE FROM account WHERE workspace_id = ?').run(bareWs);
  const bare = handleRest('income_statement', { workspaceId: bareWs, ...PERIOD }, bareDeps).body;
  assert.equal(bare.ok, false);
  assert.equal(bare.error, 'needs_chart');
});

test('export_statement accepts both compareTo shapes: {asOf} for the Bilanz, a period for the rest', () => {
  // One declared type, two payloads. Both have to survive `typeMismatch`, or the boundary would
  // reject a legitimate call for one of the two kinds.
  const { deps, workspaceId } = seeded();
  const balance = handleRest(
    'export_statement',
    { workspaceId, kind: 'balance', format: 'csv', asOf: '2026-03-31', compareTo: { asOf: '2025-12-31' } },
    deps,
  ).body;
  assert.equal(balance.ok, true, JSON.stringify(balance));
  const income = handleRest(
    'export_statement',
    {
      workspaceId,
      kind: 'income',
      format: 'csv',
      ...PERIOD,
      compareTo: { periodStart: '2025-10-01', periodEnd: '2025-12-31' },
    },
    deps,
  ).body;
  assert.equal(income.ok, true, JSON.stringify(income));
});
