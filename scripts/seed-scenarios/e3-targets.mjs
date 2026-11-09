#!/usr/bin/env node
/**
 * e3-targets.mjs: the D178 E3 seed scenario, one workspace with an open bank line for every new
 * `book_bank_line` target (A39 §17), so the Studio's booking pane (node N3) and an agent over MCP have
 * something real to book.
 *
 * SYNTHETIC BY CONSTRUCTION. Every name, amount and remittance below is invented; the IBAN is the
 * PostFinance sample the A19 suites use. Nothing is read from, copied from or derived from any real
 * book, bank statement or bexio export.
 *
 * It drives the PUBLIC API only (`handleRest` over a hand-composed `ApiDeps`, the `seed-demo-rich.mjs`
 * pattern), so every guard that holds `develop` also holds the seed. A clock moved per business date and
 * a stable `e3:<step>` idempotency key on every write make a second run over the same book a replay,
 * never a duplicate (ids are system ids: a preview mints fresh ones inside its rolled-back booking).
 *
 * The lines it imports (all in the workspace "Bankziele Muster AG", July 2026):
 *   IN-CUST   CHF 500.00 in from Kafi Muster AG, no document   target contact (a customer's Guthaben)
 *   OUT-SUPP  CHF 300.00 out to Druckerei Tannenbach AG          target contact (a supplier prepayment)
 *   IN-MULTI  two invoices of Kafi Muster AG plus CHF 5.00        target open_item { allocations[] },
 *                                                                 deviation 5.00 (remainder on_account)
 *   OUT-SPES  CHF 85.50 out to Anna Beispiel                      target expense_claims (two approved claims)
 *   OUT-CARD  CHF 94.22 card purchase, USD 100.00 + CHF 1.85      accounts with an fx leg (acknowledgeFx)
 *
 * Usage (build first: `npm run build`):
 *   TILL_DB_PATH=~/.till/till-e3.db node scripts/seed-scenarios/e3-targets.mjs --reset
 *   TILL_DB_PATH=~/.till/till-e3.db node scripts/seed-scenarios/e3-targets.mjs --book   # also book each line
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const { SqliteStore } = await import(join(ROOT, 'dist/core/store/sqlite-store.js'));
const { systemIdGen } = await import(join(ROOT, 'dist/core/ids.js'));
const { handleRest } = await import(join(ROOT, 'dist/api/rest.js'));
const { resolveDbPath } = await import(join(ROOT, 'dist/api/db-path.js'));

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const BOOK = args.includes('--book');

const dbPath = resolveDbPath();
if (dbPath === ':memory:') {
  console.error('Refusing to seed :memory: (nothing would survive). Set TILL_DB_PATH to a file, e.g. ~/.till/till-e3.db');
  process.exit(1);
}
if (RESET) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }
}

let NOW = '2026-07-01T09:00:00.000Z';
const clock = { now: () => NOW };
const store = new SqliteStore({ location: dbPath, clock });
// System ids, not a sequence: a second run replays every keyed write, but a preview (which runs a
// settlement's booking and rolls it back) mints fresh ids, and a restarted sequence would collide.
const ids = systemIdGen;
const owner = { store, clock, ids, actor: 'user_1' };
/** A second seat for the four-eyes Spesen approval: the studio seat drafts, the owner approves. */
const drafter = { ...owner, actor: 'studio' };

/** Drive one public verb on `date`; a domain refusal stops the seed loudly. */
function call(verb, input, { date, as = owner } = {}) {
  if (date !== undefined) NOW = `${date}T09:00:00.000Z`;
  const res = handleRest(verb, { ...input }, as);
  if (res.body && res.body.ok === false) {
    throw new Error(`SEED FAIL ${verb}: ${JSON.stringify(res.body)}  input=${JSON.stringify(input)}`);
  }
  return res.body;
}

const IBAN = 'CH9300762011623852957';

const ws = call('create_workspace', { name: 'Bankziele Muster AG', idempotencyKey: 'e3:ws' }, { date: '2026-01-01' });
const W = ws.workspaceId;
const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(W, number)?.id;

