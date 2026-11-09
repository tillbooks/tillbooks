/**
 * G17's two read verbs: the structured `not_found` (never a generated body), locale handling, the
 * per-token matching that makes a question-shaped query still surface a definition, and the
 * registry-level shape (both workspace-free, both reads, summaries naming the corpus as the wording
 * of record).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { listConcepts, getConcept, CONCEPTS } from '../../dist/core/guidance/index.js';
import { getAction } from '../../dist/api/registry.js';

test('get_concept returns the authored body in the requested locale', () => {
  const de = getConcept({ key: 'saldosteuersatz' });
  assert.equal(de.ok, true);
  assert.equal(de.locale, 'de-CH');
  assert.equal(de.concept.term, 'Saldosteuersatz');
  const en = getConcept({ key: 'saldosteuersatz', locale: 'en' });
  assert.equal(en.ok, true);
  const entry = CONCEPTS.find((c) => c.key === 'saldosteuersatz');
  assert.equal(en.concept.body, entry.body.en, 'the payload IS the corpus string, never a paraphrase');
  assert.equal(de.concept.body, entry.body['de-CH']);
});

test('get_concept resolves seeAlso to {key, term} so a client renders related terms without a second call', () => {
  const r = getConcept({ key: 'saldosteuersatz', locale: 'de-CH' });
  assert.equal(r.ok, true);
  assert.ok(r.concept.seeAlso.length >= 1 && r.concept.seeAlso.length <= 4);
  for (const s of r.concept.seeAlso) {
    assert.ok(typeof s.key === 'string' && typeof s.term === 'string' && s.term !== s.key, JSON.stringify(s));
  }
});

test('an unknown key is a structured not_found naming the nearest keys, never a generated body (rows 7.2/7.3)', () => {
  const r = getConcept({ key: 'saldo' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
  assert.ok(Array.isArray(r.nearest) && r.nearest.includes('saldosteuersatz'), JSON.stringify(r.nearest));
  assert.ok(!('concept' in r), 'a miss carries no body at all');
});

test('an invalid locale is refused, not silently defaulted', () => {
  const r = getConcept({ key: 'vorsteuer', locale: 'fr-CH' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_locale');
});

test('list_concepts matches per token, so a question still surfaces the definition (design §3d)', () => {
  const r = listConcepts({ query: 'soll ich saldo wählen' });
  assert.equal(r.ok, true);
  assert.ok(
    r.concepts.some((c) => c.key === 'saldosteuersatz'),
    `the saldo token surfaces the row: ${JSON.stringify(r.concepts)}`,
  );
  // And a list row is a NAME, never a paragraph.
  for (const c of r.concepts) {
    assert.deepEqual(Object.keys(c).sort(), ['area', 'key', 'term']);
  }
});

test('list_concepts with no query lists the whole corpus; with a no-match query it returns zero rows', () => {
  const all = listConcepts({});
  assert.equal(all.ok, true);
  assert.equal(all.total, CONCEPTS.length);
  const none = listConcepts({ query: 'xyzzy' });
  assert.equal(none.ok, true);
  assert.equal(none.total, 0);
});

test('both verbs are registered as workspace-free reads and get_concept names the corpus as the wording of record', () => {
  for (const name of ['list_concepts', 'get_concept']) {
    const action = getAction(name);
    assert.ok(action !== undefined, `${name} is registered`);
    assert.equal(action.kind, 'read');
    assert.ok(
      !action.inputSchema.required.includes('workspaceId') && !('workspaceId' in (action.inputSchema.properties ?? {})),
      `${name}: workspace-free, deliberately (the corpus is identical in every workspace)`,
    );
  }
  const summary = getAction('get_concept').summary;
  assert.ok(/wording of record/i.test(summary), 'the summary is the one lever against an agent answering from its own weights (row 7.3)');
});
