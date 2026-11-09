/**
 * "Kontoauszug holen": one secondary button with a menu, where the header used to carry two buttons
 * that sounded alike ("Kontoauszüge abrufen", "Kontoauszug importieren") and a loose date beside them
 * (B2, the owner's pick of 01.10.2026). The menu holds the two ways a statement arrives and, as a quiet
 * caption under them, when the bank was last asked.
 *
 * The shared `OverflowMenu` is a glyph-only trigger with word-only items; this one needs a VISIBLE label
 * and a caption, so it is its own small control on the same WAI-ARIA menu button pattern and the same
 * overlay classes: Enter, Space or ArrowDown open at the first item, ArrowUp at the last, the arrows
 * wrap, Home and End jump, Escape closes and returns focus to the trigger, Tab closes and moves on, a
 * pointer press outside closes without stealing focus. Focus is roving, so the menu is one tab stop.
 * A disabled item stays focusable and says so (`aria-disabled`), per the APG.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CaretGlyph, SureGlyph } from './glyphs';
import '../../components/OverflowMenu.css';

export interface MenuButtonItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /**
   * A toggle (the toolbar's "Filter" menu, D167): the item is a `menuitemcheckbox` with `aria-checked`,
   * and the check glyph says it is on (never colour alone).
   */
  checked?: boolean;
}

export interface MenuButtonProps {
  /** The visible label, and so the trigger's accessible name. */
  label: string;
  /** A leading glyph, decorative. */
  icon?: ReactNode;
  items: MenuButtonItem[];
  /** A quiet line under the items (a fact, not an action). */
  caption?: string;
  disabled?: boolean;
  className?: string;
  /** The quiet trigger (a ghost button), for a tool that is not an action: the toolbar's "Filter". */
  quiet?: boolean;
  /**
   * D177: the list in the overlay layer (a portal on `document.body`), fixed to the trigger: below it, or
   * above it when there is no room, right-aligned. A clipping container (the Details panel) never cuts it.
   */
  portal?: boolean;
}

export function MenuButton({ label, icon, items, caption, disabled = false, className, quiet = false, portal = false }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const menuId = useId();
  const triggerId = useId();
  const captionId = useId();

  const openAt = useCallback(
    (index: number) => {
      if (disabled || items.length === 0) return;
      setOpen(true);
      setActive(index < 0 ? items.length - 1 : index);
    },
    [disabled, items.length],
  );
  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    setActive(-1);
    triggerRef.current?.focus();
  }, []);
  const closeQuietly = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // A portalled list is hidden until it is placed; the item takes the focus once it can (a hidden
  // element refuses it, and Escape would then reach nothing).
  const placed = !portal || place !== null;
  useEffect(() => {
    if (!open || active < 0 || !placed) return;
    itemRefs.current[active]?.focus();
  }, [open, active, placed]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (listRef.current?.contains(event.target as Node) === true) return;
      if (root !== null && !root.contains(event.target as Node)) closeQuietly();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, closeQuietly]);

  useLayoutEffect(() => {
    if (!portal || !open) {
      setPlace(null);
      return undefined;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return undefined;
    const below = window.innerHeight - rect.bottom;
    const estimate = items.length * 46 + (caption !== undefined ? 40 : 0) + 16;
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
  }, [portal, open, items.length, caption, closeQuietly]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        closeAndRefocus();
        break;
      case 'Tab':
        closeQuietly();
        break;
      default:
        break;
    }
  };

  return (
    <div className={`overflow-menu bank-menu${className !== undefined ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        className={`btn ${quiet ? 'btn--ghost btn--sm' : 'btn--secondary'} bank-menu__trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || items.length === 0}
        onClick={() => (open ? closeQuietly() : openAt(0))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openAt(0);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openAt(items.length - 1);
          }
        }}
      >
        {icon}
        <span>{label}</span>
        <CaretGlyph size={16} />
      </button>
      {open && (portal ? createPortal(list(), document.body) : list())}
    </div>
  );

  function list() {
    return (
        <div
          className={`overflow-menu-list bank-menu__list${portal ? ' overflow-menu-list--portal' : ''}`}
          ref={listRef}
          style={portal ? (place ?? { position: 'fixed', visibility: 'hidden' }) : undefined}
        >
          <div
            className="bank-menu__items"
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            aria-describedby={caption !== undefined ? captionId : undefined}
            onKeyDown={onMenuKeyDown}
          >
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              className="btn btn--sm btn--menu btn--secondary"
              tabIndex={index === active ? 0 : -1}
              aria-disabled={item.disabled === true ? true : undefined}
              onClick={() => {
                if (item.disabled === true) return;
                closeAndRefocus();
                item.onSelect();
              }}
              onFocus={() => setActive(index)}
            >
              {item.checked !== undefined && (
                <span className="bank-menu__check" aria-hidden="true">
                  {item.checked ? <SureGlyph size={16} /> : null}
                </span>
              )}
              {item.label}
            </button>
          ))}
          </div>
          {caption !== undefined && (
            <p id={captionId} className="bank-menu__caption">
              {caption}
            </p>
          )}
        </div>
    );
  }
}
