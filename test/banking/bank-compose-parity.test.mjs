// THE BANK PREVIEW IS THE BOOKING (A39, D152 amendment follow-up): for an `accounts` decision on a bank line,
// the lines A02's `compose_entry` answers for the Studio's request ARE the rows `book_bank_line` stores.
//
// The bank queue's preview (the strip's "davon MWST ... auf 1170 · netto ..." and the split editor's
// Soll/Haben table) used to be derived in the browser from `vat_preview` figures. It now reads the engine's
// `compose_entry` answer, so VAT is computed in one place for the composer and the bank. This suite holds that
// move to its one claim. Every case runs the REAL engine twice on the same book: first `compose_entry`
// `expand` with the request the Studio builds (`app/src/surfaces/Bank/bankCompose.ts`, imported as it ships,
// Node strips its types), then `book_bank_line` with the target the Studio sends (`bookTargetOf`, same), and
// the stored rows of the posted entry (account, Soll, Haben, cost centre, code, base, tax, Leistungsdatum, in
// row order) must equal the answered lines exactly. A decision `book_bank_line` refuses must not be answered
// with a clean verdict either.
//
// The cases: every `accounts` decision the bank suites book (test/banking/bank-inbox*.test.mjs), then a random
// sweep over both VAT methods (effektiv, and saldo where input VAT and Bezugsteuer fold into the account), the
// codes VST-M, VST-I (Vorsteuer Investitionen to 1171), UST81, UST26, BEZUG, IMPORT, EXPORT0, AUSGENOMMEN and
// none, one to four legs with mixed signs, both money directions, Rappen edge amounts and two rate eras.
// `book_bank_line` takes no cost centre on a leg (A39 §4.3, `BankLineLeg`), so a target that names one books
// none and the request carries none; one case proves the stray key changes nothing.
//
// Run it alone: `npm run build && node --test test/banking/bank-compose-parity.test.mjs`
// (TILL_SLOW_TESTS=1 widens the sweep tenfold). Every workspace, IBAN, name and figure is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { composeEntry } from '../../dist/core/ledger/compose.js';
import { bookBankLine, createBankAccount } from '../../dist/core/banking/index.js';
import { setup } from '../vat/support.mjs';
import { importLines, MAIN_IBAN } from './bank-inbox-support.mjs';

// Computed specifiers, so the root type check does not pull the Studio's TypeScript into its program.
const studio = (rel) => pathToFileURL(fileURLToPath(new URL(`../../app/src/surfaces/Bank/${rel}`, import.meta.url))).href;
const { bankComposeRequest } = await import(studio('bankCompose.ts'));
const { bookTargetOf } = await import(studio('model.ts'));

const SLOW = process.env.TILL_SLOW_TESTS === '1';
const RANDOM_LINES = SLOW ? 4000 : 400;

