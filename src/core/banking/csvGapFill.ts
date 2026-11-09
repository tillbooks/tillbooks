/**
 * A20 §12 (owner brief of 09.11.2026): FILL A STATEMENT GAP FROM THE BANK'S OWN CSV EXPORT, when no
 * camt.053 for those days can be had.
 *
 * WHAT A FILL IS. A CSV export is read through the Bankkonto's mapping (`csvStatement.ts`), and only the
 * rows on days NO stored statement holds are taken: the days of a gap TILL knows (`statementGaps.ts`), the
 * days between the end of the books' bank history and the first statement (the BEFORE-FEED hole: the
 * linked account's last posted entry before the first statement, to the day before it), or a range the
 * caller names, always minus the days any stored statement already holds (`heldDays`). Each such stretch
 * of days becomes ONE statement of the books (`message_type` `csv`, statement id `csvfill:<digest>`), so
 * every line it brings says where it came from (provenance: the line's statement is a CSV, and its facts
 * carry `source: 'csv'`).
 *
 * WHAT PROVES IT. The bank's running balance column (`balance`). In time order every row's balance is the
 * one before plus its signed amount (`chainBreakIn`), from the last row BEFORE the stretch to the first
 * row AFTER it. So the CSV states the bank's balance at the stretch's start (the row before it, else the
 * first row's balance minus its amount) and end (the last row's balance), and that no row is missing in
 * between. Those two balances are the fill statement's opening and closing balance. A stretch the export
 * does not reach on one side is proven only as far as its rows go (its period is cut there, and an end the
 * CSV cannot state has no balance).
 *
 * WHAT TIES IT. The neighbours in the books: the stored statement right before the stretch must close on
 * the fill's opening, the one right after it must open on the fill's closing. Under the setting
 * `bank.csv_fill_balance_tie` = `required` (the default) a stretch that contradicts a neighbour, or whose
 * own chain breaks, is refused and nothing of it is written; `warn` imports it and says so. When no
 * statement precedes the stretch, the books (the linked account the day before) are named beside it, a
 * fact and never a refusal: the books can hold their own difference.
 *
 * WHAT IT DOES NOT COUNT TWICE. Under `bank.csv_fill_duplicates` = `skip_proven` (the default) a row the
 * books already hold is left out, named with the line it is: first by the bank's own reference with the
 * same money (`referenceMatch`), then by the same date, money and a shared word of its text or name, one
 * to one (`movementMatch`). `ask` imports every row and leaves the resemblances to the D178 point 19 flags
 * of the one insertion. Either way the one insertion (`insertStatement`) still runs every line through its
 * coverage and cross-format checks.
 *
 * A GAP IT CLOSES. A numbered gap whose missing days a chain of tied fills covers, from the earlier
 * statement's closing to the later one's opening, is FILLED (`gapFillOf`, read by `statementGaps.ts`) and
 * leaves the open list, like a confirmed one. The before-feed hole needs no flag: the fill is the earliest
 * statement with an opening balance, so the balance line's feed start (`bankInbox.ts`) moves to it.
 *
 * §H-TENANT on every query. Pure over its inputs apart from the reads named; writes nothing.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import type { ParsedBankStatement, ParsedCamtEntry, SkippedCamtEntry } from './camt.js';
import { csvRowBalance, csvStatementOf } from './csvStatement.js';
import type { CsvTable } from './csvStatement.js';
import type { CsvMapping } from './csvMapping.js';
import { nameTokens } from './statementDedupe.js';
import { ledgerBalanceInAccountCurrency } from './bankInbox.js';

// --- Settings (D172) -----------------------------------------------------------------------------------

/** `bank.csv_fill_balance_tie`: a stretch that contradicts its neighbours is refused, or imported with a warning. */
export const CSV_FILL_BALANCE_TIE_MODES = ['required', 'warn'] as const;
export type CsvFillBalanceTieMode = (typeof CSV_FILL_BALANCE_TIE_MODES)[number];

/** `bank.csv_fill_duplicates`: rows the books prove are left out, or every row is imported and flagged. */
export const CSV_FILL_DUPLICATE_MODES = ['skip_proven', 'ask'] as const;
export type CsvFillDuplicateMode = (typeof CSV_FILL_DUPLICATE_MODES)[number];

/** `bank.csv_fill_fed_accounts`: a Bankkonto fed over EBICS takes a fill for the days the feed never delivered, or none. */
export const CSV_FILL_FED_ACCOUNT_MODES = ['allow', 'refuse'] as const;
export type CsvFillFedAccountMode = (typeof CSV_FILL_FED_ACCOUNT_MODES)[number];

export function fillBalanceTieMode(ctx: WorkspaceContext): CsvFillBalanceTieMode {
  return getSetting<string>(ctx, 'bank.csv_fill_balance_tie') === 'warn' ? 'warn' : 'required';
}

