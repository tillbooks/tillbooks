// Critic D186 (non-author): §H-TENANT. Workspace B's bank lines, rules, bookings, bills and invoices must
// not move one figure of workspace A. Synthetic by construction.
import test from 'node:test';
import assert from 'node:assert/strict';

const { listBankInbox, bookBankLine, setBankStandard, createBankAccount, importCamt } = await import('../../dist/core/banking/index.js');
const { dashboardOverview, dashboardRevenueEstimate, dashboardSeries } = await import('../../dist/core/dashboards/index.js');
const { buildQrrReference } = await import('../../dist/core/payments/reference.js');
const { world, importLines, must, camt, secondWorkspace, TELCO_IBAN, issueInvoice } = await import('../banking/bank-inbox-support.mjs');
const { createContact } = await import('../../dist/core/sales/index.js');
const { createVendorBill, postVendorBill } = await import('../../dist/core/purchase/index.js');

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'workspaceId' || k === 'generatedAt' || k === 'lastFetch' ? undefined : v)));

test('critic D186-7: workspace B moves none of workspace A\'s D186 figures', () => {
  const t = world();
  // A: one payout line on a rule, one fee booked, so every figure is non-trivial.
  const a = importLines(t, { statementId: 'A1', openingMinor: 100000, entries: [
    { ref: 'P', amountMinor: 3000, cd: 'CRDT', name: 'Zahlwerk Beispiel Ltd', ustrd: 'AUSZAHLUNG A' },
    { ref: 'F', amountMinor: 500, cd: 'DBIT', name: 'Kontoführung', ustrd: 'Gebühr' },
  ] });
  must(setBankStandard(t.ctx, { bankTxnId: a.lines.P, accountId: t.acc('3400'), taxCode: 'UST81', idempotencyKey: 'a-rule' }));
  must(bookBankLine(t.ctx, { bankTxnId: a.lines.F, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 500 }] }, idempotencyKey: 'a-fee' }));
  const snap = () => strip({
    o: must(dashboardOverview(t.ctx, RANGE)).tiles.filter((x) => x.tile !== 'bank_inbox'),
    e: must(dashboardRevenueEstimate(t.ctx, RANGE)),
    s: must(dashboardSeries(t.ctx, { from: '2026-01-01', to: '2026-12-31' })),
  });
  const before = snap();

  // B: its own Bankkonto, statement, rule, bookings, a paid invoice and a vendor bill, all in July.
  const b = secondWorkspace(t);
  const bank = must(createBankAccount(b.ctx, { name: 'B-Konto', iban: TELCO_IBAN, currency: 'CHF', ledgerAccountId: b.bankId, idempotencyKey: 'b-bank' })).bankAccountId;
  const inv = issueInvoice(b.ctx, { contactId: b.customerId, key: 'b-inv' });
  const vendor = must(createContact(b.ctx, { partyRole: 'vendor', name: 'Lieferant Zweig GmbH', idempotencyKey: 'b-v' })).contact.id;
  const bill = must(createVendorBill(b.ctx, { vendorId: vendor, billDate: '2026-07-02', dueDate: '2026-07-30', amountMinor: 40000, expenseAccountId: b.acc('6500'), idempotencyKey: 'b-bill' }));
  must(postVendorBill(b.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'b-post' }));
  const imp = must(importCamt(b.ctx, { bankAccountId: bank, xml: camt({ statementId: 'B1', iban: TELCO_IBAN, openingMinor: 900000, entries: [
    { ref: 'BP', amountMinor: 7000, cd: 'CRDT', name: 'Zahlwerk Beispiel Ltd', ustrd: 'AUSZAHLUNG A' },
    { ref: 'BQ', amountMinor: 108100, cd: 'CRDT', qrr: buildQrrReference(inv.number), name: 'Zweite AG' },
    { ref: 'BF', amountMinor: 900, cd: 'DBIT', name: 'Kontoführung', ustrd: 'Gebühr' },
  ] }), idempotencyKey: 'b-imp' }));
  const bl = Object.fromEntries(t.store.db.prepare('SELECT id, entry_ref FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').all(b.workspaceId, imp.statementId).map((r) => [r.entry_ref, r.id]));
  must(setBankStandard(b.ctx, { bankTxnId: bl.BP, accountId: b.acc('3400'), taxCode: 'UST81', idempotencyKey: 'b-rule' }));
  const q = must(listBankInbox(b.ctx, { status: 'open', limit: 50 })).lines.find((l) => l.bankTxnId === bl.BQ);
  must(bookBankLine(b.ctx, { bankTxnId: bl.BQ, target: q.proposal.target, idempotencyKey: 'b-q' }));
  must(bookBankLine(b.ctx, { bankTxnId: bl.BF, target: { kind: 'accounts', legs: [{ accountId: b.acc('6800'), amountMinor: 900 }] }, idempotencyKey: 'b-fee' }));
  assert.ok(must(dashboardRevenueEstimate(b.ctx, RANGE)).revenueMinor > 0, 'B has an estimate of its own');

  assert.deepEqual(snap(), before, 'A reads the same figures');
});
