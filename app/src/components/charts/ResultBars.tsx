/**
 * D186: turnover and expense per month as paired columns on one baseline, the InOutBars geometry (the
 * `--t-chart-in` / `--t-chart-out` pair, a 2 px surface gap, rounded data ends square on the baseline).
 * Two optional layers, each named in the legend so identity is never colour alone:
 *
 *  - the ESTIMATE: what the open bank lines would add, drawn on top of the last month's turnover as an
 *    outline in the turnover hue (a projection, so no fill), only where it is not zero;
 *  - the PREVIOUS YEAR: a short 2 px tick in the text ink across each turnover column at last year's value.
 *
 * Each column carries a `<title>` (the hover read); the table twin carries every value.
 */
import { formatMoney } from '../../i18n';
import { ChartFigure } from './ChartFigure';
import { linear, niceCeil } from './scale';

export interface ResultPoint {
  key: string;
  label: string;
  longLabel: string;
  revenueMinor: number;
  expenseMinor: number;
  /** The same month a year earlier, when the comparison is shown. */
  previousRevenueMinor?: number;
  /** The estimate on top of this month's turnover (the running month only). */
  estimateMinor?: number;
}

export interface ResultBarsProps {
  points: readonly ResultPoint[];
  currency: string;
  summary: string;
  labels: { revenue: string; expense: string; estimate: string; previous: string; period: string; table: string };
}

const W = 640;
const H = 180;
const TOP = 8;

function barPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

export function ResultBars({ points, currency, summary, labels }: ResultBarsProps) {
  const showPrevious = points.some((p) => p.previousRevenueMinor !== undefined);
  const showEstimate = points.some((p) => (p.estimateMinor ?? 0) > 0);
  const max = niceCeil(
    Math.max(0, ...points.map((p) => Math.max(p.revenueMinor + Math.max(0, p.estimateMinor ?? 0), p.expenseMinor, p.previousRevenueMinor ?? 0))),
  );
  const y = linear(0, max, H, TOP);
  const slot = W / Math.max(1, points.length);
  const bar = Math.max(4, Math.min(18, slot * 0.3));
  return (
    <ChartFigure
      width={W}
      height={H}
      summary={summary}
      className="chart chart--bars"
      tableLabel={labels.table}
      after={
        <>
          <span className="chart-axis-max t-num">{formatMoney(max, currency)}</span>
          <ol className="chart-axis-x" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }} aria-hidden="true">
            {points.map((p) => (
              <li key={p.key}>{p.label}</li>
            ))}
          </ol>
        </>
      }
      legend={
        <>
          <span className="chart-key chart-key--in">{labels.revenue}</span>
          <span className="chart-key chart-key--out">{labels.expense}</span>
          {showEstimate ? <span className="chart-key chart-key--estimate">{labels.estimate}</span> : null}
          {showPrevious ? <span className="chart-key chart-key--previous">{labels.previous}</span> : null}
        </>
      }
      tableHead={
        <tr>
          <th scope="col">{labels.period}</th>
          <th scope="col" className="t-num">{labels.revenue}</th>
          {showEstimate ? <th scope="col" className="t-num">{labels.estimate}</th> : null}
          <th scope="col" className="t-num">{labels.expense}</th>
          {showPrevious ? <th scope="col" className="t-num">{labels.previous}</th> : null}
        </tr>
      }
      tableBody={points.map((p) => (
        <tr key={p.key}>
          <td>{p.longLabel}</td>
          <td className="t-num">{formatMoney(p.revenueMinor, currency)}</td>
          {showEstimate ? <td className="t-num">{(p.estimateMinor ?? 0) > 0 ? formatMoney(p.estimateMinor ?? 0, currency) : ''}</td> : null}
          <td className="t-num">{formatMoney(p.expenseMinor, currency)}</td>
          {showPrevious ? <td className="t-num">{p.previousRevenueMinor === undefined ? '' : formatMoney(p.previousRevenueMinor, currency)}</td> : null}
        </tr>
      ))}
    >
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} className="chart-grid" />
      ))}
      {points.map((p, i) => {
        const centre = slot * i + slot / 2;
        const revX = centre - bar - 1;
        const expX = centre + 1;
        const est = Math.max(0, p.estimateMinor ?? 0);
        const revenueTop = y(Math.max(0, p.revenueMinor));
        return (
          <g key={p.key}>
            {p.revenueMinor > 0 ? (
              <path d={barPath(revX, revenueTop, bar, H)} className="chart-mark chart-mark--in chart-grow" style={{ ['--i' as string]: i }}>
                <title>{`${p.longLabel}: ${labels.revenue} ${formatMoney(p.revenueMinor, currency)}`}</title>
              </path>
            ) : null}
            {est > 0 ? (
              <rect
                x={revX + 0.75}
                y={y(Math.max(0, p.revenueMinor) + est) + 0.75}
                width={Math.max(1, bar - 1.5)}
                height={Math.max(1, revenueTop - y(Math.max(0, p.revenueMinor) + est) - 2.75)}
                rx={3}
                className="chart-mark--estimate"
              >
                <title>{`${p.longLabel}: ${labels.estimate} ${formatMoney(est, currency)}`}</title>
              </rect>
            ) : null}
            {p.expenseMinor > 0 ? (
              <path d={barPath(expX, y(p.expenseMinor), bar, H)} className="chart-mark chart-mark--out chart-grow" style={{ ['--i' as string]: i }}>
                <title>{`${p.longLabel}: ${labels.expense} ${formatMoney(p.expenseMinor, currency)}`}</title>
              </path>
            ) : null}
            {p.previousRevenueMinor !== undefined && p.previousRevenueMinor > 0 ? (
              <line x1={revX - 2} x2={revX + bar + 2} y1={y(p.previousRevenueMinor)} y2={y(p.previousRevenueMinor)} className="chart-tick--previous">
                <title>{`${p.longLabel}: ${labels.previous} ${formatMoney(p.previousRevenueMinor, currency)}`}</title>
              </line>
            ) : null}
          </g>
        );
      })}
    </ChartFigure>
  );
}
