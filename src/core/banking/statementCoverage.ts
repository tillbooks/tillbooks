/**
 * D178 point 19, re-cut after three critic FAILs (orchestrator ruling under D178, round 3; reviewed on paper
 * by the non-author critic: docs/critique/bank-parity-e2-recut-review.md). COVERAGE DECIDES FIRST, per
 * Bankkonto, before any movement key is matched. A line's identity is never tied to its delivery: a
 * statement number, a page or a file is the DELIVERY's identity (already_imported, statement_amended),
 * never part of a line key.
 *
 *  1. EXTENDING. A delivery whose opening balance is the stored closing balance at the end of the chain
 *     AND that starts later (or carries the next sequence number and starts no earlier than the chain's
 *     last statement: several statements a day) brings new lines. Never
 *     balance alone: a net-zero day closes where it opened. Its lines are new; only a bank-issued
 *     reference key (camt AcctSvcrRef `asr:`, MT940 `//` `m9:`) drops one, and point 19's cross-format
 *     candidates still flag them.
 *  2. OVERLAP. A delivery that does not extend is checked line by line against the COVERED SPAN: the union
 *     of the stored statements' periods, minus the gaps `statementGaps.ts` knows. A statement with its
 *     opening and closing balances (every page there) covers its whole period; one without (a CSV, an
 *     intraday or ad-hoc camt, an incomplete paged MT940) covers its first day to the day before its last,
 *     and its last day is an EDGE day (it may have been cut off midday). A line belongs to its statement's
 *     period, never to its value date: its day is its booking date when that lies in the period, else the
 *     period's last day. On a covered day each line is matched ONE TO ONE on its movement key (booking
 *     date, else value date; direction; amount; currency; occurrence): matched, it is imported flagged
 *     `same_movement` naming the match; unmatched, `covered_period_new_line`. On an edge day a match is
 *     flagged and an extra line is not (the afternoon a midday export never saw).
 *  3. OUTSIDE the covered span coverage flags nothing: tomorrow's card purchases, a late gap-filler, an
 *     older period, the first import ever.
 *
 * The pages of one statement are one delivery: a page never overlaps its own siblings while the statement
 * waits for its last page (it takes their classification). A statement already COMPLETE in the books that
 * receives another page is delivered again: its siblings then count as covered, like any statement.
 *
 * §H-TENANT on every query; read only. NEAR-LINEAR: one pass over the stored statements of the window,
 * one over the stored lines of the incoming days, grouped by key.
 */

import type { WorkspaceContext } from '../context.js';
import { accountStatementGaps } from './statementGaps.js';
import type { ParsedBankStatement, ParsedCamtEntry } from './camt.js';

/** How a delivery stands against what the Bankkonto already holds. */
export type DeliveryCoverage = 'extends' | 'checked';

interface StatementRow {
  id: string;
  message_type: string;
  statement_id: string;
  electronic_seq_nb: string | null;
  page_number: number;
  last_page_ind: number;
  from_date: string | null;
  to_date: string | null;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  balance_currency: string | null;
}

/** One stored statement (every page of it), as coverage reads it. */
interface StatementGroup {
  key: string;
  rows: StatementRow[];
  from: string | null;
  to: string | null;
  /** Every page there (1 to k, page k the last). */
  complete: boolean;
  /** Its opening and closing balances are known: it covers its whole period. */
  full: boolean;
  opening: number | null;
  closing: number | null;
  currency: string | null;
  sequence: number | null;
}

