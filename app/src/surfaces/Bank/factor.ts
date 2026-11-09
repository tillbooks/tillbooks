/**
 * D177 (A39 §16.1): authoring a COMPUTED amount (`factor`) in the rule form. The engine stores and applies
 * the fraction (round-half-up(|line| × num / den) in Rappen); this module only turns what a person types
 * into an exact fraction, and shows what the fraction gives on the line the rule is saved from.
 *
 *   - "Plattform-Auszahlung (MWST-Satz, Gebühr vom Netto)": the owner's preset (D177 point 1). With the
 *     MWST rate v and a fee f taken on the net, the gross is payout × (1 + v) / (v + f), exact in basis
 *     points: num = 10000 + vBp, den = vBp + fBp, reduced. 8.1 % and 9.9 % give 1081/180, so a 15.12
 *     payout gives 90.80.
 *   - "Faktor": a decimal ("6.0056") or a fraction ("1081/180"), turned into an exact num/den, reduced.
 *
 * Every figure stays an integer (BigInt for the product), so nothing drifts by a Rappen.
 */

export interface Fraction {
  num: number;
  den: number;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

/** num/den reduced, both positive safe integers, else null. */
export function reduced(num: bigint, den: bigint): Fraction | null {
  if (num <= 0n || den <= 0n) return null;
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || d > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { num: Number(n), den: Number(d) };
}

/** A percent as typed ("8.1", "8,1", "9.90") in basis points, at most two decimals, 0 to 100 %; else null. */
export function percentToBp(raw: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  if (m === null) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp > 10_000 ? null : bp;
}

/** The platform preset: (1 + v) / (v + f) as an exact fraction, with its `explain`; null when unreadable. */
export function platformFactor(vatPct: string, feePct: string): (Fraction & { explain: { vatBp: number; feeBp: number } }) | null {
  const vatBp = percentToBp(vatPct);
  const feeBp = percentToBp(feePct);
  if (vatBp === null || feeBp === null) return null;
  const f = reduced(BigInt(10_000 + vatBp), BigInt(vatBp + feeBp));
  return f === null ? null : { ...f, explain: { vatBp, feeBp } };
}

/** A decimal ("6.0056", "6,0056") or a fraction ("1081/180") as an exact positive fraction; else null. */
export function decimalFactor(raw: string): Fraction | null {
  const text = raw.trim().replace(/[\s']/g, '');
  const frac = /^(\d{1,15})\/(\d{1,15})$/.exec(text);
  if (frac !== null) return reduced(BigInt(frac[1] as string), BigInt(frac[2] as string));
  const m = /^(\d{1,9})(?:[.,](\d{1,9}))?$/.exec(text);
  if (m === null) return null;
  const decimals = m[2] ?? '';
  return reduced(BigInt(`${m[1] as string}${decimals}`), 10n ** BigInt(decimals.length));
}

/** What a fraction gives on a line: round-half-up(|amount| × num / den), in Rappen. */
export function applyFactor(amountMinor: number, f: Fraction): number {
  const abs = BigInt(Math.abs(amountMinor));
  const num = BigInt(f.num);
  const den = BigInt(f.den);
  return Number((abs * num * 2n + den) / (2n * den));
}
