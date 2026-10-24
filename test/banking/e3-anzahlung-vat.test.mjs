/**
 * D178 E3, the owner's decision of 21.10.2026: VAT on a RECEIVED customer Anzahlung (MWSTG Art. 40),
 * behind `bank.anzahlung_vat` (default off).
 *
 * SYNTHETIC BY CONSTRUCTION: an invented customer, a hand-spelled statement, the canonical 1'000.00 +
 * 8.1% = 1'081.00 of the A14 suites.
 *
 * Held on ROWS and on the MWST-Abrechnung: off books exactly as before (no VAT on receipt); on books the
 * Umsatzsteuer when the Guthaben arrives (Q3) and clears it when `allocate_payment` applies the Guthaben to
 * the invoice (Q4), so the Q3 return declares the Anzahlung, the Q4 return nets the invoice against the
 * clearing, 1300 nets to zero and 2200 holds the tax once; a partial application clears its share; a
 * replayed application clears nothing twice; `reopen_bank_line` reverses the clearings and the receipt VAT;
 * a bad code refuses writing nothing; the Anzahlungen-account mode carries the VAT and warns.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, refused, rowCounts, balanceOf, issueInvoice, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { allocatePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { computeVatReturn } from '../../dist/core/vat/index.js';
import { reverseOwnedEntry } from '../../dist/core/ledger/reverseEntry.js';
import { makeContext } from '../../dist/core/context.js';
import { ok, err } from '../../dist/core/result.js';

afterEach(assertClaimInvariantHolds);

/** The world, the setting on (unless `off`), and one Q3 credit of 1'081.00 from the customer. */
function receipt({ off = false, amountMinor = 108100 } = {}) {
  const t = world();
  if (!off) must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat', value: true, reason: 'Art. 40 MWSTG', idempotencyKey: 'vat-on' }), 'setting');
  const line = importLines(t, { statementId: 'e3v', from: '2026-09-01', to: '2026-09-30', entries: [{ ref: 'AN', amountMinor, cd: 'CRDT', date: '2026-09-20', name: 'Muster AG', ustrd: 'Anzahlung Projekt' }] }).lines['AN'];
  return { t, line };
}

/** Ziffer 303 (8.1 %) base and tax of the return for one quarter. */
function z303(t, periodStart, periodEnd) {
  const ret = must(computeVatReturn(t.ctx, { periodStart, periodEnd }), 'return');
  const l = ret.lines.find((x) => x.code === '303');
  return { base: l?.baseMinor ?? 0, tax: l?.taxMinor ?? 0, reconciled: ret.reconciled };
}

test('off (the default): a Guthaben books exactly as before, no VAT on receipt', () => {
  const { t, line } = receipt({ off: true });
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'book');
  assert.equal(res.entryIds.length, 1);
  assert.ok(!res.warnings.includes('anzahlung_vat'));
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), 0);
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0);
  assert.deepEqual(z303(t, '2026-07-01', '2026-09-30'), { base: 0, tax: 0, reconciled: true });
});

test('on: VAT on receipt in Q3, cleared when the Guthaben is applied in Q4; each quarter\'s return is right and the tax is counted once', () => {
  const { t, line } = receipt();
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'book');
  assert.ok(res.warnings.includes('anzahlung_vat'));
  assert.equal(res.entryIds.length, 2, 'the payment and the receipt VAT');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100, 'the Umsatzsteuer is owed on receipt');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 8100, 'the tax paid ahead waits on 1300');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), -108100, 'the Guthaben stays gross on 1100');
  assert.deepEqual(z303(t, '2026-07-01', '2026-09-30'), { base: 100000, tax: 8100, reconciled: true }, 'Q3 declares the Anzahlung');

  // Q4: the invoice is issued and the Guthaben applied to it.
  const q4 = t.at('2026-10-05T09:00:00.000Z');
  const inv = issueInvoice(q4, { contactId: t.customerId, key: 'inv-q4' });
  const counts = rowCounts(t.store, t.workspaceId);
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'apply' }), 'apply');
  assert.equal(rowCounts(t.store, t.workspaceId).entries - counts.entries, 1, 'the application posts the one clearing');
  assert.equal(t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'settled');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0, '1300 nets to zero after applying');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100, 'the tax is owed once (the invoice\'s)');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0);
  assert.deepEqual(z303(t, '2026-10-01', '2026-12-31'), { base: 0, tax: 0, reconciled: true }, 'Q4: the invoice and the clearing net to zero');
  assert.deepEqual(z303(t, '2026-07-01', '2026-12-31'), { base: 100000, tax: 8100, reconciled: true }, 'over both quarters, once');

  // A replayed application clears nothing twice.
  const again = rowCounts(t.store, t.workspaceId);
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'apply' }), 'replay');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), again);

  // The undo reverses the payment, the clearing and the receipt VAT: only the invoice's tax remains.
  const undone = must(reopenBankLine(q4, { bankTxnId: line, reason: 'falsch', idempotencyKey: 'r' }), 'reopen');
  assert.equal(undone.reversedEntryIds.length, 2, 'the clearing and the receipt VAT');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0);
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100);
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), inv.totalMinor, 'the invoice is open again');
});

