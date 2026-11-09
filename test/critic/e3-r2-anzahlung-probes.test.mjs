/**
 * CRITIC PROBES, D178 E3 round 2 (non-author): the fixed-CHF Anzahlung, VAT on a received Anzahlung and its
 * clearing inside `allocate_payment`. SYNTHETIC BY CONSTRUCTION: invented customer, hand-spelled
 * statements (`test/banking/bank-inbox-support.mjs`). A `{ todo }` probe documents a finding the branch
 * does not hold yet (docs/critique/bank-parity-e3-critic-r1.md, round 2).
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { world, importLines, must, refused, rowCounts, balanceOf, issueInvoice, assertClaimInvariantHolds, secondWorkspace, SAVINGS_IBAN } from '../banking/bank-inbox-support.mjs';
import { seedRate } from '../payments/support.mjs';
import { bookBankLine, reopenBankLine, createBankAccount } from '../../dist/core/banking/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { createAccount } from '../../dist/core/accounts/index.js';
import { allocatePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { computeVatReturn } from '../../dist/core/vat/index.js';
import { computeFxRevaluation } from '../../dist/core/fx/index.js';

afterEach(assertClaimInvariantHolds);

function vatOn(t, key = 'vat-on') {
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat', value: true, reason: 'Art. 40 MWSTG', idempotencyKey: key }), 'setting');
}

function guthaben(t, amountMinor, id = 'r2') {
  const line = importLines(t, { statementId: id, from: '2026-09-01', to: '2026-09-30', entries: [{ ref: 'AN', amountMinor, cd: 'CRDT', date: '2026-09-20', name: 'Muster AG' }] }).lines['AN'];
  const res = must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: `${id}-b` }), 'book');
  return { line, res };
}

function z303(t, periodStart, periodEnd) {
  const ret = must(computeVatReturn(t.ctx, { periodStart, periodEnd }), 'return');
  const l = ret.lines.find((x) => x.code === '303');
  return { base: l?.baseMinor ?? 0, tax: l?.taxMinor ?? 0, reconciled: ret.reconciled };
}

const clearingCount = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_anzahlung_vat_clearing WHERE workspace_id = ?').get(t.workspaceId).n;

test('R2-1: three partial applications (1/3 each): the clearings add up to the receipt VAT to the Rappen; 1300 nets to zero, 2200 holds the invoices\' tax once', () => {
  const t = world();
  vatOn(t);
  const { res } = guthaben(t, 100000);
  const receiptTax = -balanceOf(t.store, t.workspaceId, '2200');
  const q4 = t.at('2026-10-05T09:00:00.000Z');
  let invoiceTax = 0;
  for (const [i, net] of [30836, 30836, 30837].entries()) {
    const before = balanceOf(t.store, t.workspaceId, '2200');
    const inv = issueInvoice(q4, { contactId: t.customerId, netMinor: net, key: `r2-1-${i}` });
    invoiceTax += -(balanceOf(t.store, t.workspaceId, '2200') - before);
    const available = 100000 - t.store.db.prepare('SELECT COALESCE(SUM(payment_amount_minor), 0) AS n FROM payment_allocation WHERE payment_id = ?').get(res.paymentId).n;
    must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: Math.min(inv.totalMinor, available) }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: `r2-1-a${i}` }), `apply ${i}`);
  }
  assert.equal(clearingCount(t), 3);
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0, `1300 residue after clearing a receipt tax of ${receiptTax}`);
  assert.equal(-balanceOf(t.store, t.workspaceId, '2200'), invoiceTax, '2200 holds the invoices\' tax once');
});

test('R2-2: an application in another workspace never clears this workspace\'s Anzahlung (§H-TENANT); ids of one tenant do not reach the other', () => {
  const t = world();
  vatOn(t);
  const b = secondWorkspace(t);
  const { res } = guthaben(t, 108100);
  const inv = issueInvoice(b.ctx, { contactId: b.customerId, key: 'r2-2' });
  const before = clearingCount(t);
  const r = allocatePayment(b.ctx, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'r2-2' });
  assert.equal(r.ok, false);
  assert.equal(clearingCount(t), before);
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 8100);
});

test('R2-3: the clearing table is append-only (no UPDATE, no DELETE)', () => {
  const t = world();
  vatOn(t);
  const { res } = guthaben(t, 108100);
  const inv = issueInvoice(t.at('2026-10-05T09:00:00.000Z'), { contactId: t.customerId, key: 'r2-3' });
  must(allocatePayment(t.ctx, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'r2-3' }), 'apply');
  assert.throws(() => t.store.db.prepare('UPDATE bank_anzahlung_vat_clearing SET gross_minor = 0 WHERE workspace_id = ?').run(t.workspaceId), /immutable/);
  assert.throws(() => t.store.db.prepare('DELETE FROM bank_anzahlung_vat_clearing WHERE workspace_id = ?').run(t.workspaceId), /never deleted/);
});

test('R2-4 (the stated residual): while the application stands, the raw Storno of its VAT clearing is refused', () => {
  const t = world();
  vatOn(t);
  const { res } = guthaben(t, 108100);
  const inv = issueInvoice(t.at('2026-10-05T09:00:00.000Z'), { contactId: t.customerId, key: 'r2-4' });
  must(allocatePayment(t.ctx, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'r2-4' }), 'apply');
  const clearing = t.store.db.prepare('SELECT entry_id AS e FROM bank_anzahlung_vat_clearing WHERE workspace_id = ?').get(t.workspaceId).e;
  const counts = rowCounts(t.store, t.workspaceId);
  const r = reverseEntry(t.ctx, { entryId: clearing, idempotencyKey: 'raw' });
  const after = { vat: balanceOf(t.store, t.workspaceId, '2200'), prepaid: balanceOf(t.store, t.workspaceId, '1300') };
  assert.equal(r.ok, false, `raw Storno of the clearing answered ok: 2200 ${after.vat}, 1300 ${after.prepaid} (the tax counted twice)`);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
});

test('R2-5: a received Anzahlung refunded to the customer (no invoice) leaves its receipt VAT declared', () => {
  const t = world();
  vatOn(t);
  guthaben(t, 108100);
  const out = importLines(t, { statementId: 'r2-5o', from: '2026-10-01', to: '2026-10-31', entries: [{ ref: 'RF', amountMinor: 108100, cd: 'DBIT', date: '2026-10-10', name: 'Muster AG' }] }).lines['RF'];
  must(bookBankLine(t.ctx, { bankTxnId: out, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'r2-5r' }), 'refund');
  assert.equal(balanceOf(t.store, t.workspaceId, '1100'), 0, 'the customer is square');
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), 0, 'no tax is owed on money handed back');
});

test('R2-6: a fixed-CHF EUR Anzahlung: 3806/4906 nets to zero, 2030 is CHF only, reopen reverses both entries; replay writes nothing', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-20' });
  must(createAccount(t.ctx, { number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'r2-6-2030' }), '2030');
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1060'), idempotencyKey: 'r2-6-eur' }), 'eur');
  const { lines } = importLines(t, { statementId: 'r2-6', currency: 'EUR', iban: SAVINGS_IBAN, entries: [{ ref: 'E', amountMinor: 20000, cd: 'CRDT', name: 'Muster AG' }] }, { bankAccountId: eur.bankAccountId });
  const input = { bankTxnId: lines['E'], target: { kind: 'contact', contactId: t.customerId, mode: 'anzahlung', overrideReason: 'Vorschuss' }, idempotencyKey: 'r2-6' };
  const res = must(bookBankLine(t.ctx, input), 'book');
  assert.equal(res.entryIds.length, 2);
  const counts = rowCounts(t.store, t.workspaceId);
  must(bookBankLine(t.ctx, input), 'replay');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
  assert.equal(balanceOf(t.store, t.workspaceId, '3806') + balanceOf(t.store, t.workspaceId, '4906'), 0);
  const foreignOn2030 = t.store.db.prepare("SELECT COUNT(*) AS n FROM journal_line l JOIN account a ON a.id = l.account_id WHERE a.workspace_id = ? AND a.number = '2030' AND l.currency <> 'CHF'").get(t.workspaceId).n;
  assert.equal(foreignOn2030, 0);
  for (const id of res.entryIds) assert.equal(reverseEntry(t.ctx, { entryId: id, idempotencyKey: `raw-${id}` }).ok, false, 'raw Storno refused');
  const undone = must(reopenBankLine(t.ctx, { bankTxnId: lines['E'], reason: 'falsch', idempotencyKey: 'r2-6-r' }), 'reopen');
  assert.equal(undone.reversedEntryIds.length, 2);
  for (const n of ['1060', '2030', '3806', '4906']) assert.equal(balanceOf(t.store, t.workspaceId, n), 0, n);
  assert.deepEqual(must(computeFxRevaluation(t.ctx, { periodEnd: '2026-07-31' }), 'reval').positions, []);
});

test('R2-7: Ist (vereinnahmte Entgelte): receipt VAT in Q3, invoice paid from the Guthaben in Q4; the tax is declared once over both quarters', () => {
  const t = world({ timing: 'ist' });
  vatOn(t);
  const { res } = guthaben(t, 108100);
  const q4 = t.at('2026-10-05T09:00:00.000Z');
  const inv = issueInvoice(q4, { contactId: t.customerId, key: 'r2-7' });
  must(allocatePayment(q4, { paymentId: res.paymentId, allocations: [{ documentId: inv.id, amountMinor: inv.totalMinor }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'r2-7' }), 'apply');
  assert.equal(balanceOf(t.store, t.workspaceId, '1300'), 0);
  assert.equal(balanceOf(t.store, t.workspaceId, '2200'), -8100, 'the tax is owed once (A07 computes no Ist return yet, so the ledger is the check)');
});

test('R2-8: the receipt VAT entry of a Guthaben is held by the decision: its raw Storno is refused', () => {
  const t = world();
  vatOn(t);
  const { res } = guthaben(t, 108100);
  const vatEntry = res.entryIds.find((e) => e !== t.store.db.prepare('SELECT journal_entry_id AS e FROM payment WHERE id = ?').get(res.paymentId).e);
  assert.ok(vatEntry);
  const counts = rowCounts(t.store, t.workspaceId);
  assert.equal(reverseEntry(t.ctx, { entryId: vatEntry, idempotencyKey: 'raw-v' }).ok, false);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts);
});
