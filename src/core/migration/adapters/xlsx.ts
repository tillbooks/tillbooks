/**
 * The xlsx adapter (G18 US-G18.2), a PURE parser over bytes. Since A20 §13.1 (D205) the workbook is
 * read by the tabular layer's grid reader (`src/core/tabular/xlsx.ts`) and this module keeps G18's row
 * shape. An `.xlsx` file is an Open Packaging Convention zip of XML parts, so this unpacks it with the shared `zip.ts` reader (which uses only
 * `node:zlib`, no `fs`/socket) and reads the worksheet XML with the same regex technique the AbaConnect
 * arm uses. NO `node:fs`, NO socket, NO new dependency: a minimal typed reader, exactly what the spec
 * asks for ("a vendored/typed minimal parser").
 *
 * It parses the FIRST worksheet by default and reports the others by name, so the Studio can offer a
 * per-file worksheet choice (US-G18.2). Typed cells are read where the file carries a type: shared and
 * inline strings, numbers, booleans, and the CACHED value of a formula cell (the formula is never
 * evaluated, spec §2 boundary). Merged cells carry their value in the top-left cell only, which is what
 * reading the raw cells yields. A password-protected workbook is an OLE/CFB compound file, not a zip,
 * so it is reported `encrypted`; a truncated or malformed zip is reported `corrupt`; a chosen sheet
 * with a header and no data rows yields `rowCount:0` (G09's empty contract).
 */

import type { ParseResult, ParseFailure } from './parse.js';
import { isXlsxFailure, readXlsxGrid } from '../../tabular/xlsx.js';
import { MAX_INFLATED_BYTES } from './zip.js';

/** The result of an xlsx parse carries the worksheet catalog alongside the chosen sheet's rows. */
export interface XlsxParseResult extends ParseResult {
  /** Every worksheet name in workbook order, so a per-file worksheet choice can be offered. */
  readonly worksheets: readonly string[];
  /** The worksheet these rows came from. */
  readonly worksheet: string;
}

/**
 * Parse an xlsx workbook. Reads the chosen worksheet (the first by default), reports every worksheet
 * name, and returns the rows plus the standard `ParseResult` fields. `asAt` is null: xlsx carries no
 * standard generation date in its cells (a spreadsheet's own date lives in a cell the map addresses).
 *
 * A20 §13.1 (D205): a thin wrapper over the tabular layer's grid reader (`tabular/xlsx.ts`). Its G18
 * behaviour is unchanged: the first row with any cell is the header, every cell is its text as stored
 * (a number's own digits, never a date conversion), and the failures keep their names (`encrypted`,
 * `corrupt`, `worksheet_not_found`) under the migration ceiling.
 */
export function parseXlsx(bytes: Uint8Array, opts: { sheet?: string } = {}): XlsxParseResult | ParseFailure {
  const grid = readXlsxGrid(bytes, { ...(opts.sheet !== undefined ? { sheet: opts.sheet } : {}), maxInflatedBytes: MAX_INFLATED_BYTES, strictMembers: false });
  if (isXlsxFailure(grid)) {
    if (grid.kind === 'ole') return { ok: false, reason: 'encrypted' };
    if (grid.kind === 'sheet_not_found') return { ok: false, reason: 'worksheet_not_found' };
    return { ok: false, reason: 'corrupt' };
  }
  // The first row with any cell is the header; empty leading rows are skipped.
  const rows = [...grid.rows.values()].filter((r) => r.size > 0);
  const headerRow = rows[0];
  if (headerRow === undefined) return { headers: [], rows: [], warnings: [], asAt: null, worksheets: grid.sheets, worksheet: grid.sheet };
  let maxCol = 0;
  for (const c of headerRow.keys()) if (c > maxCol) maxCol = c;
  const headers: string[] = [];
  for (let i = 0; i <= maxCol; i++) headers.push((headerRow.get(i)?.raw ?? '').trim());
  const data = rows.slice(1).map((r) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '') row[h] = r.get(i)?.raw ?? '';
    });
    return row;
  });
  return { headers: headers.filter((h) => h !== ''), rows: data, warnings: [], asAt: null, worksheets: grid.sheets, worksheet: grid.sheet };
}
