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
 *   - On activation, focus lands inside the container: on `initialFocus` when the caller names one
 *     (K-31, D137: a drawer's first field, never its close X), else the first focusable, else the
 *     container itself when it is programmatically focusable via `tabIndex={-1}`.
 *   - Tab at the last focusable wraps to the first; Shift+Tab at the first wraps to the last; a Tab
 *     from outside the set (focus was on the container, or lost to <body>) is pulled back in.
 *   - Escape calls `onEscape`, so the caller decides what closing means (a dirty matcher asks first).
 *   - Escape closes the INNERMOST open layer, never two at once (K-29, D137). While a popup inside the
 *     container is open (a combobox list, a select, an overflow menu: any `aria-expanded="true"` on a
 *     control that owns a popup), the trap stays out of Escape and the popup's own handler closes it.
 *     The trap listens in the capture phase on the document, so it runs BEFORE the popup's handler,
 *     and the popup's `stopPropagation()` used to arrive too late: one Escape in the composer's
 *     account list closed the list AND threw the whole booking away.
 *   - A key pressed inside ANOTHER modal is that modal's business (the feedback dialog opened from a
 *     drawer's error banner, a confirm nested in an editor): the trap neither pulls its Tab back nor
 *     answers its Escape. The topmost modal owns the keyboard.
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

/**
 * A control that owns a popup and reports it OPEN. A disclosure (a group toggle, an accordion) also
 * says `aria-expanded="true"`, but it owns no popup and Escape means nothing to it, so it is excluded:
 * only a combobox or a control with `aria-haspopup` counts.
 */
const OPEN_POPUP_OWNER = [
  '[role="combobox"][aria-expanded="true"]',
  '[aria-haspopup][aria-expanded="true"]:not([aria-haspopup="false"])',
].join(',');

/** True while a popup owned by a control inside `node` is open, so Escape belongs to that popup. */
export function hasOpenPopup(node: HTMLElement): boolean {
  return node.querySelector(OPEN_POPUP_OWNER) !== null;
}

/**
 * Where focus lands when the trap activates. A ref, a CSS selector resolved inside the container, or
 * a function of the container. When it resolves to nothing, the trap falls back to the first
 * focusable, then to the container.
 */
export type InitialFocus =
  | RefObject<HTMLElement | null>
  | string
  | ((container: HTMLElement) => HTMLElement | null);

/** Resolve an `InitialFocus` against `container`. Null when it names nothing that exists. */
function resolveInitialFocus(container: HTMLElement, target: InitialFocus): HTMLElement | null {
  if (typeof target === 'string') return container.querySelector<HTMLElement>(target);
  if (typeof target === 'function') return target(container);
  return target.current;
}

/** The form fields a person types into or picks from, as opposed to buttons and links. */
const FIELD = 'input, select, textarea, [role="combobox"], [contenteditable="true"]';

/**
 * The initial focus a FORM dialog wants (K-31): the first field marked `aria-invalid="true"`, else the
 * first field, else the container itself (whose accessible name is its title). Never a button, so
 * the first key pressed in a fresh drawer cannot land on its close X.
 */
export function firstInvalidOrField(container: HTMLElement): HTMLElement {
  const fields = focusablesIn(container).filter((element) => element.matches(FIELD));
  return (
    fields.find((element) => element.getAttribute('aria-invalid') === 'true') ??
    fields[0] ??
    container
  );
}

/**
 * Move focus to the first `aria-invalid="true"` field inside `container`, after a rejected save.
 * Returns whether one was found, so the caller can fall back to its banner for an engine error that
 * belongs to no field.
 */
export function focusFirstInvalid(container: HTMLElement): boolean {
  const invalid = focusablesIn(container).find(
    (element) => element.getAttribute('aria-invalid') === 'true',
  );
  if (invalid === undefined) return false;
  invalid.focus();
  return true;
}

export interface FocusTrapOptions {
  /** Escape inside the trap calls this. The caller owns what "close" means. */
  onEscape?: () => void;
  /** Turn the trap off without unmounting the container (a nested dialog is open over it). */
  active?: boolean;
  /**
   * Where focus lands on activation (K-31). Omitted, it is the first focusable, as before. A form
   * dialog passes `firstInvalidOrField` so its first key press never lands on the close control.
   */
  initialFocus?: InitialFocus;
}

/**
 * Trap focus inside `ref` while `active`. Attach to a modal container that is itself focusable
 * (`tabIndex={-1}`) so the initial focus has somewhere to land even before the first control.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { onEscape, active = true, initialFocus }: FocusTrapOptions = {},
): void {
  // `onEscape` is read through a ref so the trap effect does NOT depend on its identity. The caller's
  // handler is typically a `useCallback` that changes as the form goes dirty, and re-running the
  // effect on every such change would re-seed initial focus mid-typing, yanking the caret out of the
  // field. Held in a ref, the handler stays current while the effect runs only on mount and when
  // `active` toggles.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  // Read through a ref for the same reason: a caller passing an inline function must not re-run the
  // effect (and so re-seed focus) on every render.
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

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

    // Land focus inside on activation: the caller's named target first (K-31), then the first
    // focusable. The container is focusable via tabIndex={-1}, so even an empty or still-loading modal
    // never leaves focus stranded on the body behind the scrim.
    const named =
      initialFocusRef.current !== undefined
        ? resolveInitialFocus(node, initialFocusRef.current)
        : null;
    const initial = focusablesIn(node);
    if (named !== null && node.contains(named)) named.focus();
    else if (initial.length > 0) initial[0].focus();
    else node.focus();

    // The modal this trap stands for: the container itself when it carries `aria-modal` (every
    // caller today), else its nearest modal ancestor, else the first modal inside it.
    const self =
      node.closest<HTMLElement>('[aria-modal="true"]') ??
      node.querySelector<HTMLElement>('[aria-modal="true"]');

    const onKey = (event: KeyboardEvent) => {
      // A key pressed inside ANOTHER modal belongs to that modal, whether it is nested in this one (a
      // confirm over an editor) or stacked beside it (the feedback dialog, portaled to the body). The
      // topmost modal owns the keyboard; this trap neither answers its Escape nor pulls its Tab back.
      const target = event.target instanceof Element ? event.target : null;
      const owner = target?.closest('[aria-modal="true"]') ?? null;
      if (owner !== null && owner !== self) return;
      if (event.key === 'Escape') {
        // K-29: an open popup inside the trap takes Escape first and closes itself. The trap only
        // closes the dialog once nothing inside it is open.
        if (hasOpenPopup(node)) return;
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
