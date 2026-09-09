/**
 * useFocusTrap: keep keyboard focus inside a modal container, and hand it back on close.
 *
 * A modal surface (`aria-modal="true"`) promises the screen reader and the keyboard user that Tab
 * cannot walk out to the page behind it. `aria-modal` alone does NOT enforce that: it is a hint to
 * assistive tech, and a sighted keyboard user still Tabs straight through the scrim into the list
 * underneath. The PaymentAllocator carried that exact gap: it had Escape and `aria-modal`, but no
 * real trap, so Tab escaped the matcher mid-allocation. This hook closes it in one place.
 *
 * The Tab-cycling and the document-capture listener are the discipline the FeedbackDialog and the
 * OverflowMenu already prove in tests, consolidated here so every modal in the Studio traps focus
 * the same way rather than each re-deriving it. Extracting it was the fix the A14 UX gate asked for.
 *
 *   - On activation, focus lands inside the container (the first focusable, or the container itself
 *     when it is programmatically focusable via `tabIndex={-1}`).
 *   - Tab at the last focusable wraps to the first; Shift+Tab at the first wraps to the last; a Tab
 *     from outside the set (focus was on the container, or lost to <body>) is pulled back in.
 *   - Escape calls `onEscape`, so the caller decides what closing means (a dirty matcher asks first).
 *   - On deactivation or unmount, focus returns to whatever held it before the trap opened, so the
 *     control that opened the modal is where the user lands when it closes.
 */
import { useEffect, useRef, type RefObject } from 'react';

/** The tabbable set. Disabled controls and `tabindex="-1"` are excluded, per the APG. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The focusable descendants of `node`, in DOM order. Exported so a caller can seed initial focus. */
export function focusablesIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // `input:not([disabled])` still matches an input the roving list has parked at `tabindex="-1"`,
    // so filter those out: a parked roving input is not a tab stop, and the candidate table stays one
    // tab stop as designed. `tabIndex` reflects the attribute in the DOM and needs no layout, so this
    // is correct in jsdom too.
    (element) => element.tabIndex !== -1,
  );
}

export interface FocusTrapOptions {
  /** Escape inside the trap calls this. The caller owns what "close" means. */
  onEscape?: () => void;
  /** Turn the trap off without unmounting the container (a nested dialog is open over it). */
  active?: boolean;
}

/**
 * Trap focus inside `ref` while `active`. Attach to a modal container that is itself focusable
 * (`tabIndex={-1}`) so the initial focus has somewhere to land even before the first control.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { onEscape, active = true }: FocusTrapOptions = {},
): void {
  // `onEscape` is read through a ref so the trap effect does NOT depend on its identity. The caller's
  // handler is typically a `useCallback` that changes as the form goes dirty, and re-running the
  // effect on every such change would re-seed initial focus mid-typing, yanking the caret out of the
  // field. Held in a ref, the handler stays current while the effect runs only on mount and when
  // `active` toggles.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // Restore focus to the opener when the trap UNMOUNTS (the modal closes), and only then, so a
  // temporary deactivation for a nested dialog does not bounce focus around. Captured once, at mount.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    return () => {
      if (returnTo !== null && returnTo.isConnected) returnTo.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (node === null || !active) return undefined;

    // Land focus inside on activation. The container is focusable via tabIndex={-1}, so even an empty
    // or still-loading modal never leaves focus stranded on the body behind the scrim.
    const initial = focusablesIn(node);
    if (initial.length > 0) initial[0].focus();
    else node.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const handler = onEscapeRef.current;
        if (handler !== undefined) {
          event.preventDefault();
          handler();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusablesIn(node);
      if (items.length === 0) {
        // Nothing to tab between: keep focus on the container rather than letting it escape.
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [ref, active]);
}
