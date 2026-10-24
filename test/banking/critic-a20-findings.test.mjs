// A20 INDEPENDENT CRITIC probes (non-author). Refute-by-default.
//
// These are not a second copy of the author's suite. Every case here is a claim the author's suite
// does NOT make, aimed at where a camt importer books wrong money:
//
//   - double-booking across statement BOUNDARIES (an overlapping camt.053, a camt.054 whose entries
//     reappear in the end-of-day camt.053, an amended statement),
//   - the A21 seam (does the money move once, does §H-TENANT hold across it),
//   - the DEBIT path (sign, atomicity, a poisoned A14 idempotency key),
//   - the as-of reconciliation across a boundary and around a future-dated entry,
//   - the parser's honesty: what it does with input it cannot read.
//
// Cases that DEMONSTRATE A DEFECT are marked `[FINDING A20-Cn]` and assert the OBSERVED (wrong)
// behaviour, so this file is green on the branch as committed and turns red the moment the defect is
// repaired. The finding text lives in docs/critique/a20-critic.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCamt,
  createBankAccount,
  importCamt,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  applyQrMatch,
  setQrAutoApply,
  bookBankLine,
} from '../../dist/core/banking/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { setup, issueInvoice, GROSS_MINOR } from '../payments/support.mjs';
import { secondWorkspace } from './support.mjs';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';

const IBAN = 'CH9300762011623852957';

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};
const fails = (res, code, label = 'result') => {
  assert.equal(res.ok, false, `expected ${label} to fail, got ${JSON.stringify(res)}`);
  if (code !== undefined) assert.equal(res.error, code, `expected ${code}, got ${JSON.stringify(res)}`);
  return res;
};

function world(opts = {}) {
  const t = setup(opts);
  const bank = ok(
    createBankAccount(t.ctx, {
      name: 'PostFinance Geschäft',
      iban: 'CH93 0076 2011 6238 5295 7',
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'camt-bank',
    }),
    'createBankAccount',
  );
  return { ...t, bankAccountId: bank.bankAccountId };
}

/** A camt message with ARBITRARILY MANY entries, so a multi-entry statement is testable. */
function camt({
  messageType = 'camt053',
  statementId,
  seqNb = '1',
  iban = IBAN,
  entries = [],
  opbd = 100000,
  clbd = 100000,
  fromDate = '2026-07-01',
  toDate = '2026-07-01',
  currency = 'CHF',
  balanceCurrency,
  omitBalances = false,
}) {
  const stmtTag = messageType === 'camt053' ? 'Stmt' : 'Ntfctn';
  const root = messageType === 'camt053' ? 'BkToCstmrStmt' : 'BkToCstmrDbtCdtNtfctn';
  const balCcy = balanceCurrency ?? currency;
  const balances =
    messageType === 'camt053' && !omitBalances
      ? `<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="${balCcy}">${(opbd / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="${balCcy}">${(clbd / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>`
      : '';
  const ntry = entries
    .map((e) => {
      const amount = (e.amountMinor / 100).toFixed(2);
      const ccy = e.currency ?? currency;
      const rmtInf =
        e.referenceKind === undefined
          ? ''
          : `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry>${
              e.referenceKind === 'qrr' ? '<Prtry>QRR</Prtry>' : '<Cd>SCOR</Cd>'
            }</CdOrPrtry></Tp><Ref>${e.reference}</Ref></CdtrRefInf></Strd></RmtInf>`;
      const rltd = e.payerName === undefined ? '' : `<RltdPties><Dbtr><Pty><Nm>${e.payerName}</Nm></Pty></Dbtr></RltdPties>`;
      const txDtls = rmtInf === '' && rltd === '' ? '' : `<NtryDtls><TxDtls>${rmtInf}${rltd}</TxDtls></NtryDtls>`;
      const amtTag = e.omitCcy === true ? `<Amt>${amount}</Amt>` : `<Amt Ccy="${ccy}">${amount}</Amt>`;
      const date = e.date ?? '2026-07-01';
      return `<Ntry>${e.entryRef === undefined ? '' : `<NtryRef>${e.entryRef}</NtryRef>`}${amtTag}<CdtDbtInd>${e.creditDebit}</CdtDbtInd>
<Sts><Cd>${e.status ?? 'BOOK'}</Cd></Sts><RvslInd>${e.reversalInd === true}</RvslInd>
<BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
${txDtls}</Ntry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${messageType === 'camt053' ? 'camt.053.001.08' : 'camt.054.001.08'}">
<${root}><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>2026-07-05T08:00:00</CreDtTm></GrpHdr>
<${stmtTag}><Id>${statementId}</Id><ElctrncSeqNb>${seqNb}</ElctrncSeqNb>
<FrToDt><FrDtTm>${fromDate}T00:00:00</FrDtTm><ToDtTm>${toDate}T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
${balances}
${ntry}
</${stmtTag}></${root}></Document>`;
}

const rows = (t, sql, ...p) => t.store.db.prepare(sql).all(t.workspaceId, ...p);
const n = (t, table, extra = '') =>
  t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? ${extra}`).get(t.workspaceId).n;

function moneyCounts(t) {
  return {
    statements: n(t, 'bank_statement'),
    txns: n(t, 'bank_txn'),
    credits: n(t, 'reconciliation_match'),
    payments: n(t, 'payment'),
    allocations: t.store.db
      .prepare(
        'SELECT COUNT(*) AS n FROM payment_allocation a JOIN payment p ON p.id = a.payment_id WHERE p.workspace_id = ?',
      )
      .get(t.workspaceId).n,
    entries: n(t, 'journal_entry'),
    links: n(t, 'bank_txn_link'),
  };
}

function bankNet(t) {
  return t.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ?`,
    )
    .get(t.workspaceId, t.bankId).net;
}

function openVendorBill(t, { amountMinor = 4000, key }) {
  const vendor = ok(
    createContact(t.ctx, { partyRole: 'vendor', name: `Lieferant ${key}`, idempotencyKey: `${key}-vendor` }),
  );
  const created = ok(
    createVendorBill(t.ctx, {
      vendorId: vendor.contact.id,
      billDate: '2026-07-01',
      amountMinor,
      taxCode: 'VST-M',
      expenseAccountId: t.acc('6500'),
      idempotencyKey: `${key}-bill`,
    }),
    'createVendorBill',
  );
  ok(postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: `${key}-post` }), 'postVendorBill');
  return created.vendorBillId;
}

// ==================================================================================================
// 1. DOUBLE-BOOKING ACROSS STATEMENT BOUNDARIES
// ==================================================================================================

test('baseline: the exact same file re-imported under a different key writes nothing twice', () => {
  const t = world();
  const xml = camt({ statementId: 'S1', entries: [{ entryRef: 'E1', amountMinor: 4000, creditDebit: 'DBIT' }] });
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'k1' }));
  const before = moneyCounts(t);
  const again = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'k2-different' }));
  assert.equal(again.duplicate, true);
  assert.deepEqual(moneyCounts(t), before, 're-import must write nothing');
});

