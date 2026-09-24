/**
 * C4 (D118): the risk tier of a governed write, and the ONE consequence sentence that describes it.
 *
 * THE LADDER, low to high: `read` < `draft` < `post` < `filing`. A read needs no confirmation. A
 * draft is an agent proposal that waits in the Vorschläge queue (asynchronous, never a synchronous
 * modal). The two top tiers, `post` (the money path: post/issue/send/dun/pay, plus the structural
 * `customize` write) and `filing` (the statutory `vat-file` and the `plugin-install` that runs
 * third-party code), REQUIRE a synchronous human confirmation before the write leaves the surface.
 *
 * The rule this module encodes and a test pins is a floor, never a ceiling: `requiresSyncApproval`
 * is TRUE for every `post` and `filing` verb and can never be weakened to false for one. Blanket
 * confirmation on everything (decision C4-B) trains blind clicking, so a `read` and a `draft` never
 * raise a modal; but the top two tiers always do.
 *
 * THE SENTENCE IS NOT WRITTEN HERE. It is the same `agent.consequence.<capability>` string the
 * Vorschlag card shows the agent's proposal under, resolved through the shared i18n catalogue, so a
 * human confirming `post_entry` at the ledger and an approver clearing an agent's drafted
 * `post_entry` read the identical sentence. The verb-to-capability mapping is the drift-tested
 * projection of `dialMap.ts` (`command-source.generated.json`), so this file invents no mapping and
 * cannot fall behind the engine.
 */
import { verbMetaFor } from './command-source';

/** The risk ladder, low to high. */
export type ApprovalTier = 'read' | 'draft' | 'post' | 'filing';

/** The two capabilities whose consequence is statutory or runs foreign code: the top tier (D103). */
const FILING_CAPABILITIES: ReadonlySet<string> = new Set(['vat-file', 'plugin-install']);

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

/**
 * The i18n key of the shared consequence sentence for a verb, or null when the verb is not
 * dial-governed (no sentence to render). The key resolves against the merged catalogue, where the
 * Agent surface authors `agent.consequence.*` in both locales.
 */
export function consequenceKeyForVerb(verb: string): string | null {
  const capability = dialCapabilityForVerb(verb);
  return capability === null ? null : `agent.consequence.${capability}`;
}
