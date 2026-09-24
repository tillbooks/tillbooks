/**
 * A07, the MWST-Abrechnung read model.
 *
 * WHY EVERY FIXTURE HERE CARRIES AT LEAST TWO RATES. A single-rate fixture agrees with a wrong
 * calculation by luck: under a "multiply the whole turnover by the Normalsatz" mutation a one-rate
 * book stays green, because there IS only one rate and the wrong formula lands on the right number.
 * Two rates separate the two, so the per-rate grouping is actually asserted rather than assumed.
 *
 * WHY THE ASSERTIONS READ SQLITE. The reconciliation tests do not compare the return against the
 * literal the fixture posted; they read the booked `journal_line` rows back out of the database and
 * demand the return equal THOSE. A read model checked against its own inputs proves only that the
 * test can do arithmetic. Checked against the ledger, it proves the thing A07 actually claims: that
 * the figures filed with the ESTV are the figures the books hold.
 *
 * THE ZIFFERN ARE READ OFF A DOCUMENT, not remembered, and the document is now named accurately.
 * ESTV forms DM_0550_03 / 01.24 and DM_0536_04 / 01.24, fetched 2026-07-25 from
 * estv2.admin.ch/mwst/formulare/ and text-extracted. 0550 is titled `Jahresabstimmung
 * (Berichtigungsabrechnung nach Art. 72 MWSTG, effektive Methode)` and 0536 `Korrekturabrechnung
 * (Saldosteuersatz / Pauschalsteuersatz)`: neither is the PERIODIC return, and this header used to
 * call them that. They carry the same Ziffern the periodic return does, so nothing computed wrong,
 * which is exactly what let the mistake survive.
 *
 * Both forms print the current AND the legacy tax-calculation block side by side ("ab 01.01.2024"
 * and "bis 31.12.2023"), which is the form itself confirming that 302/312/342/382 are live numbers
 * for a correction return and not dead ones to delete. They do NOT agree on every label (200, 280
 * and 479 differ, 205 is effektiv-only, 470/471 are Saldo-only), which is why the engine has two
 * label maps and picks by method.
 *
 * WHY THERE ARE ASSERTIONS THE 2200 RECONCILIATION CANNOT MAKE. `reconciled: true` is close to an
 * arithmetic identity under effektiv: the allocation spreads each entry's own booked 2200 movement
 * over that entry's tagged lines, so the parts sum to the total by construction. It reported true
 * over a duplicated Ziffer, a merged rate vintage, an inverted sign and a rate the period's ESTV
 * ladder never offered. Every per-Ziffer assertion below exists because the total-level one is
 * blind to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, saveDraft, ledgerPorts } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { buildVatLines, upsertTaxCode } from '../../dist/core/vat/index.js';
import { computeVatReturn, markVatPeriodFiled, listVatPeriods, formLineLabel } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

/**
 * The same workspace, seen through a context wired with the REAL A03 ports.
 *
 * `setup()` builds its context with the permissive `allPeriodsOpen` stub, which is right for the
 * A05/A06 suites (they are not testing locks) and wrong for any assertion ABOUT a lock: through
 * that context a sealed period accepts a post, so a §H-PERIOD test written against it passes
 * whether or not the seal works. The registry's `ctxOf` wires `ledgerPorts` for every real call, so
 * this is the context a shipped surface actually uses.
 */
function enforcingCtx({ store, workspaceId, clock, ids }) {
  return makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
}

/** Look up the seeded KMU account id by its number. */
function acc(ctx, number) {
  return ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;
}

let key = 0;

/** Post one taxable supply through the A06 builder, so the A02 post-boundary gate stamps the trace. */
function sale(ctx, { net, taxCode, date = '2026-05-15', supplyDate }) {
  key += 1;
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, '3200'),
    amountMinor: net,
    amountIsGross: false,
    taxCode,
    direction: 'output',
    supplyDate: supplyDate ?? date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: `a07-s-${key}`, lines });
  assert.equal(r.ok, true, `sale post failed: ${JSON.stringify(r)}`);
  return r;
}

/**
 * Post one Bezugsteuer acquisition (Art. 45): owed on Ziffer 383 AND deducted with the ordinary
 * Vorsteuer on Ziffer 400, which is the whole point of the fixture. `sign:'both'` in P6 means this
 * pair, and the deduction leg has no Ziffer of its own on the ESTV form.
 */
function bezug(ctx, { net, date = '2026-05-22' }) {
  key += 1;
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: net,
    amountIsGross: false,
    taxCode: 'BEZUG',
    direction: 'input',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: `a07-b-${key}`, lines });
  assert.equal(r.ok, true, `bezug post failed: ${JSON.stringify(r)}`);
  return r;
}

/** Post one deductible purchase (Vorsteuer). */
function purchase(ctx, { net, taxCode = 'VST-M', date = '2026-05-20' }) {
  key += 1;
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: net,
    amountIsGross: false,
    taxCode,
    direction: 'input',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: `a07-p-${key}`, lines });
  assert.equal(r.ok, true, `purchase post failed: ${JSON.stringify(r)}`);
  return r;
}

