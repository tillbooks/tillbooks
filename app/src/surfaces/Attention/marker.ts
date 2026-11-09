/**
 * The "neu" last-seen marker (design §6d): when did I last look at THIS client's Pendenzen.
 *
 * Browser-local, never a verb, never a table, never synced, exactly like G16's recents and for the
 * same reason: a read receipt is not accounting data and storing it in the ledger earns nothing. It
 * is keyed PER WORKSPACE, because "last looked at THIS mandate" is the fact a Treuhänder's own working
 * record is made of, and `localStorage` has no tenant column to forget (§6d). The tag hides nothing: a
 * missing marker degrades to "no tags", never to "no rows".
 */

const PREFIX = 'till.attention.lastSeen.';

function keyFor(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // A privacy mode that throws on access degrades to "no marker", i.e. no tags. Never a crash.
    return null;
  }
}

/** The ISO instant this workspace's hub was last opened, or null when there is no marker yet. */
export function readLastSeen(workspaceId: string): string | null {
  const store = storage();
  if (store === null) return null;
  try {
    return store.getItem(keyFor(workspaceId));
  } catch {
    return null;
  }
}

/** Record that this workspace's hub was opened at `at` (an ISO instant). Best-effort. */
export function writeLastSeen(workspaceId: string, at: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(keyFor(workspaceId), at);
  } catch {
    // A full or disabled store simply means no "neu" tags next visit. Not an error worth surfacing.
  }
}

/** True when `since` is strictly newer than the last-seen marker. A missing marker tags nothing. */
export function isNew(since: string, lastSeen: string | null): boolean {
  if (lastSeen === null || since === '') return false;
  return since > lastSeen;
}
