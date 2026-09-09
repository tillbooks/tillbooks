/**
 * G17's centred concept panel: the palette-opened variant of the SAME `HelpHint` (design §3a,
 * "a placement of the same component, not a modal of its own"). The palette closes when a Begriff
 * row is chosen, so there is no trigger to anchor to: the panel centres, focus moves INTO it on
 * open, and `onClose` hands focus back to the palette's own restore target (§12's centred focus
 * contract). seeAlso replaces content in place exactly as it does anchored.
 */
import { useState } from 'react';

import { useI18n } from '../i18n';
import { conceptByKey } from '../lib/guidance';
import { conceptContent } from './ConceptTerm';
import { HelpHint } from './HelpHint';

export function ConceptPanel({ conceptKey, onClose }: { conceptKey: string; onClose: () => void }) {
  const { locale, t } = useI18n();
  const [shown, setShown] = useState(conceptKey);
  const entry = conceptByKey(shown) ?? conceptByKey(conceptKey);
  if (entry === undefined) return null;

  return (
    <HelpHint
      label={t('help.term', { term: entry.term[locale] })}
      placement="center"
      open
      onClose={onClose}
      {...conceptContent(entry, locale, t, setShown)}
    />
  );
}
