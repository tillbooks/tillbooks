/**
 * G17's register and umlaut guard over the BUILT corpus and the help entries (corpus-critic F2).
 *
 * WHY THIS FILE EXISTS, precisely. Two docblocks claimed a guard that was thinner than stated. The
 * true coverage map, before this file:
 *
 *  - `test/style/umlaut-transliteration.test.mjs` DOES scan every surface catalogue
 *    (`messages.de-CH.json`, its corpus 1) and every TRACKED `.ts`/`.mjs` string literal (its
 *    source corpus), so the help bodies and the corpus SOURCE were transliteration-guarded. The
 *    critic's probe passed because it patched `dist/`, which is untracked and invisible to both.
 *  - `test/style/address-register.test.mjs` DOES ban the Sie register over every tracked
 *    `de-CH.json`, so the help bodies were register-guarded.
 *  - NOTHING covered the de-CH strings of the BUILT corpus (the constant the verbs actually
 *    serve), the du register of the corpus (a `.ts` file, outside the register guard's
 *    `de-CH.json` glob), the sharp s anywhere in guidance strings, or the ENGLISH first person.
 *
 * This file closes exactly those gaps, over `dist/core/guidance/corpus.js` (the built artifact,
 * the seam the probe used) and the `help.<Dir>` entries of every surface catalogue:
 *
 *  - de-CH: no sharp s, no Sie-register offence (the address-register guard's own three patterns),
 *    no first person (wir/uns/unser), and no ASCII umlaut transliteration, detected by WORD LIST
 *    (the style guard's own philosophy: a naive `ue` scan flags Steuer, neue, Quelle and aktuell,
 *    so the list names the transliterated stems the domain actually uses and matches them
 *    mid-word, catching vierteljaehrlich through jaehrlich).
 *  - en: no first person (we/our/us): the product has no first person in any language (§7c rule 6).
 *
 * The word list is not a phonology engine and does not claim to be: a transliterated word outside
 * it passes this file and is still caught in the TRACKED source by the style guard. What this file
 * guarantees is that the strings the verbs SERVE are judged, whatever produced them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CONCEPTS } from '../../dist/core/guidance/corpus.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACES = join(ROOT, 'app/src/surfaces');

// ---------------------------------------------------------------------------------------------
// The de-CH rules
// ---------------------------------------------------------------------------------------------

const SHARP_S = 'ß';

/**
 * Transliterated stems of the guidance domain's own vocabulary, matched case-insensitively and
 * mid-word. Extend this list when a new domain word joins the corpus; the style guard's register
 * is the model.
 */
const TRANSLITERATED_STEMS = [
  'fuer',
  'ueber',
  'waehrend',
  'waehrung',
  'spaeter',
  'aender',
  'geaendert',
  'saetze',
  'saetzen',
  'jaehrlich',
  'maessig',
  'faellig',
  'zulaessig',
  'taetigkeit',
  'waehlen',
  'gewaehlt',
  'koennen',
  'koennte',
  'muessen',
  'muesste',
  'fuehren',
  'gefuehrt',
  'betraege',
  'gebuehr',
  'pruefen',
  'geprueft',
  'schluessel',
  'loeschen',
  'moeglich',
  'hoechst',
  'hoeher',
  'gruende',
  'uebernahme',
  'ueberschuss',
  'erklaert',
  'verlaesst',
  'erhaelt',
  'gegenueber',
  'zurueck',
  'ausfuehr',
  'einfuehr',
  'verfuegbar',
  'buero',
  'gueltig',
];

const TRANSLITERATION_RE = new RegExp(TRANSLITERATED_STEMS.join('|'), 'i');

/**
 * The Sie-register offences, the address-register guard's own three shapes (see
 * `test/style/address-register.test.mjs` for the full derivation and its verb-plurality argument;
 * these are the same patterns applied to strings that file's `de-CH.json` glob cannot see).
 */
const PLURAL_VERB =
  'haben|hatten|sind|waren|können|konnten|müssen|mussten|möchten|wollen|wollten|werden|wurden|' +
  'dürfen|durften|sollen|sollten|bleiben|blieben|sehen|sahen|gehen|gingen';
