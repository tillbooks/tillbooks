/**
 * A02 §4b, the Belegnummer (D178 point 2): the posting-time rules.
 *
 *  - gap-free under many sequential posts; a reversal takes its own next number and still names its
 *    original; an idempotent replay, a refused post and a rolled-back transaction spend nothing; a draft
 *    has no number until it posts (promotion numbers it);
 *  - the storage guards bite: no UPDATE or DELETE of a number, no number on a draft or across tenants, the
 *    journal counter never moves backwards and is never deleted (A10's sales rows untouched);
 *  - §H-TENANT: two workspaces keep two independent runs;
 *  - every mode: from_start with its start, per_fiscal_year with the rollover (calendar and a July fiscal
 *    year) and the prefix, off with its catch-up, and every setting change applies forward only;
 *  - the read side: get_entry, list_journal (and its number filter) and general_ledger carry `number`.
 *
 * Every book is SYNTHETIC: invented accounts and amounts on an in-memory store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, simpleEntry } from './support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { postEntry, reverseEntry, saveDraft, getEntry, listJournal } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { computeGeneralLedger } from '../../dist/core/reports/statements.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { systemIdGen } from '../../dist/core/ids.js';

const numberRows = (store, workspaceId = 'ws_1') =>
  store.db
    .prepare('SELECT entry_id, series, number, display, origin FROM journal_entry_number WHERE workspace_id = ? ORDER BY series, number')
    .all(workspaceId);
const numberOf = (store, entryId) =>
  store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(entryId)?.display ?? null;
const counter = (store, series = 'all', workspaceId = 'ws_1') =>
  store.db
    .prepare("SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = 'journal' AND year = ?")
    .get(workspaceId, series)?.next_value ?? null;

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function setMode(t, key, value, k) {
  must(settingsSet(t.ctx, { key, value, reason: 'Test', idempotencyKey: `set-${k}` }));
}

/** A balanced entry on `date` with key `k`. */
function entryOn(t, date, k, extra = {}) {
  return { ...simpleEntry(t.accounts, 1000, k), date, ...extra };
}

test('gap-free: 120 sequential posts are numbered 1..120 in posting order and the counter stands at 121', () => {
  const t = setup();
  const ids = [];
  for (let i = 1; i <= 120; i += 1) ids.push(must(postEntry(t.ctx, simpleEntry(t.accounts, 100 + i, `k${i}`))).entryId);
  const rows = numberRows(t.store);
  assert.deepEqual(
    rows.map((r) => r.number),
    Array.from({ length: 120 }, (_, i) => i + 1),
  );
  assert.deepEqual(rows.map((r) => r.entry_id), ids, 'posting order is number order');
  assert.ok(rows.every((r) => r.series === 'all' && r.origin === 'assigned' && r.display === String(r.number)));
  assert.equal(counter(t.store), 121);
});

test('a reversal takes its own next number and still names its original; the original keeps its number', () => {
  const t = setup();
  const a = must(postEntry(t.ctx, simpleEntry(t.accounts, 500, 'a'))).entryId;
  const b = must(postEntry(t.ctx, simpleEntry(t.accounts, 600, 'b'))).entryId;
  const rv = must(reverseEntry(t.ctx, { entryId: a, idempotencyKey: 'rv-a' })).reversalId;
  assert.equal(numberOf(t.store, a), '1');
  assert.equal(numberOf(t.store, b), '2');
  assert.equal(numberOf(t.store, rv), '3');
  const read = must(getEntry(t.ctx, { entryId: rv }));
  assert.equal(read.entry.reversesEntryId, a);
  assert.equal(read.entry.number, '3');
});

