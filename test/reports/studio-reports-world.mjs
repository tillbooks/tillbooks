/**
 * The worlds behind the A08 Studio fixtures in `app/src/surfaces/Reports/*.fixture.json`.
 *
 * Shared by the capture script (`capture-studio-reports.mjs`) and by the drift guard
 * (`studio-reports-fixture.test.mjs`), so the fixtures are a RECORDING of these functions and the
 * guard replays exactly the same functions. Two copies of the world would let the recording and the
 * assertion drift apart, which is the whole failure the pairing exists to prevent, and A16's pair
 * (`studio-open-items-world.mjs` + `studio-open-items-fixture.test.mjs`) is the worked example this
 * one follows line for line.
 *
 * WHY A RECORDING AND NOT A LITERAL. Eight hand-written account names in three Studio suites were
 * wrong against the shipped chart while every KIND matched, so a keys-and-kinds comparison passed
 * green over a fixture that disagreed with the product. On A08 that trap is worse than usual,
 * because a financial statement is nothing but a bucketing of the chart: a hand-typed section
 * heading, a hand-typed statutory label or a hand-typed Zwischentotal would let the Studio render a
 * Bilanz that agrees with its own test and with nothing else. So the guard asserts VALUES.
 *
 * SIX WORLDS, because the surface's states cannot occur in one workspace at once:
 *
 *  - `liveStatements()`  the canonical Q1-2026 book from `support.mjs`, which is deliberately
 *    awkward (a DEBIT on an income account, a CREDIT on an expense account, six sections touched, an
 *    opening carry in the prior year, a draft that must never reach a figure). Every one of the four
 *    reports plus the chart the picker reads.
 *  - `liveComparison()`  the same book with `compareTo` on all three period/date statements, which is
 *    the ONLY way to record a `deltaMinor` and the ONLY way to record that section subtotals carry
 *    `compareSubtotalMinor` and NO delta (design finding F4).
 *  - `liveEmpty()`  the seeded chart with nothing posted. The Saldenbilanz comes back with no rows at
 *    all and the Bilanz and Erfolgsrechnung come back with their full structure at zero, which is the
 *    difference the surface's two empty states turn on (R11 against R12).
 *  - `liveLedgerNoMovement()`  a Kontoblatt whose `lines` are empty while its opening and closing are
 *    large. "Empty and NOT nothing" (R13) cannot be recorded from the healthy book, because every
 *    account it touches moved.
 *  - `liveMismatch()`  the corrupt-importer book from `support.mjs`, which is the only way to record a
 *    statement whose reconciliation flags are FALSE. R-S9 would otherwise be rendered against a
 *    payload nobody had ever seen.
 *  - `liveCsvExport()`  one `export_statement` artifact, so the export affordance is tested against the
 *    engine's own filename, mediaType and byteLength rather than against three invented strings.
 *
 * ONE STATE NO WORLD HERE CAN PRODUCE, said out loud rather than faked. `needs_chart` needs a
 * workspace with NO accounts, and `createWorkspace` seeds the KMU chart as part of creating one, so
 * there is no supported route to it from this file. It is an error CODE rather than a payload shape,
 * so the surface test drives it as a canned refusal and nothing about it is recorded here.
 */

import assert from 'node:assert/strict';

import {
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
  exportStatement,
} from '../../dist/core/reports/index.js';
import { listAccounts } from '../../dist/core/accounts/index.js';

import { setup, seedBooks, importUnbalancedEntry, PERIOD, PRIOR } from './support.mjs';

/** The Bilanz Stichtag every capture reads at: the period end, which is what the surface defaults to. */
export const AS_OF = PERIOD.periodEnd;

/** The comparison the preset picker's "Vorperiode" produces over `PERIOD`, stated once. */
export const COMPARE_PERIOD = PRIOR;
/** The Bilanz's comparison date under the same preset: the day before the period start. */
export const COMPARE_AS_OF = '2025-12-31';

/** The Kontoblatt account: 1020 Bankkonto, the busiest account in the fixture book. */
const LEDGER_NUMBER = '1020';
/** The no-movement account: 2400, credited by the opening carry and untouched in Q1. */
const STILL_NUMBER = '2400';

const okOf = (result, what) => {
  assert.equal(result.ok, true, `${what}: ${JSON.stringify(result)}`);
  return result;
};

/** The canonical book, plus the four reports and the chart the account picker reads. */
export function liveStatements() {
  const t = setup();
  seedBooks(t);

  const trial = okOf(computeTrialBalance(t.ctx, PERIOD), 'trial_balance');
  const balance = okOf(computeBalanceSheet(t.ctx, { asOf: AS_OF }), 'balance_sheet');
  const income = okOf(computeIncomeStatement(t.ctx, PERIOD), 'income_statement');
  const ledger = okOf(
    computeGeneralLedger(t.ctx, { accountId: t.acc(LEDGER_NUMBER), ...PERIOD }),
    'general_ledger',
  );
  const accounts = okOf(listAccounts(t.ctx), 'list_accounts');

  // The recording is worthless if the book it came from is the trivial one. These are the four
  // properties the surface branches on, asserted here so a re-capture against a changed seed fails
  // at the capture rather than three suites later.
  assert.equal(trial.reconciles, true, 'the healthy book must reconcile, or R-S9 is the default');
  assert.equal(balance.reconciles, true);
  assert.equal(income.reconciles, true);
  assert.equal(ledger.reconciles, true);
  assert.ok(trial.rows.length > 0, 'a Saldenbilanz with no rows is the EMPTY world, not this one');
  assert.ok(ledger.lines.length > 0, 'a Kontoblatt with no lines is the NO-MOVEMENT world');
  assert.ok(
    income.sections.some((s) => s.subtotalMinor < 0) && income.sections.some((s) => s.subtotalMinor > 0),
    'the Erfolgsrechnung must carry both signs, or the sign convention is untested',
  );

  return { trial, balance, income, ledger, accounts, accountId: t.acc(LEDGER_NUMBER) };
}

