/**
 * A40 payment timing: the NON-AUTHOR critic's adversarial suite (docs/critique/a40-payment-timing-critique.md).
 *
 * Every test here was written by the non-author critic against the author's branch head 04a028a4. A
 * test marked `[FINDING Fn]` FAILS on that head and names the defect in the critique; a test marked
 * `[HOLDS]` passes there and pins a property the critic attacked and could not break (kept as a
 * regression guard).
 *
 * Every fixture is SYNTHETIC by construction: invented company names, the SIX sample IBANs, invented
 * amounts and dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { optimisePaymentPlan, horizonDates, isClearingDay } from '../../dist/core/liquidity/index.js';

const IBAN = 'CH93 0076 2011 6238 5295 7';

/** Deps pinned to one instant (an injected clock, never the wall clock). */
function depsAt(iso = '2026-07-16T08:00:00.000Z') {
  const store = new SqliteStore({ clock: fixedClock(iso) });
  return { store, clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

/** A workspace with VAT configured, one CHF Bankkonto on 1020 and CHF 50'000 capital posted on 1.7. */
function book(deps, name = 'Beispiel Handels GmbH', wsKey = 'ws') {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey: wsKey });
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const cap = call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'capital',
    lines: [
      { account: accId('1020'), debit: 5_000_000 },
      { account: accId('2800'), credit: 5_000_000 },
    ],
  });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const vendor = (vname, key) => call('create_contact', { partyRole: 'vendor', name: vname, idempotencyKey: key }).contact.id;
  const bill = (vendorId, billDate, dueDate, amountMinor, key) => {
    const r = call('record_expense', {
      vendorId,
      billDate,
      dueDate,
      amountMinor,
      amountIsGross: true,
      currency: 'CHF',
      taxCode: 'VST-M',
      expenseAccountId: accId('6500'),
      vendorReference: `RE-${key}`,
      idempotencyKey: key,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.vendorBillId;
  };
  return { deps, workspaceId, accId, call, bankAccountId: bank.bankAccountId, vendor, bill };
}

const count = (deps, table, ws) => deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(ws).n;

// =================================================================================================
// F1: a late payment chosen for nothing (the late option wins a tie against on-time)
// =================================================================================================

test('[FINDING F1] a CHF 30 bill with CHF 100\'000 of headroom is paid on time, not one day late', () => {
  // Due Wednesday 22.7.2026, lag 1: the last on-time execution is Tuesday 21.7. Paying Wednesday arrives
  // Thursday, one day late, and OR 104 interest on CHF 30 for one day rounds to 0.00. The late option then
  // ties the on-time one on worth and wins the "later day" tie-break (dominance drops the on-time option).
  const dates = horizonDates('2026-07-16', 30);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: dates.map(() => 10_000_000),
    floorMinor: 0,
    lagDays: 1,
    lateInterestBp: 500,
    bills: [{ id: 'kleinbetrag', openMinor: 3000, dueDate: '2026-07-22', skontoRateBp: 0, skontoUntil: null }],
  });
  const line = r.lines[0];
  assert.equal(line.option.daysLate, 0, `proposed ${line.option.date}, arriving ${line.option.arrival}: ${line.option.daysLate} day(s) late with ample cash (reason ${line.reason})`);
  assert.notEqual(line.reason, 'late_floor', 'the floor did not bind, so "zu spät wegen Mindestbestand" is untrue');
});

test('[FINDING F1] lateInterestBp 0 (a valid input) must not turn every bill into a late payment', () => {
  const dates = horizonDates('2026-07-16', 30);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: dates.map(() => 10_000_000),
    floorMinor: 0,
    lagDays: 1,
    lateInterestBp: 0,
    bills: [{ id: 'miete', openMinor: 500_000, dueDate: '2026-07-24', skontoRateBp: 0, skontoUntil: null }],
  });
  assert.equal(r.lines[0].option.daysLate, 0, `a CHF 5'000 bill proposed ${r.lines[0].option.daysLate} days late with ample cash`);
});

