/**
 * Modal: the one dialog primitive (D118 B2), so every centred overlay in the Studio traps focus,
 * closes on Escape and returns focus the same way rather than each surface re-deriving it.
 *
 * The role lands on a `div`, never on `aside`/`section`-less markup: W3C "ARIA in HTML" does not
 * permit a modal role on `aside`, and axe reports it as `aria-allowed-role`. A `div` permits any
 * role, and `test/style/modal-role-on-allowed-element.test.mjs` is the mechanism that keeps it that
 * way. The two roles this supports are the plain dialog and the alertdialog; the alertdialog is the
 * confirm/destructive case, and per the APG it does NOT dismiss on a scrim click, because a stray
 * click must not be able to answer a consequential question.
 *
 * Focus is handled by the shared `useFocusTrap`: initial focus lands inside on open, Tab cycles, and
 * focus returns to the control that opened the modal when it unmounts. Nothing here reimplements that.
 *
 * This is a controlled component: the caller owns `open` and closes on `onClose`. It renders nothing
 * when closed, so a parent can mount it unconditionally.
 */
import { useId, useRef, type ReactNode } from 'react';

import { useFocusTrap } from './useFocusTrap';
import { CloseGlyph } from './icons';
import './Modal.css';

/** The plain dialog, or the alertdialog for a consequential confirm. Both host on a `div`. */
export type ModalRole = 'dialog' | 'alertdialog';

export interface ModalProps {
  /** The caller owns visibility. When false, the modal renders nothing. */
  open: boolean;
  /** Called on Escape, on the close control, and (for a plain dialog) on a scrim click. */
  onClose: () => void;
  /** The heading. Becomes the dialog's accessible name via `aria-labelledby`. */
  title: string;
  /** The dialog body. */
  children: ReactNode;
  /**
   * The accessible label for the close control (an icon button). Required, because an icon-only
   * control with no label is invisible to a screen reader.
   */
  closeLabel: string;
  /** The plain dialog (default) or an alertdialog for a consequential confirm. */
  role?: ModalRole;
  /**
   * A footer slot, typically the actions. Kept out of the scrolling body so the primary action is
   * always reachable. Sits bottom-right, per the design law.
   */
  footer?: ReactNode;
  /**
   * The id of an element inside `children` that describes the dialog, wired as `aria-describedby`.
   * An alertdialog usually points this at its consequence sentence.
   */
  describedById?: string;
  /**
   * Whether this dialog's own focus trap and Escape handling are active. Defaults to `true`, the
   * behaviour every current caller relies on. Set it to `false` while a NESTED dialog (a confirm
   * over an editor) is open, so this dialog stops competing for focus and Escape: the child then
   * owns the trap, and Escape closes only the child. When the child closes, flip it back to `true`.
   */
  trapActive?: boolean;
}

export function Modal({ open, ...rest }: ModalProps) {
  // The panel is a separate component mounted only while open, so `useFocusTrap` sees a real mount
  // and unmount: it captures the opener on open and returns focus to it on close. A version that
  // stayed mounted and merely returned null would never fire the trap's focus-return, because the
  // component never unmounts.
  if (!open) return null;
  return <ModalPanel {...rest} />;
}

function ModalPanel({
  onClose,
  title,
  children,
  closeLabel,
  role,
  footer,
  describedById,
  trapActive = true,
}: Omit<ModalProps, 'open'>) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Resolved here rather than as a destructuring default, so the source never carries the literal
  // `role =` attribute pattern the modal-role guard scans for outside a real JSX element.
  const dialogRole = role ?? 'dialog';

  useFocusTrap(panelRef, { onEscape: onClose, active: trapActive });

  // An alertdialog must not be dismissable by a stray scrim click (APG): a consequential question is
  // answered with a control, not by clicking away. A plain dialog closes on the scrim.
  const dismissOnScrim = dialogRole === 'dialog';

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={dismissOnScrim ? onClose : undefined}
    >
      <div
        className="modal panel motion-reveal--center"
        role={dialogRole}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head" data-motion-item="1">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <CloseGlyph size={18} />
          </button>
        </div>
        <div className="modal-body" data-motion-item="2">
          {children}
        </div>
        {footer !== undefined && (
          <div className="modal-foot" data-motion-item="3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