test('an idempotent replay, a refused post and a rolled-back transaction spend no number', () => {
  const t = setup();
  const first = must(postEntry(t.ctx, simpleEntry(t.accounts, 500, 'same')));
  const replay = must(postEntry(t.ctx, simpleEntry(t.accounts, 500, 'same')));
  assert.equal(replay.entryId, first.entryId);
  assert.equal(numberRows(t.store).length, 1);

  // Refused before the transaction (unbalanced): nothing spent.
  const refused = postEntry(t.ctx, {
    ...simpleEntry(t.accounts, 500, 'bad'),
    lines: [
      { account: t.accounts['6500'], debit: 500 },
      { account: t.accounts['1000'], credit: 400 },
    ],
  });
  assert.equal(refused.ok, false);
  assert.equal(counter(t.store), 2);

  // A composite that posts and then fails rolls the number back with the entry.
  assert.throws(() =>
    t.store.tx(() => {
      must(postEntry(t.ctx, simpleEntry(t.accounts, 700, 'rolled-back')));
      assert.equal(counter(t.store), 3, 'inside the transaction the number is spent');
      throw new Error('the composite aborts');
    }),
  );
  assert.equal(counter(t.store), 2, 'the rollback returned the number');
  const next = must(postEntry(t.ctx, simpleEntry(t.accounts, 800, 'after')));
  assert.equal(numberOf(t.store, next.entryId), '2', 'the next post takes the number the rollback returned');
  assert.deepEqual(numberRows(t.store).map((r) => r.number), [1, 2]);
});

test('a draft has no number; promoting it numbers it at the flip', () => {
  const t = setup();
  const d = must(saveDraft(t.ctx, { date: '2026-03-02', lines: simpleEntry(t.accounts).lines, idempotencyKey: 'd1' })).entryId;
  assert.equal(numberOf(t.store, d), null);
  assert.equal(must(getEntry(t.ctx, { entryId: d })).entry.number, null);
  must(postEntry(t.ctx, simpleEntry(t.accounts, 300, 'other')));
  must(postEntry(t.ctx, { ...simpleEntry(t.accounts, 5000, 'promote'), entryId: d }));
  assert.equal(numberOf(t.store, d), '2', 'numbered when it posted, after the entry posted before it');
});

test('the guards bite: no UPDATE or DELETE of a number, no number on a draft or across tenants, the journal counter only forward', () => {
  const t = setup();
  const a = must(postEntry(t.ctx, simpleEntry(t.accounts, 500, 'a'))).entryId;
  const db = t.store.db;
  assert.throws(() => db.prepare('UPDATE journal_entry_number SET number = 99 WHERE entry_id = ?').run(a), /entry_number_immutable/);
  assert.throws(() => db.prepare("UPDATE journal_entry_number SET display = 'X' WHERE entry_id = ?").run(a), /entry_number_immutable/);
  assert.throws(() => db.prepare('DELETE FROM journal_entry_number WHERE entry_id = ?').run(a), /entry_number_immutable/);

  const d = must(saveDraft(t.ctx, { date: '2026-03-02', lines: simpleEntry(t.accounts).lines, idempotencyKey: 'd' })).entryId;
  const insert = db.prepare(
    "INSERT INTO journal_entry_number (id, workspace_id, entry_id, series, number, display, origin, assigned_at) VALUES (?, ?, ?, 'all', ?, ?, 'assigned', 'x')",
  );
  assert.throws(() => insert.run('n-draft', 'ws_1', d, 50, '50'), /entry_number_not_posted/);
  db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_2', 'Fremde AG', 'CHF', '01-01', 'x')").run();
  assert.throws(() => insert.run('n-cross', 'ws_2', a, 1, '1'), /entry_number_not_posted/);
  assert.throws(() => insert.run('n-dup', 'ws_1', a, 51, '51'), /UNIQUE/);

  assert.throws(
    () => db.prepare("UPDATE document_number_seq SET next_value = 1 WHERE workspace_id = 'ws_1' AND type = 'journal'").run(),
    /entry_number_counter_backwards/,
  );
  assert.throws(() => db.prepare("DELETE FROM document_number_seq WHERE workspace_id = 'ws_1' AND type = 'journal'").run(), /entry_number_counter_backwards/);
  // A10's own rows are not the journal's: the guard is fenced to type 'journal'.
  db.prepare("INSERT INTO document_number_seq (workspace_id, type, year, next_value) VALUES ('ws_1', 'invoice', '2026', 5)").run();
  db.prepare("UPDATE document_number_seq SET next_value = 3 WHERE workspace_id = 'ws_1' AND type = 'invoice'").run();
  db.prepare("DELETE FROM document_number_seq WHERE workspace_id = 'ws_1' AND type = 'invoice'").run();
});