export function fillDuplicateMode(ctx: WorkspaceContext): CsvFillDuplicateMode {
  return getSetting<string>(ctx, 'bank.csv_fill_duplicates') === 'ask' ? 'ask' : 'skip_proven';
}

export function fillFedAccountMode(ctx: WorkspaceContext): CsvFillFedAccountMode {
  return getSetting<string>(ctx, 'bank.csv_fill_fed_accounts') === 'refuse' ? 'refuse' : 'allow';
}

// --- The scope -----------------------------------------------------------------------------------------

/** What a fill takes: the gaps TILL knows (and the before-feed hole), or one range of days. */
export type CsvFillScope = { kind: 'gaps' } | { kind: 'range'; from: string; to: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The `fill` input: `{}` (the gaps) or `{ from, to }` (one range), or a refusal naming the field. */
export function readFillScope(raw: unknown): { scope: CsvFillScope } | { field: string; reason: string } {
  if (raw === true) return { scope: { kind: 'gaps' } };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { field: 'fill', reason: 'an object: {} for the gaps TILL knows, or { from, to } for one range of days' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== 'from' && k !== 'to') return { field: `fill.${k}`, reason: 'fill takes from and to only' };
  const hasFrom = r['from'] !== undefined && r['from'] !== null;
  const hasTo = r['to'] !== undefined && r['to'] !== null;
  if (!hasFrom && !hasTo) return { scope: { kind: 'gaps' } };
  if (!hasFrom || !hasTo) return { field: hasFrom ? 'fill.to' : 'fill.from', reason: 'a range names both from and to (YYYY-MM-DD)' };
  if (!isIsoDay(r['from'])) return { field: 'fill.from', reason: 'a date YYYY-MM-DD' };
  if (!isIsoDay(r['to'])) return { field: 'fill.to', reason: 'a date YYYY-MM-DD' };
  if ((r['from'] as string) > (r['to'] as string)) return { field: 'fill.to', reason: 'to is on or after from' };
  if (dayDiff(r['from'] as string, r['to'] as string) > MAX_RANGE_DAYS) return { field: 'fill', reason: `at most ${MAX_RANGE_DAYS} days in one range` };
  return { scope: { kind: 'range', from: r['from'] as string, to: r['to'] as string } };
}

/** The longest range one call fills (a bank keeps about ten years of exports; one is plenty per call). */
export const MAX_RANGE_DAYS = 3660;

// --- Day arithmetic ------------------------------------------------------------------------------------

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// --- The stored statements -----------------------------------------------------------------------------

interface StoredStatement {
  id: string;
  message_type: string;
  electronic_seq_nb: string | null;
  page_number: number;
  last_page_ind: number;
  from_date: string | null;
  to_date: string | null;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  balance_currency: string | null;
}

function readStatements(ctx: WorkspaceContext, bankAccountId: string): StoredStatement[] {
  return ctx.store.db
    .prepare(
      `SELECT id, message_type, electronic_seq_nb, page_number, last_page_ind, from_date, to_date,
              opening_balance_minor, closing_balance_minor, balance_currency
         FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?`,
    )
    .all(ctx.workspaceId, bankAccountId) as StoredStatement[];
}

/** The days a stored statement holds: its first to its last day (an undated one holds none). */
function heldSpanOf(s: Pick<StoredStatement, 'from_date' | 'to_date'>): { from: string; to: string } | null {
  const from = s.from_date?.slice(0, 10) ?? s.to_date?.slice(0, 10) ?? null;
  const to = s.to_date?.slice(0, 10) ?? from;
  if (from === null || to === null) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** A stretch of days minus every day a stored statement holds: the contiguous stretches left, in order. */
export function minusHeld(range: { from: string; to: string }, held: readonly { from: string; to: string }[]): { from: string; to: string }[] {
  const cuts = held.filter((h) => h.to >= range.from && h.from <= range.to).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: { from: string; to: string }[] = [];
  let cursor = range.from;
  for (const c of cuts) {
    if (c.from > cursor) out.push({ from: cursor, to: addDays(c.from, -1) < range.to ? addDays(c.from, -1) : range.to });
    const next = addDays(c.to, 1);
    if (next > cursor) cursor = next;
    if (cursor > range.to) return out;
  }
  if (cursor <= range.to) out.push({ from: cursor, to: range.to });
  return out;
}

// --- The targets ---------------------------------------------------------------------------------------

/** A stretch of days a fill is asked to cover. */
export interface FillTarget {
  /** `gap`: a numbered gap's missing days. `before_feed`: the books' bank history ends, then nothing until the first statement. `range`: named by the caller. */
  kind: 'gap' | 'before_feed' | 'range';
  from: string;
  to: string;
  /** For `gap`: the gap's id in `statement_gaps`. */
  gapId?: string;
}

interface OpenGapLike {
  gapId: string;
  source: 'book' | 'pending';
  after: { toDate: string | null; fromDate: string | null };
  before: { fromDate: string | null };
}

/** The latest posted entry date on the linked ledger account strictly before `day`, or null. §H-TENANT. */
function lastLedgerDayBefore(ctx: WorkspaceContext, ledgerAccountId: string, day: string): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT MAX(e.date) AS d FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date < ?`,
    )
    .get(ctx.workspaceId, ledgerAccountId, day) as { d: string | null } | undefined;
  return row?.d ?? null;
}

/**
 * The stretches a fill covers on one Bankkonto: the open numbered gaps' missing days and the before-feed
 * hole (scope `gaps`), or the named range (scope `range`), each minus the held days. `gaps` are the open
 * gaps of the account (`statementGaps`), passed in so this module reads the gap model through its door.
 */
export function fillTargetsOf(
  ctx: WorkspaceContext,
  account: { id: string; ledger_account_id: string; currency: string },
  scope: CsvFillScope,
  gaps: readonly OpenGapLike[],
  feedEnd?: string | null,
): FillTarget[] {
  const statements = readStatements(ctx, account.id);
  const held = statements.map(heldSpanOf).filter((h): h is { from: string; to: string } => h !== null);
  const out: FillTarget[] = [];
  // Critic r1 F1 (D139 item 6): on an account fed over EBICS a fill never reaches past the newest day-end
  // statement the feed delivered; the days after it are the feed's to deliver (`feedEnd` null: none yet).
  const capped = (list: FillTarget[]): FillTarget[] => {
    if (feedEnd === undefined) return list;
    if (feedEnd === null) return [];
    return list.filter((t) => t.from <= feedEnd).map((t) => (t.to > feedEnd ? { ...t, to: feedEnd } : t));
  };
  if (scope.kind === 'range') {
    for (const r of minusHeld(scope, held)) out.push({ kind: 'range', ...r });
    return capped(out);
  }
  for (const g of gaps) {
    if (g.source !== 'book') continue;
    const afterEnd = g.after.toDate?.slice(0, 10) ?? g.after.fromDate?.slice(0, 10) ?? null;
    const beforeStart = g.before.fromDate?.slice(0, 10) ?? null;
    if (afterEnd === null || beforeStart === null) continue;
    const from = addDays(afterEnd, 1);
    const to = addDays(beforeStart, -1);
    if (from > to) continue;
    for (const r of minusHeld({ from, to }, held)) out.push({ kind: 'gap', gapId: g.gapId, ...r });
  }
  // The before-feed hole: the books' bank history (the linked account's entries) ends, the first statement
  // starts later. Offered only when the books HAVE such a history: a new book has no hole to speak of.
  const firstDays = held.map((h) => h.from).sort();
  const first = firstDays[0];
  if (first !== undefined) {
    const last = lastLedgerDayBefore(ctx, account.ledger_account_id, first);
    if (last !== null) {
      const from = addDays(last, 1);
      const to = addDays(first, -1);
      if (from <= to) for (const r of minusHeld({ from, to }, held)) out.push({ kind: 'before_feed', ...r });
    }
  }
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return capped(out);
}

/** The last day of the newest day-end camt.053 of an account (the feed's reach), or null. §H-TENANT. */
export function feedEndOf(ctx: WorkspaceContext, bankAccountId: string): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT MAX(COALESCE(to_date, from_date)) AS d FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND message_type = 'camt053' AND closing_balance_minor IS NOT NULL`,
    )
    .get(ctx.workspaceId, bankAccountId) as { d: string | null } | undefined;
  return row?.d?.slice(0, 10) ?? null;
}

