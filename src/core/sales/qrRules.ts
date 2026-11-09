/**
 * The Swiss QR-bill's VALUE rules for master data, as pure functions with no imports (critic
 * phase0-installable r1 P0.4e-6/7, r2 R2-2).
 *
 * One definition serves every place a value is judged: `validateQrBill` (`qrbill.ts`) at render time,
 * `set_creditor_profile`, `create_contact` and `update_contact` where the value is typed, and the
 * Studio's issue readiness (`app/src/surfaces/Documents/invoice.ts`), which imports this file so the
 * dialog asks for a value the engine would later refuse instead of issuing without a payment part.
 * It stays dependency-free on purpose: the Studio bundles it.
 */

/** The IG v2.3 Table 8 per-field maximum lengths for a structured address (m-2). */
export const QR_ADDRESS_FIELD_MAX = { name: 70, street: 70, buildingNo: 16, postalCode: 16, town: 35 } as const;

/** The address elements the IG caps, in the order `validateQrBill` reports them. */
const CAPPED_ADDRESS_FIELDS = ['name', 'street', 'buildingNo', 'postalCode', 'town'] as const;

/** One broken value rule. `field` is the bare IG element name (`name`, `street`, `buildingNo`, ...). */
export interface QrValueIssue {
  field: string;
  reason: 'not_iso_3166' | 'too_long';
  /** For `too_long`: the IG maximum the value overran. */
  max?: number;
}

/** The structured-address elements the rules judge, each optional (a partial address is judged too). */
export type QrAddressValues = Partial<Record<'name' | 'street' | 'buildingNo' | 'postalCode' | 'town' | 'country', string | null | undefined>>;

/**
 * THE ONE CHOKEPOINT for the value rules of a structured address: the country is ISO 3166-1 alpha-2,
 * and no element overruns its IG v2.3 Table 8 maximum. It judges only the elements that are present
 * and non-empty, so it serves a partial address too (whether an element is REQUIRED is the caller's
 * rule).
 */
export function qrAddressValueIssues(address: QrAddressValues): QrValueIssue[] {
  const issues: QrValueIssue[] = [];
  const country = address.country;
  if (country != null && country.length > 0 && !/^[A-Za-z]{2}$/.test(country)) issues.push({ field: 'country', reason: 'not_iso_3166' });
  // m-2: the IG's per-field caps. A QR reader truncates or rejects an over-long element, so an
  // overrun is a flagged, fixable error, never a silently mangled payment part.
  for (const field of CAPPED_ADDRESS_FIELDS) {
    const value = address[field];
    if (value != null && value.length > QR_ADDRESS_FIELD_MAX[field]) issues.push({ field, reason: 'too_long', max: QR_ADDRESS_FIELD_MAX[field] });
  }
  return issues;
}

/**
 * The creditor-account rule of the payment part (IG v2.3 §4.2.2): a CH or LI IBAN (a QR-IBAN or a
 * plain one), compared in its normalised form. Shared by `validateQrBill` and `set_creditor_profile`.
 */
export function isQrCreditorIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) && (iban.startsWith('CH') || iban.startsWith('LI'));
}
