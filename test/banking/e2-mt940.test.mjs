// D178 point 4 (spec A20 §11.2): MT940 read into the camt statement shape. The ZKB-structured `:86:`
// (`?ZKB:`, `?ZI:` with `?0:`, `?3:`, `?4:`, `?8:`), the German GVC structure (`?00`, `?20`-`?29`, `?32`,
// SEPA keywords) and the SWIFT `/KEY/` structure; the marks C, D, RC, RD and the expected EC/ED; the
// statement identity; the account check; the import through the one door, its idempotent re-import.
//
// SYNTHETIC DATA ONLY: fixtures/e2-mt940-two-days.sta (invented references, names, amounts; the account is
// the published PostFinance sample IBAN) and messages spelled in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseMt940, looksLikeMt940 } from '../../dist/core/banking/mt940.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { world, must, refused, MAIN_IBAN } from './bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STA = readFileSync(join(HERE, 'fixtures', 'e2-mt940-two-days.sta'), 'utf8');
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;

test('parse: two messages, their balances, identity and pages', () => {
  assert.equal(looksLikeMt940(STA), true);
  const { statements } = must(parseMt940(STA));
  assert.equal(statements.length, 2);
  const [a, b] = statements;
  assert.equal(a.messageType, 'mt940');
  assert.equal(a.statementId, 'mt940:41:2026-09-02');
  assert.equal(a.pageNumber, 1);
  assert.equal(a.lastPage, true);
  assert.equal(a.splitPage, false);
  assert.equal(a.iban, MAIN_IBAN);
  assert.equal(a.openingBalanceMinor, 100000);
  assert.equal(a.closingBalanceMinor, 78989);
  assert.equal(a.balanceCurrency, 'CHF');
  assert.equal(a.fromDate, '2026-09-02');
  assert.equal(a.toDate, '2026-09-02');
  assert.equal(a.transactionReference, 'E2MT-0902');
  assert.equal(b.statementId, 'mt940:42:2026-09-03');
  assert.equal(b.closingBalanceMinor, 149324);
});

test('parse: :61: subfields, marks and keys; the ZKB, SWIFT and plain :86:', () => {
  const [a, b] = must(parseMt940(STA)).statements;
  const [card, text, invoice] = a.entries;
  // 61-1 value date, 61-2 entry date, 61-3 D, 61-5 amount, 61-8 bank reference, 61-9 supplementary.
  assert.equal(card.valueDate, '2026-09-01');
  assert.equal(card.bookingDate, '2026-09-02');
  assert.equal(card.creditDebit, 'DBIT');
  assert.equal(card.amountMinor, 4988);
  assert.equal(card.entryKey, 'm9:E2FX-TX-001');
  assert.equal(card.entryRef, 'E2FX-TX-001');
  assert.equal(card.facts.additionalInfo, 'Kartenbezug Ausland');
  // ZKB ?ZKB: and ?ZI: (?0: original amount, ?3: ZKB rate, ?8: ZKB charges).
  assert.deepEqual(card.facts.bankCode, { domain: null, family: null, subFamily: null, proprietary: '2201', issuer: 'ZKB' });
  assert.equal(card.counterpartyName, 'Buchladen Seefeld Corp');
  assert.deepEqual(card.facts.instructed, { amountMinor: 6078, currency: 'USD' });
  assert.equal(card.facts.exchange.rate, '0.810464');
  assert.equal(card.facts.exchange.effectiveRate, '0.820665');
  assert.deepEqual(card.facts.fee, { amountMinor: 62, currency: 'CHF', included: true, origin: 'charges' });
  // No bank reference: the content key with its ordinal (D178 re-cut: never the statement or the page, which
  // are delivery identity only); the plain text read by the FX text fallback.
  assert.equal(text.entryKey, 'm9c:2026-09-02|2026-09-02|D|4023|CHF#0');
  assert.equal(text.facts.exchange.origin, 'text');
  assert.deepEqual(text.facts.fee, { amountMinor: 75, currency: 'CHF', included: true, origin: 'text' });
  // SWIFT /EREF/ and /REMI/; the type code as the proprietary code.
  assert.equal(invoice.endToEndId, 'E2FX-E2E-3');
  assert.equal(invoice.remittanceText, 'Rechnung 2026-118 Flyer');
  assert.deepEqual(invoice.facts.bankCode, { domain: null, family: null, subFamily: null, proprietary: 'NTRF', issuer: 'SWIFT' });
  assert.equal(invoice.amountMinor, 12000, '`120,` reads 120.00');
  // Day two: a credit with the payer's charges deducted, a reversal of a debit, an expected entry.
  const [credit, reversal] = b.entries;
  assert.equal(credit.creditDebit, 'CRDT');
  assert.equal(credit.payerName, 'HERR MAX BEISPIEL');
  assert.deepEqual(credit.facts.instructed, { amountMinor: 70035, currency: 'CHF' });
  assert.equal(credit.facts.exchange, null, 'same currency: no exchange');
  assert.deepEqual(credit.facts.fee, { amountMinor: 1200, currency: 'CHF', included: true, origin: 'charges' }, '700.35 - 12.00 = 688.35');
  assert.equal(reversal.creditDebit, 'CRDT', 'RD is a reversal of a debit: money in');
  assert.equal(reversal.reversalInd, true);
  assert.equal(reversal.amountMinor, 1500);
  assert.deepEqual(b.skipped, [{ entryRef: 'MT-REF-22', reason: 'pending' }], 'ED is an expected entry, never a booked fact');
});

