/**
 * A13's apportionment arithmetic, in a dependency-free leaf module.
 *
 * It lives alone (rather than inside `creditNote.ts`, where it was born) so the Studio can import
 * THE ENGINE'S OWN largest-remainder split for the D78 gross readout the way it already imports
 * pure engine enums: one source, no client re-implementation, and no engine dependency (store,
 * ledger, clock) dragged into the browser bundle. `creditNote.ts` re-exports it, so the barrel and
 * every existing import are unchanged.
 */

/**
 * Apportion a NET amount across weights by largest remainder (P2: integer arithmetic, the parts sum
 * to the target EXACTLY). BigInt, because `amount * weight` can leave the safe range long before
 * either factor does. Ties go to the earlier index, so the result is deterministic.
 */
export function apportionNet(amountMinor: number, weights: readonly number[]): number[] {
  const total = weights.reduce((n, v) => n + v, 0);
  if (total <= 0) return weights.map(() => 0);
  const a = BigInt(amountMinor);
  const t = BigInt(total);
  const shares = weights.map((w) => {
    const scaled = a * BigInt(w);
    return { floor: Number(scaled / t), remainder: scaled % t };
  });
  let missing = amountMinor - shares.reduce((n, s) => n + s.floor, 0);
  const order = shares
    .map((s, i) => ({ i, remainder: s.remainder }))
    .sort((x, y) => (x.remainder === y.remainder ? x.i - y.i : x.remainder > y.remainder ? -1 : 1));
  const out = shares.map((s) => s.floor);
  for (const { i } of order) {
    if (missing <= 0) break;
    out[i] = (out[i] as number) + 1;
    missing -= 1;
  }
  return out;
}