/** A book with the KMU chart, VAT configured by `method`, and one Bankkonto on 1020. */
function world(method) {
  const w = setup({ method });
  const accounts = w.store.db.prepare('SELECT id, number FROM account WHERE workspace_id = ?').all(w.workspaceId);
  const acc = (n) => {
    const a = accounts.find((x) => x.number === n);
    assert.ok(a, `the seeded chart has no ${n}`);
    return a.id;
  };
  const bank = createBankAccount(w.ctx, { name: 'Geschäftskonto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: acc('1020'), idempotencyKey: 'parity-bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  return { ...w, acc, bankLedger: acc('1020'), bankAccountId: bank.bankAccountId };
}

/** The rows an entry stores, in the `post_entry` line shape, in row order (only what a row holds). */
function storedLines(w, entryId) {
  return w.store.db
    .prepare(
      `SELECT l.account_id, l.debit_minor, l.credit_minor, l.cost_center_id, l.tax_code, l.tax_base_minor, l.tax_amount_minor, l.supply_date
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND l.entry_id = ? ORDER BY l.rowid`,
    )
    .all(w.workspaceId, entryId)
    .map((r) => {
      const out = { account: r.account_id };
      if (r.debit_minor > 0) out.debit = r.debit_minor;
      if (r.credit_minor > 0) out.credit = r.credit_minor;
      if (r.cost_center_id !== null) out.costCenter = r.cost_center_id;
      if (r.tax_code !== null) {
        out.taxCode = r.tax_code;
        if (r.tax_base_minor !== null) out.taxBase = 0 + r.tax_base_minor;
        if (r.tax_amount_minor !== null) out.taxAmount = 0 + r.tax_amount_minor;
        if (r.supply_date !== null) out.supplyDate = r.supply_date;
      }
      return out;
    });
}

/** The answered lines in the same shape (the engine already omits what a row would not hold). */
const comparable = (lines) => lines.map((l) => JSON.parse(JSON.stringify(l)));

/**
 * Import one statement holding every case's line, then for each case: compose the Studio's request, book the
 * Studio's target, and compare. Answers the counts and every mismatch, named.
 */
function runCases(w, cases, label) {
  const entries = cases.map((c, i) => ({ ref: `${label}-${i}`, amountMinor: Math.abs(c.lineMinor), cd: c.lineMinor > 0 ? 'CRDT' : 'DBIT', date: c.date ?? '2026-07-20', ...(c.valueDate !== undefined ? { valueDate: c.valueDate } : {}), name: 'Muster Partner AG' }));
  const { lines } = importLines(w, { statementId: `st-${label}`, from: '2023-01-01', to: '2026-12-31', entries });
  const failures = [];
  let booked = 0;
  let refused = 0;
  /** Why `book_bank_line` refused, by code: the sweep's own coverage report. */
  const reasons = {};
  /** Lines whose stored booking date is not their value date (the dates the preview must not confuse). */
  let datesDiffer = 0;
  cases.forEach((c, i) => {
    const bankTxnId = lines[`${label}-${i}`];
    const row = w.store.db.prepare('SELECT booking_date, value_date FROM bank_txn WHERE id = ?').get(bankTxnId);
    const legs = c.legs.map((l) => ({ accountId: w.acc(l.acc), amountMinor: l.amountMinor, taxCode: l.taxCode ?? '' }));
    const request = bankComposeRequest({ amountMinor: c.lineMinor, bookingDate: row.booking_date, valueDate: row.value_date }, legs, w.bankLedger);
    const what = `${label}#${i} ${JSON.stringify(c)}`;
    if (row.booking_date !== row.value_date) datesDiffer += 1;
    if (request === null) {
      failures.push(`${what}: the Studio built no request`);
      return;
    }
    const answer = composeEntry(w.ctx, { mode: 'expand', date: request.date, lines: request.lines });
    if (!answer.ok) {
      failures.push(`${what}: compose_entry refused the read itself: ${JSON.stringify(answer)}`);
      return;
    }
    const target = bookTargetOf({ kind: 'accounts', legs });
    if (c.strayCostCenter !== undefined) target.legs = target.legs.map((l) => ({ ...l, costCenter: c.strayCostCenter }));
    const res = bookBankLine(w.ctx, { bankTxnId, target, idempotencyKey: `k-${label}-${i}` });
    if (!res.ok) {
      refused += 1;
      reasons[res.error] = (reasons[res.error] ?? 0) + 1;
      if (answer.verdict.ok) failures.push(`${what}: book_bank_line refused (${res.error}) but compose_entry answered a clean verdict`);
      return;
    }
    booked += 1;
    if (!answer.verdict.ok) {
      failures.push(`${what}: book_bank_line booked but compose_entry's verdict is ${JSON.stringify(answer.verdict)}`);
      return;
    }
    const stored = storedLines(w, res.entryId);
    const composed = comparable(answer.lines);
    if (JSON.stringify(stored) !== JSON.stringify(composed)) {
      failures.push(`${what}:\n  stored   ${JSON.stringify(stored)}\n  composed ${JSON.stringify(composed)}`);
    }
  });
  return { booked, refused, reasons, datesDiffer, failures };
}

// --- The bank suites' own decisions ----------------------------------------------------------------------

/** Every `accounts` decision the bank suites book, as a line amount (signed, money in positive) and its legs. */
const SUITE_CASES = [
  { lineMinor: -4200, legs: [{ acc: '6800', amountMinor: 4200 }] },
  { lineMinor: -10810, legs: [{ acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }] },
  { lineMinor: -5400, legs: [{ acc: '6500', amountMinor: 5400, taxCode: 'BEZUG' }] },
  { lineMinor: -15000, legs: [{ acc: '6500', amountMinor: 10000, taxCode: 'VST-M' }, { acc: '6800', amountMinor: 5000 }] },
  { lineMinor: 1234, legs: [{ acc: '3000', amountMinor: 1234 }] },
  { lineMinor: 1081, legs: [{ acc: '6500', amountMinor: 1081, taxCode: 'VST-M' }] },
  { lineMinor: 10810, legs: [{ acc: '3000', amountMinor: 10810, taxCode: 'UST81' }] },
  { lineMinor: -8990, legs: [{ acc: '6500', amountMinor: 8990, taxCode: 'VST-M' }] },
  { lineMinor: -700, legs: [{ acc: '6500', amountMinor: 700, taxCode: 'VST-M' }] },
  { lineMinor: -1081, legs: [{ acc: '6500', amountMinor: 1081, taxCode: 'VST-M' }] },
  { lineMinor: -1200, legs: [{ acc: '6900', amountMinor: 1200 }] },
  { lineMinor: -50000, legs: [{ acc: '1000', amountMinor: 50000 }] },
  { lineMinor: 108100, legs: [{ acc: '3400', amountMinor: 108100 }] },
  { lineMinor: -10810, legs: [{ acc: '6570', amountMinor: 10810, taxCode: 'VST-M' }] },
  { lineMinor: 5000, legs: [{ acc: '1100', amountMinor: 5000 }] },
  { lineMinor: 55000, legs: [{ acc: '3000', amountMinor: 55000 }] },
  // The Studio suites' decisions (Bank.test.tsx, model.test.ts): VST-I on an Anlagekonto, an Einfuhrsteuer,
  // a revenue less a fee (critic F5), an expense plus an untaxed fee.
  { lineMinor: -216200, legs: [{ acc: '1520', amountMinor: 216200, taxCode: 'VST-I' }] },
  { lineMinor: -7700, legs: [{ acc: '4200', amountMinor: 7700, taxCode: 'IMPORT' }] },
  { lineMinor: 10000, legs: [{ acc: '3400', amountMinor: 12000, taxCode: 'UST81' }, { acc: '6900', amountMinor: -2000 }] },
  { lineMinor: -10000, legs: [{ acc: '6500', amountMinor: 8990, taxCode: 'VST-M' }, { acc: '6900', amountMinor: 1010 }] },
  { lineMinor: -3850, legs: [{ acc: '6700', amountMinor: 3850, taxCode: 'VST-M' }] },
  // A target leg that names a cost centre: `book_bank_line` takes none, so the request carries none either.
  { lineMinor: -10810, legs: [{ acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }], strayCostCenter: 'cc_none' },
  // The booking date is not the value date (critic L2). The line books, and its VAT is priced, on the BOOKING
  // date: a value date a few days earlier changes nothing.
  { lineMinor: -10810, legs: [{ acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }], date: '2026-07-22', valueDate: '2026-07-18' },
  { lineMinor: 10810, legs: [{ acc: '3000', amountMinor: 10810, taxCode: 'UST81' }], date: '2026-07-20', valueDate: '2026-07-23' },
  // Period straddles: the value date in the prior month (and year) of the booking date, and the value date in
  // the previous RATE ERA (7.7 % until 31.12.2023) while the booking date is in the 8.1 % one, both ways. The
  // rate follows the booking date in both the preview and the posting.
  { lineMinor: -10810, legs: [{ acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }], date: '2026-08-03', valueDate: '2026-07-31' },
  { lineMinor: -11270, legs: [{ acc: '6500', amountMinor: 10770, taxCode: 'VST-M' }, { acc: '6900', amountMinor: 500 }], date: '2024-01-03', valueDate: '2023-12-29' },
  { lineMinor: 10770, legs: [{ acc: '3000', amountMinor: 10770, taxCode: 'UST81' }], date: '2023-12-29', valueDate: '2024-01-03' },
  { lineMinor: -5400, legs: [{ acc: '6500', amountMinor: 5400, taxCode: 'BEZUG' }], date: '2024-01-02', valueDate: '2023-12-31' },
  // Refused by `book_bank_line` (bank-inbox.test.mjs): a code the book does not know. The preview must not
  // answer a clean verdict for it.
  { lineMinor: -500, legs: [{ acc: '6500', amountMinor: 500, taxCode: 'NOPE' }], refuses: 'unknown_tax_code' },
  { lineMinor: -1734, legs: [{ acc: '6900', amountMinor: 500 }, { acc: '6500', amountMinor: 1234, taxCode: 'NOPE' }], refuses: 'unknown_tax_code' },
];

test('the bank suites\' decisions: compose_entry answers exactly the rows book_bank_line stores (effektiv and saldo)', () => {
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    const r = runCases(w, SUITE_CASES, `suite-${method}`);
    assert.deepEqual(r.failures, [], `${method}: ${r.failures.length} mismatch(es)`);
    const refusing = SUITE_CASES.filter((c) => c.refuses !== undefined);
    assert.equal(r.booked, SUITE_CASES.length - refusing.length, `${method}: every other suite decision books`);
    assert.deepEqual(r.reasons, { unknown_tax_code: refusing.length }, `${method}: the refusals are the expected ones`);
    assert.equal(r.datesDiffer, SUITE_CASES.filter((c) => c.valueDate !== undefined).length, `${method}: every dated case really stores two dates`);
  }
});

// --- The random sweep ------------------------------------------------------------------------------------

function rng(seed) {
  let s = seed;
  // The HIGH bits of the LCG: its low bits cycle with a short period.
  const rnd = (n) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return Math.floor(s / 65536) % n;
  };
  return { rnd, pick: (xs) => xs[rnd(xs.length)] };
}

