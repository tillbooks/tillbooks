/**
 * A02, `postEntry`: the single posting path (Pattern P3).
 *
 * Every financial effect in TILL, now and forever, becomes a call to this verb. It refuses to write
 * anything that is not balanced (§H-LEDGER), not permitted (A24 via the capability port), or aimed at
 * a locked period (§H-PERIOD via the period port), and it is idempotent (§H-IDEMPOTENT). Validation
 * happens before the transaction opens: a rejection never leaves a partial write behind.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireString, requireDate, optionalId, optionalText } from './inputGuards.js';
import { validateLineFields } from './lineValidation.js';
import { computeLineTax } from '../vat/applyVat.js';
import { allocateBase, isCurrencyCode, parseRate, RATE_ONE } from '../fx/rateMath.js';
import { resolveFxRate, baseCurrencyOf } from '../fx/rates.js';
import type { ResolvedRate } from '../fx/rates.js';
// The LEAF module, never the files barrel: the barrel pulls `node:crypto` in through the upload
// hash, and this file's runtime closure is held browser-pure by `studio-sees-payloads.test.mjs`.
import { deriveStatutoryOnPost } from '../files/postedFloor.js';

/**
 * §H-FX disclosure, the ONE predicate: does this posting state a conversion basis?
 *
 * It asks about the CURRENCY, never about the number. A posting already in the workspace base
 * currency converted nothing, so it stores and reports no rate; stamping the literal '1' there would
 * make every ordinary CHF row look converted. A posting in any other currency DID convert, so it
 * states the basis it converted on, even when that basis is exactly 1 (a peg, or a day the market
 * landed on parity). A row reading `EUR` with a NULL rate is indistinguishable from a franc row: the
 * arithmetic survives, the disclosure does not.
 *
 * Exported because A11 predicts what A02 will write when it verifies that the entry under an
 * invoice's posting key is the invoice's own. Two copies of this rule is how the paths desynchronise,
 * so there is one, and both callers import it. The statutory reasoning and the fetched sources are in
 * docs/specs/03-fx-foundation.md section 13.
 */
export function statesConversionBasis(resolved: Pick<ResolvedRate, 'currency' | 'baseCurrency'>): boolean {
  return resolved.currency !== resolved.baseCurrency;
}

/** The complement, read at the two write sites where "no basis to state" is the interesting case. */
function isBaseCurrency(resolved: Pick<ResolvedRate, 'currency' | 'baseCurrency'>): boolean {
  return !statesConversionBasis(resolved);
}

export interface LineInput {
  /** The account id this line debits or credits. */
  account: string;
  /** Rappen; exactly one of debit / credit is a positive integer. */
  debit?: number;
  credit?: number;
  costCenter?: string;
  taxCode?: string;
  taxBase?: number;
  taxAmount?: number;
  /**
   * The Leistungsdatum (supply date, `YYYY-MM-DD`) that priced this line's VAT, when it differs
   * from the entry date (F2): filing a prior-period supply later is the normal case, and the
   * supply-date rate governs (A06 §3). Absent, the entry date governs. Per LINE, because one
   * compound entry may mix supply periods.
   */
  supplyDate?: string;
  /**
   * The STATED base-currency amount of this line (§H-FX, A13 §4b.3), reserved for the engine-only
   * correction sources `credit_note` and `reversal`. A partial correction of a foreign posting must
   * release a share of the base THAT POSTING booked, not a fresh once-rounded conversion of its own
   * amount: re-converting strands Rappen no document owns and files a Ziffer whose base and tax
   * argue with each other (the A13 round-1 F2 finding). Containment, all enforced below:
   * source-gated; ALL-OR-NONE across the entry; each a non-negative safe integer on the line's own
   * side; on a base-currency entry it must EQUAL the transaction amount verbatim; and §H-LEDGER
   * balances over the stated figures. Every registry-reachable source refuses the field outright,
   * and the two sources that accept it are themselves refused by the registry before the engine
   * runs, so no caller can state a base through MCP or REST.
   */
  baseAmountMinor?: number;
}

export interface PostEntryInput {
  entryId?: string;
  date: string;
  ref?: string;
  description?: string;
  lines: LineInput[];
  source: string;
  idempotencyKey: string;
  reversesEntryId?: string;
  /**
   * The TRANSACTION currency of this entry (§H-FX). Absent means the workspace base currency, which
   * is what every pre-FX caller means and what keeps a CHF posting bit-identical to before.
   *
   * The currency is per ENTRY, not per line: an entry records one economic event, and that event
   * happened in one currency. A compound entry mixing two foreign currencies would need two rates
   * and would not be one event; nothing in the A-series produces one, and admitting the shape would
   * mean admitting an entry whose §H-LEDGER balance depends on which rate you read it with.
   */
  currency?: string;
  /**
   * The rate to convert this entry into base currency, as a decimal STRING (never a float on the
   * wire), being the price of one unit of `currency` in base currency. Absent, the rate is resolved
   * from the `exchange_rate` store for `date`; if none is admissible the posting is REFUSED
   * (`needs_fx_rate`) rather than converted at a guess.
   */
  fxRate?: string;
}

/**
 * What a SUCCESSFUL post sends back (P9). The first declared success payload in the engine.
 *
 * Until now `postEntry` returned the open `Result`, so `posted.entryId` was `unknown` to the suites,
 * to the MCP layer, to `payment.ts` (which cast it back to `string` to use it) and to the Studio.
 * Renaming this field kept every type check in the repo green and broke the drawer at runtime. Named
 * here, the payload is a closed object type, so a consumer reading a field it does not carry is
 * TS2339 at the call site instead.
 *
 * A type ALIAS, not an interface: TypeScript withholds the implicit index signature from interfaces,
 * and without it `Result<PostEntryOk>` would stop being assignable to the open `Result` that
 * `reverseEntry`, `hardCloseYear` and the rest still return.
 *
 * The three FX fields travel together or not at all, governed by `statesConversionBasis`: a
 * base-currency posting converted nothing and states no basis. They are optional here rather than
 * nullable because "absent" is what the caller actually observes.
 */
export type PostEntryOk = {
  /** The id of the entry now posted. Stable across an idempotent replay of the same key. */
  readonly entryId: string;
  /** The TRANSACTION currency, present only when it differs from the workspace base currency. */
  readonly currency?: string;
  /** The rate the posting was priced at, as a canonical decimal string. */
  readonly fxRate?: string;
  /** The validity date of that rate, or null when the caller named the rate itself. */
  readonly fxRateAsOf?: string | null;
};

/** A line with its sides normalised to integers and its base-currency amounts resolved. */
export interface PreparedLine {
  account: string;
  /** Transaction-currency minor units (Rappen when the entry is in the base currency). */
  debit: number;
  credit: number;
  /** Base-currency (CHF) minor units, §H-FX. Equal to debit/credit for a base-currency entry. */
  baseDebit: number;
  baseCredit: number;
  costCenter: string | null;
  taxCode: string | null;
  taxBase: number | null;
  taxAmount: number | null;
  supplyDate: string | null;
}

