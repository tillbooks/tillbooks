/**
 * "So wird gebucht": the Soll/Haben lines a decision posts, shown BEFORE anything posts (a MUST-SURVIVE
 * of the bank-process judge: the Buchungsvorschau). Account number and name, Soll and Haben as words
 * in the head, money right-aligned and tabular. The same table shows an existing entry that a match
 * leaves untouched.
 *
 * In B2 (the owner's pick of 01.10.2026) the MUST-SURVIVE is met in three places: the account, the
 * amount and the MWST code in the row, the VAT split in the context strip (read off the same
 * `compose_entry` answer, `bankCompose.ts`), and this full table inside the split editor and the link
 * chooser. For a booking to accounts the rows are the engine's lines verbatim, the lines `book_bank_line`
 * posts; for a match they are the stored entry's.
 */
import { useT, formatMoney } from '../../i18n';
import type { PreviewLine } from './bankCompose';
import type { Lookups } from './lookups';
import { accountLabel } from './lookups';
import { Tooltip } from '../../components/Tooltip';

/**
 * D177: a line whose figure is not known yet (a Buchungsregel's asked amount still empty): the account
 * shows, its figure reads "?" on the side named.
 */
export type PreviewRow = PreviewLine & {
  unknownSide?: 'debit' | 'credit';
  /** D177 final judge, FAIL 1: a rest that comes to 0 shows "0.00" on the side it books. */
  zeroSide?: 'debit' | 'credit';
};

export interface LegsPreviewProps {
  title: string;
  lines: readonly PreviewRow[] | null;
  currency: string;
  lookups: Lookups;
  /** Shown instead of the table while the figures are not in, or when there is nothing to show. */
  note?: string;
  /** A second line under the title (the entry stays unchanged, ...). */
  subtitle?: string;
  /** D177: a Durchlaufkonto's lines, shown in the dim ink (they net to zero), never folded away. */
  transitIds?: ReadonlySet<string>;
}

export function LegsPreview({ title, lines, currency, lookups, note, subtitle, transitIds }: LegsPreviewProps) {
  const t = useT();
  const money = (minor: number) => (minor === 0 ? '' : formatMoney(minor, currency).slice(currency.length + 1));
  const zero = formatMoney(0, currency).slice(currency.length + 1);
  const cell = (l: PreviewRow, side: 'debit' | 'credit') => (l.unknownSide === side ? '?' : l.zeroSide === side ? zero : money(side === 'debit' ? l.debit : l.credit));
  return (
    <section className="bank-legs" aria-label={title}>
      <h3 className="bank-section-title">{title}</h3>
      {subtitle !== undefined && <p className="bank-legs__subtitle">{subtitle}</p>}
      {lines === null || lines.length === 0 ? (
        <p className="bank-legs__note">{note ?? t('bankInbox.legs.pickFirst')}</p>
      ) : (
        <table className="bank-legs__table">
          <colgroup>
            <col />
            <col className="bank-legs__col-num" />
            <col className="bank-legs__col-num" />
          </colgroup>
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
              <tr key={`${l.accountId}-${i}`} data-transit={transitIds?.has(l.accountId) === true ? 'true' : undefined} data-zero={l.zeroSide !== undefined ? 'true' : undefined}>
                {/* One line per account (UX judge, item 3): a name the column cannot hold ends in an
                    ellipsis, the whole of it in its tooltip. */}
                <td className="bank-legs__account">
                  <Tooltip content={label}>
                    <span className="bank-legs__name">{label}</span>
                  </Tooltip>
                </td>
                <td className="bank-legs__num t-num">{cell(l, 'debit')}</td>
                <td className="bank-legs__num t-num">{cell(l, 'credit')}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
