/**
 * Money in and out per period as paired bars on one baseline (D178 point 13): in in `--t-chart-in`, out
 * in `--t-chart-out`, a 2 px surface gap between the pair, rounded data ends anchored to the baseline.
 * One axis, three recessive hairlines, the top value named in text. Each bar carries a `<title>` (the
 * hover read), the legend names both series with their totals, and the table twin every value.
 */
import { formatMoney } from '../../i18n';
import { ChartFigure } from './ChartFigure';
import { linear, niceCeil } from './scale';

export interface InOutPoint {
  key: string;
  /** The short axis label ("Jan"). */
  label: string;
  /** The full label for the table and the hover ("Januar 2026"). */
  longLabel: string;
  inMinor: number;
  outMinor: number;
}

export interface InOutBarsProps {
  points: readonly InOutPoint[];
  currency: string;
  summary: string;
  labels: { in: string; out: string; period: string; table: string };
}

const W = 640;
const H = 180;
const TOP = 8;

/** A bar whose top corners are rounded and whose foot sits square on the baseline. */
function barPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

export function InOutBars({ points, currency, summary, labels }: InOutBarsProps) {
  const max = niceCeil(Math.max(0, ...points.map((p) => Math.max(p.inMinor, p.outMinor))));
  const y = linear(0, max, H, TOP);
  const slot = W / Math.max(1, points.length);
  const bar = Math.max(4, Math.min(18, slot * 0.3));
  const totalIn = points.reduce((s, p) => s + p.inMinor, 0);
  const totalOut = points.reduce((s, p) => s + p.outMinor, 0);

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
          <span className="chart-key chart-key--in">
            {labels.in} <span className="t-money">{formatMoney(totalIn, currency)}</span>
          </span>
          <span className="chart-key chart-key--out">
            {labels.out} <span className="t-money">{formatMoney(totalOut, currency)}</span>
          </span>
        </>
      }
      tableHead={
        <tr>
          <th scope="col">{labels.period}</th>
          <th scope="col" className="t-num">{labels.in}</th>
          <th scope="col" className="t-num">{labels.out}</th>
        </tr>
      }
      tableBody={points.map((p) => (
        <tr key={p.key}>
          <td>{p.longLabel}</td>
          <td className="t-num">{formatMoney(p.inMinor, currency)}</td>
          <td className="t-num">{formatMoney(p.outMinor, currency)}</td>
        </tr>
      ))}
    >
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} className="chart-grid" />
      ))}
      {points.map((p, i) => {
        const centre = slot * i + slot / 2;
        const inX = centre - bar - 1;
        const outX = centre + 1;
        return (
          <g key={p.key}>
            {p.inMinor > 0 ? (
              <path d={barPath(inX, y(p.inMinor), bar, H)} className="chart-mark chart-mark--in chart-grow" style={{ ['--i' as string]: i }}>
                <title>{`${p.longLabel}: ${labels.in} ${formatMoney(p.inMinor, currency)}`}</title>
              </path>
            ) : null}
            {p.outMinor > 0 ? (
              <path d={barPath(outX, y(p.outMinor), bar, H)} className="chart-mark chart-mark--out chart-grow" style={{ ['--i' as string]: i }}>
                <title>{`${p.longLabel}: ${labels.out} ${formatMoney(p.outMinor, currency)}`}</title>
              </path>
            ) : null}
          </g>
        );
      })}
    </ChartFigure>
  );
}
