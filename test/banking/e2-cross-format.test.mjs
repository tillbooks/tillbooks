// D178 point 19 (owner, 21.10.2026; spec A20 §11.4): POSSIBLE DUPLICATES ACROSS STATEMENT FORMATS ARE THE
// PERSON'S DECISION. "keep cross-format and have a mechanism where you flag possible duplicates to be
// approved by the user. same amount, date, vendor/buyer, etc." Only the same format's exact key drops a line
// on import; under `bank.cross_format_duplicates` = `ask` (the default) every line another format may already
// have brought in is imported FLAGGED with every candidate, and `auto_strong` drops only the bank's own
// reference on the same booking date. A flagged line is never "sicher", never in the bulk path, and
// `book_bank_line` refuses it until `resolve_possible_duplicate` answers duplicate (ignored, reversible by
// reopen) or distinct (a normal line).
//
// Pinned: every order of the three formats keeps every movement and flags every extra line; the two
// settings; twin card payments; a counterparty that contradicts keeps two payments apart; the answer, the
// facet, the bulk path and the direct verb; the D81 escape; a camt-only account decides exactly as before.
//
// SYNTHETIC DATA ONLY: the e2 fixtures (invented) and statements spelled in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importCamt, listBankInbox } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { bankInboxAttention } from '../../dist/core/banking/bankInbox.js';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { world, must, camt, TELCO_IBAN, SAVINGS_IBAN } from './bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = {
  camt: readFileSync(join(HERE, 'fixtures', 'e2-camt053-card-fx.xml'), 'utf8'),
  mt940: readFileSync(join(HERE, 'fixtures', 'e2-mt940-two-days.sta'), 'utf8'),
  csv: readFileSync(join(HERE, 'fixtures', 'e2-csv-export.csv'), 'utf8'),
};
const CSV_MAPPING = {
  columns: { bookingDate: 'Buchungsdatum', valueDate: 'Valuta', text: 'Buchungstext', debit: 'Belastung', credit: 'Gutschrift' },
  dateFormat: 'dd.mm.yyyy',
  decimalSeparator: '.',
};
const SIMPLE_CSV = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag', counterpartyIban: 'IBAN' }, dateFormat: 'dd.mm.yyyy' };

let n = 0;
const key = () => `k${(n += 1)}`;

function importFile(t, format, content = FILES[format]) {
  if (format === 'camt') return must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, idempotencyKey: key() }), 'camt');
  if (format === 'mt940') return must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, idempotencyKey: key() }), 'mt940');
  return must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, mapping: format === 'csv' ? CSV_MAPPING : SIMPLE_CSV, idempotencyKey: key() }), 'csv');
}

function lines(t) {
  return t.store.db
    .prepare(
      `SELECT t.id, t.amount_minor AS a, t.credit_debit AS cd, COALESCE(t.booking_date, t.value_date) AS d, s.message_type AS f,
              p.existing_bank_txn_id AS dupOf, p.reason AS why
         FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id
         LEFT JOIN bank_txn_possible_duplicate p ON p.bank_txn_id = t.id
        WHERE t.workspace_id = ? ORDER BY d, t.amount_minor`,
    )
    .all(t.workspaceId);
}

/** The lines nobody flagged: the movements as the person keeps them once every flag is answered Duplikat. */
const unflagged = (rows) => rows.filter((r) => r.dupOf === null);
const family = (f) => (f.startsWith('camt') ? 'camt' : f);

/** The helper's camt with each entry's NtryRef also written as its AcctSvcrRef (the bank's own reference). */
const withAsr = (xml) => xml.replace(/<NtryRef>([^<]+)<\/NtryRef>([\s\S]*?<\/ValDt>)/g, '<NtryRef>$1</NtryRef>$2<AcctSvcrRef>$1</AcctSvcrRef>');

const signedSum = (rows) => rows.reduce((s, r) => s + (r.cd === 'CRDT' ? r.a : -r.a), 0);
const autoStrong = (t) => must(settingsSet(t.ctx, { key: 'bank.cross_format_duplicates', value: 'auto_strong', reason: 'test', idempotencyKey: key() }), 'setting');

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

