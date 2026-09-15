/**
 * The validations (spec G22 §10.4): named plausibility checks with a formula, the figures behind it
 * and a result, composing EXISTING reads (P5): A08's Bilanz and Saldenbilanz, A16's OP-Liste, A17's
 * as-of payables halves, H04's posted lines and A03's locks. Each answers `pass`, `fail` or
 * `unavailable` (with a reason); a `warn` row's acknowledgement binds `hash`, so a figure that moves
 * voids it by derivation.
 *
 * `formula` is an i18n key (`checklists.validation.<key>.formula`), never on-screen text; `explanation`
 * is the engine's own compact sentence with the figures in base minor, meant for the agent prompt and
 * the audit trail. A validation that throws reads `unavailable` with its reason: an unavailable row is
 * never a dead end (it carries the same fixLink as a failure and an "Erneut prüfen" control).
 *
 * The A38 half (N4, 2026-09-10): `accruals_reversed` reads 1300 and 2300 on the first day after the
 * period end; `vat_accounts_zero` reads the three tax accounts at the period end and REPORTS 2201 beside
 * the last settlement's net; `vat_declared_equals_books` and `umsatzabstimmung` read A38's
 * `vat_annual_reconciliation` of the calendar year; `tax_provision_plausible` compares the posted
 * `steuern` provision with the helper's gross figure net of the OTHER instalments (the preview's own
 * instalment figure includes the posted provision's 8900 line). `bank_balance_matches` (Q7) reads the
 * A20 statement covering the period end for every base-currency bank account and, with none on file,
 * the figure a human typed on the sibling `bank_balance_typed` sign-off row of the same run.
 */

import type { WorkspaceContext } from '../context.js';
import { computeBalanceSheet, computeTrialBalance } from '../reports/index.js';
import { listOpenItems } from '../debtors/index.js';
import { payablesBalanceAsOf, supplierOnAccountMinor, workspaceBaseOpenMinor } from '../purchase/index.js';
import { fiscalYearOf } from '../ledger/index.js';
import { canonicalHashOf } from './hash.js';
import { periodLockOf } from './checks.js';
import { taxProvisionPreview, vatAnnualReconciliation } from '../accruals/index.js';
import { baseCurrencyOf } from '../fx/index.js';
import { addDays, addMonths } from './deadlines.js';
import { fiscalYearBounds, fiscalYearStartOf, monthsBetween, type ChecklistPeriod } from './periods.js';
import type { ChecklistValidationKey } from './types.js';

export type ValidationOutcome = 'pass' | 'fail' | 'unavailable';

export interface ValidationResult {
  readonly key: ChecklistValidationKey;
  readonly result: ValidationOutcome;
  /** The i18n key of the formula text. */
  readonly formula: string;
  readonly figures: Record<string, unknown>;
  readonly explanation: string;
  readonly reason?: string;
  /** The hash an acknowledgement binds: the key, the result and the figures, canonical. */
  readonly hash: string;
}

/** D129 Q5: the Vorjahresvergleich warns only when the change exceeds BOTH bounds. */
export const PRIOR_YEAR_PCT_BAND = 50;
export const PRIOR_YEAR_MINOR_BAND = 500_000;

/** Art. 725a OR: a Kapitalverlust when equity covers less than half of Kapital plus gesetzliche Reserven. */
export const CAPITAL_LOSS_RATIO = 0.5;

function formulaKey(key: ChecklistValidationKey): string {
  return `checklists.validation.${key}.formula`;
}

function finish(key: ChecklistValidationKey, result: ValidationOutcome, figures: Record<string, unknown>, explanation: string, reason?: string): ValidationResult {
  const hash = canonicalHashOf({ key, result, figures });
  return reason === undefined
    ? { key, result, formula: formulaKey(key), figures, explanation, hash }
    : { key, result, formula: formulaKey(key), figures, explanation, reason, hash };
}

function unavailable(key: ChecklistValidationKey, reason: string, figures: Record<string, unknown> = {}): ValidationResult {
  return finish(key, 'unavailable', figures, `${key}: unavailable (${reason})`, reason);
}

