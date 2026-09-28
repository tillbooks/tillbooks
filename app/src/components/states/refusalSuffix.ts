import type { Err } from '../../lib/client';

/**
 * Which sentence of a code the flags select (the engine sets them; the English `message` is never read).
 *
 *  - `partial` (critic R2-4): the failure came AFTER the action had already saved part of its work
 *    (`store_busy`, `unexpected_error`, `schema_newer_than_runtime`). The plain sentences say nothing was
 *    changed, which is then false, so each has a `_partial` sentence that says what is.
 *  - `partial` and `completed` (critic R4-1, `schema_newer_than_runtime` only): the action was saved
 *    WHOLE, and the book moved on to a newer TILL right after. "Part of it was saved" would be false,
 *    and so would any invitation to try again: a repeat would do the action twice. `_saved` says so.
 */
export function refusalSuffix(error: Err | undefined): '' | '_partial' | '_saved' {
  if (error?.partial !== true) return '';
  return error.error === 'schema_newer_than_runtime' && error.completed === true ? '_saved' : '_partial';
}

/**
 * The SHARED `errors.*` key a surface must use instead of its own catalogue, or undefined when its own
 * wording is fine. A surface that maps codes to its own vocabulary (Recurring, Automations) asks this
 * first: only the shared catalogue says truthfully what a refusal raised after the call had saved
 * (`partial`, `completed`) left behind, and the newer-book refusal is worded once, there.
 */
export function sharedRefusalKey(error: Err): string | undefined {
  const suffix = refusalSuffix(error);
  return suffix !== '' || error.error === 'schema_newer_than_runtime' ? `errors.${error.error}${suffix}` : undefined;
}
