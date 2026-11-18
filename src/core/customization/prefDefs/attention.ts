/**
 * The PENDENZEN area: how the attention hub opens for one person.
 *
 * D201 point 4 (owner, 15.11.2026, pick A): Pendenzen is ONE list with filters, so the D178 cut into sections
 * (`attention.grouping`, by area or by kind) is gone with the sections it chose between. What a person keeps
 * is the last filter they used: the kinds (Vorschläge, Erledigen, Hinweise; none chosen is every kind), the
 * area and who it comes from (the agent or TILL). The default is everything (`all`). It is `person` scope: a
 * Treuhänder who switches mandates keeps the view they chose. The engine reads it nowhere: the Studio filters
 * the one `attention_list` answer it already holds, and an agent reading Pendenzen asks for what it wants.
 *
 * The value is one small object, never a list of rows: `{ kinds: string[], area: string, actor: string }`,
 * where `area` and `actor` are `all` or one key. A stored value the Studio cannot read falls back to the
 * default there; nothing here guesses.
 */

import type { PrefArea, PrefDef } from './types.js';

const ATTENTION: PrefArea = { id: 'attention', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } };

/** The filter a person sees before choosing any: every kind, every area, from anyone. */
export const ATTENTION_FILTERS_DEFAULT = { kinds: [], area: 'all', actor: 'all' } as const;

export const ATTENTION_PREFS: readonly PrefDef[] = [
  {
    key: 'attention.filters',
    schema: { type: 'json', root: 'object', maxBytes: 512 },
    default: ATTENTION_FILTERS_DEFAULT,
    scope: 'person',
    area: ATTENTION,
    label: { en: 'Pendenzen filter', 'de-CH': 'Filter der Pendenzen' },
    description: {
      en: 'The kinds, area and sender Pendenzen last showed you. By default it shows everything.',
      'de-CH': 'Die Arten, der Bereich und der Absender, die dir die Pendenzen zuletzt gezeigt haben. Standard ist alles.',
    },
  },
];
