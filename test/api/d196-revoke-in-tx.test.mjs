// @ts-nocheck
/**
 * D196 point 4 (critic L1), measured on rows: a REVOKE committed while the agent's approval is under way
 * rolls the act back. The engine re-reads the owner's grant INSIDE the act's own write transaction
 * (`approveOnce` in `core/agent/draftedActions.ts`), so nothing commits over a grant already withdrawn.
 *
 * The revoke is written by a raw autocommit statement from inside the replay's invoker, BEFORE the verb opens
 * its own transaction: the shape of another process (a person in the Studio) committing `off` between the
 * approval's checks and the act's commit. Until 12.11.2026 no test pinned this; the D196 live verification
 * (`docs/planning/d196-verification-2026-11-12.md`, case d) found the gap.
 *
 * All data is synthetic (the seeded KMU chart of a fresh in-memory workspace, invented bank lines).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { approveDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { AT, mintWorkspace } from './support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

/** A FILE-backed book, so a second connection (the other process) can commit the revoke. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'till-d196-rvk-'));
  const location = join(dir, 'book.db');
  const deps = { store: new SqliteStore({ location, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', 'rvk-ws');
  const created = getAction('create_bank_account').run(asStudio(deps), {
    workspaceId, name: 'Testbank', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'rvk-bank',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const imported = getAction('import_bank_statement').run(asStudio(deps), {
    workspaceId, bankAccountId: created.bankAccountId, content: 'Datum;Text;Betrag\n02.03.2026;Lieferant Beispiel;-25.00\n',
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'rvk-csv',
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const txn = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ?').get(workspaceId).id;
  return { deps, ws: workspaceId, txn, location, dir };
}

for (const verb of ['book_bank_line', 'ignore_bank_line']) {
  test(`a revoke committed during the agent's approval of ${verb} rolls the act back, and the row stays pending`, () => {
    const w = world();
    const input = verb === 'book_bank_line'
      ? { workspaceId: w.ws, bankTxnId: w.txn, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 2500 }] }, idempotencyKey: 'rvk-1' }
      : { workspaceId: w.ws, bankTxnId: w.txn, idempotencyKey: 'rvk-1' };
    const drafted = rest(asAgent(w.deps), verb, input);
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    const g = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'agent.decide_proposals', value: 'decide', reason: 'D196 test', idempotencyKey: 'rvk-grant' });
    assert.equal(g.ok, true, JSON.stringify(g));
    const posted = () => count(w.deps.store.db, "SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'", w.ws);
    const decisions = () => count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ?', w.ws, w.txn);
    const postedBefore = posted();
    const decisionsBefore = decisions();

    // The other process: its own connection to the same file.
    const other = new Database(w.location);
    let revoked = 0;
    const invoke = (tool, payload, actor) => {
      // Its committed revoke lands after the approval's checks and before the act opens its transaction.
      revoked += other
        .prepare("UPDATE workspace_setting SET value_json = '\"off\"', updated_by = 'studio' WHERE workspace_id = ? AND key = 'agent.decide_proposals'")
        .run(w.ws).changes;
      return getAction(tool).run({ ...w.deps, actor }, payload);
    };
    const ctx = makeContext(w.deps.store, { workspaceId: w.ws, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids });
    const r = approveDraftedAction(ctx, invoke, { actionId: drafted.actionId });

    assert.equal(revoked, 1, 'the revoke ran during the replay');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'permission_denied');
    assert.equal(r.reason, 'grant_revoked');
    assert.equal(posted(), postedBefore, 'nothing posted over the withdrawn grant');
    assert.equal(decisions(), decisionsBefore, 'no line decision row');
    const row = w.deps.store.db.prepare('SELECT status, committed_at, history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(w.ws, drafted.actionId);
    assert.equal(row.status, 'pending', 'the Vorschlag waits for a person');
    assert.equal(row.committed_at, null, 'no commit mark survived');
    assert.deepEqual(JSON.parse(row.history_json ?? '[]'), [], 'no decided_under_grant entry');
    other.close();
    w.deps.store.close();
    rmSync(w.dir, { recursive: true, force: true });
  });
}
