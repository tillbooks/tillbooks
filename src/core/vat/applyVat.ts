/**
 * A06, VAT on transactions: the single MWSTG-mandated mapping from a line's tax code to booked Rappen.
 *
 * `computeLineTax` is the pure per-line computation (Pattern P2, the rounding risk centre); it is the
 * ONE code path the GUI readout, the `vat_preview` MCP tool, and `buildVatLines` all share, so the
 * agent preview and the human-facing figure can never diverge. `buildVatLines` expands one taxable
 * business line into the balanced journal set (net + Vorsteuer/Umsatzsteuer + counter) ready for
 * `postEntry` (A02), but NEVER calls it: A06 adds no second posting path (§7).
 *
 * MONEY RULES (spec §4, Pattern P2), asserted by the property tests in test/vat/apply-vat.test.mjs:
 *  - Integer Rappen only, basis-point rates, never a float on the money path.
 *  - Round EXACTLY ONCE per line, at the tax amount, HALF-AWAY-FROM-ZERO to Rappen. The intermediate
 *    base is never rounded, and the ENTERED amount is always preserved verbatim: a net input keeps
 *    its net (tax derives from it), a gross input keeps its gross (tax derives from the gross, net =
 *    gross - tax). Money preservation outranks base-recompute symmetry: A07 reads the STORED
 *    taxAmount and never recomputes, so the honest guarantee per mode is "replaying the same input
 *    mode on the preserved figure reproduces the stored trace" (see the split in computeLineTax).
 *  - IMPORT (Einfuhrsteuer, Art. 50) takes the ASSESSED amount as given, never rate-derived.
 *  - Per-line rounding then sum for a multi-line document (matches ESTV per-rate treatment).
 *
 * THE SUPPLY-DATE RATE GOVERNS (spec §3, the whole point of A05's date-versioned tables). A rate is
 * never hard-coded: a code names a rate CLASS (Normalsatz / reduziert / Beherbergung), and the
 * effective rate is that class's value in the era in force on the supply date, read from the rate-era
 * helpers. So a line whose Leistungsdatum falls before the 2024 rate change computes 7.7%, its trace
 * freezes 7.7%, and the pending 2026 referendum (Normalsatz to 8.5% from 2028) becomes an added era
 * ROW rather than any code edit. Input codes (VST-*) carry no rate of their own (the input rate is
 * whatever the vendor charged), so they resolve to the Normalsatz on the supply date unless a
 * workspace defines an input code with an explicit non-zero rate.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { resolveTax } from './resolveTax.js';
import {
  vatRatesOn,
  normalRateBpOn,
  isValidRateDate,
  EARLIEST_RATE_ERA_FROM,
  VAT_RATE_ERAS,
} from './rateEras.js';
import { NORMAL_RATE_BP } from './enums.js';

export interface ComputeLineTaxInput {
  /** The line amount in Rappen: the net base, or the gross when `amountIsGross`. For IMPORT, the
   *  assessed tax taken as given. */
  amountMinor: number;
  /** True when `amountMinor` is the gross (net + tax); false when it is the net base. */
  amountIsGross: boolean;
  /** The line's tax code, or null/undefined/'none' for a line that bears no VAT. */
  taxCode?: string | null;
  /** The Leistungsdatum (supply date, `YYYY-MM-DD`). Governs the statutory rate on a straddle. */
  supplyDate?: string | null;
}

/** The frozen §H-VAT-TRACE stamped onto the base-bearing line. `null`s for a no-VAT line. */
export interface VatTrace {
  taxCode: string | null;
  taxBaseMinor: number | null;
  taxAmountMinor: number | null;
}

