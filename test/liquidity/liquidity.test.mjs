/**
 * A40 end to end through the registry (the same `action.run` both faces call): the forecast over a
 * synthetic workspace, Skonto terms, planned flows, the proposal (idempotent on ROWS), the A18 draft
 * step, the stale refusal, append-only, §H-TENANT, and the structural "posts nothing, sends nothing".
 *
 * Every fixture here is SYNTHETIC by construction (invented names, the SIX sample IBAN).
 * The fixed clock is 2026-07-16 (a Thursday).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { lastExecutionFor, skontoMinor } from '../../dist/core/liquidity/index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IBAN = 'CH93 0076 2011 6238 5295 7';

function bind(deps, workspaceId) {
  return (name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
}

/** A settled invoice due `due`, paid `paidOn`: one delay sample for the customer. A14 names the LEDGER account. */
function settledInvoice(call, customerId, due, paidOn, ledgerAccountId, key) {
  const d = call('create_document', {
    type: 'invoice',
    contactId: customerId,
    currency: 'CHF',
    dueDate: due,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${key}-doc`,
  });
  call('issue_invoice', { invoiceId: d.document.id, idempotencyKey: `${key}-issue` });
  const paid = call('record_payment', {
    direction: 'incoming',
    date: paidOn,
    amountMinor: 108100,
    bankAccountId: ledgerAccountId,
    intent: 'post_payment',
    counterpartyKind: 'customer',
    counterpartyId: customerId,
    allocations: [{ documentId: d.document.id, amountMinor: 108100 }],
    idempotencyKey: `${key}-pay`,
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  return d.document.id;
}

/**
 * The synthetic world: CHF 50'000 on the bank, a customer who pays 10, 12 and 20 days late and owes
 * one open invoice due 31.7., a supplier granting 2 % within 10 days (bill due 13.8.), a supplier
 * without Skonto (bill due 5.8., IBAN on file), one EUR bill, and monthly rent.
 */
function world(deps = freshDeps(), name = 'Beispiel GmbH', wsKey = 'ws') {
  const { workspaceId, accId } = mintWorkspace(deps, name, wsKey);
  const call = bind(deps, workspaceId);
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', {
    name: 'Kantonalbank Kontokorrent',
    iban: IBAN,
    currency: 'CHF',
    ledgerAccountId: accId('1020'),
    idempotencyKey: 'bank',
  });
  const bankAccountId = bank.bankAccountId;
  call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'capital',
    lines: [
      { account: accId('1020'), debit: 5_000_000 },
      { account: accId('2800'), credit: 5_000_000 },
    ],
  });
  const customer = call('create_contact', { partyRole: 'customer', name: 'Muster Kunde AG', idempotencyKey: 'cust' }).contact.id;
  settledInvoice(call, customer, '2026-04-01', '2026-04-11', accId('1020'), 'h1');
  settledInvoice(call, customer, '2026-05-01', '2026-05-13', accId('1020'), 'h2');
  settledInvoice(call, customer, '2026-06-01', '2026-06-21', accId('1020'), 'h3');
  const open = call('create_document', {
    type: 'invoice',
    contactId: customer,
    currency: 'CHF',
    dueDate: '2026-07-31',
    lines: [{ description: 'Beratung Juli', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'open-doc',
  });
  call('issue_invoice', { invoiceId: open.document.id, idempotencyKey: 'open-issue' });

  const skontoVendor = call('create_contact', { partyRole: 'vendor', name: 'Papier Lieferant GmbH', idempotencyKey: 'v1' }).contact.id;
  const plainVendor = call('create_contact', { partyRole: 'vendor', name: 'Server Hosting AG', idempotencyKey: 'v2' }).contact.id;
  const euroVendor = call('create_contact', { partyRole: 'vendor', name: 'Euro Supplier SE', idempotencyKey: 'v3' }).contact.id;
  const bill = (vendorId, billDate, dueDate, amountMinor, key, currency = 'CHF') =>
    call('record_expense', {
      vendorId,
      billDate,
      dueDate,
      amountMinor,
      amountIsGross: true,
      currency,
      ...(currency === 'CHF' ? { taxCode: 'VST-M' } : {}),
      expenseAccountId: accId('6500'),
      vendorReference: `RE-${key}`,
      idempotencyKey: key,
    });
  call('record_exchange_rate', { baseCurrency: 'EUR', rate: '0.95', asOf: '2026-07-10', idempotencyKey: 'fx-eur' });
  const skontoBill = bill(skontoVendor, '2026-07-14', '2026-08-13', 108100, 'bill-skonto');
  const plainBill = bill(plainVendor, '2026-07-06', '2026-08-05', 500_000, 'bill-plain');
  const euroBill = bill(euroVendor, '2026-07-10', '2026-08-09', 200_000, 'bill-eur', 'EUR');
  assert.equal(skontoBill.ok, true, JSON.stringify(skontoBill));
  assert.equal(plainBill.ok, true, JSON.stringify(plainBill));
  assert.equal(euroBill.ok, true, JSON.stringify(euroBill));
  call('set_creditor_bank_profile', { vendorId: plainVendor, iban: IBAN, idempotencyKey: 'cbp-plain' });
  call('liquidity_skonto_set', { vendorId: skontoVendor, rateBp: 200, days: 10, idempotencyKey: 'sk-v1' });
  call('liquidity_flow_set', {
    label: 'Miete Büro',
    direction: 'out',
    amountMinor: 300_000,
    currency: 'CHF',
    firstDate: '2026-08-01',
    recurrence: 'monthly',
    idempotencyKey: 'rent',
  });
  return {
    deps,
    workspaceId,
    accId,
    call,
    bankAccountId,
    customer,
    openInvoiceId: open.document.id,
    skontoBillId: skontoBill.vendorBillId,
    plainBillId: plainBill.vendorBillId,
    euroBillId: euroBill.ok ? euroBill.vendorBillId : null,
  };
}

function count(deps, table, workspaceId) {
  return deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
}

test('the forecast composes the books: bank balance, delay-dated receivable, on-time payables, rent, excluded EUR', () => {
  const w = world();
  const f = w.call('liquidity_forecast', {});
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal(f.currency, 'CHF');
  assert.equal(f.asOf, '2026-07-16');
  assert.equal(f.horizonEnd, '2026-10-13');
  // Opening: CHF 50'000 capital plus the three settled invoices (3 x 1'081.00).
  assert.equal(f.openingBalanceMinor, 5_000_000 + 3 * 108100);

  // The open invoice: due 31.7. + the customer's q80 delay of 20 days = 20.8. (a Thursday).
  const receivable = f.flows.find((x) => x.kind === 'receivable' && x.ref === w.openInvoiceId);
  assert.equal(receivable.date, '2026-08-20');
  assert.equal(receivable.amountMinor, 108100);
  assert.equal(receivable.provenance, 'delay_customer_20');

  // The payables on the last clearing day that still arrives by the due date (lag 1).
  const plain = f.flows.find((x) => x.ref === w.plainBillId);
  assert.equal(plain.date, lastExecutionFor('2026-08-05', 1));
  assert.equal(plain.amountMinor, -500_000);
  const skonto = f.flows.find((x) => x.ref === w.skontoBillId);
  assert.equal(skonto.date, lastExecutionFor('2026-08-13', 1));

  // Rent: 1.8. is a Saturday (and the National Day), so the outflow lands on Friday 31.7.
  const rent = f.flows.filter((x) => x.kind === 'planned');
  assert.deepEqual(
    rent.map((x) => x.date),
    ['2026-07-31', '2026-09-01', '2026-10-01'],
  );

  // The EUR bill is not converted: it is excluded with its reason.
  assert.ok(f.excluded.some((x) => x.kind === 'payable' && x.reason === 'other_currency' && x.currency === 'EUR'));

  // The last balance equals the opening plus every flow: nothing counted twice or dropped.
  const sum = f.flows.reduce((s, x) => s + x.amountMinor, 0);
  assert.equal(f.days[f.days.length - 1].balanceMinor, f.openingBalanceMinor + sum);
  assert.equal(f.days.length, 90);
});

test('week granularity and a recurring schedule: occurrences dated by due days plus the customer delay', () => {
  const w = world();
  const s = w.call('create_recurring_schedule', {
    contactId: w.customer,
    interval: 'monthly',
    anchorDate: '2026-08-01',
    dueDays: 30,
    lines: [{ description: 'Wartung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'rec',
  });
  assert.equal(s.ok, true, JSON.stringify(s));
  const f = w.call('liquidity_forecast', { granularity: 'week' });
  assert.equal(f.ok, true);
  const rec = f.flows.filter((x) => x.kind === 'recurring');
  // 1.8. + 30 = 31.8. + 20 = 20.9. (Sunday) -> Monday 21.9.; the 1.9. occurrence lands after the horizon.
  assert.deepEqual(rec.map((x) => [x.date, x.amountMinor]), [['2026-09-21', 108100]]);
  assert.ok(Array.isArray(f.weeks) && f.weeks.length >= 13);
  assert.equal(f.days, undefined);
  assert.equal(f.weeks[0].weekStart, '2026-07-13');
});

test('no bank account in the currency: needs_bank_account; bad parameters: invalid_input', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = bind(deps, workspaceId);
  assert.equal(call('liquidity_forecast', {}).error, 'needs_bank_account');
  assert.equal(call('liquidity_forecast', { horizonDays: 3 }).error, 'invalid_input');
  assert.equal(call('liquidity_forecast', { granularity: 'month' }).error, 'invalid_input');
  assert.equal(call('liquidity_forecast', { delayQuantile: 99 }).error, 'invalid_input');
});

test('Skonto terms: vendor default, bill override, explicit none, and the refusals', () => {
  const w = world();
  assert.equal(w.call('liquidity_skonto_set', { vendorBillId: w.skontoBillId, rateBp: 300, untilDate: '2026-07-20', idempotencyKey: 'sk-b1' }).ok, true);
  const listed = w.call('liquidity_skonto_list', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.total, 2);
  assert.ok(listed.terms.some((t) => t.scope === 'bill' && t.rateBp === 300 && t.untilDate === '2026-07-20'));
  // Replacing, not adding: the same bill again updates the one row.
  w.call('liquidity_skonto_set', { vendorBillId: w.skontoBillId, rateBp: 0, idempotencyKey: 'sk-b2' });
  assert.equal(w.call('liquidity_skonto_list', {}).total, 2);
  assert.equal(count(w.deps, 'skonto_term', w.workspaceId), 2);
  assert.equal(w.call('liquidity_skonto_set', { vendorBillId: w.skontoBillId, rateBp: 1001, untilDate: '2026-07-20', idempotencyKey: 'x1' }).error, 'invalid_input');
  assert.equal(w.call('liquidity_skonto_set', { vendorId: 'contact_nope', rateBp: 200, days: 10, idempotencyKey: 'x2' }).error, 'not_found');
  assert.equal(
    w.call('liquidity_skonto_set', { vendorId: 'a', vendorBillId: 'b', rateBp: 200, days: 10, idempotencyKey: 'x3' }).error,
    'invalid_input',
  );
  // With the explicit "none" on the bill, the proposal captures nothing on it.
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  assert.equal(p.plan.skontoCapturedMinor, 0);
});

test('planned flows: create, retire, list', () => {
  const w = world();
  const flows = w.call('liquidity_flow_list', {});
  assert.equal(flows.total, 1);
  const id = flows.flows[0].id;
  const retired = w.call('liquidity_flow_set', {
    flowId: id,
    label: 'Miete Büro',
    direction: 'out',
    amountMinor: 300_000,
    currency: 'CHF',
    firstDate: '2026-08-01',
    recurrence: 'monthly',
    active: false,
    idempotencyKey: 'rent-off',
  });
  assert.equal(retired.ok, true);
  assert.equal(w.call('liquidity_flow_list', {}).total, 0);
  assert.equal(w.call('liquidity_flow_list', { includeInactive: true }).total, 1);
  assert.equal(w.call('liquidity_forecast', {}).flows.filter((x) => x.kind === 'planned').length, 0);
  assert.equal(
    w.call('liquidity_flow_set', { label: 'x', direction: 'sideways', amountMinor: 1, currency: 'CHF', firstDate: '2026-08-01', recurrence: 'once', idempotencyKey: 'bad' }).error,
    'invalid_input',
  );
});

test('the proposal captures the Skonto, explains every bill, and is idempotent on ROWS under any key', () => {
  const w = world();
  const entriesBefore = count(w.deps, 'journal_entry', w.workspaceId);
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan-1' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.replayed, false);
  const plan = p.plan;
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.optimality, 'proven');
  assert.equal(plan.floorMinor, 1_000_000);
  assert.equal(plan.skontoCapturedMinor, skontoMinor(108100, 200));
  assert.equal(plan.objectiveMinor, 2162);
  assert.equal(plan.floorBreachedByBase, null);
  const byBill = new Map(plan.lines.map((l) => [l.vendorBillId, l]));
  const sk = byBill.get(w.skontoBillId);
  // Skonto until 24.7. (14.7. + 10), lag 1: execute Thursday 23.7.
  assert.equal(sk.reason, 'skonto_captured');
  assert.equal(sk.payDate, '2026-07-23');
  assert.equal(sk.cashMinor, 108100 - 2162);
  assert.equal(sk.detail.skontoSource, 'vendor');
  const plain = byBill.get(w.plainBillId);
  assert.equal(plain.reason, 'on_time_latest');
  assert.equal(plain.payDate, lastExecutionFor('2026-08-05', 1));
  assert.ok(plan.minBalanceMinor >= 1_000_000);

  // Same books, a DIFFERENT key: the same plan, no new row.
  const again = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan-2' });
  assert.equal(again.replayed, true);
  assert.equal(again.planId, p.planId);
  // The same key: the memoised answer.
  assert.deepEqual(w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan-1' }), p);
  assert.equal(count(w.deps, 'payment_plan', w.workspaceId), 1);
  assert.equal(count(w.deps, 'payment_plan_line', w.workspaceId), 2);
  // A different floor is a different question: a second plan.
  const other = w.call('liquidity_plan_propose', { floorMinor: 900_000, idempotencyKey: 'plan-3' });
  assert.notEqual(other.planId, p.planId);
  assert.equal(w.call('liquidity_plan_list', {}).total, 2);
  assert.equal(w.call('liquidity_plan_get', { planId: p.planId }).plan.lines.length, 2);
  // Nothing was posted.
  assert.equal(count(w.deps, 'journal_entry', w.workspaceId), entriesBefore);
});

test('M8 (owner decision 30.09.2026): scheduled flows under the floor stop the proposal with the day, the shortfall and the floor that holds', () => {
  const w = world();
  // Opening CHF 53'243; the rent (3 x CHF 3'000), the receivable of 20.8. AND both CHF bills paid on
  // their on-time day (CHF 1'081 + CHF 5'000, R2-H1: the on-time schedule is the measure) take the
  // balance to CHF 39'243 on 1.10.
  const refused = w.call('liquidity_plan_propose', { floorMinor: 5_300_000, idempotencyKey: 'tight' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'floor_breached_by_schedule');
  assert.equal(refused.date, '2026-10-01');
  assert.equal(refused.balanceMinor, 5_324_300 - 900_000 + 108_100 - 108_100 - 500_000);
  assert.equal(refused.shortfallMinor, 5_300_000 - refused.balanceMinor);
  assert.equal(refused.suggestedFloorMinor, refused.balanceMinor);
  assert.equal(refused.overdraws, false);
  assert.equal(count(w.deps, 'payment_plan', w.workspaceId), 0, 'a refusal stores no plan');
  // Option 1: lower the floor to the suggested one: every bill is then paid on time (R2-H1).
  const lowered = w.call('liquidity_plan_propose', { floorMinor: refused.suggestedFloorMinor, idempotencyKey: 'lowered' });
  assert.equal(lowered.ok, true, JSON.stringify(lowered));
  assert.equal(lowered.plan.floorBreachedByBase, null);
  assert.deepEqual(lowered.plan.lines.filter((l) => l.daysLate > 0), [], 'the lowered floor pays every bill on time');
  assert.equal(lowered.plan.lateInterestMinor, 0);
  // Option 2: accept the late payments explicitly; then no payment deepens the dip, and the Skonto goes.
  const accepted = w.call('liquidity_plan_propose', { floorMinor: 5_300_000, acceptLatePayments: true, idempotencyKey: 'accept' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.plan.floorBreachedByBase.date, '2026-10-01');
  const sk = accepted.plan.lines.find((l) => l.vendorBillId === w.skontoBillId);
  assert.notEqual(sk.reason, 'skonto_captured');
  assert.equal(accepted.plan.skontoCapturedMinor, 0);
});

test('drafting: one A18 draft run per date, the Skonto line refused by name, nothing posted', () => {
  const w = world();
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan' });
  const entriesBefore = count(w.deps, 'journal_entry', w.workspaceId);
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'draft-1' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.status, 'drafted');
  assert.equal(d.batches.length, 1);
  assert.equal(d.batches[0].executionDate, lastExecutionFor('2026-08-05', 1));
  assert.equal(d.batches[0].totalMinor, 500_000);
  assert.deepEqual(d.notDrafted, [{ vendorBillId: w.skontoBillId, payDate: '2026-07-23', reason: 'skonto_needs_reduced_amount' }]);
  const batch = w.call('get_payment_batch', { batchId: d.batches[0].batchId });
  assert.equal(batch.batch.status, 'draft');
  assert.equal(batch.batch.items[0].vendorBillId, w.plainBillId);
  assert.equal(count(w.deps, 'journal_entry', w.workspaceId), entriesBefore);
  // The line carries its run; the plan is drafted.
  const got = w.call('liquidity_plan_get', { planId: p.planId }).plan;
  assert.equal(got.status, 'drafted');
  assert.equal(got.lines.find((l) => l.vendorBillId === w.plainBillId).batchId, d.batches[0].batchId);
  // Replay under the same key: the same answer, no second run. Another key: already_drafted.
  assert.deepEqual(w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'draft-1' }), d);
  assert.equal(
    w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'draft-2' }).error,
    'already_drafted',
  );
  assert.equal(count(w.deps, 'payment_batch', w.workspaceId), 1);
});

test('drafting refuses a stale proposal, a foreign-currency account and an unknown plan', () => {
  const w = world();
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan' });
  const eur = w.call('create_bank_account', {
    name: 'EUR Konto',
    iban: 'CH56 0483 5012 3456 7800 9',
    currency: 'EUR',
    ledgerAccountId: w.accId('1020'),
    idempotencyKey: 'eur-bank',
  });
  assert.equal(eur.ok, true, JSON.stringify(eur));
  assert.equal(
    w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: eur.bankAccountId, idempotencyKey: 'd-eur' }).error,
    'currency_mismatch',
  );
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: 'pplan_nope', bankAccountId: w.bankAccountId, idempotencyKey: 'd0' }).error, 'not_found');
  // The books move: a new bill. The proposal no longer answers today's books.
  w.call('record_expense', {
    vendorId: w.deps.store.db.prepare("SELECT id FROM contact WHERE workspace_id = ? AND name = 'Server Hosting AG'").get(w.workspaceId).id,
    billDate: '2026-07-15',
    dueDate: '2026-08-14',
    amountMinor: 20_000,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: w.accId('6500'),
    idempotencyKey: 'late-bill',
  });
  const stale = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd1' });
  assert.equal(stale.error, 'stale_plan');
  assert.equal(count(w.deps, 'payment_batch', w.workspaceId), 0);
  // A refusal is never memoised: after re-proposing, the new plan drafts.
  const fresh = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan-2' });
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: fresh.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd2' }).ok, true);
});

test('a proposal is append-only: its economics cannot be edited or deleted', () => {
  const w = world();
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan' });
  const db = w.deps.store.db;
  assert.throws(() => db.prepare('UPDATE payment_plan SET objective_minor = 0 WHERE id = ?').run(p.planId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM payment_plan WHERE id = ?').run(p.planId), /append-only/);
  assert.throws(() => db.prepare('UPDATE payment_plan_line SET pay_date = NULL WHERE plan_id = ?').run(p.planId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM payment_plan_line WHERE plan_id = ?').run(p.planId), /append-only/);
});

test('§H-TENANT: another workspace sees none of it', () => {
  const deps = freshDeps();
  const a = world(deps, 'A GmbH', 'wsA');
  const p = a.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan' });
  const { workspaceId: b } = mintWorkspace(deps, 'B GmbH', 'wsB');
  const callB = bind(deps, b);
  assert.equal(callB('liquidity_plan_get', { planId: p.planId }).error, 'not_found');
  assert.equal(callB('liquidity_plan_list', {}).total, 0);
  assert.equal(callB('liquidity_skonto_list', {}).total, 0);
  assert.equal(callB('liquidity_flow_list', {}).total, 0);
  assert.equal(callB('liquidity_forecast', {}).error, 'needs_bank_account');
  assert.equal(
    callB('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: a.bankAccountId, idempotencyKey: 'steal' }).error,
    'not_found',
  );
  assert.equal(callB('liquidity_forecast', { planId: p.planId }).error, 'needs_bank_account');
});

test('structurally: the module imports no poster, no payment verb and no network', () => {
  const dir = join(ROOT, 'src/core/liquidity');
  for (const file of readdirSync(dir)) {
    const src = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\bpostEntry\b|\brecordPayment\b|\ballocatePayment\b|\bmarkBatchPaid\b|\bgeneratePain001\b/, file);
    assert.doesNotMatch(src, /node:(net|http|https|dgram|tls|child_process)|\bfetch\(/, file);
  }
});
