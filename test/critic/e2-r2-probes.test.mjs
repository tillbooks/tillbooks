// CRITIC PROBES, D178 node E2 round 2 (non-author), against the orchestrator ruling: a line is absorbed
// only on strong identity; everything weaker imports and is NAMED on the new line for the person.
//
// Each probe asserts the CORRECT outcome; a failing probe is the evidence of a defect (see
// docs/critique/bank-parity-e2-critic-r2.md). Sound checks are marked as such.
//
// ROUND 3 (author): the OWNER decided the design afterwards (D178 point 19, 21.10.2026): nothing across
// formats is dropped by default (`bank.cross_format_duplicates` = `ask`), every possible duplicate is
// imported FLAGGED for the person, and a flagged line is not bookable until the person answers
// (`resolve_possible_duplicate`). Four probes are adapted to that decision, each saying how: R2-2 and R2-S1
// keep the critic's assertion under `auto_strong` and add the default `ask` case; R2-S3 answers "Kein
// Duplikat" before it books; R2-5 is a todo owned by the bank GUI node. Every other probe is unchanged.
//
// SYNTHETIC BY CONSTRUCTION: every statement, name, reference and amount below is invented in this file;
// the IBANs are the published PostFinance sample and the invented supplier IBAN of the A39 support file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importCamt, listBankInbox } from '../../dist/core/banking/index.js';
import { importBankStatement, bankCsvPreview } from '../../dist/core/banking/statementImport.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';
import { world, must, camt, MAIN_IBAN, TELCO_IBAN } from '../banking/bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

let n = 0;
const key = () => `e2r2-${(n += 1)}`;

/** Every line of the world with its possible-duplicate flag. */
function lines(t) {
  return t.store.db
    .prepare(
      `SELECT t.id, t.amount_minor AS a, t.credit_debit AS cd, t.booking_date AS b, s.message_type AS f, p.existing_bank_txn_id AS dupOf
         FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id
         LEFT JOIN bank_txn_possible_duplicate p ON p.workspace_id = t.workspace_id AND p.bank_txn_id = t.id
        WHERE t.workspace_id = ? ORDER BY t.rowid`,
    )
    .all(t.workspaceId);
}

/** The helper's camt with each NtryRef also written as the entry's AcctSvcrRef (the bank's own reference). */
const withAsr = (xml) => xml.replace(/<NtryRef>([^<]+)<\/NtryRef>([\s\S]*?<\/ValDt>)/g, '<NtryRef>$1</NtryRef>$2<AcctSvcrRef>$1</AcctSvcrRef>');

/** One MT940 message; a page other than the last closes with :62M:, a page other than the first opens with :60M:. */
function mt940({ ref, number, page = 1, last = true, open = '261004', close = '261005', body }) {
  return [`:20:${ref}`, `:25:${MAIN_IBAN}`, `:28C:${number}/${page}`, `${page === 1 ? ':60F:' : ':60M:'}C${open}CHF1000,00`, ...body, `${last ? ':62F:' : ':62M:'}C${close}CHF900,00`, '-'].join('\n');
}

/** ROUND 3: the owner's second setting value, where a shared bank reference on the same booking date drops the line. */
const autoStrong = (t) => must(settingsSet(t.ctx, { key: 'bank.cross_format_duplicates', value: 'auto_strong', reason: 'critic probe', idempotencyKey: key() }), 'auto_strong');

const importText = (t, content, extra = {}) => must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, idempotencyKey: key(), ...extra }), 'import_bank_statement');

// --- R2-1: a line named as a possible duplicate is still "sure", so "Alle sicheren buchen" books it -----

