import test from 'node:test';
import assert from 'node:assert/strict';

import { systemIdGen, sequenceIdGen } from '../../dist/core/ids.js';

test('systemIdGen prefixes the id and never repeats', () => {
  const a = systemIdGen.next('ws');
  const b = systemIdGen.next('ws');
  assert.match(a, /^ws_/);
  assert.match(b, /^ws_/);
  assert.notEqual(a, b);
});

test('sequenceIdGen is deterministic per prefix, for reproducible tests', () => {
  const gen = sequenceIdGen();
  assert.equal(gen.next('entry'), 'entry_1');
  assert.equal(gen.next('entry'), 'entry_2');
  // counters are per-prefix so ids stay readable in fixtures
  assert.equal(gen.next('ws'), 'ws_1');
  assert.equal(gen.next('entry'), 'entry_3');
});