test('[FINDING F1] end to end: the draft step never pre-commits an A18 run AFTER a due date the floor did not force', () => {
  const w = book(depsAt());
  const v = w.vendor('Kleinteile AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  const billId = w.bill(v, '2026-07-08', '2026-07-22', 3000, 'klein');
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, true, JSON.stringify(d));
  for (const b of d.batches) {
    assert.ok(b.executionDate <= '2026-07-21', `A18 run ${b.batchId} executes ${b.executionDate}: the bill ${billId} (due 22.7.) arrives late with CHF 50'000 on the bank`);
  }
});

test('[FINDING F10] an already-overdue bill paid today with ample cash is not labelled late "because of the floor"', () => {
  const dates = horizonDates('2026-07-16', 30);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: dates.map(() => 10_000_000),
    floorMinor: 0,
    lagDays: 1,
    lateInterestBp: 500,
    bills: [{ id: 'overdue-bill', openMinor: 500_000, dueDate: '2026-07-01', skontoRateBp: 0, skontoUntil: null }],
  });
  assert.equal(r.lines[0].option.date, '2026-07-16', 'paid on the first clearing day');
  // de-CH renders late_floor as "{days} Tage zu spät wegen Mindestbestand": the lateness is the bill's
  // own history, not the floor, so the reason must say so.
  assert.notEqual(r.lines[0].reason, 'late_floor');
});

// =================================================================================================
// F2: the 1'000-bill ceiling of listVendorBills silently drops the OLDEST (overdue) payables
// =================================================================================================

test('[FINDING F2] an open overdue bill older than 1\'000 newer posted bills is neither forecast, planned nor excluded', () => {
  const w = book(depsAt());
  const v = w.vendor('Grosshandel Muster AG', 'v1');
  // The oldest bill: CHF 40'000, overdue since 1.7.
  const oldest = w.bill(v, '2026-06-01', '2026-07-01', 4_000_000, 'oldest');
  // A year of ordinary purchasing: 1'000 newer bills (all open here; paid bills keep status 'posted'
  // and count against the same ceiling).
  for (let i = 0; i < 1000; i += 1) w.bill(v, '2026-07-10', '2026-12-31', 1000, `b${i}`);
  const f = w.call('liquidity_forecast', {});
  assert.equal(f.ok, true);
  const seen = f.flows.some((x) => x.ref === oldest) || f.excluded.some((x) => x.ref === oldest);
  assert.ok(seen, 'a CHF 40\'000 overdue payable vanished from the forecast without an excluded entry');
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'p' });
  assert.ok(p.plan.lines.some((l) => l.vendorBillId === oldest), 'the plan does not account for every open payable');
});

// =================================================================================================
// F3: the MWST outflow counts only tax posted to date, while the same forecast counts VAT-inclusive
// recurring inflows of that period; a period not yet started but due inside the horizon is dropped
// =================================================================================================

function withRecurring(iso, anchorDate) {
  const w = book(depsAt(iso));
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Abo Kunde AG', idempotencyKey: 'c' }).contact.id;
  const s = w.call('create_recurring_schedule', {
    contactId: cust,
    interval: 'monthly',
    anchorDate,
    dueDays: 10,
    lines: [{ description: 'Wartung', unitPriceMinor: 1_000_000, taxCode: 'UST81' }],
    idempotencyKey: 'rec',
  });
  assert.equal(s.ok, true, JSON.stringify(s));
  return w;
}

test('[FINDING F3] default 90-day horizon: the Q3 MWST due 29.11. includes the output tax of the Q3 invoice the forecast counts', () => {
  // 1.9.2026: the Q3 period (Jul-Sep) is due 29.11., inside the 90-day horizon. The recurring invoice of
  // 1.9. is counted as a CHF 10'810 inflow (VAT included); its CHF 810 output tax is owed on 29.11.
  const w = withRecurring('2026-09-01T08:00:00.000Z', '2026-09-01');
  const f = w.call('liquidity_forecast', {});
  assert.equal(f.ok, true, JSON.stringify(f));
  const q3Inflow = f.flows.filter((x) => x.kind === 'recurring' && x.ref.endsWith('@2026-09-01'));
  assert.equal(q3Inflow.length, 1, 'fixture: the September occurrence is an inflow');
  const vatOut = -f.flows.filter((x) => x.kind === 'vat').reduce((s, x) => s + x.amountMinor, 0);
  assert.ok(vatOut >= 81_000, `MWST outflow in the horizon is CHF ${vatOut / 100}, while CHF 810 of Q3 output tax is inside the counted inflow`);
});

