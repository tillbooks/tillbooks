/**
 * D186: the Übersicht's new key figures. Each one composes reads the product already has and adds no
 * figure of its own (P5, the F00 anti-drift contract); every money figure is integer base-currency Rappen.
 *
 *  - **bank_balance**: the money ON the bank, per Bankkonto, read off A39's balance line (`accountBalance`,
 *    the same three numbers the Bank page's Abgleich shows): the closing booked balance of the latest
 *    statement (camt.053 CLBD), the linked ledger account that day, the open lines up to it and what is
 *    left unexplained. An account without a statement balance (no statement, a CSV import that carries no
 *    balance, another currency) says why and shows its books instead, never a fake bank figure.
 *  - **expense / result / margin / revenue_ltm**: A08's Erfolgsrechnung (`computeIncomeStatement`):
 *    the expense accounts' net, the Reingewinn, the Reingewinn over the Nettoerlöse, the Nettoerlöse of the
 *    twelve months up to the range end.
 *  - **free_cash**: the bank figure minus the open creditors (A17) minus the MWST due (A07), the three
 *    tiles' own answers.
 *  - **runway**: the bank figure over the average monthly expense of the last N whole months (N is the
 *    `runwayMonths` input, the person's `overview.runway_months`, default 6).
 *
 * Comparisons (compare.ts) are answered for both modes on every comparable tile, so the person's choice
 * of mode, per page or per tile, never needs a second read.
 */

import type { WorkspaceContext } from '../context.js';
import { computeIncomeStatement } from '../reports/index.js';
import { STATEMENT_COVERS_SQL, accountBalance, ledgerBalanceInAccountCurrency } from '../banking/bankInbox.js';
import { IS_HEAD } from '../files/head.js';
import { payablesBalanceAsOf } from '../purchase/index.js';
import { vatObligations } from '../liquidity/index.js';
import { vatSettlementList } from '../accruals/index.js';
import type { BankAccountBalance } from '../banking/bankInbox.js';
import { revenueEstimate } from '../banking/revenueEstimate.js';
import type { RevenueEstimateBasis } from '../banking/revenueEstimate.js';
import { COMPARE_MODES, changeBp, compareWindow, comparedThrough, shiftMonths, addDays } from './compare.js';
import type { CompareCut, CompareMode, Window } from './compare.js';

/** What one overview call shares between its tiles: today, the person's choices, and a statement memo. */
export interface KpiEnv {
  today: string;
  /** D186 (D172): `overview.compare_cut`, the same day (default) or the whole period. */
  compareCut: CompareCut;
  runwayMonths: number;
  estimateBasis: RevenueEstimateBasis;
  /** One income statement per window, shared by the revenue, expense, result and margin tiles. */
  statements: Map<string, StatementFigures | { error: string }>;
  /** The bank figure, computed once for bank_balance, free_cash and runway. */
  bank?: BankFigures;
}

export const RUNWAY_MONTHS = [3, 6, 12] as const;

export interface StatementFigures {
  revenueMinor: number;
  expenseMinor: number;
  resultMinor: number;
}

export function newKpiEnv(ctx: WorkspaceContext, opts: { runwayMonths?: number; estimateBasis?: RevenueEstimateBasis; compareCut?: CompareCut } = {}): KpiEnv {
  return {
    today: ctx.clock.now().slice(0, 10),
    compareCut: opts.compareCut ?? 'same_day',
    runwayMonths: opts.runwayMonths ?? 6,
    estimateBasis: opts.estimateBasis ?? 'rules',
    statements: new Map(),
  };
}

