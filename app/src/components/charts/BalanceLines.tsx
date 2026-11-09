/**
 * D186: the money on the bank and the money in the books at each month end, two 2 px lines on ONE axis
 * (both are francs of the same accounts, so no second scale): the bank in `--t-chart-in`, the books in
 * the dim ink. Where they part, lines wait to be booked. A month with no statement has no bank point, and
 * the bank line simply starts later. Each point carries a `<title>`; the table twin every value.
 */
import { formatMoney } from '../../i18n';
import { ChartFigure } from './ChartFigure';
import { linePath, linear, niceCeil } from './scale';

export interface BalancePoint {
  key: string;
  label: string;
  longLabel: string;
  bankMinor: number | null;
  bookedMinor: number;
}

export interface BalanceLinesProps {
  points: readonly BalancePoint[];
  currency: string;
  summary: string;
  labels: { bank: string; booked: string; period: string; table: string };
}

const W = 640;
const H = 180;
const PAD = 8;

/** A floor that is a round step under the smallest value, so a high flat balance is not drawn as a cliff. */
function niceFloor(v: number, top: number): number {
  if (v <= 0) return -niceCeil(-v);
  const step = top / 4;
  return Math.max(0, Math.floor(v / step) * step);
}

export function BalanceLines({ points, currency, summary, labels }: BalanceLinesProps) {
  const values = points.flatMap((p) => (p.bankMinor === null ? [p.bookedMinor] : [p.bankMinor, p.bookedMinor]));
  const hi = niceCeil(Math.max(1, ...values));
  const lo = niceFloor(Math.min(...values), hi);
  const y = linear(lo, hi, H - PAD, PAD);
  const slot = W / Math.max(1, points.length);
  const x = (i: number) => slot * i + slot / 2;
  const booked = points.map((p, i) => ({ x: x(i), y: y(p.bookedMinor), p }));
  const bank = points.flatMap((p, i) => (p.bankMinor === null ? [] : [{ x: x(i), y: y(p.bankMinor), p, v: p.bankMinor }]));
  return (
    <ChartFigure
      width={W}
      height={H}
      summary={summary}
      className="chart chart--line"
      tableLabel={labels.table}
      after={
        <>
          <span className="chart-axis-max t-num">{formatMoney(hi, currency)}</span>
          <ol className="chart-axis-x" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }} aria-hidden="true">
            {points.map((p) => (
              <li key={p.key}>{p.label}</li>
            ))}
          </ol>
        </>
      }
      legend={
        <>
          <span className="chart-key chart-key--line-bank">{labels.bank}</span>
          <span className="chart-key chart-key--line-books">{labels.booked}</span>
        </>
      }
      tableHead={
        <tr>
          <th scope="col">{labels.period}</th>
          <th scope="col" className="t-num">{labels.bank}</th>
          <th scope="col" className="t-num">{labels.booked}</th>
        </tr>
      }
      tableBody={points.map((p) => (
        <tr key={p.key}>
          <td>{p.longLabel}</td>
          <td className="t-num">{p.bankMinor === null ? '–' : formatMoney(p.bankMinor, currency)}</td>
          <td className="t-num">{formatMoney(p.bookedMinor, currency)}</td>
        </tr>
      ))}
    >
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={0} x2={W} y1={y(lo + (hi - lo) * f)} y2={y(lo + (hi - lo) * f)} className="chart-grid" />
      ))}
      {booked.length > 1 ? <path d={linePath(booked)} pathLength={1} className="chart-line chart-line--books chart-draw" /> : null}
      {bank.length > 1 ? <path d={linePath(bank)} pathLength={1} className="chart-line chart-line--bank chart-draw" /> : null}
      {booked.map(({ x: px, y: py, p }) => (
        <circle key={`b-${p.key}`} cx={px} cy={py} r={4} className="chart-dot chart-dot--books">
          <title>{`${p.longLabel}: ${labels.booked} ${formatMoney(p.bookedMinor, currency)}`}</title>
        </circle>
      ))}
      {bank.map(({ x: px, y: py, p, v }) => (
        <circle key={`k-${p.key}`} cx={px} cy={py} r={4} className="chart-dot chart-dot--bank">
          <title>{`${p.longLabel}: ${labels.bank} ${formatMoney(v, currency)}`}</title>
        </circle>
      ))}
    </ChartFigure>
  );
}
