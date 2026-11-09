// CRITIC PROBE (non-author), round 1, ADOPTED as a regression suite. Its full sweep (every gross Rappen,
// CRITIC_STEP=1) takes about four minutes, so the default suite walks every 25th amount and the full sweep
// runs under TILL_SLOW_TESTS=1 (or any explicit CRITIC_STEP).
//
// Brute force over the A1 composer request, composed by `compose_entry` (D152 amendment), against an INDEPENDENT statement of the Swiss booking
// (own integer arithmetic, not computeLineTax and not buildVatLines): every gross 0.01..50.00 plus random
// large amounts, every seeded code kind, both rate eras, effektiv and saldo, the natural and the unnatural
// side. Each payload is posted through the real postEntry and the STORED rows are compared per account.
//
// Every workspace and figure here is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry } from '../../dist/core/ledger/index.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { setup } from './support.mjs';

const COMPOSER = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerPayload.ts', import.meta.url))).href;
// D152 amendment: the Studio sends intent (`composeSatz` + `composeLines`) and the ENGINE composes the lines
// (`compose_entry`), so the brute force drives exactly that path: what the drawer sends, what the engine answers.
const { composeSatz, composeLines } = await import(COMPOSER);

const ERA = {
  '2023-06-30': { normal: 770, reduced: 250, accommodation: 370 },
  '2026-03-02': { normal: 810, reduced: 260, accommodation: 380 },
};
const CODE_RATE = { 'VST-M': 'normal', 'VST-I': 'normal', UST81: 'normal', UST26: 'reduced', UST38: 'accommodation', BEZUG: 'normal' };

