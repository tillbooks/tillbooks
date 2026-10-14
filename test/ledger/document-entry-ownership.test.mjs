/**
 * The raw `reverse_entry` refuses a vendor bill's, an invoice's and a credit note's entry (governance
 * check, 28.09.2026): the same class of defect the A38 accrual case and the A39 payment case had.
 *
 * Each of these entries has a ROW beside it that must move in the same transaction as the mirror: the
 * `vendor_bill` row (`status`, `reversal_entry_id`) and the `document` row (`status`). The raw tool knows
 * nothing of either. Measured before the fix: `reverse_entry` on a posted bill's entry returned ok and
 * the bill still read `posted`, so `list_vendor_bills` kept the Kreditor open against a 2000 that no
 * longer carried it, and a later `void_vendor_bill` refused `already_reversed` for good. On an invoice
 * the document stayed `issued` with its open item while 1100 had netted to zero, and
 * `transition_document` to `cancelled` failed the same way, so the invoice could never be cancelled.
 *
 * So the entry is OWNED by the verb that moves the row (`void_vendor_bill`, `transition_document`),
 * resolved by ROW like `payment`: an entry no bill or document names (a `post_entry` with source
 * `invoice`, which `POST_ENTRY_SOURCES` allows) stays reversible. The mirror is owned too (the walk in
 * `ownerOf`), so the Storno of a voided bill cannot be reversed raw into a bill that reads void on a
 * live 2000.
 *
 * HOW IT BITES: delete the `purchase` / `invoice` / `credit_note` resolvers from
 * `OWNED_REVERSAL_SOURCES` and every refusal below turns into ok with the row left behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function call(deps, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, input);
}

function vatReady(deps, workspaceId) {
  assert.equal(call(deps, 'vat_seed_defaults', { workspaceId }).ok, true);
  assert.equal(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
}

function postedBill(deps, workspaceId, accId) {
  vatReady(deps, workspaceId);
  const vendor = call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'v' });
  const bill = call(deps, 'record_expense', {
    workspaceId,
    vendorId: vendor.contact.id,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    vendorReference: 'LG-0042',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    idempotencyKey: 'bill',
  });
  assert.equal(bill.ok, true, JSON.stringify(bill));
  return bill;
}

function issuedInvoice(deps, workspaceId, seed = 'inv') {
  vatReady(deps, workspaceId);
  const c = call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Kunde AG', idempotencyKey: `${seed}-c` });
  const doc = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId: c.contact.id,
    currency: 'CHF',
    dueDate: '2026-08-31',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${seed}-doc`,
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  const issued = call(deps, 'issue_invoice', { workspaceId, invoiceId: doc.document.id, idempotencyKey: `${seed}-issue` });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return doc.document.id;
}

const docRow = (deps, workspaceId, id) =>
  deps.store.db.prepare('SELECT status, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
const billRow = (deps, workspaceId, id) =>
  deps.store.db.prepare('SELECT status, entry_id, reversal_entry_id FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
const entryCount = (deps, workspaceId) =>
  deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;

test('raw reverse_entry on a posted vendor bill entry refuses owned_by void_vendor_bill; the bill and 2000 stay whole', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const bill = postedBill(deps, workspaceId, accId);
  const { entry_id: entryId } = billRow(deps, workspaceId, bill.vendorBillId);
  const before = entryCount(deps, workspaceId);

  const raw = call(deps, 'reverse_entry', { workspaceId, entryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, false, `the raw Storno must not strand the bill: ${JSON.stringify(raw)}`);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'void_vendor_bill');
  assert.equal(entryCount(deps, workspaceId), before, 'nothing was minted');
  assert.equal(billRow(deps, workspaceId, bill.vendorBillId).status, 'posted');

  // The owner still reaches the mirror, and moves the row with it.
  const voided = call(deps, 'void_vendor_bill', { workspaceId, vendorBillId: bill.vendorBillId, idempotencyKey: 'void' });
  assert.equal(voided.ok, true, JSON.stringify(voided));
  const after = billRow(deps, workspaceId, bill.vendorBillId);
  assert.equal(after.status, 'void');
  assert.equal(typeof after.reversal_entry_id, 'string');

  // The Storno is owned through the walk: reversing it raw would put the Kreditor back on 2000 under
  // a bill that reads void.
  const rawMirror = call(deps, 'reverse_entry', { workspaceId, entryId: after.reversal_entry_id, idempotencyKey: 'raw-mirror' });
  assert.equal(rawMirror.ok, false, JSON.stringify(rawMirror));
  assert.equal(rawMirror.error, 'owned_by');
  assert.equal(rawMirror.verb, 'void_vendor_bill');
  deps.store.close();
});

test('raw reverse_entry on an issued invoice entry refuses owned_by transition_document; cancel still works', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const invoiceId = issuedInvoice(deps, workspaceId);
  const { posted_entry_id: entryId } = docRow(deps, workspaceId, invoiceId);
  assert.equal(typeof entryId, 'string', 'premise: the issued invoice carries its entry');
  const before = entryCount(deps, workspaceId);

  const raw = call(deps, 'reverse_entry', { workspaceId, entryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, false, `the raw Storno must not strand the invoice: ${JSON.stringify(raw)}`);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'transition_document');
  assert.equal(entryCount(deps, workspaceId), before);
  assert.equal(docRow(deps, workspaceId, invoiceId).status, 'issued');

  const cancelled = call(deps, 'transition_document', { workspaceId, documentId: invoiceId, to: 'cancelled', idempotencyKey: 'cancel' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(docRow(deps, workspaceId, invoiceId).status, 'cancelled');
  assert.equal(entryCount(deps, workspaceId), before + 1, 'exactly one reversal, through the owner');
  deps.store.close();
});

test('raw reverse_entry on an issued credit note entry refuses owned_by transition_document', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const invoiceId = issuedInvoice(deps, workspaceId, 'cn');
  const credit = call(deps, 'create_credit_note', { workspaceId, fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: 'cn-draft' });
  assert.equal(credit.ok, true, JSON.stringify(credit));
  const creditId = credit.document?.id ?? credit.creditNoteId ?? credit.documentId;
  const issued = call(deps, 'issue_credit_note', { workspaceId, creditNoteId: creditId, idempotencyKey: 'cn-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const { posted_entry_id: entryId } = docRow(deps, workspaceId, creditId);
  assert.equal(typeof entryId, 'string', 'premise: the issued credit note carries its entry');

  const raw = call(deps, 'reverse_entry', { workspaceId, entryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, false, JSON.stringify(raw));
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'transition_document');
  deps.store.close();
});

test('an invoice-sourced entry NO document names stays reversible (the resolver keys on the row, not the source)', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const posted = call(deps, 'post_entry', {
    workspaceId,
    date: '2026-03-01',
    source: 'invoice',
    description: 'Altbestand',
    idempotencyKey: 'pe',
    lines: [
      { account: accId('1100'), debit: 5000 },
      { account: accId('3200'), credit: 5000 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const raw = call(deps, 'reverse_entry', { workspaceId, entryId: posted.entryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, true, JSON.stringify(raw));
  deps.store.close();
});