// `error` is an `Err`, not a `Result`. It was declared `Result` while every value ever put in it
// came from `err(...)` or from a branch already narrowed to a rejection, which was harmless only
// because the success half was open too. Declaring `postEntry` made it a type error: a caller
// returning this straight out of a verb that promises `Result<PostEntryOk>` would be promising a
// success payload it cannot produce. Same reasoning for the three helpers below.
type LineValidation =
  | { valid: true; lines: PreparedLine[] }
  | { valid: false; error: Err };

/**
 * Validate the lines of a posting: at least two, each exactly one side in positive integer Rappen,
 * every account real and in this workspace, and the whole balanced in base currency. Returns the
 * prepared lines or a structured rejection. Module-internal: the only posting path is `postEntry`.
 */
function validatePostingLines(ctx: WorkspaceContext, lines: LineInput[]): LineValidation {
  // Field shape, amounts (safe non-negative integers), tax fields, and account / cost-centre
  // existence in this workspace are validated once, here (shared with saveDraft).
  const fieldErr = validateLineFields(ctx, lines);
  if (fieldErr) return { valid: false, error: fieldErr };
  if (lines.length < 2) {
    return { valid: false, error: err('unbalanced', { reason: 'at least two lines are required' }) };
  }

  const prepared: PreparedLine[] = [];
  // The balance is summed in BigInt so it stays exact even past 2^53: a set that "balances" only
  // because JS float addition lost a Rappen must not slip through §H-LEDGER.
  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const line of lines) {
    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;

    // Exactly one side must be positive: `(debit > 0) === (credit > 0)` catches both-set and neither-set.
    if (debit > 0 === credit > 0) {
      return {
        valid: false,
        error: err('invalid_line', {
          account: line.account,
          reason: 'each line is exactly one of debit or credit',
        }),
      };
    }

    debitTotal += BigInt(debit);
    creditTotal += BigInt(credit);
    prepared.push({
      account: line.account,
      debit,
      credit,
      // Filled by `applyFx` once the rate is resolved. A base-currency entry keeps these equal to
      // the transaction amounts, exactly as the pre-FX engine stored them.
      baseDebit: debit,
      baseCredit: credit,
      costCenter: line.costCenter ?? null,
      taxCode: line.taxCode ?? null,
      taxBase: line.taxBase ?? null,
      taxAmount: line.taxAmount ?? null,
      supplyDate: line.supplyDate ?? null,
    });
  }

  if (debitTotal !== creditTotal) {
    return {
      valid: false,
      error: err('unbalanced', {
        debit: Number(debitTotal),
        credit: Number(creditTotal),
        diff: Number(debitTotal - creditTotal),
      }),
    };
  }

  return { valid: true, lines: prepared };
}

/**
 * §H-FX: resolve the entry's rate and fill every prepared line's BASE amounts.
 *
 * The ledger's truth is the base currency. `debit_minor`/`credit_minor` record what the transaction
 * actually was, `base_debit_minor`/`base_credit_minor` record what the books hold, and `fx_rate`
 * records what turned one into the other, so the three together are the §H-FX trace and no reader
 * ever has to re-derive a historical rate.
 *
 * Rounding is done ONCE per side, on the side total, and allocated back over the lines by largest
 * remainder (see `../fx/rateMath.ts` for why, and for the worked Rappen that proves it matters). The
 * two sides carry the same transaction total (the entry already balanced), so they receive the same
 * base total and §H-LEDGER holds in base currency BY CONSTRUCTION. The assertion below is therefore
 * not expected to fire; it is here because "cannot happen" is a claim, and on the money path a claim
 * that is never checked is a claim that is never true when it stops being true.
 *
 * The VAT trace (`tax_base_minor` / `tax_amount_minor`) stays in the TRANSACTION currency,
 * deliberately: it sits on the same row as `currency`, `fx_rate` and the base amounts, so the row is
 * internally consistent, and the CHF figure an MWST filing needs is already stored as a value (the
 * base movement on 2200 / 1170), never recomputed. Converting the trace separately would round it a
 * second time, independently of the line it describes.
 *
 * EXPORTED, AND NARROWED TO A STRUCTURAL LINE SHAPE, so a capability that needs to know what an
 * entry WOULD convert to shares this function instead of writing the multiplication a second time.
 * A19's `previewBankOpeningBalance` is the first such caller, and its whole reason for existing is
 * that the figure shown before an irreversible click is the figure the posting then writes: two
 * implementations of one sum is exactly how a preview and its posting come to disagree. The
 * parameter takes the four amount fields and nothing else, so a caller with no VAT trace and no cost
 * centre does not have to invent them; `PreparedLine` satisfies the shape, and the posting path
 * below is unchanged.
 *
 * IT PERFORMS NO WRITE. It resolves a rate (a workspace-scoped read) and mutates the caller's own
 * line objects, which is what makes it safe to call from a read verb.
 */
export interface FxConvertibleLine {
  debit: number;
  credit: number;
  baseDebit: number;
  baseCredit: number;
}

export function applyFxToLines(
  ctx: WorkspaceContext,
  input: { date: string; currency?: string | undefined; fxRate?: string | undefined },
  lines: FxConvertibleLine[],
): { ok: true; resolved: ResolvedRate } | { ok: false; error: Err } {
  const currency = input.currency ?? baseCurrencyOf(ctx);
  const resolution = resolveFxRate(ctx, {
    currency,
    date: input.date,
    ...(input.fxRate !== undefined ? { explicitRate: input.fxRate } : {}),
  });
  if (!resolution.ok) return { ok: false, error: resolution };
  const resolved = resolution.resolved;

  if (resolved.rateScaled !== RATE_ONE) {
    const debitIdx: number[] = [];
    const creditIdx: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as FxConvertibleLine;
      if (line.debit > 0) debitIdx.push(i);
      else creditIdx.push(i);
    }
    const spread = (idx: number[], pick: (l: FxConvertibleLine) => number, put: (l: FxConvertibleLine, v: number) => void) => {
      const allocated = allocateBase(
        idx.map((i) => pick(lines[i] as FxConvertibleLine)),
        resolved.rateScaled,
      );
      idx.forEach((i, k) => put(lines[i] as FxConvertibleLine, allocated[k] as number));
    };
    spread(
      debitIdx,
      (l) => l.debit,
      (l, v) => {
        l.baseDebit = v;
        l.baseCredit = 0;
      },
    );
    spread(
      creditIdx,
      (l) => l.credit,
      (l, v) => {
        l.baseCredit = v;
        l.baseDebit = 0;
      },
    );
  }

  let baseDebitTotal = 0n;
  let baseCreditTotal = 0n;
  for (const line of lines) {
    baseDebitTotal += BigInt(line.baseDebit);
    baseCreditTotal += BigInt(line.baseCredit);
  }
  if (baseDebitTotal !== baseCreditTotal) {
    return {
      ok: false,
      error: err('unbalanced', {
        currency,
        fxRate: resolved.rate,
        baseDebit: Number(baseDebitTotal),
        baseCredit: Number(baseCreditTotal),
        diff: Number(baseDebitTotal - baseCreditTotal),
        reason: 'the entry does not balance in base currency after conversion',
      }),
    };
  }

  return { ok: true, resolved };
}

/**
 * §4b.3 (A13): validate and apply the STATED base amounts, when the entry carries any.
 *
 * Returns null when no line states a base (the ordinary path, bit-identical to before this seam
 * existed), a rejection on a violated containment rule, or the resolved rate after the stated
 * figures are written onto the prepared lines. The containment is the whole point (A13 §4b.3):
 * source-gated, all-or-none, integer, equal-to-transaction in base currency, and §H-LEDGER balanced
 * over the STATED figures, so a statement can never smuggle an unbalanced base position past the
 * check that guards every other entry.
 */