test('R2-1: a line named as a possible duplicate is never "sure" (the bulk button must not book it unseen)', () => {
  const t = world();
  // The telecom bill arrives first in a CSV export (with its IBAN column), and the person files it under a
  // Buchungsregel (6500, no MWST), so every later bill of that supplier is proposed "sure".
  importText(t, `Datum;Text;Betrag;IBAN\n05.10.2026;Telekom Rechnung Oktober;-89.90;${TELCO_IBAN}\n`, {
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag', counterpartyIban: 'IBAN' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' },
  });
  const csvLine = lines(t)[0].id;
  must(setBankStandard(t.ctx, { bankTxnId: csvLine, accountId: t.acc('6500'), taxCode: null, idempotencyKey: key() }), 'rule');
  // The same day arrives as camt: the same bill, imported and NAMED (a CSV carries no bank reference).
  const res = must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: withAsr(camt({ statementId: 'R2-1-CAMT', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'R2-1-ASR', amountMinor: 8990, cd: 'DBIT', date: '2026-10-05', iban: TELCO_IBAN, name: 'Telekom Beispiel AG' }] })),
      idempotencyKey: key(),
    }),
  );
  assert.ok(res.warnings.includes('possible_cross_format_duplicate'), JSON.stringify(res.warnings));
  const flagged = lines(t).find((l) => l.dupOf !== null);
  assert.ok(flagged !== undefined, 'the camt line is named');
  const line = must(listBankInbox(t.ctx, { bankTxnId: flagged.id, status: 'all' })).lines[0];
  // ADAPTED to the E2 re-cut: the CSV covers 05.10. (its edge day), so coverage matches the camt bill one to
  // one first, and the strongest reason it names is `same_movement`.
  assert.deepEqual(line.possibleDuplicateOf, { bankTxnId: csvLine, reason: 'same_movement' });
  assert.notEqual(
    line.attention,
    'sure',
    `a named possible duplicate is offered to "Alle sicheren buchen" (attention ${line.attention}, certainty ${line.proposal.certainty}, reason ${line.proposal.reasonCode}): one click books the movement twice`,
  );
});

// --- R2-2: an EndToEndId absorbs a line whose OWN bank reference says it is another posting ------------

test('R2-2: a second payment with the same EndToEndId but its own bank reference is never absorbed', () => {
  // ROUND 3: under `auto_strong` the critic's assertion holds as written (page 1 is the camt line by its
  // bank reference, page 2 is kept). Under the default `ask` (the case below) nothing is dropped at all.
  const t = world();
  autoStrong(t);
  // A customer pays invoice 1041 twice the same day, both times with the EndToEndId RECHNUNG-1041. The
  // morning download (a camt.053 without ElctrncSeqNb: not a day-end statement) carries the first.
  const morning = withAsr(
    camt({ statementId: 'R2-2-CAMT', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'R2-ASR-A', amountMinor: 70035, cd: 'CRDT', date: '2026-10-05', e2e: 'RECHNUNG-1041', name: 'Kundin Ammann' }] }),
  ).replace(/<ElctrncSeqNb>[^<]*<\/ElctrncSeqNb>/, '');
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: morning, idempotencyKey: key() }), 'camt morning');
  // The day-end arrives as a two-page MT940: page 1 the first payment (its // reference = the camt
  // AcctSvcrRef), page 2 the SECOND payment, with a // reference of its own.
  const page1 = mt940({ ref: 'R2-2-P1', number: 90, page: 1, last: false, body: [':61:2610051005C700,35NTRFNONREF//R2-ASR-A', ':86:/EREF/RECHNUNG-1041//REMI/Rechnung 1041/'] });
  const page2 = mt940({ ref: 'R2-2-P2', number: 90, page: 2, open: '261005', body: [':61:2610051005C700,35NTRFNONREF//R2-ASR-B', ':86:/EREF/RECHNUNG-1041//REMI/Rechnung 1041/'] });
  const res = importText(t, `${page1}\n${page2}`);
  const credits = lines(t).filter((l) => l.cd === 'CRDT');
  assert.equal(
    credits.length,
    2,
    `two payments were received; the books hold ${credits.length}. Skipped: ${JSON.stringify(res.skipped)}`,
  );
});

