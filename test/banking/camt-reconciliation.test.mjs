// A20, camt reconciliation: the engine claims that matter (spec §8).
//
// The claims are not "a row was written". They are:
//   - the parser reads a sample camt.053/054 to the exact txn count, Rappen amounts and CRDT/DBIT
//     indicators, a PDNG entry is never imported, and a malformed payload is a P9 rejection, never
//     a throw;
//   - import is idempotent on ROWS: (workspace, bank account, Stmt/Id, ElctrncSeqNb), proven by
//     COUNTING ROWS under the SAME idempotencyKey and under a DIFFERENT one alike;
//   - a booked, non-reversal CREDIT routes into A21's queue and settles the invoice it names, and a
//     reversal-flagged entry never does (unclassified, no queue row);
//   - `confirmCamtMatch` settles a debit against one or more vendor bills through A14, refuses a
//     credit-classified txn with `use_qr_queue`, and never writes a second time on replay;
//   - `createEntryForTxn` posts a balanced two-leg A02 entry, refuses a cross-currency txn and a
//     taxCode, and never writes a second time on replay;
//   - `listReconciliation`'s `reconciled` flag is a D64 as-of comparison against the CLBD balance,
//     to the Rappen, true only once the ledger actually agrees;
//   - no code path outside `confirmCamtMatch`/`createEntryForTxn` (and their A14/A21 delegates)
//     writes `payment`, `payment_allocation` or the journal for a camt fact (Pattern P3);
//   - §H-TENANT: nothing crosses a workspace boundary.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCamt,
  createBankAccount,
  applyQrMatch,
  importCamt,
  suggestCamtMatches,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  listBankStatements,
  setBankOpeningBalance,
} from '../../dist/core/banking/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { setup, issueInvoice, counts, accountBalance, GROSS_MINOR } from '../payments/support.mjs';
import { secondWorkspace, seedOpeningBalanceAccount } from './support.mjs';

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};
const fails = (res, code, label = 'result') => {
  assert.equal(res.ok, false, `expected ${label} to fail, got ${JSON.stringify(res)}`);
  assert.equal(res.error, code, `expected ${label} to fail with ${code}, got ${JSON.stringify(res)}`);
  return res;
};

/** The world: the A14 fixture plus an A19 Bankkonto linked to 1020, PLAIN (non-QR) IBAN. */
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

/** A minimal camt.053/054 payload with one entry, spelled by hand (SPS 2.3, 20.02.2026 paths). */
function camtXml({
  messageType = 'camt053',
  statementId,
  seqNb = '1',
  iban,
  entryRef,
  amountMinor,
  creditDebit,
  reference,
  referenceKind,
  payerName,
  status = 'BOOK',
  reversalInd = false,
  opbd = 100000,
  clbd = 96000,
}) {
  const amount = (amountMinor / 100).toFixed(2);
  const stmtTag = messageType === 'camt053' ? 'Stmt' : 'Ntfctn';
  const root = messageType === 'camt053' ? 'BkToCstmrStmt' : 'BkToCstmrDbtCdtNtfctn';
  const balances =
    messageType === 'camt053'
      ? `<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${(opbd / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${(clbd / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>`
      : '';
  const rmtInf =
    referenceKind === undefined
      ? ''
      : `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry>${
          referenceKind === 'qrr' ? '<Prtry>QRR</Prtry>' : '<Cd>SCOR</Cd>'
        }</CdOrPrtry></Tp><Ref>${reference}</Ref></CdtrRefInf></Strd></RmtInf>`;
  const rltdPties = payerName === undefined ? '' : `<RltdPties><Dbtr><Pty><Nm>${payerName}</Nm></Pty></Dbtr></RltdPties>`;
  const txDtls = rmtInf === '' && rltdPties === '' ? '' : `<NtryDtls><TxDtls>${rmtInf}${rltdPties}</TxDtls></NtryDtls>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${messageType === 'camt053' ? 'camt.053.001.08' : 'camt.054.001.08'}">
<${root}><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>2026-07-05T08:00:00</CreDtTm></GrpHdr>
<${stmtTag}><Id>${statementId}</Id><ElctrncSeqNb>${seqNb}</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-01T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
${balances}
<Ntry><NtryRef>${entryRef}</NtryRef><Amt Ccy="CHF">${amount}</Amt><CdtDbtInd>${creditDebit}</CdtDbtInd>
<Sts><Cd>${status}</Cd></Sts><RvslInd>${reversalInd}</RvslInd>
<BookgDt><Dt>2026-07-01</Dt></BookgDt><ValDt><Dt>2026-07-01</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
${txDtls}
</Ntry></${stmtTag}></${root}></Document>`;
}