const CODES = ['VST-M', 'VST-I', 'UST81', 'UST26', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN', '', ''];
/** Erfolgskonten, an Anlagekonto (VST-I to 1171), and two balance-sheet accounts without MWST. */
const ACCOUNTS = ['6500', '6570', '6800', '6900', '3000', '3400', '4200', '1520', '1500', '1000'];
const EDGES = [1, 2, 5, 7, 12, 13, 50, 93, 99, 100, 101, 107, 108, 1081, 10770, 10810, 123457, 9999995];
/** Two rate eras: the 2024 rates, and the pre-2024 ones (7.7 %, 2.5 %). */
const DATES = ['2026-07-20', '2026-03-02', '2023-12-20', '2024-01-02', '2026-08-03'];
/** How far the value date sits from the booking date, in days: the same day half the time, else across a month or an era. */
const VALUE_SHIFTS = [0, 0, 0, -1, -3, 2, -5];

function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function randomCase({ rnd, pick }) {
  const count = 1 + rnd(4);
  const legs = [];
  for (let i = 0; i < count; i += 1) {
    const magnitude = rnd(3) === 0 ? pick(EDGES) : 1 + rnd(500000);
    // Mixed signs: a leg runs against the line now and then (a fee netted out, a refund inside a payment).
    const sign = i > 0 && rnd(4) === 0 ? -1 : 1;
    legs.push({ acc: pick(ACCOUNTS), amountMinor: sign * magnitude, taxCode: pick(CODES) });
  }
  let sum = legs.reduce((s, l) => s + l.amountMinor, 0);
  if (sum <= 0) {
    // The line's amount is the legs' sum and is positive; flip the netted legs until it is.
    for (const l of legs) l.amountMinor = Math.abs(l.amountMinor);
    sum = legs.reduce((s, l) => s + l.amountMinor, 0);
  }
  const moneyIn = rnd(2) === 0;
  const date = pick(DATES);
  const shift = pick(VALUE_SHIFTS);
  return { lineMinor: moneyIn ? sum : -sum, legs, date, ...(shift !== 0 ? { valueDate: shiftDays(date, shift) } : {}) };
}

test(`a random sweep (${RANDOM_LINES} lines per VAT method): every booked decision is exactly its preview, every refused one is refused there too`, (t) => {
  const totals = { booked: 0, refused: 0, reasons: {}, datesDiffer: 0 };
  const generator = rng(52_152);
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    const cases = Array.from({ length: RANDOM_LINES }, () => randomCase(generator));
    const r = runCases(w, cases, `sweep-${method}`);
    assert.deepEqual(r.failures.slice(0, 5), [], `${method}: ${r.failures.length} mismatch(es) of ${cases.length}`);
    totals.booked += r.booked;
    totals.refused += r.refused;
    totals.datesDiffer += r.datesDiffer;
    for (const [code, n] of Object.entries(r.reasons)) totals.reasons[code] = (totals.reasons[code] ?? 0) + n;
  }
  t.diagnostic(`booked ${totals.booked}, refused ${totals.refused} ${JSON.stringify(totals.reasons)}, booking date != value date on ${totals.datesDiffer}`);
  assert.ok(totals.datesDiffer > RANDOM_LINES / 4, `the sweep stores a value date apart from the booking date on ${totals.datesDiffer} lines`);
  // Non-vacuous: the sweep books most of its decisions, and the comparison ran on every one of them.
  assert.ok(totals.booked > RANDOM_LINES, `the sweep booked ${totals.booked} decisions (refused ${totals.refused})`);
});

