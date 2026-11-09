/**
 * F00's three verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `costingActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * TWO READS AND NOT ONE WRITE, the B03/A08 shape: F00 owns no table and posts nothing (pure P5),
 * so both tools carry `readOnlyHint` on MCP, neither carries an `idempotency_key`, and there is no
 * conformance write scenario to write. Both opt into `READ_SCENARIOS` instead, and
 * `test/dashboards/` holds the read-only claim up by census and by static scan rather than by
 * trusting this comment.
 *
 * RBAC is PER TILE, not per verb (spec US-F00.6): each tile in `src/core/dashboards/tiles.ts`
 * declares the source verbs' own read gates, the engine asserts them via `ctx.capabilities`, and a
 * tile the caller may not see is OMITTED server-side. The boundary declaration in
 * `actionCapabilities.ts` is therefore `ungated('asserted_in_engine', ...)`: gating the whole verb
 * on any one read domain would either deny an operations-only role its permitted tiles or leak a
 * financial tile past a role that lacks the source verb's own gate.
 *
 * The descriptions name the German report words (Übersicht, Kacheln, Umsatz, Auslastung, MWST
 * fällig) the way A08 names Bilanz and Erfolgsrechnung, so an agent asked "wie läuft das Geschäft?"
 * can find the verb. They also say what a degraded tile means, because an agent will quote them: a
 * `needs_projects` tile is a module not in use, not a measured zero.
 *
 * As with every sibling module, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { dashboardOverview, dashboardRevenueEstimate, dashboardSeries, dashboardTile, DASHBOARD_TILES, RUNWAY_MONTHS, SERIES_MAX_MONTHS, SERIES_TOP_DEFAULT, SERIES_TOP_MAX } from '../core/dashboards/index.js';
import { getDeliveryRuntime } from './runtime-state.js';
import type { ActionKind } from './actionKind.js';

export interface DashboardActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/**
 * D142: the one fact the engine cannot know about the `bank_inbox` band: whether THIS process runs the
 * scheduler that fetches daily (`till up`), or not (`till serve`, a bare `till mcp`). Added here, at the
 * process boundary, as `autoAvailable`; every figure stays the engine's.
 */
function withProcessFacts(result: Result): Result {
  if (!result.ok) return result;
  const autoAvailable = getDeliveryRuntime().scheduler.enabled;
  const mark = (t: unknown): unknown =>
    typeof t === 'object' && t !== null && (t as { tile?: unknown }).tile === 'bank_inbox' && (t as { ok?: unknown }).ok === true
      ? { ...(t as Record<string, unknown>), autoAvailable }
      : t;
  if (Array.isArray(result.tiles)) return { ...result, tiles: result.tiles.map(mark) };
  if (typeof result.tile === 'object' && result.tile !== null) return { ...result, tile: mark(result.tile) };
  return result;
}

