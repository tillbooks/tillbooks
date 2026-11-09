/**
 * The switch-year calendar on era layouts the engine no longer writes but a book can still hold
 * (critic round 4 on claude/chokepoint-vat-labels, 14.10.2026, L-R4-1 and L-R4-2).
 *
 * Before the O1 fix (round 2) `vat_configure` accepted any `methodChange.validFrom`, so a book can carry a
 * mid-year boundary that is NOT a MWSTV Art. 81 Abs. 2 switch: effektiv to Saldo inside a year, a tax
 * liability recorded as an era starting mid-year, or a timing-only (Soll to Ist) boundary. The calendar
 * handles them (each method files its periods inside its era), but the refusal reasons cited MWSTV
 * Art. 81 Abs. 2 for every boundary. That basis is named now only for a Saldo to effektiv switch; any
 * other boundary is described neutrally, with its date and no legal basis claimed. A timing-only
 * boundary is no calendar change at all: the two effektiv eras merge into one year of quarters.
 *
 * The legacy eras are written straight into `vat_method_era`, the table `methodChange` writes, because no
 * verb writes these layouts any more. Synthetic workspaces in memory; no real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-12-31T00:00:00.000Z';

/** A book whose CURRENT method is `current`, carrying the closed `eras` a pre-O1 TILL could have written. */
function legacyBook(current, eras) {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Altbestand AG', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const cfg = call('vat_configure', {
    method: current.method,
    timing: current.timing ?? 'soll',
    registered: true,
    idempotencyKey: 'cfg',
    ...(current.method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const ins = deps.store.db.prepare(
    'INSERT INTO vat_method_era (workspace_id, valid_from, valid_to, method, timing, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const e of eras) ins.run(workspaceId, e.from, e.to, e.method, e.timing ?? 'soll', AT, 'legacy');
  const locks = () => deps.store.db.prepare('SELECT period FROM period_lock WHERE workspace_id = ? ORDER BY period').all(workspaceId).map((r) => r.period);
  return { call, locks };
}

// --- L-R4-1: the legal basis is cited only for a Saldo to effektiv switch ------------------------

test('L-R4-1: an effektiv to Saldo boundary on 01.10 is described neutrally, never as MWSTV Art. 81 Abs. 2', () => {
  const w = legacyBook({ method: 'saldo' }, [{ from: '0001-01-01', to: '2026-09-30', method: 'effektiv' }]);
  const p = w.call('vat_periods', { year: '2026' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.periods.map((x) => [x.label, x.method]), [['2026-Q1', 'effektiv'], ['2026-Q2', 'effektiv'], ['2026-Q3', 'effektiv']]);
  assert.deepEqual(p.stubs, [{ label: '2026-H2', method: 'saldo', periodStart: '2026-10-01', periodEnd: '2026-12-31' }]);

  const stub = w.call('vat_mark_filed', { period: '2026-H2', idempotencyKey: 'h2' });
  assert.equal(stub.error, 'switch_year_stub_not_modelled', JSON.stringify(stub));
  assert.doesNotMatch(stub.reason, /Art\. 81/, 'no legal basis is claimed for an effektiv to Saldo boundary');
  assert.match(stub.reason, /changed inside the year on 2026-10-01/);

  const h1 = w.call('vat_mark_filed', { period: '2026-H1', idempotencyKey: 'h1' });
  assert.equal(h1.error, 'not_a_filing_period', JSON.stringify(h1));
  assert.doesNotMatch(h1.reason, /Art\. 81/);
  assert.match(h1.reason, /changed inside the year on 2026-10-01/);
  assert.deepEqual(w.locks(), []);
});

test('L-R4-1: a tax liability recorded as an era from 01.07 is described neutrally too', () => {
  const w = legacyBook({ method: 'effektiv' }, [{ from: '0001-01-01', to: '2026-06-30', method: 'none' }]);
  const p = w.call('vat_periods', { year: '2026' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.periods.map((x) => x.label), ['2026-Q3', '2026-Q4']);
  assert.deepEqual(p.stubs, []);
  const q1 = w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: 'q1' });
  assert.equal(q1.error, 'not_a_filing_period', JSON.stringify(q1));
  assert.doesNotMatch(q1.reason, /Art\. 81/);
  assert.match(q1.reason, /changed inside the year on 2026-07-01/);
});

test('L-R4-1: a Saldo to effektiv switch still names MWSTV Art. 81 Abs. 2 and its day', () => {
  const w = legacyBook({ method: 'effektiv' }, [{ from: '0001-01-01', to: '2026-06-30', method: 'saldo' }]);
  const h2 = w.call('vat_mark_filed', { period: '2026-H2', idempotencyKey: 'h2' });
  assert.equal(h2.error, 'not_a_filing_period', JSON.stringify(h2));
  assert.match(h2.reason, /MWSTV Art\. 81 Abs\. 2/);
  assert.match(h2.reason, /2026-07-01/);
});

// --- L-R4-2: a timing-only boundary is no calendar change ----------------------------------------

for (const boundary of ['2026-07-01', '2026-05-01']) {
  test(`L-R4-2: a legacy Soll to Ist boundary under effektiv on ${boundary} keeps Q1 to Q4 and no stub`, () => {
    // On 01.07 the boundary falls between quarters; on 01.05 it falls INSIDE Q2, which only the
    // same-method merge keeps whole (unmerged, Q2 would split into two stubs).
    const prev = new Date(Date.parse(`${boundary}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const w = legacyBook({ method: 'effektiv', timing: 'ist' }, [{ from: '0001-01-01', to: prev, method: 'effektiv', timing: 'soll' }]);
    const p = w.call('vat_periods', { year: '2026' });
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.deepEqual(p.periods.map((x) => [x.label, x.method]), [
      ['2026-Q1', 'effektiv'],
      ['2026-Q2', 'effektiv'],
      ['2026-Q3', 'effektiv'],
      ['2026-Q4', 'effektiv'],
    ]);
    assert.deepEqual(p.stubs, []);
    // A timing-only boundary is no method change: a refusal names none.
    const h1 = w.call('vat_mark_filed', { period: '2026-H1', idempotencyKey: 'h1' });
    assert.equal(h1.error, 'not_a_filing_period', JSON.stringify(h1));
    assert.doesNotMatch(h1.reason, /changed inside the year|switched/);
    assert.equal(w.call('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'q2' }).ok, true);
    assert.deepEqual(w.locks(), ['2026-04', '2026-05', '2026-06']);
  });
}