/** The booked base movement on an account over a date range, read straight from the ledger. */
function bookedMovement(ctx, number, from, to) {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND e.date >= ? AND e.date <= ? AND a.number = ?`,
    )
    .get(ctx.workspaceId, from, to, number);
  return row.net;
}

const Q2 = { periodStart: '2026-04-01', periodEnd: '2026-06-30' };

/**
 * The line for a Ziffer, or undefined.
 *
 * A `.find()`, exactly like the GUI form-line table and like any agent reading the return, and that
 * is the point: a Ziffer rendered twice is INVISIBLE through this lookup, so every assertion written
 * with it silently grades only the first occurrence. `assertOneLinePerZiffer` below is what stops a
 * second occurrence hiding behind it.
 */
function ziff(ret, code) {
  return ret.lines.find((l) => l.code === code);
}

/**
 * A Ziffer is a BOX on the ESTV form: it takes exactly one figure. Asserted on every fixture that
 * can produce a collision, because a duplicate line does not fail any `ziff()` assertion, it just
 * removes money from the form quietly.
 */
function assertOneLinePerZiffer(ret) {
  const seen = new Map();
  for (const l of ret.lines) seen.set(l.code, (seen.get(l.code) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1);
  assert.deepEqual(dupes, [], `a Ziffer must be rendered once: ${JSON.stringify(ret.lines)}`);
}

// --- Effektiv / Soll, the core -----------------------------------------------------------------

test('A07: effektiv/soll groups output tax per rate onto 303 and 313, never a blended figure', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' }); // CHF 10'000.00 at 8.1% -> 810.00
  sale(ctx, { net: 500000, taxCode: 'UST26' }); //  CHF  5'000.00 at 2.6% -> 130.00

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'effektiv');
  assert.equal(r.timing, 'soll');

  assert.equal(ziff(r, '303').baseMinor, 1000000);
  assert.equal(ziff(r, '303').taxMinor, 81000);
  assert.equal(ziff(r, '313').baseMinor, 500000);
  assert.equal(ziff(r, '313').taxMinor, 13000);

  // A blended 8.1% over the whole 15'000 turnover would be 121'500, and a blended 2.6% 39'000.
  // Neither is 94'000, which is what makes this fixture able to fail.
  assert.equal(r.totalTaxDueMinor, 94000); // Ziffer 399
});

test('A07: the return reconciles to the booked movement on 2200, read from the ledger', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });
  purchase(ctx, { net: 200000 });

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));

  const booked2200 = bookedMovement(ctx, '2200', Q2.periodStart, Q2.periodEnd);
  assert.equal(booked2200, 94000, 'fixture sanity: the ledger really holds 94000 on 2200');
  assert.equal(r.totalTaxDueMinor, booked2200);
  assert.equal(r.reconciled, true);
  assert.equal(r.reconciliation.outputVatBookedMinor, booked2200);
  assert.equal(r.reconciliation.driftMinor, 0);
});

test('A07: Vorsteuer lands on 400 and 405 by code, and 500 is 399 minus 479', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });
  purchase(ctx, { net: 200000, taxCode: 'VST-M' }); // 8.1% of 2000.00 -> 162.00, Ziffer 400
  purchase(ctx, { net: 100000, taxCode: 'VST-I' }); // 8.1% of 1000.00 ->  81.00, Ziffer 405

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ziff(r, '400').taxMinor, 16200);
  assert.equal(ziff(r, '405').taxMinor, 8100);
  assert.equal(r.totalInputTaxMinor, 24300); // Ziffer 479
  assert.equal(r.totalTaxDueMinor, 94000); // Ziffer 399
  assert.equal(r.payableMinor, 69700); // Ziffer 500
  assert.equal(r.creditMinor, 0); // Ziffer 510
});

test('A07: Bezugsteuer claims its deduction ON Ziffer 400, which is rendered ONCE', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' }); //     810.00 output on 303
  sale(ctx, { net: 500000, taxCode: 'UST26' }); //      130.00 output on 313
  purchase(ctx, { net: 400000, taxCode: 'VST-M' }); //  324.00 ordinary Vorsteuer, Ziffer 400
  bezug(ctx, { net: 100000 }); //                        81.00 owed on 383, 81.00 deducted on 400

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));

  // Ordinary Vorsteuer (kind `input`, stored rate 0) and the Bezugsteuer deduction leg (kind
  // `reverse_charge`, rate 810) both claim on Ziffer 400. Bucketed by (Ziffer, rate, kind) they
  // landed in two buckets and BOTH rendered: Ziffer 400 read 324.00 while Ziffer 479 read 405.00,
  // so CHF 81.00 of Vorsteuer left the form through a lookup that finds the first match. Nothing
  // flagged it: the total was right, the parts were not, and the return still said reconciled.
  assertOneLinePerZiffer(r);
  assert.equal(ziff(r, '400').taxMinor, 40500, 'ordinary Vorsteuer 324.00 PLUS the Bezug leg 81.00');
  assert.equal(r.totalInputTaxMinor, 40500, 'Ziffer 479 and the sum of its parts must agree');
  assert.equal(
    r.lines.filter((l) => l.code.startsWith('4')).reduce((a, l) => a + l.taxMinor, 0),
    r.totalInputTaxMinor,
    'the Vorsteuer block must add up to its own total',
  );

  // The owed leg keeps its own Ziffer, and the metadata degrades honestly: Ziffer 400 now
  // aggregates two KINDS, so it names neither rather than picking one. (Both legs happen to be
  // priced at the Normalsatz, so the rate stays unambiguous here; the two-output-codes fixture
  // below is the one that mixes rates.)
  assert.equal(ziff(r, '383').taxMinor, 8100);
  assert.equal(ziff(r, '400').kind, null, 'a box that mixes two kinds names neither');
  assert.equal(ziff(r, '400').rateBp, 810, 'both legs were priced at the Normalsatz of the era');
  assert.equal(ziff(r, '405'), undefined);

  // 399 is unchanged by the deduction, and 500 nets the two.
  assert.equal(r.totalTaxDueMinor, 94000 + 8100);
  assert.equal(r.payableMinor, 94000 + 8100 - 40500);
});

test('A07: two output codes sharing one Ziffer merge into it rather than rendering it twice', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  // A workspace-defined output code at a rate of its own that reports on the SAME Ziffer as the
  // Normalsatz. Nothing stops a real workspace doing this (`upsertTaxCode` takes both), and the
  // ESTV still receives one figure for 303.
  const up = upsertTaxCode(ctx, {
    code: 'UST81-ALT',
    kind: 'output',
    rateBp: 500,
    formLine: '303',
    label: 'Sondersatz, gleiche Ziffer',
  });
  assert.equal(up.ok, true, JSON.stringify(up));

  sale(ctx, { net: 1000000, taxCode: 'UST81' }); //  810.00
  sale(ctx, { net: 1000000, taxCode: 'UST81-ALT' }); // 500.00
  sale(ctx, { net: 500000, taxCode: 'UST26' }); //   130.00

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assertOneLinePerZiffer(r);
  assert.equal(ziff(r, '303').taxMinor, 131000);
  assert.equal(ziff(r, '303').baseMinor, 2000000);
  assert.equal(ziff(r, '303').rateBp, null);
  assert.equal(r.totalTaxDueMinor, 144000);
  assert.equal(r.reconciled, true);
});

test('A07: more Vorsteuer than output tax reports a credit on 510, not a negative 500', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 100000, taxCode: 'UST81' }); //   81.00 output
  sale(ctx, { net: 50000, taxCode: 'UST26' }); //    13.00 output
  purchase(ctx, { net: 2000000, taxCode: 'VST-M' }); // 1620.00 input

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.totalTaxDueMinor, 9400);
  assert.equal(r.totalInputTaxMinor, 162000);
  assert.equal(r.payableMinor, 0);
  assert.equal(r.creditMinor, 152600);
});

test('A07: a 2200 movement no Ziffer explains shows up as DRIFT, it does not pass silently', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });

  const clean = computeVatReturn(ctx, Q2);
  assert.equal(clean.reconciled, true);
  assert.equal(clean.reconciliation.driftMinor, 0);

  // A manual journal posting straight at the MWST liability account, carrying no tax code at all.
  // This is exactly the case the 2200 reconciliation exists to catch: the account moved, no form
  // line moved with it, and a return that quietly reported "reconciled" would be lying.
  key += 1;
  const r = postEntry(ctx, {
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: `a07-drift-${key}`,
    lines: [
      { account: acc(ctx, '6500'), debit: 25000 },
      { account: acc(ctx, '2200'), credit: 25000 },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  const drifted = computeVatReturn(ctx, Q2);
  assert.equal(drifted.totalTaxDueMinor, 94000, 'no Ziffer moved: the tagged lines are unchanged');
  assert.equal(drifted.reconciliation.outputVatBookedMinor, 119000, 'but the account did move');
  assert.equal(drifted.reconciliation.driftMinor, -25000);
  assert.equal(drifted.reconciled, false);
});

// --- An entry carrying tax of BOTH signs --------------------------------------------------------

/**
 * The stored §H-VAT-TRACE of every tagged line in the period, keyed by tax code. This is the
 * ledger's own answer, which is what the return has to reproduce.
 */
function storedTraceByCode(ctx, from, to) {
  const rows = ctx.store.db
    .prepare(
      `SELECT l.tax_code AS code, SUM(l.tax_amount_minor) AS tax, SUM(l.tax_base_minor) AS base
         FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND e.date >= ? AND e.date <= ? AND l.tax_code IS NOT NULL
        GROUP BY l.tax_code`,
    )
    .all(ctx.workspaceId, from, to);
  return new Map(rows.map((r) => [r.code, r]));
}

test('A07: a rebate leg beside a sale keeps its NEGATIVE tax on its own Ziffer', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });

  // ONE entry, two tagged output lines at two rates and OPPOSITE signs: a CHF 10'000.00 supply at
  // 8.1% and a CHF 3'000.00 rebate at 2.6%. The rebate line sits on its unnatural side (a debit on
  // revenue), which the A02 post-boundary gate stamps NEGATED.
  //
  // Not reachable from the invoice UI today (`document.ts` refuses a negative position: discounts
  // are unimplemented), but reachable RIGHT NOW through the exposed `post_entry` verb, and reachable
  // from the invoice path the day discounts land.
  key += 1;
  const posted = postEntry(ctx, {
    date: '2026-05-15',
    source: 'manual',
    idempotencyKey: `a07-signs-${key}`,
    lines: [
      { account: acc(ctx, '1100'), debit: 773200 },
      { account: acc(ctx, '3200'), credit: 1000000, taxCode: 'UST81', supplyDate: '2026-05-15' },
      { account: acc(ctx, '3200'), debit: 300000, taxCode: 'UST26', supplyDate: '2026-05-15' },
      { account: acc(ctx, '2200'), credit: 73200 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));

  // Splitting the NET booked total (732.00) over ABSOLUTE weights put 667.70 on Ziffer 303 and
  // +64.30 of tax on Ziffer 313 against NEGATIVE turnover: two wrong signable figures whose sum is
  // right, so the 2200 reconciliation saw nothing and reported reconciled.
  const trace = storedTraceByCode(ctx, Q2.periodStart, Q2.periodEnd);
  assert.equal(trace.get('UST81').tax, 81000, 'fixture sanity: the ledger holds +810.00');
  assert.equal(trace.get('UST26').tax, -7800, 'fixture sanity: and -78.00, negated by the gate');

  assert.equal(ziff(r, '303').taxMinor, 81000);
  assert.equal(ziff(r, '303').baseMinor, 1000000);
  assert.equal(ziff(r, '313').taxMinor, -7800, 'the rebate keeps its sign, it is not inverted');
  assert.equal(ziff(r, '313').baseMinor, -300000);
  assert.equal(
    Math.sign(ziff(r, '313').taxMinor),
    Math.sign(ziff(r, '313').baseMinor),
    'tax and turnover on one Ziffer can never disagree about their sign',
  );

  // The total was right BEFORE the fix too, which is exactly why it proves nothing on its own.
  assert.equal(r.totalTaxDueMinor, 73200);
  assert.equal(r.reconciled, true);
});

test('A07: on a base-currency entry every Ziffer gets back the tax its own line booked', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  key += 1;
  const posted = postEntry(ctx, {
    date: '2026-05-15',
    source: 'manual',
    idempotencyKey: `a07-identity-${key}`,
    lines: [
      { account: acc(ctx, '1100'), debit: 773200 },
      { account: acc(ctx, '3200'), credit: 1000000, taxCode: 'UST81', supplyDate: '2026-05-15' },
      { account: acc(ctx, '3200'), debit: 300000, taxCode: 'UST26', supplyDate: '2026-05-15' },
      { account: acc(ctx, '2200'), credit: 73200 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // In the base currency the booked franc VAT IS the sum of the traces, so the allocation must be
  // the IDENTITY per line: nothing is redistributed, because nothing was rounded a second time.
  // Stated as a per-Ziffer equality against SQLite rather than against the fixture literals.
  const r = computeVatReturn(ctx, Q2);
  const trace = storedTraceByCode(ctx, Q2.periodStart, Q2.periodEnd);
  assert.equal(ziff(r, '303').taxMinor, trace.get('UST81').tax);
  assert.equal(ziff(r, '313').taxMinor, trace.get('UST26').tax);
});

// --- The franc figure on a foreign-currency supply ---------------------------------------------

test('A07: a EUR supply reports the FRANC tax the ledger booked, not the EUR trace', () => {
  const fixture = setup({ method: 'effektiv', timing: 'soll' });
  const { ctx } = fixture;

  // A EUR invoice: net EUR 10'000.00 at 8.1% -> EUR 810.00 tax, EUR 10'810.00 gross. The books are
  // kept in francs, so `applyFx` converts once per side and the franc figures are what a return is
  // filed on (MWSTV Art. 45).
  key += 1;
  const r = postEntry(ctx, {
    date: '2026-05-15',
    source: 'manual',
    currency: 'EUR',
    fxRate: '0.9412',
    idempotencyKey: `a07-eur-${key}`,
    lines: [
      { account: acc(ctx, '1100'), debit: 1081000 },
      { account: acc(ctx, '3200'), credit: 1000000, taxCode: 'UST81', taxBase: 1000000, taxAmount: 81000, supplyDate: '2026-05-15' },
      { account: acc(ctx, '2200'), credit: 81000 },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  // Read the booked franc VAT straight out of SQLite. The return must equal THIS, not the EUR
  // trace and not a client-side product: `applyFx` rounds once on the side total and allocates
  // back by largest remainder, so a per-figure multiplication is a second opinion about the
  // ledger's rounding that is free to disagree.
  const bookedFrancVat = bookedMovement(ctx, '2200', Q2.periodStart, Q2.periodEnd);
  assert.notEqual(bookedFrancVat, 81000, 'fixture sanity: the franc figure differs from the EUR one');

  const ret = computeVatReturn(ctx, Q2);
  assert.equal(ret.ok, true, JSON.stringify(ret));
  assert.equal(ziff(ret, '303').taxMinor, bookedFrancVat);
  assert.equal(ret.totalTaxDueMinor, bookedFrancVat);
  assert.equal(ret.reconciled, true);

  // And the Leistungen column is the franc turnover the ledger holds, not the EUR 10'000.00.
  const bookedFrancRevenue = bookedMovement(ctx, '3200', Q2.periodStart, Q2.periodEnd);
  assert.notEqual(bookedFrancRevenue, 1000000, 'fixture sanity: the franc turnover differs too');
  assert.equal(ziff(ret, '303').baseMinor, bookedFrancRevenue);
});

// --- The Ziffer vintage, selected by the reported period ---------------------------------------

test('A07: a pre-2024 period reports the LEGACY Ziffern 302/312 at the old rates', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  // Supplied and booked in 2023: the stored trace froze 7.7% / 2.5% (A06), and the Ziffer vintage
  // follows the period being reported, exactly as ESTV form 0550's "bis 31.12.2023" column does.
  sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2023-05-15' });
  sale(ctx, { net: 500000, taxCode: 'UST26', date: '2023-05-15' });

  const r = computeVatReturn(ctx, { periodStart: '2023-04-01', periodEnd: '2023-06-30' });
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(ziff(r, '302').taxMinor, 77000, '7.7% of 10000.00');
  assert.equal(ziff(r, '312').taxMinor, 12500, '2.5% of 5000.00');
  assert.equal(ziff(r, '303'), undefined, 'the 2024 vintage must not appear on a 2023 period');
  assert.equal(ziff(r, '313'), undefined);
  assert.equal(r.vintage, 'legacy');
});

test('A07: a straddle supply reports on its OWN vintage inside a current-vintage period', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });

  // The ordinary case a rate change creates, not an exotic one: a supply delivered 20.12.2023 and
  // invoiced 15.01.2024. MWSTG prices it at the rate in force on the LEISTUNGSDATUM (7.7%), which
  // A06 already does, and the ESTV form carries the legacy column precisely so it can be declared.
  sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2024-01-15', supplyDate: '2023-12-20' });
  // And a genuine 2024 supply beside it, at 8.1%, so the two cannot be told apart by luck.
  sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2024-02-15' });
  sale(ctx, { net: 500000, taxCode: 'UST26', date: '2024-02-20' });

  const r = computeVatReturn(ctx, { periodStart: '2024-01-01', periodEnd: '2024-03-31' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assertOneLinePerZiffer(r);

  // Resolved off the ENTRY date, the straddle was not mislabelled, it was ABSORBED: Ziffer 303 read
  // 158'000 over 20'000.00 of turnover, which 8.1% does not produce (162'000), Ziffer 302 never
  // appeared, and the CHF 40.00 gap sat inside a return reporting `reconciled: true`. ESTV
  // cross-foots Ziffer 303 against its own base.
  assert.equal(ziff(r, '302').baseMinor, 1000000);
  assert.equal(ziff(r, '302').taxMinor, 77000, '7.7%, the rate the ledger actually booked');
  assert.equal(ziff(r, '302').rateBp, 770, 'and the line names the rate it was priced at');
  assert.equal(ziff(r, '303').baseMinor, 1000000);
  assert.equal(ziff(r, '303').taxMinor, 81000);
  assert.equal(ziff(r, '303').rateBp, 810);
  assert.equal(ziff(r, '313').taxMinor, 13000);

  // Every per-rate line must now cross-foot: tax == round(base * rate). That is the check the ESTV
  // performs and the one the merge failed.
  for (const l of r.lines.filter((x) => x.rateBp !== null && x.rateBp > 0 && x.kind === 'output')) {
    assert.equal(l.taxMinor, Math.round((l.baseMinor * l.rateBp) / 10000), `Ziffer ${l.code} must cross-foot`);
  }

  assert.equal(r.totalTaxDueMinor, 171000);
  assert.equal(r.reconciled, true);
});

test('A07: with no stamped supply date the ENTRY date still governs, unchanged', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  // Every line written before `journal_line.supply_date` existed reads NULL, and NULL means "the
  // entry date governs", which is what those returns were filed on. The return must reproduce the
  // OLD answer exactly: not a refusal, and not a different number.
  //
  // Producing such a row takes brute force BECAUSE the ledger is immutable: the §H-AUDIT triggers
  // refuse the UPDATE outright (SQLITE_CONSTRAINT_TRIGGER), which is the mechanism working. So the
  // triggers are captured from `sqlite_master`, dropped, the row aged, and the triggers replayed
  // verbatim. Nothing in the engine can do this, and that is the point.
  sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2024-01-15', supplyDate: '2023-12-20' });
  const triggers = ctx.store.db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_line'")
    .all();
  assert.ok(triggers.length > 0, 'the immutability triggers must exist to be worth working around');
  for (const t of triggers) ctx.store.db.exec(`DROP TRIGGER ${t.name}`);
  ctx.store.db.prepare('UPDATE journal_line SET supply_date = NULL').run();
  for (const t of triggers) ctx.store.db.exec(t.sql);

  const r = computeVatReturn(ctx, { periodStart: '2024-01-01', periodEnd: '2024-03-31' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ziff(r, '302'), undefined, 'no stamped date, so no vintage split');
  assert.equal(ziff(r, '303').taxMinor, 77000, 'the FIGURE is the ledger 7.7% one either way');
});

test('A07: a straddle reversed later credits back the Ziffer it was declared on', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  const s = sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2024-01-15', supplyDate: '2023-12-20' });

  // Reversed inside the SAME return period. The mirror must land on 302 too: reversed at today's
  // vintage it would credit 302 and debit 303, both accounts and the 2200 total would still net to
  // zero, and the return would carry two fabricated form lines.
  const rev = reverseEntry(ctx, { entryId: s.entryId, date: '2024-02-10', idempotencyKey: 'a07-straddle-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));

  const r = computeVatReturn(ctx, { periodStart: '2024-01-01', periodEnd: '2024-03-31' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ziff(r, '302').taxMinor, 0, 'the supply and its reversal cancel ON ONE Ziffer');
  assert.equal(ziff(r, '302').baseMinor, 0);
  assert.equal(ziff(r, '303'), undefined, 'and nothing appears on the current vintage at all');
  assert.equal(r.totalTaxDueMinor, 0);
  assert.equal(r.reconciled, true);
});

test('A07: a current period reports 303/313 and never the legacy pair', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });

  const r = computeVatReturn(ctx, Q2);
  assert.equal(ziff(r, '302'), undefined);
  assert.equal(ziff(r, '312'), undefined);
  assert.equal(r.vintage, 'current');
});

// --- Saldo -------------------------------------------------------------------------------------

test('A07: saldo taxes the GROSS turnover at the Saldosteuersatz and deducts no Vorsteuer', () => {
  const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  sale(ctx, { net: 1000000, taxCode: 'UST81' }); // gross 10'810.00
  sale(ctx, { net: 500000, taxCode: 'UST26' }); //  gross  5'130.00
  purchase(ctx, { net: 200000, taxCode: 'VST-M' }); // must NOT be deducted (Art. 37)

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'saldo');

  // Gross turnover 15'940.00 at 6.2% = 988.28. Taxing the NET instead would give 930.00, and
  // taxing gross at the Normalsatz would give 1291.14: the fixture separates all three.
  assert.equal(ziff(r, '323').baseMinor, 1594000);
  assert.equal(ziff(r, '323').taxMinor, 98828);
  assert.equal(r.totalTaxDueMinor, 98828);
  assert.equal(r.totalInputTaxMinor, 0, 'Art. 37: no separate input deduction under saldo');
  assert.equal(ziff(r, '400'), undefined, 'the Saldo form has no Vorsteuer Ziffer at all');
  assert.equal(r.payableMinor, 98828);
});

test('A07: a pre-2024 saldo period reports on the legacy Ziffer 322, at a legacy-ladder rate', () => {
  // 5.9% is on the ESTV ladder in force from 1.1.2018 (SR 641.202.62) and is NOT on the rebased
  // 2024 one, so configuring it needs an `asOf` inside its own era. That is what makes this a
  // genuine legacy-period fixture rather than today's rate wearing a 2023 label.
  const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 590 }], asOf: '2023-01-01' });
  sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2023-05-15' }); // 7.7% -> gross 10'770.00
  sale(ctx, { net: 500000, taxCode: 'UST26', date: '2023-05-15' }); //  2.5% -> gross  5'125.00

  const r = computeVatReturn(ctx, { periodStart: '2023-04-01', periodEnd: '2023-06-30' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(ziff(r, '322'), undefined, 'legacy Saldo Ziffer, ESTV form 0553 "bis 31.12.2023"');
  assert.equal(ziff(r, '323'), undefined);
  assert.equal(ziff(r, '322').baseMinor, 1589500);
  // 15'895.00 at 5.9% is 937.805, and the ONE round is half away from zero: 937.81, never 937.80.
  assert.equal(ziff(r, '322').taxMinor, 93781);
});

test('A07: a Saldosteuersatz the period’s ladder never offered is REFUSED, not filed', () => {
  // 6.2% is on the 2024 ladder and absent from the 2018 one. `vat_saldo_rate` is current config and
  // carries no date, so a 2023 period was quietly computed at today's rate: not an approximation, a
  // rate the law did not offer for that period, on a line a human signs.
  const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  sale(ctx, { net: 1000000, taxCode: 'UST81', date: '2023-05-15' });
  sale(ctx, { net: 500000, taxCode: 'UST26', date: '2023-05-15' });

  const r = computeVatReturn(ctx, { periodStart: '2023-04-01', periodEnd: '2023-06-30' });
  assert.equal(r.ok, false, `a wrong signable figure must never be returned: ${JSON.stringify(r)}`);
  assert.equal(r.error, 'saldo_rate_not_valid_for_period');
  assert.equal(r.rateBp, 620);
  assert.deepEqual(r.ladderBp, [10, 60, 120, 200, 280, 350, 430, 510, 590, 650], 'the 2018 ladder');

  // And the SAME configuration files a CURRENT period without complaint: the refusal is about the
  // period, not about the rate.
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  const now = computeVatReturn(ctx, Q2);
  assert.equal(now.ok, true, JSON.stringify(now));
  assert.equal(ziff(now, '323').rateBp, 620);
});

test('A07: several Saldosteuersätze REFUSE, because no line names a business activity', () => {
  // MWSTV Art. 88 Abs. 1 taxes each activity at its own approved rate and Art. 86 Abs. 1 grants one
  // per activity above 10% of turnover (NOT MWSTG Art. 37, which carries only the method), while
  // Art. 84 Abs. 3 wants the turnover booked separately per rate. No tax code on a journal line names
  // an activity. Guessing the split would put a figure on an ESTV form that no line of the ledger
  // supports. Deleting the guard left the whole suite green and filed a fabricated figure computed
  // entirely at the FIRST rate.
  const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }, { rateBp: 370 }] });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, false, `a fabricated split must never be returned: ${JSON.stringify(r)}`);
  assert.equal(r.error, 'saldo_activity_split_required');
  // Q2 is a 2026 period, so both rates declare on the same Ziffer (A07 §3.1a). The refusal is
  // unchanged by that: what it could not choose between is the RATE, and the Ziffer never was the
  // thing in doubt. Reporting 333 here told the operator to look for a box the form does not have.
  assert.deepEqual(
    r.rates.map((x) => [x.position, x.rateBp, x.formLine]),
    [
      [1, 620, '323'],
      [2, 370, '323'],
    ],
    'the refusal names every rate it could not choose between',
  );
  // The figure the deleted guard produced, named so nobody reintroduces it as "close enough":
  // 6.2% over the whole gross turnover, as though the second activity did not exist.
  assert.equal(r.taxMinor, undefined);
});

test('A07: a 3rd Saldosteuersatz declares on the SAME Ziffer, and is still refused for want of an activity split', () => {
  // Since 1.1.2025 a filer may hold more than two rates: MWSTV Art. 86 Abs. 1 grants one per activity
  // above 10% of turnover, and the V vom 21. Aug. 2024 (AS 2024 485) repealed the two-rate cap that
  // MWSTV Art. 87 used to impose.
  //
  // THIS TEST USED TO ASSERT THAT THE 3RD RATE HAS NO ZIFFER AT ALL, on the ground that the ESTV form
  // defines two. That was true of the form up to 31.12.2024 and is not true of this period's: from
  // 01.01.2025 the Steuerberechnung block carries one Saldo row per rate ERA and none per rate
  // POSITION, and the split across "die verschiedenen SSS" is carried in the Beiblatt to Ziffern
  // 322/323 (MWST-Info 12 Ziff. 18.1.4, A07 §3.1a). So all three positions report 323.
  //
  // The refusal survives, and it is a DIFFERENT refusal from the one this test was named for: these
  // rates have no Tätigkeit mapping, so nothing says which turnover belongs to which rate. That is
  // `saldo_activity_split_required` and it is what the assertion below actually pins. The
  // no-Ziffer refusal (`saldo_form_line_missing`) still exists for a pre-2025 period and is proved in
  // `saldo-multirate.test.mjs`.
  const { ctx } = setup({
    method: 'saldo',
    timing: 'soll',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }, { rateBp: 300 }],
  });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, false, `three unmapped rates must never produce a signable figure: ${JSON.stringify(r)}`);
  assert.equal(r.error, 'saldo_activity_split_required');
  assert.deepEqual(
    r.rates.map((x) => [x.position, x.formLine]),
    [
      [1, '323'],
      [2, '323'],
      [3, '323'],
    ],
    'from 01.01.2025 the Ziffer does not vary by rate position, so a 3rd rate needs no new box',
  );
});

test('A07: the Saldo figure is rounded HALF AWAY FROM ZERO, not floored and not ceiled', () => {
  // The old fixture's `1'594'000 * 620 / 10000` is exactly 98'828, so the rounding mode was never
  // exercised: mutating the helper to `Math.floor` left all 31 tests green. Two fixtures are needed,
  // because a single one always agrees with something: a .5 case (which floor and trunc get wrong)
  // and a .2 case (which ceil gets wrong).
  {
    const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
    sale(ctx, { net: 1000000, taxCode: 'UST81' }); // gross 10'810.00
    sale(ctx, { net: 500244, taxCode: 'UST26' }); //  gross  5'132.50
    const r = computeVatReturn(ctx, Q2);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(ziff(r, '323').baseMinor, 1594250);
    // 15'942.50 at 6.2% is exactly 988.435: the half lands on the boundary the mode is named for.
    assert.equal(ziff(r, '323').taxMinor, 98844, 'half away from zero rounds UP, floor would give 98843');
  }
  {
    const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
    sale(ctx, { net: 1000000, taxCode: 'UST81' }); // gross 10'810.00
    sale(ctx, { net: 500097, taxCode: 'UST26' }); //  gross  5'131.00
    const r = computeVatReturn(ctx, Q2);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(ziff(r, '323').baseMinor, 1594100);
    // 15'941.00 at 6.2% is 988.342: below the half, so it rounds DOWN.
    assert.equal(ziff(r, '323').taxMinor, 98834, 'ceil would give 98835');
  }
});

// --- What must NOT reach the form ---------------------------------------------------------------

test('A07: a DRAFT carrying a tax code never reaches the return', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });

  // A draft is a proposal, not a booking: OR 957a knows nothing about it and the ESTV must never see
  // it. No fixture posted one, so dropping `AND e.status = 'posted'` from the tagged-line query left
  // the suite green while the return declared money nobody had committed to.
  const draft = saveDraft(ctx, {
    date: '2026-06-01',
    idempotencyKey: 'a07-draft-1',
    lines: [
      { account: acc(ctx, '1100'), debit: 9990000 },
      { account: acc(ctx, '3200'), credit: 9240000, taxCode: 'UST81', taxBase: 9240000, taxAmount: 750000 },
      { account: acc(ctx, '2200'), credit: 750000 },
    ],
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const drafted = ctx.store.db
    .prepare("SELECT COUNT(*) AS c FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.status = 'draft' AND l.tax_code IS NOT NULL")
    .get().c;
  assert.equal(drafted, 1, 'fixture sanity: there really is a tagged draft line in the database');

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ziff(r, '303').taxMinor, 81000, 'the draft’s 7’500.00 of tax must not appear');
  // The TURNOVER assertions are the ones that bite. A draft entry has no booked 2200 movement, so a
  // leaked draft line contributes zero tax and the tax-side assertions above stay green while the
  // Leistungen column silently grows by CHF 92'400.00.
  assert.equal(ziff(r, '303').baseMinor, 1000000, 'nor its turnover');
  assert.equal(ziff(r, '200').baseMinor, 1500000);
  assert.equal(ziff(r, '299').baseMinor, 1500000);
  assert.equal(r.empty, false);
  assert.equal(
    ziff(r, '303').entryIds.includes(draft.entryId),
    false,
    'and the drill-down must not name it either',
  );
  assert.equal(r.totalTaxDueMinor, 94000);
  assert.equal(r.reconciliation.outputVatBookedMinor, 94000);
  assert.equal(r.reconciled, true);
});

test('A07: Ziffer 299 is 200 minus 289, with export and exempt turnover really present', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' }); //      taxable,  810.00 tax
  sale(ctx, { net: 500000, taxCode: 'UST26' }); //       taxable,  130.00 tax
  sale(ctx, { net: 700000, taxCode: 'EXPORT0' }); //     echt befreit (Art. 23), Ziffer 220
  sale(ctx, { net: 300000, taxCode: 'AUSGENOMMEN' }); // ausgenommen (Art. 21), Ziffer 230

  // No fixture carried zero-rated or exempt turnover, so 289 and 299 were always zero and dropping
  // the deduction from 299 changed nothing: the whole Umsatz block was untested.
  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assertOneLinePerZiffer(r);
  assert.equal(ziff(r, '200').baseMinor, 2500000, 'worldwide turnover, taxable or not');
  assert.equal(ziff(r, '220').baseMinor, 700000);
  assert.equal(ziff(r, '230').baseMinor, 300000);
  assert.equal(ziff(r, '289').baseMinor, 1000000, 'Total Ziff. 220 bis 280');
  assert.equal(ziff(r, '299').baseMinor, 1500000, 'steuerbarer Gesamtumsatz: 200 less 289');
  assert.equal(ziff(r, '299').baseMinor, ziff(r, '200').baseMinor - ziff(r, '289').baseMinor);
  // And neither zero-rated nor exempt turnover produces output tax on a per-rate Ziffer.
  assert.equal(r.totalTaxDueMinor, 94000);
});

test('A07 saldo: a non-deductible input line claims nothing, and no Vorsteuer Ziffer appears', () => {
  // Art. 37: under Saldo the flat rate already imputes the input tax, so `deductible` is false for
  // every input kind and the GROSS folds into the expense with no 1170/1171 leg at all.
  //
  // The critic filed "dropping the `deductible` filter from the input allocation" as an untested
  // mutation that "only bites under Saldo". Measured, it bites nowhere: under effektiv `deductible`
  // is true for every INPUT_KIND, so the filter selects the same lines; under Saldo the allocation's
  // result is never read (the bucket loop returns before it) and the booked input movement is zero
  // anyway. It is an EQUIVALENT mutation, not a coverage gap, which is why no test can redden it.
  // What this fixture pins is the real guarantee: the Saldo form has no Vorsteuer Ziffer, and the
  // ledger holds no Vorsteuer to put on one.
  const { ctx } = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });
  purchase(ctx, { net: 200000, taxCode: 'VST-M' });
  purchase(ctx, { net: 100000, taxCode: 'VST-I' });

  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ziff(r, '400'), undefined, 'the Saldo form has no Vorsteuer Ziffer at all');
  assert.equal(ziff(r, '405'), undefined);
  assert.equal(r.totalInputTaxMinor, 0);
  assert.equal(r.payableMinor, ziff(r, '323').taxMinor, 'nothing is netted off the flat-rate figure');

  // The purchases booked NO movement on 1170/1171 at all (the gross folded into the expense), which
  // is the ledger fact the deduction filter has to agree with.
  const inputBooked = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number IN ('1170', '1171')`,
    )
    .get(ctx.workspaceId).net;
  assert.equal(inputBooked, 0, 'Art. 37: no separate Vorsteuer leg is booked under Saldo');
});

