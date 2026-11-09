/**
 * A40 critic round 4 (non-author, 30.09.2026): probes through the registry on synthetic books, against
 * the rebuilt MWST chokepoint (`vat.ts`) and the plan's floor pre-check (`plan.ts`) at c47b4e81.
 *
 * `[FINDING]` tests reproduce a defect and fail on the head until it is fixed; `[HOLDS]` tests pin a
 * property that was attacked and held.
 *
 * Every fixture is SYNTHETIC by construction: invented names, the SIX sample IBAN, invented amounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const IBAN = 'CH93 0076 2011 6238 5295 7';

function depsAt(iso) {
  return { store: new SqliteStore({ clock: fixedClock(iso) }), clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

function book(deps, { method = 'effektiv', timing = 'soll' } = {}) {
  const res = getAction('create_workspace').run(deps, { name: 'Beispiel Werkstatt GmbH', idempotencyKey: 'ws' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  call('vat_seed_defaults', {});
  assert.equal(call('set_vat_method', { vatMethod: method, vatAccounting: timing }).ok, true);
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const post = (date, key, lines) => {
    const r = call('post_entry', { date, source: 'manual', idempotencyKey: key, lines });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  return { deps, workspaceId, call, accId, post, bankAccountId: bank.bankAccountId };
}

const vatFlows = (f) => f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref]);
const vatExcluded = (f) => f.excluded.filter((e) => e.kind === 'vat').map((e) => [e.reason, e.ref, e.amountMinor]);

/** A tagged sale of `taxMinor` output tax at 8.1 %, and the customer's payment of it on `paidOn`. */
function paidSale(w, date, paidOn, taxMinor, key) {
  const net = (taxMinor / 81) * 1_000;
  w.post(date, `${key}-s`, [
    { account: w.accId('1100'), debit: net + taxMinor },
    { account: w.accId('3200'), credit: net, taxCode: 'UST81', taxBase: net, taxAmount: taxMinor },
    { account: w.accId('2200'), credit: taxMinor },
  ]);
  w.post(paidOn, `${key}-p`, [
    { account: w.accId('1020'), debit: net + taxMinor },
    { account: w.accId('1100'), credit: net + taxMinor },
  ]);
}

// =================================================================================================
// R4-M1: a period A07 refuses (every period under vereinnahmte Entgelte) drops its tax from the floor
// proof; the ledger still owes it
// =================================================================================================

test('[FINDING R4-M1] Ist timing: the MWST the ledger owes for a closed quarter is not debited, and the plan proves a floor it breaks', () => {
  const run = (timing) => {
    const w = book(depsAt('2026-07-16T08:00:00.000Z'), { timing });
    // A Q2 sale of CHF 100'000 + CHF 8'100 MWST, PAID by the customer in Q2: owed under Soll AND Ist.
    paidSale(w, '2026-05-10', '2026-05-20', 810_000, 'q2');
    const f = w.call('liquidity_forecast', { horizonDays: 90 });
    assert.equal(f.ok, true, JSON.stringify(f));
    const p = w.call('liquidity_plan_propose', { floorMinor: 10_500_000, idempotencyKey: 'p' });
    return { f, p };
  };
  // Control, Soll: Q2 (due 29.8.) is debited on 27.8. and the CHF 105'000 floor stops the proposal.
  const soll = run('soll');
  assert.deepEqual(vatFlows(soll.f), [['2026-08-27', -810_000, '2026-Q2']]);
  assert.equal(soll.p.error, 'floor_breached_by_schedule');

  const ist = run('ist');
  // What the head does: no MWST flow at all, every period `unsupported`, the CHF 8'100 on 2200
  // named `vat_unattributed` and NOT debited; the proposal says `proven` with the balance never
  // below CHF 108'100, although the ESTV collects the Q2 tax by 29.8. (MWSTG Art. 86 Abs. 1).
  assert.ok(
    vatFlows(ist.f).length > 0 || ist.p.ok === false,
    `Ist: vat flows ${JSON.stringify(vatFlows(ist.f))}, excluded ${JSON.stringify(vatExcluded(ist.f))}, ` +
      `proposal ok=${ist.p.ok} optimality=${ist.p.plan?.optimality} minBalance=${ist.p.plan?.minBalanceMinor} (floor 10'500'000, ` +
      `vatPartial=${JSON.stringify(ist.f.assumptions?.vatPartial)})`,
  );
});

// =================================================================================================
// R4-L1: the pre-check refuses (and says "only late payments help") where a no-late plan keeps the floor
// =================================================================================================

