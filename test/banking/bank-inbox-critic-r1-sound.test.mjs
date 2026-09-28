// A39 critic round 1, the probes the critic VERIFIED SOUND (p4, p4b, p10, p11, p17), ported so that
// what held at ab16d6b2 keeps holding after the remediation: the VAT legs of an accounts booking, the
// Saldo method, repeated reopen and rebook cycles, a EUR Bankkonto, and a G04 backup and restore of a
// workspace carrying superseded decisions and released claims. Synthetic data only.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createBankAccount,
  bookBankLine,
  reopenBankLine,
  ignoreBankLine,
  listBankInbox,
  bankReconciledForPeriod,
  importCamt,
  applyQrMatch,
} from '../../dist/core/banking/index.js';
import { buildVatLines } from '../../dist/core/vat/applyVat.js';
import { computeVatReturn } from '../../dist/core/vat/index.js';
import { postEntry, softCloseMonth } from '../../dist/core/ledger/index.js';
import { settledMinor } from '../../dist/core/payments/payment.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { setup as vatSetup } from '../vat/support.mjs';
import { seedRate } from '../payments/support.mjs';
import { assertClaimInvariantHolds, world, camt, importLines, issueInvoice, must, refused, legs, balanceOf, MAIN_IBAN, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { legClaimViolations, multiActiveViolations } from './bank-inbox-invariants.mjs';

// Critic A39R2-4: the claim invariant is asserted after EVERY scenario of this suite.
afterEach(assertClaimInvariantHolds);

const compact = (store, entryId) => legs(store, entryId).map((l) => [l.number, l.debit, l.credit, l.taxCode ?? null, l.taxAmount ?? null]);

/** Book one line to accounts and answer the entry's legs plus the A07 return. */
function vatCase(label, entry, legsIn) {
  const t = world();
  const { lines } = importLines(t, { statementId: label, entries: [{ ref: 'A', ...entry }] });
  const r = bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: legsIn.map((l) => ({ ...l, accountId: t.acc(l.acc) })) }, idempotencyKey: 'k' });
  const ret = computeVatReturn(t.ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  return { t, r, legs: r.ok ? compact(t.store, r.entryId) : null, ret };
}

const zif = (ret, code) => {
  const l = ret.lines.find((x) => x.code === code);
  return l === undefined ? null : [l.baseMinor, l.taxMinor];
};