// --- The CSV rows in time order ------------------------------------------------------------------------

/** One readable row of the CSV, in time order, with the balance it states. */
export interface FillRow {
  /** The row's line in the file (1-based). */
  row: number;
  date: string;
  /** Signed: + money in, - money out. */
  signedMinor: number;
  /** The balance after the row, as the bank states it, or null. */
  balanceMinor: number | null;
  entry: ParsedCamtEntry;
}

export interface FillRows {
  /** Readable rows in TIME order. */
  rows: FillRow[];
  /** Rows the reader could not take (an unreadable date or amount, another currency), with their line. */
  unreadable: SkippedCamtEntry[];
  /** The order the file stood in. */
  order: 'newest_first' | 'oldest_first';
  /** Does the mapping name a balance column? */
  hasBalance: boolean;
}

/** Does every consecutive pair of rows with balances chain (balance = previous balance + amount)? */
function chainsFully(rows: readonly FillRow[]): boolean {
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1] as FillRow;
    const b = rows[i] as FillRow;
    if (a.balanceMinor === null || b.balanceMinor === null) continue;
    if (a.balanceMinor + b.signedMinor !== b.balanceMinor) return false;
  }
  return true;
}

/**
 * The CSV's rows in time order. The order is the mapping's `rowOrder`; `auto` reads it from the dates
 * (the first dated row later than the last: newest first), and on a file of one day from the running
 * balance (the order in which it chains). Within a day, file order is kept (reversed for newest first).
 */
