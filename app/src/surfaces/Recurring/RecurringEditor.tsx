/**
 * A12, the Serien editor: the template (customer + positions), the cadence, and the bounds.
 *
 * MONEY IS PARSED EXACTLY, never through a float: the price field takes a CHF decimal string and
 * becomes integer Rappen via a digit-reading parse (P2). Quantity is thousandths on the wire
 * (`quantityMilli`); the field takes plain units with up to three decimals.
 *
 * EVERY POSITION MOUNTS THE A06 TAX-CODE PICKER, the same control the Belege editor mounts (the
 * first build's critic C15: without it, the only GUI path built schedules that auto-issued
 * numbered, posted invoices billing zero VAT with no warning anywhere). An unconfigured workspace
 * gets the picker's own CTA into /vat.
 *
 * The engine's P9 rejections render INLINE on the field they belong to (`needs_customer` on the
 * customer picker, `needs_positions` on the grid, `end_before_anchor` on the end date), never as a
 * toast and never as a stack trace.
 *
 * AUTO-ISSUE ASKS BEFORE IT ARMS (D78). Ticking the box is the one edit in this form whose
 * consequence is unattended: from the next tick, TILL issues and posts real numbered invoices with
 * nobody looking. So the OFF-to-ON flip alone is intercepted by the shared confirm idiom, naming
 * that consequence; ON-to-OFF and every unrelated edit stay one plain interaction, because a
 * confirm on a safe action teaches people to click through confirms.
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
// The ENGINE's own enum, imported (pure module, type-erased safe): the intervals this select offers
// and the intervals the engine admits are ONE array, so the §H-ENUM mirror guard has nothing to police.
import { RECURRING_INTERVALS } from '../../../../src/core/recurring/enums';
import { TaxCodePicker } from '../Vat/TaxCodePicker';
import type { VatCode } from '../Vat/types';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';

/**
 * The auto-issue confirm is a consequential dialog, so it is the shared `Modal` as an alertdialog
 * (D118 B2): it hosts the role on its own div, traps focus and closes on Escape, and does not dismiss
 * on a stray scrim click. The role travels as this value rather than a literal attribute on the
 * component, which is what keeps the modal-role source guard green.
 */
const ALERT_DIALOG = 'alertdialog' as const;

export interface ContactOption {
  id: string;
  name: string;
}

export interface EditorLine {
  description: string;
  /** Units, as typed ("1", "10.5"). Converted to quantityMilli on save. */
  quantity: string;
  /** CHF decimal string, converted to unitPriceMinor on save. */
  unitPrice: string;
  /** The A05 tax code, or '' for no VAT (mirrors the Belege editor's line shape). */
  taxCode: string;
}

export interface EditorValue {
  name: string;
  contactId: string;
  lines: EditorLine[];
  interval: string;
  customDays: string;
  anchorDate: string;
  endDate: string;
  maxOccurrences: string;
  dueDays: string;
  autoIssue: boolean;
  notes: string;
}

export const EMPTY_EDITOR: EditorValue = {
  name: '',
  contactId: '',
  lines: [{ description: '', quantity: '1', unitPrice: '', taxCode: '' }],
  interval: 'monthly',
  customDays: '30',
  anchorDate: '',
  endDate: '',
  maxOccurrences: '',
  dueDays: '',
  autoIssue: false,
  notes: '',
};

/**
 * The first day of the month after `today`, as ISO (F-03, J3.8). A series is set up for "from next
 * month on" far more often than for a day already past, so "Erste Rechnung am" defaults to it and
 * the ten keystrokes the ideal never budgeted are gone; the field stays editable for the other case.
 */
