/**
 * A31 §0a, a DECODED supplied payload as capture fields. Pure mapping, no I/O.
 *
 * Every field carries the SUPPLIER's provenance (`operator` or `agent`) at `confidence:'high'`: the
 * values were checked against the guideline, so nothing about them is a guess, but WHO asserted that
 * the payload is this bill's is the supplier, and provenance records exactly that (§0a item 10). The
 * Swico S1 tags come back from the shared parser stamped `swico`, and are re-stamped here for the same
 * reason: `swico` means "read from the stored bytes", which a supplied payload is not.
 *
 * Nothing is proposed that the payload does not state: an open amount proposes no `amount`, a `NON`
 * reference proposes no `reference`, and the ultimate debtor (the payer, usually this workspace) is not
 * a capture field at all. What ANOTHER bill stated is not proposed either: these fields reach the
 * capture only as one whole bill through the bill chokepoint (`../billMerge.ts` `mergeBill`), which
 * retires every field of the bill it takes over that this one does not restate, so an open amount
 * CLEARS the other bill's amount rather than leaving it live beside the new creditor.
 */

import type { CaptureQrPayloadSource } from '../captureEnums.js';
import type { DecodedQrBill } from './decode.js';

export interface DecodedField {
  key: string;
  value: unknown;
  provenance: CaptureQrPayloadSource;
  confidence: 'high';
}

export function decodedBillFields(bill: DecodedQrBill, provenance: CaptureQrPayloadSource): DecodedField[] {
  const out: DecodedField[] = [];
  const push = (key: string, value: unknown): void => {
    out.push({ key, value, provenance, confidence: 'high' });
  };
  const c = bill.creditor;
  push('vendor_name', c.name);
  push('vendor_address', {
    ...(c.street !== undefined ? { street: c.street } : {}),
    ...(c.buildingNumber !== undefined ? { buildingNumber: c.buildingNumber } : {}),
    postalCode: c.postalCode,
    town: c.town,
    country: c.country,
  });
  push('iban', bill.iban);
  if (bill.amountMinor !== null) push('amount', { minor: bill.amountMinor, currency: bill.currency });
  push('currency', bill.currency);
  push('reference_type', bill.referenceType);
  if (bill.reference !== null) push('reference', bill.reference);
  if (bill.unstructuredMessage !== null) push('payment_message', bill.unstructuredMessage);
  for (const f of bill.swico?.fields ?? []) {
    // The shared Swico parser lands only values it read; a value it could not read was dropped there
    // and comes back as a decoder warning, never as a field.
    push(f.key, f.value);
  }
  return out;
}
