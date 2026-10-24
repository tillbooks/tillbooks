/**
 * export_vat speaks the VAT period labels (LOW, consistency, 14.10.2026).
 *
 * `vat_periods`, `vat_mark_filed` and `vat_settlement_*` name a period `YYYY-Qn` (effektiv, quarterly)
 * or `YYYY-Hn` (Saldo, half-yearly), MWSTG Art. 35 Abs. 1. `export_vat` only took `YYYY-MM` or `YYYY`
 * and answered `invalid_period` for the very label `vat_periods` had just listed. It now takes both
 * labels, resolved exactly as `vat_periods` resolves them (a quarter is three months, a half-year six),
 * keeps the month and year forms, and names the file after the label.
 *
 * The figures are A07's own: the CSV for a quarter is byte-for-byte the serialisation of what
 * `vat_return` computes over that quarter's first and last day.
 *
 * Synthetic workspaces in memory; no real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';

const AT = '2026-10-14T00:00:00.000Z';

function world({ method = 'effektiv' } = {}) {
  const deps = { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId } = getAction('create_workspace').run(deps, { name: 'Periode AG', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const rest = (name, input) => handleRest(name, { workspaceId, ...input }, deps);
  const cfg = call('vat_configure', {
    method,
    timing: 'soll',
    registered: true,
    idempotencyKey: 'cfg',
    ...(method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const accId = (number) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const sale = (date, net, tax, taxCode = 'UST81') => {
    const r = call('post_entry', {
      date,
      source: 'manual',
      idempotencyKey: `s-${date}-${net}`,
      lines: [
        { account: accId('1100'), debit: net + tax },
        { account: accId('3200'), credit: net, taxCode, taxBase: net, taxAmount: tax, supplyDate: date },
        { account: accId('2200'), credit: tax },
      ],
    });
    assert.equal(r.ok, true, `sale ${date}: ${JSON.stringify(r)}`);
  };
  return { call, rest, sale };
}

const decode = (artifact) => Buffer.from(artifact.base64, 'base64').toString('utf8');

/** RFC 4180, quoting only when the value demands it: the serialisation the export promises. */
function csvField(v) {
  if (v === null || v === undefined) return '';
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
}
const csvLine = (fields) => fields.map(csvField).join(',');

/** The CSV `vat_return` over [start, end] serialises to, built from vat_return's answer alone. */
function expectedCsv(model) {
  const rows = [
    csvLine(['record_type', 'form_line', 'label', 'kind', 'rate_bp', 'base_minor', 'tax_minor']),
    ...model.lines.map((l) => csvLine(['line', l.code, l.label, l.kind, l.rateBp, l.baseMinor, l.taxMinor])),
    csvLine(['total', '500', 'Zu bezahlender Betrag', null, null, null, model.payableMinor]),
    csvLine(['total', '510', 'Guthaben der steuerpflichtigen Person', null, null, null, model.creditMinor]),
  ];
  return `${rows.join('\n')}\n`;
}