function applyStatedBases(
  ctx: WorkspaceContext,
  input: PostEntryInput,
  lines: PreparedLine[],
): { ok: true; resolved: ResolvedRate } | { ok: false; error: Err } | null {
  const stated = input.lines.map((l) => l.baseAmountMinor);
  if (!stated.some((s) => s !== undefined)) return null;

  if (!BASE_STATING_SOURCES.has(input.source)) {
    return {
      ok: false,
      error: err('invalid_line', {
        source: input.source,
        reason: 'baseAmountMinor is reserved for engine correction sources (credit_note, reversal)',
      }),
    };
  }
  if (stated.some((s) => s === undefined)) {
    return {
      ok: false,
      error: err('invalid_line', { reason: 'stated base amounts are all-or-none across the entry' }),
    };
  }
  for (const [i, s] of stated.entries()) {
    if (!Number.isSafeInteger(s) || (s as number) < 0) {
      return {
        ok: false,
        error: err('invalid_line', {
          account: input.lines[i]?.account,
          reason: 'baseAmountMinor must be a non-negative integer Rappen amount',
        }),
      };
    }
  }

  const currency = input.currency ?? baseCurrencyOf(ctx);
  const resolution = resolveFxRate(ctx, {
    currency,
    date: input.date,
    ...(input.fxRate !== undefined ? { explicitRate: input.fxRate } : {}),
  });
  if (!resolution.ok) return { ok: false, error: resolution };
  const resolved = resolution.resolved;

  let baseDebitTotal = 0n;
  let baseCreditTotal = 0n;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as PreparedLine;
    const s = stated[i] as number;
    const txn = line.debit > 0 ? line.debit : line.credit;
    // On a base-currency entry nothing converted, so a statement is only admissible as the exact
    // identity: anything else would let a correction move base money its transaction never carried.
    if (isBaseCurrency(resolved) && s !== txn) {
      return {
        ok: false,
        error: err('invalid_line', {
          account: line.account,
          statedMinor: s,
          transactionMinor: txn,
          reason: 'a base-currency line\'s stated base must equal the transaction amount',
        }),
      };
    }
    if (line.debit > 0) {
      line.baseDebit = s;
      line.baseCredit = 0;
      baseDebitTotal += BigInt(s);
    } else {
      line.baseCredit = s;
      line.baseDebit = 0;
      baseCreditTotal += BigInt(s);
    }
  }
  if (baseDebitTotal !== baseCreditTotal) {
    return {
      ok: false,
      error: err('unbalanced', {
        currency,
        fxRate: resolved.rate,
        baseDebit: Number(baseDebitTotal),
        baseCredit: Number(baseCreditTotal),
        diff: Number(baseDebitTotal - baseCreditTotal),
        reason: 'the entry does not balance in base currency over the stated amounts',
      }),
    };
  }
  return { ok: true, resolved };
}

/**
 * B2, the post-boundary VAT gate: the ENGINE owns the §H-VAT-TRACE. An ADDITIVE validation inside
 * the one posting path (P3: no second path), never a poster of its own.
 *
 * Rationale: A07 reads the stored trace and never recomputes, so a client-stamped trace that
 * diverges from the booked 2200/1170 money makes the MWST-Abrechnung report figures the ledger does
 * not hold. Before this gate, `post_entry` persisted taxCode/taxBase/taxAmount verbatim: a stale GUI
 * cache, a hand-edited amount, a Bezugsteuer entry with its statutory legs simply omitted, and a
 * garbage code all posted fine. Now, for every line carrying a `taxCode`:
 *
 *  (a) the code must EXIST (`unknown_tax_code`; an unconfigured workspace gets the P9
 *      `needs_vat_config`), and trace amounts without a code are rejected outright;
 *  (b) the canonical `taxBase`/`taxAmount` are recomputed server-side via the SAME `computeLineTax`
 *      that powers `vat_preview` and the GUI readout, from the line's booked amount + code + the
 *      line's `supplyDate` (Leistungsdatum) when given, else the entry's date (F2: a straddle leg
 *      priced at the supply-date rate must reconcile, not be refused against the booking-date
 *      rate), and THOSE are stamped. The convention is the base-line convention: the tag
 *      rides the line whose booked amount is the tax base (net revenue/expense; for IMPORT the
 *      assessed-tax line, whose amount IS the tax). A client-supplied `taxAmount` is only a HINT to
 *      choose between the two honest one-round interpretations of the same booking, net-entered
 *      (tax = round(base * rate)) or gross-entered (tax = round(gross * rate / (1 + rate)), which
 *      may legitimately differ by one Rappen, B1's money preservation): the hint is accepted iff it
 *      is the exact fixed point of the gross split on `base + hint`. Anything else is discarded for
 *      the net-forward figure. A line on its unnatural side (an output tag on a debit, a credit
 *      note) stamps NEGATED, the same convention a reversal stores.
 *  (c) the entry's VAT-account movements must reconcile: net credit on 2200 == the signed sum of
 *      canonical output-side tax (output + Bezugsteuer), and net debit on 1170/1171 == the signed
 *      sum of canonical deductible input-side tax (input/import/Bezugsteuer under effektiv), else
 *      `vat_trace_unreconciled` names expected vs booked.
 *
 * Non-deductible input (the saldo fold, Art. 37) books NO separate VAT leg, so its booked amount is
 * definitionally gross: its canonical trace is the gross split, and it contributes zero to both
 * reconciliation sides. `source='reversal'` is exempt from the RECOMPUTE only: every posted line's
 * code must still exist (`validateLineFields`), and `reversalMirrorsTarget` enforces the per-LINE
 * negation of the target's stored lines, tax code included, so a reversal can carry exactly the
 * traces the target carried (which passed this gate when it posted), negated, and nothing else.
 * `source='close'` may carry no trace at all (rejected earlier) and skips trivially.
 */
const NATURAL_CREDIT_KINDS: ReadonlySet<string> = new Set(['output', 'zero', 'exempt']);

