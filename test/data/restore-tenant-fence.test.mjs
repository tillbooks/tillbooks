/**
 * G04 restore: what a restored copy must NOT inherit from, or point into, the rest of the book (critic
 * round 1, R1-M2 and R1-M3).
 *
 *  - R1-M2: a copy of a PUBLISHING workspace lands with the egress dial OFF and a fresh stream epoch,
 *    the rule env_copy already applied (`landscape/copy.ts` `resetPublishDial`). The source keeps both.
 *  - R1-M3: every declared foreign key of every restored row resolves INSIDE the new workspace. A
 *    hand-edited backup (the manifest sha256 is a checksum, not a signature) that points a row at
 *    another workspace of the target book is refused whole, `restore_invariant_failed` with reason
 *    `foreign_reference`, and the gate is read from the schema's FK metadata, so a table added later
 *    is covered without being named (proved below with a table this file invents).
 *
 * Synthetic data only: invented names, no bank data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { CROSS_WORKSPACE_REFERENCE_COLUMNS } from '../../dist/core/data/idRemap.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { enableSyncPublish } from '../../dist/core/sync/index.js';
import { postEntry, reverseEntry, getAuditLog } from '../../dist/core/ledger/index.js';
import { createContact } from '../../dist/core/sales/index.js';

/** One book (production ids), `names.length` workspaces in it. */
function book(names = ['Probe Grafik GmbH']) {
  const clock = fixedClock('2026-07-19T00:00:00.000Z');
  const ids = systemIdGen;
  const store = new SqliteStore({ clock });
  const tenants = names.map((name) => {
    const workspaceId = createWorkspace({ store, clock, ids }, { name }).workspaceId;
    const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
    const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
    return { workspaceId, ctx, acc };
  });
  return { store, clock, ids, tenants };
}

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function post(t, key, amount) {
  return must(
    postEntry(t.ctx, {
      date: '2026-03-01',
      description: 'Büromaterial',
      source: 'manual',
      idempotencyKey: key,
      lines: [
        { account: t.acc('6500'), debit: amount },
        { account: t.acc('1000'), credit: amount },
      ],
    }),
    'post_entry',
  );
}

const depsOf = (b, dir) => ({ store: b.store, clock: b.clock, ids: b.ids, actor: 'user_1', backupDir: join(dir, 'b') });

