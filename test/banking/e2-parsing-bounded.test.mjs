// D178 (A20 §11), bounded parsing against ReDoS: every statement parser of the new door finishes fast on a
// pathological input (long runs of newlines, spaces, slashes, digits), the security review's two shapes
// (MT940 detection on a file of newlines, a CSV amount cell of spaces) and every sibling shape in the new
// parsers. A regression here hangs the engine on one uploaded file, so each case asserts a wall-clock
// bound far above the linear cost and far below a quadratic one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeMt940, parseMt940 } from '../../dist/core/banking/mt940.js';
import { csvSignedAmount, csvDate, readCsvTable, detectCsvLayout } from '../../dist/core/banking/csvStatement.js';
import { guessCsvMapping, guessDecimalSeparator, guessDateFormat } from '../../dist/core/banking/csvMapping.js';
import { parseFxText, swissAmountToMinor, parseDecimal } from '../../dist/core/banking/statementFacts.js';
import { detectStatementFormat } from '../../dist/core/banking/statementImport.js';
import { parseCamt } from '../../dist/core/banking/index.js';

const MiB = 1024 * 1024;

/** Run `fn`, assert it took under `ms`, return its value. */
function fast(label, ms, fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const took = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(took < ms, `${label}: ${took.toFixed(0)} ms (bound ${ms} ms)`);
  return value;
}

test('MT940 detection: 10 MiB of newlines, of spaces, and of space-newline pairs answer at once', () => {
  assert.equal(fast('newlines', 1500, () => looksLikeMt940('\n'.repeat(10 * MiB))), false);
  assert.equal(fast('spaces', 1500, () => looksLikeMt940(' '.repeat(10 * MiB))), false);
  assert.equal(fast('pairs', 1500, () => looksLikeMt940(' \n'.repeat(5 * MiB))), false);
  assert.equal(fast('real one after a preamble', 200, () => looksLikeMt940(`${'\n'.repeat(50)}{1:F01X}{2:I940X}{4:\n:20:A\n:25:B\n`)), true);
  assert.equal(fast('format detection', 1500, () => detectStatementFormat('\n'.repeat(10 * MiB))), 'csv');
  assert.equal(fast('camt-ish head', 1500, () => detectStatementFormat(`<${'a'.repeat(5 * MiB)}`)), 'csv');
});

test('MT940 parse: long whitespace lines, a long slash run in /REMI/, an unclosed envelope, a long :25:', () => {
  const head = ':20:X\n:25:CH9300762011623852957\n:28C:1\n:60F:C261001CHF1,00\n';
  const tail = ':62F:C261001CHF2,00\n';
  fast('trailing spaces', 2000, () => parseMt940(`${head}:61:2610011001C1,00NTRFNONREF${' '.repeat(2 * MiB)}x\n${tail}`));
  const slashes = fast('slash run', 2000, () => parseMt940(`${head}:61:2610011001C1,00NTRFNONREF\n:86:/REMI/${'/'.repeat(2 * MiB)}x\n${tail}`));
  assert.equal(slashes.ok, true);
  fast('unclosed envelope', 2000, () => parseMt940(`{1:${'{'.repeat(MiB)}\n${head}${tail}`));
  fast('long :25:', 2000, () => parseMt940(`:20:X\n:25:${'C'.repeat(2 * MiB)}\n:28C:1\n:60F:C261001CHF1,00\n${tail}`));
  fast('zkb tag spaces', 2000, () => parseMt940(`${head}:61:2610011001C1,00NTRFNONREF\n:86:?ZKB:${' '.repeat(MiB)}\n${tail}`));
});

test('CSV cells: a long amount cell of spaces, a long date, a long IBAN, long headers', () => {
  assert.equal(fast('amount of spaces', 200, () => csvSignedAmount(`${' '.repeat(MiB)}x`)), null);
  assert.equal(fast('amount currency suffix', 200, () => csvSignedAmount(`1${' '.repeat(MiB)}CHF`)), null);
  assert.equal(fast('amount digits', 200, () => csvSignedAmount('9'.repeat(MiB))), null);
  assert.equal(csvSignedAmount('CHF 49.88'), 4988, 'a currency prefix is still read');
  assert.equal(csvSignedAmount('-49.88 CHF'), -4988, 'and a currency suffix');
  assert.equal(fast('date', 200, () => csvDate(`02.09.2026${' '.repeat(MiB)}x`, 'dd.mm.yyyy')), null);
  assert.equal(fast('swiss amount', 200, () => swissAmountToMinor('1'.repeat(MiB))), null);
  assert.equal(fast('decimal', 200, () => parseDecimal('1'.repeat(MiB))), null);
  const longHeader = `value${' '.repeat(MiB)}`;
  fast('guess on long headers', 1500, () => guessCsvMapping([longHeader, `original${' '.repeat(MiB)}`], []));
  fast('guess on long cells', 1500, () => guessDecimalSeparator([`${','.repeat(MiB)}1`, ` ${'1'.repeat(MiB)}`]));
  fast('guess date on long cells', 1500, () => guessDateFormat([`${'1'.repeat(MiB)}`]));
  // Linear work over a quarter MiB: well under the bound even on a loaded machine, and hours if quadratic.
  fast('layout on a long line', 2000, () => detectCsvLayout(`${'a;'.repeat(128 * 1024)}\n`));
  fast('table on spaces', 3000, () => readCsvTable({ text: `Datum;Betrag\n${' '.repeat(256 * 1024)};${' '.repeat(256 * 1024)}\n` }));
});

test('the FX text fallback: long runs after its keywords, long digit runs, long texts', () => {
  fast('keyword then spaces', 500, () => parseFxText([`Kommission${' '.repeat(MiB)}`], 'CHF'));
  fast('rate then spaces', 500, () => parseFxText([`Kurs${' '.repeat(MiB)}x abgerechnet in CHF`], 'CHF'));
  fast('settled then spaces', 500, () => parseFxText([`abgerechnet${' '.repeat(MiB)}`], 'CHF'));
  fast('currency then digits', 500, () => parseFxText([`Kurs 1 USD ${'9'.repeat(MiB)},5x`], 'CHF'));
  fast('many pairs', 1500, () => parseFxText([`Kurs 1 ${'USD 1 '.repeat(200_000)}`], 'CHF'));
  // The real shape is still read.
  assert.deepEqual(parseFxText(['Händler X, USD 60.78, abgerechnet in CHF, Kurs 0.810464, Kommission CHF 0.62'], 'CHF').instructed, { amountMinor: 6078, currency: 'USD' });
});

test('camt: an entry whose NtryDtls never closes is cut at one scan', () => {
  const xml = `<Document><BkToCstmrStmt><Stmt><Id>S</Id><Ntry><Amt Ccy="CHF">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><NtryDtls>${'<TxDtls>'.repeat(50_000)}</Ntry></Stmt></BkToCstmrStmt></Document>`;
  fast('unclosed NtryDtls', 3000, () => parseCamt(xml));
});