test('[FIXED A20-C1, D178 re-cut] an OVERLAPPING statement imports the same bank entry only FLAGGED, never bookable twice', () => {
  const t = world();
  const contact = ok(createContact(t.ctx, { partyRole: 'customer', name: 'Zahler AG', idempotencyKey: 'zc' }));
  const invoice = issueInvoice(t.ctx, { contactId: contact.contact.id, key: 'ov' });
  const ref = buildQrrReference(invoice.number);

  const entry = {
    entryRef: 'BANKREF-42',
    amountMinor: GROSS_MINOR,
    creditDebit: 'CRDT',
    reference: ref,
    referenceKind: 'qrr',
    payerName: 'Zahler AG',
  };
  // Week 1 statement, then the bank's week 1+2 statement (a real and common shape: a corrected or
  // re-cut period). Same NtryRef, same amount, same value date. Different Stmt/Id. Both open at the
  // same balance, as a re-cut period does, so the second does not extend the chain.
  const first = ok(
    importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'W1', clbd: 100000 + GROSS_MINOR, entries: [entry] }), idempotencyKey: 'a' }),
  );
  assert.equal(first.txnCount, 1);
  const second = ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'W1-W2', seqNb: '2', clbd: 100000 + GROSS_MINOR, entries: [entry] }),
      idempotencyKey: 'b',
    }),
  );

  // D178 point 19 (the E2 re-cut, A20 §11.4): the second statement is a genuinely NEW `bank_statement`
  // row (different Stmt/Id), and it does not extend the balance chain (it opens at the same balance
  // over the same day), so it is an OVERLAP. A NtryRef is the account owner's reference, not the
  // bank's, so it drops nothing on its own: the line is imported FLAGGED, matched one to one on the
  // movement key to the stored line, and it waits for the person's answer. Never silent, never
  // bookable before the answer.
  assert.equal(second.duplicate, false, 'the STATEMENT itself is not a duplicate: different Stmt/Id');
  assert.equal(second.txnCount, 1, 'the line is imported, flagged');
  assert.deepEqual(second.skipped, []);
  const [firstLine, secondLine] = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').map((r) => r.id);
  assert.equal(second.nearDuplicates.length, 1);
  assert.equal(second.nearDuplicates[0].bankTxnId, secondLine);
  assert.equal(second.nearDuplicates[0].existingBankTxnId, firstLine, 'the flag names the stored line it matched');
  assert.equal(second.nearDuplicates[0].reason, 'same_movement');
  assert.ok(second.warnings.includes('overlap_same_movement'));
  fails(
    bookBankLine(t.ctx, { bankTxnId: secondLine, target: { kind: 'open_item', documentId: invoice.id }, idempotencyKey: 'bk2' }),
    'duplicate_decision_pending',
  );

  // The person answers "Duplikat": the flagged line is ignored, and the money stays one movement.
  ok(resolvePossibleDuplicate(t.ctx, { bankTxnId: secondLine, decision: 'duplicate', idempotencyKey: 'rd' }));
  const netBefore = bankNet(t);
  ok(bookBankLine(t.ctx, { bankTxnId: firstLine, target: { kind: 'open_item', documentId: invoice.id }, idempotencyKey: 'bk1' }));
  assert.equal(bankNet(t) - netBefore, GROSS_MINOR, 'one real credit moves the bank account exactly once');
  assert.equal(
    bookBankLine(t.ctx, { bankTxnId: secondLine, target: { kind: 'open_item', documentId: invoice.id }, idempotencyKey: 'bk3' }).ok,
    false,
    'the line answered as a duplicate is ignored and never books',
  );
});

test('[FIXED A20-C1, D178 re-cut] the overlap\'s queue row only follows its flagged line, so it cannot be double-applied', () => {
  const t = world();
  const contact = ok(createContact(t.ctx, { partyRole: 'customer', name: 'Zahler AG', idempotencyKey: 'zc' }));
  const invoice = issueInvoice(t.ctx, { contactId: contact.contact.id, key: 'ov2' });
  const ref = buildQrrReference(invoice.number);
  const entry = {
    entryRef: 'BANKREF-99',
    amountMinor: GROSS_MINOR,
    creditDebit: 'CRDT',
    reference: ref,
    referenceKind: 'qrr',
  };
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'X1', clbd: 100000 + GROSS_MINOR, entries: [entry] }), idempotencyKey: 'a' }));
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'X2', seqNb: '2', clbd: 100000 + GROSS_MINOR, entries: [entry] }),
      idempotencyKey: 'b',
    }),
  );
  // D178 point 19 (the E2 re-cut): the overlapping line is imported FLAGGED, so it carries its own A21
  // row; that row only FOLLOWS its line (A39 L2), so the old exploit (apply both rows) still has no way
  // in: the A21 verbs refuse use_bank_inbox, and the inbox refuses the flagged line until it is answered.
  const queue = rows(t, 'SELECT id FROM reconciliation_match WHERE workspace_id = ? ORDER BY rowid');
  assert.equal(queue.length, 2, 'the flagged line has its following A21 row');
  for (const [i, q] of queue.entries()) {
    fails(applyQrMatch(t.ctx, { creditId: q.id, invoiceId: invoice.id, idempotencyKey: `aq${i}` }), 'use_bank_inbox');
  }

  const netBefore = bankNet(t);
  const line = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid');
  assert.equal(line.length, 2, 'the real line and the flagged one');
  fails(
    bookBankLine(t.ctx, { bankTxnId: line[1].id, target: { kind: 'open_item', documentId: invoice.id }, idempotencyKey: 'ap2' }),
    'duplicate_decision_pending',
  );
  ok(bookBankLine(t.ctx, { bankTxnId: line[0].id, target: { kind: 'open_item', documentId: invoice.id }, idempotencyKey: 'ap1' }), 'book 1');
  const moved = bankNet(t) - netBefore;
  assert.equal(moved, GROSS_MINOR, 'the single real credit moves the bank account exactly once');
});

test('[A39 L7 (c), D140] a camt.054 is refused at the door, and the day-end camt.053 books the money ONCE', () => {
  const t = world();
  const entry = { entryRef: 'NTF-7', amountMinor: 25000, creditDebit: 'CRDT' };
  // The bank notifies the credit intraday (camt.054), then delivers it again on the end-of-day camt.053.
  // camt.054 is cut for go-live (D140): the notification is refused and writes nothing.
  const before = moneyCounts(t);
  fails(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ messageType: 'camt054', statementId: 'NTFCN-1', entries: [entry] }),
      idempotencyKey: 'ntf',
    }),
    'camt054_refused',
  );
  assert.deepEqual(moneyCounts(t), before, 'the refused camt.054 wrote nothing');
  const second = ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'DAY-1', entries: [entry] }),
      idempotencyKey: 'day',
    }),
  );
  assert.equal(second.txnCount, 1);
  const c = moneyCounts(t);
  assert.equal(c.txns, 1, 'the credit is imported once, from the statement');
  assert.equal(c.credits, 1, 'queued exactly once');
});

