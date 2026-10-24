/**
 * D166 point 8 (critic N1): the adopted book is not reachable, Studio side.
 *
 * While `till up` runs on its in-memory stand-in for an adopted book it could not open, the engine
 * refuses every verb but `delivery_status` with `adopted_book_unavailable` (the chokepoint in
 * `src/api/agent-gate.ts`). The Studio has ONE place that hears that refusal, `TillClient.call`, and it
 * announces it here; `WorkspaceResolver` (app/workspace.tsx) listens, and also reads `delivery_status`
 * on landing, and routes to `/first-run`, where the "nicht erreichbar" page is. So no surface has to
 * know about it, and a surface built later is covered too.
 */

/** The engine's refusal code (mirrors `ADOPTED_BOOK_UNAVAILABLE` in `src/api/agent-gate.ts`). */
export const ADOPTED_BOOK_UNAVAILABLE = 'adopted_book_unavailable';

/** The window event the client raises when the engine answered with that refusal. */
export const ADOPTED_BOOK_EVENT = 'till:adopted-book-unavailable';

/** Did the engine refuse this call because the adopted book is not reachable? */
export function isAdoptedBookRefusal(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === ADOPTED_BOOK_UNAVAILABLE;
}

/** Announce the refusal to whoever routes (one listener, `WorkspaceResolver`). Never throws. */
export function noticeAdoptedBookRefusal(body: unknown): void {
  if (!isAdoptedBookRefusal(body) || typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(ADOPTED_BOOK_EVENT));
  } catch {
    // a page without events simply stays where it is
  }
}

/** `delivery_status.adoptedBookUnavailable`, read defensively: true only when the engine says so. */
export function reportsAdoptedBookUnavailable(body: unknown): boolean {
  const value = (body as { adoptedBookUnavailable?: unknown } | null)?.adoptedBookUnavailable;
  return typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';
}
