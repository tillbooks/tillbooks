/**
 * The two G15 verb summaries spell their German nouns with umlauts (critic F7; house style).
 *
 * The summary is the one thing an agent reads to choose the verb, and the repo-wide umlaut guard
 * (`test/style/umlaut-transliteration.test.mjs`) is a curated word list that did not carry these two
 * nouns, so `Vorschlaege` and `Mahnlaeufe` sat in `docs/CONTRACT.md` unflagged. This guard is
 * narrow on purpose: it grades the attention summaries the registry serves, not the word list, so it
 * cannot false-positive on a JSON key or an identifier spelled `vorschlaege` elsewhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';

for (const name of ['attention_summary', 'attention_list']) {
  test(`${name}: the summary carries real umlauts, never ae/oe/ue for the queue nouns`, () => {
    const summary = getAction(name).summary;
    assert.equal(typeof summary, 'string');
    assert.doesNotMatch(summary, /vorschlaeg|mahnlaeuf|mahnlauf(?:e|en)\b/i, 'an ASCII-transliterated queue noun');
  });
}

test('attention_summary names the four queues by their German nouns, spelled with umlauts', () => {
  const summary = getAction('attention_summary').summary;
  assert.match(summary, /Vorschläge/);
  assert.match(summary, /Mahnläufe/);
});
