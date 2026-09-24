/**
 * A22's read models for the Studio: the rate history, the period-end revaluation, and the refusals.
 *
 * Every parser returns `null` on a shape it does not recognise rather than coercing, because a
 * coerced FX figure is a figure a human signs off on. Nothing here invents a number: it reads
 * exactly the fields `listExchangeRates` and `computeFxRevaluation` send and no more (the surface
 * derives no rate and no diff of its own, per the §6b Fixed list). The one classification it does is
 * mapping an engine rejection `error` code to the one refusal the surface knows how to name.
 */

// --- the rate history ------------------------------------------------------------------------

/**
 * One recorded rate. The pair is stored as "the price of one unit of `baseCurrency` IN
 * `quoteCurrency`", and the ledger base currency is the QUOTE side (`rates.ts`), so the FOREIGN
 * currency a reader thinks of is `baseCurrency` and CHF (the ledger base) is `quoteCurrency`.
 */
export interface RateRow {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  asOf: string;
  source: string;
  method: string | null;
  provenance: string | null;
}

// --- the revaluation read model --------------------------------------------------------------

/** One revalued monetary position: an (account x foreign currency) slice at the closing rate. */
export interface FxPositionView {
  kind: 'bank' | 'debtor' | 'creditor';
  accountId: string;
  accountNumber: string;
  /** The FOREIGN currency of the position; `fcAmountMinor` is in this currency's minor units. */
  currency: string;
  fcAmountMinor: number;
  /** The CHF (base currency) the books currently carry, minor units. */
  bookChfMinor: number;
  rate: string;
  rateAsOf: string | null;
  revaluedChfMinor: number;
  /** `revaluedChfMinor - bookChfMinor`: positive an unrealised gain, negative a loss. */
  diffChfMinor: number;
}

/** A per-currency subtotal over the positions above, in base-currency minor units for the CHF figures. */
export interface FxCurrencySummary {
  currency: string;
  fcAmountMinor: number;
  bookChfMinor: number;
  revaluedChfMinor: number;
  diffChfMinor: number;
}

/** A currency with an open FC position but no admissible closing rate on file (the `needs_rate` CTA). */
export interface NeedsRateEntry {
  currency: string;
  latestAsOf: string | null;
}

export interface FxRevaluationView {
  periodEnd: string;
  /** The ledger base currency, the unit every CHF figure below is expressed in. */
  baseCurrency: string;
  positions: FxPositionView[];
  byCurrency: FxCurrencySummary[];
  totalUnrealisedMinor: number;
  needsRate: NeedsRateEntry[];
}

// --- the post result -------------------------------------------------------------------------

export interface PostResultView {
  runId: string | null;
  periodEnd: string;
  posted: boolean;
  entryId: string | null;
  reversalId: string | null;
  totalUnrealisedMinor: number;
  /** The first day of the next period the revaluation reverses on, or null when nothing posted. */
  reversalDate: string | null;
}

// --- primitives ------------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// --- parsers ---------------------------------------------------------------------------------

export function parseRates(body: unknown): RateRow[] | null {
  const b = record(body);
  if (b === null || !Array.isArray(b.rates)) return null;
  const out: RateRow[] = [];
  for (const raw of b.rates) {
    const r = record(raw);
    if (r === null) return null;
    const id = str(r.id);
    const baseCurrency = str(r.baseCurrency);
    const quoteCurrency = str(r.quoteCurrency);
    const rate = str(r.rate);
    const asOf = str(r.asOf);
    const source = str(r.source);
    if (id === null || baseCurrency === null || quoteCurrency === null || rate === null || asOf === null || source === null) {
      return null;
    }
    out.push({
      id,
      baseCurrency,
      quoteCurrency,
      rate,
      asOf,
      source,
      method: nullableStr(r.method),
      provenance: nullableStr(r.provenance),
    });
  }
  return out;
}

