/**
 * Money input for the allocator, and the idempotency key one drawer session posts under.
 *
 * The GUI holds ONLY raw typed input. It parses a decimal string into integer Rappen and hands that
 * to the engine, and every figure it then displays comes back from `preview_payment`. Nothing here
 * adds, subtracts, or rounds money: the remainder on screen is the engine's `remainderMinor`, never
 * `amount - sum(inputs)` computed in JavaScript (§4 rule 3). That rule is not stylistic. A06 proved
 * the discipline pays in the running product, and the one place this codebase computed a money
 * figure locally it was a Rappen out from the ledger.
 */

/**
 * Parse a decimal amount string ("50", "50.5", "1'234.55") into integer Rappen.
 *
 * Returns `null` for an empty field and for anything that is not a non-negative amount with at most
 * two decimals. Parsing is exact: the fractional part is read as digits and never through a binary
 * float, because `50.55 * 100` is 5054.999999999999 and truncates to the wrong Rappen.
 */
export function parseAmountToMinor(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  if (cleaned === '') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const whole = Number(match[1]);
  const rappen = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + rappen;
}

/**
 * Render integer Rappen back into the plain decimal an input field holds.
 *
 * Deliberately NOT `formatMoney`: an input carries `1081.00`, not `CHF 1'081.00`. Putting a grouped,
 * currency-prefixed string into a text field is how a re-parse loses the value the moment the user
 * touches it.
 */
export function minorToInput(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * Mint a fresh idempotency key for one write that has NO editable question behind it (§4 rule 6, P5).
 *
 * The allocator drawer no longer calls this, and the reason is worth keeping next to it. It used to
 * mint one key at mount and hold it for the life of the drawer, which is right for a retry of the
 * same question and silently wrong for a retry of a CHANGED one: the engine fingerprints little or
 * none of the request, so an edited plan under a held key is REPLAYED with the first plan's result.
 * That surface now derives its key from its question (`app/src/lib/idempotency.ts`).
 *
 * What is left is one caller: `reverse_payment` on the list (`Payments.tsx`), which mints a fresh key
 * on every confirm. That is the OPPOSITE arrangement and it is safe here for a reason that is worth
 * writing down rather than assuming: a second reversal cannot double-post whatever key it carries,
 * because the engine refuses a reversed payment with `already_reversed` before it writes, and the
 * reversing entry itself is keyed `['payment_reversal', paymentId]`, which no client value reaches.
 * The client key is belt to those braces there, not the only strap.
 *
 * It is not a general-purpose mint. A caller whose request the operator can still edit between the
 * mint and the write wants `useIdempotencyKey` (`app/src/lib/idempotency.ts`) instead.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The pair a `needs_fx_rate` refusal names, rendered the way the copy expects: `EUR/CHF`. */
export function currencyPair(currency: unknown, baseCurrency: unknown): string {
  const from = typeof currency === 'string' ? currency : '';
  const to = typeof baseCurrency === 'string' ? baseCurrency : '';
  return to === '' ? from : `${from}/${to}`;
}
