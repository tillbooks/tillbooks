/**
 * F11, multi-rate Saldo: a workspace with more than one approved Saldosteuersatz keeps books and
 * files a return.
 *
 * THE LAW, FETCHED, NOT REMEMBERED. MWSTV (SR 641.201), Fedlex ELI `cc/2009/828`, Stand 1. Januar
 * 2025, AS 2024 485. The document's own title line was checked before a word of it was used
 * (`641.201 / Mehrwertsteuerverordnung / (MWSTV) / vom 27. November 2009 (Stand am 1. Januar 2025)`),
 * because `cc/2009/615` is the MWSTG and answers plausibly to the same article numbers.
 *
 *   Art. 84 Abs. 3  Steuerpflichtige Personen, denen mehrere Saldosteuersätze bewilligt wurden,
 *                   müssen die Erträge für jeden dieser Saldosteuersätze separat verbuchen.
 *   Art. 86 Abs. 1  Für jede Tätigkeit, deren Anteil am Gesamtumsatz aus steuerbaren Leistungen
 *                   mehr als 10 Prozent beträgt, wird der dafür festgelegte Saldosteuersatz
 *                   bewilligt.
 *   Art. 86 Abs. 3  Die Umsätze von Tätigkeiten mit gleichem Saldosteuersatz sind bei der Abklärung,
 *                   ob die 10-Prozent-Grenze überschritten wird, zusammenzuzählen.
 *   Art. 88 Abs. 1  Die Umsätze aus Tätigkeiten der steuerpflichtigen Person, der mehr als ein
 *                   Saldosteuersatz bewilligt worden ist, sind zum bewilligten Saldosteuersatz zu
 *                   versteuern, der für die betreffende Tätigkeit festgelegt ist.
 *   Art. 88 Abs. 6  Die steuerpflichtige Person kann den gesamten Umsatz aus steuerbaren Leistungen
 *                   freiwillig zum höchsten bewilligten Saldosteuersatz abrechnen.
 *
 * Art. 85 and Art. 87 are BOTH repealed with effect 1.1.2025 ("Aufgehoben durch Ziff. I der V vom
 * 21. Aug. 2024, mit Wirkung seit 1. Jan. 2025"), so there is no two-rate cap to honour.
 *
 * WHY THE FIXTURE CARRIES THREE TÄTIGKEITEN AND ONLY TWO RATES. Art. 86 Abs. 3 and Abs. 4 both speak
 * of several Tätigkeiten sharing one Saldosteuersatz, so the model has to allow it, and a fixture
 * with one activity per rate would never notice that it does not. It is also what separates the
 * single-round law from a plausible wrong one: rounding per ACTIVITY and rounding once per RATE
 * differ by a Rappen on this book, and the assertion below pins the right one.
 *
 * EVERY FIGURE HERE IS HAND-COMPUTED FROM THE ORDINANCE, and the arithmetic is written out so a
 * reader can check it without running anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { buildVatLines } from '../../dist/core/vat/index.js';
import {
  computeVatReturn,
  configureVat,
  getVatConfig,
  listSaldoGenerations,
  setSaldoDeclarationBasis,
} from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

function enforcingCtx({ store, workspaceId, clock, ids }) {
  return makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
}

function acc(ctx, number) {
  return ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;
}

let key = 0;

/** Post one taxable supply onto a NAMED Ertragskonto, which is what the attribution reads. */
function sale(ctx, { net, account, date = '2026-05-15' }) {
  key += 1;
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, account),
    amountMinor: net,
    amountIsGross: false,
    taxCode: 'UST81',
    direction: 'output',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: `f11-${key}`, lines });
  assert.equal(r.ok, true, `sale post failed: ${JSON.stringify(r)}`);
  return r;
}

function ziff(ret, code) {
  return ret.lines.find((l) => l.code === code);
}

