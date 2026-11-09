/**
 * AccountCombobox: the typeable account picker (friction ledger F-03, J3.7), the generic `Combobox`
 * it is a thin face over, and `PickerButton`, the same combobox opened from a compact trigger (A2,
 * the bank inbox's "Buchen auf" and MWST cells).
 *
 * WHY THIS EXISTS. The journal composer's account fields were native `<select>`s over a hundred
 * rows: two clicks each, a scroll through the chart, and the account NUMBER a bookkeeper knows by
 * heart could not be typed. J3.7's ideal path is keyboard-first: type "6500", Enter, Tab on. Under
 * section 0.1 a native select costs two clicks, so the two selects alone were four of the eight
 * clicks the composer cost against an ideal of three.
 *
 * HAND-ROLLED, per the DESIGN.md dependency law: Base UI's combobox is pre-approved only when the
 * hand-rolled one would cost 500+ lines. This one follows the WAI-ARIA Authoring Practices combobox
 * pattern (editable combobox with list autocomplete):
 *   - the input carries role="combobox", aria-expanded, aria-controls and aria-activedescendant;
 *   - the popup is a listbox of options; ArrowDown/ArrowUp move the active option and wrap,
 *     Home/End jump, Enter accepts the active option, Escape closes and restores the last value;
 *   - typing filters: a digit query matches the CODE by prefix (the chart's own vocabulary), a word
 *     query matches the label; an exact code match is accepted on Enter, Tab or blur even when
 *     other codes share the prefix, so "6500" never has to be disambiguated against "6500x";
 *   - Tab and blur accept the single remaining match (or the exact code), otherwise restore the
 *     display text of the current value; an emptied field clears the value, because deleting the
 *     text is the one way a person says "none".
 * No pointer-tracking motion, no virtualisation (the chart is at most a few hundred rows and the list
 * renders 40 per group).
 *
 * THE MULTI-SOURCE EXTENSION (A2, 25.09.2026). A bank line is booked to an account, OR settles an
 * open invoice or bill, OR matches a payment run or an entry already on the books. The inbox's target
 * picker is therefore ONE list over several sources, never a second picker beside this one:
 *   - `groups` sections the list ("Aktuell", "Vorschläge", "Offene Rechnungen", "Konten"); a group
 *     flagged `hideWhileSearching` (the current value, the suggestions) steps aside once a query is
 *     typed, so a search answers from the sources and never repeats a row;
 *   - an option may carry a `meta` line (why it is suggested, which contact), a `trailing` figure
 *     (the open amount, tabular) and `keywords` the query also matches (a contact name, an amount), and
 *     `current` marks the selected row with a check glyph (never colour alone);
 *   - an option id is unique across groups (the caller prefixes it), so a suggested account and the
 *     same account in the chart are two rows with two ids.
 * `inline` renders the list in flow, always open, for the popover `PickerButton` hosts: the search
 * field has focus on open, Enter picks, Escape and Tab hand control back through `onDismiss`.
 *
 * `onCreate` is the inline-create hook (J1.1 step 5): when nothing matches and the caller offers it,
 * the list shows one create row and Enter on it hands the typed query back.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { CheckGlyph } from './states/glyphs';
import { ChevronDownGlyph, CloseGlyph } from './icons';
import './AccountCombobox.css';

export interface ComboboxOption {
  id: string;
  /** The short, typeable code (an account number, a contact's short code). Optional. */
  code?: string;
  label: string;
  /** A quiet second line under the label (why it is suggested, whose it is). Already localised. */
  meta?: string;
  /** A right-aligned figure beside the label (an open amount), rendered tabular. */
  trailing?: string;
  /** Extra text a query matches as a substring (a contact name, an amount), beside code and label. */
  keywords?: string;
  /** The key of the group this option belongs to, when the combobox is grouped. */
  group?: string;
  /** Marks the option that is the current value; rendered with a check glyph. */
  current?: boolean;
  /** Listed but not pickable; `meta` says why (prevention at the control). */
  disabled?: boolean;
}