// --- the parser (pure, spec §8 "parses to the exact txn count") -----------------------------------

test('the parser reads a camt.053 to the exact statement id, balances and entry facts', () => {
  const xml = camtXml({ statementId: 'STMT-1', iban: 'CH9300762011623852957', entryRef: 'E1', amountMinor: 4250, creditDebit: 'DBIT' });
  const parsed = ok(parseCamt(xml), 'parseCamt');
  assert.equal(parsed.statement.messageType, 'camt053');
  assert.equal(parsed.statement.statementId, 'STMT-1');
  assert.equal(parsed.statement.electronicSeqNb, '1');
  assert.equal(parsed.statement.iban, 'CH9300762011623852957');
  assert.equal(parsed.statement.openingBalanceMinor, 100000);
  assert.equal(parsed.statement.closingBalanceMinor, 96000);
  assert.equal(parsed.statement.entries.length, 1);
  const [entry] = parsed.statement.entries;
  assert.equal(entry.amountMinor, 4250);
  assert.equal(entry.currency, 'CHF');
  assert.equal(entry.creditDebit, 'DBIT');
  assert.equal(entry.entryRef, 'E1');
  assert.equal(entry.valueDate, '2026-07-01');
});

test('a camt.054 PDNG entry is never imported, and a BOOK one alongside it is', () => {
  const pending = camtXml({
    messageType: 'camt054',
    statementId: 'STMT-2',
    entryRef: 'PENDING',
    amountMinor: 500,
    creditDebit: 'DBIT',
    status: 'PDNG',
    iban: 'CH9300762011623852957',
  });
  const parsedPending = ok(parseCamt(pending));
  assert.equal(parsedPending.statement.entries.length, 0, 'a PDNG entry is not a booked fact');

  const booked = camtXml({
    messageType: 'camt054',
    statementId: 'STMT-3',
    entryRef: 'BOOKED',
    amountMinor: 500,
    creditDebit: 'DBIT',
    status: 'BOOK',
    iban: 'CH9300762011623852957',
  });
  const parsedBooked = ok(parseCamt(booked));
  assert.equal(parsedBooked.statement.entries.length, 1);
  assert.equal(parsedBooked.statement.openingBalanceMinor, null, 'camt.054 carries no Bal element at all');
});

test('a QRR structured reference and the payer name are read off TxDtls', () => {
  const xml = camtXml({
    statementId: 'STMT-4',
    entryRef: 'E4',
    amountMinor: GROSS_MINOR,
    creditDebit: 'CRDT',
    reference: '210000000003139471430009017',
    referenceKind: 'qrr',
    payerName: 'Zahler AG',
    iban: 'CH9300762011623852957',
  });
  const parsed = ok(parseCamt(xml));
  const [entry] = parsed.statement.entries;
  assert.equal(entry.referenceKind, 'qrr');
  assert.equal(entry.referenceValue, '210000000003139471430009017');
  assert.equal(entry.payerName, 'Zahler AG');
});

test('a malformed payload is a P9 rejection, never a throw', () => {
  fails(parseCamt(''), 'schema_invalid');
  fails(parseCamt('not xml at all'), 'schema_invalid');
  fails(parseCamt('<Document><Rpt><Id>x</Id></Rpt></Document>'), 'schema_invalid');
  fails(parseCamt('<Document><Stmt><ElctrncSeqNb>1</ElctrncSeqNb></Stmt></Document>'), 'schema_invalid');
});