/** Round half-away-from-zero to an integer, exact in integer arithmetic (Pattern P2). */
function roundHalfAwayFromZero(numer: number, denom: number): number {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

type RateClass = 'normal' | 'reduced' | 'accommodation';

/**
 * Which rate class a stored basis-point rate names, or null for a workspace-custom rate.
 *
 * Matched against EVERY published era, newest first, never just the current one: a code seeded at
 * 810bp names the Normalsatz CLASS, and that identity must survive the next era append. (The old
 * current-era-only match was a time bomb: appending the 2028 row would have stopped 810 matching
 * anything, silently flipping a 2023 straddle from 7.7% to the stored 8.1%.) Within an era the
 * probe order normal -> reduced -> accommodation resolves any future cross-era collision
 * deterministically toward the more common class.
 */
function classifyRate(rateBp: number): RateClass | null {
  for (let i = VAT_RATE_ERAS.length - 1; i >= 0; i -= 1) {
    const era = VAT_RATE_ERAS[i]!;
    if (rateBp === era.normalBp) return 'normal';
    if (rateBp === era.reducedBp) return 'reduced';
    if (rateBp === era.accommodationBp) return 'accommodation';
  }
  return null;
}

function eraRateFor(cls: RateClass, supplyDate: string): number | null {
  const era = vatRatesOn(supplyDate);
  if (era === null) return null;
  if (cls === 'normal') return era.normalBp;
  if (cls === 'reduced') return era.reducedBp;
  return era.accommodationBp;
}

/**
 * The effective rate (basis points) for a resolved code on the supply date. A code's stored rate
 * names a rate class; the supply date selects the era. Input codes carry no rate and default to the
 * Normalsatz on the supply date. Falls back to the stored/nominal rate when no era covers the date.
 *
 * EXPORTED so A07 can REPORT the rate a line was actually priced at rather than the code's stored
 * one. On a straddle the two differ by construction: a code stored at 810 prices a 2023 supply at
 * 770, so a return that read the stored rate would print "Normal 7,7%" on Ziffer 302 next to a
 * rateBp of 810. One function, one answer, both sides of the money path.
 */
export function effectiveRateBp(kind: string, storedRateBp: number, supplyDate: string | null | undefined): number {
  const validDate = typeof supplyDate === 'string' && isValidRateDate(supplyDate) ? supplyDate : null;

  if (kind === 'input') {
    // The input rate is whatever the vendor charged. With a zero-rate seed code (VST-M/VST-I), that
    // is the Normalsatz on the supply date; a workspace-defined input code with an explicit rate
    // keeps its own class-based resolution below.
    if (storedRateBp === 0) {
      if (validDate) return normalRateBpOn(validDate) ?? NORMAL_RATE_BP;
      return NORMAL_RATE_BP;
    }
  }

  const cls = classifyRate(storedRateBp);
  if (validDate !== null && cls !== null) {
    const eraRate = eraRateFor(cls, validDate);
    if (eraRate !== null) return eraRate;
  }
  return storedRateBp;
}

export interface ComputeLineTaxResult {
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  formLine: string | null;
  kind: string;
  deductible: boolean;
  rateBp: number;
  trace: VatTrace;
}

/**
 * Compute one line's VAT, pure (Pattern P1/P2). Returns a P9 Result: `ok` with the figures and the
 * frozen trace, or `err('unknown_tax_code')` for a code that does not exist in the workspace.
 */
/** The rate-era-dependent kinds: their effective rate is read off the supply date's era. */
const RATE_BEARING_KINDS: ReadonlySet<string> = new Set(['output', 'input', 'reverse_charge']);

export function computeLineTax(ctx: WorkspaceContext, input: ComputeLineTaxInput): Result {
  // m2: integer Rappen by contract. In-process callers (A11/A17) bypass the MCP schema, so the
  // engine itself refuses a float, string, or unsafe value before it can reach the trace.
  if (!Number.isSafeInteger(input.amountMinor)) {
    return err('invalid_amount', { amountMinor: input.amountMinor });
  }

  // M3: a PRESENT-but-malformed supply date is a structured rejection, never "absent, use the
  // current rate": that silent coercion books the wrong era's rate (rateEras.ts's stated no-go).
  const supplyDate = input.supplyDate ?? null;
  if (supplyDate !== null && !isValidRateDate(supplyDate)) {
    return err('invalid_date', { supplyDate: String(supplyDate) });
  }

  const resolved = resolveTax(ctx, { taxCode: input.taxCode ?? null, supplyDate });
  if (!resolved.ok) return resolved;

  const kind = resolved.kind as string;
  const amount = input.amountMinor;

  // m6: before the earliest published era there is NO verified rate (a deliberate, documented gap in
  // rateEras.ts: absent rather than invented). For a rate-bearing kind that is a structured signal
  // to the caller, never a silent fallback to the current rate. Import (assessed, taken as given)
  // and the 0% kinds never consult an era, so any date stays computable for them.
  if (supplyDate !== null && RATE_BEARING_KINDS.has(kind) && supplyDate < EARLIEST_RATE_ERA_FROM) {
    return err('rate_era_unknown', { supplyDate, earliestKnownEra: EARLIEST_RATE_ERA_FROM });
  }

  // A line that bears no VAT: the amount passes through untouched, no trace to freeze.
  if (kind === 'none') {
    return ok({
      netMinor: amount,
      taxMinor: 0,
      grossMinor: amount,
      formLine: resolved.formLine ?? null,
      kind,
      deductible: false,
      rateBp: 0,
      trace: { taxCode: null, taxBaseMinor: null, taxAmountMinor: null } satisfies VatTrace,
    });
  }

  // Einfuhrsteuer (Art. 50): the assessed amount is the tax, taken as given, never rate-derived.
  // The customs value (the base of the imported goods) is booked where the goods are, not here.
  if (kind === 'import') {
    return ok({
      netMinor: 0,
      taxMinor: amount,
      grossMinor: amount,
      formLine: resolved.formLine ?? null,
      kind,
      deductible: resolved.deductible as boolean,
      rateBp: 0,
      trace: { taxCode: resolved.code as string, taxBaseMinor: 0, taxAmountMinor: amount } satisfies VatTrace,
    });
  }

  const rateBp = effectiveRateBp(kind, resolved.rateBp as number, input.supplyDate);

  // Zero-rated (Art. 23) and exempt (Art. 21): base recorded, tax zero. The base is the amount as
  // entered; a gross flag is moot at 0%.
  if (rateBp === 0) {
    return ok({
      netMinor: amount,
      taxMinor: 0,
      grossMinor: amount,
      formLine: resolved.formLine ?? null,
      kind,
      deductible: resolved.deductible as boolean,
      rateBp: 0,
      trace: { taxCode: resolved.code as string, taxBaseMinor: amount, taxAmountMinor: 0 } satisfies VatTrace,
    });
  }

  // EXACTLY ONE round per line (P2), and the entered amount is preserved verbatim; which figure is
  // derived depends on the input mode:
  //  - NET input: the base is the entered amount, the ONE round lands on tax = round(net * rate),
  //    gross = net + tax. Recomputing tax from the stored base reproduces the stored tax.
  //  - GROSS input: the ONE round lands on tax = round(gross * rate / (1 + rate)), net = gross - tax,
  //    and `grossMinor` IS the entered amount. Money preservation (net + tax == the entered gross) is
  //    the PRIMARY invariant here: A07 reads the STORED taxAmount and never recomputes (A06 §4), so a
  //    trace whose net-formula re-derivation differs by a Rappen is harmless, while a gross that
  //    drifts (the old double round: tax-from-gross, then tax-from-net again) mis-books real money on
  //    the counter line. Reproducibility for a gross line means: running the SAME gross split on the
  //    preserved gross (base + tax) returns the stored figures verbatim (pinned in the tests).
  let netMinor: number;
  let taxMinor: number;
  let grossMinor: number;
  if (input.amountIsGross) {
    taxMinor = roundHalfAwayFromZero(amount * rateBp, 10000 + rateBp);
    netMinor = amount - taxMinor;
    grossMinor = amount;
  } else {
    netMinor = amount;
    taxMinor = roundHalfAwayFromZero(netMinor * rateBp, 10000);
    grossMinor = netMinor + taxMinor;
  }

  return ok({
    netMinor,
    taxMinor,
    grossMinor,
    formLine: resolved.formLine ?? null,
    kind,
    deductible: resolved.deductible as boolean,
    rateBp,
    trace: {
      taxCode: resolved.code as string,
      taxBaseMinor: netMinor,
      taxAmountMinor: taxMinor,
    } satisfies VatTrace,
  });
}

/** A journal line ready for `postEntry`, in the A02 `LineInput` shape. */
export interface VatJournalLine {
  account: string;
  debit?: number;
  credit?: number;
  costCenter?: string;
  taxCode?: string;
  taxBase?: number;
  taxAmount?: number;
  /** The Leistungsdatum that priced the tagged line (F2), carried so the A02 post-boundary gate
   *  recomputes at the SAME supply-date rate a straddle was built with. */
  supplyDate?: string;
}

export type VatDirection = 'output' | 'input';

export interface BuildVatLinesInput {
  /** The counter account: the debtor (output), creditor or bank (input), or customs clearing. */
  counterAccount: string;
  /** The revenue account (output) or the expense/cost account (input). */
  revenueOrExpenseAccount: string;
  amountMinor: number;
  amountIsGross: boolean;
  taxCode?: string | null;
  direction: VatDirection;
  supplyDate?: string | null;
  costCenterId?: string;
}

/** Resolve a seeded KMU account id by its number. Throws a structured cause if it is absent. */
function accountByNumber(ctx: WorkspaceContext, number: string): string {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error(`missing_vat_account: ${number}`);
  }
  return row.id;
}

