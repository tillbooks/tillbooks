/**
 * A parts-of-a-whole ring (D178 point 13, the top expenses). The parts are ranked magnitudes of ONE
 * kind (money out), so they are one hue in sequential steps of `--t-chart-out`, the largest darkest,
 * and the rest ("Übrige") neutral; a 2 px surface gap separates neighbours. Identity never rides the
 * colour: the legend beside the ring names every part with its amount and share, and the table twin
 * repeats them. The total sits in the hole.
 */
import { formatMoney } from '../../i18n';
import { ChartFigure } from './ChartFigure';
import { arcPath, donutAngles } from './scale';

export interface DonutPart {
  key: string;
  label: string;
  valueMinor: number;
  /** The neutral "rest" part. */
  rest?: boolean;
}

export interface DonutProps {
  parts: readonly DonutPart[];
  totalMinor: number;
  currency: string;
  summary: string;
  labels: { total: string; part: string; amount: string; share: string; table: string };
}

const SIZE = 160;
const C = SIZE / 2;
const OUTER = 76;
const INNER = 50;

/** A share in whole per cent, or "<1 %" for a sliver, so the legend never claims 0 % of something. */
function share(value: number, total: number): string {
  if (total <= 0) return '0 %';
  const pct = (value * 100) / total;
  return pct > 0 && pct < 1 ? '<1 %' : `${Math.round(pct)} %`;
}

export function Donut({ parts, totalMinor, currency, summary, labels }: DonutProps) {
  const angles = donutAngles(parts.map((p) => p.valueMinor));
  return (
    <ChartFigure
      width={SIZE}
      height={SIZE}
      summary={summary}
      className="chart chart--donut"
      tableLabel={labels.table}
      legend={
        <ul className="chart-parts">
          {parts.map((p, i) => (
            <li key={p.key}>
              <span className={p.rest === true ? 'chart-swatch chart-step--rest' : `chart-swatch chart-step--${Math.min(i, 4)}`} aria-hidden="true" />
              <span className="chart-parts__label">{p.label}</span>
              <span className="chart-parts__value t-money">{formatMoney(p.valueMinor, currency)}</span>
              <span className="chart-parts__share t-num">{share(p.valueMinor, totalMinor)}</span>
            </li>
          ))}
        </ul>
      }
      tableHead={
        <tr>
          <th scope="col">{labels.part}</th>
          <th scope="col" className="t-num">{labels.amount}</th>
          <th scope="col" className="t-num">{labels.share}</th>
        </tr>
      }
      tableBody={parts.map((p) => (
        <tr key={p.key}>
          <td>{p.label}</td>
          <td className="t-num">{formatMoney(p.valueMinor, currency)}</td>
          <td className="t-num">{share(p.valueMinor, totalMinor)}</td>
        </tr>
      ))}
    >
      {parts.map((p, i) => {
        const a = angles[i];
        if (a === undefined || a.a1 <= a.a0) return null;
        return (
          <path
            key={p.key}
            d={arcPath(C, C, OUTER, INNER, a.a0, a.a1)}
            className={`chart-mark chart-grow chart-grow--arc ${p.rest === true ? 'chart-step--rest' : `chart-step--${Math.min(i, 4)}`}`}
            style={{ ['--i' as string]: i }}
          >
            <title>{`${p.label}: ${formatMoney(p.valueMinor, currency)} (${share(p.valueMinor, totalMinor)})`}</title>
          </path>
        );
      })}
      <text x={C} y={C - 4} textAnchor="middle" className="chart-hole-label" aria-hidden="true">
        {labels.total}
      </text>
      <text x={C} y={C + 12} textAnchor="middle" className="chart-hole-value" aria-hidden="true">
        {formatMoney(totalMinor, currency)}
      </text>
    </ChartFigure>
  );
}
