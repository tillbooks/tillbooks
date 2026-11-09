// Critic A41.3 r1 (non-author), probe group D: the doors around the assignment. Agent paths to the three
// human-only settings and the intake seat, §H-TENANT on the new verbs and the engine pass, and I-E side
// channels for a seat without the receipt read right.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { makeContext } from '../../dist/core/context.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments, assignBeleg as assignEngine, releaseBeleg, confirmCaptureFigures } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { ok, err } from '../../dist/core/result.js';
import { getAuditLog } from '../../dist/core/ledger/auditLog.js';
import { must, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, activeOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';
const SETTINGS = [
  ['rules.autobook_requires_beleg', 'off'],
  ['belege.autobook_figure_trust', 'agent'],
  ['belege.qr_trust_folder', 'off'],
];

function granted(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `grant-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'critic', idempotencyKey: `sc-${tag}` }));
  at(t, LATER);
  return { ...t, ap: autopilot(t) };
}
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;

test('D1 (held): the three human-only settings refuse an agent over REST and MCP, a plugin call, and a G01 rule', () => {
  const t = granted('d1');
  for (const [key, value] of SETTINGS) {
    const args = { workspaceId: t.workspaceId, key, value, reason: 'critic', idempotencyKey: `d1-${key}` };
    assert.equal(handleRest('settings_set', args, { ...t.deps, actor: 'agent' }).body.error, 'human_only', `REST ${key}`);
    const mcp = JSON.parse(callTool({ ...t.deps, actor: 'agent' }, 'settings_set', { ...args, idempotencyKey: `d1m-${key}` }).content[0].text);
    assert.equal(mcp.error, 'human_only', `MCP ${key}`);
    const plugin = withinPluginCall('user_1', () => getAction('settings_set').run({ ...t.deps, actor: 'user_1' }, { ...args, idempotencyKey: `d1p-${key}` }));
    assert.equal(plugin.error, 'human_only', `plugin ${key}`);
    const rule = getAction('create_automation_rule').run({ ...t.deps, actor: 'user_1' }, {
      workspaceId: t.workspaceId,
      name: `Auto ${key}`,
      trigger: { event: 'qr_match.needs_review' },
      action: { tool: 'settings_set', inputTemplate: args },
      idempotencyKey: `d1g-${key}`,
    });
    assert.equal(rule.ok, false, `G01 ${key}: ${JSON.stringify(rule).slice(0, 160)}`);
  }
});

test('D2 (held): a capture a plugin makes, running as its installing person, records a machine intake', () => {
  const t = granted('d2');
  const up = withinPluginCall('user_1', () =>
    getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from('plugin bytes d2').toString('base64'), mime: 'application/pdf', filename: 'p.pdf', idempotencyKey: 'd2-in' }),
  );
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(t.store.db.prepare('SELECT intake_seat FROM captures WHERE id = ?').get(up.captureId).intake_seat, 'machine');
});

test('D3 (held): §H-TENANT, another workspace can neither assign, release nor confirm this one\'s rows, and its engine pass writes nothing here', () => {
  const t = granted('d3');
  const [line] = debits(t, [1680], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1680, vendor: TELCO, date: dateOf(t, line) });
  const b = secondWorkspace(t);
  const bCtx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids });
  assert.equal(assignEngine(bCtx, { bankTxnId: line, fileIds: [r.fileId], idempotencyKey: 'd3-a' }).error, 'not_found');
  assert.equal(releaseBeleg(bCtx, { bankTxnId: line, idempotencyKey: 'd3-r' }).error, 'not_found');
  assert.equal(confirmCaptureFigures(bCtx, { captures: [{ captureId: r.captureId, expected: { sha256: 'x', fields: {} } }], idempotencyKey: 'd3-c' }).error, 'not_found');
  const report = reconcileEngineAssignments(bCtx, STATEMENT_COVERS_SQL);
  assert.deepEqual(report, { created: [], released: [] });
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM beleg_assignment WHERE workspace_id = ?').get(b.workspaceId).n, 0);
  // This workspace's own pass still pairs it.
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
});

test('D4 (I-E side channel): a seat without the receipt read right reads every assignment, release and consumption off the audit log', () => {
  const t = granted('d4');
  const [line] = debits(t, [1690], { from: '2026-04-01' });
  must(assignBeleg(t, line, [receipt(t, { amount: 1690, vendor: TELCO, date: '2026-03-01' }).fileId]));
  must(getAction('release_beleg').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, idempotencyKey: 'd4-rel' }));
  // The seat holds the books and the bank lines, not the receipts (read_master_data).
  const denying = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (c === 'read_master_data' ? err('permission_denied', { capability: c }) : ok()) },
  });
  assert.equal(must(getAction('list_bank_inbox').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, status: 'all' })).lines.length, 1, 'precondition: the line exists');
  // get_audit_log asks read_books (actionCapabilities.ts), which the seat holds; the engine read itself
  // checks nothing more, so the denying seat reads exactly what the verb would answer it.
  const res = getAuditLog(denying, {});
  assert.equal(res.ok, true);
  const viaDenying = res.rows.filter((e) => e.entityId === line && String(e.action).startsWith('beleg_')).map((e) => e.action);
  assert.deepEqual(viaDenying, [], `the audit log hands a seat without read_master_data the line's receipt history: ${JSON.stringify(viaDenying)}`);
});