test('the request states the decision as book_bank_line reads it: legs as intent, the bank leg plain and first, on the booking date', () => {
  const request = bankComposeRequest(
    { amountMinor: 10000, bookingDate: '2026-07-20', valueDate: '2026-07-21' },
    [
      { accountId: 'acc_3400', amountMinor: 12000, taxCode: 'UST81' },
      { accountId: 'acc_6900', amountMinor: -2000, taxCode: '' },
    ],
    'acc_1020',
  );
  assert.deepEqual(request, {
    date: '2026-07-20',
    lines: [
      { account: 'acc_1020', debit: 10000 },
      { account: 'acc_3400', side: 'credit', amount: 12000, gross: true, taxCode: 'UST81', supplyDate: '2026-07-20' },
      { account: 'acc_6900', side: 'debit', amount: 2000, gross: true },
    ],
  });
  // Money out: the leg is a debit, the bank a credit; the value date stands in for a missing booking date.
  assert.deepEqual(bankComposeRequest({ amountMinor: -8990, bookingDate: null, valueDate: '2026-07-21' }, [{ accountId: 'acc_6500', amountMinor: 8990, taxCode: 'VST-M' }], 'acc_1020'), {
    date: '2026-07-21',
    lines: [
      { account: 'acc_1020', credit: 8990 },
      { account: 'acc_6500', side: 'debit', amount: 8990, gross: true, taxCode: 'VST-M', supplyDate: '2026-07-21' },
    ],
  });
  // Nothing to ask: no date, no ledger account, no leg with an account and an amount.
  assert.equal(bankComposeRequest({ amountMinor: -1, bookingDate: null, valueDate: null }, [{ accountId: 'a', amountMinor: 1, taxCode: '' }], 'acc_1020'), null);
  assert.equal(bankComposeRequest({ amountMinor: -1, bookingDate: '2026-07-20', valueDate: null }, [{ accountId: 'a', amountMinor: 1, taxCode: '' }], null), null);
  assert.equal(bankComposeRequest({ amountMinor: -1, bookingDate: '2026-07-20', valueDate: null }, [{ accountId: '', amountMinor: 1, taxCode: '' }], 'acc_1020'), null);
});
