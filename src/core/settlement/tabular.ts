/**
 * A43 §2, THE TABLE DOOR'S READER: a CSV or XLSX export of a turnover source, read into a header-keyed grid.
 * Pure: no store, no clock.
 *
 * ONE READER, SHARED. The settlement table door owns no CSV or XLSX parser of its own: it reads through A20
 * §13.1's tabular layer (`src/core/tabular/`), the reader banking and migration use, with the door's own caps
 * passed IN (`maxRows`, `maxInflatedBytes`). The limits are enforced inside that one reader (during inflation,
 * and in the row loop), never by a second parser here (security review, 15.11.2026: a pre-check that parses
 * on its own drifts from the parser that reads).
 *
 * THE CONTENT IS SNIFFED, NEVER THE NAME: `contentBase64` bytes of a zip are a workbook, an OLE compound file
 * (a legacy `.xls` or an encrypted workbook) refuses `xls_unsupported`, anything else is delimited text.
 * `content` is already text (CSV).
 *
 * XLSX cells: the shared reader writes a number through its shortest decimal spelling and a date-styled cell
 * as an ISO date, and answers each cell's kind (number | text | date). A NUMBER cell is read point-decimal
 * whatever the mapping says; a TEXT cell, and every CSV cell, by the mapping's decimal mark. More than two
 * decimal places is unreadable, never rounded.
 */

import { readTable as readTabular, isTabularFailure } from '../tabular/index.js';
import type { TabularCellKind, TabularFailure } from '../tabular/index.js';
import { err } from '../result.js';
import type { Err } from '../result.js';

/** The largest table one call takes (the `import_settlement` cap). */
export const TABLE_MAX_BYTES = 10 * 1024 * 1024;
/** The most data rows one table takes: a row can become two events (its fee), and a document takes 20'000. */
export const TABLE_MAX_ROWS = 10_000;
/** The most bytes a workbook may unpack to (every member together), enforced by the reader while inflating. */
export const TABLE_MAX_INFLATED_BYTES = 4 * TABLE_MAX_BYTES;

export type TableContainer = 'csv' | 'xlsx';
export type TableDelimiter = 'semicolon' | 'comma' | 'tab';
export type TableEncoding = 'utf-8' | 'windows-1252';

export interface ReaderOptions {
  delimiter?: TableDelimiter;
  encoding?: TableEncoding;
  headerRow?: number;
}

export interface TableRead {
  container: TableContainer;
  headers: string[];
  /** Header-keyed rows, in file order. */
  records: Readonly<Record<string, string>>[];
  /** The 1-based row number of each record (the file line of a CSV, the sheet row of an XLSX). */
  rowNumbers: number[];
  /** XLSX: every worksheet name, and the one read. */
  sheets: string[] | null;
  sheet: string | null;
  /** XLSX: each record's cell kinds by header (number | text | date), in step with `records`; null for a CSV. */
  kinds: Readonly<Record<string, TabularCellKind>>[] | null;
  warnings: string[];
}

