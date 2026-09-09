/**
 * The EXTRACTION GUIDE registry (G19 §4): one module per source system, `generic` and `bexio` first.
 *
 * The guides are shipped DATA read by the verbs (`manifest.ts`), never a branch in code (the G10
 * locale-pack precedent). This file is the single source: `EXTRACTION_GUIDES` is append-only, a test
 * walks it, and the lookup falls back to the generic guide so "no guide" is unreachable (US-G19.1).
 *
 * A LOAD-TIME GUARD refuses a malformed guide the way A24's entity-kind registry refuses an unmapped
 * read domain: an item that names an invalid rung or an unknown data class, or a
 * `companionGateClearedRef` that is not a `DECISIONS.md` reference, makes this module fail to load,
 * so a broken seed cannot ship silently (spec §7).
 */

import type { ExtractionGuide, GuideItem } from './types.js';
import { guideItemIsWellFormed, guideHasCompanion } from './types.js';
import { GENERIC_GUIDE } from './generic.js';
import { BEXIO_GUIDE } from './bexio.js';

/** The stable id of the generic fallback guide. */
export const GENERIC_GUIDE_ID = 'generic';

/** The registry. `generic` first (the fallback), then vendor guides. Append-only. */
export const EXTRACTION_GUIDES: readonly ExtractionGuide[] = [GENERIC_GUIDE, BEXIO_GUIDE];

const BY_ID: ReadonlyMap<string, ExtractionGuide> = new Map(EXTRACTION_GUIDES.map((g) => [g.sourceSystem, g]));

/**
 * A `companionGateClearedRef`, when present, must reference DECISIONS.md: the flag is the ENTIRE
 * evidence that a companion cleared its three gates, so it can never be a bare boolean (spec §7).
 */
function companionRefIsValid(guide: ExtractionGuide): boolean {
  if (guide.companionGateClearedRef === undefined) return true;
  return /DECISIONS\.md/.test(guide.companionGateClearedRef);
}

/**
 * Refuse a malformed seed at load, the A24 `assertEveryEntityKindHasAReadDomain` shape: a guide that
 * would ship a bad rung, an unknown data class, or an unbacked companion claim is a crash here, not a
 * quiet defect discovered in production.
 */
function assertGuidesWellFormed(): void {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  for (const guide of EXTRACTION_GUIDES) {
    if (seenIds.has(guide.sourceSystem)) problems.push(`duplicate guide id ${guide.sourceSystem}`);
    seenIds.add(guide.sourceSystem);
    if (!companionRefIsValid(guide)) {
      problems.push(`${guide.sourceSystem}: companionGateClearedRef must reference DECISIONS.md`);
    }
    const itemIds = new Set<string>();
    for (const item of guide.items) {
      if (itemIds.has(item.id)) problems.push(`${guide.sourceSystem}: duplicate item id ${item.id}`);
      itemIds.add(item.id);
      if (!guideItemIsWellFormed(item)) {
        problems.push(`${guide.sourceSystem}/${item.id}: needs a valid rung and one valid data class or statutory:true`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Extraction guide registry is malformed:\n  ${problems.join('\n  ')}`);
  }
}

assertGuidesWellFormed();

/** The registry row for a source system, or undefined when it is not registered. */
export function extractionGuideDef(sourceSystem: unknown): ExtractionGuide | undefined {
  return typeof sourceSystem === 'string' ? BY_ID.get(sourceSystem) : undefined;
}

/** The generic fallback guide, always registered (US-G19.1 empty state is unreachable). */
export function genericGuide(): ExtractionGuide {
  return GENERIC_GUIDE;
}

/**
 * Resolve a guide for a source system, falling back to the generic guide when none is registered
 * (US-G19.1). `fellBack` is true when the fallback was used, so the caller can say so without a
 * second lookup. A strict-match caller reads `def` directly.
 */
export function resolveGuide(sourceSystem: unknown): { guide: ExtractionGuide; fellBack: boolean } {
  const def = extractionGuideDef(sourceSystem);
  if (def !== undefined) return { guide: def, fellBack: false };
  return { guide: GENERIC_GUIDE, fellBack: true };
}

/** Every registered source-system id, for a validation message that names them. */
export const EXTRACTION_GUIDE_IDS: readonly string[] = EXTRACTION_GUIDES.map((g) => g.sourceSystem);

/** Whether a guide has a companion whose gates are recorded as cleared (drives `hasCompanion`). */
export { guideHasCompanion };
export type { ExtractionGuide, GuideItem };
