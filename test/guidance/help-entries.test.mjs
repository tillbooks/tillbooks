/**
 * G17's LANDING GATE (D101): the help law binds every surface directory at landing time. Each of
 * the directories under `app/src/surfaces/` must declare a help entry (`help.<Dir>` in its OWN
 * message catalogues, the help-entry SHAPE of spec G17 §6) in BOTH locales, or sit on the
 * clearly-marked TEMPORARY allowlist below.
 *
 * ========================== THE ALLOWLIST IS TEMPORARY, BY DECISION ==========================
 * D101 (2026-08-17): "G17 does not land until a help entry exists for each of the 64 routed
 * surfaces." The authoring wave burns this list down to ZERO on the G17 branch, entry by entry,
 * each in the owning surface's catalogue, and THIS BRANCH DOES NOT MERGE TO develop WHILE THE
 * LIST IS NON-EMPTY. It exists so the mechanism and the worked examples can land green while the
 * authoring runs as its own scheduled, file-ownership-planned wave, and for no other reason.
 * =============================================================================================
 *
 * Beyond presence, every entry is held to the SHAPE: `title`/`body` per locale (body inside the
 * word budget, NO digits, no referring construction; the du register and umlauts are judged by
 * NAMED guards, not assumed: `test/style/address-register.test.mjs` bans the Sie register over
 * every tracked `de-CH.json`, `test/style/umlaut-transliteration.test.mjs` corpus 1 bans ASCII
 * transliteration over the same catalogues, and `test/guidance/register.test.mjs` re-judges the
 * help entries directly, adding the sharp-s and first-person rules in both locales);
 * `concepts` (max 5, every key in the corpus, no duplicates),
 * `docsPath` (resolving against site-docs/docs.json) and `bindingElections` (every option and
 * bindingFacts key resolving to a non-empty string in BOTH locales) IDENTICAL across locales,
 * because structure is not translation. Every entry carries at least one of concepts/docsPath
 * (the no-dead-end floor applied to surface help).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CONCEPT_KEYS } from '../../dist/core/guidance/corpus.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACES = join(ROOT, 'app/src/surfaces');
const LOCALES = ['de-CH', 'en'];

/* Written as an escape so this guard does not trip the em dash gate it enforces. */
const EM_DASH = '\u2014';

/**
 * TEMPORARY (see the banner above): surfaces whose help entry the authoring wave still owes.
 * Remove a name in the same commit that authors its entry. The gate below fails if a name here
 * ALREADY has an entry, so the list can only shrink.
 */
const PENDING_HELP_ENTRIES = new Set([]);

const REFERRING = [
  /siehe\s+(die\s+)?dokumentation/i,
  /mehr\s+dazu\s+in/i,
  /see\s+the\s+docs/i,
  /https?:\/\//i,
];

