/**
 * G02 P3, MADE EXPLICIT AS A PAIR: the reserved money-path denylist is single-sourced from the
 * registry's OWN A02/A14 write set (`reserved.ts`, wired by `registry.ts` at load) and it BITES IN
 * BOTH DIRECTIONS. The original critic's note was that neither direction can silently regress, so
 * this suite drives BOTH off the SAME `moneyPathTools()` set in one place:
 *
 *   - INSTALL time (a manifest that DECLARES/requests a reserved verb): `install_plugin` refuses
 *     `capability_forbidden` / `no_second_posting_path` and writes ZERO rows (no `plugin_manifests`
 *     row, no `plugin_capability_registrations` row). The whole install fails; nothing partial lands.
 *   - CALL time (a running plugin that tries to INVOKE a reserved verb over the IPC/tool surface):
 *     `runPluginToolCall` (the ONE door a plugin's code reaches TILL through) refuses
 *     `capability_forbidden` / `no_second_posting_path` BEFORE dispatch, even when the reserved verb
 *     was somehow granted as a scope, and the underlying invoker is NEVER reached.
 *
 * `lifecycle.test.mjs` and `sandbox.test.mjs` each already prove one direction; this file exists so
 * the PAIR is asserted together, iterating the identical reserved set, so a change that weakened one
 * face (or unwired the seam that feeds both) reddens here rather than slipping through the gap
 * between two separate files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Importing the registry wires the reserved money-path set at load (registerMoneyPathTools), so both
// faces read the SAME single source, exactly as production does.
import { getAction } from '../../dist/api/registry.js';
import { runPluginToolCall, moneyPathTools } from '../../dist/core/plugins/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function sha(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

function bundle(capabilityName, payload = 'p') {
  return {
    manifest: {
      name: 'Ext',
      version: '1.0.0',
      compat_range: '^1.0.0',
      sha256: sha(payload),
      capabilities: [{ kind: 'mcp_tool', name: capabilityName }],
      permissions: { requested: [] },
    },
    payload,
  };
}

function setup() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const count = (table) => deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
  return { workspaceId, call, count };
}

// The single source, read once. Both directions below iterate THIS set; a value renamed at the A02
// or A14 surface moves through the seam automatically, and an empty/unwired set fails this guard.
const RESERVED = [...(moneyPathTools() ?? [])];

test('G02 P3 pair: the reserved set is wired and single-sourced from the A02/A14 writes', () => {
  assert.ok(RESERVED.length > 0, 'the reserved money-path set is not wired (registry.js did not register it)');
  for (const name of ['post_entry', 'reverse_entry', 'save_draft', 'delete_draft', 'record_payment', 'allocate_payment', 'reverse_payment', 'set_write_off_threshold']) {
    assert.ok(RESERVED.includes(name), `${name} missing from the reserved money-path set`);
  }
});

test('G02 P3 pair, INSTALL direction: declaring ANY reserved verb is refused with ZERO rows written', () => {
  for (const name of RESERVED) {
    const { call, count } = setup();
    // Precondition: a clean workspace has no plugin rows, so the zero-row assertion below is about
    // THIS install and not a pre-existing empty table by coincidence.
    assert.equal(count('plugin_manifests'), 0);
    assert.equal(count('plugin_capability_registrations'), 0);

    const res = call('install_plugin', { source: 'local', packageRef: bundle(name), idempotencyKey: 'k' });

    assert.equal(res.ok, false, `${name}: install should be forbidden`);
    assert.equal(res.error, 'capability_forbidden', `${name}: wrong error ${JSON.stringify(res)}`);
    assert.equal(res.reason, 'no_second_posting_path', `${name}: wrong reason`);
    assert.equal(res.name, name, `${name}: rejection did not name the offending verb`);
    // The load-bearing row-count assertion: the WHOLE install fails, nothing partial lands.
    assert.equal(count('plugin_manifests'), 0, `${name}: a partial plugin_manifests row was written`);
    assert.equal(count('plugin_capability_registrations'), 0, `${name}: a plugin_capability_registrations row leaked`);
  }
});

test('G02 P3 pair, CALL direction: invoking ANY reserved verb is refused before dispatch (invoker never reached)', () => {
  for (const name of RESERVED) {
    let invoked = false;
    const invoke = () => {
      invoked = true;
      return { ok: true };
    };
    // The reserved verb is even GRANTED as a scope here, to prove the refusal is the money-path
    // denylist and not merely the scope gate: the denylist must bite regardless of the grant.
    const res = runPluginToolCall(invoke, {
      grantedScopes: [`mcp_tool:${name}`],
      pluginActor: 'installer_member',
      tool: name,
      input: { workspaceId: 'ws' },
    });

    assert.equal(res.ok, false, `${name}: call should be forbidden`);
    assert.equal(res.error, 'capability_forbidden', `${name}: wrong error ${JSON.stringify(res)}`);
    assert.equal(res.reason, 'no_second_posting_path', `${name}: wrong reason`);
    // The refusal-code assertion on the call path: the invoker (the shared action dispatch, i.e. the
    // ledger door) is NEVER reached for a reserved verb.
    assert.equal(invoked, false, `${name}: a reserved verb reached the ledger invoker`);
  }
});
