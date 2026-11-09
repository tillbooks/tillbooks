/**
 * F11, the Bewilligungsverlauf: what the ESTV approved, from when, and which method governed it.
 *
 * These are the three defects that killed the previous attempt at this capability, written as tests
 * BEFORE the design that answers them, because each one was a silent wrong figure rather than a
 * crash and none of them was reachable from the file the change touched.
 *
 *  1. The approval table became a HISTORY table and two consumers kept counting its ROWS as if it
 *     held current state. A workspace that has held exactly ONE Saldosteuersatz its whole life,
 *     across three recorded approvals, computed a correct return and was then refused on export.
 *  2. `vat_method` was not versioned. After a lawful MWSTG Art. 37 Abs. 4 method switch every
 *     earlier Saldo period silently recomputed under effektiv, and the rate history that was
 *     carefully preserved became unreachable, because the method branch is taken before any rate is
 *     read.
 *  3. The mapping key was sound only by convention, enforced nowhere below the application layer.
 *
 * MWSTG Art. 37 Abs. 4, fetched from Fedlex SR 641.20 (ELI `cc/2009/615`, Stand 1. Januar 2025), the
 * document title checked first (`641.20 / Bundesgesetz über die Mehrwertsteuer / (MWSTG)`):
 *
 *   "Die Abrechnung nach der Saldosteuersatzmethode ist bei der ESTV zu beantragen und muss während
 *    mindestens einer Steuerperiode beibehalten werden. Entscheidet sich die steuerpflichtige Person
 *    für die effektive Abrechnungsmethode, so kann sie frühestens nach drei Jahren zur
 *    Saldosteuersatzmethode wechseln. Wechsel sind jeweils auf Beginn einer Steuerperiode möglich."
 *
 * So a method change is lawful, it happens at the start of a Steuerperiode (the calendar year,
 * MWSTG Art. 34 Abs. 2), and the periods before it keep the method they were filed under. A return
 * that recomputes them under the new method is not an approximation: it is a different tax regime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { buildVatLines } from '../../dist/core/vat/index.js';
import {
  computeVatReturn,
  configureVat,
  listSaldoGenerations,
  resolveTax,
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

function sale(ctx, { net, date = '2026-03-15' }) {
  key += 1;
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, '3200'),
    amountMinor: net,
    amountIsGross: false,
    taxCode: 'UST81',
    direction: 'output',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: `f11g-${key}`, lines });
  assert.equal(r.ok, true, `sale post failed: ${JSON.stringify(r)}`);
  return r;
}

function ziff(ret, code) {
  return ret.lines.find((l) => l.code === code);
}

/**
 * ONE approved Saldosteuersatz, 6.2%, one Ertragskonto, one supply.
 *
 *   net CHF 1'000.00, Leistungsdatum 15.03.2026, Normalsatz 8.1%
 *   tax 1'000.00 * 8.1% = 81.00, gross 1'081.00 = 108'100 Rappen
 *   Saldo: 108'100 * 620 / 10'000 = 6'702.2  ->  6'702 Rappen = CHF 67.02   (Ziffer 323)
 */
function oneRate() {
  const s = setup({ method: 'saldo', saldoRates: [{ rateBp: 620 }], asOf: '2026-01-01' });
  const ctx = enforcingCtx(s);
  sale(ctx, { net: 100000 });
  return { ...s, ctx };
}

/** Re-record the SAME single approved rate as a new grant, the way an ESTV Neuzuteilung reads. */
function regrant(ctx, validFrom, n) {
  const r = configureVat(ctx, {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: validFrom,
    saldoRates: [{ rateBp: 620 }],
    saldoGrant: { validFrom },
    idempotencyKey: `f11g-cfg-${n}`,
  });
  assert.equal(r.ok, true, `regrant failed: ${JSON.stringify(r)}`);
}

test('F11: three approvals of ONE rate leave the return, the Ziffer and the export untouched', () => {
  const { ctx } = oneRate();

  const before = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(before.ok, true, JSON.stringify(before));
  assert.equal(ziff(before, '323').taxMinor, 6702, '108100 * 620 / 10000 = 6702.2');

  regrant(ctx, '2026-07-01', 2);
  regrant(ctx, '2027-01-01', 3);

  const gens = listSaldoGenerations(ctx);
  assert.equal(gens.generations.length, 3, 'three recorded approvals');

  const after = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.deepEqual(after.lines, before.lines, 'the return is byte-identical across later approvals');

  // The workspace has held exactly ONE Saldosteuersatz in every period of its life. Counting ROWS
  // instead of the rates governing the period refused this export with `configuredRates: 3`.
  const r = resolveTax(ctx, { taxCode: 'UST81', supplyDate: '2026-03-15' });
  assert.equal(r.ok, true);
  assert.equal(r.formLine, '323', 'the Ziffer comes from the generation governing the supply date');
});

