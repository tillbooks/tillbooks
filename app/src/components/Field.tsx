/**
 * The one labelled control of the Studio (D187, the Ruhig sweep; DESIGN.md "Form and heading rhythm").
 *
 * A label over its control, then an optional hint and an optional error, on the shared `.form-row`
 * rhythm: label to field 4px, field to hint 4px. A `.form-stack` of Fields puts 16px between them and
 * `.form-actions` closes the form 24px below the last one, so a button never touches a field and no
 * surface restates the spacing in pixels.
 *
 * It wires what a hand-built row kept forgetting: the label's `htmlFor` to the control's `id`, and the
 * hint and the error into the control's `aria-describedby`, with `aria-invalid` while an error shows.
 * The control is the single child, passed as it is (`<input className="field" />`, a `Select`, a
 * combobox); Field only adds the ids it does not already carry.
 *
 * An explanation is words on demand (D152 rule 4): `info` puts an (i) beside the label whose tooltip
 * holds the sentence, instead of a caption under the field.
 */
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

import { IconButton } from './IconButton';
import { Select } from './Select';

export interface FieldProps {
  /** The visible label, sentence case. */
  label: ReactNode;
  /** The one control. Field adds `id`, `aria-describedby` and `aria-invalid` when it can. */
  children: ReactElement<Record<string, unknown>>;
  /** A short hint under the control (a format, a unit). Prefer `info` for anything longer. */
  hint?: ReactNode;
  /** The error under the control; marks the control invalid. Pair it with a glyph in the caller. */
  error?: ReactNode;
  /** An explanation behind an (i) beside the label: the tooltip's text. */
  info?: ReactNode;
  /** An explicit control id, when the caller needs to reference it elsewhere. */
  id?: string;
  /**
   * D187: the control's width, sized to what it holds instead of the whole line (the owner: "fields far
   * too large"). `code` a short code or number, `date` a date, `amount` an amount, `short` a word or a
   * PLZ-Ort, `name` a name or an e-mail, `full` the whole line (a text area, a long address). Omitted,
   * a field is `name` wide.
   */
  size?: 'code' | 'date' | 'amount' | 'short' | 'name' | 'full';
  className?: string;
}

export function Field({ label, children, hint, error, info, id: givenId, className, size = 'name' }: FieldProps) {
  const autoId = useId();
  const childProps = isValidElement(children) ? children.props : {};
  const id = givenId ?? (typeof childProps.id === 'string' ? childProps.id : `field-${autoId}`);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined || error === null || error === false ? undefined : `${id}-error`;
  const describedBy = [childProps['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  // The shared Select names its description and invalid state as props (`describedBy`, `invalid`), not as
  // aria attributes, so Field speaks its language: a native control gets the attributes, a Select the props.
  const isSelect = isValidElement(children) && children.type === Select;
  const control = isValidElement(children)
    ? cloneElement(
        children,
        isSelect
          ? {
              id,
              describedBy: [childProps.describedBy, hintId, errorId].filter(Boolean).join(' ') || undefined,
              ...(errorId === undefined ? {} : { invalid: true }),
            }
          : {
              id,
              'aria-describedby': describedBy,
              ...(errorId === undefined ? {} : { 'aria-invalid': true }),
            },
      )
    : children;

  return (
    <div className={['form-row', `form-row--${size}`, className].filter(Boolean).join(' ')}>
      {info === undefined ? (
        <label htmlFor={id}>{label}</label>
      ) : (
        <span className="field-label-row">
          <label htmlFor={id}>{label}</label>
          <IconButton icon="info" small context={info} />
        </span>
      )}
      {control}
      {hint === undefined ? null : (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {errorId === undefined ? null : (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
