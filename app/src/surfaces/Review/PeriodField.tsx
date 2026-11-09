/**
 * The period control both A25 screens share: a granularity toggle (Monat / Jahr) and the matching
 * picker, a month input or a year input. It emits the period string the engine parses (`YYYY-MM` or
 * `YYYY`, the two shapes `parseReviewPeriod` accepts; no quarter, per D115).
 *
 * The toggle is the shared Segmented (K-11, D137: it replaced the hand-rolled `.rv-seg` family), a
 * real radio group a keyboard and a screen reader move through; the picker is a `.field` (K-15).
 */
import { useT } from '../../i18n';
import { Segmented } from '../../components/Segmented';
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
      <Segmented<Granularity>
        label={t('review.period.granularity')}
        options={[
          { value: 'month', label: t('review.period.month') },
          { value: 'year', label: t('review.period.year') },
        ]}
        value={granularity}
        onChange={onGranularity}
      />

      {granularity === 'month' ? (
        <label className="rv-period-input">
          <span className="visually-hidden">{t('review.period.monthLabel')}</span>
          <input
            type="month"
            className="field rv-period-value"
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
            className="field rv-period-value rv-period-year"
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
