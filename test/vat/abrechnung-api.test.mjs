/**
 * A07's tri-mapping: engine verb + MCP tool + REST twin, proven to be ONE code path.
 *
 * The registry is parity by construction (both adapters resolve the same `ActionDef` and call the
 * same `run`), but "by construction" is a claim about code that someone can break by adding a
 * second dispatch path. So these tests do not assert that the two faces exist; they assert that the
 * two faces return the SAME BYTES for the same input, and that the engine verb agrees with both.
 *
 * The REST status mapping is part of the contract too: a domain refusal is 422 and not 500, because
 * `needs_vat_config` is the request being well-formed and the domain saying no.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';

const AT = '2026-07-16T00:00:00.000Z';

/** A workspace minted through the registry, with MWST configured, exactly as a host would. */
function world({ method = 'effektiv', timing = 'soll', saldoRates } = {}) {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Acme GmbH', idempotencyKey: 'ws' });
  const mcp = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const rest = (name, input) => handleRest(name, { workspaceId, ...input }, deps);
  mcp('vat_configure', {
    method,
    timing,
    registered: true,
    idempotencyKey: 'cfg',
    ...(saldoRates ? { saldoRates } : method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
  });
  const accId = (number) =>
    deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  return { deps, workspaceId, mcp, rest, accId };
}

/** Post a taxable sale through the registry's own post_entry, tax legs included. */
function sale(w, { net, taxCode, tax, date = '2026-05-15' }) {
  const r = w.mcp('post_entry', {
    date,
    source: 'manual',
    idempotencyKey: `s-${taxCode}-${net}`,
    lines: [
      { account: w.accId('1100'), debit: net + tax },
      { account: w.accId('3200'), credit: net, taxCode, taxBase: net, taxAmount: tax, supplyDate: date },
      { account: w.accId('2200'), credit: tax },
    ],
  });
  assert.equal(r.ok, true, `sale post failed: ${JSON.stringify(r)}`);
  return r;
}

const Q2 = { periodStart: '2026-04-01', periodEnd: '2026-06-30' };

test('A07 tri-mapping: vat_return over MCP and over REST return byte-identical results', () => {
  const w = world();
  sale(w, { net: 1000000, taxCode: 'UST81', tax: 81000 });
  sale(w, { net: 500000, taxCode: 'UST26', tax: 13000 });

  const viaMcp = w.mcp('vat_return', Q2);
  const viaRest = w.rest('vat_return', Q2);

  assert.equal(viaRest.status, 200);
  assert.deepEqual(viaRest.body, viaMcp, 'the two adapters must not be able to drift');
  assert.equal(viaMcp.totalTaxDueMinor, 94000);
});

test('A07 tri-mapping: vat_periods over MCP and over REST agree', () => {
  const w = world();
  const viaMcp = w.mcp('vat_periods', { year: '2026' });
  const viaRest = w.rest('vat_periods', { year: '2026' });
  assert.equal(viaRest.status, 200);
  assert.deepEqual(viaRest.body, viaMcp);
  assert.deepEqual(
    viaMcp.periods.map((p) => p.label),
    ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'],
  );
});

test('A07 tri-mapping: vat_mark_filed writes through REST and seals the months', () => {
  const w = world();
  sale(w, { net: 1000000, taxCode: 'UST81', tax: 81000 });

  // A35/D103: the agent seat's vat_mark_filed is strong-default ASK at the transports, so the
  // fixture performs the explicit attributed grant first; the drafting path has its own suite in
  // test/agent/agent-gate.test.mjs.
  assert.equal(handleRest('set_agent_dial', { workspaceId: w.workspaceId, capability: 'vat-file', level: 'auto', idempotencyKey: 'vf-g' }, { ...w.deps, actor: 'studio' }).body.ok, true);
  const res = w.rest('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'r-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const locks = w.deps.store.db
    .prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed' ORDER BY period")
    .all(w.workspaceId)
    .map((r) => r.period);
  assert.deepEqual(locks, ['2026-04', '2026-05', '2026-06']);
});

test('A07 tri-mapping §H-IDEMPOTENT: a REST replay mints no second lock, counted in ROWS', () => {
  const w = world();
  const rows = () =>
    w.deps.store.db.prepare('SELECT COUNT(*) AS c FROM period_lock WHERE workspace_id = ?').get(w.workspaceId).c;

  // A35/D103: the explicit attributed grant, so the strong-default vat-file executes over REST.
  handleRest('set_agent_dial', { workspaceId: w.workspaceId, capability: 'vat-file', level: 'auto', idempotencyKey: 'vf-g' }, { ...w.deps, actor: 'studio' });
  w.rest('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'r-1' });
  const after = rows();
  assert.equal(after, 3);
  w.rest('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'r-1' });
  assert.equal(rows(), after);
});

test('A07 tri-mapping: a domain refusal is 422 on REST, never a 500 or a thrown protocol error', () => {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Unconfigured AG', idempotencyKey: 'ws' });
  const res = handleRest('vat_return', { workspaceId, ...Q2 }, deps);
  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'needs_vat_config');
});

test('A07 tri-mapping: §H-TENANT is enforced at the adapter, a missing workspaceId never reads', () => {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
  const res = handleRest('vat_return', Q2, deps);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'invalid_input');
  assert.equal(res.body.field, 'workspaceId');
});

test('A07 tri-mapping: the saldo return reports on 323 through both faces', () => {
  const w = world({ method: 'saldo', saldoRates: [{ rateBp: 620 }] });
  sale(w, { net: 1000000, taxCode: 'UST81', tax: 81000 });
  sale(w, { net: 500000, taxCode: 'UST26', tax: 13000 });

  const viaMcp = w.mcp('vat_return', Q2);
  const viaRest = w.rest('vat_return', Q2);
  assert.deepEqual(viaRest.body, viaMcp);
  assert.equal(viaMcp.method, 'saldo');
  assert.equal(viaMcp.lines.find((l) => l.code === '323').taxMinor, 98828);
});
