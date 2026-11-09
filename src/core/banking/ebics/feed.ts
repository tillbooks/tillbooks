/**
 * A36 §4.4, THE SUCCESSOR RULE: which camt.053 an EBICS-fed Bankkonto takes, whichever door the file
 * came through (the EBICS download or a hand `import_camt`).
 *
 * WHY IT EXISTS. The owner bridged by hand until the channel went live, and keeps the hand door for the
 * days EBICS cannot deliver. Two doors onto one account can double a day, skip a day, or take an older
 * copy over a newer one. The rule makes each statement land exactly once, in order, with its balances
 * chained, and refuses everything else with a message that names what is missing. There is no legacy
 * cutover and no recorded start date: the feed starts at the newest statement already in the books.
 *
 * THE FACTS IT READS (ZKB ISO 20022 V2019 handbook v1.12, pp.45-46; SPS IG Cash Management 2.3):
 *  - A DAY-END statement is a single-page camt.053 with `ElctrncSeqNb`, `FrDtTm`, `OPBD` and `CLBD`.
 *  - Its POSITION is (calendar year of `FrDtTm`, `ElctrncSeqNb` as an integer): ZKB numbers per
 *    calendar year, keeps the number on a re-created copy (`CpyDplcInd` DUPL, a new message id) and
 *    re-delivers with the same message id and number. The year is read from `FrDtTm`, never `ToDtTm`,
 *    because `ToDtTm` may read as the next midnight. Numbers compare as integers (A20 stores TEXT, so
 *    "9" would sort after "10"), dates as dates, balances in minor units in the same currency.
 *
 * THE RULES, in the order they are decided (spec §4.4):
 *  0. not a day-end statement: `not_day_end_statement`; a page of a split statement:
 *     `unsupported_multipage_statement`. Both pending.
 *  1. already there (same position, same OPBD and CLBD): `already_imported`, a no-op, whatever the
 *     message id or `Stmt/Id`.
 *  2. the successor (no newest yet, or a position above the newest's that starts no earlier than the
 *     newest ends and opens on the newest's closing balance): imported. A number jump whose balances
 *     chain imports with the notice `statement_number_jump`, naming the skipped numbers.
 *  3. the hole filler (a position absent from the books, below the newest, opening on the nearest lower
 *     statement's closing balance and, when the next higher statement is adjacent, closing on its
 *     opening balance): imported.
 *  4. a gap (any other statement above the newest, or absent below it with a lower neighbour):
 *     `gap_refused`, pending, naming the statement it does not chain to and the difference.
 *  5. an overlap (a position present in the books with other balances): `overlap_refused`, FINAL. Older
 *     than the first statement in the books: `before_feed_start`, pending and quiet.
 * Only rules 2 and 3 import, so a camt.053 cannot count twice.
 *
 * PURE. `decideSuccessor` reads the rows it is handed and writes nothing. The two readers below it read
 * `bank_statement` and the channel routing under §H-TENANT; `importCamt` calls all three inside its own
 * write transaction, before any row and before A20's statement dedupe (spec §4.4).
 */

import type { WorkspaceContext } from '../../context.js';

/** A statement's place in its account's sequence: (calendar year of FrDtTm, ElctrncSeqNb). */
export interface FeedPosition {
  year: number;
  number: number;
}

/** The candidate statement's facts, as `parseCamt` reads them. */
export interface FeedCandidate {
  messageType: string;
  electronicSeqNb: string | null;
  fromDate: string | null;
  toDate: string | null;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  balanceCurrency: string | null;
  pageNumber: number;
  lastPage: boolean;
  splitPage: boolean;
}

/** One `bank_statement` row the rule compares against (the columns it reads, nothing more). */
export interface FeedBookRow {
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
  txn_count: number;
}

/** The statement a refusal or notice names: its position and dates, never its lines. */
export interface FeedStatementRef {
  number: number;
  year: number;
  fromDate: string | null;
  toDate: string | null;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
}

/** A run of skipped statement numbers in one year (`statement_number_jump`). */
export interface FeedSkippedRange {
  year: number;
  from: number;
  to: number;
}

/**
 * A number jump as the owner reads it (§4.4 rule 2): the statement before it, the statement that jumped,
 * and the skipped numbers. The sync answer carries one per jumping import; the status the last one.
 */
