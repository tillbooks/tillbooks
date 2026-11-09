/**
 * The rail's menu-button keyboard model, once (the APG menu button, the OverflowMenu contract).
 *
 * The rail carries two menus since K-01 (D137): the workspace switcher in the head and the
 * environment pill in the footer. Both follow the same contract, so it lives here instead of twice:
 *   - Enter or Space opens the menu at the FIRST item (the browser's click on the trigger).
 *   - ArrowDown opens at the first item, ArrowUp at the LAST one.
 *   - Inside, ArrowDown / ArrowUp move and wrap; Home / End jump to the ends.
 *   - Escape closes and returns focus TO THE TRIGGER; Tab closes and lets the browser move on.
 *   - A pointer press outside closes without stealing focus back.
 * Focus is ROVING: one tab stop, `tabindex="-1"` on every other item.
 *
 * The caller owns what the items are; this owns open state, the active index and focus.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';

export interface MenuButton {
  open: boolean;
  activeIndex: number;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
  /** Open at `index`; a negative index opens at the last item. */
  openAt: (index: number) => void;
  /** Close and hand focus back to the trigger (every keyboard exit). */
  closeAndRefocus: () => void;
  /** Close without moving focus (a pointer press that already landed elsewhere, or Tab). */
  closeQuietly: () => void;
  /** The trigger's click: toggles the menu, opening at the first item. */
  onTriggerClick: () => void;
  onTriggerKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Wire one item into the roving-focus model at its flat index. */
  itemProps: (index: number) => {
    ref: (node: HTMLElement | null) => void;
    tabIndex: number;
    onFocus: () => void;
  };
}

export function useMenuButton(count: number): MenuButton {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const openAt = useCallback(
    (index: number) => {
      setOpen(true);
      setActiveIndex(index < 0 ? count - 1 : index);
    },
    [count],
  );

  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  const closeQuietly = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Roving focus: whenever the active index changes while open, move real DOM focus to match.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // A pointer press outside closes the menu. `mousedown` rather than `click`, so the menu is gone
  // before the click lands on whatever was underneath it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) closeQuietly();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeQuietly]);

  const onTriggerClick = useCallback(() => {
    if (open) closeQuietly();
    else openAt(0);
  }, [open, closeQuietly, openAt]);

  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openAt(0);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openAt(-1);
      }
      // Enter and Space are left to the browser: they fire `click`, which opens at the first item.
    },
    [openAt],
  );

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % count);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + count) % count);
          break;
        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          event.preventDefault();
          setActiveIndex(count - 1);
          break;
        case 'Escape':
          event.preventDefault();
          // The menu is the innermost layer: close it alone, never the drawer or dialog around it.
          event.stopPropagation();
          closeAndRefocus();
          break;
        case 'Tab':
          // Do NOT preventDefault: the menu closes and the browser moves focus onward as usual.
          closeQuietly();
          break;
        default:
          break;
      }
    },
    [count, closeAndRefocus, closeQuietly],
  );

  const itemProps = useCallback(
    (index: number) => ({
      ref: (node: HTMLElement | null) => {
        itemRefs.current[index] = node;
      },
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveIndex(index),
    }),
    [activeIndex],
  );

  return {
    open,
    activeIndex,
    rootRef,
    triggerRef,
    openAt,
    closeAndRefocus,
    closeQuietly,
    onTriggerClick,
    onTriggerKeyDown,
    onMenuKeyDown,
    itemProps,
  };
}