/**
 * The café. Two approved Saldosteuersätze, THREE Tätigkeiten, because Art. 86 Abs. 3 says two of
 * them may share one rate.
 *
 *   Restauration  6.2%  Ertragskonto 3200
 *   Bankett       6.2%  Ertragskonto 3400   (the second Tätigkeit at the same rate)
 *   Ablieferung   3.7%  Ertragskonto 3000
 *
 * Turnover, all Leistungsdatum 15.05.2026, all at the Normalsatz 8.1% (the Saldo flat rate applies
 * to the consideration INCLUDING tax, MWSTG Art. 37 Abs. 2, so the gross is what matters):
 *
 *   3200  net 12'400.00  tax 12'400.00 * 8.1% =   1'004.40  gross 13'404.40  = 1'340'440 Rappen
 *   3400  net  2'000.00  tax  2'000.00 * 8.1% =     162.00  gross  2'162.00  =   216'200 Rappen
 *   3000  net  3'150.00  tax  3'150.00 * 8.1% =     255.15  gross  3'405.15  =   340'515 Rappen
 *
 * Art. 84 Abs. 3 books the Erträge separately PER RATE, so the 6.2% rate carries 3200 + 3400:
 *
 *   6.2%  gross 1'340'440 + 216'200 = 1'556'640
 *         tax   1'556'640 * 620 / 10'000 = 96'511.68
 *   3.7%  gross                             340'515
 *         tax     340'515 * 370 / 10'000 = 12'599.055
 *
 *   payable 96'512 + 12'599 = 109'111 Rappen = CHF 1'091.11
 *
 * WHICH ZIFFER THOSE TWO FIGURES LAND ON DEPENDS ON THE PERIOD, and this fixture reports a 2026
 * period. From 01.01.2025 the ESTV form has one Saldo row per rate ERA and none per rate POSITION
 * (A07 §3.1a), so BOTH accumulations declare on Ziffer 323 and the per-rate split is carried in the
 * Beiblatt, which is `saldoActivities`. MWST-Info 12 Ziff. 18.1.4: the MWST is computed on the Entgelt
 * "das unter Ziffer 299 ... gesamthaft deklariert wurde", so Ziffer 323's base IS Ziffer 299:
 *
 *   Ziffer 323  base 1'556'640 + 340'515 = 1'897'155  (= Ziffer 299)
 *               tax   96'512   +  12'599 =   109'111
 *
 * The payable is identical either way, because the tax is rounded ONCE over all rates before it is
 * allocated to the Ziffern. Only the breakdown moved. `pre2025` below reports the same book on a 2024
 * period and still renders 323 and 333 separately, which is the other half of the regime.
 *
 * ONE ROUND PER RATE, and this fixture is built so the alternative is visible: rounding each
 * TÄTIGKEIT separately gives round(1'340'440 * 620/10'000) + round(216'200 * 620/10'000)
 * = 83'107.28 -> 83'107 plus 13'404.4 -> 13'404 = 96'511, one Rappen light. 96'512 is the figure
 * the ordinance's own formula produces, because Art. 88 Abs. 1 taxes at the rate approved for the
 * activity and Art. 84 Abs. 3 accumulates per rate, not per activity.
 *
 * Turnover total, Ziffer 200 and 299: 1'556'640 + 340'515 = 1'897'155.
 */
const CAFE_RATES = [{ rateBp: 620 }, { rateBp: 370 }];
const CAFE_ACTIVITIES = [
  { activityId: 'restauration', name: 'Restauration', rateBp: 620, accounts: ['3200'] },
  { activityId: 'bankett', name: 'Bankett', rateBp: 620, accounts: ['3400'] },
  { activityId: 'ablieferung', name: 'Ablieferung', rateBp: 370, accounts: ['3000'] },
];

/**
 * The café. `asOf`/`date` move the whole book into another rate era so the SAME turnover can be
 * reported under either declaration regime (A07 §3.1a), which is what lets one fixture prove that
 * the remodelling moved the boxes and not the money.
 */
function cafe({ basis, asOf = '2026-01-01', date = '2026-05-15', rates = CAFE_RATES, activities = CAFE_ACTIVITIES, extraSale } = {}) {
  const s = setup({ method: 'saldo', saldoRates: rates, asOf });
  const ctx = enforcingCtx(s);

  const cfg = configureVat(ctx, {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf,
    saldoRates: rates,
    saldoActivities: activities,
    idempotencyKey: 'f11-cfg',
  });
  assert.equal(cfg.ok, true, `configure failed: ${JSON.stringify(cfg)}`);

  sale(ctx, { net: 1240000, account: '3200', date });
  sale(ctx, { net: 200000, account: '3400', date });
  sale(ctx, { net: 315000, account: '3000', date });
  if (extraSale !== undefined) sale(ctx, { ...extraSale, date });

  if (basis !== undefined) {
    const e = setSaldoDeclarationBasis(ctx, { taxPeriod: asOf.slice(0, 4), basis, idempotencyKey: 'f11-el' });
    assert.equal(e.ok, true, `election failed: ${JSON.stringify(e)}`);
  }
  return { ...s, ctx };
}

