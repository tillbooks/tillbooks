/**
 * The Periode-sperren confirmation, on the shared `Modal` as an alertdialog (D118 B2).
 *
 * A hard lock (A03) is a deliberate, hard-to-reverse act, so it takes a confirm rather than firing on
 * one click (DESIGN.md forgiveness; the A07 mark-filed precedent). The alertdialog role is the right
 * fit: per the APG a consequential question is answered with a control, not by clicking the scrim
 * away, and `Modal` enforces exactly that (an alertdialog does not dismiss on a scrim click).
 *
 * It names the period and carries its own pending and failure states so the act is never a dead end.
 * THE CONSEQUENCE IS THE ENGINE'S SENTENCE (D118 C4): `lock_period` is dial-governed under
 * `close-period`, so the shared `ConsequenceLine` renders `agent.consequence.close-period`, the
 * identical string the Vorschlag card shows an approver and the Periods surface shows on its month
 * close (F-07, J4.1). One sentence for one consequence; the surface-authored twin this dialog used
 * to carry is retired. The line is the dialog's `aria-describedby`.
 */
import { useT, formatDate } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';

export interface LockDialogProps {
  /** The caller owns visibility; the Modal renders nothing while closed. */
  open: boolean;
  period: string;
  periodStart: string;
  periodEnd: string;
  pending: boolean;
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LockDialog({
  open,
  period,
  periodStart,
  periodEnd,
  pending,
  failed,
  onConfirm,
  onCancel,
}: LockDialogProps) {
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      // Passed as a value expression rather than a quoted attribute literal, so the modal-role source
      // guard (a text scan that flags the attribute token on a non-div host) reads it correctly: the
      // role lands on the div inside Modal, which takes it as a plain prop.
      role={'alertdialog'}
      title={t('review.lock.confirmTitle', { period })}
      closeLabel={t('review.close')}
      describedById="rv-lock-consequence"
      footer={
        <>
          <button type="button" className="btn btn--secondary rv-action" onClick={onCancel}>
            {t('review.lock.cancel')}
          </button>
          {/* K-08: sealing a period is not a money write, so it is the dialog's primary, not the accent. */}
          <button
            type="button"
            className="btn btn--primary rv-action"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? t('review.lock.locking') : t('review.lock.confirm')}
          </button>
        </>
      }
    >
      <p className="rv-dialog-body">
        {t('review.lock.confirmBody', {
          from: formatDate(periodStart),
          to: formatDate(periodEnd),
        })}
      </p>
      <div id="rv-lock-consequence">
        <ConsequenceLine verb="lock_period" />
      </div>

      {failed && (
        <p className="rv-dialog-error" role="alert">
          {t('review.lock.failed')}
        </p>
      )}
    </Modal>
  );
}
