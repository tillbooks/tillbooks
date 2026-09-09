/**
 * G16 palette recents: local to the browser, never a verb, never a table, never synced (design §6c).
 *
 * THE ONE TENANT RULE. The two kinds of recent are not the same kind of secret. A recent VERB
 * (`issue_invoice`) is the product's feature list, identical everywhere, and survives a workspace
 * switch. A recent RECORD ("Rechnung RE-2026-014, Muster AG") is a client's name and document number:
 * for a Treuhänder holding several clients in one Studio it is exactly the material A23's isolation
 * keeps apart. So verbs are stored GLOBALLY and records are stored PER WORKSPACE, keyed by id, and a
 * switch clears the previous tenant's records. `localStorage` has no tenant column, so this rule
 * ships by default when nobody writes it down: it is written down here.
 */

const MAX = 6;

function read(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Recent verb names, global to the browser profile. */
export function readVerbs(): string[] {
  return read('till.recent.verbs');
}

/** Recent record refs for ONE workspace. Never read for a different workspace. */
export function readRecords(workspaceId: string): string[] {
  return read(`till.recent.records.${workspaceId}`);
}

/** A record ref packs the fields the browse state needs, so no second read is required to render it. */
export function recordRef(hit: { entityKind: string; entityId: string; title: string; route: string }): string {
  return [hit.entityKind, hit.entityId, hit.title, hit.route].join(' | ');
}

/** Push `ref` to the front of a recents list, de-duplicated, capped. `read` supplies the current list. */
export function pushRecent(key: string, currentReader: () => string[], ref: string): void {
  try {
    const next = [ref, ...currentReader().filter((r) => r !== ref)].slice(0, MAX);
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* a private-mode localStorage throw must never take the palette down */
  }
}

/** Drop a workspace's record recents on a switch, so a client's titles never leak to the next tenant. */
export function clearWorkspaceRecents(workspaceId: string): void {
  try {
    window.localStorage.removeItem(`till.recent.records.${workspaceId}`);
  } catch {
    /* ignore */
  }
}
