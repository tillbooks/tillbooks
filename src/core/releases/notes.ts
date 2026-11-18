/**
 * O00 (D199), THE RELEASE NOTES: the bundled `whats-new.json`, its shape, its validation and the version
 * order every reader shares.
 *
 * The notes are written by hand, versioned with the code and imported here, so `tsc` ships the file in
 * `dist/` and in the npm package: the Studio, `release.mjs bump`, the test and the website all read the
 * SAME file, and the Studio needs no network to show it.
 *
 * VERSION ORDER. TILL ships pre-releases (`1.0.0-beta.5`), so the order is SemVer 2.0 precedence with the
 * pre-release part: `1.0.0-beta.10` is newer than `1.0.0-beta.9`, and `1.0.0` is newer than every
 * `1.0.0-*`. The one `unreleased` entry (a develop build's work since the last version) is newer than all.
 */

import notesDocument from './whats-new.json' with { type: 'json' };

export const LOCALES = ['en', 'de-CH'] as const;
export type NoteLocale = (typeof LOCALES)[number];

export const KINDS = ['new', 'improved', 'fixed'] as const;
export type NoteKind = (typeof KINDS)[number];

/**
 * The art an item may carry. The Studio draws each name in `app/src/components/icons/releases.tsx` and the
 * website in `web/src/lib/release-art.ts`; both are held to this list by `test/releases/whats-new.test.mjs`,
 * so add a name here and in both places together.
 */
export const RELEASE_ICONS = [
  'sparkle', 'upgrade', 'bank', 'ledger', 'receipt', 'vat', 'asset', 'agent', 'shield', 'export', 'layout', 'speed',
] as const;
export type ReleaseIcon = (typeof RELEASE_ICONS)[number];

export const UNRELEASED = 'unreleased';
export const ITEMS_MIN = 2;
export const ITEMS_MAX = 4;
export const TITLE_MAX = 40;
export const BODY_MAX = 110;
export const CHANGELOG_URL = 'https://tillbooks.ch/en/changelog/';

export interface LocalisedNote {
  readonly en: string;
  readonly 'de-CH': string;
}

export interface NoteItem {
  readonly kind: NoteKind;
  readonly icon: ReleaseIcon;
  readonly title: LocalisedNote;
  readonly body: LocalisedNote;
  /** A Studio route the item's "Show me" opens, e.g. `/journal`. */
  readonly go?: string;
}

export interface ReleaseNote {
  /** A SemVer version, or `unreleased`. */
  readonly version: string;
  /** `YYYY-MM-DD`; absent on the `unreleased` entry. */
  readonly date?: string;
  readonly items: readonly NoteItem[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GO = /^\/[a-z0-9][a-z0-9/-]{0,63}$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

function compareIdentifiers(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na) return -1; // numeric identifiers have lower precedence than alphanumeric ones
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer 2.0 precedence (-1, 0, 1). `unreleased` is newest. An unparsable value sorts as the oldest, so a
 * typo can never hide a real version behind it.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNRELEASED) return 1;
  if (b === UNRELEASED) return -1;
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (ma === null) return mb === null ? 0 : -1;
  if (mb === null) return 1;
  for (let i = 1; i <= 3; i += 1) {
    const d = Math.sign(Number(ma[i]) - Number(mb[i]));
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1; // a release is newer than its pre-releases
  if (pb === undefined) return -1;
  const ia = pa.split('.');
  const ib = pb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = compareIdentifiers(x, y);
    if (d !== 0) return d;
  }
  return 0;
}

/** One title or body: present, short, no em or en dash, no sharp s in de-CH, plus the field's own rule. */
function checkText(problems: string[], at: string, text: unknown, locale: NoteLocale, max: number, extra: (t: string) => string | null): void {
  if (typeof text !== 'string' || text.trim() === '') {
    problems.push(`${at} is missing`);
    return;
  }
  if (text.length > max) problems.push(`${at} is over ${max} characters (${text.length})`);
  if (/[\u2014\u2013]/.test(text)) problems.push(`${at} has an em or en dash`);
  if (locale === 'de-CH' && text.includes('\u00df')) problems.push(`${at} uses the sharp s (write ss)`);
  const why = extra(text);
  if (why !== null) problems.push(`${at} ${why}`);
}

/**
 * Every problem in a notes document, one sentence each (`[]` = valid). The release check, the test and the
 * website build all call this, so the rules live in one place.
 */
