/**
 * The Projekterfolg panel (B03 §6): the P&L card, the budget-vs-actual comparison and the drill
 * table, mounted on the B00 project detail (no route of its own; this directory is a component
 * library the Projects surface shares, the `Vat/` shape).
 *
 * A PURE READ over `costing_project_pl` / `costing_budget_vs_actual` / `costing_drilldown`:
 * everything renders from the engine's recomputed figures, nothing is derived in the browser
 * beyond formatting (P11 `formatMoney`, tabular numerals).
 *
 * THE PADLOCK (A24): the layer gates on `costing.read`, SEPARATE from the project master data
 * around it (the revDSG pay-data gate, spec §3), so a denial renders the shared PermissionDenied
 * padlock panel INSIDE the panel while the rest of the project page stays intact (US-B03.6). The
 * parent additionally pre-hides
 * the panel via `useCan(CAP.costingRead)` (never shown-then-rejected); the engine decides.
 *
 * HONESTY STATES, each glyph+text and never colour alone: ⚠ "Budget überschritten" on overrun,
 * ⓘ "Kein Kostensatz hinterlegt" when the cost basis degrades (an entry captured without a
 * cost-rate snapshot), the unattributable-components hint exactly when the engine names one
 * (none today: the A17/D02 project references are landed), and margin % as "–" (never 0) when
 * there is no revenue.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import type { Err } from '../../lib/client';
import { useT, useTStrict, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';

/** The card payload, exactly as `costing_project_pl` answers (spec §0 camelCase Minor names). */
export interface ProjectPl {
  currency: string;
  basis: 'bill' | 'cost';
  basisDegraded: boolean;
  revenueMinor: number;
  costMinor: number;
  costBreakdown: {
    timeMinor: number;
    expensesMinor: number;
    purchasesMinor: number;
    accruedPurchasesMinor: number;
  };
  committedMinor: number;
  marginMinor: number;
  marginBp: number | null;
  timeMinutes: number;
  unattributableComponents: string[];
}

export interface BudgetVsActual {
  budgeted: boolean;
  currency: string;
  budgetMinor?: number;
  budgetHours?: number;
  costToDateMinor: number;
  hoursToDate: number;
  remainingMinor?: number;
  consumedBp?: number | null;
  overBudget?: boolean;
}

interface DrillRow {
  id: string;
  sourceKind: string;
  amountMinor: number;
  startedAt?: string;
  minutes?: number;
  status?: string;
  number?: string | null;
  issueDate?: string | null;
  billDate?: string | null;
  description?: string | null;
  notes?: string | null;
  qty?: number;
}

const DRILL_COMPONENTS = ['time', 'expenses', 'purchases', 'accrued_purchases', 'revenue'] as const;
type DrillComponent = (typeof DRILL_COMPONENTS)[number];

export interface ProjectProfitabilityProps {
  workspaceId: string;
  projectId: string;
}

function marginPct(marginBp: number | null): string | null {
  if (marginBp === null) return null;
  return `${(marginBp / 100).toFixed(1)}%`;
}

