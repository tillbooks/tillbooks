/**
 * F01's renderers (§4, §8): CSV (RFC-4180, UTF-8 with BOM) and PDF (a report header plus the rows),
 * and the money/date formatting rules that keep a figure faithful to its source.
 *
 * MONEY IS INTEGER RAPPEN END TO END (P2). A value arrives from a source as an integer and is
 * formatted exactly once at output; it is NEVER parsed back into a float. The CSV artifact stays
 * MACHINE-NEUTRAL (raw integer Rappen, ISO-8601 dates, the column keys as its header) so a re-import
 * round-trips regardless of the viewer's locale (P11); the PDF is the human artifact and formats money
 * de-CH style (1'234.50) and dates as ISO days.
 *
 * These are pure functions of (columns, rows): no clock, no store, no locale global. The caller passes
 * the resolved column list and the projected rows, so the same input renders byte-identically every
 * time, which is what makes a replayed `idempotency_key` return the same artifact (§H-IDEMPOTENT).
 */

import type { ColumnType } from './enums.js';

export interface RenderColumn {
  readonly key: string;
  readonly label: string;
  readonly type: ColumnType;
}

export interface RenderInput {
  readonly columns: readonly RenderColumn[];
  readonly rows: readonly Record<string, unknown>[];
  /** Header block for the PDF (and ignored by CSV, which stays machine-neutral). */
  readonly meta: {
    readonly workspaceName: string;
    readonly reportName: string;
    readonly filterSummary: string;
    readonly ranAt: string;
  };
  /** The de-CH empty-result line for the PDF when there are no rows. */
  readonly emptyLabel: string;
}

const MONEY_TYPES: ReadonlySet<ColumnType> = new Set(['money']);

/** Format an integer Rappen value de-CH: thousands with `'`, two decimals. Never a float parse. */
export function formatMoneyMinor(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const francs = Math.trunc(abs / 100);
  const rappen = abs % 100;
  const grouped = String(francs).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${neg ? '-' : ''}${grouped}.${String(rappen).padStart(2, '0')}`;
}

/** The machine-neutral cell for CSV: money stays raw integer Rappen, everything else is its string. */
function csvCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return '';
  if (MONEY_TYPES.has(type)) {
    return typeof value === 'number' ? String(Math.trunc(value)) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join('|');
  return String(value);
}

/** The human cell for PDF: money is formatted, everything else is its string. */
function humanCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return '';
  if (MONEY_TYPES.has(type)) {
    return typeof value === 'number' ? formatMoneyMinor(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'ja' : 'nein';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** RFC-4180 field quoting: wrap in double quotes and double any embedded quote when needed. */
export function csvField(raw: string): string {
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/**
 * Render CSV, RFC-4180, UTF-8 with a BOM so spreadsheet apps read the umlauts correctly. CRLF line
 * endings (the RFC's record separator). Header row = the column KEYS, so the artifact re-imports.
 */
export function renderCsv(input: RenderInput): Buffer {
  const lines: string[] = [];
  lines.push(input.columns.map((c) => csvField(c.key)).join(','));
  for (const row of input.rows) {
    lines.push(input.columns.map((c) => csvField(csvCell(row[c.key], c.type))).join(','));
  }
  const body = lines.join('\r\n') + '\r\n';
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
}

// --- PDF -----------------------------------------------------------------------------------------

/** Escape the three characters a PDF literal string reserves. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A minimal but genuinely valid single-page PDF: one Helvetica text object, one line per source row,
 * with the report header on top. It is not a typeset table (the cloud tier owns rich rendering); it is
 * an honest, openable local artifact that carries the report name, the filter summary, the run time,
 * the column headers and the formatted rows. Latin-1 encoded (WinAnsi), which covers de-CH umlauts.
 */
export function renderPdf(input: RenderInput): Buffer {
  const textLines: string[] = [];
  textLines.push(input.meta.reportName);
  textLines.push(`${input.meta.workspaceName}  |  ${input.meta.ranAt}`);
  if (input.meta.filterSummary.length > 0) textLines.push(input.meta.filterSummary);
  textLines.push('');
  textLines.push(input.columns.map((c) => c.label).join('  |  '));
  textLines.push('------------------------------------------------------------');
  if (input.rows.length === 0) {
    textLines.push(input.emptyLabel);
  } else {
    for (const row of input.rows) {
      textLines.push(input.columns.map((c) => humanCell(row[c.key], c.type)).join('  |  '));
    }
  }

  // Build the content stream: a text object stepping down the page one line at a time.
  const leading = 14;
  const top = 800;
  const contentParts: string[] = ['BT', '/F1 10 Tf', `${leading} TL`, `40 ${top} Td`];
  textLines.forEach((line, i) => {
    if (i > 0) contentParts.push('T*');
    contentParts.push(`(${pdfEscape(line)}) Tj`);
  });
  contentParts.push('ET');
  const content = contentParts.join('\n');
  const contentBytes = Buffer.from(content, 'latin1');

  // Five objects: catalog, pages, page, font, content stream. Assembled with a real xref table.
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
  ];

  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (b: Buffer): void => {
    chunks.push(b);
    offset += b.length;
  };
  const offsets: number[] = [];

  push(Buffer.from('%PDF-1.4\n', 'latin1'));
  objects.forEach((body, i) => {
    offsets[i] = offset;
    push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  push(Buffer.from(xref, 'latin1'));
  push(
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      'latin1',
    ),
  );

  return Buffer.concat(chunks);
}
