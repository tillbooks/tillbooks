import test from 'node:test';
import assert from 'node:assert/strict';

import { ok, err } from '../../dist/core/result.js';

test('ok spreads fields alongside ok:true', () => {
  assert.deepEqual(ok({ entryId: 'e1' }), { ok: true, entryId: 'e1' });
});

test('ok with no fields is just ok:true', () => {
  assert.deepEqual(ok(), { ok: true });
});

test('err names the error code under `error` and spreads extra context', () => {
  assert.deepEqual(err('unbalanced', { diff: 50 }), {
    ok: false,
    error: 'unbalanced',
    diff: 50,
  });
});

test('err with no extra is just ok:false + error', () => {
  assert.deepEqual(err('not_found'), { ok: false, error: 'not_found' });
});

test('err cannot be tricked into overwriting ok or error via extra', () => {
  // extra must not be able to flip ok:false to true or rename the code
  const r = err('period_locked', { ok: true, error: 'nope', period: '2026-01' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(r.period, '2026-01');
});
