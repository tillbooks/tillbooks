// @ts-check
// A03 US-A03.1 / US-A03.5: the append-only, hash-chained audit log.
//
// The chain is `hash = H(prev_hash || canonical(row))`, verified on every read (never a stored flag).
// A post stamps a row; there is NO update/delete path; any mutation breaks the chain and getAuditLog
// reports chainVerified:false with the broken row's id.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry, appendAuditLog, getAuditLog, ledgerPorts } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { setup, entry } from './a03-support.mjs';
import { at, id, objs, okOf, row, rows as sqlRows, str } from '../support/narrow.mjs';

/** The success payload `getAuditLog` reports, with its `rows` proved to be a list of rows. */
const auditLog = (c, filter = {}) => {
  const res = okOf(getAuditLog(c, filter), 'getAuditLog');
  return { chainVerified: res.chainVerified, brokenAtId: res.brokenAtId, rows: objs(res.rows, 'getAuditLog.rows') };
};

test('every posted entry is stamped with created_by / created_at and an audit row', () => {
  const { ctx, store, byNumber } = setup();
  const posted = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 5000, date: '2026-03-01', idempotencyKey: 'k1' }));
  assert.equal(posted.ok, true);

  const stamped = row(
    store.db.prepare('SELECT created_by, created_at FROM journal_entry WHERE id = ?').get(id(posted, 'entryId', 'postEntry')),
    'the posted entry row',
  );
  assert.equal(stamped.created_by, 'user_1');
  assert.ok(stamped.created_at, 'created_at is stamped');

  // The chain opens with the workspace-create genesis row (A00 stamps it), then the post.
  const full = auditLog(ctx);
  assert.equal(full.chainVerified, true);
  assert.equal(at(full.rows, 0, 'getAuditLog.rows').action, 'create');
  assert.equal(at(full.rows, 0, 'getAuditLog.rows').entityKind, 'workspace');

  const entries = auditLog(ctx, { entityKind: 'entry' });
  assert.equal(entries.rows.length, 1);
  assert.equal(at(entries.rows, 0, 'getAuditLog.rows').entityId, id(posted, 'entryId', 'postEntry'));
  assert.equal(at(entries.rows, 0, 'getAuditLog.rows').action, 'post');
  assert.equal(at(entries.rows, 0, 'getAuditLog.rows').actor, 'user_1');
});

test('a reversal records its own action=reverse row referencing the correction', () => {
  const { ctx, byNumber } = setup();
  const posted = postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 5000, date: '2026-03-01', idempotencyKey: 'k1' }));
  const rev = reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'r1' });
  assert.equal(rev.ok, true);

  const entries = auditLog(ctx, { entityKind: 'entry' });
  assert.deepEqual(entries.rows.map((r) => r.action), ['post', 'reverse']);
  assert.equal(at(entries.rows, 1, 'getAuditLog.rows').entityId, id(rev, 'reversalId', 'reverseEntry'));
  assert.equal(auditLog(ctx).chainVerified, true);
});

test('the hash chain links each row to the previous one', () => {
  const { ctx, store, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 200, date: '2026-03-02', idempotencyKey: 'k2' }));

  // Genesis (workspace create) + two posts = three chained rows.
  const chain = sqlRows(
    store.db.prepare('SELECT prev_hash, hash FROM audit_log ORDER BY rowid ASC').all(),
    'the audit chain',
  );
  assert.equal(chain.length, 3);
  const link = (i) => at(chain, i, 'the audit chain');
  assert.equal(link(0).prev_hash, null, 'the genesis row has no predecessor');
  assert.equal(link(1).prev_hash, link(0).hash, 'row 2 chains to row 1');
  assert.equal(link(2).prev_hash, link(1).hash, 'row 3 chains to row 2');
  assert.notEqual(link(0).hash, link(1).hash);
});