export function fillRowsOf(table: CsvTable, mapping: CsvMapping, accountCurrency: string): FillRows {
  const stmt = csvStatementOf(table, mapping, accountCurrency);
  const skippedLines = new Set(stmt.skipped.map((s) => s.row));
  const recordByLine = new Map<number, Readonly<Record<string, string>>>();
  table.records.forEach((r, i) => recordByLine.set(table.lines[i] ?? table.headerRow + i + 1, r));
  const importedLines = table.lines.filter((l) => !skippedLines.has(l));
  const fileOrder: FillRow[] = stmt.entries.map((entry, i) => {
    const row = importedLines[i] ?? 0;
    const record = recordByLine.get(row);
    return {
      row,
      date: entry.bookingDate as string,
      signedMinor: entry.creditDebit === 'CRDT' ? entry.amountMinor : -entry.amountMinor,
      balanceMinor: record === undefined ? null : csvRowBalance(record, mapping),
      entry,
    };
  });
  const unreadable = stmt.skipped.filter((s) => s.reason !== 'not_a_movement');
  let order: 'newest_first' | 'oldest_first';
  if (mapping.rowOrder === 'newest_first' || mapping.rowOrder === 'oldest_first') order = mapping.rowOrder;
  else {
    const first = fileOrder[0]?.date;
    const last = fileOrder[fileOrder.length - 1]?.date;
    if (first !== undefined && last !== undefined && first !== last) order = first > last ? 'newest_first' : 'oldest_first';
    else order = chainsFully(fileOrder) || !chainsFully([...fileOrder].reverse()) ? 'oldest_first' : 'newest_first';
  }
  const rows = order === 'newest_first' ? [...fileOrder].reverse() : fileOrder;
  // A stable sort by date keeps the within-day order of the file (a bank that lists days out of order).
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i)).map((x) => x.r);
  return { rows: sorted, unreadable, order, hasBalance: mapping.columns.balance !== undefined };
}

// --- The proof of one stretch --------------------------------------------------------------------------

/** One end of a fill against what the books hold there. */
export type FillTie =
  /** A stored statement: before the stretch its closing balance, after it its opening balance. */
  | { kind: 'statement'; statementRowId: string; messageType: string; number: number | null; date: string; balanceMinor: number; csvMinor: number | null; differenceMinor: number | null }
  /** No statement before the stretch: the linked account the day before (a fact, never a refusal). */
  | { kind: 'books'; date: string; ledgerMinor: number; csvMinor: number | null; differenceMinor: number | null }
  /** Nothing in the books to tie this end to. */
  | { kind: 'none'; csvMinor: number | null };

/** Why a stretch cannot be written as proven (§H-ENUM, single point). */
export const FILL_PROBLEMS = ['no_balance_column', 'chain_broken', 'untied', 'open_end', 'not_in_file'] as const;
export type FillProblem = (typeof FILL_PROBLEMS)[number];

/** A row the books already hold, left out of the fill (`skip_proven`), with the line it is. */
export interface FillDuplicate {
  row: number;
  existingBankTxnId: string;
  /** `reference`: the bank's own reference with the same money; `movement`: the same date, money and a shared word. */
  by: 'reference' | 'movement';
  /** Signed: + money in, - money out. */
  signedMinor: number;
  /** Where the books hold it: in a statement before the stretch, after it, or on its days. */
  side: 'before' | 'after' | 'inside';
}

/** The plan for one stretch: what it would write, and what proves it. */
export interface FillPart {
  target: FillTarget;
  /** The days the CSV proves (the target's, cut where the export ends). */
  from: string;
  to: string;
  /** The CSV rows on those days (before any is left out as a duplicate). */
  rows: FillRow[];
  /** The rows the fill would write. */
  entries: ParsedCamtEntry[];
  duplicates: FillDuplicate[];
  /** Critic r2 R1: rows matched to a stored line but imported (no tied neighbour proves the match): flagged on import. */
  restored: FillDuplicate[];
  /** The bank's balance at the stretch's start and end, as the CSV states it (null: not stated). */
  csvOpeningMinor: number | null;
  csvClosingMinor: number | null;
  /**
   * The fill statement's own balances (`tieFillParts`): the CSV's, moved by the rows the books hold in a
   * statement before or after the stretch, so that opening + the kept rows = closing.
   */
  openingMinor: number | null;
  closingMinor: number | null;
  before: FillTie;
  after: FillTie;
  /** Both statement ends agree, and the CSV covers every day of the target. */
  closesTarget: boolean;
  problems: { code: FillProblem; row?: number; side?: 'before' | 'after'; differenceMinor?: number }[];
}

/** The first pair of rows in `[from, to]` (indices into `rows`) whose balances do not chain, as the later row's line. */
function chainBreakIn(rows: readonly FillRow[], from: number, to: number): number | null {
  for (let i = Math.max(from, 0) + 1; i <= to && i < rows.length; i += 1) {
    const a = rows[i - 1] as FillRow;
    const b = rows[i] as FillRow;
    if (a.balanceMinor === null || b.balanceMinor === null) return a.balanceMinor === null ? a.row : b.row;
    if (a.balanceMinor + b.signedMinor !== b.balanceMinor) return b.row;
  }
  return null;
}