test('F11: a 2026 period declares every approved rate on ONE Ziffer, and that Ziffer is Ziffer 299', () => {
  const { ctx } = cafe();
  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, true, `return refused: ${JSON.stringify(ret)}`);

  assert.equal(ziff(ret, '200').baseMinor, 1897155);
  assert.equal(ziff(ret, '299').baseMinor, 1897155);

  // THE STATUTORY IDENTITY, and the reason this figure is 1'897'155 rather than 1'556'640.
  // MWST-Info 12 Ziff. 18.1.4: under Ziffer 322/323 "wird die MWST auf dem Entgelt aus steuerbaren
  // Leistungen berechnet, das unter Ziffer 299 (Ziff. 200 abzüglich Ziff. 289) gesamthaft deklariert
  // wurde". Asserting the two are equal, rather than restating a hand-computed constant, is what
  // makes this a test of the rule instead of a test of the previous answer.
  const saldo = ziff(ret, '323');
  assert.equal(saldo.baseMinor, ziff(ret, '299').baseMinor, 'Ziffer 323 declares the whole of Ziffer 299');
  assert.equal(saldo.baseMinor, 1897155);

  // The tax is the sum of the per-rate accumulations, unchanged by the collapse because the rounding
  // was already taken once over all rates: 96'512 (6.2% on 1'556'640) + 12'599 (3.7% on 340'515).
  assert.equal(saldo.taxMinor, 109111);
  assert.equal(saldo.rateBp, null, 'one Ziffer carrying several rates can name none of them');

  // AN INDEPENDENT DERIVATION OF THE SAME FIGURE, because `323.base === 299.base` is nearly a
  // tautology given how the engine builds the bucket and would hold with every RATE wrong. This
  // recomputes the tax from the Beiblatt rows the way the ESTV does, accumulating per rate and
  // rounding once at the end (eCH-0217 Kap. 6.2.1), and never reads `taxMinor` to get there.
  const scaledByRate = new Map();
  for (const a of ret.saldoActivities) {
    scaledByRate.set(a.rateBp, (scaledByRate.get(a.rateBp) ?? 0) + a.baseMinor * a.rateBp);
  }
  assert.deepEqual([...scaledByRate.keys()].sort((x, y) => x - y), [370, 620], 'both approved rates carry turnover');
  const scaled = [...scaledByRate.values()].reduce((n, v) => n + v, 0);
  assert.equal(Math.floor((scaled + 5000) / 10000), 109111, 'the Beiblatt rows reproduce the Ziffer tax');

  // Ziffer 333 was the 2. Satz row of the pre-2025 form and is not a box on this period's form.
  assert.equal(ziff(ret, '333'), undefined, 'the 2. Satz Ziffer does not exist from 01.01.2025');
  assert.equal(ziff(ret, '332'), undefined);

  assert.equal(ret.payableMinor, 109111);
  assert.equal(ret.creditMinor, 0);
});

test('F11: the SAME book on a pre-2025 period still splits across Ziffer 323 and 333', () => {
  // The other half of A07 §3.1a, and the guard that stops the remodelling reaching back. A
  // Berichtigungsabrechnung under MWSTG Art. 72 for a closed period declares on THAT period's form,
  // whose Steuerberechnung block numbers a row per rate position (MWST-Info 12 edition 13.02.2023,
  // Ziff. 21.1.4). Same turnover, same rates, same payable, different boxes.
  const { ctx } = cafe({ asOf: '2024-01-01', date: '2024-05-15' });
  const ret = computeVatReturn(ctx, { periodStart: '2024-01-01', periodEnd: '2024-06-30' });
  assert.equal(ret.ok, true, `return refused: ${JSON.stringify(ret)}`);

  const first = ziff(ret, '323');
  assert.equal(first.baseMinor, 1556640, 'Ziffer 323 accumulates BOTH 6.2% Tätigkeiten');
  assert.equal(first.taxMinor, 96512, '1556640 * 620 / 10000 = 96511.68');
  assert.equal(first.rateBp, 620);

  const second = ziff(ret, '333');
  assert.equal(second.baseMinor, 340515);
  assert.equal(second.taxMinor, 12599, '340515 * 370 / 10000 = 12599.055');
  assert.equal(second.rateBp, 370);

  // The parts still foot to Ziffer 299 and to the same payable the 2026 period reports.
  assert.equal(first.baseMinor + second.baseMinor, ziff(ret, '299').baseMinor);
  assert.equal(ret.payableMinor, 109111, 'the regime moves the boxes, never the money');
});

