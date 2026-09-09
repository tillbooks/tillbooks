// A34 money-path invariants. These are the assertions a non-author critic verifies BITE: each one
// fails if the guard it names is removed.
//
//   - wage_journal_post POSTS via A02 (source='import'), append-only, balanced, ONE entry
//   - idempotent on ROWS: a re-post with the same key posts ONE journal entry and writes ONE
//     wage_journal_posts row (asserted on COUNTS, not a return flag)
//   - the P8 preview writes nothing and does not consume the key
//   - an unbalanced set is refused with diffRappen and posts NOTHING (zero rows)
//   - a locked period refuses (§H-PERIOD) with no partial post
//   - P3: the wage journal reaches the ledger ONLY through A02 postEntry, incl. the agent lines[] path
//   - the `post` capability is required; without it, zero rows
//   - the export/posting histories are append-only: a raw UPDATE/DELETE is refused at the DB layer
//   - §H-TENANT: a foreign workspace's exports and postings are invisible

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockPeriod } from '../../dist/core/ledger/index.js';
import { wageJournalPost, listPayrollHandoffs } from '../../dist/core/payroll/index.js';
import { uploadFile } from '../../dist/core/files/index.js';
import { setup, capCtx, counts, wageLines, secondWorkspace } from './support.mjs';

const DATE = '2026-07-05';

/** The posted net (debit minus credit) on an account number, for the posting entry only. */
function accountNet(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).net;
}

test('A34: wage_journal_post posts ONE balanced entry via A02, source=import, records a wage_journal_posts row', () => {
  const t = setup();
  const before = counts(t.store, t.workspaceId);

  const res = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.postedEntryId, 'no posted entry id');
  assert.equal(res.entryId, res.postedEntryId, 'entryId mirrors postedEntryId (for the automation event path)');

  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'exactly ONE journal entry posted');
  assert.equal(after.postings, before.postings + 1, 'exactly ONE wage_journal_posts row');
  assert.equal(after.journalLines, before.journalLines + 3, 'the three wage lines posted');

  const entry = t.store.db.prepare('SELECT source, status FROM journal_entry WHERE id = ?').get(res.postedEntryId);
  assert.equal(entry.source, 'import', 'the wage journal posts with source=import');
  assert.equal(entry.status, 'posted');

  const bal = t.store.db
    .prepare('SELECT COALESCE(SUM(base_debit_minor),0) d, COALESCE(SUM(base_credit_minor),0) c FROM journal_line WHERE entry_id = ?')
    .get(res.postedEntryId);
  assert.equal(bal.d, bal.c, 'the entry balances');
  assert.equal(accountNet(t.store, t.workspaceId, '5000'), 500000, '5000 debited the gross wage');
  assert.equal(accountNet(t.store, t.workspaceId, '2260'), -550000, '2260 credited the net + social liability');

  const row = t.store.db.prepare('SELECT posted_entry_id, line_count FROM wage_journal_posts WHERE workspace_id = ?').get(t.workspaceId);
  assert.equal(row.posted_entry_id, res.postedEntryId, 'the posting row points at the posted entry');
  assert.equal(row.line_count, 3);
});

test('A34: wage_journal_post is IDEMPOTENT ON ROWS: a re-post with the same key posts ONE entry and ONE row', () => {
  const t = setup();
  const first = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-dup' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const mid = counts(t.store, t.workspaceId);

  const second = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-dup' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.postedEntryId, first.postedEntryId, 'the replay returns the ORIGINAL posted entry');

  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, mid.entries, 'the ledger moved ONCE: no second journal entry');
  assert.equal(after.postings, mid.postings, 'no second wage_journal_posts row');
  assert.equal(after.journalLines, mid.journalLines, 'no second set of journal lines');
});

test('A34 P8: the dial-off preview writes NOTHING and does not consume the key, so confirm:true then posts', () => {
  const t = setup();
  const before = counts(t.store, t.workspaceId);

  const preview = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'wjp-p8' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.ok(preview.preview, 'the preview payload is returned');
  assert.equal(preview.preview.balanced, true);
  assert.equal(preview.preview.totalDebitMinor, 550000);
  assert.equal(preview.postedEntryId, undefined, 'the preview posts nothing');

  const mid = counts(t.store, t.workspaceId);
  assert.deepEqual(mid, before, 'the preview wrote NOTHING (no entry, no posting row, no file)');

  // The SAME key still posts: the preview did not consume it.
  const posted = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-p8' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'the confirmed post lands one entry under the preview key');
});