test('journal_number_withheld is append-only by construction: an UPDATE and a DELETE are refused, a backup and a restore keep the guards (critic r3 confirmation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1-withheld-'));
  try {
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ws = must(createWorkspace({ store, clock, ids: systemIdGen }, { name: 'Zurückhalt AG' })).workspaceId;
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids: systemIdGen });
    const acc = (w, n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(w, n).id;
    const post = (c, w, source, ref, key, amount) =>
      must(
        postEntry(c, {
          date: '2025-03-01',
          source,
          ...(ref ? { ref } : {}),
          idempotencyKey: key,
          lines: [
            { account: acc(w, '6500'), debit: amount },
            { account: acc(w, '1020'), credit: amount },
          ],
        }),
      ).entryId;
    // A plain integer claimed twice: 4 is withheld when the first native booking starts the run.
    post(ctx, ws, 'import', '4', 'a4', 41);
    post(ctx, ws, 'import', '4', 'b4', 42);
    post(ctx, ws, 'manual', null, 'n1', 10);
    const db = store.db;
    const rows = (w) => db.prepare('SELECT series, number FROM journal_number_withheld WHERE workspace_id = ?').all(w);
    assert.deepEqual(rows(ws), [{ series: 'all', number: 4 }]);
    assert.throws(() => db.prepare('UPDATE journal_number_withheld SET number = 5 WHERE workspace_id = ?').run(ws), /entry_number_immutable/);
    assert.throws(() => db.prepare('DELETE FROM journal_number_withheld WHERE workspace_id = ?').run(ws), /entry_number_immutable/);
    assert.deepEqual(rows(ws), [{ series: 'all', number: 4 }], 'nothing released');
    // An INSERT of a number already withheld is a no-op (the engine writes INSERT OR IGNORE).
    db.prepare("INSERT OR IGNORE INTO journal_number_withheld (workspace_id, series, number, withheld_at) VALUES (?, 'all', 4, 'x')").run(ws);
    assert.deepEqual(rows(ws), [{ series: 'all', number: 4 }]);

    // The G04 backup snapshot carries the guards, and the restored copy keeps the row AND the refusal.
    const deps = { store, clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ws, idempotencyKey: 'bk' }));
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    const snapGuards = snap
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_number_withheld' ORDER BY name")
      .all()
      .map((r) => r.name);
    snap.close();
    assert.deepEqual(snapGuards, ['journal_number_withheld_no_delete', 'journal_number_withheld_no_update']);
    const copy = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true })).workspaceId;
    assert.deepEqual(rows(copy), [{ series: 'all', number: 4 }]);
    assert.throws(() => db.prepare('DELETE FROM journal_number_withheld WHERE workspace_id = ?').run(copy), /entry_number_immutable/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§H-TENANT: two workspaces interleaved keep two independent runs, and B never touches A', () => {
  const t = setup();
  t.store.db
    .prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_b', 'Beta GmbH', 'CHF', '01-01', 'x')")
    .run();
  for (const [id, number] of [['acc_b_kasse', '1000'], ['acc_b_buero', '6500']]) {
    t.store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, 'ws_b', ?, ?, ?)").run(id, number, number, number === '1000' ? 'asset' : 'expense');
  }
  // One id source for both seats: ids are global row keys, the tenant is the column.
  const ctxB = makeContext(t.store, { workspaceId: 'ws_b', actor: 'user_b', clock: fixedClock(t.AT), ids: t.ctx.ids });
  const bEntry = (k) => ({
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: k,
    lines: [
      { account: 'acc_b_buero', debit: 100 },
      { account: 'acc_b_kasse', credit: 100 },
    ],
  });
  for (let i = 1; i <= 5; i += 1) {
    must(postEntry(t.ctx, simpleEntry(t.accounts, 100, `a${i}`)));
    if (i % 2 === 1) must(postEntry(ctxB, bEntry(`b${i}`)));
  }
  assert.deepEqual(numberRows(t.store, 'ws_1').map((r) => r.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(numberRows(t.store, 'ws_b').map((r) => r.number), [1, 2, 3]);
  assert.equal(counter(t.store, 'all', 'ws_1'), 6);
  assert.equal(counter(t.store, 'all', 'ws_b'), 4);
  // No number row of one workspace names an entry of the other.
  const crossed = t.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry_number n JOIN journal_entry e ON e.id = n.entry_id WHERE n.workspace_id <> e.workspace_id')
    .get().n;
  assert.equal(crossed, 0);
});

