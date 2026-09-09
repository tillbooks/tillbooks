// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry } from '../../dist/core/ledger/index.js';
import { setup } from './support.mjs';
import { id, numCol, strCol } from '../support/narrow.mjs';

const post = (ctx, accounts) =>
  postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: [
      { account: accounts['6500'], debit: 5000 },
      { account: accounts['1000'], credit: 5000 },
    ],
  });

test('R3: a posted entry cannot be UPDATEd, even by raw SQL', () => {
  const { ctx, store, accounts } = setup();
  const p = post(ctx, accounts);
  assert.throws(
    () => store.db.prepare("UPDATE journal_entry SET description = 'tamper' WHERE id = ?").run(p.entryId),
    /posted_immutable/,
  );
});

test('R3: a posted entry cannot be DELETEd, even by raw SQL', () => {
  const { ctx, store, accounts } = setup();
  const p = post(ctx, accounts);
  assert.throws(
    () => store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(p.entryId),
    /posted_immutable/,
  );
});

test('R3: a line cannot be added to a posted entry (no post-hoc unbalancing)', () => {
  const { ctx, store, accounts } = setup();
  const p = post(ctx, accounts);
  assert.throws(
    () =>
      store.db
        .prepare(
          `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor)
           VALUES ('l_x', ?, ?, 100, 0, 100, 0)`,
        )
        .run(p.entryId, accounts['6500']),
    /posted_immutable/,
  );
});

test('R3: a posted line cannot be UPDATEd or DELETEd', () => {
  const { ctx, store, accounts } = setup();
  const p = post(ctx, accounts);
  const lineId = strCol(
    store.db.prepare('SELECT id FROM journal_line WHERE entry_id = ? LIMIT 1').get(id(p, 'entryId', 'postEntry')),
    'id',
    'the first posted line',
  );
  assert.throws(
    () => store.db.prepare('UPDATE journal_line SET debit_minor = 999 WHERE id = ?').run(lineId),
    /posted_immutable/,
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM journal_line WHERE id = ?').run(lineId),
    /posted_immutable/,
  );
});

test('drafts remain freely mutable: the triggers seal posted rows only', () => {
  const { store } = setup();
  store.db
    .prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES ('e_d', 'ws_1', '2026-03-01', 'draft', 'manual', '2026-07-16T00:00:00.000Z')",
    )
    .run();
  // neither of these should throw
  store.db.prepare("UPDATE journal_entry SET description = 'ok' WHERE id = 'e_d'").run();
  store.db.prepare("DELETE FROM journal_entry WHERE id = 'e_d'").run();
  assert.equal(
    numCol(store.db.prepare("SELECT COUNT(*) AS c FROM journal_entry WHERE id = 'e_d'").get(), 'c', 'draft rows left'),
    0,
  );
});
