// A34 money path: the run kind of a wage journal (D173, owner decision Q12, 15.10.2026, generation 14).
//
// `wage_journal_posts.run_kind` is regular (default), bonus, thirteenth or correction. The month guard
// counts ONLY regular postings: a standing regular journal blocks only a new regular post; a bonus, 13th
// or correction run never blocks and is never blocked. A posting written before generation 14 reads
// 'regular' through the column default.
//
// SYNTHETIC BY CONSTRUCTION: no employee, no name, no AHV number; an invented aggregate on the shipped
// KMU chart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postEntry } from '../../dist/core/ledger/index.js';
import { wageJournalPost, listPayrollHandoffs } from '../../dist/core/payroll/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { fixture } from '../api/conformance-contract.mjs';
import { setup, counts, wageLines, secondWorkspace } from './support.mjs';

const DATE = '2026-07-05';

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

const post = (ctx, key, runKind, extra = {}) =>
  wageJournalPost(ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: key, ...(runKind ? { runKind } : {}), ...extra });

const accountIdOf = (t, number) =>
  t.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(t.workspaceId, number).id;

const kindOf =(t, wjpId) => t.store.db.prepare('SELECT run_kind AS k FROM wage_journal_posts WHERE id = ?').get(wjpId).k;

test('D173 run_kind: the default is regular, stored on the row and shown by list_payroll_handoffs', () => {
  const t = setup();
  const p = must(post(t.ctx, 'a'));
  assert.equal(p.runKind, 'regular');
  assert.equal(kindOf(t, p.wageJournalPostId), 'regular');
  const listed = must(listPayrollHandoffs(t.ctx, {})).handoffs.find((h) => h.id === p.wageJournalPostId);
  assert.equal(listed.runKind, 'regular');
});

test('D173 run_kind: a bonus after a regular journal of the same month passes, and a second regular is still refused', () => {
  const t = setup();
  const regular = must(post(t.ctx, 'r1'));
  const bonus = must(post(t.ctx, 'b1', 'bonus'), 'bonus run');
  assert.equal(bonus.warnings, undefined, 'a bonus is not even warned about');
  assert.equal(kindOf(t, bonus.wageJournalPostId), 'bonus');
  must(post(t.ctx, 'thirteenth-1', 'thirteenth'), 'thirteenth');
  must(post(t.ctx, 'correction-1', 'correction', { runKindReason: 'Falscher Satz im Juni' }), 'correction (the default setting asks a correction for its reason, Q14)');
  const before = counts(t.store, t.workspaceId);
  const second = post(t.ctx, 'r2');
  assert.equal(second.error, 'month_already_posted');
  assert.deepEqual(second.standing.map((s) => s.wageJournalPostId), [regular.wageJournalPostId], 'only the regular journal is named');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  const listed = must(listPayrollHandoffs(t.ctx, {})).handoffs.filter((h) => h.type === 'posting').map((h) => h.runKind).sort();
  assert.deepEqual(listed, ['bonus', 'correction', 'regular', 'thirteenth']);
});

test('D173 run_kind: a regular journal after a bonus of the same month passes (a bonus never blocks)', () => {
  const t = setup();
  must(post(t.ctx, 'b1', 'bonus'));
  must(post(t.ctx, 'b2', 'bonus'), 'a second bonus is not blocked either');
  const regular = must(post(t.ctx, 'r1'), 'regular after bonus');
  assert.equal(regular.warnings, undefined);
  // Under warn, the preview of a regular run names only regular journals.
  must(settingsSet(t.ctx, { key: 'payroll.month_guard', value: 'warn', reason: 'Test', idempotencyKey: 'w' }));
  const pv = must(wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'pv' }));
  assert.deepEqual(pv.warnings[0].standing.map((s) => s.wageJournalPostId), [regular.wageJournalPostId]);
});

test('D173 run_kind: a posting row written before generation 14 (no run_kind given) counts as regular', () => {
  const t = setup();
  const e = must(postEntry(t.ctx, {
    date: DATE, source: 'import', description: 'Lohnbuchung (vor Generation 14)', idempotencyKey: 'legacy-je',
    lines: [{ account: accountIdOf(t, '5000'), debit: 1000 }, { account: accountIdOf(t, '2260'), credit: 1000 }],
  }), 'legacy entry');
  t.store.db
    .prepare(
      `INSERT INTO wage_journal_posts (id, workspace_id, posted_entry_id, entry_date, mapping_id, source_sha256, line_count, actor, created_at)
       VALUES ('wjp_legacy', ?, ?, ?, NULL, NULL, 2, 'user_1', '2026-07-06T08:00:00.000Z')`,
    )
    .run(t.workspaceId, e.entryId, DATE);
  assert.equal(kindOf(t, 'wjp_legacy'), 'regular', 'the column default');
  const refused = post(t.ctx, 'r1');
  assert.equal(refused.error, 'month_already_posted', 'the legacy row blocks a regular post');
  assert.equal(refused.wageJournalPostId, 'wjp_legacy');
  must(post(t.ctx, 'b1', 'bonus'), 'and does not block a bonus');
});

test('D173 run_kind: the column CHECK refuses an unknown kind; the verb refuses it invalid_input, writing nothing', () => {
  const t = setup();
  const before = counts(t.store, t.workspaceId);
  const bad = post(t.ctx, 'x', 'holiday');
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'runKind');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  const p = must(post(t.ctx, 'a'));
  assert.throws(
    () => t.store.db.prepare("INSERT INTO wage_journal_posts (id, workspace_id, posted_entry_id, entry_date, line_count, actor, created_at, run_kind) VALUES ('wjp_bad', ?, ?, ?, 1, 'u', 'x', 'holiday')")
      .run(t.workspaceId, p.postedEntryId, DATE),
    /CHECK constraint failed/,
  );
});

test('D173 run_kind §H-TENANT and replay: another book\'s regular journal does not block; a replay keeps the kind', () => {
  const t = setup();
  const other = secondWorkspace(t);
  const theirs = wageJournalPost(other.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'o' });
  must(theirs, 'the other book posts its own regular journal for the month');
  const bonus = must(post(t.ctx, 'b1', 'bonus'));
  const before = counts(t.store, t.workspaceId);
  const replay = must(post(t.ctx, 'b1', 'bonus'));
  assert.equal(replay.wageJournalPostId, bonus.wageJournalPostId);
  assert.equal(replay.runKind, 'bonus');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'idempotent on ROWS');
  must(post(t.ctx, 'r1'), 'this book\'s first regular journal');
});

test('D173 run_kind on the REST and MCP faces: the input schema names the four kinds; a bonus posts next to a regular', () => {
  const schema = getAction('wage_journal_post').inputSchema.properties.runKind;
  assert.deepEqual(schema.enum, ['regular', 'bonus', 'thirteenth', 'correction']);
  const fx = fixture();
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '5700', debitMinor: 50000 },
    { accountNumber: '2260', creditMinor: 550000 },
  ];
  const base = { workspaceId: fx.workspaceId, lines, entryDate: DATE, confirm: true };
  must(fx.call('wage_journal_post', { ...base, idempotencyKey: 'f-1' }));
  const rest = handleRest('wage_journal_post', { ...base, runKind: 'thirteenth', idempotencyKey: 'f-13' }, fx.deps).body;
  assert.equal(rest.ok, true, JSON.stringify(rest));
  assert.notEqual(rest.error, 'month_already_posted');
});
