/**
 * D178 point 4 (spec A20 §11.3): a bank CSV export, read through a column mapping into the SAME parsed
 * statement shape camt has (`messageType: 'csv'`). Pure: no store, no clock.
 *
 * THE READER IS THE TABULAR LAYER'S (A20 §13.1, D205): `src/core/tabular/` decodes the bytes (a UTF-8 BOM;
 * strict UTF-8; else Windows-1252, the legacy single-byte export many Swiss e-banking CSVs still are), finds
 * the separator and the header row below a preamble, and reads RFC 4180 rows from the header on, the same
 * rows G09's `parseGenericCsv` reads; an XLSX sheet is written out as that text first. This module keeps
 * what a BANK export needs on top: the amounts, the dates and the statement shape. The old names
 * (`decodeStatementBytes`, `detectCsvLayout`, `readCsvTable`, `CsvTable`) are re-exported here.
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

import { decodeTextBytes, detectTableLayout, readTextTable } from '../tabular/index.js';
import type { DetectedTextEncoding, TabularCellKind, TabularTable } from '../tabular/index.js';
import type { CamtCreditDebit, ParsedBankStatement, ParsedCamtEntry, SkippedCamtEntry } from './camt.js';
import { deriveFacts, emptyFacts, parseDecimal, swissAmountToMinor } from './statementFacts.js';
import type { ParsedLineFacts } from './statementFacts.js';
import type { CsvDateFormat, CsvDelimiter, CsvEncoding, CsvMapping } from './csvMapping.js';

/** The encoding the bytes were read in (`utf-8-bom` when a BOM said so). A20 §13.1: the tabular layer's. */
export type DetectedCsvEncoding = DetectedTextEncoding;

/** Bytes to text (A20 §13.1: moved to `tabular/decode.ts`, unchanged). */
export const decodeStatementBytes: (bytes: Uint8Array, forced?: CsvEncoding) => { text: string; encoding: DetectedCsvEncoding } = decodeTextBytes;

/** The header row and separator of a bank export (A20 §13.1: moved to `tabular/layout.ts`, unchanged). */
export const detectCsvLayout: (text: string, forced?: { headerRow?: number; delimiter?: CsvDelimiter }) => { headerRow: number; delimiter: CsvDelimiter } = detectTableLayout;

/** A bank export read into a header-keyed table (A20 §13.1: the tabular layer's table; an XLSX carries `container: 'xlsx'`). */
export type CsvTable = TabularTable;

/**
 * Read a bank CSV into a header-keyed table (A20 §13.1: `tabular/table.ts`, unchanged rows). `bytes`
 * (base64-decoded upload) or `text` (already decoded). Never throws; a file with no header line answers
 * `{ headers: [] }`.
 */
export function readCsvTable(
  input: { bytes?: Uint8Array; text?: string },
  opts: { headerRow?: number; delimiter?: CsvDelimiter; encoding?: CsvEncoding } = {},
): CsvTable {
  return readTextTable(input, opts);
}

/** The longest amount or date cell read; anything longer is unparseable (no pattern ever sees it). */
const CELL_MAX_CHARS = 64;

/** Three upper-case letters, checked character by character. */
function isCurrencyCode(v: string): boolean {
  return v.length === 3 && [...v].every((c) => c >= 'A' && c <= 'Z');
}

/**
 * A date cell in the mapping's format, as an ISO date, or null when it is not one. `isoToo` (A20 §13.1: a
 * workbook's date cell is written out as its ISO date) also reads a bare `yyyy-mm-dd` whatever the format.
 */