test('export_vat: a quarter label exports exactly what vat_return computes for those three months', () => {
  const w = world();
  w.sale('2026-03-31', 100000, 8100); // Q1: outside
  w.sale('2026-04-01', 200000, 16200); // Q2 first day
  w.sale('2026-05-15', 300000, 24300);
  w.sale('2026-06-30', 50000, 1300, 'UST26'); // Q2 last day, the reduced rate
  w.sale('2026-07-01', 400000, 32400); // Q3: outside

  const model = w.call('vat_return', { periodStart: '2026-04-01', periodEnd: '2026-06-30' });
  assert.equal(model.ok, true, JSON.stringify(model));
  assert.equal(model.totalTaxDueMinor, 16200 + 24300 + 1300, 'the quarter holds its three months and nothing else');

  const q2 = w.call('export_vat', { period: '2026-Q2' });
  assert.equal(q2.ok, true, JSON.stringify(q2));
  assert.equal(q2.period, '2026-Q2');
  assert.equal(q2.periodStart, '2026-04-01');
  assert.equal(q2.periodEnd, '2026-06-30');
  assert.equal(q2.artifact.filename, 'mwst-2026-Q2.csv');
  assert.equal(q2.payableMinor, model.payableMinor);
  assert.equal(q2.creditMinor, model.creditMinor);
  assert.equal(q2.empty, false);
  assert.equal(decode(q2.artifact), expectedCsv(model), 'the quarter CSV is vat_return for the quarter, byte for byte');

  // Idempotent to the byte, and the REST twin returns the same answer.
  assert.equal(w.call('export_vat', { period: '2026-Q2' }).artifact.base64, q2.artifact.base64);
  const viaRest = w.rest('export_vat', { period: '2026-Q2' });
  assert.equal(viaRest.status, 200);
  assert.deepEqual(viaRest.body, q2);

  // The quarter's bounds are vat_periods' own bounds for the same label.
  const listed = w.call('vat_periods', { year: '2026' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  for (const p of listed.periods) {
    const exported = w.call('export_vat', { period: p.label });
    assert.equal(exported.ok, true, `${p.label}: ${JSON.stringify(exported)}`);
    assert.deepEqual([exported.periodStart, exported.periodEnd], [p.periodStart, p.periodEnd], p.label);
    const m = w.call('vat_return', { periodStart: p.periodStart, periodEnd: p.periodEnd });
    assert.equal(decode(exported.artifact), expectedCsv(m), `${p.label}: the CSV is vat_return for the label`);
  }
});

test('export_vat: a half-year label (Saldo) exports exactly what vat_return computes for those six months', () => {
  const w = world({ method: 'saldo' });
  w.sale('2026-01-01', 100000, 8100);
  w.sale('2026-06-30', 200000, 16200);
  w.sale('2026-07-01', 300000, 24300); // H2: outside H1

  const listed = w.call('vat_periods', { year: '2026' });
  assert.deepEqual(listed.periods.map((p) => p.label), ['2026-H1', '2026-H2'], 'Saldo files half-yearly');

  const model = w.call('vat_return', { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(model.ok, true, JSON.stringify(model));
  const h1 = w.call('export_vat', { period: '2026-H1' });
  assert.equal(h1.ok, true, JSON.stringify(h1));
  assert.deepEqual([h1.period, h1.periodStart, h1.periodEnd], ['2026-H1', '2026-01-01', '2026-06-30']);
  assert.equal(h1.artifact.filename, 'mwst-2026-H1.csv');
  assert.equal(h1.payableMinor, model.payableMinor);
  assert.equal(decode(h1.artifact), expectedCsv(model), 'the half-year CSV is vat_return for the half-year, byte for byte');

  const h2 = w.call('export_vat', { period: '2026-H2' });
  assert.deepEqual([h2.periodStart, h2.periodEnd, h2.artifact.filename], ['2026-07-01', '2026-12-31', 'mwst-2026-H2.csv']);
  assert.equal(decode(h2.artifact), expectedCsv(w.call('vat_return', { periodStart: '2026-07-01', periodEnd: '2026-12-31' })));
});

test('export_vat: the month and year forms keep working, under their old file names', () => {
  const w = world();
  w.sale('2026-05-15', 300000, 24300);
  w.sale('2026-11-02', 100000, 8100);

  const month = w.call('export_vat', { period: '2026-05' });
  assert.equal(month.ok, true, JSON.stringify(month));
  assert.deepEqual([month.period, month.periodStart, month.periodEnd], ['2026-05', '2026-05-01', '2026-05-31']);
  assert.equal(month.artifact.filename, 'mwst-2026-05-01-bis-2026-05-31.csv');
  assert.equal(decode(month.artifact), expectedCsv(w.call('vat_return', { periodStart: '2026-05-01', periodEnd: '2026-05-31' })));

  const year = w.call('export_vat', { period: '2026' });
  assert.equal(year.ok, true, JSON.stringify(year));
  assert.deepEqual([year.period, year.periodStart, year.periodEnd], ['2026', '2026-01-01', '2026-12-31']);
  assert.equal(year.artifact.filename, 'mwst-2026-01-01-bis-2026-12-31.csv');
  assert.equal(decode(year.artifact), expectedCsv(w.call('vat_return', { periodStart: '2026-01-01', periodEnd: '2026-12-31' })));

  // A leap-year February ends on the 29th.
  const feb = w.call('export_vat', { period: '2028-02' });
  assert.equal(feb.periodEnd, '2028-02-29');
});

test('export_vat: a malformed period is invalid_period and names every accepted form', () => {
  const w = world();
  const bad = ['2026-Q0', '2026-Q5', '2026-H0', '2026-H3', '2026-q3', '2026-h1', '2026Q3', '26-Q3', '2026-Q3 ', ' 2026-Q3', '2026-Q34', '2026-13', '2026-00', '2026-3', 'Q3-2026', '1. Quartal', '', null, undefined];
  for (const period of bad) {
    const r = w.call('export_vat', { period });
    assert.equal(r.ok, false, `${JSON.stringify(period)} must refuse: ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_period', `${JSON.stringify(period)}: ${JSON.stringify(r)}`);
    assert.equal(r.expected, 'YYYY-MM, YYYY-Qn, YYYY-Hn or YYYY', JSON.stringify(r));
  }
  // A number is not a string at all: the registry's schema refuses it before the engine sees it.
  assert.deepEqual(w.call('export_vat', { period: 2026 }), { ok: false, error: 'invalid_input', field: 'period' });
  // The period check comes first; a good label with a bad format is invalid_input, not invalid_period.
  assert.equal(w.call('export_vat', { period: '2026-Q3', format: 'pdf' }).error, 'invalid_input');
});

test('export_vat (critic L2): a label that is not a filing period for the book is exported, but says so', () => {
  // Effektiv files quarterly: H2 is a legitimate working-paper aggregate, never a filed return.
  const eff = world();
  eff.sale('2026-08-03', 100000, 8100);
  const h2 = eff.call('export_vat', { period: '2026-H2' });
  assert.equal(h2.ok, true, JSON.stringify(h2));
  assert.equal(h2.notice, 'not_a_filing_period');
  assert.equal(h2.filingPeriod, false);
  assert.equal(h2.filingMethod, 'effektiv');
  assert.deepEqual(h2.filingPeriods, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.equal(decode(h2.artifact), expectedCsv(eff.call('vat_return', { periodStart: '2026-07-01', periodEnd: '2026-12-31' })), 'the figures are still vat_return for the days');

  // A filing period carries no such notice.
  const q3 = eff.call('export_vat', { period: '2026-Q3' });
  assert.equal(q3.ok, true, JSON.stringify(q3));
  assert.equal(q3.filingPeriod, true);
  assert.equal(q3.notice, undefined);
  assert.equal(q3.filingPeriods, undefined);

  // Saldo files half-yearly: a quarter is not a filing period, and an EMPTY one still says so first.
  const saldo = world({ method: 'saldo' });
  const sq3 = saldo.call('export_vat', { period: '2026-Q3' });
  assert.equal(sq3.ok, true, JSON.stringify(sq3));
  assert.equal(sq3.empty, true);
  assert.equal(sq3.notice, 'not_a_filing_period', 'the period meaning outranks emptiness; empty:true still says the rest');
  assert.equal(sq3.filingMethod, 'saldo');
  assert.deepEqual(sq3.filingPeriods, ['2026-H1', '2026-H2']);
  const sh1 = saldo.call('export_vat', { period: '2026-H1' });
  assert.equal(sh1.filingPeriod, true);
  assert.equal(sh1.notice, 'empty_period');

  // A month or a year is not a label: no filing-period verdict at all.
  for (const period of ['2026-08', '2026']) {
    const r = eff.call('export_vat', { period });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.filingPeriod, undefined, period);
    assert.notEqual(r.notice, 'not_a_filing_period', period);
  }
});

test('export_vat (critic L-R2-3): one answer never carries two different methods', () => {
  // A Saldo book whose rate the ESTV adjusted from 01.07.2026, switching to effektiv that day under
  // MWSTV Art. 81 Abs. 2.
  const w = world({ method: 'saldo' });
  const grant = w.call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 680 }], saldoGrant: { validFrom: '2026-07-01' }, idempotencyKey: 'g' });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const sw = w.call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, methodChange: { validFrom: '2026-07-01', basis: 'mwstv_81_2' }, idempotencyKey: 'sw' });
  assert.equal(sw.ok, true, JSON.stringify(sw));
  w.sale('2026-08-03', 100000, 8100);

  // Since R3-M1 the 2026 calendar comes from the eras (H1 Saldo, Q3 and Q4 effektiv), so H2 (July to
  // December, all effektiv) is the label that is not a filing period here.
  const h2 = w.call('export_vat', { period: '2026-H2' });
  assert.equal(h2.ok, true, JSON.stringify(h2));
  assert.equal(h2.artifact.method, 'effektiv', 'the figures are the effektiv era');
  assert.equal(h2.filingPeriod, false);
  assert.equal(h2.filingMethod, 'effektiv', 'the verdict names the method governing the label, the same as the figures');
  assert.equal(h2.method, undefined, 'no bare `method` beside artifact.method that could disagree with it');
  assert.deepEqual(h2.filingPeriods, ['2026-H1', '2026-Q3', '2026-Q4']);
});

test('export_vat (critic L1): a period before the MWST era is invalid_period, never a thrown TypeError', () => {
  const w = world();
  // `0999-Q1` used to become month `999-01` (the zero padding dropped), and the export threw.
  for (const period of ['0999-Q1', '0000-H1', '0099-Q4', '1994-Q4', '1994-H2', '1994-12', '1994', '0999']) {
    const r = w.call('export_vat', { period });
    assert.equal(r.ok, false, `${period} must refuse: ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_period', `${period}: ${JSON.stringify(r)}`);
    assert.equal(r.earliestYear, 1995, `${period}: the refusal names the first MWST year`);
  }
  // The first MWST year exports in every form.
  for (const period of ['1995-Q1', '1995-01', '1995']) {
    const r = w.call('export_vat', { period });
    assert.equal(r.ok, true, `${period}: ${JSON.stringify(r)}`);
    assert.equal(r.periodStart, '1995-01-01');
  }
});
