/**
 * R-S2, the Saldenbilanz: every account that carries something, with the movement that produced it
 * and the proof that Soll equals Haben.
 *
 * THE CLASS HEADERS ARE THE ENGINE'S OWN, not this component's. `groupByKmuClass` returns one bucket
 * per KMU leading digit with its labels, its account numbers and its `debitMinor`, `creditMinor` and
 * `closingMinor` subtotals. Those subtotals are rendered, never re-added in the browser. The header's
 * Eröffnung cell renders a dash because the bucket carries NO `openingMinor` (finding F6): a dash
 * beside three real figures is honest, and a computed fourth would be the browser doing arithmetic on
 * money.
 *
 * THE TOTAL ROW'S Eröffnung AND Saldo ARE STRUCTURALLY ZERO, and this says so rather than letting it
 * look broken. `computeTrialBalance` accumulates both as `debit - credit` summed over every account,
 * so in any book that balances both are exactly `0.00`. Rendering them blank was considered and
 * rejected: `0.00` there is a real result, and hiding a real result to avoid explaining it is the
 * opposite of data honesty. A NON-ZERO figure in either cell is a genuine alarm, and it is exactly
 * what `debitEqualsCredit` and `closingTiesToLedger` are for.
 *
 * A ROW DRILLS TO AN ACCOUNT, NOT TO AN ENTRY. Only the Kontoblatt carries `entryId`
 * (`statements.ts:854`); a trial-balance row carries `account` and nothing else. So the row opens
 * that account's Kontoblatt for the same period, which is the honest one-hop path and the one
 * US-A08.1 actually describes. The chevron is PERSISTENT, never a hover reveal.
 *
 * ACCOUNT NAMES RENDER IN FULL. They are chart data, not labels this surface owns: the KMU seed's own
 * name for 1100 runs to 41 characters. The Bezeichnung column takes the remaining width and WRAPS
 * rather than truncating, because an operator who follows a row into `/accounts` has to find the name
 * they just read.
 *
 * THE EMPTY STATE IS A PANEL, and this is the one report where that is right. The engine skips any
 * account that neither moved nor carries a balance, so an empty Saldenbilanz has literally nothing to
 * draw. The Bilanz and the Erfolgsrechnung do render their structure at zero, and their copy differs
 * from this one's for exactly that reason.
 */
import { useState } from 'react';

import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState } from '../../components/states';
import { HelpHint } from '../../components/HelpHint';
import { ChevronGlyph } from './glyphs';
import type { KmuGroup, TrialBalanceRow, TrialBalanceView } from './model';

export interface TrialBalanceProps {
  view: TrialBalanceView;
  locale: 'de' | 'en';
  /** Open that account's Kontoblatt for the same period, in place (R27). */
  onDrill: (accountId: string) => void;
}

/** The rows of one class bucket, in the engine's own chart order. */
function rowsOf(view: TrialBalanceView, group: KmuGroup): TrialBalanceRow[] {
  const numbers = new Set(group.accounts);
  return view.rows.filter((row) => numbers.has(row.account.number));
}