function rhafz(numer, denom) {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

function accountsOf(ctx) {
  return ctx.store.db
    .prepare('SELECT id, number, type, vat_code_default, cost_center_allowed FROM account WHERE workspace_id = ?')
    .all(ctx.workspaceId)
    .map((r) => ({ id: r.id, number: r.number, type: r.type, vatCodeDefault: r.vat_code_default, costCenterAllowed: r.cost_center_allowed === 1 }));
}

function world(method) {
  const w = setup({ method });
  w.store.db.prepare("UPDATE account SET vat_code_default = 'VST-I' WHERE workspace_id = ? AND number = '1500'").run(w.workspaceId);
  const accounts = accountsOf(w.ctx);
  const byNumber = (n) => accounts.find((x) => x.number === n);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const numberOf = (id) => byId.get(id).number;
  return { ...w, accounts, byNumber, numberOf, accountOf: (id) => byId.get(id) };
}

/**
 * The correct Swiss booking, per account number: net movement (debit - credit), plus the expected trace on
 * the base line. Natural side only; the unnatural side is the exact negation.
 */
function expected({ method, date, code, gross, expense, counter, natural }) {
  const m = new Map();
  const add = (n, v) => m.set(n, (m.get(n) ?? 0) + v);
  const r = CODE_RATE[code] !== undefined ? ERA[date][CODE_RATE[code]] : 0;
  let trace;
  const saldo = method === 'saldo';
  if (code === 'VST-M' || code === 'VST-I') {
    const tax = rhafz(gross * r, 10000 + r);
    if (saldo) {
      add(expense, gross);
      trace = { base: gross - tax, tax, on: expense };
    } else {
      add(expense, gross - tax);
      if (tax !== 0) add(code === 'VST-I' ? '1171' : '1170', tax);
      trace = { base: gross - tax, tax, on: expense };
    }
    add(counter, -gross);
  } else if (code === 'UST81' || code === 'UST26' || code === 'UST38') {
    const tax = rhafz(gross * r, 10000 + r);
    add(counter, gross);
    add(expense, -(gross - tax));
    if (tax !== 0) add('2200', -tax);
    trace = { base: gross - tax, tax, on: expense };
  } else if (code === 'EXPORT0' || code === 'AUSGENOMMEN') {
    add(counter, gross);
    add(expense, -gross);
    trace = { base: gross, tax: 0, on: expense };
  } else if (code === 'BEZUG') {
    const tax = rhafz(gross * r, 10000);
    add(expense, gross);
    add(counter, -gross);
    add('2200', -tax);
    if (saldo) add(expense, tax);
    else add('1170', tax);
    trace = { base: gross, tax, on: expense };
  } else if (code === 'IMPORT') {
    if (saldo) {
      add(expense, gross);
      trace = { base: 0, tax: gross, on: expense };
    } else {
      add('1170', gross);
      trace = { base: 0, tax: gross, on: '1170' };
    }
    add(counter, -gross);
  } else throw new Error(code);
  for (const [k, v] of m) if (v === 0) m.delete(k);
  if (!natural) {
    for (const [k, v] of m) m.set(k, -v);
    trace = { ...trace, base: -trace.base, tax: -trace.tax };
  }
  return { movements: m, trace };
}

function storedMovements(w, entryId) {
  const rows = w.store.db
    .prepare('SELECT account_id, debit_minor, credit_minor, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ?')
    .all(entryId);
  const m = new Map();
  for (const r of rows) {
    const n = w.numberOf(r.account_id);
    m.set(n, (m.get(n) ?? 0) + r.debit_minor - r.credit_minor);
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  const traced = rows.filter((r) => r.tax_code !== null);
  return { movements: m, traced };
}

// Cases: [code, soll, haben, base(expense/revenue) account, counter, natural]
const CASES = [
  ['VST-M', '6500', '1020', '6500', '1020', true],
  ['VST-M', '1020', '6500', '6500', '1020', false],
  ['VST-I', '1500', '1020', '1500', '1020', true],
  ['VST-I', '6500', '2000', '6500', '2000', true],
  ['VST-I', '1020', '1500', '1500', '1020', false],
  ['UST81', '1100', '3400', '3400', '1100', true],
  ['UST81', '3400', '1100', '3400', '1100', false],
  ['UST26', '1100', '3200', '3200', '1100', true],
  ['UST38', '1100', '3400', '3400', '1100', true],
  ['UST38', '3400', '1100', '3400', '1100', false],
  ['EXPORT0', '1100', '3400', '3400', '1100', true],
  ['AUSGENOMMEN', '1100', '3400', '3400', '1100', true],
  ['AUSGENOMMEN', '3400', '1100', '3400', '1100', false],
  ['BEZUG', '6500', '1020', '6500', '1020', true],
  ['BEZUG', '1020', '6500', '6500', '1020', false],
  ['IMPORT', '6500', '1020', '6500', '1020', true],
  ['IMPORT', '1020', '6500', '6500', '1020', false],
];

function amounts(step) {
  const out = [];
  for (let a = 1; a <= 5000; a += step) out.push(a);
  // Deterministic pseudo-random large amounts (LCG), so a failure reproduces.
  let s = 20261001;
  for (let i = 0; i < 300; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(5001 + (s % 999_999_999));
  }
  out.push(9_999_999_999, 123_456_789_01);
  return out;
}
const STEP = Number(process.env.CRITIC_STEP ?? (process.env.TILL_SLOW_TESTS === '1' ? '1' : '25'));

for (const method of ['effektiv', 'saldo']) {
  for (const date of Object.keys(ERA)) {
   for (const [code, soll, haben, base, counter, natural] of CASES) {
    const AMOUNTS = amounts(date === '2026-03-02' && method === 'effektiv' ? STEP : 7 * STEP);
    test(`critic brute force: ${method} @ ${date}, ${code} ${soll} an ${haben} x ${AMOUNTS.length} amounts posts and books the Swiss booking`, () => {
      const w = world(method);
      const failures = [];
      let seq = 0;
      {
        for (const gross of AMOUNTS) {
          const composed = composeSatz({ soll: w.byNumber(soll).id, haben: w.byNumber(haben).id, amountMinor: gross, taxCode: code, costCenter: '' }, w.accountOf);
          const built = composeEntry(w.ctx, { mode: 'expand', date, lines: composeLines(composed, true, date) });
          if (!built.ok || !built.verdict.ok) {
            failures.push(`${code} ${soll} an ${haben} @${gross}: compose_entry refused ${JSON.stringify(built.ok ? built.verdict : built)}`);
            continue;
          }
          seq += 1;
          const r = postEntry(w.ctx, { date, source: 'manual', idempotencyKey: `bf-${seq}`, lines: built.lines });
          if (!r.ok) {
            failures.push(`${code} ${soll} an ${haben} @${gross}: engine refused ${JSON.stringify(r.error ?? r)}`);
            continue;
          }
          const want = expected({ method, date, code, gross, expense: base, counter, natural });
          const got = storedMovements(w, r.entryId);
          const a = JSON.stringify([...want.movements].sort());
          const b = JSON.stringify([...got.movements].sort());
          if (a !== b) failures.push(`${code} ${soll} an ${haben} @${gross}: movements want ${a} got ${b}`);
          if (got.traced.length !== 1) {
            failures.push(`${code} ${soll} an ${haben} @${gross}: ${got.traced.length} traced lines`);
          } else {
            const t = got.traced[0];
            const tw = want.trace;
            if (t.tax_code !== code || t.tax_base_minor !== tw.base || t.tax_amount_minor !== tw.tax || w.numberOf(t.account_id) !== tw.on || t.supply_date !== date) {
              failures.push(`${code} ${soll} an ${haben} @${gross}: trace want ${JSON.stringify(tw)} got ${JSON.stringify({ ...t, on: w.numberOf(t.account_id) })}`);
            }
          }
          if (failures.length > 25) break;
        }
      }
      try { w.store.close?.(); } catch { w.store.db.close(); }
      assert.deepEqual(failures, []);
    });
   }
  }
}

// Grid property: random Sammelbuchungen (1..4 taxed lines on mixed codes and sides, 1..3 untaxed counters),
// derived. The posted per-account movement must equal the sum of each taxed line's own Swiss booking plus the
// untaxed lines as typed, and the entry must post.
test('critic grid property: random derived Sammelbuchungen post and book the sum of their lines', () => {
  const date = '2026-03-02';
  const w = world('effektiv');
  const pool = [
    ['VST-M', '6500', 'debit', true], ['VST-M', '6500', 'credit', false], ['VST-I', '1500', 'debit', true],
    ['UST81', '3400', 'credit', true], ['UST81', '3400', 'debit', false], ['UST26', '3200', 'credit', true],
    ['BEZUG', '6500', 'debit', true], ['IMPORT', '6500', 'debit', true], ['EXPORT0', '3400', 'credit', true],
  ];
  const counters = ['1020', '1000', '1100', '2000'];
  let s = 4242;
  const rnd = (n) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % n;
  };
  const failures = [];
  for (let iter = 0; iter < 3000 && failures.length < 20; iter += 1) {
    const taxed = [];
    const k = 1 + rnd(4);
    for (let i = 0; i < k; i += 1) {
      const [code, acc, side, natural] = pool[rnd(pool.length)];
      taxed.push({ code, acc, side, natural, gross: 1 + rnd(rnd(2) === 0 ? 5000 : 50_000_000) });
    }
    let signed = 0;
    for (const t of taxed) signed += t.side === 'debit' ? t.gross : -t.gross;
    if (signed === 0) continue;
    // Split the balancing amount over 1..3 counters on the closing side.
    const nc = 1 + rnd(3);
    const total = Math.abs(signed);
    if (total < nc) continue;
    const parts = [];
    let left = total;
    for (let i = 0; i < nc - 1; i += 1) {
      const p = 1 + rnd(left - (nc - 1 - i));
      parts.push(p);
      left -= p;
    }
    parts.push(left);
    const closeSide = signed > 0 ? 'credit' : 'debit';
    const composed = [
      ...taxed.map((t) => ({ accountId: w.byNumber(t.acc).id, side: t.side, amountMinor: t.gross, taxCode: t.code, costCenter: '' })),
      ...parts.map((p, i) => ({ accountId: w.byNumber(counters[i % counters.length]).id, side: closeSide, amountMinor: p, taxCode: '', costCenter: '' })),
    ];
    const built = composeEntry(w.ctx, { mode: 'expand', date, lines: composeLines(composed, true, date) });
    if (!built.ok || !built.verdict.ok) {
      failures.push(`iter ${iter}: compose_entry refused ${JSON.stringify(built.ok ? built.verdict : built)}`);
      continue;
    }
    const r = postEntry(w.ctx, { date, source: 'manual', idempotencyKey: `grid-${iter}`, lines: built.lines });
    if (!r.ok) {
      failures.push(`iter ${iter}: engine refused ${JSON.stringify(r)}`);
      continue;
    }
    const want = new Map();
    const add = (n, v) => want.set(n, (want.get(n) ?? 0) + v);
    for (const t of taxed) {
      // expected() books the line against a counter; take its own legs and drop the counter's movement.
      const e = expected({ method: 'effektiv', date, code: t.code, gross: t.gross, expense: t.acc, counter: '__c', natural: t.natural });
      for (const [n, v] of e.movements) if (n !== '__c') add(n, v);
    }
    parts.forEach((p, i) => add(counters[i % counters.length], closeSide === 'debit' ? p : -p));
    for (const [n, v] of want) if (v === 0) want.delete(n);
    const got = storedMovements(w, r.entryId);
    const a = JSON.stringify([...want].sort());
    const b = JSON.stringify([...got.movements].sort());
    if (a !== b) failures.push(`iter ${iter}: want ${a} got ${b} for ${JSON.stringify(taxed)}`);
    if (got.traced.length !== taxed.length) failures.push(`iter ${iter}: ${got.traced.length} traces for ${taxed.length} taxed lines`);
  }
  assert.deepEqual(failures, []);
});
