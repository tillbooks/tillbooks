/**
 * The shared Select: a modern, styled replacement for a native `<select>`.
 *
 * WHY A CUSTOM CONTROL AND NOT `<select className="field">`. CSS can style a native select's CLOSED
 * trigger, but the OPEN option list is painted by the operating system: on macOS that is the blue
 * 1990s popup the owner flagged. There is no CSS hook for it. The only way to a modern dropdown is to
 * render the list ourselves, so this is a button trigger (styled like a `.field`) plus a listbox
 * popover we own, in the Brass palette.
 *
 * WHY THE POPOVER IS PORTALED. A dropdown that renders in place is clipped by any `overflow` ancestor,
 * and two of the first consumers sit in one: the environment switcher lives in the rail
 * (`overflow: hidden`) and form selects live in scrolling drawers. So the listbox is portaled to
 * <body> and positioned against the trigger's viewport rect, flipping above when the trigger is near
 * the bottom edge (the rail-footer switcher is), and it repositions on scroll and resize.
 *
 * ACCESSIBILITY is the WAI-ARIA "select-only combobox" pattern: the trigger is `role="combobox"` with
 * `aria-haspopup="listbox"`, `aria-expanded` and `aria-activedescendant`; the popover is a
 * `role="listbox"` of `role="option"` rows. Focus never leaves the trigger, so there is no focus trap
 * to manage. Keyboard: Up/Down/Home/End move the active option (opening the list if closed),
 * Enter/Space select it, Escape closes, Tab closes and moves on, printable characters type-ahead.
 *
 * API is deliberately close to a native select (`value` / `onChange` / `options`) so a migration off
 * `<select>` is mechanical. `groups` renders optgroup-style sections; pass one of `options`/`groups`.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ChevronDownGlyph } from './icons';
import { CheckGlyph } from './states/glyphs';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}

export interface SelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options?: readonly SelectOption[];
  readonly groups?: readonly SelectGroup[];
  /** Shown on the trigger when `value` matches no option. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly ariaLabel?: string;
  /** Composed onto the trigger wrapper, e.g. a width utility. */
  readonly className?: string;
  /** Form validation: marks the trigger invalid (aria-invalid) so it can carry an error state. */
  readonly invalid?: boolean;
  /** id(s) of the element(s) that describe this control (aria-describedby), e.g. an error message. */
  readonly describedBy?: string;
  /** Fired when focus leaves the trigger (e.g. to run a blur-time validation). */
  readonly onBlur?: () => void;
  /** Marks the control required (aria-required) where a form gates submit on a chosen value. */
  readonly required?: boolean;
}

interface PopPosition {
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly anchor: { edge: 'top'; px: number } | { edge: 'bottom'; px: number };
}

function flatten(options?: readonly SelectOption[], groups?: readonly SelectGroup[]): SelectOption[] {
  // Ungrouped options render first (e.g. a built-in "default" row), then the groups.
  return [...(options ?? []), ...(groups ?? []).flatMap((g) => [...g.options])];
}

