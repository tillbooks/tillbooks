/**
 * G02's money-path ABSENCE, asserted rather than documented (spec §4/§7: G02's job is to guarantee no
 * plugin ever gets a path to money, so it computes none itself). Three legs:
 *
 *   1. Neither owned table carries a money column, read off the live PRAGMA so a migration that adds
 *      one reddens this file on the day it lands.
 *   2. The plugin engine reaches no `postEntry`/`recordPayment` and writes no journal/payment row
 *      directly (the import/CALL probe lives in `sandbox.test.mjs`; here we prove it behaviourally).
 *   3. A full install -> enable -> disable -> uninstall flow, with capabilities, leaves the journal at
 *      ZERO entries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

test('G02: neither owned table carries a money column', () => {
  const store = new SqliteStore();
  for (const table of ['plugin_manifests', 'plugin_capability_registrations']) {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length >= 5, `PRAGMA answered nothing for ${table}: the probe is broken`);
    const money = columns.filter((n) => n.includes('_rappen') || n.includes('_minor') || n.includes('amount'));
    assert.deepEqual(money, [], `${table} grew money columns: ${money.join(', ')}`);
  }
});

test('G02: a full plugin lifecycle posts ZERO journal entries', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const journalCount = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
  const paymentCount = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(journalCount(), 0, 'a fresh workspace already has journal entries: the probe is broken');

  const payload = 'p';
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const packageRef = {
    manifest: {
      name: 'Acme',
      version: '1.0.0',
      compat_range: '^1.0.0',
      sha256,
      capabilities: [
        { kind: 'mcp_tool', name: 'acme_forecast' },
        { kind: 'automation_action', name: 'send_invoice' },
        { kind: 'report_source', name: 'acme_sales' },
      ],
      permissions: { requested: ['mcp_tool:list_invoices'] },
    },
    payload,
  };

  const installed = call('install_plugin', { source: 'local', packageRef, grantedScopes: ['mcp_tool:list_invoices'], idempotencyKey: 'i' });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const pluginId = installed.plugin.id;
  call('disable_plugin', { pluginId, idempotencyKey: 'd' });
  call('enable_plugin', { pluginId, idempotencyKey: 'e' });
  call('refresh_plugin_compat', { pluginId, idempotencyKey: 'r' });
  const un = call('uninstall_plugin', { pluginId, idempotencyKey: 'u' });
  assert.equal(un.ok, true);

  assert.equal(journalCount(), 0, 'the plugin lifecycle posted a journal entry: the P3 boundary is broken');
  assert.equal(paymentCount(), 0, 'the plugin lifecycle wrote a payment row');
});