export interface ComboboxGroup {
  key: string;
  /** The section heading, already localised. */
  label: string;
  /** The group steps aside while a query is typed (the current value, the suggestions). */
  hideWhileSearching?: boolean;
  /**
   * With no query typed, the list opens with this group's first option highlighted, so Enter takes it
   * (D167 polish 9: the bank picker's first TILL suggestion, not the actions above it).
   */
  defaultActive?: boolean;
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
  /** Focus the input on mount (a freshly added line, an opened popover). */
  autoFocus?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  /** Sections the list; options name theirs in `group`. Ungrouped options render first. */
  groups?: readonly ComboboxGroup[];
  /**
   * The popover form: the list renders in flow and is always open, the field starts empty (it is a
   * SEARCH field, not the value's display), and blur settles nothing. Escape and Tab call `onDismiss`.
   */
  inline?: boolean;
  /** Inline mode: the person left without picking (Escape) or moved on (Tab). */
  onDismiss?: (reason: 'escape' | 'tab') => void;
}

const LIST_CEILING = 40;
const CREATE_ID = '__create__';

function display(option: ComboboxOption | undefined): string {
  if (option === undefined) return '';
  return option.code !== undefined && option.code !== '' ? `${option.code} ${option.label}` : option.label;
}

/** Whether one option answers a query (lower-cased, trimmed, non-empty). */
function matchKind(o: ComboboxOption, q: string, digits: boolean): 'exact' | 'prefix' | 'label' | null {
  const code = (o.code ?? '').toLowerCase();
  if (code !== '' && code === q) return 'exact';
  if (code !== '' && code.startsWith(q)) return 'prefix';
  // A document number ("RE-2026-041") is a code too, but not a chart number: part of it is typed.
  if (code !== '' && !/^\d+$/.test(code) && code.includes(q)) return 'prefix';
  if ((o.keywords ?? '').toLowerCase().includes(q)) return 'label';
  if (!digits && (o.label.toLowerCase().includes(q) || display(o).toLowerCase().includes(q))) return 'label';
  return null;
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
    const kind = matchKind(o, q, digits);
    if (kind === 'exact') exact.push(o);
    else if (kind === 'prefix') prefix.push(o);
    else if (kind === 'label') label.push(o);
  }
  return [...exact, ...prefix, ...label].slice(0, LIST_CEILING);
}

/** One rendered section: its heading (null for the ungrouped head) and its visible options. */
interface Section {
  key: string;
  label: string | null;
  options: ComboboxOption[];
}

