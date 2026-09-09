/**
 * Where the Studio remembers which workspace it is looking at (D12).
 *
 * Two sources, in this order:
 *
 * 1. **The URL, `/w/:workspaceId`.** The source of truth when it is present, so a workspace is
 *    linkable and bookmarkable and two browser tabs can sit on two different sets of books.
 * 2. **`localStorage`, the fallback for a bare `/`.** The Studio is opened far more often by
 *    reloading than by following a link, and before this the id lived in React state only: a reload
 *    lost the tenant entirely and the only way forward was to mint a duplicate workspace.
 *
 * A stored or URL-supplied id is VALIDATED before it is believed. It is about to be threaded into
 * every engine call as the tenant, and neither the address bar nor `localStorage` is trustworthy
 * input. A value that does not look like a minted id is treated as absent, not passed through.
 */

/** The `localStorage` key holding the last selected workspace. Sibling of `till-theme`. */
export const WORKSPACE_STORAGE_KEY = 'till-workspace';

/** Minted ids look like `ws_<token>` (see `IdGen`). Anything else is not a tenant. */
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]+$/;

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_ID.test(value);
}

/**
 * Pull the workspace id out of a `/w/:workspaceId` path (with or without a surface below it).
 * Returns null for every other path, and for a `/w/` segment that is not a well-formed id.
 */
export function readWorkspaceIdFromPath(pathname: string): string | null {
  const match = /^\/w\/([^/]+)/.exec(pathname);
  if (match === null) return null;
  const candidate = decodeURIComponent(match[1]);
  return isWorkspaceId(candidate) ? candidate : null;
}

/**
 * Read the remembered workspace. `localStorage` can throw outright (Safari private browsing, a
 * hardened profile), and a Studio that cannot remember a workspace must still open, so a failure
 * here is "no workspace remembered", never an exception.
 */
export function readStoredWorkspaceId(): string | null {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return isWorkspaceId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remember (or, with null, forget) the selected workspace. Never throws. */
export function storeWorkspaceId(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      return;
    }
    if (isWorkspaceId(id)) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
  } catch {
    // A Studio that cannot persist its choice still works for this session.
  }
}

/** The workspace this page load starts on: the URL if it names one, else the remembered one. */
export function resolveInitialWorkspaceId(pathname = window.location.pathname): string | null {
  return readWorkspaceIdFromPath(pathname) ?? readStoredWorkspaceId();
}
