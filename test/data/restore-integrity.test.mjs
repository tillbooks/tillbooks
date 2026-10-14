/**
 * G04 restore: what the id chokepoint must NOT do (spec G04 §0c items 2 and 4).
 *
 *  - The audit chain is VERIFIED at the source and re-sealed only when it verified. Before the
 *    redesign a restore re-hashed every row blindly, so a TAMPERED or TRUNCATED source log came back
 *    as a clean, verifying chain: a restore laundered the tamper evidence (measured below against the
 *    blind re-hash itself). Now the break is carried to the same row and the copy fails verification
 *    exactly as the source does.
 *  - A value that names a source id present in two tables refuses the restore, whole, instead of
 *    guessing which row it meant.
 *  - A global UNIQUE natural key (a portal grant's token hash) does not kill a restore beside the
 *    original: the copy's grant lands revoked, the original's link keeps working.
 *
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getAction } from '../../dist/api/registry.js';
import { auditCanonicalRow, auditHashRow, AUDIT_GENESIS_PREV } from '../../dist/core/ledger/auditLog.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

/** A workspace with four posted entries (so a chain of several audit rows) and a backup dir. */
function world(dir) {
  const deps = { ...freshDeps(), backupDir: join(dir, 'b') };
  const { workspaceId, accId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  for (let i = 1; i <= 4; i += 1) assert.equal(call('post_entry', manualPost(accId, `p-${i}`, 1000 * i)).ok, true);
  return { deps, workspaceId, call };
}

function auditOf(deps, workspaceId) {
  const res = getAction('get_audit_log').run(deps, { workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

function backupAndRestore(w, key) {
  const bkp = w.call('create_backup', { idempotencyKey: key });
  assert.equal(bkp.ok, true, JSON.stringify(bkp));
  return getAction('restore_backup').run(w.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
}

/** The position of a restored audit row id inside its workspace's chain. */
function positionOf(deps, workspaceId, id) {
  return deps.store.db.prepare('SELECT id FROM audit_log WHERE workspace_id = ? ORDER BY rowid').all(workspaceId).findIndex((r) => r.id === id);
}

test('a VERIFIED source chain is re-sealed: the copy verifies, row for row, under its new identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-int-'));
  try {
    const w = world(dir);
    const source = auditOf(w.deps, w.workspaceId);
    assert.equal(source.chainVerified, true);
    const sourceHead = w.deps.store.db.prepare('SELECT head_hash FROM audit_head WHERE workspace_id = ?').get(w.workspaceId).head_hash;
    const restored = backupAndRestore(w, 'bk');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.deepEqual(restored.auditChain, { verified: true, rows: source.rows.length, sourceHeadHash: sourceHead });
    const copy = auditOf(w.deps, restored.workspaceId);
    assert.equal(copy.chainVerified, true, 'the appended restore record must not break a re-sealed chain');
    assert.deepEqual(copy.rows.slice(0, -1).map((r) => [r.action, r.actor, r.at]), source.rows.map((r) => [r.action, r.actor, r.at]));
    // R1-L1: the last row records the restore itself, the verdict and the SOURCE anchor it was
    // re-sealed from, so an externally anchored source head ties to the copy.
    const record = copy.rows.at(-1);
    assert.equal(record.entityKind, 'workspace');
    assert.equal(record.action, 'import');
    assert.deepEqual(JSON.parse(record.entityId), { restoredFrom: { chain: 'verified', sourceHead, sourceRows: source.rows.length } });
    // Every hash is new (the workspace id is a hash input), none copied.
    const sourceHashes = new Set(source.rows.map((r) => r.hash));
    assert.ok(copy.rows.every((r) => !sourceHashes.has(r.hash)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TAMPERED source chain is carried broken at the same row, never laundered into a clean one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-int-'));
  try {
    const w = world(dir);
    const rows = w.deps.store.db.prepare('SELECT id FROM audit_log WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId);
    assert.ok(rows.length >= 4);
    const victim = 2;
    // A forger edits one historical row in place (the actor), leaving every hash as it was.
    w.deps.store.db.prepare("UPDATE audit_log SET actor = 'mallory' WHERE id = ?").run(rows[victim].id);
    const source = auditOf(w.deps, w.workspaceId);
    assert.equal(source.chainVerified, false);
    assert.equal(source.brokenAtId, rows[victim].id);

    const restored = backupAndRestore(w, 'bk');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.auditChain.verified, false);
    assert.equal(restored.auditChain.brokenAtRow, victim);
    const copy = auditOf(w.deps, restored.workspaceId);
    assert.equal(copy.chainVerified, false, 'the restore must not launder the tampering');
    assert.equal(positionOf(w.deps, restored.workspaceId, copy.brokenAtId), victim, 'broken at the same row');
    // The forged content itself is carried as it was (the evidence stays readable).
    assert.equal(copy.rows[victim].actor, 'mallory');
    // R1-L1: the restore record names the verdict it carried, and appending it mended nothing.
    assert.deepEqual(JSON.parse(copy.rows.at(-1).entityId).restoredFrom.chain, 'broken');
    assert.equal(JSON.parse(copy.rows.at(-1).entityId).restoredFrom.brokenAtRow, victim);

    // Non-vacuous: the pre-redesign blind re-hash WOULD have produced a verifying chain here.
    let prev = AUDIT_GENESIS_PREV;
    const all = w.deps.store.db.prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY rowid').all(restored.workspaceId);
    for (const r of all) {
      prev = auditHashRow(prev, auditCanonicalRow({ id: r.id, workspaceId: r.workspace_id, entityKind: r.entity_kind, entityId: r.entity_id, action: r.action, actor: r.actor, at: r.at }));
    }
    assert.notEqual(all.at(-1).hash, prev, 'a blind re-hash yields a different, VERIFYING tail: the carried chain is not it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TRUNCATED source log (tail row deleted, head kept) and a tampered head stay unverifiable in the copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-int-'));
  try {
    // Truncation: the surviving prefix links perfectly; only the head anchor tells.
    const w = world(dir);
    const last = w.deps.store.db.prepare('SELECT rowid AS rid FROM audit_log WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(w.workspaceId);
    w.deps.store.db.prepare('DELETE FROM audit_log WHERE rowid = ?').run(last.rid);
    assert.equal(auditOf(w.deps, w.workspaceId).chainVerified, false);
    const restored = backupAndRestore(w, 'bk');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.auditChain.verified, false);
    assert.equal(restored.auditChain.brokenAtRow, undefined, 'every surviving link verified; the ANCHOR is what fails');
    const truncatedCopy = auditOf(w.deps, restored.workspaceId);
    assert.equal(truncatedCopy.chainVerified, false, 'the appended restore record must not re-anchor a truncated log');
    assert.equal(JSON.parse(truncatedCopy.rows.at(-1).entityId).restoredFrom.chain, 'broken');

    // A tampered head hash.
    const dir2 = mkdtempSync(join(tmpdir(), 'g04-int-'));
    try {
      const v = world(dir2);
      v.deps.store.db.prepare("UPDATE audit_head SET head_hash = 'forged' WHERE workspace_id = ?").run(v.workspaceId);
      assert.equal(auditOf(v.deps, v.workspaceId).chainVerified, false);
      const r2 = backupAndRestore(v, 'bk');
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.equal(r2.auditChain.verified, false);
      assert.equal(auditOf(v.deps, r2.workspaceId).chainVerified, false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an AMBIGUOUS source id (the same id in two tables) refuses the restore when a value names it; nothing is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-int-'));
  try {
    const w = world(dir);
    const db = w.deps.store.db;
    // Two rows in two tables share one id (only a sequence-id book can do this), and a free-standing
    // value names that id: no rule can know which row it means.
    const shared = 'shared_1';
    db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES (?, ?, 'CC1', 'Werkstatt')").run(shared, w.workspaceId);
    db.prepare("INSERT INTO item_category (id, workspace_id, name, created_at) VALUES (?, ?, 'Kaffee', '2026-01-01')").run(shared, w.workspaceId);
    const workspaces = db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
    // Without a value naming it, the restore goes through (declared FKs resolve per table).
    const clean = backupAndRestore(w, 'bk-clean');
    assert.equal(clean.ok, true, JSON.stringify(clean));
    // `contact.company_contact_id` declares no foreign key, so only the chokepoint can resolve it.
    db.prepare("INSERT INTO contact (id, workspace_id, party_role, name, created_at, kind, company_contact_id) VALUES ('ct_x', ?, 'customer', 'Muster Hans', '2026-01-01', 'person', ?)").run(w.workspaceId, shared);
    const refused = backupAndRestore(w, 'bk-ambiguous');
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'restore_invariant_failed');
    assert.equal(refused.reason, 'ambiguous_reference');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, workspaces + 1, 'only the clean restore minted a workspace');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a portal grant restores BESIDE the original as a revoked copy (the live link stays the original\'s), and into an empty book with its link kept as a draft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-int-'));
  try {
    const w = world(dir);
    const db = w.deps.store.db;
    db.prepare("INSERT INTO contact (id, workspace_id, party_role, name, created_at, kind) VALUES ('ct_portal', ?, 'customer', 'Portal AG', '2026-01-01', 'company')").run(w.workspaceId);
    const hash = 'a'.repeat(64);
    db.prepare(
      `INSERT INTO portal_grant (id, workspace_id, contact_id, kind, token_hash, scopes, expires_at, local_artifact_json, created_by, created_at, updated_at)
       VALUES ('pg_1', ?, 'ct_portal', 'customer', ?, '[]', '2030-01-01', '{}', 'user_1', '2026-01-01', '2026-01-01')`,
    ).run(w.workspaceId, hash);

    const bkp = w.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const beside = getAction('restore_backup').run(w.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(beside.ok, true, `a restore beside the original used to die on the token_hash UNIQUE: ${JSON.stringify(beside)}`);
    const copy = db.prepare('SELECT id, token_hash, revoked_at FROM portal_grant WHERE workspace_id = ?').get(beside.workspaceId);
    assert.notEqual(copy.token_hash, hash);
    assert.ok(copy.token_hash.includes(':'), 'the marker can never equal a sha256 hex digest');
    assert.notEqual(copy.revoked_at, null);
    assert.deepEqual({ ...db.prepare('SELECT token_hash, revoked_at FROM portal_grant WHERE id = ?').get('pg_1') }, { token_hash: hash, revoked_at: null });

    // Into an EMPTY book (the laptop died): the grant keeps the customer's link (its hash), and lands a
    // draft awaiting a new hand-over (D161.2), so a link revoked after the backup cannot open it.
    const fresh = { ...freshDeps(), backupDir: join(dir, 'b2') };
    const empty = getAction('restore_backup').run(fresh, { source: bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true });
    assert.equal(empty.ok, true, JSON.stringify(empty));
    const moved = fresh.store.db.prepare('SELECT token_hash, revoked_at, sent_at, minted_draft FROM portal_grant WHERE workspace_id = ?').get(empty.workspaceId);
    assert.deepEqual({ ...moved }, { token_hash: hash, revoked_at: null, sent_at: null, minted_draft: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
