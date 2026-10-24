/**
 * D178 point 11, the PENDENZEN area: how the attention hub is cut for one person.
 *
 * The owner picked "by area, Bank first" (the default) and asked that the alternative ship as a setting
 * (D178: every option presented is a setting). `by_kind` cuts the same rows into Genehmigen, Erledigen and
 * Hinweise. It is `person` scope: a Treuhänder who switches mandates keeps the cut they chose. The engine
 * honours it nowhere by itself: the Studio passes it to `attention_list { grouping }`, so an agent reading
 * Pendenzen asks for the cut it wants.
 */

import type { PrefArea, PrefDef } from './types.js';

const ATTENTION: PrefArea = { id: 'attention', label: { en: 'Pendenzen', 'de-CH': 'Pendenzen' } };

export const ATTENTION_PREFS: readonly PrefDef[] = [
  {
    key: 'attention.grouping',
    schema: { type: 'enum', values: ['by_area', 'by_kind'] },
    default: 'by_area',
    scope: 'person',
    area: ATTENTION,
    label: { en: 'Group Pendenzen', 'de-CH': 'Pendenzen gruppieren' },
    description: {
      en: 'By area (default, the bank first) or by kind: approve, to do, notes.',
      'de-CH': 'Nach Bereich (Standard, die Bank zuerst) oder nach Art: genehmigen, erledigen, Hinweise.',
    },
    valueLabels: {
      by_area: { en: 'By area', 'de-CH': 'Nach Bereich' },
      by_kind: { en: 'By kind', 'de-CH': 'Nach Art' },
    },
  },
];
