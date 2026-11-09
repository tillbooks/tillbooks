/**
 * G19, the EXTRACTION GUIDE registry: the first mile of a migration as PRODUCT DATA.
 *
 * A guide is shipped data read by the verbs, never a branch in code (the G10 locale-pack precedent,
 * spec §4). One module per source system exports an `ExtractionGuide`; `generic` and `bexio` ship
 * first. The registry (`registry.ts`) is the single source, and a test walks it: every item names a
 * valid tactic-ladder rung and at least one data class or `statutory:true`, and the guides contain
 * no vendor UI copy or trade dress, only functional menu-path facts recorded from published help
 * docs and the owner's own account, each guide carrying a `cleanRoomSource` URL list.
 *
 * THE TACTIC LADDER (US-G19.2) IS LAW, encoded as the `rung` on every item, each rung preferred over
 * the next:
 *   1. Native exports, or an API call the USER makes of their own account outside TILL. Always first.
 *   2. Report-based extraction (report screens exported where no direct export exists).
 *   3. User-driven browser automation of the customer's OWN logged-in session. Companion territory.
 *   4. Paginated-capture browser extension (the lowest-tooling rung of rung 3).
 *   5. The formal Datenherausgabe request (a shipped letter template).
 * Rungs 3 and 4 are companion-package work, gated per §3 (owner + per-source attorney + UX review);
 * until a source's gates clear the guide renders those items as "vorgesehen, noch nicht verfügbar".
 */

import { DATA_CLASS_IDS } from '../dataClasses.js';

/** The five rungs of the extraction tactic ladder (US-G19.2). Single source, `RUNGS` below. */
export const RUNGS = [1, 2, 3, 4, 5] as const;
export type Rung = (typeof RUNGS)[number];

/** A rung is companion-package territory (browser automation) and therefore gated per §3. */
export function rungIsCompanionGated(rung: Rung): boolean {
  return rung === 3 || rung === 4;
}

/** One export item on a guide: what to get out, where it lives, how, and what it feeds. */
export interface GuideItem {
  /** Stable id, unique within a guide. The manifest instantiates one item per guide item. */
  readonly id: string;
  /** What the artifact is, in plain language (the checklist row's primary label). */
  readonly what: string;
  /** The source area (menu path) as functionally observed or published. A FACT, never vendor copy. */
  readonly sourceArea: string;
  /** The expected export format(s), e.g. `['CSV', 'PDF']`. */
  readonly formats: readonly string[];
  /** The G09 data classes this item feeds (every id valid against DATA_CLASS_IDS). */
  readonly dataClasses: readonly string[];
  /** The tactic-ladder rung that gets it out (US-G19.2). */
  readonly rung: Rung;
  /** Quirks and cautions ("prefer CSV and the original PDF for filings", "no bulk Beleg export"). */
  readonly quirks: readonly string[];
  /** True when the item is a statutory artefact that MUST survive (OR 958f, GeBüV, MWSTG). */
  readonly statutory: boolean;
  /** Set when the item is a module-confirmation question rather than a plain export (US-G19.1). */
  readonly moduleQuestion?: string;
}

/**
 * The post-termination deletion clock a source carries as a CONTRACT FACT (US-G19.3). Defaulted from
 * the guide's published figure but always verified against the operator's own live terms, never
 * asserted as law. `null` when the source publishes no such clock.
 */
export interface DeletionClock {
  /** Days after `trigger` the source's access to the data ends (bexio: 30). */
  readonly days: number;
  /** What starts the clock (bexio: subscription end). */
  readonly trigger: string;
  /** What the operator must verify the figure against (their own contract / the live AGB). */
  readonly verifyAgainst: string;
}

/** One localised rendering of the Datenherausgabe letter (US-G19.5). */
export interface LetterLocale {
  readonly subject: string;
  /** The body paragraphs, in order. Placeholders `{company}`, `{address}`, `{source}` are filled by the caller. */
  readonly body: readonly string[];
  /**
   * The honest-limits paragraph (OP6 legal-claims rule): revDSG Art. 28 covers Personendaten the
   * requester provided about themselves, so the Artikel is a lever for the personal-data slice, not
   * a complete right to the books; the letter also grounds on the contract and OR 958f. ASSERTED
   * PRESENT by a test, so an overclaim can never ship by edit (spec §7).
   */
  readonly limitsParagraph: string;
}

/** The Datenherausgabe letter template, de-CH first plus fr/it/en (US-G19.5). Shipped data. */
export interface LetterTemplate {
  readonly 'de-CH': LetterLocale;
  readonly fr: LetterLocale;
  readonly it: LetterLocale;
  readonly en: LetterLocale;
}

/** One source system's extraction guide. Data read by the verbs, never a branch (spec §4). */
export interface ExtractionGuide {
  /** The stable source-system id used on the wire (`generic`, `bexio`). */
  readonly sourceSystem: string;
  /** What the catalog read shows a human. */
  readonly label: string;
  /** The export items, in checklist order. */
  readonly items: readonly GuideItem[];
  /** The post-termination deletion clock, or `null` when the source publishes none. */
  readonly deletionClock: DeletionClock | null;
  /** The Datenherausgabe letter template offered by the rung-5 item. */
  readonly letterTemplate: LetterTemplate;
  /**
   * True ONLY when a `@tillbooks/extract-<source>` companion has cleared its three gates (§3) and the
   * clearance is recorded here with a `DECISIONS.md` reference. A test refuses `true` without one, so
   * the core can never claim a companion exists before its gates clear (spec §7). Absent means false.
   */
  readonly companionGateClearedRef?: string;
  /** The published-documentation URLs this guide's facts were recorded from (clean-room discipline). */
  readonly cleanRoomSource: readonly string[];
}

/** A guide item names a valid rung and at least one valid data class OR is statutory (spec §7). */
export function guideItemIsWellFormed(item: GuideItem): boolean {
  if (!RUNGS.includes(item.rung)) return false;
  const classesValid = item.dataClasses.every((c) => DATA_CLASS_IDS.includes(c));
  if (!classesValid) return false;
  return item.dataClasses.length > 0 || item.statutory;
}

/** Whether a guide has a companion whose gates are recorded as cleared (drives `hasCompanion`). */
export function guideHasCompanion(guide: ExtractionGuide): boolean {
  return typeof guide.companionGateClearedRef === 'string' && guide.companionGateClearedRef.length > 0;
}
