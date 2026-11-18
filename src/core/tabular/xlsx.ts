/**
 * A20 §13.1 (D205): an XLSX workbook read into a GRID, and that grid written out as RFC 4180 text, so a
 * bank's Excel export goes through the same layout detection and the same delimited reader as its CSV.
 *
 * The container is unpacked by the in-repo `migration/adapters/zip.ts` reader (only `node:zlib`, no
 * `node:fs`, no socket, no dependency) with a ceiling far below the migration one: a statement workbook is
 * small. The parts are read with bounded regular expressions over the inflated XML, the technique the G18
 * adapter used; G18's `migration/adapters/xlsx.ts` is now a thin wrapper over `readXlsxGrid`.
 *
 * What a cell becomes in the text:
 *  - a string (shared, inline, or a formula's cached string) as written, a line break inside it a space;
 *  - a number in a DATE style (the built-in formats 14 to 17 and 22, or a custom format with a day, month
 *    or year part) the ISO date of its serial, `date1904` honoured; a time-only style stays a number;
 *  - any other number its SHORTEST decimal text (`String(Number(v))`), so `1234.5` reads as written and
 *    float noise such as `0.30000000000000004` keeps its digits: the amount reader then finds more than
 *    two decimals and refuses the cell (`unreadable_amount`), never rounding it;
 *  - a boolean `TRUE` or `FALSE`, an error its code (`#N/A`).
 * A formula is never evaluated: its cached value is read. A legacy `.xls`, an encrypted workbook (both an
 * OLE compound file), an OpenDocument sheet or a zip that is no workbook is not read: `xls_unsupported`.
 */

import { unzip, type ZipMember } from '../migration/adapters/zip.js';

/**
 * The inflated-size ceiling of one workbook read as a table: four times the largest file a statement import
 * takes (10 MiB). It is enforced WHILE inflating (`zip.ts` hands `maxOutputLength` to zlib), so a zip bomb
 * stops at the ceiling and is never expanded whole.
 */
export const XLSX_MAX_INFLATED_BYTES = 40 * 1024 * 1024;

/** The widest table written out as text; a cell further right is dropped with a warning. */
export const XLSX_MAX_COLUMNS = 512;

export type XlsxCellKind = 'string' | 'number' | 'boolean' | 'error' | 'date' | 'blank';

/** One cell as the workbook holds it: `raw` is the cell's text exactly as stored (entities decoded). */
export interface XlsxCell {
  readonly kind: XlsxCellKind;
  readonly raw: string;
  /** The index into the workbook's `cellXfs` (its style), or null when the cell names none. */
  readonly style: number | null;
}

/** The style facts the text conversion needs: per `cellXfs` index, is it a date or a time format. */
export type XlsxStyleKind = 'date' | 'time' | 'other';

export interface XlsxGrid {
  /** Every worksheet name in workbook order. */
  readonly sheets: readonly string[];
  /** The worksheet the rows came from. */
  readonly sheet: string;
  /** The workbook counts serials from 1904-01-01 (`<workbookPr date1904="1"/>`). */
  readonly date1904: boolean;
  /** Rows by their 1-based sheet row number, cells by their 0-based column, in sheet order. */
  readonly rows: ReadonlyMap<number, ReadonlyMap<number, XlsxCell>>;
  /** Per `cellXfs` index: date, time or other. */
  readonly styles: readonly XlsxStyleKind[];
}

/** Why a workbook was not read. */
export type XlsxFailureKind = 'ole' | 'ods' | 'not_zip' | 'not_workbook' | 'corrupt' | 'sheet_not_found' | 'too_large' | 'too_many_rows';

export interface XlsxFailure {
  readonly ok: false;
  readonly kind: XlsxFailureKind;
  /** The worksheet names, when the workbook was read but the named sheet is not in it. */
  readonly sheets?: readonly string[];
  /** `too_large`: the inflated ceiling; `too_many_rows`: the row cap. */
  readonly limit?: number;
}

const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** What the first bytes of a file say it is: an OOXML or other zip, an OLE compound file, or text. */
export function sniffContainer(bytes: Uint8Array): 'zip' | 'ole' | 'text' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.length >= 4 && OLE_SIG.slice(0, 4).every((b, i) => bytes[i] === b)) return 'ole';
  return 'text';
}

function memberBytes(members: readonly ZipMember[], name: string): Uint8Array | undefined {
  return members.find((m) => m.name === name && m.bytes !== undefined)?.bytes;
}