export function Select({
  value,
  onChange,
  options,
  groups,
  placeholder,
  disabled = false,
  id,
  ariaLabel,
  className,
  invalid = false,
  describedBy,
  onBlur,
  required = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(value);
  const [pos, setPos] = useState<PopPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });
  const reactId = useId();
  // Prefix the generated id so this control's ids (and its portaled option ids) can never equal a
  // bare React `useId()` value elsewhere. Without this, a portal that outlives a test by a tick can
  // collide with another element's `aria-describedby` target and redirect its accessible description.
  const baseId = id ?? `till-select-${reactId}`;
  const listboxId = `${baseId}-listbox`;

  const flat = useMemo(() => flatten(options, groups), [options, groups]);
  const selectable = useMemo(() => flat.filter((o) => o.disabled !== true), [flat]);
  const selected = flat.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? placeholder ?? '';
  const optionId = (v: string) => `${baseId}-opt-${flat.findIndex((o) => o.value === v)}`;

  // Position the portaled popover against the trigger, flipping above near the viewport bottom.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const compute = () => {
      const el = triggerRef.current;
      if (el === null) return;
      const r = el.getBoundingClientRect();
      const gap = 4;
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const placeBelow = below >= 200 || below >= above;
      setPos({
        left: r.left,
        width: r.width,
        maxHeight: Math.max(140, Math.min(360, placeBelow ? below : above)),
        anchor: placeBelow
          ? { edge: 'top', px: r.bottom + gap }
          : { edge: 'bottom', px: window.innerHeight - r.top + gap },
      });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocument = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (listRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocument);
    return () => document.removeEventListener('mousedown', onDocument);
  }, [open]);

  // Seed the active option from the current value each time the list opens.
  useEffect(() => {
    if (!open) return;
    setActiveValue(
      value !== '' && selectable.some((o) => o.value === value) ? value : (selectable[0]?.value ?? null),
    );
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active option scrolled into view. `scrollIntoView` is guarded because jsdom (the test
  // DOM) does not implement it, and a raw call would throw.
  useEffect(() => {
    if (!open || activeValue === null || listRef.current === null) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-value="${CSS.escape(activeValue)}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeValue]);

  const commit = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (selectable.length === 0) return;
      const currentIndex = activeValue === null ? -1 : selectable.findIndex((o) => o.value === activeValue);
      const next =
        currentIndex === -1
          ? delta > 0
            ? 0
            : selectable.length - 1
          : (currentIndex + delta + selectable.length) % selectable.length;
      setActiveValue(selectable[next].value);
    },
    [activeValue, selectable],
  );

  const typeahead = useCallback(
    (char: string) => {
      const now = Date.now();
      const state = typeaheadRef.current;
      state.buffer = now - state.at > 700 ? char : state.buffer + char;
      state.at = now;
      const match = selectable.find((o) => o.label.toLowerCase().startsWith(state.buffer.toLowerCase()));
      if (match !== undefined) setActiveValue(match.value);
    },
    [selectable],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled) return;
      const key = event.key;
      if (!open) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) {
          event.preventDefault();
          setOpen(true);
        } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          setOpen(true);
          typeahead(key);
        }
        return;
      }
      switch (key) {
        case 'ArrowDown': event.preventDefault(); moveActive(1); break;
        case 'ArrowUp': event.preventDefault(); moveActive(-1); break;
        case 'Home': event.preventDefault(); if (selectable[0]) setActiveValue(selectable[0].value); break;
        case 'End': event.preventDefault(); if (selectable.length) setActiveValue(selectable[selectable.length - 1].value); break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          if (activeValue !== null) commit(activeValue);
          break;
        case 'Escape':
          event.preventDefault();
          // Do NOT let this Escape reach a focus-trap ancestor (DetailDrawer / Modal): closing the
          // open listbox must not also close the drawer the Select sits in.
          event.stopPropagation();
          setOpen(false);
          break;
        case 'Tab': setOpen(false); break;
        default:
          if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) typeahead(key);
      }
    },
    [disabled, open, moveActive, selectable, activeValue, commit, typeahead],
  );

  const renderOption = (o: SelectOption) => (
    <div
      key={o.value}
      id={optionId(o.value)}
      role="option"
      aria-selected={o.value === value}
      aria-disabled={o.disabled === true || undefined}
      data-value={o.value}
      data-active={o.value === activeValue || undefined}
      className="select-option"
      onMouseEnter={() => o.disabled !== true && setActiveValue(o.value)}
      onClick={() => o.disabled !== true && commit(o.value)}
    >
      <span className="select-option-label">{o.label}</span>
      {o.value === value && (
        // The icon set's check, not a text dingbat from a fallback font (K-37); the SVG is the flex item.
        <CheckGlyph className="select-check" size={16} />
      )}
    </div>
  );

  // The listbox sits on the top tier of the overlay scale (K-28, D137), stated here on the portaled
  // node itself so a select inside a drawer, a dialog or the feedback dialog always opens above them.
  const popStyle: React.CSSProperties =
    pos === null
      ? { zIndex: 'var(--t-z-listbox)' }
      : {
          position: 'fixed',
          zIndex: 'var(--t-z-listbox)',
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
          ...(pos.anchor.edge === 'top' ? { top: pos.anchor.px } : { bottom: pos.anchor.px }),
        };

  return (
    <div className={`select${className !== undefined ? ` ${className}` : ''}`}>
      <button
        type="button"
        id={baseId}
        ref={triggerRef}
        className="select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeValue !== null ? optionId(activeValue) : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        <span className={`select-value${selected === undefined ? ' select-value--placeholder' : ''}`}>
          {triggerLabel}
        </span>
        <ChevronDownGlyph className="select-caret" size={16} />
      </button>
      {open &&
        createPortal(
          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="select-pop panel"
            ref={listRef}
            style={popStyle}
          >
            {(options ?? []).map(renderOption)}
            {(groups ?? []).map((g) => (
              <div key={g.label} role="group" aria-label={g.label} className="select-group">
                <div className="select-group-label" aria-hidden="true">
                  {g.label}
                </div>
                {g.options.map(renderOption)}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
