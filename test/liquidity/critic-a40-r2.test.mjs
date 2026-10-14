/**
 * A40 payment timing, critic ROUND 2 (docs/critique/a40-payment-timing-critique-r2.md): the non-author
 * critic's probes of the remediation at head 462de6a8.
 *
 * `[FINDING R2-xx]` fails on that head and names a defect the remediation left or introduced;
 * `[HOLDS]` passes there and pins a remediated property the critic attacked and could not break.
 *
 * Every fixture is SYNTHETIC by construction: invented company names, the SIX sample IBANs, invented
 * amounts and dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { optimisePaymentPlan, horizonDates, isClearingDay } from '../../dist/core/liquidity/index.js';

const IBAN_A = 'CH93 0076 2011 6238 5295 7';
const IBAN_B = 'CH56 0483 5012 3456 7800 9';

function depsAt(iso = '2026-07-16T08:00:00.000Z') {
  const store = new SqliteStore({ clock: fixedClock(iso) });
  return { store, clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

/** VAT configured (effektiv), a Kontokorrent on 1020 with CHF 50'000 capital posted on 1.7. */
function book(deps, name = 'Beispiel Handels GmbH') {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey: 'ws' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN_A, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'capital',
    lines: [
      { account: accId('1020'), debit: 5_000_000 },
      { account: accId('2800'), credit: 5_000_000 },
    ],
  });
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

// =================================================================================================
// R2-H1: the M8 refusal suggests a floor at which nothing before the low day can be paid
// =================================================================================================

test('[FINDING R2-H1] lowering the floor to suggestedFloorMinor lets the bills due before the low day be paid on time', () => {
  const w = book(depsAt());
  // A CHF 35'000 tax instalment on 15.9. takes the base to CHF 15'000, under a CHF 20'000 floor.
  w.call('liquidity_flow_set', { label: 'Steuerrate', direction: 'out', amountMinor: 3_500_000, currency: 'CHF', firstDate: '2026-09-15', recurrence: 'once', idempotencyKey: 'tax' });
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN_A, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-07-27', 500_000, 'b1');
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b2');
  const refused = w.call('liquidity_plan_propose', { floorMinor: 2_000_000, bankAccountIds: [w.bankAccountId], idempotencyKey: 'p1' });
  assert.equal(refused.error, 'floor_breached_by_schedule');
  // The Studio's first button: "Mindestbestand auf {suggested} senken".
  const lowered = w.call('liquidity_plan_propose', { floorMinor: refused.suggestedFloorMinor, bankAccountIds: [w.bankAccountId], idempotencyKey: 'p2' });
  assert.equal(lowered.ok, true, JSON.stringify(lowered));
  const late = lowered.plan.lines.filter((l) => l.daysLate > 0);
  assert.deepEqual(
    late.map((l) => [l.detail.dueDate, l.payDate, l.daysLate, l.reason]),
    [],
    `the "lower the floor" path defers ${late.length} bill(s) the owner never accepted as late (floor ${refused.suggestedFloorMinor}; paying both on time keeps CHF 5'000)`,
  );
});

// =================================================================================================
// R2-M1: tax on 2200 without a tax code is dated "overdue, today"
// =================================================================================================

test('[FINDING R2-M1] Q3 output tax on the books (no tax code, e.g. a cutover opening) is not debited as overdue months before Q3 is due', () => {
  const w = book(depsAt());
  const ob = w.call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    description: 'Eröffnung: MWST Juli aus dem Vorsystem',
    idempotencyKey: 'ob-vat',
    lines: [
      { account: w.accId('1020'), debit: 400_000 },
      { account: w.accId('2200'), credit: 400_000 },
    ],
  });
  assert.equal(ob.ok, true, JSON.stringify(ob));
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.equal(f.ok, true, JSON.stringify(f));
  // 16.7.2026: Q1 was due 30.5. (nothing owed), Q2 is due 29.8., Q3 on 29.11. Nothing is overdue today.
  const early = f.flows.filter((x) => x.kind === 'vat' && x.date < '2026-08-01');
  assert.deepEqual(early.map((x) => [x.date, x.amountMinor, x.provenance]), [], 'Q3 tax booked on 1.7. is debited on 16.7. as "overdue"');
});