export interface FeedNumberJump {
  after: { number: number; year: number };
  statement: { number: number; year: number };
  skipped: FeedSkippedRange[];
}

/** The refusal codes the rule answers (§4.4, all NEW with A36 except A39's `not_day_end_statement`). */
export const FEED_REFUSAL_CODES = [
  'not_day_end_statement',
  'unsupported_multipage_statement',
  'gap_refused',
  'overlap_refused',
  'before_feed_start',
] as const;
export type FeedRefusalCode = (typeof FEED_REFUSAL_CODES)[number];

/**
 * The three outcomes that are FINAL (D-A36.5): a downloaded statement with one of them is never
 * processed again. Every other outcome is re-run from the persisted bytes at each sync.
 */
export const FEED_FINAL_OUTCOMES: readonly string[] = ['imported', 'already_imported', 'overlap_refused'];

export type FeedDecision =
  | {
      verdict: 'import';
      rule: 'feed_start' | 'successor' | 'hole_filler';
      position: FeedPosition;
      /** Present only on a rule-2 import that skipped numbers (`statement_number_jump`). */
      jump?: { after: FeedStatementRef; skipped: FeedSkippedRange[] };
    }
  | { verdict: 'already_imported'; position: FeedPosition; statementRowId: string; txnCount: number }
  | {
      verdict: 'refused';
      code: FeedRefusalCode;
      final: boolean;
      position: FeedPosition | null;
      details: Record<string, unknown>;
    };

// --- positions ---------------------------------------------------------------------------------

function integerOrNull(v: string | null): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

