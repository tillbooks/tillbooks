// Critic D186 (non-author): RBAC of the series parts and the estimate verb. Synthetic by construction.
import test from 'node:test';
import assert from 'node:assert/strict';
const { dashboardSeries } = await import('../../dist/core/dashboards/index.js');
const { getAction } = await import('../../dist/api/registry.js').catch(() => ({}));
const { world, importLines, must, postedBill } = await import('../banking/bank-inbox-support.mjs');

test('critic D186-9: a read_books seat without read_sales gets the series with balances and vendors null', () => {
  const t = world();
  postedBill(t, { grossMinor: 50000, seed: 'rb', vendorName: 'Druckerei Lindenhof AG' });
  importLines(t, { statementId: 'RB', openingMinor: 100000, entries: [{ ref: 'F', amountMinor: 500, cd: 'DBIT', name: 'Kontoführung' }] });
  const narrow = { ...t.ctx, capabilities: { ...t.ctx.capabilities, assert: (cap) => (cap === 'read_sales' ? { ok: false, error: 'permission_denied' } : t.ctx.capabilities.assert(cap)) } };
  const s = must(dashboardSeries(narrow, { from: '2026-01-01', to: '2026-12-31' }));
  assert.equal(s.balances, null);
  assert.equal(s.topVendors, null);
  assert.deepEqual(s.omitted, ['balances', 'topVendors']);
  const full = must(dashboardSeries(t.ctx, { from: '2026-01-01', to: '2026-12-31' }));
  console.log(JSON.stringify({ vendors: full.topVendors, unattributed: full.unattributedExpenseMinor, jul: full.balances.find((b) => b.month === '2026-07') }));
});