/** The visible sections for a query, in group order; ranking runs inside each group. */
export function rankSections(
  options: readonly ComboboxOption[],
  groups: readonly ComboboxGroup[] | undefined,
  query: string,
): Section[] {
  if (groups === undefined || groups.length === 0) return [{ key: '', label: null, options: rankOptions(options, query) }];
  const searching = query.trim() !== '';
  const known = new Set(groups.map((g) => g.key));
  const sections: Section[] = [];
  const loose = options.filter((o) => o.group === undefined || !known.has(o.group));
  if (loose.length > 0) sections.push({ key: '', label: null, options: rankOptions(loose, query) });
  for (const g of groups) {
    if (searching && g.hideWhileSearching === true) continue;
    const ranked = rankOptions(
      options.filter((o) => o.group === g.key),
      query,
    );
    if (ranked.length > 0) sections.push({ key: g.key, label: g.label, options: ranked });
  }
  return sections.filter((s) => s.options.length > 0);
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
  groups,
  inline = false,
  onDismiss,
}: ComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? `combobox-${generatedId}`;
  const listId = `${inputId}-listbox`;
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const selected = byId.get(value);

  const [openState, setOpen] = useState(false);
  const open = inline || openState;
  // The text in the field. While closed it mirrors the selected option; while open it is the query.
  // Inline, the field is a search field and starts empty.
  const [text, setText] = useState(() => (inline ? '' : display(selected)));
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A value set from outside (a default from the ledger, a reset) re-renders the display text,
  // but never while the person is typing.
  useEffect(() => {
    if (!open) setText(display(selected));
  }, [selected, open]);

  const sections = useMemo(() => (open ? rankSections(options, groups, text) : []), [open, options, groups, text]);
  const matches = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  const offersCreate = onCreate !== undefined && text.trim() !== '' && matches.length === 0;
  const rowCount = matches.length + (offersCreate ? 1 : 0);

  // The option the list rests on with no query: a `defaultActive` group's first pickable option, else the
  // first row. Typing ranks the matches and starts from the top again.
  const restIndex = useMemo(() => {
    if (text.trim() !== '' || groups === undefined) return 0;
    const preferred = new Set(groups.filter((g) => g.defaultActive === true).map((g) => g.key));
    if (preferred.size === 0) return 0;
    const at = matches.findIndex((o) => o.group !== undefined && preferred.has(o.group) && o.disabled !== true);
    return at < 0 ? 0 : at;
  }, [text, groups, matches]);
  useEffect(() => {
    if (open) setActive(restIndex);
  }, [open, restIndex]);

  const close = useCallback(() => {
    setOpen(false);
    setActive(0);
  }, []);

  const pick = useCallback(
    (option: ComboboxOption) => {
      if (option.disabled === true) return;
      onChange(option.id);
      if (!inline) setText(display(option));
      close();
    },
    [onChange, close, inline],
  );

  /** What Tab or blur settles on: the exact code, else the one remaining match, else the old value. */
  const settle = useCallback(() => {
    if (!open || inline) return;
    const q = text.trim();
    if (q === '') {
      if (value !== '') onChange('');
      setText('');
      close();
      return;
    }
    const exact = matches.find((o) => (o.code ?? '').toLowerCase() === q.toLowerCase());
    const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (target !== undefined && target.disabled !== true) pick(target);
    else {
      setText(display(selected));
      close();
    }
  }, [open, inline, text, value, onChange, matches, pick, selected, close]);

  // A pointer press outside settles the field the way blur does (the popover host owns this inline).
  useEffect(() => {
    if (!open || inline) return undefined;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) settle();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, inline, settle]);

  // Inline (inside a popover) the search field takes focus on open, every time: `autoFocus` alone is
  // applied once by React during the commit, before a portal host may be positioned.
  useEffect(() => {
    if (inline && autoFocus) inputRef.current?.focus();
    // Mount only: the popover mounts a fresh combobox per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the active option in view as the arrows walk a list longer than its box. Guarded: jsdom has
  // no layout and no `scrollIntoView`.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${listId}-opt-${active}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

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
      const exact = q === '' ? undefined : matches.find((o) => (o.code ?? '').toLowerCase() === q.toLowerCase());
      if (exact !== undefined && exact.disabled !== true) {
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
      if (inline) {
        onDismiss?.('escape');
        return;
      }
      setText(display(selected));
      close();
      return;
    }
    if (e.key === 'Tab') {
      if (inline) {
        e.preventDefault();
        onDismiss?.('tab');
        return;
      }
      settle();
    }
  }

  const activeId = open && rowCount > 0 ? `${listId}-opt-${active}` : undefined;

  const renderOption = (o: ComboboxOption, i: number) => (
    <li
      key={o.id}
      id={`${listId}-opt-${i}`}
      role="option"
      aria-selected={o.id === value}
      aria-disabled={o.disabled === true ? true : undefined}
      className={`combobox__option${i === active ? ' combobox__option--active' : ''}${o.meta !== undefined ? ' combobox__option--meta' : ''}${o.disabled === true ? ' combobox__option--disabled' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault();
        pick(o);
      }}
      onPointerMove={() => setActive(i)}
    >
      {o.code !== undefined && o.code !== '' && <span className="combobox__code t-num">{o.code}</span>}
      {o.meta === undefined ? (
        <span className="combobox__label">{o.label}</span>
      ) : (
        <span className="combobox__text">
          <span className="combobox__label">{o.label}</span>
          <span className="combobox__meta">{o.meta}</span>
        </span>
      )}
      {o.trailing !== undefined && <span className="combobox__trailing t-num">{o.trailing}</span>}
      {o.current === true && <CheckGlyph className="combobox__check" size={16} />}
    </li>
  );

  // One running index across every section, so aria-activedescendant and the arrows agree.
  let index = 0;
  const grouped = groups !== undefined && groups.length > 0;

  return (
    <div className={`combobox${inline ? ' combobox--inline' : ''}`} ref={rootRef}>
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
          if (inline) return;
          // A press inside the list moves focus nowhere (the options are not focusable), so the
          // blur that fires is the pointer's; the pointerdown handler on the option picks first.
          if (rootRef.current !== null && e.relatedTarget !== null && rootRef.current.contains(e.relatedTarget as Node)) return;
          settle();
        }}
        onKeyDown={onKeyDown}
      />
      {/* The inline list (the picker popover) is always visible, so it carries its own name for
          assistive tech; the in-field list keeps the original contract (named by its combobox) so a
          label query for the field still finds exactly one element. */}
      <ul id={listId} role="listbox" aria-label={inline ? ariaLabel : undefined} className="combobox__list" hidden={!open}>
        {grouped
          ? sections.map((section) => {
              const rows = section.options.map((o) => renderOption(o, index++));
              if (section.label === null) return rows;
              const headingId = `${listId}-group-${section.key}`;
              return (
                // A list item may not BE a group (axe aria-allowed-role), so the item steps aside
                // (role none) and the inner list is the group, labelled by its own first row.
                <li key={`group-${section.key}`} role="none" className="combobox__group">
                  <ul role="group" aria-labelledby={headingId} className="combobox__group-list">
                    <li id={headingId} role="presentation" className="combobox__group-label">
                      {section.label}
                    </li>
                    {rows}
                  </ul>
                </li>
              );
            })
          : matches.map((o, i) => renderOption(o, i))}
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

// --- PickerButton: the combobox behind a compact trigger ------------------------------------------

export interface PickerButtonProps {
  /** The trigger's accessible name; the row's identity belongs in it ("Buchen auf, Alpina Telecom"). */
  label: string;
  /** What the trigger shows: the current value with its glyph, or the placeholder. */
  children: ReactNode;
  options: readonly ComboboxOption[];
  groups?: readonly ComboboxGroup[];
  /** The selected option id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  /** The search field's accessible name and placeholder. */
  searchLabel: string;
  searchPlaceholder?: string;
  noMatchLabel?: string;
  /** The keyboard hint line at the foot of the popover (already localised), or none. */
  hint?: string;
  /** Controlled open state, so a caller can chain pickers (account, then VAT). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Composed onto the trigger button. */
  className?: string;
  /** The popover width in px. */
  width?: number;
  /** Forwarded to the trigger, so a caller can return focus to it or read its box. */
  triggerRef?: (el: HTMLButtonElement | null) => void;
  /** Extra attributes for the trigger (a test id, a describedby). */
  'aria-describedby'?: string;
  /**
   * Opt-in (D167): an icon button INSIDE the field that clears the value without opening the list.
   * Off by default, so every existing consumer renders exactly as before. Shown only while there is a
   * value (`value !== ''`) and the picker is enabled; `onClear` and `clearLabel` (its accessible name)
   * come with it.
   */
  clearable?: boolean;
  onClear?: () => void;
  clearLabel?: string;
  /**
   * Forwarded to the trigger, so a `Tooltip` wrapped around the picker opens on the trigger's hover and
   * focus and ties its description to the trigger (`aria-describedby`).
   */
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onFocus?: (event: React.FocusEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

interface PopPosition {
  left: number;
  maxHeight: number;
  anchor: { edge: 'top' | 'bottom'; px: number };
}

/**
 * The combobox opened from a button: the "select with search" pattern the bank inbox needs in a
 * dense row, where an always-visible text field per row would be a wall of inputs. The trigger is a
 * button (`aria-haspopup="listbox"`, `aria-expanded`); opening it portals a popover to <body> (a
 * dense list, a scrolling panel and a drawer all clip in-place popups, the `Select` finding) with the
 * search field focused, positioned against the trigger and flipped above near the viewport bottom.
 * Enter picks, Escape and Tab close, and focus returns to the trigger unless the caller moved it on
 * (the VAT picker after an account, Buchen after the VAT).
 */
export function PickerButton({
  label,
  children,
  options,
  groups,
  value,
  onChange,
  searchLabel,
  searchPlaceholder,
  noMatchLabel,
  hint,
  open: openProp,
  onOpenChange,
  disabled = false,
  className,
  width = 400,
  triggerRef,
  'aria-describedby': describedBy,
  clearable = false,
  onClear,
  clearLabel,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onKeyDown,
}: PickerButtonProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopPosition | null>(null);
  const popId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const closeAndReturn = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, [setOpen]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const compute = () => {
      const el = buttonRef.current;
      if (el === null) return;
      const r = el.getBoundingClientRect();
      const gap = 4;
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const placeBelow = below >= 320 || below >= above;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos({
        left,
        maxHeight: Math.max(200, Math.min(420, placeBelow ? below : above)),
        anchor: placeBelow ? { edge: 'top', px: r.bottom + gap } : { edge: 'bottom', px: window.innerHeight - r.top + gap },
      });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, width]);

  // A pointer press outside the trigger and the popover closes it without stealing focus back.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) === true) return;
      if (popRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, setOpen]);

  // Never `visibility: hidden` before the position is known: the search field inside must be
  // focusable on its first commit (an invisible element refuses focus, and the open-with-search-
  // focused contract would silently break). The layout effect positions it before the first paint.
  const style: React.CSSProperties =
    pos === null
      ? { position: 'fixed', zIndex: 'var(--t-z-listbox)', width, left: 0, top: 0 }
      : {
          position: 'fixed',
          zIndex: 'var(--t-z-listbox)',
          width,
          left: pos.left,
          ...(pos.anchor.edge === 'top' ? { top: pos.anchor.px } : { bottom: pos.anchor.px }),
          ['--picker-max-h' as string]: `${pos.maxHeight}px`,
        };

  const showClear = clearable && onClear !== undefined && value !== '' && !disabled;
  const trigger = (
    <button
      type="button"
      ref={(el) => {
        buttonRef.current = el;
        triggerRef?.(el);
      }}
      className={`picker-trigger${showClear ? ' picker-trigger--clearable' : ''}${className !== undefined ? ` ${className}` : ''}`}
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? popId : undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => setOpen(!open)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      <span className="picker-trigger__value">{children}</span>
      <ChevronDownGlyph className="picker-trigger__caret" size={16} />
    </button>
  );

  return (
    <>
      {showClear ? (
        // A button may not hold a button, so the clear control is the trigger's SIBLING, laid over the
        // field's trailing edge; the trigger keeps room for it (`picker-trigger--clearable`).
        <span className="picker-field">
          {trigger}
          <button
            type="button"
            className="picker-clear"
            aria-label={clearLabel}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onClear?.();
              buttonRef.current?.focus();
            }}
          >
            <CloseGlyph size={14} />
          </button>
        </span>
      ) : (
        trigger
      )}
      {open &&
        createPortal(
          <div id={popId} ref={popRef} className="picker-pop" style={style} data-placement={pos?.anchor.edge ?? 'top'}>
            <Combobox
              inline
              autoFocus
              ariaLabel={searchLabel}
              placeholder={searchPlaceholder ?? searchLabel}
              options={options}
              groups={groups}
              value={value}
              noMatchLabel={noMatchLabel}
              inputClassName="picker-pop__search"
              onChange={(id) => {
                // Close BEFORE handing the value on, so a caller that opens the next picker or moves
                // focus to Buchen in response is the last word on where focus goes.
                closeAndReturn();
                onChange(id);
              }}
              onDismiss={() => closeAndReturn()}
            />
            {hint !== undefined && <p className="picker-pop__hint">{hint}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
