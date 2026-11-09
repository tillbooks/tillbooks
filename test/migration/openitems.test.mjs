/**
 * G21, open-items AR/AP migration: the money-path invariants the spec turns on, proven by
 * measurement.
 *
 * THE ONE SENTENCE UNDER TEST: a migrated open item posts NOTHING of its own. Its only ledger effect
 * is A04's opening 1100 (AR) / 2000 (AP) line. So the assertions worth the most here are:
 *
 *  - NO SECOND POSTING PATH: importing N migrated items adds ZERO journal entries (only A04's opening
 *    entry stands), and every migrated row's posted_entry_id / entry_id is NULL. It BITES: a mutation
 *    that made the migrated path obtain a poster would add an entry and turn the count red.
 *  - IDEMPOTENT ON ROWS: a second import under the same key yields exactly one document/bill per
 *    source item, never two (row count before/after the replay).
 *  - §H-TENANT: an import writes only into its own workspace, and neither control read crosses.
 *  - THE CONTROL TIE-OUTS: ar_control/ap_control equal Σ(open) − opening line to the Rappen; a
 *    1-Rappen injected discrepancy makes the control red (not_asserted never green).
 *  - REVERSAL / IMMUTABILITY: a migrated document's amounts have no UPDATE path (illegal_transition),
 *    and cancelling one posts nothing.
 *  - THE SOLL/IST FORK: under Soll a migrated invoice contributes no output VAT to A07 (it posts
 *    nothing); under Ist A14 settlement stamps the paid-portion VAT off the STORED code+base+tax.
 *  - NUMBERING UNTOUCHED: a migrated import never advances a native number series.
 *
 * MONEY-PATH NOTE (CLAUDE.md): drafted by the capability author; the non-author critic on this
 * capability must confirm these bite before the branch lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, secondWorkspace } from '../payments/support.mjs';
import { createContact, updateDocument, transitionDocument, assertTransition } from '../../dist/core/sales/index.js';
import { setOpeningBalances } from '../../dist/core/ledger/index.js';
import { createPlan, importOpenItems, previewOpenItems } from '../../dist/core/migration/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { listVendorBills } from '../../dist/core/purchase/index.js';
import { computeVatReturn } from '../../dist/core/vat/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';

const CUTOVER = '2026-06-30';
const ISSUE = '2026-06-15';
const DUE = '2026-07-15';
// The canonical fixture: net 100000 + 8.1% 8100 = gross 108100.
const NET = 100000;
const TAX = 8100;
const GROSS = 108100;

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function journalEntryCount(store, workspaceId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
}

function expenseAccountId(store, workspaceId) {
  return store.db
    .prepare("SELECT id FROM account WHERE workspace_id = ? AND type = 'expense' AND number NOT IN ('1170','1171') ORDER BY number LIMIT 1")
    .get(workspaceId).id;
}

/** A world with an opening 1100 = openingArMinor and 2000 = openingApMinor, balanced through 2800. */
function world({ timing = 'soll', openingArMinor = GROSS, openingApMinor = 0 } = {}) {
  const t = setup({ timing });
  const plan = must(
    createPlan(t.ctx, { sourceSystem: 'csv', cutoverDate: CUTOVER, idempotencyKey: 'plan-1' }),
    'createPlan',
  );
  const lines = [];
  let equity = 0;
  if (openingArMinor > 0) {
    lines.push({ account: '1100', debitMinor: openingArMinor });
    equity += openingArMinor;
  }
  if (openingApMinor > 0) {
    lines.push({ account: '2000', creditMinor: openingApMinor });
    equity -= openingApMinor;
  }
  // Balance the position through equity (2800), either side as needed.
  if (equity > 0) lines.push({ account: '2800', creditMinor: equity });
  else if (equity < 0) lines.push({ account: '2800', debitMinor: -equity });
  // No open position at all (the live-settled case): seed no opening entry, so the control reads a
  // clean not_asserted rather than a fabricated zero.
  if (lines.length > 0) {
    must(
      setOpeningBalances(t.ctx, { asOf: '2026-01-01', lines, idempotencyKey: 'opening-1' }),
      'setOpeningBalances',
    );
  }
  return { t, planId: plan.planId };
}

/** One AR open item worth `gross` (net 100000 + 8.1%). */
function arRow(t, { number = 'SRC-001', gross = GROSS, taxCode = 'UST81', settled } = {}) {
  const net = Math.round((gross / GROSS) * NET);
  const tax = gross - net;
  return {
    contactId: t.customerId,
    number,
    issueDate: ISSUE,
    dueDate: DUE,
    currency: 'CHF',
    declaredTotalMinor: gross,
    lines: [{ description: 'Übernommene Rechnung', netMinor: net, taxMinor: tax, taxCode, supplyDate: ISSUE }],
    ...(settled !== undefined ? { settled } : {}),
  };
}

