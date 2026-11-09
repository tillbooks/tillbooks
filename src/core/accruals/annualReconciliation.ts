/**
 * A38 (D129 leg 2), the two annual MWST reconciliations as FIGURES: the Umsatzabstimmung and the
 * Vorsteuerabstimmung of the calendar year (the MWST Steuerperiode, MWSTG Art. 34 Abs. 2), each with
 * a difference and a status, so the `umsatzabstimmung` and `vorsteuerabstimmung` validations of the
 * `year_close` checklist (G22 §10.4) are a reading of the books and not a spreadsheet.
 *
 * Statutory anchor, fetched 2026-09-09 from estv.admin.ch ("Welche Unterlagen für die MWST-Kontrolle
 * sind bereitzustellen?"), which states the requirement in the ESTV's own operational words:
 *
 *   "Umsatzabstimmung pro Jahr, ausgehend von den Salden der massgebenden Ertrags-Konten unter
 *    Berücksichtigung von Abgrenzungsposten und allfälligen Sonderposten gegenüber der Ziffer 200 der
 *    Abrechnungsformulare (Art. 128 Abs. 2 MWSTV)"
 *
 *   "Vorsteuerabstimmung pro Jahr, verbuchte Vorsteuer gemäss Vorsteuerkonten der Finanzbuchhaltung
 *    gegenüber der Deklaration in den Abrechnungsformularen"
 *
 * (the primary text of Art. 128 MWSTV, SR 641.201, sits behind fedlex's JavaScript gate and could not
 * be fetched verbatim; the ESTV page cites Abs. 2 for the Umsatzabstimmung and the Vorsteuerabstimmung
 * is Abs. 3 of the same article). A difference the books cannot explain is what MWSTG Art. 72 Abs. 1
 * is about: "Stellt die steuerpflichtige Person im Rahmen der Erstellung ihres Jahresabschlusses Mängel
 * in ihren Steuerabrechnungen fest, so muss sie diese spätestens in der Abrechnung über jene
 * Abrechnungsperiode korrigieren, in die der 180. Tag seit Ende des betreffenden Geschäftsjahres fällt."
 * (wording confirmed 2026-09-09 against weka.ch and steuerinformationen.ch, both quoting the article;
 * the deadline arithmetic lives in G22, this verb only supplies the figures).
 *
 * ## The Umsatzabstimmung, as the ledger can name it
 *
 *   revenuePerStatementsMinor   the net credit on the class-3 income accounts over the year, posted
 *                               entries only, the year-close entry and the MWST settlement excluded
 *   - accruals                  `source='accrual'` lines and their reversals on those accounts (A38's
 *                               own transitorische Posten: revenue recognised, not yet invoiced, or
 *                               invoiced ahead), the "Abgrenzungsposten" the ESTV names
 *   + asset disposal proceeds   `source='asset_disposal'` credits on income accounts OUTSIDE class 3
 *                               (H06 books proceeds as a supply the return declares; when H06 booked
 *                               them into class 3 they are already in the first line)
 *   = adjustedRevenueMinor      compared against Σ Ziffer 200 of the year's returns
 *
 * The `vat_settlement` adjustment row is reported with the amount it EXCLUDES (the Saldosteuersatz
 * difference on 3809 is a tax effect, not turnover) so a reader can see what was left out and why.
 * Bestandesänderungen and Privatanteile have no engine object yet (leg 3); the ESTV's "allfällige
 * Sonderposten" are the human's to explain, which is why the checklist row is a WARN with an
 * acknowledgement and never a block.
 *
 * ## The Vorsteuerabstimmung
 *
 * The net debit booked on 1170 + 1171 over the year (settlements excluded, so a settled quarter still
 * counts what it declared) against Σ (Ziffer 400 + 405) of the year's returns. Under Saldo there is no
 * Vorsteuer to reconcile (MWSTG Art. 37: the flat rate imputes it), reported as `applicable: false`.
 *
 * `status` per reconciliation: `match` (difference 0), `warn` (a difference the ledger cannot explain),
 * `unavailable` (a period of the year is not filed yet, or its return refused; the periods are named).
 * A workspace with no MWST method answers `applicable: false`. A pure read (Pattern P5).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { computeVatReturn, listVatPeriods, OUTPUT_VAT_ACCOUNT, INPUT_VAT_ACCOUNTS } from '../vat/abrechnung.js';
import { VAT_SETTLEMENT_SOURCE } from '../ledger/postEntry.js';

export type ReconciliationStatus = 'match' | 'warn' | 'unavailable';

export interface ReconciliationAdjustment {
  readonly kind: 'accrual' | 'asset_disposal' | 'vat_settlement';
  readonly accountNumber: string;
  /** Signed: the amount ADDED to the statements' revenue to reach the figure the return declares. */
  readonly amountMinor: number;
}

