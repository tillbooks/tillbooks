/**
 * The period control both A25 screens share: a granularity toggle (Monat / Jahr) and the matching
 * picker, a month input or a year input. It emits the period string the engine parses (`YYYY-MM` or
 * `YYYY`, the two shapes `parseReviewPeriod` accepts; no quarter, per D115).
 *
 * These are STANDALONE controls, so they sit in the 44px tap-target tier (D116). Each carries a
 * visible, persistent label; the toggle is a real radio group so a keyboard and a screen reader move
 * through it.
 */
import { useT } from '../../i18n';
import type { Granularity } from './model';

export interface PeriodFieldProps {
  granularity: Granularity;
  month: string;
  year: string;
  onGranularity: (g: Granularity) => void;
  onMonth: (v: string) => void;
  onYear: (v: string) => void;
}

export function PeriodField({
  granularity,
  month,
  year,
  onGranularity,
  onMonth,
  onYear,
}: PeriodFieldProps) {
  const t = useT();
  return (
    <div className="rv-period">
      <div
        className="rv-period-toggle"
        role="radiogroup"
        aria-label={t('review.period.granularity')}
      >
        <button
          type="button"
          role="radio"
          aria-checked={granularity === 'month'}
          className={`rv-seg ${granularity === 'month' ? 'rv-seg--on' : ''}`}
          onClick={() => onGranularity('month')}
        >
          {t('review.period.month')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={granularity === 'year'}
          className={`rv-seg ${granularity === 'year' ? 'rv-seg--on' : ''}`}
          onClick={() => onGranularity('year')}
        >
          {t('review.period.year')}
        </button>
      </div>

      {granularity === 'month' ? (
        <label className="rv-period-input">
          <span className="visually-hidden">{t('review.period.monthLabel')}</span>
          <input
            type="month"
            className="rv-input"
            value={month}
            max="2999-12"
            onChange={(e) => onMonth(e.target.value)}
          />
        </label>
      ) : (
        <label className="rv-period-input">
          <span className="visually-hidden">{t('review.period.yearLabel')}</span>
          <input
            type="number"
            className="rv-input rv-input--year"
            value={year}
            min={2000}
            max={2999}
            step={1}
            onChange={(e) => onYear(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}
