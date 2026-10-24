/**
 * Money on a Pendenzen row (DESIGN.md Money; the fresh-eyes judge, N4 M1): the figure in ink and tabular,
 * and on an outgoing amount the SIGN alone in `--t-danger`. A minus reads as a fact, never as a red row.
 */
import { formatMoney } from '../../i18n';

export function Amount({ minor, currency }: { minor: number; currency: string }) {
  const text = formatMoney(minor, currency);
  const at = minor < 0 ? text.search(/[-−]/) : -1;
  if (at < 0) return <span className="att-row-amount t-money">{text}</span>;
  return (
    <span className="att-row-amount t-money">
      {text.slice(0, at)}
      <span className="att-amount-sign">{text[at]}</span>
      {text.slice(at + 1)}
    </span>
  );
}
