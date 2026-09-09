/**
 * The SHARED custom-field input, mounted by any surface that renders a customizable record.
 *
 * SHIPPED HERE, USED EVERYWHERE. This is one half of what makes G00 a framework rather than a screen:
 * a surface renders `<CustomFieldRow>` per live def for its entity kind and gains typed custom fields
 * with no per-field code. It takes the def and the value as props and reports edits upward, so it
 * holds no client, no workspace id and no fetch: the host surface already has all three, and a
 * component that fetched for itself would issue one request per field on every screen it appears on.
 *
 * RETRO-FITTING IT INTO THE FIFTEEN SURFACES THAT SHIPPED BEFORE G00 IS THE D47 RETROFIT PASS, not
 * this build. G00 owns none of those files. What G00 owes is a component that is genuinely reusable
 * when that pass comes, and the way to owe that honestly is to consume it here first, which the
 * Anpassung surface's own preview does.
 */
import { useId } from 'react';

import { formatMoney } from '../../i18n';

/** One field definition, exactly as `list_field_defs` returns it. */
export interface FieldDefDto {
  fieldDefId: string;
  entityKind: string;
  key: string;
  labelI18n: Record<string, string>;
  type: string;
  options: string[] | null;
  required: boolean;
  defaultValue: unknown;
  sort: number;
  archived: boolean;
  draft: boolean;
}

export interface CustomFieldRowProps {
  def: FieldDefDto;
  /** The stored value, or null when the record has none. */
  value: unknown;
  locale: string;
  /**
   * The currency a `money`-typed field's preview is rendered in. The workspace base currency, passed
   * by the host: G00 stores a plain integer Rappen count and declares no currency of its own, so
   * inventing one here would be the component asserting a fact it does not have.
   */
  currency?: string;
  disabled?: boolean;
  /** Reports the edited value. `null` means the operator cleared it. */
  onChange: (value: unknown) => void;
}

/**
 * The label in the viewer's locale.
 *
 * A field label is NEVER an i18n key: it is the string whoever defined the field typed, so a field is
 * named once and reads the same in every surface and every report. `fr-CH`/`it-CH` fall back to `en`,
 * which is honest (the label was never written in those) rather than showing a machine key.
 */
export function labelFor(def: FieldDefDto, locale: string): string {
  return def.labelI18n[locale] ?? def.labelI18n['en'] ?? def.key;
}

export function CustomFieldRow({
  def,
  value,
  locale,
  currency = 'CHF',
  disabled = false,
  onChange,
}: CustomFieldRowProps) {
  const inputId = useId();
  const label = labelFor(def, locale);
  const common = { id: inputId, disabled, required: def.required };

  function control() {
    switch (def.type) {
      case 'bool':
        return (
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        );
      case 'number':
        return (
          <input
            {...common}
            type="number"
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(e) => onChange(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
          />
        );
      case 'money':
        // A money field is an integer RAPPEN count on the wire and a franc amount on screen. The
        // conversion happens once, here at the edge (P11/P2), and never in storage: entering 12.35
        // stores 1235, and a value that cannot be expressed in whole Rappen is not representable.
        return (
          <input
            {...common}
            type="number"
            step="0.01"
            value={typeof value === 'number' ? (value / 100).toFixed(2) : ''}
            onChange={(e) =>
              onChange(e.currentTarget.value === '' ? null : Math.round(Number(e.currentTarget.value) * 100))
            }
          />
        );
      case 'date':
        return (
          <input
            {...common}
            type="date"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)}
          />
        );
      case 'select':
        return (
          <select
            {...common}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)}
          >
            <option value="" />
            {(def.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );
      case 'multiselect':
        return (
          <select
            {...common}
            multiple
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={(e) =>
              onChange([...e.currentTarget.selectedOptions].map((option) => option.value))
            }
          >
            {(def.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );
      default:
        // text, contact_ref, entity_ref: all carry a string id or free text on the wire.
        return (
          <input
            {...common}
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)}
          />
        );
    }
  }

  return (
    <div className="custom-field-row">
      <label className="custom-field-row__label" htmlFor={inputId}>
        {label}
      </label>
      {control()}
      {def.type === 'money' && typeof value === 'number' ? (
        <span className="custom-field-row__hint tabular">{formatMoney(value, currency)}</span>
      ) : null}
    </div>
  );
}