/**
 * The counter of one taxable line: the side and amount `buildVatLines` books against the counter account.
 * It names no account, because the counter-less builder does not know one: in `buildVatLines` it is the
 * debtor, creditor, bank or clearing account the caller names, and in `compose_entry` it is whatever the
 * entry's OTHER lines book (A02 §6, D152 amendment).
 */
export interface VatCounter {
  side: 'debit' | 'credit';
  amountMinor: number;
}

/** One taxable line's own booked set, its counter, and where `buildVatLines` puts that counter. */
export interface VatLineParts {
  /**
   * The line's OWN lines, in `buildVatLines` order with the counter taken out: the base line first (the one
   * the trace rides; for a deductible import, the 1170/1171 line whose amount IS the assessed tax), then
   * the VAT legs or the folded tax. A zero-amount VAT leg is kept, exactly as `buildVatLines` keeps it.
   */
  own: VatJournalLine[];
  counter: VatCounter;
  /** The index `buildVatLines` inserts the counter at, so its order is unchanged byte for byte. */
  counterAt: number;
}

/** `buildVatLines`' input without the counter account. */
export type BuildVatLinePartsInput = Omit<BuildVatLinesInput, 'counterAccount'>;

/**
 * The COUNTER-LESS builder (D152 amendment, 02.10.2026): one taxable line's own booked set, its counter's
 * side and amount, and where `buildVatLines` puts the counter. `buildVatLines` is assembled from THIS, so
 * there is one arrangement of a VAT split in the engine, and `compose_entry` (which has no counter account:
 * the entry's other lines are the counter) reuses it rather than re-deriving it. Throws exactly what
 * `buildVatLines` throws (an unpriceable code, a missing VAT account, a direction the kind cannot take).
 */