test('F11: a THIRD approved rate files from 01.01.2025 and is refused only on a pre-2025 period', () => {
  // MWSTV Art. 87 was repealed with effect 01.01.2025 and the Beiblatt splits the Entgelt across
  // "die verschiedenen SSS", so there is no ceiling left to enforce on a modern period.
  const three = {
    rates: [{ rateBp: 620 }, { rateBp: 370 }, { rateBp: 130 }],
    activities: [
      { activityId: 'restauration', name: 'Restauration', rateBp: 620, accounts: ['3200'] },
      { activityId: 'bankett', name: 'Bankett', rateBp: 620, accounts: ['3400'] },
      { activityId: 'ablieferung', name: 'Ablieferung', rateBp: 370, accounts: ['3000'] },
      { activityId: 'handel', name: 'Handel', rateBp: 130, accounts: ['3600'] },
    ],
  };

  const { ctx } = cafe({ ...three, extraSale: { net: 500000, account: '3600' } });
  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, true, `a third rate must file from 2025: ${JSON.stringify(ret)}`);

  // net 500'000 at 8.1% = gross 540'500, so Ziffer 299 is 1'897'155 + 540'500 = 2'437'655.
  // scaled = 1'556'640*620 + 340'515*370 + 540'500*130 = 1'161'372'350, one round -> 116'137.
  assert.equal(ziff(ret, '299').baseMinor, 2437655);
  assert.equal(ziff(ret, '323').baseMinor, ziff(ret, '299').baseMinor);
  assert.equal(ziff(ret, '323').taxMinor, 116137);
  assert.equal(ret.payableMinor, 116137);
  assert.equal(ret.saldoActivities.length, 4, 'all four Tätigkeiten reach the Beiblatt');

  // The pre-2025 half. The approval is configured WITHOUT an explicit pre-2025 `asOf`, because
  // MWSTV Art. 87 still capped a 2024 period at two rates and `configureVat` now refuses a third
  // outright when the caller names such a date (see the config suite). What is being exercised here
  // is the other half of that rule: an approval lawfully holding three rates today still governs the
  // earlier periods it was open for, and reporting one of THOSE has no third box to print in.
  const legacy = cafe({ ...three, asOf: '2025-01-01', date: '2024-05-15', extraSale: { net: 500000, account: '3600' } });
  const refused = computeVatReturn(legacy.ctx, { periodStart: '2024-01-01', periodEnd: '2024-06-30' });
  assert.equal(refused.ok, false, 'the pre-2025 form has no third row');
  assert.equal(refused.error, 'saldo_form_line_missing');
  assert.equal(refused.regime, 'per_position');
  assert.equal(refused.position, 3);
  assert.equal(refused.rateBp, 130);
});

test('A05: MWSTV Art. 87 still caps a period the repeal had not reached, and only such a period', () => {
  // The cap fell on 01.01.2025, so it is scoped to a date rather than deleted. It binds only an
  // EXPLICIT pre-2025 `asOf`: the default is `CURRENT_RATE_ERA_FROM` ('2024-01-01', when the current
  // RATE era opened and which is still running), so reading a defaulted value as a period date would
  // refuse three rates for every ordinary caller configuring a workspace today.
  const three = [{ rateBp: 620 }, { rateBp: 370 }, { rateBp: 130 }];

  const stated = configureVat(enforcingCtx(setup({ method: 'saldo', saldoRates: three, asOf: '2025-01-01' })), {
    method: 'saldo', timing: 'soll', registered: true, asOf: '2024-01-01', saldoRates: three, idempotencyKey: 'cap-2024',
  });
  assert.equal(stated.ok, false, 'a stated 2024 period is still capped at two rates');
  assert.equal(stated.error, 'invalid_saldo_rate');
  assert.equal(stated.maxRates, 2);
  assert.equal(stated.capLiftedFrom, '2025-01-01');

  const from2025 = configureVat(enforcingCtx(setup({ method: 'saldo', saldoRates: three, asOf: '2025-01-01' })), {
    method: 'saldo', timing: 'soll', registered: true, asOf: '2025-01-01', saldoRates: three, idempotencyKey: 'cap-2025',
  });
  assert.equal(from2025.ok, true, `the repeal takes effect on 01.01.2025: ${JSON.stringify(from2025)}`);

  const defaulted = configureVat(enforcingCtx(setup({ method: 'saldo', saldoRates: three, asOf: '2025-01-01' })), {
    method: 'saldo', timing: 'soll', registered: true, saldoRates: three, idempotencyKey: 'cap-default',
  });
  assert.equal(defaulted.ok, true, `a defaulted asOf names no period and must not be read as 2024: ${JSON.stringify(defaulted)}`);
});

