/**
 * R-S4, the Erfolgsrechnung, and the sign convention (INV-4, owner decision R1, built as recommended).
 *
 * THE LAYOUT IS FORCED BY THE LABELS, and this is not a small point. The statutory heading of
 * position 2 is "Bestandesänderungen an unfertigen und fertigen Erzeugnissen sowie an nicht
 * fakturierten Dienstleistungen": 129 characters. Position 6 runs to 79 and position 9 to 71. A
 * two-column table with a fixed label column cannot hold them, and truncating a statutory heading is
 * not an available outcome. So this is a full-width LIST with a wrapping label and one right-aligned
 * figure, not a table. The canon's "design for the longest language" rule usually means leaving 30%
 * slack; here it means choosing a different layout primitive, and the German label is the reason.
 *
 * INV-4, THE SIGN CONVENTION: signed contribution to profit, and NO flip. Every figure is the
 * engine's `credit - debit`: revenue positive, expense negative, the visible positions summing to the
 * stated Jahresgewinn. The engine offers `nature` on every section specifically so a GUI could flip
 * the display sign. This does not, for three reasons and the third is decisive:
 *
 *  1. THE COLUMN SUMS ON SCREEN. A reader can add the visible figures and reach the stated Jahresgewinn.
 *     Under a flip they cannot, and a statement whose own total does not follow from its own rows is
 *     one you have to trust rather than check.
 *  2. FIVE OF THE ELEVEN POSITIONS HAVE NO HONEST FLIP. `sections.ts` carries `nature: 'mixed'` on
 *     five (the engine's own docblock says three, counting statutory clauses rather than flags:
 *     finding F12). Each is a position OR Art. 959b writes as an Aufwand AND an Ertrag. A net
 *     Finanzergebnis of -900.00 is a cost this period and could be income next; there is no heading
 *     under which +900.00 is true.
 *  3. THE EXPORTED PDF IS SIGNED. `renderPdf` prints `money(section.subtotalMinor)` RAW, so flipping
 *     the screen would make the screen and the file disagree, and the whole architecture of the export
 *     exists to make that impossible ("the file and the screen cannot disagree"). Changing the screen
 *     alone would break the one guarantee this capability sells.
 *
 * COLOUR ON THE NEGATIVES. DESIGN.md gives negative money `--t-danger` "but only in the sign or a
 * glyph, never a filled red row". Under this convention EVERY expense line is negative, so colouring
 * them all would make red the background of the statement and dull the one figure that genuinely
 * needs attention. Ordinary negative positions render in `--t-text` with a minus sign, and
 * `--t-danger` is spent on exactly one figure: a negative result, which renders as JAHRESVERLUST
 * with its own word, its sign and its colour. One statement, one alarm, and a grayscale printout
 * still reads correctly because the word and the sign carry it.
 *
 * THE CLOSING WORD IS THE ENACTED ONE, RESOLVED BY SIGN, matching `export.ts` exactly: the payload
 * key is still `reingewinnMinor` and the message keys are still `reports.reingewinn`, but every
 * string a reader sees now says Jahresgewinn or Jahresverlust. The keys kept the old scheme on cost
 * grounds (nine consumers); the copy did not, because copy is what the reader checks the statute
 * against.
 *
 * THE POSITIONS COLLAPSE AND THE BILANZ'S SECTIONS DO NOT. The position subtotals ARE the statement;
 * the account lines are the working detail. A Bilanz with collapsed sections has nothing on it.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatMoney, formatDate } from '../../i18n';
import { HelpHint } from '../../components/HelpHint';
import { ChevronGlyph } from './glyphs';
import type { IncomeStatementView } from './model';

export interface IncomeStatementProps {
  view: IncomeStatementView;
  locale: 'de' | 'en';
  /** Open that account's Kontoblatt for the SAME period, which needs no derivation (R39). */
  onDrill: (accountId: string) => void;
}

