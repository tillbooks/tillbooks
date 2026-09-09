/**
 * The A08 STUDIO fixture-versus-engine drift guard.
 *
 * This closes the mechanism behind a defect family this repo has shipped six times: "the Studio
 * assumed a shape the engine never sends". The cheapest version of it is a fixture more generous
 * than the engine, which agrees with the consumer's bug instead of with the product. On a statement
 * surface it is the most expensive version too: the recorded payloads below carry the statutory
 * section headings, the two computed equity position names and every Zwischentotal the Bilanz prints,
 * so a hand-typed fixture would let the Studio ship a document that agrees with its own test and
 * with no Swiss Bilanz.
 *
 * ## Four halves, and all of them have to hold
 *
 *  1. PRESENT: every recording is the live answer, VALUE for value, through `deepEqual`. Not keys and
 *     kinds. `test/sales/invoice-gui-fixture.test.mjs` is the reason: a keys-and-kinds comparison let
 *     a fixture spelling Zürich in ASCII sit against a seed spelling it with the umlaut and pass 6/6
 *     green, and the same blindness let eight wrong account names ride in three Studio suites.
 *  2. ABSENT: the engine does NOT send the four fields the A08 design was tempted to read. Only the
 *     Kontoblatt carries `entryId`; a KMU class header carries no `openingMinor` (F6); a section
 *     subtotal carries no `deltaMinor` (F4); and no report carries `truncated` or a ceiling of any
 *     kind (F7). A surface reading any of them would render `undefined` under a passing
 *     reconciliation mark, which is the worst possible place for it.
 *  3. LOAD-BEARING: the recordings differ in the ways the surface branches on. An "empty" Saldenbilanz
 *     that still had rows, a "no movement" Kontoblatt whose opening was zero, or a "mismatch"
 *     recording that reconciled would each leave the hardest state on the surface rendered against a
 *     payload that cannot produce it.
 *  4. THE DESIGN'S OWN ENGINE CLAIMS, re-proved here rather than trusted. The A08 UX slice cut the
 *     Gruppierung selector and turned the comparison control into a preset picker on the strength of
 *     two claims about this engine. Both are asserted below against the live code, so the day either
 *     stops being true, the design's reasoning fails loudly instead of the control staying missing
 *     for a reason that has expired.
 *
 * Every scan asserts its own corpus is non-empty, so a broken path or a renamed file cannot make this
 * file pass by finding nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeTrialBalance, SUPPORTED_GROUP_BY } from '../../dist/core/reports/index.js';

import {
  liveStatements,
  liveComparison,
  liveEmpty,
  liveLedgerNoMovement,
  liveMismatch,
  liveCsvExport,
  COMPARE_PERIOD,
} from './studio-reports-world.mjs';
import { setup, seedBooks, PERIOD } from './support.mjs';

const DIR = new URL('../../app/src/surfaces/Reports/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));

const TRIAL = read('trial-balance.fixture.json');
const BALANCE = read('balance-sheet.fixture.json');
const INCOME = read('income-statement.fixture.json');
const LEDGER = read('general-ledger.fixture.json');
const ACCOUNTS = read('list-accounts.fixture.json');

const TRIAL_COMPARE = read('trial-balance.compare.fixture.json');
const BALANCE_COMPARE = read('balance-sheet.compare.fixture.json');
const INCOME_COMPARE = read('income-statement.compare.fixture.json');

const TRIAL_EMPTY = read('trial-balance.empty.fixture.json');
const BALANCE_EMPTY = read('balance-sheet.empty.fixture.json');
const INCOME_EMPTY = read('income-statement.empty.fixture.json');

const LEDGER_STILL = read('general-ledger.no-movement.fixture.json');
const TRIAL_MISMATCH = read('trial-balance.mismatch.fixture.json');
const BALANCE_MISMATCH = read('balance-sheet.mismatch.fixture.json');
const EXPORT_CSV = read('export-statement.csv.fixture.json');

// --- 1. PRESENT ------------------------------------------------------------------------------------

test('the five healthy recordings are the live answers, value for value', () => {
  const live = liveStatements();
  assert.deepEqual(TRIAL, plain(live.trial));
  assert.deepEqual(BALANCE, plain(live.balance));
  assert.deepEqual(INCOME, plain(live.income));
  assert.deepEqual(LEDGER, plain(live.ledger));
  assert.deepEqual(ACCOUNTS, plain(live.accounts));
});

test('the three comparison recordings are the live answers too', () => {
  const live = liveComparison();
  assert.deepEqual(TRIAL_COMPARE, plain(live.trial));
  assert.deepEqual(BALANCE_COMPARE, plain(live.balance));
  assert.deepEqual(INCOME_COMPARE, plain(live.income));
});

test('the empty, no-movement, mismatch and export recordings are the live answers too', () => {
  const empty = liveEmpty();
  assert.deepEqual(TRIAL_EMPTY, plain(empty.trial));
  assert.deepEqual(BALANCE_EMPTY, plain(empty.balance));
  assert.deepEqual(INCOME_EMPTY, plain(empty.income));

  assert.deepEqual(LEDGER_STILL, plain(liveLedgerNoMovement()));

  const mismatch = liveMismatch();
  assert.deepEqual(TRIAL_MISMATCH, plain(mismatch.trial));
  assert.deepEqual(BALANCE_MISMATCH, plain(mismatch.balance));

  assert.deepEqual(EXPORT_CSV, plain(liveCsvExport()));
});

test('a Saldenbilanz row carries exactly the keys the engine emits, and no invented ones', () => {
  assert.ok(TRIAL.rows.length > 0, 'the recording holds no rows at all');
  for (const row of TRIAL.rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['account', 'closingMinor', 'creditMinor', 'debitMinor', 'kmuClass', 'openingMinor'],
      JSON.stringify(row),
    );
    assert.deepEqual(Object.keys(row.account).sort(), ['id', 'name', 'number', 'type']);
  }
});

test('a Kontoblatt line carries exactly the keys the engine emits', () => {
  assert.ok(LEDGER.lines.length > 0, 'the recording holds no lines at all');
  for (const line of LEDGER.lines) {
    assert.deepEqual(
      Object.keys(line).sort(),
      ['creditMinor', 'date', 'debitMinor', 'description', 'entryId', 'ref', 'runningMinor', 'source'],
      JSON.stringify(line),
    );
  }
});

// --- 2. ABSENT -------------------------------------------------------------------------------------

test('ONLY the Kontoblatt carries an entryId, so a Saldenbilanz row drills to an ACCOUNT', () => {
  // The design's §1.4: A08 §4 claims every read model returns entryIds for drill-down and only
  // `general_ledger` does. A Studio that shipped a row-to-entry link on the Saldenbilanz would
  // navigate with `undefined`, which is exactly the shape this guard exists to catch.
  for (const row of TRIAL.rows) assert.equal('entryId' in row, false, row.account.number);
  for (const section of BALANCE.sections) {
    for (const line of section.lines) assert.equal('entryId' in line, false, line.key);
  }
  for (const section of INCOME.sections) {
    for (const line of section.lines) assert.equal('entryId' in line, false, line.key);
  }
  assert.ok(LEDGER.lines.every((line) => typeof line.entryId === 'string' && line.entryId.length > 0));
});

test('a KMU class header carries three figures and NOT an opening one (finding F6)', () => {
  assert.ok(TRIAL.groups.length > 0, 'the recording holds no class groups at all');
  for (const group of TRIAL.groups) {
    assert.deepEqual(
      Object.keys(group).sort(),
      ['accounts', 'closingMinor', 'creditMinor', 'debitMinor', 'key', 'labels'],
      JSON.stringify(group.key),
    );
    assert.equal('openingMinor' in group, false, group.key);
  }
});

test('section subtotals and grand totals carry a compare figure and NO delta (finding F4)', () => {
  for (const section of BALANCE_COMPARE.sections) {
    assert.equal(typeof section.compareSubtotalMinor, 'number', section.key);
    assert.equal('deltaMinor' in section, false, section.key);
    for (const line of section.lines) {
      assert.equal(typeof line.deltaMinor, 'number', `${section.key}/${line.key}`);
    }
  }
  assert.equal(typeof BALANCE_COMPARE.compareAktivenMinor, 'number');
  assert.equal('deltaMinor' in BALANCE_COMPARE, false);
  assert.equal('deltaMinor' in TRIAL_COMPARE.totals, false);
});

test('no report carries a truncated flag or a row ceiling of any kind (finding F7)', () => {
  for (const [name, payload] of [
    ['trial', TRIAL],
    ['balance', BALANCE],
    ['income', INCOME],
    ['ledger', LEDGER],
  ]) {
    assert.equal('truncated' in payload, false, name);
    assert.equal('ceiling' in payload, false, name);
    assert.equal('total' in payload, false, name);
  }
});

test('a CSV artifact declares no PDF/A profile field at all, and the PDF one declares null', () => {
  // `pdfaProfile: null` is the engine's own honesty and the surface must not upgrade it. On a CSV the
  // field is absent entirely, so a surface reading it unconditionally would print "null".
  assert.equal('pdfaProfile' in EXPORT_CSV.artifact, false);
  assert.deepEqual(
    Object.keys(EXPORT_CSV.artifact).sort(),
    ['base64', 'byteLength', 'filename', 'format', 'kind', 'mediaType', 'reconciles'],
  );
});

// --- 3. LOAD-BEARING -------------------------------------------------------------------------------

test('the healthy recordings reconcile and the mismatch ones do not', () => {
  assert.equal(TRIAL.reconciles, true);
  assert.equal(BALANCE.reconciles, true);
  assert.equal(INCOME.reconciles, true);
  assert.equal(LEDGER.reconciles, true);

  assert.equal(TRIAL_MISMATCH.reconciles, false);
  assert.equal(TRIAL_MISMATCH.reconciliation.debitEqualsCredit, false);
  assert.equal(BALANCE_MISMATCH.reconciles, false);
  assert.equal(BALANCE_MISMATCH.reconciliation.ledgerNetsToZero, false);
});

test('the empty Saldenbilanz has NO rows while the empty Bilanz has its whole structure', () => {
  // R12 against R11: the Saldenbilanz shows a panel because there is nothing to draw, and the Bilanz
  // draws the statutory document at 0.00. Both are the ENGINE's behaviour, recorded from one world.
  assert.equal(TRIAL_EMPTY.rows.length, 0);
  assert.equal(TRIAL_EMPTY.groups.length, 0);
  assert.equal(TRIAL_EMPTY.noActivity, true);

  assert.equal(BALANCE_EMPTY.sections.length, 7);
  assert.equal(INCOME_EMPTY.sections.length, 11);
  assert.ok(BALANCE_EMPTY.sections.every((s) => s.subtotalMinor === 0));
  assert.equal(INCOME_EMPTY.reingewinnMinor, 0);
  assert.equal(BALANCE_EMPTY.reconciles, true, 'a zero statement reconciles honestly and still says so');
});

test('the no-movement Kontoblatt is empty and NOT nothing (R13)', () => {
  assert.equal(LEDGER_STILL.lines.length, 0);
  assert.notEqual(LEDGER_STILL.openingMinor, 0);
  assert.equal(LEDGER_STILL.openingMinor, LEDGER_STILL.closingMinor);
  assert.equal(LEDGER_STILL.naturalSide, 'credit', 'this world also covers the credit-side explainer');
  assert.equal(LEDGER.naturalSide, 'debit', 'and the healthy one covers the debit-side explainer');
});

test('the Bilanz carries two computed equity lines with a null account and a statutory name', () => {
  const equity = BALANCE.sections.find((s) => s.key === 'eigenkapital');
  assert.ok(equity !== undefined);
  const computed = equity.lines.filter((line) => line.account === null);
  assert.equal(computed.length, 2, 'the two undrillable equity positions are the whole of R29');
  assert.deepEqual(
    computed.map((line) => line.key),
    ['ergebnisvortrag', 'jahresergebnis'],
  );
  for (const line of computed) {
    assert.equal(typeof line.labels.de, 'string');
    assert.ok(line.labels.de.length > 0, `${line.key} has no German position name to render`);
    // `statutoryWording` is drafting instruction and appears on no Swiss Bilanz, so the engine keeps
    // it out of the payload entirely. If it ever arrives, the surface must still not print it.
    assert.equal('statutoryWording' in line, false, line.key);
  }
});

test('the Total row is structurally zero in both balance columns, which the surface has to explain', () => {
  // `totals.openingMinor` and `totals.closingMinor` accumulate `debit - credit` over EVERY account,
  // so in any book that balances both are exactly zero. A surface that treated a zero there as a
  // rendering failure would hide the one cell where a non-zero figure is a genuine alarm.
  assert.equal(TRIAL.totals.openingMinor, 0);
  assert.equal(TRIAL.totals.closingMinor, 0);
  assert.equal(TRIAL.totals.debitMinor, TRIAL.totals.creditMinor);
  assert.notEqual(TRIAL.totals.debitMinor, 0, 'a zero movement total would make the claim vacuous');
});

test('the Erfolgsrechnung recording carries both signs and eleven positions', () => {
  assert.equal(INCOME.sections.length, 11);
  assert.ok(INCOME.sections.some((s) => s.subtotalMinor > 0));
  assert.ok(INCOME.sections.some((s) => s.subtotalMinor < 0));
  assert.equal(
    INCOME.sections.reduce((sum, s) => sum + s.subtotalMinor, 0),
    INCOME.reingewinnMinor,
    'the visible positions must sum to the stated Reingewinn, which is INV-4 argument 1',
  );
  assert.equal(INCOME.sections.filter((s) => s.nature === 'mixed').length, 5, 'finding F12: five, not three');
});

test('the recorded chart is the one the picker renders, archived rows included by absence', () => {
  assert.ok(ACCOUNTS.accounts.length > 20, 'a chart this short would not exercise the picker search');
  for (const account of ACCOUNTS.accounts) {
    assert.equal(typeof account.number, 'string');
    assert.equal(typeof account.name, 'string');
    assert.equal(typeof account.archived, 'boolean');
  }
});

// --- 4. THE DESIGN'S OWN ENGINE CLAIMS -------------------------------------------------------------

test('groupBy is REFUSED rather than implemented, which is why no Gruppierung selector ships', () => {
  assert.deepEqual([...SUPPORTED_GROUP_BY], ['kmu']);
  const t = setup();
  seedBooks(t);
  const refused = computeTrialBalance(t.ctx, { ...PERIOD, groupBy: 'kostenstelle' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'unsupported_group_by');
  // Sending the ONE accepted value is the same as sending nothing, so the surface sends nothing.
  const withKmu = computeTrialBalance(t.ctx, { ...PERIOD, groupBy: 'kmu' });
  const without = computeTrialBalance(t.ctx, PERIOD);
  assert.deepEqual(plain(withKmu), plain(without));
});

test('computeTrialBalance DISCARDS compareTo.periodStart, which is why the control is a preset', () => {
  // Two comparison windows that differ ONLY in their start date produce byte-identical answers, so a
  // pair of date fields would ask the operator for a value that changes nothing. Proved against the
  // live engine rather than read off the source, because a comment can go stale and this cannot.
  const t = setup();
  seedBooks(t);
  const a = computeTrialBalance(t.ctx, { ...PERIOD, compareTo: COMPARE_PERIOD });
  const b = computeTrialBalance(t.ctx, {
    ...PERIOD,
    compareTo: { periodStart: '2020-01-01', periodEnd: COMPARE_PERIOD.periodEnd },
  });
  assert.deepEqual(plain(a.rows), plain(b.rows));
  assert.deepEqual(plain(a.totals), plain(b.totals));
  // The echoed `compareTo.start` is the ONLY thing that moves, which is what makes the parameter
  // misleading rather than harmless: it is reported back as though it had been used.
  assert.notEqual(a.compareTo.start, b.compareTo.start);
});
