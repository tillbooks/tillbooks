/**
 * DetailDrawer: the one right-side detail panel (D118 B2), so every drawer in the Studio scrolls its
 * body independently, traps focus, closes on Escape and hosts the quiet provenance line the same way.
 *
 * The five shipped drawers each hand-rolled this and disagreed: some had Escape, some a focus trap,
 * some neither, and two started life as an `aside` carrying a dialog role, which axe rejects as
 * `aria-allowed-role` (the aside element does not permit it). This settles it: the dialog role sits
 * on a `div`, focus is the shared
 * `useFocusTrap`, and the header stays put while only the body scrolls.
 *
 * The header stays; the body scrolls. That split is the whole point of a drawer over a modal: the
 * title and the actions stay in view while a long record scrolls under them. `provenance` is a
 * dedicated slot at the foot for the C3 `Provenance` line, which belongs on detail views and nowhere
 * else.
 *
 * Controlled: the caller owns `open` and closes on `onClose`. The panel is mounted only while open,
 * so `useFocusTrap` returns focus to the row that opened it.
 */
import { useId, useRef, type ReactNode } from 'react';

import { useFocusTrap } from './useFocusTrap';
import { CloseGlyph } from './icons';
import './DetailDrawer.css';

export interface DetailDrawerProps {
  /** The caller owns visibility. When false, the drawer renders nothing. */
  open: boolean;
  /** Called on Escape, on the close control, and on a scrim click. */
  onClose: () => void;
  /** The record title. Becomes the drawer's accessible name via `aria-labelledby`. */
  title: string;
  /** The accessible label for the close control (an icon button). Required. */
  closeLabel: string;
  /** The scrolling body: the record's fields, tabs, tables. */
  children: ReactNode;
  /** An optional strip of controls beside the title (e.g. a kind glyph, a status chip). */
  headerExtra?: ReactNode;
  /** The action row, pinned below the scrolling body so the primary action stays reachable. */
  footer?: ReactNode;
  /**
   * The C3 provenance slot: pass the shared `<Provenance>` line. It sits below the body, above the
   * footer, quiet by law. Omitted when the record has no provenance to show.
   */
  provenance?: ReactNode;
  /** The id of an element inside `children` that describes the drawer, wired as `aria-describedby`. */
  describedById?: string;
  /**
   * Whether the drawer's own focus trap and Escape handling are active. Defaults to `true`, the
   * behaviour every current caller relies on. Set it to `false` while a NESTED dialog (a confirm
   * over an editor hosted in the drawer) is open, so the drawer stops competing for focus and
   * Escape: the child dialog then owns the trap, and Escape closes only the child. Flip it back to
   * `true` when the child closes.
   */
  trapActive?: boolean;
}

export function DetailDrawer({ open, ...rest }: DetailDrawerProps) {
  // Mounted only while open so the trap captures the opener and returns focus on close. See Modal.
  if (!open) return null;
  return <DrawerPanel {...rest} />;
}

function DrawerPanel({
  onClose,
  title,
  closeLabel,
  children,
  headerExtra,
  footer,
  provenance,
  describedById,
  trapActive = true,
}: Omit<DetailDrawerProps, 'open'>) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, { onEscape: onClose, active: trapActive });

  return (
    <div className="drawer-scrim" role="presentation" onClick={onClose}>
      <div
        className="drawer panel motion-reveal--right"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-head" data-motion-item="1">
          <h2 id={titleId} className="drawer-title">
            {title}
          </h2>
          {headerExtra !== undefined && <div className="drawer-head-extra">{headerExtra}</div>}
          <button
            type="button"
            className="btn btn--ghost btn--icon drawer-close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <CloseGlyph size={18} />
          </button>
        </div>
        <div className="drawer-body" data-motion-item="2">
          {children}
        </div>
        {provenance !== undefined && <div className="drawer-provenance">{provenance}</div>}
        {footer !== undefined && (
          <div className="drawer-foot" data-motion-item="3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
