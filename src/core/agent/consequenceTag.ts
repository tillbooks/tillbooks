/**
 * D160/D161: WHAT A WRITE TOUCHES, the consequence tag every write declares beside its reversibility class.
 *
 * D160 moved the approval boundary from the reversibility class to the consequence: a write waits for the
 * person by default when it touches the books or money, a statutory record, data leaving TILL, access or
 * third-party code, or permanently deletes business data. Every other write is exempt, and only for one of
 * a CLOSED list of reasons. Both lists are closed unions here: a new tag is a reviewed change to this
 * file, never a free string at a call site.
 *
 * The tag rides on the verb's registration kind (`write:<class>:<tag>`, `src/api/actionKind.ts`), so a write
 * that names no tag does not compile and a malformed one throws at load (`splitActionKind`).
 *
 * Pure data: core never imports the registry, and nothing here imports anything.
 */

/** D160.1 (a) to (e): a write carrying one of these waits for the person by default. */
export const GATED_CONSEQUENCE_TAGS = ['books', 'statutory', 'outbound', 'access', 'erase'] as const;

/**
 * D160.2: the closed list of reasons a write may run without the person, one word each:
 *   - `internal`: an internal working record (task, note, comment, draft, view, checklist step);
 *   - `ui-state`: the person's own UI state;
 *   - `derived`: regenerable or derived output;
 *   - `pre-workspace`: runs before any books exist;
 *   - `stop`: a stop button;
 *   - `human-only`: the engine already refuses the agent seat.
 */
export const EXEMPT_CONSEQUENCE_TAGS = ['internal', 'ui-state', 'derived', 'pre-workspace', 'stop', 'human-only'] as const;

/** A tag that puts a write behind the person's OK by default (D160.1). */
export type GatedConsequenceTag = (typeof GATED_CONSEQUENCE_TAGS)[number];

/** An exemption reason (D160.2). Closed: there is no other way to be exempt. */
export type ExemptConsequenceTag = (typeof EXEMPT_CONSEQUENCE_TAGS)[number];

/** What a write touches: exactly one gated tag or one exemption reason. */
export type ConsequenceTag = GatedConsequenceTag | ExemptConsequenceTag;

/** Every tag, gated first. */
export const CONSEQUENCE_TAGS: readonly ConsequenceTag[] = [...GATED_CONSEQUENCE_TAGS, ...EXEMPT_CONSEQUENCE_TAGS];

/** True for a tag that D160.1 gates by default. */
export function isGatedConsequenceTag(tag: ConsequenceTag): tag is GatedConsequenceTag {
  return (GATED_CONSEQUENCE_TAGS as readonly string[]).includes(tag);
}
