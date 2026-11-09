// @ts-check
// A03's P&L sweep is driven off journal_entry on purpose, and this suite is what holds that in place.
//
// The store collects NO table statistics (ANALYZE is a write, and D12 puts a second writer on the
// file: see the note on `SqliteStore.close()`). With none, the planner cannot know that the selective
// fence of this query lives on journal_entry (one workspace, one year, posted, not a close), so it
// drives the whole join off journal_line_account: a full index scan of the largest table in the file
// plus a row fetch per line, most of which the date filter then discards. `CROSS JOIN` pins the join
// ORDER (it is an inner join with a fixed outer table, not a cartesian product) and `INDEXED BY`
// makes the per-entry lookup a hard constraint instead of a hope.
//
// Re-measured on this branch rather than inherited. 10'000 entries / 30'000 lines, file-backed,
// separate seeded databases in ONE process exercised in a rotating round (several agents build on
// this machine at once, so a sequential before/after measures the load as much as the change),
// 21 scored rounds, median round, on a ledger with three years of history:
//
//   as-is                              14.48 ms
//   FROM journal_line l NOT INDEXED     9.99 ms   1.45x, the obvious lever, kept below as a control arm
//   as shipped                          4.86 ms   2.98x
//   as-is after a full ANALYZE          4.95 ms   what statistics would buy, reached without them
//
// The assertions read the statement out of the COMPILED module rather than restating it, so removing
// the lever from src/core/ledger/yearClose.ts turns this red instead of leaving a suite that passes
// against a paraphrase nobody ships. A close_year runs once a fiscal year, so the point of the fix is
// not the milliseconds: it is that the sweep's cost stops scaling with every line the book has ever
// held, and the FIGURES it produces must be identical whichever plan runs, which is what the row-for-
// row comparison below is for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { postEntry, hardCloseYear } from '../../dist/core/ledger/index.js';
import { setup, entry, balanceOf, idOf } from './a03-support.mjs';
import { rows as sqlRows, strCol } from '../support/narrow.mjs';

const AT = '2026-07-16T00:00:00.000Z';

