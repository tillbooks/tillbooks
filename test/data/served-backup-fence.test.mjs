/**
 * Security review F2 (Medium) and F3 (Medium), as re-decided by the D59 critic: `restore_backup` is
 * refused to EVERY served subject (member or stranger), and the machine-state reads are refused too.
 *
 * F2 (critic decision, fail-closed): restore is a LOCAL operator action. Threading `identitySource`
 * denied the STRANGER but SEATED a served MEMBER as owner of the restored copy, which turned an
 * unreadable orphan into a cross-tenant read of whatever bundle the member named. So a served subject
 * is denied restore outright, at the top of the verb.
 *
 * F3: `list_restorable_backups`, `verify_backup` AND the unconfirmed `restore_backup` PLAN (which ran
 * `verifyBackup` before any gate) are refused for a served subject: no machine-directory disclosure,
 * no `/etc` vs `/nope` existence oracle, no foreign-bundle entry count. A LOCAL operator keeps them.
 *
 * Money-path discipline: the happy path is unchanged and asserted below (a LOCAL restore still
 * round-trips), only the served-subject GATE is added.
 *
 * BITE F2/F3: remove `refuseServedRestore(deps) ??` from `dist/api/data-actions.js` and the stranger,
 * member and plan-oracle tests redden. Remove `refuseServedMachineRead(deps) ??` and the list/verify
 * disclosure tests redden.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { SERVED_STRANGER_ACTOR } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

function seatServedMember(deps, workspaceId, email, role, key) {
  const invited = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: `${key}:inv` });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const accepted = call(served(deps, email), 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);
  return resolveServedActor(deps.store, email).actor;
}

/** A world with a temp backup dir, a mandate seeded with a couple of posted entries, and a backup. */
function backedUpWorld() {
  const deps = freshDeps();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-f2f3-'));
  const { workspaceId, accId } = mintWorkspace(deps, 'Mandate One', 'ws1');
  for (let i = 0; i < 2; i += 1) {
    const posted = call(deps, 'post_entry', { workspaceId, ...manualPost(accId, `p-${i}`, 1000 * (i + 1)) });
    assert.equal(posted.ok, true, `seed post failed: ${JSON.stringify(posted)}`);
  }
  const backup = call(deps, 'create_backup', { workspaceId, idempotencyKey: 'bkp' });
  assert.equal(backup.ok, true, `create_backup failed: ${JSON.stringify(backup)}`);
  return { deps, workspaceId, source: backup.artifactRef };
}

const workspaceCount = (deps) => deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;

test('F2: a served STRANGER cannot restore_backup, and no orphan workspace is minted', () => {
  const { deps, source } = backedUpWorld();
  const stranger = served(deps, 'nobody@evil.example');
  assert.equal(stranger.actor, SERVED_STRANGER_ACTOR, 'the unknown subject resolves to the stranger sentinel');

  const before = workspaceCount(deps);
  const res = call(stranger, 'restore_backup', { source, newWorkspaceName: 'Stolen Copy', confirmed: true, idempotencyKey: 'r1' });
  assert.equal(res.ok, false, `a served stranger must be refused restore_backup: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'permission_denied', 'the D111 gate refuses, permission_denied-shaped');
  assert.equal(workspaceCount(deps), before, 'no orphan copy of another mandate may be minted');

  rmSync(deps.backupDir, { recursive: true, force: true });
});

test('F2: a served MEMBER cannot restore ANY bundle (their own or another mandate`s): no seat, no mint', () => {
  const { deps, workspaceId, source } = backedUpWorld();
  seatServedMember(deps, workspaceId, 'alice@client.example', 'owner', 'alice');
  const alice = served(deps, 'alice@client.example');
  assert.ok(alice.actor.startsWith('member:'), 'sanity: alice is a bound served member, not the stranger');

  const before = workspaceCount(deps);
  // Their OWN mandate's bundle: still denied (restore is a local operator action in the rc).
  const own = call(alice, 'restore_backup', { source, newWorkspaceName: 'Own Copy', confirmed: true, idempotencyKey: 'r2' });
  assert.equal(own.ok, false, `a served member must be refused restore, even of their own bundle: ${JSON.stringify(own)}`);
  assert.equal(own.error, 'permission_denied');

  // A FOREIGN mandate's bundle: the cross-tenant read the critic found. Denied, nothing minted, no seat.
  const foreign = call(deps, 'create_backup', { workspaceId, idempotencyKey: 'foreign-bkp' }); // stand-in bundle
  const cross = call(alice, 'restore_backup', { source: foreign.artifactRef, newWorkspaceName: 'Cross', confirmed: true, idempotencyKey: 'r2b' });
  assert.equal(cross.ok, false, `a served member must be refused a foreign bundle: ${JSON.stringify(cross)}`);
  assert.equal(cross.error, 'permission_denied');

  assert.equal(workspaceCount(deps), before, 'no workspace may be minted for a served member restore');

  rmSync(deps.backupDir, { recursive: true, force: true });
});

