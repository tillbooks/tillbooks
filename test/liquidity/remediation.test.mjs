/**
 * A40 critic remediation (docs/critique/a40-payment-timing-critique.md):
 * the author's own proofs for the findings the critic's suite does not pin by itself. Each test names
 * the finding it proves. Synthetic books only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { lastExecutionFor } from '../../dist/core/liquidity/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IBAN = 'CH93 0076 2011 6238 5295 7';

function depsAt(iso = '2026-07-16T08:00:00.000Z') {
  const store = new SqliteStore({ clock: fixedClock(iso) });
  return { store, clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

function book(deps = depsAt(), name = 'Beispiel Werkstatt GmbH', wsKey = 'ws') {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey: wsKey });
  const workspaceId = res.workspaceId;
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
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

// --- M1: MWST already overdue is read off the ledger; the debit arrives by the due date (L6) --------

test('M1: an unpaid MWST liability of a period already past its due date is an outflow today; a paid one is not', () => {
  const w = book();
  // Q1 2026 output tax, posted in March, due 30.5.: still on 2200 on 16.7.
  const sale = w.call('post_entry', {
    date: '2026-03-10',
    source: 'manual',
    idempotencyKey: 'q1-sale',
    lines: [
      { account: w.accId('1100'), debit: 1_081_000 },
      { account: w.accId('3200'), credit: 1_000_000, taxCode: 'UST81' },
      { account: w.accId('2200'), credit: 81_000 },
    ],
  });
  assert.equal(sale.ok, true, JSON.stringify(sale));
  const f = w.call('liquidity_forecast', {});
  const overdue = f.flows.filter((x) => x.kind === 'vat' && x.provenance === 'vat_overdue');
  assert.deepEqual(overdue.map((x) => [x.date, x.amountMinor, x.ref]), [['2026-07-16', -81_000, '2026-Q1']]);
  // Paid to the ESTV: the liability is gone, and so is the flow.
  w.call('post_entry', {
    date: '2026-05-28',
    source: 'manual',
    idempotencyKey: 'q1-paid',
    lines: [
      { account: w.accId('2200'), debit: 81_000 },
      { account: w.accId('1020'), credit: 81_000 },
    ],
  });
  const g = w.call('liquidity_forecast', {});
  assert.equal(g.flows.filter((x) => x.kind === 'vat' && x.provenance === 'vat_overdue').length, 0);
});

test('M2: a customer payment booked ahead is counted once, on its own date, not also as the open invoice', () => {
  const w = book();
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Vorauszahler AG', idempotencyKey: 'c' }).contact.id;
  const doc = w.call('create_document', {
    type: 'invoice',
    contactId: cust,
    currency: 'CHF',
    dueDate: '2026-07-31',
    lines: [{ description: 'Montage', unitPriceMinor: 100_000, taxCode: 'UST81' }],
    idempotencyKey: 'inv',
  });
  w.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'iss' });
  const paid = w.call('record_payment', {
    direction: 'incoming',
    date: '2026-07-24',
    amountMinor: 108_100,
    bankAccountId: w.accId('1020'),
    intent: 'post_payment',
    counterpartyKind: 'customer',
    counterpartyId: cust,
    allocations: [{ documentId: doc.document.id, amountMinor: 108_100 }],
    idempotencyKey: 'pay',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const f = w.call('liquidity_forecast', {});
  const booked = f.flows.filter((x) => x.kind === 'booked');
  assert.deepEqual(booked.map((x) => [x.date, x.amountMinor]), [['2026-07-24', 108_100]]);
  assert.equal(f.flows.filter((x) => x.kind === 'receivable' && x.ref === doc.document.id).length, 0, 'counted twice');
  assert.equal(f.days.find((d) => d.date === '2026-07-24').balanceMinor, 5_000_000 + 108_100);
});

// --- M6: restore. The columns with one target declare REFERENCES; the polymorphic one waits for G04. ---

function restoredWorld() {
  const deps = depsAt();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-a40-m6-'));
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
  return { db: deps.store.db, ws: restored.workspaceId };
}

test('M6: the declared plan-line references land on rows of the restored workspace', () => {
  const { db, ws } = restoredWorld();
  const inWs = (table, id) => db.prepare(`SELECT 1 AS x FROM ${table} WHERE workspace_id = ? AND id = ?`).get(ws, id) !== undefined;
  const lines = db.prepare('SELECT vendor_bill_id, vendor_id, batch_id FROM payment_plan_line WHERE workspace_id = ?').all(ws);
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(inWs('vendor_bill', l.vendor_bill_id), `vendor_bill_id ${l.vendor_bill_id}`);
    if (l.vendor_id !== null) assert.ok(inWs('contact', l.vendor_id), `vendor_id ${l.vendor_id}`);
    if (l.batch_id !== null) assert.ok(inWs('payment_batch', l.batch_id), `batch_id ${l.batch_id}`);
  }
});

test('M6: a restored Skonto term still names its supplier or bill in the restored workspace', {}, () => {
  const { db, ws } = restoredWorld();
  for (const t of db.prepare('SELECT scope_kind, scope_id FROM skonto_term WHERE workspace_id = ?').all(ws)) {
    const table = t.scope_kind === 'vendor' ? 'contact' : 'vendor_bill';
    assert.ok(db.prepare(`SELECT 1 AS x FROM ${table} WHERE workspace_id = ? AND id = ?`).get(ws, t.scope_id) !== undefined, `${t.scope_kind} ${t.scope_id}`);
  }
});

test('M9: the forecast counts and sums the assumptions that can break the floor', () => {
  const w = book();
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Neukunde AG', idempotencyKey: 'c' }).contact.id;
  const doc = w.call('create_document', {
    type: 'invoice',
    contactId: cust,
    currency: 'CHF',
    dueDate: '2026-07-31',
    lines: [{ description: 'Erstauftrag', unitPriceMinor: 100_000, taxCode: 'UST81' }],
    idempotencyKey: 'inv',
  });
  w.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'iss' });
  const f = w.call('liquidity_forecast', {});
  assert.deepEqual(f.assumptions.noHistory, { count: 1, amountMinor: 108_100 });
  assert.deepEqual(f.assumptions.pooledHistory, { count: 0, amountMinor: 0 });
  assert.equal(f.assumptions.openingSource, 'ledger');
  assert.equal(f.assumptions.accountCount, 1);
  assert.equal(f.assumptions.lastPossibleDay, true);
});

test('L4: a parked customer credit is named in excluded, never silently skipped', () => {
  const w = book();
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Vorschuss AG', idempotencyKey: 'c' }).contact.id;
  const parked = w.call('record_payment', {
    direction: 'incoming',
    date: '2026-07-10',
    amountMinor: 50_000,
    bankAccountId: w.accId('1020'),
    intent: 'post_payment',
    counterpartyKind: 'customer',
    counterpartyId: cust,
    onAccountMinor: 50_000,
    idempotencyKey: 'parked',
  });
  assert.equal(parked.ok, true, JSON.stringify(parked));
  const f = w.call('liquidity_forecast', {});
  assert.ok(f.excluded.some((x) => x.reason === 'customer_credit'), JSON.stringify(f.excluded));
});

test('L5: a bill landed by a second writer between the checks and the write makes the draft stale, and nothing is drafted', () => {
  const w = book();
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  // The D12 race, made deterministic: the moment the draft opens its write transaction, another writer
  // has just posted a bill. Before the fix the freshness proof ran OUTSIDE the transaction and missed it.
  const store = w.deps.store;
  const original = store.rememberIdempotent.bind(store);
  let raced = false;
  store.rememberIdempotent = (ws, key, verb, compute) => {
    if (verb === 'liquidity_plan_draft_batches' && !raced) {
      raced = true;
      w.bill(v, '2026-07-15', '2026-08-14', 70_000, 'second-writer');
    }
    return original(ws, key, verb, compute);
  };
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  store.rememberIdempotent = original;
  assert.equal(raced, true);
  assert.equal(d.error, 'stale_plan', JSON.stringify(d));
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM payment_batch WHERE workspace_id = ?').get(w.workspaceId).n, 0);
});

test('L7: a reused propose key replays the same plan in its CURRENT status', () => {
  const w = book();
  const v = w.vendor('Hosting AG', 'v1');
  w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN, idempotencyKey: 'cbp' });
  w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  assert.equal(p.plan.status, 'proposed');
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' }).ok, true);
  const again = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'p' });
  assert.equal(again.planId, p.planId);
  assert.equal(again.plan.status, 'drafted');
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM payment_plan WHERE workspace_id = ?').get(w.workspaceId).n, 1);
});

test('L6: the MWST debit sits on the last clearing day that still ARRIVES by the due date', () => {
  // On 1.9.2026 the Q3 period (due 29.11., a Sunday) is in the horizon; at lag 1 the debit is Thursday 26.11.
  const w = book(depsAt('2026-09-01T08:00:00.000Z'));
  w.call('post_entry', {
    date: '2026-08-10',
    source: 'manual',
    idempotencyKey: 'q3-sale',
    lines: [
      { account: w.accId('1100'), debit: 108_100 },
      { account: w.accId('3200'), credit: 100_000, taxCode: 'UST81' },
      { account: w.accId('2200'), credit: 8_100 },
    ],
  });
  const f = w.call('liquidity_forecast', {});
  const q3 = f.flows.find((x) => x.kind === 'vat' && x.ref === '2026-Q3');
  assert.equal(q3.date, lastExecutionFor('2026-11-29', 1));
  assert.equal(q3.date, '2026-11-26');
  assert.equal(q3.amountMinor, -8_100);
});
