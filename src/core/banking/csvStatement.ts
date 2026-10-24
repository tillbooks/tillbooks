/**
 * D178 point 4 (spec A20 §11.3): a bank CSV export, read through a column mapping into the SAME parsed
 * statement shape camt has (`messageType: 'csv'`). Pure: no store, no clock.
 *
 * THE READER IS G09's, UNCHANGED. `parseGenericCsv` (`migration/adapters/parse.ts`) is the repo's one
 * delimited reader: RFC 4180 quoting, `;` `,` and tab, header-keyed rows. This module only does what a
 * bank export needs BEFORE that reader: it detects the encoding (a UTF-8 BOM; strict UTF-8; else
 * Windows-1252, the legacy single-byte export many Swiss e-banking CSVs still are), finds the separator
 * and the header row below a preamble (`detectCsvLayout`), and hands the reader UTF-8 bytes from the
 * header row on, with the separator named.
 *
 * AMOUNTS ARE EXACT. `1'234.50`, `1’234.50`, `1 234,50`, `1234,50`, `-12.30`, `12.30-`, `(12.30)`
 * read into integer hundredths (`swissAmountToMinor`); more than two decimals is unreadable, never
 * rounded. One signed amount column, or separate debit and credit columns.
 *
 * THE IDENTITY KEY (A20 §11.4): `csv:<booking date>|<direction>|<amount>|<currency>#<n>`, `n` counting
 * earlier rows of that signature in the file. It holds ONLY what every valid mapping must map (the
 * booking date and the amount; the currency defaults to the Bankkonto's and a row in another one is
 * skipped): the value date, the text and every other optional column stay out (critic H1). Since the D178
 * point 19 re-cut the key is only a storage label (a taken one gets `~dupN`) and never drops a row: a CSV
 * never extends the balance chain, so a re-export is an OVERLAP, and statementCoverage.ts matches each row
 * one to one on its movement (booking date, direction, amount, currency, occurrence) on the days the books
 * already cover, importing it FLAGGED `same_movement` instead of counting it twice silently. A CSV covers
 * its first booking date to the day before its last (a midday export does not cover its last day).
 */

import { createHash } from 'node:crypto';

import { parseGenericCsv, isParseFailure } from '../migration/adapters/parse.js';
import type { CamtCreditDebit, ParsedBankStatement, ParsedCamtEntry, SkippedCamtEntry } from './camt.js';
import { deriveFacts, emptyFacts, parseDecimal, swissAmountToMinor } from './statementFacts.js';
import type { ParsedLineFacts } from './statementFacts.js';
import type { CsvDateFormat, CsvDelimiter, CsvEncoding, CsvMapping } from './csvMapping.js';

/** The encoding the bytes were read in (`utf-8-bom` when a BOM said so). */
export type DetectedCsvEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252';