const SIE_OFFENCES = [
  new RegExp(`\\b(?:${PLURAL_VERB})\\s+Sie\\b`),
  new RegExp(`\\bSie\\s+(?:${PLURAL_VERB})\\b`),
  /\b[A-Za-zäöü]+en\s+Sie\b/,
  /(?<!^)(?<![.!?:]\s)\bIhr(?:e|en|em|er|es)?\b/,
];

const DE_FIRST_PERSON = /\b(wir|uns|unser\w*)\b/i;
const EN_FIRST_PERSON = /\b(we|our|us)\b/i;

function deOffences(text) {
  const found = [];
  if (text.includes(SHARP_S)) found.push('sharp s (Swiss German has none: write ss)');
  const translit = TRANSLITERATION_RE.exec(text);
  if (translit !== null) found.push(`ASCII transliteration "${translit[0]}" (write the umlaut)`);
  for (const re of SIE_OFFENCES) {
    const m = re.exec(text);
    if (m !== null) found.push(`Sie-register "${m[0]}" (the register is du, D54/D56)`);
  }
  const first = DE_FIRST_PERSON.exec(text);
  if (first !== null) found.push(`first person "${first[0]}" (the product has no first person, §7c rule 6)`);
  return found;
}

function enOffences(text) {
  const m = EN_FIRST_PERSON.exec(text);
  return m === null ? [] : [`first person "${m[0]}" (the product has no first person, §7c rule 6)`];
}

// ---------------------------------------------------------------------------------------------
// The corpora
// ---------------------------------------------------------------------------------------------

function helpEntries(locale) {
  const out = [];
  for (const dir of readdirSync(SURFACES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const tree = JSON.parse(readFileSync(join(SURFACES, dir.name, `messages.${locale}.json`), 'utf8'));
    const entry = tree.help?.[dir.name];
    if (entry === undefined) continue;
    out.push({ where: `help.${dir.name}`, texts: [entry.title, entry.body].filter((t) => typeof t === 'string') });
  }
  return out;
}

test('the BUILT corpus de-CH strings hold the register: du, real umlauts, no sharp s, no first person', () => {
  const problems = [];
  for (const c of CONCEPTS) {
    for (const text of [c.term['de-CH'], c.body['de-CH']]) {
      for (const offence of deOffences(text)) problems.push(`${c.key}: ${offence}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the BUILT corpus en strings carry no first person', () => {
  const problems = [];
  for (const c of CONCEPTS) {
    for (const text of [c.term.en, c.body.en]) {
      for (const offence of enOffences(text)) problems.push(`${c.key}: ${offence}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every help entry holds the register in both locales (de rules + the en first-person ban)', () => {
  const problems = [];
  for (const { where, texts } of helpEntries('de-CH')) {
    for (const text of texts) for (const offence of deOffences(text)) problems.push(`${where} (de-CH): ${offence}`);
  }
  for (const { where, texts } of helpEntries('en')) {
    for (const text of texts) for (const offence of enOffences(text)) problems.push(`${where} (en): ${offence}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the guard bites: the critic probe vocabulary and each rule class are caught, and clean German is not', () => {
  // The F2 probe body's own words, every one flagged.
  for (const word of ['fuer', 'vierteljaehrlich', 'halbjaehrlich', 'regelmaessigem', 'Vorsteuerueberschuss', 'jaehrlich']) {
    assert.ok(TRANSLITERATION_RE.test(word), `probe word "${word}" must be flagged`);
  }
  assert.ok(deOffences('Das gilt für dich, wenn du später wechselst.').length === 0, 'clean du-German passes');
  // The known false-positive families of a naive digraph scan stay invisible to the word list.
  for (const legit of ['Steuer', 'neue', 'Quelle', 'aktuell', 'individuell', 'teuer']) {
    assert.ok(!TRANSLITERATION_RE.test(legit), `"${legit}" is real German and must not be flagged`);
  }
  assert.ok(deOffences('Haben Sie das geprüft?').length > 0, 'the Sie register is caught');
  assert.ok(deOffences('weiß').length > 0, 'the sharp s is caught');
  assert.ok(deOffences('Wir buchen das.').length > 0, 'de first person is caught');
  assert.ok(enOffences('We book this for you.').length > 0, 'en first person is caught');
  assert.ok(enOffences('The status of your books.').length === 0, 'en containing "us" inside a word passes');
});
