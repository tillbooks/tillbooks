/**
 * The shared destructive-confirm dialog (Tier-3 forgiveness, spec A01 §6).
 *
 * A hard delete never fires on a single click: it is gated behind a deliberate confirm step. The
 * dialog states what will happen and offers an explicit confirm plus a cancel out.
 */
import { useId } from 'react';

import { useT } from '../../i18n';

export interface ConfirmDialogProps {
  /** The confirmation question (already resolved copy). */
  message: string;
  /** Label for the destructive confirm button. */
  confirmLabel: string;
  /**
   * Label for the way out. Defaults to the shared "Abbrechen". Overridden where the safe choice has a
   * better name than a bare cancel: the unsaved-edit guard's out is "Weiter bearbeiten", which says
   * what happens instead of what does not.
   */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const t = useT();
  const titleId = useId();
  return (
    <div className="acc-confirm-overlay" role="presentation" onClick={onCancel}>
      <div
        className="acc-confirm panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <p id={titleId} className="acc-confirm-message">
          {message}
        </p>
        <div className="acc-confirm-foot">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {cancelLabel ?? t('account.cancel')}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
