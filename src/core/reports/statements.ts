/**
 * A08, the financial statements: Saldenbilanz, Bilanz, Erfolgsrechnung and Kontoblatt as pure read
 * models over the journal A02 wrote (Pattern P5).
 *
 * A08 ADDS NO MUTATION. There is no `INSERT`, `UPDATE` or `DELETE` anywhere in this module and no
 * table belongs to it; every figure is recomputed from `journal_entry` + `journal_line` on each
 * call, so a statement cannot drift from the ledger the way a cached total can. That absence is the
 * §7 tripwire, and `test/reports/surface.test.mjs` holds it up by counting rows before and after
 * every read.
 *
 * ## What the reconciliation flags do and do not catch
 *
 * A07 shipped four filing-grade defects that every one of them reported `reconciled: true`, because
 * the check summed the same numbers it had just distributed. So each flag below says what it is
 * comparing, and none of them is a restatement of the thing it checks:
 *
 *  - `debitEqualsCredit` (Saldenbilanz). Close to an IDENTITY and worth little on its own: `postEntry`
 *    refuses an unbalanced entry, so any book written through the product satisfies it by
 *    construction. It earns its place as a guard on the paths that DO NOT go through `postEntry`: a
 *    restored file, a migration, a future importer. Treat a red one as a corrupt database rather
 *    than a reporting bug.
 *  - `closingTiesToLedger` (Saldenbilanz and Kontoblatt). Genuinely two derivations. The report
 *    builds a closing balance as `opening + debit - credit`, from a windowed aggregate and a carry;
 *    the check reads a CUMULATIVE aggregate with its own date fence. They agree only if both fences
 *    are right, so an off-by-one on a period boundary shows. It CANNOT catch an error common to both
 *    queries (a wrong `status` filter, a wrong tenant fence): those are what the tests are for. And
 *    there is deliberately no second "the opening column ties out" flag beside it, because
 *    `closing == cumulative` and `opening == cumulative - movement` are one equation rearranged.
 *  - `aktivenEqualPassiven` (Bilanz). NOT an identity here, and this is the flag that carries real
 *    weight: it holds only if every account reached exactly one section AND the two computed equity
 *    positions really do capture the whole result. A section-map bug that drops one account breaks
 *    it immediately.
 *  - `ledgerNetsToZero` (Bilanz). One aggregate over every posted line, with no section map in the
 *    way. Read it TOGETHER with the flag above: if the ledger nets to zero but Aktiven and Passiven
 *    disagree, the bug is in this file's bucketing, not in the books. If both are red, the database
 *    is.
 *  - `resultTiesToLedger` (Erfolgsrechnung). The Reingewinn built by summing the eleven positions,
 *    against an aggregate taken by account TYPE with no number ranges involved. That is a real
 *    second opinion: it is exactly the comparison that catches a position rendered twice, which was
 *    one of A07's four. It is the ONE flag here that NO database state can turn red, and that is a
 *    property of it rather than a gap in the tests: both derivations read the same population under
 *    the same fences, so they can only disagree if this file's arithmetic is wrong. Measured, not
 *    assumed: adding every position to a second section as well drives it to `false` on the
 *    ordinary fixture (reingewinn 1'080'000 against a ledger saying 540'000). Read it as a
 *    self-check on the bucketing, never as evidence about the data.
 *  - `everyAccountClassifiedOnce` / `everyAccountRenderedOnce` (all three statements). Counts the
 *    accounts the LEDGER says belong on the report against the account-backed lines actually
 *    rendered, in one grouped query with no section map in the way. A drop and a duplicate are the
 *    two defects that survive every total-level check, because the total moves with them.
 *
 * ALL OF THIS USED TO BE UNTESTED. Every A08 assertion was `assert.equal(reconciles, true)` and not
 * one had ever observed a flag as `false`, so all four survived being replaced by the literal
 * `true`. They were unexercised rather than fake, and the reason they looked unreachable is that the
 * `posted_immutable` triggers refuse a `DELETE` of a posted line and an `INSERT` into a posted
 * entry. They do not refuse what an IMPORTER does: write the entry as a draft, write its lines, flip
 * it to posted. That is the "corrupt database" the first bullet names, `test/reports/support.mjs`
 * now builds it, and six of the seven flags are observed red against it.
 *
 * A green reconciliation is evidence about coverage and about the date fences. It is not evidence
 * that an account sits in the RIGHT section: a chart where 6800 was filed under Personalaufwand
 * would foot, tie out, and be wrong. The section map is held by fixture instead
 * (`test/reports/or-structure.test.mjs`), against the OR text itself.
 *
 * NOR is it evidence that the report is about the right ROWS. Every flag above compares two
 * derivations over the same population, so a fence that is wrong in both is invisible to all of
 * them: that is exactly how a closed year's Erfolgsrechnung read all zeroes with both of its flags
 * green (the closing entry zeroed the accounts, and the independent check dutifully agreed that
 * nothing was nothing). What catches that class is a fixture that knows what the year actually held,
 * which is what `test/reports/statements.test.mjs` now carries for the close.
 *
 * ## Which statements see the closing entry
 *
 * A03 posts a `source='close'` entry on the last day of a closed fiscal year. The **Erfolgsrechnung
 * excludes it** and every flag it reports takes the same fence (see `computeIncomeStatement`). The
 * **Bilanz includes it**, because there it is real movement into 2970 and excluding it would count
 * the result twice. The **Saldenbilanz and the Kontoblatt include it** as well: they are working
 * papers, a bookkeeper checking a close needs to see the entry that performed it, and the Kontoblatt
 * carries a `source` column precisely so a close line is identifiable on sight.
 *
 * ## Signs, stated once
 *
 * The ledger is debit-positive: a line's contribution is `base_debit_minor - base_credit_minor`.
 * The three read models present that differently and deliberately:
 *
 *  - **Saldenbilanz and Kontoblatt** stay RAW debit-positive. They are working papers, and a
 *    bookkeeper reading a Saldenbilanz wants the ledger's own sign.
 *  - **Bilanz** presents each line positive on its OWN side: `debit - credit` on the Aktiven,
 *    `credit - debit` on the Passiven. Printing the raw net would show every liability as negative,
 *    and the statement would still foot, because the error cancels inside the Passiven total.
 *  - **Erfolgsrechnung** presents every position as its CONTRIBUTION TO PROFIT, `credit - debit`.
 *    Revenue is positive, expense is negative, and `reingewinnMinor` is the plain sum. This is the
 *    one convention under which the three MIXED positions of OR Art. 959b Abs. 2 (Ziff. 7, 8 and 9
 *    each name an Aufwand AND an Ertrag) have an unambiguous value. A `Math.abs` anywhere in here
 *    would declare a loss as a profit, which is the shape of the sign defect A07 shipped, so the
 *    sections carry a `nature` for a GUI to flip the DISPLAY sign and the figure itself is never
 *    made positive.
 *
 * ## Money is read in the BASE currency, always
 *
 * Every sum is over `base_debit_minor` / `base_credit_minor` (§H-FX), never the transaction amounts.
 * A statement is what the BOOKS hold. Summing `debit_minor` on a EUR entry would print euros under a
 * franc heading and foot perfectly, because both legs carry the same wrong unit.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireDate, requireString, optionalId } from '../ledger/inputGuards.js';
import { fiscalYearOf } from '../ledger/periods.js';
import { baseCurrencyOf } from '../fx/rates.js';
import type { AccountType } from '../accounts/kmuSeed.js';
import {
  BILANZ_SECTIONS,
  COMPUTED_EQUITY_LINES,
  ERFOLG_SECTIONS,
  KMU_CLASS_LABELS,
  bilanzSectionFor,
  erfolgSectionFor,
  kmuClassOf,
} from './sections.js';

/** The four report kinds, single-sourced (§H-ENUM) so `export_statement` cannot invent a fifth. */
export const STATEMENT_KINDS: readonly string[] = ['trial', 'balance', 'income', 'ledger'];

