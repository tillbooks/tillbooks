// CRITIC PROBE (non-author, claude/bank-compose-entry). An independent sweep: the engine request is built
// here from first principles off the STORED row (credit_debit, lineBookingDate), never through the Studio's
// `bankComposeRequest`. The Studio's request (built from the list_bank_inbox wire line) is then checked to
// equal it, and `compose_entry`'s lines are checked to equal the rows `book_bank_line` stores. Synthetic data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { composeEntry } from '../../dist/core/ledger/compose.js';
import { bookBankLine, createBankAccount, listBankInbox } from '../../dist/core/banking/index.js';
import { lineBookingDate } from '../../dist/core/banking/bankLines.js';
import { setup } from '../vat/support.mjs';
import { importLines, MAIN_IBAN } from './bank-inbox-support.mjs';

const studio = (rel) => pathToFileURL(fileURLToPath(new URL(`../../app/src/surfaces/Bank/${rel}`, import.meta.url))).href;
const { bankComposeRequest } = await import(studio('bankCompose.ts'));
const { bookTargetOf } = await import(studio('model.ts'));

const PER_METHOD = Number(process.env.CRITIC_SWEEP ?? 400);

function world(method) {
  const w = setup({ method });
  const accounts = w.store.db.prepare('SELECT id, number FROM account WHERE workspace_id = ?').all(w.workspaceId);
  const acc = (n) => accounts.find((x) => x.number === n).id;
  const bank = createBankAccount(w.ctx, { name: 'Konto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: acc('1020'), idempotencyKey: 'critic-bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  return { ...w, acc, bankLedger: acc('1020'), bankAccountId: bank.bankAccountId };
}

/** First principles: what book_bank_line reads off the row, stated as compose_entry lines. */
function myRequest(row, legs, bankLedger) {
  const date = lineBookingDate(row);
  const moneyIn = row.credit_debit === 'CRDT';
  let bank = 0;
  const out = [];
  for (const leg of legs) {
    if (leg.amountMinor === 0) continue;
    const legIn = leg.amountMinor > 0 ? moneyIn : !moneyIn;
    const amount = Math.abs(leg.amountMinor);
    bank += legIn ? amount : -amount;
    const l = { account: leg.accountId, side: legIn ? 'credit' : 'debit', amount, gross: true };
    if (leg.taxCode !== '') Object.assign(l, { taxCode: leg.taxCode, supplyDate: date });
    out.push(l);
  }
  const bankLine = bank > 0 ? [{ account: bankLedger, debit: bank }] : bank < 0 ? [{ account: bankLedger, credit: -bank }] : [];
  return { date, lines: [...bankLine, ...out] };
}

function stored(w, entryId) {
  return w.store.db
    .prepare(
      `SELECT l.account_id, l.debit_minor, l.credit_minor, l.cost_center_id, l.tax_code, l.tax_base_minor, l.tax_amount_minor, l.supply_date
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ? AND l.entry_id = ? ORDER BY l.rowid`,
    )
    .all(w.workspaceId, entryId)
    .map((r) => {
      const o = { account: r.account_id };
      if (r.debit_minor > 0) o.debit = r.debit_minor;
      if (r.credit_minor > 0) o.credit = r.credit_minor;
      if (r.cost_center_id !== null) o.costCenter = r.cost_center_id;
      if (r.tax_code !== null) {
        o.taxCode = r.tax_code;
        if (r.tax_base_minor !== null) o.taxBase = 0 + r.tax_base_minor;
        if (r.tax_amount_minor !== null) o.taxAmount = 0 + r.tax_amount_minor;
        if (r.supply_date !== null) o.supplyDate = r.supply_date;
      }
      return o;
    });
}

function rng(seed) {
  let s = seed >>> 0;
  const rnd = (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
  return { rnd, pick: (xs) => xs[rnd(xs.length)] };
}

const CODES = ['VST-M', 'VST-I', 'UST81', 'UST26', 'UST38', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN', ''];
const ACCOUNTS = ['6500', '6570', '6800', '6900', '3000', '3200', '3400', '4200', '1520', '1500', '1000', '2000', '1100'];
const EDGES = [1, 2, 3, 5, 6, 7, 12, 13, 19, 50, 62, 93, 99, 100, 101, 107, 108, 125, 1081, 1077, 10770, 10810, 123457, 9999995, 99999999];
// The 2024 rate change: both sides of the boundary, a straddle (booking in 2024, value in 2023) and the reverse.
const DATES = [
  { date: '2023-12-31' },
  { date: '2024-01-01' },
  { date: '2024-01-02', valueDate: '2023-12-29' },
  { date: '2023-12-29', valueDate: '2024-01-03' },
  { date: '2022-06-15' },
  { date: '2026-07-20' },
  // booking date dropped after import: both sides fall back to the value date
  { date: '2024-01-05', valueDate: '2023-12-30', dropBooking: true },
  { date: '2023-12-28', valueDate: '2024-01-02', dropBooking: true },
];

function randomCase({ rnd, pick }) {
  const count = 1 + rnd(5);
  const legs = [];
  for (let i = 0; i < count; i += 1) {
    const mag = rnd(3) === 0 ? pick(EDGES) : 1 + rnd(2_000_000);
    const sign = i > 0 && rnd(3) === 0 ? -1 : 1;
    legs.push({ acc: pick(ACCOUNTS), amountMinor: sign * mag, taxCode: pick(CODES) });
  }
  let sum = legs.reduce((s, l) => s + l.amountMinor, 0);
  if (sum <= 0) {
    for (const l of legs) l.amountMinor = Math.abs(l.amountMinor);
    sum = legs.reduce((s, l) => s + l.amountMinor, 0);
  }
  return { lineMinor: rnd(2) === 0 ? sum : -sum, legs, ...pick(DATES) };
}

function run(w, cases, label) {
  const entries = cases.map((c, i) => ({ ref: `${label}-${i}`, amountMinor: Math.abs(c.lineMinor), cd: c.lineMinor > 0 ? 'CRDT' : 'DBIT', date: c.date, valueDate: c.valueDate, name: 'Muster AG' }));
  const { lines } = importLines(w, { statementId: `st-${label}`, from: '2022-01-01', to: '2026-12-31', entries });
  const out = { booked: 0, refused: 0, reasons: {}, failures: [], studioDiff: [] };
  cases.forEach((c, i) => {
    const id = lines[`${label}-${i}`];
    if (c.dropBooking) w.store.db.prepare('UPDATE bank_txn SET booking_date = NULL WHERE id = ?').run(id);
    const row = w.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(id);
    const legs = c.legs.map((l) => ({ accountId: w.acc(l.acc), amountMinor: l.amountMinor, taxCode: l.taxCode ?? '' }));
    const mine = myRequest(row, legs, w.bankLedger);
    // The Studio's request, from the wire line exactly as list_bank_inbox answers it.
    const wire = listBankInbox(w.ctx, { bankTxnId: id, status: 'all' });
    assert.equal(wire.ok, true, JSON.stringify(wire));
    const line = wire.lines[0];
    const theirs = bankComposeRequest(line, legs, w.bankLedger);
    if (JSON.stringify(theirs) !== JSON.stringify(mine)) out.studioDiff.push(`${label}#${i}: mine ${JSON.stringify(mine)} studio ${JSON.stringify(theirs)}`);
    const answer = composeEntry(w.ctx, { mode: 'expand', date: mine.date, lines: mine.lines });
    const what = `${label}#${i} ${JSON.stringify(c)}`;
    if (!answer.ok) {
      out.failures.push(`${what}: read refused ${JSON.stringify(answer)}`);
      return;
    }
    const res = bookBankLine(w.ctx, { bankTxnId: id, target: bookTargetOf({ kind: 'accounts', legs }), idempotencyKey: `k-${label}-${i}` });
    if (!res.ok) {
      out.refused += 1;
      out.reasons[res.error] = (out.reasons[res.error] ?? 0) + 1;
      if (answer.verdict.ok && c.expectRefusalWithCleanVerdict !== true) out.failures.push(`${what}: book refused ${res.error} ${JSON.stringify(res)} but verdict clean`);
      return;
    }
    out.booked += 1;
    if (!answer.verdict.ok) out.failures.push(`${what}: booked but verdict ${JSON.stringify(answer.verdict)}`);
    const s = JSON.stringify(stored(w, res.entryId));
    const a = JSON.stringify(JSON.parse(JSON.stringify(answer.lines)));
    if (s !== a) out.failures.push(`${what}\n stored   ${s}\n composed ${a}`);
  });
  return out;
}

test('critic sweep: compose_entry(first-principles request) === book_bank_line rows; Studio request === first-principles request', (t) => {
  const g = rng(0xc0ffee);
  let booked = 0;
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    const cases = Array.from({ length: PER_METHOD }, () => randomCase(g));
    const r = run(w, cases, `cs-${method}`);
    t.diagnostic(`${method}: booked ${r.booked} refused ${r.refused} ${JSON.stringify(r.reasons)}`);
    assert.deepEqual(r.studioDiff.slice(0, 5), [], `${method}: ${r.studioDiff.length} Studio request differences`);
    assert.deepEqual(r.failures.slice(0, 5), [], `${method}: ${r.failures.length} mismatches`);
    booked += r.booked;
  }
  assert.ok(booked > PER_METHOD, `booked ${booked}`);
});

test('critic fixed: every code on every era boundary, both directions, both natural and mirrored sides', () => {
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    const cases = [];
    for (const code of CODES)
      for (const d of DATES)
        for (const dir of [1, -1])
          for (const amt of [1, 7, 1081, 10770, 123457]) {
            cases.push({ lineMinor: dir * amt, legs: [{ acc: code.startsWith('UST') || code === 'EXPORT0' ? '3400' : '6500', amountMinor: amt, taxCode: code }], ...d });
            // mirrored: a fee netted out on the same line, the taxed leg running against the line
            cases.push({ lineMinor: dir * amt, legs: [{ acc: '6900', amountMinor: amt + 500 }, { acc: '6500', amountMinor: -500, taxCode: code }], ...d });
          }
    const r = run(w, cases, `fx-${method}`);
    assert.deepEqual(r.studioDiff.slice(0, 3), [], `${method}: ${r.studioDiff.length} Studio request differences`);
    assert.deepEqual(r.failures.slice(0, 3), [], `${method}: ${r.failures.length} mismatches of ${cases.length}; refused ${JSON.stringify(r.reasons)}`);
  }
});

test('critic: a split that does not add up is refused by book_bank_line; the preview answers a CLEAN verdict for it (recorded, not asserted as a defect)', (t) => {
  const w = world('effektiv');
  const cases = [
    { lineMinor: -10000, legs: [{ acc: '6500', amountMinor: 8000, taxCode: 'VST-M' }], date: '2026-07-20', expectRefusalWithCleanVerdict: true },
    { lineMinor: -10000, legs: [{ acc: '6500', amountMinor: 8000, taxCode: 'VST-M' }, { acc: '6900', amountMinor: 0 }], date: '2026-07-20', expectRefusalWithCleanVerdict: true },
  ];
  const r = run(w, cases, 'short');
  t.diagnostic(JSON.stringify(r.reasons));
  assert.deepEqual(r.studioDiff, []);
  assert.equal(r.refused, 2);
});

test('critic FOREIGN CURRENCY: book_bank_line refuses a taxed leg on a EUR line; compose_entry answers composed lines with a CLEAN verdict', (t) => {
  const w = world('effektiv');
  // a second Bankkonto in EUR on its own ledger account (synthetic IBAN, published-sample shape)
  const eurIban = 'CH5604835012345678009';
  const eur = createBankAccount(w.ctx, { name: 'EUR Konto', iban: eurIban, currency: 'EUR', ledgerAccountId: w.acc('1060'), idempotencyKey: 'critic-eur' });
  assert.equal(eur.ok, true, JSON.stringify(eur));
  const { lines } = importLines(
    w,
    { statementId: 'st-eur', iban: eurIban, currency: 'EUR', from: '2026-07-01', to: '2026-07-31', entries: [{ ref: 'eur-0', amountMinor: 8990, cd: 'DBIT', date: '2026-07-20', name: 'Fournisseur SA' }, { ref: 'eur-1', amountMinor: 4200, cd: 'DBIT', date: '2026-07-20', name: 'Fournisseur SA' }] },
    { bankAccountId: eur.bankAccountId },
  );
  const bankLedger = w.store.db.prepare('SELECT ledger_account_id FROM bank_account WHERE id = ?').get(eur.bankAccountId).ledger_account_id;
  // taxed leg
  const id0 = lines['eur-0'];
  const row0 = w.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(id0);
  const legs0 = [{ accountId: w.acc('6500'), amountMinor: 8990, taxCode: 'VST-M' }];
  const wire0 = listBankInbox(w.ctx, { bankTxnId: id0, status: 'all' }).lines[0];
  const req0 = bankComposeRequest(wire0, legs0, bankLedger);
  assert.deepEqual(req0, myRequest(row0, legs0, bankLedger));
  const ans0 = composeEntry(w.ctx, { mode: 'expand', date: req0.date, lines: req0.lines });
  const res0 = bookBankLine(w.ctx, { bankTxnId: id0, target: bookTargetOf({ kind: 'accounts', legs: legs0 }), idempotencyKey: 'k-eur-0' });
  t.diagnostic(`EUR taxed: compose composed=${ans0.composed} verdict=${JSON.stringify(ans0.verdict)} lines=${JSON.stringify(ans0.lines)}; book=${JSON.stringify(res0)}`);
  assert.equal(res0.ok, false);
  assert.equal(res0.reason ?? res0.error, res0.reason === undefined ? 'unsupported' : 'vat_on_foreign_currency_bank_line');
  assert.equal(ans0.verdict.ok, true, 'the preview gives a clean verdict to a booking the engine refuses');
  // untaxed leg on the same EUR account: parity of lines
  const id1 = lines['eur-1'];
  const legs1 = [{ accountId: w.acc('6500'), amountMinor: 4200, taxCode: '' }];
  const wire1 = listBankInbox(w.ctx, { bankTxnId: id1, status: 'all' }).lines[0];
  const req1 = bankComposeRequest(wire1, legs1, bankLedger);
  const ans1 = composeEntry(w.ctx, { mode: 'expand', date: req1.date, lines: req1.lines });
  const res1 = bookBankLine(w.ctx, { bankTxnId: id1, target: bookTargetOf({ kind: 'accounts', legs: legs1 }), idempotencyKey: 'k-eur-1' });
  t.diagnostic(`EUR untaxed: book=${JSON.stringify(res1).slice(0, 200)}`);
  if (res1.ok) assert.equal(JSON.stringify(stored(w, res1.entryId)), JSON.stringify(ans1.lines));
});

test('critic: a zero-amount line (0.00 CRDT) with legs that cancel', (t) => {
  const w = world('effektiv');
  let r;
  try {
    r = run(w, [{ lineMinor: 0, legs: [{ acc: '6900', amountMinor: 500 }, { acc: '6500', amountMinor: -500, taxCode: 'VST-M' }], date: '2026-07-20' }], 'zero');
  } catch (e) {
    r = { importRefused: String(e.message).slice(0, 300) };
  }
  t.diagnostic(JSON.stringify(r));
});