// --- The printed labels --------------------------------------------------------------------------

test('A07: the Ziffer labels are the ones the FILED METHOD’s form prints, verbatim', () => {
  // The two forms disagree, and a label is German text printed beside a figure a person signs.
  // Ziffer 200 gains "inkl. optierte Leistungen" under effektiv, because optieren is an effektiv
  // concept; 479 is a different figure entirely on each form. Read off DM_0550_03 / 01.24 and
  // DM_0536_04 / 01.24, both fetched 2026-07-25 from estv2.admin.ch.
  const eff = setup({ method: 'effektiv', timing: 'soll' });
  sale(eff.ctx, { net: 1000000, taxCode: 'UST81' });
  sale(eff.ctx, { net: 500000, taxCode: 'UST26' });
  const e = computeVatReturn(eff.ctx, Q2);
  assert.equal(e.ok, true, JSON.stringify(e));
  assert.match(ziff(e, '200').label, /inkl\. optierte Leistungen/);

  const sal = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  sale(sal.ctx, { net: 1000000, taxCode: 'UST81' });
  sale(sal.ctx, { net: 500000, taxCode: 'UST26' });
  const s = computeVatReturn(sal.ctx, Q2);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.doesNotMatch(ziff(s, '200').label, /optierte/, 'the Saldo form does not carry that clause');
  assert.match(ziff(s, '200').label, /weltweiter Umsatz/);

  // The 479 split, which is the part of F8 that could actually mislead a filer.
  assert.equal(formLineLabel('479', false), 'Total Ziff. 400 bis 420');
  assert.equal(formLineLabel('479', true), 'Total Ziff. 470 bis 471');
  assert.equal(formLineLabel('470', true), 'Steueranrechnung gemäss Formular Nr. 1050');
  assert.equal(formLineLabel('470', false), '470', 'the effektiv form has no 470 at all');
  // A Ziffer neither form carries falls back to its own number, never to a fabricated label.
  assert.equal(formLineLabel('123', false), '123');
});