/** The F00 verbs, in append order. */
export function dashboardActions(h: DashboardActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  return [
    ctxAction(
      'dashboard_overview',
      'read',
      `Die Übersicht (dashboard): one KPI tile wall for a date range, composed live from the read models the product already computes and never cached (pure read, F00 posts nothing and owns no tables). Core tiles: ${DASHBOARD_TILES.join(' | ')}, each an integer-Rappen (or basis-point) figure that equals its source verb's answer for the same filter: revenue from income_statement (the Nettoerlöse section; comparisons.previous_period and comparisons.previous_year each give the window, its figure and changeBp, like for like: both windows stop at comparedThrough, the earlier of the range end and today, so a running month is compared day for day; trendBp is the previous period's changeBp; estimate gives revenueMinor, lineCount and the excluded counts of what the open bank lines of the range would add, net of MWST, see dashboard_revenue_estimate), cash from the A19 bank accounts' Kontoblatt closing balances (general_ledger), AR from aging_report, AP from list_vendor_bills, utilisation as the billable share of time_list minutes (B01 has no capacity model), margin from costing_pl_list, MWST due verbatim from vat_return for the settlement period containing the range end, stock value from stock_valuation_report under the books' method. bank_inbox is the Bankeingang band (current, not ranged): the open bank lines, those that need you, the sure proposals and the lines booked to accounts without a Beleg, each by list_bank_inbox's own per-line definitions, per Bankkonto with money in and out, plus the last statement fetch, a fetch running now, the daily automatic fetch (autoMode, nextAutoSyncAt, lastAutoOutcome) and autoAvailable (false when this process runs no scheduler, e.g. till serve). D186 adds: bank_balance (the money ON the bank: per Bankkonto the latest statement's closing booked balance bankMinor with statementDate, the linked account's bookedMinor that day, openCount/openMinor of the lines still open and differenceMinor = bank - booked - open; an account without a statement balance has bankMinor null and a reason; valueRappen sums the base-currency accounts, the books where no statement says it, complete:false then), free_cash (from the BOOKS alone, basis 'books': the distinct Bankkonto ledger accounts at base value less 2000 Kreditoren less the MWST still open by liquidity_forecast's own rule (A07's return capped by what 2200 + 2201 owe; the return figure for a Saldo period), all as of today; an unbooked bank line moves none of the terms; detail has each), runway (valueQuantity in tenths of months: the bank over the average monthly expense of the last runwayMonths whole months), low_point (liquidity_forecast's lowest balance in 30 days, which starts from the books), expense, result (Reingewinn), margin (valueBp, changes in points), revenue_ltm, dso (valueQuantity days from issue to payment, last 12 months, lowerIsBetter), top_customer (valueBp share of the largest customer's net invoiced turnover), auto_rate (valueBp of the decided bank lines a Buchungsregel or the autopilot decided) and receipt_rate (valueBp of outgoing lines booked to accounts that have their Beleg). Options: runwayMonths (${RUNWAY_MONTHS.join(", ")}, default 6) compareCut (same_day, the default: both windows stop at the same day; whole_period: the whole range against the whole earlier one) and estimateBasis (rules: a Buchungsregel's proposal plus the sure and learned ones, the default; all: also the ones to check). Every tile embeds a drill descriptor (studioRoute, mcpTool, params) naming the EXISTING source tool behind the number: call that tool for the rows. Tiles the caller's A24 role may not see are omitted server-side into omitted[] (per-tile gates: read_books, read_sales, read_vat, read_master_data, time.read, costing.read); an unconfigured or unused module degrades its one tile to ok:false with the source's own code (needs_vat_config, needs_chart, needs_projects, needs_stock_items) while the rest still render; an empty workspace answers ok:true zero states, never an error. from > to answers invalid_range. savedViewId applies a G00 saved view (entityKind 'workspace', layout 'dashboard') to restrict and order tiles; an unresolvable view falls back to the full default with viewFallback:true and can never widen access.`,
      ctxSchema({ from: STR, to: STR, savedViewId: STR, runwayMonths: INT, estimateBasis: STR, compareCut: STR }, ['from', 'to']),
      (ctx, input) => withProcessFacts(dashboardOverview(ctx, as(input))),
    ),
    ctxAction(
      'dashboard_tile',
      'read',
      `Eine Kachel der Übersicht in voller Tiefe: the same figure dashboard_overview shows for '${DASHBOARD_TILES.join("' | '")}', plus its detail block (the aging buckets behind the Debitoren figure, the top and bottom projects behind the Marge, the MWST settlement period and filed flag, the per-bank-account closing balances) and the drill descriptor naming the source tool that owns the rows. The value is the source verb's own answer, recomputed on every call; F00 fabricates nothing. An unknown tile id answers unknown_tile naming the valid set; a tile the caller's A24 role may not see answers permission_denied outright (the same per-tile gate the overview applies as an omission); an unavailable module answers the tile with ok:false and the source's own structured code.`,
      ctxSchema({ tile: STR, from: STR, to: STR, runwayMonths: INT, estimateBasis: STR, compareCut: STR }, ['tile', 'from', 'to']),
      (ctx, input) => withProcessFacts(dashboardTile(ctx, as(input))),
    ),
    // D178 point 13: the series behind the Übersicht's charts. Gated `read_books` at the boundary (one
    // domain: every figure is the ledger's), unlike the two per-tile verbs above.
    ctxAction(
      'dashboard_series',
      'read',
      `Die Diagramme der Übersicht: Geld rein und raus pro Monat und die grössten Aufwände (pure read, posts nothing). months[] holds every calendar month the range touches (clipped to it, at most ${SERIES_MAX_MONTHS}), each with inMinor and outMinor in integer base-currency Rappen: the money in and out of the A19 Bankkonten's ledger accounts, netted per journal entry, so a transfer between two own bank accounts is neither in nor out, and the engine's own opening postings (Eröffnungsbilanz, Bank-Eröffnungssaldo) are left out because no money moved. totals sums them; Σ in − Σ out equals the bank accounts' net Kontoblatt movement over the window (general_ledger) minus those openings. topExpenses[] names the ${SERIES_TOP_DEFAULT} (top, 1 to ${SERIES_TOP_MAX}) largest Aufwand accounts of the range from income_statement (accountId, number, name, amountMinor), otherExpensesMinor is the rest of the expense accounts with a debit balance, grossExpenseMinor their sum (Σ top + other = gross), expenseReductionsMinor the expense accounts with a credit balance in the range (zero or negative: an Aufwandminderung or a stock change booked against material), and expenseTotalMinor the Erfolgsrechnung's net expense total (gross + reductions = total). bankAccounts counts the Bankkonten that fed the series (0 means no bank account yet: every month is 0, never an error). from > to answers invalid_range, a window over ${SERIES_MAX_MONTHS} months range_too_long, a workspace with no chart needs_chart. D186 adds result[] (per month revenueMinor, the Nettoerlöse, and expenseMinor, the expense accounts' net, each with previousYear for the same month a year earlier), balances[] (per month end the base-currency Bankkonten's statement balance bankMinor, null unless every account has one, and the books bookedMinor on the statement's date) and topVendors[] (name, contactId when a vendor bill names it, amountMinor: the expense accounts' net by vendor bill contact or by the counterparty of the bank line that booked it), otherVendorsMinor and unattributedExpenseMinor (gross expense no vendor names). balances and topVendors need read_sales too; without it they are null and named in omitted.`,
      ctxSchema({ from: STR, to: STR, top: INT }, ['from', 'to']),
      (ctx, input) => dashboardSeries(ctx, as(input)),
    ),
    // D186 point 2: the estimate line by line, so an agent sees the figure the revenue tile shows and why.
    ctxAction(
      'dashboard_revenue_estimate',
      'read',
      `Geschätzter Umsatz (D186): what booking the OPEN bank lines dated in [from, to] would add to the Nettoerlöse, before anyone books them (pure read, posts nothing). Each open line gets the proposal list_bank_inbox shows; where it books to accounts (an accounts or a rule target) the booking preview (compose_entry's bank-line path, the exact lines book_bank_line would post, rule factor and MWST split included) is summed on the Nettoerlöse accounts (A08 class 30 to 38), credit minus debit, in base Rappen: so the figure is net of MWST. lines[] names each counted line (bankTxnId, date, amountMinor, counterparty, basis rule|proposal, certainty, reasonCode, accountNumbers, revenueMinor); excluded counts the rest per reason: settles_document (the proposal pays an invoice or bill, whose turnover was booked at issue), ignored_by_rule, no_proposal, below_basis, not_bookable (the preview refuses: an amount still to ask, a rest of zero), no_revenue. basis rules (default) counts a Buchungsregel's proposal whatever its certainty plus the sure and learned ones; all also counts the ones to check. The estimate drops a line the moment it is booked. Needs read_books and read_sales.`,
      ctxSchema({ from: STR, to: STR, basis: STR }, ['from', 'to']),
      (ctx, input) => dashboardRevenueEstimate(ctx, as(input)),
    ),
  ];
}
