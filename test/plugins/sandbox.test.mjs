/**
 * G02 §8: the sandbox data-reach boundary (the enforced half of US-G02.6).
 *
 * `runPluginToolCall` is the ONE door a plugin's code reaches TILL through, and it must be
 * architecturally identical to an agent's: a reserved money-path tool is refused before dispatch
 * (P3, belt to install's braces), a tool outside the plugin's granted `mcp_tool:*` scopes is refused
 * `forbidden`, and a granted tool is dispatched through the SAME invoker an agent uses, as the
 * plugin's actor (so A24 binds it live). The iframe descriptor never carries `allow-same-origin`, and
 * the process descriptor scopes the filesystem and states the no-module-path-into-src invariant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Importing the registry wires the reserved money-path set at load (registerMoneyPathTools).
import '../../dist/api/registry.js';
import {
  runPluginToolCall,
  iframeSandboxDescriptor,
  pluginProcessDescriptor,
  grantedToolNames,
  isReservedMoneyPathTool,
} from '../../dist/core/plugins/index.js';

const PLUGINS_DIR = fileURLToPath(new URL('../../src/core/plugins/', import.meta.url));

test('G02 sandbox: a reserved money-path tool is refused before dispatch (P3 belt)', () => {
  let invoked = false;
  const invoke = () => {
    invoked = true;
    return { ok: true };
  };
  const res = runPluginToolCall(invoke, {
    grantedScopes: ['mcp_tool:post_entry'], // even if somehow granted, the bridge refuses it
    pluginActor: 'installer',
    tool: 'post_entry',
    input: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'capability_forbidden');
  assert.equal(invoked, false, 'the reserved tool reached the invoker');
});

test('G02 sandbox: a tool outside the granted scopes is refused forbidden', () => {
  let invoked = false;
  const invoke = () => {
    invoked = true;
    return { ok: true };
  };
  const res = runPluginToolCall(invoke, {
    grantedScopes: ['mcp_tool:list_invoices'],
    pluginActor: 'installer',
    tool: 'list_contacts',
    input: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'forbidden');
  assert.equal(res.reason, 'scope_not_granted');
  assert.equal(invoked, false, 'an ungranted tool reached the invoker');
});

test('G02 sandbox: a granted tool is dispatched through the invoker AS the plugin actor', () => {
  const seen = [];
  const invoke = (tool, input, asActor) => {
    seen.push({ tool, input, asActor });
    return { ok: true, echoed: tool };
  };
  const res = runPluginToolCall(invoke, {
    grantedScopes: ['mcp_tool:list_invoices'],
    pluginActor: 'installer_member',
    tool: 'list_invoices',
    input: { workspaceId: 'ws' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.echoed, 'list_invoices');
  assert.deepEqual(seen, [{ tool: 'list_invoices', input: { workspaceId: 'ws' }, asActor: 'installer_member' }]);
});

test('G02 sandbox: grantedToolNames reads only the mcp_tool scopes', () => {
  const names = grantedToolNames(['mcp_tool:a', 'network:x.example', 'mcp_tool:b', 'garbage']);
  assert.deepEqual([...names].sort(), ['a', 'b']);
});

test('G02 sandbox: the iframe descriptor is allow-scripts and NEVER allow-same-origin', () => {
  const none = iframeSandboxDescriptor([]);
  assert.equal(none.sandbox, 'allow-scripts');
  assert.equal(none.sandbox.includes('allow-same-origin'), false);
  assert.equal(none.connectSrc, "'none'");

  const withNet = iframeSandboxDescriptor(['network:api.example', 'mcp_tool:x']);
  assert.equal(withNet.sandbox, 'allow-scripts');
  assert.equal(withNet.sandbox.includes('allow-same-origin'), false);
  assert.equal(withNet.connectSrc, 'api.example');
});

test('G02 sandbox: the process descriptor scopes the filesystem and forbids a module path into src', () => {
  const d = pluginProcessDescriptor('plg_1', ['mcp_tool:list_invoices', 'network:x']);
  assert.equal(d.cwd, 'plugins/plg_1/data');
  assert.equal(d.noModulePathIntoSrc, true);
  assert.deepEqual(d.allowedTools, ['list_invoices']);
});

test('G02 sandbox: the reserved money-path names are wired and include the A02/A14 writes', () => {
  for (const name of ['post_entry', 'reverse_entry', 'record_payment', 'allocate_payment', 'reverse_payment']) {
    assert.equal(isReservedMoneyPathTool(name), true, `${name} is not reserved`);
  }
  assert.equal(isReservedMoneyPathTool('list_invoices'), false);
});

test('G02 sandbox: the plugins engine reaches no posting path or network transport (P3)', () => {
  const files = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 5, `only ${files.length} engine files found: the probe is aimed wrong`);
  const forbidden = [
    /\bpostEntry\s*\(/,
    /\brecordPayment\s*\(/,
    /INSERT INTO journal_entry\b/,
    /INSERT INTO payment\b/,
    /from 'node:http'/,
    /from 'node:https'/,
    /from 'node:child_process'/,
    /\bfetch\s*\(/,
  ];
  for (const file of files) {
    const source = readFileSync(`${PLUGINS_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the money/transport boundary is crossed`);
    }
  }
});