// --- P9 scope degradation ----------------------------------------------------------------------

test('A07: an unconfigured workspace returns needs_vat_config, never a zero return', () => {
  const { ctx } = setup({ registered: false });
  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'needs_vat_config');
});

test('A07: an Ist workspace is REFUSED, it is never handed the Soll figures', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'ist' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });

  // Ist recognises VAT on payment (MWSTG Art. 39 Abs. 2), and neither of the two supplies above has
  // been paid. The Soll answer for this fixture is CHF 940.00, and handing an Ist filer that number
  // would give them a wrong return that looks right: a figure they would sign. Refusing is the only
  // honest answer until the payment-driven selection exists.
  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsupported');
  assert.equal(r.reason, 'ist_timing_not_implemented');
});

test('A07: an empty period is a ZERO return, not an error and not an absent one', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  const r = computeVatReturn(ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.payableMinor, 0);
  assert.equal(r.creditMinor, 0);
  assert.equal(r.totalTaxDueMinor, 0);
  assert.equal(r.empty, true);
});

test('A07: a malformed period is a structured rejection, never a silently coerced range', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  const r = computeVatReturn(ctx, { periodStart: '01.04.2026', periodEnd: '2026-06-30' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_input');
});

test('A07: an inverted period is rejected rather than returning an empty return', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  const r = computeVatReturn(ctx, { periodStart: '2026-06-30', periodEnd: '2026-04-01' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_period');
});

// --- §H-TENANT ---------------------------------------------------------------------------------

/**
 * Two workspaces in ONE database, and the other tenant is minted FIRST.
 *
 * Both halves are load-bearing. The old fixture called `setup()` twice, and `setup()` built a
 * `new SqliteStore(...)` on every call, so "the second workspace" lived in a separate in-memory
 * database and was minted as `ws_1` all over again: the same id, in a file the first workspace could
 * not see. Neutralising the workspace filter in all three tenant-scoped reads
 * (`workspace_id = ? OR 1=1`) left the whole suite green, three times over.
 *
 * The ORDER is the second half. A neutralised filter on a `.get()` degenerates to "the first
 * matching row", so a fixture whose own workspace was created first survives that mutation by
 * accident. Minting the other tenant first is what makes those reads falsifiable, and it is why the
 * other tenant is configured to differ on EVERY field a leak could carry: a different method
 * (saldo, so the Ziffern and the period length change), a different timing (ist, which A07 refuses
 * outright), a different Saldosteuersatz, and its own locks.
 */
function twoTenants(mine, theirs = { method: 'saldo', timing: 'ist', saldoRates: [{ rateBp: 370 }] }) {
  const other = setup(theirs);
  const own = setup({ ...mine, store: other.store, ids: other.ids });
  assert.equal(own.store, other.store, 'one database, or this test proves nothing');
  assert.notEqual(own.workspaceId, other.workspaceId, 'two tenants, or this test proves nothing');
  return { own, other };
}

test('A07 §H-TENANT: another workspace’s postings, config and locks never enter this return', () => {
  const { own, other } = twoTenants({ method: 'effektiv', timing: 'soll' });

  sale(own.ctx, { net: 1000000, taxCode: 'UST81' });
  sale(own.ctx, { net: 500000, taxCode: 'UST26' });
  purchase(own.ctx, { net: 200000, taxCode: 'VST-M' });

  // The other tenant posts into the SAME database, in the same period, in shapes that would be
  // impossible to miss if they leaked.
  sale(other.ctx, { net: 9900000, taxCode: 'UST81' });
  purchase(other.ctx, { net: 8800000, taxCode: 'VST-M' });

  const r = computeVatReturn(own.ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'effektiv', 'the config read must be this tenant’s');
  assert.equal(r.timing, 'soll');
  assert.equal(r.totalTaxDueMinor, 94000, 'the tagged-line read must be this tenant’s');
  assert.equal(r.totalInputTaxMinor, 16200);
  assert.equal(
    r.reconciliation.outputVatBookedMinor,
    94000,
    'and so must the booked 2200 movement the reconciliation compares against',
  );
  assert.equal(r.reconciled, true);

  const ids = new Set(r.lines.flatMap((l) => l.entryIds));
  const theirs = other.ctx.store.db
    .prepare('SELECT id FROM journal_entry WHERE workspace_id = ?')
    .all(other.workspaceId)
    .map((e) => e.id);
  assert.ok(theirs.length > 0, 'fixture sanity: the other tenant really did post');
  for (const id of theirs) assert.equal(ids.has(id), false, `the drill-down leaked ${id}`);

  // And the filed flag: the other tenant seals 2026-Q2, which must leave this tenant's Q2 open.
  const filed = markVatPeriodFiled(other.ctx, { period: '2026-Q2', idempotencyKey: 'other-f1' });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const periods = listVatPeriods(own.ctx, { year: '2026' });
  assert.equal(periods.ok, true, JSON.stringify(periods));
  assert.deepEqual(
    periods.periods.map((p) => p.label),
    ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'],
    'the method read behind the period derivation must be this tenant’s too',
  );
  assert.equal(
    periods.periods.find((p) => p.label === '2026-Q2').filed,
    false,
    'another tenant’s hard locks must not mark this tenant’s quarter filed',
  );
});

test('A07 §H-TENANT: the Saldosteuersatz read is this tenant’s, not the database’s', () => {
  // Both tenants on saldo, at DIFFERENT rates. A neutralised filter on `vat_saldo_rate` returns two
  // rows, which A07 reads as a multi-activity workspace and refuses; returning the other tenant's
  // single row instead would file 3.7% where 6.2% is owed. Either way the figure below cannot
  // survive.
  const { own } = twoTenants(
    { method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] },
    { method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 370 }] },
  );
  sale(own.ctx, { net: 1000000, taxCode: 'UST81' });
  sale(own.ctx, { net: 500000, taxCode: 'UST26' });

  const r = computeVatReturn(own.ctx, Q2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ziff(r, '323').taxMinor, 98828, '6.2% of the gross 15’940.00, not the other tenant’s 3.7%');
});

