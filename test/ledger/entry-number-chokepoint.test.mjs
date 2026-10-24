/**
 * A02 §4b.2, THE POSITIVE GUARD for the Belegnummer chokepoint (D178 point 2).
 *
 * The number is assigned at ONE place, the draft-to-posted flip in `writePostedEntry`, so that no posting
 * path has to be listed. This suite proves the claim from the other side, without a list either: it drives
 * EVERY write verb's conformance scenario (`SCENARIOS` in `test/api/conformance-contract.mjs`, which a new
 * write verb cannot ship without) on a fresh book, and after each one asserts over the WHOLE database:
 *
 *  1. every posted entry has exactly one number row, and no draft has one (the one exception is an entry
 *     that WAITS by rule: numbering off, or an import posting under continue_migrated before the continuous
 *     run has started, A02 §4b.3 rule a; both with the catch-up marker set);
 *  2. no number row names an entry of another workspace;
 *  3. per (workspace, series) the numbers TILL assigned are a gap-free run, and the counter stands
 *     exactly one past the highest number in the series.
 *
 * A posting path that bypassed the flip (a raw INSERT of a posted row, a second writer) leaves an entry
 * without a number and fails rule 1 here by name. The mechanism test at the end proves the checker sees
 * exactly that, so a green run is not a checker that cannot fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS } from '../../dist/api/registry.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';
import { postEntry } from '../../dist/core/ledger/index.js';
import { ENTRY_NUMBER_SCHEMA_SQL } from '../../dist/core/ledger/entryNumberSchema.js';
import { setup, simpleEntry } from './support.mjs';

/**
 * Whether a posting is a MIGRATION posting (A02 §4b.3 rule a, critic r2 M2-1): an import, or a reversal whose
 * chain of reversed entries leads back to one. Written here independently of the engine's helper.
 */
function isMigration(db, entryId) {
  let row = db.prepare('SELECT source, reverses_entry_id FROM journal_entry WHERE id = ?').get(entryId);
  for (let hops = 0; row !== undefined && row.source === 'reversal' && row.reverses_entry_id !== null && hops < 16; hops += 1) {
    row = db.prepare('SELECT source, reverses_entry_id FROM journal_entry WHERE id = ?').get(row.reverses_entry_id);
  }
  return row !== undefined && row.source === 'import';
}

/**
 * Whether an unnumbered posted entry is WAITING by rule rather than missed: the workspace owes a catch-up
 * (the pending marker) AND either numbering is off, or (A02 §4b.3 rule a) the mode is continue_migrated, the
 * continuous run has not started and the entry is a migration posting. Nothing else may lack a number.
 */
function waitsByRule(db, workspaceId, entryId) {
  const pending = db.prepare('SELECT 1 AS x FROM journal_numbering_pending WHERE workspace_id = ?').get(workspaceId) !== undefined;
  if (!pending) return false;
  const row = db
    .prepare("SELECT value_json FROM workspace_setting WHERE workspace_id = ? AND key = 'ledger.belegnummer_mode'")
    .get(workspaceId);
  const mode = row === undefined ? 'continue_migrated' : JSON.parse(row.value_json);
  if (mode === 'off') return true;
  const started =
    db.prepare("SELECT 1 AS x FROM document_number_seq WHERE workspace_id = ? AND type = 'journal' AND year = 'all'").get(workspaceId) !==
    undefined;
  return mode === 'continue_migrated' && !started && isMigration(db, entryId);
}

/** Every violation of rules 1 to 3 in `db`, as readable strings. */
function numberingViolations(db) {
  const out = [];
  for (const r of db
    .prepare(
      `SELECT e.id, e.source, e.workspace_id FROM journal_entry e
        WHERE e.status = 'posted' AND NOT EXISTS (SELECT 1 FROM journal_entry_number n WHERE n.entry_id = e.id)`,
    )
    .all()) {
    if (waitsByRule(db, r.workspace_id, r.id)) continue;
    out.push(`posted entry ${r.id} (source ${r.source}) has no Belegnummer`);
  }
  for (const r of db
    .prepare('SELECT entry_id, COUNT(*) AS n FROM journal_entry_number GROUP BY entry_id HAVING COUNT(*) > 1')
    .all()) {
    out.push(`entry ${r.entry_id} has ${r.n} numbers`);
  }
  for (const r of db
    .prepare(
      `SELECT n.entry_id, e.status, e.workspace_id AS ews, n.workspace_id AS nws FROM journal_entry_number n
         LEFT JOIN journal_entry e ON e.id = n.entry_id
        WHERE e.id IS NULL OR e.status <> 'posted' OR e.workspace_id <> n.workspace_id`,
    )
    .all()) {
    out.push(`number row for ${r.entry_id} names a ${r.status ?? 'missing'} entry (entry workspace ${r.ews}, row workspace ${r.nws})`);
  }
  const series = db.prepare('SELECT DISTINCT workspace_id, series FROM journal_entry_number').all();
  for (const { workspace_id: ws, series: s } of series) {
    const numbers = db
      .prepare('SELECT number, origin FROM journal_entry_number WHERE workspace_id = ? AND series = ? ORDER BY number')
      .all(ws, s);
    const assigned = numbers.filter((n) => n.origin === 'assigned').map((n) => n.number);
    for (let i = 1; i < assigned.length; i += 1) {
      if (assigned[i] !== assigned[i - 1] + 1) out.push(`${ws}/${s}: a gap between ${assigned[i - 1]} and ${assigned[i]}`);
    }
    const highest = numbers.at(-1)?.number ?? 0;
    const counter = db
      .prepare("SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = 'journal' AND year = ?")
      .get(ws, s)?.next_value;
    if (counter !== highest + 1) out.push(`${ws}/${s}: the counter stands at ${counter}, the highest number is ${highest}`);
  }
  return out;
}

