/**
 * A07's period labels (`YYYY-Qn`, `YYYY-Hn`): what a label is, and which label a book may FILE
 * (critic round 2 on claude/chokepoint-vat-labels, 14.10.2026, findings L1 and L2).
 *
 * L1. `monthsOfVatPeriod` built its month strings from `Number(year)`, which drops the zero padding:
 *     `0999-Q1` became `999-01`, `vat_mark_filed` echoed that garbled month, and `export_vat` threw a
 *     TypeError (unexpected_error) instead of answering `invalid_period`. A label now keeps its year as
 *     written, and a year before the MWST era is not a VAT period at all: the Mehrwertsteuer replaced
 *     the Warenumsatzsteuer on 1 January 1995 (MWSTV of 22 June 1994, in force 1.1.1995), so no
 *     MWST return exists for 1994 or earlier.
 *
 * L2. A label that is not a filing period for the book's method in that year (a Saldo book's
 *     `2026-Q3`, an effektiv book's `2026-H2`) was sealed by `vat_mark_filed` as if it had been filed.
 *     MWSTG Art. 35 Abs. 1 files quarterly, and half-yearly under Saldosteuersätze, so such a seal is
 *     a false statement of fact. It is refused, naming the year's filing periods.
 *
 * Synthetic workspaces in memory; no real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';
import { monthsOfVatPeriod, MWST_FIRST_YEAR } from '../../dist/core/vat/index.js';

const AT = '2026-10-14T00:00:00.000Z';

function world({ method = 'effektiv' } = {}) {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Label AG', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  if (method !== null) {
    const cfg = call('vat_configure', {
      method,
      timing: 'soll',
      registered: true,
      idempotencyKey: 'cfg',
      ...(method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
    });
    assert.equal(cfg.ok, true, JSON.stringify(cfg));
  }
  const locks = () => deps.store.db.prepare('SELECT period FROM period_lock WHERE workspace_id = ? ORDER BY period').all(workspaceId).map((r) => r.period);
  return { call, locks };
}

// --- L1: the label keeps its year, and the MWST era starts in 1995 ---------------------------------

test('L1: the MWST era starts in 1995, and a label keeps its year exactly as written', () => {
  assert.equal(MWST_FIRST_YEAR, 1995);
  assert.deepEqual(monthsOfVatPeriod('1995-Q1'), ['1995-01', '1995-02', '1995-03']);
  assert.deepEqual(monthsOfVatPeriod('2026-H2'), ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
  for (const label of ['0999-Q1', '0000-H1', '0099-Q4', '1994-Q4', '1994-H2']) {
    assert.equal(monthsOfVatPeriod(label), null, `${label} is not a VAT period`);
  }
});

test('L1: vat_mark_filed refuses a pre-MWST label as invalid_period and seals nothing', () => {
  const w = world();
  for (const period of ['0999-Q1', '0000-H1', '0099-Q4', '1994-Q4']) {
    const r = w.call('vat_mark_filed', { period, idempotencyKey: `f-${period}` });
    assert.equal(r.ok, false, `${period}: ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_period', `${period}: ${JSON.stringify(r)}`);
    assert.equal(r.period, period, 'the refusal echoes the label as given, never a garbled month');
  }
  assert.deepEqual(w.locks(), []);
});

test('L1: vat_periods refuses a pre-MWST year instead of listing garbled periods', () => {
  const w = world();
  for (const year of ['0999', '0000', '1994']) {
    const r = w.call('vat_periods', { year });
    assert.equal(r.ok, false, `${year}: ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_input', `${year}: ${JSON.stringify(r)}`);
    assert.equal(r.field, 'year');
  }
  const first = w.call('vat_periods', { year: '1995' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.periods.map((p) => [p.label, p.periodStart, p.periodEnd]), [
    ['1995-Q1', '1995-01-01', '1995-03-31'],
    ['1995-Q2', '1995-04-01', '1995-06-30'],
    ['1995-Q3', '1995-07-01', '1995-09-30'],
    ['1995-Q4', '1995-10-01', '1995-12-31'],
  ]);
});

// --- L2: only a filing period of the book's method can be sealed as filed --------------------------

test('L2: vat_mark_filed refuses a Saldo book quarter and an effektiv book half-year, sealing nothing', () => {
  const saldo = world({ method: 'saldo' });
  const q3 = saldo.call('vat_mark_filed', { period: '2026-Q3', idempotencyKey: 's-q3' });
  assert.equal(q3.ok, false, JSON.stringify(q3));
  assert.equal(q3.error, 'not_a_filing_period');
  assert.equal(q3.period, '2026-Q3');
  assert.equal(q3.method, 'saldo');
  assert.deepEqual(q3.filingPeriods, ['2026-H1', '2026-H2']);
  assert.deepEqual(saldo.locks(), [], 'no month of the quarter was sealed');

  const eff = world();
  const h2 = eff.call('vat_mark_filed', { period: '2026-H2', idempotencyKey: 'e-h2' });
  assert.equal(h2.ok, false, JSON.stringify(h2));
  assert.equal(h2.error, 'not_a_filing_period');
  assert.equal(h2.method, 'effektiv');
  assert.deepEqual(h2.filingPeriods, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(eff.locks(), []);
});

test('L2: the filing periods themselves still seal, and vat_periods then reports them filed', () => {
  const saldo = world({ method: 'saldo' });
  const h1 = saldo.call('vat_mark_filed', { period: '2026-H1', idempotencyKey: 's-h1' });
  assert.equal(h1.ok, true, JSON.stringify(h1));
  assert.deepEqual(saldo.locks(), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.deepEqual(saldo.call('vat_periods', { year: '2026' }).periods.map((p) => [p.label, p.filed]), [
    ['2026-H1', true],
    ['2026-H2', false],
  ]);

  const eff = world();
  const q2 = eff.call('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'e-q2' });
  assert.equal(q2.ok, true, JSON.stringify(q2));
  assert.deepEqual(eff.locks(), ['2026-04', '2026-05', '2026-06']);
});

test('L2: the method that governed THAT year decides, not today\'s', () => {
  // Saldo until 31.12.2026, effektiv from 01.01.2027 (MWSTG Art. 37 Abs. 4: at the start of a Steuerperiode).
  const w = world({ method: 'saldo' });
  const moved = w.call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, methodChange: { validFrom: '2027-01-01' }, idempotencyKey: 'mc' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(w.call('vat_mark_filed', { period: '2026-H2', idempotencyKey: 'h2' }).ok, true, '2026 was a Saldo year');
  assert.equal(w.call('vat_mark_filed', { period: '2026-Q4', idempotencyKey: 'q4' }).error, 'not_a_filing_period');
  assert.equal(w.call('vat_mark_filed', { period: '2027-Q1', idempotencyKey: 'q1' }).ok, true, '2027 is an effektiv year');
  assert.equal(w.call('vat_mark_filed', { period: '2027-H1', idempotencyKey: 'h1' }).error, 'not_a_filing_period');
});
