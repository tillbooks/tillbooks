/**
 * A05, `resolveTax`: the P6 contract, defined EXACTLY ONCE (risk R2, the method-explosion guard).
 *
 * A pure lookup of a line's `tax_code` against the workspace enum + method (effektiv/saldo) + timing
 * (ist/soll), returning the debit/credit effect, deductibility, and ESTV form line that A06 stamps and
 * A07 reads. This is the single branch point for `effektiv/saldo × ist/soll × kind`; no other spec
 * re-derives VAT method logic. A05 defines the function and the mapping; it never posts (P3 by absence).
 *
 * Key MWSTG rules encoded here:
 * - Art. 37 Saldosteuersatz: under `saldo`, input tax is NOT separately reclaimable (`deductible:false`
 *   for every kind), and an output line reports under the workspace's Saldo Ziffer, not the per-rate one.
 * - Art. 21 ausgenommen (`exempt`): no output tax AND no input deduction. (The Vorsteuerkorrektur that
 *   exempt turnover triggers on OTHER lines, Art. 29/30, Ziffer 415, is a period-level computation A07
 *   owns: no per-line P6 result can express it, and A05 deliberately does not.)
 * - Art. 23 echt befreit (`zero`): 0% output, input preserved (but this line itself bears no input tax).
 * - Art. 45 Bezugsteuer (`reverse_charge`): owed always; deductible (and thus `sign:'both'`) ONLY under
 *   effektiv. Under saldo the flat rate already imputes input tax (MWSTV Art. 91), so it is owed but not
 *   reclaimable (`sign:'credit'`, `deductible:false`). Under effektiv the owed leg reports in the 38x
 *   family and the deduction leg at the Vorsteuer Ziffer; A06 posts the two legs.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { vatRatesOn, isValidRateDate } from './rateEras.js';
import {
  generationOn,
  methodOn,
  saldoDeclarationRegimeForPeriod,
  saldoFormLineForPosition,
} from './saldoGenerations.js';

export type TaxSign = 'credit' | 'debit' | 'both' | 'none';

export interface ResolveTaxInput {
  /** The line's tax code, or null/undefined/'none' for a line that bears no VAT. */
  taxCode?: string | null;
  /**
   * The Leistungsdatum (supply date, `YYYY-MM-DD`). Governs the ESTV Ziffer VINTAGE the line
   * reports on (M2): the era-encoded families flip their trailing digit per era. Absent or
   * out-of-era dates keep the stored Ziffer.
   */
  supplyDate?: string | null;
}

/**
 * The ESTV Ziffern whose trailing digit encodes the rate era (enums.ts header): the per-rate output
 * lines (30x/31x/34x), Bezugsteuer (38x), and the Saldo lines (32x/33x). Digit 2 = the 2018-2023
 * era, digit 3 = from 2024. The Vorsteuer / Export / Ausgenommen lines (400/405/220/230) are
 * period-stable and never in this set.
 */
const ERA_VARYING_FORM_LINES: ReadonlySet<string> = new Set([
  '302', '303', '312', '313', '342', '343', '382', '383', '322', '323', '332', '333',
]);

/** The vintage digit per era `effectiveFrom`. A future era without a published Ziffer set maps to
 *  nothing and keeps the stored digit (never invented). */
const ERA_FORM_LINE_DIGIT: Readonly<Record<string, string>> = {
  '2018-01-01': '2',
  '2024-01-01': '3',
};

/** Resolve the Ziffer VINTAGE for the supply date: same family, the era's trailing digit (M2). */
function formLineOn(formLine: string | null, supplyDate: string | null | undefined): string | null {
  if (formLine === null || !ERA_VARYING_FORM_LINES.has(formLine)) return formLine;
  if (typeof supplyDate !== 'string' || !isValidRateDate(supplyDate)) return formLine;
  const era = vatRatesOn(supplyDate);
  if (era === null) return formLine;
  const digit = ERA_FORM_LINE_DIGIT[era.effectiveFrom];
  if (digit === undefined) return formLine;
  return formLine.slice(0, 2) + digit;
}

interface CodeRow {
  code: string;
  kind: string;
  rate_bp: number;
  esa_form_line: string | null;
}

function signFor(kind: string, saldo: boolean): TaxSign {
  if (kind === 'output') return 'credit';
  if (kind === 'input' || kind === 'import') return 'debit';
  // Bezugsteuer: owed + deducted (`both`) under effektiv, but owed-only (`credit`) under saldo, where
  // the flat rate already imputes input tax (MWSTV Art. 91), so there is no reclaimable leg.
  if (kind === 'reverse_charge') return saldo ? 'credit' : 'both';
  return 'none';
}

