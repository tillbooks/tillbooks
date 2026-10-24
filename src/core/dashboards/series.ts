/**
 * F00 + D178 point 13, THE ÜBERSICHT'S CHART SERIES: `dashboard_series`, one pure read (P5).
 *
 * Two answers, both the ledger's own:
 *
 *  - **Money in and out per calendar month**, over the A19 bank accounts' ledger accounts (archived
 *    ones included: money that moved in the past moved). Posted entries only, base-currency columns
 *    only (§H-FX), and NETTED PER JOURNAL ENTRY: an entry whose bank lines net to +x is x in, to -x is
 *    x out, so a transfer between two own bank accounts (or a booking that debits and credits banks
 *    in one entry) is neither. The engine's own opening postings (A04's `opening-balances:*` and A19's
 *    `bank-opening:*` keys, the predicate G22's `booksStartOf` uses) and their reversals are not money
 *    that moved, so they are left out. Hence the identity the suite asserts: Σ in − Σ out equals the
 *    bank accounts' net Kontoblatt movement over the window, minus those opening postings.
 *  - **The top expense accounts of the range**, read off A08's Erfolgsrechnung (`computeIncomeStatement`),
 *    never a second classification: every `expense`-type line with a debit balance, largest first, the
 *    first `top` of them named and the rest one `otherExpensesMinor`, so Σ top + other equals
 *    `grossExpenseMinor`. An expense account with a CREDIT balance in the range (an Aufwandminderung, a
 *    stock change booked against material) is not a part of a ring; it is summed into
 *    `expenseReductionsMinor` (zero or negative), so gross + reductions equals the statement's expense
 *    total, `expenseTotalMinor`, and nothing is dropped.
 *
 * §H-TENANT: the bank-account list is A19's (workspace-fenced), and the one query of its own fences both
 * `journal_entry.workspace_id` and `account.workspace_id`, the A08 `aggregate` posture. Nothing is
 * written, nothing is cached, nothing is emitted; `test/dashboards/read-only.test.mjs` scans this
 * directory for write SQL like every other F00 file.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { computeIncomeStatement } from '../reports/index.js';
import { listBankAccounts } from '../banking/index.js';
import { BANK_OPENING_KEY_PREFIX } from '../banking/bankAccounts.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A04's opening-balance key namespace (`OPENING_KEY_PREFIX` in the ledger module), restated because this
 * directory reaches no ledger module (`test/dashboards/read-only.test.mjs`); the series suite pins the two
 * to each other, so they cannot drift.
 */
export const LEDGER_OPENING_KEY_PREFIX = 'opening-balances';

/** The longest window the series answers, in calendar months. Five years of bars is already a wall. */
export const SERIES_MAX_MONTHS = 60;

/** How many expense accounts are named by default, and the most a caller may ask for. */
export const SERIES_TOP_DEFAULT = 5;
export const SERIES_TOP_MAX = 12;

export interface DashboardSeriesInput {
  from: string;
  to: string;
  top?: number | undefined;
}

export interface SeriesMonth {
  /** `YYYY-MM`. */
  month: string;
  /** The month clipped to the range. */
  from: string;
  to: string;
  inMinor: number;
  outMinor: number;
}