test('A34: an UNBALANCED set is refused with diffRappen and posts NOTHING', () => {
  const t = setup();
  const before = counts(t.store, t.workspaceId);
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '2260', creditMinor: 400000 }, // 1'000.00 short
  ];
  const res = wageJournalPost(t.ctx, { lines, entryDate: DATE, confirm: true, idempotencyKey: 'wjp-unb' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unbalanced');
  assert.equal(res.diffRappen, 100000, 'the Rappen difference is reported');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a refused post writes zero rows');
});

test('A34 §H-PERIOD: a locked period refuses (period_locked) with no partial post', () => {
  const t = setup();
  const lock = lockPeriod(t.ctx, { period: '2026-07', kind: 'hard', idempotencyKey: 'lk' });
  assert.equal(lock.ok, true, JSON.stringify(lock));
  const before = counts(t.store, t.workspaceId);

  const res = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-lock' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a period-locked post writes zero rows');
});

test('A34 P3 + capability: without `post` the wage journal is refused and nothing reaches the ledger', () => {
  const t = setup();
  const noPost = capCtx(t, 'clerk', ['hr.read', 'hr.manage']);
  const before = counts(t.store, t.workspaceId);
  const res = wageJournalPost(noPost, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-noperm' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'permission_denied');
  assert.equal(res.capability, 'post');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a permission-denied post writes zero rows');
});

test('A34: an unknown account is refused before posting (zero rows)', () => {
  const t = setup();
  const before = counts(t.store, t.workspaceId);
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '9999', creditMinor: 500000 }, // not in the chart
  ];
  const res = wageJournalPost(t.ctx, { lines, entryDate: DATE, confirm: true, idempotencyKey: 'wjp-badacct' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_account');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'an unknown account posts zero rows');
});

test('A34 append-only: a raw UPDATE or DELETE of a posting row is refused at the DB layer', () => {
  const t = setup();
  const res = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-immut' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.throws(
    () => t.store.db.prepare('UPDATE wage_journal_posts SET line_count = 99 WHERE workspace_id = ?').run(t.workspaceId),
    /wage_journal_post_immutable/,
    'a posting row cannot be updated',
  );
  assert.throws(
    () => t.store.db.prepare('DELETE FROM wage_journal_posts WHERE workspace_id = ?').run(t.workspaceId),
    /wage_journal_post_immutable/,
    'a posting row cannot be deleted',
  );
});

test('A34 P3: the fileRef (provider CSV) path reaches the ledger ONLY through A02, one balanced entry', () => {
  const t = setup();
  const csv = [
    '# Lohnlauf Juli 2026',
    'account_number,debit_rappen,credit_rappen,description',
    '5000,500000,0,Bruttolohn',
    '5700,50000,0,AG-Sozialbeitraege',
    '2260,0,550000,Nettolohn',
  ].join('\n');
  const up = uploadFile(t.ctx, { contentBase64: Buffer.from(csv, 'utf8').toString('base64'), mime: 'text/csv', filename: 'lohn.csv', title: 'Lohnlauf' });
  assert.equal(up.ok, true, JSON.stringify(up));
  const before = counts(t.store, t.workspaceId);

  // Preview first (writes nothing), then post.
  const preview = wageJournalPost(t.ctx, { fileRef: up.file.id, entryDate: DATE, idempotencyKey: 'wjp-file' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.preview.balanced, true);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'the file preview wrote nothing');

  const posted = wageJournalPost(t.ctx, { fileRef: up.file.id, entryDate: DATE, mappingId: 'Lohnlauf Provider X', confirm: true, idempotencyKey: 'wjp-file' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'the CSV posted exactly one entry');
  const entry = t.store.db.prepare('SELECT source FROM journal_entry WHERE id = ?').get(posted.postedEntryId);
  assert.equal(entry.source, 'import', 'the CSV path posts with source=import (P3: via A02)');
  const row = t.store.db.prepare('SELECT mapping_id, source_sha256 FROM wage_journal_posts WHERE posted_entry_id = ?').get(posted.postedEntryId);
  assert.equal(row.mapping_id, 'Lohnlauf Provider X', 'the mapping label is recorded for provenance');
  assert.ok(row.source_sha256, 'the provider file hash is recorded');
});

test('A34 §H-TENANT: another workspace cannot see this workspace\'s wage postings', () => {
  const t = setup();
  const posted = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: 'wjp-tenant' });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const other = secondWorkspace(t);
  const list = listPayrollHandoffs(other.ctx, {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.total, 0, 'the foreign workspace sees none of this workspace\'s postings');
});