export interface VatAnnualReconciliationInput {
  year: string;
}

interface PeriodFigures {
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly filed: boolean;
  readonly computed: boolean;
  readonly error: string | null;
  readonly ziffer200Minor: number;
  readonly ziffer399Minor: number;
  readonly ziffer400405Minor: number;
  readonly payableMinor: number;
  readonly creditMinor: number;
}

interface SumRow {
  net: number;
}

interface AdjustmentRow {
  number: string;
  net: number;
}

const YEAR_RE = /^\d{4}$/;

/** Net CREDIT (credit minus debit) on the class-3 income accounts over the year, the exclusions applied. */
function revenueOf(ctx: WorkspaceContext, start: string, end: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
          AND a.type = 'income' AND a.number LIKE '3%'
          AND e.source NOT IN ('close', ?)
          AND NOT (e.source = 'reversal' AND e.reverses_entry_id IN
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND source = ?))`,
    )
    .get(ctx.workspaceId, start, end, VAT_SETTLEMENT_SOURCE, ctx.workspaceId, VAT_SETTLEMENT_SOURCE) as SumRow;
  return row.net;
}

/**
 * Net credit per income account over the year for one journal source AND the reversals of that
 * source's entries, so a reverted accrual contributes zero rather than its half.
 */
function sourceOnIncomeAccounts(
  ctx: WorkspaceContext,
  start: string,
  end: string,
  source: string,
  classThreeOnly: boolean | null,
): AdjustmentRow[] {
  const classClause = classThreeOnly === null ? '' : classThreeOnly ? "AND a.number LIKE '3%'" : "AND a.number NOT LIKE '3%'";
  return ctx.store.db
    .prepare(
      `SELECT a.number AS number, COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
          AND a.type = 'income' ${classClause}
          AND (e.source = ? OR (e.source = 'reversal' AND e.reverses_entry_id IN
               (SELECT id FROM journal_entry WHERE workspace_id = ? AND source = ?)))
        GROUP BY a.number
       HAVING net <> 0
        ORDER BY a.number`,
    )
    .all(ctx.workspaceId, start, end, source, ctx.workspaceId, source) as AdjustmentRow[];
}

/** Net DEBIT on the two Vorsteuer accounts over the year, settlements and their reversals excluded. */
function bookedInputOf(ctx: WorkspaceContext, start: string, end: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
          AND a.number IN (?, ?)
          AND e.source <> ?
          AND NOT (e.source = 'reversal' AND e.reverses_entry_id IN
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND source = ?))`,
    )
    .get(
      ctx.workspaceId,
      start,
      end,
      INPUT_VAT_ACCOUNTS[0],
      INPUT_VAT_ACCOUNTS[1],
      VAT_SETTLEMENT_SOURCE,
      ctx.workspaceId,
      VAT_SETTLEMENT_SOURCE,
    ) as SumRow;
  return row.net;
}

function statusOf(differenceMinor: number, unavailable: boolean): ReconciliationStatus {
  if (unavailable) return 'unavailable';
  return differenceMinor === 0 ? 'match' : 'warn';
}

