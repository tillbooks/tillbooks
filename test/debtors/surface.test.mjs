// A16 §5, the tri-mapping: engine verb, MCP tool, REST twin. All three or the capability is not done.
//
// The engine tests next door prove the numbers are right. This file proves the numbers are
// REACHABLE, which is a different claim and the one that has been quietly false before: a verb that
// exists in `src/core` and is not in the registry is a capability nobody can call, and a tool in the
// registry with no REST twin is a capability only one of the two faces can call.
//
// The parity assertions drive the SAME input through both faces and compare the whole Result rather
// than a status code, because "both returned 200" is exactly the shape of agreement that hides a
// divergence in what was actually returned.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** The five tools A16 registers (§7 §H-ENUM), with the read/write split the spec fixes. */
const A16_TOOLS = [
  ['list_open_items', 'read'],
  ['customer_balance', 'read'],
  ['aging_report', 'read'],
  ['get_aging_bucket_config', 'read'],
  ['set_aging_bucket_config', 'write'],
];

function viaMcp(deps, name, input) {
  const res = callTool(deps, name, input);
  assert.equal(res.content[0].type, 'text');
  return JSON.parse(res.content[0].text);
}

test('A16 §5: every verb is in the registry, with the read/write kind the spec fixes', () => {
  for (const [name, kind] of A16_TOOLS) {
    const action = getAction(name);
    assert.ok(action, `${name} must be registered: an engine verb nobody can call is not a capability`);
    assert.equal(action.kind, kind, `${name} is a ${kind}`);
    assert.ok(action.summary.length > 40, `${name} needs a description an agent can choose it by`);
    assert.equal(action.inputSchema.required.includes('workspaceId'), true, `${name} is workspace-scoped`);
  }
  assert.equal(new Set(ACTIONS.map((a) => a.name)).size, ACTIONS.length, 'no duplicate tool name');
});

test('A16 §5: only set_aging_bucket_config can write; the other four are read models (P5)', () => {
  const writes = A16_TOOLS.filter(([name]) => getAction(name).kind === 'write');
  assert.deepEqual(
    writes.map(([n]) => n),
    ['set_aging_bucket_config'],
    'A16 posts nothing and settles nothing: the aging boundaries are its only write',
  );
});

test('A16 §5: the MCP tool and its REST twin return the identical Result on an empty workspace', () => {
  const mcp = freshDeps();
  const rest = freshDeps();
  const { workspaceId } = mintWorkspace(mcp);
  mintWorkspace(rest);

  for (const [name] of A16_TOOLS) {
    const input =
      name === 'customer_balance'
        ? { workspaceId, customerId: 'contact_none' }
        : name === 'set_aging_bucket_config'
          ? { workspaceId, boundariesDays: [14, 28], idempotencyKey: 'parity' }
          : { workspaceId };
    const m = viaMcp(mcp, name, input);
    const r = handleRest(name, input, rest);
    assert.equal(r.status, 200, `${name} must be reachable over REST: ${JSON.stringify(r.body)}`);
    assert.deepEqual(m, r.body, `parity mismatch for ${name}`);
  }
});

test('A16 §5 P9: an empty workspace degrades to an empty reconciled list, never to an error', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const list = handleRest('list_open_items', { workspaceId }, deps);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items, []);
  assert.equal(list.body.reconciled, true, '0 == 0 is a held reconciliation, not an absent one');

  const report = handleRest('aging_report', { workspaceId }, deps);
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.byCustomer, []);

  const config = handleRest('get_aging_bucket_config', { workspaceId }, deps);
  assert.deepEqual(config.body.boundariesDays, [30, 60, 90], 'an unset config is the default, not an error');
});

test('A16 §5: a rejected write is a 422 naming the field, never a 500 and never a silent 200', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const bad = handleRest(
    'set_aging_bucket_config',
    { workspaceId, boundariesDays: [90, 30], idempotencyKey: 'k' },
    deps,
  );
  assert.equal(bad.status, 422);
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error, 'invalid_input');
  assert.equal(bad.body.field, 'boundariesDays');

  // The boundary validation must survive the registry's own type gate: a string where a list belongs
  // is caught at the boundary, and the verb's own rule catches the shapes the schema cannot express.
  const wrongType = handleRest(
    'set_aging_bucket_config',
    { workspaceId, boundariesDays: 'thirty', idempotencyKey: 'k2' },
    deps,
  );
  assert.equal(wrongType.status, 422);
  assert.equal(wrongType.body.field, 'boundariesDays');
});

test('A16 §5: an unknown workspace is workspace_not_found, never a silent empty OP-Liste', () => {
  const deps = freshDeps();
  mintWorkspace(deps);

  const res = handleRest('list_open_items', { workspaceId: 'ws_nope' }, deps);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'workspace_not_found');
});

test('A16 §5: the write round-trips over REST and the read reflects it on the next call', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const set = handleRest(
    'set_aging_bucket_config',
    { workspaceId, boundariesDays: [10, 20, 30], idempotencyKey: 'rest-1' },
    deps,
  );
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.boundariesDays, [10, 20, 30]);

  const got = handleRest('get_aging_bucket_config', { workspaceId }, deps);
  assert.deepEqual(got.body.boundariesDays, [10, 20, 30]);
  assert.equal(got.body.configured, true);

  const list = handleRest('list_open_items', { workspaceId }, deps);
  assert.deepEqual(Object.keys(list.body.bucketTotals), ['0-10', '11-20', '21-30', '30+']);

  // The same key again writes nothing, over the wire as well as in the engine.
  const replay = handleRest(
    'set_aging_bucket_config',
    { workspaceId, boundariesDays: [99], idempotencyKey: 'rest-1' },
    deps,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.boundariesDays, [10, 20, 30]);
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM aging_bucket_config WHERE workspace_id = ?').get(workspaceId).n,
    1,
  );
});
