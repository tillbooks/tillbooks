/**
 * G17's structural claims, asserted over the registry, the schema and the router source: G17 mints
 * NO write verb, NO table and NO route. This is what makes the product-tour genre unbuildable
 * rather than merely banned (design §7b): every mechanism in that genre needs somewhere to remember
 * what you dismissed, and G17 has nowhere of its own to put one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { ACTIONS } from '../../dist/api/registry.js';
import { SCHEMA_SQL } from '../../dist/core/store/schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const G17_VERBS = ['list_concepts', 'get_concept'];

test('G17 mints exactly two verbs and both are reads (rows 3.4 / 9.3)', () => {
  const conceptVerbs = ACTIONS.filter((a) => /concept|begriff|guidance/i.test(a.name));
  assert.deepEqual(
    conceptVerbs.map((a) => a.name).sort(),
    [...G17_VERBS].sort(),
    'a new guidance-flavoured verb must be argued into the spec first: the two-reads shape is load-bearing',
  );
  for (const a of conceptVerbs) {
    assert.equal(a.kind, 'read', `${a.name}: G17 mints no write verb, asserted, not documented`);
  }
});

test('G17 owns no table: the schema carries no guidance or concept surface', () => {
  assert.ok(
    !/CREATE TABLE[^(]*\b(concept|guidance|begriff)/i.test(SCHEMA_SQL),
    'G17 stores nothing; a guidance table would be the seed the tour genre grows from',
  );
});

test('G17 adds no route: no help, glossary or Begriffe destination in the nav model', () => {
  const nav = readFileSync(join(ROOT, 'app/src/app/nav.ts'), 'utf8');
  assert.ok(
    !/['"`]\/(hilfe|help|glossar|begriffe|concepts)['"`]/i.test(nav),
    'guidance lives where the question is, never at a destination (design §2b)',
  );
});
