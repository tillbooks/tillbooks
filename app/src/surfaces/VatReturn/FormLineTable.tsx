/**
 * The ESTV form, and S3, the Ziffer drill-down.
 *
 * THE WHOLE FORM RENDERS, not only the boxes with figures in them. The filer's task here is matching
 * this screen against a paper return, and a form showing only its filled-in boxes is not that form.
 * `form-lines.ts` holds the box list; the payload fills it in.
 *
 * THE ZERO RULE, AND ITS ONE EXCEPTION. The canon says a zero renders `-` and never a fabricated
 * figure. On a tax form that needs an exception, and it is stated once: DECLARED figures (289, 299,
 * 399, 479, 500) always render a number, including `CHF 0.00`, because a filer who sees `-` beside
 * "Zu bezahlender Betrag" cannot tell zero from unknown. DETAIL lines with no contributing entries
 * render `-`, which means "nothing of this kind happened", which is exactly what the canon wants.
 * The Saldo Steueranrechnung (470 / 471 / 479) is the one declared box that still renders `-`,
 * because TILL does not compute it at all and a nil there would be a claim nobody made.
 *
 * S3, THE DRILL-DOWN. A row with contributing entries carries a disclosure control that expands a
 * capped entry table IN PLACE. Expanding in place rather than navigating to the Journal is what
 * keeps the return the operator was checking on screen. Each entry row opens the Journal's own
 * `EntryDrawer` in view mode, which already exists and is not redesigned here.
 *
 * THE CAP IS 20 AND THERE IS NO "SHOW THE REST" LINK. The design wanted one into `/journal`
 * pre-filtered to the period. `Journal.tsx` holds its filters in local state only and accepts
 * nothing from the URL, so that link would land on an unfiltered list and quietly lose the filer's
 * place. A link that does not do what it says is worse than its absence, so the note names the count
 * and stops there.
 */
import { Fragment } from 'react';

import { useT, formatMoney, formatDate } from '../../i18n';
import { Skeleton } from '../../components/states';
import { ChevronGlyph } from './glyphs';
import type { FormRow, RenderedSection } from './model';

/** One contributing journal entry, as far as the drill-down needs it. */
export interface DrillEntry {
  id: string;
  date: string;
  ref: string | null;
  description: string | null;
}

export interface DrillState {
  loading: boolean;
  failed: boolean;
  entries: DrillEntry[];
  /** How many entries the Ziffer really has, which can exceed `entries.length`. */
  total: number;
}

export interface FormLineTableProps {
  sections: RenderedSection[];
  currency: string;
  /** The Ziffer currently expanded, or null. */
  expanded: string | null;
  drill: DrillState | null;
  onToggle: (code: string) => void;
  onOpenEntry: (entryId: string) => void;
  /** True on Saldo, where the Steueranrechnung footnote applies. */
  saldo: boolean;
}

/** `-` for an empty box: an en dash, which is what the rest of the Studio uses for absence. */
const DASH = '–';

function figure(value: number | null, currency: string): string {
  return value === null ? DASH : formatMoney(value, currency);
}

export function FormLineTable({
  sections,
  currency,
  expanded,
  drill,
  onToggle,
  onOpenEntry,
  saldo,
}: FormLineTableProps) {
  const t = useT();

  return (
    <div className="vr-form">
      {sections.map((section) => (
        <section className="vr-section panel" key={section.titleKey}>
          <h2 className="vr-section-title">{t(section.titleKey)}</h2>
          <table className="vr-table">
            <caption className="visually-hidden">{t(section.titleKey)}</caption>
            <thead>
              <tr>
                <th scope="col" className="vr-th-code">
                  {t('vat.return.col.ziffer')}
                </th>
                <th scope="col">{t('vat.return.col.label')}</th>
                <th scope="col" className="vr-num">
                  {t('vat.return.col.turnover')}
                </th>
                <th scope="col" className="vr-num">
                  {t('vat.return.col.tax')}
                </th>
              </tr>
            </thead>
            <tbody>
              <Rows
                rows={section.rows}
                currency={currency}
                expanded={expanded}
                drill={drill}
                onToggle={onToggle}
                onOpenEntry={onOpenEntry}
              />
              {section.subheadKey !== undefined && (
                <tr className="vr-subhead">
                  <th scope="colgroup" colSpan={4}>
                    {t(section.subheadKey)}
                  </th>
                </tr>
              )}
              <Rows
                rows={section.subRows}
                currency={currency}
                expanded={expanded}
                drill={drill}
                onToggle={onToggle}
                onOpenEntry={onOpenEntry}
              />
            </tbody>
          </table>
          {saldo && section.titleKey === 'vat.return.section.taxCredit' && (
            <p className="vr-footnote">{t('vat.return.taxCreditNote')}</p>
          )}
          {saldo && section.titleKey === 'vat.return.section.settlement' && (
            <p className="vr-footnote">{t('vat.return.saldoPayableNote')}</p>
          )}
        </section>
      ))}
    </div>
  );
}

function Rows({
  rows,
  currency,
  expanded,
  drill,
  onToggle,
  onOpenEntry,
}: {
  rows: FormRow[];
  currency: string;
  expanded: string | null;
  drill: DrillState | null;
  onToggle: (code: string) => void;
  onOpenEntry: (entryId: string) => void;
}) {
  const t = useT();

  return (
    <>
      {rows.map((row) => {
        const drillable = row.entryIds.length > 0;
        const open = expanded === row.code;
        return (
          <Fragment key={`${row.code}-${row.legacy ? 'legacy' : 'current'}`}>
            <tr className={row.declared === true ? 'vr-row vr-row--total' : 'vr-row'}>
              <th scope="row" className="vr-th-code">
                {row.code}
              </th>
              <td className="vr-label">
                {row.label}
                {drillable && (
                  <button
                    type="button"
                    className="vr-drill"
                    aria-expanded={open}
                    onClick={() => onToggle(row.code)}
                  >
                    <span className="visually-hidden">{t('vat.return.drill', { ziffer: row.code })}</span>
                    <ChevronGlyph className={open ? 'vr-chevron vr-chevron--open' : 'vr-chevron'} />
                  </button>
                )}
              </td>
              <td className="vr-num t-money">{figure(row.baseMinor, currency)}</td>
              <td className="vr-num t-money">{figure(row.taxMinor, currency)}</td>
            </tr>
            {open && (
              <tr className="vr-drill-row">
                <td colSpan={4}>
                  <DrillPanel
                    drill={drill}
                    known={row.entryIds.length}
                    onOpenEntry={onOpenEntry}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function DrillPanel({
  drill,
  known,
  onOpenEntry,
}: {
  drill: DrillState | null;
  known: number;
  onOpenEntry: (entryId: string) => void;
}) {
  const t = useT();
  if (drill === null || drill.loading) return <Skeleton rows={3} height={24} />;
  if (drill.failed) return <p className="vr-drill-error">{t('vat.return.drillFailed')}</p>;

  return (
    <>
      <ul className="vr-drill-list">
        {drill.entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="vr-drill-entry" onClick={() => onOpenEntry(entry.id)}>
              <span className="vr-drill-date">{formatDate(entry.date)}</span>
              <span className="vr-drill-ref">{entry.ref ?? entry.description ?? entry.id}</span>
            </button>
          </li>
        ))}
      </ul>
      {known > drill.entries.length && (
        <p className="vr-drill-more">{t('vat.return.drillCapped', { count: known, shown: drill.entries.length })}</p>
      )}
    </>
  );
}