test('F2 money-path: a LOCAL restore is UNAFFECTED and round-trips the ledger', () => {
  const { deps, source } = backedUpWorld();
  const before = workspaceCount(deps);
  const res = call(deps, 'restore_backup', { source, newWorkspaceName: 'Local Restore', confirmed: true, idempotencyKey: 'r3' });
  assert.equal(res.ok, true, `a local restore must still work: ${JSON.stringify(res)}`);
  assert.equal(workspaceCount(deps), before + 1, 'the local restore mints exactly one new workspace');
  // The restored ledger carries the two posted entries (round-trip fidelity, unchanged).
  const entries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(res.workspaceId).n;
  assert.equal(entries, 2, 'the restored copy holds the source ledger');

  rmSync(deps.backupDir, { recursive: true, force: true });
});

test('F3: a served subject is refused list_restorable_backups and verify_backup (no disclosure, no oracle)', () => {
  const { deps, workspaceId, source } = backedUpWorld();
  seatServedMember(deps, workspaceId, 'alice@client.example', 'owner', 'alice');

  for (const subject of ['nobody@evil.example', 'alice@client.example']) {
    const who = served(deps, subject);
    const listed = call(who, 'list_restorable_backups', {});
    assert.equal(listed.ok, false, `${subject}: list_restorable_backups must be refused: ${JSON.stringify(listed)}`);
    assert.equal(listed.error, 'permission_denied');

    // The real bundle: refused (no metadata disclosure).
    const verify = call(who, 'verify_backup', { source });
    assert.equal(verify.ok, false, `${subject}: verify_backup must be refused: ${JSON.stringify(verify)}`);
    assert.equal(verify.error, 'permission_denied');

    // An arbitrary absolute path: refused the SAME way (no existence oracle for /etc vs a missing path).
    const oracleHit = call(who, 'verify_backup', { source: '/etc' });
    const oracleMiss = call(who, 'verify_backup', { source: '/definitely-not-here-xyz' });
    assert.equal(oracleHit.error, 'permission_denied', `${subject}: /etc must not be an existence oracle`);
    assert.equal(oracleMiss.error, 'permission_denied', `${subject}: a missing path must not be distinguishable`);
  }

  rmSync(deps.backupDir, { recursive: true, force: true });
});

test('F3 plan oracle: the UNCONFIRMED restore_backup plan is refused for a served subject (no existence oracle)', () => {
  const { deps, source } = backedUpWorld();
  const stranger = served(deps, 'nobody@evil.example');

  // Before the fix the plan ran verifyBackup before any gate, so these three answered differently
  // (manifest_missing / source_missing / a real entry count). Now all three are one refusal shape.
  const onEtc = call(stranger, 'restore_backup', { source: '/etc', newWorkspaceName: 'x' }); // exists, not a bundle
  const onMissing = call(stranger, 'restore_backup', { source: '/definitely-not-here-xyz', newWorkspaceName: 'x' });
  const onReal = call(stranger, 'restore_backup', { source, newWorkspaceName: 'x' }); // a real bundle

  for (const [label, res] of [['/etc', onEtc], ['missing', onMissing], ['real-bundle', onReal]]) {
    assert.equal(res.ok, false, `${label}: the unconfirmed plan must be refused: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'permission_denied', `${label}: no manifest_missing/source_missing/entryCount may leak`);
  }

  rmSync(deps.backupDir, { recursive: true, force: true });
});

test('F3: a LOCAL operator keeps list_restorable_backups and verify_backup', () => {
  const { deps, source } = backedUpWorld();
  const listed = call(deps, 'list_restorable_backups', {});
  assert.equal(listed.ok, true, `local list_restorable_backups must work: ${JSON.stringify(listed)}`);
  const verify = call(deps, 'verify_backup', { source });
  assert.equal(verify.ok, true, `local verify_backup must work: ${JSON.stringify(verify)}`);

  rmSync(deps.backupDir, { recursive: true, force: true });
});
