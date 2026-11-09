/**
 * Shapes for the reusable A06 VAT controls (S9 picker, S10 summary, the per-line readout).
 *
 * These live under `surfaces/**` so their `messages.*.json` are globbed by the i18n merge, and so
 * A11 (invoice line editor) and A17 (expense form) reuse the same controls, the same i18n, and the
 * same `vat_preview` code path as the Journal EntryDrawer (S11). Re-declared, never imported from the
 * engine, per the browser/engine boundary (see `lib/client.ts`).
 */

/** A tax code as returned by `vat_codes` (the engine `listTaxCodes` read model). */
export interface VatCode {
  code: string;
  kind: string;
  rateBp: number;
  formLine: string | null;
  label: string;
  active: boolean;
}

/** The frozen §H-VAT-TRACE the preview carries, stamped onto the posted line so A07 reproduces it. */
export interface VatTraceBody {
  taxCode: string | null;
  taxBaseMinor: number | null;
  taxAmountMinor: number | null;
}

/** The successful `vat_preview` / `computeLineTax` result the readout and summary consume. */
export interface LineVatOk {
  ok: true;
  kind: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  rateBp: number;
  deductible: boolean;
  formLine: string | null;
  trace: VatTraceBody;
}

/** A rejected preview (an unknown or archived code on an old draft). */
export interface LineVatErr {
  ok: false;
  error: string;
}

export type LineVat = LineVatOk | LineVatErr;

/** One aggregated summary row: a rate (or a special kind) with its base and tax across the document. */
export interface VatSummaryRow {
  /** A stable key: the rate in basis points, or `reverse_charge` / `import` for the special kinds. */
  key: string;
  kind: string;
  rateBp: number;
  baseMinor: number;
  taxMinor: number;
}

export interface VatSummary {
  rows: VatSummaryRow[];
  totalTaxMinor: number;
}