function seqOf(s: StoredStatement): number | null {
  if (s.electronic_seq_nb === null) return null;
  const n = Number(s.electronic_seq_nb.trim());
  return Number.isSafeInteger(n) ? n : null;
}


function hasLedgerHistory(ctx: WorkspaceContext, ledgerAccountId: string, asOf: string): boolean {
  return lastLedgerDayBefore(ctx, ledgerAccountId, addDays(asOf, 1)) !== null;
}

/** The stored statement right before `day` with a closing balance (the latest by end, then sequence). */
function statementBefore(statements: readonly StoredStatement[], day: string, currency: string): StoredStatement | null {
  const c = statements.filter((s) => s.last_page_ind === 1 && s.closing_balance_minor !== null && (s.balance_currency === null || s.balance_currency === currency)).filter((s) => {
    const span = heldSpanOf(s);
    return span !== null && span.to < day;
  });
  c.sort((a, b) => {
    const ta = heldSpanOf(a)?.to as string;
    const tb = heldSpanOf(b)?.to as string;
    return ta < tb ? -1 : ta > tb ? 1 : (seqOf(a) ?? -1) - (seqOf(b) ?? -1);
  });
  return c[c.length - 1] ?? null;
}

/** The stored statement right after `day` with an opening balance (the earliest by start, then sequence). */
function statementAfter(statements: readonly StoredStatement[], day: string, currency: string): StoredStatement | null {
  const c = statements.filter((s) => s.page_number === 1 && s.opening_balance_minor !== null && (s.balance_currency === null || s.balance_currency === currency)).filter((s) => {
    const span = heldSpanOf(s);
    return span !== null && span.from > day;
  });
  c.sort((a, b) => {
    const fa = heldSpanOf(a)?.from as string;
    const fb = heldSpanOf(b)?.from as string;
    return fa < fb ? -1 : fa > fb ? 1 : (seqOf(a) ?? Number.MAX_SAFE_INTEGER) - (seqOf(b) ?? Number.MAX_SAFE_INTEGER);
  });
  return c[0] ?? null;
}

function statementTie(s: StoredStatement, side: 'before' | 'after', csvMinor: number | null): FillTie {
  const span = heldSpanOf(s) as { from: string; to: string };
  const balance = (side === 'before' ? s.closing_balance_minor : s.opening_balance_minor) as number;
  return {
    kind: 'statement',
    statementRowId: s.id,
    messageType: s.message_type,
    number: s.message_type === 'camt053' ? seqOf(s) : null,
    date: side === 'before' ? span.to : span.from,
    balanceMinor: balance,
    csvMinor,
    differenceMinor: csvMinor === null ? null : csvMinor - balance,
  };
}

/**
 * The plan for every target stretch against one CSV: its rows, the days it proves, the CSV's balances and
 * the breaks of its chain. Pure. Duplicates are decided afterwards (`decideFillDuplicates`), then the ties
 * (`tieFillParts`).
 */