function reconcileAndStampVat(
  ctx: WorkspaceContext,
  input: PostEntryInput,
  lines: PreparedLine[],
): Err | null {
  for (const line of lines) {
    if (line.taxCode === null && (line.taxBase !== null || line.taxAmount !== null)) {
      return err('invalid_line', { account: line.account, reason: 'taxBase/taxAmount require a taxCode' });
    }
  }
  if (!lines.some((l) => l.taxCode !== null)) return null;

  let expectedOutputMinor = 0;
  let expectedInputMinor = 0;

  for (const line of lines) {
    if (line.taxCode === null) continue;
    // F1: an archived code still RESOLVES (historical reads, faithful reversals) but is not for NEW
    // postings: this gate only runs for the business sources, so a reversal mirroring a historical
    // archived-code entry is untouched. The A06 GUI states name this error (`vat.error.archivedCode`).
    if (line.taxCode !== 'none') {
      const codeRow = ctx.store.db
        .prepare('SELECT active FROM tax_code WHERE workspace_id = ? AND code = ?')
        .get(ctx.workspaceId, line.taxCode) as { active: number } | undefined;
      if (codeRow !== undefined && codeRow.active !== 1) {
        return err('archived_tax_code', { taxCode: line.taxCode });
      }
    }
    const amount = line.debit > 0 ? line.debit : line.credit;
    // F2: the Leistungsdatum that priced the leg governs the rate; the entry date is the fallback.
    const supplyDate = line.supplyDate ?? input.date;
    const canon = computeLineTax(ctx, {
      amountMinor: amount,
      amountIsGross: false,
      taxCode: line.taxCode,
      supplyDate,
    });
    if (!canon.ok) return canon;

    const kind = canon.kind as string;
    if (kind === 'none') {
      // The literal 'none' sentinel: a no-VAT line, normalised to a null trace.
      line.taxCode = null;
      line.taxBase = null;
      line.taxAmount = null;
      continue;
    }

    const deductible = canon.deductible as boolean;
    const naturalCredit = NATURAL_CREDIT_KINDS.has(kind);
    const sign = (line.credit > 0) === naturalCredit ? 1 : -1;

    let baseMinor: number;
    let taxMinor: number;
    if (kind === 'input' && !deductible) {
      // The saldo fold (Art. 37): no separate VAT leg exists, so the booked amount is gross by
      // definition and the canonical trace is its gross split.
      const folded = computeLineTax(ctx, {
        amountMinor: amount,
        amountIsGross: true,
        taxCode: line.taxCode,
        supplyDate,
      });
      if (!folded.ok) return folded;
      baseMinor = folded.netMinor as number;
      taxMinor = folded.taxMinor as number;
    } else if (input.source === 'credit_note') {
      // D71 (A13 §4b.2): the credit-note delegate's stated trace is accepted VERBATIM. The
      // exhausting credit books each rate class's REMAINING VAT (the invoice's statutory figure
      // minus the priors'), which is definitionally not this line's own canonical arithmetic, and
      // the Klassenausgleich pair stamps a whole class residual on a one-Rappen base. The
      // containment: the source is engine-only (registry-refused), the code must still exist and
      // resolve (checked above), and the entry's booked 2200 movement must still equal the signed
      // sum of exactly these stamped figures (the reconciliation below), so a stated trace can
      // never move tax the entry's own legs do not book.
      const trace = canon.trace as { taxBaseMinor: number | null; taxAmountMinor: number | null };
      baseMinor = line.taxBase === null ? (trace.taxBaseMinor ?? 0) : Math.abs(line.taxBase);
      taxMinor = line.taxAmount === null ? (canon.taxMinor as number) : Math.abs(line.taxAmount);
    } else {
      const trace = canon.trace as { taxBaseMinor: number | null; taxAmountMinor: number | null };
      baseMinor = trace.taxBaseMinor ?? 0;
      taxMinor = canon.taxMinor as number;
      // The gross-entered hint: accepted iff it is the exact gross-split fixed point (see above).
      const hint = line.taxAmount === null ? null : Math.abs(line.taxAmount);
      if (
        hint !== null &&
        hint !== taxMinor &&
        (hint === taxMinor - 1 || hint === taxMinor + 1) &&
        kind !== 'import' &&
        (canon.rateBp as number) > 0
      ) {
        const probe = computeLineTax(ctx, {
          amountMinor: baseMinor + hint,
          amountIsGross: true,
          taxCode: line.taxCode,
          supplyDate,
        });
        if (probe.ok && probe.taxMinor === hint && probe.netMinor === baseMinor) taxMinor = hint;
      }
    }

    if (kind === 'output' || kind === 'reverse_charge') expectedOutputMinor += sign * taxMinor;
    if (deductible) expectedInputMinor += sign * taxMinor;

    line.taxBase = sign * baseMinor;
    line.taxAmount = sign * taxMinor;
  }

  // The booked movements on the KMU VAT accounts (spec §3: 2200 Umsatzsteuer, 1170/1171 Vorsteuer).
  const vatAccounts = ctx.store.db
    .prepare("SELECT id, number FROM account WHERE workspace_id = ? AND number IN ('2200', '1170', '1171')")
    .all(ctx.workspaceId) as { id: string; number: string }[];
  const outputIds = new Set(vatAccounts.filter((a) => a.number === '2200').map((a) => a.id));
  const inputIds = new Set(vatAccounts.filter((a) => a.number !== '2200').map((a) => a.id));
  let bookedOutputMinor = 0;
  let bookedInputMinor = 0;
  for (const line of lines) {
    if (outputIds.has(line.account)) bookedOutputMinor += line.credit - line.debit;
    if (inputIds.has(line.account)) bookedInputMinor += line.debit - line.credit;
  }

  if (bookedOutputMinor !== expectedOutputMinor) {
    return err('vat_trace_unreconciled', {
      account: '2200',
      expectedMinor: expectedOutputMinor,
      bookedMinor: bookedOutputMinor,
    });
  }
  if (bookedInputMinor !== expectedInputMinor) {
    return err('vat_trace_unreconciled', {
      account: '1170/1171',
      expectedMinor: expectedInputMinor,
      bookedMinor: bookedInputMinor,
    });
  }
  return null;
}

/**
 * The single §H-ENUM source of truth for `journal_entry.source` (data model §D0). The engine
 * enforces it (there is no DB CHECK constraint), so a spec that legitimately adds a value adds it
 * here, in one place.
 */
