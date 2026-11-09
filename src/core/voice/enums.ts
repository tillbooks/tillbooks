/**
 * E05's two §H-ENUM points, single-sourced here so no verb, registry, or surface redeclares them.
 *
 * `VOICE_SOURCE_KINDS` is the closed set of places an exemplar can come from: the practitioner's
 * own sent mail (via E04's index, the corpus this cluster exists for) and an E00 document they
 * explicitly picked. There is deliberately no `url`, no `paste`, no free-text source of any kind:
 * an exemplar is a LOCATOR into material that already lives on this machine, and anything that
 * would need a socket or a copied excerpt is out of scope permanently (OP6, spec §3).
 *
 * `RUNTIME_SOURCES` is how a model selection was made: `catalog` (a row of the shipped manifest,
 * validated against the RAM floor) or `byo` (a local `.gguf` path behind Erweitert, unsupported
 * and carrying no quality claim, spec US-E05.5 Boundary).
 */

export const VOICE_SOURCE_KINDS = ['sent_mail', 'document'] as const;
export type VoiceSourceKind = (typeof VOICE_SOURCE_KINDS)[number];

export function isVoiceSourceKind(value: unknown): value is VoiceSourceKind {
  return typeof value === 'string' && (VOICE_SOURCE_KINDS as readonly string[]).includes(value);
}

export const RUNTIME_SOURCES = ['catalog', 'byo'] as const;
export type RuntimeSource = (typeof RUNTIME_SOURCES)[number];

export function isRuntimeSource(value: unknown): value is RuntimeSource {
  return typeof value === 'string' && (RUNTIME_SOURCES as readonly string[]).includes(value);
}

/**
 * D144, the "System One" question types `decide()` answers (E05 §10.1): `noul` is a yes-or-no
 * question answered by one probability of yes, `choice` picks one of 2 to `maxChoices` options,
 * `score` places the state on 2 to `maxChoices` ordered levels. Single-sourced here; the manifest
 * validation and the core door both read it.
 */
export const DECIDE_QUESTION_TYPES = ['noul', 'choice', 'score'] as const;
export type DecideQuestionType = (typeof DECIDE_QUESTION_TYPES)[number];

export function isDecideQuestionType(value: unknown): value is DecideQuestionType {
  return typeof value === 'string' && (DECIDE_QUESTION_TYPES as readonly string[]).includes(value);
}