export function planFillParts(fill: FillRows, targets: readonly FillTarget[]): FillPart[] {
  const rows = fill.rows;
  const parts: FillPart[] = [];
  for (const target of targets) {
    const problems: FillPart['problems'] = [];
    const inIdx = rows.map((r, i) => ({ r, i })).filter((x) => x.r.date >= target.from && x.r.date <= target.to).map((x) => x.i);
    const firstIn = inIdx[0];
    const lastIn = inIdx[inIdx.length - 1];
    let beforeIdx = -1;
    for (let i = 0; i < rows.length; i += 1) if ((rows[i] as FillRow).date < target.from) beforeIdx = i;
    let afterIdx = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) if ((rows[i] as FillRow).date > target.to) afterIdx = i;
    const inRows = inIdx.map((i) => rows[i] as FillRow);
    if (inRows.length === 0 && (beforeIdx < 0 || afterIdx < 0)) {
      // No row on these days, and the export does not reach past both ends: it says nothing about them.
      parts.push({
        target,
        from: target.from,
        to: target.to,
        rows: [],
        entries: [],
        duplicates: [],
        restored: [],
        csvOpeningMinor: null,
        csvClosingMinor: null,
        openingMinor: null,
        closingMinor: null,
        before: { kind: 'none', csvMinor: null },
        after: { kind: 'none', csvMinor: null },
        closesTarget: false,
        problems: [{ code: 'not_in_file' }],
      });
      continue;
    }
    // The days the CSV proves: the target's, unless the export ends inside it.
    const from = beforeIdx >= 0 ? target.from : inRows.length > 0 ? (inRows[0] as FillRow).date : target.from;
    const to = afterIdx >= 0 ? target.to : inRows.length > 0 ? (inRows[inRows.length - 1] as FillRow).date : target.to;
    let openingMinor: number | null = null;
    let closingMinor: number | null = null;
    if (fill.hasBalance) {
      if (beforeIdx >= 0) openingMinor = (rows[beforeIdx] as FillRow).balanceMinor;
      else if (firstIn !== undefined) {
        const f = rows[firstIn] as FillRow;
        openingMinor = f.balanceMinor === null ? null : f.balanceMinor - f.signedMinor;
      }
      if (afterIdx >= 0) {
        const a = rows[afterIdx] as FillRow;
        closingMinor = lastIn !== undefined ? (rows[lastIn] as FillRow).balanceMinor : openingMinor;
        // The row after the stretch must open where the stretch closes (chainBreakIn below checks it too).
        if (a.balanceMinor === null || closingMinor === null || a.balanceMinor - a.signedMinor !== closingMinor) {
          problems.push({ code: 'chain_broken', row: a.row });
        }
      } else {
        // The export ends inside the stretch: its last day may be cut off, so the stretch's end is not stated.
        closingMinor = null;
        problems.push({ code: 'open_end' });
      }
      const lo = beforeIdx >= 0 ? beforeIdx : (firstIn ?? 0);
      const hi = afterIdx >= 0 ? afterIdx : (lastIn ?? lo);
      const broken = chainBreakIn(rows, lo, hi);
      if (broken !== null && !problems.some((p) => p.code === 'chain_broken')) problems.push({ code: 'chain_broken', row: broken });
      if (problems.some((p) => p.code === 'chain_broken')) {
        openingMinor = null;
        closingMinor = null;
      }
    } else {
      problems.push({ code: 'no_balance_column' });
    }
    // An unreadable row (or one in another currency) inside the stretch is money the CSV moved but TILL
    // cannot read: the running balance then jumps by it, and `chainBreakIn` above names the row after it.

    parts.push({
      target,
      from,
      to,
      rows: inRows,
      entries: inRows.map((r) => r.entry),
      duplicates: [],
      restored: [],
      csvOpeningMinor: openingMinor,
      csvClosingMinor: closingMinor,
      openingMinor,
      closingMinor,
      before: { kind: 'none', csvMinor: openingMinor },
      after: { kind: 'none', csvMinor: closingMinor },
      closesTarget: false,
      problems,
    });
  }
  return parts;
}

/**
 * The ties of every planned stretch, AFTER its duplicates are decided. A row the CSV dates inside the
 * stretch but the books hold in a statement AFTER it (a card purchase on a Saturday, booked on Monday's
 * camt.053) is part of the CSV's closing balance and not of the later statement's opening, so the fill's
 * own closing is the CSV's minus that row (and, mirrored, a row the books hold BEFORE the stretch is added
 * to its opening). The fill statement then holds exactly its kept rows: opening + rows = closing. Those
 * balances are compared with the neighbours: the stored statement before (its closing), else the books the
 * day before (a fact, never a refusal), and the stored statement after (its opening).
 */