function yearOf(date: string | null): number | null {
  if (date === null || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  return Number.parseInt(date.slice(0, 4), 10);
}

/** A day-end statement's position, or null when it is not one (rule 0). */
export function dayEndPosition(s: {
  messageType: string;
  electronicSeqNb: string | null;
  fromDate: string | null;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
}): FeedPosition | null {
  if (s.messageType !== 'camt053') return null;
  const number = integerOrNull(s.electronicSeqNb);
  const year = yearOf(s.fromDate);
  if (number === null || year === null) return null;
  if (s.openingBalanceMinor === null || s.closingBalanceMinor === null) return null;
  return { year, number };
}

/** -1, 0 or 1: the calendar year first, then the number, as integers. */
export function comparePositions(a: FeedPosition, b: FeedPosition): number {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  return 0;
}

export interface BookStatement {
  row: FeedBookRow;
  position: FeedPosition;
}

/** The day-end statements among the rows, each with its position: pages and unnumbered rows are skipped. */
export function bookStatements(rows: readonly FeedBookRow[]): BookStatement[] {
  const out: BookStatement[] = [];
  for (const row of rows) {
    if (row.page_number !== 1 || row.last_page_ind !== 1) continue;
    const position = dayEndPosition({
      messageType: row.message_type,
      electronicSeqNb: row.electronic_seq_nb,
      fromDate: row.from_date,
      openingBalanceMinor: row.opening_balance_minor,
      closingBalanceMinor: row.closing_balance_minor,
    });
    if (position !== null) out.push({ row, position });
  }
  out.sort((a, b) => comparePositions(a.position, b.position) || a.row.id.localeCompare(b.row.id));
  return out;
}

function refOf(b: BookStatement): FeedStatementRef {
  return {
    number: b.position.number,
    year: b.position.year,
    fromDate: b.row.from_date,
    toDate: b.row.to_date,
    openingBalanceMinor: b.row.opening_balance_minor,
    closingBalanceMinor: b.row.closing_balance_minor,
  };
}

function sameCurrency(a: string | null, b: string | null): boolean {
  return (a ?? '') === (b ?? '');
}

/** The skipped numbers between the newest and a later candidate (only the numbers that are knowable). */
export function skippedBetween(newest: FeedPosition, candidate: FeedPosition): FeedSkippedRange[] {
  if (candidate.year === newest.year) {
    return candidate.number > newest.number + 1 ? [{ year: newest.year, from: newest.number + 1, to: candidate.number - 1 }] : [];
  }
  // A year turn: ZKB restarts at 1, so the new year's numbers below the candidate are the knowable gap.
  return candidate.number > 1 ? [{ year: candidate.year, from: 1, to: candidate.number - 1 }] : [];
}

/** Is `candidate` the next statement after `newest`: the next number, or number 1 after a year turn. */
function isNext(newest: FeedPosition, candidate: FeedPosition): boolean {
  if (candidate.year === newest.year) return candidate.number === newest.number + 1;
  return candidate.year === newest.year + 1 && candidate.number === 1;
}

/**
 * THE RULE. `book` is every `bank_statement` row of the account (any order, pages and camt.054 rows
 * included: they are filtered here). Pure: the same inputs always give the same decision.
 */
export function decideSuccessor(candidate: FeedCandidate, book: readonly FeedBookRow[]): FeedDecision {
  // Rule 0, a page first: page 1 of a split statement carries no genuine CLBD and would otherwise read
  // as "not a day-end statement", which names the wrong recovery.
  if (candidate.splitPage || candidate.pageNumber !== 1 || !candidate.lastPage) {
    return {
      verdict: 'refused',
      code: 'unsupported_multipage_statement',
      final: false,
      position: null,
      details: { electronicSeqNb: candidate.electronicSeqNb, pageNumber: candidate.pageNumber, lastPage: candidate.lastPage },
    };
  }
  const position = dayEndPosition(candidate);
  if (position === null) {
    return {
      verdict: 'refused',
      code: 'not_day_end_statement',
      final: false,
      position: null,
      details: {
        electronicSeqNb: candidate.electronicSeqNb,
        fromDate: candidate.fromDate,
        hasOpeningBalance: candidate.openingBalanceMinor !== null,
        hasClosingBalance: candidate.closingBalanceMinor !== null,
      },
    };
  }
  const opening = candidate.openingBalanceMinor as number;
  const closing = candidate.closingBalanceMinor as number;

  const statements = bookStatements(book);

  // Rules 1 and 5 (overlap): the position is already in the books.
  const atPosition = statements.filter((b) => comparePositions(b.position, position) === 0);
  if (atPosition.length > 0) {
    const same = atPosition.find(
      (b) =>
        b.row.opening_balance_minor === opening &&
        b.row.closing_balance_minor === closing &&
        sameCurrency(b.row.balance_currency, candidate.balanceCurrency),
    );
    if (same !== undefined) {
      return { verdict: 'already_imported', position, statementRowId: same.row.id, txnCount: same.row.txn_count };
    }
    const other = atPosition[0] as BookStatement;
    return {
      verdict: 'refused',
      code: 'overlap_refused',
      final: true,
      position,
      details: {
        statement: { number: position.number, year: position.year, fromDate: candidate.fromDate, toDate: candidate.toDate },
        against: refOf(other),
      },
    };
  }

  // Rule 2, the feed start: nothing in the books yet, so coverage begins here (D139 item 7).
  if (statements.length === 0) return { verdict: 'import', rule: 'feed_start', position };

  const newest = statements[statements.length - 1] as BookStatement;
  const first = statements[0] as BookStatement;

  // Rule 2, the successor, or rule 4, a gap above the newest.
  if (comparePositions(position, newest.position) > 0) {
    const startsInTime = newest.row.to_date === null || candidate.fromDate === null || candidate.fromDate >= newest.row.to_date;
    const chains =
      startsInTime &&
      newest.row.closing_balance_minor === opening &&
      sameCurrency(newest.row.balance_currency, candidate.balanceCurrency);
    if (chains) {
      if (isNext(newest.position, position)) return { verdict: 'import', rule: 'successor', position };
      return {
        verdict: 'import',
        rule: 'successor',
        position,
        jump: { after: refOf(newest), skipped: skippedBetween(newest.position, position) },
      };
    }
    return {
      verdict: 'refused',
      code: 'gap_refused',
      final: false,
      position,
      details: {
        statement: { number: position.number, year: position.year, fromDate: candidate.fromDate, openingBalanceMinor: opening },
        against: refOf(newest),
        differenceMinor: opening - (newest.row.closing_balance_minor ?? 0),
        reason: startsInTime ? 'balance_does_not_chain' : 'starts_before_newest_ends',
      },
    };
  }

  // Rule 5, older than the first statement in the books: pending and quiet.
  if (comparePositions(position, first.position) < 0) {
    return {
      verdict: 'refused',
      code: 'before_feed_start',
      final: false,
      position,
      details: { statement: { number: position.number, year: position.year, fromDate: candidate.fromDate }, first: refOf(first) },
    };
  }

  // Rule 3, the hole filler, or rule 4, a gap below the newest.
  let lower: BookStatement = first;
  let higher: BookStatement = newest;
  for (const b of statements) {
    if (comparePositions(b.position, position) < 0) lower = b;
    else {
      higher = b;
      break;
    }
  }
  const opensOnLower =
    lower.row.closing_balance_minor === opening && sameCurrency(lower.row.balance_currency, candidate.balanceCurrency);
  const adjacentHigher = higher.position.year === position.year && higher.position.number === position.number + 1;
  const closesOnHigher = !adjacentHigher || higher.row.opening_balance_minor === closing;
  if (opensOnLower && closesOnHigher) return { verdict: 'import', rule: 'hole_filler', position };
  const against = opensOnLower ? higher : lower;
  return {
    verdict: 'refused',
    code: 'gap_refused',
    final: false,
    position,
    details: {
      statement: { number: position.number, year: position.year, fromDate: candidate.fromDate, openingBalanceMinor: opening, closingBalanceMinor: closing },
      against: refOf(against),
      differenceMinor: opensOnLower ? (higher.row.opening_balance_minor ?? 0) - closing : opening - (lower.row.closing_balance_minor ?? 0),
      reason: opensOnLower ? 'does_not_close_on_next' : 'balance_does_not_chain',
    },
  };
}

// --- the two readers (§H-TENANT) ---------------------------------------------------------------

/**
 * Is this account EBICS-fed (§4.4): routed to a connection that was once activated and is not retired?
 * A halted (`bank_keys_changed`) or `blocked` channel keeps the rule, so the hand bridge cannot double a
 * day while the channel waits.
 */
export function isEbicsFedAccount(ctx: WorkspaceContext, bankAccountId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS fed FROM ebics_connection c
         JOIN ebics_connection_account a ON a.connection_id = c.id AND a.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND a.bank_account_id = ? AND c.activated_at IS NOT NULL AND c.state != 'retired'
        LIMIT 1`,
    )
    .get(ctx.workspaceId, bankAccountId) as { fed: number } | undefined;
  return row !== undefined;
}

/** Every `bank_statement` row of one account, the columns the rule reads (§H-TENANT). */
export function readFeedBook(ctx: WorkspaceContext, bankAccountId: string): FeedBookRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, message_type, electronic_seq_nb, page_number, last_page_ind, from_date, to_date,
              opening_balance_minor, closing_balance_minor, balance_currency, txn_count
         FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?`,
    )
    .all(ctx.workspaceId, bankAccountId) as FeedBookRow[];
}