// =================================================================================================
// R2-M2: a per-account plan credits the account with receipts that land on another account
// =================================================================================================

test('[FINDING R2-M2] a forecast solved on the paying account does not count customer receipts that the QR-bill sends to another account', () => {
  const w = book(depsAt());
  // Invoices are paid to the Kontokorrent (the creditor IBAN on every QR-bill); runs are paid from a
  // second CHF account.
  assert.equal(w.call('set_creditor_profile', { creditorName: 'Beispiel Handels GmbH', iban: IBAN_A }).ok, true);
  const acc = w.call('create_account', { number: '1021', name: 'Bank Zahlungskonto', type: 'asset', idempotencyKey: 'acc2' });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  const pay = w.call('create_bank_account', { name: 'Zahlungskonto', iban: IBAN_B, currency: 'CHF', ledgerAccountId: w.accId('1021'), idempotencyKey: 'bank2' });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' }).contact.id;
  const doc = w.call('create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-08-14', lines: [{ description: 'Beratung', unitPriceMinor: 2_000_000, taxCode: 'UST81' }], idempotencyKey: 'd' });
  assert.equal(w.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'i' }).ok, true);
  const f = w.call('liquidity_forecast', { bankAccountIds: [pay.bankAccountId] });
  assert.equal(f.ok, true, JSON.stringify(f));
  const credited = f.flows.filter((x) => x.kind === 'receivable');
  assert.deepEqual(credited.map((x) => [x.date, x.amountMinor]), [], 'a CHF 21\'620 receipt that lands on the Kontokorrent is counted on the Zahlungskonto');
});

// =================================================================================================
// R2-L1: the delegated payment_batch.created carries a thinner payload than A18's own
// =================================================================================================

test('[FINDING R2-L1] a payment_batch.created rule conditioned on input.executionDate treats an A40 run like an A18 run', () => {
  const deps = depsAt();
  const w = book(deps);
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN_A, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, bankAccountIds: [w.bankAccountId], idempotencyKey: 'p' });
  const execDate = p.plan.lines[0].payDate;
  const rule = w.call('create_automation_rule', {
    name: 'Zahlungslauf am Stichtag',
    trigger: { event: 'payment_batch.created' },
    condition: { all: [{ field: 'input.executionDate', op: 'eq', value: execDate }] },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: v, segments: ['zahlungslauf'] } },
    idempotencyKey: 'rule',
  });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  const statuses = () => deps.store.db.prepare('SELECT status FROM automation_run WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId).map((r) => r.status);
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const afterA40 = statuses();
  // Control: the same condition through A18's own door, for another bill on the same date.
  const other = w.bill(v, '2026-07-07', '2026-08-06', 200_000, 'b2');
  assert.equal(w.call('create_payment_batch', { bankAccountId: w.bankAccountId, itemIds: [other], executionDate: execDate, idempotencyKey: 'direct' }).ok, true);
  const all = statuses();
  assert.equal(all[all.length - 1], 'ok', 'control: the condition holds for the A18 run');
  assert.deepEqual(afterA40, ['ok'], 'the A40 run published payment_batch.created without executionDate, so the condition was skipped');
});

// =================================================================================================
// HOLDS
// =================================================================================================

test('[HOLDS] M7: a replayed draft key and a refused draft publish nothing twice and nothing at all', () => {
  const deps = depsAt();
  const w = book(deps);
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN_A, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  w.call('create_automation_rule', {
    name: 'Neuer Zahlungslauf',
    trigger: { event: 'payment_batch.created' },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: v, segments: ['lauf'] } },
    idempotencyKey: 'rule',
  });
  const runs = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ?').get(w.workspaceId).n;
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, bankAccountIds: [w.bankAccountId], idempotencyKey: 'p' });
  // A refused draft (another account) publishes nothing.
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: 'bank_x', idempotencyKey: 'bad' }).ok, false);
  assert.equal(runs(), 0);
  const d1 = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  assert.equal(runs(), 1);
  assert.deepEqual(w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' }).batches, d1.batches);
  assert.equal(runs(), 1, 'a replay fired the rule a second time');
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd2' }).error, 'already_drafted');
  assert.equal(runs(), 1);
});