test('parse: the German GVC structure (?00, ?20-?29 with EREF+/KREF+/SVWZ+, ?31, ?32/?33) and an RC reversal', () => {
  const msg = [
    ':20:E2DK-1',
    ':25:CH9300762011623852957',
    ':28C:7',
    ':60F:C261001CHF500,00',
    ':61:2610011001D80,50NDDTNONREF//DK-REF-1',
    ':86:105?00SEPA-BASIS-LASTSCHRIFT?20EREF+E2DK-E2E-1?21KREF+E2DK-RUN-9?22SVWZ+Mitglied',
    'erbeitrag Oktober?30ZZZZDEFFXXX?31DE89370400440532013000?32Turnverein Ahornb?33ach e.V.',
    ':61:2610011001RC10,00NMSCNONREF//DK-REF-2',
    ':86:Storno Gutschrift',
    ':62F:C261001CHF409,50',
  ].join('\n');
  const [s] = must(parseMt940(msg)).statements;
  const [dd, rc] = s.entries;
  assert.deepEqual(dd.facts.bankCode, { domain: null, family: null, subFamily: null, proprietary: '105', issuer: 'DK' });
  assert.equal(dd.endToEndId, 'E2DK-E2E-1');
  assert.equal(dd.txPmtInfId, 'E2DK-RUN-9', 'KREF+ is the run reference');
  assert.equal(dd.remittanceText, 'Mitgliederbeitrag Oktober', 'wrapped purpose lines join without a space');
  assert.equal(dd.counterpartyName, 'Turnverein Ahornbach e.V.');
  assert.equal(dd.counterpartyIban, 'DE89370400440532013000');
  assert.equal(rc.creditDebit, 'DBIT', 'RC is a reversal of a credit: money out');
  assert.equal(rc.reversalInd, true);
  assert.equal(s.pageNumber, 1);
  assert.equal(s.statementId, 'mt940:7:2026-10-01');
});

test('parse: refusals name what is missing; an unreadable :61: is skipped with its reason', () => {
  refused(parseMt940(''), 'schema_invalid');
  refused(parseMt940(':20:X\n:28C:1\n:60F:C261001CHF1,00\n:62F:C261001CHF1,00'), 'schema_invalid', 'no :25:');
  refused(parseMt940(':20:X\n:25:CH9300762011623852957\n:28C:1\n:62F:C261001CHF1,00'), 'schema_invalid', 'no :60F:');
  const bad = must(parseMt940(':20:X\n:25:CH9300762011623852957\n:28C:1\n:60F:C261001CHF1,00\n:61:261399D1,00NTRFNONREF\n:61:2610011001DX,00NTRFNONREF\n:62F:C261001CHF1,00'));
  assert.deepEqual(bad.statements[0].skipped.map((s) => s.reason), ['unreadable_date', 'unreadable_amount']);
  // An interim page (60M/62M) never surfaces its balance as the statement's (the D81 INTM rule).
  const page = must(parseMt940(':20:X\n:25:CH9300762011623852957\n:28C:12/2\n:60M:C261001CHF1,00\n:61:2610011001C1,00NTRFNONREF\n:62M:C261001CHF2,00')).statements[0];
  assert.equal(page.pageNumber, 2);
  assert.equal(page.lastPage, false);
  assert.equal(page.splitPage, true);
  assert.equal(page.openingBalanceMinor, null);
  assert.equal(page.closingBalanceMinor, null);
});

