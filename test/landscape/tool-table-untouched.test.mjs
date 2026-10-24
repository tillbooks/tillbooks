/**
 * The tables TILL does not own stay untouched by every data-handling enumeration, not only by the G04
 * backup path (LOW from the 13.10.2026 backup-tool-tables critic).
 *
 * `isTillTable` / `tillTables` (`src/core/store/schemaShape.ts`) is the one rule for which tables are
 * TILL's. The backup, export, verify and restore went through it on 13.10.2026; four other
 * enumerations still ran their own `NOT LIKE 'sqlite_%'` query and so treated a tool's table as part
 * of the book: the env_copy mandate refresh (`deleteWorkspace`), the sanitizer (free-text redaction and
 * the money scale), the secret drift tripwire, and the Testmandant hard delete.
 *
 * The probe is a tool table that LOOKS like TILL's: `_tool_state` carries a `workspace_id`, a money
 * column (`amount_minor`), a free-text column (`notes`) and a secret-named column (`api_token`), so
 * every one of those enumerations would reach it if it were not fenced. A tool would not declare a
 * foreign key into TILL's tables, so it declares none.
 *
 * Synthetic books only, built from scratch in tmp dirs or in memory. No real data, no ~/.till.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { envCreate, envCopy, applySanitization, findUnclassifiedSecretColumns } from '../../dist/core/landscape/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const TOOL_DDL =
  'CREATE TABLE _tool_state (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, amount_minor INTEGER, notes TEXT, api_token TEXT)';

/** Give `db` the tool table, one row per workspace id given. */
function addToolState(db, wsIds) {
  db.exec(TOOL_DDL);
  const ins = db.prepare('INSERT INTO _tool_state (id, workspace_id, amount_minor, notes, api_token) VALUES (?, ?, ?, ?, ?)');
  wsIds.forEach((ws, i) => ins.run(`t${i + 1}`, ws, 1000 + i, `TOOLNOTE-${i + 1}`, `TOOLTOKEN-${i + 1}`));
}

const toolRows = (db) => db.prepare('SELECT id, workspace_id, amount_minor, notes, api_token FROM _tool_state ORDER BY id').all();

// --- sanitize and the secret tripwire ---------------------------------------------------------------

test('tool table: the sanitizer never reaches a workspace-scoped tool table', () => {
  const store = new SqliteStore({ clock: { now: () => '2026-10-14T00:00:00.000Z' } });
  try {
    const created = createWorkspace(
      { store, clock: { now: () => '2026-10-14T00:00:00.000Z' }, ids: systemIdGen, actor: 'seed' },
      { name: 'Werkzeug AG' },
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    const wsId = created.workspaceId;
    addToolState(store.db, [wsId]);
    const before = toolRows(store.db);

    // Both scopes: the copied workspace (a mandate copy) and every row (an instance copy).
    for (const workspaceIds of [[wsId], []]) {
      const summary = applySanitization(store.db, { level: 'structure_synthetic', workspaceIds });
      assert.ok(summary.piiCellsMasked > 0, 'the sanitizer did run over TILL rows (the workspace name)');
      assert.deepEqual(toolRows(store.db), before, `scope ${JSON.stringify(workspaceIds)}: the tool row is byte-identical`);
    }
  } finally {
    store.close();
  }
});

test('tool table: the secret drift tripwire does not name a tool table column as unclassified TILL schema', () => {
  const store = new SqliteStore({ clock: { now: () => '2026-10-14T00:00:00.000Z' } });
  try {
    assert.deepEqual(findUnclassifiedSecretColumns(store.db), [], 'the real schema is fully classified');
    addToolState(store.db, ['ws_x']);
    // A secret-looking column is drift only when it is TILL's to classify.
    assert.deepEqual(findUnclassifiedSecretColumns(store.db), [], 'a tool table column is not TILL schema drift');
  } finally {
    store.close();
  }
});

// --- the Testmandant hard delete ------------------------------------------------------------------

test('tool table: discarding a Testmandant leaves a tool row naming that workspace untouched', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', 'tt-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const plan = call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'tt-plan' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const t = call('migration_create_testmandant', { planId: plan.planId, idempotencyKey: 'tt-t' });
  assert.equal(t.ok, true, JSON.stringify(t));

  addToolState(deps.store.db, [t.workspaceId, workspaceId]);
  const before = toolRows(deps.store.db);

  const discarded = call('discard_testmandant', { planId: plan.planId, confirmed: true, idempotencyKey: 'tt-dis' });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  // The delete ran: the Testmandant is gone from TILL's own tables.
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace WHERE id = ?').get(t.workspaceId).n, 0);
  assert.deepEqual(toolRows(deps.store.db), before, 'the tool rows, the Testmandant one included, are byte-identical');
});

// --- the env_copy mandate refresh -----------------------------------------------------------------

test('tool table: an env_copy mandate refresh into a target carrying a tool table leaves it untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-tooltable-'));
  try {
    const at = () => '2026-10-14T00:00:00.000Z';
    const seedWith = (name) => (path) => {
      const s = new SqliteStore({ location: path });
      const ws = createWorkspace({ store: s, clock: { now: at }, ids: systemIdGen, actor: 'seed' }, { name });
      if (!ws.ok) throw new Error(`seed ${name} failed`);
      s.close();
    };
    const deps = {
      supportDir: dir,
      environmentsRoot: join(dir, 'environments'),
      mainDbPath: join(dir, 'main', 'till.db'),
      actor: 'owner',
      now: at,
      seeders: { source: seedWith('Quelle AG'), keeper: seedWith('Keeper AG') },
      ids: systemIdGen,
      clock: { now: at },
    };
    assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'source', tierRank: 250, confirmed: true }).ok, true);
    assert.equal(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'keeper', tierRank: 40, confirmed: true }).ok, true);
    const srcPath = join(dir, 'environments', 'src', 'till.db');
    const dstPath = join(dir, 'environments', 'dst', 'till.db');

    const srcStore = new SqliteStore({ location: srcPath });
    const srcWs = srcStore.db.prepare('SELECT id FROM workspace LIMIT 1').get().id;
    srcStore.close();

    const first = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: 'structure_synthetic', confirmed: true });
    assert.equal(first.ok, true, JSON.stringify(first));

    // The target now holds the keeper and the first copy; the tool keeps a row for each.
    let dst = new SqliteStore({ location: dstPath });
    const wsIds = dst.db.prepare('SELECT id FROM workspace ORDER BY rowid').all().map((r) => r.id);
    assert.equal(wsIds.length, 2, 'keeper + the first copy');
    addToolState(dst.db, wsIds);
    const before = toolRows(dst.db);
    dst.close();

    // The refresh deletes the prior copy by id (deleteWorkspace), restores a fresh one, sanitizes it.
    const second = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: 'structure_synthetic', confirmed: true });
    assert.equal(second.ok, true, JSON.stringify(second));

    dst = new SqliteStore({ location: dstPath });
    try {
      const after = dst.db.prepare('SELECT id FROM workspace ORDER BY rowid').all().map((r) => r.id);
      assert.equal(after.length, 2, 'keeper + one copy: the refresh replaced the prior copy');
      assert.ok(!after.includes(wsIds[1]), 'the prior copy was deleted by the refresh');
      assert.deepEqual(toolRows(dst.db), before, 'the tool rows, the deleted copy one included, are byte-identical');
    } finally {
      dst.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
