/**
 * One series over time as a 2 px line (D178 point 13, the cash flow): the net of money in and out per
 * period, against a zero hairline, with an 8 px marker per point that carries the hover read. One
 * series, so no legend box: the widget's title names it. The table twin carries every value.
 *
 * `Sparkline` is the same line at tile size, decorative beside a figure that already states the value
 * (`aria-hidden`), so it needs no table.
 */
import { formatMoney } from '../../i18n';
import { ChartFigure } from './ChartFigure';
import { linePath, linear, niceCeil } from './scale';

export interface LinePoint {
  key: string;
  label: string;
  longLabel: string;
  valueMinor: number;
}

export interface LineChartProps {
  points: readonly LinePoint[];
  currency: string;
  summary: string;
  labels: { period: string; value: string; table: string };
}

const W = 640;
const H = 180;
const PAD = 8;

export function LineChart({ points, currency, summary, labels }: LineChartProps) {
  const values = points.map((p) => p.valueMinor);
  // One axis that always holds zero: the nice ceiling of the largest gain, the nice floor of the largest loss.
  const gain = Math.max(0, ...values);
  const loss = Math.max(0, ...values.map((v) => -v));
  const lo = loss > 0 ? -niceCeil(loss) : 0;
  const hi = gain > 0 || loss === 0 ? niceCeil(gain) : 0;
  const y = linear(lo, hi, H - PAD, PAD);
  const slot = W / Math.max(1, points.length);
  const xy = points.map((p, i) => ({ x: slot * i + slot / 2, y: y(p.valueMinor), p }));
  return (
    <ChartFigure
      width={W}
      height={H}
      summary={summary}
      className="chart chart--line"
      tableLabel={labels.table}
      after={
        <ol className="chart-axis-x" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }} aria-hidden="true">
          {points.map((p) => (
            <li key={p.key}>{p.label}</li>
          ))}
        </ol>
      }
      tableHead={
        <tr>
          <th scope="col">{labels.period}</th>
          <th scope="col" className="t-num">{labels.value}</th>
        </tr>
      }
      tableBody={points.map((p) => (
        <tr key={p.key}>
          <td>{p.longLabel}</td>
          <td className="t-num">{formatMoney(p.valueMinor, currency)}</td>
        </tr>
      ))}
    >
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="chart-grid chart-grid--zero" />
      {xy.length > 1 ? <path d={linePath(xy)} pathLength={1} className="chart-line chart-draw" /> : null}
      {xy.map(({ x, y: py, p }, i) => (
        <circle key={p.key} cx={x} cy={py} r={4} className="chart-dot chart-grow chart-grow--arc" style={{ ['--i' as string]: i }}>
          <title>{`${p.longLabel}: ${formatMoney(p.valueMinor, currency)}`}</title>
        </circle>
      ))}
    </ChartFigure>
  );
}

/** A tile-sized trend line, decorative beside the figure it follows. */
export function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = linear(min, max === min ? min + 1 : max, h - 3, 3);
  const x = linear(0, values.length - 1, 2, w - 2);
  const d = linePath(values.map((v, i) => ({ x: x(i), y: y(v) })));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart-sparkline" aria-hidden="true" focusable="false">
      <path d={d} pathLength={1} className="chart-line chart-draw" />
    </svg>
  );
}
