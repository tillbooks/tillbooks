/**
 * OverflowMenu: the one per-row overflow control (D15/C2).
 *
 * A dense list row used to carry every action inline, so a full KMU chart of accounts showed
 * roughly a hundred rows times three controls, and a destructive action sat one stray click from
 * the pointer. D15/C2 moves the secondary and destructive actions one level down: the primary row
 * action stays directly reachable, everything else lives behind a single quiet trigger, and the
 * destructive item is coloured only once the menu is open.
 *
 * The keyboard model is the WAI-ARIA Authoring Practices menu button pattern, not an invention:
 *   - Enter or Space opens the menu and puts focus on the FIRST item.
 *   - ArrowDown opens at the first item, ArrowUp opens at the LAST one.
 *   - ArrowDown / ArrowUp move between items and wrap at both ends.
 *   - Home / End jump to the first / last item.
 *   - Escape closes the menu and returns focus TO THE TRIGGER. Losing the focus position to the
 *     body is the classic bug in this pattern, so it is asserted in the tests.
 *   - Tab closes the menu and lets the browser move on naturally.
 *   - A pointer press outside closes the menu without stealing focus back, because the user has
 *     already said where they want to be.
 *
 * Focus is ROVING: exactly one item is tabbable at a time and the rest carry `tabindex="-1"`, so
 * the menu is one tab stop rather than N. Disabled items stay focusable, per the APG, so a
 * keyboard user can discover that an action exists and is currently unavailable.
 *
 * Destructive items belong LAST. The component does not reorder them, it renders what the caller
 * passes, so ordering is the caller's contract and the surfaces are tested for it. When a destructive
 * item follows ordinary ones, a separator sits between the two piles (K-21, D137), so "Löschen" is
 * never one slip of the arrow key below "Bearbeiten" without a visible break.
 *
 * `quiet` makes the trigger a ghost (K-21): a list with one overflow per row would otherwise draw a
 * bordered box on every line.
 */
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';

import { MoreGlyph } from './icons';
import './OverflowMenu.css';

export interface OverflowMenuItem {
  /** Stable identity for the item, used as the React key and in tests. */
  key: string;
  /** The visible, already-localised label. There is no glyph-only item: every row reads as words. */
  label: string;
  onSelect: () => void;
  /** Renders the item in the danger variant. Destructive items are passed last by the caller. */
  danger?: boolean;
  disabled?: boolean;
}

export interface OverflowMenuProps {
  /**
   * The accessible name of the TRIGGER, for example "Actions for account 1020". A bare glyph with
   * no name is unusable with a screen reader and indistinguishable from the ninety-nine identical
   * triggers above and below it, so the name carries the row's identity.
   */
  label: string;
  items: OverflowMenuItem[];
  /** Disables the trigger outright, for a row whose actions are all unavailable. */
  disabled?: boolean;
  /**
   * A borderless ghost trigger instead of the secondary button, for the trailing overflow of a table
   * row, where a bordered box on every line would outweigh the data.
   */
  quiet?: boolean;
}

export function OverflowMenu({ label, items, disabled = false, quiet = false }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  /** Index of the item currently holding focus. -1 while the menu is closed. */
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const menuId = useId();
  const triggerId = useId();

  const openAt = useCallback(
    (index: number) => {
      if (disabled || items.length === 0) return;
      setOpen(true);
      setActiveIndex(index < 0 ? items.length - 1 : index);
    },
    [disabled, items.length],
  );

  /** Close and hand focus back to the trigger. Every keyboard exit uses this. */
  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  /** Close without moving focus, for a pointer press that already landed somewhere else. */
  const closeQuietly = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Roving focus: whenever the active index changes while open, move real DOM focus to match.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // A pointer press outside the menu closes it. `mousedown` rather than `click`, so the menu is
  // gone before the click lands on whatever was underneath it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) closeQuietly();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeQuietly]);

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(items.length - 1);
    }
    // Enter and Space are left to the browser: they fire `click`, which opens at the first item.
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        closeAndRefocus();
        break;
      case 'Tab':
        // Do NOT preventDefault: the menu closes and the browser moves focus onward as usual.
        closeQuietly();
        break;
      default:
        break;
    }
  }

  function selectItem(item: OverflowMenuItem) {
    if (item.disabled === true) return;
    // Focus returns to the trigger BEFORE the action runs, so an action that opens a dialog
    // inherits a sane return point once that dialog closes.
    closeAndRefocus();
    item.onSelect();
  }

  return (
    <div className="overflow-menu" ref={rootRef}>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        className={`btn ${quiet ? 'btn--ghost' : 'btn--secondary'} btn--icon overflow-menu-trigger`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || items.length === 0}
        onClick={() => (open ? closeQuietly() : openAt(0))}
        onKeyDown={onTriggerKeyDown}
      >
        <span aria-hidden="true" className="overflow-menu-glyph">
          <MoreGlyph size={16} />
        </span>
      </button>

      {open && (
        <div
          className="overflow-menu-list"
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {item.danger === true && index > 0 && items[index - 1]?.danger !== true && (
                <div role="separator" className="overflow-menu-separator" />
              )}
              <button
                type="button"
                role="menuitem"
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className={`btn btn--sm btn--menu ${item.danger === true ? 'btn--danger' : 'btn--secondary'}`}
                tabIndex={index === activeIndex ? 0 : -1}
                aria-disabled={item.disabled === true ? true : undefined}
                onClick={() => selectItem(item)}
                onFocus={() => setActiveIndex(index)}
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export default OverflowMenu;
