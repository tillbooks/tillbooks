/**
 * The S10 VAT summary aggregation, pure so it is testable in isolation.
 *
 * ESTV treats VAT per rate: each line rounds independently (A06 does that in `computeLineTax`), and
 * the document total is the SUM of the already-rounded per-line taxes, never a re-round of a
 * document-level base. So this helper only groups and adds integers: the total it returns is exactly
 * the sum of the line taxes, and a mismatch against the line sum is a bug by definition (A06 §8),
 * never a UI rounding artefact.
 *
 * The ordinary rates group by `rateBp` (an 8.1% line and a 2.6% line are two rows). Reverse-charge
 * (Bezugsteuer) and import (Einfuhrsteuer) each get their own row regardless of rate, because the
 * summary badges them distinctly (spec §6 / S10) and they must never be conflated with an output row.
 *
 * The two 0% kinds are keyed by kind too, never by rate: zero-rated export (echt befreit, Ziffer 220)
 * and exempt (unecht, Ziffer 230) both carry rate 0 but report on DIFFERENT ESTV Ziffern, so a shared
 * "0.0%" row would preview a base no return line shows (M31 / US-A06.5: the two 0% kinds never share
 * a label or a row). Each gets its own row with its own humanized label.
 */

import type { LineVat, VatSummary, VatSummaryRow } from './types';

/** One taxed line's contribution to the summary. */
export interface VatContribution {
  kind: string;
  rateBp: number;
  baseMinor: number;
  taxMinor: number;
}

/**
 * The kinds that get their own summary row rather than grouping by rate: the special kinds
 * (reverse-charge, import) and the two distinct 0% kinds (zero-rated export, exempt), which must
 * never merge into a single "0.0%" row (M31). Everything else groups by rate.
 */
const KIND_KEYED = new Set(['reverse_charge', 'import', 'zero', 'exempt']);

function rowKeyFor(c: VatContribution): string {
  if (KIND_KEYED.has(c.kind)) return c.kind;
  return `rate:${c.rateBp}`;
}

/**
 * Aggregate the per-line VAT into summary rows and a total. Untaxed lines (kind `none`, or a line
 * with zero base and zero tax) contribute nothing. Zero-rated and exempt lines carry a base but no
 * tax, so they surface as a 0% row (their base is real, their tax is nil): the summary tells the
 * honest story rather than hiding a booked-but-untaxed line.
 */
export function summariseVat(contributions: VatContribution[]): VatSummary {
  const byKey = new Map<string, VatSummaryRow>();
  for (const c of contributions) {
    if (c.kind === 'none') continue;
    if (c.baseMinor === 0 && c.taxMinor === 0) continue;
    const key = rowKeyFor(c);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { key, kind: c.kind, rateBp: c.rateBp, baseMinor: c.baseMinor, taxMinor: c.taxMinor });
    } else {
      existing.baseMinor += c.baseMinor;
      existing.taxMinor += c.taxMinor;
    }
  }

  // Order: ordinary rates high to low, then the special kinds, so the common output rate leads.
  const rows = [...byKey.values()].sort((a, b) => {
    const special = (r: VatSummaryRow) => (r.kind === 'reverse_charge' || r.kind === 'import' ? 1 : 0);
    const sa = special(a);
    const sb = special(b);
    if (sa !== sb) return sa - sb;
    return b.rateBp - a.rateBp;
  });

  const totalTaxMinor = rows.reduce((sum, r) => sum + r.taxMinor, 0);
  return { rows, totalTaxMinor };
}

/** Narrow a `vat_preview` body to a contribution, or null when the line bears no VAT / errored. */
export function contributionOf(vat: LineVat | undefined): VatContribution | null {
  if (vat === undefined || vat.ok !== true) return null;
  if (vat.kind === 'none') return null;
  return { kind: vat.kind, rateBp: vat.rateBp, baseMinor: vat.netMinor, taxMinor: vat.taxMinor };
}