/**
 * The one `groupBy` value A08 can honour today (§6b).
 *
 * The spec's alternate groupings re-bucket by an account-level `select`/`multiselect` custom field,
 * which is A01 §6b + G00 and does not exist: there is no `custom_field_values` table in the schema.
 * So any other value is REJECTED as unsupported rather than silently ignored, the same shape
 * `list_payments` uses for its reserved `savedViewId`. Accepting and ignoring it would hand back a
 * KMU-grouped report under a management-view label, which is worse than a refusal.
 */
export const SUPPORTED_GROUP_BY: readonly string[] = ['kmu'];

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: AccountType;
}

interface AggregateRow {
  account_id: string;
  debit: number;
  credit: number;
}

/** The calendar day before an ISO `YYYY-MM-DD`. Pure date arithmetic, no wall-clock read. */
function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Every account in the workspace, by id. §H-TENANT: fenced on `workspace_id`. */
function chartOf(ctx: WorkspaceContext): Map<string, AccountRow> {
  const rows = ctx.store.db
    .prepare('SELECT id, number, name, type FROM account WHERE workspace_id = ? ORDER BY number')
    .all(ctx.workspaceId) as AccountRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The window every aggregate below is taken over.
 *
 * `excludeClose` drops `source='close'` entries, which ONLY the Erfolgsrechnung asks for. See
 * `computeIncomeStatement` for why it is not the default, and why the Bilanz must never set it.
 */
interface Window {
  from?: string;
  to: string;
  excludeClose?: boolean;
}

/** The `source='close'` fence, written once so the three queries that take it cannot disagree. */
const NOT_A_CLOSE_ENTRY = "e.source != 'close'";

/**
 * Posted debit/credit totals per account over a date window, in BASE currency.
 *
 * `from` absent means "everything up to `to`", which is how a cumulative balance is taken. Both
 * `account.workspace_id` and `journal_entry.workspace_id` are fenced: the two are the same tenant
 * for every row a writer produced, and asserting both means neither alone is load-bearing.
 *
 * THAT LAST CLAIM IS NOW MEASURED, because it is the kind of claim that is usually wrong. Deleting
 * this function's tenant fences and running the A08 suite: 0 failures. Deleting `chartOf`'s instead:
 * also 0 failures. Deleting BOTH: 5 failures. So the two really are defence in depth rather than one
 * fence and one decoration, and the reason neither can be killed alone is structural: a leaked
 * aggregate row is only ever read back by `netOf(agg, account.id)` for an account `chartOf` returned,
 * and a leaked chart account finds no row in a fenced aggregate, so it nets to zero and is skipped.
 *
 * The queries that do NOT have a partner are a different matter and each one is killable on its own:
 * `resultByType` (2 failures), `countBalanceSheetAccounts` (22), and the Kontoblatt's account lookup
 * (1). `ledgerNetThrough` was the exception and was untested until `tenant.test.mjs` grew a neighbour
 * whose ledger does not net to zero, because a balanced neighbour summed into a balanced book still
 * nets to zero and hides a dead fence completely.
 */
function aggregate(ctx: WorkspaceContext, window: Window): Map<string, AggregateRow> {
  const clauses = ["e.status = 'posted'", 'e.workspace_id = ?', 'a.workspace_id = ?', 'e.date <= ?'];
  const params: string[] = [ctx.workspaceId, ctx.workspaceId, window.to];
  if (window.from !== undefined) {
    clauses.push('e.date >= ?');
    params.push(window.from);
  }
  if (window.excludeClose === true) clauses.push(NOT_A_CLOSE_ENTRY);
  const rows = ctx.store.db
    .prepare(
      `SELECT l.account_id AS account_id,
              COALESCE(SUM(l.base_debit_minor), 0) AS debit,
              COALESCE(SUM(l.base_credit_minor), 0) AS credit
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY l.account_id`,
    )
    .all(...params) as AggregateRow[];
  return new Map(rows.map((row) => [row.account_id, row]));
}

/** Debit minus credit for an account in an aggregate, or 0 when it did not move. */
function netOf(agg: Map<string, AggregateRow>, accountId: string): number {
  const row = agg.get(accountId);
  return row === undefined ? 0 : row.debit - row.credit;
}

/**
 * The posted net of every income and expense account in a window, taken by TYPE.
 *
 * The INDEPENDENT derivation of the result: no section map, no number ranges, no per-account
 * grouping. Returned as a contribution to profit (`credit - debit`), which is the Erfolgsrechnung's
 * convention.
 */
function resultByType(ctx: WorkspaceContext, window: Window): number {
  const clauses = [
    "e.status = 'posted'",
    'e.workspace_id = ?',
    'a.workspace_id = ?',
    "a.type IN ('income', 'expense')",
    'e.date <= ?',
  ];
  const params: string[] = [ctx.workspaceId, ctx.workspaceId, window.to];
  if (window.from !== undefined) {
    clauses.push('e.date >= ?');
    params.push(window.from);
  }
  if (window.excludeClose === true) clauses.push(NOT_A_CLOSE_ENTRY);
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE ${clauses.join(' AND ')}`,
    )
    .get(...params) as { net: number };
  return row.net;
}

/** The whole posted ledger's net through a date. Zero in any book double entry actually produced. */
function ledgerNetThrough(ctx: WorkspaceContext, to: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.status = 'posted' AND e.workspace_id = ? AND a.workspace_id = ? AND e.date <= ?`,
    )
    .get(ctx.workspaceId, ctx.workspaceId, to) as { net: number };
  return row.net;
}