test('p4: VAT on a bank line is the manual-entry tax model, and the A07 return reconciles with the books', () => {
  const vst = vatCase('VST', { amountMinor: 10810, cd: 'DBIT' }, [{ acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }]);
  assert.deepEqual(vst.legs, [['1020', 0, 10810, null, null], ['1170', 810, 0, null, null], ['6500', 10000, 0, 'VST-M', 810]]);
  assert.equal(vst.ret.reconciled, true);
  assert.deepEqual(zif(vst.ret, '400'), [10000, 810]);

  const bezug = vatCase('BEZUG', { amountMinor: 10000, cd: 'DBIT' }, [{ acc: '4400', amountMinor: 10000, taxCode: 'BEZUG' }]);
  assert.deepEqual(bezug.legs, [['1020', 0, 10000, null, null], ['1170', 810, 0, null, null], ['2200', 0, 810, null, null], ['4400', 10000, 0, 'BEZUG', 810]]);
  assert.deepEqual(zif(bezug.ret, '383'), [10000, 810], 'Bezugsteuer owed');
  assert.deepEqual(zif(bezug.ret, '400'), [10000, 810], 'and deducted');
  assert.equal(bezug.ret.reconciled, true);

  const ust = vatCase('UST', { amountMinor: 10810, cd: 'CRDT' }, [{ acc: '3400', amountMinor: 10810, taxCode: 'UST81' }]);
  assert.deepEqual(ust.legs, [['1020', 10810, 0, null, null], ['2200', 0, 810, null, null], ['3400', 0, 10000, 'UST81', 810]]);
  assert.equal(ust.ret.reconciled, true);

  const refund = vatCase('REFUND', { amountMinor: 10810, cd: 'CRDT' }, [{ acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }]);
  assert.deepEqual(refund.legs, [['1020', 10810, 0, null, null], ['1170', 0, 810, null, null], ['6500', 0, 10000, 'VST-M', -810]], 'a refund reduces the tax, mirrored');

  const imp = vatCase('IMPORT', { amountMinor: 810, cd: 'DBIT' }, [{ acc: '4200', amountMinor: 810, taxCode: 'IMPORT' }]);
  assert.deepEqual(imp.legs, [['1020', 0, 810, null, null], ['1170', 810, 0, 'IMPORT', 810]], 'the assessed Einfuhrsteuer is all tax');

  const mixed = vatCase('MIXED', { amountMinor: 9784, cd: 'CRDT' }, [{ acc: '3400', amountMinor: 10810, taxCode: 'UST81' }, { acc: '3200', amountMinor: -1026, taxCode: 'UST26' }]);
  assert.deepEqual(mixed.legs, [['1020', 9784, 0, null, null], ['2200', 26, 0, null, null], ['2200', 0, 810, null, null], ['3200', 1000, 0, 'UST26', -26], ['3400', 0, 10000, 'UST81', 810]]);

  const mixedIn = vatCase('MIXIN', { amountMinor: 9729, cd: 'DBIT' }, [{ acc: '4200', amountMinor: 10810, taxCode: 'VST-M' }, { acc: '6800', amountMinor: -1081, taxCode: 'VST-I' }]);
  assert.deepEqual(mixedIn.legs, [['1020', 0, 9729, null, null], ['1170', 810, 0, null, null], ['1171', 0, 81, null, null], ['4200', 10000, 0, 'VST-M', 810], ['6800', 0, 1000, 'VST-I', -81]]);

  const card = vatCase('CARD', { amountMinor: 9700, cd: 'CRDT' }, [{ acc: '3400', amountMinor: 10000, taxCode: 'UST81' }, { acc: '6900', amountMinor: -300 }]);
  assert.deepEqual(card.legs, [['1020', 9700, 0, null, null], ['2200', 0, 749, null, null], ['3400', 0, 9251, 'UST81', 749], ['6900', 300, 0, null, null]], 'card turnover netted with its fee');

  const round = vatCase('ROUND', { amountMinor: 1000, cd: 'DBIT' }, [{ acc: '6500', amountMinor: 333, taxCode: 'VST-M' }, { acc: '6500', amountMinor: 333, taxCode: 'VST-M' }, { acc: '6500', amountMinor: 334, taxCode: 'VST-M' }]);
  assert.equal(round.r.ok, true);
  const bank = round.legs.find((l) => l[0] === '1020');
  assert.equal(bank[2], 1000, 'three legs, one bank leg of the whole line');

  const nosum = vatCase('NOSUM', { amountMinor: 1000, cd: 'DBIT' }, [{ acc: '6500', amountMinor: 999, taxCode: 'VST-M' }]);
  assert.equal(nosum.r.error, 'legs_do_not_sum');
});

test('p4b: under the Saldosteuersatz method a bank-line booking equals buildVatLines, the manual model', () => {
  for (const [label, cd, amount, leg] of [
    ['SALDO-VST', 'DBIT', 10810, { acc: '6500', amountMinor: 10810, taxCode: 'VST-M' }],
    ['SALDO-UST', 'CRDT', 10810, { acc: '3400', amountMinor: 10810, taxCode: 'UST81' }],
    ['SALDO-BEZUG', 'DBIT', 10000, { acc: '4400', amountMinor: 10000, taxCode: 'BEZUG' }],
  ]) {
    const s = vatSetup({ method: 'saldo', saldoRates: [{ rateBp: 620 }] });
    const acc = (n) => s.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(s.workspaceId, n)?.id;
    const bank = must(createBankAccount(s.ctx, { name: 'Konto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: acc('1020'), idempotencyKey: 'b' }));
    const t = { ...s, acc, bankAccountId: bank.bankAccountId };
    const { lines } = importLines(t, { statementId: label, entries: [{ ref: 'A', amountMinor: amount, cd }] });
    const r = must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: [{ accountId: acc(leg.acc), amountMinor: leg.amountMinor, taxCode: leg.taxCode }] }, idempotencyKey: 'k' }), label);
    const manual = buildVatLines(t.ctx, {
      counterAccount: acc('1020'),
      revenueOrExpenseAccount: acc(leg.acc),
      amountMinor: amount,
      amountIsGross: leg.taxCode !== 'BEZUG',
      taxCode: leg.taxCode,
      direction: cd === 'CRDT' ? 'output' : 'input',
    });
    const number = (id) => t.store.db.prepare('SELECT number FROM account WHERE id = ?').get(id).number;
    const model = manual
      .map((l) => [number(l.account), l.debit ?? 0, l.credit ?? 0])
      .filter((l) => l[1] !== 0 || l[2] !== 0)
      .sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2]));
    const booked = legs(t.store, r.entryId)
      .map((l) => [l.number, l.debit, l.credit])
      .sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2]));
    assert.deepEqual(booked, model, `${label}: the bank line books exactly the manual model`);
  }
});