test('on: a partial application clears its share; the rest clears with the rest', () => {
  const { t, line } = receipt();
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'book');
  const q4 = t.at('2026-10-05T09:00:00.000Z');
  const half = issueInvoice(q4, { contactId: t.customerId, netMinor: 50000, key: 'inv-half' });
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: half.id, amountMinor: half.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'a1' }), 'half');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 8100 - 4050, 'half the receipt VAT is cleared');
  const rest = issueInvoice(q4, { contactId: t.customerId, netMinor: 50000, key: 'inv-rest' });
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: rest.id, amountMinor: rest.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'a2' }), 'rest');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0, 'the whole Guthaben applied clears the whole receipt VAT');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100);
});

test('on: a code that is not an active output code refuses, writing nothing', () => {
  const { t, line } = receipt();
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat_code', value: 'VST-M', reason: 'Test', idempotencyKey: 'code' }), 'code');
  const counts = rowCounts(t.store, t.workspaceId);
  const r = refused(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'invalid_anzahlung_vat_code');
  assert.equal(r.reason, 'not_an_output_code');
  assert.equal(typeof r.sentence['de-CH'], 'string');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
});

test('on, Anzahlungen account: the entry carries the receipt VAT and warns that the reclassification clears it', () => {
  const { t, line } = receipt();
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'acc-2030' }), '2030');
  const res = must(
    bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss' }, idempotencyKey: 'b' }),
    'book',
  );
  assert.ok(res.warnings.includes('anzahlung_vat_clears_on_reclassification'));
  assert.equal(res.entryIds.length, 1, 'one entry, the VAT inside it');
  assert.equal(balanceOf(t.store, t.workspaceId, '2030'), -108100);
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100);
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 8100);
  assert.deepEqual(z303(t, '2026-07-01', '2026-09-30'), { base: 100000, tax: 8100, reconciled: true });
  // The undo reverses the one entry, VAT included.
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch', idempotencyKey: 'r' }), 'reopen');
  for (const n of ['2030', '2200', '1300']) assert.equal(balanceOf(t.store, t.workspaceId, n), 0, n);
});

test('on: money out to a supplier, or a refund to a customer, carries no receipt VAT', () => {
  const t = world();
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat', value: true, reason: 'Art. 40 MWSTG', idempotencyKey: 'vat-on' }), 'setting');
  const line = importLines(t, { statementId: 'e3v-out', entries: [{ ref: 'OUT', amountMinor: 20000, cd: 'DBIT', name: 'Muster AG' }] }).lines['OUT'];
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId, beyondGuthaben: true }, idempotencyKey: 'o' }), 'refund');
  assert.ok(!res.warnings.includes('anzahlung_vat'));
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), 0);
});

/** A Q3 Guthaben with receipt VAT and a Q4 refund line to the same customer. */
function refundWorld(refundMinor, setting) {
  const { t, line } = receipt();
  if (setting !== undefined) must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat_refund', value: setting, reason: 'Test', idempotencyKey: 'refund-setting' }), 'setting');
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'receipt');
  const refund = importLines(t, { statementId: 'e3v-rf', from: '2026-10-01', to: '2026-10-31', entries: [{ ref: 'RF', amountMinor: refundMinor, cd: 'DBIT', date: '2026-10-10', name: 'Muster AG' }] }).lines['RF'];
  return { t, refund };
}

test('refund (default reverse): the matching share of the receipt VAT is corrected in the refund quarter; its reopen gives it back', () => {
  const { t, refund } = refundWorld(54050);
  const res = must(bookBankLine(t.ctx, { bankTxnId: refund, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'rf' }), 'refund half');
  assert.ok(res.warnings.includes('anzahlung_vat_refund_corrected'));
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -4050, 'half the receipt VAT stays owed');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 4050);
  assert.deepEqual(z303(t, '2026-10-01', '2026-12-31'), { base: -50000, tax: -4050, reconciled: true }, 'Q4 declares the Entgeltsminderung');
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: refund, reason: 'falsch', idempotencyKey: 'rf-r' }), 'reopen the refund');
  assert.equal(undone.reversedEntryIds.length, 1, 'the correction');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100);
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 8100);
});