test('F11: a period that two approvals govern refuses rather than picking one', () => {
  const { ctx } = oneRate();
  regrant(ctx, '2026-04-01', 2);

  const straddle = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(straddle.ok, false);
  assert.equal(straddle.error, 'saldo_rates_changed_within_period');
});

test('F11: a Saldo period keeps its method after a lawful Art. 37 Abs. 4 switch to effektiv', () => {
  const { ctx } = oneRate();
  const saldoReturn = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ziff(saldoReturn, '323').taxMinor, 6702);

  // "Wechsel sind jeweils auf Beginn einer Steuerperiode möglich": from 01.01.2027.
  const switched = configureVat(ctx, {
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    asOf: '2027-01-01',
    methodChange: { validFrom: '2027-01-01' },
    idempotencyKey: 'f11g-switch',
  });
  assert.equal(switched.ok, true, JSON.stringify(switched));

  const again = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.method, 'saldo', 'the method that GOVERNED the period, not the current one');
  assert.equal(ziff(again, '323').taxMinor, 6702, 'CHF 67.02 under Saldo, not CHF 81.00 under effektiv');
  assert.equal(ziff(again, '303'), undefined, 'no effektiv per-rate Ziffer appears in a Saldo period');

  // And the new method governs its own periods: CHF 1'000.00 at 8.1% is 8'100 on Ziffer 303.
  sale(ctx, { net: 100000, date: '2027-02-10' });
  const effektiv = computeVatReturn(ctx, { periodStart: '2027-01-01', periodEnd: '2027-03-31' });
  assert.equal(effektiv.ok, true, JSON.stringify(effektiv));
  assert.equal(effektiv.method, 'effektiv');
  assert.equal(ziff(effektiv, '303').taxMinor, 8100);
});

test('F11: a period straddling the method change refuses and names both methods', () => {
  const { ctx } = oneRate();
  configureVat(ctx, {
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    asOf: '2027-01-01',
    methodChange: { validFrom: '2027-01-01' },
    idempotencyKey: 'f11g-switch2',
  });

  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2027-06-30' });
  assert.equal(ret.ok, false);
  assert.equal(ret.error, 'period_straddles_method_change');
  assert.deepEqual(
    ret.methods.map((m) => m.method),
    ['saldo', 'effektiv'],
  );
});

test('F11: a material change to a generation that already governs posted turnover must name its branch', () => {
  const { ctx } = oneRate();

  // No branch stated, and the open generation already governs a posted supply. Rewriting it in
  // place would move a figure the books already hold; appending would rewrite nothing. Neither is
  // safe to guess, so the engine refuses and names both.
  const guessed = configureVat(ctx, {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    saldoRates: [{ rateBp: 530 }],
    idempotencyKey: 'f11g-guess',
  });
  assert.equal(guessed.ok, false, JSON.stringify(guessed));
  assert.equal(guessed.error, 'saldo_generation_change_unstated');

  // The correction branch: the open generation was recorded wrongly and is rewritten in place.
  const corrected = configureVat(ctx, {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    saldoRates: [{ rateBp: 530 }],
    saldoCorrection: true,
    idempotencyKey: 'f11g-correct',
  });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  const gens = listSaldoGenerations(ctx);
  assert.equal(gens.generations.length, 1, 'a correction does not append a generation');

  // 108'100 * 530 / 10'000 = 5'729.3 -> 5'729.
  const ret = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ziff(ret, '323').taxMinor, 5729);
});

test('F11: the same Saldosteuersatz cannot be recorded twice in one approval, and the schema says so', () => {
  const { ctx, store, workspaceId } = oneRate();

  const dup = configureVat(ctx, {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    saldoRates: [{ rateBp: 620 }, { rateBp: 620 }],
    saldoCorrection: true,
    idempotencyKey: 'f11g-dup',
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'invalid_saldo_rate');

  // The application-layer refusal above is not the only guard. A duplicate rate inside ONE approval
  // silently merged two Tätigkeiten in the previous design, and the argument that it could not
  // happen lived in a comment three files away. It is now a schema constraint.
  const gen = store.db
    .prepare('SELECT valid_from FROM vat_saldo_generation WHERE workspace_id = ?')
    .get(workspaceId);
  assert.throws(
    () =>
      store.db
        .prepare(
          'INSERT INTO vat_saldo_generation_rate (workspace_id, valid_from, position, rate_bp, form_line) VALUES (?, ?, ?, ?, ?)',
        )
        .run(workspaceId, gen.valid_from, 2, 620, '333'),
    /UNIQUE/,
    'the schema refuses a duplicate rate inside one approval',
  );
});