test('p10: reopen and rebook three times settles the invoice once, reverses each payment once, and keeps every decision', () => {
  const t = world({ realPeriods: true });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ro' });
  const { lines } = importLines(t, { statementId: 'RO', entries: [{ ref: 'P', amountMinor: 108100, cd: 'CRDT', date: '2026-07-20', qrr: buildQrrReference(inv.number) }] });
  const P = lines.P;
  must(bookBankLine(t.ctx, { bankTxnId: P, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'b0' }));
  for (let i = 1; i <= 3; i += 1) {
    const r = must(reopenBankLine(t.ctx, { bankTxnId: P, reason: `zyklus ${i}`, idempotencyKey: `r${i}` }));
    assert.equal(r.reversedPaymentIds.length, 1, `cycle ${i} reverses exactly one payment`);
    assert.equal(settledMinor(t.ctx, 'document', inv.id), 0);
    must(bookBankLine(t.ctx, { bankTxnId: P, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: `b${i}` }));
    assert.equal(settledMinor(t.ctx, 'document', inv.id), 108100, `cycle ${i}: settled exactly once`);
  }
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), 108100, 'the bank moved +108100 once');
  const hist = t.store.db.prepare('SELECT superseded_at IS NOT NULL AS gone FROM bank_line_decision WHERE bank_txn_id = ? ORDER BY rowid').all(P);
  assert.deepEqual(hist.map((h) => h.gone), [1, 1, 1, 0], 'four decisions, three superseded, all readable');
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
  // The queue and the inbox cannot BOTH settle the line: the queue refuses an imported credit (L2).
  const payments = t.store.db.prepare("SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ? AND status = 'posted'").get(t.workspaceId).n;
  const credit = t.store.db.prepare('SELECT id FROM reconciliation_match WHERE bank_txn_id = ?').get(P).id;
  refused(applyQrMatch(t.ctx, { creditId: credit, invoiceId: inv.id, mode: 'partial', confirmed: true, idempotencyKey: 'q1' }), 'use_bank_inbox');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ? AND status = 'posted'").get(t.workspaceId).n, payments);
  assert.equal(settledMinor(t.ctx, 'document', inv.id), 108100);
  // L5: once July is closed, the reversal (dated like the payment) refuses period_locked unchanged.
  must(softCloseMonth(t.ctx, { period: '2026-07', idempotencyKey: 'close' }));
  const locked = refused(reopenBankLine(t.ctx, { bankTxnId: P, reason: 'falsch', idempotencyKey: 'r-locked' }), 'period_locked');
  assert.equal(locked.suggestion, undefined);
});