/** Edit a backup's data.sqlite the way anyone holding the file can, then recompute its checksum. */
function tamper(artifactRef, edit) {
  const file = join(artifactRef, 'data.sqlite');
  const snap = new Database(file);
  for (const t of snap.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) snap.exec(`DROP TRIGGER "${t.name}"`);
  snap.pragma('foreign_keys = OFF');
  edit(snap);
  snap.close();
  const manifestPath = join(artifactRef, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(file);
  manifest.files['data.sqlite'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

const workspaces = (b) => b.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;

// --- R1-M2 -----------------------------------------------------------------------------------------

test('R1-M2 a restored copy of a PUBLISHING workspace lands with the dial OFF and a fresh epoch; the source keeps both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const b = book();
    const [t] = b.tenants;
    must(enableSyncPublish(t.ctx, { idempotencyKey: 'pub' }), 'enable_sync_publish');
    post(t, 'p1', 1000);
    const state = (db, ws) => db.prepare('SELECT publishing, epoch FROM sync_publish_state WHERE workspace_id = ?').get(ws);
    const before = { ...state(b.store.db, t.workspaceId) };
    assert.equal(before.publishing, 1);
    assert.equal(typeof before.epoch, 'string');
    const bkp = must(createBackup(depsOf(b, dir), { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'create_backup');

    // Beside the original.
    const beside = must(restoreBackup(depsOf(b, dir), { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), 'restore beside');
    const copy = state(b.store.db, beside.workspaceId);
    assert.equal(copy.publishing, 0, 'egress is consent: a copy never inherits an ON dial');
    assert.equal(typeof copy.epoch, 'string');
    assert.notEqual(copy.epoch, before.epoch, 'the copy streams under its own epoch, so a consumer sees the fork');
    assert.deepEqual({ ...state(b.store.db, t.workspaceId) }, before, 'the source dial and epoch are untouched');

    // Into an empty book (the disaster case): the same.
    const fresh = book(['Leer AG']);
    const empty = must(restoreBackup(depsOf(fresh, join(dir, 'f')), { source: bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true }), 'restore empty');
    const moved = state(fresh.store.db, empty.workspaceId);
    assert.equal(moved.publishing, 0);
    assert.notEqual(moved.epoch, before.epoch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-M2 a workspace that never published restores with no stream minted for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const b = book();
    const [t] = b.tenants;
    post(t, 'p1', 1000);
    const bkp = must(createBackup(depsOf(b, dir), { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
    const r = must(restoreBackup(depsOf(b, dir), { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), 'restore');
    const copy = b.store.db.prepare('SELECT publishing, epoch FROM sync_publish_state WHERE workspace_id = ?').get(r.workspaceId);
    assert.ok(copy === undefined || (copy.publishing === 0 && copy.epoch === null), JSON.stringify(copy));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1-M3 -----------------------------------------------------------------------------------------

/** Two tenants in one book; the backup of the second is edited by `edit(snap, victim)`. */
function crossTenant(dir, edit, seed = () => {}) {
  const b = book(['Opfer AG', 'Andere GmbH']);
  const [victim, other] = b.tenants;
  seed(b, victim);
  const victimEntry = post(victim, 'v1', 7000).entryId;
  const victimContact = must(createContact(victim.ctx, { partyRole: 'vendor', name: 'Lieferant des Opfers AG', idempotencyKey: 'vc' }), 'contact').contact.id;
  post(other, 'o1', 2500);
  must(createContact(other.ctx, { partyRole: 'vendor', name: 'Eigener Lieferant GmbH', idempotencyKey: 'oc' }), 'contact');
  const bkp = must(createBackup(depsOf(b, dir), { workspaceId: other.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
  if (edit !== null) tamper(bkp.artifactRef, (snap) => edit(snap, { entry: victimEntry, contact: victimContact, ws: other.workspaceId }));
  const count = workspaces(b);
  const restored = restoreBackup(depsOf(b, dir), { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
  return { b, victim, victimEntry, restored, count };
}

function assertRefused(res, table, column, count, b) {
  assert.equal(res.restored.ok, false, `the restore accepted a reference into another tenant: ${JSON.stringify(res.restored)}`);
  assert.equal(res.restored.error, 'restore_invariant_failed');
  assert.equal(res.restored.reason, 'foreign_reference');
  assert.equal(res.restored.table, table);
  assert.equal(res.restored.column, column);
  assert.equal(workspaces(b), count, 'a refused restore minted no workspace (the whole transaction rolled back)');
  const said = JSON.stringify(res.restored);
  assert.ok(!said.includes(res.victim.workspaceId) && !said.includes(res.victimEntry), `the refusal names the other tenant: ${said}`);
}

test('R1-M3 an entry edited to REVERSE another tenant\'s entry is refused (foreign_reference), and the victim can still reverse its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const res = crossTenant(dir, (snap, v) => snap.prepare('UPDATE journal_entry SET reverses_entry_id = ? WHERE workspace_id = ?').run(v.entry, v.ws));
    assertRefused(res, 'journal_entry', 'reverses_entry_id', res.count, res.b);
    // The global one-reversal index is untouched, so the victim's own correction path still works.
    const rev = reverseEntry(res.victim.ctx, { entryId: res.victimEntry, date: '2026-03-02', idempotencyKey: 'rev' });
    assert.equal(rev.ok, true, JSON.stringify(rev));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-M3 a journal line moved into another tenant\'s DRAFT entry is refused (the line is fenced by its account, the gate holds its entry)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    let draft;
    const res = crossTenant(
      dir,
      (snap, v) => {
        const line = snap.prepare('SELECT rowid AS rid FROM journal_line LIMIT 1').get();
        snap.prepare('UPDATE journal_line SET entry_id = ? WHERE rowid = ?').run(draft, line.rid);
      },
      (b, victim) => {
        // A DRAFT of the victim (a posted parent is already refused by the posted-row trigger, so the
        // draft is the case only the foreign-reference gate can see).
        draft = 'je_victim_draft';
        b.store.db
          .prepare("INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES (?, ?, '2026-03-01', 'draft', 'manual', '2026-03-01T00:00:00.000Z')")
          .run(draft, victim.workspaceId);
      },
    );
    assertRefused(res, 'journal_line', 'entry_id', res.count, res.b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-M3 the gate is read from the schema: a table this test invents is fenced without being named anywhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const b = book(['Opfer AG', 'Andere GmbH']);
    const [victim, other] = b.tenants;
    b.store.db.exec(
      `CREATE TABLE future_probe (
         id TEXT PRIMARY KEY,
         workspace_id TEXT NOT NULL REFERENCES workspace(id),
         contact_id TEXT REFERENCES contact(id)
       )`,
    );
    const victimContact = must(createContact(victim.ctx, { partyRole: 'vendor', name: 'Lieferant des Opfers AG', idempotencyKey: 'vc' }), 'contact').contact.id;
    const ownContact = must(createContact(other.ctx, { partyRole: 'vendor', name: 'Eigener Lieferant GmbH', idempotencyKey: 'oc' }), 'contact').contact.id;
    b.store.db.prepare("INSERT INTO future_probe (id, workspace_id, contact_id) VALUES ('fp_own', ?, ?)").run(other.workspaceId, ownContact);
    b.store.db.prepare("INSERT INTO future_probe (id, workspace_id, contact_id) VALUES ('fp_null', ?, NULL)").run(other.workspaceId);

    // Unedited, the new table restores: its own reference follows its row, a NULL stays NULL.
    const clean = must(createBackup(depsOf(b, dir), { workspaceId: other.workspaceId, idempotencyKey: 'bk-clean' }), 'create_backup');
    const ok = must(restoreBackup(depsOf(b, dir), { source: clean.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), 'clean restore');
    const rows = b.store.db
      .prepare('SELECT f.contact_id, c.workspace_id AS cws FROM future_probe f LEFT JOIN contact c ON c.id = f.contact_id WHERE f.workspace_id = ? ORDER BY f.contact_id')
      .all(ok.workspaceId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.cws), [null, ok.workspaceId]);

    // Edited to point into the victim's contacts: refused, naming the invented table.
    const edited = must(createBackup(depsOf(b, dir), { workspaceId: other.workspaceId, idempotencyKey: 'bk-edit' }), 'create_backup');
    tamper(edited.artifactRef, (snap) => snap.prepare("UPDATE future_probe SET contact_id = ? WHERE id = 'fp_null'").run(victimContact));
    const count = workspaces(b);
    const refused = restoreBackup(depsOf(b, dir), { source: edited.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.reason, 'foreign_reference');
    assert.equal(refused.table, 'future_probe');
    assert.equal(refused.column, 'contact_id');
    assert.equal(workspaces(b), count);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-M3 an UNEDITED backup of one tenant restores beside the other tenant (the fence refuses nothing legitimate)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const res = crossTenant(dir, null);
    assert.equal(res.restored.ok, true, JSON.stringify(res.restored));
    const audit = getAuditLog(makeContext(res.b.store, { workspaceId: res.restored.workspaceId, actor: 'user_1', clock: res.b.clock, ids: res.b.ids }));
    assert.equal(audit.chainVerified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R2-M2: the fence is at the chokepoint, not in the FK metadata ---------------------------------

/**
 * One book, two tenants, and a table this test invents with NO declared reference beyond its tenant
 * key: `target_ref` is an undeclared id column, `meta` a JSON column, `path` a structured value and
 * `note` prose. Nothing names any of them in the engine; the fence must hold them by the chokepoint's
 * own grammar.
 */
function inventedWorld() {
  const b = book(['Opfer AG', 'Andere GmbH']);
  const [victim, other] = b.tenants;
  b.store.db.exec(
    `CREATE TABLE undeclared_probe (
       id TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL REFERENCES workspace(id),
       target_ref TEXT,
       meta TEXT,
       path TEXT,
       note TEXT
     )`,
  );
  const victimContact = must(createContact(victim.ctx, { partyRole: 'vendor', name: 'Lieferant des Opfers AG', idempotencyKey: 'vc' }), 'contact').contact.id;
  const ownContact = must(createContact(other.ctx, { partyRole: 'vendor', name: 'Eigener Lieferant GmbH', idempotencyKey: 'oc' }), 'contact').contact.id;
  b.store.db
    .prepare('INSERT INTO undeclared_probe (id, workspace_id, target_ref, meta, path, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run('up_1', other.workspaceId, ownContact, JSON.stringify({ links: [ownContact] }), `contact/${ownContact}/rev1`, 'Lieferant geprüft');
  return { b, victim, other, victimContact, ownContact };
}

function restoreEdited(w, dir, key, edit) {
  const bkp = must(createBackup(depsOf(w.b, dir), { workspaceId: w.other.workspaceId, idempotencyKey: key }), 'create_backup');
  if (edit !== null) tamper(bkp.artifactRef, edit);
  const count = workspaces(w.b);
  return { restored: restoreBackup(depsOf(w.b, dir), { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), count };
}

function assertForeign(res, w, column, references) {
  assert.equal(res.restored.ok, false, `a value naming another tenant's row restored: ${JSON.stringify(res.restored)}`);
  assert.equal(res.restored.error, 'restore_invariant_failed');
  assert.equal(res.restored.reason, 'foreign_reference');
  assert.equal(res.restored.table, 'undeclared_probe');
  assert.equal(res.restored.column, column);
  assert.equal(res.restored.references, references);
  assert.equal(workspaces(w.b), res.count, 'the refused restore minted no workspace');
  assert.ok(!JSON.stringify(res.restored).includes(w.victimContact), 'the refusal never names the other tenant\'s row');
}

test('R2-M2 an UNEDITED backup: every undeclared reference form follows its own row, prose is copied verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const w = inventedWorld();
    const res = restoreEdited(w, dir, 'bk', null);
    assert.equal(res.restored.ok, true, JSON.stringify(res.restored));
    const row = w.b.store.db.prepare('SELECT * FROM undeclared_probe WHERE workspace_id = ?').get(res.restored.workspaceId);
    const copied = w.b.store.db.prepare('SELECT id FROM contact WHERE id = ? AND workspace_id = ?').get(row.target_ref, res.restored.workspaceId);
    assert.ok(copied, 'target_ref names the restored contact');
    assert.deepEqual(JSON.parse(row.meta), { links: [row.target_ref] });
    assert.equal(row.path, `contact/${row.target_ref}/rev1`);
    assert.equal(row.note, 'Lieferant geprüft');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-M2 an undeclared id column edited to another tenant\'s row is refused, the column never named in the engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const w = inventedWorld();
    const res = restoreEdited(w, dir, 'bk', (snap) => snap.prepare("UPDATE undeclared_probe SET target_ref = ? WHERE id = 'up_1'").run(w.victimContact));
    assertForeign(res, w, 'target_ref', 'contact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-M2 an id inside a JSON column naming another tenant\'s row is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const w = inventedWorld();
    const res = restoreEdited(w, dir, 'bk', (snap) =>
      snap.prepare("UPDATE undeclared_probe SET meta = ? WHERE id = 'up_1'").run(JSON.stringify({ links: [w.ownContact, { nested: w.victimContact }] })),
    );
    assertForeign(res, w, 'meta', 'contact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-M2 an id inside a structured value (a path) naming another tenant\'s row is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const w = inventedWorld();
    const res = restoreEdited(w, dir, 'bk', (snap) => snap.prepare("UPDATE undeclared_probe SET path = ? WHERE id = 'up_1'").run(`contact/${w.victimContact}/rev1`));
    assertForeign(res, w, 'path', 'contact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-M2 prose that MENTIONS another tenant\'s id is not a reference: it restores, copied verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const w = inventedWorld();
    const sentence = `Rückfrage zu ${w.victimContact} beim Lieferanten`;
    const res = restoreEdited(w, dir, 'bk', (snap) => snap.prepare("UPDATE undeclared_probe SET note = ? WHERE id = 'up_1'").run(sentence));
    assert.equal(res.restored.ok, true, JSON.stringify(res.restored));
    assert.equal(w.b.store.db.prepare('SELECT note FROM undeclared_probe WHERE workspace_id = ?').get(res.restored.workspaceId).note, sentence);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-M2 the one documented crossing: migration_plan.testmandant_workspace_id passes the fence and is then CLEARED (the copy does not own its sibling), and the same value elsewhere is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-fence-'));
  try {
    const w = inventedWorld();
    // The victim workspace plays the test mandate of the other tenant's migration plan, mid-trial.
    w.b.store.db
      .prepare("INSERT INTO migration_plan (id, workspace_id, status, created_at, testmandant_workspace_id) VALUES ('mplan_1', ?, 'trial', '2026-07-01T00:00:00.000Z', ?)")
      .run(w.other.workspaceId, w.victim.workspaceId);
    const ok = restoreEdited(w, dir, 'bk-ok', null);
    assert.equal(ok.restored.ok, true, JSON.stringify(ok.restored));
    const plan = w.b.store.db.prepare('SELECT testmandant_workspace_id AS t, status FROM migration_plan WHERE workspace_id = ?').get(ok.restored.workspaceId);
    // Before 11.10.2026 the copy kept naming the ORIGINAL's Testmandant, and its discard deleted it.
    assert.equal(plan.t, null, 'the restored plan no longer names a sibling it does not own');
    assert.equal(plan.status, 'planned', 'a mid-trial plan goes back to planned');
    const original = w.b.store.db.prepare("SELECT testmandant_workspace_id AS t, status FROM migration_plan WHERE id = 'mplan_1'").get();
    assert.deepEqual([original.t, original.status], [w.victim.workspaceId, 'trial'], 'the original keeps its link and its trial');

    const res = restoreEdited(w, dir, 'bk-edit', (snap) => snap.prepare("UPDATE undeclared_probe SET target_ref = ? WHERE id = 'up_1'").run(w.victim.workspaceId));
    assertForeign(res, w, 'target_ref', 'workspace');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-M2 every CROSS_WORKSPACE_REFERENCE_COLUMNS entry names a real column, with a reason', () => {
  const store = new SqliteStore({});
  for (const [key, reason] of Object.entries(CROSS_WORKSPACE_REFERENCE_COLUMNS)) {
    const [table, column] = key.split('.');
    const cols = store.db.pragma(`table_info("${table}")`).map((c) => c.name);
    assert.ok(cols.includes(column), `stale allowlist entry ${key}`);
    assert.ok(typeof reason === 'string' && reason.length > 10, `${key} carries no reason`);
  }
});

// --- R3-L1: the fence's cost does not grow per table per chunk ------------------------------------

test('R3-L1 at volume (20\'000 unmapped tokens of a prefix no table carries) the fence still finds the ONE foreign row, and passes a clean crowd', async () => {
  const { RestoreIdMap } = await import('../../dist/core/data/idRemap.js');
  const { assertUnmappedStayInside, restoreLoadTables } = await import('../../dist/core/data/portability.js');
  const { randomUUID } = await import('node:crypto');
  const b = book(['Opfer AG', 'Quelle AG', 'Neu AG']);
  const [victim, source, fresh] = b.tenants;
  const victimContact = must(createContact(victim.ctx, { partyRole: 'vendor', name: 'Lieferant des Opfers AG', idempotencyKey: 'vc' }), 'contact').contact.id;
  const loaded = restoreLoadTables(b.store.db);
  const crowd = () => {
    const remap = new RestoreIdMap();
    // The idempotency-key shape the critic measured: one `vbk_` run per posted entry, naming no row.
    for (let i = 0; i < 20000; i += 1) remap.remapValue('journal_entry', 'idempotency_key', `vendor-bill-post-x-vbk_${randomUUID()}`);
    return remap;
  };
  const clean = crowd();
  b.store.tx(() => assertUnmappedStayInside(b.store.db, clean, fresh.workspaceId, source.workspaceId, loaded));
  const dirty = crowd();
  dirty.remapValue('undeclared_column_of_a_future_table', 'target_ref', victimContact);
  assert.throws(
    () => b.store.tx(() => assertUnmappedStayInside(b.store.db, dirty, fresh.workspaceId, source.workspaceId, loaded)),
    (e) => e.reason === 'foreign_reference' && e.detail.table === 'undeclared_column_of_a_future_table' && e.detail.references === 'contact',
  );
});