test('[HOLDS] M5: one open proposal per book state (DB-enforced); a drafted plan is never replayed; discard frees a new one', () => {
  const w = book(depsAt());
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN_A, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const args = { floorMinor: 1_000_000, bankAccountIds: [w.bankAccountId] };
  const p1 = w.call('liquidity_plan_propose', { ...args, idempotencyKey: 'k1' });
  const p1b = w.call('liquidity_plan_propose', { ...args, idempotencyKey: 'k2' });
  assert.equal(p1b.planId, p1.planId);
  assert.equal(p1b.replayed, true);
  const db = w.deps.store.db;
  const row = db.prepare('SELECT * FROM payment_plan WHERE id = ?').get(p1.planId);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO payment_plan (id, workspace_id, status, as_of, horizon_end, currency, floor_minor, params_json, inputs_hash, inputs_json,
             objective_minor, skonto_captured_minor, late_interest_minor, optimality, upper_bound_minor, nodes_explored, min_balance_minor,
             min_balance_date, idempotency_key, created_at)
           VALUES ('pplan_dup', ?, 'proposed', ?, ?, 'CHF', ?, ?, ?, ?, 0, 0, 0, 'proven', 0, 0, 0, ?, 'dup', ?)`,
        )
        .run(row.workspace_id, row.as_of, row.horizon_end, row.floor_minor, row.params_json, row.inputs_hash, row.inputs_json, row.min_balance_date, row.created_at),
    /UNIQUE/,
  );
  const d = w.call('liquidity_plan_draft_batches', { planId: p1.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd1' });
  for (const b of d.batches) w.call('discard_payment_batch', { batchId: b.batchId, idempotencyKey: `x-${b.batchId}` });
  const p2 = w.call('liquidity_plan_propose', { ...args, idempotencyKey: 'k3' });
  assert.notEqual(p2.planId, p1.planId);
  assert.equal(p2.plan.status, 'proposed');
  const p2b = w.call('liquidity_plan_propose', { ...args, idempotencyKey: 'k4' });
  assert.equal(p2b.planId, p2.planId, 'the new open plan is again the one answer for these books');
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p2.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd2' }).ok, true);
});

// --- lexicographic brute force on the NEW optimiser: worth first, then days late ------------------

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

test('[HOLDS] H1 remediation: proven is optimal in worth AND lateness, bounds hold, and no bill is ever late for nothing', () => {
  const rand = mulberry32(0xa402);
  const starts = ['2026-03-30', '2026-12-21', '2027-05-03', '2026-07-16', '2026-07-29'];
  let lateSeen = 0;
  for (let n = 0; n < 200; n += 1) {
    const asOf = starts[n % starts.length];
    const T = 8 + Math.floor(rand() * 11);
    const dates = horizonDates(asOf, T);
    const scale = rand() < 0.3 ? 1_000_000 : 1;
    const ev = {};
    for (let k = 0; k < 3; k += 1) {
      const d = dates[Math.floor(rand() * T)];
      ev[d] = (ev[d] ?? 0) + Math.round((rand() - 0.4) * 300_000 * scale);
    }
    let run = Math.round(rand() * 400_000 * scale);
    const baseBalance = dates.map((d) => (run += ev[d] ?? 0));
    const floorMinor = rand() < 0.15 ? Math.min(...baseBalance) : Math.round(rand() * 150_000 * scale);
    const bills = [];
    const nb = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < nb; i += 1) {
      const due = plusDays(asOf, Math.floor(rand() * (T + 6)) - 5);
      const sk = rand() < 0.5;
      const amt = Math.max(1, Math.round((rand() < 0.35 ? rand() * 5000 : 10_000 + rand() * 200_000) * scale));
      bills.push({ id: `b${i}`, openMinor: amt, dueDate: due, skontoRateBp: sk ? 50 + Math.floor(rand() * 950) : 0, skontoUntil: sk ? plusDays(due, -Math.floor(rand() * 12)) : null });
    }
    const lagDays = Math.floor(rand() * 3);
    const lateInterestBp = [0, 0, 1, 500, 2000][Math.floor(rand() * 5)];
    const input = { dates, baseBalance, floorMinor, bills, lagDays, lateInterestBp };
    const r = optimisePaymentPlan(input);

    const clearing = dates.filter(isClearingDay);
    const deferArrival = arrive(nextClr(dates[T - 1]), lagDays);
    const options = r.lines.map((l) => {
      const b = bills.find((x) => x.id === l.billId);
      const until = b.skontoRateBp > 0 && b.skontoUntil !== null ? (b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate) : null;
      const K = until === null ? 0 : skOf(b.openMinor, b.skontoRateBp);
      const opts = clearing.map((x) => {
        const a = arrive(x, lagDays);
        const cap = until !== null && a <= until ? K : 0;
        const late = Math.max(0, between(b.dueDate, a));
        return { day: between(asOf, x), cash: b.openMinor - cap, value: cap - intOf(b.openMinor, lateInterestBp, late), late };
      });
      const dueIn = l.detail.lastExecutionDue <= dates[T - 1];
      const dl = dueIn ? Math.max(1, between(b.dueDate, deferArrival)) : 0;
      opts.push({ day: null, cash: 0, value: -intOf(b.openMinor, lateInterestBp, dl), late: dl });
      return opts;
    });
    const head = baseBalance.map((c) => Math.max(0, c - floorMinor));
    let best = Number.NEGATIVE_INFINITY;
    let bestLate = Number.POSITIVE_INFINITY;
    const paid = new Array(T).fill(0);
    const rec = (i, value, late) => {
      if (i === options.length) {
        let c = 0;
        for (let s = 0; s < T; s += 1) {
          c += paid[s];
          if (c > head[s]) return;
        }
        if (value > best || (value === best && late < bestLate)) {
          best = value;
          bestLate = late;
        }
        return;
      }
      for (const o of options[i]) {
        if (o.day !== null) paid[o.day] += o.cash;
        rec(i + 1, value + o.value, late + o.late);
        if (o.day !== null) paid[o.day] -= o.cash;
      }
    };
    rec(0, 0, 0);
    assert.equal(r.optimality, 'proven', `instance ${n}`);
    assert.equal(r.objectiveMinor, best, `instance ${n}: worth`);
    assert.equal(r.lines.reduce((s, l) => s + l.option.daysLate, 0), bestLate, `instance ${n}: days late`);

    for (const res of [r, optimisePaymentPlan({ ...input, nodeBudget: 1 })]) {
      assert.ok(res.upperBoundMinor >= best, `instance ${n}: bound under the optimum`);
      const paidOn = new Array(T).fill(0);
      for (const l of res.lines) if (l.option.date !== null) paidOn[between(asOf, l.option.date)] += l.option.cashMinor;
      let c = 0;
      for (let s = 0; s < T; s += 1) {
        c += paidOn[s];
        assert.ok(c <= head[s], `instance ${n}: floor broken on day ${s}`);
      }
      // Never late for nothing: a late line whose on-time day exists must not fit there alone.
      const firstC = clearing[0];
      for (const l of res.lines) {
        if (l.option.daysLate === 0 || l.detail.lastExecutionDue < firstC || l.detail.lastExecutionDue > dates[T - 1]) continue;
        lateSeen += 1;
        const moved = [...paidOn];
        if (l.option.date !== null) moved[between(asOf, l.option.date)] -= l.option.cashMinor;
        moved[between(asOf, l.detail.lastExecutionDue)] += bills.find((x) => x.id === l.billId).openMinor;
        let m = 0;
        let fits = true;
        for (let s = 0; s < T; s += 1) {
          m += moved[s];
          if (m > head[s]) fits = false;
        }
        assert.equal(fits, false, `instance ${n}: ${l.billId} is late (${l.reason}) though its on-time day fits`);
      }
    }
  }
  assert.ok(lateSeen >= 20, `only ${lateSeen} late lines exercised`);
});