export function parseRevaluation(body: unknown): FxRevaluationView | null {
  const b = record(body);
  if (b === null) return null;
  const periodEnd = str(b.periodEnd);
  const baseCurrency = str(b.baseCurrency);
  const totalUnrealisedMinor = num(b.totalUnrealisedMinor);
  if (periodEnd === null || baseCurrency === null || totalUnrealisedMinor === null) return null;
  if (!Array.isArray(b.positions) || !Array.isArray(b.byCurrency) || !Array.isArray(b.needsRate)) return null;

  const positions: FxPositionView[] = [];
  for (const raw of b.positions) {
    const p = record(raw);
    if (p === null) return null;
    const kind = str(p.kind);
    const accountId = str(p.accountId);
    const accountNumber = str(p.accountNumber);
    const currency = str(p.currency);
    const fcAmountMinor = num(p.fcAmountMinor);
    const bookChfMinor = num(p.bookChfMinor);
    const rate = str(p.rate);
    const revaluedChfMinor = num(p.revaluedChfMinor);
    const diffChfMinor = num(p.diffChfMinor);
    if (
      (kind !== 'bank' && kind !== 'debtor' && kind !== 'creditor') ||
      accountId === null ||
      accountNumber === null ||
      currency === null ||
      fcAmountMinor === null ||
      bookChfMinor === null ||
      rate === null ||
      revaluedChfMinor === null ||
      diffChfMinor === null
    ) {
      return null;
    }
    positions.push({
      kind,
      accountId,
      accountNumber,
      currency,
      fcAmountMinor,
      bookChfMinor,
      rate,
      rateAsOf: nullableStr(p.rateAsOf),
      revaluedChfMinor,
      diffChfMinor,
    });
  }

  const byCurrency: FxCurrencySummary[] = [];
  for (const raw of b.byCurrency) {
    const c = record(raw);
    if (c === null) return null;
    const currency = str(c.currency);
    const fcAmountMinor = num(c.fcAmountMinor);
    const bookChfMinor = num(c.bookChfMinor);
    const revaluedChfMinor = num(c.revaluedChfMinor);
    const diffChfMinor = num(c.diffChfMinor);
    if (currency === null || fcAmountMinor === null || bookChfMinor === null || revaluedChfMinor === null || diffChfMinor === null) {
      return null;
    }
    byCurrency.push({ currency, fcAmountMinor, bookChfMinor, revaluedChfMinor, diffChfMinor });
  }

  const needsRate: NeedsRateEntry[] = [];
  for (const raw of b.needsRate) {
    const n = record(raw);
    if (n === null) return null;
    const currency = str(n.currency);
    if (currency === null) return null;
    needsRate.push({ currency, latestAsOf: nullableStr(n.latestAsOf) });
  }

  return { periodEnd, baseCurrency, positions, byCurrency, totalUnrealisedMinor, needsRate };
}

export function parsePostResult(body: unknown): PostResultView | null {
  const b = record(body);
  if (b === null) return null;
  const periodEnd = str(b.periodEnd);
  const totalUnrealisedMinor = num(b.totalUnrealisedMinor);
  if (periodEnd === null || totalUnrealisedMinor === null || typeof b.posted !== 'boolean') return null;
  return {
    runId: nullableStr(b.runId),
    periodEnd,
    posted: b.posted,
    entryId: nullableStr(b.entryId),
    reversalId: nullableStr(b.reversalId),
    totalUnrealisedMinor,
    reversalDate: nullableStr(b.reversalDate),
  };
}

// --- refusals --------------------------------------------------------------------------------

/**
 * The rejection codes A22's own surface knows how to name with a next step. Anything else falls to
 * the shared `ErrorBanner`, which owns the generic and the report-this-error path.
 *
 * `needs_rate` carries the currencies still missing a closing rate, so the panel can offer the exact
 * add-rate CTA rather than a bare "add a rate". `already_posted` carries the run so the badge can be
 * specific. `period_locked` links to A03's unlock surface.
 */
export type FxRefusal =
  | { code: 'needs_rate'; currencies: NeedsRateEntry[] }
  | { code: 'period_locked' }
  | { code: 'already_posted'; postedAt: string | null }
  | { code: 'needs_account'; number: string | null };

/** The error codes above, as a set, so a caller can decide whether a rejection is one the surface names. */
const NAMED_CODES = new Set(['needs_rate', 'period_locked', 'already_posted', 'needs_account']);

export function isNamedRefusal(code: unknown): boolean {
  return typeof code === 'string' && NAMED_CODES.has(code);
}

/**
 * Read an engine rejection into a refusal the surface can render, or `null` when the code is one it
 * does not special-case (the ErrorBanner takes those). Reads only fields the engine actually sends.
 */
export function refusalOf(body: unknown): FxRefusal | null {
  const b = record(body);
  if (b === null || b.ok !== false) return null;
  const code = b.error;
  if (code === 'needs_rate') {
    const currencies: NeedsRateEntry[] = [];
    if (Array.isArray(b.currencies)) {
      for (const raw of b.currencies) {
        const n = record(raw);
        const currency = n === null ? null : str(n.currency);
        if (currency !== null) currencies.push({ currency, latestAsOf: n === null ? null : nullableStr(n.latestAsOf) });
      }
    }
    return { code: 'needs_rate', currencies };
  }
  if (code === 'period_locked') return { code: 'period_locked' };
  if (code === 'already_posted') return { code: 'already_posted', postedAt: nullableStr(b.postedAt) };
  if (code === 'needs_account') return { code: 'needs_account', number: nullableStr(b.number) };
  return null;
}

/** Today as an ISO date (`YYYY-MM-DD`), the default the period-end picker opens on. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
