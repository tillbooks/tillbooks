// Test support for A39, the bank inbox. SYNTHETIC BY CONSTRUCTION: every IBAN below is either the
// published PostFinance / SIX sample the A19 suite already uses or an invented number with a correct
// check pair, every name is invented, and every statement is spelled by hand here (SPS 2.3 element
// paths, the A20 precedent). No real statement, no real counterparty.

import assert from 'node:assert/strict';

import { setup, issueInvoice, secondWorkspace as secondWorkspaceOf } from '../payments/support.mjs';
import { legClaimViolations, multiActiveViolations } from './bank-inbox-invariants.mjs';
import { createBankAccount, importCamt } from '../../dist/core/banking/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';

/** The account the world's Bankkonto is registered with (PostFinance sample, plain IBAN). */
export const MAIN_IBAN = 'CH9300762011623852957';
/** A second, invented own account (the savings account a transfer goes to). */
export const SAVINGS_IBAN = 'CH5604835012345678009';
/** An invented counterparty IBAN (a telecom supplier). */
export const TELCO_IBAN = 'CH4431999123000889012';

export function must(res, label = 'result') {
  assert.equal(res.ok, true, `${label}: expected ok, got ${JSON.stringify(res)}`);
  return res;
}

export function refused(res, code, label = 'result') {
  assert.equal(res.ok, false, `${label}: expected a refusal, got ${JSON.stringify(res)}`);
  assert.equal(res.error, code, `${label}: expected ${code}, got ${JSON.stringify(res)}`);
  return res;
}

/** The A14 world (VAT effektiv/soll, a customer) plus one Bankkonto on 1020. */
// --- The claim invariant after EVERY scenario (critic A39R2-4) -------------------------------------------

const tracked = [];

/**
 * Every workspace an A39 test builds is checked after the test (`afterEach(assertClaimInvariantHolds)` in
 * each A39 suite): an entry leg backs at most one live line, every link has a decision, claims sum to
 * their line, and one live decision per line. A test that breaks the rows ON PURPOSE (a mutation proof)
 * calls `excuseClaimInvariant()` at its end.
 */
export function trackClaimInvariant(store, workspaceId) {
  tracked.push({ store, workspaceId });
}

export function excuseClaimInvariant() {
  tracked.length = 0;
}

export function assertClaimInvariantHolds() {
  const found = [];
  for (const { store, workspaceId } of tracked.splice(0)) {
    if (!store.db.open) continue;
    for (const v of [...legClaimViolations(store, workspaceId), ...multiActiveViolations(store, workspaceId)]) found.push(`${workspaceId}: ${v}`);
  }
  assert.deepEqual(found, [], 'the claim invariant holds after the scenario');
}

/** A second workspace on the same store, tracked like the first. */
export function secondWorkspace(t) {
  const b = secondWorkspaceOf(t);
  trackClaimInvariant(t.store, b.workspaceId);
  return b;
}

