/**
 * A24: every capability the engine enumerates owes a label in EVERY Studio catalogue.
 *
 * WHY THIS IS A CRASH AND NOT A COSMETIC GAP. `app/src/surfaces/Members/Members.tsx` renders the
 * capability registry through `tStrict`, and `tStrict` THROWS in dev on a missing key (see
 * `app/src/i18n/index.tsx`: "an untranslated runtime value is a bug, not a rendering state"). The
 * registry it renders is whatever `list_roles` sends, which is `CAPABILITIES` in full on the owner
 * row. So one unlabelled capability does not render as a machine name: it takes the whole Roles tab
 * down for the person most likely to be looking at it.
 *
 * IT HAPPENED TWICE IN ONE DAY, which is the argument for a guard rather than two fixes. G00
 * promoted `manage_custom_fields` and `manage_saved_views` out of `RESERVED_CAPABILITIES` and did not
 * label them, and D50's five read capabilities plus the new `reading` GROUP would have done exactly
 * the same thing an hour later. Neither author was careless; the coupling is simply invisible from
 * the file each of them was editing.
 *
 * DERIVED ON BOTH SIDES, and that is the point of the shape rather than a nicety. Spelling any
 * capability name in this file would make it a THIRD mirror of the enum, which is the exact defect it
 * exists to catch: the next author would then have three places to remember instead of two. So the
 * engine side reads `CAPABILITIES` and the Studio side reads the catalogue JSON, and nothing in
 * between is written by hand.
 *
 * WHERE THIS LIVES, and why it is not a row in `test/style/studio-mirrors-engine-enums.test.mjs`.
 * That file was written on `claude/studio-enum-drift` and this note used to say it sat on neither
 * this branch's base nor `claude/wave-f2-integration`, with the fold offered as a follow-up. Both
 * branches met on 30.07.2026 and the fold was weighed and DECLINED, by the author of that file:
 *
 *   - Its rows all pair an engine export against a symbol DECLARED in a TypeScript source, read out
 *     of the AST. This suite pairs an engine export against JSON CATALOGUE KEYS resolved down a
 *     dotted path, because `diagnostics.read` is stored nested. Same idea, different machinery.
 *   - Two of the three tests here are not engine-to-Studio comparisons at all. Locale-to-locale key
 *     parity and per-GROUP label coverage are properties of the catalogues themselves, and they have
 *     no home in a file about mirrored enumerations.
 *   - The capability enum is A24's, and this suite sits with A24's other guards, which is where
 *     somebody changing `CAPABILITIES` will actually be looking.
 *
 * So the two are siblings and not duplicates: that one holds the DECLARED mirrors, this one holds
 * the LABELS. Neither subsumes the other, and each says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CAPABILITIES, CAPABILITY_IDS } from '../../dist/core/access/index.js';

/** The Studio's per-surface message catalogues, one per locale. */
const CATALOGUES = ['en', 'de-CH'];

function catalogue(locale) {
  return JSON.parse(
    readFileSync(new URL(`../../app/src/surfaces/Members/messages.${locale}.json`, import.meta.url), 'utf8'),
  );
}

/**
 * Resolve a dotted key the way the Studio's `lookup` does.
 *
 * It has to be dotted rather than flat because `diagnostics.read` contains a dot and is stored
 * NESTED (`capability.diagnostics.read`). A flat lookup would report it missing and send somebody
 * to add a duplicate key that the surface would never read.
 */
function lookup(catalog, key) {
  return key.split('.').reduce((node, part) => (node === undefined ? undefined : node[part]), catalog);
}

test('A24: every capability id has a label in every Studio catalogue', () => {
  // Non-vacuous by construction: an empty registry would satisfy every loop below.
  assert.ok(CAPABILITY_IDS.length > 10, `only ${CAPABILITY_IDS.length} capabilities were derived`);

  const missing = [];
  for (const locale of CATALOGUES) {
    const catalog = catalogue(locale);
    for (const id of CAPABILITY_IDS) {
      const label = lookup(catalog, `capability.${id}`);
      if (typeof label !== 'string' || label.length === 0) {
        missing.push(`${locale}: capability.${id}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'tStrict throws in dev on each of these, taking the whole Roles tab down');
});

test('A24: every capability GROUP has a label, and the Studio renders all of them', () => {
  // A group the engine sends and the Studio does not know does not throw: `GROUP_ORDER` simply never
  // asks for it, so its whole block of checkboxes vanishes silently. That is the worse failure of the
  // two, because a checkbox nobody can see is a permission nobody can grant, and nothing says so.
  const groups = [...new Set(CAPABILITIES.map((c) => c.group))];
  assert.ok(groups.length >= 3, `only ${groups.length} groups were derived; the filter is wrong`);

  const missing = [];
  for (const locale of CATALOGUES) {
    const catalog = catalogue(locale);
    for (const group of groups) {
      const label = lookup(catalog, `members.roles.group.${group}`);
      if (typeof label !== 'string' || label.length === 0) missing.push(`${locale}: members.roles.group.${group}`);
    }
  }
  assert.deepEqual(missing, [], 'these groups have no label');

  // And the surface's own render order covers every group. Read out of the source rather than
  // imported, because `Members.tsx` is TSX and this is a node:test suite over `dist/`.
  const source = readFileSync(new URL('../../app/src/surfaces/Members/Members.tsx', import.meta.url), 'utf8');
  const declared = /const GROUP_ORDER: readonly RegistryEntry\['group'\]\[\] = \[([^\]]*)\]/.exec(source);
  assert.ok(declared !== null, 'GROUP_ORDER could not be read out of Members.tsx; this guard is measuring nothing');
  const rendered = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...rendered].sort(),
    [...groups].sort(),
    'GROUP_ORDER and the engine registry disagree, so a block of checkboxes renders nowhere',
  );
});

test('A24: the two catalogues carry the same capability keys as each other', () => {
  // The pairing above is engine-to-Studio. This one is locale-to-locale, and it catches the half a
  // single-locale author misses: a key added to `en` alone is green in a test that only ever looks
  // at what the engine needs, right up until somebody switches to de-CH.
  const keysOf = (locale) => Object.keys(catalogue(locale).capability ?? {}).sort();
  assert.deepEqual(keysOf('en'), keysOf('de-CH'), 'the capability catalogues have drifted apart');
});
