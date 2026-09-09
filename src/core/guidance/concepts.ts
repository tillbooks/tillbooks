/**
 * G17's two read verbs over the corpus: `listConcepts` and `getConcept`.
 *
 * Both are pure functions of their input and the build-time corpus: no store, no clock, no tenant.
 * They deliberately take NO WorkspaceContext (see `../../api/guidance-actions.ts` for the boundary
 * declaration): §H-TENANT protects tenant data and the corpus is identical in every workspace on
 * the planet, so a tenant scope would imply the one property that must never exist for the
 * explanation of a statutory election, namely that it could differ per workspace.
 *
 * `getConcept` NEVER synthesises a body. An unknown key is a structured `not_found` naming the
 * nearest keys, so an agent that guessed a key can correct itself from the payload instead of
 * improvising a definition (design rows 7.2/7.3).
 */

import { ok, err, type Result } from '../result.js';
import {
  CONCEPTS,
  CONCEPT_KEYS,
  conceptByKey,
  type ConceptEntry,
  type GuidanceLocale,
} from './corpus.js';

const DEFAULT_LOCALE: GuidanceLocale = 'de-CH';

function narrowLocale(locale: unknown): GuidanceLocale | null {
  if (locale === undefined || locale === null) return DEFAULT_LOCALE;
  return locale === 'de-CH' || locale === 'en' ? locale : null;
}

/** Tokenize a query or key the way the palette does: lowercase, split on non-word runs. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9äöüéèàç]+/)
    .filter((t) => t.length > 0);
}

/**
 * Per-token matching (design §3d): a concept matches when ANY query token of at least two
 * characters prefixes or is contained in a token of the key or either term. That is what lets a
 * question-shaped query ("soll ich saldo wählen") still surface the `saldosteuersatz` row through
 * its `saldo` token, instead of demanding the reader phrase a lookup like a lookup.
 */
export function conceptMatchScore(query: string, entry: ConceptEntry): number {
  const haystack = [...tokens(entry.key), ...tokens(entry.term['de-CH']), ...tokens(entry.term.en)];
  const wanted = tokens(query).filter((w) => w.length >= 2);
  let score = 0;
  for (const w of wanted) {
    if (haystack.some((h) => h === w)) score += 3;
    else if (haystack.some((h) => h.startsWith(w))) score += 2;
    else if (haystack.some((h) => h.includes(w))) score += 1;
  }
  return score;
}

/** True when the query matches the entry at all. See `conceptMatchScore`. */
export function matchesConcept(query: string, entry: ConceptEntry): boolean {
  return conceptMatchScore(query, entry) > 0;
}

/** Rank the corpus keys by how much they share with `key`, for the `not_found` payload. */
function nearestKeys(key: string, limit: number): string[] {
  const wanted = tokens(key);
  const scored = CONCEPTS.map((c) => {
    const hay = [...tokens(c.key), ...tokens(c.term['de-CH']), ...tokens(c.term.en)];
    let score = 0;
    for (const w of wanted) {
      if (hay.some((h) => h === w)) score += 3;
      else if (hay.some((h) => h.startsWith(w) || w.startsWith(h))) score += 2;
      else if (hay.some((h) => h.includes(w) || w.includes(h))) score += 1;
    }
    return { key: c.key, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const ranked = (hits.length > 0 ? hits : scored.sort((a, b) => a.key.localeCompare(b.key))).slice(0, limit);
  return ranked.map((s) => s.key);
}

/** The localized wire shape of one entry. `seeAlso` resolves to `{key, term}` so a client renders it without a second call. */
function project(entry: ConceptEntry, locale: GuidanceLocale) {
  return {
    key: entry.key,
    area: entry.area,
    term: entry.term[locale],
    body: entry.body[locale],
    articles: [...entry.articles],
    seeAlso: entry.seeAlso.map((k) => {
      const target = conceptByKey(k);
      return { key: k, term: target === undefined ? k : target.term[locale] };
    }),
    docsPath: entry.docsPath ?? null,
    era: entry.era ?? null,
    notImplemented: entry.notImplemented === true,
  };
}

export interface ListConceptsInput {
  area?: unknown;
  query?: unknown;
  locale?: unknown;
}

/** List (optionally filtered) concepts: key, localized term and area. Never the bodies: a list row is a name. */
export function listConcepts(input?: ListConceptsInput): Result {
  const locale = narrowLocale(input?.locale);
  if (locale === null) return err('invalid_locale', { locale: input?.locale, supported: ['de-CH', 'en'] });
  const area = input?.area;
  if (area !== undefined && area !== 'mwst' && area !== 'steuern') {
    return err('invalid_area', { area, supported: ['mwst', 'steuern'] });
  }
  const query = typeof input?.query === 'string' && input.query.trim() !== '' ? input.query : undefined;
  const inArea = CONCEPTS.filter((c) => area === undefined || c.area === area);
  const ranked =
    query === undefined
      ? inArea.map((c) => ({ c, score: 0 }))
      : inArea
          .map((c) => ({ c, score: conceptMatchScore(query, c) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.c.key.localeCompare(b.c.key));
  const concepts = ranked.map(({ c }) => ({ key: c.key, area: c.area, term: c.term[locale] }));
  return ok({ concepts, locale, total: concepts.length });
}

export interface GetConceptInput {
  key?: unknown;
  locale?: unknown;
}

/** One concept, in one locale. Unknown key: structured `not_found` with the nearest keys, never a generated body. */
export function getConcept(input?: GetConceptInput): Result {
  const locale = narrowLocale(input?.locale);
  if (locale === null) return err('invalid_locale', { locale: input?.locale, supported: ['de-CH', 'en'] });
  const key = input?.key;
  if (typeof key !== 'string' || key.trim() === '') {
    return err('invalid_input', { field: 'key', expected: 'a corpus key', known: [...CONCEPT_KEYS] });
  }
  const entry = conceptByKey(key);
  if (entry === undefined) {
    return err('not_found', {
      key,
      nearest: nearestKeys(key, 3),
      reason: 'No corpus entry carries this key. The corpus is authored: nothing is generated for unknown keys.',
    });
  }
  return ok({ concept: project(entry, locale), locale });
}