test('R2-2 (round 3, the default ask): both MT940 pages are imported and flagged; nothing is dropped, the person decides', () => {
  const t = world();
  const morning = withAsr(
    camt({ statementId: 'R2-2-CAMT', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'R2-ASR-A', amountMinor: 70035, cd: 'CRDT', date: '2026-10-05', e2e: 'RECHNUNG-1041', name: 'Kundin Ammann' }] }),
  ).replace(/<ElctrncSeqNb>[^<]*<\/ElctrncSeqNb>/, '');
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: morning, idempotencyKey: key() }), 'camt morning');
  const page1 = mt940({ ref: 'R2-2-P1', number: 90, page: 1, last: false, body: [':61:2610051005C700,35NTRFNONREF//R2-ASR-A', ':86:/EREF/RECHNUNG-1041//REMI/Rechnung 1041/'] });
  const page2 = mt940({ ref: 'R2-2-P2', number: 90, page: 2, open: '261005', body: [':61:2610051005C700,35NTRFNONREF//R2-ASR-B', ':86:/EREF/RECHNUNG-1041//REMI/Rechnung 1041/'] });
  const res = importText(t, `${page1}\n${page2}`);
  assert.equal(res.skipped.filter((s) => s.reason === 'cross_format_duplicate').length, 0, 'nothing dropped across formats under ask');
  const credits = lines(t).filter((l) => l.cd === 'CRDT');
  assert.equal(credits.length, 3);
  assert.equal(credits.filter((l) => l.dupOf !== null).length, 2, 'both MT940 lines wait for the person');
});

// --- R2-3: the MT940 page counter depends on the pages arriving in order ------------------------------

test('R2-3a: the pages of one MT940 statement imported from two files, page 2 first: both identical coffees stay', () => {
  const t = world();
  const coffee = (info) => [':61:2610051005D4,50NMSCNONREF', `:86:${info}`];
  const page1 = mt940({ ref: 'R2-3-P1', number: 91, page: 1, last: false, body: coffee('Kaffeebar Seeblick Karte 1') });
  const page2 = mt940({ ref: 'R2-3-P2', number: 91, page: 2, open: '261005', body: coffee('Kaffeebar Seeblick Karte 2') });
  importText(t, page2);
  const res = importText(t, page1);
  assert.equal(lines(t).length, 2, `two coffees, got ${lines(t).length}; skipped ${JSON.stringify(res.skipped)}`);
});

test('R2-3b: one file whose pages of statement X are split by another statement Y (X2, Y1, X1): both coffees of X stay', () => {
  const t = world();
  const coffee = (info) => [':61:2610051005D4,50NMSCNONREF', `:86:${info}`];
  const x2 = mt940({ ref: 'R2-3-X2', number: 93, page: 2, open: '261005', body: coffee('Kaffeebar Seeblick Karte 2') });
  const y1 = mt940({ ref: 'R2-3-Y1', number: 94, page: 1, open: '261005', close: '261006', body: [':61:2610061006D12,00NMSCNONREF', ':86:Papeterie Lindenhof'] });
  const x1 = mt940({ ref: 'R2-3-X1', number: 93, page: 1, last: false, body: coffee('Kaffeebar Seeblick Karte 1') });
  const res = importText(t, `${x2}\n${y1}\n${x1}`);
  assert.equal(lines(t).filter((l) => l.a === 450).length, 2, `two coffees, got ${JSON.stringify(lines(t))}; skipped ${JSON.stringify(res.skipped)}`);
});

// --- R2-4 (LOW): the modal width picks a preamble that outnumbers a short month's rows ----------------

test('R2-4: a short month (two rows) below a five-line key;value preamble keeps its real header row', () => {
  const t = world();
  const csv = [
    'Konto;CH93 0076 2011 6238 5295 7',
    'Kontoinhaber;Beispiel GmbH',
    'Währung;CHF',
    'Datum von;01.10.2026',
    'Datum bis;31.10.2026',
    'Buchungsdatum;Buchungstext;Betrag',
    '05.10.2026;Kaffeebar Seeblick;-4.50',
    '06.10.2026;Gutschrift Kundin Ammann;350.00',
  ].join('\n');
  const preview = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csv }));
  assert.deepEqual(preview.headers, ['Buchungsdatum', 'Buchungstext', 'Betrag'], `header row ${preview.headerRow}: ${JSON.stringify(preview.headers)}`);
});

