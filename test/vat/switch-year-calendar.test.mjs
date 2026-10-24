/**
 * The filing calendar of a MWSTV Art. 81 Abs. 2 switch year (critic round 3 on
 * claude/chokepoint-vat-labels, 14.10.2026, finding R3-M1).
 *
 * MWSTG Art. 35 Abs. 1 files quarterly, and half-yearly under Saldosteuersätze. MWSTV Art. 81 Abs. 2 (AS
 * 2024 485, in force 1.1.2025) lets a Saldo filer switch to the effektiv method on the day the ESTV adjusts
 * its Saldosteuersatz, inside the year. Round 3 admitted that switch, but the year's filing calendar still
 * came from the 01.01 method for all twelve months: after a 01.07 switch `vat_mark_filed 2026-Q3` (the
 * first effektiv quarter, the very return the filer owes) refused "was never a return", and `2026-H2` was
 * accepted and sealed October to December before they were filed.
 *
 * The calendar now comes from the method ERAS (`filingPeriodsOfYear`, one source for `vat_periods`,
 * `vat_mark_filed` and the `export_vat` verdict): each method's statutory periods that lie WHOLLY inside its
 * era. A switch on 01.07 gives H1 (Saldo), Q3 and Q4 (effektiv). A switch inside a period (01.10 under
 * Saldo cuts H2 to July to September) leaves a STUB that TILL computes (vat_return by dates, eCH-0217 with
 * periodDeviationApproved) but does not seal: `vat_mark_filed` refuses any label touching it with
 * `switch_year_stub_not_modelled`, which says how to file it, and seals no month of it.
 *
 * Synthetic workspaces in memory; no real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-12-31T00:00:00.000Z';

/** A Saldo book (620 bp) whose rate the ESTV adjusts to 680 bp on `switchDay`, switching to effektiv that day. */
function switchYearBook(switchDay) {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Wechseljahr AG', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const ok = (r, what) => {
    assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
    return r;
  };
  ok(call('update_company_profile', { uid: 'CHE-116.281.271' }), 'uid'); // the synthetic UID the eCH-0217 suite uses
  ok(call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], idempotencyKey: 'cfg' }), 'saldo');
  ok(call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 680 }], saldoGrant: { validFrom: switchDay }, idempotencyKey: 'grant' }), 'grant');
  ok(call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, methodChange: { validFrom: switchDay, basis: 'mwstv_81_2' }, idempotencyKey: 'switch' }), 'switch');
  const locks = () => deps.store.db.prepare('SELECT period FROM period_lock WHERE workspace_id = ? ORDER BY period').all(workspaceId).map((r) => r.period);
  return { call, locks };
}

const months = (from, to) => {
  const out = [];
  for (let m = from; m <= to; m += 1) out.push(`2026-${String(m).padStart(2, '0')}`);
  return out;
};

// --- a switch on 01.07: H1 under Saldo, then Q3 and Q4 effektiv -----------------------------------

