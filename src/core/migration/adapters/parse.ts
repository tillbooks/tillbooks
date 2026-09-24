/**
 * G09 source adapters, the PURE half: `parse(bytes, dataClass) -> {rows, warnings, asAt}`, over
 * bytes and NEVER over paths (spec §4, "Adapters, pure over bytes, never over paths").
 *
 * This resolves the contradiction the review found: the OSS core does no file I/O and takes
 * pre-parsed rows (A04 §10, `contactImport.ts`), while G03 assumed the engine reads files. Files
 * enter through E00; an adapter is handed the BYTES E00 read back and returns rows. There is NO
 * `node:fs` import anywhere under this directory, asserted by the adapter-purity test (spec §7), so
 * the core's no-file-I/O property stays intact and the adapters are trivially testable over fixtures.
 *
 * The generic adapter reads RFC 4180 CSV (and its tab-separated sibling), detecting the delimiter
 * from the header line: comma, semicolon (the ch-de default many ERPs export) or tab. It carries no
 * embedded generated date, so `asAt` is `null`, which US-G09.1's boundary requires G11 to surface as
 * `not_computable` rather than a guess. A format that DOES carry an as-of date (camt, SAF-T) sets it.
 */

import { parseXlsx } from './xlsx.js';
import { parseAbaConnect } from './xml.js';
import { NOT_YET_READABLE_ADAPTERS } from './registry.js';

/** One parsed row: the source header names mapped to their string cell values, unmapped fields kept. */
export type ParsedRow = Readonly<Record<string, string>>;

export interface ParseResult {
  /** The header names, in source order, for the discovery header sample and the column map. */
  readonly headers: readonly string[];
  /** One object per data row. Empty when the file is a header with no rows (US-G09.1 empty case). */
  readonly rows: readonly ParsedRow[];
  /** Non-fatal notes (a short row, a blank line skipped). Never throws for recoverable input. */
  readonly warnings: readonly string[];
  /** The file's own generated/as-of date where the format carries one; null when it does not. */
  readonly asAt: string | null;
  /** For a workbook format (xlsx): every worksheet name, so a per-file worksheet choice can be offered. */
  readonly worksheets?: readonly string[];
  /** For a workbook format (xlsx): which worksheet these rows came from. */
  readonly worksheet?: string;
}

/** A parse that could not proceed at all: the US-G09.1 `source_unparseable` recovery reads these. */
export interface ParseFailure {
  readonly ok: false;
  readonly reason: string;
  readonly detectedEncoding?: string;
  readonly detectedDelimiter?: string;
}

const DELIMITERS: readonly { readonly ch: string; readonly name: string }[] = [
  { ch: ',', name: 'comma' },
  { ch: ';', name: 'semicolon' },
  { ch: '\t', name: 'tab' },
];

/** The delimiter NAMES a K-15 override may force, single-sourced from `DELIMITERS`. */
export const DELIMITER_NAMES: readonly string[] = DELIMITERS.map((d) => d.name);

/** The separator character for a delimiter NAME (`semicolon` -> `;`), or undefined for an unknown name. */
export function delimiterCharFor(name: string): string | undefined {
  return DELIMITERS.find((d) => d.name === name)?.ch;
}

/**
 * The text encodings the generic reader can be FORCED to decode with (the K-15 override). Auto-decoding
 * is always UTF-8 (tolerating a BOM); an operator whose export is a legacy single-byte encoding names
 * one of these to re-decode a file UTF-8 turned to mojibake. These are WHATWG encoding labels the
 * platform `TextDecoder` accepts; `latin1` and `windows-1252` both resolve to the windows-1252 decoder.
 * This is the engine's single source for the set, so the verb validates against it and never guesses.
 */
export const SOURCE_ENCODINGS = ['utf-8', 'latin1', 'windows-1252'] as const;
export type SourceEncoding = (typeof SOURCE_ENCODINGS)[number];