test('refund with the setting refuse: no refund until the call states the correction; then it books', () => {
  const { t, refund } = refundWorld(108100, 'refuse');
  const counts = rowCounts(t.store, t.workspaceId);
  const r = refused(bookBankLine(t.ctx, { bankTxnId: refund, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'rf1' }), 'anzahlung_vat_refund_needs_decision');
  assert.equal(typeof r.sentence['de-CH'], 'string');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  must(bookBankLine(t.ctx, { bankTxnId: refund, target: { kind: 'contact', contactId: t.customerId, refundVat: 'reverse' }, idempotencyKey: 'rf2' }), 'stated');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), 0, 'the whole receipt VAT is corrected');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0);
});

test('refund with the setting warn: the refund books, the VAT stays, the answer warns; stating reverse needs a reason', () => {
  const { t, refund } = refundWorld(108100, 'warn');
  refused(bookBankLine(t.ctx, { bankTxnId: refund, target: { kind: 'contact', contactId: t.customerId, refundVat: 'reverse' }, idempotencyKey: 'rf0' }), 'reason_required');
  const res = must(bookBankLine(t.ctx, { bankTxnId: refund, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'rf1' }), 'refund');
  assert.ok(res.warnings.includes('anzahlung_vat_refund_uncorrected'));
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100);
});

// Security review fix-forward (D178 E3, 21.10.2026), one test per finding.

test('security 1: a reversed clearing no longer counts; after a refund is reopened the full application clears the whole receipt VAT', () => {
  const { t, refund } = refundWorld(54050);
  must(bookBankLine(t.ctx, { bankTxnId: refund, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'rf' }), 'refund half');
  must(reopenBankLine(t.ctx, { bankTxnId: refund, reason: 'falsch', idempotencyKey: 'rf-r' }), 'reopen the refund');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 8100, 'the correction is reversed');
  const q4 = t.at('2026-10-15T09:00:00.000Z');
  const inv = issueInvoice(q4, { contactId: t.customerId, key: 'inv-all' });
  const paymentId = t.store.db.prepare("SELECT payment_id AS p FROM bank_anzahlung_vat_clearing WHERE workspace_id = ? AND kind = 'refund'").get(t.workspaceId).p;
  must(allocatePayment(q4, { paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'apply' }), 'apply');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0, 'the reversed refund clearing is not re-booked out: 1300 nets to zero');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100, 'the tax is owed once');
});

/** The test world's ctx with every right except `withheld`. */
function ctxWithout(t, withheld) {
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: t.ctx.actor,
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (c === withheld ? err('permission_denied', { capability: c }) : ok()) },
  });
}

test('security 2: keeping the VAT under refuse needs manage_vat_config and a reason; A24 and the dial declare it', async () => {
  const { requiredCapabilitiesFor } = await import('../../dist/core/access/index.js');
  assert.deepEqual(requiredCapabilitiesFor('book_bank_line', { bankTxnId: 'x', target: { kind: 'contact', refundVat: 'keep' } }), ['pay', 'manage_vat_config']);
  assert.deepEqual(requiredCapabilitiesFor('book_bank_line', { bankTxnId: 'x', target: { kind: 'contact' } }), ['pay']);
  const { dialCapabilitiesForCall } = await import('../../dist/core/agent/dialMap.js');
  assert.deepEqual(dialCapabilitiesForCall('book_bank_line', { bankTxnId: 'x', target: { kind: 'contact', refundVat: 'keep' } }), ['vat-file', 'pay']);
  assert.deepEqual(dialCapabilitiesForCall('book_bank_line', { bankTxnId: 'x', target: { kind: 'contact' } }), ['pay']);
  const { t, refund } = refundWorld(108100, 'refuse');
  const counts = rowCounts(t.store, t.workspaceId);
  const keep = { kind: 'contact', contactId: t.customerId, refundVat: 'keep', overrideReason: 'Kunde bleibt' };
  const denied = refused(bookBankLine(ctxWithout(t, 'manage_vat_config'), { bankTxnId: refund, target: keep, idempotencyKey: 'k0' }), 'permission_denied');
  assert.equal(denied.capability, 'manage_vat_config');
  refused(bookBankLine(t.ctx, { bankTxnId: refund, target: { ...keep, overrideReason: '  ' }, idempotencyKey: 'k1' }), 'reason_required');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'nothing written');
  const res = must(bookBankLine(t.ctx, { bankTxnId: refund, target: keep, idempotencyKey: 'k2' }), 'keep with the right and a reason');
  assert.ok(res.warnings.includes('anzahlung_vat_refund_uncorrected'));
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100);
});