test('R3-M1 01.07 switch: vat_periods lists H1 (Saldo), Q3 and Q4 (effektiv)', () => {
  const w = switchYearBook('2026-07-01');
  const p = w.call('vat_periods', { year: '2026' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(
    p.periods.map((x) => [x.label, x.method, x.periodStart, x.periodEnd]),
    [
      ['2026-H1', 'saldo', '2026-01-01', '2026-06-30'],
      ['2026-Q3', 'effektiv', '2026-07-01', '2026-09-30'],
      ['2026-Q4', 'effektiv', '2026-10-01', '2026-12-31'],
    ],
  );
  assert.deepEqual(p.stubs, []);
});

test('R3-M1 01.07 switch: vat_mark_filed seals Q3 exactly, and refuses H2 without sealing Q4', () => {
  const w = switchYearBook('2026-07-01');
  const q3 = w.call('vat_mark_filed', { period: '2026-Q3', idempotencyKey: 'q3' });
  assert.equal(q3.ok, true, JSON.stringify(q3));
  assert.deepEqual(w.locks(), months(7, 9), 'July to September and nothing else');

  const h2 = w.call('vat_mark_filed', { period: '2026-H2', idempotencyKey: 'h2' });
  assert.equal(h2.error, 'not_a_filing_period', JSON.stringify(h2));
  assert.deepEqual(h2.filingPeriods, ['2026-H1', '2026-Q3', '2026-Q4']);
  assert.doesNotMatch(h2.reason, /never a return/);
  assert.match(h2.reason, /2026-Q3 \(effektiv\)/);
  assert.deepEqual(w.locks(), months(7, 9), 'Q4 stays open: no unfiled month is sealed');

  assert.equal(w.call('vat_mark_filed', { period: '2026-H1', idempotencyKey: 'h1' }).ok, true);
  assert.deepEqual(w.locks(), months(1, 9));
});

test('R3-M1 01.07 switch: export_vat judges Q3 a filing period, and its verdict method agrees with its figures', () => {
  const w = switchYearBook('2026-07-01');
  const q3 = w.call('export_vat', { period: '2026-Q3' });
  assert.equal(q3.ok, true, JSON.stringify(q3));
  assert.equal(q3.filingPeriod, true);
  assert.equal(q3.notice, 'empty_period');
  assert.equal(q3.artifact.method, 'effektiv');
  const h2 = w.call('export_vat', { period: '2026-H2' });
  assert.equal(h2.ok, true, JSON.stringify(h2));
  assert.equal(h2.notice, 'not_a_filing_period');
  assert.equal(h2.filingMethod, 'effektiv', 'the method governing that span, the same as the figures');
  assert.equal(h2.artifact.method, 'effektiv');
});

test('R3-M1 01.07 switch: the effektiv quarter exports as eCH-0217', () => {
  const w = switchYearBook('2026-07-01');
  const x = w.call('vat_export_ech0217', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(x.ok, true, JSON.stringify(x).slice(0, 400));
});

// --- a switch on 01.10: H1 under Saldo, a Saldo stub July to September, Q4 effektiv ---------------

test('R3-M1 01.10 switch: vat_periods lists H1 and Q4, and names the July to September Saldo stub', () => {
  const w = switchYearBook('2026-10-01');
  const p = w.call('vat_periods', { year: '2026' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.periods.map((x) => [x.label, x.method]), [['2026-H1', 'saldo'], ['2026-Q4', 'effektiv']]);
  assert.deepEqual(p.stubs, [{ label: '2026-H2', method: 'saldo', periodStart: '2026-07-01', periodEnd: '2026-09-30' }]);
});

test('R3-M1 01.10 switch: vat_mark_filed refuses the stub honestly and seals no month of it; Q4 seals exactly', () => {
  const w = switchYearBook('2026-10-01');
  for (const period of ['2026-Q3', '2026-H2']) {
    const r = w.call('vat_mark_filed', { period, idempotencyKey: `s-${period}` });
    assert.equal(r.error, 'switch_year_stub_not_modelled', `${period}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.stub, { label: '2026-H2', method: 'saldo', periodStart: '2026-07-01', periodEnd: '2026-09-30' });
    assert.match(r.reason, /vat_return/, 'it says what TILL computes correctly');
    assert.match(r.hint, /ePortal/, 'and how to file it');
    assert.match(r.hint, /periodDeviationApproved/);
    assert.match(r.reason, /does not seal|seals no/);
    assert.doesNotMatch(r.reason, /never a return/);
  }
  assert.deepEqual(w.locks(), [], 'no month of the stub is sealed');
  assert.equal(w.call('vat_mark_filed', { period: '2026-Q4', idempotencyKey: 'q4' }).ok, true);
  assert.deepEqual(w.locks(), months(10, 12));
});

test('R3-M1 01.10 switch: export_vat flags the stub and judges Q4 by the effektiv era', () => {
  const w = switchYearBook('2026-10-01');
  const q4 = w.call('export_vat', { period: '2026-Q4' });
  assert.equal(q4.ok, true, JSON.stringify(q4));
  assert.equal(q4.filingPeriod, true);
  assert.equal(q4.artifact.method, 'effektiv');
  const q3 = w.call('export_vat', { period: '2026-Q3' });
  assert.equal(q3.ok, true, JSON.stringify(q3));
  assert.equal(q3.filingPeriod, false);
  assert.equal(q3.notice, 'switch_year_stub_not_modelled');
  assert.equal(q3.filingMethod, 'saldo');
  assert.equal(q3.artifact.method, 'saldo');
});

test('R3-M1 01.10 switch: the stub computes by dates and exports as eCH-0217 under the stated deviation', () => {
  const w = switchYearBook('2026-10-01');
  const r = w.call('vat_return', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'saldo');
  const plain = w.call('vat_export_ech0217', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(plain.error, 'period_length_not_statutory', JSON.stringify(plain).slice(0, 300));
  assert.match(plain.nextStep, /Art\. 81 Abs\. 2/, 'the step names the switch-year stub as a sanctioned deviation (L-R3-3)');
  const approved = w.call('vat_export_ech0217', { periodStart: '2026-07-01', periodEnd: '2026-09-30', periodDeviationApproved: true });
  assert.notEqual(approved.error, 'period_length_not_statutory', JSON.stringify(approved).slice(0, 300));
});

test('R3-M1: the straddle refusal no longer claims a quarter or half-year never spans a method change', () => {
  const w = switchYearBook('2026-10-01');
  const r = w.call('vat_return', { periodStart: '2026-07-01', periodEnd: '2026-12-31' });
  assert.equal(r.error, 'period_straddles_method_change', JSON.stringify(r));
  assert.doesNotMatch(r.hint, /never spans one/);
  assert.match(r.hint, /Art\. 81 Abs\. 2/);
});