export function tieFillParts(ctx: WorkspaceContext, account: { id: string; ledger_account_id: string; currency: string }, parts: FillPart[]): void {
  const statements = readStatements(ctx, account.id);
  for (const part of parts) {
    if (part.problems.some((p) => p.code === 'not_in_file')) continue;
    // Critic r1 F3: a row is left out as "in the books" only when the side its money moves to is TIED to
    // an adjacent stored statement, so a false match is caught as untied. Without that tie (a range inside
    // a hole) the row is imported, and the one insertion's possible-duplicate flags ask the person.
    const prevAdj = statementBefore(statements, part.from, account.currency);
    const nextAdj = statementAfter(statements, part.to, account.currency);
    const tiedBefore = prevAdj !== null && heldSpanOf(prevAdj)?.to === addDays(part.from, -1);
    const tiedAfter = nextAdj !== null && heldSpanOf(nextAdj)?.from === addDays(part.to, 1);
    const stand = part.duplicates.filter((d) => (d.side === 'before' ? tiedBefore : d.side === 'after' ? tiedAfter : true));
    if (stand.length !== part.duplicates.length) {
      const skipped = new Set(stand.map((d) => d.row));
      part.restored = part.duplicates.filter((d) => !skipped.has(d.row));
      part.duplicates = stand;
      part.entries = part.rows.filter((r) => !skipped.has(r.row)).map((r) => r.entry);
    }
    const shiftBefore = part.duplicates.filter((d) => d.side === 'before').reduce((n, d) => n + d.signedMinor, 0);
    const shiftAfter = part.duplicates.filter((d) => d.side === 'after').reduce((n, d) => n + d.signedMinor, 0);
    if (part.duplicates.some((d) => d.side === 'inside') && part.csvOpeningMinor !== null) {
      // A row the books hold on one of these very days: which balance it sits in is not knowable here.
      part.problems.push({ code: 'chain_broken', row: part.duplicates.find((d) => d.side === 'inside')?.row ?? 0 });
    }
    const broken = part.problems.some((p) => p.code === 'chain_broken');
    part.openingMinor = broken || part.csvOpeningMinor === null ? null : part.csvOpeningMinor + shiftBefore;
    part.closingMinor = broken || part.csvClosingMinor === null ? null : part.csvClosingMinor - shiftAfter;
    // A neighbour ties only when it is ADJACENT (it ends the day before the stretch, or starts the day
    // after): with unheld days between, the CSV's balance there is not the statement's, and a fill of a
    // range inside a hole only proves itself.
    const prev = statementBefore(statements, part.from, account.currency);
    if (prev !== null) part.before = heldSpanOf(prev)?.to === addDays(part.from, -1) ? statementTie(prev, 'before', part.openingMinor) : { kind: 'none', csvMinor: part.openingMinor };
    else if (hasLedgerHistory(ctx, account.ledger_account_id, addDays(part.from, -1))) {
      const date = addDays(part.from, -1);
      const ledgerMinor = ledgerBalanceInAccountCurrency(ctx, account, date);
      part.before = { kind: 'books', date, ledgerMinor, csvMinor: part.openingMinor, differenceMinor: part.openingMinor === null ? null : part.openingMinor - ledgerMinor };
    } else part.before = { kind: 'none', csvMinor: part.openingMinor };
    const next = statementAfter(statements, part.to, account.currency);
    part.after = next !== null && heldSpanOf(next)?.from === addDays(part.to, 1) ? statementTie(next, 'after', part.closingMinor) : { kind: 'none', csvMinor: part.closingMinor };
    for (const [side, tie] of [['before', part.before], ['after', part.after]] as const) {
      if (tie.kind === 'statement' && tie.differenceMinor !== null && tie.differenceMinor !== 0) part.problems.push({ code: 'untied', side, differenceMinor: tie.differenceMinor });
    }
    const agrees = (tie: FillTie): boolean => tie.kind !== 'statement' || tie.differenceMinor === 0;
    const proven = part.openingMinor !== null && part.closingMinor !== null && part.problems.length === 0;
    part.closesTarget = proven && part.from === part.target.from && part.to === part.target.to && agrees(part.before) && agrees(part.after);
  }
}

// --- Duplicates (skip_proven) --------------------------------------------------------------------------

interface StoredRefLine {
  id: string;
  entry_key: string;
  entry_ref: string | null;
  acct_svcr_ref: string | null;
  booking_date: string | null;
  value_date: string | null;
  credit_debit: string;
  amount_minor: number;
  currency: string;
  counterparty_name: string | null;
  remittance_text: string | null;
  payer_name: string | null;
  s_from: string | null;
  s_to: string | null;
}

/**
 * The BANK's references a stored line carries: its `AcctSvcrRef` fact and its `asr:` / `m9:` key. Never its
 * entry reference (critic r1 F3: on a CSV line that is a mapped column, never the bank's word, D178).
 */
