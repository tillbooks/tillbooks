/**
 * Test support (D178 N2): a person's preferences for a /bank suite, held in a detached store.
 *
 * The D177 suites were written against the side panel beside the table; since D178 N2 that is the detail
 * area docked RIGHT, and the default (`automatic`) docks a short inbox at the bottom. A suite that asserts
 * the D177 layout (the compact table, the panel's Buchen) renders under `dockedRight()`, which states that
 * layout as the person's preference instead of relying on the line count. Imported by tests only.
 */
import { PrefsStore, type PrefValue } from '../../lib/prefs';

/** A detached store seeded with `seed` (no engine is asked; a write applies at once). */
export function prefsStore(seed: Record<string, PrefValue> = {}): PrefsStore {
  const store = new PrefsStore(null, null, { useCache: false });
  for (const [key, value] of Object.entries(seed)) store.seed(key, value);
  return store;
}

/** The D177 layout: the detail area docked right, whatever the inbox's size. */
export function dockedRight(): PrefsStore {
  return prefsStore({ 'bank.detail_position': 'right' });
}