test('p11: a EUR Bankkonto books at the stored rate without VAT, refuses VAT, matches a EUR entry and is judged in EUR', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'eur' })).bankAccountId;
  const imp = must(importCamt(t.ctx, { bankAccountId: eur, xml: camt({ statementId: 'E1', iban: SAVINGS_IBAN, currency: 'EUR', entries: [
    { ref: 'FEE', amountMinor: 1000, cd: 'DBIT' }, { ref: 'VAT', amountMinor: 1081, cd: 'DBIT' }, { ref: 'IN', amountMinor: 5000, cd: 'CRDT' },
  ] }), idempotencyKey: 'ie' }));
  const ids = Object.fromEntries(t.store.db.prepare('SELECT id, entry_ref FROM bank_txn WHERE statement_id = ?').all(imp.statementId).map((r) => [r.entry_ref, r.id]));
  const fee = must(bookBankLine(t.ctx, { bankTxnId: ids.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1000 }] }, idempotencyKey: 'f' }));
  const bankLeg = t.store.db.prepare("SELECT l.currency, l.credit_minor AS c, l.base_credit_minor AS bc FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.number = '1000'").get(fee.entryId);
  assert.deepEqual({ ...bankLeg }, { currency: 'EUR', c: 1000, bc: 950 }, 'EUR 10.00 at the stored 0.95');
  const vat = refused(bookBankLine(t.ctx, { bankTxnId: ids.VAT, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1081, taxCode: 'VST-M' }] }, idempotencyKey: 'v' }), 'unsupported');
  assert.equal(vat.reason, 'vat_on_foreign_currency_bank_line');
  const e = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'EUR in', currency: 'EUR', idempotencyKey: 'eurin', lines: [{ account: t.acc('1000'), debit: 5000 }, { account: t.acc('3400'), credit: 5000 }] }));
  must(bookBankLine(t.ctx, { bankTxnId: ids.IN, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'm' }));
  const b = must(listBankInbox(t.ctx, { bankAccountId: eur })).summary[0];
  assert.equal(b.currency, 'EUR');
  assert.equal(b.bankBalanceMinor, 2919);
  assert.equal(b.ledgerBalanceMinor, 4000, 'the EUR movement, never a converted base figure');
  assert.equal(b.openSumMinor, -1081);
  assert.equal(b.differenceMinor, 0);
  const g = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-07-31');
  const row = g.accounts.find((a) => a.bankAccountId === eur);
  assert.equal(row.status, 'open_lines');
  assert.equal(row.differenceMinor, -1081, 'the open EUR line, named in EUR');
});

test('p17: a G04 backup and restore keeps superseded decisions, released claims and every line state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-restore-'));
  try {
    const t = world();
    const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'rs' });
    const e = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand', idempotencyKey: 'rs-e', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
    const { lines } = importLines(t, { statementId: 'RS', entries: [
      { ref: 'A', amountMinor: 700, cd: 'DBIT' }, { ref: 'P', amountMinor: 108100, cd: 'CRDT' }, { ref: 'M', amountMinor: 900, cd: 'DBIT' }, { ref: 'I', amountMinor: 50, cd: 'DBIT' } ] });
    must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 700 }] }, idempotencyKey: 'a1' }));
    must(reopenBankLine(t.ctx, { bankTxnId: lines.A, reason: 'x', idempotencyKey: 'r1' }));
    must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 700 }] }, idempotencyKey: 'a2' }));
    must(bookBankLine(t.ctx, { bankTxnId: lines.P, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'p1' }));
    must(bookBankLine(t.ctx, { bankTxnId: lines.M, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'm1' }));
    must(ignoreBankLine(t.ctx, { bankTxnId: lines.I, reason: 'other', idempotencyKey: 'i1' }));
    must(reopenBankLine(t.ctx, { bankTxnId: lines.I, reason: 'zurück', idempotencyKey: 'u1' }));
    must(ignoreBankLine(t.ctx, { bankTxnId: lines.I, reason: 'duplicate', idempotencyKey: 'i2' }));
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'backup');
    const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true }), 'restore');
    const ws = restored.workspaceId;
    const count = (tbl, w) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE workspace_id = ?`).get(w).n;
    for (const tbl of ['bank_txn_link', 'bank_line_decision', 'bank_line_claim']) {
      assert.equal(count(tbl, ws), count(tbl, t.workspaceId), `${tbl} restored row for row`);
    }
    const ctx2 = makeContext(t.store, { workspaceId: ws, actor: 'user_1', clock: t.clock, ids: t.ids });
    const states = must(listBankInbox(ctx2, { status: 'all' })).lines.map((l) => `${l.amountMinor}:${l.state}`).sort();
    assert.deepEqual(states, ['-50:ignored', '-700:booked', '-900:matched', '108100:booked']);
    assert.deepEqual(legClaimViolations(t.store, ws), []);
    assert.deepEqual(multiActiveViolations(t.store, ws), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