for (const mode of ['ask', 'auto_strong']) {
  for (const order of permutations(['camt', 'mt940', 'csv'])) {
    test(`${mode}: every order keeps every movement and flags every extra line: ${order.join(' -> ')}`, () => {
      const t = world();
      if (mode === 'auto_strong') autoStrong(t);
      const reports = order.map((f) => importFile(t, f));
      const rows = lines(t);
      // camt carries 02.09 only; MT940 and CSV carry 02.09 and 03.09: five movements in all.
      const kept = unflagged(rows);
      assert.equal(kept.length, 5, `five movements nobody flagged, got ${JSON.stringify(rows)}`);
      assert.equal(signedSum(kept), 68835 + 1500 - 4988 - 4023 - 12000, 'the unflagged lines are each movement once, to the Rappen');
      for (const r of rows.filter((x) => x.dupOf !== null)) {
        const other = rows.find((x) => x.id === r.dupOf);
        assert.ok(other !== undefined && other.a === r.a && other.cd === r.cd && family(other.f) !== family(r.f), `a flag names the same money in another format: ${JSON.stringify(r)}`);
      }
      const absorbed = reports.flatMap((r) => r.skipped.filter((s) => s.reason === 'cross_format_duplicate'));
      for (const rep of reports) {
        assert.deepEqual(
          rep.skipped.filter((s) => s.reason !== 'cross_format_duplicate' && s.reason !== 'not_a_movement' && s.reason !== 'pending').map((s) => s.reason),
          [],
          'nothing else skipped',
        );
      }
      // ask: nothing dropped across formats. auto_strong: only the card payment whose camt AcctSvcrRef IS the
      // MT940 // reference (E2FX-TX-001); the printer's lines share only an EndToEndId, the payer's, no proof.
      assert.equal(absorbed.length, mode === 'ask' ? 0 : 1, JSON.stringify(absorbed));
      // Re-importing everything again changes nothing.
      for (const f of order) importFile(t, f);
      assert.equal(lines(t).length, rows.length);
    });
  }
}

test('ask flags even the bank reference on the same day; auto_strong drops exactly that and asks a day apart', () => {
  const camtXml = withAsr(camt({ statementId: 'S-REF', from: '2026-10-05', to: '2026-10-05', entries: [
    { ref: 'ASR-77', amountMinor: 3300, cd: 'DBIT', date: '2026-10-05' },
    { ref: 'ASR-78', amountMinor: 4400, cd: 'DBIT', date: '2026-10-05' },
  ] }));
  const mt = [
    ':20:R', ':25:CH9300762011623852957', ':28C:9', ':60F:C261005CHF100,',
    ':61:2610051005D33,NMSCNONREF//ASR-77', ':86:Gebühr',
    ':61:2610061006D44,NMSCNONREF//ASR-78', ':86:Gebühr',
    ':62F:C261006CHF23,',
  ].join('\n');
  const a = world();
  must(importCamt(a.ctx, { bankAccountId: a.bankAccountId, xml: camtXml, idempotencyKey: key() }));
  const asked = importFile(a, 'mt940', mt);
  assert.equal(asked.imported, 2);
  assert.deepEqual(asked.statements[0].nearDuplicates.map((d) => d.reason), ['shared_reference', 'shared_reference']);
  const b = world();
  autoStrong(b);
  must(importCamt(b.ctx, { bankAccountId: b.bankAccountId, xml: camtXml, idempotencyKey: key() }));
  const strong = importFile(b, 'mt940', mt);
  assert.deepEqual(strong.skipped.map((s) => s.reason), ['cross_format_duplicate'], 'the same booking date is proof');
  assert.equal(strong.imported, 1, 'a day apart is asked');
  assert.equal(strong.statements[0].nearDuplicates[0].reason, 'shared_reference');
});

test('auto_strong: a camt NtryRef that equals an MT940 // reference is not the bank reference: asked, not dropped', () => {
  const t = world();
  autoStrong(t);
  must(importCamt(t.ctx, {
    bankAccountId: t.bankAccountId,
    xml: camt({ statementId: 'S-NR', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'NR-5', amountMinor: 3300, cd: 'DBIT', date: '2026-10-05' }] }),
    idempotencyKey: key(),
  }));
  const mt = [':20:NR', ':25:CH9300762011623852957', ':28C:12', ':60F:C261005CHF100,', ':61:2610051005D33,NMSCNONREF//NR-5', ':86:Gebühr', ':62F:C261005CHF67,'].join('\n');
  const res = importFile(t, 'mt940', mt);
  assert.equal(res.imported, 1, 'not dropped: a NtryRef is the account owner\'s word, not the bank\'s reference');
  // D178 re-cut: the MT940 lies inside the day the camt covers, so coverage matches it one to one first
  // (same_movement), and the camt line is its candidate.
  const [near] = res.statements[0].nearDuplicates;
  assert.equal(near.reason, 'same_movement');
  assert.equal(near.candidates.length, 1);
});

