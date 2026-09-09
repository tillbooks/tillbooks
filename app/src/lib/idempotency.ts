/**
 * One idempotency key per QUESTION, for every Studio surface that writes behind an editable form.
 *
 * WHY THIS IS SHARED AND NOT COPIED A FIFTH TIME. The same defect has now been found four times in
 * this codebase, in four surfaces, by three different readers:
 *
 *   1. `BankAccountEditor` (A19), fixed 2026-07-26;
 *   2. `OpeningBalanceStep` (A19), fixed the same day by a second critic, on ROWS, after the first
 *      critic had passed over it;
 *   3. `PaymentAllocator` (A14), the one drawer that writes money on the payments surface;
 *   4. `BucketBoundaries` (A16).
 *
 * Every instance was the same eight lines and the same subtle argument, and A19 wrote that argument
 * out twice, verbatim, in two files. A correctness rule that has to be re-derived at each call site
 * gets it right until it does not: the law was written into `OpeningBalanceStep`'s header AFTER the
 * third instance and the fourth was shipped anyway. So the primitive lives here once, and the
 * reasoning lives with it.
 *
 * WHAT GOES WRONG WITHOUT IT. A key minted at mount names ONE write attempt for ever, while the form
 * behind it stays editable. `SqliteStore.rememberIdempotent` keys on `(workspace, verb, key)` and
 * fingerprints no input at all, so a CHANGED request under a recorded key is REPLAYED rather than
 * refused: the caller is answered `ok` with the first write's result, byte-identical and carrying no
 * marker that would let it tell. The surface then closes reporting a success on a figure the
 * operator had already edited away.
 *
 * The window is not exotic. It is the one the key exists for: a write that LANDED whose response was
 * lost. Both transports surface that as a `transport_error` Result rather than a throw, so the
 * surface shows a refusal over a write the engine has already committed, holds every typed value on
 * purpose, and invites the operator to edit and click again.
 *
 * WHAT THE HELPER DOES. The key cannot be CLEARED when the inputs change, because a null key is not
 * a key. So it is DERIVED: the caller states the question as exactly the values its write sends, and
 * the key changes when, and only when, the request would be a different request. The property the
 * original ref was minted for is untouched: an unchanged question re-clicked after a lost response
 * is still one write, under one key.
 *
 * A REF RATHER THAN A `useMemo`, deliberately. `useMemo` is a hint React is free to discard, and a
 * discarded cache here would mint a fresh key for an UNCHANGED question, which is the double-write
 * the whole mechanism exists to prevent. Re-minting during render is safe because it is decided
 * purely by the question: a repeated render of the same question computes the same answer and keeps
 * the same key.
 *
 * THE ONE CASE IT DOES NOT COVER, stated rather than hidden: it remembers the CURRENT question only,
 * so a caller who edits away from a question and back again gets a third key rather than the first.
 * That errs toward a second write where a replay would have been correct, which is the direction
 * that leaves a visible extra row instead of a silent wrong figure, and it needs React to interleave
 * renders of two different questions, which none of the four callers can do (no `useTransition`, no
 * Suspense boundary between the fields and the write).
 */
import { useRef } from 'react';

/**
 * Hold one key for as long as `question` is unchanged, and mint a new one the moment it is not.
 *
 * `question` is anything `JSON.stringify` can render: pass an array or object built from exactly the
 * fields the write sends, and nothing else. Fields the request does NOT carry must stay out of it,
 * or an edit the engine will never see will throw away a key that was still valid.
 */
export function useIdempotencyKey(question: unknown): string {
  const asked = JSON.stringify(question) ?? 'undefined';
  const held = useRef<{ asked: string; key: string }>({ asked, key: crypto.randomUUID() });
  if (held.current.asked !== asked) {
    held.current = { asked, key: crypto.randomUUID() };
  }
  return held.current.key;
}