test('from_start: a fresh series starts at ledger.belegnummer_start; a later start change does not re-seed a running series', () => {
  const t = setup();
  setMode(t, 'ledger.belegnummer_mode', 'from_start', 'm');
  setMode(t, 'ledger.belegnummer_start', 1000, 's');
  const a = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'a'))).entryId;
  const b = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'b'))).entryId;
  assert.equal(numberOf(t.store, a), '1000');
  assert.equal(numberOf(t.store, b), '1001');
  setMode(t, 'ledger.belegnummer_start', 5000, 's2');
  const c = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'c'))).entryId;
  assert.equal(numberOf(t.store, c), '1002', 'forward only: no jump, no gap');
});

test('per_fiscal_year: one run per calendar year shown as YYYY-0001, the prefix in front, the rollover on the first post of the year', () => {
  const t = setup();
  setMode(t, 'ledger.belegnummer_mode', 'per_fiscal_year', 'm');
  const a = must(postEntry(t.ctx, entryOn(t, '2025-12-30', 'a'))).entryId;
  const b = must(postEntry(t.ctx, entryOn(t, '2026-01-02', 'b'))).entryId;
  const c = must(postEntry(t.ctx, entryOn(t, '2025-12-31', 'c'))).entryId;
  setMode(t, 'ledger.belegnummer_prefix', 'B', 'p');
  const d = must(postEntry(t.ctx, entryOn(t, '2026-02-01', 'd'))).entryId;
  assert.equal(numberOf(t.store, a), '2025-0001');
  assert.equal(numberOf(t.store, b), '2026-0001');
  assert.equal(numberOf(t.store, c), '2025-0002');
  assert.equal(numberOf(t.store, d), 'B2026-0002', 'the prefix applies forward; the earlier 2026 number keeps its form');
  assert.equal(counter(t.store, '2025'), 3);
  assert.equal(counter(t.store, '2026'), 3);
  assert.equal(counter(t.store, 'all'), null, 'no continuous series was started');
});

test('per_fiscal_year with a July fiscal year: 30 June belongs to the year that began the July before', () => {
  const t = setup();
  t.store.db.prepare("UPDATE workspace SET fiscal_year_start = '07-01' WHERE id = 'ws_1'").run();
  setMode(t, 'ledger.belegnummer_mode', 'per_fiscal_year', 'm');
  setMode(t, 'ledger.belegnummer_start', 10, 's');
  const june = must(postEntry(t.ctx, entryOn(t, '2026-06-30', 'june'))).entryId;
  const july = must(postEntry(t.ctx, entryOn(t, '2026-07-01', 'july'))).entryId;
  assert.equal(numberOf(t.store, june), '2025-0010');
  assert.equal(numberOf(t.store, july), '2026-0010', 'each new fiscal year starts at the start number');
});

test('off: entries post without a number and mark the catch-up; switching on numbers the backlog at once, in date order', () => {
  const t = setup();
  const first = must(postEntry(t.ctx, entryOn(t, '2026-03-01', 'first'))).entryId;
  setMode(t, 'ledger.belegnummer_mode', 'off', 'off');
  const late = must(postEntry(t.ctx, entryOn(t, '2026-03-20', 'late'))).entryId;
  const early = must(postEntry(t.ctx, entryOn(t, '2026-03-05', 'early'))).entryId;
  assert.equal(numberOf(t.store, late), null);
  assert.equal(numberOf(t.store, early), null);
  assert.equal(must(getEntry(t.ctx, { entryId: late })).entry.number, null);
  assert.ok(t.store.db.prepare("SELECT 1 FROM journal_numbering_pending WHERE workspace_id = 'ws_1'").get(), 'the marker is set');
  // Critic r1 L2: the change that switches numbering back on runs the catch-up in its own transaction, so no
  // posted entry reads without a number between the switch and the next booking.
  setMode(t, 'ledger.belegnummer_mode', 'continue_migrated', 'on');
  assert.equal(numberOf(t.store, first), '1');
  assert.equal(numberOf(t.store, early), '2', 'the backlog is numbered in (date, created_at, rowid) order');
  assert.equal(numberOf(t.store, late), '3');
  assert.equal(t.store.db.prepare("SELECT 1 FROM journal_numbering_pending WHERE workspace_id = 'ws_1'").get(), undefined, 'the marker is cleared');
  const now = must(postEntry(t.ctx, entryOn(t, '2026-01-01', 'now'))).entryId;
  assert.equal(numberOf(t.store, now), '4', 'back on the hot path: the next number, whatever the date');
});