/**
 * A member the unzip did not inflate: the ceiling (`too_large`) or a damaged or unknown member (`corrupt`).
 * `strict` (the default) refuses on ANY member, `needed` only on the parts a sheet is read from.
 */
function memberFailure(members: readonly ZipMember[], needed: readonly (string | undefined)[] | null): 'too_large' | 'corrupt' | null {
  const failed = members.filter((m) => m.error !== undefined && (needed === null || needed.includes(m.name)));
  if (failed.some((m) => m.error === 'inflated_size_exceeds_ceiling')) return 'too_large';
  return failed.length > 0 ? 'corrupt' : null;
}

/** A part as text with every element's namespace prefix removed (`<x:row>` reads as `<row>`). */
function partText(members: readonly ZipMember[], name: string): string | undefined {
  const bytes = memberBytes(members, name);
  if (bytes === undefined) return undefined;
  return new TextDecoder('utf-8').decode(bytes).replace(/<(\/?)[A-Za-z_][\w.-]{0,40}:/g, '<$1');
}

/** XML entities (named and numeric) to characters. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|quot|apos|amp);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    const code = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** OOXML's own escape for a character XML cannot carry (`_x000D_` is a carriage return). */
function decodeOoxmlEscapes(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

/**
 * A20 §13.1 (critic round 1, M2): ONE LINEAR ELEMENT SCAN instead of lazy `[\s\S]*?</tag>` patterns, which rescanned to
 * the end of the part from every unclosed opener (80'000 unclosed `<row>` in a 1.5 KB zip took 8 s, quadratically). Each
 * opener's `>` and its closing tag are found with `indexOf` FROM the opener; when one is absent no later one exists
 * either, so the scan stops there and says so (`broken`), and the caller refuses the workbook as corrupt.
 */
interface Element {
  /** The text between the name and `>` (or `/>`). */
  attrs: string;
  /** The text between `>` and the closing tag; null for a self-closing element. */
  inner: string | null;
}

function scanElements(xml: string, name: string, limit = Number.POSITIVE_INFINITY): { elements: Element[]; broken: boolean } {
  const open = `<${name}`;
  const close = `</${name}>`;
  const elements: Element[] = [];
  let pos = 0;
  for (;;) {
    if (elements.length >= limit) return { elements, broken: false };
    const at = xml.indexOf(open, pos);
    if (at < 0) return { elements, broken: false };
    const next = xml.charCodeAt(at + open.length);
    // `<rows`, `<sheets`: another element whose name merely starts the same.
    if (!(next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x2f || next === 0x3e)) {
      pos = at + open.length;
      continue;
    }
    const gt = xml.indexOf('>', at + open.length);
    if (gt < 0) return { elements, broken: true };
    if (xml.charCodeAt(gt - 1) === 0x2f) {
      elements.push({ attrs: xml.slice(at + open.length, gt - 1), inner: null });
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return { elements, broken: true };
    elements.push({ attrs: xml.slice(at + open.length, gt), inner: xml.slice(gt + 1, end) });
    pos = end + close.length;
  }
}

/** A part was cut off inside an element: the workbook cannot be read as written. */
class BrokenPart extends Error {}

function elementsOf(xml: string, name: string): Element[] {
  const scan = scanElements(xml, name);
  if (scan.broken) throw new BrokenPart(name);
  return scan.elements;
}

/** The first element of a name, or undefined. */
function firstOf(xml: string, name: string): Element | undefined {
  return elementsOf(xml, name)[0];
}

/** The text of a rich or plain string body: its `<t>` runs, the phonetic `<rPh>` runs left out. */
function runsOf(body: string): string {
  // The phonetic runs carry their own `<t>`: they are cut out first, by the same scan.
  let plain = body;
  if (body.includes('<rPh')) {
    let out = '';
    let pos = 0;
    for (;;) {
      const at = plain.indexOf('<rPh', pos);
      if (at < 0) break;
      const end = plain.indexOf('</rPh>', at);
      if (end < 0) throw new BrokenPart('rPh');
      out += plain.slice(pos, at);
      pos = end + '</rPh>'.length;
    }
    plain = out + plain.slice(pos);
  }
  let s = '';
  for (const t of elementsOf(plain, 't')) s += t.inner ?? '';
  return decodeOoxmlEscapes(decodeXmlEntities(s));
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  return elementsOf(xml, 'si').map((si) => runsOf(si.inner ?? ''));
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m?.[1];
}

/** The built-in number formats that are dates (ECMA-376 Part 1 §18.8.30): 14 to 17, and 22 (a date with a time). */
export const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([14, 15, 16, 17, 22]);
/** The built-in time-only formats (18 to 21, 45 to 47). */
export const BUILTIN_TIME_FORMATS: ReadonlySet<number> = new Set([18, 19, 20, 21, 45, 46, 47]);

/**
 * A custom format code: a date when it names a day, month or year; a time when only hours, minutes or seconds.
 * Critic round 1, L3: only letter runs made of date and time tokens count (`dd`, `mmm`, `yyyy`, `h`, `ss`); a
 * literal word (`USD`, `CHF`, `General`, the `E` of a scientific format, `AM/PM`) says nothing about it.
 */
export function formatKindOf(code: string): XlsxStyleKind {
  // An elapsed-time section (`[h]:mm`, `[mm]:ss`) is a duration, never a date.
  if (/\[(h+|m+|s+)\]/i.test(code)) return 'time';
  // Quoted literals, escaped characters, `[Red]` or `[$-407]` sections and a fill character say nothing about it.
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[_*]./g, '')
    .toLowerCase()
    .replace(/[a-z]+/g, (run) => (/^[dmyhs]+$/.test(run) ? run : ' '));
  const section = bare.split(';')[0] ?? '';
  if (/[dy]/.test(section)) return 'date';
  if (/[hs]/.test(section)) return 'time';
  // An `m` without hours or seconds next to it is a month.
  if (/m/.test(section)) return 'date';
  return 'other';
}

function parseStyles(xml: string | undefined): XlsxStyleKind[] {
  if (xml === undefined) return [];
  const custom = new Map<number, string>();
  for (const f of elementsOf(xml, 'numFmt')) {
    const id = Number(attr(f.attrs, 'numFmtId'));
    const code = attr(f.attrs, 'formatCode');
    if (Number.isSafeInteger(id) && code !== undefined) custom.set(id, decodeXmlEntities(code));
  }
  const cellXfs = firstOf(xml, 'cellXfs')?.inner ?? '';
  return elementsOf(cellXfs, 'xf').map((xf) => {
    const id = Number(attr(xf.attrs, 'numFmtId') ?? '0');
    const code = custom.get(id);
    if (code !== undefined) return formatKindOf(code);
    if (BUILTIN_DATE_FORMATS.has(id)) return 'date';
    if (BUILTIN_TIME_FORMATS.has(id)) return 'time';
    return 'other';
  });
}

/** The worksheet catalog (name and relationship id), in workbook order. */
function parseWorkbookSheets(xml: string): { name: string; rid: string }[] {
  const out: { name: string; rid: string }[] = [];
  for (const s of elementsOf(xml, 'sheet')) {
    const name = attr(s.attrs, 'name');
    const rid = /\br:id="([^"]*)"/.exec(s.attrs)?.[1] ?? attr(s.attrs, 'id');
    if (name !== undefined && rid !== undefined) out.push({ name: decodeXmlEntities(name), rid });
  }
  return out;
}