/** The Erfolgsrechnung's three figures for a window, memoised per call; `{ error }` is A08's refusal. */
export function statementFigures(ctx: WorkspaceContext, env: KpiEnv, w: Window): StatementFigures | { error: string } {
  const key = `${w.from}|${w.to}`;
  const hit = env.statements.get(key);
  if (hit !== undefined) return hit;
  const statement = computeIncomeStatement(ctx, { periodStart: w.from, periodEnd: w.to });
  let out: StatementFigures | { error: string };
  if (!statement.ok) {
    out = { error: statement.error };
  } else {
    const sections = statement.sections as { key: string; subtotalMinor: number; lines: { account: { type: string }; amountMinor: number }[] }[];
    let expenseMinor = 0;
    for (const section of sections) for (const line of section.lines) if (line.account.type === 'expense') expenseMinor -= line.amountMinor;
    out = {
      revenueMinor: sections.find((s) => s.key === 'netto_erloese')?.subtotalMinor ?? 0,
      expenseMinor,
      resultMinor: typeof statement.reingewinnMinor === 'number' ? statement.reingewinnMinor : 0,
    };
  }
  env.statements.set(key, out);
  return out;
}

/** One comparison: the window and the figure in it, and the change against it. */
export interface Comparison {
  from: string;
  to: string;
  value: number;
  changeBp: number | null;
}

/**
 * Both comparisons of a figure measured by `measure` (null when the source refuses a window), cut at the
 * same point (compare.ts). The current side is the range itself, the figure the tile shows.
 */
export function comparisonsOf(
  range: Window,
  env: KpiEnv,
  current: number,
  measure: (w: Window) => number | null,
): { comparedThrough: string; comparedValue: number; comparedKnown: boolean; comparisons: Record<CompareMode, Comparison | null> } {
  const through = comparedThrough(range, env.today, env.compareCut);
  // Critic D186-4: BOTH sides stop at `through`. The tile shows the whole range; the change is measured on
  // the range cut at the same day as the comparison (`comparedValue`), so a posting dated after today counts
  // on neither side.
  // Critic R2-6: when the cut range has no figure (no revenue for a margin, no decided line for a share),
  // there is nothing to compare like for like: the change is null, never the whole range's figure.
  const cut = through === range.to ? current : measure({ from: range.from, to: through });
  const comparedValue = cut ?? current;
  const comparisons = {} as Record<CompareMode, Comparison | null>;
  for (const mode of COMPARE_MODES) {
    const w = compareWindow(mode, range, through);
    const value = measure(w);
    comparisons[mode] = value === null ? null : { from: w.from, to: w.to, value, changeBp: cut === null ? null : changeBp(comparedValue, value) };
  }
  return { comparedThrough: through, comparedValue, comparedKnown: cut !== null, comparisons };
}

// --- the bank figure -------------------------------------------------------------------------------

/** One Bankkonto as the bank tile shows it. */
export interface BankAccountFigure {
  bankAccountId: string;
  name: string;
  /** The IBAN's last four characters, for "ZKB ·· 4821". */
  ibanLast4: string;
  currency: string;
  /** The closing booked balance of the latest statement, or null with `reason`. */
  bankMinor: number | null;
  /** The statement's closing date, or null. */
  statementDate: string | null;
  /** The linked ledger account: at the statement date when there is one, else today. */
  bookedMinor: number;
  /** The open lines up to the statement date, and their signed sum. */
  openCount: number;
  openMinor: number;
  /** bank - booked - open, zero when bank and books agree; null when not judged. */
  differenceMinor: number | null;
  reason: BankAccountBalance['reason'];
}

export interface BankFigures {
  accounts: BankAccountFigure[];
  /**
   * The base-currency accounts' money: the bank figure where a statement says it, else the books. This is
   * the figure free_cash and runway start from; `bankShareComplete` says whether every base account had a
   * statement balance.
   */
  totalMinor: number;
  bankShareComplete: boolean;
  /** The latest statement date among the base-currency accounts, or null. */
  asOf: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  iban: string;
  currency: string;
  ledger_account_id: string;
  opening_entry_id: string | null;
  archived: number;
}

