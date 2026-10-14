/**
 * A40, the liquidity chart: the projected bank balance day by day, without and with the proposal,
 * against the floor.
 *
 * The Studio has no chart primitive, so this is one small inline SVG, tokens only (brand/DESIGN.md):
 * the balance WITH the proposal is the one solid ink line, the balance without it a dashed dim line,
 * the floor a dashed warn line with its label in words. The lowest point is marked with a glyph and
 * named in text beside the chart, never by colour alone. `role="img"` carries a one-sentence summary,
 * and the table twin under it carries every value the chart draws, so nothing is chart-only.
 */
import { useT, formatDate, formatMoney } from '../../i18n';
import { chartGeometry, type ForecastDay } from './planning-model';

export interface LiquidityChartProps {
  days: readonly ForecastDay[];
  currency: string;
  floorMinor: number | null;
  lowest: { date: string; balanceMinor: number };
}

export function LiquidityChart({ days, currency, floorMinor, lowest }: LiquidityChartProps) {
  const t = useT();
  const g = chartGeometry(days, floorMinor);
  if (g === null) return null;
  const hasPlan = g.withPlan !== null;
  const summary = t('pay.plan.chart.summary', {
    from: formatDate(days[0]?.date ?? lowest.date),
    to: formatDate(days[days.length - 1]?.date ?? lowest.date),
    lowest: formatMoney(lowest.balanceMinor, currency),
    date: formatDate(lowest.date),
  });
  const below = floorMinor !== null && lowest.balanceMinor < floorMinor;

  return (
    <figure className="pay-plan-chart">
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        width="100%"
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="pay-plan-chart-svg"
      >
        {g.ticks.map((tick) => (
          <line key={tick.y} x1={0} x2={g.width} y1={tick.y} y2={tick.y} className="pay-plan-chart-grid" />
        ))}
        {g.floorY !== null && (
          <line x1={0} x2={g.width} y1={g.floorY} y2={g.floorY} className="pay-plan-chart-floor" />
        )}
        <path d={g.base} className={hasPlan ? 'pay-plan-chart-base' : 'pay-plan-chart-line'} />
        {g.withPlan !== null && <path d={g.withPlan} className="pay-plan-chart-line" />}
        <circle cx={g.lowest.x} cy={g.lowest.y} r={4} className="pay-plan-chart-low" />
      </svg>
      <figcaption className="pay-plan-chart-legend">
        <span className="pay-plan-legend pay-plan-legend--line">
          {hasPlan ? t('pay.plan.chart.withPlan') : t('pay.plan.chart.balance')}
        </span>
        {hasPlan && <span className="pay-plan-legend pay-plan-legend--base">{t('pay.plan.chart.withoutPlan')}</span>}
        {floorMinor !== null && (
          <span className="pay-plan-legend pay-plan-legend--floor">
            {t('pay.plan.chart.floor', { amount: formatMoney(floorMinor, currency) })}
          </span>
        )}
        <span className={below ? 'pay-plan-legend pay-plan-legend--low is-below' : 'pay-plan-legend pay-plan-legend--low'}>
          {below ? t('pay.plan.chart.lowestBelow', { amount: formatMoney(lowest.balanceMinor, currency), date: formatDate(lowest.date) }) : t('pay.plan.chart.lowest', { amount: formatMoney(lowest.balanceMinor, currency), date: formatDate(lowest.date) })}
        </span>
      </figcaption>
      <details className="pay-plan-chart-table">
        <summary>{t('pay.plan.chart.asTable')}</summary>
        <table className="data-table">
          <caption className="visually-hidden">{summary}</caption>
          <thead>
            <tr>
              <th scope="col">{t('pay.plan.chart.date')}</th>
              <th scope="col" className="t-num">{hasPlan ? t('pay.plan.chart.inWithPlan') : t('pay.plan.chart.in')}</th>
              <th scope="col" className="t-num">{hasPlan ? t('pay.plan.chart.outWithPlan') : t('pay.plan.chart.out')}</th>
              <th scope="col" className="t-num">{hasPlan ? t('pay.plan.chart.withoutPlan') : t('pay.plan.chart.balance')}</th>
              {hasPlan && <th scope="col" className="t-num">{t('pay.plan.chart.withPlan')}</th>}
            </tr>
          </thead>
          <tbody>
            {/* L3: every day either series moves on is a row (a day only the proposal pays on
                included), and with a proposal the Ein/Aus columns are the proposal's own. */}
            {days
              .filter(
                (d) =>
                  d.inMinor !== 0 ||
                  d.outMinor !== 0 ||
                  (d.inWithPlanMinor ?? 0) !== 0 ||
                  (d.outWithPlanMinor ?? 0) !== 0 ||
                  d.date === lowest.date,
              )
              .map((d) => (
                <tr key={d.date}>
                  <td>{formatDate(d.date)}</td>
                  <td className="t-num">{formatMoney(hasPlan ? (d.inWithPlanMinor ?? d.inMinor) : d.inMinor, currency)}</td>
                  <td className="t-num">{formatMoney(hasPlan ? (d.outWithPlanMinor ?? d.outMinor) : d.outMinor, currency)}</td>
                  <td className="t-num">{formatMoney(d.balanceMinor, currency)}</td>
                  {hasPlan && (
                    <td className="t-num">{formatMoney(d.balanceWithPlanMinor ?? d.balanceMinor, currency)}</td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
