/**
 * A25 decision D115 (coverage = 2a): the sticky header line on Review.
 *
 * It carries the counts ("142/150 freigegeben, 3 markiert, 5 offen"), a coverage meter, and the
 * Periode-sperren button, which is DISABLED until the period is clean (0 open AND 0 flagged): the
 * lock decision needs the numbers in view at row 148, not only at row 3, so this bar sticks.
 *
 * Locking additionally needs A03's `manage_periods`; without it the button stays visible but disabled
 * with its reason named inline (never shown-then-rejected, never a hover-only tooltip). The counts are
 * glyph PLUS text; approved rides `--t-success`, open and flagged ride neutral ink, never a second
 * accent (D115, DESIGN.md).
 */
import { useT } from '../../i18n';
import { CheckGlyph, DotGlyph, FlagGlyph } from './glyphs';
import type { ReviewStatus } from './model';

export interface CoverageBarProps {
  status: ReviewStatus;
  locked: boolean;
  canManagePeriods: boolean;
  /** "Alle freigeben" in flight: the control waits rather than firing a second sweep. */
  approvingAll?: boolean;
  /** Offered while entries are open (J4.3: one act for the unflagged rest). Absent on a locked period. */
  onApproveAll?: () => void;
  onLock: () => void;
}

export function CoverageBar({ status, locked, canManagePeriods, approvingAll = false, onApproveAll, onLock }: CoverageBarProps) {
  const t = useT();
  const clean = status.open === 0 && status.flagged === 0;
  const pct = status.total === 0 ? 0 : Math.round((status.approved / status.total) * 100);
  // The button's disabled reason, most specific first: already locked, then the missing right, then
  // the not-clean case. One sentence, rendered beside the control (D15/C3), never a bare grey.
  const reason = locked
    ? t('review.lock.alreadyLocked')
    : !canManagePeriods
      ? t('review.lock.needsManagePeriods')
      : !clean
        ? t('review.lock.notClean')
        : null;

  return (
    <div className="rv-coverage panel" role="group" aria-label={t('review.coverage')}>
      <div className="rv-coverage-counts">
        <span className="rv-count rv-count--approved">
          <CheckGlyph size={16} className="rv-count-glyph" aria-hidden="true" />
          <span className="rv-count-figure">
            {status.approved}/{status.total}
          </span>
          <span>{t('review.status.approved')}</span>
        </span>
        <span className="rv-count-sep" aria-hidden="true">
          &middot;
        </span>
        <span className="rv-count">
          <FlagGlyph size={16} className="rv-count-glyph" aria-hidden="true" />
          <span className="rv-count-figure">{status.flagged}</span>
          <span>{t('review.status.flagged')}</span>
        </span>
        <span className="rv-count-sep" aria-hidden="true">
          &middot;
        </span>
        <span className="rv-count">
          <DotGlyph size={16} className="rv-count-glyph" aria-hidden="true" />
          <span className="rv-count-figure">{status.open}</span>
          <span>{t('review.status.open')}</span>
        </span>
      </div>

      <div
        className="rv-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t('review.coverage')}
      >
        <span className="rv-meter-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="rv-coverage-lock">
        {!locked && status.open > 0 && onApproveAll !== undefined && (
          <button type="button" className="btn btn--secondary rv-action" disabled={approvingAll} onClick={onApproveAll}>
            {approvingAll ? t('review.approveAll.working') : t('review.approveAll.action', { count: String(status.open) })}
          </button>
        )}
        <button
          type="button"
          className="btn btn--secondary rv-action"
          disabled={locked || !canManagePeriods || !clean}
          onClick={onLock}
        >
          {locked ? t('review.lock.locked') : t('review.lockPeriod')}
        </button>
        {reason !== null && <p className="rv-lock-reason">{reason}</p>}
      </div>
    </div>
  );
}
