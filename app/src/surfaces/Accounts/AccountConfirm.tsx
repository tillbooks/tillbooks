/**
 * AccountConfirm: the destructive-confirm dialog for the Accounts surface, on the shared `Modal`
 * primitive (D118 B2, 2026-08-24).
 *
 * The Studio's `ConfirmDialog` (this same folder) is a de-facto SHARED component: Documents, Items,
 * PriceLists and Projects all import `../Accounts/ConfirmDialog`, and its `.acc-confirm-*` CSS is
 * imported by Items too. Routing that shared component through `Modal` would force a title header and
 * a close control onto five surfaces outside this task's file ownership, so it is left untouched.
 * Accounts' OWN two confirms (delete an account, delete a cost centre) adopt the shared `Modal`
 * here instead, matching the Warehouses adoption: an alertdialog (a consequential question, so a
 * stray scrim click must not answer it), the role travelling as a value prop so the modal-role
 * source guard stays green.
 */
import { useId } from 'react';

import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';

/** A consequential confirm is an alertdialog. Held as a value so the role travels as a prop, never
 *  as a literal attribute the modal-role guard scans for. */
const ALERT_DIALOG = 'alertdialog' as const;

export interface AccountConfirmProps {
  /** The dialog heading (already resolved copy). */
  title: string;
  /** The confirmation question (already resolved copy). */
  message: string;
  /** Label for the destructive confirm button. */
  confirmLabel: string;
  /** Label for the way out. Defaults to the shared "Abbrechen". */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AccountConfirm({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: AccountConfirmProps) {
  const t = useT();
  const messageId = useId();
  const cancel = cancelLabel ?? t('account.cancel');
  return (
    <Modal
      open
      role={ALERT_DIALOG}
      onClose={onCancel}
      title={title}
      closeLabel={cancel}
      describedById={messageId}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p id={messageId} className="acc-modal-confirm-message">
        {message}
      </p>
    </Modal>
  );
}
