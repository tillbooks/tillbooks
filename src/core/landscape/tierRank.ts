/**
 * TIER RANK: the down-only invariant made checkable (canon finding #10).
 *
 * "Data flows DOWN only" (`main` -> `test` -> `develop`) was a slogan the original design only
 * half-enforced (it keyed protection to the NAME `main`). Each environment now carries an explicit
 * `tier_rank`, and the copy path (Phase B) refuses a source whose rank is at or below the target's, so
 * "down only" is a checked invariant rather than a promise. This module owns the ranking and the
 * comparison; nothing else decides what "below" means.
 *
 * A LARGER number is a MORE SENSITIVE tier. `main` sits at the top, `test` below it, `develop` below
 * that, and a named ad-hoc environment defaults below `develop` unless its creator pins a rank. The
 * gaps are deliberately wide (100 apart) so a named env can be slotted between two tiers by rank.
 */

/** `main`: the live books. The highest rank; nothing is more sensitive, so nothing may copy INTO it. */
export const RANK_MAIN = 300;
/** `test`: staging-grade, a sanitized copy of `main`. */
export const RANK_TEST = 200;
/** `develop`: synthetic, the lowest of the three standard tiers. */
export const RANK_DEVELOP = 100;
/** The default rank for a named ad-hoc environment: below `develop`, so a copy into it is always down. */
export const RANK_NAMED_DEFAULT = 50;

/** The standard tier ranks, so the control-file bootstrap and the tests read ONE source. */
export const STANDARD_TIER_RANKS: Readonly<Record<string, number>> = {
  main: RANK_MAIN,
  test: RANK_TEST,
  develop: RANK_DEVELOP,
};

/**
 * May data be copied from a source of `sourceRank` DOWN into a target of `targetRank`?
 *
 * Strictly greater: a copy from a rank onto an EQUAL rank is refused too, because two same-rank
 * environments carry the same sensitivity and a "copy" between them is a lateral move the landscape
 * law does not sanction. This is the Phase B `env.copy` guard, implemented now so the ranking is real
 * from birth (finding #10).
 */
export function canCopyDown(sourceRank: number, targetRank: number): boolean {
  return sourceRank > targetRank;
}

/**
 * The rank a NEW environment should carry: the caller's explicit choice when valid, else the standard
 * rank for a standard name, else the named default. A non-integer or non-positive explicit rank is
 * rejected by returning `undefined`, so the operation can refuse with `invalid_input` rather than
 * silently coercing.
 */
export function resolveTierRank(name: string, explicit: unknown): number | undefined {
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'number' || !Number.isInteger(explicit) || explicit <= 0) return undefined;
    return explicit;
  }
  return STANDARD_TIER_RANKS[name] ?? RANK_NAMED_DEFAULT;
}