// --- Drill-down --------------------------------------------------------------------------------

test('A07: every form line names the entries that produced it', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  const s1 = sale(ctx, { net: 1000000, taxCode: 'UST81' });
  const s2 = sale(ctx, { net: 500000, taxCode: 'UST26' });

  const r = computeVatReturn(ctx, Q2);
  assert.deepEqual(ziff(r, '303').entryIds, [s1.entryId]);
  assert.deepEqual(ziff(r, '313').entryIds, [s2.entryId]);
});

// --- A07 never posts (P3 by absence) -----------------------------------------------------------

test('A07: computing a return writes nothing at all', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  sale(ctx, { net: 500000, taxCode: 'UST26' });

  const count = () =>
    ctx.store.db.prepare('SELECT COUNT(*) AS c FROM journal_line').get().c +
    ctx.store.db.prepare('SELECT COUNT(*) AS c FROM journal_entry').get().c;
  const before = count();
  computeVatReturn(ctx, Q2);
  computeVatReturn(ctx, Q2);
  assert.equal(count(), before, 'a read model that writes is not a read model');
});

// --- Filing: the A03 hard lock, and §H-IDEMPOTENT on ROWS ---------------------------------------

test('A07: marking a period filed applies A03 hard locks with reason vat_filed', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });

  const r = markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'f-1' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const locks = ctx.store.db
    .prepare('SELECT period, kind, reason FROM period_lock WHERE workspace_id = ? ORDER BY period')
    .all(ctx.workspaceId);
  assert.deepEqual(
    locks.map((l) => l.period),
    ['2026-04', '2026-05', '2026-06'],
    'a quarter seals its three months: period_lock keys on YYYY-MM or YYYY',
  );
  for (const l of locks) {
    assert.equal(l.kind, 'hard');
    assert.equal(l.reason, 'vat_filed');
  }
});