test('[FIXED A20-C2] an AMENDED statement (same id/seq, corrected amount) refuses statement_amended, naming the change', () => {
  const t = world();
  const first = camt({ statementId: 'AM-1', entries: [{ entryRef: 'E1', amountMinor: 4000, creditDebit: 'DBIT' }] });
  const amended = camt({ statementId: 'AM-1', entries: [{ entryRef: 'E1', amountMinor: 9999, creditDebit: 'DBIT' }] });
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: first, idempotencyKey: 'a' }));
  const res = fails(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: amended, idempotencyKey: 'b' }), 'statement_amended');
  // FIXED (D81/A20-C2): the answer names what changed, and is NOT the `duplicate:true` a
  // byte-identical re-import gets, so the operator cannot mistake a discarded correction for
  // "already have this".
  assert.ok(
    res.changes.some((c) => c.includes('nr:E1') && c.includes('4000') && c.includes('9999')),
    `expected the diff to name the amount change, got ${JSON.stringify(res.changes)}`,
  );
  const txn = rows(t, 'SELECT amount_minor FROM bank_txn WHERE workspace_id = ?');
  assert.equal(txn.length, 1);
  // The stale figure is left standing (a silent overwrite would be worse than a silent drop): the
  // operator now KNOWS a correction is waiting, which is the actual fix.
  assert.equal(txn[0].amount_minor, 4000, 'the stale amount is left alone; a human decides what to do with the correction');
});

// ==================================================================================================
// 2. THE A21 SEAM
// ==================================================================================================

test('a high-confidence credit auto-applied by A21 moves the money exactly once', () => {
  const t = world();
  ok(setQrAutoApply(t.ctx, { autoApply: true, idempotencyKey: 'dial' }), 'setQrAutoApply');
  const contact = ok(createContact(t.ctx, { partyRole: 'customer', name: 'Zahler AG', idempotencyKey: 'zc' }));
  const invoice = issueInvoice(t.ctx, { contactId: contact.contact.id, key: 'auto' });
  const ref = buildQrrReference(invoice.number);
  const xml = camt({
    statementId: 'AUTO-1',
    entries: [{ entryRef: 'A1', amountMinor: GROSS_MINOR, creditDebit: 'CRDT', reference: ref, referenceKind: 'qrr' }],
  });
  const before = bankNet(t);
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'auto' }));
  const moved = bankNet(t) - before;
  assert.ok(moved === 0 || moved === GROSS_MINOR, `money moved ${moved}, expected 0 or exactly ${GROSS_MINOR}`);
  // And a re-import of the SAME statement under a fresh key must not move it again.
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'auto-2' }));
  assert.equal(bankNet(t) - before, moved, 're-import moved money again');
});

test('§H-TENANT: a bankTxnId from another workspace is invisible to confirm/create/list', () => {
  const t = world();
  const other = secondWorkspace(t);
  const xml = camt({ statementId: 'T1', entries: [{ entryRef: 'E1', amountMinor: 4000, creditDebit: 'DBIT' }] });
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'ten' }));
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;
  const stmtId = rows(t, 'SELECT id FROM bank_statement WHERE workspace_id = ?')[0].id;

  fails(confirmCamtMatch(other.ctx, { bankTxnId: txnId, entryId: 'x', idempotencyKey: 'c' }), undefined, 'cross-tenant confirm');
  fails(
    createEntryForTxn(other.ctx, { bankTxnId: txnId, contraAccountId: other.acc('6500') ?? 'x', idempotencyKey: 'e' }),
    'not_found',
    'cross-tenant createEntry',
  );
  fails(listReconciliation(other.ctx, { statementId: stmtId }), 'not_found', 'cross-tenant list');
  const seen = ok(listReconciliation(other.ctx, {}));
  assert.deepEqual([...seen.matched, ...seen.unmatched, ...seen.partial], [], 'no foreign txn leaks into the board');
});

test("a credit's board status follows the A21 queue row after an override (D77 judgment verbs)", () => {
  const t = world();
  const contact = ok(createContact(t.ctx, { partyRole: 'customer', name: 'Zahler AG', idempotencyKey: 'zc' }));
  const invoice = issueInvoice(t.ctx, { contactId: contact.contact.id, key: 'ovr' });
  const ref = buildQrrReference(invoice.number);
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({
        statementId: 'OV-1',
        entries: [{ entryRef: 'E1', amountMinor: GROSS_MINOR, creditDebit: 'CRDT', reference: ref, referenceKind: 'qrr' }],
      }),
      idempotencyKey: 'ov',
    }),
  );
  const board = ok(listReconciliation(t.ctx, {}));
  const all = [...board.matched, ...board.unmatched, ...board.partial];
  assert.equal(all.length, 1);
  const view = all[0];
  assert.equal(view.classification, 'incoming_credit');
  assert.notEqual(view.creditId, null, 'the board names the A21 row that decides this credit');

  // A39 L2: the line is decided on the bank inbox; the board and the A21 row both follow the line.
  ok(bookBankLine(t.ctx, { bankTxnId: view.bankTxnId, target: { kind: 'open_item', documentId: invoice.id }, idempotencyKey: 'ap' }));
  const after = ok(listReconciliation(t.ctx, {}));
  assert.equal(after.matched.length, 1, 'the board follows the line decision without A20 storing a status');
});

// ==================================================================================================
// 3. THE DEBIT PATH
// ==================================================================================================

test('[FIXED A20-C3] a REVERSAL CREDIT (money IN) refuses wrong_direction, never settles as an OUTGOING payment', () => {
  const t = world();
  const billId = openVendorBill(t, { amountMinor: 4324, key: 'rev' });
  // A returned outgoing payment: the bank credits the account back, with RvslInd=true. A20
  // classifies it `unclassified`; `confirmCamtMatch` used to refuse only `incoming_credit`.
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({
        statementId: 'REV-1',
        entries: [{ entryRef: 'R1', amountMinor: 4324, creditDebit: 'CRDT', reversalInd: true }],
      }),
      idempotencyKey: 'rev',
    }),
  );
  const txn = rows(t, 'SELECT id, classification, credit_debit FROM bank_txn WHERE workspace_id = ?')[0];
  assert.equal(txn.classification, 'unclassified');
  assert.equal(txn.credit_debit, 'CRDT');

  const before = bankNet(t);
  const res = fails(
    confirmCamtMatch(t.ctx, { bankTxnId: txn.id, vendorBillId: billId, idempotencyKey: 'cf' }),
    'wrong_direction',
  );
  // FIXED: the guard now compares the bank fact's OWN direction (`credit_debit`) against the
  // direction a settlement always books (outgoing), not just the classification.
  assert.equal(res.creditDebit, 'CRDT');
  assert.equal(bankNet(t), before, 'a refused confirm must move nothing');

  // The manual entryId LINK stays open to both directions (it only annotates an entry a human
  // already posted, it never decides a direction of its own).
  const manualEntryId = 'whatever-id-a-human-already-posted';
  const linkResult = confirmCamtMatch(t.ctx, { bankTxnId: txn.id, entryId: manualEntryId, idempotencyKey: 'cf-link' });
  assert.notEqual(linkResult.error, 'wrong_direction', 'the entryId annotation path is not direction-gated');
});

