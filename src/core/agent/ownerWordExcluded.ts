/**
 * D209 amendment (owner, 18.11.2026, after an automated security review: TILL cannot verify a quote the agent
 * supplies). THE DIAL FAMILIES THE OWNER'S WORD NEVER APPROVES: three outward, hard-to-undo kinds always wait
 * for a person's click in the Studio. Filing the VAT return (`vat-file`), installing or starting a plugin
 * (`plugin-install`) and data leaving the machine or outside access to it (`share`).
 *
 * D172: the set is one human-only setting, `agent.owner_word_excluded`, a comma-separated list of dial
 * families with these three as the default. A person may shrink it (the owner's word then reaches that kind
 * too) or grow it (any other family waits for the click as well). The setting's reader and its fail-closed
 * rule live in `decisionGrant.ts`; this module holds the pure parts the settings registry and its value rule
 * read too, so neither imports the agent's decision module.
 */

import { DIAL_CAPABILITIES } from './dial.js';

/** The setting that carries the excluded families. */
export const OWNER_WORD_EXCLUDED_SETTING = 'agent.owner_word_excluded';

/** The owner's default (18.11.2026): filing the VAT return, plugins, sharing with someone outside. */
export const OWNER_WORD_EXCLUDED_DEFAULT_FAMILIES: readonly string[] = ['vat-file', 'plugin-install', 'share'];

/** The stored default. */
export const OWNER_WORD_EXCLUDED_DEFAULT = OWNER_WORD_EXCLUDED_DEFAULT_FAMILIES.join(',');

/**
 * The value that names no family (a person decided the owner's word reaches every kind, as D209 first shipped).
 * A word, because the settings verbs refuse an empty required value; an empty string reads the same.
 */
export const OWNER_WORD_EXCLUDED_NONE = 'none';

/** The longest stored value: every family once, with commas and room for spaces. */
export const OWNER_WORD_EXCLUDED_MAX_LENGTH = 200;

function tokensOf(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Why a value cannot be `agent.owner_word_excluded`, or null when it can. `none` (or empty) names no family.
 * Otherwise every name must be a dial family, none twice, and `none` never beside a family.
 */
export function ownerWordExcludedProblem(value: unknown): { reason: 'not_a_list' | 'unknown_family' | 'repeated_family' | 'none_beside_a_family'; family?: string } | null {
  if (typeof value !== 'string') return { reason: 'not_a_list' };
  const tokens = tokensOf(value);
  if (tokens.length === 1 && tokens[0] === OWNER_WORD_EXCLUDED_NONE) return null;
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t === OWNER_WORD_EXCLUDED_NONE) return { reason: 'none_beside_a_family' };
    if (!DIAL_CAPABILITIES.includes(t)) return { reason: 'unknown_family', family: t };
    if (seen.has(t)) return { reason: 'repeated_family', family: t };
    seen.add(t);
  }
  return null;
}

/** The families a value names, or null when it does not parse (the caller fails closed). */
export function parseOwnerWordExcluded(value: unknown): Set<string> | null {
  if (ownerWordExcludedProblem(value) !== null) return null;
  return new Set(tokensOf(value as string).filter((t) => t !== OWNER_WORD_EXCLUDED_NONE));
}