export function bankFigures(ctx: WorkspaceContext, env: KpiEnv, base: string): BankFigures {
  if (env.bank !== undefined) return env.bank;
  const rows = ctx.store.db
    .prepare('SELECT id, name, iban, currency, ledger_account_id, opening_entry_id, archived FROM bank_account WHERE workspace_id = ? AND archived = 0 ORDER BY name, id')
    .all(ctx.workspaceId) as AccountRow[];
  const accounts: BankAccountFigure[] = [];
  let totalMinor = 0;
  // Critic D186-6: complete only when at least one base-currency account exists and every one is judged.
  let complete = rows.some((r) => r.currency === base);
  let asOf: string | null = null;
  // Critic re-cut: two Bankkonten on one ledger account without a statement count the books once.
  const booksCounted = new Set<string>();
  for (const row of rows) {
    const b = accountBalance(ctx, row);
    const judged = b.judgeable && b.bankBalanceMinor !== null && b.ledgerBalanceMinor !== null;
    const booked = judged ? (b.ledgerBalanceMinor as number) : ledgerBalanceInAccountCurrency(ctx, row, env.today);
    const firstBooks = judged || !booksCounted.has(row.ledger_account_id);
    if (!judged) booksCounted.add(row.ledger_account_id);
    const compact = row.iban.replace(/\s+/g, '');
    accounts.push({
      bankAccountId: row.id,
      name: row.name,
      ibanLast4: compact.slice(-4),
      currency: row.currency,
      bankMinor: judged ? b.bankBalanceMinor : null,
      statementDate: b.statementDate,
      bookedMinor: booked,
      openCount: judged ? b.openCount : 0,
      openMinor: judged ? b.openSumMinor : 0,
      differenceMinor: judged ? b.differenceMinor : null,
      reason: b.reason,
    });
    if (row.currency !== base) continue;
    totalMinor += judged ? (b.bankBalanceMinor as number) : firstBooks ? booked : 0;
    if (!judged) complete = false;
    if (judged && b.statementDate !== null && (asOf === null || b.statementDate > asOf)) asOf = b.statementDate;
  }
  env.bank = { accounts, totalMinor, bankShareComplete: complete, asOf };
  return env.bank;
}

/**
 * D186 re-cut (three critic FAILs, owner's pick of 09.11.2026): free cash on ONE basis, the BOOKS, every term
 * a ledger balance as of today, so an open bank line moves none of them and nothing is guessed.
 *
 *  - bank: the DISTINCT ledger accounts behind every Bankkonto (archived ones included, any currency), at
 *    their base value (`base_debit - base_credit`): two Bankkonten on one ledger account count it once.
 *  - payables: 2000 Kreditoren (`payablesBalanceAsOf`, A17's reconciliation target): every bill, migrated
 *    ones included, and every payment booked against 2000, however it was booked.
 *  - MWST: what A40 says is still open (`vatObligations`, the forecast's ONE chokepoint, as of today): per
 *    period A07's return under the effektive Methode capped by what 2200 + 2201 still owe (so a filed and
 *    settled period on 2201 counts until paid, critic R4-1, and a payment to 2201 is never subtracted twice,
 *    R4-2), the return for a Saldo period (owner's pick of 09.11.2026: the books hold no Saldo liability
 *    until A38's settlement), A40's blunt rule for a refused period, plus liability no period explains.
 *    Never negative: a credit is not added to free cash.
 */
export interface BooksFreeCash {
  bankMinor: number;
  bankAccounts: string[];
  payablesMinor: number;
  vatDueMinor: number;
  valueMinor: number;
}