test('a DEBIT settling MULTIPLE vendor bills is atomic: one bad leg writes nothing', () => {
  const t = world();
  const grossA = 3000;
  const grossB = 2000;
  const a = openVendorBill(t, { amountMinor: grossA, key: 'm1' });
  const b = openVendorBill(t, { amountMinor: grossB, key: 'm2' });
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({
        statementId: 'MB-1',
        entries: [{ entryRef: 'D1', amountMinor: grossA + grossB, creditDebit: 'DBIT' }],
      }),
      idempotencyKey: 'mb',
    }),
  );
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;

  const before = moneyCounts(t);
  // Leg two names a bill that does not exist: the whole confirm must write nothing at all.
  const bad = confirmCamtMatch(t.ctx, {
    bankTxnId: txnId,
    allocations: [
      { vendorBillId: a, amountMinor: grossA },
      { vendorBillId: 'vb_does_not_exist', amountMinor: grossB },
    ],
    idempotencyKey: 'bad',
  });
  assert.equal(bad.ok, false, `a bad leg must refuse, got ${JSON.stringify(bad)}`);
  assert.deepEqual(moneyCounts(t), before, 'a refused multi-bill confirm must write NOTHING');

  // The good shape then settles both, once.
  const good = confirmCamtMatch(t.ctx, {
    bankTxnId: txnId,
    allocations: [
      { vendorBillId: a, amountMinor: grossA },
      { vendorBillId: b, amountMinor: grossB },
    ],
    idempotencyKey: 'good',
  });
  assert.equal(good.ok, true, `the corrected confirm must succeed, got ${JSON.stringify(good)}`);
  const after = moneyCounts(t);
  assert.equal(after.payments, before.payments + 1);
  assert.equal(after.allocations, before.allocations + 2);
  assert.equal(after.links, before.links + 1);
});

test('REFUTED: a failed confirm does NOT poison the fixed A14 key `camt-confirm-<bankTxnId>`', () => {
  const t = world();
  const bill = openVendorBill(t, { amountMinor: 3243, key: 'poison' });
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'PZ-1', entries: [{ entryRef: 'D1', amountMinor: 3243, creditDebit: 'DBIT' }] }),
      idempotencyKey: 'pz',
    }),
  );
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;

  // Attempt 1: the operator names the wrong bill. A14 refuses.
  const wrong = confirmCamtMatch(t.ctx, {
    bankTxnId: txnId,
    vendorBillId: 'vb_typo',
    idempotencyKey: 'try-1',
  });
  assert.equal(wrong.ok, false);

  // Attempt 2: corrected, and with a FRESH idempotency key, which is exactly what a retrying
  // operator or agent does. A20 passes A14 the FIXED key `camt-confirm-<bankTxnId>` regardless.
  const retry = confirmCamtMatch(t.ctx, { bankTxnId: txnId, vendorBillId: bill, idempotencyKey: 'try-2' });
  const paymentCount = moneyCounts(t).payments;
  if (!retry.ok) {
    assert.fail(`OBSERVED: the corrected retry is refused forever, ${JSON.stringify(retry)}`);
  }
  assert.equal(paymentCount, 1, 'the corrected retry must actually settle');
  // A14 validates its allocations BEFORE entering `rememberIdempotent`, so the first (refused)
  // attempt stored nothing under `camt-confirm-<bankTxnId>`. The fixed key is therefore safe TODAY,
  // by A14's ordering rather than by anything A20 asserts.
});

test('a debit confirmed twice under different keys links and pays exactly once', () => {
  const t = world();
  const bill = openVendorBill(t, { amountMinor: 3243, key: 'once' });
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'ON-1', entries: [{ entryRef: 'D1', amountMinor: 3243, creditDebit: 'DBIT' }] }),
      idempotencyKey: 'on',
    }),
  );
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;
  ok(confirmCamtMatch(t.ctx, { bankTxnId: txnId, vendorBillId: bill, idempotencyKey: 'c1' }));
  const mid = moneyCounts(t);
  // A39 (walk B14.3): a fresh key on a booked line is a second decision, refused and named, not echoed.
  const second = confirmCamtMatch(t.ctx, { bankTxnId: txnId, vendorBillId: bill, idempotencyKey: 'c2-different' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'line_not_open');
  assert.deepEqual(moneyCounts(t), mid, 'a second confirm under a fresh key must write nothing');
});

test('[FIXED A20-C1, D178 re-cut] a duplicated DEBIT is booked into the ledger exactly ONCE, guarded by the duplicate answer', () => {
  const t = world();
  const fee = { entryRef: 'FEE-1', amountMinor: 4000, creditDebit: 'DBIT' };
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'F1', clbd: 96000, entries: [fee] }), idempotencyKey: 'f1' }));
  const second = ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'F2', seqNb: '2', clbd: 96000, entries: [fee] }),
      idempotencyKey: 'f2',
    }),
  );
  // D178 point 19 (the E2 re-cut): the debit lane has the same backstop as the credit lane. The
  // overlapping fee is imported FLAGGED (same_movement) and no booking path takes it before the answer.
  assert.equal(second.txnCount, 1, 'imported, flagged');
  assert.equal(second.nearDuplicates[0].reason, 'same_movement');
  const txns = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY rowid');
  assert.equal(txns.length, 2);
  fails(
    createEntryForTxn(t.ctx, { bankTxnId: txns[1].id, contraAccountId: t.acc('6500'), idempotencyKey: 'ce-early' }),
    'duplicate_decision_pending',
  );
  ok(resolvePossibleDuplicate(t.ctx, { bankTxnId: txns[1].id, decision: 'duplicate', idempotencyKey: 'rd' }));

  const before = bankNet(t);
  for (const [i, x] of txns.entries()) {
    const res = createEntryForTxn(t.ctx, { bankTxnId: x.id, contraAccountId: t.acc('6500'), idempotencyKey: `ce${i}` });
    if (i === 0) ok(res);
    else assert.equal(res.ok, false, 'the line answered as a duplicate never books');
  }
  // FIXED: one real CHF 40.00 bank fee, exactly CHF 40.00 taken out of 1020. The entry-identity key
  // (D81) protects the DEBIT lane exactly as it protects the credit lane, instead of relying on A21's
  // document-level guard alone.
  assert.equal(bankNet(t) - before, -4000, 'FIXED: a single 40.00 fee is booked exactly once');
  assert.equal(n(t, 'journal_entry', "AND source = 'camt'"), 1);
});

// ==================================================================================================
// 4. AS-OF RECONCILIATION
// ==================================================================================================

