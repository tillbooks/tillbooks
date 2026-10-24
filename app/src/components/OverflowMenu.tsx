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
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { MoreGlyph, VOCABULARY, type VocabularyIcon } from './icons';
import { Tooltip } from './Tooltip';
import './OverflowMenu.css';

export interface OverflowMenuItem {
  /** Stable identity for the item, used as the React key and in tests. */
  key: string;
  /** The visible, already-localised label. There is no glyph-only item: every row reads as words. */
  label: string;
  /**
   * A small glyph BESIDE the label (D180), never instead of it: decorative, so it is hidden from
   * assistive tech and the label stays the item's name.
   */
  glyph?: ReactNode;
  /**
   * D180: a choice among siblings (the bank item's size). Set on every item of the group, it renders
   * as `menuitemradio` with `aria-checked`, and the chosen one carries a check beside its words, so
   * the state is never colour alone. Omitted: a plain `menuitem`.
   */
  checked?: boolean;
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
  /**
   * D177: a menu whose trigger is another glyph of the closed vocabulary (the bank row's Ignorieren,
   * which opens its five reasons). Its name is the tooltip's first line, `tooltip` the second; the
   * trigger's accessible name stays `label`.
   */
  icon?: VocabularyIcon;
  /** The tooltip's second line for an `icon` trigger. */
  tooltip?: string;
  /** An extra class on the menu's root (a surface's reveal rules). */
  className?: string;
  /**
   * D177: render the list in the overlay layer (a portal on `document.body`, fixed to the trigger), so a
   * scrolling or clipping container (a table's panel) never cuts it. It opens below the trigger, or above
   * it when there is no room below, right-aligned to the trigger's trailing edge.
   */
  portal?: boolean;
}

/** The check beside the chosen item of a radio group: the vocabulary's own (Fertig), drawn once. */
const CheckMark = VOCABULARY.done.glyph;
/** The check's slot keeps its width when empty, so the words of a group line up. */
const CHECK_SLOT: CSSProperties = { display: 'inline-flex', width: 16, flex: '0 0 auto' };

export function OverflowMenu({ label, items, disabled = false, quiet = false, icon, tooltip, className, portal = false }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  /** Index of the item currently holding focus. -1 while the menu is closed. */
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
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

  // A portalled list is fixed to the trigger: below it, or above it when the viewport has no room below.
  // A scroll or a resize closes it rather than leaving it hanging where the trigger was.
  useLayoutEffect(() => {
    if (!portal || !open) {
      setPlace(null);
      return undefined;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return undefined;
    const below = window.innerHeight - rect.bottom;
    const estimate = items.length * 46 + 16;
    const right = Math.max(8, window.innerWidth - rect.right);
    setPlace(below >= estimate || below >= rect.top ? { position: 'fixed', top: rect.bottom + 4, right, left: 'auto' } : { position: 'fixed', bottom: window.innerHeight - rect.top + 4, top: 'auto', right, left: 'auto' });
    const close = () => closeQuietly();
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node) === true) return;
      closeQuietly();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [portal, open, items.length, closeQuietly]);

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
      const target = event.target as Node;
      // A portalled list is outside the root in the DOM: a press inside it is still inside the menu.
      if (listRef.current?.contains(target) === true) return;
      if (root !== null && !root.contains(target)) closeQuietly();
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

  const Glyph = icon === undefined ? MoreGlyph : VOCABULARY[icon].glyph;
  const trigger = (
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
      data-icon={icon}
      onClick={() => (open ? closeQuietly() : openAt(0))}
      onKeyDown={onTriggerKeyDown}
    >
      <span aria-hidden="true" className="overflow-menu-glyph">
        <Glyph size={16} />
      </span>
    </button>
  );

  const menuList = (
        <div
          className={portal ? 'overflow-menu-list overflow-menu-list--portal' : 'overflow-menu-list'}
          id={menuId}
          ref={listRef}
          style={portal ? (place ?? { position: 'fixed', visibility: 'hidden' }) : undefined}
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
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className={`btn btn--sm btn--menu ${item.danger === true ? 'btn--danger' : 'btn--secondary'}`}
                tabIndex={index === activeIndex ? 0 : -1}
                aria-disabled={item.disabled === true ? true : undefined}
                onClick={() => selectItem(item)}
                onFocus={() => setActiveIndex(index)}
              >
                {item.checked !== undefined ? (
                  <span aria-hidden="true" className="overflow-menu-check" style={CHECK_SLOT}>
                    {item.checked ? <CheckMark size={16} /> : null}
                  </span>
                ) : null}
                {item.glyph !== undefined ? (
                  <span aria-hidden="true" className="overflow-menu-item-glyph">
                    {item.glyph}
                  </span>
                ) : null}
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
  );

  return (
    <div className={className === undefined ? 'overflow-menu' : `overflow-menu ${className}`} ref={rootRef}>
      {icon !== undefined ? (
        <Tooltip
          suppressed={open}
          content={
            <>
              <span className="tooltip-name">{VOCABULARY[icon].name}</span>
              {tooltip !== undefined && <span className="tooltip-context">{tooltip}</span>}
            </>
          }
        >
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}

      {open && (portal ? createPortal(menuList, document.body) : menuList)}
    </div>
  );
}

export default OverflowMenu;
