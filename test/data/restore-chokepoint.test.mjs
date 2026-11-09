/**
 * THE LIST-FREE RESTORE GATE (spec G04 §0c item 5). Money-path data moves through a restore, and the
 * A31 critic failed three rounds in a row on references a restore did not know about. This suite does
 * not ask "is column X remapped"; it asks the OUTCOME over worlds as rich as can be built:
 *
 *   after a restore (beside the original, into an empty book, and through `env_copy` plain and
 *   pseudonymized), does ANY text value of ANY restored row still name a row of the SOURCE?
 *
 * The scan (`./restore-gate-support.mjs`) is stricter than the chokepoint it checks: it flags a source
 * id anywhere in a value, as a token of a path, a list or a sentence. A leak can only be tolerated in
 * two places, each with its reason: the chokepoint's own `NATURAL_KEY_COLUMNS` (external keys that
 * must stay verbatim), and `PROSE_COLUMNS` below, where the ENGINE writes a human sentence that
 * mentions an id, and only for a value that really is a sentence. The last tests prove the gate
 * bites: a chokepoint mutated to skip JSON, or to do nothing, fails it; a planted id in prose fails it.
 *
 * Synthetic data only: the conformance scenarios and the Seeblick presentation ledger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { RestoreIdMap, NATURAL_KEY_COLUMNS } from '../../dist/core/data/idRemap.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import { getAuditLog } from '../../dist/core/ledger/index.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';
import { conformanceWorlds, seeblickWorld } from './restore-worlds.mjs';
import { sourceIdsOfBackup, sourceIdsOfDatabase, scanRestoredWorkspace, scanWholeDatabase, populatedTables, formatLeaks } from './restore-gate-support.mjs';

/**
 * Columns where the ENGINE writes a human SENTENCE that names an internal id. The chokepoint never
 * rewrites inside prose (spec §0c item 2), so the copy keeps the sentence as it was written; the row's
 * real links are its own columns, which do follow. Tolerated ONLY for a value that is prose (it has
 * whitespace and a word that is not an id): a whole id, a JSON id or a path in the same column is
 * still a leak.
 */
const PROSE_COLUMNS = {
  'entry_review.comment': 'A12 review note, e.g. "duplicate_suspect: same date and amount as <entry>"',
  'stored_file.title': 'a display title the engine derives, e.g. "eBill-Nutzlast <document>"; the file follows through entity_id',
  'journal_entry.description': 'the posting text (Buchungstext); A17 writes "Kreditorenrechnung <bill>" when a bill has no number',
};

const ID_CHARS = /^[A-Za-z0-9_-]+$/;

/** A leak is tolerated only in a prose column AND only when its value is a sentence. */
function untolerated(leaks, sourceIds) {
  return leaks.filter((l) => {
    if (PROSE_COLUMNS[l.key] === undefined) return true;
    const words = l.value.split(/\s+/).filter((w) => w.length > 0);
    const prose = words.length > 1 && words.some((w) => !ID_CHARS.test(w) || !sourceIds.has(w));
    return !prose;
  });
}

function ctxOf(store, clock, ids, ws) {
  return makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids });
}