test('twin card payments: every new coffee names every candidate (nothing used up); auto_strong drops each by its own reference; a third is asked, never dropped', () => {
  const twins = (statementId, refs) =>
    withAsr(camt({ statementId, from: '2026-10-05', to: '2026-10-05', entries: refs.map((ref) => ({ ref, amountMinor: 450, cd: 'DBIT', date: '2026-10-05', ustrd: 'Kaffeebar Lindenplatz' })) }));
  const csv = (k) => `Datum;Text;Betrag;IBAN\n${Array.from({ length: k }, () => '05.10.2026;Kaffeebar Lindenplatz;-4.50;').join('\n')}\n`;
  const mt = (refs) =>
    [':20:T', ':25:CH9300762011623852957', ':28C:5', ':60F:C261004CHF100,', ...refs.map((r) => `:61:2610051005D4,50NMSCNONREF//${r}\n:86:Kaffeebar Lindenplatz`), ':62F:C261005CHF91,'].join('\n');

  // auto_strong, camt first.
  const a = world();
  autoStrong(a);
  must(importCamt(a.ctx, { bankAccountId: a.bankAccountId, xml: twins('S-TW', ['TW-1', 'TW-2']), idempotencyKey: key() }));
  const viaMt = importFile(a, 'mt940', mt(['TW-1', 'TW-2', 'TW-3']));
  assert.equal(viaMt.imported, 1, 'TW-1 and TW-2 are the camt lines by their bank references; TW-3 is imported');
  assert.equal(viaMt.statements[0].nearDuplicates.length, 1, 'TW-3 is asked: two coffees that day are candidates');
  const viaCsv = importFile(a, 'simple', csv(2));
  assert.equal(viaCsv.imported, 2, 'a CSV is never dropped across formats');
  for (const d of viaCsv.statements[0].nearDuplicates) assert.equal(d.candidates.length, 3, 'each CSV coffee names all three stored coffees');

  // ask, CSV first, then camt: everything imported and flagged, nothing used up.
  const b = world();
  assert.equal(importFile(b, 'simple', csv(2)).imported, 2, 'two identical rows are two movements');
  const second = must(importCamt(b.ctx, { bankAccountId: b.bankAccountId, xml: twins('S-TW', ['TW-1', 'TW-2']), idempotencyKey: key() }));
  assert.equal(second.txnCount, 2, 'imported and flagged, never dropped');
  assert.deepEqual(second.nearDuplicates.map((d) => d.candidates.length), [2, 2]);
  const third = must(importCamt(b.ctx, { bankAccountId: b.bankAccountId, xml: twins('S-TW3', ['TW-1', 'TW-2', 'TW-3']), idempotencyKey: key() }));
  assert.equal(third.txnCount, 1, 'TW-1 and TW-2 are exact repeats; TW-3 is new');
  assert.equal(third.nearDuplicates.length, 1, 'and asked: the CSV coffees are candidates again (naming uses nothing up)');
  assert.equal(unflagged(lines(b)).length, 2);
});

