// @ts-check
// A03 §7 regression tripwires (R3-style): the closing entry and the audit log are unalterable by
// construction, not just by convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as ledger from '../../dist/core/ledger/index.js';
import * as auditLog from '../../dist/core/ledger/auditLog.js';
import { postEntry, hardCloseYear } from '../../dist/core/ledger/index.js';
import { setup, entry } from './a03-support.mjs';
import { row, str } from '../support/narrow.mjs';

test('a posted source=close entry is immutable at the DB layer (no update, no delete)', () => {
  const { ctx, store, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 10000, date: '2026-05-01', idempotencyKey: 'inc' }));
  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true);

  const closeEntry = row(
    store.db.prepare("SELECT id FROM journal_entry WHERE source = 'close' LIMIT 1").get(),
    'a close entry exists',
  );
  const closeEntryId = str(closeEntry.id, 'close entry id');

  assert.throws(
    () => store.db.prepare("UPDATE journal_entry SET description = 'tampered' WHERE id = ?").run(closeEntryId),
    /posted_immutable/,
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(closeEntryId),
    /posted_immutable/,
  );
});

test('the audit surface exposes append + read only: no update or delete verb (append-only by construction)', () => {
  const fns = Object.keys(auditLog).filter((k) => typeof auditLog[k] === 'function');
  // The only writer is appendAuditLog; getAuditLog reads. There is deliberately no mutate/delete path.
  for (const name of fns) {
    assert.ok(
      !/update|delete|edit|remove|mutate/i.test(name),
      `audit surface must expose no mutation verb, found: ${name}`,
    );
  }
  assert.ok(fns.includes('appendAuditLog'));
  assert.ok(fns.includes('getAuditLog'));
});

test('the ledger index likewise exposes no audit-log mutation verb', () => {
  const fns = Object.keys(ledger).filter((k) => typeof ledger[k] === 'function');
  assert.equal(fns.filter((n) => /auditLog/i.test(n)).sort().join(','), 'appendAuditLog,getAuditLog');
});