// --- No second posting path ---------------------------------------------------------------------

test('AR import posts NOTHING: no new journal entry, posted_entry_id NULL, control green', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const before = journalEntryCount(t.store, t.workspaceId);
  const res = must(
    importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-ar' }),
    'importOpenItems ar',
  );
  const after = journalEntryCount(t.store, t.workspaceId);

  assert.equal(res.importedCount, 1);
  // THE BITE: importing a migrated item added ZERO journal entries (only A04's opening entry stands).
  assert.equal(after, before, 'a migrated import must post nothing: journal entry count must not move');

  const row = t.store.db
    .prepare("SELECT posted_entry_id, origin, status FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  assert.equal(row.posted_entry_id, null, 'a migrated document carries NO posted entry');
  assert.equal(row.origin, 'migrated');
  assert.equal(row.status, 'issued');

  // The tie-out is green: the migrated open total equals the 1100 opening line to the Rappen.
  assert.equal(res.control.status, 'passed');
  assert.equal(res.control.differenceMinor, 0);

  // And it appears NATIVELY in A16, reconciled inclusive of the migrated item.
  const list = must(listOpenItems(t.ctx, { asOf: CUTOVER }), 'listOpenItems');
  assert.equal(list.reconciled, true, 'A16 reconciles inclusive of the migrated open item');
  assert.equal(list.workspaceBaseTotalOpenMinor, GROSS);
  const item = list.items.find((i) => i.number === 'SRC-001');
  assert.ok(item, 'the migrated item shows in the Debitoren open-item list');
  assert.equal(item.openMinor, GROSS);
});

test('AP import posts NOTHING: no new journal entry, entry_id NULL, ap_control green', () => {
  const { t, planId } = world({ openingApMinor: GROSS });
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant AG', idempotencyKey: 'v1' }), 'vendor').contact.id;
  const expense = expenseAccountId(t.store, t.workspaceId);
  const before = journalEntryCount(t.store, t.workspaceId);

  const res = must(
    importOpenItems(t.ctx, {
      planId,
      side: 'ap',
      rows: [
        {
          vendorId: vendor,
          number: 'BILL-001',
          billDate: ISSUE,
          dueDate: DUE,
          currency: 'CHF',
          netMinor: NET,
          taxAmountMinor: TAX,
          grossMinor: GROSS,
          taxCode: 'VST-M',
          expenseAccountId: expense,
        },
      ],
      idempotencyKey: 'imp-ap',
    }),
    'importOpenItems ap',
  );
  assert.equal(journalEntryCount(t.store, t.workspaceId), before, 'a migrated AP import posts nothing');

  const bill = t.store.db
    .prepare("SELECT entry_id, origin, status FROM vendor_bill WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  assert.equal(bill.entry_id, null, 'a migrated vendor bill carries NO posting entry');
  assert.equal(bill.status, 'posted');
  assert.equal(res.control.status, 'passed');
  assert.equal(res.control.differenceMinor, 0);

  const bills = must(listVendorBills(t.ctx, {}), 'listVendorBills');
  assert.equal(bills.reconciled, true, 'A17 reconciles inclusive of the migrated bill');
  assert.equal(bills.workspaceBaseTotalOpenMinor, GROSS);
});

// --- Idempotent on ROWS -------------------------------------------------------------------------

test('import twice under one key yields exactly ONE document per source item', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const input = { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-once' };
  must(importOpenItems(t.ctx, input), 'first import');
  const countAfterFirst = t.store.db
    .prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId).n;
  must(importOpenItems(t.ctx, input), 'replay import');
  const countAfterReplay = t.store.db
    .prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId).n;
  assert.equal(countAfterFirst, 1);
  assert.equal(countAfterReplay, 1, 'a replay under the same key must not mint a second row');
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('an import writes only into its own workspace; neither control read crosses', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const nb = secondWorkspace(t);
  must(importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-t' }), 'import');

  const neighbourMigrated = t.store.db
    .prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(nb.workspaceId).n;
  assert.equal(neighbourMigrated, 0, 'the neighbour workspace holds no migrated rows');
  const neighbourList = must(listOpenItems(nb.ctx, { asOf: CUTOVER }), 'neighbour listOpenItems');
  assert.equal(neighbourList.workspaceBaseTotalOpenMinor, 0, 'the neighbour control does not see the import');
});

// --- The control tie-out (three-status) ---------------------------------------------------------

test('a 1-Rappen discrepancy makes ar_control RED (not_asserted never green)', () => {
  // The opening 1100 line is GROSS, but the imported item is 1 Rappen short: the control must fail.
  const { t, planId } = world({ openingArMinor: GROSS });
  const res = must(
    importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t, { gross: GROSS - 1 })], idempotencyKey: 'imp-off' }),
    'import',
  );
  assert.equal(res.control.status, 'failed', 'a Rappen out of tie is a red control');
  assert.equal(res.control.differenceMinor, -1);
});