test('import: the MT940 door imports both days, skips the expected entry, and a re-import adds nothing', () => {
  const t = world();
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: STA, fileName: 'e2.sta', idempotencyKey: 'mt-1' }));
  assert.equal(res.format, 'mt940');
  assert.equal(res.imported, 5);
  assert.equal(res.duplicates, 0);
  assert.equal(res.refused, 1, 'the expected entry');
  assert.deepEqual(res.skipped.map((s) => [s.part, s.reason, s.message.length > 0]), [[2, 'pending', true]]);
  assert.deepEqual(res.statements.map((s) => [s.outcome, s.txnCount]), [['imported', 3], ['imported', 2]]);
  assert.equal(count(t, 'bank_txn_fact'), 5);
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND message_type = 'mt940'").get(t.workspaceId).n, 2);
  // The balance line reads the MT940 closing balance.
  const inbox = must(listBankInbox(t.ctx, { status: 'all' }));
  assert.equal(inbox.summary[0].bankBalanceMinor, 149324);
  // Replaying the key answers the first report; a fresh key finds both statements already in the books.
  assert.deepEqual(must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: STA, fileName: 'e2.sta', idempotencyKey: 'mt-1' })), res);
  const before = count(t, 'bank_txn');
  const again = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: STA, idempotencyKey: 'mt-2' }));
  assert.deepEqual(again.statements.map((s) => s.outcome), ['already_imported', 'already_imported']);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 5);
  assert.equal(count(t, 'bank_txn'), before, 're-import adds zero rows');
  // The same bytes as base64 are the same file.
  const b64 = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: Buffer.from(STA, 'utf8').toString('base64'), idempotencyKey: 'mt-3' }));
  assert.equal(b64.imported, 0);
  assert.equal(b64.encoding, 'utf-8');
});

test('critic H2 and R2-3 (D178 re-cut): statement and page are delivery identity, never in a line key; any delivery order imports the same three lines, none flagged; L2: a zero line is skipped', () => {
  // A paged statement 90 (2 pages) whose identical coffees carry no // reference and no entry date.
  const page = (n, last, lines) =>
    [`:20:H2-P${n}`, `:25:${MAIN_IBAN}`, `:28C:90/${n}`, `${n === 1 ? ':60F:' : ':60M:'}C261004CHF100,`, ...lines, `${last ? ':62F:' : ':62M:'}C261005CHF91,`, '-'].join('\n');
  const coffee = ':61:261002D4,50NMSCNONREF\n:86:Kaffeebar Seeblick';
  const p1 = page(1, false, [coffee, coffee]);
  const p2 = page(2, true, [coffee, ':61:261002D0,00NMSCNONREF\n:86:Saldo-Info']);
  const keys = (t) => t.store.db.prepare('SELECT entry_key FROM bank_txn WHERE workspace_id = ? ORDER BY entry_key').all(t.workspaceId).map((r) => r.entry_key);
  // A content key is only a storage label now: a label already taken gets `~dupN`, never a dropped line.
  const expected = ['m9c:2026-10-02||D|450|CHF#0', 'm9c:2026-10-02||D|450|CHF#0~dup1', 'm9c:2026-10-02||D|450|CHF#1'];
  const flags = (t) => count(t, 'bank_txn_possible_duplicate');

  // Page 2 BEFORE page 1 in one file: three coffees, the zero line skipped.
  const a = world();
  const res = must(importBankStatement(a.ctx, { bankAccountId: a.bankAccountId, content: `${p2}\n${p1}`, idempotencyKey: 'h2-a' }));
  assert.deepEqual(keys(a), expected);
  assert.deepEqual(res.statements.map((s) => [s.part, s.txnCount]), [[1, 1], [2, 2]], 'the answer keeps the file order');
  assert.deepEqual(res.skipped.map((s) => s.reason), ['zero_amount']);
  assert.equal(flags(a), 0, 'the pages of one statement never overlap each other');

  // The pages in two files, page 2 first: the same keys; both again add nothing.
  const b = world();
  must(importBankStatement(b.ctx, { bankAccountId: b.bankAccountId, content: p2, idempotencyKey: 'h2-b2' }));
  must(importBankStatement(b.ctx, { bankAccountId: b.bankAccountId, content: p1, idempotencyKey: 'h2-b1' }));
  assert.deepEqual(keys(b), expected);
  const again = must(importBankStatement(b.ctx, { bankAccountId: b.bankAccountId, content: `${p1}\n${p2}`, idempotencyKey: 'h2-b3' }));
  assert.equal(again.imported, 0, 'the same statement again: already imported, by its delivery identity');
  assert.equal(count(b, 'bank_txn'), 3);
  assert.equal(flags(b), 0);
});

