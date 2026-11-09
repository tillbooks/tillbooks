/**
 * P0.4e: the issue dialog ASKS for what the QR-bill still lacks, right where the invoice is issued.
 *
 * THE DEFECT. The first-run audit issued R-2026-0001 with no payment part: nothing had asked for the
 * company's own address (A00's one-panel setup saves the IBAN without it, by design, F-09) or for the
 * customer's (created inline in the invoice form with a name only). The dialog said so in a line of
 * consequence text, and the only ways out were links to other surfaces that a modal over an unsaved
 * draft cannot follow without losing the draft. So the first invoice a new company sent was one its
 * customer could not pay by QR.
 *
 * WHAT IT DOES. For each fixable gap (the creditor's name and structured address, the creditor IBAN,
 * the customer's structured address) the dialog shows exactly the missing block, prefilled with
 * whatever is already stored. On confirm, `planQrFix` turns what was typed into the owning verbs'
 * calls (`set_creditor_profile`, `update_contact`, the verbs Setup and Contacts already drive), the
 * editor runs them, and only then issues. A block left untouched is not saved and the invoice issues
 * exactly as before, still stating that it carries no payment part: the QR-bill stays a
 * CONSEQUENCE, never a blocker (A11-G9). A block half-filled is refused inline, before anything is
 * saved or issued, because half an address is a mistake, not a deferral (A00's own rule).
 */
import { useId } from 'react';

import { useT } from '../../i18n';
import { isValidIban } from '../../../../src/core/setup/iban.js';
import type { ContactAddress, CreditorView } from './invoice';

/** What the dialog must ask for. `customer` is null when the customer's address is complete. */
export interface QrFixNeeds {
  iban: boolean;
  creditorAddress: boolean;
  customer: { contactId: string; name: string } | null;
}

export interface QrFixValues {
  creditorName: string;
  creditorStreet: string;
  creditorBuildingNo: string;
  creditorZip: string;
  creditorTown: string;
  creditorCountry: string;
  iban: string;
  customerStreet: string;
  customerHouseNo: string;
  customerZip: string;
  customerCity: string;
  customerCountry: string;
}

export type QrFixBlock = 'creditor' | 'iban' | 'customer';

const BLOCK_FIELDS: Record<QrFixBlock, readonly (keyof QrFixValues)[]> = {
  creditor: ['creditorName', 'creditorStreet', 'creditorBuildingNo', 'creditorZip', 'creditorTown', 'creditorCountry'],
  iban: ['iban'],
  customer: ['customerStreet', 'customerHouseNo', 'customerZip', 'customerCity', 'customerCountry'],
};

/** The fields a block must carry to be saved. The house number is optional on a contact (IG v2.3). */
const BLOCK_REQUIRED: Record<QrFixBlock, readonly (keyof QrFixValues)[]> = {
  creditor: BLOCK_FIELDS.creditor,
  iban: ['iban'],
  customer: ['customerStreet', 'customerZip', 'customerCity', 'customerCountry'],
};