test('outside the covered span, a counterparty that contradicts (another IBAN, another name) is two payments: nothing flags them; an EndToEndId is no counterparty; inside it, the movement key alone decides', () => {
  const t = world();
  const stmt = must(importCamt(t.ctx, {
    bankAccountId: t.bankAccountId,
    xml: camt({ statementId: 'S-V', from: '2026-10-06', to: '2026-10-06', entries: [
      { ref: 'V-1', amountMinor: 1000, cd: 'DBIT', date: '2026-10-06', iban: TELCO_IBAN },
      { ref: 'V-2', amountMinor: 2000, cd: 'DBIT', date: '2026-10-06', e2e: 'E2E-AAA' },
      { ref: 'V-3', amountMinor: 3000, cd: 'DBIT', date: '2026-10-06', name: 'Papeterie Lindenhof AG' },
    ] }),
    idempotencyKey: key(),
  }));
  assert.equal(stmt.txnCount, 3);
  // D178 re-cut: the camt covers 06.10. only; these rows are a day later, outside the covered span, where
  // point 19 alone decides (same money, a date within three days, a counterparty that does not contradict).
  const res = importFile(t, 'simple', `Datum;Text;Betrag;IBAN\n07.10.2026;Abo Sparkonto;-10.00;${SAVINGS_IBAN}\n`);
  assert.equal(res.imported, 1, 'another IBAN is another payment');
  assert.deepEqual(res.statements[0].warnings, [], 'and nothing flags it');
  const named = must(importBankStatement(t.ctx, {
    bankAccountId: t.bankAccountId,
    content: 'Datum;Text;Betrag;Gegenpartei\n07.10.2026;Rechnung;-30.00;Druckerei Seeblick GmbH\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag', counterparty: 'Gegenpartei' }, dateFormat: 'dd.mm.yyyy' },
    idempotencyKey: key(),
  }));
  assert.deepEqual(named.statements[0].warnings, [], 'another name is another payment');
  // The EndToEndId is the payer's word, not a counterparty: the same money the same day is asked.
  const mt = [':20:V', ':25:CH9300762011623852957', ':28C:6', ':60F:C261006CHF100,', ':61:2610071007D20,NTRFNONREF//MT-V2', ':86:/EREF/E2E-BBB//REMI/Rechnung/', ':62F:C261007CHF80,'].join('\n');
  const mtRes = importFile(t, 'mt940', mt);
  assert.equal(mtRes.imported, 1);
  assert.deepEqual(mtRes.statements[0].warnings, ['possible_cross_format_duplicate']);
  // Inside the covered day the movement key has no counterparty in it (the recut review): the same money on
  // 06.10. is matched one to one, whatever IBAN the CSV names, and the person answers.
  const inside = importFile(t, 'simple', `Datum;Text;Betrag;IBAN\n06.10.2026;Abo Sparkonto;-10.00;${SAVINGS_IBAN}\n`);
  assert.equal(inside.imported, 1);
  assert.equal(inside.statements[0].nearDuplicates[0].reason, 'same_movement');
  assert.ok(inside.statements[0].warnings.includes('overlap_same_movement'));
});

test('the person decides: a flagged line is never sure, the bulk count and the direct verb refuse it, the facet lists it, and the answer is recorded and reversible', () => {
  const t = world();
  // A telecom bill: camt first, with a Buchungsregel so its lines are proposed "sure".
  const camtXml = (id, ref) => withAsr(camt({ statementId: id, from: '2026-10-06', to: '2026-10-06', entries: [{ ref, amountMinor: 7700, cd: 'DBIT', date: '2026-10-06', iban: TELCO_IBAN, name: 'Telekom Beispiel AG' }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtXml('S-N', 'N-1'), idempotencyKey: key() }));
  const camtLine = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).id;
  must(setBankStandard(t.ctx, { bankTxnId: camtLine, accountId: t.acc('6500'), taxCode: null, idempotencyKey: key() }), 'rule');
  const res = importFile(t, 'simple', `Datum;Text;Betrag;IBAN\n07.10.2026;Telekom Rechnung;-77.00;${TELCO_IBAN}\n`);
  assert.equal(res.imported, 1);
  assert.deepEqual(res.statements[0].warnings, ['possible_cross_format_duplicate']);
  const [near] = res.statements[0].nearDuplicates;
  assert.equal(near.reason, 'near_date');
  const line = () => must(listBankInbox(t.ctx, { bankTxnId: near.bankTxnId, status: 'all' })).lines[0];
  // The read model: every candidate, the decision state, the facet and its count.
  assert.equal(line().needsDuplicateDecision, true);
  assert.deepEqual(line().possibleDuplicates.map((c) => [c.bankTxnId, c.reason, c.format, c.date, c.amountMinor, c.currency]), [[near.existingBankTxnId, 'near_date', 'camt', '2026-10-06', -7700, 'CHF']]);
  assert.equal(line().possibleDuplicateOf.bankTxnId, near.existingBankTxnId);
  const original = must(listBankInbox(t.ctx, { bankTxnId: near.existingBankTxnId, status: 'all' })).lines[0];
  assert.equal(original.needsDuplicateDecision, false, 'the line imported first is not flagged');
  assert.deepEqual(original.possibleDuplicates, []);
  const facet = must(listBankInbox(t.ctx, { facet: 'duplicates' }));
  assert.deepEqual([facet.total, facet.lines.map((l) => l.bankTxnId)], [1, [near.bankTxnId]], 'the count the attention surfaces read');
  assert.equal(listBankInbox(t.ctx, { facet: 'other' }).error, 'invalid_input');
  // Never sure, so never in "Alle sicheren buchen" (the bulk path books only `sure`), and the band counts it as needing the person.
  assert.notEqual(line().attention, 'sure');
  assert.notEqual(line().proposal.certainty, 'sure');
  assert.equal(bankInboxAttention(t.ctx).total.sure, 1, 'only the camt line is sure');
  // The direct verb refuses it, naming the way out (an agent's draft: statement-import-dial.test.mjs).
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 7700 }] };
  const direct = bookBankLine(t.ctx, { bankTxnId: near.bankTxnId, target, idempotencyKey: key() });
  assert.equal(direct.error, 'duplicate_decision_pending');
  assert.match(direct.reason, /camt line of 2026-10-06/);
  // "Duplikat": the line is ignored with that reason; reopened, it needs a decision again.
  const dup = must(resolvePossibleDuplicate(t.ctx, { bankTxnId: near.bankTxnId, decision: 'duplicate', otherBankTxnId: near.existingBankTxnId, idempotencyKey: key() }));
  assert.equal(dup.state, 'ignored');
  assert.equal(line().state, 'ignored');
  assert.equal(line().decision.ignoreReason, 'duplicate');
  assert.equal(line().duplicateDecision.decision, 'duplicate');
  assert.equal(must(listBankInbox(t.ctx, { facet: 'duplicates' })).total, 0);
  must(reopenBankLine(t.ctx, { bankTxnId: near.bankTxnId, reason: 'doch prüfen', idempotencyKey: key() }));
  assert.equal(line().needsDuplicateDecision, true, 'reopened: decide again');
  // "Kein Duplikat": a normal line again, proposed and bookable; the answer is kept with who and when.
  const distinct = must(resolvePossibleDuplicate(t.ctx, { bankTxnId: near.bankTxnId, decision: 'distinct', idempotencyKey: key() }));
  assert.equal(distinct.state, 'open');
  assert.equal(line().needsDuplicateDecision, false);
  assert.equal(line().duplicateDecision.decision, 'distinct');
  must(bookBankLine(t.ctx, { bankTxnId: near.bankTxnId, target, idempotencyKey: key() }), 'booked once decided');
  // Recorded, append-only, and a re-import of the same file touches nothing.
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_duplicate_decision WHERE workspace_id = ?').get(t.workspaceId).n, 2);
  importFile(t, 'simple', `Datum;Text;Betrag;IBAN\n07.10.2026;Telekom Rechnung;-77.00;${TELCO_IBAN}\n`);
  assert.equal(line().duplicateDecision.decision, 'distinct');
  // Refusals: a line nothing names, an unknown candidate, a decided (booked) line.
  assert.equal(resolvePossibleDuplicate(t.ctx, { bankTxnId: near.existingBankTxnId, decision: 'distinct', idempotencyKey: key() }).error, 'not_flagged');
  assert.equal(resolvePossibleDuplicate(t.ctx, { bankTxnId: near.bankTxnId, decision: 'maybe', idempotencyKey: key() }).error, 'invalid_input');
  assert.equal(resolvePossibleDuplicate(t.ctx, { bankTxnId: near.bankTxnId, decision: 'duplicate', idempotencyKey: key() }).error, 'line_not_open');
});