test('the reconciled flag is an as-of statement: a FUTURE-dated entry does not spoil it', () => {
  const t = world();
  // The bank says the account closed 2026-07-01 at 400.00 after one 40.00 debit.
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({
        statementId: 'AS-1',
        toDate: '2026-07-01',
        opbd: 44000,
        clbd: 40000,
        entries: [{ entryRef: 'E1', amountMinor: 4000, creditDebit: 'DBIT', date: '2026-07-01' }],
      }),
      idempotencyKey: 'as',
    }),
  );
  const stmtId = rows(t, 'SELECT id FROM bank_statement WHERE workspace_id = ?')[0].id;
  const revenue = t.acc('3000');
  ok(
    postEntry(t.ctx, {
      date: '2026-06-01',
      source: 'manual',
      description: 'Eröffnung',
      idempotencyKey: 'seed-open',
      lines: [
        { account: t.bankId, debit: 44000 },
        { account: revenue, credit: 44000 },
      ],
    }),
  );
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;
  ok(createEntryForTxn(t.ctx, { bankTxnId: txnId, contraAccountId: revenue, idempotencyKey: 'bk' }));
  assert.equal(ok(listReconciliation(t.ctx, { statementId: stmtId })).reconciled, true, 'the books agree as of 01.07');

  // A movement AFTER the statement date must not change the as-of answer.
  ok(
    postEntry(t.ctx, {
      date: '2026-07-15',
      source: 'manual',
      description: 'spätere Bewegung',
      idempotencyKey: 'later',
      lines: [
        { account: t.bankId, debit: 5000 },
        { account: revenue, credit: 5000 },
      ],
    }),
  );
  assert.equal(
    ok(listReconciliation(t.ctx, { statementId: stmtId })).reconciled,
    true,
    'a later entry must not un-reconcile a closed statement',
  );
});

test('A20-C5 (nit/strengthening): a same-net ghost in/out before the period still reconciles (unchanged, genuinely correct)', () => {
  const t = world();
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'PD-1', fromDate: '2026-07-01', toDate: '2026-07-31', opbd: 0, clbd: 0, entries: [] }),
      idempotencyKey: 'pd',
    }),
  );
  const stmtId = rows(t, 'SELECT id FROM bank_statement WHERE workspace_id = ?')[0].id;
  assert.equal(ok(listReconciliation(t.ctx, { statementId: stmtId })).reconciled, true, 'empty books, zero balance');
  // Two entries dated BEFORE the statement's from_date that fully offset each other: the ledger
  // balance strictly before 01.07 genuinely is 0, matching the bank's OPBD of 0.00. The critic rated
  // this a NIT/strengthening rather than a defect for exactly this reason: comparing OPBD too does
  // not change the answer HERE, since both ends of the period genuinely agree. See the next test for
  // a scenario where the two sides genuinely disagree and the (now-added) OPBD comparison catches it.
  ok(
    postEntry(t.ctx, {
      date: '2026-06-01',
      source: 'manual',
      description: 'ein Betrag den die Bank nie sah',
      idempotencyKey: 'ghost-in',
      lines: [
        { account: t.bankId, debit: 12345 },
        { account: t.acc('3000'), credit: 12345 },
      ],
    }),
  );
  ok(
    postEntry(t.ctx, {
      date: '2026-06-02',
      source: 'manual',
      description: 'und wieder heraus',
      idempotencyKey: 'ghost-out',
      lines: [
        { account: t.acc('3000'), debit: 12345 },
        { account: t.bankId, credit: 12345 },
      ],
    }),
  );
  assert.equal(
    ok(listReconciliation(t.ctx, { statementId: stmtId })).reconciled,
    true,
    'the ledger genuinely nets to zero before the period too: this was never actually wrong',
  );
});

test('[FIXED A20-C5] a GENUINE opening-balance disagreement is now caught, even though the closing side agrees', () => {
  const t = world();
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'PD-2', fromDate: '2026-07-01', toDate: '2026-07-31', opbd: 0, clbd: 5000, entries: [] }),
      idempotencyKey: 'pd2',
    }),
  );
  const stmtId = rows(t, 'SELECT id FROM bank_statement WHERE workspace_id = ?')[0].id;
  // The bank says OPBD 0.00 on 01.07. The ledger disagrees: a manual entry dated BEFORE the period
  // leaves a genuine, un-offset 50.00 sitting on the books that the bank never reported.
  ok(
    postEntry(t.ctx, {
      date: '2026-06-15',
      source: 'manual',
      description: 'ein Betrag der vor der Periode liegen bleibt',
      idempotencyKey: 'stray-opening',
      lines: [
        { account: t.bankId, debit: 5000 },
        { account: t.acc('3000'), credit: 5000 },
      ],
    }),
  );
  // The closing side happens to agree (5000 == CLBD 5000.00, since nothing moved during July), so
  // the OLD closing-only check would have said `true`. FIXED: the OPBD comparison catches the
  // genuine opening disagreement and the statement is correctly NOT reconciled.
  assert.equal(
    ok(listReconciliation(t.ctx, { statementId: stmtId })).reconciled,
    false,
    'FIXED: a real opening-balance mismatch is now caught even though the closing side agrees',
  );
});

// ==================================================================================================
// 5. PARSER ROBUSTNESS AND HONESTY
// ==================================================================================================

test('[FIXED A20-C6] an entry the parser cannot read is NAMED, not silently dropped', () => {
  const t = world();
  const xml = camt({
    statementId: 'SD-1',
    entries: [
      { entryRef: 'GOOD', amountMinor: 4000, creditDebit: 'DBIT' },
      { entryRef: 'NO-CCY', amountMinor: 9900, creditDebit: 'CRDT', omitCcy: true },
      { entryRef: 'ODD-STS', amountMinor: 7700, creditDebit: 'DBIT', status: 'INFO' },
    ],
  });
  const parsed = ok(parseCamt(xml));
  // Still one ENTRY (the unreadable ones never become a bank_txn candidate), but now the parser
  // reports WHY the other two were not: this is the fix, not a change in which ones import.
  assert.equal(parsed.statement.entries.length, 1);
  assert.deepEqual(parsed.statement.skipped, [
    { entryRef: 'NO-CCY', reason: 'unreadable_amount' },
    { entryRef: 'ODD-STS', reason: 'unsupported_status', status: 'INFO' },
  ]);

  const res = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'sd' }));
  // FIXED: `{ok:true, txnCount:1}` is now accompanied by a `skipped` list naming exactly what was
  // dropped and why, instead of a silent truncation the caller has no way to notice.
  assert.equal(res.txnCount, 1);
  assert.deepEqual(res.skipped, [
    { entryRef: 'NO-CCY', reason: 'unreadable_amount' },
    { entryRef: 'ODD-STS', reason: 'unsupported_status', status: 'INFO' },
  ]);
  assert.equal(n(t, 'bank_txn'), 1);
});

