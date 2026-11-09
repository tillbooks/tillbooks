/**
 * The xlsx adapter (G18 US-G18.2), a PURE parser over bytes. An `.xlsx` file is an Open Packaging
 * Convention zip of XML parts, so this unpacks it with the shared `zip.ts` reader (which uses only
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
import { unzip, type ZipMember } from './zip.js';

/** The result of an xlsx parse carries the worksheet catalog alongside the chosen sheet's rows. */
export interface XlsxParseResult extends ParseResult {
  /** Every worksheet name in workbook order, so a per-file worksheet choice can be offered. */
  readonly worksheets: readonly string[];
  /** The worksheet these rows came from. */
  readonly worksheet: string;
}

const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0];

function looksEncrypted(bytes: Uint8Array): boolean {
  return OLE_SIG.every((byte, i) => bytes[i] === byte);
}

function memberByName(members: readonly ZipMember[], name: string): Uint8Array | undefined {
  const m = members.find((x) => x.name === name && x.bytes !== undefined);
  return m?.bytes;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The shared-string table: each `<si>` collapses its (possibly rich-text) `<t>` runs into one string. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const body = m[1] as string;
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    let s = '';
    while ((t = tRe.exec(body)) !== null) s += t[1] as string;
    out.push(decodeEntities(s));
  }
  return out;
}

/** The worksheet catalog from workbook.xml (name + relationship id), in document (workbook) order. */
function parseWorkbookSheets(xml: string): Array<{ name: string; rid: string }> {
  const out: Array<{ name: string; rid: string }> = [];
  const re = /<sheet\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] as string;
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    const rid = /r:id="([^"]*)"/.exec(attrs)?.[1];
    if (name !== undefined && rid !== undefined) out.push({ name: decodeEntities(name), rid });
  }
  return out;
}

/** Map a relationship id to its worksheet part path, from workbook.xml.rels. */
function parseRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (xml === undefined) return map;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] as string;
    const id = /Id="([^"]*)"/.exec(attrs)?.[1];
    let target = /Target="([^"]*)"/.exec(attrs)?.[1];
    if (id === undefined || target === undefined) continue;
    target = target.replace(/^\/?/, '').replace(/^xl\//, '');
    map.set(id, target.startsWith('worksheets/') ? `xl/${target}` : `xl/${target}`);
  }
  return map;
}

/** A1-style column letters to a zero-based index: A->0, B->1, AA->26. */
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The value of one `<c>` cell: shared/inline strings, numbers, booleans, and cached formula values. */
function cellValue(cellXml: string, shared: readonly string[]): string {
  const t = /\bt="([^"]*)"/.exec(cellXml)?.[1] ?? 'n';
  if (t === 'inlineStr') {
    const isBody = /<is>([\s\S]*?)<\/is>/.exec(cellXml)?.[1] ?? '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let s = '';
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(isBody)) !== null) s += m[1] as string;
    return decodeEntities(s);
  }
  // The CACHED value in <v> is read even for a formula cell; the <f> formula is never evaluated.
  const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
  if (v === undefined) return '';
  if (t === 's') {
    const idx = Number(v);
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? (shared[idx] as string) : '';
  }
  if (t === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  // 'str' (formula string result), 'n' (number), 'e' (error): the text as the file carries it.
  return decodeEntities(v);
}

/** Parse one worksheet part into a header row and data rows. */
function parseSheet(xml: string, shared: readonly string[]): { headers: string[]; rows: Record<string, string>[] } {
  const sheetData = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const parsedRows: Array<Map<number, string>> = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetData)) !== null) {
    const body = rm[1] as string;
    const cells = new Map<number, string>();
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(body)) !== null) {
      const attrs = cm[1] as string;
      const inner = cm[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (ref === undefined) continue;
      cells.set(colIndex(ref), cellValue(`${attrs}>${inner}`, shared));
    }
    parsedRows.push(cells);
  }
  // The first row with any cell is the header; empty leading rows are skipped.
  const headerRow = parsedRows.find((r) => r.size > 0);
  if (headerRow === undefined) return { headers: [], rows: [] };
  const maxCol = Math.max(...headerRow.keys());
  const headers: string[] = [];
  for (let i = 0; i <= maxCol; i++) headers.push((headerRow.get(i) ?? '').trim());
  const rows: Record<string, string>[] = [];
  let headerSeen = false;
  for (const r of parsedRows) {
    if (r.size === 0) continue;
    if (!headerSeen) {
      headerSeen = true;
      continue; // this is the header row itself
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '') row[h] = r.get(i) ?? '';
    });
    rows.push(row);
  }
  return { headers: headers.filter((h) => h !== ''), rows };
}

/**
 * Parse an xlsx workbook. Reads the chosen worksheet (the first by default), reports every worksheet
 * name, and returns the rows plus the standard `ParseResult` fields. `asAt` is null: xlsx carries no
 * standard generation date in its cells (a spreadsheet's own date lives in a cell the map addresses).
 */
export function parseXlsx(bytes: Uint8Array, opts: { sheet?: string } = {}): XlsxParseResult | ParseFailure {
  if (looksEncrypted(bytes)) return { ok: false, reason: 'encrypted' };
  const zip = unzip(bytes);
  if (!zip.ok) {
    // Not a zip and not an OLE compound file: a truncated or malformed workbook.
    return { ok: false, reason: 'corrupt' };
  }
  const workbookXml = memberByName(zip.members, 'xl/workbook.xml');
  if (workbookXml === undefined) return { ok: false, reason: 'corrupt' };
  const shared = parseSharedStrings(memberByName(zip.members, 'xl/sharedStrings.xml') ? text(memberByName(zip.members, 'xl/sharedStrings.xml') as Uint8Array) : undefined);
  const rels = parseRels(memberByName(zip.members, 'xl/_rels/workbook.xml.rels') ? text(memberByName(zip.members, 'xl/_rels/workbook.xml.rels') as Uint8Array) : undefined);
  const sheets = parseWorkbookSheets(text(workbookXml));
  const worksheets = sheets.map((s) => s.name);
  if (sheets.length === 0) return { ok: false, reason: 'corrupt' };

  const chosen = opts.sheet !== undefined ? sheets.find((s) => s.name === opts.sheet) : sheets[0];
  if (chosen === undefined) return { ok: false, reason: 'worksheet_not_found' };
  const partPath = rels.get(chosen.rid);
  const sheetBytes = partPath !== undefined ? memberByName(zip.members, partPath) : undefined;
  if (sheetBytes === undefined) return { ok: false, reason: 'corrupt' };

  const { headers, rows } = parseSheet(text(sheetBytes), shared);
  return { headers, rows, warnings: [], asAt: null, worksheets, worksheet: chosen.name };
}