// --- R2-5: the Studio never shows the mark the toast tells the person to look for ----------------------

// ROUND 3: rendering the flag (a badge, the candidates, the two decision buttons) belongs to the bank GUI
// node (orchestrator, round 3 item 8); this node provides the read fields (possibleDuplicates,
// needsDuplicateDecision), the facet and the verb. A todo here until that node lands.
test('R2-5: the Studio bank inbox shows a line\'s possibleDuplicates (the toast says the line is marked)', { todo: 'owned by the bank GUI node (D178 round 3 item 8)' }, () => {
  const dir = join(ROOT, 'app', 'src', 'surfaces', 'Bank');
  const uses = readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .filter((f) => /possibleDuplicates|possibleDuplicateOf/.test(readFileSync(join(dir, f), 'utf8')));
  const de = readFileSync(join(dir, 'messages.de-CH.json'), 'utf8');
  assert.ok(de.includes('TILL hat sie importiert und markiert'), 'the toast promises a mark on the line');
  assert.ok(uses.length > 0, 'no Bank surface file reads possibleDuplicateOf: the mark exists only in the engine');
});

// --- Sound checks ------------------------------------------------------------------------------------

test('R2-S1 (sound check): twin card payments the same day, each with its own AcctSvcrRef, through a two-page MT940: each absorbed by its own reference', () => {
  // ROUND 3: absorption happens only under `auto_strong` (the owner's opt-in); the default ask is below.
  const t = world();
  autoStrong(t);
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: withAsr(camt({ statementId: 'R2-S1', from: '2026-10-05', to: '2026-10-05', entries: [
        { ref: 'R2-S1-A', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' },
        { ref: 'R2-S1-B', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' },
      ] })),
      idempotencyKey: key(),
    }),
  );
  const p1 = mt940({ ref: 'R2-S1-P1', number: 95, page: 1, last: false, body: [':61:2610051005D4,50NMSCNONREF//R2-S1-B', ':86:Kaffee'] });
  const p2 = mt940({ ref: 'R2-S1-P2', number: 95, page: 2, open: '261005', body: [':61:2610051005D4,50NMSCNONREF//R2-S1-A', ':86:Kaffee'] });
  const res = importText(t, `${p1}\n${p2}`);
  assert.equal(lines(t).length, 2);
  const absorbed = res.skipped.filter((s) => s.reason === 'cross_format_duplicate').map((s) => s.existingBankTxnId).sort();
  assert.equal(new Set(absorbed).size, 2, `each page absorbed into its own camt line: ${JSON.stringify(res.skipped)}`);
  // ROUND 3, the default ask: the same file keeps all four lines, the two MT940 coffees flagged, each
  // naming its own camt line first (shared_reference).
  const u = world();
  must(
    importCamt(u.ctx, {
      bankAccountId: u.bankAccountId,
      xml: withAsr(camt({ statementId: 'R2-S1', from: '2026-10-05', to: '2026-10-05', entries: [
        { ref: 'R2-S1-A', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' },
        { ref: 'R2-S1-B', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' },
      ] })),
      idempotencyKey: key(),
    }),
  );
  const asked = importText(u, `${p1}\n${p2}`);
  assert.equal(lines(u).length, 4);
  const camtOf = (ref) => u.store.db.prepare("SELECT id FROM bank_txn WHERE workspace_id = ? AND entry_key = ?").get(u.workspaceId, `asr:${ref}`).id;
  const firsts = asked.statements.flatMap((st) => st.nearDuplicates ?? []).map((n) => [n.reason, n.existingBankTxnId]);
  assert.deepEqual(firsts.sort(), [['shared_reference', camtOf('R2-S1-A')], ['shared_reference', camtOf('R2-S1-B')]].sort());
});

test('R2-S2 (sound check): a reference shared a day apart, a value date only, a CSV: each never absorbed, each named', () => {
  const base = () => {
    const t = world();
    must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: withAsr(camt({ statementId: 'R2-S2', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'R2-S2-A', amountMinor: 3300, cd: 'DBIT', date: '2026-10-05' }] })), idempotencyKey: key() }));
    return t;
  };
  const cases = [
    (t) => importText(t, mt940({ ref: 'R2-S2-M', number: 96, open: '261005', close: '261006', body: [':61:2610061006D33,00NMSCNONREF//R2-S2-A', ':86:Gebühr'] })),
    (t) => importText(t, mt940({ ref: 'R2-S2-N', number: 97, body: [':61:261005D33,00NMSCNONREF', ':86:Gebühr ohne Buchungsdatum'] })),
    (t) => importText(t, 'Datum;Text;Betrag\n05.10.2026;Gebühr;-33.00\n', { mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' } }),
  ];
  for (const run of cases) {
    const t = base();
    const r = run(t);
    assert.equal(r.skipped.filter((s) => s.reason === 'cross_format_duplicate').length, 0, JSON.stringify(r.skipped));
    const all = lines(t);
    assert.equal(all.length, 2);
    assert.equal(all.filter((l) => l.dupOf !== null).length, 1, 'the weaker resemblance is named');
  }
});

