/**
 * A25 decision D115 (coverage = 2a): the sticky header line on Review.
 *
 * It carries the counts ("142/150 freigegeben, 3 markiert, 5 offen"), a coverage meter, "Alle
 * freigeben" while entries are open, and Periode sperren. The lock decision needs the numbers in view
 * at row 148, not only at row 3, so this bar sticks, and it is ONE line (D152).
 *
 * D152 rule 3 (one action, one place; absent rather than disabled): Periode sperren is PRESENT only
 * when it can act, i.e. the period is clean (0 offen AND 0 markiert), the actor holds A03's
 * `manage_periods` (the F5 padlock idiom: absent without the right, never disabled-then-refused) and
 * the period is not already hard-locked (the locked banner says so). The counts beside it already say
 * why it is missing; the condition sentence sits behind an (i) at the end of the counts (rule 4: the
 * shared Tooltip on an icon button, the sentence named by `aria-describedby`), so the reason is one
 * hover or focus away, never a three-line paragraph at rest.
 *
 * The counts are glyph PLUS text; approved rides `--t-success`, open and flagged ride neutral ink,
 * never a second accent (D115, DESIGN.md).
 */
import { useT } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { InfoGlyph } from '../../components/states/glyphs';
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

/**
 * Why Periode sperren is not on the bar, as the sentence(s) the (i) holds, or null when the lock is
 * offered (or the period is already locked, which the locked banner says on its own). Both missing
 * conditions are named when both apply, the period first: that is the one the reviewer can act on.
 */
export function lockCondition(
  t: ReturnType<typeof useT>,
  { clean, locked, canManagePeriods }: { clean: boolean; locked: boolean; canManagePeriods: boolean },
): string | null {
  if (locked) return null;
  const reasons: string[] = [];
  if (!clean) reasons.push(t('review.lock.notClean'));
  if (!canManagePeriods) reasons.push(t('review.lock.needsManagePeriods'));
  return reasons.length === 0 ? null : reasons.join(' ');
}

export function CoverageBar({ status, locked, canManagePeriods, approvingAll = false, onApproveAll, onLock }: CoverageBarProps) {
  const t = useT();
  const clean = status.open === 0 && status.flagged === 0;
  const pct = status.total === 0 ? 0 : Math.round((status.approved / status.total) * 100);
  const condition = lockCondition(t, { clean, locked, canManagePeriods });
  const canLock = !locked && clean && canManagePeriods;
  const offerApproveAll = !locked && status.open > 0 && onApproveAll !== undefined;

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
        {condition !== null && (
          <span className="rv-lock-info">
            <Tooltip placement="bottom" content={condition}>
              <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={t('review.lock.info')}>
                <InfoGlyph size={16} />
              </button>
            </Tooltip>
          </span>
        )}
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

      {(offerApproveAll || canLock) && (
        <div className="rv-coverage-lock">
          {offerApproveAll && (
            <button type="button" className="btn btn--secondary rv-action" disabled={approvingAll} onClick={onApproveAll}>
              {approvingAll ? t('review.approveAll.working') : t('review.approveAll.action', { count: String(status.open) })}
            </button>
          )}
          {canLock && (
            <button type="button" className="btn btn--secondary rv-action" onClick={onLock}>
              {t('review.lockPeriod')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