test('preview computes the delta WITHOUT writing a row', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const before = t.store.db
    .prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId).n;
  const res = must(previewOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)] }), 'preview');
  const after = t.store.db
    .prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId).n;
  assert.equal(after, before, 'preview writes nothing');
  assert.equal(res.control.status, 'passed');
  assert.equal(res.validCount, 1);
});

// --- Refusals (P9, atomic) ----------------------------------------------------------------------

test('refusals name the offending row and import NOTHING (atomic)', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const good = arRow(t, { number: 'GOOD' });
  const badContact = { ...arRow(t, { number: 'BADC' }), contactId: 'no-such-contact' };
  const badTotal = { ...arRow(t, { number: 'BADT' }), declaredTotalMinor: 999 };
  const res = importOpenItems(t.ctx, { planId, side: 'ar', rows: [good, badContact, badTotal], idempotencyKey: 'imp-bad' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'open_items_refused');
  const reasons = res.refusals.map((r) => r.reason).sort();
  assert.deepEqual(reasons, ['contact_unmapped', 'open_item_total_mismatch']);
  const imported = t.store.db
    .prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId).n;
  assert.equal(imported, 0, 'one bad row refuses the whole batch: nothing is written');
});

test('a foreign-currency row with no admissible rate refuses needs_fx_rate (never a guessed 1.0)', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const eurRow = { ...arRow(t, { number: 'EUR-1' }), currency: 'EUR' };
  const res = importOpenItems(t.ctx, { planId, side: 'ar', rows: [eurRow], idempotencyKey: 'imp-eur' });
  assert.equal(res.ok, false);
  assert.equal(res.refusals[0].reason, 'needs_fx_rate');
});

test('a tax code that resolves to nothing at the supply date refuses tax_unresolved', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const badTax = arRow(t, { number: 'TAX-1', taxCode: 'NOPE_CODE' });
  const res = importOpenItems(t.ctx, { planId, side: 'ar', rows: [badTax], idempotencyKey: 'imp-tax' });
  assert.equal(res.ok, false);
  assert.equal(res.refusals[0].reason, 'tax_unresolved');
});

// --- Numbering untouched ------------------------------------------------------------------------

