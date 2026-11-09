/**
 * R-S3, the Bilanz, and the note that keeps it honest (INV-5, owner decision R2, built as recommended).
 *
 * THE COVERAGE NOTE IS PERMANENT, and it is the reason this component exists in this shape. A08 §10
 * is explicit: `BILANZ_SECTIONS` models the seven first-level groupings and then emits raw account
 * lines ordered by account number. On the shipped Kontenrahmen KMU that reproduces the statutory
 * sequence BY COINCIDENCE, and "a workspace that renames or renumbers its chart gets a Bilanz that
 * names none of the required positions. No reconciliation flag can detect this, because the statement
 * still foots." The spec ends "A08 must not be described as implementing the OR Art. 959a minimum
 * structure", and a silent screen describes it as exactly that, by omission, to the one reader who
 * would act on it.
 *
 * Three reasons it is permanent rather than conditional: it is a property of the statement and not of
 * the data (`test/reports/or-structure.test.mjs` asserts 22 of the 24 statutory sub-positions are
 * unmodelled on every chart); the failure it warns about is undetectable from the figures, so the
 * only honest predicate is "always"; and the consequence is legal rather than cosmetic. It renders in
 * EVERY state of this statement including the zero one. One dimmed line, no banner, no warning
 * colour, no icon: nothing about it competes with the statement.
 *
 * ONE COLUMN, NOT TWO. The Kontoform (Aktiven left, Passiven right) is the classic printed shape and
 * it does not survive real data: on a KMU chart the Aktiven side commonly carries two or three times
 * the Passiven lines, so the right column ends while the left runs on. Balancing them would mean
 * padding one side with blank rows, which is worse. Aktiven then Passiven in one column, with both
 * grand totals side by side on one footer row where the identity they assert is visible at a glance.
 * That is also the shape that survives a narrow viewport with no second layout.
 *
 * THE TWO COMPUTED EQUITY LINES ARE FACTS WITH NO AFFORDANCE (R29). `ergebnisvortrag` and
 * `jahresergebnis` arrive with `account: null`, and the engine says why: "so a caller that tries to
 * drill into it gets nothing instead of a plausible wrong entry list". They have no link, no hover
 * state and no cursor change, and a `HelpHint` says they are computed from the result rather than
 * posted to an account. A row that is not a link is not a dead end; a row that looks like a link and
 * opens nothing is. They render their statutory POSITION NAMES from the engine's `labels`, never their
 * keys, and `statutoryWording` ("als Minusposten") is drafting instruction that appears on no Swiss
 * Bilanz and is therefore never rendered.
 *
 * ALL SEVEN SECTIONS RENDER, ALWAYS, INCLUDING AT ZERO. `BILANZ_SECTIONS.map` produces them
 * unconditionally, so the zero state is the same document with zeros in it, under a quiet band. The
 * sections do NOT collapse: a Bilanz with collapsed sections is a Bilanz with nothing on it.
 */
import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatMoney, formatDate } from '../../i18n';
import { HelpHint } from '../../components/HelpHint';
import { ChevronGlyph } from './glyphs';
import type { BalanceSheetSection, BalanceSheetView } from './model';

export interface BalanceSheetProps {
  view: BalanceSheetView;
  locale: 'de' | 'en';
  /**
   * Open that account's Kontoblatt for the fiscal year containing `asOf`, ENDING at `asOf` (R38).
   *
   * The end date is what matters: the Kontoblatt's Schlusssaldo is the cumulative net at `periodEnd`
   * whatever the start date is, so ending at `asOf` is what makes the figure the operator clicked
   * equal the figure they land on.
   */
  onDrill: (accountId: string) => void;
}