/** Back up `ws`, restore it into `target` (beside the original when target is the same store). */
function roundTrip(source, target, ws, dir) {
  const deps = { store: source.store, clock: source.clock, ids: source.ids, actor: 'user_1', backupDir: join(dir, `b-${Math.random().toString(36).slice(2)}`) };
  const backup = createBackup(deps, { workspaceId: ws, idempotencyKey: `gate-${ws}` });
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const tdeps = { store: target.store, clock: target.clock, ids: target.ids, actor: 'user_1', backupDir: deps.backupDir };
  const restored = restoreBackup(tdeps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  return { backup, restored };
}

/** The gate for one restored workspace: zero untolerated leaks, and a chain that verifies. */
function assertClean(label, target, restored, backup) {
  const sourceIds = sourceIdsOfBackup(backup.artifactRef);
  const leaks = untolerated(scanRestoredWorkspace(target.store.db, restored.workspaceId, sourceIds), sourceIds);
  assert.equal(leaks.length, 0, `${label}: restored rows still name source rows:\n${formatLeaks(leaks)}`);
  assert.equal(restored.auditChain.verified, true, `${label}: the source chain verified, so the copy must be re-sealed`);
  const audit = getAuditLog(ctxOf(target.store, target.clock, target.ids, restored.workspaceId));
  assert.equal(audit.chainVerified, true, `${label}: the restored audit chain must verify (${JSON.stringify(audit.brokenAtId)})`);
  // Every carried row, plus the one row that records the restore itself (critic R1-L1).
  assert.equal(audit.rows.length, restored.auditChain.rows + 1);
  assert.equal(audit.rows.at(-1).action, 'import');
  return sourceIds.size;
}

// --- The allowlist is sound -----------------------------------------------------------------------

test('the natural-key allowlist and the prose columns name real, non-FK columns, each with a reason', () => {
  const store = new SqliteStore({});
  try {
    for (const [key, reason] of [...Object.entries(NATURAL_KEY_COLUMNS), ...Object.entries(PROSE_COLUMNS)]) {
      const [table, column] = key.split('.');
      const cols = store.db.pragma(`table_info("${table}")`).map((c) => c.name);
      assert.ok(cols.includes(column), `stale entry ${key}: the schema has no such column`);
      const fks = store.db.pragma(`foreign_key_list("${table}")`).map((f) => f.from);
      assert.ok(!fks.includes(column), `${key} is a declared foreign key; it can never be a natural key`);
      assert.ok(typeof reason === 'string' && reason.length > 10, `${key} needs its reason`);
    }
  } finally {
    store.close();
  }
});

// --- The worlds -------------------------------------------------------------------------------------

test('GATE conformance worlds: a restore BESIDE the original leaves no source id in any restored row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const worlds = conformanceWorlds();
    const covered = new Set();
    let scanned = 0;
    worlds.forEach((w, i) => {
      const t = { store: w.fx.deps.store, clock: w.fx.deps.clock, ids: w.fx.deps.ids };
      for (const table of Object.keys(populatedTables(t.store.db, w.fx.workspaceId))) covered.add(table);
      const { backup, restored } = roundTrip(t, t, w.fx.workspaceId, dir);
      scanned += assertClean(`world ${i}`, t, restored, backup);
    });
    // Not vacuous: the worlds reach most of the schema and move thousands of ids.
    assert.ok(covered.size >= 130, `the worlds reached only ${covered.size} tables`);
    assert.ok(scanned >= 1000, `only ${scanned} source ids were checked`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GATE conformance world: a restore into an EMPTY book leaves no source id in any restored row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const [w] = conformanceWorlds(1);
    const source = { store: w.fx.deps.store, clock: w.fx.deps.clock, ids: w.fx.deps.ids };
    // A uuid generator: a fresh sequence would mint `ws_1` again, a NAME equal to the source's id.
    const fresh = { store: new SqliteStore({ location: join(dir, 'empty.sqlite') }), clock: w.fx.deps.clock, ids: systemIdGen };
    try {
      const { backup, restored } = roundTrip(source, fresh, w.fx.workspaceId, dir);
      assertClean('empty book', fresh, restored, backup);
      assert.deepEqual(fresh.store.db.pragma('foreign_key_check'), []);
    } finally {
      fresh.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GATE Seeblick ledger: both workspaces restore beside the original and into an empty book with no source id left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const path = seeblickWorld(dir);
    const store = new SqliteStore({ location: path });
    const source = { store, clock: { now: () => '2026-09-30T10:00:00.000Z' }, ids: systemIdGen };
    const fresh = { store: new SqliteStore({ location: join(dir, 'empty.sqlite') }), clock: source.clock, ids: systemIdGen };
    try {
      const wss = store.db.prepare('SELECT id FROM workspace ORDER BY rowid').all().map((r) => r.id);
      assert.equal(wss.length, 2);
      for (const ws of wss) {
        const beside = roundTrip(source, source, ws, dir);
        assertClean(`Seeblick ${ws} beside`, source, beside.restored, beside.backup);
        const empty = roundTrip(source, fresh, ws, dir);
        assertClean(`Seeblick ${ws} into an empty book`, fresh, empty.restored, empty.backup);
      }
    } finally {
      fresh.store.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A landscape to copy between, whose source env is a byte copy of `worldPath`. */
function landscape(dir, worldPath) {
  const deps = {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-09-30T00:00:00.000Z',
    seeders: {
      world: (p) => copyFileSync(worldPath, p),
      minimal: (p) => new SqliteStore({ location: p }).close(),
    },
    ids: systemIdGen,
    clock: { now: () => '2026-09-30T00:00:00.000Z' },
  };
  const src = envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'world', tierRank: 250, confirmed: true });
  assert.equal(src.ok, true, JSON.stringify(src));
  return deps;
}

function copyAndScan(deps, dir, level) {
  const tgt = envCreate(deps, { name: `dst-${level}`, policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true });
  assert.equal(tgt.ok, true, JSON.stringify(tgt));
  const res = envCopy(deps, { source: 'src', target: `dst-${level}`, sanitize: level, confirmed: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  const src = new Database(join(dir, 'environments', 'src', 'till.db'), { readonly: true });
  const sourceIds = sourceIdsOfDatabase(src);
  src.close();
  const dst = new Database(join(dir, 'environments', `dst-${level}`, 'till.db'), { readonly: true });
  try {
    const leaks = untolerated(scanWholeDatabase(dst, sourceIds), sourceIds);
    assert.equal(leaks.length, 0, `env_copy ${level}: the target still names source rows:\n${formatLeaks(leaks)}`);
    return sourceIds.size;
  } finally {
    dst.close();
  }
}

test('GATE env_copy of the Seeblick ledger, plain and pseudonymized: the target names no source row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const path = seeblickWorld(dir);
    const s = new SqliteStore({ location: path });
    s.checkpoint();
    s.close();
    const deps = landscape(dir, path);
    for (const level of ['raw', 'pseudonymize']) assert.ok(copyAndScan(deps, dir, level) > 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GATE env_copy of the conformance world, plain and pseudonymized: the target names no source row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const [w] = conformanceWorlds(1);
    const path = join(dir, 'conformance.db');
    writeFileSync(path, w.fx.deps.store.db.serialize());
    const deps = landscape(dir, path);
    for (const level of ['raw', 'pseudonymize']) assert.ok(copyAndScan(deps, dir, level) > 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The gate bites ---------------------------------------------------------------------------------

/** Run `fn` with the chokepoint replaced by `mutant`, restoring the real one afterwards. */
function withMutant(mutant, fn) {
  const real = RestoreIdMap.prototype.remapValue;
  RestoreIdMap.prototype.remapValue = mutant(real);
  try {
    return fn();
  } finally {
    RestoreIdMap.prototype.remapValue = real;
  }
}

/**
 * Restore conformance world 1 under a mutated chokepoint, beside the original or into an empty book,
 * and return what the gate sees: the refusal when the restore could not even complete, else the leaks.
 */
function underMutant(mutant, into = 'beside') {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const [w] = conformanceWorlds(1);
    const t = { store: w.fx.deps.store, clock: w.fx.deps.clock, ids: w.fx.deps.ids };
    const target = into === 'beside' ? t : { store: new SqliteStore({ location: join(dir, 'empty.sqlite') }), clock: t.clock, ids: systemIdGen };
    try {
      return withMutant(mutant, () => {
        const deps = { ...t, actor: 'user_1', backupDir: join(dir, 'b') };
        const backup = createBackup(deps, { workspaceId: w.fx.workspaceId, idempotencyKey: 'mutant' });
        assert.equal(backup.ok, true, JSON.stringify(backup));
        const restored = restoreBackup({ ...target, actor: 'user_1', backupDir: deps.backupDir }, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
        if (!restored.ok) return { refused: restored, leaks: [] };
        const sourceIds = sourceIdsOfBackup(backup.artifactRef);
        return { refused: null, leaks: untolerated(scanRestoredWorkspace(target.store.db, restored.workspaceId, sourceIds), sourceIds) };
      });
    } finally {
      if (target !== t) target.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the gate BITES: a chokepoint that only maps whole values (the pre-redesign reach) leaves JSON and structured leaks', () => {
  const { refused, leaks } = underMutant(() =>
    function wholeOnly(table, column, value) {
      if (typeof value !== 'string' || NATURAL_KEY_COLUMNS[`${table}.${column}`] !== undefined) return value;
      return this.get(value) ?? value;
    },
  );
  assert.equal(refused, null);
  const columns = new Set(leaks.map((l) => l.key));
  // The forms beyond a whole value: ids inside JSON, a materialised path, a composite key with the
  // workspace id, a derived idempotency key.
  for (const expected of ['po_version.header_snapshot', 'stock_location.path', 'audit_log.entity_id', 'journal_entry.idempotency_key']) {
    assert.ok(columns.has(expected), `expected a leak in ${expected}, got ${[...columns].join(', ')}`);
  }
});

test('the gate BITES: a chokepoint that does nothing is refused beside the original (round 1) and leaks every undeclared reference into an empty book', () => {
  const noop = () => (_table, _column, value) => value;
  const beside = underMutant(noop, 'beside');
  // Round 1's exact failure: the capture fields collide with the original's on the live index. It is
  // now a clean refusal (the transaction rolled back), not a raw exception.
  assert.equal(beside.refused?.error, 'restore_invariant_failed', JSON.stringify(beside.refused));
  assert.equal(beside.refused.reason, 'constraint_violation');
  const empty = underMutant(noop, 'empty');
  assert.equal(empty.refused, null);
  const columns = new Set(empty.leaks.map((l) => l.key));
  // The A31 rounds 1 and 2 columns and the polymorphic entity links, found without being named
  // anywhere (round 3's ids inside a field value are the capture suite's own gate).
  for (const expected of ['captures.document_id', 'capture_fields.capture_id', 'stored_file.entity_id', 'task.entity_id']) {
    assert.ok(columns.has(expected), `expected a leak in ${expected}, got ${[...columns].join(', ')}`);
  }
});

test('the gate BITES: an id planted in prose outside the prose columns fails it (the scan is stricter than the chokepoint)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-gate-'));
  try {
    const [w] = conformanceWorlds(1);
    const t = { store: w.fx.deps.store, clock: w.fx.deps.clock, ids: w.fx.deps.ids };
    const contacts = t.store.db.prepare('SELECT id FROM contact WHERE workspace_id = ? ORDER BY rowid LIMIT 2').all(w.fx.workspaceId);
    assert.equal(contacts.length, 2);
    t.store.db.prepare('UPDATE contact SET name = ? WHERE id = ?').run(`Rechnungen an ${contacts[1].id} weiterleiten`, contacts[0].id);
    const { backup, restored } = roundTrip(t, t, w.fx.workspaceId, dir);
    const sourceIds = sourceIdsOfBackup(backup.artifactRef);
    const leaks = untolerated(scanRestoredWorkspace(t.store.db, restored.workspaceId, sourceIds), sourceIds);
    assert.equal(leaks.length, 1, formatLeaks(leaks));
    assert.equal(leaks[0].key, 'contact.name');
    assert.equal(leaks[0].id, contacts[1].id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
