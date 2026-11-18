/**
 * A20 §13.1 (D205): ONE TABLE READER for every tabular export, whatever its container. A delimited file is
 * decoded (`decode.ts`), its layout detected (`layout.ts`) and read from the header row on
 * (`delimited.ts`); an XLSX sheet is written out as delimited text first (`xlsx.ts`) and then read the same
 * way, so a preamble above a workbook's header is skipped exactly as in a CSV and a line number is the
 * sheet's row number. Banking (`banking/csvStatement.ts`), the settlement table door and migration read
 * through here. Pure: never throws.
 */

import { decodeTextBytes, type DetectedTextEncoding, type TabularEncoding } from './decode.js';
import { readDelimitedRows, type TabularRow } from './delimited.js';
import { delimiterChar, detectTableLayout, type TabularDelimiter } from './layout.js';
import { isXlsxFailure, readXlsxGrid, sniffContainer, xlsxGridToText, XLSX_MAX_INFLATED_BYTES, XLSX_PREAMBLE_ROWS, type TabularCellKind, type XlsxFailureKind } from './xlsx.js';

/**
 * The most data rows one table holds (a decade of a busy account's daily lines fits many times over). A
 * table with more is refused `too_many_rows` naming the cap; reading stops at the first row over it, in a
 * CSV and in a workbook alike.
 */
export const TABULAR_MAX_ROWS = 100_000;

/** The containers a table is read from. */
export const TABULAR_CONTAINERS = ['csv', 'xlsx'] as const;
export type TabularContainer = (typeof TABULAR_CONTAINERS)[number];

export interface TabularTable {
  /** How the bytes were read (a delimited file); an XLSX is always UTF-8 XML and says `utf-8`. */
  encoding: DetectedTextEncoding;
  delimiter: TabularDelimiter;
  headerRow: number;
  headers: string[];
  /** Header-keyed rows, in file order. */
  records: TabularRow[];
  /** The 1-based file line (for an XLSX: the sheet row) of each record, in step with `records`. */
  lines: number[];
  warnings: string[];
  /** Where the table came from; absent means a delimited file (`csv`). */
  container?: TabularContainer;
  /** XLSX: every worksheet name in workbook order, and the one read. */
  sheets?: string[];
  sheet?: string;
  /** The file holds more than `TABULAR_MAX_ROWS` (or the asked cap) data rows: `records` stops at the cap. */
  overCap?: true;
  /**
   * A20 §13.1 (critic round 1, H1): each record's cell kinds by header, in step with `records`, for a container
   * that knows them (XLSX). Absent: every cell is `text` (a delimited file).
   */
  kinds?: Readonly<Record<string, TabularCellKind>>[];
}

/** Why a file could not be read as a table at all. */
export interface TabularFailure {
  ok: false;
  /** `xls_unsupported`: a legacy `.xls`, an encrypted workbook, an OpenDocument sheet, or no workbook at all. `sheet_not_found`: the named sheet is not in the workbook. */
  code: 'xls_unsupported' | 'sheet_not_found' | 'too_large' | 'too_many_rows';
  kind: XlsxFailureKind;
  reason: string;
  sheets?: string[];
  /** `too_large`: the inflated ceiling in bytes; `too_many_rows`: the row cap. */
  limit?: number;
}

export function isTabularFailure(r: TabularTable | TabularFailure): r is TabularFailure {
  return (r as TabularFailure).ok === false;
}

export interface ReadTableOptions {
  headerRow?: number;
  /** Delimited files only: an XLSX is always written out with `;`. */
  delimiter?: TabularDelimiter;
  /** Delimited files only. */
  encoding?: TabularEncoding;
  /** XLSX only: the worksheet to read (the first by default). */
  sheet?: string;
  /** The most DATA rows read; one more refuses `too_many_rows` naming the cap (default `TABULAR_MAX_ROWS`). */
  maxRows?: number;
  /**
   * The most bytes the content may take once unpacked (default `TABULAR_MAX_INFLATED_BYTES`): an XLSX's members,
   * enforced while inflating, or a delimited file's own bytes. More refuses `too_large` naming the limit.
   */
  maxInflatedBytes?: number;
}

/** The default unpacked-size limit of one table, CSV or XLSX (`XLSX_MAX_INFLATED_BYTES`). */
export const TABULAR_MAX_INFLATED_BYTES = XLSX_MAX_INFLATED_BYTES;

