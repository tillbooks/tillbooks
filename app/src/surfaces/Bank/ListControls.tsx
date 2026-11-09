/**
 * D178 N3 (A39 §20.4): the /bank list's own controls, beside the tabs: the Zeitraum (from, to), the money's
 * direction as a segmented control (Alle, Gutschriften, Belastungen) with the engine's counts per direction,
 * and the honest count with paging past 200.
 *
 * EVERY COUNT IS THE ENGINE'S (A39 §17.6). `list_bank_inbox` answers `total` (every active filter, the
 * direction included, across all pages) and `directionCounts` (the same filters WITHOUT the direction), so a
 * chip says what choosing it would list, and "1 bis 200 von 437" is the whole filtered list, never the
 * loaded page. The Studio narrows nothing itself.
 */
import { useId } from 'react';

import { useT } from '../../i18n';
import { Segmented } from '../../components/Segmented';

export type DirectionValue = 'all' | 'in' | 'out';

/** A booking date as the engine takes it (`YYYY-MM-DD`), or null for anything else. */
export function isoDateOrNull(raw: string | null | undefined): string | null {
  return raw !== null && raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** True when both ends are set and the start lies after the end: nothing is asked then. */
export function periodInverted(from: string | null, to: string | null): boolean {
  return from !== null && to !== null && from > to;
}

export function PeriodFilter({ from, to, onChange }: { from: string | null; to: string | null; onChange: (from: string | null, to: string | null) => void }) {
  const t = useT();
  const id = useId();
  const inverted = periodInverted(from, to);
  return (
    <fieldset className="bank-period" data-invalid={inverted ? 'true' : undefined}>
      <legend className="visually-hidden">{t('bankInbox.period.legend')}</legend>
      <label className="bank-period__field" htmlFor={`${id}-from`}>
        <span className="bank-period__label">{t('bankInbox.period.from')}</span>
        <input
          id={`${id}-from`}
          type="date"
          className="field t-num bank-period__input"
          value={from ?? ''}
          max={to ?? undefined}
          aria-invalid={inverted || undefined}
          aria-describedby={inverted ? `${id}-why` : undefined}
          onChange={(e) => onChange(isoDateOrNull(e.target.value), to)}
        />
      </label>
      <label className="bank-period__field" htmlFor={`${id}-to`}>
        <span className="bank-period__label">{t('bankInbox.period.to')}</span>
        <input
          id={`${id}-to`}
          type="date"
          className="field t-num bank-period__input"
          value={to ?? ''}
          min={from ?? undefined}
          aria-invalid={inverted || undefined}
          aria-describedby={inverted ? `${id}-why` : undefined}
          onChange={(e) => onChange(from, isoDateOrNull(e.target.value))}
        />
      </label>
      {inverted && (
        <span id={`${id}-why`} className="bank-period__why" role="status">
          {t('bankInbox.period.inverted')}
        </span>
      )}
    </fieldset>
  );
}

export function DirectionFilter({ value, counts, onChange }: { value: DirectionValue; counts: { in: number; out: number } | null; onChange: (next: DirectionValue) => void }) {
  const t = useT();
  const label = (key: 'in' | 'out') => (counts === null ? t(`bankInbox.direction.${key}`) : t(`bankInbox.direction.${key}Count`, { count: counts[key] }));
  return (
    <Segmented<DirectionValue>
      className="bank-direction"
      label={t('bankInbox.direction.label')}
      options={[
        { value: 'all', label: counts === null ? t('bankInbox.direction.all') : t('bankInbox.direction.allCount', { count: counts.in + counts.out }) },
        { value: 'in', label: label('in') },
        { value: 'out', label: label('out') },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** The page the list shows: `offset` lines skipped, `shown` on screen, `total` matching every filter. */
export interface PageView {
  /** How many lines the earlier pages showed (the first line of this page is `offset + 1`). */
  offset: number;
  shown: number;
  total: number;
  pageSize: number;
  /** The engine said more lines follow (a next cursor on some status read). */
  more: boolean;
}

export function ListCount({ view, onPrevious, onNext }: { view: PageView; onPrevious: () => void; onNext: () => void }) {
  const t = useT();
  const { offset, shown, total, pageSize, more } = view;
  const paged = offset > 0 || more || total > pageSize;
  return (
    <div className="bank-count" data-paged={paged ? 'true' : undefined}>
      <span className="bank-count__text t-num" role="status" aria-live="polite">
        {!paged
          ? t(total === 1 ? 'bankInbox.count.one' : 'bankInbox.count.other', { count: total })
          : t('bankInbox.count.range', { first: shown === 0 ? 0 : offset + 1, last: offset + shown, total })}
      </span>
      {paged && (
        <span className="bank-count__pages">
          <button type="button" className="btn btn--ghost btn--sm" disabled={offset === 0} onClick={onPrevious}>
            {t('bankInbox.count.previous')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!more && offset + shown >= total} onClick={onNext}>
            {t('bankInbox.count.next')}
          </button>
        </span>
      )}
    </div>
  );
}