export function booksFreeCash(ctx: WorkspaceContext, today: string): BooksFreeCash {
  const ledgers = ctx.store.db
    .prepare(
      `SELECT DISTINCT a.id AS id, a.number AS number FROM bank_account b
         JOIN account a ON a.workspace_id = b.workspace_id AND a.id = b.ledger_account_id
        WHERE b.workspace_id = ? ORDER BY a.number`,
    )
    .all(ctx.workspaceId) as { id: string; number: string }[];
  const balance = ctx.store.db.prepare(
    `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
       FROM journal_line l
       JOIN journal_entry e ON e.workspace_id = ? AND e.id = l.entry_id
      WHERE l.account_id = ? AND e.status = 'posted' AND e.date <= ?`,
  );
  let bankMinor = 0;
  for (const l of ledgers) bankMinor += (balance.get(ctx.workspaceId, l.id, today) as { net: number }).net;
  const payablesMinor = payablesBalanceAsOf(ctx, today);
  const obligations = vatObligations(ctx, today, today);
  // Critic R5-1: A40 leaves a computed Saldo claim uncapped (2200 cannot show its payment) and its forecast
  // never debits a past one; here a Saldo period counts its return only while A38 has not settled it. Once
  // settled, the books hold that liability on 2201 until it is paid, so 2201's credit balance stands for
  // every settled Saldo period (paid: zero), net of what the effektiv claims of SETTLED periods already took
  // from 2201 through A40's 2200 + 2201 cap (critic R6-1: across a change from effektiv to Saldo, 2201 counts
  // once). Stated residuals, both in the safe direction (free cash too low, never too high): a Saldo period
  // paid straight from 2200 without the settlement stays counted (A40's own), and Saldo MWST paid to 2201
  // BEFORE A38 settles the period counts until it is settled (R6-4: a debit on 2201 is not netted against an
  // unsettled return, because a signed term would cancel another period still owed). Third (critic R7-1, a
  // change from effektiv to Saldo only): A40 allots an older settled-and-paid effektiv claim out of the
  // invoiced-rate tax a later Saldo sale leaves on 2200, so that claim counts again. The MWST-Periode
  // checklist (G22) settles before paying, so the first two do not arise on the documented path.
  const settlements = vatSettlementList(ctx, {});
  const settled = new Set(
    settlements.ok ? (settlements.settlements as { period: string; status: string }[]).filter((x) => x.status === 'posted').map((x) => x.period) : [],
  );
  let vatOpen = 0;
  let saldo = false;
  let settledEffektivMinor = 0;
  for (const p of obligations.periods) {
    const computedSaldo = p.method === 'saldo' && p.refusal === null;
    if (computedSaldo) saldo = true;
    if (!computedSaldo || (p.started && !settled.has(p.label))) vatOpen += Math.max(0, p.openMinor);
    if (!computedSaldo && settled.has(p.label)) settledEffektivMinor += Math.max(0, p.openMinor);
    vatOpen += Math.max(0, p.unattributedMinor);
  }
  vatOpen += Math.max(0, obligations.unattributedMinor);
  if (saldo) {
    const onSettlement = ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
           FROM journal_line l
           JOIN account a ON a.workspace_id = ? AND a.id = l.account_id
           JOIN journal_entry e ON e.workspace_id = a.workspace_id AND e.id = l.entry_id
          WHERE a.number = '2201' AND e.status = 'posted' AND e.date <= ?`,
      )
      .get(ctx.workspaceId, today) as { net: number };
    vatOpen += Math.max(0, onSettlement.net - settledEffektivMinor);
  }
  const vatDueMinor = Math.max(0, vatOpen);
  return { bankMinor, bankAccounts: ledgers.map((l) => l.number), payablesMinor, vatDueMinor, valueMinor: bankMinor - payablesMinor - vatDueMinor };
}

// --- the revenue estimate --------------------------------------------------------------------------

export function estimateOf(ctx: WorkspaceContext, env: KpiEnv, range: Window): Record<string, unknown> {
  const e = revenueEstimate(ctx, { from: range.from, to: range.to, basis: env.estimateBasis });
  return { revenueMinor: e.revenueMinor, lineCount: e.lines.length, openLines: e.openLines, basis: e.basis, excluded: e.excluded };
}

// --- windows ---------------------------------------------------------------------------------------

/** The twelve months ending with `to` (`to` itself, back to the day after the same day a year earlier). */
export function ltmWindow(to: string): Window {
  return { from: addDays(shiftMonths(to, -12), 1), to };
}

/** The last `n` whole calendar months before the month of `today`. */
export function lastWholeMonths(today: string, n: number): Window {
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;
  return { from: shiftMonths(firstOfThisMonth, -n), to: addDays(firstOfThisMonth, -1) };
}

// --- customers --------------------------------------------------------------------------------------

/**
 * D186 `dso`: the average days from an invoice's issue to its last posted payment, over the invoices
 * settled inside the window (the A40 delay history's own join, `readDelayHistory`, measured from the issue
 * date instead of the due date). One mean, one rounding; null with no settled invoice. An invoice closed
 * by a credit note or a write-off alone has no payment and is not a payment duration.
 */
export function dsoFigure(ctx: WorkspaceContext, w: Window): { days: number | null; invoices: number } {
  const rows = ctx.store.db
    .prepare(
      `SELECT d.issue_date AS issued, MAX(p.date) AS settled
         FROM document d
         JOIN payment_allocation a
           ON a.workspace_id = d.workspace_id AND a.target_kind = 'document' AND a.target_id = d.id
         JOIN payment p
           ON p.workspace_id = a.workspace_id AND p.id = a.payment_id AND p.status = 'posted'
        WHERE d.workspace_id = ? AND d.type = 'invoice' AND d.status = 'settled' AND d.issue_date IS NOT NULL
        GROUP BY d.id
       HAVING MAX(p.date) >= ? AND MAX(p.date) <= ?`,
    )
    .all(ctx.workspaceId, w.from, w.to) as { issued: string; settled: string }[];
  if (rows.length === 0) return { days: null, invoices: 0 };
  const total = rows.reduce((s, r) => s + Math.max(0, Math.round((Date.parse(`${r.settled}T00:00:00Z`) - Date.parse(`${r.issued}T00:00:00Z`)) / 86_400_000)), 0);
  return { days: Math.round(total / rows.length), invoices: rows.length };
}

/**
 * D186 `top_customer`: the largest customer's share of the net invoiced turnover in the window, in basis
 * points. Invoices issued in the window (posted, not cancelled) minus their credit notes, net of MWST
 * (`subtotal_minor`), per contact, a merged contact counted under the one it was merged into. Base-currency
 * documents only (a document stores no base amount); `foreignDocuments` says how many were left out.
 */
export function topCustomerFigure(
  ctx: WorkspaceContext,
  w: Window,
  base: string,
): { shareBp: number | null; contactId: string | null; name: string | null; netMinor: number; totalMinor: number; customers: number; foreignDocuments: number } {
  const rows = ctx.store.db
    .prepare(
      `SELECT COALESCE(c.merged_into_id, d.contact_id) AS contact, d.currency AS currency,
              SUM(CASE WHEN d.type = 'invoice' THEN d.subtotal_minor ELSE -d.subtotal_minor END) AS net, COUNT(*) AS n
         FROM document d
         LEFT JOIN contact c ON c.workspace_id = d.workspace_id AND c.id = d.contact_id
        WHERE d.workspace_id = ? AND d.type IN ('invoice', 'credit_note') AND d.posted_entry_id IS NOT NULL
          AND d.status != 'cancelled' AND d.contact_id IS NOT NULL AND d.issue_date >= ? AND d.issue_date <= ?
        GROUP BY contact, d.currency`,
    )
    .all(ctx.workspaceId, w.from, w.to) as { contact: string; currency: string; net: number; n: number }[];
  let foreignDocuments = 0;
  const byContact = new Map<string, number>();
  for (const r of rows) {
    if (r.currency !== base) {
      foreignDocuments += r.n;
      continue;
    }
    byContact.set(r.contact, (byContact.get(r.contact) ?? 0) + r.net);
  }
  const ranked = [...byContact.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const totalMinor = ranked.reduce((s, [, v]) => s + v, 0);
  const top = ranked[0];
  if (top === undefined || totalMinor <= 0) return { shareBp: null, contactId: null, name: null, netMinor: 0, totalMinor: 0, customers: 0, foreignDocuments };
  const name = (ctx.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, top[0]) as { name: string } | undefined)?.name ?? null;
  return { shareBp: Math.round((top[1] * 10000) / totalMinor), contactId: top[0], name, netMinor: top[1], totalMinor, customers: ranked.length, foreignDocuments };
}

// --- the books' own housekeeping ---------------------------------------------------------------------

const LINE_DAY = `COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10))`;

/**
 * D186 `auto_rate`: of the bank lines decided booked or matched whose date is in the window (the live
 * decision, `superseded_at IS NULL`), the share a Buchungsregel decided: the autopilot (`channel`
 * `autobook:<rule>`, N04), a booking through a rule target (`rule_id`), or a person who kept the rule's
 * proposal unchanged (`proposed_rule_id` with `rule_changed = 0`, N03). Basis points; null with no line.
 */
export function autoRateFigure(ctx: WorkspaceContext, w: Window): { shareBp: number | null; decided: number; autopilot: number; byRule: number } {
  const r = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS decided,
              SUM(CASE WHEN d.channel LIKE 'autobook:%' THEN 1 ELSE 0 END) AS autopilot,
              SUM(CASE WHEN d.channel IS NULL AND (d.rule_id IS NOT NULL OR (d.proposed_rule_id IS NOT NULL AND d.rule_changed = 0)) THEN 1 ELSE 0 END) AS by_rule
         FROM bank_line_decision d
         JOIN bank_txn t ON t.workspace_id = d.workspace_id AND t.id = d.bank_txn_id
        WHERE d.workspace_id = ? AND d.superseded_at IS NULL AND d.state IN ('booked', 'matched')
          AND ${LINE_DAY} >= ? AND ${LINE_DAY} <= ?`,
    )
    .get(ctx.workspaceId, w.from, w.to) as { decided: number; autopilot: number | null; by_rule: number | null };
  const autopilot = r.autopilot ?? 0;
  const byRule = r.by_rule ?? 0;
  return { shareBp: r.decided === 0 ? null : Math.round(((autopilot + byRule) * 10000) / r.decided), decided: r.decided, autopilot, byRule };
}