call('vat_configure', { workspaceId: W, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'e3:vat' });
// The two Anzahlungen accounts of the Schweizer Kontenrahmen KMU (A39 §17.1), so the `anzahlung` mode of a
// contact booking works here without asking; TILL's core seed carries neither.
if (acc('2030') === undefined) call('create_account', { workspaceId: W, number: '2030', name: 'Erhaltene Anzahlungen', type: 'liability', idempotencyKey: 'e3:acc2030' });
if (acc('1190') === undefined) call('create_account', { workspaceId: W, number: '1190', name: 'Sonstige kurzfristige Forderungen', type: 'asset', idempotencyKey: 'e3:acc1190' });

const bank = call('create_bank_account', { workspaceId: W, name: 'Geschäftskonto', iban: IBAN, currency: 'CHF', ledgerAccountId: acc('1020'), idempotencyKey: 'e3:bank' });
const customer = call('create_contact', { workspaceId: W, partyRole: 'customer', name: 'Kafi Muster AG', idempotencyKey: 'e3:cust' }).contact.id;
const supplier = call('create_contact', { workspaceId: W, partyRole: 'vendor', name: 'Druckerei Tannenbach AG', idempotencyKey: 'e3:supp' }).contact.id;
const payee = call('create_contact', { workspaceId: W, partyRole: 'vendor', name: 'Anna Beispiel', idempotencyKey: 'e3:payee' }).contact.id;

// Two issued invoices of the customer, paid together by one line.
const invoices = [80000, 40000].map((net, i) => {
  const doc = call('create_document', { workspaceId: W, type: 'invoice', contactId: customer, lines: [{ description: `Kaffeeservice ${i + 1}`, unitPriceMinor: net, taxCode: 'UST81' }], idempotencyKey: `e3:doc${i}` }, { date: '2026-06-20' });
  return call('issue_invoice', { workspaceId: W, invoiceId: doc.document.id, idempotencyKey: `e3:issue${i}` }, { date: '2026-06-20' }).document;
});

// Two approved Spesen of one employee (each under the CHF 50 receipt threshold): drafted and submitted
// by the studio seat, approved by the owner (four eyes).
const emp = call('hr_employee_upsert', { workspaceId: W, employee: { firstName: 'Anna', lastName: 'Beispiel', employmentPct: 80, startsOn: '2026-01-01', contactId: payee }, idempotencyKey: 'e3:emp' });
const claims = [
  ['Zugreise Bern', 4000],
  ['Messe Basel', 4550],
].map(([title, amountMinor], i) => {
  const claim = call('expense_claim_create', { workspaceId: W, employeeId: emp.employeeId, title, idempotencyKey: `e3:clm${i}` }, { as: drafter, date: '2026-06-25' });
  // A replay over a seeded book finds the claim already moved on: its line is frozen once submitted.
  const status = () => store.db.prepare('SELECT status FROM expense_claim WHERE workspace_id = ? AND id = ?').get(W, claim.claimId).status;
  if (status() === 'draft') {
    call('expense_line_upsert', { workspaceId: W, claimId: claim.claimId, line: { expenseDate: '2026-06-24', category: 'travel', amountMinor }, idempotencyKey: `e3:clm${i}:line` }, { as: drafter });
    call('expense_claim_submit', { workspaceId: W, claimId: claim.claimId, idempotencyKey: `e3:clm${i}:submit` }, { as: drafter });
  }
  if (status() === 'submitted') call('expense_claim_approve', { workspaceId: W, claimId: claim.claimId, confirm: true, idempotencyKey: `e3:clm${i}:approve` }, { date: '2026-06-26' });
  return claim.claimId;
});