/** Bytes to text: a forced encoding, else a UTF-8 BOM, else strict UTF-8, else Windows-1252. */
export function decodeStatementBytes(bytes: Uint8Array, forced?: CsvEncoding): { text: string; encoding: DetectedCsvEncoding } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (forced === 'windows-1252') return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  if (bom) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  if (forced === 'utf-8') return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** The candidates in tie order: `;` (the Swiss export's), then tab, then `,`. */
const SEPARATORS: readonly { name: CsvDelimiter; ch: string }[] = [
  { name: 'semicolon', ch: ';' },
  { name: 'tab', ch: '\t' },
  { name: 'comma', ch: ',' },
];

/** The cells of one line split on `ch` outside double quotes (quotes kept; the reader strips them). */
function cellsOf(line: string, ch: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (const c of line) {
    if (c === '"') {
      quoted = !quoted;
      cell += c;
    } else if (c === ch && !quoted) {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

/** Separators outside double quotes on one line. */
function separatorCount(line: string, ch: string): number {
  return cellsOf(line, ch).length - 1;
}


/** The most frequent positive count of a list (the larger count on a tie) and how many lines carry it. */
function modalCount(counts: readonly number[]): { count: number; support: number } {
  const freq = new Map<number, number>();
  for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
  let best = { count: 0, support: 0 };
  for (const [count, support] of freq) {
    if (support > best.support || (support === best.support && count > best.count)) best = { count, support };
  }
  return best;
}

/**
 * The header row (1-based) and separator of a bank export, read from the first 30 non-empty lines
 * (critic M3):
 *  - the SEPARATOR is the one most lines agree on: for each candidate, the most frequent column count
 *    and how many lines carry it; the most lines win, and on a tie `;` (the Swiss export's separator),
 *    then tab, then `,`. A decimal comma or a card text with commas never outvotes a `;` file whose rows
 *    all have the same width;
 *  - the HEADER (critic R2-4: a `key;value` preamble can outnumber a short month's rows, so the most
 *    frequent width is not the table's) is found among the widths a header AND at least one later line
 *    share, widest first: the first line of that width that is followed by a line of the same width, has
 *    as many filled cells as any such line, and at least `HEADER_MIN_WORDS` distinct cells that are words,
 *    not numbers or dates (a header names columns, a row carries values). A preamble padded to the column
 *    count by a spreadsheet (`Kontoauszug;;;`) has fewer filled cells; `Konto;CH93 ...` is narrower than
 *    the table. When no width has such a line, the most filled line of the widest shared width is taken.
 * A forced separator or row is taken as given; the Studio's mapping step offers both.
 */
export function detectCsvLayout(text: string, forced: { headerRow?: number; delimiter?: CsvDelimiter } = {}): { headerRow: number; delimiter: CsvDelimiter } {
  const lines = text.split(/\r\n|\r|\n/);
  // At most 30 lines of at most 64 KiB each are read: no file can make the detection slow.
  const sample = lines
    .slice(0, 200)
    .map((l, i) => ({ l: l.slice(0, 65_536), i }))
    .filter((x) => x.l.trim() !== '')
    .slice(0, 30);
  let delimiter: CsvDelimiter = forced.delimiter ?? 'semicolon';
  if (forced.delimiter === undefined) {
    let best = { support: 0, count: 0 };
    for (const s of SEPARATORS) {
      const modal = modalCount(sample.map((x) => separatorCount(x.l, s.ch)));
      if (modal.support > best.support) {
        best = modal;
        delimiter = s.name;
      }
    }
  }
  if (forced.headerRow !== undefined) return { headerRow: forced.headerRow, delimiter };
  const ch = (SEPARATORS.find((s) => s.name === delimiter) as { ch: string }).ch;
  const rows = sample.map((x) => {
    const cells = cellsOf(x.l, ch).map((c) => c.replace(/"/g, '').trim());
    const words = new Set(cells.filter((c) => c !== '' && isWordCell(c)));
    return {
      i: x.i,
      separators: cells.length - 1,
      filled: cells.filter((c) => c !== '').length,
      words: words.size,
      numeric: cells.some((c) => c !== '' && !isWordCell(c)),
    };
  });
  // A width counts when a line of it is followed by another line of it: a header and its first row.
  const followed = rows.filter((r, k) => r.separators > 0 && rows.slice(k + 1).some((o) => o.separators === r.separators));
  const widths = [...new Set(followed.map((r) => r.separators))].sort((a, b) => b - a);
  for (const width of widths) {
    const atWidth = followed.filter((r) => r.separators === width);
    const most = Math.max(...atWidth.map((r) => r.filled));
    const header = atWidth.find((r) => r.filled === most && r.words >= HEADER_MIN_WORDS && !r.numeric);
    if (header !== undefined) return { headerRow: header.i + 1, delimiter };
  }
  const widest = widths[0];
  if (widest === undefined) return { headerRow: (sample[0]?.i ?? 0) + 1, delimiter };
  const atWidest = followed.filter((r) => r.separators === widest);
  const most = Math.max(...atWidest.map((r) => r.filled));
  const header = atWidest.find((r) => r.filled === most);
  return { headerRow: header === undefined ? 1 : header.i + 1, delimiter };
}

/** The fewest column names a header carries: what every mapping must map (a booking date and an amount). */
const HEADER_MIN_WORDS = 2;

/** A cell that names something (it has a letter), not a number, an amount or a date. */
function isWordCell(cell: string): boolean {
  return /\p{L}/u.test(cell);
}

export interface CsvTable {
  encoding: DetectedCsvEncoding;
  delimiter: CsvDelimiter;
  headerRow: number;
  headers: string[];
  /** Header-keyed rows (G09's shape), in file order. */
  records: Readonly<Record<string, string>>[];
  /** The 1-based file line of each record, in step with `records`. */
  lines: number[];
  warnings: string[];
}

/**
 * Read a bank CSV into a header-keyed table through G09's reader. `bytes` (base64-decoded upload) or
 * `text` (already decoded). Never throws; a file with no header line answers `{ headers: [] }`.
 */
export function readCsvTable(
  input: { bytes?: Uint8Array; text?: string },
  opts: { headerRow?: number; delimiter?: CsvDelimiter; encoding?: CsvEncoding } = {},
): CsvTable {
  const decoded = input.bytes !== undefined ? decodeStatementBytes(input.bytes, opts.encoding) : { text: (input.text ?? '').replace(/^﻿/, ''), encoding: 'utf-8' as const };
  const layout = detectCsvLayout(decoded.text, opts);
  const all = decoded.text.split(/\r\n|\r|\n/);
  const fromHeader = all.slice(layout.headerRow - 1);
  const parsed = parseGenericCsv(new TextEncoder().encode(fromHeader.join('\n')), { encoding: 'utf-8', delimiter: layout.delimiter });
  if (isParseFailure(parsed)) {
    return { encoding: decoded.encoding, delimiter: layout.delimiter, headerRow: layout.headerRow, headers: [], records: [], lines: [], warnings: [parsed.reason] };
  }
  // The file line of each record, by the reader's own rule: after the header line, every non-blank line.
  const lines: number[] = [];
  const firstNonBlank = fromHeader.findIndex((l) => l.trim() !== '');
  for (let i = firstNonBlank + 1; i < fromHeader.length; i += 1) {
    if ((fromHeader[i] as string).trim() !== '') lines.push(layout.headerRow + i);
  }
  return {
    encoding: decoded.encoding,
    delimiter: layout.delimiter,
    headerRow: layout.headerRow + Math.max(0, firstNonBlank),
    headers: parsed.headers.filter((h) => h !== ''),
    records: [...parsed.rows],
    lines: lines.slice(0, parsed.rows.length),
    warnings: [...parsed.warnings],
  };
}

/** The longest amount or date cell read; anything longer is unparseable (no pattern ever sees it). */
const CELL_MAX_CHARS = 64;

/** Three upper-case letters, checked character by character. */
function isCurrencyCode(v: string): boolean {
  return v.length === 3 && [...v].every((c) => c >= 'A' && c <= 'Z');
}

/** A date cell in the mapping's format, as an ISO date, or null when it is not one. */
export function csvDate(raw: string, format: CsvDateFormat): string | null {
  if (raw.length > CELL_MAX_CHARS) return null;
  const v = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  let hit: RegExpExecArray | null;
  if (format === 'yyyy-mm-dd') {
    hit = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(v);
    if (hit === null) return null;
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else if (format === 'dd/mm/yyyy') {
    hit = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (hit === null) return null;
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else {
    hit = format === 'dd.mm.yy' ? /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(v) : /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s.*)?$/.exec(v);
    if (hit === null) return null;
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (format === 'dd.mm.yy') y += 2000;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** A signed amount cell: `-12.30`, `12.30-`, `(12.30)`, `+12.30`, `1'234.50`. Null when unreadable. */
export function csvSignedAmount(raw: string, decimal?: '.' | ','): number | null {
  // Bounded before any pattern reads it: an amount cell is short, and a long one is unparseable.
  if (raw.length > CELL_MAX_CHARS) return null;
  let v = raw.trim();
  if (v.length > 3 && isCurrencyCode(v.slice(0, 3))) v = v.slice(3).trimStart();
  if (v.length > 3 && isCurrencyCode(v.slice(-3))) v = v.slice(0, -3).trimEnd();
  if (v === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (v.startsWith('-') || v.startsWith('−')) {
    negative = !negative;
    v = v.slice(1);
  } else if (v.startsWith('+')) v = v.slice(1);
  if (v.endsWith('-')) {
    negative = !negative;
    v = v.slice(0, -1);
  }
  const minor = swissAmountToMinor(v, decimal);
  if (minor === null) return null;
  return negative ? -minor : minor;
}

function cell(record: Readonly<Record<string, string>>, header: string | undefined): string {
  return header === undefined ? '' : (record[header] ?? '').trim();
}

function isIban(v: string): boolean {
  return v.length <= CELL_MAX_CHARS && /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v.replace(/\s+/g, '').toUpperCase());
}

/**
 * The mapped table as a statement for the one insertion. Rows are skipped with their file line and a
 * stable reason: `not_a_movement` (no booking date: a total, a carried balance, a note), `unreadable_date`,
 * `unreadable_amount`, `zero_amount`, `currency_differs` (a row in another currency than the
 * Bankkonto's is a foreign amount, not the booked one).
 */
export function csvStatementOf(table: CsvTable, mapping: CsvMapping, accountCurrency: string): ParsedBankStatement {
  const c = mapping.columns;
  const entries: ParsedCamtEntry[] = [];
  const skipped: SkippedCamtEntry[] = [];
  const seen = new Map<string, number>();
  const canonical: string[] = [];
  table.records.forEach((record, i) => {
    const row = table.lines[i] ?? table.headerRow + i + 1;
    const dateRaw = cell(record, c.bookingDate);
    const amountRaw = cell(record, c.amount);
    const debitRaw = cell(record, c.debit);
    const creditRaw = cell(record, c.credit);
    const reference = cell(record, c.reference);
    if (dateRaw === '' && amountRaw === '' && debitRaw === '' && creditRaw === '') {
      skipped.push({ entryRef: null, reason: 'not_a_movement', row });
      return;
    }
    // A row without a booking date is no movement (a total, a carried balance, a note line).
    if (dateRaw === '') {
      skipped.push({ entryRef: reference || null, reason: 'not_a_movement', row });
      return;
    }
    const bookingDate = csvDate(dateRaw, mapping.dateFormat);
    if (bookingDate === null) {
      skipped.push({ entryRef: reference || null, reason: 'unreadable_date', row });
      return;
    }
    let signed: number | null;
    if (c.amount !== undefined) {
      signed = csvSignedAmount(amountRaw, mapping.decimalSeparator);
    } else {
      const debit = debitRaw === '' ? 0 : csvSignedAmount(debitRaw, mapping.decimalSeparator);
      const credit = creditRaw === '' ? 0 : csvSignedAmount(creditRaw, mapping.decimalSeparator);
      if (debit === null || credit === null) signed = null;
      else if (debit !== 0 && credit !== 0) signed = null; // both sides filled: which one is the booking?
      else signed = credit !== 0 ? Math.abs(credit) : -Math.abs(debit);
    }
    if (signed === null) {
      skipped.push({ entryRef: reference || null, reason: 'unreadable_amount', row });
      return;
    }
    if (signed === 0) {
      skipped.push({ entryRef: reference || null, reason: 'zero_amount', row });
      return;
    }
    const currency = (cell(record, c.currency) || accountCurrency).toUpperCase();
    if (currency !== accountCurrency) {
      skipped.push({ entryRef: reference || null, reason: 'currency_differs', row });
      return;
    }
    const valueDate = c.valueDate === undefined ? null : csvDate(cell(record, c.valueDate), mapping.dateFormat);
    const creditDebit: CamtCreditDebit = signed > 0 ? 'CRDT' : 'DBIT';
    const amountMinor = Math.abs(signed);
    // Only what every valid mapping maps (critic H1): never the value date or another optional column.
    const signature = `${bookingDate}|${creditDebit}|${amountMinor}|${currency}`;
    const n = seen.get(signature) ?? 0;
    seen.set(signature, n + 1);
    const text = cell(record, c.text);
    const counterparty = cell(record, c.counterparty);
    const ibanCell = cell(record, c.counterpartyIban);
    const ibanRaw = ibanCell.length > CELL_MAX_CHARS ? '' : ibanCell.replace(/\s+/g, '').toUpperCase();
    const instructedRaw = cell(record, c.instructedAmount);
    const instructedCurrency = cell(record, c.instructedCurrency).toUpperCase();
    const instructedMinor = instructedRaw === '' ? null : csvSignedAmount(instructedRaw, mapping.decimalSeparator);
    const rateRaw = cell(record, c.rate).replace(',', '.');
    const feeRaw = cell(record, c.fee);
    const feeMinor = feeRaw === '' ? null : csvSignedAmount(feeRaw, mapping.decimalSeparator);
    const instructed =
      instructedMinor !== null && instructedMinor !== 0 && /^[A-Z]{3}$/.test(instructedCurrency) ? { amountMinor: Math.abs(instructedMinor), currency: instructedCurrency } : null;
    const facts: ParsedLineFacts = {
      ...emptyFacts('csv'),
      bankText: text === '' ? null : text,
      refs: { endToEndId: null, accountServicerRef: null, instructionId: null, transactionId: null },
      instructed,
      exchange:
        instructed !== null && instructed.currency !== currency
          ? {
              sourceCurrency: instructed.currency,
              targetCurrency: currency,
              unitCurrency: instructed.currency,
              rate: parseDecimal(rateRaw) === null ? null : rateRaw,
              effectiveRate: null,
              origin: 'structured',
            }
          : null,
      charges:
        feeMinor !== null && feeMinor !== 0
          ? { totalMinor: Math.abs(feeMinor), currency, records: [{ amountMinor: Math.abs(feeMinor), currency, creditDebit: null, included: null, type: 'fee' }], origin: 'structured' }
          : null,
    };
    canonical.push([signature, n, valueDate ?? '', text, counterparty, ibanRaw, reference, instructedRaw, instructedCurrency, rateRaw, feeRaw].join('\u001f'));
    entries.push({
      entryKey: `csv:${signature}#${n}`,
      entryRef: reference === '' ? null : reference,
      amountMinor,
      currency,
      creditDebit,
      bookingDate,
      valueDate,
      reversalInd: false,
      btcDomain: null,
      btcFamily: null,
      btcSubFamily: null,
      batchPmtInfId: null,
      txPmtInfId: null,
      referenceKind: 'none',
      referenceValue: null,
      payerName: creditDebit === 'CRDT' && counterparty !== '' ? counterparty : null,
      counterpartyName: counterparty === '' ? null : counterparty,
      counterpartyIban: isIban(ibanRaw) ? ibanRaw : null,
      remittanceText: text === '' ? null : text,
      endToEndId: null,
      facts: deriveFacts(facts, { amountMinor, currency, creditDebit }),
    });
  });
  const dates = entries.map((e) => e.bookingDate as string).sort();
  // The statement's identity is the content it carries under this mapping: the same file mapped the same
  // way is a byte-identical re-import (duplicate:true); a changed mapping is a new statement whose lines
  // the per-line keys still recognise.
  const digest = createHash('sha256').update(canonical.join('\n'), 'utf8').digest('hex').slice(0, 24);
  return {
    messageType: 'csv',
    statementId: `csv:${digest}`,
    electronicSeqNb: null,
    pageNumber: 1,
    lastPage: true,
    splitPage: false,
    iban: null,
    fromDate: dates[0] ?? null,
    toDate: dates[dates.length - 1] ?? null,
    openingBalanceMinor: null,
    closingBalanceMinor: null,
    balanceCurrency: null,
    entries,
    skipped,
  };
}
