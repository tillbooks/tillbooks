/**
 * A36 §4.7 (D150), THE STATEMENT GAP READ MODEL, and the one human act that may close a gap without a
 * statement: the confirmation that nothing is missing.
 *
 * WHY IT EXISTS. The jump notice (`lastNumberJump`) is re-derived from the last two feed-imported
 * statements, so it vanished at the next ordinary fetch while the numbers were still missing, a partial
 * fill silently dropped the lower numbers, and a hand import never raised it at all. A gap is a fact
 * about the BOOK: two neighbouring day-end statements of one Bankkonto whose numbers skip. This module
 * derives that fact from `bank_statement` every time it is asked, for every account (fed over EBICS or
 * imported by hand), so it stays true until the missing statements are in the books or a person
 * confirms that none exist.
 *
 * READ ONLY OVER THE MONEY PATH. Nothing here imports, posts or changes a statement. `decideSuccessor`
 * is untouched: a statement found later still imports by rule 3, whatever was confirmed. The one write,
 * `confirmStatementGap` / `revokeStatementGapConfirmation` (in `statementGapAck.ts`, critic round 2
 * LOW 2: there it reads the channel's waiting statements itself), appends a row to
 * `bank_statement_gap_ack` and nothing else; the latest row for a gap decides whether it is confirmed.
 *
 * THE RULE FOR A CONFIRMATION (owner, 01.10.2026). Only a person, never an agent alone; only when the
 * balances chain (`differenceMinor` 0: the later statement opens exactly on the earlier one's close);
 * only while the gap is still open in the book; always with a reason. A gap with an unexplained amount
 * can never be confirmed away.
 *
 * §H-TENANT on every query: each one is fenced by `workspace_id`.
 */

import type { WorkspaceContext } from '../context.js';
import { comparePositions, readFeedBook, skippedBetween } from './ebics/feed.js';
import { isClearingDay } from '../liquidity/calendar.js';
import type { FeedBookRow, FeedPosition, FeedSkippedRange } from './ebics/feed.js';

/**
 * One statement as the gap model reads the book (critic M2): a single-page day-end statement, or every
 * page of a split one gathered under its position. The successor rule (`feed.ts`) still knows only
 * whole single-page statements; this model only has to know which NUMBERS the book holds, so a split
 * statement's number is present, and its balances are the first page's opening and the last page's
 * closing, when every page is there.
 */
interface GapStatement {
  /** The balances of the whole statement, under the first page's id (null closing when incomplete). */
  row: FeedBookRow;
  position: FeedPosition;
  /** A split statement whose pages are not all in the books: its closing balance is unknown. */
  incomplete: boolean;
  /** Critic round 2, N2: copies of one statement whose balances differ (a re-delivery that changed). */
  conflicting?: boolean;
}

/** Is this end of a gap one whose money cannot be judged (incomplete, or conflicting copies)? */
function flagged(s: GapStatement): boolean {
  return s.incomplete || s.conflicting === true;
}

/**
 * Ids in their NUMERIC order where they share a prefix (`bstmt_9` before `bstmt_10`), else as text, so
 * a tie-break never depends on string comparison of sequence ids (pre-launch critic A1).
 */
