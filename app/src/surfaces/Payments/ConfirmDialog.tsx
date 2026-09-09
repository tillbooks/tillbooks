/**
 * The plain confirm dialog A14 uses for S8 (discard) and, wrapped, for S6 (Storno).
 *
 * This is the same shape as `surfaces/Accounts/ConfirmDialog.tsx`, which the design names as the
 * shared convention. It is re-declared here rather than imported for one reason worth stating: the
 * Accounts copy is another surface's file and this agent does not own it, so importing it would
 * couple two surfaces through a file neither of them owns. The markup, the roles and the button
 * variants are identical, so the two behave the same and either can be lifted into
 * `components/` later as one move.
 */
import { useId, type ReactNode } from 'react';

import { useT } from '../../i18n';

export interface ConfirmDialogProps {
  /** The confirmation question, already resolved. */
  message: string;
  /** Anything the decision needs beyond the question: a date field, a warning, a rejection. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for a reversal, `primary` for a neutral confirm. */
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  message,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const titleId = useId();

  return (
    <div className="pay-confirm-overlay" role="presentation" onClick={onCancel}>
      <div
        className="pay-confirm panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <p id={titleId} className="pay-confirm-message">
          {message}
        </p>
        {children}
        <div className="pay-confirm-foot">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {cancelLabel ?? t('payment.cancel')}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary'}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
