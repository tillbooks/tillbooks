// CRITIC PROBES, D178 node E2 round 1 (non-author): the statement door beyond the dedupe keys: the
// account check of a multi-account MT940, the near-duplicate warning reaching the person, the CSV layout
// detection, the FX text fallback, and the time a file inside the size limit may take.
//
// Each probe asserts the CORRECT outcome; a failing probe is the evidence of a defect (see
// docs/critique/bank-parity-e2-critic-r1.md).
//
// SYNTHETIC BY CONSTRUCTION: every statement, name, account number, reference and amount below is
// invented in this file; the account IBAN is the published PostFinance sample the A39 suites already use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importCamt } from '../../dist/core/banking/index.js';
import { importBankStatement, bankCsvPreview } from '../../dist/core/banking/statementImport.js';
import { deriveFacts, emptyFacts } from '../../dist/core/banking/statementFacts.js';
import { world, must, camt, MAIN_IBAN } from '../banking/bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

let n = 0;
const key = () => `e2d-${(n += 1)}`;

const lineCount = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;

// --- E2-D1: a multi-account MT940 file lands every account on the chosen Bankkonto ------------------

test('E2-D1: an MT940 file with two accounts imports only the statement of this Bankkonto', () => {
  const t = world();
  // A Datalink-style file: two messages appended, `:25:` written as the bank's account number (the ZKB
  // shape `1100-1234.567`, per A20 §11.2), not as an IBAN. The first is this Bankkonto's (its digits are
  // the IBAN's account part), the second is ANOTHER account of the same customer, numbered on its own.
  const msg = (ref, account, number, line) => [`:20:${ref}`, `:25:${account}`, `:28C:${number}/1`, ':60F:C261001CHF500,00', `:61:${line}`, ':86:Zahlung', ':62F:C261002CHF400,00', '-'].join('\n');
  const file = `${msg('E2D-OWN', '0762011623852957', 5, '2610021002D100,00NTRFNONREF//E2D-OWN-1')}\n${msg('E2D-OTHER', '1100-9876.543', 214, '2610021002D2500,00NTRFNONREF//E2D-OTH-1')}`;
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, idempotencyKey: key() }));
  const other = res.statements.find((s) => s.part === 2);
  assert.equal(lineCount(t), 1, `only this Bankkonto's line, got ${lineCount(t)}; part 2 answered ${JSON.stringify(other)}`);
});

// --- E2-D2: the near-duplicate warning never reaches the person on the Studio's camt path -------------

test('E2-D2: a camt imported in the Studio after a CSV warns possible_cross_format_duplicate in the toast', () => {
  const t = world();
  // A CSV whose only date is the purchase day, then the day-end camt booking the same coffee a day later.
  must(
    importBankStatement(t.ctx, {
      bankAccountId: t.bankAccountId,
      content: 'Datum;Text;Betrag\n02.10.2026;Kaffeebar Seeblick;-4.50\n',
      mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' },
      idempotencyKey: key(),
    }),
  );
  // The Studio's ImportDialog sends a camt file through `import_camt` (not import_bank_statement) and
  // hands the answer to Bank.tsx `onImported`, which words only the warnings in its KNOWN_WARNINGS.
  const res = must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'E2D-CAMT', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'E2D-1', amountMinor: 450, cd: 'DBIT', date: '2026-10-05', valueDate: '2026-10-02', ustrd: 'Kaffeebar Seeblick' }] }),
      idempotencyKey: key(),
    }),
  );
  assert.ok(res.warnings.includes('possible_cross_format_duplicate'), `the engine warns: ${JSON.stringify(res.warnings)}`);
  const bank = readFileSync(join(ROOT, 'app', 'src', 'surfaces', 'Bank', 'Bank.tsx'), 'utf8');
  const known = /const KNOWN_WARNINGS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(bank);
  assert.ok(known !== null, 'Bank.tsx declares the warnings its import toast words');
  assert.ok(
    known[1].includes("'possible_cross_format_duplicate'"),
    `Bank.tsx onImported drops the warning, so the toast says "imported" in the success tone: ${known[1]}`,
  );
});

// --- E2-D3: the CSV layout detection picks the wrong separator, and nothing in the Studio corrects it ---

test('E2-D3: a Swiss semicolon CSV with commas in the booking text is read as semicolon-separated', () => {
  const t = world();
  const csv = [
    'Buchungsdatum;Valuta;Buchungstext;Betrag;Saldo',
    '02.10.2026;02.10.2026;Debitkarte Zahlung, Kaffeebar Seeblick, 8008 Zürich, Karte XXXX 1234;-12,30;987,70',
    '03.10.2026;03.10.2026;Gutschrift Kundin Ammann;100,00;1087,70',
  ].join('\n');
  const preview = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csv }));
  assert.equal(preview.delimiter, 'semicolon', `detected ${preview.delimiter}, headers ${JSON.stringify(preview.headers)}`);
  assert.deepEqual(preview.headers, ['Buchungsdatum', 'Valuta', 'Buchungstext', 'Betrag', 'Saldo']);
});

