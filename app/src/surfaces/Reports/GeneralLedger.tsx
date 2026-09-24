/**
 * R-S5, the Kontoblatt: what one account opened at, everything that moved it, and what it closed at.
 *
 * THE TWO BALANCE ROWS ARE ALWAYS THERE, AND THAT IS THE EMPTY STATE (R13). `lines` can be empty
 * while `openingMinor` and `closingMinor` are large: an account with a balance and no movement in the
 * period is a completely normal thing and is NOT "nothing". So the no-movement state keeps both
 * balance rows and replaces the line list with one sentence. It never says the account is empty, and
 * it is never the shared `EmptyState` panel, because that panel would hide the two figures that are
 * the answer.
 *
 * `naturalSide` IS USED AND NEVER DISPLAYED. The model returns it so a GUI can present the account
 * without inferring a sign. It drives one thing: the hint on the Schlusssaldo saying which way this
 * account is expected to lean, so a negative balance on an asset account reads as the anomaly it is,
 * and so a Kreditor of 5'410.55 on the Bilanz opening a Kontoblatt at -5'410.55 is explained BEFORE
 * the operator has to work it out (R38). The raw word never reaches the screen.
 *
 * `source` RENDERS AS A WORD, and `close` is the one that matters. The engine keeps the column
 * "precisely so a close line is identifiable on sight", so `close` renders as Abschluss. `manual`
 * renders as NOTHING at all: it is the default, and a column reading "Manuell" 240 times is noise
 * rather than information.
 *
 * AT SCALE IT DEGRADES, AND THIS SAYS SO OUT LOUD. There is no ceiling anywhere in A08 and
 * `general_ledger` has no pagination: a busy bank account over a full year returns hundreds of lines.
 * Three honest responses and no fourth: the period control is the lever and it is already on screen,
 * the row count is stated above the table so the operator learns what they asked for before they
 * scroll it, and NO control implies a pagination the engine does not offer. No page numbers, no "load
 * more", no infinite scroll.
 *
 * THE DRILL OPENS A02's `EntryDrawer` IN PLACE (INV-8), and does not link to `/journal`.
 * `Journal.tsx` holds its filters in local state and reads no query parameter (finding F5), so a link
 * there would land on an unfiltered newest-first list and the operator would have to find the entry
 * again by hand. That is a dead end with extra steps. `EntryDrawer` in `view` mode already renders a
 * posted entry read-only, and reusing it means A08 ships no second way of looking at a journal entry.
 */
import { useT, formatMoney, formatDate } from '../../i18n';
import { HelpHint } from '../../components/HelpHint';
import type { GeneralLedgerView } from './model';
import { hasCloseEntry, sourceLabelKey } from './model';

export interface GeneralLedgerProps {
  view: GeneralLedgerView;
  /** Open A02's EntryDrawer in `view` mode over this surface (R28). */
  onOpenEntry: (entryId: string) => void;
}

export function GeneralLedger({ view, onOpenEntry }: GeneralLedgerProps) {
  const t = useT();
  const currency = view.baseCurrency;
  const closed = hasCloseEntry(view.lines);

  return (
    <section className="rp-statement" aria-labelledby="rp-ledger-heading">
      <h2 id="rp-ledger-heading" className="rp-statement-title">
        {t('reports.heading.generalLedger', {
          account: `${view.account.number} ${view.account.name}`,
          from: formatDate(view.period.start),
          to: formatDate(view.period.end),
        })}
      </h2>

      <p className="rp-ledger-meta">
        <span>{t('reports.lineCount', { n: view.lines.length })}</span>
        <HelpHint
          label={t('reports.generalLedger.naturalSideLabel')}
          title={t('reports.generalLedger.naturalSideTitle')}
          body={
            <>
              <span>{t(`reports.generalLedger.naturalSide.${view.naturalSide}`)}</span>{' '}
              <span>{t('reports.generalLedger.signFromStatement')}</span>
            </>
          }
        />
      </p>

      {closed && <p className="rp-note">{t('reports.generalLedger.closedYearNote')}</p>}

      <div className="rp-table-wrap">
        <table className="rp-table">
          <thead>
            <tr>
              <th scope="col">{t('reports.column.date')}</th>
              <th scope="col">{t('reports.column.ref')}</th>
              <th scope="col">{t('reports.column.description')}</th>
              <th scope="col">{t('reports.column.source')}</th>
              <th scope="col" className="rp-num">
                {t('reports.column.debit')}
              </th>
              <th scope="col" className="rp-num">
                {t('reports.column.credit')}
              </th>
              <th scope="col" className="rp-num">
                {t('reports.column.balance')}
              </th>
              <th scope="col">
                <span className="rp-sr">{t('reports.openEntry')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="rp-balance-row">
              <th scope="row" colSpan={6}>
                {t('reports.openingBalance')}
              </th>
              <td className="rp-num rp-money t-money">{formatMoney(view.openingMinor, currency)}</td>
              <td />
            </tr>
            {view.lines.map((line, index) => {
              const sourceKey = sourceLabelKey(line.source);
              return (
                <tr key={`${line.entryId}-${String(index)}`}>
                  <th scope="row" className="rp-numeric-cell">
                    {formatDate(line.date)}
                  </th>
                  <td>{line.ref ?? ''}</td>
                  <td className="rp-name">{line.description ?? ''}</td>
                  <td>{sourceKey === null ? '' : t(sourceKey)}</td>
                  <td className="rp-num rp-money t-money">
                    {line.debitMinor === 0 ? '' : formatMoney(line.debitMinor, currency)}
                  </td>
                  <td className="rp-num rp-money t-money">
                    {line.creditMinor === 0 ? '' : formatMoney(line.creditMinor, currency)}
                  </td>
                  <td className="rp-num rp-money t-money">{formatMoney(line.runningMinor, currency)}</td>
                  <td className="rp-row-action">
                    <button
                      type="button"
                      className="rp-drill"
                      onClick={() => onOpenEntry(line.entryId)}
                      aria-label={`${t('reports.openEntry')} ${formatDate(line.date)} ${line.description ?? ''}`}
                    >
                      <span aria-hidden="true">…</span>
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr className="rp-balance-row">
              <th scope="row" colSpan={6}>
                {t('reports.closingBalance')}
              </th>
              <td className="rp-num rp-money t-money">{formatMoney(view.closingMinor, currency)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {view.lines.length === 0 && <p className="rp-note">{t('reports.empty.ledgerNoMovement')}</p>}
    </section>
  );
}