test('security 3: the refund corrects only the cash the Guthaben still holds, and that cash is then spent', () => {
  const { t, line } = receipt();
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'receipt');
  const q4 = t.at('2026-10-05T09:00:00.000Z');
  const half = issueInvoice(q4, { contactId: t.customerId, netMinor: 50000, key: 'inv-half' });
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: half.id, amountMinor: half.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'a1' }), 'half');
  // Probe: the application's clearing reversed by its owner while the allocation stands. The cash it applied
  // is still gone from the Guthaben, so a refund cannot hand it back.
  const clearing = t.store.db.prepare("SELECT entry_id AS e FROM bank_anzahlung_vat_clearing WHERE workspace_id = ? AND kind = 'application'").get(t.workspaceId).e;
  must(reverseOwnedEntry(t.ctx, { entryId: clearing, idempotencyKey: 'probe-rv' }, 'reopen_bank_line'), 'probe reversal');
  const rf = importLines(t, { statementId: 'e3v-rf3', from: '2026-10-01', to: '2026-10-31', entries: [{ ref: 'RF', amountMinor: 108100, cd: 'DBIT', date: '2026-10-10', name: 'Muster AG' }, { ref: 'RF2', amountMinor: 20000, cd: 'DBIT', date: '2026-10-11', name: 'Muster AG' }] }).lines;
  must(bookBankLine(t.ctx, { bankTxnId: rf['RF'], target: { kind: 'contact', contactId: t.customerId, beyondGuthaben: true }, idempotencyKey: 'rf' }), 'refund');
  const corrections = t.store.db.prepare("SELECT gross_minor AS g, applied_minor AS a FROM bank_anzahlung_vat_clearing WHERE workspace_id = ? AND kind = 'refund'").all(t.workspaceId);
  assert.deepEqual(corrections.map((c) => [c.a, c.g]), [[54050, 54050]], 'capped at the unallocated 540.50 the Guthaben still held');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100, 'only that share (40.50) of the receipt VAT is corrected, not the whole 81.00');
  const again = must(bookBankLine(t.ctx, { bankTxnId: rf['RF2'], target: { kind: 'contact', contactId: t.customerId, beyondGuthaben: true }, idempotencyKey: 'rf2' }), 'second refund');
  assert.ok(!again.warnings.includes('anzahlung_vat_refund_corrected'), 'the handed-back cash is spent: nothing left to correct');
});

test('refund nets against the Guthaben: receipt 100, refund 100, then allocate_payment has nothing to apply; a larger refund needs beyondGuthaben', () => {
  const { t, line } = receipt({ off: true, amountMinor: 10000 });
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'receipt');
  const rf = importLines(t, { statementId: 'e3n-rf', from: '2026-10-01', to: '2026-10-31', entries: [{ ref: 'RF', amountMinor: 10000, cd: 'DBIT', date: '2026-10-10', name: 'Muster AG' }, { ref: 'RF2', amountMinor: 5000, cd: 'DBIT', date: '2026-10-11', name: 'Muster AG' }] }).lines;
  must(bookBankLine(t.ctx, { bankTxnId: rf['RF'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'rf' }), 'refund 100');
  const q4 = t.at('2026-10-15T09:00:00.000Z');
  const inv = issueInvoice(q4, { contactId: t.customerId, netMinor: 5000, key: 'inv-n' });
  const counts = rowCounts(t.store, t.workspaceId);
  refused(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'apply' }), 'nothing_to_allocate');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  // Nothing is left to refund either: a second refund refuses unless the call states it goes beyond.
  const r = refused(bookBankLine(t.ctx, { bankTxnId: rf['RF2'], target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'rf2' }), 'refund_exceeds_guthaben');
  assert.equal(r.openGuthabenMinor, 0);
  assert.equal(typeof r.sentence['de-CH'], 'string');
  must(bookBankLine(t.ctx, { bankTxnId: rf['RF2'], target: { kind: 'contact', contactId: t.customerId, beyondGuthaben: true }, idempotencyKey: 'rf3' }), 'stated');
  // Reopening the first refund gives the Guthaben back to allocate.
  must(reopenBankLine(t.ctx, { bankTxnId: rf['RF'], reason: 'falsch', idempotencyKey: 'rf-r' }), 'reopen');
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'apply2' }), 'apply after reopen');
});
