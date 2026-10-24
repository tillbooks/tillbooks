/**
 * A dated method change takes effect at the start of a Steuerperiode, with one exception (critic
 * rounds 2 and 3 on claude/chokepoint-vat-labels, 14.10.2026, O1 and R2-M1).
 *
 * The law, read from the consolidated MWSTG (SR 641.20, fedlex consolidation of 1.1.2025) on 14.10.2026:
 *  - Art. 34 Abs. 2: "Als Steuerperiode gilt das Kalenderjahr." (Abs. 3, the Geschäftsjahr on
 *    application, is marked "noch nicht in Kraft", AS 2009 5203.)
 *  - Art. 37 Abs. 4: the Saldosteuersatzmethode "muss während mindestens einer Steuerperiode
 *    beibehalten werden", a return to it after the effektiv method is possible "frühestens nach drei
 *    Jahren", and "Wechsel sind jeweils auf Beginn einer Steuerperiode möglich."
 *  - Art. 39 Abs. 3: "Die gewählte Abrechnungsart muss während mindestens einer Steuerperiode
 *    beibehalten werden." (Soll / Ist, which the same dated change carries.)
 *  - MWSTV (SR 641.201) in the version of AS 2024 485, in force 1.1.2025 (re-read on fedlex
 *    14.10.2026): Art. 79 Abs. 1 (effektiv to Saldo) and Art. 81 Abs. 1 (Saldo to effektiv) are notified
 *    "bis spätestens 60 Tage nach Beginn der Steuerperiode, ab welcher der Wechsel erfolgen soll", and
 *    Art. 81 Abs. 3 forces the switch "auf den Beginn der folgenden Steuerperiode".
 *  - THE ONE MID-YEAR CASE, MWSTV Art. 81 Abs. 2: "Ein Wechsel ist vor Ablauf der ganzen Steuerperiode
 *    zulässig, wenn mit mindestens einem bewilligten Saldosteuersatz abgerechnet wird, den die ESTV
 *    angepasst hat, ohne dass die Anpassung auf eine Änderung der Steuersätze nach den Artikeln 25 und 55
 *    MWSTG zurückzuführen ist. Der Wechsel erfolgt auf den Zeitpunkt der Änderung des
 *    Saldosteuersatzes." Abs. 5 lets the Abrechnungsart change with that switch. (Art. 80, the
 *    retroactive withdrawal, and Art. 83, the takeover, are not dated method changes.)
 * So a `methodChange.validFrom` is a 01.01, except a Saldo to effektiv switch that states
 * `basis: 'mwstv_81_2'` on the day a stored Saldo approval of this book took effect (the ESTV's
 * adjustment). Round 2 refused that lawful case too (critic R2-M1); round 3 admits exactly it. The start
 * of the tax liability itself (possibly mid-year) is the FIRST method era, which carries no
 * `methodChange` date at all, so it is not affected.
 *
 * Synthetic workspaces in memory; no real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-10-14T00:00:00.000Z';

function world(method = 'effektiv') {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Wechsel AG', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const cfg = call('vat_configure', {
    method,
    timing: 'soll',
    registered: true,
    idempotencyKey: 'cfg',
    ...(method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const eras = () => deps.store.db.prepare('SELECT * FROM vat_method_era WHERE workspace_id = ? ORDER BY valid_to').all(workspaceId);
  return { call, eras };
}

const toSaldo = (validFrom, key) => ({
  method: 'saldo',
  timing: 'soll',
  registered: true,
  saldoRates: [{ rateBp: 620 }],
  methodChange: { validFrom },
  idempotencyKey: key,
});

test('O1: a method change dated inside a calendar year is refused, naming the next start of a Steuerperiode', () => {
  const w = world();
  for (const [validFrom, next] of [
    ['2026-07-01', '2027-01-01'],
    ['2026-04-01', '2027-01-01'],
    ['2026-12-31', '2027-01-01'],
    ['2027-01-02', '2028-01-01'],
  ]) {
    const r = w.call('vat_configure', toSaldo(validFrom, `mc-${validFrom}`));
    assert.equal(r.ok, false, `${validFrom}: ${JSON.stringify(r)}`);
    assert.equal(r.error, 'vat_method_change_not_period_start', `${validFrom}: ${JSON.stringify(r)}`);
    assert.equal(r.validFrom, validFrom);
    assert.equal(r.nextPeriodStart, next, validFrom);
    assert.match(r.hint, new RegExp(next));
  }
  // Nothing moved: still effektiv, no era written.
  assert.equal(w.call('vat_config', {}).config.method, 'effektiv');
  assert.deepEqual(w.eras(), []);
  assert.deepEqual(w.call('vat_periods', { year: '2026' }).periods.map((p) => p.label), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
});

test('O1: a timing change (Soll to Ist) dated inside a year is refused the same way (MWSTG Art. 39 Abs. 3)', () => {
  const w = world();
  const r = w.call('vat_configure', { method: 'effektiv', timing: 'ist', registered: true, methodChange: { validFrom: '2026-10-01' }, idempotencyKey: 'ist' });
  assert.equal(r.error, 'vat_method_change_not_period_start', JSON.stringify(r));
});

test('O1: a change on 01.01 is recorded, and each year keeps its own filing periods', () => {
  const w = world();
  const r = w.call('vat_configure', toSaldo('2027-01-01', 'mc-ok'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.eras().length, 1, 'the effektiv era is closed at 31.12.2026');
  assert.deepEqual(w.call('vat_periods', { year: '2026' }).periods.map((p) => p.label), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(w.call('vat_periods', { year: '2027' }).periods.map((p) => p.label), ['2027-H1', '2027-H2']);
});

test('O1: once a quarter is filed, the refusals hand over the next 01.01, never a mid-year first unfiled day', () => {
  const w = world();
  assert.equal(w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: 'q1' }).ok, true);
  // Undated: the remedy names a date that vat_configure will accept.
  const undated = w.call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], idempotencyKey: 'u' });
  assert.equal(undated.error, 'vat_method_change_undated', JSON.stringify(undated));
  assert.equal(undated.firstUnfiledFrom, '2026-04-01');
  assert.equal(undated.earliestChangeFrom, '2027-01-01');
  assert.match(undated.hint, /2027-01-01/);
  assert.doesNotMatch(undated.hint, /2026-04-01/);
  // Following the hint works.
  assert.equal(w.call('vat_configure', toSaldo(undated.earliestChangeFrom, 'follow')).ok, true);
});

// --- MWSTV Art. 81 Abs. 2: the lawful mid-year switch (critic R2-M1) ------------------------------

/** A Saldo book (620 bp) whose Saldosteuersatz the ESTV adjusts to 680 bp from 01.07.2026. */
function adjustedSaldoBook() {
  const w = world('saldo');
  const grant = w.call('vat_configure', {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    saldoRates: [{ rateBp: 680 }],
    saldoGrant: { validFrom: '2026-07-01' },
    idempotencyKey: 'grant-0701',
  });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  return w;
}

