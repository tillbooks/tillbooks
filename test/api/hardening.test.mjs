// Regression tests for the MCP/REST parity review (Fable 5): a type-invalid input must map to a
// structured Result on BOTH faces, never a thrown 500 and never divergence; a missing/nonexistent
// tenant is a structured error, not an FK crash or a silent ok.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { freshDeps } from './support.mjs';

/** Run a tool through the MCP path and decode its JSON content block back to a Result. */
function mcpResult(deps, name, input) {
  const res = callTool(deps, name, input);
  return JSON.parse(res.content[0].text);
}

// F1a: a write with no workspaceId is invalid_input, not a thrown FOREIGN KEY crash.
test('F1a: an inserting write with no workspaceId returns invalid_input (no thrown 500)', () => {
  const deps = freshDeps();
  const res = handleRest('vat_seed_defaults', {}, deps);
  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'invalid_input');
  assert.equal(res.body.field, 'workspaceId');
});

// F1b: a null idempotencyKey is treated as absent, not a thrown TypeError.
test('F1b: create_workspace with idempotencyKey:null does not throw', () => {
  const deps = freshDeps();
  const res = handleRest('create_workspace', { name: 'Acme', idempotencyKey: null }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.workspaceId);
});

// F1c: a type-invalid id (object where a string is expected) is a structured Result, never a throw.
test('F1c: a type-invalid field yields a structured Result, not an uncaught exception', () => {
  const deps = freshDeps();
  const ws = handleRest('create_workspace', { name: 'Acme' }, deps).body.workspaceId;
  const res = handleRest('unlock_period', { workspaceId: ws, period: {}, idempotencyKey: 'u1' }, deps);
  assert.equal(res.body.ok, false, 'a bad period type is refused, not thrown');
  assert.ok(res.status === 422);
});

// F2: the SAME throwing-shaped input maps to the SAME Result on both faces (no divergence).
test('F2: MCP and REST agree on a type-invalid input (both structured, deeply equal)', () => {
  const a = freshDeps();
  const b = freshDeps();
  const input = {}; // vat_seed_defaults with no workspaceId
  const rest = handleRest('vat_seed_defaults', input, a);
  const mcp = mcpResult(b, 'vat_seed_defaults', input);
  assert.deepEqual(mcp, rest.body, 'the two faces produce the identical Result');
  assert.equal(mcp.error, 'invalid_input');
});

// F3: a well-formed but nonexistent workspaceId is workspace_not_found, never a silent ok.
test('F3: an UPDATE-shaped verb on a nonexistent workspace returns workspace_not_found, not silent ok', () => {
  const deps = freshDeps();
  const res = handleRest('set_vat_method', { workspaceId: 'ws_nope', vatMethod: 'saldo', vatAccounting: 'ist' }, deps);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'workspace_not_found');
});

test('F3: a read on a nonexistent workspace is workspace_not_found, not an empty ok list', () => {
  const deps = freshDeps();
  const res = handleRest('list_accounts', { workspaceId: 'ws_nope' }, deps);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'workspace_not_found');
});

// F4: the deps-based bootstrap_workspace has parity too (the deps-path parity claim rests on it).
test('F4: bootstrap_workspace produces identical Results on MCP and REST', () => {
  const a = freshDeps();
  const b = freshDeps();
  const input = { description: 'Muster GmbH, effective method, CHE-123.456.789 MWST', idempotencyKey: 'b1' };
  const rest = handleRest('bootstrap_workspace', input, a);
  const mcp = mcpResult(b, 'bootstrap_workspace', input);
  assert.equal(rest.body.ok, true);
  assert.deepEqual(mcp, rest.body, 'deps-based action parity holds');
});