// --- The implemented validations --------------------------------------------------------------

function locksOnAllMonths(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'locks_on_all_months';
  const months = monthsBetween(period.periodStart, period.periodEnd).slice(0, -1);
  const locked = months.filter((m) => periodLockOf(ctx, m) !== undefined);
  const missing = months.filter((m) => !locked.includes(m));
  const figures = { months, locked, missing };
  return finish(key, missing.length === 0 ? 'pass' : 'fail', figures, `${locked.length} of ${months.length} months locked; missing: ${missing.join(', ') || 'none'}`);
}

function openItemsDebtors(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'open_items_debtors';
  const res = listOpenItems(ctx, { asOf: period.periodEnd });
  if (!res.ok) return unavailable(key, res.error ?? 'list_open_items refused');
  const openMinor = Number(res.workspaceBaseTotalOpenMinor ?? 0);
  const ledgerMinor = Number(res.receivablesBalanceMinor ?? 0);
  const differenceMinor = openMinor - ledgerMinor;
  const figures = { asOf: period.periodEnd, openItemsMinor: openMinor, ledger1100Minor: ledgerMinor, differenceMinor };
  return finish(key, differenceMinor === 0 ? 'pass' : 'fail', figures, `open items ${openMinor} vs 1100 ${ledgerMinor}: difference ${differenceMinor}`);
}

function openItemsCreditors(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'open_items_creditors';
  const asOf = period.periodEnd;
  const openMinor = workspaceBaseOpenMinor(ctx, asOf);
  const onAccountMinor = supplierOnAccountMinor(ctx, asOf);
  const ledgerMinor = payablesBalanceAsOf(ctx, asOf);
  const differenceMinor = openMinor - onAccountMinor - ledgerMinor;
  const figures = { asOf, openBillsMinor: openMinor, onAccountMinor, ledger2000Minor: ledgerMinor, differenceMinor };
  return finish(key, differenceMinor === 0 ? 'pass' : 'fail', figures, `open bills ${openMinor} less on-account ${onAccountMinor} vs 2000 ${ledgerMinor}: difference ${differenceMinor}`);
}

interface ChargedRow {
  asset_id: string;
  number: string;
  depreciation_method: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  useful_life_months: number | null;
  declining_rate_bp: number | null;
  charged: number;
  accumulated_before: number;
  months: number;
}

/**
 * Per asset charged in the period: the charge may not exceed the asset's own resolved rate on the
 * right base, pro rata to the months charged. Declining balance: `declining_rate_bp` on the Buchwert
 * at the first charged month; straight line: `12 / useful_life_months` on the Anschaffungswert (the
 * Merkblatt A 1995 halving rule, applied to a rate that is already the straight-line one). A charge
 * above that is what the H04 override path or a hand-posted line produces, and it warns. The
 * tolerance is one percent plus one Rappen for rounding.
 */
function depreciationWithinLimit(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'depreciation_within_limit';
  const months = monthsBetween(period.periodStart, period.periodEnd);
  const rows = ctx.store.db
    .prepare(
      `SELECT l.asset_id, a.number, a.depreciation_method, a.acquisition_cost_rappen, a.residual_value_rappen,
              a.useful_life_months, a.declining_rate_bp,
              SUM(l.amount_rappen) AS charged, MIN(l.accumulated_before_rappen) AS accumulated_before, COUNT(*) AS months
         FROM asset_depreciation_line l
         JOIN asset_depreciation_run r ON r.id = l.run_id
         JOIN asset a ON a.id = l.asset_id
        WHERE r.workspace_id = ? AND r.status = 'posted' AND r.period >= ? AND r.period <= ?
        GROUP BY l.asset_id ORDER BY a.number ASC`,
    )
    .all(ctx.workspaceId, months[0] ?? period.periodStart.slice(0, 7), months[months.length - 1] ?? period.periodEnd.slice(0, 7)) as ChargedRow[];
  const assets: Array<{ assetNumber: string; method: string; chargedMinor: number; limitMinor: number | null; exceeds: boolean }> = [];
  for (const r of rows) {
    let limit: number | null = null;
    if (r.depreciation_method === 'declining_balance' && r.declining_rate_bp !== null) {
      const nbvStart = r.acquisition_cost_rappen - r.accumulated_before;
      limit = Math.round((nbvStart * r.declining_rate_bp * r.months) / (10_000 * 12));
    } else if (r.depreciation_method === 'straight_line' && r.useful_life_months !== null && r.useful_life_months > 0) {
      limit = Math.round(((r.acquisition_cost_rappen - r.residual_value_rappen) * r.months) / r.useful_life_months);
    }
    const exceeds = limit !== null && r.charged > Math.round(limit * 1.01) + 1;
    assets.push({ assetNumber: r.number, method: r.depreciation_method, chargedMinor: r.charged, limitMinor: limit, exceeds });
  }
  const exceeding = assets.filter((a) => a.exceeds).map((a) => a.assetNumber);
  const figures = { months, assets, exceeding };
  return finish(key, exceeding.length === 0 ? 'pass' : 'fail', figures, `${assets.length} assets charged, ${exceeding.length} above the asset's own rate: ${exceeding.join(', ') || 'none'}`);
}