/**
 * Read delimited text (or bytes, decoded first) into a header-keyed table from its detected or forced
 * layout. A file with no header line answers `{ headers: [] }`.
 */
export function readTextTable(input: { bytes?: Uint8Array; text?: string }, opts: Omit<ReadTableOptions, 'sheet'> = {}): TabularTable {
  const decoded = input.bytes !== undefined ? decodeTextBytes(input.bytes, opts.encoding) : { text: (input.text ?? '').replace(/^﻿/, ''), encoding: 'utf-8' as const };
  return tableOfText(decoded.text, decoded.encoding, opts);
}

function tableOfText(
  text: string,
  encoding: DetectedTextEncoding,
  opts: Pick<ReadTableOptions, 'headerRow' | 'delimiter' | 'maxRows'>,
  kindsByLine?: ReadonlyMap<number, readonly (TabularCellKind | undefined)[]>,
): TabularTable {
  const forced = {
    ...(opts.headerRow !== undefined ? { headerRow: opts.headerRow } : {}),
    ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
  };
  const layout = detectTableLayout(text, forced);
  const all = text.split(/\r\n|\r|\n/);
  const fromHeader = all.slice(layout.headerRow - 1);
  const parsed = readDelimitedRows(fromHeader.join('\n'), delimiterChar(layout.delimiter), layout.delimiter, opts.maxRows ?? TABULAR_MAX_ROWS);
  if (parsed === null) {
    return { encoding, delimiter: layout.delimiter, headerRow: layout.headerRow, headers: [], records: [], lines: [], warnings: ['no_header_row'] };
  }
  // The file line of each record, from the reader's own row loop (line k of the text from the header is file line
  // headerRow + k), so lines and kinds can never drift from the records they describe.
  const lines = parsed.rowIndex.map((k) => layout.headerRow + k);
  let kinds: Record<string, TabularCellKind>[] | undefined;
  if (kindsByLine !== undefined) {
    // A workbook's cell kinds by header, keyed exactly as the reader keyed the row (the last column of a repeated
    // name wins). A row with no kinds gets none: the money reader then refuses it rather than guess.
    kinds = parsed.rows.map((_, r) => {
      const rowKinds = kindsByLine.get(lines[r] as number);
      const out: Record<string, TabularCellKind> = {};
      if (rowKinds === undefined) return out;
      parsed.headers.forEach((h, c) => {
        const kind = rowKinds[c];
        if (h !== '' && kind !== undefined) out[h] = kind;
      });
      return out;
    });
  }
  return {
    encoding,
    delimiter: layout.delimiter,
    headerRow: layout.headerRow + Math.max(0, parsed.headerIndex),
    headers: parsed.headers.filter((h) => h !== ''),
    records: parsed.rows,
    lines,
    warnings: parsed.warnings,
    ...(parsed.overCap ? { overCap: true as const } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
  };
}

const XLSX_FAILURE_TEXT: Readonly<Record<XlsxFailureKind, string>> = {
  ole: 'this is a legacy Excel file (.xls) or an encrypted workbook: save it as xlsx (without a password) or as CSV',
  ods: 'this is an OpenDocument spreadsheet: save it as xlsx or as CSV',
  not_zip: 'this is no xlsx workbook: save it as xlsx or as CSV',
  not_workbook: 'this zip holds no Excel workbook: save it as xlsx or as CSV',
  corrupt: 'the workbook cannot be read (damaged or incomplete): save it again as xlsx or as CSV',
  sheet_not_found: 'the workbook has no worksheet of that name',
  too_large: 'the workbook unpacks to more than a statement can be: export a shorter period',
  too_many_rows: 'the worksheet has more rows than one import reads: export a shorter period',
};

/** The refusal of a table over the row cap. */
function overCapFailure(maxRows: number): TabularFailure {
  return { ok: false, code: 'too_many_rows', kind: 'too_many_rows', reason: `the file has more than ${maxRows} rows: export a shorter period`, limit: maxRows };
}

/** Read one worksheet of an XLSX workbook as a table, through the same layout detection as a CSV. */
export function readXlsxTable(bytes: Uint8Array, opts: Pick<ReadTableOptions, 'headerRow' | 'sheet' | 'maxRows' | 'maxInflatedBytes'> = {}): TabularTable | TabularFailure {
  const maxRows = opts.maxRows ?? TABULAR_MAX_ROWS;
  // The rows counted are the rows returned: the grid of the ONE chosen sheet, stopped early (a preamble above
  // the header takes a few sheet rows, the 200 the header detection may look at), then its data rows counted
  // again, exactly, in the same loop the delimited reader yields them from.
  const grid = readXlsxGrid(bytes, { ...(opts.sheet !== undefined ? { sheet: opts.sheet } : {}), maxRows: maxRows + XLSX_PREAMBLE_ROWS, maxInflatedBytes: opts.maxInflatedBytes ?? TABULAR_MAX_INFLATED_BYTES });
  if (isXlsxFailure(grid)) {
    if (grid.kind === 'too_many_rows') return overCapFailure(maxRows);
    return {
      ok: false,
      code: grid.kind === 'sheet_not_found' ? 'sheet_not_found' : grid.kind === 'too_large' ? 'too_large' : 'xls_unsupported',
      kind: grid.kind,
      reason: XLSX_FAILURE_TEXT[grid.kind],
      ...(grid.sheets !== undefined ? { sheets: [...grid.sheets] } : {}),
      ...(grid.limit !== undefined ? { limit: grid.limit } : {}),
    };
  }
  const written = xlsxGridToText(grid, { maxChars: opts.maxInflatedBytes ?? TABULAR_MAX_INFLATED_BYTES, maxLines: maxRows + XLSX_PREAMBLE_ROWS });
  if (!written.ok) {
    if (written.kind === 'too_many_rows') return overCapFailure(maxRows);
    return { ok: false, code: 'too_large', kind: 'too_large', reason: XLSX_FAILURE_TEXT.too_large, limit: written.limit };
  }
  const table = tableOfText(written.text, 'utf-8', { delimiter: 'semicolon', maxRows, ...(opts.headerRow !== undefined ? { headerRow: opts.headerRow } : {}) }, written.kinds);
  if (table.overCap === true) return overCapFailure(maxRows);
  return { ...table, warnings: [...written.warnings, ...table.warnings], container: 'xlsx', sheets: [...grid.sheets], sheet: grid.sheet, kinds: table.kinds ?? [] };
}

/**
 * What a file is, read off its bytes, never its name: an XLSX (a zip), an OLE compound file (a legacy
 * `.xls` or an encrypted workbook), or text.
 */
export function sniffTabular(bytes: Uint8Array): 'xlsx' | 'ole' | 'text' {
  const c = sniffContainer(bytes);
  return c === 'zip' ? 'xlsx' : c;
}

/**
 * Read a file as a table in the named container, or the one its bytes say (`auto`): a zip or an OLE file is
 * read as a workbook (an OLE file answers `xls_unsupported`), anything else as delimited text.
 */
export function readTable(input: { bytes?: Uint8Array; text?: string }, opts: ReadTableOptions & { container?: TabularContainer | 'auto' } = {}): TabularTable | TabularFailure {
  const container = opts.container ?? 'auto';
  const sniffed = input.bytes === undefined ? 'text' : sniffTabular(input.bytes);
  if (input.bytes !== undefined && (container === 'xlsx' || (container === 'auto' && sniffed !== 'text'))) {
    return readXlsxTable(input.bytes, {
      ...(opts.headerRow !== undefined ? { headerRow: opts.headerRow } : {}),
      ...(opts.sheet !== undefined ? { sheet: opts.sheet } : {}),
      ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
      ...(opts.maxInflatedBytes !== undefined ? { maxInflatedBytes: opts.maxInflatedBytes } : {}),
    });
  }
  if (container === 'xlsx') return { ok: false, code: 'xls_unsupported', kind: 'not_zip', reason: 'an xlsx workbook is sent as its bytes (contentBase64), never as text' };
  const maxBytes = opts.maxInflatedBytes ?? TABULAR_MAX_INFLATED_BYTES;
  const size = input.bytes !== undefined ? input.bytes.length : Buffer.byteLength(input.text ?? '', 'utf8');
  if (size > maxBytes) return { ok: false, code: 'too_large', kind: 'too_large', reason: `the file is larger than ${maxBytes} bytes: export a shorter period`, limit: maxBytes };
  const table = readTextTable(input, {
    ...(opts.headerRow !== undefined ? { headerRow: opts.headerRow } : {}),
    ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
    ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
    ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
  });
  return table.overCap === true ? overCapFailure(opts.maxRows ?? TABULAR_MAX_ROWS) : table;
}