function idOrder(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma !== null && mb !== null && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Two balance facts agree: equal minor units, or both unknown. */
function sameBalances(a: FeedBookRow, b: FeedBookRow): boolean {
  return (
    a.opening_balance_minor === b.opening_balance_minor &&
    a.closing_balance_minor === b.closing_balance_minor &&
    (a.balance_currency ?? '') === (b.balance_currency ?? '')
  );
}

/**
 * THE ONE RULE for the rows the book holds at one position (year of FrDtTm, ElctrncSeqNb), written down
 * once (narrow critic round, 01.10.2026) instead of patched per case. It decides only what the GAP model
 * says about that number; the successor rule (`feed.ts`) is untouched.
 *
 *  CANDIDATES. Each WHOLE COPY (a row that is page 1 and the last page) is one candidate. All other rows
 *  (the pages of a split statement) together are one more, the SPLIT.
 *  IGNORED. A candidate without an opening or without a closing balance (a `not_day_end_statement`
 *  export, or a split with its first or last page missing) takes no part in agreement or completeness.
 *  THE SPLIT. Its rows are grouped by page number. Two rows on one page number with different
 *  (opening, closing, currency) make the position CONFLICTING; identical duplicates collapse to one. The
 *  split is COMPLETE when pages 1..n are all present, page n is marked the last page, and every page
 *  k > 1 opens on page k-1's close in the same currency, wherever both balances are stated (a bank
 *  states interim balances as INTM, which the parser does not store, so an unstated pair is no break).
 *  All pages present but a break in that chain: CONFLICTING. Pages missing: an INCOMPLETE candidate,
 *  opening on page 1's opening when page 1 is there.
 *  THE VERDICT. CONFLICTING when flagged above or when two complete candidates disagree on (opening,
 *  closing, currency); else COMPLETE when any candidate is complete (the lowest-id complete one stands
 *  for it); else INCOMPLETE. A position whose every row was ignored is INCOMPLETE too: the number is
 *  present, but nothing about its money can be trusted. Never complete.
 *
 * The answer depends on neither the order the rows were imported in nor on ids compared as strings
 * (tie-breaks use `idOrder`).
 */
function positionVerdict(rowsAt: readonly FeedBookRow[], position: FeedPosition): GapStatement {
  const byId = [...rowsAt].sort((a, b) => idOrder(a.id, b.id));
  const whole = byId.filter((r) => r.page_number === 1 && r.last_page_ind === 1);
  const splitRows = byId.filter((r) => !(r.page_number === 1 && r.last_page_ind === 1));
  const hasBalances = (r: FeedBookRow) => r.opening_balance_minor !== null && r.closing_balance_minor !== null;
  const anchor = byId[0] as FeedBookRow;
  const conflict = (base: FeedBookRow): GapStatement => ({
    row: { ...base, opening_balance_minor: null, closing_balance_minor: null },
    position,
    incomplete: false,
    conflicting: true,
  });

  const complete: FeedBookRow[] = whole.filter(hasBalances);
  let incompleteCandidate: FeedBookRow | null = null;

  if (splitRows.length > 0) {
    const pages = new Map<number, FeedBookRow>();
    for (const r of splitRows) {
      const seen = pages.get(r.page_number);
      if (seen === undefined) pages.set(r.page_number, r);
      else if (!sameBalances(seen, r)) return conflict(anchor); // one page, two different contents
    }
    const numbers = [...pages.keys()].sort((a, b) => a - b);
    const lastNumber = numbers[numbers.length - 1] as number;
    const first = pages.get(1) ?? null;
    const last = pages.get(lastNumber) as FeedBookRow;
    const allPresent = first !== null && numbers.length === lastNumber && last.last_page_ind === 1;
    if (allPresent) {
      for (let k = 2; k <= lastNumber; k += 1) {
        const prev = pages.get(k - 1) as FeedBookRow;
        const cur = pages.get(k) as FeedBookRow;
        const stated = prev.closing_balance_minor !== null && cur.opening_balance_minor !== null;
        const currencyKnown = prev.balance_currency !== null && cur.balance_currency !== null;
        if ((stated && prev.closing_balance_minor !== cur.opening_balance_minor) || (currencyKnown && prev.balance_currency !== cur.balance_currency)) {
          return conflict(anchor); // all pages there, but they do not chain
        }
      }
      const statement: FeedBookRow = {
        ...first,
        opening_balance_minor: first.opening_balance_minor,
        closing_balance_minor: last.closing_balance_minor,
        to_date: last.to_date ?? first.to_date,
        balance_currency: first.balance_currency ?? last.balance_currency ?? null,
        page_number: 1,
        last_page_ind: 1,
        txn_count: [...pages.values()].reduce((n, p) => n + p.txn_count, 0),
      };
      if (hasBalances(statement)) complete.push(statement);
    } else {
      const base = first ?? (pages.get(numbers[0] as number) as FeedBookRow);
      incompleteCandidate = {
        ...base,
        opening_balance_minor: first?.opening_balance_minor ?? null,
        closing_balance_minor: null,
        page_number: 1,
        last_page_ind: 0,
        txn_count: [...pages.values()].reduce((n, p) => n + p.txn_count, 0),
      };
    }
  }

  const chosen = [...complete].sort((a, b) => idOrder(a.id, b.id))[0];
  if (chosen !== undefined) {
    if (!complete.every((c) => sameBalances(c, chosen))) return conflict(chosen);
    return { row: chosen, position, incomplete: false };
  }
  // No complete candidate: incomplete, whether a split misses pages or every row was ignored.
  const base = incompleteCandidate ?? anchor;
  return { row: { ...base, closing_balance_minor: null }, position, incomplete: true };
}

/** The book's statements by position (`positionVerdict`); rows without a number or a date are skipped. */
function gapStatements(rows: readonly FeedBookRow[]): GapStatement[] {
  const groups = new Map<string, FeedBookRow[]>();
  for (const row of rows) {
    if (row.message_type !== 'camt053' || row.electronic_seq_nb === null || !/^\d{1,9}$/.test(row.electronic_seq_nb.trim())) continue;
    if (row.from_date === null || !/^\d{4}-\d{2}-\d{2}/.test(row.from_date)) continue;
    const key = `${row.from_date.slice(0, 4)}:${Number.parseInt(row.electronic_seq_nb.trim(), 10)}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: GapStatement[] = [];
  for (const rowsAt of groups.values()) {
    const anchorRow = rowsAt[0] as FeedBookRow;
    const position = {
      year: Number.parseInt((anchorRow.from_date as string).slice(0, 4), 10),
      number: Number.parseInt((anchorRow.electronic_seq_nb as string).trim(), 10),
    };
    out.push(positionVerdict(rowsAt, position));
  }
  out.sort((a, b) => comparePositions(a.position, b.position) || idOrder(a.row.id, b.row.id));
  return out;
}

/** One end of a gap: a statement in the books, or (for a pending gap's `before`) a downloaded one. */
export interface StatementGapRef {
  /** The `bank_statement` row id; null for a downloaded statement that is not in the books. */
  statementRowId: string | null;
  /** The E00 document id of a downloaded statement still waiting; null for a statement in the books. */
  documentId: string | null;
  number: number;
  year: number;
  fromDate: string | null;
  toDate: string | null;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  /** Critic M2: a split statement whose pages are not all in the books (its closing balance is unknown). */
  incomplete?: boolean;
  /** Critic round 2, N2: the books hold copies of this statement with different balances. */
  conflicting?: boolean;
}

/** A downloaded statement the successor rule refuses as `gap_refused`, read off the channel's pending members. */
export interface PendingGapStatement {
  bankAccountId: string;
  documentId: string;
  position: FeedPosition;
  fromDate: string | null;
  toDate: string | null;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  currency: string | null;
  /** The rule's own difference (the statement's opening minus the balance it does not chain to). */
  differenceMinor: number;
  reason: string;
}

/** A refused statement named on the gap it belongs to (it waits inside or behind the gap). */
export interface StatementGapRefused {
  documentId: string;
  number: number;
  year: number;
  fromDate: string | null;
  differenceMinor: number;
  reason: string;
}

export interface StatementGap {
  /** `${after}:${before}`: stable while both ends stand. */
  gapId: string;
  bankAccountId: string;
  /** `book`: both ends in the books. `pending`: `before` is a downloaded statement the rule refused. */
  source: 'book' | 'pending';
  after: StatementGapRef;
  before: StatementGapRef;
  /** The missing numbers that are knowable (a year turn names only the new year's, see below). */
  missing: FeedSkippedRange[];
  /**
   * True across a year turn: how many statements the old year still had is unknown. With `missing`
   * empty (the new year starts at 1) the gap names no number at all, only the days.
   */
  oldYearTailUnknown: boolean;
  /** The days to fetch in eBanking: the day after `after` starts to the day before `before` starts. */
  missingDates: { from: string | null; to: string | null };
  /** The balances chain: `before` opens exactly on `after`'s close, so no money is missing. */
  chains: boolean;
  /** `before.opening - after.closing` in minor units: what stands in the missing statements. */
  differenceMinor: number;
  currency: string | null;
  /** Downloaded statements refused inside (or, for a pending gap, behind) this gap. */
  refused: StatementGapRefused[];
  /**
   * A person may confirm it closed: a book gap whose balances chain AND that no downloaded statement
   * waits inside (critic H1: a refused statement inside the gap proves money the books do not explain).
   */
  confirmable: boolean;
  /** Money stands unexplained in this gap: the balances do not chain, or a refused statement waits inside. */
  unexplained: boolean;
  /**
   * Critic round 2 LOW 1: a person confirmed this gap earlier, and the confirmation no longer holds
   * (a refused statement now waits inside, or an end cannot be judged): the gap is open again.
   */
  confirmationVoid?: boolean;
}

/** One `bank_statement_gap_ack` row, the columns the read model needs. */
interface AckRow {
  after_statement_id: string;
  before_statement_id: string;
  action: string;
}

/** The two actions a confirmation row records (§H-ENUM, single point). */
export const STATEMENT_GAP_ACK_ACTIONS = ['confirm', 'revoke'] as const;


function addDays(date: string, n: number): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function bookRef(b: GapStatement): StatementGapRef {
  return {
    statementRowId: b.row.id,
    documentId: null,
    number: b.position.number,
    year: b.position.year,
    fromDate: b.row.from_date,
    toDate: b.row.to_date,
    openingBalanceMinor: b.row.opening_balance_minor,
    closingBalanceMinor: b.row.closing_balance_minor,
    ...(b.incomplete ? { incomplete: true } : {}),
    ...(b.conflicting === true ? { conflicting: true } : {}),
  };
}

/**
 * The days a person fetches in eBanking for the hole between two statements: the day after the
 * earlier statement starts to the day before the later one starts. A day-end statement is dated by its
 * `FrDtTm` (its `ToDtTm` may read as the next midnight), so the start dates are the ones compared. When
 * that range is empty (the skipped numbers fall on one of the two days), both statement days are named:
 * fetching a day already in the books is harmless, it answers `already_imported`.
 */
function missingDatesOf(afterFrom: string | null, beforeFrom: string | null): { from: string | null; to: string | null } {
  if (afterFrom === null || beforeFrom === null) return { from: afterFrom, to: beforeFrom };
  const from = addDays(afterFrom, 1);
  const to = addDays(beforeFrom, -1);
  if (from > to) return { from: afterFrom.slice(0, 10), to: beforeFrom.slice(0, 10) };
  return { from, to };
}

/**
 * Critic M1, round 2 LOW 3: across a year turn, are days missing between the old year's last statement
 * and the new year's first? A day-end statement exists for a bank business day, so a day is missing
 * when at least one SIC clearing day lies STRICTLY between the two statement days (weekends, 25.12,
 * 26.12, 1.1 and 2.1 are closed: `isClearingDay`, A40's SIX calendar, reused). Unknown dates count as
 * missing.
 */
export function yearTurnDaysMissing(afterFrom: string | null, beforeFrom: string | null): boolean {
  if (afterFrom === null || beforeFrom === null) return true;
  const end = beforeFrom.slice(0, 10);
  for (let d = addDays(afterFrom, 1); d < end; d = addDays(d, 1)) {
    if (isClearingDay(d)) return true;
  }
  return false;
}

/** The confirmed gaps of one account: (after, before) pairs whose LATEST ack row is a confirm. */
export function confirmedPairs(ctx: WorkspaceContext, bankAccountId: string): Set<string> {
  const rows = ctx.store.db
    .prepare(
      `SELECT after_statement_id, before_statement_id, action FROM bank_statement_gap_ack
        WHERE workspace_id = ? AND bank_account_id = ? ORDER BY rowid`,
    )
    .all(ctx.workspaceId, bankAccountId) as AckRow[];
  const latest = new Map<string, string>();
  for (const r of rows) latest.set(`${r.after_statement_id}:${r.before_statement_id}`, r.action);
  return new Set([...latest].filter(([, action]) => action === 'confirm').map(([key]) => key));
}

/** A gap with the confirmation state the book records for it. */
export interface StatementGapWithState extends StatementGap {
  confirmed: boolean;
}

/**
 * Every gap of ONE account, confirmed ones included and marked (the confirm verb needs to see them).
 * `pending` are the account's downloaded statements the rule refuses as `gap_refused`.
 */
export function accountStatementGaps(
  ctx: WorkspaceContext,
  bankAccountId: string,
  pending: readonly PendingGapStatement[] = [],
): StatementGapWithState[] {
  const statements = gapStatements(readFeedBook(ctx, bankAccountId));
  const confirmed = confirmedPairs(ctx, bankAccountId);
  const mine = pending.filter((p) => p.bankAccountId === bankAccountId).sort((a, b) => comparePositions(a.position, b.position));
  const gaps: StatementGapWithState[] = [];

  for (let i = 1; i < statements.length; i += 1) {
    const a = statements[i - 1] as GapStatement;
    const b = statements[i] as GapStatement;
    const missing = skippedBetween(a.position, b.position);
    const sameCurrency = (a.row.balance_currency ?? '') === (b.row.balance_currency ?? '');
    // Critic M2: an incomplete split statement has no known closing balance, so nothing about the money
    // between it and its neighbour can be said: never "chains", and the gap names the incomplete end.
    const balancesKnown = a.row.closing_balance_minor !== null && b.row.opening_balance_minor !== null && !flagged(a) && !flagged(b);
    const differenceMinor = balancesKnown ? (b.row.opening_balance_minor ?? 0) - (a.row.closing_balance_minor ?? 0) : 0;
    const chains = balancesKnown && sameCurrency && differenceMinor === 0;
    // Critic M1: a year turn to number 1 skips no KNOWABLE number, yet the old year's tail may be
    // missing. It is a gap when the balances do not chain, or when more days lie between the two
    // statements than a year end explains (`yearTurnDaysMissing`).
    const yearTurnGap = missing.length === 0 && a.position.year !== b.position.year && (!chains || yearTurnDaysMissing(a.row.from_date, b.row.from_date));
    // Critic round 2, N1: an incomplete statement ALWAYS yields an item, whatever its neighbours: as
    // the earlier end of its pair, or as the later end when it is the newest statement.
    const flaggedPair = flagged(a) || (flagged(b) && i === statements.length - 1);
    if (missing.length === 0 && !yearTurnGap && !flaggedPair) continue;
    const flaggedEnd = flagged(a) || flagged(b);
    const gapId = `${a.row.id}:${b.row.id}`;
    const refused = mine
      .filter((p) => comparePositions(p.position, a.position) > 0 && comparePositions(p.position, b.position) < 0)
      .map(refusedOf);
    gaps.push({
      gapId,
      bankAccountId,
      source: 'book',
      after: bookRef(a),
      before: bookRef(b),
      missing,
      oldYearTailUnknown: a.position.year !== b.position.year,
      missingDates: missingDatesOf(a.row.from_date, b.row.from_date),
      chains,
      differenceMinor,
      currency: b.row.balance_currency ?? a.row.balance_currency,
      refused,
      confirmable: chains && refused.length === 0 && !flaggedEnd,
      unexplained: !chains || refused.length > 0 || flaggedEnd,
      confirmed: chains && refused.length === 0 && !flaggedEnd && confirmed.has(gapId),
      ...(confirmed.has(gapId) && (refused.length > 0 || flaggedEnd || !chains) ? { confirmationVoid: true } : {}),
    });
  }

  // N1: an incomplete statement that is the ONLY statement in the books still yields its item.
  const lone = statements.length === 1 ? statements[0] : undefined;
  if (lone !== undefined && flagged(lone)) {
    gaps.push({
      gapId: `${lone.row.id}:${lone.row.id}`,
      bankAccountId,
      source: 'book',
      after: bookRef(lone),
      before: bookRef(lone),
      missing: [],
      oldYearTailUnknown: false,
      missingDates: { from: lone.row.from_date, to: lone.row.from_date },
      chains: false,
      differenceMinor: 0,
      currency: lone.row.balance_currency,
      refused: [],
      confirmable: false,
      unexplained: true,
      confirmed: false,
    });
  }

  // A downloaded statement waiting above the newest statement in the books: the feed stops there until
  // the missing statements are imported. The lowest one makes the gap; the others wait behind it.
  const newest = statements[statements.length - 1];
  if (newest !== undefined) {
    const above = mine.filter((p) => comparePositions(p.position, newest.position) > 0);
    const first = above[0];
    if (first !== undefined) {
      gaps.push({
        gapId: `${newest.row.id}:${first.documentId}`,
        bankAccountId,
        source: 'pending',
        after: bookRef(newest),
        before: {
          statementRowId: null,
          documentId: first.documentId,
          number: first.position.number,
          year: first.position.year,
          fromDate: first.fromDate,
          toDate: first.toDate,
          openingBalanceMinor: first.openingBalanceMinor,
          closingBalanceMinor: first.closingBalanceMinor,
        },
        missing: skippedBetween(newest.position, first.position),
        oldYearTailUnknown: newest.position.year !== first.position.year,
        missingDates: missingDatesOf(newest.row.from_date, first.fromDate),
        chains: false,
        differenceMinor: first.differenceMinor,
        currency: first.currency ?? newest.row.balance_currency,
        refused: above.map(refusedOf),
        confirmable: false,
        unexplained: true,
        confirmed: false,
      });
    }
  }
  return gaps;
}

function refusedOf(p: PendingGapStatement): StatementGapRefused {
  return {
    documentId: p.documentId,
    number: p.position.number,
    year: p.position.year,
    fromDate: p.fromDate,
    differenceMinor: p.differenceMinor,
    reason: p.reason,
  };
}

/** The non-archived Bankkonten of the workspace (or the one named), in a stable order. */
function accountIds(ctx: WorkspaceContext, bankAccountId?: string): string[] {
  const rows = (
    bankAccountId !== undefined
      ? ctx.store.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND id = ?').all(ctx.workspaceId, bankAccountId)
      : ctx.store.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND archived = 0 ORDER BY created_at, id').all(ctx.workspaceId)
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * THE READ MODEL: every OPEN gap (not confirmed) of every Bankkonto, or of the one named. `pending` are
 * the downloaded statements the channel holds as `gap_refused` (`readStatementGaps` in the EBICS
 * channel passes them; without a channel there are none).
 */
export function statementGaps(
  ctx: WorkspaceContext,
  input: { bankAccountId?: string } = {},
  pending: readonly PendingGapStatement[] = [],
): StatementGap[] {
  const out: StatementGap[] = [];
  for (const id of accountIds(ctx, input.bankAccountId)) {
    for (const gap of accountStatementGaps(ctx, id, pending)) {
      if (gap.confirmed) continue;
      const { confirmed: _confirmed, ...open } = gap;
      void _confirmed;
      out.push(open);
    }
  }
  return out;
}