export function buildVatLineParts(ctx: WorkspaceContext, input: BuildVatLinePartsInput): VatLineParts {
  const computed = computeLineTax(ctx, {
    amountMinor: input.amountMinor,
    amountIsGross: input.amountIsGross,
    taxCode: input.taxCode ?? null,
    supplyDate: input.supplyDate ?? null,
  });
  if (!computed.ok) {
    throw new Error(String(computed.error));
  }

  const kind = computed.kind as string;
  const net = computed.netMinor as number;
  const tax = computed.taxMinor as number;
  const gross = computed.grossMinor as number;
  const deductible = computed.deductible as boolean;
  const cc = input.costCenterId;
  const formLine = computed.formLine as string | null;
  const computedTrace = computed.trace as VatTrace;

  const withCc = (line: VatJournalLine): VatJournalLine => (cc !== undefined ? { ...line, costCenter: cc } : line);
  // Only the defined fields are stamped: exactOptionalPropertyTypes forbids an explicit `undefined`.
  const trace: Pick<VatJournalLine, 'taxCode' | 'taxBase' | 'taxAmount' | 'supplyDate'> = {};
  if (computedTrace.taxCode !== null) trace.taxCode = computedTrace.taxCode;
  if (computedTrace.taxBaseMinor !== null) trace.taxBase = computedTrace.taxBaseMinor;
  if (computedTrace.taxAmountMinor !== null) trace.taxAmount = computedTrace.taxAmountMinor;
  // F2: the tagged line carries the Leistungsdatum it was priced at, so the legs round-trip
  // through the post-boundary gate on a straddle (the gate recomputes at this date, not the
  // booking date). Same-date bookings omit it: the entry date is the fallback and nothing changes.
  if (computedTrace.taxCode !== null && input.supplyDate != null) trace.supplyDate = input.supplyDate;
  // Input VAT to 1170 by default, to 1171 for Investitionen (the code that reports on ESTV Ziff. 405).
  const inputVatAccount = () => accountByNumber(ctx, formLine === '405' ? '1171' : '1170');

  // m7: Bezugsteuer (Art. 45) and Einfuhrsteuer (Art. 50) are input-side bookings by construction.
  // A caller passing direction 'output' has mixed up its call site; booking the same lines anyway
  // would hide the defect, so it fails loudly and structured instead.
  if ((kind === 'reverse_charge' || kind === 'import') && input.direction !== 'input') {
    throw new Error(`invalid_direction: ${kind} books on the input side, got '${input.direction}'`);
  }

  // Bezugsteuer (Art. 45): the paired output + input legs, plus the net expense booked to its counter.
  if (kind === 'reverse_charge') {
    const own: VatJournalLine[] = [];
    // The net expense carries the trace: ONE convention across every kind and every caller (GUI,
    // agent, buildVatLines): the tag rides the BASE line whose booked amount is the tax base, which
    // is exactly what the A02 post-boundary gate recomputes from. (It used to ride the 2200 leg,
    // whose amount is the TAX, unrecoverable back to a base.)
    own.push(withCc({ account: input.revenueOrExpenseAccount, debit: net, ...trace }));
    // The owed leg always books to 2200 (Umsatzsteuer).
    own.push({ account: accountByNumber(ctx, '2200'), credit: tax });
    if (deductible) {
      // Fully deductible: the deduction leg to 1170 cancels the owed leg (a wash).
      own.push({ account: inputVatAccount(), debit: tax });
    } else {
      // Not deductible (saldo / exempt activity): the tax is a real cost, debited to the expense.
      own.push(withCc({ account: input.revenueOrExpenseAccount, debit: tax }));
    }
    return { own, counter: { side: 'credit', amountMinor: net }, counterAt: 1 };
  }

  // Einfuhrsteuer (Art. 50): the assessed Vorsteuer against the counter (bank / customs clearing).
  // The 1170/1171 line's amount IS the assessed tax, so it is the one line whose booked amount the
  // trace describes: the tag rides it (the base-line convention; an import has no base line here,
  // the customs value books where the goods are). Under saldo (Art. 37, no separate reclaim) the
  // assessed tax is a real cost instead: it folds into the expense account, still carrying the trace.
  if (kind === 'import') {
    const importTaxLine = deductible
      ? { account: inputVatAccount(), debit: tax, ...trace }
      : withCc({ account: input.revenueOrExpenseAccount, debit: tax, ...trace });
    return { own: [importTaxLine], counter: { side: 'credit', amountMinor: tax }, counterAt: 1 };
  }

  if (input.direction === 'output') {
    // Debtor gross / revenue net (with trace) / output VAT to 2200. Zero-rated and exempt book only
    // the net (tax == 0), with the trace still stamped on the revenue line.
    const own: VatJournalLine[] = [withCc({ account: input.revenueOrExpenseAccount, credit: net, ...trace })];
    if (tax !== 0) own.push({ account: accountByNumber(ctx, '2200'), credit: tax });
    return { own, counter: { side: 'debit', amountMinor: gross }, counterAt: 0 };
  }

  // Input direction (ordinary Vorsteuer). Under a deductible method the net books to the cost account
  // and the tax to 1170/1171; under saldo (or a non-deductible kind) the GROSS folds into the cost
  // account with no input-VAT split (Art. 37).
  if (deductible && tax !== 0) {
    return {
      own: [
        withCc({ account: input.revenueOrExpenseAccount, debit: net, ...trace }),
        { account: inputVatAccount(), debit: tax },
      ],
      counter: { side: 'credit', amountMinor: gross },
      counterAt: 2,
    };
  }
  return {
    own: [withCc({ account: input.revenueOrExpenseAccount, debit: gross, ...trace })],
    counter: { side: 'credit', amountMinor: gross },
    counterAt: 1,
  };
}