test('getAuditLog reports chainVerified:false and brokenAtId when a row is tampered', () => {
  const { ctx, store, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 200, date: '2026-03-02', idempotencyKey: 'k2' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 300, date: '2026-03-03', idempotencyKey: 'k3' }));

  // Tamper with the middle row's payload without recomputing the chain.
  const midId = str(
    row(store.db.prepare('SELECT id FROM audit_log ORDER BY rowid ASC LIMIT 1 OFFSET 1').get(), 'the middle audit row').id,
    'audit_log.id',
  );
  store.db.prepare("UPDATE audit_log SET actor = 'attacker' WHERE id = ?").run(midId);

  const log = auditLog(ctx);
  assert.equal(log.chainVerified, false);
  assert.equal(log.brokenAtId, midId);
});

test('deleting a row breaks the chain at the row whose prev_hash no longer matches', () => {
  const { ctx, store, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 200, date: '2026-03-02', idempotencyKey: 'k2' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 300, date: '2026-03-03', idempotencyKey: 'k3' }));

  const midId = str(
    row(store.db.prepare('SELECT id FROM audit_log ORDER BY rowid ASC LIMIT 1 OFFSET 1').get(), 'the middle audit row').id,
    'audit_log.id',
  );
  const thirdId = str(
    row(store.db.prepare('SELECT id FROM audit_log ORDER BY rowid ASC LIMIT 1 OFFSET 2').get(), 'the third audit row').id,
    'audit_log.id',
  );
  store.db.prepare('DELETE FROM audit_log WHERE id = ?').run(midId);

  const log = auditLog(ctx);
  assert.equal(log.chainVerified, false);
  // The third row now follows the genesis row, so its prev_hash mismatches.
  assert.equal(log.brokenAtId, thirdId);
});

test('getAuditLog filters by entityKind / from / to but verifies the whole chain', () => {
  const { ctx, byNumber } = setup();
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 200, date: '2026-03-02', idempotencyKey: 'k2' }));

  const none = auditLog(ctx, { entityKind: 'period_lock' });
  assert.equal(none.rows.length, 0);
  assert.equal(none.chainVerified, true, 'an empty filter result still verifies the chain');
});

test('appendAuditLog and the post stamp start the same chain deterministically', () => {
  const { ctx, workspaceId, store } = setup();
  const r1 = appendAuditLog({ store, workspaceId, ids: ctx.ids }, {
    entityKind: 'period_lock',
    entityId: '2026-06',
    action: 'lock',
    actor: 'user_1',
    at: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(r1.ok, true);
  assert.ok(r1.hash);

  // The workspace-create genesis row is already present, so the manual append extends the chain to two.
  const log = auditLog(ctx);
  assert.equal(log.chainVerified, true);
  assert.equal(log.rows.length, 2);
  assert.equal(at(log.rows, 1, 'getAuditLog.rows').entityKind, 'period_lock');
});

test('the audit log is workspace-scoped: another workspace cannot see or affect this chain', () => {
  const { ctx, store, ids, clock, byNumber } = setup();

  // A second workspace in the SAME store, so isolation is by workspace_id, not by a separate db.
  const mintedB = createWorkspace({ store, clock, ids }, { name: 'Beta AG', fiscalYearStart: '01-01' });
  const wsB = id(mintedB, 'workspaceId', 'createWorkspace');
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'user_2', clock, ids, ...ledgerPorts({ store, workspaceId: wsB, ids }) });

  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1000', amount: 100, date: '2026-03-01', idempotencyKey: 'k1' }));

  // Each workspace carries only its own genesis create row; B never sees A's post.
  const logB = auditLog(ctxB);
  assert.equal(logB.rows.length, 1, 'workspace B sees only its own create row');
  assert.equal(at(logB.rows, 0, 'getAuditLog.rows').action, 'create');
  assert.equal(at(logB.rows, 0, 'getAuditLog.rows').entityId, wsB);
  assert.equal(logB.chainVerified, true);
  assert.equal(auditLog(ctxB, { entityKind: 'entry' }).rows.length, 0, 'none of A entries leak into B');

  const logA = auditLog(ctx);
  assert.equal(logA.rows.length, 2, 'A: its create row plus its post');
  assert.equal(logA.chainVerified, true);
});