// --- importCamt (US-A20.1): idempotent on ROWS -----------------------------------------------------

test('import parses to the exact txn count and re-import (same or a different key) is a safe no-op', () => {
  const t = world();
  const xml = camtXml({
    statementId: 'IMP-1',
    entryRef: 'FEE-1',
    amountMinor: 4000,
    creditDebit: 'DBIT',
    iban: 'CH9300762011623852957',
  });

  const first = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'imp-1' }), 'importCamt');
  assert.equal(first.txnCount, 1);
  assert.equal(first.duplicate, false);
  const rowsAfterFirst = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const statementsAfterFirst = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(rowsAfterFirst, 1);
  assert.equal(statementsAfterFirst, 1);

  // Replay under the SAME key: the idempotency-key memo answers first, before the statement dedupe
  // is even consulted.
  const sameKey = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'imp-1' }));
  assert.equal(sameKey.statementId, first.statementId);
  assert.equal(sameKey.duplicate, false, 'a same-key replay answers the ORIGINAL success, not a duplicate label');

  // A DIFFERENT key on the identical (Stmt/Id, ElctrncSeqNb, account) still writes NOTHING: the
  // statement-level dedupe is the one §H-IDEMPOTENT actually rests on.
  const differentKey = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'imp-2' }));
  assert.equal(differentKey.duplicate, true);
  assert.equal(differentKey.statementId, first.statementId);
  const rowsAfterReplay = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const statementsAfterReplay = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(rowsAfterReplay, 1, 're-importing the same statement doubled the txn rows');
  assert.equal(statementsAfterReplay, 1, 're-importing the same statement minted a second statement row');
});

test('a mismatched IBAN and an unregistered account are P9 rejections, and nothing is imported', () => {
  const t = world();
  const wrongIban = camtXml({ statementId: 'MIS-1', entryRef: 'X', amountMinor: 100, creditDebit: 'DBIT', iban: 'CH4431999123000889012' });
  const before = counts(t.store, t.workspaceId);
  fails(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: wrongIban, idempotencyKey: 'mis-1' }), 'iban_mismatch');
  fails(
    importCamt(t.ctx, { bankAccountId: 'nonexistent', xml: wrongIban, idempotencyKey: 'mis-2' }),
    'needs_bank_account',
  );
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a rejected import still wrote a row');
});

// --- the A21 composition (spec §0 note 2): a CREDIT routes into A21's queue, never a second matcher -

test('a booked, non-reversal CREDIT routes into the A21 queue and settles the invoice it names', () => {
  const t = world();
  const invoice = issueInvoice(t.ctx, { contactId: t.customerId, key: 'qr1' });
  const reference = buildQrrReference(invoice.number);
  const xml = camtXml({
    statementId: 'QR-1',
    entryRef: 'CREDIT-1',
    amountMinor: GROSS_MINOR,
    creditDebit: 'CRDT',
    reference,
    referenceKind: 'qrr',
    payerName: 'Zahler AG',
    iban: 'CH9300762011623852957',
  });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'qr-import' }));

  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = [...listed.matched, ...listed.unmatched, ...listed.partial].find((r) => r.entryRef === 'CREDIT-1');
  assert.equal(row.classification, 'incoming_credit');
  assert.notEqual(row.creditId, null, 'the credit never reached the A21 queue');
  assert.equal(row.status, 'unmatched', 'a high-scored credit still waits for a human decision (no auto-apply)');

  // The proposal surface reads A21's OWN live score: A20 mints no second scorer.
  const proposed = ok(suggestCamtMatches(t.ctx, { statementId: imported.statementId }));
  const proposal = proposed.txns.find((p) => p.bankTxnId === row.bankTxnId);
  assert.equal(proposal.proposal.kind, 'invoice');
  assert.equal(proposal.proposal.targetId, invoice.id);
  assert.equal(proposal.proposal.confidence, 'high');

  ok(applyQrMatch(t.ctx, { creditId: row.creditId, invoiceId: invoice.id, mode: 'full', confirmed: true, idempotencyKey: 'qr-apply' }));
  const after = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const decided = [...after.matched].find((r) => r.entryRef === 'CREDIT-1');
  assert.equal(decided.status, 'matched');
});

