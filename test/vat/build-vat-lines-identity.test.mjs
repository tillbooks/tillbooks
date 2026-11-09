// PROOF 1 of the D152 amendment: `buildVatLines`, now assembled from the counter-less `buildVatLineParts`,
// is BYTE-IDENTICAL to the builder it replaced, for every caller.
//
// The oracle is a frozen JavaScript copy of the pre-refactor builder (`./oracle/build-vat-lines.frozen.mjs`).
// The property runs every seeded code kind, both methods (effektiv and saldo, where input and Bezugsteuer
// turn non-deductible), Rappen edge amounts and random ones, gross and net, both directions (including the
// one an import or Bezugsteuer refuses), supply dates (none, the booking era, a pre-2024 straddle, a date
// before the earliest era) and cost centres, and compares the JSON of the result, or the thrown message, of
// the live builder against the oracle. Then each caller's own shape (invoice, dunning, vendor bill, claims,
// bank inbox) is run separately so a failure names the caller it would break. A chart missing 1171 or 2200
// must throw the same message too.
//
// Every workspace, account and figure is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVatLines, buildVatLineParts, vatIntentRules, mirrorVatLine } from '../../dist/core/vat/applyVat.js';
import { frozenBuildVatLines } from './oracle/build-vat-lines.frozen.mjs';
import { setup } from './support.mjs';

const SLOW = process.env.TILL_SLOW_TESTS === '1';
const RANDOM_CASES = SLOW ? 40_000 : 4_000;