/** Decode a base64 body, or null when it is not base64. */
function bytesOf(b64raw: string): Uint8Array | null {
  const b64 = b64raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** The reader's failure in the door's own codes: every size or row limit is `table_too_large`. */
function refusalOf(f: TabularFailure): Err {
  if (f.code === 'too_large' || f.code === 'too_many_rows' || f.kind === 'too_large' || f.kind === 'too_many_rows') {
    return err('table_too_large', { reason: f.reason, ...(f.limit !== undefined ? { limit: f.limit } : {}) });
  }
  if (f.code === 'sheet_not_found') return err('sheet_not_found', { field: 'sheet', reason: f.reason, sheets: f.sheets ?? [] });
  // A legacy or encrypted workbook, or an OpenDocument sheet: saved again as xlsx or CSV, it reads.
  if (f.kind === 'ole' || f.kind === 'ods') return err('xls_unsupported', { reason: f.reason });
  return err('table_unreadable', { reason: f.reason });
}

/**
 * Read a table: `content` (CSV text) or `contentBase64` (CSV or XLSX bytes), exactly one. Refuses
 * `invalid_input` (no file, a file too large, not base64), `table_too_large` (more than `TABLE_MAX_ROWS` data
 * rows, or a workbook unpacking past `TABLE_MAX_INFLATED_BYTES`, both stopped inside the reader),
 * `xls_unsupported` (a legacy or encrypted workbook), `sheet_not_found` (with the sheets), `table_unreadable`
 * (a damaged workbook, no header row).
 */
export function readTable(input: { content?: unknown; contentBase64?: unknown; sheet?: unknown }, opts: ReaderOptions = {}): TableRead | Err {
  const hasText = typeof input.content === 'string' && input.content.length > 0;
  const hasBytes = typeof input.contentBase64 === 'string' && input.contentBase64.length > 0;
  if (hasText === hasBytes) return err('invalid_input', { field: 'content', reason: 'exactly one of content (the CSV text) or contentBase64 (the file bytes, CSV or XLSX)' });
  if (input.sheet !== undefined && (typeof input.sheet !== 'string' || input.sheet.length === 0 || input.sheet.length > 200)) {
    return err('invalid_input', { field: 'sheet', reason: 'a worksheet name' });
  }
  let bytes: Uint8Array | null = null;
  if (hasBytes) {
    bytes = bytesOf(input.contentBase64 as string);
    if (bytes === null) return err('invalid_input', { field: 'contentBase64', reason: 'base64 of the file bytes' });
    if (bytes.length > TABLE_MAX_BYTES) return err('invalid_input', { field: 'contentBase64', reason: `at most ${TABLE_MAX_BYTES} bytes` });
  } else if (Buffer.byteLength(input.content as string, 'utf8') > TABLE_MAX_BYTES) {
    return err('invalid_input', { field: 'content', reason: `at most ${TABLE_MAX_BYTES} bytes` });
  }
  // `maxRows` is the most DATA rows read: the reader refuses the first row past it, in a CSV and a workbook alike.
  const read = readTabular(bytes !== null ? { bytes } : { text: input.content as string }, {
    container: 'auto',
    maxRows: TABLE_MAX_ROWS,
    maxInflatedBytes: TABLE_MAX_INFLATED_BYTES,
    ...(typeof input.sheet === 'string' ? { sheet: input.sheet } : {}),
    ...(opts.headerRow !== undefined ? { headerRow: opts.headerRow } : {}),
    ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
    ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
  });
  if (isTabularFailure(read)) return refusalOf(read);
  if (read.headers.length === 0) return err('table_unreadable', { reason: 'the file has no header row' });
  return {
    container: read.container ?? 'csv',
    headers: read.headers,
    records: read.records,
    rowNumbers: read.lines,
    sheets: read.sheets ?? null,
    sheet: read.sheet ?? null,
    kinds: read.kinds ?? null,
    warnings: read.warnings,
  };
}

const NUMBER_TEXT = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * A money cell of an XLSX workbook through its shortest decimal spelling (the reader writes it so already; an
 * exponent spelling such as `2.162E2` reads as `216.2`); a CSV cell, or a cell that is not a plain number, as
 * written.
 */
export function moneyText(raw: string, container: TableContainer): string {
  const v = raw.trim();
  if (container !== 'xlsx' || !NUMBER_TEXT.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

/**
 * An XLSX date serial (the 1900 system) as an ISO day, or null: for a day column whose cells carry no date
 * style (a date-styled cell the reader already writes as an ISO date). Only whole serials of plausible days.
 */
export function xlsxSerialDay(raw: string): string | null {
  const v = raw.trim();
  if (!/^\d{5}(?:\.\d+)?$/.test(v)) return null;
  const serial = Math.floor(Number(v));
  if (serial < 20_000 || serial > 80_000) return null;
  // Day 25569 is 1970-01-01 in the 1900 system (which counts the phantom 29.02.1900).
  return new Date((serial - 25_569) * 86_400_000).toISOString().slice(0, 10);
}

/** Normalise a header for comparison: trimmed, lower case, inner whitespace collapsed. */
export function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}