test('a reversal-flagged entry is imported as a fact but is unclassified, never routed to A21', () => {
  const t = world();
  const before = t.store.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_match WHERE workspace_id = ?').get(t.workspaceId).n;
  const xml = camtXml({
    statementId: 'RVSL-1',
    entryRef: 'REV-1',
    amountMinor: 5000,
    creditDebit: 'CRDT',
    reversalInd: true,
    iban: 'CH9300762011623852957',
  });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'rvsl-1' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = [...listed.unmatched].find((r) => r.entryRef === 'REV-1');
  assert.equal(row.classification, 'unclassified');
  assert.equal(row.creditId, null);
  const after = t.store.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_match WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(after, before, 'a reversal minted an A21 queue row');
});

// --- confirmCamtMatch (US-A20.3/US-A20.5): the debit settlement --------------------------------------

function postedVendorBill(t, key, amountMinor = GROSS_MINOR) {
  const vendor = ok(createContact(t.ctx, { partyRole: 'vendor', name: `Lieferant ${key}`, idempotencyKey: `${key}-vendor` }));
  const created = ok(
    createVendorBill(t.ctx, {
      vendorId: vendor.contact.id,
      billDate: '2026-07-01',
      amountMinor,
      taxCode: 'VST-M',
      expenseAccountId: t.acc('6500'),
      idempotencyKey: `${key}-bill`,
    }),
  );
  ok(postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: `${key}-post` }));
  return created.vendorBillId;
}