function surfaceDirs() {
  return readdirSync(SURFACES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function catalogue(dir, locale) {
  return JSON.parse(readFileSync(join(SURFACES, dir, `messages.${locale}.json`), 'utf8'));
}

function helpEntry(dir, locale) {
  const tree = catalogue(dir, locale);
  const help = tree.help;
  if (typeof help !== 'object' || help === null) return null;
  const entry = help[dir];
  return typeof entry === 'object' && entry !== null ? entry : null;
}

function docsPages() {
  const docs = JSON.parse(readFileSync(join(ROOT, 'site-docs/docs.json'), 'utf8'));
  const pages = new Set();
  for (const tab of docs.navigation?.tabs ?? []) {
    for (const group of tab.groups ?? []) for (const page of group.pages ?? []) pages.add(page);
  }
  return pages;
}

/** Resolve a dot-path against a catalogue tree, the i18n resolver's shape. */
function resolveKey(tree, key) {
  let node = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

test('the landing gate: every surface directory declares a help entry in both locales, or is on the TEMPORARY allowlist', () => {
  const dirs = surfaceDirs();
  const missing = [];
  for (const dir of dirs) {
    const hasBoth = LOCALES.every((locale) => helpEntry(dir, locale) !== null);
    if (!hasBoth && !PENDING_HELP_ENTRIES.has(dir)) missing.push(dir);
  }
  assert.deepEqual(
    missing,
    [],
    `Surfaces with no help entry and no allowlist row: ${missing.join(', ')}. ` +
      'brand/DESIGN.md holds "help reachable from each surface" absolute (D101). Author the entry ' +
      'in the surface\'s own catalogues, or (only during the authoring wave) add the name to ' +
      'PENDING_HELP_ENTRIES.',
  );
});

test('the allowlist can only shrink: no allowlisted surface already has its entry, and no stale names', () => {
  const dirs = new Set(surfaceDirs());
  for (const name of PENDING_HELP_ENTRIES) {
    assert.ok(dirs.has(name), `PENDING_HELP_ENTRIES names "${name}", which is not a surface directory`);
    const authored = LOCALES.every((locale) => helpEntry(name, locale) !== null);
    assert.ok(
      !authored,
      `${name} has its help entry but still sits on PENDING_HELP_ENTRIES: remove it in the same commit`,
    );
  }
});

test('every authored help entry holds the SHAPE (title/body, budget, no digits, no referring construction)', () => {
  const pages = docsPages();
  for (const dir of surfaceDirs()) {
    const entries = LOCALES.map((locale) => helpEntry(dir, locale));
    if (entries.some((e) => e === null)) continue; // presence is the first gate's job
    for (const [i, locale] of LOCALES.entries()) {
      const entry = entries[i];
      assert.ok(typeof entry.title === 'string' && entry.title.trim() !== '', `${dir} (${locale}): title`);
      assert.ok(typeof entry.body === 'string' && entry.body.trim() !== '', `${dir} (${locale}): body`);
      const words = entry.body.split(/\s+/).filter((w) => w.length > 0).length;
      assert.ok(words >= 15 && words <= 115, `${dir} (${locale}): body is ${words} words, budget 15..115`);
      assert.ok(!/\d/.test(entry.body), `${dir} (${locale}): a digit in a help body cannot be corrected by a constant`);
      assert.ok(!entry.body.includes(EM_DASH), `${dir} (${locale}): em dash`);
      for (const banned of REFERRING) {
        assert.ok(!banned.test(entry.body), `${dir} (${locale}): body matches ${banned}`);
      }
    }
  }
});

test('concepts, docsPath and bindingElections are IDENTICAL across locales, valid, and inside the caps', () => {
  const pages = docsPages();
  const corpus = new Set(CONCEPT_KEYS);
  for (const dir of surfaceDirs()) {
    const de = helpEntry(dir, 'de-CH');
    const en = helpEntry(dir, 'en');
    if (de === null || en === null) continue;
    assert.deepEqual(de.concepts ?? [], en.concepts ?? [], `${dir}: concepts differ across locales (structure is not translation)`);
    assert.equal(de.docsPath, en.docsPath, `${dir}: docsPath differs across locales`);
    assert.deepEqual(de.bindingElections ?? [], en.bindingElections ?? [], `${dir}: bindingElections differ across locales`);

    const concepts = de.concepts ?? [];
    assert.ok(Array.isArray(concepts), `${dir}: concepts is a list`);
    assert.ok(concepts.length <= 5, `${dir}: ${concepts.length} concepts, the cap is 5 (row 11.2); the rest are reachable through the palette`);
    assert.equal(new Set(concepts).size, concepts.length, `${dir}: duplicate concept`);
    for (const key of concepts) {
      assert.ok(corpus.has(key), `${dir}: concept "${key}" is not a corpus key (row 1.3: a build failure, never a runtime dead link)`);
    }
    if (de.docsPath !== undefined) {
      assert.ok(pages.has(de.docsPath), `${dir}: docsPath "${de.docsPath}" is not a page in site-docs/docs.json (row 6.3)`);
    }
    assert.ok(
      concepts.length > 0 || typeof de.docsPath === 'string',
      `${dir}: an entry with neither concepts nor docsPath is a dead-end panel (the §3a floor applied to surface help)`,
    );
  }
});

test('every bindingElections option and bindingFacts key resolves to a non-empty string in BOTH locales', () => {
  for (const dir of surfaceDirs()) {
    const entry = helpEntry(dir, 'de-CH');
    if (entry === null || !Array.isArray(entry.bindingElections)) continue;
    for (const locale of LOCALES) {
      const tree = catalogue(dir, locale);
      for (const election of entry.bindingElections) {
        assert.ok(typeof election.id === 'string' && election.id !== '', `${dir}: election id`);
        assert.ok(Array.isArray(election.options) && election.options.length >= 2, `${dir}/${election.id}: a binding election has at least two options to explain`);
        for (const key of [...election.options, ...(election.bindingFacts !== undefined ? [election.bindingFacts] : [])]) {
          const hit = resolveKey(tree, key);
          assert.ok(
            hit !== undefined && hit.trim() !== '',
            `${dir}/${election.id} (${locale}): "${key}" does not resolve in the surface's catalogue. ` +
              'This is what makes "an option in a binding election with no consequence line fails the gate" enumerable (§12).',
          );
        }
      }
    }
  }
});

test('at least the worked-example surfaces have authored entries (the mechanism is not vacuous)', () => {
  for (const dir of ['VatSettings', 'VatReturn', 'Reports', 'Journal', 'OpenItems', 'Payments', 'Onboarding']) {
    for (const locale of LOCALES) {
      assert.ok(helpEntry(dir, locale) !== null, `${dir} (${locale}): the worked example's entry is missing`);
    }
  }
  // And VatSettings declares its two binding elections, since it is the §8b worked example.
  const vs = helpEntry('VatSettings', 'de-CH');
  assert.equal((vs.bindingElections ?? []).length, 2, 'VatSettings declares the method AND timing elections');
});