test('R2-S3 (sound check): the flag is scoped to its Bankkonto and workspace, written once, never blocks an ignore; a booking waits for the decision', async () => {
  const { createBankAccount } = await import('../../dist/core/banking/index.js');
  const { ignoreBankLine, bookBankLine } = await import('../../dist/core/banking/bankBooking.js');
  const { secondWorkspace } = await import('../banking/bank-inbox-support.mjs');
  const t = world();
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
  importText(t, 'Datum;Text;Betrag\n05.10.2026;Papeterie Lindenhof;-12.00\n06.10.2026;Druckerei Seeblick;-120.00\n', { mapping });
  const xml = withAsr(camt({ statementId: 'R2-S3', from: '2026-10-05', to: '2026-10-06', entries: [
    { ref: 'R2-S3-A', amountMinor: 1200, cd: 'DBIT', date: '2026-10-05' },
    { ref: 'R2-S3-B', amountMinor: 12000, cd: 'DBIT', date: '2026-10-06' },
  ] }));
  // Another Bankkonto of the same workspace never resembles this one's lines.
  const savings = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: t.acc('1020'), idempotencyKey: 'r2s3-sav' }));
  must(importCamt(t.ctx, { bankAccountId: savings.bankAccountId, xml: xml.replace(MAIN_IBAN, 'CH5604835012345678009'), idempotencyKey: key() }), 'savings camt');
  assert.equal(lines(t).filter((l) => l.dupOf !== null).length, 0, 'another Bankkonto: nothing named');
  // This Bankkonto: both camt lines named, once; a re-import writes no second flag.
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: key() }), 'camt');
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml, idempotencyKey: key() }), 'camt again');
  const flagRows = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate').get().n;
  assert.equal(flagRows(), 2);
  // Another workspace reads none of them.
  const b = secondWorkspace(t);
  const bAcc = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'r2s3-b' }), 'B account');
  must(importCamt(b.ctx, { bankAccountId: bAcc.bankAccountId, xml, idempotencyKey: key() }), 'B camt');
  const bLines = must(listBankInbox(b.ctx, { status: 'all' })).lines;
  assert.ok(bLines.length === 2 && bLines.every((l) => l.possibleDuplicateOf === null), 'workspace B sees no flag');
  // A named line can be ignored as a duplicate; the other one is booked once the person said "Kein Duplikat"
  // (ROUND 3, the owner's decision: a flagged line is not bookable before the answer); the flag stays as history.
  const [first, second] = lines(t).filter((l) => l.dupOf !== null);
  must(ignoreBankLine(t.ctx, { bankTxnId: first.id, reason: 'duplicate', idempotencyKey: key() }), 'ignore');
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 12000 }] };
  const early = bookBankLine(t.ctx, { bankTxnId: second.id, target, idempotencyKey: key() });
  assert.equal(early.error, 'duplicate_decision_pending');
  must(resolvePossibleDuplicate(t.ctx, { bankTxnId: second.id, decision: 'distinct', idempotencyKey: key() }), 'distinct');
  must(bookBankLine(t.ctx, { bankTxnId: second.id, target, idempotencyKey: key() }), 'book');
  assert.equal(flagRows(), 2);
});