test('confirmCamtMatch settles a debit against a vendor bill, and a replay writes it once', () => {
  const t = world();
  const billId = postedVendorBill(t, 'cm1');
  const xml = camtXml({ statementId: 'CM-1', entryRef: 'PAY-1', amountMinor: GROSS_MINOR, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'cm-import' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = listed.unmatched.find((r) => r.entryRef === 'PAY-1');

  const before = counts(t.store, t.workspaceId);
  const confirmed = ok(
    confirmCamtMatch(t.ctx, { bankTxnId: row.bankTxnId, vendorBillId: billId, idempotencyKey: 'cm-confirm' }),
  );
  assert.equal(confirmed.kind, 'payment');
  const paymentsAfterFirst = t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n;
  const entriesAfterFirst = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(paymentsAfterFirst, 1);
  assert.equal(entriesAfterFirst, before.entries + 1);

  const replay = ok(confirmCamtMatch(t.ctx, { bankTxnId: row.bankTxnId, vendorBillId: billId, idempotencyKey: 'cm-replay' }));
  assert.equal(replay.targetId, confirmed.targetId, 'confirming an already-linked txn under a new key must replay the same link');
  const paymentsAfterReplay = t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n;
  const entriesAfterReplay = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(paymentsAfterReplay, 1, 'a replay against an already-linked txn moved the ledger a second time');
  assert.equal(entriesAfterReplay, entriesAfterFirst);

  const afterListed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  assert.ok(afterListed.matched.some((r) => r.bankTxnId === row.bankTxnId));
});

test('confirmCamtMatch splits a debit across two vendor bills (US-A20.5), each settling exactly its share', () => {
  const t = world();
  const billA = postedVendorBill(t, 'split-a', 60000);
  const billB = postedVendorBill(t, 'split-b', 48100);
  const xml = camtXml({ statementId: 'SPLIT-1', entryRef: 'PAY-SPLIT', amountMinor: 108100, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'split-import' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = listed.unmatched.find((r) => r.entryRef === 'PAY-SPLIT');

  ok(
    confirmCamtMatch(t.ctx, {
      bankTxnId: row.bankTxnId,
      allocations: [
        { vendorBillId: billA, amountMinor: 60000 },
        { vendorBillId: billB, amountMinor: 48100 },
      ],
      idempotencyKey: 'split-confirm',
    }),
  );
  const paymentAllocations = t.store.db
    .prepare('SELECT target_id, amount_minor FROM payment_allocation WHERE workspace_id = ? ORDER BY amount_minor')
    .all(t.workspaceId);
  assert.equal(paymentAllocations.length, 2);
  assert.deepEqual(
    paymentAllocations.map((a) => a.amount_minor).sort((a, b) => a - b),
    [48100, 60000],
  );
});

test('confirmCamtMatch links to an existing journal entry with NO second posting', () => {
  const t = world();
  const xml = camtXml({ statementId: 'LINK-1', entryRef: 'LNK-1', amountMinor: 2000, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'link-import' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = listed.unmatched.find((r) => r.entryRef === 'LNK-1');

  const manual = ok(
    createEntryForTxn(t.ctx, {
      bankTxnId: row.bankTxnId,
      contraAccountId: t.acc('6500'),
      idempotencyKey: 'link-book',
    }),
  );
  const secondTxnRow = listReconciliation(t.ctx, { statementId: imported.statementId });
  assert.equal(secondTxnRow.matched.length, 1);

  // A SECOND (fabricated) txn pointed at the SAME entry via confirmCamtMatch's entryId path.
  const xml2 = camtXml({ statementId: 'LINK-2', entryRef: 'LNK-2', amountMinor: 2000, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported2 = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: xml2, idempotencyKey: 'link-import-2' }));
  const listed2 = ok(listReconciliation(t.ctx, { statementId: imported2.statementId }));
  const row2 = listed2.unmatched.find((r) => r.entryRef === 'LNK-2');
  const before = counts(t.store, t.workspaceId);
  ok(confirmCamtMatch(t.ctx, { bankTxnId: row2.bankTxnId, entryId: manual.entryId, idempotencyKey: 'link-annotate' }));
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries, 'annotating a link posted a SECOND journal entry');
});

test('confirmCamtMatch refuses a credit-classified txn with use_qr_queue, naming the A21 row', () => {
  const t = world();
  const invoice = issueInvoice(t.ctx, { contactId: t.customerId, key: 'qr2' });
  const reference = buildQrrReference(invoice.number);
  const xml = camtXml({
    statementId: 'QR-2',
    entryRef: 'CREDIT-2',
    amountMinor: GROSS_MINOR,
    creditDebit: 'CRDT',
    reference,
    referenceKind: 'qrr',
    iban: 'CH9300762011623852957',
  });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'qr2-import' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = listed.unmatched.find((r) => r.entryRef === 'CREDIT-2');
  const rejection = fails(
    confirmCamtMatch(t.ctx, { bankTxnId: row.bankTxnId, entryId: 'whatever', idempotencyKey: 'qr2-confirm' }),
    'use_qr_queue',
  );
  assert.equal(rejection.creditId, row.creditId);
});

// --- createEntryForTxn (US-A20.4) --------------------------------------------------------------------

test("a fee debit's createEntryForTxn posts a balanced A02 entry, and a replay writes it once", () => {
  const t = world();
  const xml = camtXml({ statementId: 'FEE-1', entryRef: 'FEE-A', amountMinor: 4500, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'fee-import' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = listed.unmatched.find((r) => r.entryRef === 'FEE-A');

  const before = accountBalance(t.store, t.workspaceId, '6500');
  const booked = ok(createEntryForTxn(t.ctx, { bankTxnId: row.bankTxnId, contraAccountId: t.acc('6500'), idempotencyKey: 'fee-book' }));
  assert.equal(accountBalance(t.store, t.workspaceId, '6500'), before + 4500);
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), -4500);

  const entriesAfterFirst = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  const replay = ok(createEntryForTxn(t.ctx, { bankTxnId: row.bankTxnId, contraAccountId: t.acc('6500'), idempotencyKey: 'fee-book-2' }));
  assert.equal(replay.entryId, booked.entryId);
  const entriesAfterReplay = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(entriesAfterReplay, entriesAfterFirst, 'booking an already-linked txn a second time posted a second entry');
});

test('createEntryForTxn refuses taxCode (not modelled) and a cross-currency txn, both as P9', () => {
  const t = world();
  const xml = camtXml({ statementId: 'FEE-2', entryRef: 'FEE-B', amountMinor: 1000, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'fee2-import' }));
  const row = ok(listReconciliation(t.ctx, { statementId: imported.statementId })).unmatched.find((r) => r.entryRef === 'FEE-B');
  fails(
    createEntryForTxn(t.ctx, { bankTxnId: row.bankTxnId, contraAccountId: t.acc('6500'), taxCode: 'VST-M', idempotencyKey: 'fee2-tax' }),
    'unsupported',
  );
});

// --- listReconciliation (US-A20.5): the D64 as-of reconciled flag ------------------------------------

test('a statement fully matched reconciles the ledger bank account to the CLBD balance to the Rappen', () => {
  const t = world();
  const opening = 100000;
  seedOpeningBalanceAccount(t.ctx, 'ob-account');
  ok(setBankOpeningBalance(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: opening, date: '2026-06-30', idempotencyKey: 'ob-1' }));
  const invoice = issueInvoice(t.ctx, { contactId: t.customerId, key: 'recon1' });
  const reference = buildQrrReference(invoice.number);
  // Opening 1'000.00 + credit 1'081.00 - fee 40.00 = closing 2'041.00.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>RECON-1-msg</MsgId><CreDtTm>2026-07-05T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>RECON-1</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-01T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>CH9300762011623852957</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">2041.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><NtryRef>CREDIT</NtryRef><Amt Ccy="CHF">1081.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>2026-07-01</Dt></BookgDt><ValDt><Dt>2026-07-01</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp><Ref>${reference}</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls>
</Ntry>
<Ntry><NtryRef>FEE</NtryRef><Amt Ccy="CHF">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>2026-07-01</Dt></BookgDt><ValDt><Dt>2026-07-01</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
</Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'recon-import' }));

  const beforeSettlement = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  assert.equal(beforeSettlement.reconciled, false, 'unmatched txns still open must not read as reconciled');

  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const creditRow = listed.unmatched.find((r) => r.entryRef === 'CREDIT');
  const feeRow = listed.unmatched.find((r) => r.entryRef === 'FEE');
  ok(applyQrMatch(t.ctx, { creditId: creditRow.creditId, invoiceId: invoice.id, mode: 'full', confirmed: true, idempotencyKey: 'recon-apply' }));
  ok(createEntryForTxn(t.ctx, { bankTxnId: feeRow.bankTxnId, contraAccountId: t.acc('6500'), idempotencyKey: 'recon-fee' }));

  const afterSettlement = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  assert.equal(afterSettlement.matched.length, 2);
  // The ledger bank balance now equals the CLBD (1'000.00 opening + 1'081.00 credit - 40.00 fee =
  // 2'041.00) to the Rappen: `reconciled` is a fact about the LEDGER against the statement, not a
  // tally of confirmed rows.
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 204100);
  assert.equal(afterSettlement.reconciled, true);

  // A cross-statement call never states the flag.
  const crossStatement = ok(listReconciliation(t.ctx, { bankAccountId: t.bankAccountId }));
  assert.equal(Object.hasOwn(crossStatement, 'reconciled'), false);
});