test('[NEW] a legitimate PDNG skip is reported the same honest way, never invisible', () => {
  const t = world();
  const xml = camt({
    statementId: 'PDNG-1',
    entries: [{ entryRef: 'PENDING-1', amountMinor: 5000, creditDebit: 'DBIT', status: 'PDNG' }],
  });
  const res = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'pdng' }));
  assert.equal(res.txnCount, 0);
  assert.deepEqual(res.skipped, [{ entryRef: 'PENDING-1', reason: 'pending' }]);
});

test('[FIXED A20-C7] a multi-Stmt camt message REFUSES rather than silently dropping the second account', () => {
  const one = camt({ statementId: 'M-1', entries: [{ entryRef: 'A', amountMinor: 1000, creditDebit: 'DBIT' }] });
  const two = camt({ statementId: 'M-2', entries: [{ entryRef: 'B', amountMinor: 2000, creditDebit: 'DBIT' }] });
  // Splice the second Stmt into the first message, which is what a bank export carrying two
  // accounts (or a non-conforming multi-account file) looks like on the wire.
  const secondStmt = two.slice(two.indexOf('<Stmt>'), two.indexOf('</Stmt>') + '</Stmt>'.length);
  const merged = one.replace('</Stmt>', `</Stmt>\n${secondStmt}`);
  // FIXED: SPS 2.3 p.45, "Only one instance will be provided, one account per camt message". A
  // second top-level Stmt is a non-conforming export; parseCamt now refuses it honestly (P9) rather
  // than silently importing only the first account and dropping the second (A20-C7).
  fails(parseCamt(merged), 'schema_invalid');
});

test('a foreign-currency statement on a CHF Bankkonto: import, and what it refuses downstream', () => {
  const t = world();
  const res = importCamt(t.ctx, {
    bankAccountId: t.bankAccountId,
    xml: camt({
      statementId: 'FX-1',
      currency: 'EUR',
      entries: [{ entryRef: 'E1', amountMinor: 5000, creditDebit: 'DBIT', currency: 'EUR' }],
    }),
    idempotencyKey: 'fx',
  });
  if (res.ok) {
    const txn = rows(t, 'SELECT id, currency FROM bank_txn WHERE workspace_id = ?')[0];
    assert.equal(txn.currency, 'EUR', 'the bank_txn keeps its own currency verbatim (§H-FX)');
    // A39: a EUR line on a CHF Bankkonto cannot book into the CHF bank account's ledger account (a
    // line in the ACCOUNT's own foreign currency can, at the stored rate); still currency_mismatch.
    fails(
      createEntryForTxn(t.ctx, { bankTxnId: txn.id, contraAccountId: t.acc('3000'), idempotencyKey: 'fxe' }),
      'currency_mismatch',
      'cross-currency manual booking',
    );
    const stmtId = rows(t, 'SELECT id FROM bank_statement WHERE workspace_id = ?')[0].id;
    const board = ok(listReconciliation(t.ctx, { statementId: stmtId }));
    assert.equal('reconciled' in board, false, 'no converted-guess indicator on a foreign-currency statement');
  } else {
    assert.ok(true, `import refused a currency mismatch with ${res.error}`);
  }
});

test('an IBAN mismatch refuses and writes nothing; an entry with no reference still imports', () => {
  const t = world();
  const before = moneyCounts(t);
  fails(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'IB-1', iban: 'CH5604835012345678009', entries: [{ entryRef: 'E', amountMinor: 100, creditDebit: 'DBIT' }] }),
      idempotencyKey: 'ib',
    }),
    // A39 D-A39.9: an IBAN registered nowhere is a missing account, not a mismatch between two.
    'needs_bank_account',
  );
  assert.deepEqual(moneyCounts(t), before, 'a refused import writes nothing');

  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'NR-1', entries: [{ amountMinor: 4000, creditDebit: 'DBIT' }] }),
      idempotencyKey: 'nr',
    }),
  );
  const txn = rows(t, 'SELECT entry_ref, reference_kind, reference_value FROM bank_txn WHERE workspace_id = ?')[0];
  assert.equal(txn.entry_ref, null);
  assert.equal(txn.reference_kind, 'none');
  assert.equal(txn.reference_value, null);
});

test('truncated XML refuses honestly and imports nothing at all', () => {
  const t = world();
  const xml = camt({ statementId: 'TR-1', entries: [{ entryRef: 'E', amountMinor: 4000, creditDebit: 'DBIT' }] });
  const before = moneyCounts(t);
  const truncated = xml.slice(0, Math.floor(xml.length * 0.6));
  const res = importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: truncated, idempotencyKey: 'tr' });
  if (res.ok) {
    assert.equal(res.txnCount, 0, `a truncated file must not import a movement, got ${JSON.stringify(res)}`);
  }
  assert.equal(n(t, 'bank_txn'), 0, 'no txn from a truncated file');
  assert.equal(moneyCounts(t).payments, before.payments);
});

// ==================================================================================================
// 6. G01 AUTOMATION: which moments actually fire
// ==================================================================================================

test('[A20-C8, DOCUMENTED not fixed] importing credits fires NO needs-review moment; the spec now says so honestly', async () => {
  const { getAction } = await import('../../dist/api/registry.js');
  const { AUTOMATION_EVENTS } = await import('../../dist/core/automation/events.js');
  const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
  const { defineRule, runRows } = await import('../automation/support.mjs');
  const run = (deps, name, input) => getAction(name).run(deps, input);

  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Abgleich AG', 'c8-ws');
  const bank = ok(
    run(deps, 'create_bank_account', {
      workspaceId,
      name: 'PostFinance',
      iban: 'CH93 0076 2011 6238 5295 7',
      currency: 'CHF',
      ledgerAccountId: accId('1020'),
      idempotencyKey: 'c8-bank',
    }),
    'create_bank_account',
  );

  // A20 §0 note 5 states, as a REASON for not registering a per-txn review event: "The per-credit
  // review moment already exists: A21's `qr_match.needs_review` fires from the queue registration
  // A20's importer performs."
  const claim = AUTOMATION_EVENTS.find((e) => e.event === 'qr_match.needs_review');
  assert.equal(claim.emittedBy, 'record_incoming_credit');

  const ruleId = defineRule(
    deps,
    workspaceId,
    { name: 'review', event: 'qr_match.needs_review', tool: 'post_entry', template: {} },
    'c8-rule',
  );
  assert.ok(ruleId);

  // A credit with NO reference at all: A21 scores it low, so it is exactly the credit a human must
  // look at, and the one `qr_match.needs_review` exists for.
  ok(
    run(deps, 'import_camt', {
      workspaceId,
      bankAccountId: bank.bankAccountId,
      xml: camt({ statementId: 'C8-1', entries: [{ entryRef: 'E1', amountMinor: 50000, creditDebit: 'CRDT' }] }),
      idempotencyKey: 'c8-imp',
    }),
    'import_camt',
  );
  const queued = deps.store.db
    .prepare("SELECT id, confidence FROM reconciliation_match WHERE workspace_id = ?")
    .all(workspaceId);
  assert.equal(queued.length, 1, 'the credit really did reach the queue');
  assert.notEqual(queued[0].confidence, 'high', 'and it really does need review');

  // STILL TRUE, and intentionally not remediated here (A20-C8, D59's cheapest allowed option): the
  // dispatch fires by ACTION NAME after `action.run`; `importCamt` calls the ENGINE function
  // `recordIncomingCredit` directly, so the `record_incoming_credit` action never runs and its
  // event never fires. Building a real per-txn firing needs G01's dispatch to resolve MORE than one
  // entity id from a single action call, which is out of A20's file ownership (`src/core/automation`)
  // and a materially bigger change than this remediation's scope. THE FIX HERE IS THE SPEC:
  // A20-camt-reconciliation.md §0 note 5 no longer claims a review moment exists on this path; it
  // now names this test and points at G01 as the capability that owns the real repair.
  const runs = runRows(deps, workspaceId).filter((r) => r.trigger_event === 'qr_match.needs_review');
  assert.deepEqual(runs, [], 'no needs-review automation fires for a camt-imported credit (known gap, spec corrected, owed to G01)');
});