/**
 * Expand one taxable business line into the balanced journal set ready for `postEntry` (never posts).
 * The trace (§H-VAT-TRACE) is stamped on the net base line so A07 reads it once, without double
 * counting. Sigma debit == Sigma credit on every result (asserted by the property test).
 *
 * Assembled from `buildVatLineParts` (D152 amendment): the counter is booked on `counterAccount`, with the
 * line's cost centre, at the index the pre-refactor builder put it. The output is byte-identical to that
 * builder for every caller, held by `test/vat/build-vat-lines-identity.test.mjs` against a frozen copy.
 */
export function buildVatLines(ctx: WorkspaceContext, input: BuildVatLinesInput): VatJournalLine[] {
  const parts = buildVatLineParts(ctx, input);
  const cc = input.costCenterId;
  const bare: VatJournalLine =
    parts.counter.side === 'debit'
      ? { account: input.counterAccount, debit: parts.counter.amountMinor }
      : { account: input.counterAccount, credit: parts.counter.amountMinor };
  const counter = cc !== undefined ? { ...bare, costCenter: cc } : bare;
  const lines = [...parts.own];
  lines.splice(parts.counterAt, 0, counter);
  return lines;
}

// --- The rules a line's VAT follows from its KIND (D152 amendment) ----------------------------------