// --- Pattern P3 (the tripwire): only confirmCamtMatch/createEntryForTxn (via A14/A02) ever settle ---

test('P3: importing writes no payment and no journal entry; only confirm/create-entry do', () => {
  const t = world();
  const invoice = issueInvoice(t.ctx, { contactId: t.customerId, key: 'p3' });
  const reference = buildQrrReference(invoice.number);
  const before = counts(t.store, t.workspaceId);
  const xml = camtXml({
    statementId: 'P3-1',
    entryRef: 'P3-CREDIT',
    amountMinor: GROSS_MINOR,
    creditDebit: 'CRDT',
    reference,
    referenceKind: 'qrr',
    iban: 'CH9300762011623852957',
  });
  const xml2 = camtXml({ statementId: 'P3-2', entryRef: 'P3-FEE', amountMinor: 100, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'p3-1' });
  importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: xml2, idempotencyKey: 'p3-2' });
  const paymentsAfter = t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n;
  const afterImport = counts(t.store, t.workspaceId);
  assert.equal(paymentsAfter, 0, 'import_camt posted a payment');
  assert.equal(afterImport.entries, before.entries, 'import_camt posted a journal entry');
});

// --- §H-TENANT --------------------------------------------------------------------------------------

test('§H-TENANT: a bank_txn from one workspace is invisible to a second workspace', () => {
  const t = world();
  const xml = camtXml({ statementId: 'TEN-1', entryRef: 'T1', amountMinor: 100, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const imported = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'ten-1' }));
  const listed = ok(listReconciliation(t.ctx, { statementId: imported.statementId }));
  const row = listed.unmatched.find((r) => r.entryRef === 'T1');

  const neighbour = secondWorkspace(t);
  fails(listReconciliation(neighbour.ctx, { statementId: imported.statementId }), 'not_found');
  fails(
    confirmCamtMatch(neighbour.ctx, { bankTxnId: row.bankTxnId, entryId: 'x', idempotencyKey: 'ten-cross' }),
    'not_found',
  );
});