/** The workspace's fiscal-year start as `MM-DD`, defaulting to the calendar year (A00). */
function fiscalYearStartOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/** The first day of the fiscal year a date falls in. */
function fiscalYearStartFor(ctx: WorkspaceContext, date: string): string {
  const monthDay = fiscalYearStartOf(ctx);
  return `${fiscalYearOf(date, monthDay)}-${monthDay}`;
}

/** `needs_chart` (P9): a workspace with no accounts cannot produce a statement, and says so. */
function requireChart(ctx: WorkspaceContext): Result | null {
  const row = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM account WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { n: number };
  return row.n === 0 ? err('needs_chart') : null;
}

/** A `{periodStart, periodEnd}` pair: both real calendar dates, in order. */
function requirePeriod(input: { periodStart?: unknown; periodEnd?: unknown }, prefix = ''): Result | null {
  const guard =
    requireDate(input.periodStart, `${prefix}periodStart`) ?? requireDate(input.periodEnd, `${prefix}periodEnd`);
  if (guard) return guard;
  if ((input.periodStart as string) > (input.periodEnd as string)) {
    return err('invalid_period', { periodStart: input.periodStart, periodEnd: input.periodEnd });
  }
  return null;
}

/** `groupBy` (§6b): absent or `'kmu'` today; anything else is an honest refusal, never ignored. */
function requireGroupBy(groupBy: unknown): Result | null {
  const guard = optionalId(groupBy, 'groupBy');
  if (guard) return guard;
  if (groupBy === undefined || SUPPORTED_GROUP_BY.includes(groupBy as string)) return null;
  return err('unsupported_group_by', {
    groupBy,
    supported: SUPPORTED_GROUP_BY,
    reason: 'account-level custom fields are a G00 capability and do not exist yet',
  });
}

