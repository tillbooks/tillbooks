/**
 * The LOCALE PACK REGISTRY (G10 §4): what makes "Swiss is a pack" a structure, not a slogan.
 *
 * A pack declares the target chart seed, the target tax-code set, the parse conventions and the
 * statutory anchors for ONE locale, and the resolver in `maps.ts` reads the pack as DATA. Nothing
 * in this file, and nothing anywhere under `src/core/migration/` outside `locale/ch/`, may name a
 * KMU account number or an MWST code: that is the locale fence (spec §7), asserted by
 * `test/migration/locale-fence.test.mjs`, and it is the whole difference between a second locale
 * being a pack and being a rewrite.
 *
 * `ch` ALWAYS SHIPS (spec §2 US-G10.4: the empty state is unreachable, decided rather than
 * discovered). A plugin may register a further pack (OP9) by appending a row here through its own
 * registration seam when G02 lands; the shape is already the whole contract.
 */

/** A source-header synonym: a header string a locale conventionally uses for a target field. */
export interface HeaderSynonym {
  /** The normalized source header (lowercase, alphanumerics only, see `normalizeToken`). */
  readonly header: string;
  /** The neutral target field id (`date`, `description`, `amount`, `debit`, `credit`, ...). */
  readonly field: string;
}

/** A chart suggestion: a normalized source account label and the target account NUMBER it maps to. */
export interface ChartSynonym {
  readonly label: string;
  readonly targetNumber: string;
}

/** A tax suggestion: a source rate in basis points and the target code governing from a date. */
export interface TaxRateSuggestion {
  readonly rateBp: number;
  readonly targetCode: string;
  /** ISO date the target code's era begins; the suggested `validFrom` of the mapping window. */
  readonly validFrom: string;
}

/** One locale pack. Data read by the resolver, never a branch inside it (spec §4). */
export interface LocalePack {
  /** The stable id used on the wire (`ch`). */
  readonly id: string;
  /** What the catalog read shows a human. */
  readonly label: string;
  /** The A01 chart seed this pack maps onto, by seed id, and its account numbers. */
  readonly targetChartSeed: { readonly id: string; readonly accountNumbers: readonly string[] };
  /** The A05 tax codes this pack maps onto. Codes only: rates stay A05's (P6). */
  readonly taxCodeSet: readonly string[];
  /** Date order, separators and negative-number shape a source from this locale conventionally uses. */
  readonly parseConventions: {
    readonly dateOrder: 'dmy' | 'mdy' | 'ymd';
    readonly decimalSeparator: string;
    readonly groupingSeparator: string;
    readonly negativeShape: 'leading_minus' | 'parentheses';
  };
  /** The statutes the pack's structure derives from, for the catalog read. */
  readonly statutoryAnchors: readonly string[];
  /** Column-header synonyms for the suggestion path. */
  readonly headerSynonyms: readonly HeaderSynonym[];
  /** Account-label synonyms for the chart-map suggestion path. */
  readonly chartSynonyms: readonly ChartSynonym[];
  /** Rate-to-code suggestions for the tax-map suggestion path. */
  readonly taxRateSuggestions: readonly TaxRateSuggestion[];
}

/**
 * Normalize a header or label for matching: lowercase, alphanumerics only. Deliberately shared by
 * the packs and the resolver so both sides of a comparison went through the same door.
 */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9äöüéèàç]/g, '');
}

import { CH_LOCALE_PACK } from './ch/index.js';

/** The registry. `ch` first, always shipped; a later pack is appended as data. */
export const LOCALE_PACKS: readonly LocalePack[] = [CH_LOCALE_PACK];

const BY_ID: ReadonlyMap<string, LocalePack> = new Map(LOCALE_PACKS.map((p) => [p.id, p]));

/** The shipped default pack a plan resolves through until it names one. */
export const DEFAULT_LOCALE_PACK_ID = CH_LOCALE_PACK.id;

/** The registry row for a pack id, or undefined when it is not registered. */
export function localePackDef(id: unknown): LocalePack | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** Every registered pack id, for a validation message that names them. */
export const LOCALE_PACK_IDS: readonly string[] = LOCALE_PACKS.map((p) => p.id);