const toEffektiv = (validFrom, extra = {}) => ({
  method: 'effektiv',
  timing: 'soll',
  registered: true,
  methodChange: { validFrom, ...extra },
  idempotencyKey: `eff-${validFrom}-${JSON.stringify(extra)}`,
});

test('R2-M1: Saldo to effektiv on the day the ESTV adjusted the Saldosteuersatz, basis mwstv_81_2, is recorded', () => {
  const w = adjustedSaldoBook();
  const r = w.call('vat_configure', toEffektiv('2026-07-01', { basis: 'mwstv_81_2' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.config.method, 'effektiv');
  const eras = w.eras();
  assert.equal(eras.length, 1, 'the Saldo era is closed');
  assert.equal(eras[0].method, 'saldo');
  assert.equal(eras[0].valid_to, '2026-06-30', 'Saldo governed up to the day before the adjustment');
});

test('R2-M1: the return splits at the switch: H1 under Saldo, July onwards effektiv, the year refuses', () => {
  const w = adjustedSaldoBook();
  assert.equal(w.call('vat_configure', toEffektiv('2026-07-01', { basis: 'mwstv_81_2' })).ok, true);
  const h1 = w.call('vat_return', { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(h1.ok, true, JSON.stringify(h1));
  assert.equal(h1.method, 'saldo', 'the first half-year is a Saldo return');
  const q3 = w.call('vat_return', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(q3.ok, true, JSON.stringify(q3));
  assert.equal(q3.method, 'effektiv', 'from the adjustment day the effektiv method governs');
  const year = w.call('vat_return', { periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  assert.equal(year.error, 'period_straddles_method_change', JSON.stringify(year));
});

test('R2-M1: the Abrechnungsart may change with that switch (MWSTV Art. 81 Abs. 5)', () => {
  const w = adjustedSaldoBook();
  const r = w.call('vat_configure', { ...toEffektiv('2026-07-01', { basis: 'mwstv_81_2' }), timing: 'ist' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.config.timing, 'ist');
});

test('R2-M1: every other mid-year change stays refused, naming what is missing', () => {
  // Without the basis, on the very adjustment day.
  const a = adjustedSaldoBook();
  const noBasis = a.call('vat_configure', toEffektiv('2026-07-01'));
  assert.equal(noBasis.error, 'vat_method_change_not_period_start', JSON.stringify(noBasis));
  assert.deepEqual(noBasis.unmet, ['basis']);
  assert.deepEqual(noBasis.saldoAdjustmentDates, ['2026-07-01']);
  assert.match(noBasis.hint, /mwstv_81_2/);

  // With the basis, but on a day no Saldo approval of this book took effect.
  const notAGrantDay = a.call('vat_configure', toEffektiv('2026-08-01', { basis: 'mwstv_81_2' }));
  assert.equal(notAGrantDay.error, 'vat_method_change_not_period_start', JSON.stringify(notAGrantDay));
  assert.deepEqual(notAGrantDay.unmet, ['saldo_rate_adjusted_on_that_day']);

  // Effektiv to Saldo mid-year (MWSTV Art. 79: only from the start of a Steuerperiode), basis or not.
  const eff = world();
  const toSaldoMid = eff.call('vat_configure', { ...toSaldo('2026-07-01', 'ts-mid'), methodChange: { validFrom: '2026-07-01', basis: 'mwstv_81_2' } });
  assert.equal(toSaldoMid.error, 'vat_method_change_not_period_start', JSON.stringify(toSaldoMid));
  assert.ok(toSaldoMid.unmet.includes('from_saldo_to_effektiv'), JSON.stringify(toSaldoMid.unmet));

  // A plain Soll to Ist change on a Saldo book's adjustment day (MWSTG Art. 39 Abs. 3), basis or not.
  const b = adjustedSaldoBook();
  const timingOnly = b.call('vat_configure', {
    method: 'saldo', timing: 'ist', registered: true, saldoRates: [{ rateBp: 680 }],
    methodChange: { validFrom: '2026-07-01', basis: 'mwstv_81_2' }, idempotencyKey: 'ist-only',
  });
  assert.equal(timingOnly.error, 'vat_method_change_not_period_start', JSON.stringify(timingOnly));
  assert.ok(timingOnly.unmet.includes('from_saldo_to_effektiv'));

  // An unknown basis is not a basis.
  const bogus = a.call('vat_configure', toEffektiv('2026-07-01', { basis: 'trust_me' }));
  assert.equal(bogus.error, 'invalid_input', JSON.stringify(bogus));
  assert.equal(bogus.field, 'methodChange.basis');
});

test('L-R3-1: a "grant" that changes no rate is no ESTV adjustment, so it opens no mid-year switch', () => {
  const w = world('saldo');
  // Recorded after the fact with the SAME 620 bp: nothing was adjusted (MWSTV Art. 81 Abs. 2 "angepasst").
  const same = w.call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], saldoGrant: { validFrom: '2026-05-01' }, idempotencyKey: 'same' });
  assert.equal(same.ok, true, JSON.stringify(same));
  const r = w.call('vat_configure', toEffektiv('2026-05-01', { basis: 'mwstv_81_2' }));
  assert.equal(r.error, 'vat_method_change_not_period_start', JSON.stringify(r));
  assert.deepEqual(r.unmet, ['saldo_rate_unchanged_on_that_day']);
  assert.deepEqual(r.saldoAdjustmentDates, [], 'an unchanged grant is not offered as an adjustment day');
});

test('R2-M1: no refusal text claims the law allows no mid-year change', () => {
  const w = world();
  const r = w.call('vat_configure', toSaldo('2026-07-01', 'txt'));
  assert.match(r.reason, /MWSTV Art\. 81 Abs\. 2/, 'the reason names the exception');
  assert.doesNotMatch(r.reason, /never grants/);
});