const VALID_SOURCES = new Set([
  'manual',
  'invoice',
  'payment',
  'import',
  'agent',
  'reversal',
  'close',
  'fx',
  // A17, the creditor side. Its own value rather than `manual`, because `list_journal` filters on this
  // column and a Kreditorenbuchung is a distinct business event. It is deliberately absent from
  // `POST_ENTRY_SOURCES` in `src/api/registry.ts`, the agent-facing allow-list, for the reason
  // `reversal` and `close` are: only `postVendorBill` may write one, so a caller cannot forge an entry
  // claiming to be a vendor bill with no `vendor_bill` row behind it (A17 §7, P3).
  'purchase',
  // A15, the Mahngebühr. Its own value for the same two reasons as `purchase`: `list_journal`
  // filters on this column and a booked reminder fee is a distinct business event, and it is
  // deliberately absent from `POST_ENTRY_SOURCES` so a caller cannot forge an entry claiming to be
  // a dunning fee with no `dunning_run` behind it (only `issueDunningRun` writes one).
  'dunning',
  // A13, the Gutschrift. Engine-only for the same reason as `purchase`: only A13's registered
  // `onIssue` delegate may write one, so no caller can forge a credit-note entry with no credit note
  // behind it, and the two privileges the source carries (the stated-base seam and the verbatim VAT
  // hint, both below) stay unreachable from MCP and REST.
  'credit_note',
  // A20, camt reconciliation. Its own value for the same two reasons as `purchase`/`dunning`:
  // `list_journal` filters on this column and a bank-fact entry is a distinct business event, and it
  // is deliberately absent from `POST_ENTRY_SOURCES` in `src/api/registry.ts` so a caller cannot
  // forge an entry claiming a bank txn behind it (only `createEntryForTxn` writes one).
  'camt',
  // D01, the period-end inventory valuation (Bestandesbewertung). Its own value for the same two
  // reasons as `purchase`/`dunning`/`camt`: `list_journal` filters on this column and a stock
  // valuation is a distinct business event, and it is deliberately absent from `POST_ENTRY_SOURCES`
  // (the agent-facing allow-list) so a caller cannot forge one through the raw `post_entry` tool with
  // no `stock_valuation_run` behind it: only `runValuation` (spec §2 D01.4, the ONLY posting path,
  // P3) writes one, and a re-run reverses the prior via `source='reversal'` (§H-AUDIT).
  'stock',
  // I03, the landed-cost reclassification (Dr inventory control, Cr landed-cost clearing / accrued
  // costs). Its own value for the same two reasons as `purchase`/`dunning`/`camt`/`stock`:
  // `list_journal` filters on this column and capitalising freight/duty onto inventory is a distinct
  // business event, and it is deliberately absent from `POST_ENTRY_SOURCES` (the agent-facing
  // allow-list) so a caller cannot forge one through the raw `post_entry` tool with no
  // `landed_cost_voucher` behind it: only `landedCostAllocateConfirm` writes one (the ONLY posting
  // path, P3), and a reverse negates the prior via `source='reversal'` (§H-AUDIT).
  'landed_cost',
  // E02, the approved expense-claim reimbursement liability. Its own value for the same two reasons
  // as `purchase`/`dunning`/`camt`/`stock`: `list_journal` filters on this column and a Spesen
  // reimbursement posting is a distinct business event, and it is deliberately absent from
  // `POST_ENTRY_SOURCES` (the agent-facing allow-list) so a caller cannot forge one through the raw
  // `post_entry` tool with no `expense_claim` behind it: only `approveClaim` (E02 §4, the ONLY
  // posting path, P3) writes one, and a wrong approval is corrected via `source='reversal'` (§H-AUDIT).
  'expense_claim',
  // H02, the fixed-asset acquisition / additional-capitalisation. Its own value for the same two
  // reasons as `purchase`/`stock`/`expense_claim`: `list_journal` filters on this column and an asset
  // capitalisation is a distinct business event, and it is deliberately absent from
  // `POST_ENTRY_SOURCES` (the agent-facing allow-list) so a caller cannot forge one through the raw
  // `post_entry` tool with no `asset_transaction` behind it: only `assetAcquire` /
  // `assetAddCapitalisation` (H02, the ONLY posting path, P3) write one, and a correction is a
  // `source='reversal'` of the entry plus a compensating transaction (§H-AUDIT).
  'asset_acquisition',
  // H04, the period-end depreciation run. Its own value for the same two reasons as `asset_acquisition`:
  // `list_journal` filters on this column and a depreciation posting is a distinct business event, and
  // it is deliberately absent from `POST_ENTRY_SOURCES` (the agent-facing allow-list) so a caller cannot
  // forge one through the raw `post_entry` tool with no depreciation run behind it: only
  // `assetDepreciationRunPost` (H04, the ONLY posting path, P3) writes one, and a correction is a
  // `source='reversal'` of the entry (via `assetDepreciationRunReverse`) plus a compensating transaction.
  'asset_depreciation',
  // H06, the fixed-asset disposal. Its own value for the same two reasons as `asset_acquisition` /
  // `asset_depreciation`: `list_journal` filters on this column and a disposal (clearing cost +
  // accumulated depreciation, recognising proceeds and the book gain/loss) is a distinct business
  // event, and it is deliberately absent from `POST_ENTRY_SOURCES` (the agent-facing allow-list) so a
  // caller cannot forge one through the raw `post_entry` tool with no `asset_transaction` behind it:
  // only `assetDispose` (H06, the ONLY posting path, P3) writes one, and a correction is a
  // `source='reversal'` of the entry plus a compensating asset_transaction (§H-AUDIT; there is no
  // un-dispose verb).
  'asset_disposal',
  // J06, the period-end inventory valuation posting that links the sub-ledger to the GL (OP11). Its
  // own value for the same two reasons as `stock`/`landed_cost`: `list_journal` filters on this column
  // and a Bestandesbewertung that carries J03's advanced valuation (incl. I03 landed cost) to the
  // inventory control account is a distinct business event, and it is deliberately absent from
  // `POST_ENTRY_SOURCES` (the agent-facing allow-list) so a caller cannot forge one through the raw
  // `post_entry` tool with no `inventory_valuation_run` behind it: only `inventoryValuationPost` /
  // `inventoryValuationOpening` (J06, the ONLY posting path, P3) write one, and a correction is a
  // `source='reversal'` of the entry (via `inventoryValuationReverse`) plus a fresh run (§H-AUDIT).
  // It is NOT the same source as D01's `stock`: J06 owns the OP11 reconciliation and its own run table.
  'inventory_valuation',
  // A38, Abgrenzungen und Rückstellungen. Two engine-only sources for the same two reasons as the
  // asset runs: `list_journal` filters on this column, and an Abgrenzung (posted as a PAIR with its
  // next-period reversal) or a Rückstellung (formed, released, reversed) is a distinct business event.
  // Both are deliberately absent from `POST_ENTRY_SOURCES` (the agent-facing allow-list) so a caller
  // cannot forge one through the raw `post_entry` tool with no `accrual` / `provision` row behind it:
  // only `accrualPost` / `accrualReverse` write `accrual` (each as an atomic pair, the A22 `fx`
  // shape) and only `provisionPost` / `provisionRelease` write `provision`. The Storno of an accrual
  // is a NEW `accrual` entry plus its `reversal` (design doc §7.8), never an edit.
  'accrual',
  'provision',
  // A38, the year-end MWST-Saldierung (D129 leg 2): the per-period transfer of the filed period's
  // 2200 / 1170 / 1171 balances to 2201. Its own value for the two usual reasons (`list_journal`
  // filters on it, a settlement is a distinct business event) and for a THIRD: it is the one source
  // beside `close` that §H-PERIOD relaxes for, under the three conditions `rejectSettlementViolations`
  // and the period check below enforce. Deliberately absent from `POST_ENTRY_SOURCES` (the agent-facing
  // allow-list), so only `vatSettlementPost` (`src/core/accruals/vatSettlement.ts`) can reach the
  // relaxation; a correction is a `source='reversal'` of the settlement entry (`vatSettlementReverse`).
  'vat_settlement',
]);

/** The journal source of an A38 MWST settlement entry. Only `vatSettlementPost` writes it. */
export const VAT_SETTLEMENT_SOURCE = 'vat_settlement';

/**
 * The journal source of an A22 FX revaluation entry (§D0 enum). Only `src/core/fx/revaluation.ts`
 * writes it. Declared here, beside `VAT_SETTLEMENT_SOURCE`, so that `reverseEntry.ts` can own it
 * without importing the revaluation module (which imports `reverseEntry.ts` itself: a cycle would
 * leave the ownership map reading the constant before it exists).
 */
export const FX_SOURCE = 'fx';

/**
 * The sources whose entries carry NO tax code BY DESIGN: the closing and period-end mechanics of
 * A22, H04, A38 and A03, and the reversals that mirror them. A scan for "a line on a VAT-defaulted
 * account without a tax code" (A26's `detect_anomalies`, A25's `prepare_period`, and through them
 * G22's `no_missing_tax_codes` check) skips these by name, because an Abgrenzung on 6500 or a
 * Steuerrückstellung on 8900 is not a bookkeeping mistake and must not turn the year's checklist
 * red the moment the closing entries post (measured at the N4 build, 2026-09-10: the Nomadik walk
 * flagged its own accrual). A manual entry stays scanned: that is the mistake the scan exists for.
 */
