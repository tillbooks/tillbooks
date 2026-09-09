/**
 * Every dial-governed verb has a human label in BOTH Studio locales.
 *
 * The defect this guards: the Phase 1 critic (`docs/ux/measurements/CRITIC-phase1-j3-j8.md`) found
 * 24 of the 38 verbs in `DIAL_CAPABILITY_FOR_ACTION` rendering on the approval card and the
 * attention hub as a raw verb id with the underscores replaced ("post vendor bill", "go productive"),
 * because `agent.verb.*` carried 14 labels while the dial map governed 38. The approval card is
 * where a human accepts an irreversible write; DESIGN.md says no raw snake_case ever reaches the
 * screen. The labels live in the shared catalogue (`app/src/i18n/<locale>.json`) with the Agent
 * surface's own fragment merged over it, exactly as `app/src/i18n/index.tsx` merges them, so this
 * reads both and asserts the union. A verb added to the dial map without a label goes red here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DIAL_CAPABILITY_FOR_ACTION, CONSEQUENCE_FOR_ACTION } from '../../dist/core/agent/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

function verbLabels(locale) {
  const shared = readJson(`app/src/i18n/${locale}.json`).agent?.verb ?? {};
  const fragment = readJson(`app/src/surfaces/Agent/messages.${locale}.json`).agent?.verb ?? {};
  return { ...shared, ...fragment };
}

for (const locale of ['de-CH', 'en']) {
  test(`every dial-governed verb carries an agent.verb.* label in ${locale}`, () => {
    const labels = verbLabels(locale);
    const missing = Object.keys(DIAL_CAPABILITY_FOR_ACTION).filter((verb) => typeof labels[verb] !== 'string' || labels[verb].trim() === '');
    assert.deepEqual(missing, [], `governed verbs without a ${locale} label`);
    // A label is a human sentence, not the id with the underscores swapped.
    const raw = Object.keys(DIAL_CAPABILITY_FOR_ACTION).filter((verb) => labels[verb] === verb || labels[verb] === verb.replace(/_/g, ' '));
    assert.deepEqual(raw, [], `labels that are still the raw verb id in ${locale}`);
  });
}

test('every dial-governed verb carries an engine consequence sentence (the D118 C4 source the hub resolves)', () => {
  const missing = Object.keys(DIAL_CAPABILITY_FOR_ACTION).filter((verb) => typeof CONSEQUENCE_FOR_ACTION[verb] !== 'string');
  assert.deepEqual(missing, []);
});

test('de-CH verb labels use real umlauts and never a sharp s', () => {
  const de = JSON.stringify(verbLabels('de-CH'));
  assert.doesNotMatch(de, /ß/);
  assert.doesNotMatch(de, /\b(ae|oe|ue)\b/i, 'an ASCII transliteration where an umlaut belongs');
});