test('a migrated import does not advance the native invoice number series', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  must(importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-num' }), 'import');
  // The migrated document kept the SOURCE number, verbatim.
  const migrated = t.store.db
    .prepare("SELECT number FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  assert.equal(migrated.number, 'SRC-001');
  // The next NATIVE invoice still gets R-2026-0001: the counter was never advanced by the import.
  const seq = t.store.db
    .prepare("SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = 'invoice' AND year = '2026'")
    .get(t.workspaceId);
  assert.equal(seq, undefined, 'no native invoice number was ever consumed by a migrated import');
});

// --- Immutability & correction by reversal ------------------------------------------------------

test('a migrated document is immutable: an amount UPDATE refuses illegal_transition', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  must(importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-imm' }), 'import');
  const doc = t.store.db
    .prepare("SELECT id FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  const res = updateDocument(t.ctx, { documentId: doc.id, patch: { lines: [{ unitPriceMinor: 1, taxCode: 'UST81' }] } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'illegal_transition');
});

test('cancelling a migrated item posts NOTHING and drops it from the open-item list', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  must(importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-cancel' }), 'import');
  const doc = t.store.db
    .prepare("SELECT id FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  const before = journalEntryCount(t.store, t.workspaceId);
  const cancelled = must(transitionDocument(t.ctx, { documentId: doc.id, to: 'cancelled', idempotencyKey: 'cx' }), 'cancel');
  assert.equal(journalEntryCount(t.store, t.workspaceId), before, 'cancelling a migrated item posts nothing');
  assert.equal(cancelled.document.status, 'cancelled');
  const list = must(listOpenItems(t.ctx, { asOf: CUTOVER }), 'listOpenItems');
  assert.equal(list.items.find((i) => i.number === 'SRC-001'), undefined, 'a cancelled migrated item is no longer open');
});

test('the A10 guard forbids a migrated row taking a posting edge', () => {
  // A native draft may issue (the posting edge); a migrated row may never, at the guard.
  assert.equal(assertTransition('draft', 'issued', 'invoice', 'native').ok, true);
  const migrated = assertTransition('draft', 'issued', 'invoice', 'migrated');
  assert.equal(migrated.ok, false);
  assert.equal(migrated.reason, 'migrated_no_posting_edge');
});

// --- The Soll/Ist VAT fork ----------------------------------------------------------------------

test('SOLL: a migrated invoice contributes NO output VAT to A07 (it posts nothing)', () => {
  const { t, planId } = world({ timing: 'soll', openingArMinor: GROSS });
  must(importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-soll' }), 'import');
  const ret = must(computeVatReturn(t.ctx, { periodStart: '2026-04-01', periodEnd: '2026-06-30' }), 'vat_return');
  assert.equal(ret.totalTaxDueMinor, 0, 'a migrated invoice posts nothing, so it declares no output VAT under Soll');
});

test('IST: settling a migrated invoice stamps the paid-portion VAT off the STORED code+base+tax', () => {
  const { t, planId } = world({ timing: 'ist', openingArMinor: GROSS });
  must(importOpenItems(t.ctx, { planId, side: 'ar', rows: [arRow(t)], idempotencyKey: 'imp-ist' }), 'import');
  const doc = t.store.db
    .prepare("SELECT id FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  // A14 settles the migrated open item exactly like a native one (documentBookedBase already handles a
  // NULL posted_entry_id). Under Ist it stamps the recognised VAT on the allocation, off the doc's
  // stored tax, which is the seam A07's Ist branch will read.
  const pay = must(
    recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-10',
      amountMinor: GROSS,
      bankAccountId: t.bankId,
      counterpartyId: t.customerId,
      intent: PAYMENT_INTENTS.record,
      allocations: [{ documentId: doc.id, amountMinor: GROSS }],
      idempotencyKey: 'pay-ist',
    }),
    'record_payment',
  );
  const alloc = t.store.db
    .prepare('SELECT tax_base_minor, tax_amount_minor FROM payment_allocation WHERE workspace_id = ? AND target_id = ?')
    .get(t.workspaceId, doc.id);
  assert.equal(alloc.tax_amount_minor, TAX, 'the full paid portion recognises the stored 8.1% VAT under Ist');
  assert.equal(alloc.tax_base_minor, NET);
  assert.equal(pay.ok, true);
});

// --- D112 Q2: the prior-year detail choice ------------------------------------------------------

test('archive (default) refuses a settled prior-year row toward the G13 archive', () => {
  const { t, planId } = world({ openingArMinor: GROSS });
  const settledRow = arRow(t, { number: 'OLD-1', settled: true });
  const res = importOpenItems(t.ctx, { planId, side: 'ar', rows: [settledRow], idempotencyKey: 'imp-arch' });
  assert.equal(res.ok, false);
  assert.equal(res.refusals[0].reason, 'prior_year_detail_archived');
});

test('live: a settled prior-year item is carried, posts nothing AND nets to zero open', () => {
  // Opening 1100 is 0: the settled item must NOT add to the open control (it is already settled).
  const { t, planId } = world({ openingArMinor: 0 });
  const before = journalEntryCount(t.store, t.workspaceId);
  const res = must(
    importOpenItems(t.ctx, {
      planId,
      side: 'ar',
      rows: [arRow(t, { number: 'OLD-2', settled: true })],
      priorYearDetail: 'live',
      idempotencyKey: 'imp-live',
    }),
    'import live settled',
  );
  assert.equal(journalEntryCount(t.store, t.workspaceId), before, 'a live-settled item posts nothing');
  assert.equal(res.control.status, 'not_asserted', 'no open position: the control is nichts geprüft, never green-by-fiat');
  const list = must(listOpenItems(t.ctx, { asOf: CUTOVER }), 'listOpenItems');
  assert.equal(list.workspaceBaseTotalOpenMinor, 0, 'a live-settled item nets to zero open (never double-recognised)');
  // But the record exists, at the terminal settled state.
  const doc = t.store.db
    .prepare("SELECT status FROM document WHERE workspace_id = ? AND origin = 'migrated'")
    .get(t.workspaceId);
  assert.equal(doc.status, 'settled');
});