export function hasQrFixNeeds(needs: QrFixNeeds | null | undefined): needs is QrFixNeeds {
  return needs !== null && needs !== undefined && (needs.iban || needs.creditorAddress || needs.customer !== null);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The form's starting values: what is already stored, so the person types only what is missing. The
 * creditor name defaults to the company name (A00's own default) and a blank country to CH.
 */
export function initialQrFixValues(input: {
  creditor: CreditorView | null;
  companyName: string | null;
  customerAddress: ContactAddress | null | undefined;
}): QrFixValues {
  const a = (typeof input.creditor?.address === 'object' && input.creditor?.address !== null ? input.creditor.address : {}) as Record<string, unknown>;
  const c = input.customerAddress ?? null;
  return {
    creditorName: str(input.creditor?.name) || str(input.companyName),
    creditorStreet: str(a.street),
    creditorBuildingNo: str(a.buildingNo),
    creditorZip: str(a.zip),
    creditorTown: str(a.town),
    creditorCountry: str(a.country) || 'CH',
    iban: '',
    customerStreet: str(c?.street),
    customerHouseNo: str(c?.houseNo),
    customerZip: str(c?.zip),
    customerCity: str(c?.city),
    customerCountry: str(c?.country) || 'CH',
  };
}

/** One call the editor makes before issuing, to the verb that owns the data. */
export type QrFixCall =
  | { action: 'set_creditor_profile'; input: Record<string, unknown> }
  | { action: 'update_contact'; input: Record<string, unknown> };

export type QrFixPlan =
  /** Nothing was typed: issue exactly as before (no payment part, stated). */
  | { kind: 'none' }
  /** Something was typed but a block is not complete (or the IBAN is not an IBAN): nothing is saved. */
  | { kind: 'incomplete'; blocks: QrFixBlock[]; invalidIban: boolean }
  | { kind: 'save'; calls: QrFixCall[] };

/**
 * Turn the form into the owning verbs' calls. A block counts as ANSWERED when any of its fields
 * differs from where it started; an untouched block is skipped (the person chose to issue without
 * it). Every answered block must be complete, or the plan is `incomplete` and nothing is saved.
 */
export function planQrFix(needs: QrFixNeeds, initial: QrFixValues, values: QrFixValues): QrFixPlan {
  const asked: QrFixBlock[] = [
    ...(needs.creditorAddress ? (['creditor'] as const) : []),
    ...(needs.iban ? (['iban'] as const) : []),
    ...(needs.customer !== null ? (['customer'] as const) : []),
  ];
  const touched = asked.filter((b) => BLOCK_FIELDS[b].some((f) => values[f].trim() !== initial[f].trim()));
  if (touched.length === 0) return { kind: 'none' };

  const incomplete = touched.filter((b) => BLOCK_REQUIRED[b].some((f) => values[f].trim() === ''));
  const invalidIban = touched.includes('iban') && values.iban.trim() !== '' && !isValidIban(values.iban.replace(/\s+/g, '').toUpperCase());
  if (incomplete.length > 0 || invalidIban) return { kind: 'incomplete', blocks: incomplete, invalidIban };

  const calls: QrFixCall[] = [];
  const creditorInput: Record<string, unknown> = {};
  if (touched.includes('creditor')) {
    creditorInput.creditorName = values.creditorName.trim();
    creditorInput.address = {
      street: values.creditorStreet.trim(),
      buildingNo: values.creditorBuildingNo.trim(),
      zip: values.creditorZip.trim(),
      town: values.creditorTown.trim(),
      country: values.creditorCountry.trim().toUpperCase(),
    };
  }
  if (touched.includes('iban')) creditorInput.iban = values.iban.replace(/\s+/g, '').toUpperCase();
  if (Object.keys(creditorInput).length > 0) calls.push({ action: 'set_creditor_profile', input: creditorInput });
  if (touched.includes('customer') && needs.customer !== null) {
    calls.push({
      action: 'update_contact',
      input: {
        contactId: needs.customer.contactId,
        // A patch sets all five address fields at once (A09), so the stored ones ride along.
        patch: {
          address: {
            street: values.customerStreet.trim(),
            houseNo: values.customerHouseNo.trim(),
            zip: values.customerZip.trim(),
            city: values.customerCity.trim(),
            country: values.customerCountry.trim().toUpperCase(),
          },
        },
      },
    });
  }
  return { kind: 'save', calls };
}

/** The creditor fields in the order a Swiss address is written, with their copy keys. */
const CREDITOR_INPUTS: readonly { field: keyof QrFixValues; key: string; autoComplete: string }[] = [
  { field: 'creditorName', key: 'invoice.qrFix.field.name', autoComplete: 'organization' },
  { field: 'creditorStreet', key: 'invoice.qrFix.field.street', autoComplete: 'address-line1' },
  { field: 'creditorBuildingNo', key: 'invoice.qrFix.field.number', autoComplete: 'off' },
  { field: 'creditorZip', key: 'invoice.qrFix.field.zip', autoComplete: 'postal-code' },
  { field: 'creditorTown', key: 'invoice.qrFix.field.town', autoComplete: 'address-level2' },
  { field: 'creditorCountry', key: 'invoice.qrFix.field.country', autoComplete: 'country' },
];
const CUSTOMER_INPUTS: readonly { field: keyof QrFixValues; key: string }[] = [
  { field: 'customerStreet', key: 'invoice.qrFix.field.street' },
  { field: 'customerHouseNo', key: 'invoice.qrFix.field.number' },
  { field: 'customerZip', key: 'invoice.qrFix.field.zip' },
  { field: 'customerCity', key: 'invoice.qrFix.field.town' },
  { field: 'customerCountry', key: 'invoice.qrFix.field.country' },
];

export interface QrCompletionProps {
  needs: QrFixNeeds;
  values: QrFixValues;
  onChange: (next: QrFixValues) => void;
  disabled: boolean;
  /** The blocks the last confirm found incomplete, and whether the IBAN was not an IBAN. */
  incomplete: { blocks: QrFixBlock[]; invalidIban: boolean } | null;
}

/** The inline completion form inside the issue dialog: only the blocks that are missing. */
export function QrCompletion({ needs, values, onChange, disabled, incomplete }: QrCompletionProps) {
  const t = useT();
  const base = useId();
  const set = (field: keyof QrFixValues, value: string) => onChange({ ...values, [field]: value });
  const input = (field: keyof QrFixValues, key: string, autoComplete = 'off') => {
    const id = `${base}-${field}`;
    return (
      <label key={field} className="documents-field" htmlFor={id}>
        <span>{t(key)}</span>
        <input
          id={id}
          className="field"
          type="text"
          value={values[field]}
          disabled={disabled}
          autoComplete={autoComplete}
          onChange={(e) => set(field, e.target.value)}
        />
      </label>
    );
  };

  return (
    <div className="documents-confirm-qrfix">
      <p className="documents-confirm-qrfix-title">{t('invoice.qrFix.title')}</p>
      <p>{t('invoice.qrFix.lead')}</p>
      {needs.creditorAddress && (
        <fieldset className="documents-confirm-qrfix-block" disabled={disabled}>
          <legend>{t('invoice.qrFix.creditorHeading')}</legend>
          {CREDITOR_INPUTS.map((i) => input(i.field, i.key, i.autoComplete))}
        </fieldset>
      )}
      {needs.iban && (
        <fieldset className="documents-confirm-qrfix-block" disabled={disabled}>
          <legend>{t('invoice.qrFix.ibanHeading')}</legend>
          {input('iban', 'invoice.qrFix.field.iban')}
        </fieldset>
      )}
      {needs.customer !== null && (
        <fieldset className="documents-confirm-qrfix-block" disabled={disabled}>
          <legend>{t('invoice.qrFix.customerHeading', { name: needs.customer.name })}</legend>
          {CUSTOMER_INPUTS.map((i) => input(i.field, i.key))}
        </fieldset>
      )}
      {incomplete !== null && (
        <p className="documents-confirm-error" role="alert">
          {incomplete.invalidIban ? t('invoice.qrFix.invalidIban') : t('invoice.qrFix.incomplete')}
        </p>
      )}
    </div>
  );
}
