/**
 * The de-CH address register is `du`, and this is the test that keeps it that way (D56).
 *
 * WHY THIS FILE EXISTS. D48 asked for a register test. D49 asked again. Neither shipped, and on
 * 29.07.2026 the register was decided as `Sie` and reversed to `du` inside the same day with
 * nothing going red in between. A convention that is only written down comes apart the first week
 * two people write copy in the same sentence; this one came apart in under a day.
 *
 * THE TRAP THIS FILE IS BUILT AROUND. German `sie` is also the third-person pronoun, and it is
 * capitalised at the start of a sentence. The catalogues legitimately contain:
 *
 *     "Das ist eine QR-IBAN. Sie kann nur Zahlungen empfangen."       (sie = die IBAN)
 *     "In dieser Periode liegt eine Abschlussbuchung. Sie steht ..."  (sie = die Buchung)
 *
 * Both are correct German and must survive. A test that bans the word `Sie` would demand they be
 * corrupted, and a reviewer under time pressure would comply. So this file never looks for the
 * word.
 *
 * THE DISCRIMINATOR, which is grammar rather than a word list. The polite `Sie` is grammatically
 * PLURAL and always takes a plural verb (`Sie haben`, `Sie können`, `haben Sie`). The third-person
 * pronoun for a feminine noun is SINGULAR and takes a singular verb (`sie hat`, `sie kann`,
 * `sie ist`). So the offence is `Sie` next to a PLURAL verb, never `Sie` next to a singular one.
 * That distinction is exact, not heuristic, and it is why the six legitimate pronoun sentences in
 * the corpus are invisible to this test rather than allowlisted by hand.
 *
 * The polite possessive `Ihr`/`Ihre`/`Ihren` is banned outright when capitalised mid-sentence.
 * Lowercase `ihr` (her, their, or the informal plural) is untouched.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;

/** Verbs that are plural in the present or past. A `Sie` beside one of these is the polite form. */
const PLURAL_VERB =
  'haben|hatten|sind|waren|können|konnten|müssen|mussten|möchten|wollen|wollten|werden|wurden|' +
  'dürfen|durften|sollen|sollten|bleiben|blieben|sehen|sahen|gehen|gingen';

const OFFENCES = [
  {
    id: 'polite-inversion',
    // `haben Sie`, `können Sie`: the verb-subject inversion of a question or an imperative.
    re: new RegExp(`\\b(?:${PLURAL_VERB})\\s+Sie\\b`),
    fix: 'use the du form: "haben Sie" becomes "hast du".',
  },
  {
    id: 'polite-subject',
    // `Sie haben`, `Sie können`. A singular verb here is the pronoun and is deliberately not matched.
    re: new RegExp(`\\bSie\\s+(?:${PLURAL_VERB})\\b`),
    fix: 'use the du form: "Sie haben" becomes "du hast".',
  },
  {
    id: 'polite-imperative',
    // Any infinitive-shaped word followed by `Sie`: `Prüfen Sie`, `Kopieren Sie`, and crucially
    // `Bitte geben Sie`, where the verb is LOWERCASE because it is not sentence-initial. An
    // earlier version of this pattern required a capital and let `Bitte geben Sie` straight
    // through; the self-test below is what caught it.
    //
    // Safe against the pronoun by shape: this matches VERB-then-Sie, and every legitimate pronoun
    // use in the corpus is Sie-then-verb.
    re: /\b\p{L}+en\s+Sie\b/u,
    fix: 'use the du imperative: "Kopieren Sie" becomes "Kopiere", "Bitte geben Sie" becomes "Bitte gib".',
  },
  {
    id: 'polite-possessive',
    // Capitalised `Ihr` and its inflections. Lowercase `ihr` is a different word and is left alone.
    re: /\bIhr(?:e|en|em|er|es)?\b|\bIhnen\b/,
    fix: 'use the du possessive: "Ihr Text" becomes "dein Text", "Von Ihnen" becomes "von dir".',
  },
];

/** Every tracked de-CH catalogue. `git ls-files`, so an untracked scratch file is not the repo. */
function catalogues() {
  return execFileSync('git', ['ls-files'], { env: cleanGitEnv(), cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((p) => /de-CH\.json$/.test(p));
}

/** Every string leaf in a catalogue, with its dot path, so a failure names the key to fix. */
function strings(node, path = '', out = []) {
  if (typeof node === 'string') out.push({ path, value: node });
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function offences(value) {
  return OFFENCES.filter((o) => o.re.test(value));
}

test('de-CH copy addresses the reader as du, never as Sie', () => {
  const files = catalogues();
  assert.ok(files.length > 0, 'found no de-CH catalogues at all, so this test proves nothing');

  const found = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    for (const { path, value } of strings(data)) {
      for (const o of offences(value)) {
        found.push(`${file}\n    key:  ${path}\n    text: ${value}\n    ${o.id}: ${o.fix}`);
      }
    }
  }

  assert.deepEqual(
    found,
    [],
    `de-CH copy must use the du register (D56). Offending strings:\n\n${found.join('\n\n')}\n`,
  );
});

test('the third-person pronoun sie is NOT flagged, in every place the corpus really uses it', () => {
  // Verbatim from the catalogues. These are feminine nouns referred to in the next sentence, they
  // are correct German, and a register test that demanded they change would be a defect.
  const LEGITIMATE = [
    'Das ist eine QR-IBAN. Sie kann nur Zahlungen empfangen.',
    'Die Aufteilung zeigt, wie lange ein Betrag schon offen ist. Sie ist eine Darstellung und keine Frist.',
    'In dieser Periode liegt eine Abschlussbuchung. Sie steht hier drin und in der Erfolgsrechnung nicht.',
    'Die internationale Referenz nach ISO 11649. Sie beginnt mit RF und trägt eine Prüfziffer.',
    'Ob die Rechnung hinausging, weiss TILL nicht. Sie liegt möglicherweise beim Kunden.',
    'Bleibt die Vorschau leer, lade die Datei herunter. Sie ist vollständig.',
    'Der Beleg wurde gebucht. Sie erscheint im Journal.',
  ];
  for (const s of LEGITIMATE) {
    assert.deepEqual(
      offences(s).map((o) => o.id),
      [],
      `the pronoun sie was flagged as the polite address, which would corrupt correct German:\n  ${s}`,
    );
  }
});

test('the guard actually fires, on every shape of the polite address', () => {
  // Real strings from the corpus before the D56 conversion. If any of these stops failing, the
  // guard has a hole and the register can drift back through it.
  const MUST_FAIL = [
    ['Bitte geben Sie einen kurzen Betreff an.', 'polite-imperative'],
    ['Was ist passiert, und was haben Sie erwartet?', 'polite-inversion'],
    ['Sie haben noch keinen Bericht verfasst.', 'polite-subject'],
    ['Von Ihnen verfasste Berichte', 'polite-possessive'],
    ['TILL übergibt einen Bericht an Ihr Mail-Programm.', 'polite-possessive'],
    ['Kopieren Sie ihn, bevor Sie dies schliessen.', 'polite-imperative'],
    ['Nie: Beträge, Namen, Kontonummern, Ihre Eingaben.', 'polite-possessive'],
  ];
  for (const [s, expected] of MUST_FAIL) {
    const ids = offences(s).map((o) => o.id);
    assert.ok(
      ids.includes(expected),
      `expected ${expected} to fire on:\n  ${s}\ngot: ${ids.join(', ') || '(nothing)'}`,
    );
  }
});