export function vatAnnualReconciliation(ctx: WorkspaceContext, input: VatAnnualReconciliationInput): Result {
  const year = input?.year;
  if (typeof year !== 'string' || !YEAR_RE.test(year)) return err('invalid_input', { field: 'year', expected: 'YYYY' });
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const listed = listVatPeriods(ctx, { year });
  if (!listed.ok) {
    if (listed.error === 'needs_vat_config') {
      // Story 6.2: no MWST method, nothing to reconcile against. An answer, not a refusal, because the
      // checklist derives "excluded" from it rather than rendering an error.
      return ok({ year, applicable: false, method: (listed.method as string | undefined) ?? 'none' });
    }
    return listed;
  }
  const method = listed.method as string;
  const saldo = method === 'saldo';

  const periods: PeriodFigures[] = (
    listed.periods as { label: string; periodStart: string; periodEnd: string; filed: boolean }[]
  ).map((p) => {
    const ret = computeVatReturn(ctx, { periodStart: p.periodStart, periodEnd: p.periodEnd });
    if (!ret.ok) {
      return {
        label: p.label,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        filed: p.filed,
        computed: false,
        error: ret.error,
        ziffer200Minor: 0,
        ziffer399Minor: 0,
        ziffer400405Minor: 0,
        payableMinor: 0,
        creditMinor: 0,
      };
    }
    const lines = ret.lines as { code: string; baseMinor: number }[];
    const z200 = lines.find((l) => l.code === '200');
    return {
      label: p.label,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      filed: p.filed,
      computed: true,
      error: null,
      ziffer200Minor: z200 === undefined ? 0 : z200.baseMinor,
      ziffer399Minor: ret.totalTaxDueMinor as number,
      ziffer400405Minor: ret.totalInputTaxMinor as number,
      payableMinor: ret.payableMinor as number,
      creditMinor: ret.creditMinor as number,
    };
  });

  const unfiled = periods.filter((p) => !p.filed).map((p) => p.label);
  const refused = periods.filter((p) => !p.computed).map((p) => p.label);
  const unavailable = unfiled.length > 0 || refused.length > 0;

  // --- Umsatzabstimmung (Art. 128 Abs. 2 MWSTV) ---------------------------------------------------
  const revenuePerStatementsMinor = revenueOf(ctx, start, end);
  const adjustments: ReconciliationAdjustment[] = [];
  let adjustedRevenueMinor = revenuePerStatementsMinor;
  for (const row of sourceOnIncomeAccounts(ctx, start, end, 'accrual', true)) {
    // A recognised-not-invoiced credit sits in the statements and not in Ziffer 200: subtract it.
    adjustments.push({ kind: 'accrual', accountNumber: row.number, amountMinor: -row.net });
    adjustedRevenueMinor -= row.net;
  }
  for (const row of sourceOnIncomeAccounts(ctx, start, end, 'asset_disposal', false)) {
    // Proceeds booked outside class 3 are a declared supply the first line did not count: add them.
    adjustments.push({ kind: 'asset_disposal', accountNumber: row.number, amountMinor: row.net });
    adjustedRevenueMinor += row.net;
  }
  for (const row of sourceOnIncomeAccounts(ctx, start, end, VAT_SETTLEMENT_SOURCE, null)) {
    // Already excluded from the first line (the Saldo tax effect on 3809 is not turnover). Reported
    // with amount 0 so the reader sees what was left out rather than wondering where it went.
    adjustments.push({ kind: 'vat_settlement', accountNumber: row.number, amountMinor: 0 });
  }
  const declaredZiffer200Minor = periods.reduce((sum, p) => sum + p.ziffer200Minor, 0);
  const umsatzDifference = adjustedRevenueMinor - declaredZiffer200Minor;

  // --- Vorsteuerabstimmung (Art. 128 Abs. 3 MWSTV) ------------------------------------------------
  const bookedInputMinor = bookedInputOf(ctx, start, end);
  const declaredZiffer400405Minor = periods.reduce((sum, p) => sum + p.ziffer400405Minor, 0);
  const vorsteuerDifference = saldo ? 0 : bookedInputMinor - declaredZiffer400405Minor;

  return ok({
    year,
    applicable: true,
    method,
    periodStart: start,
    periodEnd: end,
    outputVatAccount: OUTPUT_VAT_ACCOUNT,
    inputVatAccounts: [...INPUT_VAT_ACCOUNTS],
    unfiledPeriods: unfiled,
    refusedPeriods: refused,
    umsatz: {
      revenuePerStatementsMinor,
      adjustments,
      adjustedRevenueMinor,
      declaredZiffer200Minor,
      differenceMinor: umsatzDifference,
      status: statusOf(umsatzDifference, unavailable),
    },
    vorsteuer: {
      applicable: !saldo,
      bookedInputMinor,
      declaredZiffer400405Minor,
      differenceMinor: vorsteuerDifference,
      status: saldo ? 'match' : statusOf(vorsteuerDifference, unavailable),
    },
    periods,
  });
}
