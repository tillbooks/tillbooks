/**
 * §H-FX, the rate arithmetic. Integer only, no floats anywhere on this path.
 *
 * A rate is held as a SCALED INTEGER at `RATE_SCALE` (1e12, twelve decimal places). It is parsed
 * from and rendered back to a decimal STRING by digit manipulation, never through `parseFloat`: the
 * whole point of integer Rappen is lost the moment `0.9412` becomes a binary double and 100 of them
 * stop summing to 94.12.
 *
 * ## The quotation convention (read this before touching anything)
 *
 * A pair is written `base_currency/quote_currency` and the rate is the price of ONE unit of the BASE
 * currency expressed in the QUOTE currency, which is the ordinary FX market convention:
 *
 *     EUR/CHF = 0.9412  means  1 EUR = 0.9412 CHF  and  amountCHF = amountEUR * 0.9412
 *
 * The trap this invites is worth naming: the workspace's LEDGER base currency (CHF) is the pair's
 * QUOTE side, not its base side. TILL therefore only ever stores and resolves rows whose
 * `quote_currency` IS the workspace base currency, and `recordExchangeRate` rejects anything else
 * rather than accept a row nothing can use (see rates.ts).
 *
 * ## Rounding, stated once
 *
 * Every conversion rounds HALF AWAY FROM ZERO at the Rappen, the same rule A06/A10 already round
 * money with, so one convention covers the whole money path.
 *
 * Converting each line independently would round each one independently, and `Σ round(x_i)` is not
 * `round(Σ x_i)`: a EUR invoice whose gross is one debit and whose net + VAT are two credits can
 * come out one Rappen unbalanced in CHF, which §H-LEDGER would (correctly) refuse. Plugging that
 * with a rounding-difference account would be inventing money. So the conversion is done ONCE per
 * side, on the side TOTAL, and the resulting base total is allocated back over the lines by LARGEST
 * REMAINDER (Hare quota, ties to the lower line index). Both sides carry the same transaction-currency
 * total (the entry balances before conversion), so both receive the same base total and the entry is
 * balanced in CHF BY CONSTRUCTION, with every line within one Rappen of its own conversion.
 *
 * For a rate of exactly 1 (a base-currency entry) the allocation is the identity: `a_i * T / T == a_i`
 * exactly in integer arithmetic, so a CHF posting produces bit-identical numbers to the pre-FX engine.
 */

/**
 * Decimal places a stored rate is held to.
 *
 * TWELVE, and the number is not a round-up-for-comfort. It is what the admissible published series
 * actually needs, plus a stated margin.
 *
 * The BAZG "Devisenkurse (Verkauf)" feed is the series the ESTV names as the MWST Tageskurs
 * (see `./bazgFeed.ts`), and it quotes per 1, 100, 1000 or 10000 units with five decimal places. The
 * per-unit rate therefore runs to NINE decimal places, and on the real payload of 24.07.2026 four of
 * the 72 currencies land exactly there:
 *
 *     IDR  10000 IDR = 0.45902 CHF  ->  0.000045902
 *     KHR  10000 KHR = 2.05323 CHF  ->  0.000205323
 *     COP  10000 COP = 2.56742 CHF  ->  0.000256742
 *     LBP  10000 LBP = 0.09201 CHF  ->  0.000009201
 *
 * At eight places none of the four could be held, so none of them could be BOOKED: the §H-FX
 * foundation shipped with that as open item 4. Rounding them to fit was never on the table, because
 * a truncated rate is a fixed RELATIVE error and so loses more money the larger the invoice: at
 * 0.00004590 instead of 0.000045902, an IDR 9'876'543'210.00 sale books CHF 453'333.33 where the
 * published rate says CHF 453'353.09.
 *
 * Twelve leaves three orders of magnitude of headroom below today's smallest published rate, so a
 * currency can devalue a thousandfold and still be booked with four significant figures. Going
 * further is not free: see `RATE_MAX_SCALED` for the ceiling the scale buys at the other end.
 */
export const RATE_DECIMALS = 12;

/** The scaling factor a rate is held at: `rateScaled = rate * RATE_SCALE`. */
export const RATE_SCALE = 1_000_000_000_000n;

/** The scaled representation of a rate of exactly 1 (a base-currency posting). */
export const RATE_ONE = RATE_SCALE;

