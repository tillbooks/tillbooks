/**
 * S9, the A06 tax-code picker: pick a MWST code from valid values only.
 *
 * Built once here and reused by the Journal EntryDrawer (S11), the A11 invoice line editor and the
 * recurring-invoice editor. It is the shared `Select` (K-30, D137): the composer used to set a native
 * `<select>` for the code beside the shared select for the cost centre, two control families at two
 * heights in one row. The options stay grouped by kind so each group stays short (the Hick fix, not a
 * second control), the humanized label leading and the raw code trailing but visible.
 *
 * The states it owns (spec §6): unconfigured renders a banner-CTA to /vat instead of a dropdown
 * (never posts untaxed, P9 `needs_vat_config`); an archived or unknown code on an old draft flags
 * inline via the field's own `aria-describedby` (announced, not colour-only); permission-denied
 * renders the current code as read-only text with no edit affordance. Loading is the caller's
 * skeleton with `disabled` set.
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { Select, type SelectOption } from '../../components/Select';
import type { VatCode } from './types';
import { groupOf } from './format';

export interface TaxCodePickerProps {
  /** Stable id so a label / readout can point at the control. */
  id?: string;
  /** Accessible name (the control has no visible label of its own in a dense grid). */
  ariaLabel: string;
  /** The active codes to offer. */
  codes: VatCode[];
  /** The selected code, or '' for no VAT. */
  value: string;
  onChange: (code: string) => void;
  /** Loading: the control renders disabled inside the caller's line skeleton. */
  disabled?: boolean;
  /** Permission-denied: render the current code as read-only text, no dropdown. */
  readOnly?: boolean;
  /** Unconfigured workspace (P9): no dropdown, a quiet banner-CTA into /vat instead. */
  needsConfig?: boolean;
  /** The selected value is not among the active codes (archived or unknown): flag inline. */
  invalidCode?: boolean;
  /** M5: a non-import tag left on a VAT-account line (2200/1170/1171): flag inline, the trace
   *  belongs on the revenue/expense line whose amount is the tax base. */
  strandedOnVatAccount?: boolean;
}

const GROUP_ORDER = ['output', 'input', 'special', 'exempt'] as const;

export function TaxCodePicker({
  id,
  ariaLabel,
  codes,
  value,
  onChange,
  disabled = false,
  readOnly = false,
  needsConfig = false,
  invalidCode = false,
  strandedOnVatAccount = false,
}: TaxCodePickerProps) {
  const t = useT();

  if (needsConfig) {
    return (
      <div className="vat-needs-config" role="note">
        <span className="vat-needs-config-text">{t('vat.needsConfig')}</span>
        <Link className="vat-needs-config-cta link-inline" to="/vat">
          {t('vat.needsConfigCta')}
        </Link>
      </div>
    );
  }

  if (readOnly) {
    return (
      <span className="vat-code-readonly" aria-label={ariaLabel}>
        {value === '' ? t('vat.line.none') : value}
      </span>
    );
  }

  const errorId = id !== undefined ? `${id}-err` : undefined;
  const flagged = invalidCode || strandedOnVatAccount;
  const groups = GROUP_ORDER.map((g) => ({
    label: t(`vat.group.${g}`),
    options: codes
      .filter((c) => groupOf(c.kind) === g)
      .map((c): SelectOption => ({ value: c.code, label: `${c.label} · ${c.code}` })),
  })).filter((g) => g.options.length > 0);

  // A selected code missing from the offered list (archived, unknown, or stranded on a VAT-account
  // line whose list is import-only) stays selectable, so the line still shows what it carries rather
  // than silently snapping to another code.
  const stray: SelectOption[] =
    flagged && value !== '' && !codes.some((c) => c.code === value) ? [{ value, label: value }] : [];

  return (
    <div className="vat-code-picker">
      <Select
        id={id}
        ariaLabel={ariaLabel}
        value={value}
        disabled={disabled}
        invalid={flagged}
        describedBy={flagged ? errorId : undefined}
        onChange={onChange}
        options={[{ value: '', label: t('vat.line.none') }, ...stray]}
        groups={groups}
      />
      {flagged && (
        <p id={errorId} role="alert" className="vat-code-error">
          {strandedOnVatAccount ? t('vat.error.vatAccountTag') : t('vat.error.archivedCode')}
        </p>
      )}
    </div>
  );
}