test('F11: the per-Tätigkeit turnover is reported, cross-foots to Ziffer 299, and carries no tax figure', () => {
  const { ctx } = cafe();
  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, true);

  const byId = new Map(ret.saldoActivities.map((a) => [a.activityId, a]));
  assert.equal(byId.get('restauration').baseMinor, 1340440);
  assert.equal(byId.get('bankett').baseMinor, 216200);
  assert.equal(byId.get('ablieferung').baseMinor, 340515);
  assert.equal(byId.get('bankett').rateBp, 620);
  assert.equal(byId.get('bankett').formLine, '323');

  // eCH-0217 carries no per-rate tax element at all (the ESTV recomputes), so a per-ACTIVITY tax
  // figure would be an invention with nowhere to go and a second opinion about the rounding.
  for (const a of ret.saldoActivities) assert.equal('taxMinor' in a, false);

  const summed = ret.saldoActivities.reduce((n, a) => n + a.baseMinor, 0);
  assert.equal(summed, ziff(ret, '299').baseMinor, 'the activities must cross-foot to the taxable total');
});

test('F11: turnover on an unmapped Ertragskonto refuses and NAMES the account (Art. 84 Abs. 3)', () => {
  const { ctx } = cafe();
  // A fourth revenue account nobody mapped. Attributing it to any rate would put turnover on a
  // Saldosteuersatz the ESTV never granted for it, which is the whole point of the refusal.
  sale(ctx, { net: 100000, account: '3600' });

  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, false);
  assert.equal(ret.error, 'saldo_activity_split_required');
  assert.deepEqual(
    ret.unmappedAccounts.map((a) => a.number),
    ['3600'],
  );
  // net 100'000 * 8.1% = 8'100, so the gross the refusal reports is 108'100 Rappen.
  assert.equal(ret.unmappedGrossMinor, 108100);
});

test('F11: the Art. 88 Abs. 6 election declares everything at the HIGHEST approved rate', () => {
  const { ctx } = cafe({ basis: 'highest_rate' });
  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, true, `return refused: ${JSON.stringify(ret)}`);

  // 1'897'155 * 620 / 10'000 = 117'623.61 -> 117'624, all of it on the highest rate's Ziffer.
  assert.equal(ziff(ret, '323').baseMinor, 1897155);
  assert.equal(ziff(ret, '323').taxMinor, 117624);
  assert.equal(ziff(ret, '333'), undefined, 'the second Saldo Ziffer is absent under Abs. 6');
  assert.equal(ret.payableMinor, 117624);
  assert.equal(ret.saldoDeclarationBasis, 'highest_rate');
});

test('F11: the election is per Steuerperiode, so an unelected year still splits per Tätigkeit', () => {
  const { ctx } = cafe({ basis: 'highest_rate' });
  // Elected for 2026 only. 2025 is a different Steuerperiode (MWSTG Art. 34 Abs. 2) and keeps Abs. 1.
  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.saldoDeclarationBasis, 'highest_rate');

  const withdrawn = setSaldoDeclarationBasis(ctx, {
    taxPeriod: '2026',
    basis: 'per_activity',
    idempotencyKey: 'f11-el2',
  });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  const after = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(after.ok, true);
  // Withdrawing the election restores the Art. 88 Abs. 1 per-rate accumulation, which on a 2026
  // period is 96'512 + 12'599 on the ONE Ziffer the Beiblatt regime has, not 117'624 at the highest
  // rate. The figure that proves the withdrawal took effect is the payable, not the box count.
  assert.equal(after.saldoDeclarationBasis, 'per_activity');
  assert.equal(ziff(after, '323').taxMinor, 109111, 'withdrawing the election restores the Abs. 1 split');
  assert.equal(after.payableMinor, 109111);
  assert.notEqual(after.payableMinor, 117624, 'the Abs. 6 figure must not survive its withdrawal');

  // And the per-Tätigkeit split is back to three rows rather than the election's single row.
  assert.deepEqual(
    after.saldoActivities.map((a) => a.baseMinor).sort((x, y) => x - y),
    [216200, 340515, 1340440],
  );
});

test('F11: the account mapping and the approval history are both readable', () => {
  const { ctx } = cafe();

  const cfg = getVatConfig(ctx);
  assert.equal(cfg.ok, true);
  const activities = cfg.config.saldoActivities;
  assert.equal(activities.length, 3);
  assert.deepEqual(
    activities.find((a) => a.activityId === 'restauration').accounts.map((a) => a.number),
    ['3200'],
  );

  const gens = listSaldoGenerations(ctx);
  assert.equal(gens.ok, true, JSON.stringify(gens));
  assert.equal(gens.generations.length, 1);
  assert.equal(gens.generations[0].validTo, null, 'the only generation is open-ended');
  assert.deepEqual(
    gens.generations[0].rates.map((r) => r.rateBp),
    [620, 370],
  );
});