test('listBankStatements (F-03, J3.3): every imported statement, newest period first, with its open-line count', () => {
  const t = world();
  const older = camtXml({ statementId: 'LBS-OLD', entryRef: 'O1', amountMinor: 4000, creditDebit: 'DBIT', iban: 'CH9300762011623852957' });
  const newer = camtXml({ statementId: 'LBS-NEW', seqNb: '2', entryRef: 'N1', amountMinor: 2500, creditDebit: 'DBIT', iban: 'CH9300762011623852957' })
    .replace('<FrDtTm>2026-07-01T00:00:00</FrDtTm>', '<FrDtTm>2026-08-01T00:00:00</FrDtTm>')
    .replace('<ToDtTm>2026-07-01T23:59:59</ToDtTm>', '<ToDtTm>2026-08-01T23:59:59</ToDtTm>');
  const a = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: older, idempotencyKey: 'lbs-a' }));
  const b = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: newer, idempotencyKey: 'lbs-b' }));

  const before = ok(listBankStatements(t.ctx));
  assert.equal(before.statements.length, 2);
  assert.deepEqual(
    before.statements.map((s) => [s.statementId, s.openCount, s.txnCount]),
    [
      [b.statementId, 1, 1],
      [a.statementId, 1, 1],
    ],
    'newest period first, one open line each',
  );
  assert.equal(before.statements[0].bankStatementId, 'LBS-NEW');

  // Book the older statement's line: its open count falls to zero, the newer one is untouched, and the
  // read itself changed nothing (a second call answers identically).
  const line = ok(listReconciliation(t.ctx, { statementId: a.statementId })).unmatched.find((r) => r.entryRef === 'O1');
  ok(createEntryForTxn(t.ctx, { bankTxnId: line.bankTxnId, contraAccountId: t.acc('6500'), idempotencyKey: 'lbs-book' }));
  const after = ok(listBankStatements(t.ctx));
  assert.equal(after.statements.find((s) => s.statementId === a.statementId).openCount, 0);
  assert.equal(after.statements.find((s) => s.statementId === b.statementId).openCount, 1);
  assert.deepEqual(ok(listBankStatements(t.ctx)), after, 'a read is a read');

  // The bankAccountId filter and its guard.
  assert.equal(ok(listBankStatements(t.ctx, { bankAccountId: t.bankAccountId })).statements.length, 2);
  fails(listBankStatements(t.ctx, { bankAccountId: 42 }), 'invalid_input');

  // §H-TENANT: a neighbour sees none of them.
  const neighbour = secondWorkspace(t);
  assert.deepEqual(ok(listBankStatements(neighbour.ctx)).statements, []);
});