/** Is `x` an encoding the generic reader can be forced to (K-15)? Narrows to `SourceEncoding`. */
export function isSourceEncoding(x: unknown): x is SourceEncoding {
  return typeof x === 'string' && (SOURCE_ENCODINGS as readonly string[]).includes(x);
}

/**
 * Decode bytes as text, tolerating a BOM. The encoding defaults to UTF-8 (the auto path, byte-for-byte
 * the historical behaviour); a K-15 override names a validated `SourceEncoding` to re-decode a legacy
 * single-byte export. A wrong-encoding file was always the caller's re-parse control; the override is
 * how that control is now actually exercised.
 */
function decode(bytes: Uint8Array, encoding: SourceEncoding = 'utf-8'): string {
  const text = new TextDecoder(encoding).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Pick the delimiter whose count in the header line is highest and non-zero. */
function detectDelimiter(headerLine: string): { ch: string; name: string } | undefined {
  let best: { ch: string; name: string; count: number } | undefined;
  for (const d of DELIMITERS) {
    const count = headerLine.split(d.ch).length - 1;
    if (count > 0 && (best === undefined || count > best.count)) best = { ...d, count };
  }
  return best === undefined ? undefined : { ch: best.ch, name: best.name };
}

/**
 * Split a delimited line honouring RFC 4180 double-quote quoting: a quoted field may contain the
 * delimiter and escaped quotes (`""`). Deliberately small: the generic path is a safety net, not a
 * full CSV engine, and a vendor with a stranger dialect gets its own adapter (spec §4).
 */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Parse a generic CSV/TSV blob. Returns a `ParseFailure` only when there is genuinely nothing to
 * classify (no header line at all); an empty data section is a valid `rows:[]`, never a failure.
 */
export function parseGenericCsv(bytes: Uint8Array, opts?: { encoding?: SourceEncoding | undefined; delimiter?: string | undefined }): ParseResult | ParseFailure {
  const encoding = opts?.encoding ?? 'utf-8';
  const text = decode(bytes, encoding);
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines = rawLines.filter((l, i) => !(l.trim() === '' && i >= rawLines.length - 1));
  const headerLine = lines.find((l) => l.trim() !== '');
  if (headerLine === undefined) {
    return { ok: false, reason: 'no_header_row', detectedEncoding: encoding };
  }
  // K-15: a forced delimiter skips detection and parses with EXACTLY that separator, correcting a wrong
  // sniff. An unknown name (already refused by the verb) falls back to auto-detection here defensively.
  if (opts?.delimiter !== undefined) {
    const forced = delimiterCharFor(opts.delimiter);
    if (forced !== undefined) return parseWithDelimiter(lines, headerLine, forced, opts.delimiter);
  }
  const delim = detectDelimiter(headerLine);
  if (delim === undefined) {
    // A single-column file is legal: one header, one value per row, comma as the nominal delimiter.
    return parseWithDelimiter(lines, headerLine, ',', 'comma');
  }
  return parseWithDelimiter(lines, headerLine, delim.ch, delim.name);
}

function parseWithDelimiter(lines: readonly string[], headerLine: string, delim: string, delimName: string): ParseResult {
  const headers = splitLine(headerLine, delim);
  const warnings: string[] = [];
  const rows: ParsedRow[] = [];
  let headerSeen = false;
  for (const line of lines) {
    if (!headerSeen) {
      if (line === headerLine) headerSeen = true;
      continue;
    }
    if (line.trim() === '') continue;
    const cells = splitLine(line, delim);
    if (cells.length !== headers.length) {
      warnings.push(`row width ${cells.length} != header width ${headers.length} (${delimName})`);
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '') row[h] = cells[i] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows, warnings, asAt: null };
}

/**
 * Dispatch a parse to the adapter named by `adapterId`. The generic adapters (`csv`, `tsv`) both
 * route to `parseGenericCsv`, which auto-detects the delimiter; a vendor adapter would branch here.
 * `dataClass` is accepted for the adapter that needs it (SAF-T yields different rows per class) and
 * ignored by the generic one, which returns whatever the file holds.
 */
export function parseSource(
  adapterId: string,
  bytes: Uint8Array,
  _dataClass?: string,
  opts?: { sheet?: string | undefined; encoding?: SourceEncoding | undefined; delimiter?: string | undefined },
): ParseResult | ParseFailure {
  // A "not yet readable" vendor row is registered honestly (it appears in the catalog and carries a
  // cleanRoomSource) but has NO parser: guessing a parse from an unverified format would be exactly the
  // defect US-G18.5 forbids, so it refuses rather than degrade to a guess (spec §2, Topal boundary).
  if (NOT_YET_READABLE_ADAPTERS.has(adapterId)) {
    return { ok: false, reason: 'not_yet_readable' };
  }
  // K-15: the encoding/delimiter override rides only on the generic (delimited) reader; the xlsx and
  // AbaConnect arms parse their own container/markup and ignore a forced text encoding or delimiter.
  const csvOpts =
    opts?.encoding === undefined && opts?.delimiter === undefined ? undefined : { encoding: opts.encoding, delimiter: opts.delimiter };
  switch (adapterId) {
    case 'csv':
    case 'tsv':
      return parseGenericCsv(bytes, csvOpts);
    case 'xlsx':
      return parseXlsx(bytes, opts?.sheet === undefined ? {} : { sheet: opts.sheet });
    case 'abacus_abaconnect':
      return parseAbaConnect(bytes);
    case 'bexio_csv':
    case 'banana_tsv':
    case 'cresus_csv':
      // bexio, Banana and Crésus export ordinary delimited files (Banana and Crésus tab-separated,
      // detected from the header line); the vendor value they add over the generic reader is a COLUMN
      // PRESET per class, carried on the registry row, not a different parse.
      return parseGenericCsv(bytes, csvOpts);
    default:
      return parseGenericCsv(bytes, csvOpts);
  }
}

/** Is a parse outcome a failure? Narrows the union for callers. */
export function isParseFailure(r: ParseResult | ParseFailure): r is ParseFailure {
  return (r as ParseFailure).ok === false;
}

// --- The streaming contract (G18 US-G18.4) ------------------------------------------------------

/** One batch of a streamed parse: at most `STREAM_BATCH_ROWS` rows, plus any warnings for them. */
export interface ParseBatch {
  readonly rows: readonly ParsedRow[];
  readonly warnings: readonly string[];
}

/**
 * The documented per-batch row ceiling. `parseStream` never yields a batch larger than this, so no
 * verb response built from a batch ever carries an unbounded array and peak memory stays flat at any
 * source size (the harness paginates a step internally over these batches).
 */
export const STREAM_BATCH_ROWS = 10_000;

/**
 * Stream a generic CSV/TSV source in row batches of at most `STREAM_BATCH_ROWS`, decoding and
 * splitting lines INCREMENTALLY across arbitrary chunk boundaries. Peak memory is bounded by one
 * batch plus one partial line, independent of the total source size: this is the half of US-G18.4
 * that keeps a multi-hundred-megabyte GL export from being materialised. The `byteSource` is an async
 * iterable of byte chunks (the E00 byte-range reader over a migration-class blob wraps one); the
 * generic adapter is streamed here, and a vendor adapter that opts in declares so on its registry row.
 *
 * The header line is read from the first non-empty line and the delimiter detected there, exactly as
 * `parseGenericCsv` does, so a small source and a streamed source yield identical rows. A source with
 * no header line at all yields nothing (the streaming analogue of `no_header_row`).
 */
export async function* parseStream(byteSource: AsyncIterable<Uint8Array>, _dataClass?: string): AsyncGenerator<ParseBatch> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let headers: readonly string[] | null = null;
  let delim = ',';
  let delimName = 'comma';
  let batch: ParsedRow[] = [];
  let warnings: string[] = [];
  let seenAnyByte = false;

  const takeLine = (line: string): void => {
    if (headers === null) {
      if (line.trim() === '') return; // skip blank leading lines until the header
      const d = detectDelimiter(line);
      if (d !== undefined) {
        delim = d.ch;
        delimName = d.name;
      }
      headers = splitLine(line, delim);
      return;
    }
    if (line.trim() === '') return;
    const cells = splitLine(line, delim);
    if (cells.length !== headers.length) {
      warnings.push(`row width ${cells.length} != header width ${headers.length} (${delimName})`);
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '') row[h] = cells[i] ?? '';
    });
    batch.push(row);
  };

  for await (const chunk of byteSource) {
    buf += decoder.decode(chunk, { stream: true });
    if (!seenAnyByte) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1); // tolerate a leading BOM once
      seenAnyByte = true;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      takeLine(line);
      if (batch.length >= STREAM_BATCH_ROWS) {
        yield { rows: batch, warnings };
        batch = [];
        warnings = [];
      }
    }
  }
  // The trailing line (a file whose last row carries no newline) plus any decoder remainder.
  buf += decoder.decode();
  if (buf.length > 0) {
    const last = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
    takeLine(last);
  }
  if (batch.length > 0 || warnings.length > 0) {
    yield { rows: batch, warnings };
  }
}

