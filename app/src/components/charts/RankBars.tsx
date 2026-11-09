/**
 * Ranked magnitudes as horizontal bars (D178 point 13, the top expenses under "Verlauf"). The labels and
 * amounts are HTML text beside each bar, so they stay legible at any width; the bar is the one mark, in
 * `--t-chart-out`, growing from its left edge. A list, not a chart image: the numbers ARE the content,
 * so there is nothing chart-only to twin.
 */
import { formatMoney } from '../../i18n';

import './charts.css';

export interface RankBar {
  key: string;
  label: string;
  valueMinor: number;
}

export function RankBars({ rows, currency, label }: { rows: readonly RankBar[]; currency: string; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.valueMinor));
  return (
    <ol className="chart-rank" aria-label={label}>
      {rows.map((r, i) => (
        <li key={r.key} className="chart-rank__row">
          <span className="chart-rank__label">{r.label}</span>
          <span className="chart-rank__value t-money">{formatMoney(r.valueMinor, currency)}</span>
          <span className="chart-rank__track" aria-hidden="true">
            <span
              className="chart-rank__bar chart-grow chart-grow--x"
              style={{ width: `${Math.max(0, (r.valueMinor * 100) / max)}%`, ['--i' as string]: i }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}