/** The same book with the comparison column on all three statements that offer one. */
export function liveComparison() {
  const t = setup();
  seedBooks(t);

  const trial = okOf(computeTrialBalance(t.ctx, { ...PERIOD, compareTo: COMPARE_PERIOD }), 'trial compare');
  const balance = okOf(
    computeBalanceSheet(t.ctx, { asOf: AS_OF, compareTo: { asOf: COMPARE_AS_OF } }),
    'balance compare',
  );
  const income = okOf(
    computeIncomeStatement(t.ctx, { ...PERIOD, compareTo: COMPARE_PERIOD }),
    'income compare',
  );

  // The three facts the Δ column's design rests on, recorded rather than assumed: line-level rows
  // carry a delta, section subtotals carry a compare figure and NO delta (F4), and the trial
  // balance's compare column is a CUMULATIVE closing balance because the engine reads only
  // `compareTo.periodEnd` (F3, which is why the control is a preset picker and not two date fields).
  assert.ok(
    trial.rows.some((r) => typeof r.deltaMinor === 'number'),
    'no row carries a deltaMinor: the Δ column would be recorded against nothing',
  );
  for (const section of balance.sections) {
    assert.equal('compareSubtotalMinor' in section, true, section.key);
    assert.equal('deltaMinor' in section, false, `${section.key} grew a subtotal delta`);
  }
  assert.equal(trial.compareTo.start, COMPARE_PERIOD.periodStart);
  assert.equal(trial.compareTo.end, COMPARE_PERIOD.periodEnd);

  return { trial, balance, income };
}

/**
 * The seeded chart with nothing posted at all.
 *
 * This is the world that separates the surface's two empty states. The Saldenbilanz skips every
 * account that carries nothing, so it comes back with an empty `rows`: there is literally no
 * structure to draw, and the surface shows a panel. The Bilanz and the Erfolgsrechnung emit their
 * sections unconditionally, so they come back as the full statutory document at 0.00, and the
 * surface renders it under a quiet band. Recording both from ONE world is what proves the two
 * behaviours are the engine's and not the Studio's.
 */
export function liveEmpty() {
  const t = setup();

  const trial = okOf(computeTrialBalance(t.ctx, PERIOD), 'empty trial');
  const balance = okOf(computeBalanceSheet(t.ctx, { asOf: AS_OF }), 'empty balance');
  const income = okOf(computeIncomeStatement(t.ctx, PERIOD), 'empty income');

  assert.equal(trial.noActivity, true);
  assert.equal(trial.rows.length, 0, 'the empty Saldenbilanz must have NO rows, or R12 is not this state');
  assert.equal(balance.sections.length, 7, 'the zero Bilanz must still carry all seven sections');
  assert.equal(income.sections.length, 11, 'the zero Erfolgsrechnung must still carry all eleven positions');
  assert.equal(balance.reconciles, true, 'a zero statement reconciles honestly, and still says so');

  return { trial, balance, income };
}

/** A Kontoblatt with a large opening and closing balance and no movement in the window (R13). */
export function liveLedgerNoMovement() {
  const t = setup();
  seedBooks(t);

  const ledger = okOf(
    computeGeneralLedger(t.ctx, { accountId: t.acc(STILL_NUMBER), ...PERIOD }),
    'general_ledger still',
  );
  assert.equal(ledger.lines.length, 0, 'this world exists to record an EMPTY line list');
  assert.notEqual(ledger.openingMinor, 0, 'with a zero opening this would be "nothing", not "no movement"');
  assert.equal(ledger.openingMinor, ledger.closingMinor);
  return ledger;
}

/**
 * The corrupt-importer book: a posted entry whose lines do not balance.
 *
 * `postEntry` refuses an unbalanced entry and the `posted_immutable` triggers refuse to mutate a
 * posted one, so this state is unreachable through any product path. It is reachable exactly the way
 * an importer would reach it (write the entry as a draft, write its lines, flip it to posted), which
 * is what `importUnbalancedEntry` does and what `statements.ts`'s own docblock names as the paths the
 * flags guard. Without it, R-S9 ships rendered against a payload that has never existed.
 */
export function liveMismatch() {
  const t = setup();
  seedBooks(t);
  importUnbalancedEntry(t, { id: 'bad_import', date: '2026-02-14', number: '1000', debit: 123400 });

  const trial = okOf(computeTrialBalance(t.ctx, PERIOD), 'mismatch trial');
  const balance = okOf(computeBalanceSheet(t.ctx, { asOf: AS_OF }), 'mismatch balance');

  assert.equal(trial.reconciles, false, 'the mismatch world must NOT reconcile, or R-S9 never renders');
  assert.equal(trial.reconciliation.debitEqualsCredit, false);
  assert.equal(balance.reconciles, false);
  assert.equal(balance.reconciliation.ledgerNetsToZero, false);
  return { trial, balance };
}

/** One real export artifact, so the export affordance is tested against the engine's own filename. */
export function liveCsvExport() {
  const t = setup();
  seedBooks(t);
  const result = okOf(exportStatement(t.ctx, { kind: 'trial', format: 'csv', ...PERIOD }), 'export_statement');
  assert.equal(result.artifact.filename, 'saldenbilanz-2026-01-01-bis-2026-03-31.csv');
  return { artifact: result.artifact };
}