// --- R2-6: a near-date flag consumes the stored line, so its TRUE counterpart later goes unnamed ------

test("R2-6: a daily coffee: a near-date flag on Thursday never leaves Wednesday's real duplicate unnamed", () => {
  const t = world();
  // camt for Monday to Wednesday: one CHF 4.50 coffee a day, each with its AcctSvcrRef.
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: withAsr(camt({ statementId: 'R2-6-CAMT', from: '2026-10-05', to: '2026-10-07', entries: [
        { ref: 'R2-6-MO', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' },
        { ref: 'R2-6-TU', amountMinor: 450, cd: 'DBIT', date: '2026-10-06' },
        { ref: 'R2-6-WE', amountMinor: 450, cd: 'DBIT', date: '2026-10-07' },
      ] })),
      idempotencyKey: key(),
    }),
  );
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
  // Thursday's coffee (a NEW movement) comes in a CSV first: named near_date against Wednesday's camt line.
  importText(t, 'Datum;Text;Betrag\n08.10.2026;Kaffeebar Seeblick;-4.50\n', { mapping });
  // Then the week's CSV export, Monday to Thursday: the same four coffees.
  const res = importText(t, ['Datum;Text;Betrag', '05.10.2026;Kaffeebar Seeblick;-4.50', '06.10.2026;Kaffeebar Seeblick;-4.50', '07.10.2026;Kaffeebar Seeblick;-4.50', '08.10.2026;Kaffeebar Seeblick;-4.50'].join('\n'), { mapping });
  const all = lines(t);
  const wednesday = all.filter((l) => l.b === '2026-10-07');
  const unnamedWednesday = wednesday.filter((l) => l.dupOf === null);
  assert.equal(
    unnamedWednesday.length,
    1,
    `Wednesday's coffee is in the books ${wednesday.length} times, ${unnamedWednesday.length} of them unnamed (a silent double count): ${JSON.stringify(all)}; warnings ${JSON.stringify(res.statements.map((s) => s.warnings))}`,
  );
});

// ADDED with the E2 re-cut (author, round 3): inside the covered span coverage now matches Wednesday's coffee
// one to one whatever point 19 names, so R2-6 above no longer reaches point 19's naming alone (the critic's
// mutation E survived it). This case lies OUTSIDE every covered day, where only point 19 names a line: a stored
// line already named for one import must still be named for the next.
test('R2-6b (outside coverage, added with the E2 re-cut): a stored line named for one import is named again for the next', () => {
  const t = world();
  // camt for Monday only: one coffee with its AcctSvcrRef; it covers Monday and nothing after.
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: withAsr(camt({ statementId: 'R2-6B-CAMT', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'R2-6B-MO', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' }] })),
      idempotencyKey: key(),
    }),
  );
  const camtLine = lines(t)[0].id;
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
  // Two single-row CSV exports of Tuesday (other texts, so two deliveries): Tuesday is covered by nothing.
  importText(t, 'Datum;Text;Betrag\n06.10.2026;Kaffeebar Seeblick;-4.50\n', { mapping });
  importText(t, 'Datum;Text;Betrag\n06.10.2026;Kaffeebar Seeblick Karte;-4.50\n', { mapping });
  const tuesday = lines(t).filter((l) => l.b === '2026-10-06');
  assert.equal(tuesday.length, 2);
  assert.deepEqual(tuesday.map((l) => l.dupOf), [camtLine, camtLine], `each Tuesday row names Monday's camt coffee: ${JSON.stringify(lines(t))}`);
});