test('A07 §H-IDEMPOTENT: re-filing on the same key mints no second lock, counted in ROWS', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });

  const rows = () =>
    ctx.store.db.prepare('SELECT COUNT(*) AS c FROM period_lock WHERE workspace_id = ?').get(ctx.workspaceId).c;
  // The SECOND counter, and the one that actually guards this verb's own contribution.
  //
  // `period_lock` keys on (workspace_id, period), so its row count stays at 3 across a replay no
  // matter WHAT key A07 hands A03: the database primary key holds that line, not this code. A
  // mutation that made the delegated key unstable (a random suffix per call) left the lock count
  // untouched and passed a test that only counted locks. What a broken key actually does is mint a
  // fresh `idempotency` row on every replay, forever. So that is what gets counted.
  const keys = () =>
    ctx.store.db
      .prepare("SELECT COUNT(*) AS c FROM idempotency WHERE workspace_id = ? AND verb = 'lock_period'")
      .get(ctx.workspaceId).c;

  const first = markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'f-1' });
  const afterLocks = rows();
  const afterKeys = keys();
  assert.equal(first.ok, true);
  assert.equal(afterLocks, 3);
  assert.equal(afterKeys, 3, 'one delegated key per month, and it is derived from the caller’s');

  const second = markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'f-1' });
  assert.equal(second.ok, true);
  assert.equal(rows(), afterLocks, 'a replay must not double-count, and rows are the proof');
  assert.equal(keys(), afterKeys, 'a replay must REUSE the derived keys, not mint new ones');
  assert.deepEqual(second, first, 'and it must return the same result, not merely a similar one');
});

