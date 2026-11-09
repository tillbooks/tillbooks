/**
 * The period control both A25 screens share: a granularity toggle (Monat / Jahr) and the matching
 * picker, a month input or a year input. It emits the period string the engine parses (`YYYY-MM` or
 * `YYYY`, the two shapes `parseReviewPeriod` accepts; no quarter, per D115).
 *
 * The toggle is the shared Segmented (K-11, D137: it replaced the hand-rolled `.rv-seg` family), a
 * real radio group a keyboard and a screen reader move through; the picker is a `.field` (K-15).
 *
 * D190 adds the Export page's two controls beside it: `RangeField` (Von, Bis and the quick picks, for the
 * journal and the statements) and `VatPeriodField` (the fixed MWST periods, for the MWST export). Review
 * keeps `PeriodField` unchanged: a review still runs over a lockable month or year.
 */
import { useT } from '../../i18n';
import { Segmented } from '../../components/Segmented';
import { isIsoDate, isoToday, rangeOfShape, shapeOfRange } from './model';
import type { DateRange, Granularity, RangeShape, VatGranularity, VatPeriodParts } from './model';

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

export interface RangeFieldProps {
  range: DateRange;
  onRange: (range: DateRange) => void;
}

/**
 * D190: the export's date range, Von and Bis (both inclusive), and the quick picks Monat / Quartal / Jahr
 * that fill both with the whole month, quarter or year around Von (today while Von is empty). A range that
 * is none of the three shows no pick as chosen. The engine is the judge of a bad range (it refuses by
 * name, and the page says so), so a half-typed date never blocks typing here.
 */
export function RangeField({ range, onRange }: RangeFieldProps) {
  const t = useT();
  const shape = shapeOfRange(range);
  const fill = (next: RangeShape) => {
    if (next === 'custom') return;
    onRange(rangeOfShape(next, isIsoDate(range.from) ? range.from : isoToday()));
  };
  return (
    <div className="rv-period ex-range">
      <label className="ex-range-bound">
        <span className="ex-range-word">{t('export.range.from')}</span>
        <input
          type="date"
          className="field rv-period-value ex-range-date"
          value={range.from}
          max="2999-12-31"
          onChange={(e) => onRange({ from: e.target.value, to: range.to })}
        />
      </label>
      <label className="ex-range-bound">
        <span className="ex-range-word">{t('export.range.to')}</span>
        <input
          type="date"
          className="field rv-period-value ex-range-date"
          value={range.to}
          max="2999-12-31"
          onChange={(e) => onRange({ from: range.from, to: e.target.value })}
        />
      </label>
      <Segmented<RangeShape>
        label={t('export.range.label')}
        options={[
          { value: 'month', label: t('export.range.month') },
          { value: 'quarter', label: t('export.range.quarter') },
          { value: 'year', label: t('export.range.year') },
        ]}
        value={shape}
        onChange={fill}
      />
    </div>
  );
}

export interface VatPeriodFieldProps {
  granularity: VatGranularity;
  parts: VatPeriodParts;
  onGranularity: (g: VatGranularity) => void;
  onParts: (parts: VatPeriodParts) => void;
}

/**
 * D190: the MWST period picker. MWST keeps its fixed periods (MWSTG Art. 35), so the MWST export shows this
 * instead of the range: Quartal (effektiv), Halbjahr (Saldo), Monat or Jahr, emitting the label
 * `export_vat` parses (`2026-Q3`, `2026-H1`, `2026-07`, `2026`).
 */
export function VatPeriodField({ granularity, parts, onGranularity, onParts }: VatPeriodFieldProps) {
  const t = useT();
  const yearInput = (
    <label className="rv-period-input">
      <span className="visually-hidden">{t('export.vatPeriod.yearLabel')}</span>
      <input
        type="number"
        className="field rv-period-value rv-period-year"
        value={parts.year}
        min={1995}
        max={2999}
        step={1}
        onChange={(e) => onParts({ ...parts, year: e.target.value })}
      />
    </label>
  );
  return (
    <div className="rv-period">
      <Segmented<VatGranularity>
        label={t('export.vatPeriod.granularity')}
        options={[
          { value: 'quarter', label: t('export.vatPeriod.quarter') },
          { value: 'half', label: t('export.vatPeriod.half') },
          { value: 'month', label: t('export.vatPeriod.month') },
          { value: 'year', label: t('export.vatPeriod.year') },
        ]}
        value={granularity}
        onChange={onGranularity}
      />
      {granularity === 'month' ? (
        <label className="rv-period-input">
          <span className="visually-hidden">{t('export.vatPeriod.monthLabel')}</span>
          <input
            type="month"
            className="field rv-period-value"
            value={parts.month}
            max="2999-12"
            onChange={(e) => onParts({ ...parts, month: e.target.value })}
          />
        </label>
      ) : (
        yearInput
      )}
      {granularity === 'quarter' && (
        <Segmented
          label={t('export.vatPeriod.quarterLabel')}
          options={['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ value: q, label: q }))}
          value={parts.quarter}
          onChange={(quarter) => onParts({ ...parts, quarter })}
        />
      )}
      {granularity === 'half' && (
        <Segmented
          label={t('export.vatPeriod.halfLabel')}
          options={['H1', 'H2'].map((h) => ({ value: h, label: h }))}
          value={parts.half}
          onChange={(half) => onParts({ ...parts, half })}
        />
      )}
    </div>
  );
}
