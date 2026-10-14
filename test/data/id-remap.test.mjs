/**
 * The G04 restore id chokepoint's STRING RULE, value by value (spec G04 §0c item 2). The list-free gate
 * (`restore-chokepoint.test.mjs`) proves the outcome over whole worlds; this suite pins the rule
 * itself, including what it must NEVER touch (prose, allowlisted natural keys, non-text values, every
 * byte of a JSON text that is not a rewritten id).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RestoreIdMap, AmbiguousReferenceError, NATURAL_KEY_COLUMNS } from '../../dist/core/data/idRemap.js';

const A = 'contact_1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const A2 = 'contact_9f1c2d34-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const B = 'account_6fa459ea-ee8a-3ca4-894e-db77e160355e';
const B2 = 'account_0c5d0b57-7c2f-4a55-9e3a-2a1f3c4d5e6f';
const WS = 'ws_16fd2706-8baf-433b-82eb-8c7fada847da';
const WS2 = 'ws_886313e1-3b8a-5372-9b90-0c9aee199e5d';

function map() {
  const m = new RestoreIdMap();
  m.add('contact', A, A2);
  m.add('account', B, B2);
  m.add('workspace', WS, WS2);
  return m;
}
const r = (value, table = 'captures', column = 'note') => map().remapValue(table, column, value);

test('a whole value equal to a re-minted id becomes the restored id; any other plain value is untouched', () => {
  assert.equal(r(A), A2);
  assert.equal(r(WS), WS2);
  assert.equal(r('contact_unknown'), 'contact_unknown');
  assert.equal(r(''), '');
  assert.equal(r('Beispiel Werkstatt AG'), 'Beispiel Werkstatt AG');
});

test('non-text values pass through: money, counts, null, BLOBs', () => {
  const m = map();
  assert.equal(m.remapValue('t', 'amount_minor', 12050), 12050);
  assert.equal(m.remapValue('t', 'x', null), null);
  const blob = Buffer.from(A, 'utf8');
  assert.equal(m.remapValue('t', 'content', blob), blob);
});

test('JSON: a JSON string, object values and object KEYS that name ids are rewritten; nothing else moves', () => {
  assert.equal(r(JSON.stringify(A)), JSON.stringify(A2));
  // Spacing, key order and number spelling survive byte for byte (a re-serialise would round 2^53+1).
  const text = `{ "vendor": "${A}",\n  "big": 9007199254740993, "n": 1.50, "k": {"${B}": [1, "${A}", "free text ${A}"]} }`;
  const want = `{ "vendor": "${A2}",\n  "big": 9007199254740993, "n": 1.50, "k": {"${B2}": [1, "${A2}", "free text ${A}"]} }`;
  assert.equal(r(text), want);
  // Escapes inside other strings are kept as written.
  assert.equal(r(`["a\\"b", "${A}", "\\u00fc"]`), `["a\\"b", "${A2}", "\\u00fc"]`);
});

test('JSON nested inside a JSON string is followed', () => {
  const inner = JSON.stringify({ accountId: B });
  const outer = JSON.stringify({ payload: inner, other: 'x' });
  assert.equal(JSON.parse(JSON.parse(r(outer)).payload).accountId, B2);
});

test('structured values: paths, composite keys, derived labels and keys, lists', () => {
  assert.equal(r(`/${A}/${B}/`), `/${A2}/${B2}/`);
  assert.equal(r(`${WS}:2026`), `${WS2}:2026`);
  assert.equal(r(`builtin:checklist_autostart:month_close:${WS}`), `builtin:checklist_autostart:month_close:${WS2}`);
  assert.equal(r(`po-artifact/${A}/rev1`), `po-artifact/${A2}/rev1`);
  assert.equal(r(`pain001-item-${A}`), `pain001-item-${A2}`);
  assert.equal(r(`ebics-ini-letter-${A}.txt`), `ebics-ini-letter-${A2}.txt`);
  assert.equal(r(`${A},${B}`), `${A2},${B2}`);
  assert.equal(r(`${A}, ${B}`), `${A2}, ${B2}`, 'a list of nothing but ids, spaced');
});

test('prose is never rewritten, even when it mentions an id', () => {
  const sentence = `duplicate_suspect: same date and amount as ${A}`;
  assert.equal(r(sentence), sentence);
  assert.equal(r(`Rechnungen an ${A} weiterleiten`), `Rechnungen an ${A} weiterleiten`);
  // Inside JSON too: a JSON string that is a sentence stays a sentence.
  assert.equal(r(JSON.stringify({ note: `see ${A} please` })), JSON.stringify({ note: `see ${A} please` }));
});

test('only a MINTED id (<prefix>_<n> or <prefix>_<uuid>) is resolved outside a foreign key: a natural id never is', () => {
  const m = new RestoreIdMap();
  // A table whose id were a natural value must not turn every equal value of the book into its new id.
  m.add('currency', 'CHF', 'currency_9');
  m.add('blob', 'a'.repeat(64), 'blob_9');
  m.add('agent_action', 'aa-approve', 'agent_action_2');
  assert.equal(m.remapValue('document', 'currency', 'CHF'), 'CHF');
  assert.equal(m.remapValue('stored_file', 'sha256', 'a'.repeat(64)), 'a'.repeat(64));
  assert.equal(m.remapValue('t', 'k', 'aa-approve'), 'aa-approve');
  assert.equal(m.remapValue('t', 'k', 'aa-approve-inner'), 'aa-approve-inner');
  // Sequence and uuid ids are minted, and a prefix may itself carry underscores.
  m.add('stocktake_line', 'stktakeln_11', 'stocktake_line_4');
  assert.equal(m.remapValue('t', 'k', 'seed:p19:stockcommit:1-ln-stktakeln_11'), 'seed:p19:stockcommit:1-ln-stocktake_line_4');
});

test('allowlisted natural keys are never rewritten, even when equal to a re-minted id', () => {
  assert.ok(Object.keys(NATURAL_KEY_COLUMNS).length > 10);
  for (const key of Object.keys(NATURAL_KEY_COLUMNS)) {
    const [table, column] = key.split('.');
    assert.equal(map().remapValue(table, column, A), A, key);
  }
});

test('an ambiguous source id (two tables) refuses when a value names it, and only then', () => {
  const m = new RestoreIdMap();
  m.add('document_line', 'line_1', 'document_line_9');
  m.add('journal_line', 'line_1', 'journal_line_9');
  assert.throws(() => m.remapValue('t', 'ref', 'line_1'), AmbiguousReferenceError);
  assert.throws(() => m.remapValue('t', 'ref', '{"line":"line_1"}'), AmbiguousReferenceError);
  assert.throws(() => m.remapValue('t', 'ref', '/line_1/'), AmbiguousReferenceError);
  // Prose that merely mentions it is prose: left alone, no refusal.
  assert.equal(m.remapValue('t', 'ref', 'see line_1 above'), 'see line_1 above');
  // Re-adding the same id for the same table is not ambiguity.
  const n = new RestoreIdMap();
  n.add('contact', A, A2);
  n.add('contact', A, A2);
  assert.equal(n.remapValue('t', 'ref', A), A2);
});