export function BalanceSheet({ view, locale, onDrill }: BalanceSheetProps) {
  const t = useT();
  const currency = view.baseCurrency;
  const comparing = view.compareTo !== undefined;
  // G13 (spec §6 safeguard 5): the archive comparative labels the COLUMN HEADER with the system
  // and covered range; an absent figure is a dash with its reason on hover, never a zero.
  const compareHead =
    view.comparative !== undefined
      ? t('reports.comparative.prior', {
          system: view.comparative.system ?? '?',
          from: view.comparative.coveredFrom ?? '?',
          to: view.comparative.coveredTo ?? '?',
        })
      : t('reports.compare.columnBalance', { date: formatDate(view.compareTo ?? '') });
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
  const label = (labels: { de: string; en: string }): string => (locale === 'de' ? labels.de : labels.en);

  const renderSide = (side: 'aktiven' | 'passiven') => (
    <tbody key={side}>
      <tr className="rp-side">
        <th scope="colgroup" colSpan={comparing ? 4 : 2}>
          {t(side === 'aktiven' ? 'reports.aktiven' : 'reports.passiven')}
        </th>
      </tr>
      {view.sections
        .filter((section) => section.side === side)
        .map((section) => renderSection(section))}
    </tbody>
  );

  const renderSection = (section: BalanceSheetSection) => (
    <Fragment key={section.key}>
      <tr className="rp-section">
        <th scope="row" colSpan={comparing ? 4 : 2}>
          {/*
            The statutory citation, in G17's structured mechanism (design §8d, the A08 migration):
            the old Tooltip trigger was a bare span with no tabindex, so a keyboard user could not
            reach the citation at all. The HelpHint glyph is a real button, and the article lives
            in the structured citation field where every other citation in the product lives.
          */}
          <span>{label(section.labels)}</span>
          <HelpHint
            label={t('reports.cite.citeLabel', { section: label(section.labels) })}
            title={label(section.labels)}
            body={t('reports.cite.citeBody')}
            articles={[section.cite]}
          />
        </th>
      </tr>
      {section.lines.map((line) => {
        const computed = line.account === null;
        const name = computed ? label(line.labels ?? { de: line.key, en: line.key }) : line.account?.name;
        return (
          <tr key={`${section.key}-${line.key}`} className={computed ? 'rp-line rp-line--computed' : 'rp-line'}>
            <th scope="row" className="rp-line-label">
              {computed ? (
                <>
                  <span>{name}</span>
                  <HelpHint
                    label={t('reports.computedEquity.label')}
                    title={t('reports.computedEquity.title')}
                    body={t('reports.computedEquity.hint')}
                  />
                </>
              ) : (
                <button
                  type="button"
                  className="rp-line-drill"
                  onClick={() => onDrill(line.account?.id ?? '')}
                  aria-label={t('reports.rowActionsFor', {
                    account: `${line.account?.number ?? ''} ${line.account?.name ?? ''}`,
                  })}
                >
                  <span className="rp-numeric-cell">{line.account?.number}</span>
                  <span>{name}</span>
                  <ChevronGlyph className="rp-line-chev" />
                </button>
              )}
            </th>
            <td className="rp-num rp-money t-money">{formatMoney(line.balanceMinor, currency)}</td>
            {comparing && (
              <>
                <td className="rp-num rp-money t-money">{compareCell(line.compareBalanceMinor)}</td>
                <td className="rp-num rp-money t-money">
                  {line.deltaMinor === undefined ? '' : formatMoney(line.deltaMinor, currency)}
                </td>
              </>
            )}
          </tr>
        );
      })}
      <tr className="rp-subtotal">
        <th scope="row">{t('reports.subtotal')}</th>
        <td className="rp-num rp-money t-money">{formatMoney(section.subtotalMinor, currency)}</td>
        {comparing && (
          <>
            <td className="rp-num rp-money t-money">{compareCell(section.compareSubtotalMinor)}</td>
            {/* Blank by design (INV-9, finding F4): the engine sends no delta here and this component
                will not subtract two figures in the browser to fill a cell. */}
            <td className="rp-num" />
          </>
        )}
      </tr>
    </Fragment>
  );

  return (
    <section className="rp-statement" aria-labelledby="rp-balance-heading">
      <h2 id="rp-balance-heading" className="rp-statement-title">
        {t('reports.heading.balanceSheet', { date: formatDate(view.asOf) })}
      </h2>
      <p className="rp-coverage">
        <span>{t('reports.balanceSheet.coverage')}</span>
        <HelpHint
          label={t('reports.balanceSheet.coverageLabel')}
          title={t('reports.balanceSheet.coverageTitle')}
          body={t('reports.balanceSheet.coverageHint')}
        />
      </p>

      {view.noActivity && (
        <div className="rp-zero-band" role="status">
          <span>{t('reports.empty.structure')}</span>
          <Link className="btn btn--secondary btn--sm" to="/journal">
            {t('reports.empty.structureAction')}
          </Link>
        </div>
      )}

      <div className="rp-table-wrap">
        <table className="rp-table rp-table--statement">
          <thead>
            <tr>
              <th scope="col">{t('reports.column.name')}</th>
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
            </tr>
          </thead>
          {renderSide('aktiven')}
          {renderSide('passiven')}
          <tfoot>
            <tr>
              <th scope="row">{t('reports.totalAktiven')}</th>
              <td className="rp-num rp-money t-money">{formatMoney(view.aktivenMinor, currency)}</td>
              {comparing && (
                <>
                  <td className="rp-num rp-money t-money">{compareCell(view.compareAktivenMinor)}</td>
                  <td className="rp-num" />
                </>
              )}
            </tr>
            <tr>
              <th scope="row">{t('reports.totalPassiven')}</th>
              <td className="rp-num rp-money t-money">{formatMoney(view.passivenMinor, currency)}</td>
              {comparing && (
                <>
                  <td className="rp-num rp-money t-money">{compareCell(view.comparePassivenMinor)}</td>
                  <td className="rp-num" />
                </>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
