// A08, the four read models: Saldenbilanz, Bilanz, Erfolgsrechnung, Kontoblatt.
//
// The assertions here are VALUES, not shapes. A test that checks a section exists and carries a
// `kind` passes against a report whose every figure is wrong, and this repo has shipped exactly that
// (eight hand-written account names were wrong while every kind matched). So each case names the
// Rappen it expects, worked out by hand in `support.mjs` and never by a second call to the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
} from '../../dist/core/reports/index.js';
import { hardCloseYear } from '../../dist/core/ledger/index.js';
import {
  setup,
  seedBooks,
  post,
  importRawEntry,
  importUnbalancedEntry,
  PERIOD,
  PRIOR,
  EXPECTED,
  ledgerNet,
  sectionFor,
  rowFor,
} from './support.mjs';

// --- US-A08.1, Saldenbilanz ----------------------------------------------------------------------

test('trial balance: opening, period movement and closing per account, to the Rappen', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(res.ok, true, JSON.stringify(res));

  // 1020 Bankkonto: opened at 20'000.00, took 5'405.00 in and paid 7'450.00 out during Q1.
  const bank = rowFor(res, '1020');
  assert.equal(bank.openingMinor, 2000000);
  assert.equal(bank.debitMinor, 540500);
  assert.equal(bank.creditMinor, 745000); // 600000 + 120000 + 25000
  assert.equal(bank.closingMinor, 1795500);

  // 3800 Erlösminderungen carries a DEBIT on an income account: the sign trap.
  const rabatt = rowFor(res, '3800');
  assert.equal(rabatt.openingMinor, 0);
  assert.equal(rabatt.debitMinor, 30000);
  assert.equal(rabatt.creditMinor, 0);
  assert.equal(rabatt.closingMinor, 30000);

  // 4900 erhaltene Skonti carries a CREDIT on an expense account: the mirror trap.
  const skonto = rowFor(res, '4900');
  assert.equal(skonto.debitMinor, 0);
  assert.equal(skonto.creditMinor, 15000);
  assert.equal(skonto.closingMinor, -15000);

  // 1500 opened at 12'000.00 and was written down by 2'000.00.
  const maschinen = rowFor(res, '1500');
  assert.equal(maschinen.openingMinor, 1200000);
  assert.equal(maschinen.creditMinor, 200000);
  assert.equal(maschinen.closingMinor, 1000000);
});

test('trial balance: the grand totals and the reconciliation are the arithmetic, not a restatement', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(res.totals.debitMinor, EXPECTED.trial.debit);
  assert.equal(res.totals.creditMinor, EXPECTED.trial.credit);
  assert.equal(res.totals.openingMinor, EXPECTED.trial.opening);
  assert.equal(res.totals.closingMinor, EXPECTED.trial.closing);
  assert.equal(res.reconciles, true);
  assert.equal(res.reconciliation.debitEqualsCredit, true);
  assert.equal(res.reconciliation.closingTiesToLedger, true);
  assert.equal(res.reconciliation.everyAccountRenderedOnce, true);
  assert.equal(res.noActivity, false);
});