export const VAT_FREE_ENTRY_SOURCES: readonly string[] = ['reversal', 'close', FX_SOURCE, 'asset_depreciation', 'accrual', 'provision', VAT_SETTLEMENT_SOURCE];

/**
 * The ONLY accounts a `source='vat_settlement'` line may name (A38 §4.6, the second of the three
 * carve-out conditions): the two Vorsteuer accounts, the Umsatzsteuer account, the MWST-Abrechnungskonto
 * the balances transfer to, and under owner question Q3 the Saldosteuersatz income-reduction account
 * that carries the flat-rate tax due. Numbers, not ids, because the carve-out is a statement about the
 * Kontenrahmen KMU roles and a workspace's chart is seeded with exactly these numbers (A01).
 */
export const VAT_SETTLEMENT_ACCOUNTS: readonly string[] = ['1170', '1171', '2200', '2201', '3809'];

/**
 * The sources that may STATE base-currency amounts and whose VAT trace hints are accepted verbatim
 * (A13 §4b.3, D71). Both privileges exist because a CORRECTION of a posted entry must reproduce
 * figures that posting already fixed (its once-rounded base allocation, its per-class VAT), and
 * recomputing them independently is exactly how a pair fails to close. `reversal` states bases (the
 * faithful mirror restates what the target's rows carry) but keeps the mirror check instead of the
 * hint path; `credit_note` uses both.
 */
const BASE_STATING_SOURCES = new Set(['credit_note', 'reversal']);

/**
 * The year-end closing entry (`source='close'`) IS the sealing act, so §H-PERIOD is relaxed for it in a
 * NARROW, enforced way: it may land at fiscal year-end over a soft-closed month or a filed quarter, but
 * NEVER into an already year-close-sealed year (see the period check below). The safety rationale that
 * a close "cannot alter a filed return" is ENFORCED, not assumed: a `source='close'` line may carry no
 * VAT trace (checked in `rejectVatTraceOnClose`). This is compliance-driven, not a per-workspace policy
 * (§6b fixes lock enforcement); the MCP/REST boundary (Phase E) additionally keeps `source='close'` off
 * the agent-facing `post_entry` tool, so only the year-close path reaches it.
 */
function rejectVatTraceOnClose(input: PostEntryInput): Err | null {
  if (input.source !== 'close') return null;
  for (const line of input.lines) {
    if (line.taxCode !== undefined || line.taxBase !== undefined || line.taxAmount !== undefined) {
      return err('invalid_line', { account: line.account, reason: 'a close entry carries no VAT trace' });
    }
  }
  return null;
}

/**
 * A38 §4.6, the `source='vat_settlement'` carve-out (D129 leg 2): the MWST-Saldierung joins the `close`
 * relaxation of §H-PERIOD, because the transfer of a FILED period's 2200 / 1170 / 1171 balances to 2201
 * is dated the period end and therefore lands inside the `vat_filed` hard lock by construction. The
 * safety rationale is the same as the close's and it is ENFORCED, not assumed, by THREE conditions:
 *
 *   1. no VAT trace on any line (checked here): a settlement moves booked tax between tax accounts, it
 *      declares nothing, so `computeVatReturn` (which reads tagged lines) can never see it;
 *   2. every line on one of `VAT_SETTLEMENT_ACCOUNTS` (checked here): the carve-out cannot be used to
 *      move revenue, cost or cash into a filed period;
 *   3. never into a `year_close` seal (the period check in `postEntry`): the seal is the strongest
 *      legal lock and nothing posts over it.
 *
 * The A07 bridge and the 2200 drift read (`bookedVatByEntry` in `src/core/vat/abrechnung.ts`) exclude
 * this source and its reversals by name, so a posted settlement leaves the filed return and the
 * Abstimmung untouched. `test/ledger/vat-settlement-carveout.test.mjs` asserts all three rejections and
 * the admission by name.
 *
 * Account numbers are resolved through the chart rather than trusted from the caller: a line names an
 * account ID, and the condition is about the account's ROLE (its Kontenrahmen number).
 */
function rejectSettlementViolations(ctx: WorkspaceContext, input: PostEntryInput): Err | null {
  if (input.source !== VAT_SETTLEMENT_SOURCE) return null;
  const numberOf = ctx.store.db.prepare('SELECT number FROM account WHERE workspace_id = ? AND id = ?');
  for (const line of input.lines) {
    if (line.taxCode !== undefined || line.taxBase !== undefined || line.taxAmount !== undefined) {
      return err('invalid_line', { account: line.account, reason: 'a settlement carries no VAT trace' });
    }
    const row = numberOf.get(ctx.workspaceId, line.account) as { number: string } | undefined;
    if (row === undefined || !VAT_SETTLEMENT_ACCOUNTS.includes(row.number)) {
      return err('invalid_line', {
        account: line.account,
        reason: 'settlement_account',
        allowed: [...VAT_SETTLEMENT_ACCOUNTS],
      });
    }
  }
  return null;
}

/**
 * Whether a `source='reversal'` entry mirrors a settlement entry, which admits it through the same
 * carve-out (A38 §4.6): its faithful mirror carries no trace and touches the same accounts by
 * construction (`reversalMirrorsTarget` guarantees that), and it is what lets `vatSettlementReverse`
 * date the Storno inside the filed period so the four accounts net to zero within it.
 */
