/**
 * Money, as integer Rappen.
 *
 * There are no floats anywhere on the money path. `0.1 + 0.2 !== 0.3` is not a curiosity here, it
 * is a defect that compounds silently across a year of entries and then fails an audit. Every
 * amount in TILL is an integer count of the currency's minor unit, and CHF has 100 of them.
 *
 * This module is deliberately small and total. It is the bottom of the money path, so it must be
 * boring.
 */

/** An integer amount in the minor unit (Rappen for CHF). Negative means credit / outgoing. */
export type Rappen = number & { readonly __brand: 'Rappen' };

/** ISO 4217. CHF is base; others arrive with the FX work. */
export type Currency = 'CHF' | 'EUR' | 'USD';

export interface Money {
  readonly amount: Rappen;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Assert an integer count of minor units. Throws on a float, NaN, or an unsafe magnitude. */
export function rappen(value: number): Rappen {
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Money must be an integer count of Rappen, got ${value}. ` +
        `Use money.fromFranken() to convert, never a raw float.`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount ${value} exceeds the safe integer range.`);
  }
  return value as Rappen;
}

export function money(amount: number, currency: Currency = 'CHF'): Money {
  return { amount: rappen(amount), currency };
}

/**
 * Convert a Franken figure to Rappen.
 *
 * Rounds half away from zero, which is what Swiss commercial practice expects and what
 * `Math.round` does NOT do for negatives (`Math.round(-0.5)` is `-0`, not `-1`).
 */
export function fromFranken(franken: number, currency: Currency = 'CHF'): Money {
  if (!Number.isFinite(franken)) {
    throw new MoneyError(`Cannot convert a non-finite value: ${franken}`);
  }
  // `franken * 100` is a float multiply, so it reintroduces the exact defect this module exists to
  // prevent: 1.005 * 100 is 100.49999999999999, which rounds down and loses a Rappen. Collapsing to
  // 15 significant digits discards the representation error while keeping every real value intact.
  const scaled = Number((franken * 100).toPrecision(15));
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return money(rounded, currency);
}

/** The Franken value, for display and export only. Never feed this back into arithmetic. */
export function toFranken(m: Money): number {
  return m.amount / 100;
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Refusing to mix ${a.currency} and ${b.currency}. Convert through an explicit FX rate first.`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function sum(items: readonly Money[], currency: Currency = 'CHF'): Money {
  return items.reduce<Money>((acc, m) => add(acc, m), money(0, currency));
}

export function isZero(m: Money): boolean {
  return m.amount === 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

/**
 * Format for humans: `CHF 1'234.55`.
 *
 * The Swiss thousands separator is an apostrophe. Not a comma, not a period, not a space.
 */
export function format(m: Money): string {
  const negative = m.amount < 0;
  const abs = Math.abs(m.amount);
  const whole = Math.trunc(abs / 100);
  const cents = abs % 100;

  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const body = `${grouped}.${String(cents).padStart(2, '0')}`;

  return `${negative ? '-' : ''}${m.currency} ${body}`;
}