export interface SeriesExpense {
  accountId: string;
  number: string;
  name: string;
  amountMinor: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Every calendar month `[from, to]` touches, each clipped to the range, or null past the cap. */
function monthsOf(from: string, to: string): { month: string; from: string; to: string }[] | null {
  const out: { month: string; from: string; to: string }[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${pad(month)}`;
    const start = `${key}-01`;
    const end = `${key}-${pad(lastDayOf(year, month))}`;
    out.push({ month: key, from: start < from ? from : start, to: end > to ? to : end });
    if (out.length > SERIES_MAX_MONTHS) return null;
    if (key === endKey) return out;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/**
 * The engine's own opening postings, as a SQL predicate over `e` (the `booksStartOf` rule): A04's and
 * A19's opening keys under `source = 'import'`. Keyed on the reserved key namespaces, never on
 * `source = 'import'` alone, which any `post_entry` caller may choose.
 */
const OPENING_ENTRY = `(source = 'import' AND (idempotency_key LIKE ? OR idempotency_key LIKE ?))`;

/** The bank accounts' net per posted entry in the window, opening postings and their reversals left out. */
function entryNets(ctx: WorkspaceContext, ledgerIds: readonly string[], from: string, to: string): { date: string; net: number }[] {
  if (ledgerIds.length === 0) return [];
  const marks = ledgerIds.map(() => '?').join(', ');
  const openingKeys = [`${LEDGER_OPENING_KEY_PREFIX}:%`, `${BANK_OPENING_KEY_PREFIX}:%`];
  return ctx.store.db
    .prepare(
      `SELECT e.date AS date, COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.status = 'posted' AND e.workspace_id = ? AND a.workspace_id = ?
          AND e.date >= ? AND e.date <= ?
          AND l.account_id IN (${marks})
          AND NOT (e.source = 'import' AND (e.idempotency_key LIKE ? OR e.idempotency_key LIKE ?))
          AND NOT (e.source = 'reversal' AND e.reverses_entry_id IN
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND ${OPENING_ENTRY}))
        GROUP BY e.id`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, from, to, ...ledgerIds, ...openingKeys, ctx.workspaceId, ...openingKeys) as {
    date: string;
    net: number;
  }[];
}

/** `dashboard_series`: the monthly money in and out, and the top expenses of the range (D178 point 13). */
export function dashboardSeries(ctx: WorkspaceContext, input: DashboardSeriesInput): Result {
  const { from, to } = input;
  if (typeof from !== 'string' || !ISO_DATE.test(from)) return err('invalid_input', { field: 'from' });
  if (typeof to !== 'string' || !ISO_DATE.test(to)) return err('invalid_input', { field: 'to' });
  if (from > to) return err('invalid_range', { from, to });
  const top = input.top ?? SERIES_TOP_DEFAULT;
  if (!Number.isInteger(top) || top < 1 || top > SERIES_TOP_MAX) {
    return err('invalid_input', { field: 'top', min: 1, max: SERIES_TOP_MAX });
  }
  const windows = monthsOf(from, to);
  if (windows === null) return err('range_too_long', { maxMonths: SERIES_MAX_MONTHS });

  // The expense split first: a workspace with no chart answers A08's own `needs_chart`.
  const statement = computeIncomeStatement(ctx, { periodStart: from, periodEnd: to });
  if (!statement.ok) return statement;
  const sections = statement.sections as { lines: { account: { id: string; number: string; name: string; type: string }; amountMinor: number }[] }[];
  const expenses: SeriesExpense[] = [];
  for (const section of sections) {
    for (const line of section.lines) {
      if (line.account.type !== 'expense') continue;
      // The statement states a contribution to profit (credit - debit); an expense is its negation.
      expenses.push({ accountId: line.account.id, number: line.account.number, name: line.account.name, amountMinor: -line.amountMinor });
    }
  }
  expenses.sort((a, b) => b.amountMinor - a.amountMinor || a.number.localeCompare(b.number));
  const expenseTotalMinor = expenses.reduce((sum, e) => sum + e.amountMinor, 0);
  const debits = expenses.filter((e) => e.amountMinor > 0);
  const grossExpenseMinor = debits.reduce((sum, e) => sum + e.amountMinor, 0);
  const expenseReductionsMinor = expenseTotalMinor - grossExpenseMinor;
  const topExpenses = debits.slice(0, top);
  const otherExpensesMinor = grossExpenseMinor - topExpenses.reduce((sum, e) => sum + e.amountMinor, 0);

  // The money in and out, per entry, then per month.
  const listed = listBankAccounts(ctx, { includeArchived: true });
  if (!listed.ok) return listed;
  const ledgerIds = [...new Set((listed.bankAccounts as { ledgerAccountId: string }[]).map((b) => b.ledgerAccountId))];
  const months: SeriesMonth[] = windows.map((w) => ({ ...w, inMinor: 0, outMinor: 0 }));
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const row of entryNets(ctx, ledgerIds, from, to)) {
    const bucket = byMonth.get(row.date.slice(0, 7));
    if (bucket === undefined) continue; // structurally unreachable: the window covers every date queried.
    if (row.net > 0) bucket.inMinor += row.net;
    else if (row.net < 0) bucket.outMinor += -row.net;
  }

  return ok({
    workspaceId: ctx.workspaceId,
    from,
    to,
    currency: statement.baseCurrency,
    bankAccounts: (listed.bankAccounts as unknown[]).length,
    months,
    totals: {
      inMinor: months.reduce((sum, m) => sum + m.inMinor, 0),
      outMinor: months.reduce((sum, m) => sum + m.outMinor, 0),
    },
    topExpenses,
    otherExpensesMinor,
    grossExpenseMinor,
    expenseReductionsMinor,
    expenseTotalMinor,
  });
}