test('the three A20 events resolve a real entity id from the real payload', async () => {
  const { AUTOMATION_EVENTS } = await import('../../dist/core/automation/events.js');
  const a20 = AUTOMATION_EVENTS.filter((e) =>
    ['import_camt', 'confirm_match', 'create_entry_for_txn'].includes(e.emittedBy),
  );
  assert.equal(a20.length, 3);
  assert.deepEqual(
    a20.map((e) => `${e.event}:${e.entityIdPath}`),
    [
      'bank_statement.imported:result.statementId',
      'bank_txn.matched:input.bankTxnId',
      'bank_txn.booked:input.bankTxnId',
    ],
  );
  // `bank_statement.imported` carries no entityKind, so a condition on a bank_statement custom
  // field cannot be written. `bank_statement` is not a G00 entity kind either, so this is
  // consistent rather than a gap.
  assert.equal(a20[0].entityKind, undefined);
});

// ==================================================================================================
// 7. THE STANDARD ITSELF, re-read against the primary source
//    SPS 2.3 (20.02.2026), `ig-cash-management-sps-2026-en.pdf`, fetched and read by this critic:
//    p.44 (Bal: "camt.054: Element does not exist"), p.45 (Stmt 1..n "Only one instance will be
//    provided, one account per camt message"; Id "unique for a period of at least one calendar
//    year"; ElctrncSeqNb "mandatory for camt.052/camt.053"), p.53 ("camt.053: Is always sent"),
//    p.54 (Cd: "mandatory OPBD in combination with CLBD"; SubTp/Cd: "Multi-page statement: where an
//    account statement is divided into more than one message ... the relevant interim balances are
//    identified with the code INTM"), p.61 ("One booking can combine several transactions"; the
//    PDNG variant listed for camt.052 and camt.054 only), p.102-103 (SCOR under Tp/CdOrPrtry/Cd,
//    QRR under Tp/CdOrPrtry/Prtry, value in Ref).
//    The four facts the author cited are CORRECT. These two are facts the author did not read.
// ==================================================================================================

/** A page of a multi-page camt.053 (SPS 2.3 p.54): same Stmt/Id and ElctrncSeqNb, StmtPgntn differs. */
function camtPage(pgNb, lastPage, entries, interimClosing) {
  const total = entries.reduce((s, e) => s + e.amountMinor, 0);
  return `<Document><BkToCstmrStmt><GrpHdr><MsgId>MSG-${pgNb}</MsgId></GrpHdr>
<Stmt><Id>STMT-2026-07</Id><StmtPgntn><PgNb>${pgNb}</PgNb><LastPgInd>${lastPage}</LastPgInd></StmtPgntn>
<ElctrncSeqNb>7</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-31T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry>${
    interimClosing ? '<SubTp><CdOrPrtry><Cd>INTM</Cd></CdOrPrtry></SubTp>' : ''
  }</Tp><Amt Ccy="CHF">${(total / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
${entries
  .map(
    (e) =>
      `<Ntry><NtryRef>${e.entryRef}</NtryRef><Amt Ccy="CHF">${(e.amountMinor / 100).toFixed(
        2,
      )}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-07-05</Dt></BookgDt><ValDt><Dt>2026-07-05</Dt></ValDt></Ntry>`,
  )
  .join('')}
</Stmt></BkToCstmrStmt></Document>`;
}

test('[FIXED A20-C9] a MULTI-PAGE camt.053 keeps every movement; page number is part of the identity', () => {
  const t = world();
  const p1 = camtPage(1, 'false', [{ entryRef: 'P1-A', amountMinor: 10000 }, { entryRef: 'P1-B', amountMinor: 20000 }], true);
  const p2 = camtPage(2, 'true', [{ entryRef: 'P2-A', amountMinor: 30000 }, { entryRef: 'P2-B', amountMinor: 40000 }], false);

  const first = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: p1, idempotencyKey: 'pg1' }));
  assert.equal(first.txnCount, 2);
  const second = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: p2, idempotencyKey: 'pg2' }));

  // FIXED (D81): `StmtPgntn/PgNb` is part of the statement's identity, so page 2 is a genuinely NEW
  // `bank_statement` row (both pages share Stmt/Id and ElctrncSeqNb BY DESIGN, SPS 2.3 p.54, but that
  // is exactly why pagination has to be in the key), and its CHF 700.00 of movements are kept.
  assert.equal(second.duplicate, false, 'FIXED: page 2 is not treated as a re-import of page 1');
  assert.equal(second.txnCount, 2);
  assert.equal(n(t, 'bank_statement'), 2, 'FIXED: one row per page, not one merged/collided row');
  const kept = rows(t, 'SELECT entry_ref FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').map((r) => r.entry_ref);
  assert.deepEqual(kept, ['P1-A', 'P1-B', 'P2-A', 'P2-B'], 'FIXED: all four movements are on the books');

  // FIXED: page 1's Bal is flagged INTM (SPS 2.3 p.54) and is never stored as a real closing figure;
  // page 2 (LastPgInd=true, no INTM flag) carries the genuine closing balance and the last_page flag
  // that gates the D64 `reconciled` indicator.
  const [page1, page2] = rows(
    t,
    'SELECT id, page_number, last_page_ind, closing_balance_minor FROM bank_statement WHERE workspace_id = ? ORDER BY page_number',
  );
  assert.equal(page1.page_number, 1);
  assert.equal(page1.last_page_ind, 0);
  assert.equal(page1.closing_balance_minor, null, 'FIXED: an INTM interim balance is never stored as CLBD');
  assert.equal(page2.page_number, 2);
  assert.equal(page2.last_page_ind, 1);
  assert.equal(page2.closing_balance_minor, 70000, "FIXED: the last page's genuine CLBD is kept");

  // And `listReconciliation`'s D64 indicator holds a non-last page back (its balance, even if one
  // were present, is never a real closing position): page 1 has no `reconciled` key at all.
  const board1 = ok(listReconciliation(t.ctx, { statementId: page1.id }));
  assert.equal('reconciled' in board1, false, 'a non-last page never states the reconciled indicator');
});