function reversesSettlement(ctx: WorkspaceContext, input: PostEntryInput): boolean {
  if (input.source !== 'reversal' || input.reversesEntryId === undefined) return false;
  const target = ctx.store.db
    .prepare('SELECT source FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.reversesEntryId) as { source: string } | undefined;
  return target !== undefined && target.source === VAT_SETTLEMENT_SOURCE;
}

/**
 * A reversal must truly reverse: LINE by LINE. Every target line must be matched by exactly one
 * reversal line with the same account, cost centre, and tax CODE, the debit/credit net negated in BOTH
 * the transaction currency and the base currency (§H-FX: a foreign entry's mirror must undo the CHF
 * the books actually carry, not merely the EUR), and the VAT trace (base + amount) negated, as a
 * multiset (order-free, duplicates counted). This closes
 * slot-squatting (a balanced-but-not-mirror entry occupying the target's reversal slot) AND the
 * reversal door the re-critique re-opened (F1): the old per-bucket SUM comparison keyed only on
 * (account, cost centre) let a `source='reversal'` caller swap the tax code, plant fabricated traces
 * whose sums cancel, or split one traced line into fabricated magnitudes that sum right. A per-line
 * signature admits none of those, and a faithful mirror (what `reverseEntry` builds) is unaffected.
 */
function reversalMirrorsTarget(ctx: WorkspaceContext, targetId: string, lines: PreparedLine[]): boolean {
  const targetRows = ctx.store.db
    .prepare(
      'SELECT account_id, cost_center_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ?',
    )
    .all(targetId) as {
    account_id: string;
    cost_center_id: string | null;
    debit_minor: number;
    credit_minor: number;
    base_debit_minor: number;
    base_credit_minor: number;
    tax_code: string | null;
    tax_base_minor: number | null;
    tax_amount_minor: number | null;
    supply_date: string | null;
  }[];

  // The multiset of NEGATED target-line signatures. `0 + x` normalises a JS `-0` to `0` so a negated
  // zero trace (a 0%-rated base line's taxAmount) compares equal to a stored literal 0.
  const negate = (n: number | null): number | null => (n === null ? null : 0 + -n);
  // The supply date is part of the signature, not decoration. It is what selects the ESTV Ziffer
  // VINTAGE a tagged line reports on, so a `source='reversal'` caller that kept every amount and
  // moved only the Leistungsdatum would post a mirror that nets to zero on every account and still
  // credits one Ziffer while debiting another. The trace amounts alone cannot see that.
  const signature = (
    account: string,
    costCenter: string | null,
    taxCode: string | null,
    net: number,
    baseNet: number,
    taxBase: number | null,
    taxAmount: number | null,
    supplyDate: string | null,
  ): string => JSON.stringify([account, costCenter, taxCode, net, baseNet, taxBase, taxAmount, supplyDate]);

  const expected = new Map<string, number>();
  for (const r of targetRows) {
    const key = signature(
      r.account_id,
      r.cost_center_id,
      r.tax_code,
      0 + -(r.debit_minor - r.credit_minor),
      0 + -(r.base_debit_minor - r.base_credit_minor),
      negate(r.tax_base_minor),
      negate(r.tax_amount_minor),
      // NOT negated: a date has no sign. The mirror reports on the SAME supply date, which is the
      // whole point of carrying it.
      r.supply_date,
    );
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }

  if (lines.length !== targetRows.length) return false;
  for (const l of lines) {
    const key = signature(
      l.account,
      l.costCenter,
      l.taxCode,
      l.debit - l.credit,
      l.baseDebit - l.baseCredit,
      l.taxBase,
      l.taxAmount,
      l.taxCode === null ? null : l.supplyDate,
    );
    const remaining = expected.get(key);
    if (remaining === undefined || remaining === 0) return false;
    expected.set(key, remaining - 1);
  }
  return true;
}

/** The audit action a given posting source records (A03's audit-log enum). */
function auditAction(source: string): string {
  if (source === 'reversal') return 'reverse';
  if (source === 'close') return 'close';
  return 'post';
}

/**
 * Write a validated, balanced posting. Runs inside `rememberIdempotent`, so it either commits whole
 * or, on a retry of the same idempotency key, is skipped and the original result replayed.
 *
 * Every row write happens while the entry is still `draft`; flipping it to `posted` is the last step.
 * That is what lets the immutability triggers seal a posted entry (no line can be added, changed, or
 * removed, and the entry itself can be neither updated nor deleted) without getting in the way of the
 * legitimate post. A promotion (a draft posted in place) replaces the draft's lines the same way.
 */
function writePostedEntry(
  ctx: WorkspaceContext,
  input: PostEntryInput,
  lines: PreparedLine[],
  fx: ResolvedRate,
): string {
  const { db } = ctx.store;
  const at = ctx.clock.now();
  const entryId = input.entryId ?? ctx.ids.next('entry');
  const promoting = input.entryId !== undefined;

  if (promoting) {
    db.prepare('DELETE FROM journal_line WHERE entry_id = ?').run(entryId);
    db.prepare(
      `UPDATE journal_entry
         SET date = ?, ref = ?, description = ?, reverses_entry_id = ?, idempotency_key = ?, source = ?, created_by = ?, created_at = ?
       WHERE id = ?`,
    ).run(
      input.date,
      input.ref ?? null,
      input.description ?? null,
      input.reversesEntryId ?? null,
      input.idempotencyKey,
      input.source,
      ctx.actor,
      at,
      entryId,
    );
  } else {
    db.prepare(
      `INSERT INTO journal_entry
         (id, workspace_id, date, ref, description, status, reverses_entry_id, idempotency_key, source, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).run(
      entryId,
      ctx.workspaceId,
      input.date,
      input.ref ?? null,
      input.description ?? null,
      input.reversesEntryId ?? null,
      input.idempotencyKey,
      input.source,
      ctx.actor,
      at,
    );
  }

  const insertLine = db.prepare(
    `INSERT INTO journal_line
       (id, entry_id, account_id, cost_center_id, debit_minor, credit_minor, currency,
        base_debit_minor, base_credit_minor, fx_rate, tax_code, tax_base_minor, tax_amount_minor,
        supply_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // §H-FX, the whole trace on every row: what the transaction was (`currency` + debit/credit), what
  // the books hold (the base amounts), and what turned one into the other (`fx_rate`).
  //
  // The predicate is the CURRENCY, never the number. A base-currency entry stores a NULL rate
  // because no conversion happened, and stamping a literal '1' would make every CHF row look
  // converted. A foreign-currency entry stores its rate because a conversion DID happen, and a rate
  // that landed on exactly 1 (a peg, or a day the market obliged) is a fact about that day, not a
  // licence to erase the record of it. Writing NULL there would leave a row reading `EUR` that is
  // indistinguishable from a franc row, which breaks the ESTV Prüfspur in the direction that matters
  // (MWST-Info 16 Ziff. 1.5, walking the booking back to the Beleg) and forfeits the
  // `Nachprüfbarkeit` OR Art. 957a Abs. 2 Ziff. 5 requires. See docs/specs/03-fx-foundation.md
  // section 9. The same predicate governs the reversal mirror below and A11's `expectedRate`: all
  // three must agree or the paths desynchronise.
  const fxRate = isBaseCurrency(fx) ? null : fx.rate;
  for (const line of lines) {
    insertLine.run(
      ctx.ids.next('line'),
      entryId,
      line.account,
      line.costCenter,
      line.debit,
      line.credit,
      fx.currency,
      line.baseDebit,
      line.baseCredit,
      fxRate,
      line.taxCode,
      line.taxBase,
      line.taxAmount,
      // F2, the other half of the straddle fix. `reconcileAndStampVat` above has PRICED with this
      // date since the straddle fix landed; until now it was thrown away the moment the row was
      // written, so A07 could only fall back to the entry date and merged a pre-2024 supply into
      // the current-rate bucket. A trace that says what it was computed FROM is the difference
      // between a return that can be re-derived and one that has to be believed.
      //
      // Only carried when the line actually bears VAT: a supply date on an untagged line describes
      // nothing, and storing it would invite a reader to treat it as a second entry date.
      line.taxCode === null ? null : line.supplyDate,
    );
  }

  // The final flip. OLD.status is 'draft' here, so the immutability trigger does not fire.
  db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?").run(entryId);

  // D63 (E00): a file linked while this entry was a draft carried no statutory floor; the floor
  // attaches at this moment, in the same transaction as the flip that makes the entry evidence.
  deriveStatutoryOnPost(ctx, 'journal_entry', entryId);

  ctx.audit.record({
    entityKind: 'entry',
    entityId: entryId,
    action: auditAction(input.source),
    actor: ctx.actor,
    at,
  });

  return entryId;
}

export function postEntry(ctx: WorkspaceContext, input: PostEntryInput): Result<PostEntryOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireDate(input.date, 'date') ??
    optionalId(input.entryId, 'entryId') ??
    optionalId(input.reversesEntryId, 'reversesEntryId') ??
    optionalText(input.description, 'description') ??
    optionalText(input.ref, 'ref') ??
    optionalId(input.currency, 'currency') ??
    optionalId(input.fxRate, 'fxRate');
  if (guard) return guard;

  if (!VALID_SOURCES.has(input.source)) {
    return err('invalid_source', { source: input.source });
  }

  // §H-FX shape guards, BEFORE the lines are looked at: a caller who mistyped the currency should be
  // told THAT, not sent chasing whichever line the line validator happened to reach first.
  if (input.currency !== undefined && !isCurrencyCode(input.currency)) {
    return err('invalid_input', { field: 'currency' });
  }
  if (input.fxRate !== undefined && parseRate(input.fxRate) === null) {
    return err('invalid_input', { field: 'fxRate' });
  }

  const closeVatErr = rejectVatTraceOnClose(input);
  if (closeVatErr) return closeVatErr;

  const settlementErr = rejectSettlementViolations(ctx, input);
  if (settlementErr) return settlementErr;

  // Replay a completed post before any state-dependent guard, so retrying a promoted draft returns
  // the original result instead of `already_posted` (§H-IDEMPOTENT). A reversal's post lives in its
  // own namespace, so reusing the original post key as the reversal key is not a collision.
  const scope = input.source === 'reversal' ? 'reverse_entry' : 'post_entry';
  const replayed = ctx.store.recallIdempotent<Result<PostEntryOk>>(
    ctx.workspaceId,
    input.idempotencyKey,
    scope,
  );
  if (replayed !== undefined) return replayed;

  // `reversesEntryId` marks the reversal slot, and only `source='reversal'` may set it. Validate that
  // the target is a posted entry in this workspace that is not already reversed, so no caller can
  // occupy another entry's reversal slot (which would block its real correction) or trip an FK.
  if (input.reversesEntryId !== undefined) {
    if (input.source !== 'reversal') {
      return err('invalid_source', { reason: 'reversesEntryId requires source reversal' });
    }
    const target = ctx.store.db
      .prepare('SELECT status FROM journal_entry WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.reversesEntryId) as { status: string } | undefined;
    if (target === undefined) return err('not_found', { entryId: input.reversesEntryId });
    if (target.status !== 'posted') return err('not_posted', { entryId: input.reversesEntryId });
    const already = ctx.store.db
      .prepare('SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?')
      .get(ctx.workspaceId, input.reversesEntryId) as { id: string } | undefined;
    if (already !== undefined) return err('already_reversed', { reversalId: already.id });
  } else if (input.source === 'reversal') {
    return err('invalid_source', { reason: 'reversal requires reversesEntryId' });
  }

  // Promotion is one-way: an entryId may name an existing draft (to post in place) but never a
  // posted row. This check rejects before any write, so it is not memoised under the key.
  if (input.entryId !== undefined) {
    const row = ctx.store.db
      .prepare('SELECT status FROM journal_entry WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.entryId) as { status: string } | undefined;
    if (row === undefined) return err('not_found', { entryId: input.entryId });
    if (row.status === 'posted') return err('already_posted', { entryId: input.entryId });
  }

  const validated = validatePostingLines(ctx, input.lines);
  if (!validated.valid) return validated.error;

  // §H-FX. Runs BEFORE the mirror check (which now compares base amounts too) and before the write,
  // so an unresolvable rate rejects with nothing half-done. An entry that STATES its base amounts
  // (A13 §4b.3, the two correction sources only) takes the stated path, which validates the
  // containment rules and writes the stated figures instead of allocating fresh ones.
  const statedFx = applyStatedBases(ctx, input, validated.lines);
  if (statedFx !== null && !statedFx.ok) return statedFx.error;
  const fx = statedFx ?? applyFxToLines(ctx, input, validated.lines);
  if (!fx.ok) return fx.error;

  if (input.source === 'reversal' && input.reversesEntryId !== undefined) {
    // A reversal must also mirror the entry's CURRENCY and RATE. Without this a caller could occupy
    // the reversal slot with the right CHF figures reached through a different currency and rate,
    // which would net the books to zero while telling a different story about what happened.
    const targetLine = ctx.store.db
      .prepare('SELECT currency, fx_rate FROM journal_line WHERE entry_id = ? LIMIT 1')
      .get(input.reversesEntryId) as { currency: string; fx_rate: string | null } | undefined;
    if (targetLine !== undefined) {
      const targetRate = targetLine.fx_rate;
      // Reads the SAME predicate the write path uses, so what a reversal must match is by
      // construction what the original stored. At parity this is what refuses a franc "mirror" of a
      // pegged EUR entry: it nets the CHF books to zero on identical integers while telling a
      // different story about what happened.
      const ourRate = isBaseCurrency(fx.resolved) ? null : fx.resolved.rate;
      if (targetLine.currency !== fx.resolved.currency || targetRate !== ourRate) {
        return err('not_a_mirror', {
          entryId: input.reversesEntryId,
          reason: 'a reversal carries the currency and rate of the entry it reverses',
          targetCurrency: targetLine.currency,
          targetFxRate: targetRate,
          currency: fx.resolved.currency,
          fxRate: ourRate,
        });
      }
    }
    if (!reversalMirrorsTarget(ctx, input.reversesEntryId, validated.lines)) {
      return err('not_a_mirror', { entryId: input.reversesEntryId });
    }
  } else if (input.source !== 'close') {
    // B2: the engine owns the VAT trace. Validates the codes, recomputes and stamps the canonical
    // base/tax onto the prepared lines, and rejects an entry whose 2200/1170 movements do not
    // reconcile. A reversal is mirror-checked above instead; a close entry carries no trace.
    const vatErr = reconcileAndStampVat(ctx, input, validated.lines);
    if (vatErr) return vatErr;
  }

  const periodOpen = ctx.periods.assertOpen(input.date);
  if (!periodOpen.ok) {
    // The year-close sealing entry may post over a soft/filing lock, but never into a year-close seal;
    // every other source honours all locks. A38 (D129 leg 2): the MWST settlement and its own reversal
    // share the relaxation (conditions 1 and 2 were enforced above by `rejectSettlementViolations` and
    // the mirror check; this is condition 3, the seal), because the transfer of a filed period's VAT
    // balances is dated the period end and lands inside the `vat_filed` lock by construction.
    const isYearSeal = periodOpen.kind === 'hard' && periodOpen.reason === 'year_close';
    const relaxed =
      input.source === 'close' || input.source === VAT_SETTLEMENT_SOURCE || reversesSettlement(ctx, input);
    if (!relaxed || isYearSeal) return periodOpen;
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, scope, () => {
    const entryId = writePostedEntry(ctx, input, validated.lines, fx.resolved);
    // The type argument is the pin: with it, this literal is judged against `PostEntryOk`, so a typo
    // or a dropped field is an error HERE rather than an `undefined` in the Studio.
    return ok<PostEntryOk>({
      entryId,
      // §H-FX is reported back, not merely stored: a caller that just posted a foreign-currency entry
      // must be able to say which rate priced it without going back to the database for it. Same
      // predicate as the row write, so what the caller is told and what the books hold agree even at
      // parity, where the rate is 1 and the conversion still happened.
      ...(statesConversionBasis(fx.resolved)
        ? { currency: fx.resolved.currency, fxRate: fx.resolved.rate, fxRateAsOf: fx.resolved.rateAsOf }
        : {}),
    });
  });
}