/**
 * The Saldo Ziffer an output line reports under, resolved from the approval GOVERNING THE SUPPLY DATE.
 *
 * One approved rate on that day: that rate's Ziffer (323). No approval governing the day: null.
 *
 * TWO OR MORE depends on the regime the supply day files under (A07 §3.1a). Under `beiblatt`, from
 * 01.01.2025, every approved rate declares on the SAME Ziffer, so the answer is that Ziffer and the
 * preview can state it: the thing a per-line result cannot decide is the RATE, and the Ziffer stopped
 * depending on the rate. Under `per_position`, up to 31.12.2024, the Ziffer really did vary by
 * Tätigkeit and a P6 result cannot pick one from a tax code that carries no activity, so it stays
 * null and A07 assigns it at filing from the Ertragskonto.
 *
 * THE DATE IS NOT OPTIONAL HERE, and that is the whole fix. This used to count the rows in the
 * approval table, which was sound only while that table held current state. Once it held a history,
 * a workspace with exactly ONE approved Saldosteuersatz that had been re-granted once reported NO
 * Ziffer at all on every preview, forever, while the return it previewed went on filing under 323.
 * `formLine` is not persisted to `journal_line`, so no posted figure moved: what moved was the
 * screen, and A07's standard is that a screen and a file may not disagree.
 */
function saldoOutputFormLine(ctx: WorkspaceContext, day: string): string | null {
  const generation = generationOn(ctx, day);
  if (generation === null || generation.rates.length === 0) return null;
  if (generation.rates.length === 1) return generation.rates[0]?.formLine ?? null;
  // Several approved rates. Only the Beiblatt regime can name one Ziffer for all of them, and there
  // it is position 1's, which is the only Saldo row that regime's form has.
  // A single DAY is passed as both ends, so it can never straddle and the null case is unreachable
  // here. This is a per-line preview, not a period.
  if (saldoDeclarationRegimeForPeriod(day, day) !== 'beiblatt') return null;
  return saldoFormLineForPosition(1);
}

/**
 * Resolve a line's tax code to its posting effect. Archived codes still resolve (historical reads,
 * §H-VAT-TRACE); an unknown code is a structured error. A `none`/absent code short-circuits to a
 * no-VAT resolution without a lookup.
 */
export function resolveTax(ctx: WorkspaceContext, input: ResolveTaxInput): Result {
  // THE METHOD THAT GOVERNED THE SUPPLY, not the one configured today. A line dated inside a Saldo
  // period keeps its Saldo resolution after the workspace lawfully moves to the effektive Methode
  // (MWSTG Art. 37 Abs. 4), which is what stops a correction return for that period from being
  // previewed under a tax regime it was never filed under. Absent a supply date the question is
  // about a line being entered now, so today governs, which is the pre-existing behaviour.
  const day =
    typeof input.supplyDate === 'string' && isValidRateDate(input.supplyDate)
      ? input.supplyDate.slice(0, 10)
      : ctx.clock.now().slice(0, 10);
  const era = methodOn(ctx, day);
  const method = era.method;
  const timing = era.timing;
  const saldo = method === 'saldo';

  if (input.taxCode === undefined || input.taxCode === null || input.taxCode === 'none') {
    return ok({
      code: null,
      kind: 'none',
      rateBp: 0,
      sign: 'none',
      deductible: false,
      saldo,
      formLine: null,
      method,
      timing,
    });
  }

  const row = ctx.store.db
    .prepare('SELECT code, kind, rate_bp, esa_form_line FROM tax_code WHERE workspace_id = ? AND code = ?')
    .get(ctx.workspaceId, input.taxCode) as CodeRow | undefined;
  if (row === undefined) {
    // P9 (m1): a workspace with NO codes at all (archived included) is not "every code unknown", it
    // is MWST-not-configured. This is the same state the GUI's banner-CTA branches on, surfaced with
    // the same code so the agent and the human share one code path into A05's setup.
    const anyCode = ctx.store.db
      .prepare('SELECT 1 FROM tax_code WHERE workspace_id = ? LIMIT 1')
      .get(ctx.workspaceId);
    if (anyCode === undefined) return err('needs_vat_config');
    return err('unknown_tax_code', { taxCode: input.taxCode });
  }

  const kind = row.kind;
  const sign = signFor(kind, saldo);
  // Input tax is reclaimable only under the effektiv method (Art. 37 removes separate input deduction
  // under Saldo); output/zero/exempt/none never carry a reclaimable input.
  const deductible = !saldo && (kind === 'input' || kind === 'import' || kind === 'reverse_charge');
  // Under Saldo an output line reports on the workspace's Saldo Ziffer; otherwise the code's ESTV
  // Ziffer. Either way the supply date picks the Ziffer VINTAGE (M2): a 2023 straddle reports on
  // the legacy 302/382/322 family, not the current one the code stores.
  const storedFormLine = saldo && kind === 'output' ? saldoOutputFormLine(ctx, day) : row.esa_form_line;
  const formLine = formLineOn(storedFormLine, input.supplyDate);

  return ok({
    code: row.code,
    kind,
    rateBp: row.rate_bp,
    sign,
    deductible,
    saldo,
    formLine,
    method,
    timing,
  });
}
