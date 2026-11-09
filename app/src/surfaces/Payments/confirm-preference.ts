/**
 * The "nicht mehr anzeigen" preference for the post-confirmation dialog (P9, D38).
 *
 * WHAT THIS IS ALLOWED TO DECIDE: whether a human sees a dialog before a payment posts.
 * WHAT THIS IS NOT ALLOWED TO DECIDE: anything on the wire. It cannot reach `intent.ts`, does not
 * import it, and is not imported by it. The intent token is attached by the request builders with
 * no parameter for it, so no value stored here can produce a post without one.
 *
 * WHY `localStorage` AND NOT THE SERVER. D38 is explicit and the reasoning matters more than the
 * mechanism: a server-side setting would imply it could change the CONTRACT, which is the one thing
 * it must never do. A per-operator presentational choice belongs on the operator's own machine, next
 * to `till-theme` and `till-workspace`, which is exactly where it lives.
 *
 * KEYED PER WORKSPACE. One person can keep three sets of books: a bookkeeper who has decided they no
 * longer need the dialog on their own test workspace has not decided that for a client's live
 * ledger. The key is `till-payment-confirm:<workspaceId>`, so the answer never leaks across tenants.
 *
 * NEVER THROWS. `localStorage` can throw outright (Safari private browsing, a hardened profile), and
 * a Studio that cannot remember a preference must still post payments. A failure to read is "the
 * preference is not set", which fails SAFE: the dialog is shown.
 */

/** The `localStorage` key prefix. Sibling of `till-theme` and `till-workspace`. */
export const CONFIRM_PREFERENCE_PREFIX = 'till-payment-confirm';

/** The stored value meaning "this operator asked not to see the dialog again". */
const SUPPRESSED = 'suppressed';

function keyFor(workspaceId: string): string {
  return `${CONFIRM_PREFERENCE_PREFIX}:${workspaceId}`;
}

/**
 * Should the confirmation dialog be shown before posting in this workspace?
 *
 * Defaults to `true`, and every failure path also returns `true`. Showing a dialog one extra time
 * is a small annoyance; skipping one because storage threw is a payment posted without the person
 * being asked, so the two outcomes are not weighed equally.
 */
export function shouldConfirmPost(workspaceId: string | null): boolean {
  if (workspaceId === null) return true;
  try {
    return window.localStorage.getItem(keyFor(workspaceId)) !== SUPPRESSED;
  } catch {
    return true;
  }
}

/** Record (or clear) this operator's choice for one workspace. Never throws. */
export function setConfirmPostSuppressed(workspaceId: string | null, suppressed: boolean): void {
  if (workspaceId === null) return;
  try {
    if (suppressed) window.localStorage.setItem(keyFor(workspaceId), SUPPRESSED);
    else window.localStorage.removeItem(keyFor(workspaceId));
  } catch {
    // A Studio that cannot persist the choice still posts payments; it just keeps asking.
  }
}