/** The sweep as SHIPPED, lifted verbatim out of the compiled module that actually runs. */
function shippedSweepSql() {
  const compiled = readFileSync(new URL('../../dist/core/ledger/yearClose.js', import.meta.url), 'utf8');
  const match = compiled.match(/`SELECT l\.account_id AS account_id[\s\S]*?`/);
  assert.ok(match, 'the P&L sweep must still be one template literal in dist/core/ledger/yearClose.js');
  const sql = match[0].slice(1, -1);
  assert.doesNotMatch(sql, /\$\{/, 'it must stay a literal statement: an interpolated one could not be planned here');
  return sql;
}

function planOf(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join('\n');
}

/**
 * A ledger with HISTORY: 900 entries of 3 lines over three fiscal years, so the sweep's date fence
 * actually rejects rows, which is the shape any real year-close runs against. Raw SQL, lines down
 * while the entry is still a draft and the flip to 'posted' last, because
 * `journal_line_no_insert_posted` refuses a line under an already-posted entry.
 */
function seedThreeYears(db, workspaceId = 'ws_1') {
  db.prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)').run(
    workspaceId,
    'Acme GmbH',
    'CHF',
    '01-01',
    AT,
  );
  const insAccount = db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)');
  // A quarter of the chart is balance-sheet, so `a.type IN ('income', 'expense')` is not a no-op.
  const TYPES = ['expense', 'income', 'expense', 'asset'];
  for (let i = 0; i < 16; i++) {
    insAccount.run(`acc_${i}`, workspaceId, String(3000 + i * 10), `Konto ${i}`, TYPES[i % TYPES.length]);
  }
  const insEntry = db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, ref, description, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
     VALUES (?, ?, ?, ?, ?, 'CHF', ?, ?)`,
  );
  const flip = db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?");
  for (let e = 0; e < 900; e++) {
    const id = `ent_${String(e).padStart(4, '0')}`;
    const year = 2026 - (e % 3); // 2026, 2025, 2024
    // Every ninth entry is a `close` posting and every eleventh stays a draft: both are rows the
    // sweep must EXCLUDE, so a plan that quietly widened the fence would show up as a wrong figure.
    insEntry.run(id, workspaceId, `${year}-0${1 + (e % 9)}-15`, `B-${e}`, `Buchung ${e}`, e % 9 === 0 ? 'close' : 'manual', AT);
    insLine.run(`lin_${id}_0`, id, `acc_${e % 16}`, 3000, 0, 3000, 0);
    insLine.run(`lin_${id}_1`, id, `acc_${(e + 1) % 16}`, 0, 2000, 0, 2000);
    insLine.run(`lin_${id}_2`, id, `acc_${(e + 5) % 16}`, 0, 1000, 0, 1000);
    if (e % 11 !== 0) flip.run(id);
  }
}

// --- what ships ----------------------------------------------------------------------------------

test('the P&L sweep SHIPS driven off journal_entry, with the line lookup pinned to journal_line_entry', () => {
  const sql = shippedSweepSql();
  assert.match(sql, /FROM journal_entry e\s+CROSS JOIN journal_line l INDEXED BY journal_line_entry ON l\.entry_id = e\.id/, sql);
});

test('the shipped sweep drives off journal_entry and never index-scans journal_line', () => {
  const store = new SqliteStore();
  seedThreeYears(store.db);
  const shipped = shippedSweepSql();
  const plan = planOf(store.db, shipped, 'ws_1', '2026-01-01', '2026-12-31');

  assert.equal(plan.split('\n')[0], 'SCAN e', `the outer loop must be journal_entry:\n${plan}`);
  assert.match(plan, /SEARCH l USING INDEX journal_line_entry \(entry_id=\?\)/, plan);
  assert.doesNotMatch(plan, /journal_line_account/, `journal_line must not be driven off the account index:\n${plan}`);

  // The premise, asserted rather than assumed. Undo just the join-order constraint and the planner
  // really does fall back to the plan this change exists to replace, so the lever is load-bearing.
  const undone = shipped.replace('CROSS JOIN journal_line l INDEXED BY journal_line_entry', 'JOIN journal_line l');
  assert.notEqual(undone, shipped, 'the control arm must actually differ, or the comparison proves nothing');
  const undonePlan = planOf(store.db, undone, 'ws_1', '2026-01-01', '2026-12-31');
  assert.equal(undonePlan.split('\n')[0], 'SCAN l USING INDEX journal_line_account', undonePlan);
  store.close();
});

test('four plan-distinct arms return the SAME rows, in the same order, to the Rappen', () => {
  const store = new SqliteStore();
  seedThreeYears(store.db);
  const db = store.db;
  const shipped = shippedSweepSql();
  const asWas = shipped.replace('FROM journal_entry e\n         CROSS JOIN journal_line l INDEXED BY journal_line_entry ON l.entry_id = e.id', 'FROM journal_line l\n         JOIN journal_entry e ON e.id = l.entry_id');
  assert.notEqual(asWas, shipped, 'the as-was arm must actually differ');
  // `NOT INDEXED` is the only form that produces a real table scan. `+column` does NOT: SQLite still
  // reads `+account_id = ?` as usable and just moves to another index, so a control arm built that
  // way would silently be comparing an index against an index.
  const scanned = asWas.replace('FROM journal_line l\n', 'FROM journal_line l NOT INDEXED\n');
  const entryDriven = shipped.replace(' INDEXED BY journal_line_entry', '');

  const plans = {
    shipped: planOf(db, shipped, 'ws_1', '2026-01-01', '2026-12-31'),
    asWas: planOf(db, asWas, 'ws_1', '2026-01-01', '2026-12-31'),
    scanned: planOf(db, scanned, 'ws_1', '2026-01-01', '2026-12-31'),
    entryDriven: planOf(db, entryDriven, 'ws_1', '2026-01-01', '2026-12-31'),
  };
  assert.equal(plans.scanned.split('\n')[0], 'SCAN l', `the control arm must genuinely SCAN:\n${plans.scanned}`);
  assert.notEqual(plans.shipped, plans.asWas, 'the arms must reach DIFFERENT plans, or they prove nothing');

  for (const [year, from, to] of [
    [2026, '2026-01-01', '2026-12-31'],
    [2025, '2025-01-01', '2025-12-31'],
    [2024, '2024-01-01', '2024-12-31'],
  ]) {
    const rows = db.prepare(shipped).all('ws_1', from, to);
    assert.ok(rows.length > 0, `${year}: the fixture must have P&L movement, or every arm agreed on nothing`);
    assert.deepEqual(db.prepare(asWas).all('ws_1', from, to), rows, `${year}: the plan changed the ANSWER`);
    assert.deepEqual(db.prepare(scanned).all('ws_1', from, to), rows, `${year}: the scan disagrees`);
    assert.deepEqual(db.prepare(entryDriven).all('ws_1', from, to), rows, `${year}: the unhinted arm disagrees`);
  }

  // The fence itself: draft rows and `source = 'close'` rows are excluded, and balance-sheet accounts
  // never appear. A join order that widened any of these would show up right here.
  const sweptAccounts = new Set(
    sqlRows(db.prepare(shipped).all('ws_1', '2026-01-01', '2026-12-31'), 'the shipped sweep').map(
      (r) => r.account_id,
    ),
  );
  for (const id of sweptAccounts) {
    assert.match(
      strCol(db.prepare('SELECT type FROM account WHERE id = ?').get(id), 'type', 'the swept account'),
      /^(income|expense)$/,
      'a balance-sheet account was swept into the P&L close',
    );
  }
  const closeIds = sqlRows(db.prepare("SELECT id FROM journal_entry WHERE source = 'close'").all(), 'close entries').map((r) => r.id);
  const draftIds = sqlRows(db.prepare("SELECT id FROM journal_entry WHERE status = 'draft'").all(), 'draft entries').map((r) => r.id);
  assert.ok(closeIds.length > 0 && draftIds.length > 0, 'the fixture must contain rows the sweep has to EXCLUDE');
  store.close();
});

test('INDEXED BY is a HARD constraint: without journal_line_entry the sweep refuses to prepare', () => {
  const store = new SqliteStore();
  const db = store.db;
  const shipped = shippedSweepSql();
  db.prepare(shipped); // prepares fine while the index exists

  db.exec('DROP INDEX journal_line_entry');
  assert.throws(
    () => db.prepare(shipped),
    /no such index: journal_line_entry/,
    'without the index, driving off journal_entry would mean a table scan per entry: fail loudly instead',
  );
  store.close();
});

// --- and the close itself is unmoved ---------------------------------------------------------------

test('the close still zeroes the P&L and carries the exact result, on a ledger with prior-year history', () => {
  const { ctx, store, workspaceId, byNumber } = setup();

  // 2025, which must NOT be swept into the 2026 close: income 7000, expense 1000.
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 7000, date: '2025-05-01', idempotencyKey: 'p25-1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1020', amount: 1000, date: '2025-06-01', idempotencyKey: 'p25-2' }));
  // 2026: income 10000, expense 4000 => result +6000.
  postEntry(ctx, entry(byNumber, { debitNo: '1020', creditNo: '3000', amount: 10000, date: '2026-05-01', idempotencyKey: 'p26-1' }));
  postEntry(ctx, entry(byNumber, { debitNo: '6500', creditNo: '1020', amount: 4000, date: '2026-06-01', idempotencyKey: 'p26-2' }));

  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.result, 6000, "the 2026 result only, in Rappen: the prior year's 6000 is not swept in");

  // 3000 and 6500 still carry their 2025 movement and nothing else: 7000 credited, 1000 debited.
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '3000')), -7000);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '6500')), 1000);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2979')), 0, '2979 opened and carried out');
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2970')), -6000, 'a profit is a credit balance on 2970');

  // Idempotent on its key: the sweep runs again and never double-carries.
  const again = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(again.closingEntryId, closed.closingEntryId);
  assert.equal(balanceOf(store, workspaceId, idOf(byNumber, '2970')), -6000);
  store.close();
});