/**
 * A06 kinds whose NATURAL direction is money arriving: an output code books a sale, and the zero-rated and
 * exempt codes are sales too. Every other kind (input, Bezugsteuer, Einfuhrsteuer) books money going out.
 * The same set the A02 gate reads as "naturally on the credit side" when it signs a stamped trace.
 */
export const NATURAL_IN_KINDS: ReadonlySet<string> = new Set(['output', 'zero', 'exempt']);

/** What a booked line's VAT follows from its code's kind, before any figure is computed. */
export interface VatIntentRules {
  /** The `buildVatLines` direction: a sale (`output`) or a purchase (`input`). */
  direction: VatDirection;
  /** The side the BASE line books on when the money runs the natural way (a sale credits, a purchase debits). */
  naturalSide: 'debit' | 'credit';
  /**
   * Bezugsteuer (Art. 45) prices on the base: the foreign supplier charged no Swiss VAT, so the amount
   * paid or booked IS the base and the tax is owed on top, whatever the line was typed as. Every other kind
   * prices the amount as entered (gross or net).
   */
  pricesOnBase: boolean;
}

/** The kind's direction, natural side and pricing: one place, read by the bank inbox and `compose_entry`. */
export function vatIntentRules(kind: string): VatIntentRules {
  const naturalIn = NATURAL_IN_KINDS.has(kind);
  return {
    direction: naturalIn ? 'output' : 'input',
    naturalSide: naturalIn ? 'credit' : 'debit',
    pricesOnBase: kind === 'reverse_charge',
  };
}

/**
 * One booked line on its UNNATURAL side (a refund on an input code, a customer refund or credit on an output
 * code) is the SAME booking mirrored: debit and credit swapped, every other field kept, so the tax is
 * reduced, never invented. The A02 gate then stamps the trace negated (`reconcileAndStampVat`).
 */
export function mirrorVatLine<T extends { debit?: number; credit?: number }>(line: T): T {
  const { debit, credit, ...rest } = line;
  return {
    ...rest,
    ...(credit !== undefined ? { debit: credit } : {}),
    ...(debit !== undefined ? { credit: debit } : {}),
  } as T;
}