/** The account identity every report row carries, so a caller can drill without a second read. */
function accountRef(account: AccountRow) {
  return { id: account.id, number: account.number, name: account.name, type: account.type };
}

// --- US-A08.1, Saldenbilanz ----------------------------------------------------------------------

export interface TrialBalanceInput {
  periodStart: string;
  periodEnd: string;
  compareTo?: { periodStart: string; periodEnd: string };
  groupBy?: string;
}

/**
 * The Saldenbilanz: every account's opening, period debit, period credit and closing.
 *
 * Rows are limited to accounts that actually carry something (an opening, a movement, or a closing
 * balance). A chart's worth of zero rows is not "the structure", it is noise: the statutory
 * structure lives on the Bilanz and the Erfolgsrechnung, which do render their sections at zero.
 */
export function computeTrialBalance(ctx: WorkspaceContext, input: TrialBalanceInput): Result {
  const guard = requirePeriod(input) ?? requireGroupBy(input.groupBy);
  if (guard) return guard;
  if (input.compareTo !== undefined) {
    const compareGuard = requirePeriod(input.compareTo, 'compareTo.');
    if (compareGuard) return compareGuard;
  }
  const chartGuard = requireChart(ctx);
  if (chartGuard) return chartGuard;

  const chart = chartOf(ctx);
  const openingTo = dayBefore(input.periodStart);
  const opening = aggregate(ctx, { to: openingTo });
  const movement = aggregate(ctx, { from: input.periodStart, to: input.periodEnd });
  // The independent second derivation: a CUMULATIVE aggregate with its own date fence, against which
  // `opening + debit - credit` is checked. See the reconciliation note at the top of this file.
  const cumulative = aggregate(ctx, { to: input.periodEnd });
  const compare =
    input.compareTo === undefined ? null : aggregate(ctx, { to: input.compareTo.periodEnd });

  const rows: Record<string, unknown>[] = [];
  const totals = { openingMinor: 0, debitMinor: 0, creditMinor: 0, closingMinor: 0 };
  let closingTies = true;

  for (const account of chart.values()) {
    const openingMinor = netOf(opening, account.id);
    const move = movement.get(account.id);
    const debitMinor = move?.debit ?? 0;
    const creditMinor = move?.credit ?? 0;
    const closingMinor = openingMinor + debitMinor - creditMinor;
    if (openingMinor === 0 && debitMinor === 0 && creditMinor === 0 && closingMinor === 0) continue;

    if (closingMinor !== netOf(cumulative, account.id)) closingTies = false;

    totals.openingMinor += openingMinor;
    totals.debitMinor += debitMinor;
    totals.creditMinor += creditMinor;
    totals.closingMinor += closingMinor;

    const compareClosingMinor = compare === null ? undefined : netOf(compare, account.id);
    rows.push({
      account: accountRef(account),
      kmuClass: kmuClassOf(account.number),
      openingMinor,
      debitMinor,
      creditMinor,
      closingMinor,
      ...(compareClosingMinor !== undefined
        ? { compareClosingMinor, deltaMinor: closingMinor - compareClosingMinor }
        : {}),
    });
  }

  // There is NO separate "the opening column ties out" flag, and its absence is deliberate. Closing
  // is defined as `opening + debit - credit`, so `closing == cumulative` and
  // `opening == cumulative - (debit - credit)` are the same equation rearranged: reporting both
  // would be one check wearing two badges, which is exactly the kind of padded reconciliation A07's
  // critic found. `closingTiesToLedger` validates the opening carry too.
  const debitEqualsCredit = totals.debitMinor === totals.creditMinor;
  const everyAccountRenderedOnce = rows.length === countTrialBalanceAccounts(ctx, input.periodStart, input.periodEnd);
  return ok({
    period: { start: input.periodStart, end: input.periodEnd },
    ...(input.compareTo !== undefined ? { compareTo: { start: input.compareTo.periodStart, end: input.compareTo.periodEnd } } : {}),
    baseCurrency: baseCurrencyOf(ctx),
    groupBy: input.groupBy ?? 'kmu',
    rows,
    groups: groupByKmuClass(rows),
    totals,
    noActivity: rows.length === 0,
    reconciles: debitEqualsCredit && closingTies && everyAccountRenderedOnce,
    reconciliation: {
      debitEqualsCredit,
      closingTiesToLedger: closingTies,
      everyAccountRenderedOnce,
    },
  });
}

/**
 * How many accounts BELONG on the Saldenbilanz for a window, counted in one grouped query.
 *
 * The predicate is the row-inclusion rule stated in SQL rather than in the loop above: an account
 * earns a row when it closes at something, or when it moved inside the window. Compared against
 * `rows.length` this is the coverage check, and it is what catches an account the report never
 * reached (a tenant fence that quietly excluded it, a chart read that missed it). Neither a drop nor
 * a duplicate moves any TOTAL on its own, which is why the totals cannot be asked about it.
 */