test('the D81 escape admits a dropped cross-format line as a genuine second movement (auto_strong)', () => {
  const t = world();
  autoStrong(t);
  importFile(t, 'camt');
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: FILES.mt940, allowDuplicateEntries: true, idempotencyKey: key() }));
  assert.equal(res.imported, 5, 'admitted on request');
  assert.equal(lines(t).length, 8);
});

test('a camt-only account: the next statement of the chain is new, nothing flagged; the same money in an unchained statement over the same day is asked', () => {
  const t = world();
  const day = (statementId, seqNb, openingMinor, ref) =>
    withAsr(camt({ statementId, seqNb, openingMinor, from: '2026-10-08', to: '2026-10-08', entries: [{ ref, amountMinor: 999, cd: 'DBIT', date: '2026-10-08' }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: day('C-1', '1', 0, 'C-A'), idempotencyKey: key() }));
  // The intraday second statement: the next sequence number the same day, opening where C-1 closed.
  const second = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: day('C-2', '2', -999, 'C-B'), idempotencyKey: key() }));
  assert.equal(second.txnCount, 1);
  assert.deepEqual(second.warnings, [], 'an extension: its lines are new, nothing flagged');
  assert.equal(unflagged(lines(t)).length, 2);
  // The same money, another AcctSvcrRef, in a statement that does not continue the chain: an overlap, asked.
  const third = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: day('C-X', '7', 0, 'C-C'), idempotencyKey: key() }));
  assert.equal(third.txnCount, 1, 'imported, never dropped');
  assert.equal(third.nearDuplicates[0].reason, 'same_movement');
  assert.deepEqual(third.warnings, ['overlap_same_movement'], 'no cross-format warning between two camt files');
});