export function TrialBalance({ view, locale, onDrill }: TrialBalanceProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const currency = view.baseCurrency;
  const comparing = view.compareTo !== undefined;
  // G13: with an archive comparative, the column header carries the Vorsystem label and covered
  // range ITSELF (spec §6 safeguard 5), and an absent figure renders a dash with its reason on
  // hover, never a zero and never an empty cell that could read as one.
  const compareHead =
    view.comparative !== undefined
      ? t('reports.comparative.prior', {
          system: view.comparative.system ?? '?',
          from: view.comparative.coveredFrom ?? '?',
          to: view.comparative.coveredTo ?? '?',
        })
      : t('reports.compare.columnBalance', { date: formatDate(view.compareTo?.end ?? '') });
  const compareCell = (value: number | undefined) =>
    value !== undefined ? (
      formatMoney(value, currency)
    ) : view.comparative === undefined ? (
      ''
    ) : (
      <span
        title={
          view.comparative.status === 'partial'
            ? t('reports.comparative.partialPeriod')
            : t('reports.comparative.noData')
        }
      >
        {'\u2013'}
      </span>
    );

  if (view.rows.length === 0) {
    return (
      <EmptyState
        title={t('reports.tab.trialBalance')}
        hint={t('reports.empty.trialBalance')}
        action={{ label: t('reports.empty.trialBalanceAction'), to: '/journal' }}
      />
    );
  }

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="rp-table-wrap">
      <table className="rp-table">
        <caption className="rp-sr">
          {t('reports.heading.trialBalance', {
            from: formatDate(view.period.start),
            to: formatDate(view.period.end),
          })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.column.number')}</th>
            <th scope="col">{t('reports.column.name')}</th>
            <th scope="col" className="rp-num">
              {t('reports.column.opening')}
            </th>
            <th scope="col" className="rp-num">
              {t('reports.column.debit')}
            </th>
            <th scope="col" className="rp-num">
              {t('reports.column.credit')}
            </th>
            <th scope="col" className="rp-num">
              {t('reports.column.balance')}
            </th>
            {comparing && (
              <>
                <th scope="col" className="rp-num">
                  {compareHead}
                </th>
                <th scope="col" className="rp-num">
                  {t('reports.delta')}
                </th>
              </>
            )}
            <th scope="col">
              <span className="rp-sr">{t('reports.account')}</span>
            </th>
          </tr>
        </thead>
        {view.groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          const label = locale === 'de' ? group.labels.de : group.labels.en;
          return (
            <tbody key={group.key}>
              <tr className="rp-group">
                <th scope="colgroup" colSpan={2}>
                  <button
                    type="button"
                    className="rp-collapse"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group.key)}
                  >
                    <ChevronGlyph className={`rp-chev${isCollapsed ? '' : ' rp-chev--open'}`} />
                    <span>{label}</span>
                  </button>
                  {group.key === '?' && (
                    <HelpHint
                      label={t('reports.kmuClass.unclassifiedLabel')}
                      title={t('reports.kmuClass.unclassifiedTitle')}
                      body={t('reports.kmuClass.unclassifiedHint')}
                    />
                  )}
                </th>
                {/* No `openingMinor` on a bucket (F6): a dash, never a figure this component added. */}
                <td className="rp-num rp-dim">{t('reports.noOpening')}</td>
                <td className="rp-num rp-money">{formatMoney(group.debitMinor, currency)}</td>
                <td className="rp-num rp-money">{formatMoney(group.creditMinor, currency)}</td>
                <td className="rp-num rp-money">{formatMoney(group.closingMinor, currency)}</td>
                {comparing && (
                  <>
                    <td className="rp-num" />
                    <td className="rp-num" />
                  </>
                )}
                <td />
              </tr>
              {!isCollapsed &&
                rowsOf(view, group).map((row) => (
                  <tr key={row.account.id}>
                    <th scope="row" className="rp-numeric-cell">
                      {row.account.number}
                    </th>
                    <td className="rp-name">{row.account.name}</td>
                    <td className="rp-num rp-money">{formatMoney(row.openingMinor, currency)}</td>
                    <td className="rp-num rp-money">{formatMoney(row.debitMinor, currency)}</td>
                    <td className="rp-num rp-money">{formatMoney(row.creditMinor, currency)}</td>
                    <td className="rp-num rp-money">{formatMoney(row.closingMinor, currency)}</td>
                    {comparing && (
                      <>
                        <td className="rp-num rp-money">{compareCell(row.compareClosingMinor)}</td>
                        <td className="rp-num rp-money">
                          {row.deltaMinor === undefined ? '' : formatMoney(row.deltaMinor, currency)}
                        </td>
                      </>
                    )}
                    <td className="rp-row-action">
                      <button
                        type="button"
                        className="rp-drill"
                        onClick={() => onDrill(row.account.id)}
                        aria-label={t('reports.rowActionsFor', {
                          account: `${row.account.number} ${row.account.name}`,
                        })}
                      >
                        <ChevronGlyph />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          );
        })}
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              {t('reports.total')}
              <HelpHint
                label={t('reports.trialBalance.totalsLabel')}
                title={t('reports.trialBalance.totalsTitle')}
                body={t('reports.trialBalance.totalsNetToZero')}
                placement="top"
              />
            </th>
            <td className="rp-num rp-money">{formatMoney(view.totals.openingMinor, currency)}</td>
            <td className="rp-num rp-money">{formatMoney(view.totals.debitMinor, currency)}</td>
            <td className="rp-num rp-money">{formatMoney(view.totals.creditMinor, currency)}</td>
            <td className="rp-num rp-money">{formatMoney(view.totals.closingMinor, currency)}</td>
            {comparing && (
              <>
                <td className="rp-num" />
                <td className="rp-num" />
              </>
            )}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
