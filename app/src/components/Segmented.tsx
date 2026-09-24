/**
 * Segmented: pick exactly one of 2 to 5 sibling values that shape the same view (K-11, D137).
 *
 * Zeitraum Monat / Jahr, Liste / Board, the export format: a small, closed set where every option is
 * worth seeing at once. It replaces the hand-rolled "one of N" families (`.rv-seg`, the period
 * toggles, the kind pickers) that disagreed on height, selection treatment and ARIA.
 *
 * What it settles:
 *   - **A radio group, not tabs and not toggle buttons.** `role="radiogroup"` with one `role="radio"`
 *     per value and `aria-checked`, per the APG radio group: one Tab stop (roving tabindex), the arrow
 *     keys move AND select with wraparound, Home and End jump to the ends. A value is a choice, not a
 *     view of a record; that is what `Tabs` is for.
 *   - **A neutral raise, never the accent.** The chosen segment lifts off a `--t-bg-soft` track as
 *     `--t-bg-elev` with the control shadow and a hairline. The accent stays for the nav pill, the
 *     selected row and the one primary action; a segmented control on the same screen as "Buchen"
 *     must not compete with it (the owner's exemption, D137).
 *   - **32px, equal widths.** The track is 32px in both densities (the D116 dense band) and every
 *     segment takes the same width, so the chosen one does not change the control's shape.
 *   - **Six or more values are a `Select`**, not a wider strip. The component renders what it is given;
 *     the rule is the caller's, stated here so it is read before a sixth option is added.
 *
 * Controlled: the caller owns `value` and changes it in `onChange`.
 */
import { useRef, type KeyboardEvent } from 'react';

import './Segmented.css';

export interface SegmentedOption<V extends string = string> {
  /** The value reported to `onChange`; also the React key. */
  value: V;
  /** The visible label, already translated by the caller. */
  label: string;
}

export interface SegmentedProps<V extends string = string> {
  /** The 2 to 5 values, left to right. */
  options: readonly SegmentedOption<V>[];
  /** The chosen value, owned by the caller. */
  value: V;
  /** Called with the value the user picked. Not called when the chosen value is picked again. */
  onChange: (value: V) => void;
  /** The group's accessible name ("Zeitraum"). Pass this or `labelledBy`. */
  label?: string;
  /** The id of a visible element naming the group, instead of `label`. */
  labelledBy?: string;
  /** Disables every segment. */
  disabled?: boolean;
  /** An extra class on the track, for layout only (margins, alignment). */
  className?: string;
}

export function Segmented<V extends string = string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  disabled = false,
  className,
}: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosenIndex = options.findIndex((option) => option.value === value);
  // One Tab stop even when `value` names no option: the first segment takes it.
  const stopIndex = chosenIndex === -1 ? 0 : chosenIndex;

  const pick = (index: number, moveFocus: boolean) => {
    const option = options[index];
    if (option === undefined) return;
    if (option.value !== value) onChange(option.value);
    if (moveFocus) refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const count = options.length;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        pick((index + 1) % count, true);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        pick((index - 1 + count) % count, true);
        break;
      case 'Home':
        event.preventDefault();
        pick(0, true);
        break;
      case 'End':
        event.preventDefault();
        pick(count - 1, true);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      className={className === undefined ? 'segmented' : `segmented ${className}`}
    >
      {options.map((option, index) => {
        const checked = index === chosenIndex;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === stopIndex ? 0 : -1}
            disabled={disabled}
            className="segmented-option"
            onClick={() => pick(index, false)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
