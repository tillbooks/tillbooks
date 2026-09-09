/**
 * AccountCombobox: the typeable account picker (friction ledger F-03, J3.7), and the generic
 * `Combobox` it is a thin face over.
 *
 * WHY THIS EXISTS. The journal composer's account fields were native `<select>`s over a hundred
 * rows: two clicks each, a scroll through the chart, and the account NUMBER a bookkeeper knows by
 * heart could not be typed. J3.7's ideal path is keyboard-first: type "6500", Enter, Tab on. Under
 * section 0.1 a native select costs two clicks, so the two selects alone were four of the eight
 * clicks the composer cost against an ideal of three.
 *
 * HAND-ROLLED, per the DESIGN.md dependency law: Base UI's combobox is pre-approved only when the
 * hand-rolled one would cost 500+ lines. This one is about 260 lines of component against the
 * WAI-ARIA Authoring Practices combobox pattern (editable combobox with list autocomplete):
 *   - the input carries role="combobox", aria-expanded, aria-controls and aria-activedescendant;
 *   - the popup is a listbox of options; ArrowDown/ArrowUp move the active option and wrap,
 *     Home/End jump, Enter accepts the active option, Escape closes and restores the last value;
 *   - typing filters: a digit query matches the CODE by prefix (the chart's own vocabulary), a word
 *     query matches the label; an exact code match is accepted on Enter, Tab or blur even when
 *     other codes share the prefix, so "6500" never has to be disambiguated against "6500x";
 *   - Tab and blur accept the single remaining match (or the exact code), otherwise restore the
 *     display text of the current value; an emptied field clears the value, because deleting the
 *     text is the one way a person says "none".
 * No pointer-tracking motion, no portal (the surfaces that mount it own their stacking), no
 * virtualisation (the chart is at most a few hundred rows and the list renders 40).
 *
 * `onCreate` is the inline-create hook (J1.1 step 5): when nothing matches and the caller offers it,
 * the list shows one create row and Enter on it hands the typed query back.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import './AccountCombobox.css';

export interface ComboboxOption {
  id: string;
  /** The short, typeable code (an account number, a contact's short code). Optional. */
  code?: string;
  label: string;
}

export interface ComboboxProps {
  id?: string;
  ariaLabel: string;
  options: readonly ComboboxOption[];
  /** The selected option id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Rendered when the query matches nothing (already localised). */
  noMatchLabel?: string;
  /** Inline create: offered as the one row when nothing matches. Receives the typed query. */
  onCreate?: (query: string) => void;
  /** The create row's label for `query` (already localised). */
  createLabel?: (query: string) => string;
  /** Extra class on the input, so a surface's own field treatment applies (`field`, ...). */
  inputClassName?: string;
  /** Focus the input on mount (a freshly added line). */
  autoFocus?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

const LIST_CEILING = 40;
const CREATE_ID = '__create__';

function display(option: ComboboxOption | undefined): string {
  if (option === undefined) return '';
  return option.code !== undefined && option.code !== '' ? `${option.code} ${option.label}` : option.label;
}

/** Filter and rank: exact code, code prefix, label match; a digit query never matches labels. */
export function rankOptions(options: readonly ComboboxOption[], query: string): ComboboxOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return options.slice(0, LIST_CEILING);
  const digits = /^\d+$/.test(q);
  const exact: ComboboxOption[] = [];
  const prefix: ComboboxOption[] = [];
  const label: ComboboxOption[] = [];
  for (const o of options) {
    const code = (o.code ?? '').toLowerCase();
    if (code !== '' && code === q) exact.push(o);
    else if (code !== '' && code.startsWith(q)) prefix.push(o);
    else if (!digits && (o.label.toLowerCase().includes(q) || display(o).toLowerCase().includes(q))) label.push(o);
  }
  return [...exact, ...prefix, ...label].slice(0, LIST_CEILING);
}

