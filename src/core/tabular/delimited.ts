/**
 * A20 §13.1 (D205): the delimited reader of the tabular layer. It reads RFC 4180 rows the way G09's
 * `parseGenericCsv` (`migration/adapters/parse.ts`) reads them with a named separator, byte for byte the
 * same rows, so the banking reader no longer imports the migration adapters: double-quote quoting (a quoted
 * field may hold the separator and `""`), each field trimmed, header-keyed rows, a blank line skipped, a row
 * of another width read as far as it goes with a warning. Pure.
 */

/** One header-keyed row, unmapped columns kept. */
export type TabularRow = Readonly<Record<string, string>>;

/** Split one line on `delim` honouring double-quote quoting; every field trimmed. */
export function splitDelimitedLine(line: string, delim: string): string[] {
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
 * Read delimited text whose FIRST non-blank line is the header, with the named separator. Null when the
 * text has no header line at all; an empty data section is `rows: []`. Reading stops at the first row over
 * `maxRows` (`overCap`), so a huge file is never read whole.
 */
export function readDelimitedRows(
  text: string,
  delim: string,
  delimName: string,
  maxRows = Number.POSITIVE_INFINITY,
): { headers: string[]; rows: TabularRow[]; warnings: string[]; overCap: boolean; headerIndex: number; rowIndex: number[] } | null {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines = rawLines.filter((l, i) => !(l.trim() === '' && i >= rawLines.length - 1));
  const headerIndex = lines.findIndex((l) => l.trim() !== '');
  const headerLine = headerIndex < 0 ? undefined : lines[headerIndex];
  if (headerLine === undefined) return null;
  const headers = splitDelimitedLine(headerLine, delim);
  const warnings: string[] = [];
  const rows: TabularRow[] = [];
  // A20 §13.1: the input line of every row, from THE loop that yields the rows, so a caller keys anything per
  // row (a line number, a workbook's cell kinds) on the very structure the rows came from.
  const rowIndex: number[] = [];
  let headerSeen = false;
  let overCap = false;
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k] as string;
    if (!headerSeen) {
      if (k === headerIndex) headerSeen = true;
      continue;
    }
    if (line.trim() === '') continue;
    if (rows.length >= maxRows) {
      overCap = true;
      break;
    }
    const cells = splitDelimitedLine(line, delim);
    if (cells.length !== headers.length) warnings.push(`row width ${cells.length} != header width ${headers.length} (${delimName})`);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h !== '') row[h] = cells[i] ?? '';
    });
    rows.push(row);
    rowIndex.push(k);
  }
  return { headers, rows, warnings, overCap, headerIndex, rowIndex };
}