function balanceEquation(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'balance_equation';
  const bs = computeBalanceSheet(ctx, { asOf: period.periodEnd });
  if (!bs.ok) return unavailable(key, bs.error ?? 'balance_sheet refused');
  const tb = computeTrialBalance(ctx, { periodStart: period.periodStart, periodEnd: period.periodEnd });
  if (!tb.ok) return unavailable(key, tb.error ?? 'trial_balance refused');
  const totals = (tb.totals ?? {}) as { debitMinor?: number; creditMinor?: number };
  const aktivenMinor = Number(bs.aktivenMinor ?? 0);
  const passivenMinor = Number(bs.passivenMinor ?? 0);
  const debitMinor = Number(totals.debitMinor ?? 0);
  const creditMinor = Number(totals.creditMinor ?? 0);
  const figures = { asOf: period.periodEnd, aktivenMinor, passivenMinor, debitMinor, creditMinor };
  const pass = aktivenMinor === passivenMinor && debitMinor === creditMinor;
  return finish(key, pass ? 'pass' : 'fail', figures, `Aktiven ${aktivenMinor} vs Passiven ${passivenMinor}; Soll ${debitMinor} vs Haben ${creditMinor}`);
}

/**
 * Net (debit minus credit) per P&L account over the POSTED, NON-CLOSE entries of a window: the
 * `statementsHashOf` income shape (spec §10.2). A02's trial balance carries no close exclusion, and
 * the seal's own entry (`source = 'close'`, dated the fiscal year end) zeroes every P&L account: read
 * through it, a sealed prior year answers `first_year` and a sealed current year flags every account
 * and moves the acknowledgement hash, so the sealed year's run could never read `done`.
 */
function plNetByAccount(ctx: WorkspaceContext, periodStart: string, periodEnd: string): Map<string, number> {
  const rows = ctx.store.db
    .prepare(
      `SELECT a.number AS number, SUM(l.base_debit_minor) - SUM(l.base_credit_minor) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source <> 'close'
          AND e.date >= ? AND e.date <= ? AND a.type IN ('income', 'expense')
        GROUP BY a.number HAVING net <> 0
        ORDER BY a.number ASC`,
    )
    .all(ctx.workspaceId, periodStart, periodEnd) as { number: string; net: number }[];
  return new Map(rows.map((r) => [r.number, r.net]));
}

