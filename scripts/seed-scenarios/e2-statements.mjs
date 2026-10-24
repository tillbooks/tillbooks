#!/usr/bin/env node
/**
 * Seed scenario E2 (D178 points 3 and 4, spec A20 §11): statements in, in three formats, on the Seeblick
 * demo book that `scripts/seed-demo-rich.mjs` builds.
 *
 * It drives the PUBLIC API only (`handleRest`, the seed-demo-rich pattern) and touches no engine code:
 *
 *  1. a dedicated Bankkonto "Kartenkonto CHF" on its own ledger account 1022 (so the demo's main account
 *     and its statement chain stay exactly as the demo seed left them);
 *  2. a camt.053 for 19.08.2026 with a USD card payment carrying its instructed amount, the bank's rate
 *     and an included fee (structured `AmtDtls`, `CcyXchg`, `Chrgs`), a EUR card payment whose amount,
 *     rate and fee are only in the booking text (the text fallback), and a domestic transfer;
 *  3. an MT940 for 20.08.2026 (a ZKB-style `?ZI:` block with a foreign amount and a fee, a customer
 *     credit) through the same door;
 *  4. a CSV export for 20.08 and 21.08.2026, mapped once (the mapping is saved on the Bankkonto), whose
 *     20.08 row is the MT940's card payment again. Under the owner's decision (D178 point 19, A20 §11.4)
 *     the row is imported FLAGGED with the MT940 line as its candidate (`possibleDuplicates`,
 *     `needsDuplicateDecision`): it is never "sicher" and waits for the person's "Duplikat" or "Kein
 *     Duplikat" (`resolve_possible_duplicate`).
 *
 * SYNTHETIC BY CONSTRUCTION: every merchant, name, amount, rate and reference below is invented; the
 * IBAN is generated here with valid check digits on an invented account number.
 *
 * Every write carries a stable `seed:e2:*` idempotency key and every statement dedupes on its own
 * identity, so running it again changes nothing.
 *
 * Usage (after `npm run build` and the demo seed):
 *   TILL_DB_PATH=~/.till/till-demo.db node scripts/seed-scenarios/e2-statements.mjs
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const { SqliteStore } = await import(join(ROOT, 'dist/core/store/sqlite-store.js'));
const { systemIdGen } = await import(join(ROOT, 'dist/core/ids.js'));
const { handleRest } = await import(join(ROOT, 'dist/api/rest.js'));
const { resolveDbPath } = await import(join(ROOT, 'dist/api/db-path.js'));

const dbPath = resolveDbPath();
if (dbPath === ':memory:') {
  console.error('Refusing to seed :memory: (nothing would survive). Set TILL_DB_PATH to the demo book, e.g. ~/.till/till-demo.db');
  process.exit(1);
}

let NOW = '2026-08-21T09:00:00.000Z';
const clock = { now: () => NOW };
const store = new SqliteStore({ location: dbPath, clock });
const deps = { store, clock, ids: systemIdGen, actor: 'user_1' };

/** Drive one public verb; throw loudly on a refusal. */
function call(verb, input, date) {
  if (date !== undefined) NOW = `${date}T09:00:00.000Z`;
  const res = handleRest(verb, { ...input }, deps);
  if (res.body && res.body.ok === false) {
    throw new Error(`SEED E2 FAIL ${verb} status=${res.status} -> ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** A Swiss IBAN with valid ISO 13616 check digits for an invented clearing and account number. */
function swissIban(clearing, account) {
  const bban = `${clearing}${account}`;
  const numeric = `${bban}CH00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of numeric) rest = (rest * 10 + Number(digit)) % 97;
  return `CH${String(98 - rest).padStart(2, '0')}${bban}`;
}

// --- The Seeblick workspace and the dedicated card account --------------------------------------------
const ws = store.db.prepare("SELECT id FROM workspace WHERE name LIKE 'Seeblick Kaffee%' ORDER BY rowid LIMIT 1").get();
if (ws === undefined) {
  console.error('No Seeblick workspace in this book: run scripts/seed-demo-rich.mjs first.');
  process.exit(1);
}
const workspaceId = ws.id;
const IBAN = swissIban('00762', '011623859990');

const accountRow = () => store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1022'").get(workspaceId);
if (accountRow() === undefined) {
  call('create_account', { workspaceId, number: '1022', name: 'Bank Kartenkonto', type: 'asset', idempotencyKey: 'seed:e2:acc:1022' }, '2026-08-18');
}
const existing = store.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND iban = ?').get(workspaceId, IBAN);
let bankAccountId = existing?.id;
if (bankAccountId === undefined) {
  const created = call('create_bank_account', { workspaceId, name: 'Kartenkonto CHF', iban: IBAN, currency: 'CHF', ledgerAccountId: accountRow().id, idempotencyKey: 'seed:e2:bank' }, '2026-08-18');
  bankAccountId = created.bankAccount?.id ?? created.bankAccountId;
}

// --- 1. camt.053 for 19.08.2026 -------------------------------------------------------------------------
const camt = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>SEED-E2-MSG-1</MsgId><CreDtTm>2026-08-19T20:00:00</CreDtTm></GrpHdr>
<Stmt><Id>SEED-E2-STMT-1</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-08-19T00:00:00</FrDtTm><ToDtTm>2026-08-19T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">2000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1789.89</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><NtryRef>SEED-E2-1</NtryRef><Amt Ccy="CHF">49.88</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>false</RvslInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>2026-08-19</Dt></BookgDt><ValDt><Dt>2026-08-18</Dt></ValDt><AcctSvcrRef>SEED-E2-ASR-1</AcctSvcrRef>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>SEED-E2-TX-1</AcctSvcrRef></Refs><Amt Ccy="CHF">49.88</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<AmtDtls><InstdAmt><Amt Ccy="USD">60.78</Amt><CcyXchg><SrcCcy>USD</SrcCcy><TrgtCcy>CHF</TrgtCcy><UnitCcy>USD</UnitCcy><XchgRate>0.810464</XchgRate></CcyXchg></InstdAmt></AmtDtls>
<Chrgs><TtlChrgsAndTaxAmt Ccy="CHF">0.62</TtlChrgsAndTaxAmt><Rcrd><Amt Ccy="CHF">0.62</Amt><CdtDbtInd>DBIT</CdtDbtInd><ChrgInclInd>true</ChrgInclInd></Rcrd></Chrgs>
<RltdPties><Cdtr><Pty><Nm>Antiquariat Westbrook Ltd</Nm></Pty></Cdtr></RltdPties>
<RmtInf><Ustrd>Kartenzahlung Antiquariat Westbrook Ltd Boston</Ustrd></RmtInf><AddtlTxInf>Debitkarte xxxx 5521</AddtlTxInf></TxDtls></NtryDtls>
<AddtlNtryInf>Kartenbezug Ausland</AddtlNtryInf></Ntry>
<Ntry><NtryRef>SEED-E2-2</NtryRef><Amt Ccy="CHF">40.23</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>false</RvslInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>2026-08-19</Dt></BookgDt><ValDt><Dt>2026-08-19</Dt></ValDt><AcctSvcrRef>SEED-E2-ASR-2</AcctSvcrRef>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>SEED-E2-TX-2</AcctSvcrRef></Refs><Amt Ccy="CHF">40.23</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<RmtInf><Ustrd>Velowerkstatt Alpenblick Annecy, EUR 41.50, abgerechnet in CHF, Kurs 0.951234, 18.08.2026, Kommission CHF 0.75</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><NtryRef>SEED-E2-3</NtryRef><Amt Ccy="CHF">120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>false</RvslInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>2026-08-19</Dt></BookgDt><ValDt><Dt>2026-08-19</Dt></ValDt><AcctSvcrRef>SEED-E2-ASR-3</AcctSvcrRef>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>AUTT</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>SEED-E2-TX-3</AcctSvcrRef><EndToEndId>SEED-E2-E2E-3</EndToEndId></Refs><Amt Ccy="CHF">120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<RltdPties><Cdtr><Pty><Nm>Druckerei Lindenhof AG</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>Rechnung 2026-118 Flyer</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>
`;

// --- 2. MT940 for 20.08.2026 ----------------------------------------------------------------------------
const mt940 = [
  ':20:SEED-E2-0820',
  `:25:${IBAN}`,
  ':28C:2/1',
  ':60F:C260819CHF1789,89',
  ':61:2608200820D25,18NMSCNONREF//SEED-E2-MT-1',
  ':86:?ZKB:2201 55001',
  'Buchhandlung Nordlicht Oslo',
  'Kartenzahlung?ZI:?0:NOK262,40?3:0,093720?8:CHF0,59',
  ':61:2608200820C250,NTRFNONREF//SEED-E2-MT-2',
  ':86:/ORDP/NAME/Familie Beispielmann//REMI/Rechnung 2026-131 Kaffeeabo/',
  ':62F:C260820CHF2014,71',
].join('\n');

// --- 3. CSV for 20.08 and 21.08.2026 -------------------------------------------------------------------
const csv = [
  'Kartenkonto CHF;Seeblick Kaffee & Technik GmbH',
  '',
  'Buchungsdatum;Valuta;Buchungstext;Belastung;Gutschrift',
  '20.08.2026;20.08.2026;Kartenzahlung Buchhandlung Nordlicht Oslo NOK 262.40;25.18;',
  '21.08.2026;21.08.2026;Parkhaus Bahnhof Winterthur;6.50;',
  "21.08.2026;21.08.2026;Gutschrift Café Rosengarten Rechnung 2026-133;;1'180.00",
].join('\r\n');
const mapping = {
  columns: { bookingDate: 'Buchungsdatum', valueDate: 'Valuta', text: 'Buchungstext', debit: 'Belastung', credit: 'Gutschrift' },
  dateFormat: 'dd.mm.yyyy',
  decimalSeparator: '.',
};

const report = (label, r) =>
  console.log(`${label}: format ${r.format}, imported ${r.imported}, duplicates ${r.duplicates}, refused ${r.refused}${r.skipped.length > 0 ? ` (${r.skipped.map((s) => s.reason).join(', ')})` : ''}`);

report('camt', call('import_bank_statement', { workspaceId, bankAccountId, content: camt, fileName: 'seed-e2-0819.xml', idempotencyKey: 'seed:e2:camt' }, '2026-08-19'));
report('MT940', call('import_bank_statement', { workspaceId, bankAccountId, content: mt940, fileName: 'seed-e2-0820.sta', idempotencyKey: 'seed:e2:mt940' }, '2026-08-20'));
report(
  'CSV',
  call(
    'import_bank_statement',
    { workspaceId, bankAccountId, contentBase64: Buffer.from(`﻿${csv}`, 'utf8').toString('base64'), fileName: 'seed-e2-0821.csv', mapping, idempotencyKey: 'seed:e2:csv' },
    '2026-08-21',
  ),
);

const inbox = call('list_bank_inbox', { workspaceId, bankAccountId, status: 'all', limit: 50 });
const withFee = inbox.lines.filter((l) => l.facts?.fee !== null && l.facts?.fee !== undefined);
const named = inbox.lines.filter((l) => l.needsDuplicateDecision === true);
console.log(
  `Kartenkonto CHF: ${inbox.total} lines, ${withFee.length} with a known fee, ${named.length} waiting for a duplicate decision, balance ${inbox.summary[0]?.bankBalanceMinor ?? 'n/a'} (Rappen)`,
);
store.close?.();
