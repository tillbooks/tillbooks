// J03: every explanation key the ENGINE emits exists in BOTH Studio locale catalogues.
//
// THE GAP THIS CLOSES. `ValuationResult.explanation` is an i18n key chosen by the engine and shipped
// on the MCP and REST payload, and nothing in the repo compared those keys against the catalogues
// that have to render them. A rename produced `invValuation.explain.weightedAverageAllocated`, which
// existed in neither locale for a full round: nothing rendered it that day, so no raw key appeared on
// screen, and the only reason it was caught at all is that a critic read the file. An agent consuming
// the verb got a key it could not resolve either.
//
// HOW IT STAYS NON-VACUOUS, because a guard that greps and finds nothing passes loudest:
//   - the extraction is asserted to find a MINIMUM number of keys, so a broken regex fails rather
//     than silently approving an empty set
//   - both catalogues are asserted to be non-empty objects before any comparison is believed
//   - a synthetic missing key is checked to be REPORTED by the same comparison, so the comparison
//     itself is proven to bite on every run
//
// Scoped to J03's own namespace, which is what this capability owns. The general version (every
// engine-emitted i18n key, every surface) belongs in `test/style/` and is recorded as a follow-up
// rather than smuggled in here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ENGINE = join(ROOT, 'src', 'core', 'inventory', 'valuation.ts');
const LOCALES = ['de-CH', 'en'];

/** Every `invValuation.explain.*` literal the engine can put on a result. */
function engineKeys() {
  const source = readFileSync(ENGINE, 'utf8');
  const found = source.match(/invValuation\.explain\.[A-Za-z]+/g) ?? [];
  return [...new Set(found)].sort();
}

function catalogue(locale) {
  const path = join(ROOT, 'app', 'src', 'surfaces', 'InventoryValuation', `messages.${locale}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Resolve a dot path against a message tree, the way the Studio's `t()` does. */
function resolve(tree, key) {
  let node = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

test('J03 i18n: the extraction really reads the engine (a broken probe cannot pass vacuously)', () => {
  const keys = engineKeys();
  assert.ok(keys.length >= 10, `expected the engine to emit at least ten explanation keys, found ${keys.length}`);
  assert.ok(keys.includes('invValuation.explain.lcm'), 'a key known to exist must be among them');
});

test('J03 i18n: both catalogues load and are non-empty', () => {
  for (const locale of LOCALES) {
    const tree = catalogue(locale);
    assert.equal(typeof tree, 'object');
    assert.ok(Object.keys(tree.invValuation ?? {}).length > 0, `${locale} carries no invValuation namespace`);
  }
});

test('J03 i18n: every engine-emitted explanation key resolves in every locale', () => {
  const missing = [];
  for (const locale of LOCALES) {
    const tree = catalogue(locale);
    for (const key of engineKeys()) {
      if (resolve(tree, key) === undefined) missing.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'the engine emits an explanation key the Studio cannot render, and it also reaches MCP and REST callers',
  );
});

test('J03 i18n: the comparison can actually see a missing key', () => {
  // The guard above concludes from an EMPTY list, so the comparison that produces it is re-proved
  // here against a key that is deliberately absent.
  const tree = catalogue('de-CH');
  assert.equal(resolve(tree, 'invValuation.explain.definitelyNotThere'), undefined);
  assert.notEqual(resolve(tree, 'invValuation.explain.lcm'), undefined);
});