const CODES = ['VST-M', 'VST-I', 'UST81', 'UST26', 'UST38', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN', 'none', null, 'NOPE'];
const EDGE_AMOUNTS = [0, 1, 2, 5, 6, 7, 12, 13, 19, 50, 93, 99, 100, 101, 107, 108, 1081, 10_000, 10_770, 10_810, 999_999, 2 ** 31, Number.MAX_SAFE_INTEGER];
const SUPPLY_DATES = [undefined, null, '2026-03-02', '2023-12-20', '2017-06-30'];
const COST_CENTERS = [undefined, 'cc_x'];

/** The live builder and the oracle on one input: the JSON of the lines, or the thrown message. */
function both(ctx, input) {
  const run = (fn) => {
    try {
      return JSON.stringify(fn(ctx, input));
    } catch (e) {
      return `throws ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  return { live: run(buildVatLines), frozen: run(frozenBuildVatLines) };
}

function worlds() {
  const out = [];
  for (const method of ['effektiv', 'saldo']) {
    const w = setup({ method });
    const accounts = w.store.db.prepare('SELECT id, number FROM account WHERE workspace_id = ?').all(w.workspaceId);
    const byNumber = (n) => /** @type {{ id: string }} */ (accounts.find((a) => a.number === n)).id;
    out.push({ method, ctx: w.ctx, byNumber });
  }
  return out;
}

let seed = 4242;
function rnd(n) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
}
const pick = (xs) => xs[rnd(xs.length)];

test('buildVatLines is byte-identical to the frozen pre-refactor builder over every kind, amount, mode, date and cost centre', () => {
  const failures = [];
  let compared = 0;
  for (const w of worlds()) {
    const counter = w.byNumber('1020');
    const own = w.byNumber('6500');
    // The exhaustive edge grid.
    for (const taxCode of CODES)
      for (const amountMinor of EDGE_AMOUNTS)
        for (const amountIsGross of [true, false])
          for (const direction of ['input', 'output'])
            for (const supplyDate of SUPPLY_DATES)
              for (const costCenterId of COST_CENTERS) {
                const input = {
                  counterAccount: counter,
                  revenueOrExpenseAccount: own,
                  amountMinor,
                  amountIsGross,
                  taxCode,
                  direction,
                  ...(supplyDate !== undefined ? { supplyDate } : {}),
                  ...(costCenterId !== undefined ? { costCenterId } : {}),
                };
                const r = both(w.ctx, input);
                compared += 1;
                if (r.live !== r.frozen && failures.length < 10) failures.push(`${w.method} ${JSON.stringify(input)}: ${r.live} != ${r.frozen}`);
              }
    // Random amounts across the whole range.
    for (let i = 0; i < RANDOM_CASES; i += 1) {
      const input = {
        counterAccount: counter,
        revenueOrExpenseAccount: own,
        amountMinor: rnd(2) === 0 ? 1 + rnd(5000) : 1 + rnd(2_000_000_000),
        amountIsGross: rnd(2) === 0,
        taxCode: pick(CODES),
        direction: pick(['input', 'output']),
        ...(rnd(3) === 0 ? {} : { supplyDate: pick(SUPPLY_DATES) }),
        ...(rnd(2) === 0 ? {} : { costCenterId: 'cc_r' }),
      };
      const r = both(w.ctx, input);
      compared += 1;
      if (r.live !== r.frozen && failures.length < 10) failures.push(`${w.method} ${JSON.stringify(input)}: ${r.live} != ${r.frozen}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(compared > 20_000, `compared ${compared}`);
});

test('each caller shape (invoice, dunning, vendor bill, claims, bank inbox) is byte-identical', () => {
  const failures = [];
  const taxed = ['VST-M', 'VST-I', 'UST81', 'UST26', 'UST38', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN'];
  for (const w of worlds()) {
    /** @type {Record<string, (amountMinor: number, taxCode: string) => Record<string, unknown> | null>} */
    const callers = {
      // sales/invoice.ts: the debtor against revenue, net, output, the line's supply date or null.
      invoice: (amountMinor, taxCode) => ({
        counterAccount: w.byNumber('1100'), revenueOrExpenseAccount: w.byNumber('3400'), amountMinor, amountIsGross: false,
        taxCode, direction: 'output', supplyDate: rnd(2) === 0 ? null : '2023-12-20',
      }),
      // dunning/run.ts: the Mahngebühr, gross, output, dated today.
      dunning: (amountMinor, taxCode) => ({
        direction: 'output', counterAccount: w.byNumber('1100'), revenueOrExpenseAccount: w.byNumber('3400'), amountMinor,
        amountIsGross: true, taxCode, supplyDate: '2026-09-30',
      }),
      // purchase/vendorBill.ts: payable against expense, gross or net, input, a supply date or undefined, a cost centre or none.
      vendorBill: (amountMinor, taxCode) => ({
        counterAccount: w.byNumber('2000'), revenueOrExpenseAccount: w.byNumber('6500'), amountMinor, amountIsGross: rnd(2) === 0,
        taxCode, direction: 'input', supplyDate: rnd(2) === 0 ? undefined : '2026-03-02',
        ...(rnd(2) === 0 ? { costCenterId: 'cc_v' } : {}),
      }),
      // hr/claims.ts: the claim payable against the expense, gross, input, the expense date, a cost centre or none.
      claims: (amountMinor, taxCode) => ({
        counterAccount: w.byNumber('2000'), revenueOrExpenseAccount: w.byNumber('6570'), amountMinor, amountIsGross: true,
        taxCode, direction: 'input', supplyDate: '2026-03-02', ...(rnd(2) === 0 ? { costCenterId: 'cc_c' } : {}),
      }),
      // banking/bankBooking.ts: the bank against the leg, gross unless Bezugsteuer, direction by kind.
      bank: (amountMinor, taxCode) => {
        const kind = /** @type {{ kind: string } | undefined} */ (
          w.ctx.store.db.prepare('SELECT kind FROM tax_code WHERE workspace_id = ? AND code = ?').get(w.ctx.workspaceId, taxCode)
        )?.kind;
        if (kind === undefined) return null;
        const rules = vatIntentRules(kind);
        return {
          counterAccount: w.byNumber('1020'), revenueOrExpenseAccount: w.byNumber('6500'), amountMinor,
          amountIsGross: !rules.pricesOnBase, taxCode, direction: rules.direction, supplyDate: '2026-03-02',
        };
      },
    };
    for (const [name, shape] of Object.entries(callers)) {
      for (let i = 0; i < 600; i += 1) {
        const input = shape(rnd(3) === 0 ? pick(EDGE_AMOUNTS) : 1 + rnd(9_000_000), pick(taxed));
        if (input === null) continue;
        const r = both(w.ctx, input);
        if (r.live !== r.frozen && failures.length < 10) failures.push(`${name} ${w.method} ${JSON.stringify(input)}: ${r.live} != ${r.frozen}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a chart missing 1171 or 2200 throws the same message from both builders', () => {
  for (const missing of ['1171', '2200', '1170']) {
    const w = setup({});
    w.store.db.prepare('DELETE FROM account WHERE workspace_id = ? AND number = ?').run(w.workspaceId, missing);
    const id = (n) => /** @type {{ id: string }} */ (w.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(w.workspaceId, n)).id;
    for (const [taxCode, direction] of [['VST-I', 'input'], ['VST-M', 'input'], ['UST81', 'output'], ['BEZUG', 'input'], ['IMPORT', 'input']]) {
      const input = { counterAccount: id('1020'), revenueOrExpenseAccount: id('6500'), amountMinor: 10_770, amountIsGross: true, taxCode, direction };
      const r = both(w.ctx, input);
      assert.equal(r.live, r.frozen, `${missing} ${taxCode}`);
    }
  }
});

test('the parts reassemble the builder: own + counter at counterAt, the own set never names the counter', () => {
  const [w] = worlds();
  assert.ok(w);
  for (const taxCode of ['VST-M', 'VST-I', 'UST81', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN']) {
    const kind = /** @type {{ kind: string }} */ (w.ctx.store.db.prepare('SELECT kind FROM tax_code WHERE workspace_id = ? AND code = ?').get(w.ctx.workspaceId, taxCode)).kind;
    const rules = vatIntentRules(kind);
    const input = { revenueOrExpenseAccount: w.byNumber('6500'), amountMinor: 10_770, amountIsGross: !rules.pricesOnBase, taxCode, direction: rules.direction };
    const parts = buildVatLineParts(w.ctx, input);
    const whole = buildVatLines(w.ctx, { ...input, counterAccount: w.byNumber('1020') });
    assert.equal(whole.length, parts.own.length + 1);
    assert.deepEqual(whole[parts.counterAt], { account: w.byNumber('1020'), [parts.counter.side]: parts.counter.amountMinor });
    assert.ok(!parts.own.some((l) => l.account === w.byNumber('1020')));
    // Balanced: own + counter nets to zero.
    const net = parts.own.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
    assert.equal(net, parts.counter.side === 'credit' ? parts.counter.amountMinor : -parts.counter.amountMinor);
  }
});

test('the bank inbox mirror is the shared mirrorVatLine: debit and credit swap, every other field and the key order stay', () => {
  const line = { account: 'a', debit: 5, costCenter: 'c', taxCode: 'VST-M', taxBase: 4, taxAmount: 1, supplyDate: '2026-03-02' };
  assert.equal(JSON.stringify(mirrorVatLine(line)), JSON.stringify({ account: 'a', costCenter: 'c', taxCode: 'VST-M', taxBase: 4, taxAmount: 1, supplyDate: '2026-03-02', credit: 5 }));
  assert.deepEqual(mirrorVatLine({ account: 'b', credit: 3 }), { account: 'b', debit: 3 });
  assert.deepEqual(vatIntentRules('output'), { direction: 'output', naturalSide: 'credit', pricesOnBase: false });
  assert.deepEqual(vatIntentRules('reverse_charge'), { direction: 'input', naturalSide: 'debit', pricesOnBase: true });
  assert.deepEqual(vatIntentRules('import'), { direction: 'input', naturalSide: 'debit', pricesOnBase: false });
  for (const k of ['zero', 'exempt']) assert.equal(vatIntentRules(k).direction, 'output');
});