/**
 * D186 `receipt_rate`: of the outgoing bank lines booked to accounts in the window that need a Beleg (the
 * Bankeingang's own `noReceipt` rule: a line whose booking the statement itself does not cover), the share
 * with one: a current file version on the line or on the entry it booked. Basis points; null with none.
 */
export function receiptRateFigure(ctx: WorkspaceContext, w: Window): { shareBp: number | null; needing: number; missing: number } {
  const r = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS needing,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM stored_file f
                 WHERE f.workspace_id = t.workspace_id AND ${IS_HEAD('f')}
                   AND ((f.entity_kind = 'bank_txn' AND f.entity_id = t.id)
                     OR (d.entry_id IS NOT NULL AND f.entity_kind = 'journal_entry' AND f.entity_id = d.entry_id))
              ) THEN 1 ELSE 0 END) AS covered
         FROM bank_txn t
         JOIN bank_line_decision d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id AND d.superseded_at IS NULL
        WHERE t.workspace_id = ? AND d.state = 'booked' AND d.target_kind = 'accounts' AND t.credit_debit = 'DBIT'
          AND NOT ${STATEMENT_COVERS_SQL('d.entry_id', 't.bank_account_id', 't.workspace_id')}
          AND ${LINE_DAY} >= ? AND ${LINE_DAY} <= ?`,
    )
    .get(ctx.workspaceId, w.from, w.to) as { needing: number; covered: number | null };
  const covered = r.covered ?? 0;
  return { shareBp: r.needing === 0 ? null : Math.round((covered * 10000) / r.needing), needing: r.needing, missing: r.needing - covered };
}
