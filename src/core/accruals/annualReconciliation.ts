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
 *   + asset sales not invoiced  D192 point 12: the `proceeds_rappen` of the year's standing disposals
 *                               that resolve to no invoice NOW (unlinked, or linked to a payment that
 *                               does not lie wholly on one invoice): a sale of a Betriebsmittel the
 *                               books hold and no invoice declared, the ESTV's Sonderposten
 *   = adjustedRevenueMinor      compared against Σ Ziffer 200 of the year's returns
 *
 * D192 (critic r1 F2, a defect on develop before it): `source='asset_disposal'` entries and every mirror
 * in their chain are EXCLUDED from the first line, the way the MWST settlement is. A disposal books no
 * turnover: its clearing line takes out an invoice's credit the invoice already declared, and its gain
 * or loss is a Veräusserungserfolg. The earlier adjustment added the disposal's credits on income
 * accounts outside class 3, which could only ever be the GAIN, so a VAT-correct invoiced sale warned a
 * false difference of its gain and an undeclared one warned only its gain.
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
                   (SELECT id FROM journal_entry WHERE workspace_id = ? AND source = ?))
          AND e.id NOT IN (${DISPOSAL_CHAIN_SQL})`,
    )
    .get(ctx.workspaceId, start, end, VAT_SETTLEMENT_SOURCE, ctx.workspaceId, VAT_SETTLEMENT_SOURCE, ctx.workspaceId, ctx.workspaceId) as SumRow;
  return row.net;
}

/**
 * D192 point 12: every `asset_disposal` entry and every mirror in its chain (the reverse, a raw Storno,
 * the mirror of a mirror), workspace-scoped on both hops. Two parameters: the workspace id twice.
 */
const DISPOSAL_CHAIN_SQL = `WITH RECURSIVE disposal_chain(id) AS (
    SELECT id FROM journal_entry WHERE workspace_id = ? AND source = 'asset_disposal'
    UNION
    SELECT m.id FROM journal_entry m JOIN disposal_chain c ON m.reverses_entry_id = c.id WHERE m.workspace_id = ?
  ) SELECT id FROM disposal_chain`;

/** Does the payment lie WHOLLY on one invoice now (D191 point 1's rule, read here for D192 G3)? */
function paymentWhollyOnOneInvoice(ctx: WorkspaceContext, paymentId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT p.amount_minor AS amount, COUNT(a.id) AS n, COUNT(DISTINCT a.target_id) AS targets,
              COALESCE(SUM(a.payment_amount_minor), 0) AS used,
              COALESCE(SUM(CASE WHEN a.target_kind = 'document' AND d.type = 'invoice' THEN 0 ELSE 1 END), 0) AS other
         FROM payment p
         LEFT JOIN payment_allocation a ON a.payment_id = p.id AND a.workspace_id = p.workspace_id
         LEFT JOIN document d ON d.id = a.target_id AND d.workspace_id = a.workspace_id
        WHERE p.workspace_id = ? AND p.id = ?`,
    )
    .get(ctx.workspaceId, paymentId) as { amount: number | null; n: number; targets: number; used: number; other: number } | undefined;
  return row !== undefined && row.amount !== null && row.n > 0 && row.targets === 1 && row.other === 0 && row.used >= row.amount;
}

/**
 * D192 point 12 (and critic G3): the year's standing disposals with proceeds that resolve to no invoice
 * NOW. Unlinked rows, and payment-linked rows whose payment does not lie wholly on one invoice at this
 * reading (a Guthaben applied to an invoice later is declared by that invoice). §H-TENANT on every join.
 */
function uninvoicedDisposals(ctx: WorkspaceContext, start: string, end: string): AdjustmentRow[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT d.proceeds_rappen AS proceeds, d.source_document_type AS doc_type, d.source_document_id AS doc_id, ac.number AS number
         FROM asset_transaction d
         JOIN asset s ON s.id = d.asset_id AND s.workspace_id = d.workspace_id
         JOIN account ac ON ac.id = s.gl_asset_account_id AND ac.workspace_id = d.workspace_id
        WHERE d.workspace_id = ? AND d.type = 'disposal' AND d.date >= ? AND d.date <= ?
          AND COALESCE(d.proceeds_rappen, 0) > 0
          AND (d.source_document_type IS NULL OR d.source_document_type <> 'invoice')
          AND NOT EXISTS (SELECT 1 FROM asset_transaction r WHERE r.workspace_id = d.workspace_id
                           AND r.source_document_type = 'asset_transaction' AND r.source_document_id = d.id)
        ORDER BY d.date, d.rowid`,
    )
    .all(ctx.workspaceId, start, end) as { proceeds: number; doc_type: string | null; doc_id: string | null; number: string }[];
  return rows
    .filter((r) => !(r.doc_type === 'payment' && r.doc_id !== null && paymentWhollyOnOneInvoice(ctx, r.doc_id)))
    .map((r) => ({ number: r.number, net: r.proceeds }));
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
  for (const row of uninvoicedDisposals(ctx, start, end)) {
    // D192 point 12: a sale of a Betriebsmittel no invoice declared. Added, so the difference names it.
    // `accountNumber` is the asset's cost account (the sale has no turnover account of its own).
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