test('E2-D3b: a preamble padded to the column count (an Excel save) does not become the header row', () => {
  const t = world();
  const csv = ['Kontoauszug;;;', 'Konto;Geschäftskonto Beispiel;;', ';;;', 'Buchungsdatum;Buchungstext;Betrag;Saldo', '02.10.2026;Kaffeebar Seeblick;-4.50;995.50'].join('\n');
  const preview = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csv }));
  assert.deepEqual(preview.headers, ['Buchungsdatum', 'Buchungstext', 'Betrag', 'Saldo'], `header row ${preview.headerRow}: ${JSON.stringify(preview.headers)}`);
});

test('E2-D3c: the Studio mapping step can correct the separator and the header row the detection chose', () => {
  const dialog = readFileSync(join(ROOT, 'app', 'src', 'surfaces', 'Bank', 'ImportDialog.tsx'), 'utf8');
  // The engine takes `mapping.delimiter` and `mapping.headerRow`; a person needs a control for each when
  // the detection is wrong, or the file can never be imported from the Studio.
  assert.ok(/setMapping\(\{[^}]*delimiter/.test(dialog), 'a control that sets mapping.delimiter');
  assert.ok(/setMapping\(\{[^}]*headerRow/.test(dialog), 'a control that sets mapping.headerRow');
});

// --- E2-D4: the FX text fallback reads a course and a postcode as an exchange -------------------------

test('E2-D4: no FX is read from an ordinary text that says "Kurs 12" or "Rate 3" next to a place or a contract code', () => {
  for (const text of ['Yoga Kurs 12 Lektionen, Studio Lindenhof ZUG 6300', 'Leasing Rate 3 von 36, Vertrag LSG 445566']) {
    const facts = emptyFacts('csv');
    facts.bankText = text;
    const derived = deriveFacts(facts, { amountMinor: 24000, currency: 'CHF', creditDebit: 'DBIT' });
    assert.equal(derived.instructed, null, `${text}: instructed ${JSON.stringify(derived.instructed)}`);
    assert.equal(derived.exchange, null, `${text}: exchange ${JSON.stringify(derived.exchange)}`);
  }
});

// --- E2-D5: the cross-format rule is quadratic, inside the 10 MB limit --------------------------------

/**
 * The critic's scenario at size N: N stored CSV lines, then an MT940 of N lines; the MT940 import's
 * milliseconds. ROUND 3: the MT940 lines are the SAME money as the CSV lines (debits of equal amounts on
 * the same days), so every line meets its look-alike and is flagged: the dedupe rule's heaviest case, and
 * the one round 1's `stored.find` per line made quadratic.
 */
function crossFormatImportMs(N) {
  const t = world();
  const day = (i) => String(1 + (i % 10)).padStart(2, '0');
  const amount = (i) => (1 + i / 100).toFixed(2);
  const csv = ['Datum;Text;Betrag'];
  for (let i = 0; i < N; i += 1) csv.push(`2026-10-${day(i)};Zeile ${i};-${amount(i)}`);
  must(
    importBankStatement(t.ctx, {
      bankAccountId: t.bankAccountId,
      content: csv.join('\n'),
      mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', decimalSeparator: '.' },
      idempotencyKey: key(),
    }),
  );
  const ls = [];
  for (let i = 0; i < N; i += 1) ls.push(`:61:2610${day(i)}10${day(i)}D${amount(i).replace('.', ',')}NMSCNONREF//E2D-R${i}\n:86:Belastung ${i}`);
  const sta = [':20:E2D-PERF', `:25:${MAIN_IBAN}`, ':28C:1/1', ':60F:C260930CHF0,00', ...ls, ':62F:C261010CHF0,00', '-'].join('\n');
  const t0 = Date.now();
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: sta, idempotencyKey: key() }));
  const ms = Date.now() - t0;
  assert.equal(res.statements[0].nearDuplicates?.length, N, 'every line met its look-alike');
  t.store.close();
  return ms;
}

test('E2-D5: an MT940 of 16 000 lines against 16 000 stored CSV lines imports in bounded time', () => {
  // ROUND 3 (author, critic R2-7): a direct linearity check. The import is timed at four sizes (the best of
  // two runs each, so a busy moment on a shared box does not count) and the cost PER LINE must stay flat:
  // the largest size may cost at most 2.5 times per line what the cheaper of the two smallest did. Round
  // 1's quadratic grew per line with the file (about 8x from 2k to 16k in this scenario, where every new
  // line scanned every stored one), so it fails this by far; a linear import stays near 1x.
  const sizes = [2000, 4000, 8000, 16000];
  const perLine = sizes.map((n) => Math.min(crossFormatImportMs(n), crossFormatImportMs(n)) / n);
  const base = Math.max(Math.min(perLine[0], perLine[1]), 0.001);
  const growth = perLine.map((p) => p / base);
  const detail = sizes.map((n, i) => `${n}: ${(perLine[i] * 1000).toFixed(1)} us/line`).join(', ');
  assert.ok(Math.max(...growth) < 2.5, `per-line cost is not flat: ${detail}`);
  // And a catastrophe bound in wall-clock terms, generous for a shared box: 16k lines in under two minutes.
  assert.ok(perLine[3] * 16000 < 120_000, `16k took ${(perLine[3] * 16000).toFixed(0)} ms`);
});