test('every write verb, driven through its own scenario, leaves every posted entry with exactly one Belegnummer', () => {
  const failures = [];
  const posting = new Set();
  let scenarios = 0;
  for (const action of ACTIONS.filter((a) => a.kind === 'write')) {
    const scenario = SCENARIOS[action.name];
    if (scenario === undefined) continue; // conformance rule 8 already fails a write verb with no scenario.
    const fx = fixture();
    try {
      const input = scenario(fx);
      const before = fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE status = 'posted'").get().n;
      const result = action.run(fx.deps, input);
      scenarios += 1;
      const after = fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE status = 'posted'").get().n;
      if (result.ok === true && after > before) posting.add(action.name);
      for (const v of numberingViolations(fx.deps.store.db)) failures.push(`${action.name}: ${v}`);
    } finally {
      fx.deps.store.close();
    }
  }
  assert.deepEqual(failures, [], `the Belegnummer chokepoint was bypassed:\n  ${failures.join('\n  ')}`);

  // NOT VACUOUS: the sweep really posted, through many distinct paths, the composites among them.
  assert.ok(scenarios > 400, `only ${scenarios} write scenarios ran`);
  assert.ok(posting.size >= 40, `only ${posting.size} write verbs posted an entry: ${[...posting].sort().join(', ')}`);
  // The public door, the reversal, a document poster, and composites that post under an INTERNAL scope
  // (postEntryInternal / postEntryInternalChecked). (close_year's scenario closes an empty year, which posts
  // nothing; its sweep and carry are covered by the year-close suites, through the same flip.)
  for (const name of ['post_entry', 'reverse_entry', 'issue_invoice', 'set_opening_balances', 'vat_settlement_post', 'accrual_post', 'wage_journal_post']) {
    assert.ok(posting.has(name), `${name} posted nothing in its scenario, so the sweep does not cover its path`);
  }
});

test('mechanism: the checker names an entry that bypassed the chokepoint, a doubled run and a counter out of step', () => {
  const t = setup();
  for (let i = 1; i <= 3; i += 1) postEntry(t.ctx, simpleEntry(t.accounts, 100 * i, `k${i}`));
  assert.deepEqual(numberingViolations(t.store.db), [], 'premise: a clean book');

  // A second writer: a posted row that never met the flip.
  t.store.db
    .prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, status, idempotency_key, source, created_at) VALUES ('rogue', 'ws_1', '2026-03-01', 'posted', 'rogue', 'manual', 'x')",
    )
    .run();
  assert.deepEqual(numberingViolations(t.store.db), ['posted entry rogue (source manual) has no Belegnummer']);
  // An import that bypassed the flip is not excused by rule (a): the run has started and no catch-up is owed.
  t.store.db
    .prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, status, idempotency_key, source, created_at) VALUES ('rogue-import', 'ws_1', '2026-03-01', 'posted', 'rogue-import', 'import', 'x')",
    )
    .run();
  assert.ok(numberingViolations(t.store.db).includes('posted entry rogue-import (source import) has no Belegnummer'));

  // A number spent twice (by hand, guards dropped), and a counter wound back.
  const db = t.store.db;
  db.exec('DROP TRIGGER journal_entry_number_no_delete; DROP TRIGGER journal_number_seq_forward;');
  db.prepare("DELETE FROM journal_entry_number WHERE number = 2").run();
  db.prepare("UPDATE document_number_seq SET next_value = 9 WHERE type = 'journal'").run();
  db.exec(ENTRY_NUMBER_SCHEMA_SQL);
  const found = numberingViolations(db);
  assert.ok(found.some((v) => v.includes('has no Belegnummer') && !v.includes('rogue')), 'the entry whose number was removed');
  assert.ok(found.includes('ws_1/all: a gap between 1 and 3'), found.join(' | '));
  assert.ok(found.includes('ws_1/all: the counter stands at 9, the highest number is 3'), found.join(' | '));
});
