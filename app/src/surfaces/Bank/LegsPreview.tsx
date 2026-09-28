/**
 * "So wird gebucht": the Soll/Haben lines a decision posts, shown BEFORE anything posts (a MUST-SURVIVE
 * of the bank-process judge: the Buchungsvorschau). Account number and name, Soll and Haben as words
 * in the head, money right-aligned and tabular. The same table shows an existing entry that a match
 * leaves untouched, and a booked line's entry.
 */
import { useT, formatMoney } from '../../i18n';
import type { PreviewLine } from './model';
import type { Lookups } from './lookups';
import { accountLabel } from './lookups';

export interface LegsPreviewProps {
  title: string;
  lines: readonly PreviewLine[] | null;
  currency: string;
  lookups: Lookups;
  /** Shown instead of the table while the figures are not in, or when there is nothing to show. */
  note?: string;
  /** A second line under the title (the entry stays unchanged, ...). */
  subtitle?: string;
}

export function LegsPreview({ title, lines, currency, lookups, note, subtitle }: LegsPreviewProps) {
  const t = useT();
  const money = (minor: number) => (minor === 0 ? '' : formatMoney(minor, currency).slice(currency.length + 1));
  return (
    <section className="bank-legs" aria-label={title}>
      <h3 className="bank-section-title">{title}</h3>
      {subtitle !== undefined && <p className="bank-legs__subtitle">{subtitle}</p>}
      {lines === null || lines.length === 0 ? (
        <p className="bank-legs__note">{note ?? t('bankInbox.legs.pickFirst')}</p>
      ) : (
        <table className="bank-legs__table">
          <thead>
            <tr>
              <th scope="col">{t('bankInbox.legs.account')}</th>
              <th scope="col" className="bank-legs__num">
                {t('bankInbox.legs.debit')}
              </th>
              <th scope="col" className="bank-legs__num">
                {t('bankInbox.legs.credit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const label = accountLabel(lookups, l.accountId) || t('bankInbox.legs.unknownAccount');
              return (
              <tr key={`${l.accountId}-${i}`}>
                <td className="bank-legs__account" title={label}>
                  {label}
                </td>
                <td className="bank-legs__num t-num">{money(l.debit)}</td>
                <td className="bank-legs__num t-num">{money(l.credit)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
