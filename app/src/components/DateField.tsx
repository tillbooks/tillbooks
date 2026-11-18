/**
 * D195: the shared DateField. A date is typed as text in the person's format (`appearance.date_format`:
 * `31.12.2026`, `2026-12-31` or `12/31/2026`) and handed on as ISO (`YYYY-MM-DD`), the shape every verb takes.
 *
 * WHY NOT `<input type="date">` ALONE. The native field shows the BROWSER's locale (a US macOS shows
 * `mm/dd/yyyy` to a Swiss person), it cannot be told which format to use, and an empty one renders a mask that
 * reads like a value. The text field shows exactly the person's format, and an empty one shows its placeholder,
 * never today.
 *
 * THE CALENDAR is the browser's own: a hidden `type="date"` beside the text, opened with `showPicker()`. A
 * click on the calendar glyph inside the field opens it, and so does Alt+ArrowDown in the text (the native
 * date field's own key), so the glyph needs no button of its own: it is not one of the vocabulary's glyphs
 * (DESIGN.md "Icon vocabulary"), and a pointer-only shortcut beside a keyboard one is not a hidden control.
 *
 * A typed date is read when the field is left or on Enter. Text that is not a real date in the chosen format
 * stays as typed, marked invalid with the format in words; nothing is guessed. An emptied field is "no date".
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { useT, formatDateAs, formatPrefsNow, parseDateAs, type DateFormat } from '../i18n';
import { CalendarGlyph } from './icons';
import './DateField.css';

export interface DateFieldProps {
  /** The date as ISO (`2026-12-31`), or null for none. */
  value: string | null;
  onChange: (iso: string | null) => void;
  /** The accessible name ("Von"); a visible label stays the host's. */
  ariaLabel?: string;
  id?: string;
  /** The calendar's bounds, ISO. */
  min?: string | null;
  max?: string | null;
  /** The host's own invalid state (an inverted range), on top of an unreadable date. */
  invalid?: boolean;
  /** Element ids that describe the field (the host's reason). */
  describedBy?: string;
  className?: string;
  disabled?: boolean;
  /** Pin the format (a suite); the person's `appearance.date_format` otherwise. */
  format?: DateFormat;
}

/** Opens the browser's own date picker on a `type="date"` input, where it can. */
function openPicker(input: HTMLInputElement | null): void {
  if (input === null) return;
  const withPicker = input as HTMLInputElement & { showPicker?: () => void };
  try {
    if (typeof withPicker.showPicker === 'function') {
      withPicker.showPicker();
      return;
    }
  } catch {
    // A browser that refuses (no user activation, an old engine) falls through to focus and click.
  }
  input.focus();
  input.click();
}

export function DateField({ value, onChange, ariaLabel, id, min = null, max = null, invalid = false, describedBy, className, disabled = false, format }: DateFieldProps) {
  const t = useT();
  const fmt: DateFormat = format ?? formatPrefsNow().dateFormat;
  const own = useId();
  const inputId = id ?? `date-field-${own}`;
  const whyId = `${inputId}-why`;
  const shown = value === null ? '' : formatDateAs(value, fmt);
  const [text, setText] = useState(shown);
  const [unreadable, setUnreadable] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  // A value set from outside (the calendar, a cleared filter, a deep link) replaces what the field shows.
  useEffect(() => {
    setText(shown);
    setUnreadable(false);
  }, [shown]);

  const commit = () => {
    const typed = text.trim();
    if (typed === '') {
      setUnreadable(false);
      if (value !== null) onChange(null);
      return;
    }
    const iso = parseDateAs(typed, fmt);
    if (iso === null) {
      setUnreadable(true);
      return;
    }
    setUnreadable(false);
    setText(formatDateAs(iso, fmt));
    if (iso !== value) onChange(iso);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      return;
    }
    if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      openPicker(picker.current);
    }
  };
  const described = [describedBy, unreadable ? whyId : undefined].filter((x): x is string => x !== undefined && x !== '').join(' ');

  return (
    <span className={`date-field${className !== undefined ? ` ${className}` : ''}`} data-invalid={invalid || unreadable ? 'true' : undefined}>
      <span
        className="date-field__glyph"
        aria-hidden="true"
        onClick={() => {
          if (!disabled) openPicker(picker.current);
        }}
      >
        <CalendarGlyph size={16} />
      </span>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        className="field date-field__input t-num"
        value={text}
        placeholder={t(`date.placeholder.${fmt}`)}
        aria-label={ariaLabel}
        aria-invalid={invalid || unreadable || undefined}
        aria-describedby={described === '' ? undefined : described}
        aria-keyshortcuts="Alt+ArrowDown"
        title={unreadable ? t('date.unreadable', { format: t(`date.placeholder.${fmt}`) }) : undefined}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <input
        ref={picker}
        type="date"
        className="date-field__native"
        tabIndex={-1}
        aria-hidden="true"
        value={value ?? ''}
        min={min ?? undefined}
        max={max ?? undefined}
        disabled={disabled}
        onChange={(e) => {
          const iso = e.target.value === '' ? null : e.target.value;
          if (iso !== value) onChange(iso);
        }}
      />
      {unreadable && (
        <span id={whyId} className="visually-hidden" role="status">
          {t('date.unreadable', { format: t(`date.placeholder.${fmt}`) })}
        </span>
      )}
    </span>
  );
}
