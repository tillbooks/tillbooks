/**
 * O00 (D199), WHAT'S NEW: which release notes this install has not seen yet, and the seen marker.
 *
 * THE SEEN MARKER belongs to the INSTALL, not to a set of books: `<supportDir>/whats-new.json`
 * `{seen, unreleased, at}`. `seen` is the newest version whose notes the person read or dismissed;
 * `unreleased` is the fingerprint of the `unreleased` entry they saw, so a develop build whose unreleased
 * work grew shows the new items once more. The support directory is injected (`ApiDeps.supportDir`), never
 * re-derived, so a suite never touches a real home.
 *
 * THE BASELINE with no marker: a book with no posted entry is a new user, who starts at the running
 * version and sees nothing; a book with entries is an existing install meeting this feature, which starts
 * just below the running version so that version's notes show once. `till up` writes the baseline at boot
 * (`seedSeen`), so it is decided once and does not flip when the first entry is posted later.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeDirectoryDurably, writeFileDurably } from '../store/sqlite-store.js';
import {
  BUNDLED_NOTES,
  CHANGELOG_URL,
  UNRELEASED,
  compareVersions,
  fingerprintOf,
  isVersion,
  resolveItems,
  type ReleaseNote,
  type ResolvedItem,
} from './notes.js';

export const SEEN_FILE = 'whats-new.json';

export interface SeenMarker {
  readonly seen: string;
  readonly unreleased: string | null;
}

export function seenPath(supportDir: string): string {
  return join(supportDir, SEEN_FILE);
}

export function readSeen(supportDir: string | undefined): SeenMarker | null {
  if (supportDir === undefined) return null;
  try {
    const raw = JSON.parse(readFileSync(seenPath(supportDir), 'utf8')) as { seen?: unknown; unreleased?: unknown };
    if (!isVersion(raw.seen) && raw.seen !== '0.0.0') return null;
    return { seen: String(raw.seen), unreleased: typeof raw.unreleased === 'string' ? raw.unreleased : null };
  } catch {
    return null;
  }
}

export function writeSeen(supportDir: string, marker: SeenMarker, now: Date = new Date()): void {
  makeDirectoryDurably(supportDir);
  writeFileDurably(seenPath(supportDir), `${JSON.stringify({ ...marker, at: now.toISOString() }, null, 2)}\n`);
}

/** The `unreleased` entry this build carries, or null on a released build. */
export function unreleasedEntry(notes: readonly ReleaseNote[]): ReleaseNote | null {
  const first = notes[0];
  return first !== undefined && first.version === UNRELEASED ? first : null;
}

/** The marker an install starts from when it has none (see the module comment). */
export function baselineFor(running: string, notes: readonly ReleaseNote[], existingInstall: boolean): SeenMarker {
  const unreleased = unreleasedEntry(notes);
  if (!existingInstall) return { seen: running, unreleased: unreleased === null ? null : fingerprintOf(unreleased) };
  const below = notes.find((r) => r.version !== UNRELEASED && compareVersions(r.version, running) < 0);
  return { seen: below?.version ?? '0.0.0', unreleased: null };
}

/**
 * Write the baseline when the install has no marker yet (`till up` at boot). Returns the marker written,
 * or null when one already existed or there is no support directory. A failing write is not fatal: the
 * read then computes the same baseline.
 */
export function seedSeen(supportDir: string | undefined, running: string, existingInstall: boolean, notes: readonly ReleaseNote[] = BUNDLED_NOTES): SeenMarker | null {
  if (supportDir === undefined || readSeen(supportDir) !== null) return null;
  const marker = baselineFor(running, notes, existingInstall);
  try {
    writeSeen(supportDir, marker);
  } catch {
    return null;
  }
  return marker;
}

export interface NoteEntryView {
  readonly version: string;
  readonly date: string | null;
  readonly items: readonly ResolvedItem[] | ReleaseNote['items'];
}

export interface WhatsNewAnswer {
  readonly version: string;
  readonly seen: string;
  readonly unseen: readonly NoteEntryView[];
  readonly recent: readonly NoteEntryView[];
  readonly releasesUrl: string;
}

function view(entry: ReleaseNote, locale: string | undefined): NoteEntryView {
  return { version: entry.version, date: entry.date ?? null, items: locale === undefined ? entry.items : resolveItems(entry, locale) };
}

/**
 * The read: the running version, the entries this install has not seen (newest first) and the recent
 * ones for the menu, each list capped at `max`. Only entries up to the running build count: a newer
 * version's notes are O01's business (an update that is available, not one that is installed).
 */
export function whatsNew(input: {
  running: string;
  supportDir: string | undefined;
  existingInstall: () => boolean;
  max: number;
  locale?: string | undefined;
  notes?: readonly ReleaseNote[];
}): WhatsNewAnswer {
  const notes = input.notes ?? BUNDLED_NOTES;
  const marker = readSeen(input.supportDir) ?? baselineFor(input.running, notes, input.existingInstall());
  const unreleased = unreleasedEntry(notes);
  const installed = notes.filter((r) => r.version === UNRELEASED || compareVersions(r.version, input.running) <= 0);
  const unseen = installed.filter((r) =>
    r.version === UNRELEASED ? unreleased !== null && fingerprintOf(r) !== marker.unreleased : compareVersions(r.version, marker.seen) > 0,
  );
  const locale = input.locale;
  return {
    version: input.running,
    seen: marker.seen,
    unseen: unseen.slice(0, input.max).map((r) => view(r, locale)),
    recent: installed.slice(0, input.max).map((r) => view(r, locale)),
    releasesUrl: locale !== undefined && locale.startsWith('de') ? CHANGELOG_URL.replace('/en/', '/de/') : CHANGELOG_URL,
  };
}

/** Mark the notes up to the running build as seen (the unreleased entry included). */
export function markSeen(input: { running: string; supportDir: string; notes?: readonly ReleaseNote[] }): SeenMarker {
  const notes = input.notes ?? BUNDLED_NOTES;
  const unreleased = unreleasedEntry(notes);
  const marker: SeenMarker = { seen: input.running, unreleased: unreleased === null ? null : fingerprintOf(unreleased) };
  writeSeen(input.supportDir, marker);
  return marker;
}
