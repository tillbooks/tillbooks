/**
 * G17's marked term: a concept-bearing word inside a translated sentence, rendered as a REAL
 * button with a dotted underline and an accessible name ("Begriff Saldosteuersatz"), never a hover
 * reveal (design §4c). It reaches sentences through `tRich`:
 *
 *   tRich('vat.explainer.p1', { saldo: <ConceptTerm k="saldosteuersatz" /> })
 *
 * The panel it opens is the extended `HelpHint` (one popover for the whole product, §2c). Choosing
 * a related term REPLACES the panel content in place: same panel, no stack, no history, and Esc
 * returns focus to THIS term, the original trigger, because the trigger never moves (§3a).
 *
 * Zero engine calls, zero writes, zero per-user state: the corpus is a build-time constant and the
 * open state lives here and dies with the panel.
 */
import { useState } from 'react';

import { useI18n } from '../i18n';
import {
  agentHandoffProvider,
  conceptByKey,
  docsUrl,
  type ConceptEntry,
} from '../lib/guidance';
import { HelpHint, type ConceptRef, type HelpHintProps } from './HelpHint';

/** The localized panel props for one corpus entry. Shared with ConceptPanel and SurfaceHelp. */
export function conceptContent(
  entry: ConceptEntry,
  locale: 'de-CH' | 'en',
  t: (key: string, params?: Record<string, string | number>) => string,
  onSeeAlso: (key: string) => void,
): Pick<HelpHintProps, 'title' | 'body' | 'articles' | 'seeAlso' | 'onSeeAlso' | 'learnMore' | 'handoff'> {
  const seeAlso: ConceptRef[] = entry.seeAlso
    .map((key) => {
      const target = conceptByKey(key);
      return target === undefined ? null : { key, term: target.term[locale] };
    })
    .filter((ref): ref is ConceptRef => ref !== null);
  const content: ReturnType<typeof conceptContent> = {
    title: entry.term[locale],
    body: entry.body[locale],
    articles: entry.articles,
    seeAlso,
    onSeeAlso,
  };
  if (entry.docsPath !== undefined) {
    content.learnMore = { href: docsUrl(entry.docsPath), label: t('help.docs') };
  }
  const provider = agentHandoffProvider();
  if (provider !== null) {
    // Row 5.2: with no A35 provider registered this branch never runs and NO handoff DOM exists.
    content.handoff = {
      label: provider.label,
      onActivate: () => provider.openWithDraft({ conceptKey: entry.key, term: entry.term[locale] }),
    };
  }
  return content;
}

export function ConceptTerm({ k, text }: { k: string; text?: string }) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  // The concept currently SHOWN: seeAlso replaces it in place. Reset to the term's own concept on
  // every open, so a reader four terms deep who closes and reopens starts at the word they clicked.
  const [shown, setShown] = useState(k);

  const entry = conceptByKey(open ? shown : k);
  const own = conceptByKey(k);
  if (own === undefined || entry === undefined) {
    // Unknown key: plain text, no trigger (row 1.3). The BUILD failure lives in test/guidance/.
    return <>{text ?? k}</>;
  }

  // `text` lets a sentence mark its own word ("Soll") while the accessible name still carries the
  // corpus term ("Begriff Vereinbarte Entgelte (Soll)"), so the panel and the announcement agree.
  return (
    <HelpHint
      label={t('help.term', { term: own.term[locale] })}
      trigger={{ kind: 'term', text: text ?? own.term[locale] }}
      open={open}
      onOpen={() => {
        setShown(k);
        setOpen(true);
      }}
      onClose={() => setOpen(false)}
      {...conceptContent(entry, locale, t, setShown)}
    />
  );
}