test('A07: a filed period blocks later posting into it (§H-PERIOD)', () => {
  const fixture = setup({ method: 'effektiv', timing: 'soll' });
  const { ctx } = fixture;
  sale(ctx, { net: 1000000, taxCode: 'UST81' });
  markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'f-1' });

  // Through a period-ENFORCING context: the seal has to actually stop the post, not merely exist.
  const sealed = enforcingCtx(fixture);
  key += 1;
  const late = postEntry(sealed, {
    date: '2026-05-31',
    source: 'manual',
    idempotencyKey: `a07-late-${key}`,
    lines: [
      { account: acc(ctx, '6500'), debit: 5000 },
      { account: acc(ctx, '1000'), credit: 5000 },
    ],
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'period_locked');
});

test('A07: a malformed period label is rejected before any lock is written', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  const r = markVatPeriodFiled(ctx, { period: '2026-Q5', idempotencyKey: 'f-1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_period');
  const rows = ctx.store.db
    .prepare('SELECT COUNT(*) AS c FROM period_lock WHERE workspace_id = ?')
    .get(ctx.workspaceId).c;
  assert.equal(rows, 0, 'a rejected filing must leave no partial seal behind');
});

// --- Periods -----------------------------------------------------------------------------------

test('A07: effektiv derives QUARTERLY periods, saldo derives SEMI-ANNUAL ones (MWSTG Art. 35)', () => {
  const eff = setup({ method: 'effektiv', timing: 'soll' });
  const q = listVatPeriods(eff.ctx, { year: '2026' });
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.deepEqual(
    q.periods.map((p) => p.label),
    ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'],
  );
  assert.equal(q.periods[1].periodStart, '2026-04-01');
  assert.equal(q.periods[1].periodEnd, '2026-06-30');

  const sal = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  const h = listVatPeriods(sal.ctx, { year: '2026' });
  assert.deepEqual(
    h.periods.map((p) => p.label),
    ['2026-H1', '2026-H2'],
  );
  assert.equal(h.periods[0].periodStart, '2026-01-01');
  assert.equal(h.periods[0].periodEnd, '2026-06-30');
});

test('A07: a period reports filed once its months are hard-locked by a filing', () => {
  const { ctx } = setup({ method: 'effektiv', timing: 'soll' });
  sale(ctx, { net: 1000000, taxCode: 'UST81' });

  const before = listVatPeriods(ctx, { year: '2026' });
  assert.equal(before.periods.find((p) => p.label === '2026-Q2').filed, false);

  markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'f-1' });

  const after = listVatPeriods(ctx, { year: '2026' });
  assert.equal(after.periods.find((p) => p.label === '2026-Q2').filed, true);
  assert.equal(after.periods.find((p) => p.label === '2026-Q1').filed, false);
});
