/**
 * PRE-CLAIMED INNER KEYS (K1, 04.10.2026): one probe per composite verb that derives an inner write's
 * idempotency key from its own key.
 *
 * THE DEFECT CLASS. A composite verb (close_year, wage_journal_post, capture_commit, ...) calls an
 * inner write (postEntry, createVendorBill, createPaymentBatch, ...) with a key it derives from its own,
 * e.g. `${key}:wjp`. Before K1 that inner write stored its memo under the SAME idempotency scope as the
 * public verb of the same name (`post_entry`, `create_vendor_bill`, ...), so anyone who could call that
 * public verb with the derived key FIRST had their write replayed in place of the composite's: the
 * composite then answered ok over a foreign result. The realistic actor is an agent seat that drafts
 * the composite with its own key (a human approves it later) and meanwhile writes under the derived key.
 *
 * WHAT EACH PROBE ASSERTS: the pre-claim is made through the PUBLIC verb (or the engine function that
 * verb calls, with the same context), then the composite runs, and it must NEVER answer ok over the
 * foreign write. Either it does its own write (where only the idempotency memo was claimed) or it
 * refuses by name (where a domain table also holds the raw key unique, which turns the squat into a
 * refusal, never into wrong money). Each probe FAILED on develop 60302c09 and passes with K1's
 * internal idempotency scope (`SqliteStore.innerWrite`).
 *
 * Fixtures are synthetic by construction (invented names, the SIX sample IBAN, the BAZG sample feed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { captureIntake, captureExtract, captureCommit, getCapture, getVendorBill, createVendorBill } from '../../dist/core/purchase/index.js';
import { createClaim, upsertLine } from '../../dist/core/hr/index.js';
import { linkFile } from '../../dist/core/files/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup as purchaseSetup } from '../purchase/support.mjs';
import { addEmployee } from '../hr/support.mjs';
import { lastExecutionFor } from '../../dist/core/liquidity/index.js';

const IBAN = 'CH93 0076 2011 6238 5295 7';
const DAILY = readFileSync(new URL('../fx/fixtures/bazg-xmldaily-20260724.xml', import.meta.url), 'utf8');

function registryWorld(deps = freshDeps(), name = 'Beispiel GmbH') {
  const { workspaceId, accId } = mintWorkspace(deps, name, 'ws');
  const call = (verb, input = {}) => getAction(verb).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call, db: deps.store.db };
}

const entryOf = (db, ws, id) => db.prepare('SELECT id, source, idempotency_key, status FROM journal_entry WHERE workspace_id = ? AND id = ?').get(ws, id);
const linesOf = (db, id) =>
  db
    .prepare('SELECT a.number, l.debit_minor AS debit, l.credit_minor AS credit FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number')
    .all(id)
    .map((r) => ({ ...r }));

// --- wage_journal_post -> postEntry (`${key}:wjp`) --------------------------------------------

test('K1 wage_journal_post: a post_entry under the derived key `K:wjp` is never booked as the wage journal', () => {
  const w = registryWorld();
  const K = 'wjp-agent-1';
  // The squat: a CHF 1.00 manual posting through the public post_entry verb, under the derived key.
  const squat = w.call('post_entry', {
    date: '2026-07-05',
    source: 'manual',
    idempotencyKey: `${K}:wjp`,
    lines: [{ account: w.accId('6500'), debit: 100 }, { account: w.accId('1000'), credit: 100 }],
  });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const posted = w.call('wage_journal_post', {
    entryDate: '2026-07-05',
    confirm: true,
    idempotencyKey: K,
    lines: [
      { accountNumber: '5000', debitMinor: 500000 },
      { accountNumber: '5700', debitMinor: 50000 },
      { accountNumber: '2260', creditMinor: 550000 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.notEqual(posted.postedEntryId, squat.entryId, 'the wage journal answered ok over the squatter\'s CHF 1.00 entry');
  assert.deepEqual(linesOf(w.db, posted.postedEntryId), [
    { number: '2260', debit: 0, credit: 550000 },
    { number: '5000', debit: 500000, credit: 0 },
    { number: '5700', debit: 50000, credit: 0 },
  ]);
  assert.equal(entryOf(w.db, w.workspaceId, posted.postedEntryId).source, 'import');
  // The composite's own replay is unchanged.
  assert.deepEqual(w.call('wage_journal_post', { entryDate: '2026-07-05', confirm: true, idempotencyKey: K, lines: [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '5700', debitMinor: 50000 },
    { accountNumber: '2260', creditMinor: 550000 },
  ] }), posted);
});

// --- import_exchange_rates -> recordExchangeRate (`${key}:${series}:${ccy}:${asOf}`) -------------

test('K1 import_exchange_rates: a record_exchange_rate under a derived key never stands in for an imported rate', () => {
  const deps = freshDeps();
  deps.clock = { now: () => '2026-07-25T09:00:00.000Z' };
  const w = registryWorld(deps);
  const K = 'imp-agent-1';
  // The squat: a USD rate recorded under the key the import will use for EUR on 25.07.2026.
  const squat = w.call('record_exchange_rate', { baseCurrency: 'USD', rate: '0.5', asOf: '2026-07-01', idempotencyKey: `${K}:daily:EUR:2026-07-25` });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const res = w.call('import_exchange_rates', { payload: DAILY, currencies: ['EUR'], idempotencyKey: K });
  assert.equal(res.ok, true, JSON.stringify(res));
  const eur = w.db
    .prepare("SELECT rate, source FROM exchange_rate WHERE workspace_id = ? AND base_currency = 'EUR' AND as_of = '2026-07-25'")
    .get(w.workspaceId);
  assert.notEqual(eur, undefined, 'the import answered ok and listed EUR 25.07. as imported, but no EUR rate exists for that day');
  assert.deepEqual({ ...eur }, { rate: '0.93883', source: 'rate_api' });
  assert.ok(res.imported.some((r) => r.currency === 'EUR' && r.asOf === '2026-07-25'));
});

// --- liquidity_plan_draft_batches -> createPaymentBatch (`${key}:${date}`) -------------------------

function liquidityWorld() {
  const w = registryWorld();
  const { call, accId } = w;
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kantonalbank', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'capital',
    lines: [{ account: accId('1020'), debit: 5_000_000 }, { account: accId('2800'), credit: 5_000_000 }],
  });
  const vendor = call('create_contact', { partyRole: 'vendor', name: 'Server Hosting AG', idempotencyKey: 'v' }).contact.id;
  call('set_creditor_bank_profile', { vendorId: vendor, iban: IBAN, idempotencyKey: 'cbp' });
  const bill = (billDate, dueDate, amountMinor, key) =>
    call('record_expense', { vendorId: vendor, billDate, dueDate, amountMinor, amountIsGross: true, currency: 'CHF', taxCode: 'VST-M', expenseAccountId: accId('6500'), vendorReference: `RE-${key}`, idempotencyKey: key });
  const planned = bill('2026-07-06', '2026-08-05', 500_000, 'bill-planned');
  const other = bill('2026-07-07', '2026-08-06', 30_000, 'bill-other');
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(other.ok, true, JSON.stringify(other));
  return { ...w, bankAccountId: bank.bankAccountId, plannedBillId: planned.vendorBillId, otherBillId: other.vendorBillId };
}

test('K1 liquidity_plan_draft_batches: a create_payment_batch under `K:<date>` is never adopted as the plan\'s run', () => {
  const w = liquidityWorld();
  const K = 'draft-agent-1';
  const date = lastExecutionFor('2026-08-05', 1);
  // The squat, BEFORE the proposal (so the plan is fresh): a batch over the OTHER bill under the key
  // the draft will derive for the planned bill's execution date.
  const squat = w.call('create_payment_batch', { bankAccountId: w.bankAccountId, itemIds: [w.otherBillId], executionDate: date, idempotencyKey: `${K}:${date}` });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, idempotencyKey: 'plan' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.plan.lines.find((l) => l.vendorBillId === w.plannedBillId).payDate, date);

  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: K });
  if (d.ok) {
    // Only acceptable if the run it drafted is its own, over the planned bill.
    for (const b of d.batches) {
      assert.notEqual(b.batchId, squat.batchId, 'the draft answered ok and adopted the squatter\'s batch as the plan\'s run');
      const got = w.call('get_payment_batch', { batchId: b.batchId });
      assert.deepEqual(got.batch.items.map((i) => i.vendorBillId), [w.plannedBillId]);
    }
  } else {
    // The squatted domain key (payment_batch.idempotency_key is unique) refuses by name, and nothing moved.
    assert.equal(d.error, 'idempotency_key_conflict', JSON.stringify(d));
    assert.equal(w.call('liquidity_plan_get', { planId: p.planId }).plan.status, 'proposed');
  }
});

// --- capture_commit -> createVendorBill / attachReceipt / linkFile / createClaim / upsertLine -------

const RASTER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 4, 6, 8, 10, 12, 14, 16]).toString('base64');

function qrBill(amount = '100.00') {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', 'Beispiel Druckerei GmbH', 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    'SCOR', buildScorReference('K1PROBE'), '', 'EPD',
  ].join('\n');
}

function capturedBill(t, key = 'k') {
  const intake = captureIntake(t.ctx, { contentBase64: RASTER, mime: 'image/png', filename: 'beleg.png', idempotencyKey: `in-${key}` });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  const x = captureExtract(t.ctx, { captureId: intake.captureId, source: 'operator', qrPayload: qrBill(), idempotencyKey: `x-${key}` });
  assert.equal(x.ok, true, JSON.stringify(x));
  return intake.captureId;
}

test('K1 capture_commit (vendor bill): a create_vendor_bill under `K:<capture>:vb` is never committed as the capture\'s bill', () => {
  const t = purchaseSetup();
  const vendorId = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Druckerei GmbH', idempotencyKey: 'v' }).contact.id;
  const decoy = createContact(t.ctx, { partyRole: 'vendor', name: 'Andere AG', idempotencyKey: 'v2' }).contact.id;
  const captureId = capturedBill(t);
  const K = 'commit-agent-1';
  // The squat: a CHF 99'999.00 bill to ANOTHER vendor, under the key the commit derives (create_vendor_bill's engine function).
  const squat = createVendorBill(t.ctx, {
    vendorId: decoy, billDate: '2026-07-01', dueDate: '2026-07-31', amountMinor: 9_999_900, amountIsGross: true,
    expenseAccountId: t.acc('6500'), idempotencyKey: `${K}:${captureId}:vb`,
  });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'vendor_bill', vendorId, billDate: '2026-07-01', expenseAccountId: t.acc('6500') }, idempotencyKey: K });
  if (commit.ok) {
    assert.notEqual(commit.targetId, squat.vendorBillId, 'the capture was committed onto the squatter\'s CHF 99\'999.00 bill');
    const bill = getVendorBill(t.ctx, { vendorBillId: commit.targetId }).vendorBill;
    assert.equal(bill.grossMinor, 10000);
  } else {
    assert.equal(commit.error, 'idempotency_key_conflict', JSON.stringify(commit));
    assert.equal(getCapture(t.ctx, { captureId }).capture.status, 'needs_review', 'a refused commit leaves the capture open');
  }
});

test('K1 capture_commit (vendor bill): a files_link under `K:<capture>:lk` cannot stand in for the bill\'s link', () => {
  const t = purchaseSetup();
  const vendorId = createContact(t.ctx, { partyRole: 'vendor', name: 'Beispiel Druckerei GmbH', idempotencyKey: 'v' }).contact.id;
  const captureId = capturedBill(t);
  const documentId = getCapture(t.ctx, { captureId }).capture.documentId;
  const K = 'commit-agent-2';
  // The squat: link the receipt document to the vendor CONTACT under the key the commit derives.
  const squat = linkFile(t.ctx, { fileId: documentId, entityKind: 'contact', entityId: vendorId, idempotencyKey: `${K}:${captureId}:lk` });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'vendor_bill', vendorId, billDate: '2026-07-01', expenseAccountId: t.acc('6500') }, idempotencyKey: K });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const file = t.store.db.prepare('SELECT entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND id = ?').get(t.workspaceId, documentId);
  assert.deepEqual({ ...file }, { entity_kind: 'vendor_bill', entity_id: commit.targetId }, 'the commit answered ok while the receipt stayed linked where the squatter put it');
});

test('K1 capture_commit (expense line): an expense_claim_create under `K:<capture>:clm` never receives the capture\'s line', () => {
  const t = purchaseSetup();
  const { employeeId } = addEmployee(t.ctx);
  const other = addEmployee(t.ctx, { firstName: 'Kim', lastName: 'Beispiel', name: 'Kim Beispiel' }, 'emp2');
  const captureId = capturedBill(t);
  const K = 'commit-agent-3';
  // The squat: a claim for ANOTHER employee under the key the commit derives for the fresh claim.
  const squat = createClaim(t.ctx, { employeeId: other.employeeId, title: 'Fremde Abrechnung', idempotencyKey: `${K}:${captureId}:clm` });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'expense_line', employeeId, category: 'other', expenseDate: '2026-07-01' }, idempotencyKey: K });
  const onSquat = t.store.db.prepare('SELECT COUNT(*) AS n FROM expense_line WHERE workspace_id = ? AND claim_id = ?').get(t.workspaceId, squat.claimId).n;
  assert.equal(onSquat, 0, 'the capture\'s receipt was booked onto another employee\'s claim');
  if (!commit.ok) assert.equal(commit.error, 'idempotency_key_conflict', JSON.stringify(commit));
});

test('K1 capture_commit (expense line): an expense_line_upsert under `K:<capture>:eln` is never committed as the capture\'s line', () => {
  const t = purchaseSetup();
  const { employeeId } = addEmployee(t.ctx);
  const claim = createClaim(t.ctx, { employeeId, title: 'Juli', idempotencyKey: 'claim-juli' });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const captureId = capturedBill(t);
  const K = 'commit-agent-4';
  // The squat: a CHF 4'999.00 line on the SAME claim under the key the commit derives for its line.
  const squat = upsertLine(t.ctx, {
    claimId: claim.claimId,
    line: { expenseDate: '2026-07-01', category: 'other', amountMinor: 499_900, currency: 'CHF' },
    idempotencyKey: `${K}:${captureId}:eln`,
  });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const commit = captureCommit(t.ctx, { captureId, target: { kind: 'expense_line', claimId: claim.claimId, category: 'other', expenseDate: '2026-07-01' }, idempotencyKey: K });
  if (commit.ok) {
    assert.notEqual(commit.targetId, squat.lineId, 'the capture was committed onto the squatter\'s CHF 4\'999.00 line');
    const line = t.store.db.prepare('SELECT amount_minor FROM expense_line WHERE workspace_id = ? AND id = ?').get(t.workspaceId, commit.targetId);
    assert.equal(line.amount_minor, 10000);
  } else {
    // expense_line holds the raw key unique: the squat refuses by name, and the capture stays open.
    assert.equal(commit.error, 'idempotency_key_conflict', JSON.stringify(commit));
    assert.equal(getCapture(t.ctx, { captureId }).capture.status, 'needs_review');
  }
});
