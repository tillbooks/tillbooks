/**
 * D164 (04.10.2026): THE one rule for the Leistungsdatum a document line is priced and posted at.
 *
 * A line's own `supply_date` wins (stated on the line: by an agent or MCP caller, by a person through
 * the line's own control, or pinned by `createCreditNote` on a derived Gutschrift). Else the
 * document-level `supply_date` (the Studio's "Datum", stated for the whole document). Else null,
 * which every caller already reads as "the issue date": A11 prices a null date at the code's stored
 * rate and A02 reconciles it at the entry date (which IS the issue date), with A11's
 * `needs_supply_date` refusal standing between them whenever the two disagree.
 *
 * Provenance is by STRUCTURE, never inferred from a date's value: a date is stated because it is
 * stored where a statement goes. Every posting path that prices document lines (A11's invoice
 * posting and its Swico /32/ tag, A13's credit-note derivation and posting, A14's Skonto VAT)
 * resolves the date through this function and nowhere else.
 */
export function lineSupplyDate(
  line: { supply_date: string | null },
  document: { supply_date?: string | null },
): string | null {
  return line.supply_date ?? document.supply_date ?? null;
}