function storedRefsOf(l: StoredRefLine): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = v?.trim();
    if (t !== undefined && t !== '') out.add(t.toUpperCase());
  };
  add(l.acct_svcr_ref);
  const m = /^(?:asr|m9):(.*)$/.exec(l.entry_key);
  if (m !== null) add((m[1] as string).replace(/~dup\d+$/, '').replace(/#\d+$/, ''));
  return [...out];
}

/** A reference without a trailing `-<digits>` (ZKB's `-1`), or null when it has none. */
function baseRef(ref: string): string | null {
  const m = /^(.+)-\d{1,3}$/.exec(ref);
  return m === null ? null : (m[1] as string);
}

/**
 * Leave out the rows the books already hold (`skip_proven`), one to one: first the bank's own reference
 * with the same money (any date: a card line's dates differ between the CSV and the camt), then the same
 * date (the stored booking or value date), the same money and a shared word of the text or name. Reads
 * the account's lines within a month of the rows' dates. Mutates `parts` (entries, duplicates).
 */
export function decideFillDuplicates(ctx: WorkspaceContext, bankAccountId: string, mapping: CsvMapping, parts: FillPart[]): void {
  const all = parts.flatMap((p) => p.rows);
  if (all.length === 0) return;
  const dates = all.map((r) => r.date).sort();
  const from = addDays(dates[0] as string, -31);
  const to = addDays(dates[dates.length - 1] as string, 31);
  const stored = ctx.store.db
    .prepare(
      `SELECT t.id, t.entry_key, t.entry_ref, f.acct_svcr_ref, t.booking_date, t.value_date, t.credit_debit, t.amount_minor, t.currency,
              d.counterparty_name, d.remittance_text, t.payer_name, s.from_date AS s_from, s.to_date AS s_to
         FROM bank_txn t
         JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id
         LEFT JOIN bank_txn_fact f ON f.workspace_id = t.workspace_id AND f.bank_txn_id = t.id
         LEFT JOIN bank_txn_detail d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND t.bank_account_id = ?
          AND ((t.booking_date >= ? AND t.booking_date <= ?) OR (t.value_date >= ? AND t.value_date <= ?))
        ORDER BY t.rowid`,
    )
    .all(ctx.workspaceId, bankAccountId, from, to, from, to) as StoredRefLine[];
  const used = new Set<string>();
  const money = (cd: string, a: number, c: string) => `${cd}|${a}|${c}`;
  // `strip_dash_number` strips the INCOMING reference only (critic r1 F4): the CSV's `L...-1` meets the
  // camt's `L...`; a stored `L...-1` never meets an incoming `L...-2`.
  const keysOf = (ref: string): string[] => {
    const b = mapping.referenceSuffix === 'strip_dash_number' ? baseRef(ref) : null;
    return b === null ? [ref] : [ref, b];
  };
  const near = (s: StoredRefLine, day: string): boolean =>
    [s.booking_date, s.value_date].some((d) => d !== null && Math.abs(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) <= 31 * 86_400_000);
  const byRef = new Map<string, StoredRefLine[]>();
  for (const s of stored) {
    for (const ref of storedRefsOf(s)) {
      const list = byRef.get(ref) ?? [];
      list.push(s);
      byRef.set(ref, list);
    }
  }
  for (const part of parts) {
    const keep: ParsedCamtEntry[] = [];
    for (const r of part.rows) {
      const e = r.entry;
      const m = money(e.creditDebit, e.amountMinor, e.currency);
      let hit: { id: string; by: 'reference' | 'movement' } | null = null;
      const ref = e.entryRef?.trim().toUpperCase() ?? '';
      if (ref !== '') {
        // The bank's reference proves the movement only with the same money (never a reference alone).
        // Within a month of the row's own date (critic r1 F3: never the whole file's window).
        const c = keysOf(ref)
          .flatMap((k) => byRef.get(k) ?? [])
          .find((s) => !used.has(s.id) && money(s.credit_debit, s.amount_minor, s.currency) === m && near(s, r.date));
        if (c !== undefined) hit = { id: c.id, by: 'reference' };
      }
      if (hit === null) {
        const words = nameTokens([e.counterpartyName, e.remittanceText, e.facts?.bankText].filter((x): x is string => typeof x === 'string' && x !== '').join(' '));
        if (words !== null) {
          const c = stored.find((s) => {
            if (used.has(s.id) || money(s.credit_debit, s.amount_minor, s.currency) !== m) return false;
            if (s.booking_date !== r.date && s.value_date !== r.date) return false;
            const theirs = nameTokens([s.counterparty_name, s.payer_name, s.remittance_text].filter((x): x is string => typeof x === 'string' && x !== '').join(' '));
            if (theirs === null) return false;
            for (const w of words) if (theirs.has(w)) return true;
            return false;
          });
          if (c !== undefined) hit = { id: c.id, by: 'movement' };
        }
      }
      if (hit !== null) {
        used.add(hit.id);
        const line = stored.find((x) => x.id === hit?.id) as StoredRefLine;
        const span = heldSpanOf({ from_date: line.s_from, to_date: line.s_to });
        const side = span === null ? 'inside' : span.to < part.from ? 'before' : span.from > part.to ? 'after' : 'inside';
        part.duplicates.push({ row: r.row, existingBankTxnId: hit.id, by: hit.by, signedMinor: r.signedMinor, side });
      } else keep.push(e);
    }
    part.entries = keep;
  }
}

// --- The statement a part writes -----------------------------------------------------------------------

/** The statement one part writes: a CSV statement over the proven days, with the balances the CSV states. */
export function fillStatementOf(part: FillPart, currency: string, mappingDigest: string, tieMode: CsvFillBalanceTieMode): ParsedBankStatement {
  const proven = !part.problems.some((p) => p.code === 'chain_broken' || p.code === 'no_balance_column');
  // An untied stretch imported under `warn` keeps the CSV's balances: they are the bank's own figures, and
  // the gap model then still sees the contradiction (it never reads such a fill as closing a gap).
  const opening = proven && (tieMode === 'warn' || !part.problems.some((p) => p.code === 'untied')) ? part.openingMinor : null;
  const closing = proven && (tieMode === 'warn' || !part.problems.some((p) => p.code === 'untied')) ? part.closingMinor : null;
  const canonical = [
    part.from,
    part.to,
    opening ?? '',
    closing ?? '',
    mappingDigest,
    ...part.entries.map((e) => [e.entryKey, e.bookingDate, e.creditDebit, e.amountMinor, e.currency, e.entryRef ?? '', e.remittanceText ?? ''].join('\u001f')),
  ].join('\n');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
  return {
    messageType: 'csv',
    statementId: `csvfill:${digest}`,
    electronicSeqNb: null,
    pageNumber: 1,
    lastPage: true,
    splitPage: false,
    iban: null,
    fromDate: part.from,
    toDate: part.to,
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    balanceCurrency: opening !== null || closing !== null ? currency : null,
    entries: part.entries,
    skipped: [],
  };
}
