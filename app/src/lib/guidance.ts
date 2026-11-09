/**
 * G17's Studio-side access to the Begriffe corpus and the era-scoped Saldo eligibility limits.
 *
 * The data is `guidance-corpus.generated.json`, a projection of the engine's build-time constant
 * (`src/core/guidance/corpus.ts`) produced by `npm run generate:guidance` and held true by
 * `test/guidance/studio-corpus-drift.test.mjs`: the browser build has no path into engine sources,
 * and a hand-copied corpus would drift, which for statutory copy is the defect G17 exists to
 * prevent. Matching is local and synchronous, so the palette's Begriffe group works with the
 * engine down: a concept is the one thing in the palette that needs no call at all.
 *
 * NOTHING HERE WRITES. No fetch, no localStorage, no state: the corpus is a constant and the
 * panel's open state belongs to the component that renders it (design §7b).
 */
import type { Locale, Messages } from '../i18n';
import { CATALOG } from '../i18n';
import generated from './guidance-corpus.generated.json';

export interface ConceptEra {
  effectiveFrom: string;
  source: string;
}

export interface ConceptEntry {
  key: string;
  area: string;
  term: Record<Locale, string>;
  body: Record<Locale, string>;
  articles: readonly string[];
  seeAlso: readonly string[];
  docsPath?: string;
  era?: ConceptEra;
  notImplemented?: boolean;
}

export interface SaldoEligibilityEra {
  effectiveFrom: string;
  turnoverLimitMinor: number;
  taxDueLimitMinor: number;
  source: string;
}

export const CONCEPTS: readonly ConceptEntry[] = (generated as { concepts: ConceptEntry[] }).concepts;

export const SALDO_ELIGIBILITY_ERAS: readonly SaldoEligibilityEra[] = (
  generated as { saldoEligibilityEras: SaldoEligibilityEra[] }
).saldoEligibilityEras;

/** The Art. 37 Abs. 1 limits in force on an ISO day, or null before the earliest verified era. */
export function saldoEligibilityOn(isoDay: string): SaldoEligibilityEra | null {
  let found: SaldoEligibilityEra | null = null;
  for (const era of SALDO_ELIGIBILITY_ERAS) {
    if (era.effectiveFrom <= isoDay) found = era;
    else break;
  }
  return found;
}

/** Resolve one entry, or undefined. A surface naming an unknown key is a BUILD failure, not a runtime state. */
export function conceptByKey(key: string): ConceptEntry | undefined {
  return CONCEPTS.find((c) => c.key === key);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9äöüéèàç]+/)
    .filter((t) => t.length > 0);
}

/**
 * Per-token matching, mirroring the engine's `conceptMatchScore` (design §3d): ANY query token of
 * two or more characters that prefixes or is contained in a token of the key or either term
 * matches, so "soll ich saldo wählen" still surfaces the `saldosteuersatz` row.
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

/** Rank the corpus against a query: highest score first, ties by key, zero-score rows absent. */
export function matchConcepts(query: string): ConceptEntry[] {
  return CONCEPTS.map((c) => ({ c, score: conceptMatchScore(query, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.key.localeCompare(b.c.key))
    .map((x) => x.c);
}

// ---------------------------------------------------------------------------------------------
// The A35 handoff seam (design row 5.2). A35 is not built; until its dock registers a provider
// here, the concept panel emits NO handoff DOM at all: no placeholder, no "coming soon". The
// handoff itself sends nothing: A35's provider receives a drafted, UNSENT question the user edits.
// ---------------------------------------------------------------------------------------------

export interface AgentHandoffProvider {
  /** The control's visible label (A35 owns the wording, in its own catalogue). */
  label: string;
  /** Open the dock with a drafted, unsent question about this concept. Sends nothing. */
  openWithDraft(args: { conceptKey: string; term: string }): void;
}

let agentHandoff: AgentHandoffProvider | null = null;

/** Registered by A35's dock when it mounts. G17 never registers anything itself. */
export function registerAgentHandoffProvider(provider: AgentHandoffProvider | null): void {
  agentHandoff = provider;
}

export function agentHandoffProvider(): AgentHandoffProvider | null {
  return agentHandoff;
}

/** The public documentation site a `docsPath` resolves onto. The one outward link guidance renders. */
export const DOCS_BASE_URL = 'https://docs.tillbooks.ch/';

export function docsUrl(docsPath: string): string {
  return `${DOCS_BASE_URL}${docsPath}`;
}

// ---------------------------------------------------------------------------------------------
// Surface help entries (the help-entry SHAPE, spec §6): read from the surface's own catalogue.
// ---------------------------------------------------------------------------------------------

/** One binding election a surface declares, so the consequence-line gate has something to enumerate. */
export interface BindingElectionDecl {
  id: string;
  /** The consequence-line message key of every option in the election. */
  options: readonly string[];
  /** The fieldset-level binding-facts message key. */
  bindingFacts?: string;
}

export interface SurfaceHelpEntry {
  title: string;
  body: string;
  concepts: readonly string[];
  docsPath?: string;
  bindingElections?: readonly BindingElectionDecl[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a surface's help entry (`help.<SurfaceDir>`) out of the merged catalogue for a locale.
 * Returns null when the surface has authored none, in which case the caller renders NO glyph at
 * all (G16's absence rule applied to copy): the corpus fills in without shipping empty panels.
 */
export function surfaceHelp(locale: Locale, surfaceDir: string): SurfaceHelpEntry | null {
  const tree: Messages = CATALOG[locale];
  const help = tree.help;
  if (!isRecord(help)) return null;
  const entry = help[surfaceDir];
  if (!isRecord(entry)) return null;
  const { title, body } = entry;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  const concepts = Array.isArray(entry.concepts)
    ? (entry.concepts as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];
  const result: SurfaceHelpEntry = { title, body, concepts };
  if (typeof entry.docsPath === 'string') result.docsPath = entry.docsPath;
  if (Array.isArray(entry.bindingElections)) {
    result.bindingElections = (entry.bindingElections as unknown[]).filter(isRecord).map((e) => {
      const decl: BindingElectionDecl = {
        id: String(e.id ?? ''),
        options: Array.isArray(e.options)
          ? (e.options as unknown[]).filter((k): k is string => typeof k === 'string')
          : [],
      };
      if (typeof e.bindingFacts === 'string') decl.bindingFacts = e.bindingFacts;
      return decl;
    });
  }
  return result;
}
