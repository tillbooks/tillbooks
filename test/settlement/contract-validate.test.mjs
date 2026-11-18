// A43 section 5: validate_settlement, the contract's agent door. It runs the import's reader and WRITES
// NOTHING. SYNTHETIC DATA ONLY (see contract-corpus.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { validateSettlement } from '../../dist/api/settlement-format-actions.js';
import { assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, must, refused } from './support.mjs';
import { CASES } from './contract-corpus.mjs';

afterEach(assertClaimInvariantHolds);

/** The row count of every table, so "writes nothing" is stated for the whole book. */
function everyTableCount(store) {
  const out = {};
  for (const { name } of store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    out[name] = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  }
  return out;
}

test('[INVARIANT read-only] validate_settlement writes zero rows, on a valid and on a refused document', () => {
  // Guards settlement-format-actions.ts: it is a read verb and calls the reader only.
  const t = settlementWorld();
  const before = everyTableCount(t.store);
  for (const c of CASES.slice(0, 12)) {
    validateSettlement(t.ctx, c.doc.constructor === Object ? { settlement: c.doc } : { content: JSON.stringify(c.doc) });
  }
  assert.deepEqual(everyTableCount(t.store), before);
  assert.equal(getAction('validate_settlement').kind, 'read');
});

test('a valid document: valid true, totals by kind, nothing refused', () => {
  const t = settlementWorld();
  const full = CASES.find((c) => c.name.startsWith('every kind'));
  const res = must(validateSettlement(t.ctx, { settlement: full.doc }));
  assert.equal(res.valid, true);
  assert.equal(res.system, 'demoshop');
  assert.equal(res.currency, 'CHF');
  assert.deepEqual({ total: res.events.total, readable: res.events.readable, refused: res.events.refused }, { total: 10, readable: 10, refused: 0 });
  assert.deepEqual(res.events.byKind['sale'], { count: 1, amountMinor: 10810 });
  assert.equal(res.events.firstDay, '2026-07-03');
  assert.equal(res.events.lastDay, '2026-07-08');
});

test('every corpus case gets the reader code: a file-level one refuses the call, an event-level one is listed', () => {
  const t = settlementWorld();
  for (const c of CASES) {
    const res = validateSettlement(t.ctx, { settlement: c.doc.constructor === Object ? c.doc : undefined, content: c.doc.constructor === Object ? undefined : JSON.stringify(c.doc) });
    if (c.refusal === null) {
      assert.equal(must(res).valid, true, c.name);
    } else if (['invalid_settlement', 'unsupported_schema'].includes(c.refusal)) {
      refused(res, c.refusal);
    } else {
      const ok = must(res);
      assert.equal(ok.valid, false, c.name);
      assert.equal(ok.refused[0].code, c.refusal, c.name);
    }
  }
});

test('content (text) works, bad text and both or neither input are refused', () => {
  const t = settlementWorld();
  const good = CASES[1].doc;
  assert.equal(must(validateSettlement(t.ctx, { content: JSON.stringify(good) })).valid, true);
  refused(validateSettlement(t.ctx, { content: '{not json' }), 'invalid_settlement');
  refused(validateSettlement(t.ctx, {}), 'invalid_input');
  refused(validateSettlement(t.ctx, { settlement: good, content: JSON.stringify(good) }), 'invalid_input');
});

test('the REST twin answers the same', () => {
  const t = settlementWorld();
  const viaRest = handleRest('validate_settlement', { workspaceId: t.workspaceId, settlement: CASES[1].doc }, t.deps);
  assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
  assert.equal(viaRest.body.valid, true);
});

test('the echoed warnings are capped at 200 (critic L2)', () => {
  const t = settlementWorld();
  const doc = { ...CASES[1].doc, warnings: Array.from({ length: 500 }, (_, i) => `note ${i}`) };
  const res = must(validateSettlement(t.ctx, { settlement: doc }));
  assert.equal(res.warnings.length, 200);
  assert.equal(res.warningsTruncated, true);
  assert.equal(must(validateSettlement(t.ctx, { settlement: CASES[1].doc })).warningsTruncated, false);
});