export function IncomeStatement({ view, locale, onDrill }: IncomeStatementProps) {
  const t = useT();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const currency = view.baseCurrency;
  const comparing = view.compareTo !== undefined;
  // G13 (spec §6 safeguard 5): the archive comparative carries its Vorsystem label ON the surface
  // (the note under the heading names system and covered range), and an absent figure renders a
  // dash with its reason on hover, never a zero.
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
  const loss = view.reingewinnMinor < 0;
  // The closing word follows the SIGN, the way `erfolgsrechnungResultLabel` in `core/reports/export.ts`
  // does, because the file and the screen cannot disagree. Three branches and not two: exactly zero
  // keeps the enacted form whole, since a book that broke even made neither, and picking one would be
  // the heading claiming something the figure does not support. `loss` stays strictly `< 0` because it
  // also drives `--t-danger`, and a break-even statement is not an alarm.
  const brokeEven = view.reingewinnMinor === 0;
  const resultWord = brokeEven
    ? t('reports.reingewinnOderReinverlust')
    : loss
      ? t('reports.reinverlust')
      : t('reports.reingewinn');

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="rp-statement" aria-labelledby="rp-income-heading">
      <h2 id="rp-income-heading" className="rp-statement-title">
        {t('reports.heading.incomeStatement', {
          from: formatDate(view.period.start),
          to: formatDate(view.period.end),
        })}
      </h2>
      <p className="rp-sign-note">{t('reports.incomeStatement.signNote')}</p>
      {view.comparative !== undefined && (
        <p className="rp-sign-note" data-testid="rp-archive-compare-note">
          {t('reports.comparative.prior', {
            system: view.comparative.system ?? '?',
            from: view.comparative.coveredFrom ?? '?',
            to: view.comparative.coveredTo ?? '?',
          })}
        </p>
      )}

      {view.noActivity && (
        <div className="rp-zero-band" role="status">
          <span>{t('reports.empty.structure')}</span>
          <Link className="btn btn--secondary btn--sm" to="/journal">
            {t('reports.empty.structureAction')}
          </Link>
        </div>
      )}

      <ul className="rp-positions">
        {view.sections.map((section) => {
          const expanded = open.has(section.key);
          const heading = label(section.labels);
          return (
            <li key={section.key} className="rp-position">
              <div className="rp-position-head">
                <button
                  type="button"
                  className="rp-collapse rp-collapse--wide"
                  aria-expanded={expanded}
                  onClick={() => toggle(section.key)}
                >
                  <ChevronGlyph className={`rp-chev${expanded ? ' rp-chev--open' : ''}`} />
                  <span className="rp-position-label">{heading}</span>
                </button>
                {/*
                  The statutory citation, in G17's structured mechanism (design §8d, the A08
                  migration). It sat inside a Tooltip whose trigger was a span with no tabindex,
                  NESTED inside this collapse button: unreachable by keyboard twice over. The
                  HelpHint glyph is its own real button, OUTSIDE the collapse control, with the
                  article in the structured citation field.
                */}
                <HelpHint
                  label={t('reports.cite.citeLabel', { section: heading })}
                  title={heading}
                  body={t('reports.cite.citeBody')}
                  articles={[section.cite]}
                />
                <span className="rp-num rp-money rp-position-figure">
                  {formatMoney(section.subtotalMinor, currency)}
                </span>
                {comparing && (
                  <>
                    <span className="rp-num rp-money rp-position-figure">{compareCell(section.compareSubtotalMinor)}</span>
                    {/* Blank by design (INV-9, F4): the engine sends no subtotal delta and this
                        component will not subtract two figures in the browser to fill a cell. */}
                    <span className="rp-num rp-position-figure" />
                  </>
                )}
              </div>

              {expanded && (
                <ul className="rp-position-lines">
                  {section.lines.map((line) => (
                    <li key={line.key} className="rp-position-line">
                      <button
                        type="button"
                        className="rp-line-drill"
                        onClick={() => onDrill(line.account.id)}
                        aria-label={t('reports.rowActionsFor', {
                          account: `${line.account.number} ${line.account.name}`,
                        })}
                      >
                        <span className="rp-numeric-cell">{line.account.number}</span>
                        <span>{line.account.name}</span>
                        <ChevronGlyph className="rp-line-chev" />
                      </button>
                      <span className="rp-num rp-money rp-position-figure">
                        {formatMoney(line.amountMinor, currency)}
                      </span>
                      {comparing && (
                        <>
                          <span className="rp-num rp-money rp-position-figure">{compareCell(line.compareAmountMinor)}</span>
                          <span className="rp-num rp-money rp-position-figure">
                            {line.deltaMinor === undefined ? '' : formatMoney(line.deltaMinor, currency)}
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <p className={`rp-result${loss ? ' rp-result--loss' : ''}`}>
        <span className="rp-result-word">{resultWord}</span>
        <HelpHint
          label={t('reports.incomeStatement.closedYearLabel')}
          title={t('reports.incomeStatement.closedYearTitle')}
          body={t('reports.incomeStatement.closedYearHint')}
          placement="top"
        />
        <span className="rp-num rp-money rp-result-figure">{formatMoney(view.reingewinnMinor, currency)}</span>
        {comparing && (
          <span className="rp-num rp-money rp-result-figure">{compareCell(view.compareReingewinnMinor)}</span>
        )}
      </p>
    </section>
  );
}