function isoDayAdd(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The statement's sequence: camt `ElctrncSeqNb`, else the MT940 `:28C:` number its id carries. */
function sequenceOf(r: Pick<StatementRow, 'electronic_seq_nb' | 'statement_id'>): number | null {
  if (r.electronic_seq_nb !== null) {
    const n = Number(r.electronic_seq_nb);
    return Number.isSafeInteger(n) ? n : null;
  }
  const m = /^mt940:(\d+):/.exec(r.statement_id);
  return m === null ? null : Number(m[1]);
}

/** The identity of a statement across its pages (the delivery identity A20-C2 keys on). */
function groupKeyOf(r: Pick<StatementRow, 'statement_id' | 'electronic_seq_nb'>): string {
  return `${r.statement_id}\u001f${r.electronic_seq_nb ?? ''}`;
}

function groupsOf(rows: readonly StatementRow[]): StatementGroup[] {
  const by = new Map<string, StatementRow[]>();
  for (const r of rows) {
    const k = groupKeyOf(r);
    const list = by.get(k);
    if (list === undefined) by.set(k, [r]);
    else list.push(r);
  }
  const out: StatementGroup[] = [];
  for (const [key, list] of by) {
    list.sort((a, b) => a.page_number - b.page_number);
    const last = list.find((r) => r.last_page_ind === 1);
    const pages = new Set(list.map((r) => r.page_number));
    let complete = last !== undefined;
    if (last !== undefined) for (let p = 1; p <= last.page_number; p += 1) if (!pages.has(p)) complete = false;
    const first = list.find((r) => r.page_number === 1);
    const opening = first?.opening_balance_minor ?? null;
    const closing = complete ? (last?.closing_balance_minor ?? null) : null;
    const froms = list.map((r) => r.from_date).filter((d): d is string => d !== null).sort();
    const tos = list.map((r) => r.to_date).filter((d): d is string => d !== null).sort();
    out.push({
      key,
      rows: list,
      from: froms[0] ?? null,
      to: tos[tos.length - 1] ?? null,
      complete,
      full: complete && opening !== null && closing !== null,
      opening,
      closing,
      currency: (last ?? list[0])?.balance_currency ?? null,
      sequence: sequenceOf(list[0] as StatementRow),
    });
  }
  return out;
}

function readStatements(ctx: WorkspaceContext, bankAccountId: string): StatementRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, message_type, statement_id, electronic_seq_nb, page_number, last_page_ind, from_date, to_date,
              opening_balance_minor, closing_balance_minor, balance_currency
         FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?`,
    )
    .all(ctx.workspaceId, bankAccountId) as StatementRow[];
}

/** The period a parsed statement covers: its own dates, else its lines' dates. */
export function periodOf(stmt: Pick<ParsedBankStatement, 'fromDate' | 'toDate' | 'entries'>): { from: string | null; to: string | null } {
  const dates = stmt.entries.flatMap((e) => [e.bookingDate, e.valueDate]).filter((d): d is string => d !== null).sort();
  return { from: stmt.fromDate ?? dates[0] ?? null, to: stmt.toDate ?? dates[dates.length - 1] ?? null };
}

/** The day a line belongs to: its booking date inside its statement's period, else the period's last day. */
export function lineDayOf(entry: Pick<ParsedCamtEntry, 'bookingDate' | 'valueDate'>, period: { from: string | null; to: string | null }): string | null {
  const b = entry.bookingDate;
  if (b !== null && (period.from === null || b >= period.from) && (period.to === null || b <= period.to)) return b;
  return period.to ?? b ?? entry.valueDate;
}

/** The covered days of a Bankkonto: `full` days a statement accounts for completely, `edge` days it may have cut off. */
export interface CoveredSpan {
  full: ReadonlySet<string>;
  edge: ReadonlySet<string>;
}

export interface CoverageAnswer {
  coverage: DeliveryCoverage;
  span: CoveredSpan;
}

/**
 * Classify ONE incoming statement (page) of a Bankkonto, the row the import just wrote for it excluded,
 * and the covered span over `window` (the incoming lines' days). §H-TENANT.
 */
export function coverageOf(
  ctx: WorkspaceContext,
  bankAccountId: string,
  stmt: Pick<ParsedBankStatement, 'statementId' | 'electronicSeqNb' | 'pageNumber' | 'openingBalanceMinor' | 'balanceCurrency' | 'fromDate' | 'toDate' | 'entries'>,
  ownRowId: string,
  window: { from: string; to: string } | null,
): CoverageAnswer {
  const all = readStatements(ctx, bankAccountId).filter((r) => r.id !== ownRowId);
  const ownKey = groupKeyOf({ statement_id: stmt.statementId, electronic_seq_nb: stmt.electronicSeqNb });
  const groups = groupsOf(all);
  const siblings = groups.find((g) => g.key === ownKey);
  // The pages of a statement still waiting for its last page are one delivery with this page: they never
  // cover it, and it takes their classification (an extending page 1 makes page 2 extending).
  const waiting = siblings !== undefined && !siblings.complete;
  const others = waiting ? groups.filter((g) => g.key !== ownKey) : groups;
  const period = periodOf(stmt);

  let coverage: DeliveryCoverage = 'checked';
  if (waiting && siblings !== undefined) {
    const ownRows = new Set(siblings.rows.map((r) => r.id));
    const extendedBefore = ctx.store.db
      .prepare(`SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND coverage = 'extends' AND id IN (${[...ownRows].map(() => '?').join(', ')})`)
      .get(ctx.workspaceId, ...ownRows) as { n: number };
    if (extendedBefore.n > 0) coverage = 'extends';
  }
  if (coverage !== 'extends' && stmt.pageNumber === 1 && stmt.openingBalanceMinor !== null && period.from !== null) {
    // The chain's end: the stored statement with a known closing balance that ends last (then the
    // highest sequence on that day).
    const chained = others.filter((g) => g.closing !== null && g.to !== null);
    chained.sort((a, b) => ((a.to as string) < (b.to as string) ? -1 : (a.to as string) > (b.to as string) ? 1 : (a.sequence ?? -1) - (b.sequence ?? -1)));
    const end = chained[chained.length - 1];
    const ownSeq = sequenceOf({ electronic_seq_nb: stmt.electronicSeqNb, statement_id: stmt.statementId });
    if (
      end !== undefined &&
      end.closing === stmt.openingBalanceMinor &&
      (end.currency === null || stmt.balanceCurrency === null || end.currency === stmt.balanceCurrency) &&
      // A later start, or the NEXT sequence number of a statement that starts no earlier than the chain's end
      // started (several statements a day, or a bank that dates each statement by its whole month).
      (period.from > (end.to as string) || (ownSeq !== null && end.sequence !== null && ownSeq === end.sequence + 1 && end.from !== null && period.from >= end.from))
    ) {
      coverage = 'extends';
    }
  }

  const full = new Set<string>();
  const edge = new Set<string>();
  if (window !== null) {
    const inWindow = (d: string): boolean => d >= window.from && d <= window.to;
    // Critic R4-1: an EXTENDING delivery is new against the balance chain, but not against a delivery without
    // one (a CSV, an unchained or incomplete statement): on any day such a delivery covers, its lines are
    // still matched one to one. Only the days neither the chain nor such a delivery covers are new outright.
    for (const g of coverage === 'checked' ? others : others.filter((x) => !x.full)) {
      if (g.from === null || g.to === null) continue;
      const lastFull = g.full ? g.to : isoDayAdd(g.to, -1);
      const start = g.from > window.from ? g.from : window.from;
      for (let d = start; d <= lastFull && d <= window.to; d = isoDayAdd(d, 1)) full.add(d);
      if (!g.full && inWindow(g.to)) edge.add(g.to);
    }
    for (const d of full) edge.delete(d);
    // Minus the gaps TILL already knows between STORED statements: days a missing statement would hold are
    // not covered. A gap this delivery itself opens (its own number jump, its own broken chain) is no
    // knowledge about the books, and must never uncover the days it overlaps.
    const delivery = new Set<string>([ownRowId, ...(waiting && siblings !== undefined ? siblings.rows.map((r) => r.id) : [])]);
    for (const gap of accountStatementGaps(ctx, bankAccountId)) {
      if (gap.confirmed || gap.after.statementRowId === gap.before.statementRowId) continue;
      if (delivery.has(gap.after.statementRowId ?? '') || delivery.has(gap.before.statementRowId ?? '')) continue;
      const { from, to } = gap.missingDates;
      if (from === null || to === null) continue;
      for (let d = from > window.from ? from : window.from; d <= to && d <= window.to; d = isoDayAdd(d, 1)) {
        full.delete(d);
        edge.delete(d);
      }
    }
  }
  return { coverage, span: { full, edge } };
}

/** A line's movement key without its occurrence: booking date (else value date), direction, amount, currency. */
export function movementKeyOf(e: { bookingDate: string | null; valueDate: string | null; creditDebit: string; amountMinor: number; currency: string }): string {
  return `${e.bookingDate ?? e.valueDate ?? ''}|${e.creditDebit}|${e.amountMinor}|${e.currency}`;
}

/** SQL: the same movement key over a `bank_txn` alias, so every stored line has it, history included. */
export function MOVEMENT_KEY_SQL(t: string): string {
  return `COALESCE(${t}.booking_date, ${t}.value_date, '') || '|' || ${t}.credit_debit || '|' || ${t}.amount_minor || '|' || ${t}.currency`;
}

/**
 * The stored lines of a Bankkonto on the given movement keys, the ones that stand as movements in the
 * books (not a line flagged and undecided, not one decided a duplicate), in stored order. §H-TENANT.
 */
export function storedMovements(ctx: WorkspaceContext, bankAccountId: string, keys: readonly string[], dates: { from: string; to: string }): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (keys.length === 0) return out;
  const wanted = new Set(keys);
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id, ${MOVEMENT_KEY_SQL('t')} AS mk FROM bank_txn t
        WHERE t.workspace_id = ? AND t.bank_account_id = ?
          AND COALESCE(t.booking_date, t.value_date) >= ? AND COALESCE(t.booking_date, t.value_date) <= ?
          AND NOT (EXISTS (SELECT 1 FROM bank_txn_possible_duplicate pd WHERE pd.workspace_id = t.workspace_id AND pd.bank_txn_id = t.id)
                   AND COALESCE((SELECT dd.decision FROM bank_txn_duplicate_decision dd
                                  WHERE dd.workspace_id = t.workspace_id AND dd.bank_txn_id = t.id
                                  ORDER BY dd.decided_at DESC, dd.rowid DESC LIMIT 1), '') <> 'distinct')
        ORDER BY t.rowid`,
    )
    .all(ctx.workspaceId, bankAccountId, dates.from, dates.to) as { id: string; mk: string }[];
  for (const r of rows) {
    if (!wanted.has(r.mk)) continue;
    const list = out.get(r.mk);
    if (list === undefined) out.set(r.mk, [r.id]);
    else list.push(r.id);
  }
  return out;
}