/**
 * The LAST number jump of an account (critic A36C-1): the numbers skipped right before the newest
 * statement the feed imported (`feedStatementIds`, from the order log's `imported` outcomes), as the
 * book stands now. Null when that statement follows its predecessor, so the notice ends once the owner
 * imported the missing statements by hand, or at the next ordinary import (a number that exists only as
 * an intraday statement never nags forever). Pure.
 */
export function lastNumberJump(book: readonly FeedBookRow[], feedStatementIds: ReadonlySet<string>): FeedNumberJump | null {
  const statements = bookStatements(book);
  let i = statements.length - 1;
  while (i >= 0 && !feedStatementIds.has((statements[i] as BookStatement).row.id)) i -= 1;
  if (i <= 0) return null;
  const before = statements[i - 1] as BookStatement;
  const jumped = statements[i] as BookStatement;
  const skipped = skippedBetween(before.position, jumped.position);
  if (skipped.length === 0) return null;
  return {
    after: { number: before.position.number, year: before.position.year },
    statement: { number: jumped.position.number, year: jumped.position.year },
    skipped,
  };
}

/** The newest day-end statement of an account (the feed position the status card shows), or null. */
export function newestFeedStatement(book: readonly FeedBookRow[]): (FeedStatementRef & { currency: string | null }) | null {
  const statements = bookStatements(book);
  const newest = statements[statements.length - 1];
  if (newest === undefined) return null;
  return { ...refOf(newest), currency: newest.row.balance_currency };
}