function priorYearComparison(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'prior_year_comparison';
  const prior = { periodStart: addMonths(period.periodStart, -12), periodEnd: addMonths(period.periodEnd, -12) };
  const current = plNetByAccount(ctx, period.periodStart, period.periodEnd);
  const previous = plNetByAccount(ctx, prior.periodStart, prior.periodEnd);
  if (previous.size === 0) return unavailable(key, 'first_year', { prior });
  const accounts: Array<{ number: string; currentMinor: number; priorMinor: number; deltaMinor: number; deltaPct: number | null; flagged: boolean }> = [];
  for (const number of [...new Set([...current.keys(), ...previous.keys()])].sort()) {
    const currentMinor = current.get(number) ?? 0;
    const priorMinor = previous.get(number) ?? 0;
    const deltaMinor = currentMinor - priorMinor;
    const deltaPct = priorMinor === 0 ? null : Math.round((Math.abs(deltaMinor) / Math.abs(priorMinor)) * 100);
    const flagged = Math.abs(deltaMinor) > PRIOR_YEAR_MINOR_BAND && (deltaPct === null || deltaPct > PRIOR_YEAR_PCT_BAND);
    accounts.push({ number, currentMinor, priorMinor, deltaMinor, deltaPct, flagged });
  }
  const flagged = accounts.filter((a) => a.flagged).map((a) => a.number);
  const figures = { prior, bands: { pct: PRIOR_YEAR_PCT_BAND, minor: PRIOR_YEAR_MINOR_BAND }, accounts, flagged };
  return finish(key, flagged.length === 0 ? 'pass' : 'fail', figures, `${accounts.length} P&L accounts compared, ${flagged.length} moved beyond both bands: ${flagged.join(', ') || 'none'}`);
}

/**
 * Art. 725a OR: equity (the equity accounts as of the period end plus the fiscal-year result to that
 * date, so a posted close and an open year read the same) against half of Kapital (28xx below 2850,
 * which is the Einzelfirma's Privat) plus the gesetzliche Reserven (2900 to 2959: the gesetzliche
 * Kapitalreserve and the gesetzliche Gewinnreserve; 2960 onwards are freiwillige Reserven and the
 * Gewinnvortrag, which do not count). No capital on the books means nothing to measure against:
 * `unavailable` with `no_capital`, never a pass.
 */
function capitalLoss(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'capital_loss';
  const fys = fiscalYearStartOf(ctx);
  const fy = fiscalYearBounds(fiscalYearOf(period.periodEnd, fys), fys);
  const db = ctx.store.db;
  const creditNet = (typeClause: string, from: string | null): number => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(l.base_credit_minor) - SUM(l.base_debit_minor), 0) AS net
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date <= ? ${from === null ? '' : 'AND e.date >= ?'} AND ${typeClause}`,
      )
      .get(...(from === null ? [ctx.workspaceId, period.periodEnd] : [ctx.workspaceId, period.periodEnd, from])) as { net: number };
    return row.net;
  };
  const equityAccountsMinor = creditNet(`a.type = 'equity'`, null);
  const resultMinor = creditNet(`a.type IN ('income', 'expense')`, fy.periodStart);
  const equityMinor = equityAccountsMinor + resultMinor;
  const kapitalMinor = creditNet(`a.number >= '2800' AND a.number < '2850'`, null);
  const reservenMinor = creditNet(`a.number >= '2900' AND a.number < '2960'`, null);
  const baseMinor = kapitalMinor + reservenMinor;
  const thresholdMinor = Math.round(baseMinor * CAPITAL_LOSS_RATIO);
  const figures = { asOf: period.periodEnd, equityAccountsMinor, resultMinor, equityMinor, kapitalMinor, reservenMinor, baseMinor, thresholdMinor };
  if (baseMinor <= 0) return unavailable(key, 'no_capital', figures);
  return finish(key, equityMinor >= thresholdMinor ? 'pass' : 'fail', figures, `equity ${equityMinor} vs half of Kapital plus gesetzliche Reserven ${thresholdMinor}`);
}

// --- The A38 and A20 validations (N4) -----------------------------------------------------------

/** Net debit minus credit of one account NUMBER over posted entries dated up to and including `asOf`. */
function accountNetAsOf(ctx: WorkspaceContext, number: string, asOf: string): number | null {
  const acc = ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number) as { id: string } | undefined;
  if (acc === undefined) return null;
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor) - SUM(l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date <= ?`,
    )
    .get(ctx.workspaceId, acc.id, asOf) as { net: number };
  return row.net;
}

