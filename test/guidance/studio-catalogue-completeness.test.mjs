/**
 * The Studio catalogue locale-completeness gate, PRODUCT-WIDE (G17 §12, "the second is worth more
 * than G17"). `brand/DESIGN.md` asks for locale completeness as a build gate; until this file the
 * Studio had none: `test/web/locale-completeness.test.mjs` globs `web/src/i18n/fragments/`, the
 * public WEBSITE, and nothing enumerated `app/src/surfaces/[star][star]/messages.<locale>.json`.
 * (The app's own vitest suite checks the MERGED catalogue; this one runs in the ROOT gate, per
 * surface, so a mismatch names the file that carries it.)
 *
 * Rules per surface directory and for the two shared catalogues:
 *  - the same leaf-key set in every locale (a key present in one locale only is a silent English
 *    or German fallback in production);
 *  - every STRING leaf non-empty in every locale;
 *  - structural leaves (arrays, the G17 help-entry structure) are allowed and checked by
 *    `help-entries.test.mjs`, not here: this gate only demands the key sets line up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACES = join(ROOT, 'app/src/surfaces');
const LOCALES = ['de-CH', 'en'];

function flatten(tree, prefix = '') {
  const out = new Map();
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flatten(value, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function catalogues() {
  const dirs = readdirSync(SURFACES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(SURFACES, e.name));
  return [...dirs, join(ROOT, 'app/src/i18n')].map((dir) => ({
    dir,
    byLocale: Object.fromEntries(
      LOCALES.map((locale) => {
        const file =
          dir.endsWith('i18n') ? join(dir, `${locale}.json`) : join(dir, `messages.${locale}.json`);
        return [locale, flatten(JSON.parse(readFileSync(file, 'utf8')))];
      }),
    ),
  }));
}

test('every surface catalogue (and the shared pair) carries the same key set in every locale', () => {
  const problems = [];
  for (const { dir, byLocale } of catalogues()) {
    const de = byLocale['de-CH'];
    const en = byLocale.en;
    for (const key of de.keys()) if (!en.has(key)) problems.push(`${dir}: "${key}" missing from en`);
    for (const key of en.keys()) if (!de.has(key)) problems.push(`${dir}: "${key}" missing from de-CH`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every string leaf is non-empty in every locale', () => {
  const blank = [];
  for (const { dir, byLocale } of catalogues()) {
    for (const locale of LOCALES) {
      for (const [key, value] of byLocale[locale]) {
        if (typeof value === 'string' && value.trim() === '') blank.push(`${dir} (${locale}): ${key}`);
      }
    }
  }
  assert.deepEqual(blank, [], blank.join('\n'));
});
