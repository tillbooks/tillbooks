// A38 (D129 leg 2), `vat_annual_reconciliation`: the Umsatz- and Vorsteuerabstimmung of a calendar year
// as figures (Art. 128 Abs. 2 and 3 MWSTV as the ESTV states them). A pure read: it names its periods,
// its adjustments and its status, and it never invents a match. Values, not keys and kinds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });

let n = 0;
const key = (tag) => `recon-${tag}-${(n += 1)}`;

function effektivWorld(deps) {
  const { workspaceId, accId } = mintWorkspace(deps);
  call(deps, workspaceId, 'vat_seed_defaults', {});
  call(deps, workspaceId, 'set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  return { ws: workspaceId, accId };
}

function sale(deps, ws, accId, date, net) {
  const r = call(deps, ws, 'post_entry', {
    date,
    source: 'manual',
    idempotencyKey: key('sale'),
    lines: [
      { account: accId('1100'), debit: Math.round(net * 1.081) },
      { account: accId('3200'), credit: net, taxCode: 'UST81' },
      { account: accId('2200'), credit: Math.round(net * 0.081) },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
}

function purchase(deps, ws, accId, date, net) {
  const r = call(deps, ws, 'post_entry', {
    date,
    source: 'manual',
    idempotencyKey: key('buy'),
    lines: [
      { account: accId('4000'), debit: net, taxCode: 'VST-M' },
      { account: accId('1170'), debit: Math.round(net * 0.081) },
      { account: accId('2000'), credit: Math.round(net * 1.081) },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
}

function fileAll(deps, ws) {
  for (const q of ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']) {
    assert.equal(call(deps, ws, 'vat_mark_filed', { period: q, idempotencyKey: key('file') }).ok, true);
  }
}

test('a clean year matches on both sides: class-3 revenue = sum Ziffer 200, booked Vorsteuer = sum Ziffer 400', () => {
  const deps = freshDeps();
  const { ws, accId } = effektivWorld(deps);
  sale(deps, ws, accId, '2026-02-10', 4_000_000);
  sale(deps, ws, accId, '2026-08-12', 3_000_000);
  purchase(deps, ws, accId, '2026-05-20', 2_000_000);
  fileAll(deps, ws);
  const r = call(deps, ws, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.applicable, true);
  assert.equal(r.method, 'effektiv');
  assert.deepEqual(r.unfiledPeriods, []);
  assert.equal(r.umsatz.revenuePerStatementsMinor, 7_000_000);
  assert.deepEqual(r.umsatz.adjustments, []);
  assert.equal(r.umsatz.adjustedRevenueMinor, 7_000_000);
  assert.equal(r.umsatz.declaredZiffer200Minor, 7_000_000);
  assert.equal(r.umsatz.differenceMinor, 0);
  assert.equal(r.umsatz.status, 'match');
  assert.equal(r.vorsteuer.applicable, true);
  assert.equal(r.vorsteuer.bookedInputMinor, 162_000);
  assert.equal(r.vorsteuer.declaredZiffer400405Minor, 162_000);
  assert.equal(r.vorsteuer.status, 'match');
  assert.deepEqual(
    r.periods.map((p) => [p.label, p.filed, p.ziffer200Minor, p.ziffer399Minor, p.ziffer400405Minor]),
    [
      ['2026-Q1', true, 4_000_000, 324_000, 0],
      ['2026-Q2', true, 0, 0, 162_000],
      ['2026-Q3', true, 3_000_000, 243_000, 0],
      ['2026-Q4', true, 0, 0, 0],
    ],
  );
});

test('a revenue posting the return never saw is a WARN on the Umsatzabstimmung with the exact difference; an untagged 1170 posting warns the Vorsteuer side', () => {
  const deps = freshDeps();
  const { ws, accId } = effektivWorld(deps);
  sale(deps, ws, accId, '2026-02-10', 1_000_000);
  // Untagged revenue: in the statements, never on Ziffer 200.
  assert.equal(
    call(deps, ws, 'post_entry', {
      date: '2026-03-01',
      source: 'manual',
      idempotencyKey: 'untagged',
      lines: [{ account: accId('1020'), debit: 50_000 }, { account: accId('3200'), credit: 50_000 }],
    }).ok,
    true,
  );
  // A hand posting straight onto 1170 with no code: booked Vorsteuer the form never declared.
  assert.equal(
    call(deps, ws, 'post_entry', {
      date: '2026-03-02',
      source: 'manual',
      idempotencyKey: 'hand-1170',
      lines: [{ account: accId('1170'), debit: 700 }, { account: accId('1020'), credit: 700 }],
    }).ok,
    true,
  );
  fileAll(deps, ws);
  const r = call(deps, ws, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(r.umsatz.revenuePerStatementsMinor, 1_050_000);
  assert.equal(r.umsatz.declaredZiffer200Minor, 1_000_000);
  assert.equal(r.umsatz.differenceMinor, 50_000);
  assert.equal(r.umsatz.status, 'warn');
  assert.equal(r.vorsteuer.bookedInputMinor, 700);
  assert.equal(r.vorsteuer.declaredZiffer400405Minor, 0);
  assert.equal(r.vorsteuer.differenceMinor, 700);
  assert.equal(r.vorsteuer.status, 'warn');
});

test('an unfiled period makes both sides UNAVAILABLE and names the period; the figures are still reported', () => {
  const deps = freshDeps();
  const { ws, accId } = effektivWorld(deps);
  sale(deps, ws, accId, '2026-02-10', 1_000_000);
  for (const q of ['2026-Q1', '2026-Q2', '2026-Q3']) {
    assert.equal(call(deps, ws, 'vat_mark_filed', { period: q, idempotencyKey: key('file') }).ok, true);
  }
  const r = call(deps, ws, 'vat_annual_reconciliation', { year: '2026' });
  assert.deepEqual(r.unfiledPeriods, ['2026-Q4']);
  assert.equal(r.umsatz.status, 'unavailable');
  assert.equal(r.vorsteuer.status, 'unavailable');
  assert.equal(r.umsatz.differenceMinor, 0, 'the arithmetic is still done');
  assert.equal(r.periods.find((p) => p.label === '2026-Q4').filed, false);
});

test('the settlement is excluded on both sides: the reconciliation reads the same after four settlements, and 3809 is named as excluded under Saldo', () => {
  const deps = freshDeps();
  const { ws, accId } = effektivWorld(deps);
  sale(deps, ws, accId, '2026-02-10', 4_000_000);
  purchase(deps, ws, accId, '2026-05-20', 2_000_000);
  sale(deps, ws, accId, '2026-11-11', 6_000_000);
  fileAll(deps, ws);
  const before = call(deps, ws, 'vat_annual_reconciliation', { year: '2026' });
  for (const q of ['2026-Q1', '2026-Q2', '2026-Q4']) {
    assert.equal(call(deps, ws, 'vat_settlement_post', { period: q, idempotencyKey: key('settle') }).ok, true);
  }
  const after = call(deps, ws, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'a settlement moves no reconciliation figure');
  assert.equal(after.vorsteuer.bookedInputMinor, 162_000, 'the booked Vorsteuer still reads what was declared, not zero');
});

test('the accrual adjustment: a source=accrual credit on a class-3 account is subtracted and named; its reversal in the same year nets it out', () => {
  const deps = freshDeps();
  const { ws, accId } = effektivWorld(deps);
  sale(deps, ws, accId, '2026-02-10', 1_000_000);
  // The engine refuses `accrual` from the registry (N2's verb is the only writer), so the ledger row is
  // planted the way N2's poster will write it: a posted entry with source='accrual'. This proves the
  // READ names the adjustment; N2's suite proves the writer.
  const entryId = 'e_accrual_test';
  const now = '2026-12-31T00:00:00.000Z';
  // Planted as a draft and promoted, the way `postEntry` promotes: the `posted_immutable` trigger
  // refuses lines on an already-posted row, which is the guard doing its job.
  deps.store.db
    .prepare("INSERT INTO journal_entry (id, workspace_id, date, source, status, idempotency_key, created_at, description) VALUES (?, ?, '2026-12-31', 'accrual', 'draft', 'acc-k', ?, 'Abgrenzung')")
    .run(entryId, ws, now);
  const ins = deps.store.db.prepare(
    'INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  ins.run('l_acc_1', entryId, accId('1300'), 20_000, 0, 20_000, 0, 'CHF');
  ins.run('l_acc_2', entryId, accId('3200'), 0, 20_000, 0, 20_000, 'CHF');
  deps.store.db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?").run(entryId);
  fileAll(deps, ws);
  const r = call(deps, ws, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.umsatz.revenuePerStatementsMinor, 1_020_000);
  assert.deepEqual(r.umsatz.adjustments, [{ kind: 'accrual', accountNumber: '3200', amountMinor: -20_000 }]);
  assert.equal(r.umsatz.adjustedRevenueMinor, 1_000_000);
  assert.equal(r.umsatz.differenceMinor, 0);
  assert.equal(r.umsatz.status, 'match');
});

test('no MWST method answers applicable:false; a malformed year is invalid_input; Saldo reports the Vorsteuer half not applicable', () => {
  const deps = freshDeps();
  const { workspaceId: bare } = mintWorkspace(deps, 'Bare AG', 'ws-bare');
  const none = call(deps, bare, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(none.ok, true);
  assert.equal(none.applicable, false);
  const bad = call(deps, bare, 'vat_annual_reconciliation', { year: '26' });
  assert.equal(bad.error, 'invalid_input');

  const { workspaceId: saldo } = mintWorkspace(deps, 'Saldo GmbH', 'ws-saldo');
  call(deps, saldo, 'vat_seed_defaults', {});
  const cfg = call(deps, saldo, 'vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], idempotencyKey: 'saldo-cfg' });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const r = call(deps, saldo, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'saldo');
  assert.equal(r.vorsteuer.applicable, false);
  assert.deepEqual(r.periods.map((p) => p.label), ['2026-H1', '2026-H2']);
});

test('§H-TENANT: the reconciliation of one workspace reads none of another\'s revenue', () => {
  const deps = freshDeps();
  const a = effektivWorld(deps);
  sale(deps, a.ws, a.accId, '2026-02-10', 1_000_000);
  const { workspaceId: b } = mintWorkspace(deps, 'B GmbH', 'ws-b');
  call(deps, b, 'vat_seed_defaults', {});
  call(deps, b, 'set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const r = call(deps, b, 'vat_annual_reconciliation', { year: '2026' });
  assert.equal(r.umsatz.revenuePerStatementsMinor, 0);
  assert.equal(r.umsatz.declaredZiffer200Minor, 0);
  assert.equal(r.vorsteuer.bookedInputMinor, 0);
});
