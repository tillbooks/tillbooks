/**
 * G11, `vat_balance_at_cutover` (US-G11.3): the VAT position on the books at the Übernahmestichtag
 * proved against the position the last filed return left outstanding, DECLARED by the operator from
 * the old system's own Abrechnung (MWSTG via A07). TILL never re-files or under-declares what the
 * other system already handled; this control is what makes G09's period freeze safe to run.
 *
 * The computed figure is the net payable position: the credit balance on 2200 (Umsatzsteuer) minus
 * the debit balances on 1170/1171 (Vorsteuer), integer Rappen read off posted rows (P2: nothing is
 * converted or re-rounded). The account numbers are A07's own single-source constants restated; the
 * MWSTG fixture in the G11 suite holds them together.
 *
 * THE STRADDLED PERIOD (US-G11.3 boundary): if the Stichtag falls INSIDE a reporting period (it is
 * neither a period's first nor its last day, per A07's method-derived periods), the position is
 * genuinely split across two systems and NO single figure is right, so the control reports
 * `not_computable` naming both date ranges. It does not block on its own; cutting over mid-period is
 * legal, and G09's readiness is where the recommendation to prefer a boundary lives.
 */

import type { WorkspaceContext } from '../../context.js';
import { listVatPeriods, OUTPUT_VAT_ACCOUNT, INPUT_VAT_ACCOUNTS } from '../../vat/index.js';
import type { ControlModule } from './registry.js';

/** The posted net balance of an account NUMBER as of a date, signed as `sign` directs. */
function balanceAsOf(ctx: WorkspaceContext, number: string, asOf: string, sign: 'credit' | 'debit'): number {
  const expr = sign === 'credit' ? 'l.base_credit_minor - l.base_debit_minor' : 'l.base_debit_minor - l.base_credit_minor';
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(${expr}), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(ctx.workspaceId, number, asOf) as { net: number };
  return row.net;
}

/** The period containing the Stichtag, or undefined when A05's config cannot say. */
function periodAround(
  ctx: WorkspaceContext,
  cutover: string,
): { start: string; end: string; label: string } | 'no_config' | undefined {
  const year = cutover.slice(0, 4);
  const listed = listVatPeriods(ctx, { year });
  if (!listed.ok) return 'no_config';
  const periods = listed.periods as Array<{ label: string; periodStart: string; periodEnd: string }>;
  const hit = periods.find((p) => p.periodStart <= cutover && cutover <= p.periodEnd);
  return hit === undefined ? undefined : { start: hit.periodStart, end: hit.periodEnd, label: hit.label };
}

export const vatBalanceAtCutover: ControlModule = {
  kind: 'vat_balance_at_cutover',
  declarable: true,
  appliesTo: (step) => step.data_class === 'opening_balances',
  compute(ctx, plan, _step, env) {
    if (env.against !== 'live') {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'testmandant (G12)' }];
    }
    if (plan.cutover_date === null) {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'cutover_date' }];
    }
    const cutover = plan.cutover_date;
    const output = balanceAsOf(ctx, OUTPUT_VAT_ACCOUNT, cutover, 'credit');
    const input = INPUT_VAT_ACCOUNTS.reduce((n, acc) => n + balanceAsOf(ctx, acc, cutover, 'debit'), 0);
    const position = output - input;

    // An empty position ties out trivially whatever the period looks like (the A16 0 == 0 posture).
    if (position === 0) {
      return [{ scope: 'workspace', computedMinor: 0, inputsPresent: true, detail: 'MWST-Position 0 am Stichtag' }];
    }

    const period = periodAround(ctx, cutover);
    if (period === 'no_config') {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'vat_config (A05)' }];
    }
    if (period !== undefined && cutover !== period.start && cutover !== period.end) {
      // The straddle: named with BOTH date ranges, because no single figure is right (US-G11.3).
      return [
        {
          scope: 'workspace',
          computedMinor: null,
          inputsPresent: false,
          missingInput: 'period_boundary',
          detail: `Stichtag ${cutover} liegt in der Abrechnungsperiode ${period.label} (${period.start} bis ${period.end}): die Position ist auf zwei Systeme verteilt`,
        },
      ];
    }
    return [
      {
        scope: 'workspace',
        computedMinor: position,
        inputsPresent: true,
        detail: `2200 (${output}) minus Vorsteuer 1170/1171 (${input}) am ${cutover}`,
      },
    ];
  },
};