test('trial balance: every account with a movement or a balance appears exactly once', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, PERIOD);
  const numbers = res.rows.map((r) => r.account.number);
  assert.equal(new Set(numbers).size, numbers.length, 'an account was rendered twice');
  // Every account the LEDGER moved must be on the report. A dropped row is the defect class that
  // survives every total-level check when its section is also dropped.
  const moved = t.store.db
    .prepare(
      `SELECT DISTINCT a.number AS number FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .all(t.workspaceId, PERIOD.periodEnd)
    .map((r) => r.number);
  for (const number of moved) {
    assert.ok(numbers.includes(number), `account ${number} moved in the ledger but is not on the report`);
  }
});

test('trial balance: the closing column agrees with an independent query over journal_line', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, PERIOD);
  for (const row of res.rows) {
    assert.equal(
      row.closingMinor,
      ledgerNet(t.store, t.workspaceId, row.account.number, { to: PERIOD.periodEnd }),
      `closing balance of ${row.account.number} disagrees with the ledger`,
    );
  }
});

test('trial balance: a draft never reaches a figure (§H-AUDIT)', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, PERIOD);
  // The draft posts 999'999.00 to 6500. If it leaked, the office-costs row would be off by that.
  assert.equal(rowFor(res, '6500').debitMinor, 120000);
  assert.equal(res.totals.debitMinor, EXPECTED.trial.debit);
});

test('trial balance: the comparison column carries the prior period closing', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, { ...PERIOD, compareTo: PRIOR });
  // 1020 closed the prior quarter at the opening carry alone: the 2025-12-31 entry is inside it.
  assert.equal(rowFor(res, '1020').compareClosingMinor, 2000000);
  assert.equal(rowFor(res, '1020').deltaMinor, 1795500 - 2000000);
  // 3400 had no prior-period activity at all.
  assert.equal(rowFor(res, '3400').compareClosingMinor, 0);
  assert.equal(rowFor(res, '3400').deltaMinor, -1000000);
});

// --- US-A08.2, Bilanz ----------------------------------------------------------------------------

test('balance sheet: OR 959a sections carry the hand-computed subtotals and Aktiven == Passiven', () => {
  const t = setup();
  seedBooks(t);
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(res.ok, true, JSON.stringify(res));

  for (const [key, expected] of Object.entries(EXPECTED.bilanz)) {
    if (key === 'aktiven' || key === 'passiven') continue;
    assert.equal(sectionFor(res, key).subtotalMinor, expected, `section ${key}`);
  }
  assert.equal(res.aktivenMinor, EXPECTED.bilanz.aktiven);
  assert.equal(res.passivenMinor, EXPECTED.bilanz.passiven);
  assert.equal(res.reconciles, true);
  assert.equal(res.reconciliation.aktivenEqualPassiven, true);
  assert.equal(res.reconciliation.ledgerNetsToZero, true);
  assert.equal(res.reconciliation.everyAccountClassifiedOnce, true);
});

test('balance sheet: each line is positive on its own side, never a raw debit-minus-credit', () => {
  const t = setup();
  seedBooks(t);
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  const lineFor = (number) =>
    res.sections.flatMap((s) => s.lines).find((l) => l.account.number === number);
  for (const [number, expected] of Object.entries(EXPECTED.balances)) {
    assert.equal(lineFor(number).balanceMinor, expected, `line ${number}`);
  }
  // 2000 Kreditoren is a credit balance of 6'850.00 and must READ as +685000 on the Passiven side,
  // while the ledger holds it as -685000 debit-net. Reporting the raw net would print a negative
  // liability and still foot, because the sign error cancels inside the Passiven total.
  assert.equal(ledgerNet(t.store, t.workspaceId, '2000', { to: '2026-03-31' }), -685000);
});

test('balance sheet: the Jahresergebnis is an equity line (OR 959a Abs. 2 Ziff. 3 lit. g)', () => {
  const t = setup();
  seedBooks(t);
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  const equity = sectionFor(res, 'eigenkapital');
  const result = equity.lines.find((l) => l.key === 'jahresergebnis');
  assert.ok(result !== undefined, 'the Bilanz must carry the running result as an equity position');
  assert.equal(result.balanceMinor, EXPECTED.erfolgsrechnung.reingewinn);
  assert.equal(result.account, null, 'the result line is computed, not an account');
});

test('balance sheet: a LOSS reduces equity and the statement still foots', () => {
  const t = setup();
  seedBooks(t, { loss: true });
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  const equity = sectionFor(res, 'eigenkapital');
  const result = equity.lines.find((l) => l.key === 'jahresergebnis');
  assert.equal(result.balanceMinor, -460000); // 540000 - 1000000
  assert.equal(equity.subtotalMinor, 1540000); // 2000000 - 460000
  assert.equal(res.aktivenMinor, 3346500);
  assert.equal(res.passivenMinor, 3346500);
  assert.equal(res.reconciles, true);
});

// --- US-A08.3, Erfolgsrechnung -------------------------------------------------------------------

test('income statement: the OR 959b Abs. 2 positions carry the hand-computed figures', () => {
  const t = setup();
  seedBooks(t);
  const res = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(res.ok, true, JSON.stringify(res));
  for (const [key, expected] of Object.entries(EXPECTED.erfolgsrechnung)) {
    if (key === 'reingewinn') continue;
    assert.equal(sectionFor(res, key).subtotalMinor, expected, `position ${key}`);
  }
  assert.equal(res.reingewinnMinor, EXPECTED.erfolgsrechnung.reingewinn);
  assert.equal(res.reconciles, true);
  assert.equal(res.reconciliation.resultTiesToLedger, true);
  assert.equal(res.reconciliation.everyAccountClassifiedOnce, true);
});

test('income statement: a loss is a negative Reingewinn, never an absolute value', () => {
  const t = setup();
  seedBooks(t, { loss: true });
  const res = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(res.reingewinnMinor, -460000);
  assert.equal(sectionFor(res, 'uebriger_betrieblicher_aufwand').subtotalMinor, -1120000);
  assert.equal(res.reconciles, true);
});

test('income statement: the Reingewinn equals the Bilanz Eigenkapital movement (tie-out)', () => {
  const t = setup();
  seedBooks(t);
  const income = computeIncomeStatement(t.ctx, { periodStart: '2026-01-01', periodEnd: '2026-03-31' });
  const bilanz = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  const result = sectionFor(bilanz, 'eigenkapital').lines.find((l) => l.key === 'jahresergebnis');
  assert.equal(income.reingewinnMinor, result.balanceMinor);
});

test('income statement: no balance-sheet account can leak into a position', () => {
  const t = setup();
  seedBooks(t);
  const res = computeIncomeStatement(t.ctx, PERIOD);
  const numbers = res.sections.flatMap((s) => s.lines).map((l) => l.account.number);
  for (const number of numbers) {
    assert.ok(/^[3-9]/.test(number), `${number} is a balance-sheet account and must not be on the ER`);
  }
  assert.equal(new Set(numbers).size, numbers.length, 'an account was rendered twice');
});

// --- US-A08.4, Kontoblatt ------------------------------------------------------------------------

test('general ledger: opening carry, chronological lines with a running balance, closing', () => {
  const t = setup();
  seedBooks(t);
  const res = computeGeneralLedger(t.ctx, { accountId: t.acc('1020'), ...PERIOD });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.openingMinor, 2000000);
  assert.deepEqual(
    res.lines.map((l) => [l.date, l.debitMinor, l.creditMinor, l.runningMinor]),
    [
      ['2026-02-03', 540500, 0, 2540500],
      ['2026-02-25', 0, 600000, 1940500],
      ['2026-03-05', 0, 120000, 1820500],
      ['2026-03-20', 0, 25000, 1795500],
    ],
  );
  assert.equal(res.closingMinor, 1795500);
  assert.equal(res.closingMinor, ledgerNet(t.store, t.workspaceId, '1020', { to: PERIOD.periodEnd }));
});

test('general ledger: every line carries the entry it drills to', () => {
  const t = setup();
  seedBooks(t);
  const res = computeGeneralLedger(t.ctx, { accountId: t.acc('1020'), ...PERIOD });
  for (const line of res.lines) {
    assert.equal(typeof line.entryId, 'string');
    assert.ok(line.entryId.length > 0);
  }
  assert.equal(res.lines[0].ref, 'RE-0002');
  assert.equal(res.lines[0].description, 'Warenverkauf');
});

test('general ledger: a draft line is not on the Kontoblatt', () => {
  const t = setup();
  seedBooks(t);
  const res = computeGeneralLedger(t.ctx, { accountId: t.acc('6500'), ...PERIOD });
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].debitMinor, 120000);
  assert.equal(res.closingMinor, 120000);
});

test('general ledger: an unknown account is a structured rejection, not an empty report', () => {
  const t = setup();
  seedBooks(t);
  const res = computeGeneralLedger(t.ctx, { accountId: 'acc_nope', ...PERIOD });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
});

// --- Boundaries and degradation ------------------------------------------------------------------

test('a period straddling the year end carries the prior-year opening', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, { periodStart: '2025-12-01', periodEnd: '2026-01-31' });
  // The 2025-12-31 opening entry is now INSIDE the window, so it is movement and not carry.
  assert.equal(rowFor(res, '1020').openingMinor, 0);
  assert.equal(rowFor(res, '1020').debitMinor, 2000000);
  assert.equal(rowFor(res, '1100').debitMinor, 1081000);
  assert.equal(res.reconciles, true);
});

test('an entry dated exactly on a period boundary is INSIDE the window, at both ends', () => {
  // Added after a mutation sweep found the gap: turning `e.date >= ?` into `e.date > ?` left every
  // case green, because no fixture entry sat on the opening boundary. A period fence is exactly the
  // kind of off-by-one that moves a figure between two quarters and reconciles perfectly in both.
  const t = setup();
  seedBooks(t);
  post(t, {
    date: '2025-12-31',
    key: 'day-before',
    lines: [
      { n: '1000', debit: 100 },
      { n: '3600', credit: 100 },
    ],
  });
  post(t, {
    date: '2026-01-01',
    key: 'first-day',
    lines: [
      { n: '1000', debit: 11100 },
      { n: '3600', credit: 11100 },
    ],
  });
  post(t, {
    date: '2026-03-31',
    key: 'last-day',
    lines: [
      { n: '1000', debit: 22200 },
      { n: '3600', credit: 22200 },
    ],
  });
  post(t, {
    date: '2026-04-01',
    key: 'day-after',
    lines: [
      { n: '1000', debit: 400 },
      { n: '3600', credit: 400 },
    ],
  });

  const res = computeTrialBalance(t.ctx, PERIOD);
  const cash = rowFor(res, '1000');
  assert.equal(cash.openingMinor, 500100, 'the day BEFORE the window is carry, not movement');
  assert.equal(cash.debitMinor, 33300, 'both boundary days are movement: 11100 + 22200');
  assert.equal(cash.closingMinor, 533400);
  assert.equal(rowFor(res, '3600').creditMinor, 33300);
  assert.equal(res.reconciles, true);

  // The Kontoblatt runs its own dated query, so it is fenced separately and checked separately.
  const kontoblatt = computeGeneralLedger(t.ctx, { accountId: t.acc('1000'), ...PERIOD });
  assert.deepEqual(
    kontoblatt.lines.map((l) => [l.date, l.debitMinor]),
    [
      ['2026-01-01', 11100],
      ['2026-03-31', 22200],
    ],
  );
  assert.equal(kontoblatt.openingMinor, 500100);
  assert.equal(kontoblatt.closingMinor, 533400);

  // And the Erfolgsrechnung, whose independent tie-out runs a third dated query of its own.
  const income = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(sectionFor(income, 'netto_erloese').subtotalMinor, 1470000 + 33300);
  assert.equal(income.reconciles, true);
});

test('an empty period returns the statutory structure at zero, flagged, never an error', () => {
  const t = setup();
  seedBooks(t);
  const res = computeIncomeStatement(t.ctx, { periodStart: '2020-01-01', periodEnd: '2020-12-31' });
  assert.equal(res.ok, true);
  assert.equal(res.noActivity, true);
  assert.equal(res.reingewinnMinor, 0);
  assert.equal(res.sections.length, 11, 'the ten OR 959b Abs. 2 positions plus the Abs. 5 residual still render');
  for (const section of res.sections) assert.equal(section.subtotalMinor, 0);
});

test('a workspace with no chart degrades to needs_chart (P9), never a 500', () => {
  const t = setup();
  t.store.db.prepare('DELETE FROM account WHERE workspace_id = ?').run(t.workspaceId);
  for (const res of [
    computeTrialBalance(t.ctx, PERIOD),
    computeBalanceSheet(t.ctx, { asOf: '2026-03-31' }),
    computeIncomeStatement(t.ctx, PERIOD),
  ]) {
    assert.equal(res.ok, false);
    assert.equal(res.error, 'needs_chart');
  }
});

test('an inverted or malformed period is a structured rejection', () => {
  const t = setup();
  seedBooks(t);
  const inverted = computeTrialBalance(t.ctx, { periodStart: '2026-03-31', periodEnd: '2026-01-01' });
  assert.equal(inverted.ok, false);
  assert.equal(inverted.error, 'invalid_period');
  const malformed = computeTrialBalance(t.ctx, { periodStart: '01.01.2026', periodEnd: '2026-03-31' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'invalid_input');
  const badAsOf = computeBalanceSheet(t.ctx, { asOf: '2026-02-30' });
  assert.equal(badAsOf.ok, false);
  assert.equal(badAsOf.error, 'invalid_input');
});

// --- §H-FX: the books, not the transaction ------------------------------------------------------

test('every figure is the BASE amount, never the transaction amount', () => {
  const t = setup();
  // EUR 1'000.00 of revenue at 0.95 is CHF 950.00 in the books. A report that summed `debit_minor`
  // would print 1'000.00 and foot perfectly, because both legs carry the same wrong unit.
  post(t, {
    date: '2026-02-10',
    key: 'eur-1',
    currency: 'EUR',
    fxRate: '0.95',
    lines: [
      { n: '1020', debit: 100000 },
      { n: '3400', credit: 100000 },
    ],
  });
  const trial = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(rowFor(trial, '1020').debitMinor, 95000);
  assert.equal(rowFor(trial, '3400').creditMinor, 95000);
  const income = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(income.reingewinnMinor, 95000);
  assert.equal(income.baseCurrency, 'CHF');
});

// --- US-A08.5, the comparison column, asserted for VALUE -----------------------------------------
//
// The Saldenbilanz's comparison column was the only one held to a figure. Pointing the Bilanz's
// `compare` aggregate at `input.asOf` instead of `compareTo.asOf` stayed green, and so did the
// Erfolgsrechnung's `compareReingewinnMinor`: the columns were asserted to EXIST and never to be a
// different period. A comparison column that silently repeats the current period is worse than none,
// because the delta reads as zero and a reader concludes nothing moved.

test('balance sheet: the comparison column is the PRIOR Stichtag, figure by figure', () => {
  const t = setup();
  seedBooks(t);
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31', compareTo: { asOf: '2025-12-31' } });
  assert.equal(res.compareTo, '2025-12-31');

  // At 2025-12-31 only the opening entry has happened, so every figure differs from Q1's.
  const umlauf = sectionFor(res, 'umlaufvermoegen');
  const bank = umlauf.lines.find((l) => l.account?.number === '1020');
  assert.equal(bank.balanceMinor, 1795500);
  assert.equal(bank.compareBalanceMinor, 2000000, 'the comparison must be the opening carry, not Q1');
  assert.equal(bank.deltaMinor, -204500);
  // 1100 Forderungen did not exist at the prior Stichtag: a zero that is a real zero.
  const forderungen = umlauf.lines.find((l) => l.account?.number === '1100');
  assert.equal(forderungen.balanceMinor, 1051000);
  assert.equal(forderungen.compareBalanceMinor, 0);
  // Subtotals: 500000 + 2000000 at the prior date, against Q1's 3346500.
  assert.equal(umlauf.subtotalMinor, EXPECTED.bilanz.umlaufvermoegen);
  assert.equal(umlauf.compareSubtotalMinor, 2500000);
  assert.equal(sectionFor(res, 'anlagevermoegen').compareSubtotalMinor, 1200000);

  // The prior year's Jahresergebnis is zero (the opening entry touches no P&L account), and the
  // comparison is drawn against the PRIOR fiscal year's start, not the current one.
  const equity = sectionFor(res, 'eigenkapital');
  assert.equal(equity.lines.find((l) => l.key === 'jahresergebnis').balanceMinor, 540000);
  assert.equal(equity.lines.find((l) => l.key === 'jahresergebnis').compareBalanceMinor, 0);

  // And the comparison column foots on its own, at a figure that is not the current one.
  assert.equal(res.compareAktivenMinor, 3700000);
  assert.equal(res.comparePassivenMinor, 3700000);
  assert.notEqual(res.compareAktivenMinor, res.aktivenMinor);
});

test('income statement: compareReingewinnMinor is the OTHER window', () => {
  const t = setup();
  seedBooks(t);
  // January and February only: the March postings (Abschreibung, Skonto, Zins, Bürokosten) are out,
  // so the comparison result must differ from Q1's by exactly those.
  const res = computeIncomeStatement(t.ctx, {
    ...PERIOD,
    compareTo: { periodStart: '2026-01-01', periodEnd: '2026-02-28' },
  });
  assert.equal(res.reingewinnMinor, EXPECTED.erfolgsrechnung.reingewinn);
  // 1470000 Nettoerlöse - 600000 Personalaufwand, and nothing else falls before 1 March.
  assert.equal(res.compareReingewinnMinor, 870000);
  assert.notEqual(res.compareReingewinnMinor, res.reingewinnMinor);

  const personal = sectionFor(res, 'personalaufwand');
  assert.equal(personal.subtotalMinor, -600000);
  assert.equal(personal.compareSubtotalMinor, -600000, 'the February wage is in both windows');
  const abschreibungen = sectionFor(res, 'abschreibungen');
  assert.equal(abschreibungen.subtotalMinor, -200000);
  assert.equal(abschreibungen.compareSubtotalMinor, 0, 'the 31 March Abschreibung is outside the comparison');
  assert.equal(abschreibungen.lines[0].deltaMinor, -200000);
});

// --- The fields a GUI presents on, asserted for value --------------------------------------------

test('the Kontoblatt states the account naturalSide and its KMU class', () => {
  const t = setup();
  seedBooks(t);
  // `naturalSide` forced to the constant 'debit' and `kmuClass` forced to '1' both survived: a GUI
  // reads these to choose a presentation without re-deriving one, so a constant would flip the
  // display sign of every liability and income account on the Kontoblatt.
  const cases = [
    ['1020', 'debit', '1'], // asset
    ['2000', 'credit', '2'], // liability
    ['2800', 'credit', '2'], // equity
    ['3400', 'credit', '3'], // income
    ['5000', 'debit', '5'], // expense
    ['6800', 'debit', '6'],
  ];
  for (const [number, side, kmuClass] of cases) {
    const res = computeGeneralLedger(t.ctx, { accountId: t.acc(number), ...PERIOD });
    assert.equal(res.naturalSide, side, `${number}: naturalSide`);
    assert.equal(res.kmuClass, kmuClass, `${number}: kmuClass`);
  }
});

test('the Saldenbilanz kmuClass follows the account number, and the groups follow it', () => {
  const t = setup();
  seedBooks(t);
  const res = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(rowFor(res, '1020').kmuClass, '1');
  assert.equal(rowFor(res, '2200').kmuClass, '2');
  assert.equal(rowFor(res, '3800').kmuClass, '3');
  assert.equal(rowFor(res, '4900').kmuClass, '4');
  assert.equal(rowFor(res, '5000').kmuClass, '5');
  assert.equal(rowFor(res, '6900').kmuClass, '6');
  // More than one class is present, so a constant cannot satisfy this.
  const classes = res.groups.map((g) => g.key);
  assert.deepEqual(classes, ['1', '2', '3', '4', '5', '6']);
  assert.equal(res.groups.find((g) => g.key === '5').labels.de, 'Personalaufwand');
});

// --- The reconciliation flags, observed RED ------------------------------------------------------
//
// Every A08 assertion used to be `assert.equal(res.reconciles, true)`, and all four flags survived
// being replaced by the literal `true`. Not one test had ever seen one as `false`, so the whole
// reconciliation apparatus was unexercised: a green flag proved that the code said green.
//
// These drive them red through the state they were WRITTEN for, a corrupt database
// (`importUnbalancedEntry` explains how that is reachable), and they are the reason
// `assert.equal(reconciles, true)` elsewhere in this file now means something.

test('an unbalanced posted entry turns THREE flags red, and the report says so', () => {
  const t = setup();
  seedBooks(t);
  importUnbalancedEntry(t, { date: '2026-02-20', number: '1000', debit: 123400 });

  const trial = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(trial.reconciliation.debitEqualsCredit, false, 'a 1234.00 debit with no credit must show');
  assert.equal(trial.reconciles, false);

  const bilanz = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(bilanz.reconciliation.aktivenEqualPassiven, false);
  assert.equal(bilanz.reconciliation.ledgerNetsToZero, false);
  assert.equal(bilanz.reconciles, false);
  // And the two sides really are apart by the imported amount, not merely flagged.
  assert.equal(bilanz.aktivenMinor - bilanz.passivenMinor, 123400);

  // The Erfolgsrechnung is untouched, correctly: the corruption is on an ASSET account, and a flag
  // that went red for an unrelated statement would be noise rather than a signal.
  assert.equal(computeIncomeStatement(t.ctx, PERIOD).reconciles, true);
});

test('an account whose type is off the union turns the COVERAGE flag red on its own', () => {
  const t = setup();
  seedBooks(t);
  // A migration or an importer writing a type the product does not know. `account.type` carries no
  // CHECK constraint, so this is a state a restored file can really be in. 3400 stops being income,
  // so it falls off the Erfolgsrechnung and lands on the Bilanz, where the coverage query (which
  // counts only asset/liability/equity) does not know about it.
  t.store.db
    .prepare('UPDATE account SET type = ? WHERE workspace_id = ? AND number = ?')
    .run('revenue', t.workspaceId, '3400');

  const bilanz = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(bilanz.reconciliation.everyAccountClassifiedOnce, false, 'the rendered line is not in the count');
  assert.equal(bilanz.reconciles, false);
  // ISOLATED: the other two flags stay green. That is the point of having three, and it is what
  // proves the coverage check is doing work no total-level check does. Both sides still foot,
  // because the account was rendered on both the line and its subtotal.
  assert.equal(bilanz.reconciliation.aktivenEqualPassiven, true);
  assert.equal(bilanz.reconciliation.ledgerNetsToZero, true);
});

// --- The date fences, at the boundary ------------------------------------------------------------
//
// Four date predicates survived mutation because every fixture kept its movements away from the
// boundary. These put an account's ONLY movement exactly ON it, which is the single date at which
// `>=` and `>` (or `<=` and `<`) disagree.

test('an account whose only movement is ON periodStart is still counted (Saldenbilanz)', () => {
  const t = setup();
  seedBooks(t);
  // Debit and credit on the SAME account, so its cumulative net is zero and only the movement half
  // of `countTrialBalanceAccounts` can see it. Dated exactly periodStart.
  post(t, {
    date: PERIOD.periodStart,
    key: 'wash',
    description: 'Umbuchung am ersten Tag',
    lines: [{ n: '1060', debit: 44400 }, { n: '1060', credit: 44400 }],
  });
  const trial = computeTrialBalance(t.ctx, PERIOD);
  const row = rowFor(trial, '1060');
  assert.ok(row !== undefined, '1060 moved inside the window and must have a row');
  assert.equal(row.debitMinor, 44400);
  assert.equal(row.creditMinor, 44400);
  assert.equal(row.closingMinor, 0);
  // The coverage flag is what a `>` fence breaks: the row is rendered and the count would miss it.
  assert.equal(trial.reconciliation.everyAccountRenderedOnce, true);
  assert.equal(trial.reconciles, true);
});

test('an income account whose only movement is ON periodStart is still counted (Erfolgsrechnung)', () => {
  const t = setup();
  seedBooks(t);
  post(t, {
    date: PERIOD.periodStart,
    key: 'newyear',
    description: 'Umsatz am ersten Tag',
    lines: [{ n: '1020', debit: 33300 }, { n: '3600', credit: 33300 }],
  });
  const income = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(sectionFor(income, 'netto_erloese').lines.find((l) => l.account.number === '3600').amountMinor, 33300);
  assert.equal(income.reconciliation.everyAccountClassifiedOnce, true);
  assert.equal(income.reconciles, true);
});

test('an asset whose only movement is ON the Stichtag is still counted (Bilanz)', () => {
  const t = setup();
  seedBooks(t);
  post(t, {
    date: '2026-03-31',
    key: 'lastday',
    description: 'Kauf am Stichtag',
    lines: [{ n: '1200', debit: 22200 }, { n: '1020', credit: 22200 }],
  });
  const bilanz = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(sectionFor(bilanz, 'umlaufvermoegen').lines.find((l) => l.account.number === '1200').balanceMinor, 22200);
  assert.equal(bilanz.reconciliation.everyAccountClassifiedOnce, true);
  assert.equal(bilanz.reconciles, true);
});

test('an entry that falls BETWEEN the fences turns closingTiesToLedger red', () => {
  const t = setup();
  seedBooks(t);
  // The one flag that is genuinely two derivations: the report builds closing as
  // `opening + debit - credit` from a windowed aggregate plus a carry, and the check reads a single
  // CUMULATIVE aggregate. Its docstring claims "they agree only if both fences are right, so an
  // off-by-one on a period boundary shows", and nothing had ever tested that.
  //
  // Every well-formed date is in exactly one of {opening, movement}, and in cumulative iff it is in
  // one of them, so the two derivations agree by construction on any book `postEntry` wrote. The
  // partition has a GAP, and a malformed date lands in it: '2025-12-31T23:59:59' sorts ABOVE
  // dayBefore(periodStart) = '2025-12-31' and BELOW periodStart = '2026-01-01', so it is in neither
  // window, while `<= periodEnd` still admits it to the cumulative. That is the shape a bad
  // migration or a timestamp-instead-of-date importer really produces, and it is exactly what this
  // flag exists to notice. The entry is BALANCED, so nothing else may go red.
  importRawEntry(t, {
    id: 'rot',
    date: '2025-12-31T23:59:59',
    lines: [{ n: '1020', debit: 70000 }, { n: '1000', credit: 70000 }],
  });

  const trial = computeTrialBalance(t.ctx, PERIOD);
  assert.equal(trial.reconciliation.closingTiesToLedger, false, 'the Saldenbilanz must notice the gap');
  assert.equal(trial.reconciles, false);
  // ISOLATED: the entry balances, so the other two Saldenbilanz flags stay green.
  assert.equal(trial.reconciliation.debitEqualsCredit, true);
  assert.equal(trial.reconciliation.everyAccountRenderedOnce, true);

  // The Kontoblatt makes the same check for one account, by accumulation rather than by carry.
  const sheet = computeGeneralLedger(t.ctx, { accountId: t.acc('1020'), ...PERIOD });
  assert.equal(sheet.reconciliation.closingTiesToLedger, false);
  assert.equal(sheet.reconciles, false);

  // And the two statements that take a single cumulative aggregate are unaffected, correctly: they
  // have no second fence to disagree with.
  assert.equal(computeBalanceSheet(t.ctx, { asOf: '2026-03-31' }).reconciles, true);
  assert.equal(computeIncomeStatement(t.ctx, PERIOD).reconciles, true);
});

test('ledgerNetsToZero reads THROUGH the Stichtag, not up to the day before', () => {
  const t = setup();
  seedBooks(t);
  // The critic judged this predicate unfalsifiable, and on a book `postEntry` wrote it is: a
  // balanced ledger nets to zero at every date, so `<=` and `<` agree everywhere. It becomes
  // falsifiable the moment the ledger does NOT net to zero, which is the only state the flag is
  // for. The corruption is dated exactly the Stichtag, the one date the two fences disagree on.
  importUnbalancedEntry(t, { date: '2026-03-31', number: '1000', debit: 11100 });
  assert.equal(computeBalanceSheet(t.ctx, { asOf: '2026-03-31' }).reconciliation.ledgerNetsToZero, false);
  // The day before, the same books are clean: the flag is reading the date and not a constant.
  assert.equal(computeBalanceSheet(t.ctx, { asOf: '2026-03-30' }).reconciliation.ledgerNetsToZero, true);
});

// --- A03 interaction: the year close ------------------------------------------------------------

/**
 * The books a closed year is tested against: one year, one revenue and one expense, both real.
 *
 * Small on purpose. The defect this guards made the whole statement read zero, so a fixture whose
 * every figure is distinct and non-zero is all it takes, and a small one states the expectation in
 * numbers a reader can hold in their head.
 */
function closableBooks(t) {
  post(t, {
    date: '2026-02-01',
    key: 'fy-rev',
    description: 'Umsatz 2026',
    lines: [{ n: '1020', debit: 500000 }, { n: '3400', credit: 500000 }],
  });
  post(t, {
    date: '2026-03-01',
    key: 'fy-lohn',
    description: 'Löhne 2026',
    lines: [{ n: '5000', debit: 200000 }, { n: '1020', credit: 200000 }],
  });
}

const FY_2026 = { periodStart: '2026-01-01', periodEnd: '2026-12-31' };

test('AFTER a hard close, the closed year still has an Erfolgsrechnung (F2)', () => {
  const t = setup();
  closableBooks(t);

  const before = computeIncomeStatement(t.ctx, FY_2026);
  assert.equal(before.reingewinnMinor, 300000);
  assert.equal(sectionFor(before, 'netto_erloese').subtotalMinor, 500000);
  assert.equal(sectionFor(before, 'personalaufwand').subtotalMinor, -200000);

  // A03's REAL close, through the real period port. `hardCloseYear` posts a `source='close'` entry
  // dated 2026-12-31 that zeroes every P&L account into 2979 and carries 2979 into 2970.
  const closed = hardCloseYear(t.withRealPeriods(), { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.result, 300000);
  assert.ok(closed.closingEntryId !== null, 'the close must actually have posted an entry');

  // THE DEFECT: this statement used to read reingewinn=0, netto_erloese=0, personalaufwand=0,
  // noActivity=true, and reconciles=true, because both flags compared the zeroed report against the
  // zeroed ledger. A closed year is exactly the year that gets filed.
  const after = computeIncomeStatement(t.ctx, FY_2026);
  assert.equal(after.reingewinnMinor, 300000, 'the closed year lost its result');
  assert.equal(sectionFor(after, 'netto_erloese').subtotalMinor, 500000, 'the closed year lost its revenue');
  assert.equal(sectionFor(after, 'personalaufwand').subtotalMinor, -200000, 'the closed year lost its wages');
  assert.equal(after.noActivity, false, 'a year with CHF 5000.00 of revenue is not a year without activity');
  assert.equal(after.reconciles, true);
  // Identical, before and after. The close changes the books, not what the year did.
  assert.deepEqual(after.sections, before.sections);
});

test('the Bilanz DOES see the close: the result moves to 2970 and lit. g falls to zero', () => {
  const t = setup();
  closableBooks(t);

  const before = computeBalanceSheet(t.ctx, { asOf: '2026-12-31' });
  const equityBefore = sectionFor(before, 'eigenkapital');
  assert.equal(equityBefore.lines.find((l) => l.key === 'jahresergebnis').balanceMinor, 300000);
  assert.equal(equityBefore.lines.find((l) => l.account?.number === '2970'), undefined);

  assert.equal(hardCloseYear(t.withRealPeriods(), { year: 2026, idempotencyKey: 'close-2026' }).ok, true);

  // The mirror image of the case above, and the reason the two statements MUST disagree about the
  // closing entry: here it is real movement. 2970 Gewinnvortrag now carries the result as an
  // ordinary account line, so lit. g must fall to zero or the Bilanz would count it twice.
  const after = computeBalanceSheet(t.ctx, { asOf: '2026-12-31' });
  const equityAfter = sectionFor(after, 'eigenkapital');
  assert.equal(equityAfter.lines.find((l) => l.account?.number === '2970').balanceMinor, 300000);
  assert.equal(equityAfter.lines.find((l) => l.key === 'jahresergebnis').balanceMinor, 0);
  assert.equal(equityAfter.lines.find((l) => l.key === 'ergebnisvortrag').balanceMinor, 0);
  // Unmoved: the Bilanz foots at the same figure before and after, which is the point of a close.
  assert.equal(after.aktivenMinor, before.aktivenMinor);
  assert.equal(after.passivenMinor, before.passivenMinor);
  assert.equal(after.reconciles, true);
});

test('the working papers DO show the closing entry, because a bookkeeper checks it', () => {
  const t = setup();
  closableBooks(t);
  assert.equal(hardCloseYear(t.withRealPeriods(), { year: 2026, idempotencyKey: 'close-2026' }).ok, true);

  // The Saldenbilanz is not a filed statement: 3400 must show its 5'000.00 credit AND the 5'000.00
  // debit the close posted against it, closing at zero.
  const trial = computeTrialBalance(t.ctx, FY_2026);
  const revenue = rowFor(trial, '3400');
  assert.equal(revenue.creditMinor, 500000);
  assert.equal(revenue.debitMinor, 500000, 'the Saldenbilanz must show the closing movement');
  assert.equal(revenue.closingMinor, 0);
  assert.equal(trial.reconciles, true);

  // And the Kontoblatt names it, through the `source` column that exists for exactly this.
  const sheet = computeGeneralLedger(t.ctx, { accountId: t.acc('3400'), ...FY_2026 });
  const closeLine = sheet.lines.find((l) => l.source === 'close');
  assert.ok(closeLine !== undefined, 'the Kontoblatt must carry the closing line');
  assert.equal(closeLine.debitMinor, 500000);
  assert.equal(sheet.closingMinor, 0);
});
