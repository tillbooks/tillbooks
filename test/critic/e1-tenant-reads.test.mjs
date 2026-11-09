/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2). Non-author. Synthetic by construction.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE (§H-TENANT): two workspaces in one book, both numbered. From B, nothing of A's run is readable:
 * not by A's entry id, not through the Beleg-Nr. filter, not through the plan's counts or its migrated
 * classification, and the storage guard refuses a number row that names A's entry under B's tenant. And
 * A crafted catch-up for B never touches A's unnumbered backlog.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { postEntry, getEntry, listJournal, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { computeGeneralLedger } from '../../dist/core/reports/statements.js';

const AT = '2026-07-16T00:00:00.000Z';

function must(r) {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('[PROBE e1-tenant] B reads nothing of A’s run and the guard refuses a cross-tenant number', () => {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const ids = sequenceIdGen();
  const ctxs = {};
  for (const ws of ['ws_a', 'ws_b']) {
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, 'CHF', '01-01', ?)").run(ws, ws, AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, '6500', 'Büro', 'expense')").run(`${ws}_6500`, ws);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, '1020', 'Bank', 'asset')").run(`${ws}_1020`, ws);
    ctxs[ws] = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids });
  }
  const post = (ws, key, extra = {}) =>
    must(postEntry(ctxs[ws], { date: '2026-03-01', source: 'manual', idempotencyKey: key, lines: [
      { account: `${ws}_6500`, debit: 1000 },
      { account: `${ws}_1020`, credit: 1000 },
    ], ...extra })).entryId;

  const a1 = post('ws_a', 'a1', { source: 'import', ref: '77' });
  const a2 = post('ws_a', 'a2');
  // A goes off and leaves an unnumbered backlog with its marker.
  must(settingsSet(ctxs.ws_a, { key: 'ledger.belegnummer_mode', value: 'off', reason: 'Probe', idempotencyKey: 'off' }));
  const a3 = post('ws_a', 'a3');
  const b1 = post('ws_b', 'b1');
  const b2 = post('ws_b', 'b2');

  // B's posts never caught A up.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry_number WHERE entry_id = ?').get(a3).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM journal_numbering_pending WHERE workspace_id = 'ws_a'").get().n, 1);

  assert.equal(getEntry(ctxs.ws_b, { entryId: a1 }).ok, false, 'A’s entry is not readable from B');
  const hits = must(listJournal(ctxs.ws_b, { number: '77' })).entries;
  assert.deepEqual(hits, [], 'B’s Beleg-Nr. filter does not reach A’s adopted 77');
  const one = must(listJournal(ctxs.ws_b, { number: '1' })).entries.map((e) => e.id);
  assert.deepEqual(one, [b1]);
  const plan = must(journalNumberingPlan(ctxs.ws_b));
  assert.deepEqual(plan.counts, { posted: 2, numbered: 2, unnumbered: 0, adopted: 0 });
  assert.equal(plan.pending, false);
  assert.equal(plan.migrated.entries, 0);
  const gl = must(computeGeneralLedger(ctxs.ws_b, { accountId: 'ws_b_6500', periodStart: '2026-01-01', periodEnd: '2026-12-31' }));
  assert.deepEqual(gl.lines.map((l) => l.number), ['1', '2']);

  // The storage guard: a number row naming A's entry under B's tenant is refused.
  assert.throws(
    () =>
      store.db
        .prepare("INSERT INTO journal_entry_number (id, workspace_id, entry_id, series, number, display, origin, assigned_at) VALUES ('x', 'ws_b', ?, 'all', 99, '99', 'assigned', ?)")
        .run(a3, AT),
    /entry_number_not_posted/,
    'A’s UNNUMBERED posted entry cannot be numbered under B',
  );
  assert.ok(a2 && b2);
});