function ledgerNetOfAccountId(ctx: WorkspaceContext, accountId: string, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor) - SUM(l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date <= ?`,
    )
    .get(ctx.workspaceId, accountId, asOf) as { net: number };
  return row.net;
}

/** The item id of the sign-off row that carries a typed bank balance (spec §10.5 item 6a). */
export const BANK_BALANCE_TYPED_ITEM_ID = 'bank_balance_typed';

/**
 * The balance a human typed on the `bank_balance_typed` row of a run over this period: its live
 * sign-off's `evidence_ref`, a decimal amount in the base currency ("12345.60") or an integer of
 * minor units when it carries no point. Null when no run, no sign-off or an unparsable ref.
 */
function typedBankBalanceOf(ctx: WorkspaceContext, period: ChecklistPeriod): { minor: number; actor: string; at: string } | null {
  const row = ctx.store.db
    .prepare(
      `SELECT s.evidence_ref, s.actor, s.created_at FROM checklist_signoff s
         JOIN checklist_run_item i ON i.id = s.run_item_id
         JOIN checklist_run r ON r.id = s.run_id
        WHERE s.workspace_id = ? AND s.voided_at IS NULL AND i.item_id = ? AND i.status = 'done'
          AND r.period_start = ? AND r.period_end = ? AND r.status <> 'abandoned'
        ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, BANK_BALANCE_TYPED_ITEM_ID, period.periodStart, period.periodEnd) as { evidence_ref: string; actor: string; at?: string; created_at: string } | undefined;
  if (row === undefined) return null;
  const text = row.evidence_ref.replace(/['’\s]/g, '').replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (m === null) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = m[3] === undefined ? null : Number(m[3].padEnd(2, '0'));
  const minor = frac === null ? whole : whole * 100 + frac;
  return { minor: sign * minor, actor: row.actor, at: row.created_at };
}

interface StatementRow {
  id: string;
  bank_account_id: string;
  from_date: string | null;
  to_date: string | null;
  closing_balance_minor: number | null;
  balance_currency: string | null;
}

/**
 * Q7: the A20 statement covering the period end, per base-currency bank account (last page, a closing
 * balance on it, `from_date <= periodEnd <= to_date`), against the ledger balance of the account's
 * A19 ledger account at the period end. With no covering statement on any account, the typed figure
 * on the sibling sign-off row against 1020. The row states which source it read.
 */
function bankBalanceMatches(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'bank_balance_matches';
  const base = baseCurrencyOf(ctx);
  const accounts = ctx.store.db
    .prepare('SELECT id, name, iban, currency, ledger_account_id FROM bank_account WHERE workspace_id = ? AND currency = ? ORDER BY name ASC')
    .all(ctx.workspaceId, base) as { id: string; name: string; iban: string; currency: string; ledger_account_id: string }[];
  const compared: Array<{ bankAccount: string; ledgerAccount: string; statementId: string; statementTo: string | null; statementMinor: number; ledgerMinor: number; differenceMinor: number }> = [];
  for (const account of accounts) {
    const stmt = ctx.store.db
      .prepare(
        `SELECT id, bank_account_id, from_date, to_date, closing_balance_minor, balance_currency FROM bank_statement
          WHERE workspace_id = ? AND bank_account_id = ? AND last_page_ind = 1 AND closing_balance_minor IS NOT NULL
            AND (balance_currency IS NULL OR balance_currency = ?)
            AND from_date IS NOT NULL AND to_date IS NOT NULL AND from_date <= ? AND to_date >= ?
          ORDER BY to_date ASC, imported_at DESC LIMIT 1`,
      )
      .get(ctx.workspaceId, account.id, base, period.periodEnd, period.periodEnd) as StatementRow | undefined;
    if (stmt === undefined || stmt.closing_balance_minor === null) continue;
    const ledgerAccount = ctx.store.db.prepare('SELECT number FROM account WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, account.ledger_account_id) as { number: string } | undefined;
    const ledgerMinor = ledgerNetOfAccountId(ctx, account.ledger_account_id, period.periodEnd);
    compared.push({
      bankAccount: account.name,
      ledgerAccount: ledgerAccount?.number ?? account.ledger_account_id,
      statementId: stmt.id,
      statementTo: stmt.to_date,
      statementMinor: stmt.closing_balance_minor,
      ledgerMinor,
      differenceMinor: stmt.closing_balance_minor - ledgerMinor,
    });
  }
  if (compared.length > 0) {
    const mismatched = compared.filter((c) => c.differenceMinor !== 0).map((c) => c.bankAccount);
    const figures = { asOf: period.periodEnd, source: 'statement', accounts: compared, mismatched };
    return finish(key, mismatched.length === 0 ? 'pass' : 'fail', figures, `${compared.length} statement(s) covering ${period.periodEnd}; mismatched: ${mismatched.join(', ') || 'none'}`);
  }
  const typed = typedBankBalanceOf(ctx, period);
  const ledgerMinor = accountNetAsOf(ctx, '1020', period.periodEnd);
  if (typed === null) {
    return unavailable(key, 'no_statement_no_typed_balance', { asOf: period.periodEnd, source: 'none', ledger1020Minor: ledgerMinor, typedItemId: BANK_BALANCE_TYPED_ITEM_ID });
  }
  if (ledgerMinor === null) return unavailable(key, 'no_account_1020', { asOf: period.periodEnd, source: 'typed', typedMinor: typed.minor });
  const differenceMinor = typed.minor - ledgerMinor;
  const figures = { asOf: period.periodEnd, source: 'typed', typedMinor: typed.minor, typedBy: typed.actor, typedAt: typed.at, ledger1020Minor: ledgerMinor, differenceMinor };
  return finish(key, differenceMinor === 0 ? 'pass' : 'fail', figures, `typed ${typed.minor} vs 1020 ${ledgerMinor}: difference ${differenceMinor}`);
}

/** 1300 = 2300 = 0 on the first day after the period end (an A38 pair passes by construction). */
function accrualsReversed(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'accruals_reversed';
  const dayAfter = addDays(period.periodEnd, 1);
  const active = accountNetAsOf(ctx, '1300', dayAfter) ?? 0;
  const passive = accountNetAsOf(ctx, '2300', dayAfter) ?? 0;
  const figures = { asOf: dayAfter, account1300Minor: active, account2300Minor: passive };
  return finish(key, active === 0 && passive === 0 ? 'pass' : 'fail', figures, `1300 ${active}, 2300 ${passive} on ${dayAfter}`);
}

/**
 * The three tax accounts read zero at the period end; 2201 and the last settlement's net are reported
 * beside them (reconciled 2026-09-10: a last period already paid reads zero on 2201, so it is a figure
 * for the reader, not a condition).
 */
function vatAccountsZero(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'vat_accounts_zero';
  const asOf = period.periodEnd;
  const a1170 = accountNetAsOf(ctx, '1170', asOf) ?? 0;
  const a1171 = accountNetAsOf(ctx, '1171', asOf) ?? 0;
  const a2200 = accountNetAsOf(ctx, '2200', asOf) ?? 0;
  const a2201 = accountNetAsOf(ctx, '2201', asOf);
  const last = ctx.store.db
    .prepare(`SELECT period_label, net_minor FROM vat_settlement WHERE workspace_id = ? AND status = 'posted' AND period_end <= ? ORDER BY period_start DESC LIMIT 1`)
    .get(ctx.workspaceId, asOf) as { period_label: string; net_minor: number } | undefined;
  const nonZero = [
    ...(a1170 !== 0 ? ['1170'] : []),
    ...(a1171 !== 0 ? ['1171'] : []),
    ...(a2200 !== 0 ? ['2200'] : []),
  ];
  const figures = { asOf, account1170Minor: a1170, account1171Minor: a1171, account2200Minor: a2200, account2201Minor: a2201, lastSettlement: last === undefined ? null : { period: last.period_label, netMinor: last.net_minor }, nonZero };
  return finish(key, nonZero.length === 0 ? 'pass' : 'fail', figures, `1170 ${a1170}, 1171 ${a1171}, 2200 ${a2200} at ${asOf}; non-zero: ${nonZero.join(', ') || 'none'}`);
}

/** The calendar year the period ends in: the MWST Steuerperiode (MWSTG Art. 34 Abs. 2). */
function taxYearOf(period: ChecklistPeriod): string {
  return period.periodEnd.slice(0, 4);
}

function reconciliationOf(ctx: WorkspaceContext, period: ChecklistPeriod): { ok: true; res: Record<string, unknown> } | { ok: false; reason: string; figures: Record<string, unknown> } {
  const year = taxYearOf(period);
  const res = vatAnnualReconciliation(ctx, { year });
  if (!res.ok) return { ok: false, reason: res.error ?? 'vat_annual_reconciliation refused', figures: { year } };
  if (res.applicable === false) return { ok: false, reason: 'needs_vat_config', figures: { year, method: res.method ?? null } };
  const unfiled = Array.isArray(res.unfiledPeriods) ? (res.unfiledPeriods as string[]) : [];
  const refused = Array.isArray(res.refusedPeriods) ? (res.refusedPeriods as string[]) : [];
  if (unfiled.length > 0) return { ok: false, reason: 'unfiled_periods', figures: { year, unfiledPeriods: unfiled } };
  if (refused.length > 0) return { ok: false, reason: 'periods_not_computable', figures: { year, refusedPeriods: refused } };
  return { ok: true, res: res as Record<string, unknown> };
}

/** Σ Ziffer 399 = the net credit booked on 2200; Σ Ziffer 400 + 405 = the net debit booked on 1170 + 1171, over the calendar year. */
function vatDeclaredEqualsBooks(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'vat_declared_equals_books';
  const rec = reconciliationOf(ctx, period);
  if (!rec.ok) return unavailable(key, rec.reason, rec.figures);
  const year = taxYearOf(period);
  const periods = rec.res.periods as { ziffer399Minor: number; ziffer400405Minor: number }[];
  const declaredOutputMinor = periods.reduce((sum, p) => sum + p.ziffer399Minor, 0);
  const vorsteuer = rec.res.vorsteuer as { applicable: boolean; bookedInputMinor: number; declaredZiffer400405Minor: number; differenceMinor: number };
  // The output side: what the books credited to 2200 over the year, the settlement transfers excluded
  // (they move the balance to 2201 and are not tax).
  const booked = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor) - SUM(l.base_debit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number = '2200' AND e.source <> 'vat_settlement'
          AND e.date >= ? AND e.date <= ?`,
    )
    .get(ctx.workspaceId, `${year}-01-01`, `${year}-12-31`) as { net: number };
  const outputDifferenceMinor = booked.net - declaredOutputMinor;
  const inputDifferenceMinor = vorsteuer.applicable ? vorsteuer.differenceMinor : 0;
  const figures = {
    year,
    output: { bookedMinor: booked.net, declaredZiffer399Minor: declaredOutputMinor, differenceMinor: outputDifferenceMinor },
    input: { applicable: vorsteuer.applicable, bookedMinor: vorsteuer.bookedInputMinor, declaredZiffer400405Minor: vorsteuer.declaredZiffer400405Minor, differenceMinor: inputDifferenceMinor },
  };
  const pass = outputDifferenceMinor === 0 && inputDifferenceMinor === 0;
  return finish(key, pass ? 'pass' : 'fail', figures, `2200 booked ${booked.net} vs declared ${declaredOutputMinor}; Vorsteuer booked ${vorsteuer.bookedInputMinor} vs declared ${vorsteuer.declaredZiffer400405Minor}`);
}

/** Art. 128 Abs. 2 MWSTV: the adjusted revenue per the statements equals Σ Ziffer 200 of the year's returns. */
function umsatzabstimmung(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'umsatzabstimmung';
  const rec = reconciliationOf(ctx, period);
  if (!rec.ok) return unavailable(key, rec.reason, rec.figures);
  const umsatz = rec.res.umsatz as { revenuePerStatementsMinor: number; adjustments: unknown[]; adjustedRevenueMinor: number; declaredZiffer200Minor: number; differenceMinor: number };
  const figures = { year: taxYearOf(period), ...umsatz };
  return finish(key, umsatz.differenceMinor === 0 ? 'pass' : 'fail', figures, `adjusted revenue ${umsatz.adjustedRevenueMinor} vs Σ Ziffer 200 ${umsatz.declaredZiffer200Minor}: difference ${umsatz.differenceMinor}`);
}

/** D129 Q5-style band for the tax provision: five percent either way of the helper's figure. */
export const TAX_PROVISION_BAND_PCT = 5;

/**
 * The posted `steuern` provision against the ZStB 27/1 helper. The helper's `instalmentsMinor` is the
 * year's net debit on 8900, which includes the posted provision's own expense line, so the figure to
 * compare with is `gross - (instalments - posted)`: the gross provision net of the OTHER instalments.
 */
function taxProvisionPlausible(ctx: WorkspaceContext, period: ChecklistPeriod): ValidationResult {
  const key = 'tax_provision_plausible';
  const posted = ctx.store.db
    .prepare("SELECT id, amount_minor FROM provision WHERE workspace_id = ? AND period_end = ? AND reason = 'steuern' AND status IN ('posted', 'released') ORDER BY created_at ASC")
    .all(ctx.workspaceId, period.periodEnd) as { id: string; amount_minor: number }[];
  if (posted.length === 0) return unavailable(key, 'no_tax_provision', { periodEnd: period.periodEnd });
  const postedMinor = posted.reduce((s, p) => s + p.amount_minor, 0);
  const preview = taxProvisionPreview(ctx, { periodEnd: period.periodEnd });
  if (!preview.ok) return unavailable(key, preview.error ?? 'tax_provision_preview refused', { periodEnd: period.periodEnd, postedMinor });
  if (preview.applicable === false) return unavailable(key, String(preview.reason ?? 'not_applicable'), { periodEnd: period.periodEnd, postedMinor });
  const grossMinor = Number(preview.grossProvisionMinor ?? 0);
  const instalmentsMinor = Number(preview.instalmentsMinor ?? 0);
  const expectedMinor = Math.max(0, grossMinor - (instalmentsMinor - postedMinor));
  const toleranceMinor = Math.round((expectedMinor * TAX_PROVISION_BAND_PCT) / 100);
  const differenceMinor = postedMinor - expectedMinor;
  const figures = { periodEnd: period.periodEnd, provisionIds: posted.map((p) => p.id), postedMinor, expectedMinor, grossMinor, otherInstalmentsMinor: instalmentsMinor - postedMinor, rateBp: preview.rateBp ?? null, toleranceMinor, differenceMinor, bandPct: TAX_PROVISION_BAND_PCT };
  return finish(key, Math.abs(differenceMinor) <= toleranceMinor ? 'pass' : 'fail', figures, `posted ${postedMinor} vs expected ${expectedMinor} (±${toleranceMinor}): difference ${differenceMinor}`);
}

/** Evaluate one validation. Never throws: an exception is an `unavailable` result carrying its message. */
export function evaluateValidation(ctx: WorkspaceContext, key: ChecklistValidationKey, period: ChecklistPeriod): ValidationResult {
  try {
    switch (key) {
      case 'locks_on_all_months':
        return locksOnAllMonths(ctx, period);
      case 'open_items_debtors':
        return openItemsDebtors(ctx, period);
      case 'open_items_creditors':
        return openItemsCreditors(ctx, period);
      case 'depreciation_within_limit':
        return depreciationWithinLimit(ctx, period);
      case 'balance_equation':
        return balanceEquation(ctx, period);
      case 'prior_year_comparison':
        return priorYearComparison(ctx, period);
      case 'capital_loss':
        return capitalLoss(ctx, period);
      case 'bank_balance_matches':
        return bankBalanceMatches(ctx, period);
      case 'accruals_reversed':
        return accrualsReversed(ctx, period);
      case 'vat_accounts_zero':
        return vatAccountsZero(ctx, period);
      case 'vat_declared_equals_books':
        return vatDeclaredEqualsBooks(ctx, period);
      case 'umsatzabstimmung':
        return umsatzabstimmung(ctx, period);
      case 'tax_provision_plausible':
        return taxProvisionPlausible(ctx, period);
    }
  } catch (e) {
    return unavailable(key, e instanceof Error ? e.message : String(e));
  }
}