/** A batch Ntry with N QR credits, each `amountEach`; `NbOfTxs` and the sum are consistent by
 *  default so the fan-out is legal (a separate test covers the sum-mismatch refusal). */
function batchXml({ amountEach = 10000, refs = ['AAA', 'BBB', 'CCC'], totalOverride } = {}) {
  const total = totalOverride ?? amountEach * refs.length;
  // A camt.053 since A39 L7 (c): a camt.054 is refused at import (D140); the batch shape is the same.
  return `<Document><BkToCstmrStmt><GrpHdr><MsgId>B</MsgId></GrpHdr>
<Stmt><Id>NTF-BATCH</Id><ElctrncSeqNb>1</ElctrncSeqNb><Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
<Ntry><NtryRef>BATCH-1</NtryRef><Amt Ccy="CHF">${(total / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>2026-07-06</Dt></BookgDt><ValDt><Dt>2026-07-06</Dt></ValDt>
<NtryDtls><Btch><NbOfTxs>${refs.length}</NbOfTxs></Btch>
${refs
  .map(
    (r, i) =>
      `<TxDtls><Amt Ccy="CHF">${(amountEach / 100).toFixed(2)}</Amt><RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp><Ref>REF-${r}</Ref></CdtrRefInf></Strd></RmtInf><RltdPties><Dbtr><Pty><Nm>Payer ${i}</Nm></Pty></Dbtr></RltdPties></TxDtls>`,
  )
  .join('')}
</NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
}

test('[FIXED A20-C10] a BATCH entry fans out into one bank_txn per TxDtls, none vanish', () => {
  // SPS 2.3 p.61: "One booking can combine several transactions." `TxDtls` is 0..n, and batching
  // same-day QR credits into one `Ntry` is the ordinary Swiss bank shape (it is why camt.054
  // carries the transaction-level detail at all).
  const batch = batchXml({ amountEach: 10000, refs: ['AAA', 'BBB', 'CCC'] });

  const parsed = ok(parseCamt(batch));
  // FIXED (D81): three parsed entries, not one, each keeping its OWN reference and payer, and
  // summing exactly to the entry's stated Amt (300.00).
  assert.equal(parsed.statement.entries.length, 3);
  assert.deepEqual(
    parsed.statement.entries.map((e) => [e.amountMinor, e.referenceValue, e.payerName]),
    [
      [10000, 'REF-AAA', 'Payer 0'],
      [10000, 'REF-BBB', 'Payer 1'],
      [10000, 'REF-CCC', 'Payer 2'],
    ],
  );
  const sum = parsed.statement.entries.reduce((s, e) => s + e.amountMinor, 0);
  assert.equal(sum, 30000, 'the fan-out sums exactly to the entry amount');

  const t = world();
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: batch, idempotencyKey: 'batch' }));
  assert.equal(imported.txnCount, 3, 'FIXED: three bank_txn rows, one per TxDtls');
  const queued = rows(t, 'SELECT amount_minor, reference_value FROM reconciliation_match WHERE workspace_id = ? ORDER BY reference_value');
  // FIXED: three separate A21 queue rows, each for its own CHF 100.00 credit and its own reference,
  // rather than one CHF 300.00 credit naming only the first payer.
  assert.deepEqual(queued, [
    { amount_minor: 10000, reference_value: 'REF-AAA' },
    { amount_minor: 10000, reference_value: 'REF-BBB' },
    { amount_minor: 10000, reference_value: 'REF-CCC' },
  ]);
});

test('[A39 L7 (b)] a batch whose TxDtls do NOT sum to the entry amount is ONE line of the entry amount, never fanned out wrong', () => {
  // Entry says 300.00; the two TxDtls only sum to 200.00. The bank's entry amount is the booked fact:
  // the batch is ONE line of it, keyed like a single-line entry, and the file is not refused.
  const bad = batchXml({ amountEach: 10000, refs: ['AAA', 'BBB'], totalOverride: 30000 });
  const parsed = ok(parseCamt(bad));
  assert.deepEqual(
    parsed.statement.entries.map((e) => [e.entryKey, e.amountMinor, e.referenceValue]),
    [['nr:BATCH-1', 30000, null]],
  );

  const t = world();
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: bad, idempotencyKey: 'bad-batch' }));
  assert.equal(imported.txnCount, 1, 'one line of the entry amount');
  assert.deepEqual(rows(t, 'SELECT amount_minor FROM bank_txn WHERE workspace_id = ?'), [{ amount_minor: 30000 }]);
});

test('[D178 re-cut] a genuine same-day twin is imported flagged and the person, not the importer, admits it', () => {
  const t = world();
  // No AcctSvcrRef, no NtryRef, identical amount/date/currency/direction: two customers paying
  // CHF 100.00 with no reference on the same day are indistinguishable by content alone.
  const twin = { amountMinor: 10000, creditDebit: 'DBIT', date: '2026-07-01' };
  const xml1 = camt({ statementId: 'TW-1', clbd: 90000, entries: [twin] });
  const xml2 = camt({ statementId: 'TW-2', seqNb: '2', clbd: 90000, entries: [twin] });

  const first = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: xml1, idempotencyKey: 't1' }));
  assert.equal(first.txnCount, 1);

  // D178 point 19 (the E2 re-cut, A20 §11.4): a content key drops nothing. The second statement does
  // not extend the chain, so it overlaps the covered day: the content-identical entry is imported
  // FLAGGED (same_movement), and the person, not the importer, says whether it is a twin.
  const flagged = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: xml2, idempotencyKey: 't2' }));
  assert.equal(flagged.txnCount, 1);
  assert.deepEqual(flagged.skipped, []);
  assert.equal(flagged.nearDuplicates[0].reason, 'same_movement');

  // allowDuplicateEntries is the escape for a BANK reference key only; it never silences a coverage flag.
  const xml3 = camt({ statementId: 'TW-3', seqNb: '3', clbd: 90000, entries: [twin] });
  const admitted = ok(
    importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: xml3, idempotencyKey: 't3', allowDuplicateEntries: true }),
  );
  assert.equal(admitted.txnCount, 1);
  assert.ok(admitted.nearDuplicates?.length === 1, 'the third copy is flagged too');

  // The person answers "Kein Duplikat" for the genuine twin: it is bookable like any line.
  ok(resolvePossibleDuplicate(t.ctx, { bankTxnId: flagged.nearDuplicates[0].bankTxnId, decision: 'distinct', idempotencyKey: 'tw-d' }));
  ok(
    createEntryForTxn(t.ctx, { bankTxnId: flagged.nearDuplicates[0].bankTxnId, contraAccountId: t.acc('6500'), idempotencyKey: 'tw-ce' }),
  );
  assert.equal(n(t, 'bank_txn'), 3, 'every delivered line is on the books; none vanished');
});