/** Wrap a full byte buffer as a chunked `byteSource`, so a small in-memory blob can feed `parseStream`. */
export async function* bytesAsChunks(bytes: Uint8Array, chunkSize = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
  }
}

/**
 * The SYNCHRONOUS sibling of `parseStream` (G18 US-G18.4). The engine is synchronous (better-sqlite3),
 * so the migration harness cannot await an async iterator inside a verb; it reads a migration-class
 * blob's segments as a synchronous `Iterable<Uint8Array>` (E00's `readBlobSegmentsSync`) and paginates
 * over these batches. The row-splitting logic is identical to `parseStream`, so a small materialised
 * parse and a streamed one yield the SAME rows, and peak memory stays one batch plus one partial line,
 * independent of source size: this is what lets `previewStep` count a multi-hundred-megabyte GL export
 * without ever holding it whole.
 */
export function* parseStreamSync(byteSource: Iterable<Uint8Array>, _dataClass?: string): Generator<ParseBatch> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let headers: readonly string[] | null = null;
  let delim = ',';
  let delimName = 'comma';
  let batch: ParsedRow[] = [];
  let warnings: string[] = [];
  let seenAnyByte = false;

  const takeLine = (line: string): void => {
    if (headers === null) {
      if (line.trim() === '') return;
      const d = detectDelimiter(line);
      if (d !== undefined) {
        delim = d.ch;
        delimName = d.name;
      }
      headers = splitLine(line, delim);
      return;
    }
    if (line.trim() === '') return;
    const cells = splitLine(line, delim);
    if (cells.length !== headers.length) {
      warnings.push(`row width ${cells.length} != header width ${headers.length} (${delimName})`);
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '') row[h] = cells[i] ?? '';
    });
    batch.push(row);
  };

  for (const chunk of byteSource) {
    buf += decoder.decode(chunk, { stream: true });
    if (!seenAnyByte) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
      seenAnyByte = true;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      takeLine(line);
      if (batch.length >= STREAM_BATCH_ROWS) {
        yield { rows: batch, warnings };
        batch = [];
        warnings = [];
      }
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) {
    const last = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
    takeLine(last);
  }
  if (batch.length > 0 || warnings.length > 0) {
    yield { rows: batch, warnings };
  }
}

/** Wrap a full byte buffer as a synchronous chunked iterable, for `parseStreamSync` over a small blob. */
export function* bytesAsChunksSync(bytes: Uint8Array, chunkSize = 64 * 1024): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
  }
}