test('[FINDING R4-L1] the floor pre-check measures only the full-amount on-time schedule: a Skonto schedule keeps the floor with no bill late, yet the proposal says only late payments can help', () => {
  const w = book(depsAt('2026-07-06T08:00:00.000Z'));
  w.post('2026-07-01', 'capital', [
    { account: w.accId('1020'), debit: 1_000_000 },
    { account: w.accId('2800'), credit: 1_000_000 },
  ]);
  const v = w.call('create_contact', { partyRole: 'vendor', name: 'Muster Holz AG', idempotencyKey: 'v' }).contact.id;
  const bill = w.call('record_expense', {
    vendorId: v,
    billDate: '2026-07-01',
    dueDate: '2026-07-20',
    amountMinor: 1_000_000,
    amountIsGross: true,
    currency: 'CHF',
    taxCode: 'VST-M',
    expenseAccountId: w.accId('6500'),
    vendorReference: 'RE-1',
    idempotencyKey: 'b',
  });
  assert.equal(bill.ok, true, JSON.stringify(bill));
  assert.equal(w.call('liquidity_skonto_set', { vendorBillId: bill.vendorBillId, rateBp: 300, untilDate: '2026-07-08', idempotencyKey: 'k' }).ok, true);
  assert.equal(
    w.call('liquidity_flow_set', { label: 'Miete', direction: 'out', amountMinor: 20_000, currency: 'CHF', firstDate: '2026-07-20', recurrence: 'once', bankAccountId: w.bankAccountId, idempotencyKey: 'rent' }).ok,
    true,
  );
  // Paying on time (full CHF 10'000 on 17.7.) and the rent on 20.7. overdraws by CHF 200. Paying with
  // the Skonto on 7.7. (CHF 9'700) leaves CHF 300, then CHF 100 after the rent: no bill late, floor 0 kept.
  const withConsent = w.call('liquidity_plan_propose', { floorMinor: 0, acceptLatePayments: true, idempotencyKey: 'c' });
  assert.equal(withConsent.ok, true, JSON.stringify(withConsent));
  assert.equal(withConsent.plan.daysLateTotal, 0, 'control: the best plan makes no bill late');
  assert.equal(withConsent.plan.skontoCapturedMinor, 30_000, 'control: it captures the Skonto');
  const strict = w.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 's' });
  assert.equal(
    strict.ok,
    true,
    `the default proposal refuses: ${JSON.stringify(strict)} (Studio: "Das reicht auch ohne Mindestbestand nicht: Es geht nur, wenn einige Rechnungen später bezahlt werden.")`,
  );
});

// =================================================================================================
// R4-L2: a refunded Vorsteuerüberschuss is added back to the cap, so a period already paid is debited
// as overdue (the conservative direction, but a phantom debt that can stop the proposal)
// =================================================================================================

test('[FINDING R4-L2] a Vorsteuer refund already received is added back to the cap: the paid Q2 tax is debited again as overdue today', () => {
  const w = book(depsAt('2026-09-15T08:00:00.000Z'));
  w.post('2026-01-02', 'capital', [
    { account: w.accId('1020'), debit: 50_000_000 },
    { account: w.accId('2800'), credit: 50_000_000 },
  ]);
  // Q1: a purchase with CHF 4'050 Vorsteuer and no sales: a Vorsteuerüberschuss, refunded on 15.6.
  const net = (405_000 / 81) * 1_000;
  w.post('2026-02-10', 'q1-buy', [
    { account: w.accId('6500'), debit: net, taxCode: 'VST-M', taxBase: net, taxAmount: 405_000 },
    { account: w.accId('1170'), debit: 405_000 },
    { account: w.accId('1020'), credit: net + 405_000 },
  ]);
  w.post('2026-06-15', 'q1-refund', [
    { account: w.accId('1020'), debit: 405_000 },
    { account: w.accId('1170'), credit: 405_000 },
  ]);
  // Q2: CHF 8'100 output tax, paid to the ESTV on 25.8. (due 29.8.). Nothing is owed any more.
  paidSale(w, '2026-05-10', '2026-05-20', 810_000, 'q2');
  w.post('2026-08-25', 'q2-estv', [
    { account: w.accId('2200'), debit: 810_000 },
    { account: w.accId('1020'), credit: 810_000 },
  ]);
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.deepEqual(vatFlows(f), [], `nothing is owed, yet: ${JSON.stringify(vatFlows(f))}`);
});

// =================================================================================================
// Held
// =================================================================================================

test('[HOLDS] effektiv: a Vorsteuerüberschuss is never an inflow', () => {
  const w = book(depsAt('2026-07-10T08:00:00.000Z'), { method: 'effektiv' });
  // Effektiv Q2 with a credit only: nothing flows in.
  const net = (405_000 / 81) * 1_000;
  w.post('2026-05-10', 'buy', [
    { account: w.accId('6500'), debit: net, taxCode: 'VST-M', taxBase: net, taxAmount: 405_000 },
    { account: w.accId('1170'), debit: 405_000 },
    { account: w.accId('1020'), credit: net + 405_000 },
  ]);
  const f = w.call('liquidity_forecast', { horizonDays: 90 });
  assert.equal(f.ok, true);
  assert.deepEqual(vatFlows(f), []);
  assert.ok(f.flows.every((x) => !(x.kind === 'vat' && x.amountMinor > 0)), 'no MWST inflow');
});

test('[HOLDS] Saldo: the H1 semester is due 60 days after 30.6. (29.8.) and debited on the last clearing day that still arrives', () => {
  const may = depsAt('2026-05-12T08:00:00.000Z');
  const july = { ...may, clock: fixedClock('2026-07-10T08:00:00.000Z') };
  let deps = may;
  const ws = getAction('create_workspace').run(deps, { name: 'Beispiel Atelier GmbH', idempotencyKey: 'ws' });
  const workspaceId = ws.workspaceId;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  call('vat_seed_defaults');
  const cfg = call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620, formLine: '322' }], idempotencyKey: 'cfg' });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  assert.equal(call('create_bank_account', { name: 'Kontokorrent', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' }).ok, true);
  const cust = call('create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' }).contact.id;
  const doc = call('create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-05-30', lines: [{ description: 'Beratung', unitPriceMinor: 1_000_000, taxCode: 'UST81' }], idempotencyKey: 'd' });
  assert.equal(call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'i' }).ok, true);
  deps = july;
  const ret = call('vat_return', { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, true, JSON.stringify(ret));
  const owed = ret.payableMinor - ret.creditMinor;
  assert.ok(owed > 0, JSON.stringify(ret).slice(0, 400));
  const f = call('liquidity_forecast', { horizonDays: 60 });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.deepEqual(vatFlows(f), [['2026-08-27', -owed, '2026-H1']]);
});