// The statement: one day-end camt.053 with one line per target.
const total = invoices.reduce((s, d) => s + d.totalMinor, 0) + 500;
const lines = [
  { ref: 'IN-CUST', amountMinor: 50000, cd: 'CRDT', name: 'Kafi Muster AG', text: 'Anzahlung Kaffeemaschine' },
  { ref: 'OUT-SUPP', amountMinor: 30000, cd: 'DBIT', name: 'Druckerei Tannenbach AG', text: 'Vorauszahlung Broschüren-Druck' },
  { ref: 'IN-MULTI', amountMinor: total, cd: 'CRDT', name: 'Kafi Muster AG', text: 'Rechnungen Juni' },
  { ref: 'OUT-SPES', amountMinor: 8550, cd: 'DBIT', name: 'Anna Beispiel', text: 'Spesen Juni' },
  { ref: 'OUT-CARD', amountMinor: 9422, cd: 'DBIT', name: 'Cloud Hosting Inc', text: 'USD 100.00 Kurs 0.9237 Kommission CHF 1.85' },
];
const major = (minor) => (minor / 100).toFixed(2);
const net = lines.reduce((s, l) => s + (l.cd === 'CRDT' ? l.amountMinor : -l.amountMinor), 0);
const bal = (code, minor) =>
  `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${major(Math.abs(minor))}</Amt><CdtDbtInd>${minor < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd></Bal>`;
const ntry = lines
  .map((l) => {
    const party = l.cd === 'CRDT' ? 'Dbtr' : 'Cdtr';
    return `<Ntry><NtryRef>${l.ref}</NtryRef><Amt Ccy="CHF">${major(l.amountMinor)}</Amt><CdtDbtInd>${l.cd}</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><RvslInd>false</RvslInd><BookgDt><Dt>2026-07-15</Dt></BookgDt><ValDt><Dt>2026-07-15</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><RltdPties><${party}><Pty><Nm>${l.name}</Nm></Pty></${party}></RltdPties><RmtInf><Ustrd>${l.text}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
  })
  .join('\n');
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>E3-SEED-1-msg</MsgId><CreDtTm>2026-07-15T20:00:00</CreDtTm></GrpHdr>
<Stmt><Id>E3-SEED-1</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-07-15T00:00:00</FrDtTm><ToDtTm>2026-07-15T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
${bal('OPBD', 0)}
${bal('CLBD', net)}
${ntry}
</Stmt></BkToCstmrStmt></Document>`;
const imported = call('import_camt', { workspaceId: W, bankAccountId: bank.bankAccountId, xml, idempotencyKey: 'e3:camt' }, { date: '2026-07-16' });
const lineId = (ref) => store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ? AND entry_ref = ?').get(W, imported.statementId, ref)?.id;

/** The target each line is meant for, exactly as `book_bank_line` and `compose_entry` take it. */
const targets = {
  'IN-CUST': { kind: 'contact', contactId: customer },
  'OUT-SUPP': { kind: 'contact', contactId: supplier },
  'IN-MULTI': { kind: 'open_item', allocations: invoices.map((d) => ({ documentId: d.id, amountMinor: d.totalMinor })), remainder: 'on_account' },
  'OUT-SPES': { kind: 'expense_claims', claimIds: claims },
  'OUT-CARD': {
    kind: 'accounts',
    legs: [
      { accountId: acc('6570'), amountMinor: 9237, fx: { currency: 'USD', amountMinor: 10000 } },
      { accountId: acc('6900'), amountMinor: 185 },
    ],
    acknowledgeFx: true,
  },
};

console.log(`workspace ${W} (Bankziele Muster AG), statement ${imported.statementId}`);
for (const [ref, target] of Object.entries(targets)) {
  const bankTxnId = lineId(ref);
  const decided = store.db.prepare('SELECT target_kind FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL').get(W, bankTxnId);
  if (decided !== undefined) {
    console.log(`  ${ref.padEnd(9)} ${bankTxnId}  already booked (${decided.target_kind})`);
    continue;
  }
  const preview = call('compose_entry', { workspaceId: W, mode: 'expand', bankTxnId, target }, { date: '2026-07-16' });
  const b = preview.booking;
  console.log(`  ${ref.padEnd(9)} ${bankTxnId}  ${target.kind.padEnd(14)} bookable=${b.bookable}${b.blockedBy ? ` (${b.blockedBy})` : ''}${b.deviationMinor ? ` deviation=${major(b.deviationMinor)}` : ''}`);
  if (BOOK) call('book_bank_line', { workspaceId: W, bankTxnId, target, idempotencyKey: `e3:book:${ref}` }, { date: '2026-07-16' });
}
console.log(BOOK ? 'every line booked; reopen_bank_line undoes each.' : 'every line is open in /bank; run with --book to book them.');
store.close?.();