function countTrialBalanceAccounts(ctx: WorkspaceContext, periodStart: string, periodEnd: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT l.account_id
           FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id
           JOIN account a ON a.id = l.account_id
          WHERE e.status = 'posted' AND e.workspace_id = ? AND a.workspace_id = ? AND e.date <= ?
          GROUP BY l.account_id
         HAVING COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) <> 0
             OR COALESCE(SUM(CASE WHEN e.date >= ? THEN l.base_debit_minor + l.base_credit_minor ELSE 0 END), 0) <> 0
       )`,
    )
    .get(ctx.workspaceId, ctx.workspaceId, periodEnd, periodStart) as { n: number };
  return row.n;
}

/**
 * The `groupBy='kmu'` bucketing (§6b): the SAME rows and the SAME totals, under a section label.
 *
 * Purely presentational, and that is the invariant §7 pins: re-bucketing may change which header a
 * row sits under and nothing else. The rows themselves are not copied into the groups, only their
 * account numbers, so a grouping bug cannot duplicate a figure.
 */
function groupByKmuClass(rows: readonly Record<string, unknown>[]) {
  const buckets = new Map<string, { accounts: string[]; debitMinor: number; creditMinor: number; closingMinor: number }>();
  for (const row of rows) {
    const key = row.kmuClass as string;
    const bucket = buckets.get(key) ?? { accounts: [], debitMinor: 0, creditMinor: 0, closingMinor: 0 };
    bucket.accounts.push((row.account as { number: string }).number);
    bucket.debitMinor += row.debitMinor as number;
    bucket.creditMinor += row.creditMinor as number;
    bucket.closingMinor += row.closingMinor as number;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => ({ key, labels: KMU_CLASS_LABELS[key] ?? KMU_CLASS_LABELS['?'], ...bucket }));
}

// --- US-A08.2, Bilanz ----------------------------------------------------------------------------

export interface BalanceSheetInput {
  asOf: string;
  /**
   * The prior reporting DATE the comparison column is drawn at (US-A08.5).
   *
   * An object carrying one date rather than a bare string, so `compareTo` has ONE declared type
   * across all four tools. The registry's schema gate requires every property to declare a type, and
   * a field that is an object on three verbs and a string on the fourth cannot be typed on
   * `export_statement`, which forwards whichever of them it was asked for.
   */
  compareTo?: { asOf: string };
}

/**
 * The Bilanz grouped into the FIRST LEVEL of OR Art. 959a, with the result carried into Eigenkapital.
 *
 * This docblock used to open "The Bilanz in the OR Art. 959a minimum structure", and it is the
 * docblock of the function the `balance_sheet` tool calls. The tool description was corrected and
 * this sentence was left standing three files away, which is how the claim survived its own
 * retraction. A08 §10 forbids it in terms.
 *
 * What is actually modelled: seven first-level groupings, five citing an Absatz and a Ziffer of
 * OR Art. 959a and two the residual of Abs. 3, plus the two computed equity lines of Abs. 2 Ziff. 3
 * lit. f and lit. g. The 24 sub-positions Abs. 1 and Abs. 2 prescribe "einzeln und in der
 * vorgegebenen Reihenfolge" are NOT modelled, which `OR_ARTICLE_COVERAGE` in `sections.ts` records
 * as 0 of 10 and 2 of 14 and `test/reports/statutory-claims.test.mjs` holds every description to.
 *
 * NO `groupBy` (§6b, fixed): this is the statement a Treuhänder, an auditor or the FTA reads, and a
 * management view that re-shapes it is a different document. The parameter is not accepted at all
 * rather than accepted and refused, so the contract itself says the answer.
 */
export function computeBalanceSheet(ctx: WorkspaceContext, input: BalanceSheetInput): Result {
  const guard =
    requireDate(input.asOf, 'asOf') ??
    (input.compareTo === undefined ? null : requireDate(input.compareTo.asOf, 'compareTo.asOf'));
  if (guard) return guard;
  const chartGuard = requireChart(ctx);
  if (chartGuard) return chartGuard;

  const chart = chartOf(ctx);
  const balances = aggregate(ctx, { to: input.asOf });
  const compare = input.compareTo === undefined ? null : aggregate(ctx, { to: input.compareTo.asOf });

  const sections = BILANZ_SECTIONS.map((def) => ({
    key: def.key,
    side: def.side,
    labels: def.labels,
    cite: def.cite,
    lines: [] as Record<string, unknown>[],
    subtotalMinor: 0,
    ...(compare === null ? {} : { compareSubtotalMinor: 0 }),
  }));
  const byKey = new Map(sections.map((section) => [section.key, section]));
  let accountLines = 0;

  for (const account of chart.values()) {
    if (account.type === 'income' || account.type === 'expense') continue;
    const net = netOf(balances, account.id);
    const section = byKey.get(bilanzSectionFor(account));
    if (section === undefined) continue;
    // Positive on the account's own side. `credit - debit` for a liability or equity account, so a
    // Kreditor of 6'850.00 reads as +685000 and not as the ledger's -685000.
    const balanceMinor = section.side === 'aktiven' ? net : -net;
    const compareBalanceMinor =
      compare === null ? undefined : section.side === 'aktiven' ? netOf(compare, account.id) : -netOf(compare, account.id);
    if (balanceMinor === 0 && (compareBalanceMinor ?? 0) === 0) continue;
    accountLines += 1;
    section.subtotalMinor += balanceMinor;
    if (compare !== null) {
      (section as { compareSubtotalMinor: number }).compareSubtotalMinor += compareBalanceMinor ?? 0;
    }
    section.lines.push({
      key: account.number,
      account: accountRef(account),
      balanceMinor,
      ...(compareBalanceMinor !== undefined
        ? { compareBalanceMinor, deltaMinor: balanceMinor - compareBalanceMinor }
        : {}),
    });
  }

  // OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g: the result belongs on the Bilanz, as equity. See
  // COMPUTED_EQUITY_LINES for why it is two positions and not one.
  const fyStart = fiscalYearStartFor(ctx, input.asOf);
  const equity = byKey.get('eigenkapital');
  const computed: Record<string, number> = {
    ergebnisvortrag: resultByType(ctx, { to: dayBefore(fyStart) }),
    jahresergebnis: resultByType(ctx, { from: fyStart, to: input.asOf }),
  };
  const compareComputed: Record<string, number> = {};
  if (compare !== null && input.compareTo !== undefined) {
    const compareFyStart = fiscalYearStartFor(ctx, input.compareTo.asOf);
    compareComputed.ergebnisvortrag = resultByType(ctx, { to: dayBefore(compareFyStart) });
    compareComputed.jahresergebnis = resultByType(ctx, { from: compareFyStart, to: input.compareTo.asOf });
  }
  if (equity !== undefined) {
    for (const def of COMPUTED_EQUITY_LINES) {
      const balanceMinor = computed[def.key] ?? 0;
      equity.subtotalMinor += balanceMinor;
      const compareBalanceMinor = compare === null ? undefined : (compareComputed[def.key] ?? 0);
      if (compare !== null) {
        (equity as { compareSubtotalMinor: number }).compareSubtotalMinor += compareBalanceMinor ?? 0;
      }
      equity.lines.push({
        key: def.key,
        // Computed, not an account: `null` rather than a fabricated account reference, so a caller
        // that tries to drill into it gets nothing instead of a plausible wrong entry list.
        account: null,
        labels: def.labels,
        cite: def.cite,
        balanceMinor,
        ...(compareBalanceMinor !== undefined
          ? { compareBalanceMinor, deltaMinor: balanceMinor - compareBalanceMinor }
          : {}),
      });
    }
  }

  const aktivenMinor = sections.filter((s) => s.side === 'aktiven').reduce((sum, s) => sum + s.subtotalMinor, 0);
  const passivenMinor = sections.filter((s) => s.side === 'passiven').reduce((sum, s) => sum + s.subtotalMinor, 0);

  const movedAccounts = countBalanceSheetAccounts(ctx, input.asOf, input.compareTo?.asOf);
  const aktivenEqualPassiven = aktivenMinor === passivenMinor;
  const ledgerNetsToZero = ledgerNetThrough(ctx, input.asOf) === 0;
  const everyAccountClassifiedOnce = accountLines === movedAccounts;

  return ok({
    asOf: input.asOf,
    ...(input.compareTo !== undefined ? { compareTo: input.compareTo.asOf } : {}),
    baseCurrency: baseCurrencyOf(ctx),
    sections,
    aktivenMinor,
    passivenMinor,
    ...(compare === null
      ? {}
      : {
          compareAktivenMinor: sections
            .filter((s) => s.side === 'aktiven')
            .reduce((sum, s) => sum + ((s as { compareSubtotalMinor?: number }).compareSubtotalMinor ?? 0), 0),
          comparePassivenMinor: sections
            .filter((s) => s.side === 'passiven')
            .reduce((sum, s) => sum + ((s as { compareSubtotalMinor?: number }).compareSubtotalMinor ?? 0), 0),
        }),
    noActivity: accountLines === 0,
    reconciles: aktivenEqualPassiven && ledgerNetsToZero && everyAccountClassifiedOnce,
    reconciliation: { aktivenEqualPassiven, ledgerNetsToZero, everyAccountClassifiedOnce },
  });
}

/**
 * How many balance-sheet accounts carry a non-zero balance, counted independently of the section map.
 *
 * Compared against the lines actually rendered, this is the coverage check: a dropped account and a
 * duplicated one both move the count, and neither moves any total on its own.
 */
function countBalanceSheetAccounts(ctx: WorkspaceContext, asOf: string, compareTo?: string): number {
  const dates = compareTo === undefined ? [asOf] : [asOf, compareTo];
  const seen = new Set<string>();
  for (const date of dates) {
    const rows = ctx.store.db
      .prepare(
        `SELECT l.account_id AS account_id
           FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id
           JOIN account a ON a.id = l.account_id
          WHERE e.status = 'posted' AND e.workspace_id = ? AND a.workspace_id = ? AND e.date <= ?
            AND a.type IN ('asset', 'liability', 'equity')
          GROUP BY l.account_id
         HAVING COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) <> 0`,
      )
      .all(ctx.workspaceId, ctx.workspaceId, date) as { account_id: string }[];
    for (const row of rows) seen.add(row.account_id);
  }
  return seen.size;
}

// --- US-A08.3, Erfolgsrechnung -------------------------------------------------------------------

export interface IncomeStatementInput {
  periodStart: string;
  periodEnd: string;
  compareTo?: { periodStart: string; periodEnd: string };
}

/**
 * The Erfolgsrechnung in the OR Art. 959b Abs. 2 Gesamtkostenverfahren layout.
 *
 * NO `groupBy` (§6b, fixed), for the same reason as the Bilanz. The Absatzerfolgsrechnung of
 * Abs. 3 (Umsatzkostenverfahren) is a different layout that needs a cost-of-sales attribution the
 * ledger does not carry, and A08 does not pretend to offer it.
 *
 * ## THE CLOSING ENTRY IS NOT A TRANSACTION, and this statement excludes it
 *
 * A03's `hardCloseYear` posts a real `source='close'` journal entry, dated the LAST DAY of the
 * fiscal year, whose entire purpose is to zero every P&L account into 2979 and carry that into 2970.
 * It is bookkeeping machinery, not trade. Summing it back into the Erfolgsrechnung made the closed
 * year's statement read
 *
 *     reingewinn=0  netto_erloese=0  personalaufwand=0  noActivity=true  reconciles=true
 *
 * on a year that had turned CHF 5'000.00 of revenue against CHF 2'000.00 of wages. Both flags were
 * green because they compared a zeroed report against a zeroed ledger: the check summed the same
 * rows it had just distributed, which is precisely the failure A07 shipped four of. A blank
 * Erfolgsrechnung for a closed year is the single worst document this module can produce, because a
 * closed year is exactly the year a Treuhänder files.
 *
 * `yearClose.ts` has always excluded its own entries when it computes the result (`AND e.source !=
 * 'close'`); this statement now agrees with it. The exclusion is UNCONDITIONAL rather than scoped to
 * the window, because a close entry carries nothing an Erfolgsrechnung should ever show, whichever
 * period it falls in.
 *
 * THE BILANZ MUST NOT DO THIS, and does not. There the close is real movement: it puts the result
 * into 2970, a genuine equity account that appears as an ordinary line, and `jahresergebnis` (lit. g)
 * correctly falls to zero as the close moves it out. Excluding the close there would count the
 * result twice, on 2970 and again on lit. g, and the Bilanz would stop footing. The two statements
 * disagreeing about the close entry is the correct answer, not an inconsistency.
 *
 * The one thing this cannot defend against is a caller posting ordinary trade with `source='close'`
 * through `postEntry`. That is the same assumption `yearClose.ts` makes, and `source` is a
 * classification the writer chooses; a book that mislabels its revenue as a closing entry is
 * mislabelled at the ledger, not misreported here.
 */
export function computeIncomeStatement(ctx: WorkspaceContext, input: IncomeStatementInput): Result {
  const guard = requirePeriod(input);
  if (guard) return guard;
  if (input.compareTo !== undefined) {
    const compareGuard = requirePeriod(input.compareTo, 'compareTo.');
    if (compareGuard) return compareGuard;
  }
  const chartGuard = requireChart(ctx);
  if (chartGuard) return chartGuard;

  const chart = chartOf(ctx);
  const movement = aggregate(ctx, { from: input.periodStart, to: input.periodEnd, excludeClose: true });
  const compare =
    input.compareTo === undefined
      ? null
      : aggregate(ctx, { from: input.compareTo.periodStart, to: input.compareTo.periodEnd, excludeClose: true });

  const sections = ERFOLG_SECTIONS.map((def) => ({
    key: def.key,
    nature: def.nature,
    labels: def.labels,
    cite: def.cite,
    lines: [] as Record<string, unknown>[],
    subtotalMinor: 0,
    ...(compare === null ? {} : { compareSubtotalMinor: 0 }),
  }));
  const byKey = new Map(sections.map((section) => [section.key, section]));
  let accountLines = 0;

  for (const account of chart.values()) {
    if (account.type !== 'income' && account.type !== 'expense') continue;
    // Contribution to profit, `credit - debit`. Never an absolute value: a loss is a negative here.
    const amountMinor = -netOf(movement, account.id);
    const compareAmountMinor = compare === null ? undefined : -netOf(compare, account.id);
    if (amountMinor === 0 && (compareAmountMinor ?? 0) === 0) continue;
    const section = byKey.get(erfolgSectionFor(account));
    if (section === undefined) continue;
    accountLines += 1;
    section.subtotalMinor += amountMinor;
    if (compare !== null) {
      (section as { compareSubtotalMinor: number }).compareSubtotalMinor += compareAmountMinor ?? 0;
    }
    section.lines.push({
      key: account.number,
      account: accountRef(account),
      amountMinor,
      ...(compareAmountMinor !== undefined
        ? { compareAmountMinor, deltaMinor: amountMinor - compareAmountMinor }
        : {}),
    });
  }

  const reingewinnMinor = sections.reduce((sum, section) => sum + section.subtotalMinor, 0);
  // The independent opinion: by account TYPE, with no number range and no section map involved. It
  // takes the SAME close fence as the sections above, because a flag that compared a close-excluding
  // report against a close-including ledger would go red on every properly closed year.
  const resultTiesToLedger =
    reingewinnMinor === resultByType(ctx, { from: input.periodStart, to: input.periodEnd, excludeClose: true });
  const everyAccountClassifiedOnce =
    accountLines === countResultAccounts(ctx, input.periodStart, input.periodEnd, input.compareTo);

  return ok({
    period: { start: input.periodStart, end: input.periodEnd },
    ...(input.compareTo !== undefined
      ? { compareTo: { start: input.compareTo.periodStart, end: input.compareTo.periodEnd } }
      : {}),
    baseCurrency: baseCurrencyOf(ctx),
    sections,
    reingewinnMinor,
    ...(compare === null
      ? {}
      : {
          compareReingewinnMinor: sections.reduce(
            (sum, s) => sum + ((s as { compareSubtotalMinor?: number }).compareSubtotalMinor ?? 0),
            0,
          ),
        }),
    noActivity: accountLines === 0,
    reconciles: resultTiesToLedger && everyAccountClassifiedOnce,
    reconciliation: { resultTiesToLedger, everyAccountClassifiedOnce },
  });
}

/**
 * How many income/expense accounts moved in the window, counted without the section map.
 *
 * Takes the same `source='close'` fence the statement does. Without it, a closed year counted the
 * P&L accounts the closing entry touched and the coverage flag went red on a correct report.
 */
function countResultAccounts(
  ctx: WorkspaceContext,
  from: string,
  to: string,
  compareTo?: { periodStart: string; periodEnd: string },
): number {
  const windows = compareTo === undefined ? [[from, to]] : [[from, to], [compareTo.periodStart, compareTo.periodEnd]];
  const seen = new Set<string>();
  for (const [start, end] of windows) {
    const rows = ctx.store.db
      .prepare(
        `SELECT l.account_id AS account_id
           FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id
           JOIN account a ON a.id = l.account_id
          WHERE e.status = 'posted' AND e.workspace_id = ? AND a.workspace_id = ?
            AND ${NOT_A_CLOSE_ENTRY}
            AND e.date >= ? AND e.date <= ? AND a.type IN ('income', 'expense')
          GROUP BY l.account_id
         HAVING COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) <> 0`,
      )
      .all(ctx.workspaceId, ctx.workspaceId, start, end) as { account_id: string }[];
    for (const row of rows) seen.add(row.account_id);
  }
  return seen.size;
}

// --- US-A08.4, Kontoblatt ------------------------------------------------------------------------

export interface GeneralLedgerInput {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  groupBy?: string;
}

interface LedgerLineRow {
  entry_id: string;
  date: string;
  ref: string | null;
  description: string | null;
  source: string;
  debit: number;
  credit: number;
}

/**
 * The Kontoblatt: one account's opening carry, every posting in the window, and a running balance.
 *
 * Debit-positive throughout, like the Saldenbilanz: this is a working paper. `naturalSide` says
 * which way the account is expected to lean so a GUI can present it without inferring a sign.
 */
export function computeGeneralLedger(ctx: WorkspaceContext, input: GeneralLedgerInput): Result {
  const guard =
    requireString(input.accountId, 'accountId') ?? requirePeriod(input) ?? requireGroupBy(input.groupBy);
  if (guard) return guard;

  const account = ctx.store.db
    .prepare('SELECT id, number, name, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.accountId) as AccountRow | undefined;
  if (account === undefined) return err('not_found', { accountId: input.accountId });

  const opening = aggregate(ctx, { to: dayBefore(input.periodStart) });
  const openingMinor = netOf(opening, account.id);

  const rows = ctx.store.db
    .prepare(
      `SELECT l.entry_id AS entry_id, e.date AS date, e.ref AS ref, e.description AS description,
              e.source AS source, l.base_debit_minor AS debit, l.base_credit_minor AS credit
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.status = 'posted' AND e.workspace_id = ? AND a.workspace_id = ? AND l.account_id = ?
          AND e.date >= ? AND e.date <= ?
        ORDER BY e.date, e.created_at, e.id, l.rowid`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, account.id, input.periodStart, input.periodEnd) as LedgerLineRow[];

  let running = openingMinor;
  const lines = rows.map((row) => {
    running += row.debit - row.credit;
    return {
      date: row.date,
      entryId: row.entry_id,
      ref: row.ref,
      description: row.description,
      source: row.source,
      debitMinor: row.debit,
      creditMinor: row.credit,
      runningMinor: running,
    };
  });

  const closingMinor = running;
  // The same two-derivation check the Saldenbilanz makes, for one account: the running balance is
  // built by accumulation, the target by a single cumulative aggregate.
  const closingTiesToLedger = closingMinor === netOf(aggregate(ctx, { to: input.periodEnd }), account.id);

  return ok({
    account: accountRef(account),
    naturalSide: account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit',
    period: { start: input.periodStart, end: input.periodEnd },
    baseCurrency: baseCurrencyOf(ctx),
    groupBy: input.groupBy ?? 'kmu',
    kmuClass: kmuClassOf(account.number),
    openingMinor,
    lines,
    closingMinor,
    noActivity: lines.length === 0,
    reconciles: closingTiesToLedger,
    reconciliation: { closingTiesToLedger },
  });
}