export function csvDate(raw: string, format: CsvDateFormat, isoToo = false): string | null {
  if (raw.length > CELL_MAX_CHARS) return null;
  const v = raw.trim();
  if (isoToo && format !== 'yyyy-mm-dd' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return csvDate(v, 'yyyy-mm-dd');
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
  return readMoneyCell(raw, { decimal })?.minor ?? null;
}

/** One money cell read: its signed minor units, and the ISO 4217 code the cell itself named, if any. */
export interface MoneyCell {
  minor: number;
  currency?: string;
}

/**
 * A20 §13.1 (critic round 1, H1; security review): THE ONE money-cell parser of every tabular door (banking, and
 * the A43 settlement table door), so no second reader can disagree with it. `kind` is the cell's kind as the
 * table carries it: a workbook's `number` cell is read point-decimal whatever `decimal` says (it is the
 * workbook's own number, never locale text) and names no currency; a `text` cell (every cell of a delimited
 * file) is read with `decimal`, and a leading or trailing three-letter code (`EUR 50.00`, `50.00 EUR`,
 * `CHF -12.30`, `(12.30) USD`) is stripped and answered as `currency`. Two different codes, or anything
 * unreadable, answer null. Amounts are exact: more than two decimals is unreadable, never rounded.
 */
export function readMoneyCell(raw: string, opts: { decimal?: '.' | ',' | undefined; kind?: TabularCellKind | undefined } = {}): MoneyCell | null {
  // Bounded before any pattern reads it: an amount cell is short, and a long one is unparseable.
  if (raw.length > CELL_MAX_CHARS) return null;
  const decimal = opts.kind === 'number' ? '.' : opts.decimal;
  let v = raw.trim();
  let currency: string | undefined;
  if (opts.kind !== 'number') {
    if (v.length > 3 && isCurrencyCode(v.slice(0, 3))) {
      currency = v.slice(0, 3);
      v = v.slice(3).trimStart();
    }
    if (v.length > 3 && isCurrencyCode(v.slice(-3))) {
      const code = v.slice(-3);
      if (currency !== undefined && currency !== code) return null;
      currency = code;
      v = v.slice(0, -3).trimEnd();
    }
  }
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
  const signed = negative ? -minor : minor;
  return currency === undefined ? { minor: signed } : { minor: signed, currency };
}

function cell(record: Readonly<Record<string, string>>, header: string | undefined): string {
  return header === undefined ? '' : (record[header] ?? '').trim();
}

/** A20 §12: the name part of a counterparty cell (`first_comma`: before the first comma, the rest an address). */
function counterpartyOf(raw: string, cut: CsvMapping['counterpartyCut']): string {
  if (cut !== 'first_comma') return raw;
  const at = raw.indexOf(',');
  return (at < 0 ? raw : raw.slice(0, at)).trim();
}

/** The kinds of one record's cells by header (A20 §13.1: an XLSX's), or undefined for a delimited file. */
export type CsvRowKinds = Readonly<Record<string, TabularCellKind>> | undefined;

/**
 * A20 §13.1 (critic round 1, H1): THE ONE amount reader of a mapped cell. A workbook's `number` cell is the
 * workbook's own number, written point-decimal, so it is read point-decimal whatever the mapping says; only a
 * `text` cell is read with the mapping's decimal separator. Every amount a row carries goes through here.
 */
export function csvAmountCell(record: Readonly<Record<string, string>>, header: string | undefined, mapping: CsvMapping, kinds: CsvRowKinds): number | null {
  return csvMoneyCellOf(record, header, mapping, kinds)?.minor ?? null;
}

/**
 * The same, with the currency the cell names (`readMoneyCell`). FAIL CLOSED: when the row comes with kinds (a
 * workbook) and the cell has none, it is unreadable, never read with the mapping's separator as a guess.
 */
export function csvMoneyCellOf(record: Readonly<Record<string, string>>, header: string | undefined, mapping: CsvMapping, kinds: CsvRowKinds): MoneyCell | null {
  const raw = cell(record, header);
  if (raw === '') return null;
  const kind = header === undefined ? undefined : kinds?.[header];
  if (kinds !== undefined && kind === undefined) return null;
  return readMoneyCell(raw, { decimal: mapping.decimalSeparator, kind });
}

/**
 * A20 §12: the running balance a row states (the balance after it, as the bank shows it), in minor
 * units, or null when the mapping names no balance column or the cell is empty or unreadable.
 */
export function csvRowBalance(record: Readonly<Record<string, string>>, mapping: CsvMapping, kinds?: CsvRowKinds): number | null {
  return csvAmountCell(record, mapping.columns.balance, mapping, kinds);
}

/** The amount columns a mapping can name (A20 §13.1: what the separator check reads). */
const AMOUNT_TARGETS = ['amount', 'debit', 'credit', 'balance', 'fee', 'instructedAmount'] as const;

/**
 * A20 §13.1 (critic round 1, M3): the first TEXT amount cell whose decimal separator contradicts the mapping's
 * (`12.50` under `,`, `12,50` under `.`), as its row and column, or null. A workbook's number cells are not text and
 * never contradict; a cell readable either way (`1.234`) is not a contradiction (the parsed sample shows it).
 */
export function separatorMismatch(table: Pick<CsvTable, 'records' | 'lines' | 'headerRow' | 'kinds'>, mapping: CsvMapping): { row: number; column: string } | null {
  const dec = mapping.decimalSeparator;
  if (dec === undefined) return null;
  const headers = [...new Set(AMOUNT_TARGETS.map((f) => mapping.columns[f]).filter((h): h is string => h !== undefined))];
  for (let i = 0; i < table.records.length; i += 1) {
    const record = table.records[i] as Readonly<Record<string, string>>;
    // Re-critic L3: only a movement row speaks for the amounts; a dateless footer (`;Total;12.50`) is skipped as
    // no movement and never refuses the file.
    if (cell(record, mapping.columns.bookingDate) === '') continue;
    for (const h of headers) {
      if (table.kinds?.[i]?.[h] === 'number') continue;
      const raw = (record[h] ?? '').trim();
      if (raw === '' || raw.length > CELL_MAX_CHARS) continue;
      const v = raw.replace(/^[A-Z]{3}\s*/, '').replace(/\s*[A-Z]{3}$/, '');
      const pointDecimal = /^\(?[-+\u2212]?[\d'\u2019 ]*\d\.\d{1,2}\)?-?$/.test(v) && !v.includes(',');
      const commaDecimal = /^\(?[-+\u2212]?[\d'\u2019 ]*\d,\d{1,2}\)?-?$/.test(v) && !v.includes('.');
      if ((dec === ',' && pointDecimal) || (dec === '.' && commaDecimal)) return { row: table.lines[i] ?? table.headerRow + i + 1, column: h };
    }
  }
  return null;
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
  // A20 §13.1: a workbook's lines say so (`container`), and its date cells arrive as ISO dates.
  const xlsx = table.container === 'xlsx';
  // A workbook's row without kinds is read with EMPTY kinds, so every amount of it is unreadable (fail closed).
  const kindsOf = (i: number): CsvRowKinds => (xlsx ? (table.kinds?.[i] ?? {}) : table.kinds?.[i]);
  const amountOf = (i: number, record: Readonly<Record<string, string>>, header: string | undefined): number | null => csvAmountCell(record, header, mapping, kindsOf(i));
  // A20 §13.1: the currency the booked amount's own cell names (`EUR 50.00`), if any.
  const namedCurrencyOf = (i: number, record: Readonly<Record<string, string>>): string | null => {
    for (const h of [c.amount, c.debit, c.credit]) {
      const m = h === undefined ? null : csvMoneyCellOf(record, h, mapping, kindsOf(i));
      if (m?.currency !== undefined && m.minor !== 0) return m.currency;
    }
    return null;
  };
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
    const bookingDate = csvDate(dateRaw, mapping.dateFormat, xlsx);
    if (bookingDate === null) {
      skipped.push({ entryRef: reference || null, reason: 'unreadable_date', row });
      return;
    }
    let signed: number | null;
    if (c.amount !== undefined) {
      signed = amountOf(i, record, c.amount);
    } else {
      const debit = debitRaw === '' ? 0 : amountOf(i, record, c.debit);
      const credit = creditRaw === '' ? 0 : amountOf(i, record, c.credit);
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
    // A20 §13.1 (security review): a code the amount cell itself names counts like the currency column, so a
    // foreign amount written `EUR 50.00` is never read as the account's money.
    const named = namedCurrencyOf(i, record);
    const columnCurrency = cell(record, c.currency).toUpperCase();
    if (named !== null && columnCurrency !== '' && named !== columnCurrency) {
      skipped.push({ entryRef: reference || null, reason: 'currency_differs', row });
      return;
    }
    const currency = (columnCurrency || named || accountCurrency).toUpperCase();
    if (currency !== accountCurrency) {
      skipped.push({ entryRef: reference || null, reason: 'currency_differs', row });
      return;
    }
    const valueDate = c.valueDate === undefined ? null : csvDate(cell(record, c.valueDate), mapping.dateFormat, xlsx);
    const creditDebit: CamtCreditDebit = signed > 0 ? 'CRDT' : 'DBIT';
    const amountMinor = Math.abs(signed);
    // Only what every valid mapping maps (critic H1): never the value date or another optional column.
    const signature = `${bookingDate}|${creditDebit}|${amountMinor}|${currency}`;
    const n = seen.get(signature) ?? 0;
    seen.set(signature, n + 1);
    const text = cell(record, c.text);
    // A20 §12: a payment purpose kept apart from the booking text is the remittance; the text stays the bank's.
    const purpose = cell(record, c.purpose);
    const counterparty = counterpartyOf(cell(record, c.counterparty), mapping.counterpartyCut);
    const ibanCell = cell(record, c.counterpartyIban);
    const ibanRaw = ibanCell.length > CELL_MAX_CHARS ? '' : ibanCell.replace(/\s+/g, '').toUpperCase();
    const instructedRaw = cell(record, c.instructedAmount);
    const instructedCurrency = cell(record, c.instructedCurrency).toUpperCase();
    const instructedMinor = instructedRaw === '' ? null : amountOf(i, record, c.instructedAmount);
    const rateRaw = cell(record, c.rate).replace(',', '.');
    const feeRaw = cell(record, c.fee);
    const feeMinor = feeRaw === '' ? null : amountOf(i, record, c.fee);
    const instructed =
      instructedMinor !== null && instructedMinor !== 0 && /^[A-Z]{3}$/.test(instructedCurrency) ? { amountMinor: Math.abs(instructedMinor), currency: instructedCurrency } : null;
    const facts: ParsedLineFacts = {
      ...emptyFacts('csv'),
      ...(xlsx ? { container: 'xlsx' as const } : {}),
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
    canonical.push([signature, n, valueDate ?? '', text, counterparty, ibanRaw, reference, instructedRaw, instructedCurrency, rateRaw, feeRaw, ...(purpose === '' ? [] : [purpose])].join('\u001f'));
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
      remittanceText: purpose !== '' ? purpose : text === '' ? null : text,
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
