/**
 * A20 §13.1 (D205): the LAYOUT of a delimited export (its separator and the row with the column names below
 * a preamble). Moved here unchanged from `banking/csvStatement.ts` (A20 §11.3, critic M3 and R2-4), which
 * re-exports it. An XLSX sheet is written out as delimited text first (`xlsx.ts`), so a preamble above a
 * workbook's header is found the same way. Pure.
 */

/** The separators, by the names the delimited reader uses. */
export const TABULAR_DELIMITERS = ['semicolon', 'comma', 'tab'] as const;
export type TabularDelimiter = (typeof TABULAR_DELIMITERS)[number];

/** The candidates in tie order: `;` (the Swiss export's), then tab, then `,`. */
const SEPARATORS: readonly { name: TabularDelimiter; ch: string }[] = [
  { name: 'semicolon', ch: ';' },
  { name: 'tab', ch: '\t' },
  { name: 'comma', ch: ',' },
];

/** The separator character of a delimiter name. */
export function delimiterChar(name: TabularDelimiter): string {
  return (SEPARATORS.find((s) => s.name === name) as { ch: string }).ch;
}

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

/** The fewest column names a header carries: what every mapping must map (a booking date and an amount). */
const HEADER_MIN_WORDS = 2;

/** A cell that names something (it has a letter), not a number, an amount or a date. */
function isWordCell(cell: string): boolean {
  return /\p{L}/u.test(cell);
}

/**
 * The header row (1-based) and separator of an export, read from the first 30 non-empty lines (critic M3):
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
export function detectTableLayout(text: string, forced: { headerRow?: number; delimiter?: TabularDelimiter } = {}): { headerRow: number; delimiter: TabularDelimiter } {
  const lines = text.split(/\r\n|\r|\n/);
  // At most 30 lines of at most 64 KiB each are read: no file can make the detection slow.
  const sample = lines
    .slice(0, 200)
    .map((l, i) => ({ l: l.slice(0, 65_536), i }))
    .filter((x) => x.l.trim() !== '')
    .slice(0, 30);
  let delimiter: TabularDelimiter = forced.delimiter ?? 'semicolon';
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
  const ch = delimiterChar(delimiter);
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
