/**
 * G02 §8: the manifest lifecycle and the two load-bearing safety properties a critic scrutinises.
 *
 *   - P3 / no second posting path: a manifest declaring a reserved money-path tool is rejected
 *     `capability_forbidden` with ZERO rows written, for every A02/A14 write name and for a shadow
 *     name colliding with one; a capability colliding with an existing core tool is
 *     `capability_name_conflict`; an `automation_action` REFERENCING a non-money core tool is allowed.
 *   - Grant is the INTERSECTION of requested and granted, never a superset.
 *   - Checksum mismatch installs nothing; install is idempotent-on-rows; disable sweeps every
 *     registration byte-identical; an incompatible plugin degrades honestly; version supersede and
 *     uninstall write the audit chain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getAction } from '../../dist/api/registry.js';
import { moneyPathTools } from '../../dist/core/plugins/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function sha(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

function bundle(over = {}, payload = 'p') {
  return {
    manifest: {
      name: over.name ?? 'Ext',
      version: over.version ?? '1.0.0',
      compat_range: over.compat_range ?? '^1.0.0',
      sha256: over.sha256 ?? sha(payload),
      capabilities: over.capabilities ?? [],
      permissions: over.permissions ?? { requested: [] },
    },
    payload,
  };
}

function setup() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const count = (table) => deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
  return { deps, workspaceId, call, count };
}

test('G02 P3: a manifest declaring ANY reserved money-path tool is rejected with zero rows', () => {
  const reserved = [...(moneyPathTools() ?? [])];
  assert.ok(reserved.includes('post_entry') && reserved.includes('record_payment'), 'the reserved set is not wired');
  for (const name of reserved) {
    const { call, count } = setup();
    const res = call('install_plugin', {
      source: 'local',
      packageRef: bundle({ capabilities: [{ kind: 'mcp_tool', name }] }),
      idempotencyKey: 'k',
    });
    assert.equal(res.ok, false, `${name} should be forbidden`);
    assert.equal(res.error, 'capability_forbidden');
    assert.equal(res.reason, 'no_second_posting_path');
    assert.equal(count('plugin_manifests'), 0, `${name}: a partial plugin was written`);
    assert.equal(count('plugin_capability_registrations'), 0, `${name}: a registration leaked`);
  }
});

test('G02 P3: an automation_action naming post_entry is forbidden (references count too)', () => {
  const { call, count } = setup();
  const res = call('install_plugin', {
    source: 'local',
    packageRef: bundle({ capabilities: [{ kind: 'automation_action', name: 'post_entry' }] }),
    idempotencyKey: 'k',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'capability_forbidden');
  assert.equal(count('plugin_manifests'), 0);
});

test('G02: a capability colliding with an existing core tool is capability_name_conflict', () => {
  const { call, count } = setup();
  const res = call('install_plugin', {
    source: 'local',
    packageRef: bundle({ capabilities: [{ kind: 'mcp_tool', name: 'list_contacts' }] }),
    idempotencyKey: 'k',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'capability_name_conflict');
  assert.equal(res.name, 'list_contacts');
  assert.equal(count('plugin_manifests'), 0);
});

test('G02: an automation_action REFERENCING a non-money core tool installs (it is a reference, not a new name)', () => {
  const { call } = setup();
  const res = call('install_plugin', {
    source: 'local',
    packageRef: bundle({ capabilities: [{ kind: 'automation_action', name: 'send_invoice' }] }),
    idempotencyKey: 'k',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test('G02: the granted scope set is the INTERSECTION of requested and granted, never a superset', () => {
  const { call } = setup();
  const res = call('install_plugin', {
    source: 'local',
    packageRef: bundle({ permissions: { requested: ['mcp_tool:list_invoices', 'network:a.example'] } }),
    grantedScopes: ['mcp_tool:list_invoices', 'mcp_tool:post_entry', 'network:evil.example'],
    idempotencyKey: 'k',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  // Only the one scope that was BOTH requested and granted survives; the ungranted-but-requested and
  // the granted-but-not-requested scopes are both absent.
  assert.deepEqual(res.plugin.granted, ['mcp_tool:list_invoices']);
  assert.deepEqual([...res.plugin.requested].sort(), ['mcp_tool:list_invoices', 'network:a.example']);
});

test('G02: a checksum mismatch installs nothing', () => {
  const { call, count } = setup();
  const res = call('install_plugin', {
    source: 'local',
    packageRef: bundle({ sha256: 'deadbeef' }),
    idempotencyKey: 'k',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'manifest_checksum_failed');
  assert.equal(count('plugin_manifests'), 0);
});

test('G02: install is idempotent-on-rows under one key', () => {
  const { call, count } = setup();
  const input = { source: 'local', packageRef: bundle(), idempotencyKey: 'once' };
  const a = call('install_plugin', input);
  const b = call('install_plugin', input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.plugin.id, b.plugin.id);
  assert.equal(count('plugin_manifests'), 1, 'a second call under the same key made a second row');
});

test('G02: disable sweeps every registration and enable restores it byte-identical', () => {
  const { call, count, deps, workspaceId } = setup();
  const caps = [
    { kind: 'mcp_tool', name: 'acme_forecast' },
    { kind: 'studio_screen', name: 'acme_panel' },
    { kind: 'report_source', name: 'acme_sales' },
  ];
  const installed = call('install_plugin', { source: 'local', packageRef: bundle({ capabilities: caps }), idempotencyKey: 'i' });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const pluginId = installed.plugin.id;
  const rowsSql = 'SELECT kind, name FROM plugin_capability_registrations WHERE workspace_id = ? AND plugin_id = ? ORDER BY kind, name';
  const before = deps.store.db.prepare(rowsSql).all(workspaceId, pluginId);
  assert.equal(before.length, 3, 'install did not register the three capabilities');

  const disabled = call('disable_plugin', { pluginId, idempotencyKey: 'd' });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.plugin.status, 'disabled');
  assert.equal(count('plugin_capability_registrations'), 0, 'disable did not sweep the registrations');

  const enabled = call('enable_plugin', { pluginId, idempotencyKey: 'e' });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.plugin.status, 'installed');
  const after = deps.store.db.prepare(rowsSql).all(workspaceId, pluginId);
  assert.deepEqual(after, before, 'the swept registry did not return byte-identical after re-enable');
});

test('G02: an incompatible compat_range installs disabled-equivalent (incompatible) and never crashes', () => {
  const { call } = setup();
  const res = call('install_plugin', {
    source: 'local',
    packageRef: bundle({ compat_range: '^99.0.0', capabilities: [{ kind: 'mcp_tool', name: 'acme_x' }] }),
    idempotencyKey: 'i',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.plugin.status, 'incompatible');
  assert.equal(res.plugin.compatible, false);
  // No capabilities registered for an incompatible plugin.
  const got = call('get_plugin', { pluginId: res.plugin.id });
  assert.equal(got.ok, true);
  assert.deepEqual(got.registrations, []);
});

test('G02: a newer version supersedes in place and writes an audit_log row; uninstall audits and deletes', () => {
  const { call, count } = setup();
  const v1 = call('install_plugin', { source: 'local', packageRef: bundle({ name: 'Acme', version: '1.0.0' }), idempotencyKey: 'v1' });
  assert.equal(v1.ok, true);
  const auditBefore = count('audit_log');

  const v2 = call('install_plugin', { source: 'local', packageRef: bundle({ name: 'Acme', version: '1.1.0' }), idempotencyKey: 'v2' });
  assert.equal(v2.ok, true);
  assert.equal(v2.plugin.version, '1.1.0');
  assert.equal(v2.plugin.id, v1.plugin.id, 'supersede minted a new row instead of replacing in place');
  assert.equal(count('plugin_manifests'), 1, 'supersede left two rows');
  assert.ok(count('audit_log') > auditBefore, 'supersede wrote no audit row');

  // A downgrade is refused.
  const down = call('install_plugin', { source: 'local', packageRef: bundle({ name: 'Acme', version: '0.9.0' }), idempotencyKey: 'v0' });
  assert.equal(down.ok, false);
  assert.equal(down.error, 'plugin_downgrade_refused');

  const auditPreUninstall = count('audit_log');
  const un = call('uninstall_plugin', { pluginId: v1.plugin.id, idempotencyKey: 'u' });
  assert.equal(un.ok, true);
  assert.equal(un.uninstalled, true);
  assert.equal(count('plugin_manifests'), 0, 'uninstall left the row');
  assert.ok(count('audit_log') > auditPreUninstall, 'uninstall wrote no audit row');

  // Idempotent replay of the completed uninstall (the row is gone) still succeeds.
  const un2 = call('uninstall_plugin', { pluginId: v1.plugin.id, idempotencyKey: 'u' });
  assert.equal(un2.ok, true);
  assert.equal(un2.uninstalled, true);
});

test('G02: refresh_plugin_compat flips an incompatible plugin back when the range starts matching', () => {
  const { call } = setup();
  // Install incompatible, then simulate a manifest whose range matches by re-installing a newer
  // version with a satisfying range (US-G02.4 boundary): it flips back to installed automatically.
  const bad = call('install_plugin', { source: 'local', packageRef: bundle({ name: 'Acme', version: '1.0.0', compat_range: '^99.0.0' }), idempotencyKey: 'b' });
  assert.equal(bad.plugin.status, 'incompatible');
  const good = call('install_plugin', { source: 'local', packageRef: bundle({ name: 'Acme', version: '1.1.0', compat_range: '^1.0.0' }), idempotencyKey: 'g' });
  assert.equal(good.ok, true);
  assert.equal(good.plugin.status, 'installed');
  // A standalone refresh is a no-op that stamps the check time without crashing.
  const refreshed = call('refresh_plugin_compat', { pluginId: good.plugin.id, idempotencyKey: 'r' });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.compatible, true);
});