test('[FINDING F3] 180-day horizon (a Studio option): the Q4 MWST due 1.3.2027 is counted or named, never silently absent', () => {
  const w = withRecurring('2026-09-30T08:00:00.000Z', '2026-10-01');
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.ok(f.horizonEnd >= '2027-03-01', 'fixture: the Q4 due date lies inside the horizon');
  const q4Invoices = f.flows.filter((x) => x.kind === 'recurring' && /@2026-1[0-2]-/.test(x.ref));
  assert.equal(q4Invoices.length, 3, 'fixture: three Q4 invoices are counted as inflows, VAT included');
  const vatFlow = f.flows.some((x) => x.kind === 'vat' && x.date >= '2027-01-01');
  const vatNamed = f.excluded.some((x) => x.kind === 'vat' && x.reason !== 'vat_not_configured');
  assert.ok(vatFlow || vatNamed, 'the Q4 MWST payment inside the horizon is neither a flow nor an excluded entry');
});

// =================================================================================================
// F9: a POSTED bank movement dated after today is in neither the opening balance nor a flow
// =================================================================================================

test('[FINDING F9] a posted bank outflow dated after today reaches the forecast', () => {
  // Salaries booked ahead for 20.7. (or a run marked paid with its future value date): the ledger already
  // knows CHF 30'000 leaves the bank on 20.7.
  const w = book(depsAt());
  const lohn = w.call('post_entry', {
    date: '2026-07-20',
    source: 'manual',
    description: 'Löhne Juli',
    idempotencyKey: 'lohn',
    lines: [
      { account: w.accId('5000'), debit: 3_000_000 },
      { account: w.accId('1020'), credit: 3_000_000 },
    ],
  });
  assert.equal(lohn.ok, true, JSON.stringify(lohn));
  const f = w.call('liquidity_forecast', {});
  const day = f.days.find((d) => d.date === '2026-07-21');
  assert.equal(day.balanceMinor, 2_000_000, `the forecast shows CHF ${day.balanceMinor / 100} on 21.7. although CHF 30'000 is booked out on 20.7.`);
});

// =================================================================================================
// F5: a drafted plan whose runs were discarded blocks every re-proposal of the same day
// =================================================================================================

