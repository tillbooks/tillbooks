// A20 RE-CRITIC independent probes (non-author). Attacks the D81 "entry is the unit of identity"
// remediation from angles the author's own findings suite does NOT cover. Written against the
// remediated tree (a20-remediation @ 9fb16d4). These ASSERT the CORRECT behaviour: a red line here is
// a defect the remediation left open, not a demonstration of an accepted one.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCamt,
  createBankAccount,
  importCamt,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
} from '../../dist/core/banking/index.js';
import { lockPeriod } from '../../dist/core/ledger/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { setup } from '../payments/support.mjs';
import { secondWorkspace } from './support.mjs';

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
      name: 'PostFinance',
      iban: 'CH93 0076 2011 6238 5295 7',
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'camt-bank',
    }),
  );
  return { ...t, bankAccountId: bank.bankAccountId };
}

// A camt.053 with per-entry AcctSvcrRef support (the D81 top rung), which the author's `camt()` helper
// does NOT emit. This lets the re-critic key entries on the bank's real idempotency token.
function camt({ statementId, seqNb = '1', iban = IBAN, entries = [], opbd = 100000, clbd = 100000, currency = 'CHF' }) {
  const balances = `<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="${currency}">${(opbd / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="${currency}">${(clbd / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>`;
  const ntry = entries
    .map((e) => {
      const amount = (e.amountMinor / 100).toFixed(2);
      const date = e.date ?? '2026-07-01';
      const asr = e.acctSvcrRef === undefined ? '' : `<AcctSvcrRef>${e.acctSvcrRef}</AcctSvcrRef>`;
      const ref = e.entryRef === undefined ? '' : `<NtryRef>${e.entryRef}</NtryRef>`;
      return `<Ntry>${ref}${asr}<Amt Ccy="${currency}">${amount}</Amt><CdtDbtInd>${e.creditDebit}</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><RvslInd>${e.reversalInd === true}</RvslInd>
<BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt></Ntry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}-msg</MsgId></GrpHdr>
<Stmt><Id>${statementId}</Id><ElctrncSeqNb>${seqNb}</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-07-01T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
${balances}
${ntry}
</Stmt></BkToCstmrStmt></Document>`;
}

const rows = (t, sql) => t.store.db.prepare(sql).all(t.workspaceId);
const n = (t, table, extra = '') =>
  t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? ${extra}`).get(t.workspaceId).n;
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
  const vendor = ok(createContact(t.ctx, { partyRole: 'vendor', name: `V ${key}`, idempotencyKey: `${key}-v` }));
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

// ==================================================================================================
// PROBE 1. The AcctSvcrRef rung of the D81 ladder actually keys the entry (the author's helper never
// emits AcctSvcrRef, so this rung is exercised by NO test in the author's suite).
// ==================================================================================================

test('[PROBE] AcctSvcrRef is the identity: two DIFFERENT statements sharing one AcctSvcrRef dedupe on it', () => {
  const t = world();
  // Same booking, re-delivered under a different Stmt/Id and a DIFFERENT NtryRef, but the bank's own
  // AcctSvcrRef is stable. D81 says AcctSvcrRef is the top rung, so the second must be skipped.
  const e1 = { acctSvcrRef: 'ASR-BANK-777', entryRef: 'NR-A', amountMinor: 5000, creditDebit: 'DBIT' };
  const e2 = { acctSvcrRef: 'ASR-BANK-777', entryRef: 'NR-B-DIFFERENT', amountMinor: 5000, creditDebit: 'DBIT' };
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'S1', entries: [e1] }), idempotencyKey: 'a' }));
  const second = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'S2', seqNb: '2', entries: [e2] }), idempotencyKey: 'b' }));
  assert.equal(second.txnCount, 0, 'the bank AcctSvcrRef dedupes even when NtryRef differs');
  assert.equal(second.skipped[0].reason, 'duplicate_entry');
  assert.equal(n(t, 'bank_txn'), 1);
  const key = rows(t, 'SELECT entry_key FROM bank_txn WHERE workspace_id = ?')[0].entry_key;
  assert.equal(key, 'asr:ASR-BANK-777', 'the stored key is the AcctSvcrRef rung, not the NtryRef one');
});

// ==================================================================================================
// PROBE 2. A DUPLICATE ENTRY WITHIN ONE FILE. The preload set is filled from the DB before the loop;
// a same-key twin arriving later in the SAME message must be caught by the in-loop set, not crash on
// the UNIQUE index mid-insert (which would abort the whole transaction and lose the good entries).
// ==================================================================================================

test('[PROBE] two entries with the same AcctSvcrRef in ONE file: the twin is skipped, the file still imports', () => {
  const t = world();
  const dup = { acctSvcrRef: 'ASR-DUP', amountMinor: 1000, creditDebit: 'DBIT' };
  const other = { acctSvcrRef: 'ASR-OK', amountMinor: 2000, creditDebit: 'DBIT' };
  const res = ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'DUP-1', entries: [dup, other, dup] }),
      idempotencyKey: 'd',
    }),
  );
  assert.equal(res.txnCount, 2, 'two distinct bookings imported');
  assert.equal(n(t, 'bank_txn'), 2, 'no UNIQUE-index throw aborted the import');
  assert.ok(res.skipped.some((s) => s.reason === 'duplicate_entry'), 'the in-file twin is reported as a duplicate_entry');
  assert.equal(res.duplicate, false);
});

// ==================================================================================================
// PROBE 3. §H-TENANT on the ENTRY IDENTITY KEY. The unique index is per (workspace, bank account). Two
// tenants importing the identical file with the identical AcctSvcrRef must BOTH keep their booking:
// one tenant's entry key must never suppress another tenant's real movement.
// ==================================================================================================

test('[PROBE] the entry-identity unique index is tenant-scoped: same AcctSvcrRef in two workspaces both import', () => {
  const t = world();
  const other = secondWorkspace(t);
  const otherBank = ok(
    createBankAccount(other.ctx, {
      name: 'PostFinance B',
      iban: 'CH93 0076 2011 6238 5295 7',
      currency: 'CHF',
      ledgerAccountId: other.bankLedgerId,
      idempotencyKey: 'camt-bank-b',
    }),
  );
  const xml = camt({ statementId: 'CROSS-1', entries: [{ acctSvcrRef: 'ASR-SHARED', amountMinor: 4000, creditDebit: 'DBIT' }] });
  const a = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'wa' }));
  const b = ok(importCamt(other.ctx, { bankAccountId: otherBank.bankAccountId, xml, idempotencyKey: 'wb' }));
  assert.equal(a.txnCount, 1);
  assert.equal(b.txnCount, 1, 'tenant B keeps its own booking; tenant A did not suppress it');
  const countFor = (wsId) => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(wsId).n;
  assert.equal(countFor(t.workspaceId), 1);
  assert.equal(countFor(other.workspaceId), 1);
});

// ==================================================================================================
// PROBE 4. AMENDED STATEMENT WRITES NOTHING and leaves the first import's downstream state intact:
// the queue rows, the ledger, everything. A re-issue that differs must not partially apply.
// ==================================================================================================

test('[PROBE] a statement_amended refusal writes nothing and preserves the first import untouched', () => {
  const t = world();
  const first = camt({ statementId: 'AM-1', entries: [{ acctSvcrRef: 'X1', amountMinor: 4000, creditDebit: 'DBIT' }] });
  const amended = camt({ statementId: 'AM-1', entries: [{ acctSvcrRef: 'X1', amountMinor: 9999, creditDebit: 'DBIT' }] });
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: first, idempotencyKey: 'a' }));
  const snapStmt = n(t, 'bank_statement');
  const snapTxn = n(t, 'bank_txn');
  const snapAmt = rows(t, 'SELECT amount_minor FROM bank_txn WHERE workspace_id = ?')[0].amount_minor;
  fails(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: amended, idempotencyKey: 'b' }), 'statement_amended');
  assert.equal(n(t, 'bank_statement'), snapStmt, 'no new statement row from an amended refusal');
  assert.equal(n(t, 'bank_txn'), snapTxn, 'no new txn row');
  assert.equal(rows(t, 'SELECT amount_minor FROM bank_txn WHERE workspace_id = ?')[0].amount_minor, snapAmt, 'the stale amount is NOT overwritten');
});

test('[PROBE] a balance-only amendment (entries identical, CLBD corrected) is still caught as statement_amended', () => {
  const t = world();
  const first = camt({ statementId: 'BAL-1', clbd: 100000, entries: [{ acctSvcrRef: 'B1', amountMinor: 4000, creditDebit: 'DBIT' }] });
  const amended = camt({ statementId: 'BAL-1', clbd: 105000, entries: [{ acctSvcrRef: 'B1', amountMinor: 4000, creditDebit: 'DBIT' }] });
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: first, idempotencyKey: 'a' }));
  const res = fails(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: amended, idempotencyKey: 'b' }), 'statement_amended');
  assert.ok(res.changes.some((c) => c.toLowerCase().includes('closing')), `expected a closing-balance change, got ${JSON.stringify(res.changes)}`);
});

// ==================================================================================================
// PROBE 5. PERIOD LOCK / §H-PERIOD. A20's two posting verbs go through A02 postEntry (createEntryForTxn)
// and A14 recordPayment->postEntry (confirmCamtMatch). A booking dated into a HARD-locked period must
// refuse, and it must write nothing. The author's suite never touches periods.
// ==================================================================================================

test('[PROBE] createEntryForTxn refuses a bank fact dated into a hard-locked period, writing nothing', () => {
  const t = world({ realPeriods: true });
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'PL-1', entries: [{ acctSvcrRef: 'PL', amountMinor: 4000, creditDebit: 'DBIT', date: '2026-07-01' }] }),
      idempotencyKey: 'pl',
    }),
  );
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;
  ok(lockPeriod(t.ctx, { period: '2026-07', kind: 'hard', reason: 'test-seal', idempotencyKey: 'lock' }));
  const before = bankNet(t);
  const entriesBefore = n(t, 'journal_entry');
  const res = createEntryForTxn(t.ctx, { bankTxnId: txnId, contraAccountId: t.acc('6500'), idempotencyKey: 'ce' });
  assert.equal(res.ok, false, `a locked-period booking must refuse, got ${JSON.stringify(res)}`);
  assert.equal(bankNet(t), before, 'a refused booking moves no money');
  assert.equal(n(t, 'journal_entry'), entriesBefore, 'a refused booking writes no journal entry');
  assert.equal(n(t, 'bank_txn_link'), 0, 'and no link row is written for a booking that never posted');
});

test('[PROBE] confirmCamtMatch (debit settlement) refuses into a hard-locked period, writing nothing', () => {
  const t = world({ realPeriods: true });
  const bill = openVendorBill(t, { amountMinor: 4000, key: 'plc' });
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'PLC-1', entries: [{ acctSvcrRef: 'PLC', amountMinor: 4000, creditDebit: 'DBIT', date: '2026-07-01' }] }),
      idempotencyKey: 'plc',
    }),
  );
  const txnId = rows(t, 'SELECT id FROM bank_txn WHERE workspace_id = ?')[0].id;
  ok(lockPeriod(t.ctx, { period: '2026-07', kind: 'hard', reason: 'test-seal', idempotencyKey: 'lock' }));
  const paymentsBefore = n(t, 'payment');
  const before = bankNet(t);
  const res = confirmCamtMatch(t.ctx, { bankTxnId: txnId, vendorBillId: bill, idempotencyKey: 'cf' });
  assert.equal(res.ok, false, `a locked-period settlement must refuse, got ${JSON.stringify(res)}`);
  assert.equal(n(t, 'payment'), paymentsBefore, 'no payment written into a locked period');
  assert.equal(bankNet(t), before, 'no money moved');
  assert.equal(n(t, 'bank_txn_link'), 0, 'no link row for a settlement that never posted');
});

// ==================================================================================================
// PROBE 6. DIRECTION. C3 fixed the CRDT-money-in case. Attack the neighbouring cell: a reversal DBIT
// (RvslInd=true, money OUT) is classified `unclassified`; settling it as an outgoing payment is
// directionally CONSISTENT (money out settles a payable), so it must be ALLOWED, and a plain CRDT
// (already covered) refused. This pins that the guard keys on credit_debit, not on reversal-ness.
// ==================================================================================================

test('[PROBE] a reversal DBIT (money out) may settle a bill; the guard keys on direction, not on the reversal flag', () => {
  const t = world();
  const bill = openVendorBill(t, { amountMinor: 4000, key: 'rd' });
  ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'RD-1', entries: [{ acctSvcrRef: 'RD', amountMinor: 4000, creditDebit: 'DBIT', reversalInd: true }] }),
      idempotencyKey: 'rd',
    }),
  );
  const txn = rows(t, 'SELECT id, classification, credit_debit FROM bank_txn WHERE workspace_id = ?')[0];
  assert.equal(txn.classification, 'unclassified', 'a reversal is unclassified regardless of sign');
  assert.equal(txn.credit_debit, 'DBIT');
  const before = bankNet(t);
  const res = ok(confirmCamtMatch(t.ctx, { bankTxnId: txn.id, vendorBillId: bill, idempotencyKey: 'cf' }));
  assert.equal(res.kind, 'payment');
  assert.equal(bankNet(t) - before, -4000, 'money out, exactly once, directionally consistent with the bank');
});

// ==================================================================================================
// PROBE 7. IDEMPOTENCY ON ROWS, not on the returned id. Re-import the SAME statement (same Stmt/Id,
// same content) under three DIFFERENT idempotency keys: the row counts must be frozen after the first.
// Then a genuinely new booking (new AcctSvcrRef) in a later statement must still get through.
// ==================================================================================================

test('[PROBE] idempotency proven on ROWS: 3x re-import writes once; a genuinely new entry still lands', () => {
  const t = world();
  const xml = camt({ statementId: 'ID-1', entries: [{ acctSvcrRef: 'IDA', amountMinor: 4000, creditDebit: 'DBIT' }] });
  ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'k1' }));
  const froze = { s: n(t, 'bank_statement'), x: n(t, 'bank_txn') };
  for (const k of ['k2', 'k3']) {
    const r = ok(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: k }));
    assert.equal(r.duplicate, true);
  }
  assert.equal(n(t, 'bank_statement'), froze.s, 're-import minted no statement row');
  assert.equal(n(t, 'bank_txn'), froze.x, 're-import minted no txn row');
  // A genuinely different booking must still land.
  const more = ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'ID-2', seqNb: '2', entries: [{ acctSvcrRef: 'IDB', amountMinor: 7000, creditDebit: 'DBIT' }] }),
      idempotencyKey: 'k4',
    }),
  );
  assert.equal(more.txnCount, 1, 'a new AcctSvcrRef is not falsely deduped against an unrelated one');
  assert.equal(n(t, 'bank_txn'), froze.x + 1);
});

// ==================================================================================================
// PROBE 8. The content-hash rung must not collide two GENUINELY DIFFERENT reference-less entries that
// differ only by amount (a false dedupe here would eat a real movement).
// ==================================================================================================

test('[PROBE] two reference-less entries differing only by amount are NOT falsely deduped', () => {
  const t = world();
  const res = ok(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({
        statementId: 'CH-1',
        entries: [
          { amountMinor: 1000, creditDebit: 'DBIT' },
          { amountMinor: 2000, creditDebit: 'DBIT' },
        ],
      }),
      idempotencyKey: 'ch',
    }),
  );
  assert.equal(res.txnCount, 2, 'the content key distinguishes on amount, so neither is lost');
  assert.equal(n(t, 'bank_txn'), 2);
});