/**
 * The largest rate the ledger will hold, as its scaled integer: 9000 units of base currency per unit
 * of foreign currency.
 *
 * Two ceilings sit above a scaled rate, and this is the lower of them, deliberately.
 *
 *  - `exchange_rate.rate_scaled` is a SQLite INTEGER, so 64-bit signed: 9'223'372'036'854'775'807.
 *    That is a thousand times this ceiling.
 *  - The store reads that column back as a JavaScript `number`, and a `number` is only EXACT to
 *    `Number.MAX_SAFE_INTEGER` (9'007'199'254'740'991). A stored rate above it would come back as a
 *    different rate, which on this path means different money. This ceiling sits just under it, so
 *    every value that can be stored is exact in both representations and the hazard cannot arise.
 *
 * 9000 is far above anything a currency does: the largest rate the published series carries is
 * KWD at 2.66992, so the ceiling is over three thousand times the real maximum. A rate above it is
 * REFUSED by `parseRate` rather than truncated into range, because a rate quietly clamped to fit is
 * a wrong rate, and a wrong rate is wrong money.
 */
export const RATE_MAX_SCALED = 9_000_000_000_000_000n;

const RATE_PATTERN = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

/**
 * Parse a decimal rate string into its scaled integer, exactly. Returns `null` for anything that is
 * not a positive decimal with at most `RATE_DECIMALS` places, and for anything above
 * `RATE_MAX_SCALED`: a rate TILL cannot represent exactly is refused, never silently truncated or
 * clamped (either one is a wrong rate).
 */
export function parseRate(text: unknown): bigint | null {
  if (typeof text !== 'string') return null;
  const m = RATE_PATTERN.exec(text.trim());
  if (m === null) return null;
  const whole = m[1] ?? '0';
  const frac = (m[2] ?? '').padEnd(RATE_DECIMALS, '0');
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(frac);
  return scaled > 0n && scaled <= RATE_MAX_SCALED ? scaled : null;
}

/**
 * Render a scaled rate back to its canonical decimal string: no exponent, no trailing zeros, and no
 * trailing dot. This is the ONE textual form stored in `exchange_rate.rate` and stamped onto
 * `journal_line.fx_rate`, so the same rate always reads the same way in the audit trail.
 */
export function formatRate(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const frac = (scaled % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0').replace(/0+$/, '');
  return frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
}

/** Round a scaled product back to whole minor units, half away from zero. */
function unscaleHalfAway(scaledProduct: bigint): bigint {
  const half = RATE_SCALE / 2n;
  return scaledProduct < 0n
    ? -((-scaledProduct + half) / RATE_SCALE)
    : (scaledProduct + half) / RATE_SCALE;
}

/**
 * Convert one amount in transaction minor units to base minor units at `rateScaled`, rounded half
 * away from zero. Used for the side TOTAL; per-line figures come from `allocateBase`, which keeps
 * the sides equal.
 */
export function convertMinor(amountMinor: number, rateScaled: bigint): number {
  return Number(unscaleHalfAway(BigInt(amountMinor) * rateScaled));
}

/**
 * Allocate the converted side total back over the side's line amounts by largest remainder.
 *
 * `amounts` are non-negative transaction-currency minor units (one side of an entry, in line order).
 * The return is the same length, non-negative, and sums EXACTLY to `convertMinor(Σ amounts, rate)`.
 * Ties in the remainder go to the lower index, so the result is deterministic and a reversal of an
 * FX entry reproduces the original's base amounts line for line.
 */
export function allocateBase(amounts: readonly number[], rateScaled: bigint): number[] {
  const total = amounts.reduce((sum, a) => sum + BigInt(a), 0n);
  if (total === 0n) return amounts.map(() => 0);

  const baseTotal = unscaleHalfAway(total * rateScaled);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let allocated = 0n;
  for (const amount of amounts) {
    const numerator = BigInt(amount) * baseTotal;
    const floor = numerator / total;
    floors.push(floor);
    remainders.push(numerator - floor * total);
    allocated += floor;
  }

  let leftover = baseTotal - allocated;
  const order = amounts
    .map((_, i) => i)
    .sort((x, y) => {
      const rx = remainders[x] as bigint;
      const ry = remainders[y] as bigint;
      if (rx === ry) return x - y;
      return ry > rx ? 1 : -1;
    });
  for (let k = 0; k < order.length && leftover > 0n; k += 1) {
    const i = order[k] as number;
    floors[i] = (floors[i] as bigint) + 1n;
    leftover -= 1n;
  }

  return floors.map((f) => Number(f));
}

/** ISO 4217 shape: three uppercase letters. The engine never invents or normalises a currency code. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}
