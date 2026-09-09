/**
 * G17's surface-title help glyph: the existing `HelpHint` "?" beside a surface's heading, showing
 * the surface's own help entry (`help.<SurfaceDir>` in its message catalogue: the help-entry SHAPE
 * of spec §6). A surface that has authored NO entry renders NO glyph at all (G16's
 * absence-renders-nothing rule applied to copy), which is what lets the corpus fill in
 * incrementally without shipping empty panels; the landing gate in `test/guidance/` is what keeps
 * "incrementally" from meaning "never" (D101).
 *
 * The entry's declared concepts render as the panel's related terms: choosing one replaces the
 * content in place with that Begriff, and Esc still returns to the glyph, the original trigger.
 */
import { useState } from 'react';

import { useI18n } from '../i18n';
import { conceptByKey, docsUrl, surfaceHelp } from '../lib/guidance';
import { conceptContent } from './ConceptTerm';
import { HelpHint, type ConceptRef, type HelpHintProps } from './HelpHint';

export function SurfaceHelp({ surface }: { surface: string }) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  /** null shows the surface entry itself; a key shows that concept (seeAlso replacement in place). */
  const [shownConcept, setShownConcept] = useState<string | null>(null);

  const entry = surfaceHelp(locale, surface);
  if (entry === null) return null; // no entry, NO glyph: absence renders nothing.

  let content: Pick<
    HelpHintProps,
    'title' | 'body' | 'articles' | 'seeAlso' | 'onSeeAlso' | 'learnMore' | 'handoff'
  >;
  const shownEntry = shownConcept === null ? undefined : conceptByKey(shownConcept);
  if (shownEntry !== undefined) {
    content = conceptContent(shownEntry, locale, t, setShownConcept);
  } else {
    const seeAlso: ConceptRef[] = entry.concepts
      .map((key) => {
        const target = conceptByKey(key);
        return target === undefined ? null : { key, term: target.term[locale] };
      })
      .filter((ref): ref is ConceptRef => ref !== null);
    content = {
      title: entry.title,
      body: entry.body,
      seeAlso,
      onSeeAlso: setShownConcept,
    };
    if (entry.docsPath !== undefined) {
      content.learnMore = { href: docsUrl(entry.docsPath), label: t('help.docs') };
    }
  }

  return (
    <HelpHint
      label={t('help.surface', { title: entry.title })}
      open={open}
      onOpen={() => {
        setShownConcept(null);
        setOpen(true);
      }}
      onClose={() => setOpen(false)}
      {...content}
    />
  );
}
