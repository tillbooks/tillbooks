// D186 re-cut (three critic FAILs; the owner's pick of 09.11.2026): free_cash on ONE basis, the books.
// free_cash = Σ DISTINCT Bankkonto ledger accounts (base value) - 2000 Kreditoren - max(0, 2200 - 1170 - 1171),
// all as of today. These are the critic's paper-review cases, each held as an assertion that would go red
// under the earlier mixed-basis designs. Synthetic by construction: invented names and amounts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBankAccount, importCamt, listBankInbox, bookBankLine } from '../../dist/core/banking/index.js';
import { dashboardOverview } from '../../dist/core/dashboards/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { world, must, camt, postedBill } from '../banking/bank-inbox-support.mjs';

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const freeOf = (t) => must(dashboardOverview(t.ctx, RANGE)).tiles.find((x) => x.tile === 'free_cash');
const post = (t, date, key, lines) => must(postEntry(t.ctx, { date, source: 'manual', idempotencyKey: key, lines }), key);

test('two Bankkonten on ONE ledger account count it once', () => {
  const t = world();
  must(createBankAccount(t.ctx, { name: 'Zweitkonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: t.bankId, idempotencyKey: 'second' }), 'second');
  post(t, '2026-07-02', 'in', [{ account: t.bankId, debit: 100000 }, { account: t.acc('3400'), credit: 100000 }]);
  const free = freeOf(t);
  assert.equal(free.detail.bankAccounts.length, 1);
  assert.equal(free.detail.bankMinor, 100000, 'the shared ledger account once, not twice');
});

test('a bank line booked straight to 2000 moves the bank and the payables together: free_cash unchanged', () => {
  const t = world();
  post(t, '2026-07-01', 'cash', [{ account: t.bankId, debit: 500000 }, { account: t.acc('2800'), credit: 500000 }]);
  postedBill(t, { grossMinor: 50000, seed: 'k2000', vendorName: 'Druckerei Lindenhof AG' });
  const before = freeOf(t);
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'K2000', openingMinor: 500000, entries: [{ ref: 'P', amountMinor: 50000, cd: 'DBIT', date: '2026-07-15', name: 'Druckerei Lindenhof AG' }] }), idempotencyKey: 'imp' }), 'import');
  const line = must(listBankInbox(t.ctx, { status: 'open', limit: 10 })).lines[0];
  must(bookBankLine(t.ctx, { bankTxnId: line.bankTxnId, target: { kind: 'accounts', legs: [{ accountId: t.acc('2000'), amountMinor: 50000 }] }, idempotencyKey: 'to2000' }), 'book');
  const after = freeOf(t);
  assert.equal(after.detail.bankMinor, before.detail.bankMinor - 50000);
  assert.equal(after.detail.payablesMinor, before.detail.payablesMinor - 50000, '2000 is the books, whatever the bill list says');
  assert.equal(after.valueRappen, before.valueRappen, 'paying a debt does not change free cash');
});

test('MWST owed is the ledger (2200 less 1170 and 1171): an earlier unpaid period counts, a credit is never added', () => {
  const t = world();
  post(t, '2026-03-31', 'q1-vat', [{ account: t.acc('1100'), debit: 8100 }, { account: t.acc('2200'), credit: 8100 }]);
  assert.equal(freeOf(t).detail.vatDueMinor, 8100, 'Q1 is still owed in July until it is paid');
  post(t, '2026-07-10', 'q1-paid', [{ account: t.acc('2200'), debit: 8100 }, { account: t.bankId, credit: 8100 }]);
  assert.equal(freeOf(t).detail.vatDueMinor, 0);
  post(t, '2026-07-11', 'input', [{ account: t.acc('1170'), debit: 3000 }, { account: t.acc('2000'), credit: 3000 }]);
  assert.equal(freeOf(t).detail.vatDueMinor, 0, 'a VAT credit is floored at zero, never added to free cash');
});

test('an Ist filer owes its MWST too (the ledger answers whatever the timing)', () => {
  const t = world({ timing: 'ist' });
  post(t, '2026-07-05', 'ist-vat', [{ account: t.acc('1100'), debit: 8100 }, { account: t.acc('2200'), credit: 8100 }]);
  const free = freeOf(t);
  assert.equal(free.detail.vatDueMinor, 8100);
  assert.equal(free.valueRappen, free.detail.bankMinor - free.detail.payablesMinor - 8100);
});

test('free_cash is a current figure: the page range does not move it', () => {
  const t = world();
  post(t, '2026-03-31', 'q1-vat', [{ account: t.acc('1100'), debit: 8100 }, { account: t.acc('2200'), credit: 8100 }]);
  const july = freeOf(t);
  const q1 = must(dashboardOverview(t.ctx, { from: '2026-01-01', to: '2026-03-31' })).tiles.find((x) => x.tile === 'free_cash');
  assert.equal(q1.valueRappen, july.valueRappen);
});

test('a Saldo filer owes the return figure of the running period (owner, 09.11.2026), not the invoiced rate', async () => {
  const { getAction } = await import('../../dist/api/registry.js');
  const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Saldo Beispiel GmbH', 'ws-saldo');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  call('vat_seed_defaults', {});
  must(call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], idempotencyKey: 'cfg' }), 'saldo');
  call('set_creditor_profile', { creditorName: 'Saldo Beispiel GmbH', address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' }, qrIban: 'CH4431999123000889012' });
  const c = must(call('create_contact', { partyRole: 'customer', name: 'Kachel AG', address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' }, email: 'a@b.example', idempotencyKey: 'c1' }), 'contact');
  const d = must(call('create_document', { type: 'invoice', contactId: c.contact.id, currency: 'CHF', dueDate: '2026-08-15', lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }], idempotencyKey: 'doc' }), 'doc');
  must(call('issue_invoice', { invoiceId: d.document.id, idempotencyKey: 'iss' }), 'issue');
  const o = must(call('dashboard_overview', { from: '2026-07-01', to: '2026-07-31' }), 'overview');
  const free = o.tiles.find((x) => x.tile === 'free_cash');
  const mwst = o.tiles.find((x) => x.tile === 'mwst_due');
  // 1'081.00 gross at the 6.2 % Saldosteuersatz: 67.02, A07's own return figure (not the 81.00 on 2200).
  assert.equal(free.detail.vatDueMinor, 6702);
  assert.equal(free.detail.vatDueMinor, mwst.valueRappen);
});