export function world(opts = {}) {
  const t = setup(opts);
  const bank = must(
    createBankAccount(t.ctx, { name: 'Geschäftskonto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: t.bankId, idempotencyKey: 'ib-bank' }),
    'createBankAccount',
  );
  const w = { ...t, bankAccountId: bank.bankAccountId };
  trackClaimInvariant(w.store, w.workspaceId);
  return w;
}

export { issueInvoice };

const major = (minor) => (Math.abs(minor) / 100).toFixed(2);

/**
 * A camt.053.001.08 statement with any number of entries. `entries[]`:
 * `{ ref, amountMinor, cd, date?, valueDate?, name?, iban?, ustrd?, qrr?, pmtInfId?, e2e?, reversal? }`
 * (`date` is the booking date; the value date defaults to it). The closing
 * balance is the opening plus every entry, so the statement is internally consistent.
 */
export function camt({ statementId, seqNb = '1', iban = MAIN_IBAN, from = '2026-07-01', to = '2026-07-31', openingMinor = 0, entries, closingMinor, currency = 'CHF' }) {
  const net = entries.reduce((s, e) => s + (e.cd === 'CRDT' ? e.amountMinor : -e.amountMinor), 0);
  const closing = closingMinor ?? openingMinor + net;
  const bal = (code, minor) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${currency}">${major(minor)}</Amt><CdtDbtInd>${minor < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd></Bal>`;
  const ntry = entries
    .map((e) => {
      const date = e.date ?? '2026-07-20';
      const party = e.cd === 'CRDT' ? 'Dbtr' : 'Cdtr';
      const rltd =
        e.name !== undefined || e.iban !== undefined
          ? `<RltdPties>${e.name !== undefined ? `<${party}><Pty><Nm>${e.name}</Nm></Pty></${party}>` : ''}${
              e.iban !== undefined ? `<${party}Acct><Id><IBAN>${e.iban}</IBAN></Id></${party}Acct>` : ''
            }</RltdPties>`
          : '';
      const strd = e.qrr !== undefined ? `<Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp><Ref>${e.qrr}</Ref></CdtrRefInf></Strd>` : '';
      const ustrd = e.ustrd !== undefined ? `<Ustrd>${e.ustrd}</Ustrd>` : '';
      const rmt = strd !== '' || ustrd !== '' ? `<RmtInf>${ustrd}${strd}</RmtInf>` : '';
      const refs = e.e2e !== undefined ? `<Refs><EndToEndId>${e.e2e}</EndToEndId></Refs>` : '';
      const btch = e.pmtInfId !== undefined ? `<Btch><PmtInfId>${e.pmtInfId}</PmtInfId></Btch>` : '';
      return `<Ntry><NtryRef>${e.ref}</NtryRef><Amt Ccy="${currency}">${major(e.amountMinor)}</Amt><CdtDbtInd>${e.cd}</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><RvslInd>${e.reversal === true ? 'true' : 'false'}</RvslInd>
<BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${e.valueDate ?? date}</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls>${btch}<TxDtls>${refs}${rltd}${rmt}</TxDtls></NtryDtls></Ntry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>${to}T20:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${statementId}</Id><ElctrncSeqNb>${seqNb}</ElctrncSeqNb>
<FrToDt><FrDtTm>${from}T00:00:00</FrDtTm><ToDtTm>${to}T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
${bal('OPBD', openingMinor)}
${bal('CLBD', closing)}
${ntry}
</Stmt></BkToCstmrStmt></Document>`;
}

/** Import a statement and answer `{ statementId, lines: { ref: bankTxnId } }`. */
export function importLines(t, spec, { ctx = t.ctx, bankAccountId = t.bankAccountId, key } = {}) {
  const res = must(importCamt(ctx, { bankAccountId, xml: camt(spec), idempotencyKey: key ?? `imp-${spec.statementId}` }), `import ${spec.statementId}`);
  const rows = t.store.db
    .prepare('SELECT id, entry_ref FROM bank_txn WHERE workspace_id = ? AND statement_id = ?')
    .all(ctx.workspaceId, res.statementId);
  const lines = {};
  for (const r of rows) lines[r.entry_ref] = r.id;
  return { statementId: res.statementId, lines, result: res };
}

/** A posted vendor bill of `grossMinor` (booked gross to 6500, no VAT), with a supplier reference. */
export function postedBill(t, { grossMinor, seed, vendorName = 'Druckerei Tannenbach AG', vendorReference } = {}) {
  const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: vendorName, idempotencyKey: `v-${seed}` }), 'vendor').contact.id;
  const bill = must(
    createVendorBill(t.ctx, {
      vendorId: vendor,
      billDate: '2026-07-01',
      dueDate: '2026-07-20',
      amountMinor: grossMinor,
      expenseAccountId: t.acc('6500'),
      ...(vendorReference !== undefined ? { vendorReference } : {}),
      idempotencyKey: `bill-${seed}`,
    }),
    'createVendorBill',
  );
  must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'postVendorBill');
  return { vendorId: vendor, vendorBillId: bill.vendorBillId };
}

/** Row counts across every table a bank-line decision can touch (§H-IDEMPOTENT is asserted on ROWS). */
export function rowCounts(store, workspaceId) {
  const one = (sql) => store.db.prepare(sql).get(workspaceId).n;
  return {
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    lines: one('SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?'),
    payments: one('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?'),
    allocations: one('SELECT COUNT(*) AS n FROM payment_allocation WHERE workspace_id = ?'),
    links: one('SELECT COUNT(*) AS n FROM bank_txn_link WHERE workspace_id = ?'),
    decisions: one('SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ?'),
    claims: one('SELECT COUNT(*) AS n FROM bank_line_claim WHERE workspace_id = ?'),
    drafts: one('SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?'),
  };
}

/** Every journal line of an entry with its account number and VAT trace. */
export function legs(store, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit,
              l.tax_code AS taxCode, l.tax_base_minor AS taxBase, l.tax_amount_minor AS taxAmount
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? ORDER BY a.number, l.debit_minor DESC`,
    )
    .all(entryId);
}

/** Net movement (debit - credit, base) on one account number, posted entries only. */
export function balanceOf(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).net;
}