export function Combobox({
  id,
  ariaLabel,
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  noMatchLabel,
  onCreate,
  createLabel,
  inputClassName,
  autoFocus = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: ComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? `combobox-${generatedId}`;
  const listId = `${inputId}-listbox`;
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const selected = byId.get(value);

  const [open, setOpen] = useState(false);
  // The text in the field. While closed it mirrors the selected option; while open it is the query.
  const [text, setText] = useState(() => display(selected));
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A value set from outside (a default from the ledger, a reset) re-renders the display text,
  // but never while the person is typing.
  useEffect(() => {
    if (!open) setText(display(selected));
  }, [selected, open]);

  const matches = useMemo(() => (open ? rankOptions(options, text) : []), [open, options, text]);
  const offersCreate = onCreate !== undefined && text.trim() !== '' && matches.length === 0;
  const rowCount = matches.length + (offersCreate ? 1 : 0);

  const close = useCallback(() => {
    setOpen(false);
    setActive(0);
  }, []);

  const pick = useCallback(
    (option: ComboboxOption) => {
      onChange(option.id);
      setText(display(option));
      close();
    },
    [onChange, close],
  );

  /** What Tab or blur settles on: the exact code, else the one remaining match, else the old value. */
  const settle = useCallback(() => {
    if (!open) return;
    const q = text.trim();
    if (q === '') {
      if (value !== '') onChange('');
      setText('');
      close();
      return;
    }
    const exact = matches.find((o) => (o.code ?? '').toLowerCase() === q.toLowerCase());
    const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (target !== undefined) pick(target);
    else {
      setText(display(selected));
      close();
    }
  }, [open, text, value, onChange, matches, pick, selected, close]);

  // A pointer press outside settles the field the way blur does.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) settle();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, settle]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      if (rowCount > 0) setActive((i) => (i + 1) % rowCount);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      if (rowCount > 0) setActive((i) => (i - 1 + rowCount) % rowCount);
      return;
    }
    if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(Math.max(0, rowCount - 1));
      return;
    }
    if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      const q = text.trim();
      const exact = matches.find((o) => (o.code ?? '').toLowerCase() === q.toLowerCase());
      if (exact !== undefined) {
        pick(exact);
        return;
      }
      if (offersCreate && active === matches.length) {
        onCreate?.(q);
        close();
        return;
      }
      const target = matches[active];
      if (target !== undefined) pick(target);
      return;
    }
    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setText(display(selected));
      close();
      return;
    }
    if (e.key === 'Tab') {
      settle();
    }
  }

  const activeId = open && rowCount > 0 ? `${listId}-opt-${active}` : undefined;

  return (
    <div className="combobox" ref={rootRef}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        className={inputClassName === undefined ? 'combobox__input' : `combobox__input ${inputClassName}`}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onClick={() => {
          if (!disabled && !open) setOpen(true);
        }}
        onBlur={(e) => {
          // A press inside the list moves focus nowhere (the options are not focusable), so the
          // blur that fires is the pointer's; the pointerdown handler on the option picks first.
          if (rootRef.current !== null && e.relatedTarget !== null && rootRef.current.contains(e.relatedTarget as Node)) return;
          settle();
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" className="combobox__list" hidden={!open}>
        {matches.map((o, i) => (
          <li
            key={o.id}
            id={`${listId}-opt-${i}`}
            role="option"
            aria-selected={o.id === value}
            className={`combobox__option${i === active ? ' combobox__option--active' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              pick(o);
            }}
            onPointerMove={() => setActive(i)}
          >
            {o.code !== undefined && o.code !== '' && <span className="combobox__code t-num">{o.code}</span>}
            <span className="combobox__label">{o.label}</span>
          </li>
        ))}
        {offersCreate && (
          <li
            key={CREATE_ID}
            id={`${listId}-opt-${matches.length}`}
            role="option"
            aria-selected={false}
            className={`combobox__option combobox__option--create${active === matches.length ? ' combobox__option--active' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              onCreate?.(text.trim());
              close();
            }}
            onPointerMove={() => setActive(matches.length)}
          >
            {createLabel !== undefined ? createLabel(text.trim()) : text.trim()}
          </li>
        )}
        {/* Critic F5: a listbox may only hold options, so the no-match row IS one, disabled and never
            selected; its id keeps aria-activedescendant from ever pointing past it. */}
        {open && rowCount === 0 && noMatchLabel !== undefined && (
          <li id={`${listId}-empty`} role="option" aria-disabled="true" aria-selected={false} className="combobox__empty">
            {noMatchLabel}
          </li>
        )}
      </ul>
    </div>
  );
}

export interface AccountLike {
  id: string;
  number: string;
  name: string;
}

export interface AccountComboboxProps {
  id?: string;
  ariaLabel: string;
  accounts: readonly AccountLike[];
  value: string;
  onChange: (accountId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  noMatchLabel?: string;
  inputClassName?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** The account face: the chart's number is the code, so "6500" + Enter lands on 6500. */
export function AccountCombobox({ accounts, ...rest }: AccountComboboxProps) {
  const options = useMemo<ComboboxOption[]>(() => accounts.map((a) => ({ id: a.id, code: a.number, label: a.name })), [accounts]);
  return <Combobox options={options} {...rest} />;
}