/** A relationship id to its part path under `xl/`. */
function parseRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (xml === undefined) return map;
  for (const r of elementsOf(xml, 'Relationship')) {
    const id = attr(r.attrs, 'Id');
    const target = attr(r.attrs, 'Target');
    if (id === undefined || target === undefined) continue;
    map.set(id, `xl/${target.replace(/^\/?/, '').replace(/^xl\//, '')}`);
  }
  return map;
}

/** A1-style column letters to a zero-based index (A is 0, AA is 26), or -1 when there are none. */
function colIndex(ref: string): number {
  const letters = /^[A-Z]{1,3}/.exec(ref)?.[0] ?? '';
  if (letters === '') return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellOf(attrs: string, inner: string, shared: readonly string[]): XlsxCell {
  const t = attr(attrs, 't') ?? 'n';
  const s = attr(attrs, 's');
  const style = s === undefined || !/^\d{1,6}$/.test(s) ? null : Number(s);
  if (t === 'inlineStr') {
    const body = firstOf(inner, 'is')?.inner ?? '';
    return { kind: 'string', raw: runsOf(body), style };
  }
  // The CACHED value is read even for a formula cell; the formula is never evaluated.
  const v = firstOf(inner, 'v')?.inner ?? undefined;
  if (v === undefined) return { kind: 'blank', raw: '', style };
  if (t === 's') {
    const idx = Number(v);
    return { kind: 'string', raw: Number.isInteger(idx) && idx >= 0 && idx < shared.length ? (shared[idx] as string) : '', style };
  }
  if (t === 'b') return { kind: 'boolean', raw: v === '1' ? 'TRUE' : 'FALSE', style };
  if (t === 'e') return { kind: 'error', raw: decodeXmlEntities(v), style };
  if (t === 'str') return { kind: 'string', raw: decodeOoxmlEscapes(decodeXmlEntities(v)), style };
  if (t === 'd') return { kind: 'date', raw: decodeXmlEntities(v).trim(), style };
  return { kind: 'number', raw: decodeXmlEntities(v).trim(), style };
}

/** Rows by number; null when the sheet holds more than `maxRows` rows (reading stops at the first one over). */
function parseSheetRows(xml: string, shared: readonly string[], maxRows: number): Map<number, Map<number, XlsxCell>> | null {
  const rows = new Map<number, Map<number, XlsxCell>>();
  const sheetData = firstOf(xml, 'sheetData')?.inner ?? '';
  let lastRow = 0;
  // The scan stops at the first row over the cap, so the cap bounds the reading itself.
  const scan = scanElements(sheetData, 'row', maxRows + 1);
  if (scan.broken) throw new BrokenPart('row');
  for (const first of scan.elements) {
    const rAttr = attr(first.attrs, 'r');
    const rowNumber = rAttr !== undefined && /^\d{1,7}$/.test(rAttr) ? Number(rAttr) : lastRow + 1;
    lastRow = rowNumber;
    const cells = rows.get(rowNumber) ?? new Map<number, XlsxCell>();
    let lastCol = -1;
    for (const c of elementsOf(first.inner ?? '', 'c')) {
      const ref = attr(c.attrs, 'r');
      const col = ref === undefined ? lastCol + 1 : colIndex(ref);
      if (col < 0) continue;
      lastCol = col;
      cells.set(col, cellOf(c.attrs, c.inner ?? '', shared));
    }
    rows.set(rowNumber, cells);
    if (rows.size > maxRows) return null;
  }
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

export interface ReadXlsxGridOptions {
  /** The worksheet to read (the first by default). */
  sheet?: string;
  /** The inflated-size ceiling across all members, enforced WHILE inflating (default `XLSX_MAX_INFLATED_BYTES`). */
  maxInflatedBytes?: number;
  /** The most `<row>` elements read from the sheet; reading stops at the first one over (default: no cap). */
  maxRows?: number;
  /** Refuse when ANY member failed to inflate (default true); false refuses only on the parts the sheet needs (G18). */
  strictMembers?: boolean;
}

/** Read one worksheet of an XLSX workbook into a grid: the first by default, `sheet` by name. Never throws. */
export function readXlsxGrid(bytes: Uint8Array, opts: ReadXlsxGridOptions = {}): XlsxGrid | XlsxFailure {
  const container = sniffContainer(bytes);
  if (container === 'ole') return { ok: false, kind: 'ole' };
  const maxInflated = opts.maxInflatedBytes ?? XLSX_MAX_INFLATED_BYTES;
  const strict = opts.strictMembers !== false;
  // The ceiling goes INTO the unzip: nothing is inflated past it, and nothing is inflated twice.
  const zip = unzip(bytes, { maxTotal: maxInflated });
  if (!zip.ok) return { ok: false, kind: 'not_zip' };
  const mimetype = memberBytes(zip.members, 'mimetype');
  if (mimetype !== undefined && new TextDecoder('utf-8').decode(mimetype).startsWith('application/vnd.oasis.opendocument')) return { ok: false, kind: 'ods' };
  const failedEarly = memberFailure(zip.members, strict ? null : ['xl/workbook.xml']);
  if (failedEarly !== null) return failedEarly === 'too_large' ? { ok: false, kind: 'too_large', limit: maxInflated } : { ok: false, kind: 'corrupt' };
  const workbook = partText(zip.members, 'xl/workbook.xml');
  if (workbook === undefined) {
    return { ok: false, kind: zip.members.some((m) => m.name === 'xl/workbook.xml') ? 'corrupt' : 'not_workbook' };
  }
  try {
    return gridOf(zip.members, workbook, opts, maxInflated, strict);
  } catch (e) {
    // A part cut off inside an element (M2): refused as damaged, after a linear scan.
    if (e instanceof BrokenPart) return { ok: false, kind: 'corrupt' };
    throw e;
  }
}

function gridOf(members: readonly ZipMember[], workbook: string, opts: ReadXlsxGridOptions, maxInflated: number, strict: boolean): XlsxGrid | XlsxFailure {
  const sheets = parseWorkbookSheets(workbook);
  if (sheets.length === 0) return { ok: false, kind: 'corrupt' };
  const names = sheets.map((s) => s.name);
  const chosen = opts.sheet !== undefined ? sheets.find((s) => s.name === opts.sheet) : sheets[0];
  if (chosen === undefined) return { ok: false, kind: 'sheet_not_found', sheets: names };
  const rels = parseRels(partText(members, 'xl/_rels/workbook.xml.rels'));
  const path = rels.get(chosen.rid);
  const failedPart = strict ? null : memberFailure(members, [path, 'xl/sharedStrings.xml', 'xl/styles.xml']);
  if (failedPart === 'too_large') return { ok: false, kind: 'too_large', limit: maxInflated };
  const sheetXml = path === undefined ? undefined : partText(members, path);
  if (sheetXml === undefined) return { ok: false, kind: 'corrupt' };
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows = parseSheetRows(sheetXml, parseSharedStrings(partText(members, 'xl/sharedStrings.xml')), maxRows);
  if (rows === null) return { ok: false, kind: 'too_many_rows', limit: maxRows };
  const d1904 = attr(firstOf(workbook, 'workbookPr')?.attrs ?? '', 'date1904');
  return {
    sheets: names,
    sheet: chosen.name,
    date1904: d1904 === '1' || d1904 === 'true',
    rows,
    styles: parseStyles(partText(members, 'xl/styles.xml')),
  };
}

export function isXlsxFailure(r: XlsxGrid | XlsxFailure): r is XlsxFailure {
  return (r as XlsxFailure).ok === false;
}

const DAY_MS = 86_400_000;

/** The ISO date of a date serial, or null when the serial names no real day (the 1900 system's 29.02.1900 is none). */
export function serialToIsoDate(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const days = Math.floor(serial);
  let base: number;
  if (date1904) base = Date.UTC(1904, 0, 1);
  else if (days >= 61) base = Date.UTC(1899, 11, 30);
  else if (days >= 1 && days < 60) base = Date.UTC(1899, 11, 31);
  else return null;
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** A number's shortest decimal text (`1234.5`, `0.30000000000000004`), or the raw text when it is not a number. */
export function shortestDecimal(raw: string): string {
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return Object.is(n, -0) ? '0' : String(n);
}

/**
 * The longest text one cell contributes. A bank cell is short (an amount or a date is unreadable past 64
 * characters); a longer one is cut here BEFORE it is copied, so a shared string referenced by every cell
 * cannot multiply a huge string.
 */
export const XLSX_CELL_MAX_CHARS = 1024;

/** How many sheet rows above the data the text may carry (a preamble and the header). */
export const XLSX_PREAMBLE_ROWS = 200;

/** One cell as the text a CSV of the same sheet would carry, at most `XLSX_CELL_MAX_CHARS` characters. */
export function cellText(cell: XlsxCell, grid: Pick<XlsxGrid, 'date1904' | 'styles'>): string {
  switch (cell.kind) {
    case 'blank':
      return '';
    case 'string':
    case 'error':
    case 'boolean':
      return cell.raw.slice(0, XLSX_CELL_MAX_CHARS).replace(/\r\n|\r|\n/g, ' ');
    case 'date': {
      const iso = /^(\d{4}-\d{2}-\d{2})/.exec(cell.raw.slice(0, 64))?.[1];
      return iso ?? cell.raw.slice(0, XLSX_CELL_MAX_CHARS);
    }
    case 'number': {
      const raw = cell.raw.slice(0, XLSX_CELL_MAX_CHARS);
      const kind = cell.style === null ? 'other' : (grid.styles[cell.style] ?? 'other');
      if (kind === 'date') {
        const iso = serialToIsoDate(Number(raw), grid.date1904);
        if (iso !== null) return iso;
      }
      return shortestDecimal(raw);
    }
  }
}

/** One RFC 4180 field: always quoted, a quote doubled. */
function quoted(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** The limits of writing a grid out as text. */
export interface GridTextLimits {
  /** The most characters of text written (default `XLSX_MAX_INFLATED_BYTES`): the text never outgrows the unpacked file's own budget. */
  maxChars?: number;
  /** The most sheet rows written (the data cap plus `XLSX_PREAMBLE_ROWS`; default: no cap). */
  maxLines?: number;
}

/**
 * A20 §13.1 (critic round 1, H1): what a cell IS, carried out of the grid beside its text. A `number` cell's text is
 * point-decimal whatever the mapping says (it is the workbook's own number, never locale text); only a `text` cell
 * is read with the mapping's decimal separator; a `date` cell is an ISO date.
 */
export type TabularCellKind = 'number' | 'text' | 'date';

/** The kind of one cell as `cellText` writes it. */
export function cellKindOf(cell: XlsxCell, grid: Pick<XlsxGrid, 'date1904' | 'styles'>): TabularCellKind {
  if (cell.kind === 'date') return 'date';
  if (cell.kind !== 'number') return 'text';
  const style = cell.style === null ? 'other' : (grid.styles[cell.style] ?? 'other');
  if (style === 'date' && serialToIsoDate(Number(cell.raw.slice(0, XLSX_CELL_MAX_CHARS)), grid.date1904) !== null) return 'date';
  return 'number';
}

export type GridText =
  | { ok: true; text: string; warnings: string[]; kinds: ReadonlyMap<number, readonly (TabularCellKind | undefined)[]> }
  | { ok: false; kind: 'too_large' | 'too_many_rows'; limit: number };

/**
 * The grid as `;`-separated RFC 4180 text, one line per sheet row from row 1 to the last (an empty row an
 * empty line, so a line number IS the sheet's row number), every row padded to the widest one as a
 * spreadsheet's own CSV export does. Nothing here can amplify past the limits (critic, D205): the width
 * is read from the cells that hold text and is at most `XLSX_MAX_COLUMNS` (a filled cell further right
 * refuses `too_large`), the last row is at most `maxLines` (a cell further down refuses `too_many_rows`),
 * rows times width is checked before a line is written, every cell is cut at `XLSX_CELL_MAX_CHARS`, and the
 * text written is counted as it grows and stops at `maxChars` (`too_large`).
 */
export function xlsxGridToText(grid: XlsxGrid, limits: GridTextLimits = {}): GridText {
  const maxChars = limits.maxChars ?? XLSX_MAX_INFLATED_BYTES;
  const maxLines = limits.maxLines ?? Number.POSITIVE_INFINITY;
  const warnings: string[] = [];
  let width = 0;
  let last = 0;
  for (const [r, cells] of grid.rows) {
    let filled = false;
    for (const [col, cell] of cells) {
      // Whether a cell holds text is read off its raw value: no text is built for the width.
      if (cell.kind === 'blank' || cell.raw === '') continue;
      filled = true;
      if (col >= XLSX_MAX_COLUMNS) return { ok: false, kind: 'too_large', limit: XLSX_MAX_COLUMNS };
      if (col + 1 > width) width = col + 1;
    }
    if (filled && r > last) last = r;
  }
  if (last > maxLines) return { ok: false, kind: 'too_many_rows', limit: maxLines };
  // Every written cell costs at least its two quotes and a separator.
  if (last * width * 3 > maxChars) return { ok: false, kind: 'too_large', limit: maxChars };
  const lines: string[] = [];
  const kinds = new Map<number, (TabularCellKind | undefined)[]>();
  let written = 0;
  let cut = false;
  for (let r = 1; r <= last; r += 1) {
    const cells = grid.rows.get(r);
    if (cells === undefined) {
      lines.push('');
      written += 1;
      continue;
    }
    const values: string[] = [];
    // WP2 critic L4: a cell the sheet does not hold has NO kind (absent), never a default `text`.
    const rowKinds: (TabularCellKind | undefined)[] = [];
    let rowChars = 0;
    for (let c = 0; c < width; c += 1) {
      const cell = cells.get(c);
      if (cell !== undefined && cell.raw.length > XLSX_CELL_MAX_CHARS) cut = true;
      const v = cell === undefined ? '' : cellText(cell, grid).trim();
      rowKinds.push(cell === undefined ? undefined : cellKindOf(cell, grid));
      rowChars += v.length + 3;
      if (written + rowChars > maxChars) return { ok: false, kind: 'too_large', limit: maxChars };
      values.push(v);
    }
    const line = values.every((v) => v === '') ? '' : values.map(quoted).join(';');
    written += line.length + 1;
    if (written > maxChars) return { ok: false, kind: 'too_large', limit: maxChars };
    lines.push(line);
    kinds.set(r, rowKinds);
  }
  if (cut) warnings.push(`xlsx: a cell longer than ${XLSX_CELL_MAX_CHARS} characters is cut there`);
  return { ok: true, text: lines.join('\n'), warnings, kinds };
}
