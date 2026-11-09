/**
 * C4 (D118): the risk tier of a governed write, and the ONE consequence sentence that describes it.
 *
 * THE LADDER, low to high: `read` < `draft` < `post` < `filing`. A read needs no confirmation. A
 * draft is an agent proposal that waits in the Vorschläge queue (asynchronous, never a synchronous
 * modal). The two top tiers, `post` (the money path: post/issue/send/dun/pay, plus the structural
 * `customize` write, since D156 the `share` consent, and since D161 the `stock` writes that move or
 * value stock with no entry) and `filing` (the statutory `vat-file`, the
 * `plugin-install` that runs third-party code and, since D156, the `erase` family that deletes for
 * good), REQUIRE a synchronous human confirmation before the write leaves the surface.
 *
 * The rule this module encodes and a test pins is a floor, never a ceiling: `requiresSyncApproval`
 * is TRUE for every `post` and `filing` verb and can never be weakened to false for one. Blanket
 * confirmation on everything (decision C4-B) trains blind clicking, so a `read` and a `draft` never
 * raise a modal; but the top two tiers always do.
 *
 * THE SENTENCE IS NOT WRITTEN HERE, AND NOT IN ANY STUDIO CATALOGUE (D156). It is the engine's one
 * consequence catalogue (`src/core/agent/consequences.ts`), projected per verb and per dial family into
 * `command-source.generated.json` in both locales with its reversibility, the same entry the MCP tool
 * description and `_meta` carry. Resolution is the engine's: the verb's own entry, else its family's.
 * So a human confirming `post_entry` at the ledger, an approver clearing an agent's drafted
 * `post_entry` on the Vorschlag card and an agent reading `tools/list` read the identical sentence.
 * `test/agent/consequence-parity.test.mjs` holds the projection byte-equal to the engine.
 */
import { useI18n, type Locale } from '../i18n';
import generated from './command-source.generated.json';
import { verbMetaFor } from './command-source';

/** The risk ladder, low to high. */
export type ApprovalTier = 'read' | 'draft' | 'post' | 'filing';

/**
 * The capabilities in the top tier: the statutory filing and foreign code (D103), and since D156 the
 * `erase` family, whose act has no way back at all (a deletion, a merge, an anonymisation).
 */
const FILING_CAPABILITIES: ReadonlySet<string> = new Set(['vat-file', 'plugin-install', 'erase']);

/** The A26 dial capability governing a verb, or null when the verb is not dial-governed. */
export function dialCapabilityForVerb(verb: string): string | null {
  return verbMetaFor(verb)?.dialCapability ?? null;
}

/** The risk tier of a dial capability. A non-governed capability (null) is not a write we tier here. */
export function tierForCapability(capability: string | null): ApprovalTier {
  if (capability === null) return 'read';
  if (FILING_CAPABILITIES.has(capability)) return 'filing';
  return 'post';
}

/** The risk tier of a verb, via its dial capability. */
export function tierForVerb(verb: string): ApprovalTier {
  return tierForCapability(dialCapabilityForVerb(verb));
}

/** True only for the top two tiers: a synchronous human confirmation is required before the write. */
export function requiresSyncApproval(tier: ApprovalTier): boolean {
  return tier === 'post' || tier === 'filing';
}

/** How far a governed write can be undone (D156, `Reversibility` in `consequences.ts`). */
export type Reversibility = 'reversible' | 'correctable' | 'final';

/** One consequence as the engine states it, in both Studio locales. */
export interface Consequence {
  en: string;
  'de-CH': string;
  reversibility: Reversibility;
}

const FAMILY_CONSEQUENCES = generated.consequenceFamilies as Record<string, Consequence>;

/**
 * The engine's consequence for a verb, or null when it carries none (an ungoverned write gets no
 * sentence invented here). `capability` is the dial family a CALL resolved to, for a verb whose family
 * depends on its input (a drafted action's stored tier, a bank booking's target): it is the fallback
 * only, after the verb's own entry, exactly as the engine's `consequenceFor` resolves it.
 */
export function consequenceForVerb(verb: string, capability?: string | null): Consequence | null {
  const own = verbMetaFor(verb)?.consequence ?? null;
  if (own !== null) return own;
  if (typeof capability === 'string' && capability.length > 0) return FAMILY_CONSEQUENCES[capability] ?? null;
  return null;
}

/** The consequence sentence for a verb in one locale, or null when the verb carries none. */
export function consequenceSentence(verb: string, locale: Locale, capability?: string | null): string | null {
  return consequenceForVerb(verb, capability)?.[locale] ?? null;
}

/** The consequence sentence for a verb in the active locale (the hook every surface renders through). */
export function useConsequence(verb: string, capability?: string | null): string | null {
  const { locale } = useI18n();
  return consequenceSentence(verb, locale, capability);
}