test('a settings change that owes nothing, or leaves numbering off, numbers nothing', () => {
  const t = setup();
  must(postEntry(t.ctx, entryOn(t, '2026-03-01', 'a')));
  setMode(t, 'ledger.belegnummer_mode', 'off', 'off');
  const b = must(postEntry(t.ctx, entryOn(t, '2026-03-02', 'b'))).entryId;
  setMode(t, 'ledger.belegnummer_prefix', 'B', 'prefix-while-off');
  assert.equal(numberOf(t.store, b), null, 'still off: the backlog waits');
  setMode(t, 'ledger.belegnummer_mode', 'from_start', 'on');
  assert.equal(numberOf(t.store, b), 'B2', 'switched on: caught up with the prefix in force');
  const before = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry_number').get().n;
  setMode(t, 'ledger.belegnummer_start', 50, 'start');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry_number').get().n, before, 'nothing owed, nothing written');
});

test('a mode switch applies forward only: continuous, then per fiscal year, then continuous again resumes its own run', () => {
  const t = setup();
  const a = must(postEntry(t.ctx, entryOn(t, '2026-03-01', 'a'))).entryId;
  const b = must(postEntry(t.ctx, entryOn(t, '2026-03-02', 'b'))).entryId;
  setMode(t, 'ledger.belegnummer_mode', 'per_fiscal_year', 'fy');
  const c = must(postEntry(t.ctx, entryOn(t, '2026-03-03', 'c'))).entryId;
  setMode(t, 'ledger.belegnummer_mode', 'from_start', 'cont');
  const d = must(postEntry(t.ctx, entryOn(t, '2026-03-04', 'd'))).entryId;
  assert.deepEqual([a, b, c, d].map((id) => numberOf(t.store, id)), ['1', '2', '2026-0001', '3']);
});

test('the read side: get_entry, list_journal and general_ledger carry `number`; the list filters by it', () => {
  const t = setup();
  const a = must(postEntry(t.ctx, entryOn(t, '2026-03-01', 'a'))).entryId;
  const b = must(postEntry(t.ctx, entryOn(t, '2026-03-02', 'b'))).entryId;
  setMode(t, 'ledger.belegnummer_mode', 'per_fiscal_year', 'fy');
  const c = must(postEntry(t.ctx, entryOn(t, '2026-03-03', 'c'))).entryId;
  const d = must(saveDraft(t.ctx, { date: '2026-03-04', lines: simpleEntry(t.accounts).lines, idempotencyKey: 'draft' })).entryId;

  assert.equal(must(getEntry(t.ctx, { entryId: b })).entry.number, '2');
  const listed = must(listJournal(t.ctx, {})).entries;
  assert.deepEqual(
    Object.fromEntries(listed.map((e) => [e.id, e.number])),
    { [a]: '1', [b]: '2', [c]: '2026-0001', [d]: null },
  );
  // An exact display match.
  assert.deepEqual(must(listJournal(t.ctx, { number: '2026-0001' })).entries.map((e) => e.id), [c]);
  // A plain integer matches that number in every series: 1 is the continuous 1 and 2026-0001.
  assert.deepEqual(new Set(must(listJournal(t.ctx, { number: ' 1 ' })).entries.map((e) => e.id)), new Set([a, c]));
  assert.deepEqual(must(listJournal(t.ctx, { number: '2' })).entries.map((e) => e.id), [b]);
  assert.deepEqual(must(listJournal(t.ctx, { number: '99' })).entries, []);

  const gl = must(computeGeneralLedger(t.ctx, { accountId: t.accounts['6500'], periodStart: '2026-01-01', periodEnd: '2026-12-31' }));
  assert.deepEqual(gl.lines.map((l) => l.number), ['1', '2', '2026-0001']);
});