test('[FINDING F5] after discarding the drafted runs, the same books can be proposed and drafted again the same day', () => {
  const w = book(depsAt());
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p1 = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p1' });
  const d1 = w.call('liquidity_plan_draft_batches', { planId: p1.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd1' });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  for (const b of d1.batches) {
    const disc = w.call('discard_payment_batch', { batchId: b.batchId, idempotencyKey: `x-${b.batchId}` });
    assert.equal(disc.ok, true, JSON.stringify(disc));
  }
  // The person presses "Vorschlag berechnen" again (a fresh key per press, as the Studio does).
  const p2 = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p2' });
  assert.equal(p2.ok, true, JSON.stringify(p2));
  const d2 = w.call('liquidity_plan_draft_batches', { planId: p2.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd2' });
  assert.equal(d2.ok, true, `re-proposal answered plan ${p2.planId} (status ${p2.plan.status}, replayed ${p2.replayed}); drafting it: ${JSON.stringify(d2).slice(0, 200)}`);
});

// =================================================================================================
// F12: runs drafted on a bank account the plan's floor never looked at
// =================================================================================================

test('[FINDING F12] a plan solved on one account\'s balance is not drafted onto another account', () => {
  const w = book(depsAt());
  const acc = w.call('create_account', { number: '1021', name: 'Bank Zweitkonto', type: 'asset', idempotencyKey: 'acc2' });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  const second = w.call('create_bank_account', {
    name: 'Zweitkonto',
    iban: 'CH56 0483 5012 3456 7800 9',
    currency: 'CHF',
    ledgerAccountId: w.accId('1021'),
    idempotencyKey: 'bank2',
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  // Solved on the Kontokorrent's CHF 50'000 only; the Zweitkonto holds nothing.
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, bankAccountIds: [w.bankAccountId], idempotencyKey: 'p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: second.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, false, 'a CHF 5\'000 run was drafted onto an empty account the plan never forecast');
});

// =================================================================================================
// F8: the Studio's "pay it yourself with the deduction" leaves a remainder the next plan drafts
// =================================================================================================

test('[FINDING F8] after the manual Skonto payment the Studio asks for, the next plan does not draft the deducted Skonto as a payment', () => {
  const deps = depsAt();
  const w = book(deps);
  const v = w.vendor('Papier Lieferant GmbH', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  const billId = w.bill(v, '2026-07-14', '2026-08-13', 108_100, 'sk');
  w.call('liquidity_skonto_set', { vendorId: v, rateBp: 200, days: 10, idempotencyKey: 'sk' });
  const p1 = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p1' });
  const line = p1.plan.lines.find((l) => l.vendorBillId === billId);
  assert.equal(line.reason, 'skonto_captured');
  const d1 = w.call('liquidity_plan_draft_batches', { planId: p1.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd1' });
  assert.equal(d1.error, 'nothing_to_draft');
  assert.equal(d1.notDrafted[0].reason, 'skonto_needs_reduced_amount');
  // "Zahle diese Rechnung selbst mit Abzug": the person pays CHF 1'059.38 at the bank and books it.
  const paid = w.call('record_payment', {
    direction: 'outgoing',
    date: '2026-07-16',
    amountMinor: line.cashMinor,
    bankAccountId: w.accId('1020'),
    intent: 'post_payment',
    counterpartyKind: 'supplier',
    counterpartyId: v,
    allocations: [{ vendorBillId: billId, amountMinor: line.cashMinor }],
    idempotencyKey: 'manual-skonto',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  // Ten days later the Skonto window is over; the CHF 21.62 the supplier conceded is still "open".
  deps.clock = fixedClock('2026-07-27T08:00:00.000Z');
  const p2 = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p2' });
  assert.equal(p2.ok, true, JSON.stringify(p2));
  const d2 = w.call('liquidity_plan_draft_batches', { planId: p2.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd2' });
  const drafted = d2.ok ? d2.batches : [];
  const remainderRun = drafted.some((b) =>
    w.call('get_payment_batch', { batchId: b.batchId }).batch.items.some((it) => it.vendorBillId === billId),
  );
  assert.equal(remainderRun, false, 'the deducted CHF 21.62 Skonto was drafted into an A18 run as a payment to the supplier');
});

// =================================================================================================
// F6: G04 restore leaves A40's undeclared id columns pointing at the SOURCE workspace
// =================================================================================================

// TODO (orchestrator, 30.09.2026): passes once the G04 chokepoint is merged (claude/g04-restore-chokepoint:
// a universal id remap over every restored TEXT value plus a schema-wide leak-scan gate). A40 declares
// REFERENCES where the target is one table (payment_plan_line.vendor_id, .batch_id); skonto_term.scope_id
// is polymorphic and waits for the chokepoint. portability.ts is not A40's to edit.
test('[FINDING F6] backup then restore: every Skonto term, plan-line vendor and batch link resolves inside the restored workspace', {}, () => {
  const deps = depsAt();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-a40-critic-'));
  const w = book(deps);
  const v = w.vendor('Papier Lieferant GmbH', 'v1');
  const v2 = w.vendor('Hosting AG', 'v2');
  w.call('set_creditor_bank_profile', { vendorId: v2, iban: IBAN, idempotencyKey: 'cbp' });
  const skBill = w.bill(v, '2026-07-14', '2026-08-13', 108_100, 'sk');
  w.bill(v2, '2026-07-06', '2026-08-05', 500_000, 'plain');
  w.call('liquidity_skonto_set', { vendorId: v, rateBp: 200, days: 10, idempotencyKey: 'skv' });
  w.call('liquidity_skonto_set', { vendorBillId: skBill, rateBp: 300, untilDate: '2026-07-24', idempotencyKey: 'skb' });
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, true, JSON.stringify(d));

  const bkp = w.call('create_backup', { idempotencyKey: 'bkp' });
  assert.equal(bkp.ok, true, JSON.stringify(bkp));
  const restored = getAction('restore_backup').run(deps, { source: bkp.artifactRef, newWorkspaceName: 'Wiederhergestellt GmbH', confirmed: true, idempotencyKey: 'rb' });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const ws = restored.workspaceId;
  const db = deps.store.db;
  const inWs = (table, id) => db.prepare(`SELECT 1 AS x FROM ${table} WHERE workspace_id = ? AND id = ?`).get(ws, id) !== undefined;

  const terms = db.prepare('SELECT scope_kind, scope_id FROM skonto_term WHERE workspace_id = ?').all(ws);
  assert.equal(terms.length, 2);
  for (const t of terms) {
    assert.ok(inWs(t.scope_kind === 'vendor' ? 'contact' : 'vendor_bill', t.scope_id), `restored ${t.scope_kind} Skonto term points at ${t.scope_id}, not a row of the restored workspace`);
  }
  for (const l of db.prepare('SELECT vendor_id, batch_id FROM payment_plan_line WHERE workspace_id = ?').all(ws)) {
    if (l.vendor_id !== null) assert.ok(inWs('contact', l.vendor_id), `restored plan line vendor_id ${l.vendor_id} dangles`);
    if (l.batch_id !== null) assert.ok(inWs('payment_batch', l.batch_id), `restored plan line batch_id ${l.batch_id} dangles`);
  }
  // The functional consequence: the restored books propose with the Skonto the source had.
  const callR = (n, i = {}) => getAction(n).run(deps, { workspaceId: ws, ...i });
  const listed = callR('liquidity_skonto_list', {});
  assert.ok(listed.terms.every((t) => t.name !== null), 'restored Skonto terms no longer name their supplier');
});

// =================================================================================================
// F7: a run drafted through A40 does not emit payment_batch.created
// =================================================================================================

test('[FINDING F7] an automation rule on payment_batch.created sees runs drafted through liquidity_plan_draft_batches', () => {
  const deps = depsAt();
  const w = book(deps);
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const rule = w.call('create_automation_rule', {
    name: 'Neuer Zahlungslauf: Treuhänder markieren',
    trigger: { event: 'payment_batch.created' },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: v, segments: ['zahlungslauf'] } },
    idempotencyKey: 'rule',
  });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  const runs = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ?').get(w.workspaceId).n;
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.batches.length, 1);
  const afterA40 = runs();
  // Control: the same rule DOES fire when A18's own door creates a run, so the rule is live.
  const other = w.bill(v, '2026-07-07', '2026-08-06', 200_000, 'b2');
  const direct = w.call('create_payment_batch', { bankAccountId: w.bankAccountId, itemIds: [other], executionDate: '2026-08-05', idempotencyKey: 'direct' });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.ok(runs() > afterA40, 'control: the rule fires on create_payment_batch');
  assert.ok(afterA40 >= 1, 'a payment run was created through A40 and the payment_batch.created rule never fired');
});

// =================================================================================================
// F11: the append-only triggers leave attribution and evidence columns editable
// =================================================================================================

test('[FINDING F11] a proposal\'s author, base-breach record and a line\'s vendor are frozen like its economics', () => {
  const w = book(depsAt());
  const v = w.vendor('Hosting AG', 'v1');
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  const db = w.deps.store.db;
  assert.throws(() => db.prepare("UPDATE payment_plan SET created_by = 'jemand-anders' WHERE id = ?").run(p.planId), /append-only/);
  assert.throws(() => db.prepare("UPDATE payment_plan SET base_breach_json = '{}' WHERE id = ?").run(p.planId), /append-only/);
  assert.throws(() => db.prepare("UPDATE payment_plan_line SET vendor_id = 'contact_x' WHERE plan_id = ?").run(p.planId), /append-only/);
});

// =================================================================================================
// HOLDS: properties the critic attacked and could not break
// =================================================================================================

test('[HOLDS] §H-TENANT: workspace B cannot read, reuse or aim at anything of workspace A', () => {
  const deps = depsAt();
  const a = book(deps, 'A GmbH', 'wsA');
  const va = a.vendor('Lieferant A AG', 'va');
  a.call('set_creditor_bank_profile', { vendorId: va, iban: IBAN, idempotencyKey: 'cbp' });
  const billA = a.bill(va, '2026-07-06', '2026-08-05', 500_000, 'ba');
  a.call('liquidity_skonto_set', { vendorId: va, rateBp: 200, days: 30, idempotencyKey: 'sk' });
  const flowA = a.call('liquidity_flow_set', { label: 'Miete', direction: 'out', amountMinor: 1_000_000, currency: 'CHF', firstDate: '2026-07-20', recurrence: 'monthly', idempotencyKey: 'f' });
  const planA = a.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });

  const b = book(deps, 'B GmbH', 'wsB');
  const beforeB = b.call('liquidity_forecast', {});
  assert.equal(b.call('liquidity_skonto_set', { vendorBillId: billA, rateBp: 300, untilDate: '2026-07-24', idempotencyKey: 'x1' }).error, 'not_found');
  assert.equal(b.call('liquidity_skonto_set', { vendorId: va, rateBp: 300, days: 10, idempotencyKey: 'x2' }).error, 'not_found');
  assert.equal(b.call('liquidity_forecast', { bankAccountIds: [a.bankAccountId] }).error, 'not_found');
  assert.equal(
    b.call('liquidity_flow_set', { flowId: flowA.flow.id, label: 'weg', direction: 'in', amountMinor: 1, currency: 'CHF', firstDate: '2026-07-20', recurrence: 'once', idempotencyKey: 'x3' }).error,
    'not_found',
  );
  assert.equal(b.call('liquidity_forecast', { planId: planA.planId }).error, 'not_found');
  assert.equal(a.call('liquidity_plan_draft_batches', { planId: planA.planId, bankAccountId: b.bankAccountId, idempotencyKey: 'x4' }).error, 'needs_bank_account');
  // A's terms, flows and bills never enter B's numbers.
  assert.deepEqual(b.call('liquidity_forecast', {}), beforeB);
  assert.equal(beforeB.flows.filter((x) => x.kind === 'planned').length, 0, "A's planned rent reached B's forecast");
  assert.equal(count(deps, 'skonto_term', b.workspaceId), 0);
  assert.equal(count(deps, 'payment_batch', a.workspaceId), 0);
  // A term row of workspace A that happens to carry B's vendor id (the shape a G04 restore beside the
  // original leaves behind, F6) must never price B's bill.
  const vb = b.vendor('Lieferant B AG', 'vb');
  const billB = b.bill(vb, '2026-07-14', '2026-08-13', 108_100, 'bb');
  deps.store.db
    .prepare(
      `INSERT INTO skonto_term (id, workspace_id, scope_kind, scope_id, rate_bp, days, until_date, idempotency_key, created_by, created_at, updated_by, updated_at)
       VALUES ('skonto_foreign', ?, 'vendor', ?, 300, 30, NULL, 'foreign', 'x', '2026-07-16', 'x', '2026-07-16')`,
    )
    .run(a.workspaceId, vb);
  const planB = b.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'pb' });
  assert.equal(planB.plan.lines.find((l) => l.vendorBillId === billB).detail.skontoRateBp, 0, "A's term row priced B's bill");
});

test('[HOLDS] rows: two proposals on one book never put a bill into two runs; the second is refused as stale', () => {
  const w = book(depsAt());
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  const billId = w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p1 = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p1' });
  const p2 = w.call('liquidity_plan_propose', { floorMinor: 500_000, idempotencyKey: 'p2' });
  assert.notEqual(p1.planId, p2.planId);
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p1.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd1' }).ok, true);
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p2.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd2' }).error, 'stale_plan');
  const items = w.deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM payment_batch_item i JOIN payment_batch b ON b.id = i.batch_id WHERE i.workspace_id = ? AND i.vendor_bill_id = ? AND b.status IN ('draft','generated')`)
    .get(w.workspaceId, billId).n;
  assert.equal(items, 1);
});

test('[HOLDS] drafting writes DRAFT runs only: no pain.001, no journal row, no transmit, no paid mark', () => {
  const w = book(depsAt());
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const entries = count(w.deps, 'journal_entry', w.workspaceId);
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, true);
  // D148 freezes the pain.001 references at batch creation, so a draft now carries its msg_id; that a
  // file was produced is the frozen `generated_at` stamp, which a draft never has.
  for (const b of w.deps.store.db.prepare('SELECT status, generated_at, ctrl_sum_minor FROM payment_batch WHERE workspace_id = ?').all(w.workspaceId)) {
    assert.equal(b.status, 'draft');
    assert.equal(b.generated_at, null);
    assert.equal(b.ctrl_sum_minor, null);
  }
  assert.equal(count(w.deps, 'journal_entry', w.workspaceId), entries);
  const verbs = w.deps.store.db.prepare('SELECT DISTINCT verb FROM idempotency WHERE workspace_id = ?').all(w.workspaceId).map((r) => r.verb);
  for (const forbidden of ['generate_pain001', 'payment_batch_transmit', 'mark_batch_paid', 'record_payment']) assert.ok(!verbs.includes(forbidden), forbidden);
});

// --- an independent brute force: own calendar stepping, own money arithmetic, adversarial instances --

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const between = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const nextClr = (d) => {
  let x = plusDays(d, 1);
  while (!isClearingDay(x)) x = plusDays(x, 1);
  return x;
};
const arrive = (d, lag) => {
  let x = d;
  for (let i = 0; i < lag; i += 1) x = nextClr(x);
  return x;
};
const halfAway = (num, den) => Number((num * 2n + den) / (den * 2n));
const skOf = (A, bp) => halfAway(BigInt(A) * BigInt(bp), 10_000n);
const intOf = (A, bp, days) => (days <= 0 || bp <= 0 ? 0 : halfAway(BigInt(A) * BigInt(bp) * BigInt(days), 3_650_000n));

test('[HOLDS] independent brute force: proven means optimal, the bound bounds, every line re-prices exactly (holidays, big Rappen, ties, bp 0..2000)', () => {
  const rand = mulberry32(0xc417);
  const starts = ['2026-03-30', '2026-12-21', '2027-05-03', '2026-12-30', '2027-03-24', '2026-07-29', '2026-04-01'];
  let binding = 0;
  for (let n = 0; n < 220; n += 1) {
    const asOf = starts[n % starts.length];
    const T = 8 + Math.floor(rand() * 11);
    const dates = horizonDates(asOf, T);
    const scale = rand() < 0.3 ? 1_000_000 : 1; // up to ~CHF 4 billion in Rappen
    const ev = {};
    for (let k = 0; k < 3; k += 1) {
      const d = dates[Math.floor(rand() * T)];
      ev[d] = (ev[d] ?? 0) + Math.round((rand() - 0.4) * 300_000 * scale);
    }
    let run = Math.round(rand() * 400_000 * scale);
    const baseBalance = dates.map((d) => (run += ev[d] ?? 0));
    const floorMinor = rand() < 0.15 ? Math.min(...baseBalance) : Math.round(rand() * 150_000 * scale);
    const tie = rand() < 0.25;
    const bills = [];
    const nb = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < nb; i += 1) {
      const due = tie && i > 0 ? bills[0].dueDate : plusDays(asOf, Math.floor(rand() * (T + 6)) - 5);
      const sk = rand() < 0.6;
      const amt = tie && i > 0 ? bills[0].openMinor : Math.max(1, Math.round((rand() < 0.2 ? rand() * 5000 : 10_000 + rand() * 200_000) * scale));
      bills.push({ id: `b${i}`, openMinor: amt, dueDate: due, skontoRateBp: sk ? 50 + Math.floor(rand() * 950) : 0, skontoUntil: sk ? plusDays(due, -Math.floor(rand() * 12)) : null });
    }
    const lagDays = Math.floor(rand() * 3);
    const lateInterestBp = [0, 1, 500, 500, 2000][Math.floor(rand() * 5)];
    const input = { dates, baseBalance, floorMinor, bills, lagDays, lateInterestBp };
    const r = optimisePaymentPlan(input);

    // Every line re-priced independently, and the floor in its semantic form.
    const paidOn = new Array(T).fill(0);
    for (const l of r.lines) {
      if (l.option.date === null) continue;
      const b = bills.find((x) => x.id === l.billId);
      assert.ok(isClearingDay(l.option.date), `instance ${n}: ${l.option.date} is no clearing day`);
      const a = arrive(l.option.date, lagDays);
      assert.equal(l.option.arrival, a, `instance ${n}: arrival`);
      const until = b.skontoRateBp > 0 && b.skontoUntil !== null ? (b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate) : null;
      const cap = until !== null && a <= until ? skOf(b.openMinor, b.skontoRateBp) : 0;
      assert.equal(l.option.skontoMinor, cap, `instance ${n}: skonto`);
      assert.equal(l.option.interestMinor, intOf(b.openMinor, lateInterestBp, Math.max(0, between(b.dueDate, a))), `instance ${n}: interest`);
      assert.equal(l.option.cashMinor, b.openMinor - cap, `instance ${n}: cash`);
      paidOn[between(asOf, l.option.date)] += l.option.cashMinor;
    }
    let cum = 0;
    for (let s = 0; s < T; s += 1) {
      cum += paidOn[s];
      assert.ok(cum <= Math.max(0, baseBalance[s] - floorMinor), `instance ${n}: day ${s} breaks the floor`);
    }

    // The truth over EVERY clearing day of every decided bill (defer priced as the optimiser prices it).
    const clearing = dates.filter(isClearingDay);
    const deferArrival = arrive(nextClr(dates[T - 1]), lagDays);
    const options = r.lines.map((l) => {
      const b = bills.find((x) => x.id === l.billId);
      const until = b.skontoRateBp > 0 && b.skontoUntil !== null ? (b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate) : null;
      const K = until === null ? 0 : skOf(b.openMinor, b.skontoRateBp);
      const opts = clearing.map((x) => {
        const a = arrive(x, lagDays);
        const cap = until !== null && a <= until ? K : 0;
        return { day: between(asOf, x), cash: b.openMinor - cap, value: cap - intOf(b.openMinor, lateInterestBp, Math.max(0, between(b.dueDate, a))) };
      });
      const dueIn = l.detail.lastExecutionDue <= dates[T - 1];
      opts.push({ day: null, cash: 0, value: -intOf(b.openMinor, lateInterestBp, dueIn ? Math.max(1, between(b.dueDate, deferArrival)) : 0) });
      return opts;
    });
    const head = baseBalance.map((c) => Math.max(0, c - floorMinor));
    let best = Number.NEGATIVE_INFINITY;
    const paid = new Array(T).fill(0);
    const rec = (i, value) => {
      if (i === options.length) {
        let c = 0;
        for (let s = 0; s < T; s += 1) {
          c += paid[s];
          if (c > head[s]) return;
        }
        if (value > best) best = value;
        return;
      }
      for (const o of options[i]) {
        if (o.day !== null) paid[o.day] += o.cash;
        rec(i + 1, value + o.value);
        if (o.day !== null) paid[o.day] -= o.cash;
      }
    };
    rec(0, 0);
    assert.equal(r.optimality, 'proven', `instance ${n}`);
    assert.equal(r.objectiveMinor, best, `instance ${n}: proven ${r.objectiveMinor}, true optimum ${best}`);
    const cut = optimisePaymentPlan({ ...input, nodeBudget: 1 });
    assert.ok(cut.upperBoundMinor >= best, `instance ${n}: bound ${cut.upperBoundMinor} under the optimum ${best}`);
    assert.ok(cut.objectiveMinor <= best, `instance ${n}: an incumbent above the optimum`);
    if (r.lines.some((l) => /floor/.test(l.reason))) binding += 1;
  }
  assert.ok(binding >= 20, `only ${binding} instances had a binding floor`);
});
