/**
 * S2, the Periodenwähler.
 *
 * RECOGNITION OVER RECALL, STRUCTURALLY. The list comes from `vat_periods`, so the operator picks a
 * real period and can never type `2026-Q5` or a period their workspace's cadence does not have. The
 * engine emits quarters under effektiv and halves under Saldo, and the picker renders exactly what
 * it is given: constructing periods client-side from a hardcoded quarter assumption is how an
 * annual filer ends up looking at four boxes their ESTV approval does not contain.
 *
 * THE CADENCE LIST IS SHORTER THAN THE LAW. `listVatPeriods` emits `YYYY-Qn` and `YYYY-Hn` only.
 * MWSTG Art. 35 Abs. 1bis has allowed monthly and annual filing on application to the ESTV since
 * 1.1.2025, and A05 stores no elected-frequency field, so neither can be derived. The engine says so
 * in its own header rather than guessing, and the picker inherits that: a monthly or annual filer
 * cannot pick their period here at all. It is an engine gap, reported, not something a picker can
 * paper over.
 *
 * WHY THIS IS NOT A `<select>`. Each row carries three facts (the label, the date range and the
 * status) and the status has to be a WORD beside a glyph rather than a colour. A native select
 * holds one string per option, so the status would have to be crammed into the label or dropped. It
 * is a listbox-shaped menu instead, built the way the rest of the Studio builds its menus.
 */
import { useEffect, useRef, useState } from 'react';

import { useT, formatDate } from '../../i18n';
import { Skeleton } from '../../components/states';
import { LockGlyph } from './glyphs';
import { periodTitle, statusOf, todayIso, type VatPeriod } from './model';

export interface PeriodPickerProps {
  periods: VatPeriod[];
  loading: boolean;
  failed: boolean;
  selected: string | null;
  onSelect: (label: string) => void;
  onRetry: () => void;
}

export function PeriodPicker({ periods, loading, failed, selected, onSelect, onRetry }: PeriodPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const today = todayIso();

  useEffect(() => {
    if (!open) return undefined;
    const onDocument = (event: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocument);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocument);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = selected === null ? t('vat.return.pickPeriod') : periodTitle(selected);

  return (
    <div className="vr-picker" ref={wrapRef}>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {t('vat.return.periodTrigger', { period: label })}
      </button>
      {open && (
        <div className="vr-picker-pop panel" role="menu" aria-label={t('vat.return.periodMenu')}>
          {loading && <Skeleton rows={3} height={24} />}
          {/* Never an empty dropdown: an error row with a retry, because a blank menu reads as
              "there is nothing to pick" and sends the operator looking in the wrong place. */}
          {!loading && failed && (
            <div className="vr-picker-error">
              <p>{t('vat.return.periodsFailed')}</p>
              <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
                {t('states.error.retry')}
              </button>
            </div>
          )}
          {!loading && !failed && periods.length === 0 && (
            <div className="vr-picker-empty">
              <p>{t('vat.return.periods.empty')}</p>
              <p className="vr-picker-hint">{t('vat.return.periods.emptyHint')}</p>
            </div>
          )}
          {!loading && !failed && periods.length > 0 && (
            // `role="none"` on the list scaffolding: a `menu` OWNS its `menuitem*` children, and an
            // intervening `ul`/`li` breaks that ownership (axe `aria-required-children` and
            // `aria-required-parent`). Making the wrappers presentational keeps the list semantics
            // out of the way without giving up the markup the CSS hangs on.
            <ul className="vr-picker-list" role="none">
              {periods.map((period) => {
                const status = statusOf(period, today);
                return (
                  <li key={period.label} role="none">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={period.label === selected}
                      className="vr-picker-item"
                      onClick={() => {
                        onSelect(period.label);
                        setOpen(false);
                      }}
                    >
                      <span className="vr-picker-label">{periodTitle(period.label)}</span>
                      <span className="vr-picker-range">
                        {formatDate(period.periodStart)} {t('vat.return.rangeTo')} {formatDate(period.periodEnd)}
                      </span>
                      {/* Status is a WORD, and the filed rows carry a lock glyph beside it. Never
                          colour alone. */}
                      <span className="vr-picker-status">
                        {status === 'filed' && <LockGlyph size={14} />}
                        {t(`vat.return.period.${status}`)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