export function validateNotes(doc: unknown): string[] {
  const problems: string[] = [];
  const releases = (doc as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases) || releases.length === 0) return ['whats-new.json has no "releases" array'];
  const seen = new Set<string>();
  releases.forEach((raw: unknown, i: number) => {
    const r = (raw ?? {}) as { version?: unknown; date?: unknown; items?: unknown };
    const at = `releases[${i}]${typeof r.version === 'string' ? ` (${r.version})` : ''}`;
    const version = typeof r.version === 'string' ? r.version : '';
    if (version === UNRELEASED) {
      if (i !== 0) problems.push(`${at}: "unreleased" must be the first entry`);
      if (r.date !== undefined) problems.push(`${at}: the unreleased entry has no date`);
    } else {
      if (!isVersion(version)) problems.push(`${at}: "version" is not a SemVer version or "unreleased"`);
      if (typeof r.date !== 'string' || !DATE.test(r.date) || Number.isNaN(Date.parse(r.date))) problems.push(`${at}: "date" is not YYYY-MM-DD`);
    }
    if (seen.has(version)) problems.push(`${at}: version listed twice`);
    seen.add(version);
    if (i > 0) {
      const prev = (releases[i - 1] as { version?: unknown } | null)?.version;
      if (typeof prev === 'string' && compareVersions(version, prev) >= 0) problems.push(`${at}: not newest first`);
    }
    const items = r.items;
    if (!Array.isArray(items) || items.length < ITEMS_MIN || items.length > ITEMS_MAX) {
      problems.push(`${at}: needs ${ITEMS_MIN} to ${ITEMS_MAX} "items"`);
      return;
    }
    items.forEach((rawItem: unknown, j: number) => {
      const it = (rawItem ?? {}) as { kind?: unknown; icon?: unknown; go?: unknown; title?: Record<string, unknown>; body?: Record<string, unknown> };
      const ia = `${at} items[${j}]`;
      if (!(KINDS as readonly unknown[]).includes(it.kind)) problems.push(`${ia}: "kind" must be one of ${KINDS.join(', ')}`);
      if (!(RELEASE_ICONS as readonly unknown[]).includes(it.icon)) problems.push(`${ia}: "icon" ${JSON.stringify(it.icon)} is not in RELEASE_ICONS`);
      if (it.go !== undefined && (typeof it.go !== 'string' || !GO.test(it.go))) problems.push(`${ia}: "go" must be a Studio route such as /journal`);
      for (const locale of LOCALES) {
        checkText(problems, `${ia}: title.${locale}`, it.title?.[locale], locale, TITLE_MAX, (t) => (/[.!?]$/.test(t) ? 'ends with a period' : null));
        checkText(problems, `${ia}: body.${locale}`, it.body?.[locale], locale, BODY_MAX, (t) => {
          if (!t.endsWith('.')) return 'does not end with a period';
          if (/[.!?]\s+[A-Z\u00c4\u00d6\u00dc]/.test(t)) return 'is more than one sentence';
          return null;
        });
      }
    });
  });
  return problems;
}

/** The releases of a document already validated, as typed entries (newest first). */
export function releasesOf(doc: unknown): ReleaseNote[] {
  const releases = (doc as { releases?: unknown } | null)?.releases;
  return Array.isArray(releases) ? (releases as ReleaseNote[]) : [];
}

/** The notes bundled with this build. */
export const BUNDLED_NOTES: readonly ReleaseNote[] = releasesOf(notesDocument);

/** The notes problems of this build's own file (`[]` when valid). */
export function bundledNotesProblems(): string[] {
  return validateNotes(notesDocument);
}

/** One entry by version, or null. */
export function entryFor(version: string, notes: readonly ReleaseNote[] = BUNDLED_NOTES): ReleaseNote | null {
  return notes.find((r) => r.version === version) ?? null;
}

/** An item with its title and body resolved to one locale (the exact locale, then English). */
export interface ResolvedItem {
  readonly kind: NoteKind;
  readonly icon: ReleaseIcon;
  readonly title: string;
  readonly body: string;
  readonly go: string | null;
}

export function resolveItems(entry: ReleaseNote, locale: string): ResolvedItem[] {
  const pick = (text: LocalisedNote): string => (locale === 'de-CH' || locale.startsWith('de') ? text['de-CH'] : text.en);
  return entry.items.map((it) => ({ kind: it.kind, icon: it.icon, title: pick(it.title), body: pick(it.body), go: it.go ?? null }));
}

/** A short, stable fingerprint of an entry's content (the unreleased entry is told apart by it). */
export function fingerprintOf(entry: ReleaseNote): string {
  // FNV-1a over the canonical JSON: no crypto needed, the fingerprint only tells two contents apart.
  const text = JSON.stringify(entry.items);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
