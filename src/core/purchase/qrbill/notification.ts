/**
 * IG v2.3 §4.4 Table 10, the notices of a "DO NOT USE FOR PAYMENT" QR-bill, in the four languages and
 * in capitals as the guideline prescribes ("Deviating entries may lead to misprocessing"). Such a bill
 * carries the amount 0.00, which is not the bill's amount: it is collected by direct debit or eBill.
 *
 * One definition for both A31 readers (critic R2-L1): the strict decoder of supplied payloads
 * (`decode.ts`) and the per-field text-layer pass (`captureParse.ts`) must agree that such a bill
 * proposes no amount.
 */
export const NOTIFICATION_NOTICES: ReadonlySet<string> = new Set([
  'NICHT ZUR ZAHLUNG VERWENDEN',
  'NE PAS UTILISER POUR LE PAIEMENT',
  'NON UTILIZZARE PER IL PAGAMENTO',
  'DO NOT USE FOR PAYMENT',
]);