export function ProjectProfitability({ workspaceId, projectId }: ProjectProfitabilityProps) {
  const t = useT();
  const tStrict = useTStrict();
  const client = useClient();

  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [pl, setPl] = useState<ProjectPl | null>(null);
  const [budget, setBudget] = useState<BudgetVsActual | null>(null);
  const [basis, setBasis] = useState<'bill' | 'cost'>('bill');

  const [drillComponent, setDrillComponent] = useState<DrillComponent>('time');
  const [drillRows, setDrillRows] = useState<DrillRow[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDenied(false);
    const [plResp, budgetResp] = await Promise.all([
      client.call('costing_project_pl', { workspaceId, projectId, basis }),
      client.call('costing_budget_vs_actual', { workspaceId, projectId }),
    ]);
    if (isErr(plResp.body)) {
      if (plResp.body.error === 'permission_denied' || plResp.status === 403) setDenied(true);
      else setError(plResp.body);
      setLoading(false);
      return;
    }
    setPl(plResp.body as unknown as ProjectPl);
    setBudget(isErr(budgetResp.body) ? null : (budgetResp.body as unknown as BudgetVsActual));
    setLoading(false);
  }, [client, workspaceId, projectId, basis]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDrill = useCallback(async () => {
    const resp = await client.call('costing_drilldown', {
      workspaceId,
      projectId,
      component: drillComponent,
      basis,
    });
    setDrillRows(isErr(resp.body) ? [] : ((resp.body.rows as DrillRow[] | undefined) ?? []));
  }, [client, workspaceId, projectId, drillComponent, basis]);

  useEffect(() => {
    void loadDrill();
  }, [loadDrill]);

  if (denied) {
    return (
      <section className="costing" aria-label={t('costing.tab.title')}>
        <h3 className="costing-title">{t('costing.tab.title')}</h3>
        <PermissionDenied body={t('costing.denied')} />
      </section>
    );
  }

  if (loading || pl === null) {
    return (
      <section className="costing" aria-label={t('costing.tab.title')}>
        <h3 className="costing-title">{t('costing.tab.title')}</h3>
        {error !== null ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Skeleton rows={3} height={28} />}
      </section>
    );
  }

  const isEmpty = pl.revenueMinor === 0 && pl.costMinor === 0;
  const pct = marginPct(pl.marginBp);

  return (
    <section className="costing" aria-label={t('costing.tab.title')}>
      <div className="costing-head">
        <h3 className="costing-title">
          {t('costing.tab.title')}
          <SurfaceHelp surface="Costing" />
        </h3>
        <div className="costing-basis" role="group" aria-label={t('costing.basis.label')}>
          {(['bill', 'cost'] as const).map((b) => (
            <button
              key={b}
              type="button"
              className={`costing-seg ${basis === b ? 'costing-seg--active' : ''}`}
              aria-pressed={basis === b}
              onClick={() => setBasis(b)}
            >
              {t(`costing.basis.${b}`)}
            </button>
          ))}
        </div>
      </div>

      {error !== null && <ErrorBanner error={error} onRetry={() => void load()} />}
      {isEmpty && <p className="costing-empty">{t('costing.empty')}</p>}

      <dl className="costing-figures">
        <div>
          <dt>{t('costing.card.revenue')}</dt>
          <dd className="costing-num">{formatMoney(pl.revenueMinor, pl.currency)}</dd>
        </div>
        <div>
          <dt>{t('costing.card.cost')}</dt>
          <dd className="costing-num">{formatMoney(pl.costMinor, pl.currency)}</dd>
        </div>
        <div>
          <dt>{t('costing.card.margin')}</dt>
          <dd className="costing-num costing-margin">{formatMoney(pl.marginMinor, pl.currency)}</dd>
        </div>
        <div>
          <dt>{t('costing.card.marginPct')}</dt>
          <dd className="costing-num">{pct ?? t('costing.noMarginPct')}</dd>
        </div>
      </dl>

      <dl className="costing-breakdown">
        <div>
          <dt>{t('costing.component.time')}</dt>
          <dd className="costing-num">{formatMoney(pl.costBreakdown.timeMinor, pl.currency)}</dd>
        </div>
        <div>
          <dt>{t('costing.component.expenses')}</dt>
          <dd className="costing-num">{formatMoney(pl.costBreakdown.expensesMinor, pl.currency)}</dd>
        </div>
        <div>
          <dt>{t('costing.component.purchases')}</dt>
          <dd className="costing-num">{formatMoney(pl.costBreakdown.purchasesMinor, pl.currency)}</dd>
        </div>
        <div>
          <dt>{t('costing.component.accrued_purchases')}</dt>
          <dd className="costing-num">{formatMoney(pl.costBreakdown.accruedPurchasesMinor, pl.currency)}</dd>
        </div>
        {pl.committedMinor > 0 && (
          <div>
            <dt>{t('costing.component.committed')}</dt>
            <dd className="costing-num">{formatMoney(pl.committedMinor, pl.currency)}</dd>
          </div>
        )}
      </dl>
      {pl.unattributableComponents.length > 0 && (
        <p className="costing-hint">
          <span aria-hidden="true">ⓘ </span>
          {t('costing.hint.unattributable')}
        </p>
      )}
      {basis === 'cost' && pl.basisDegraded && (
        <p className="costing-hint" role="status">
          <span aria-hidden="true">ⓘ </span>
          {t('costing.hint.costRateMissing')}
        </p>
      )}

      {budget !== null && budget.budgeted && (
        <div className="costing-budget">
          <h4>{t('costing.budget.title')}</h4>
          <dl className="costing-figures">
            <div>
              <dt>{t('costing.budget.budget')}</dt>
              <dd className="costing-num">{formatMoney(budget.budgetMinor ?? 0, budget.currency)}</dd>
            </div>
            <div>
              <dt>{t('costing.budget.costToDate')}</dt>
              <dd className="costing-num">{formatMoney(budget.costToDateMinor, budget.currency)}</dd>
            </div>
            <div>
              <dt>{t('costing.budget.remaining')}</dt>
              <dd className="costing-num">{formatMoney(budget.remainingMinor ?? 0, budget.currency)}</dd>
            </div>
            {budget.consumedBp !== null && budget.consumedBp !== undefined && (
              <div>
                <dt>{t('costing.budget.consumed')}</dt>
                <dd className="costing-num">{(budget.consumedBp / 100).toFixed(1)}%</dd>
              </div>
            )}
          </dl>
          {budget.overBudget === true && (
            <p className="costing-over" role="status">
              <span aria-hidden="true">⚠ </span>
              {t('costing.budget.overBudget')}
            </p>
          )}
        </div>
      )}

      <div className="costing-drill">
        <div className="costing-drill-head">
          <h4>{t('costing.drill.title')}</h4>
          <div role="group" aria-label={t('costing.drill.component')}>
            {DRILL_COMPONENTS.map((c) => (
              <button
                key={c}
                type="button"
                className={`costing-seg ${drillComponent === c ? 'costing-seg--active' : ''}`}
                aria-pressed={drillComponent === c}
                onClick={() => setDrillComponent(c)}
              >
                {t(`costing.component.${c}`)}
              </button>
            ))}
          </div>
        </div>
        {drillRows === null ? (
          <Skeleton rows={2} height={24} />
        ) : drillRows.length === 0 ? (
          <p className="costing-drill-empty">{t('costing.drill.empty')}</p>
        ) : (
          <table className="costing-drill-table" aria-label={t('costing.drill.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('costing.drill.date')}</th>
                <th scope="col">{t('costing.drill.source')}</th>
                <th scope="col">{t('costing.drill.detail')}</th>
                <th scope="col" className="costing-num">
                  {t('costing.drill.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {drillRows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.startedAt ?? row.issueDate ?? row.billDate ?? '')}</td>
                  <td>
                    {row.sourceKind === 'time_entry'
                      ? t('costing.drill.timeEntry')
                      : row.sourceKind === 'invoice_line'
                        ? t('costing.drill.invoiceLine')
                        : row.sourceKind === 'vendor_bill'
                          ? t('costing.drill.vendorBill')
                          : row.sourceKind === 'po_line'
                            ? t('costing.drill.poLine')
                            : t('costing.drill.creditNoteLine')}
                  </td>
                  <td>
                    {row.sourceKind === 'time_entry'
                      ? tStrict('costing.drill.minutes', { minutes: row.minutes ?? 0 })
                      : (row.number ?? row.description ?? '')}
                  </td>
                  <td className="costing-num">{formatMoney(row.amountMinor, pl.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
