/**
 * N00, THE BRIEF'S SECTIONS: the closed list, and the one parser of the `hausbuch.brief_sections` setting.
 *
 * A LEAF MODULE ON PURPOSE. The settings verbs (`core/settings/settings.ts`) judge a new value of
 * `hausbuch.brief_sections` with `briefSectionsProblem` before anything is written, and the brief reads the
 * stored value with `parseBriefSections`. Both import this file and it imports nothing, so neither side
 * reaches the other through it.
 *
 * The setting is a comma-separated list because the settings registry has no list schema (D172 holds a
 * value to an integer, a number, a boolean, a string or an enum). Its default names every section, in the
 * order the brief answers them.
 */

/** Every section the brief can carry, in the order it answers them (§H-ENUM, single point). */
export const BRIEF_SECTIONS = ['accounts', 'vatCodes', 'bankAccounts', 'rules', 'notes', 'counts'] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

/** The setting's default: every section. */
export const BRIEF_SECTIONS_DEFAULT = BRIEF_SECTIONS.join(',');

/** The longest stored value: every name once, with commas and room for spaces. */
export const BRIEF_SECTIONS_MAX_LENGTH = 120;

export function isBriefSection(value: unknown): value is BriefSection {
  return typeof value === 'string' && (BRIEF_SECTIONS as readonly string[]).includes(value);
}

function tokensOf(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Why a value cannot be the setting, or null when it can: at least one name, every name a section, none
 * twice. The settings verbs answer the problem as `invalid_setting_value`.
 */
export function briefSectionsProblem(value: unknown): { reason: 'empty' | 'unknown_section' | 'repeated_section'; section?: string } | null {
  if (typeof value !== 'string') return { reason: 'empty' };
  const tokens = tokensOf(value);
  if (tokens.length === 0) return { reason: 'empty' };
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!isBriefSection(t)) return { reason: 'unknown_section', section: t };
    if (seen.has(t)) return { reason: 'repeated_section', section: t };
    seen.add(t);
  }
  return null;
}

/**
 * The sections a stored value names, in the brief's own order. A value that does not parse (a row written
 * by hand, a name a later build retired) reads as every section, so a brief never comes back empty
 * because of a bad setting.
 */
export function parseBriefSections(value: unknown): BriefSection[] {
  if (briefSectionsProblem(value) !== null) return [...BRIEF_SECTIONS];
  const named = new Set(tokensOf(value as string));
  return BRIEF_SECTIONS.filter((s) => named.has(s));
}