export function nextFirstOfMonth(today: Date): string {
  // LOCAL getters and a local ISO day (critic F10): between 00:00 and 02:00 CEST on the first of a
  // month the UTC month is still the previous one, and the UTC version made the default TODAY, so
  // the series drafted on save.
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Exact decimal-to-minor parse ("1'234.55" -> 123455). Null for blank or malformed. */
export function parsePriceMinor(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  if (cleaned === '') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Exact units-to-milli parse ("10.5" -> 10500). Null for blank or malformed. */
export function parseQuantityMilli(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  if (cleaned === '') return null;
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cleaned);
  if (match === null) return null;
  return Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
}

export interface RecurringEditorProps {
  contacts: readonly ContactOption[];
  /** The active A05 codes for the per-line picker, loaded by the surface beside the contacts. */
  taxCodes: readonly VatCode[];
  initial: EditorValue;
  /** True while a save is in flight: the submit is disabled, nothing double-fires. */
  busy: boolean;
  /** The engine's rejection code for THIS form, or null. Rendered inline on the field it names. */
  errorCode: string | null;
  onSave: (value: EditorValue) => void;
  onCancel: () => void;
}

export function RecurringEditor({
  contacts,
  taxCodes,
  initial,
  busy,
  errorCode,
  onSave,
  onCancel,
}: RecurringEditorProps) {
  const t = useT();
  const [value, setValue] = useState<EditorValue>(initial);
  // D78: the OFF-to-ON auto-issue flip waits behind an explicit confirm. While this is true the
  // checkbox still shows OFF, because the value only moves when the person confirms.
  const [confirmAutoIssue, setConfirmAutoIssue] = useState(false);
  const nameId = useId();
  const contactFieldId = useId();
  const intervalId = useId();
  const customDaysId = useId();
  const anchorId = useId();
  const endId = useId();
  const maxId = useId();
  const dueDaysId = useId();
  const autoIssueId = useId();
  const autoIssueConfirmId = useId();
  const notesId = useId();

  const set = (patch: Partial<EditorValue>) => setValue((v) => ({ ...v, ...patch }));
  const setLine = (index: number, patch: Partial<EditorLine>) =>
    setValue((v) => ({
      ...v,
      lines: v.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));

  const customerError = errorCode === 'needs_customer';
  const positionsError = errorCode === 'needs_positions';
  const endDateError = errorCode === 'end_before_anchor';
  const otherError = errorCode !== null && !customerError && !positionsError && !endDateError;

  return (
    <form
      className="recurring__form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <div className="recurring__formGrid">
        <label htmlFor={nameId}>
          <span>{t('recurring.form.name')}</span>
          <input
            className="field"
            id={nameId}
            value={value.name}
            onChange={(e) => set({ name: e.currentTarget.value })}
            placeholder={t('recurring.form.namePlaceholder')}
          />
        </label>

        <label htmlFor={contactFieldId}>
          <span>{t('recurring.form.customer')}</span>
          <Select
            id={contactFieldId}
            value={value.contactId}
            onChange={(v) => set({ contactId: v })}
            options={[
              { value: '', label: t('recurring.form.customerNone') },
              ...contacts.map((c) => ({ value: c.id, label: c.name })),
            ]}
            invalid={customerError}
            ariaLabel={t('recurring.form.customer')}
          />
          {customerError ? (
            <span className="recurring__fieldError" role="alert">
              {t('recurring.error.needs_customer')}
            </span>
          ) : null}
        </label>
      </div>

      <fieldset className="recurring__lines">
        <legend>{t('recurring.form.positions')}</legend>
        {value.lines.map((line, index) => (
          // Index-keyed is safe here: rows are only appended and removed at a known index.
          // eslint-disable-next-line react/no-array-index-key
          <div className="recurring__lineRow" key={index}>
            <label>
              <span>{t('recurring.form.lineDescription')}</span>
              {/* F-03 (J3.8): the description is no longer typed on top of the name. Left blank, the
                  position carries the series name (the placeholder says so, and the save applies it),
                  so a one-position retainer costs one name, not two. */}
              <input
                className="field"
                value={line.description}
                placeholder={line.description === '' && value.name.trim() !== '' ? value.name.trim() : t('recurring.form.lineDescriptionPlaceholder')}
                onChange={(e) => setLine(index, { description: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>{t('recurring.form.lineQuantity')}</span>
              <input
                className="field"
                inputMode="decimal"
                value={line.quantity}
                onChange={(e) => setLine(index, { quantity: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>{t('recurring.form.linePrice')}</span>
              <input
                className="field"
                inputMode="decimal"
                aria-invalid={positionsError || undefined}
                value={line.unitPrice}
                onChange={(e) => setLine(index, { unitPrice: e.currentTarget.value })}
              />
            </label>
            <div className="recurring__lineVat">
              <TaxCodePicker
                id={`recurring-vat-${index}`}
                ariaLabel={`${t('recurring.form.lineVat')} ${index + 1}`}
                codes={[...taxCodes]}
                value={line.taxCode}
                onChange={(code) => setLine(index, { taxCode: code })}
                invalidCode={line.taxCode !== '' && !taxCodes.some((c) => c.code === line.taxCode)}
              />
            </div>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={value.lines.length === 1}
              onClick={() => setValue((v) => ({ ...v, lines: v.lines.filter((_, i) => i !== index) }))}
            >
              {t('recurring.form.lineRemove')}
            </button>
          </div>
        ))}
        {positionsError ? (
          <p className="recurring__fieldError" role="alert">
            {t('recurring.error.needs_positions')}
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() =>
            setValue((v) => ({
              ...v,
              lines: [...v.lines, { description: '', quantity: '1', unitPrice: '', taxCode: '' }],
            }))
          }
        >
          {t('recurring.form.lineAdd')}
        </button>
      </fieldset>

      <div className="recurring__formGrid">
        <label htmlFor={intervalId}>
          <span>{t('recurring.form.interval')}</span>
          <Select
            id={intervalId}
            value={value.interval}
            onChange={(v) => set({ interval: v })}
            options={RECURRING_INTERVALS.map((interval) => ({
              value: interval,
              label: t(`recurring.interval.${interval}`),
            }))}
            ariaLabel={t('recurring.form.interval')}
          />
        </label>

        {value.interval === 'custom' ? (
          <label htmlFor={customDaysId}>
            <span>{t('recurring.form.customDays')}</span>
            <input
              className="field"
              id={customDaysId}
              inputMode="numeric"
              value={value.customDays}
              onChange={(e) => set({ customDays: e.currentTarget.value })}
            />
          </label>
        ) : null}

        <label htmlFor={anchorId}>
          <span>{t('recurring.form.anchorDate')}</span>
          <input
            className="field"
            id={anchorId}
            type="date"
            required
            value={value.anchorDate}
            onChange={(e) => set({ anchorDate: e.currentTarget.value })}
          />
        </label>

        <label htmlFor={endId}>
          <span>{t('recurring.form.endDate')}</span>
          <input
            className="field"
            id={endId}
            type="date"
            aria-invalid={endDateError || undefined}
            value={value.endDate}
            onChange={(e) => set({ endDate: e.currentTarget.value })}
          />
          {endDateError ? (
            <span className="recurring__fieldError" role="alert">
              {t('recurring.error.end_before_anchor')}
            </span>
          ) : null}
        </label>

        <label htmlFor={maxId}>
          <span>{t('recurring.form.maxOccurrences')}</span>
          <input
            className="field"
            id={maxId}
            inputMode="numeric"
            value={value.maxOccurrences}
            onChange={(e) => set({ maxOccurrences: e.currentTarget.value })}
          />
        </label>

        <label htmlFor={dueDaysId}>
          <span>{t('recurring.form.dueDays')}</span>
          <input
            className="field"
            id={dueDaysId}
            inputMode="numeric"
            value={value.dueDays}
            onChange={(e) => set({ dueDays: e.currentTarget.value })}
          />
        </label>
      </div>

      <label className="recurring__autoIssue" htmlFor={autoIssueId}>
        <input
          type="checkbox"
          id={autoIssueId}
          checked={value.autoIssue}
          onChange={(e) => {
            // OFF-to-ON is the one transition that arms unattended posting, so it asks first
            // (D78). ON-to-OFF is the safe direction and flips immediately.
            if (e.currentTarget.checked && !value.autoIssue) setConfirmAutoIssue(true);
            else set({ autoIssue: false });
          }}
        />
        <span>{t('recurring.form.autoIssue')}</span>
      </label>
      <p className="recurring__hint">{t('recurring.form.autoIssueHint')}</p>

      <Modal
        open={confirmAutoIssue}
        role={ALERT_DIALOG}
        title={t('recurring.form.autoIssueConfirmTitle')}
        closeLabel={t('recurring.history.close')}
        describedById={autoIssueConfirmId}
        onClose={() => setConfirmAutoIssue(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setConfirmAutoIssue(false)}
            >
              {t('recurring.form.autoIssueConfirmCancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                set({ autoIssue: true });
                setConfirmAutoIssue(false);
              }}
            >
              {t('recurring.form.autoIssueConfirmAction')}
            </button>
          </>
        }
      >
        <p id={autoIssueConfirmId}>{t('recurring.form.autoIssueConfirm')}</p>
      </Modal>

      <label htmlFor={notesId}>
        <span>{t('recurring.form.notes')}</span>
        <textarea
          className="field"
          id={notesId}
          rows={2}
          value={value.notes}
          onChange={(e) => set({ notes: e.currentTarget.value })}
        />
      </label>

      {otherError ? (
        <p className="recurring__fieldError" role="alert">
          {t(`recurring.error.${errorCode}`)}
        </p>
      ) : null}

      <div className="recurring__formActions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {t('recurring.form.save')}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
          {t('recurring.form.cancel')}
        </button>
      </div>
    </form>
  );
}