test('import: an MT940 for another IBAN is refused per statement; an account number that is not the IBAN warns', () => {
  const t = world();
  const other = STA.replace(/:25:CH9300762011623852957/g, ':25:CH5604835012345678009');
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: other, idempotencyKey: 'other' }));
  assert.deepEqual(res.statements.map((s) => [s.outcome, s.code]), [['refused', 'account_mismatch'], ['refused', 'account_mismatch']]);
  assert.equal(count(t, 'bank_txn'), 0);
  const suffix = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: STA.replace(/:25:CH9300762011623852957/g, ':25:762011623852957'), idempotencyKey: 'suffix' }));
  assert.deepEqual(suffix.statements.map((s) => s.warnings), [[], []], "the IBAN's account part verifies the account");
  const t2 = world();
  const unknown = must(importBankStatement(t2.ctx, { bankAccountId: t2.bankAccountId, content: STA.replace(/:25:CH9300762011623852957/g, ':25:1100-1234.567'), idempotencyKey: 'unv' }));
  assert.deepEqual(unknown.statements.map((s) => s.warnings), [['account_unverified'], ['account_unverified']]);
});

test('critic M2: a file of several accounts imports only the statements of this Bankkonto, or nothing when none is recognisably it', () => {
  const msg = (ref, account, number, line) => [`:20:${ref}`, `:25:${account}`, `:28C:${number}/1`, ':60F:C261001CHF500,00', `:61:${line}`, ':86:Zahlung', ':62F:C261002CHF400,00', '-'].join('\n');
  const own = msg('M2-OWN', '0762011623852957', 5, '2610021002D100,00NTRFNONREF//M2-OWN-1');
  const other = msg('M2-OTHER', '1100-9876.543', 214, '2610021002D2500,00NTRFNONREF//M2-OTH-1');
  const third = msg('M2-THIRD', '1100-5555.111', 7, '2610021002D70,00NTRFNONREF//M2-THD-1');

  // One statement verifies (the IBAN's account part): the other account's statement is refused.
  const t = world();
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: `${own}\n${other}`, idempotencyKey: 'm2-a' }));
  assert.deepEqual(res.statements.map((s) => [s.part, s.outcome, s.code ?? null]), [[1, 'imported', null], [2, 'refused', 'account_mismatch']]);
  assert.match(res.statements[1].reason, /1100-9876\.543/);
  assert.equal(count(t, 'bank_txn'), 1);

  // Nothing verifies and two accounts are named: the whole file is refused, naming both.
  const t2 = world();
  const several = importBankStatement(t2.ctx, { bankAccountId: t2.bankAccountId, content: `${other}\n${third}`, idempotencyKey: 'm2-b' });
  assert.equal(several.ok, false);
  assert.equal(several.error, 'mt940_several_accounts');
  assert.deepEqual(several.accounts, ['1100-9876.543', '1100-5555.111']);
  assert.equal(count(t2, 'bank_txn'), 0);

  // One unverified account named throughout still imports, with the warning (unchanged).
  const one = must(importBankStatement(t2.ctx, { bankAccountId: t2.bankAccountId, content: other, idempotencyKey: 'm2-c' }));
  assert.deepEqual(one.statements.map((s) => s.warnings), [['account_unverified']]);
});
