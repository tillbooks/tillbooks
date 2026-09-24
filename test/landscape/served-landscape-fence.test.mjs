/**
 * Security review F1 (High): a served OWNER writes and deletes arbitrary host files through the
 * `env_*` family, because those verbs resolve `landscape.manage` against the caller's WORKSPACE
 * membership (an owner holds it) while the operation writes the host-level control file and arbitrary
 * data roots. Two layers close it, both proven to BITE here:
 *
 *   1. SERVED FENCE (`src/api/env-actions.ts`, `stagedWrite`): every `env_*` WRITE is refused for a
 *      served subject, driven through the registry as a served OWNER exactly as the drill's door does.
 *   2. PATH CONFINEMENT (`src/core/landscape/operations.ts`, `envCreate`): a caller-supplied `dbPath`
 *      is confined to the environments root for EVERY face (a local agent seat with `landscape.manage`
 *      had the same primitive over stdio), driven at the engine seam like the rest of landscape.test.
 *
 * BITE, layer 1: remove the `ctx.identitySource === 'served_subject'` guard from
 * `dist/api/env-actions.js` and the served-owner tests redden (the create/delete/switch return ok).
 * BITE, layer 2: remove the confinement block from `dist/core/landscape/operations.js` and the
 * out-of-root / sidecar / existing-target tests redden (the write lands and the sentinel is clobbered).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envCreate, envList } from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

/** The per-request deps a served request runs under, resolved exactly as the transport does. */
function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

/** Seat `subject` as a real served member of `workspaceId` (invite + served accept). */
function seatServedMember(deps, workspaceId, email, role, key) {
  const invited = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: `${key}:inv` });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const accepted = call(served(deps, email), 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);
  const actor = resolveServedActor(deps.store, email).actor;
  assert.ok(actor.startsWith('member:'), `expected a bound member actor, got ${actor}`);
  return actor;
}

/** A LandscapeDeps for the engine-seam confinement tests (mirrors landscape.test.mjs makeDeps). */
function makeLandscapeDeps(dir) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-09-16T00:00:00.000Z',
    seeders: { minimal: (target) => new SqliteStore({ location: target }).close() },
  };
}

test('F1 served fence: a served OWNER is refused every env_* write, and the sentinel is untouched', () => {
  const deps = freshDeps();
  const supportDir = mkdtempSync(join(tmpdir(), 'till-f1-support-'));
  deps.supportDir = supportDir;
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  const alice = seatServedMember(deps, w1, 'alice@client.example', 'owner', 'alice');
  assert.ok(alice.startsWith('member:'), 'sanity: alice is a bound served OWNER, not the stranger');

  // A sentinel standing in for another tenant's file on the host.
  const sentinelDir = mkdtempSync(join(tmpdir(), 'till-f1-sentinel-'));
  const sentinel = join(sentinelDir, 'other-tenant.sqlite');
  const SENTINEL_BYTES = "SENTINEL: another tenant's bytes";
  writeFileSync(sentinel, SENTINEL_BYTES);

  const owner = served(deps, 'alice@client.example');

  // env_create against the sentinel: refused before any host write.
  const created = call(owner, 'env_create', {
    workspaceId: w1,
    name: 'pwn',
    policy: 'live',
    dbPath: sentinel,
    confirmed: true,
    idempotencyKey: 'pwn1',
  });
  assert.equal(created.ok, false, `a served owner must be refused env_create: ${JSON.stringify(created)}`);
  assert.equal(created.error, 'permission_denied', 'the refusal is permission_denied-shaped');

  // The plan form is refused too (a served subject learns nothing about the landscape).
  const plan = call(owner, 'env_create', { workspaceId: w1, name: 'pwn2', policy: 'live', dbPath: sentinel });
  assert.equal(plan.ok, false, 'the unconfirmed plan is refused as well');
  assert.equal(plan.error, 'permission_denied');

  // env_switch / env_reset / env_delete are refused the same way.
  for (const [name, input] of [
    ['env_switch', { workspaceId: w1, name: 'main', confirmed: true, idempotencyKey: 'sw1' }],
    ['env_reset', { workspaceId: w1, name: 'develop', confirmed: true, idempotencyKey: 'rs1' }],
    ['env_delete', { workspaceId: w1, name: 'develop', force: true, confirmed: true, idempotencyKey: 'dl1' }],
  ]) {
    const res = call(owner, name, input);
    assert.equal(res.ok, false, `a served owner must be refused ${name}: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'permission_denied', `${name} refusal is permission_denied`);
  }

  // The sentinel is byte-identical: nothing was written or deleted.
  assert.equal(existsSync(sentinel), true, 'the sentinel still exists');
  assert.equal(readFileSync(sentinel, 'utf8'), SENTINEL_BYTES, 'the sentinel bytes are untouched');

  rmSync(supportDir, { recursive: true, force: true });
  rmSync(sentinelDir, { recursive: true, force: true });
});

test('F1 served fence: the READS stay open to a served owner (only the writes are host-scoped)', () => {
  const deps = freshDeps();
  const supportDir = mkdtempSync(join(tmpdir(), 'till-f1-reads-'));
  deps.supportDir = supportDir;
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  seatServedMember(deps, w1, 'alice@client.example', 'owner', 'alice');
  const owner = served(deps, 'alice@client.example');

  const listed = call(owner, 'env_list', { workspaceId: w1 });
  assert.equal(listed.ok, true, `env_list must stay available to a served owner: ${JSON.stringify(listed)}`);
  assert.ok(Array.isArray(listed.environments), 'env_list returns the landscape');

  rmSync(supportDir, { recursive: true, force: true });
});

test('F1 confinement: env_create refuses a dbPath outside the environments root, and leaves the sentinel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-f1-confine-'));
  try {
    const deps = makeLandscapeDeps(dir);
    const sentinelDir = mkdtempSync(join(tmpdir(), 'till-f1-outside-'));
    const sentinel = join(sentinelDir, 'sentinel.sqlite');
    writeFileSync(sentinel, 'OUTSIDE');

    const res = envCreate(deps, { name: 'evil', policy: 'live', dbPath: sentinel, confirmed: true, idempotencyKey: 'e1' });
    assert.equal(res.ok, false, `an out-of-root dbPath must be refused: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'data_root_outside_environments_root');
    assert.equal(readFileSync(sentinel, 'utf8'), 'OUTSIDE', 'the out-of-root sentinel is untouched');

    // A WAL sidecar of main is outside the root too (the review's live-ledger clobber), refused.
    const wal = envCreate(deps, { name: 'wal', policy: 'live', dbPath: `${deps.mainDbPath}-wal`, confirmed: true, idempotencyKey: 'e2' });
    assert.equal(wal.ok, false, 'the live ledger WAL sidecar is not an accepted target');
    assert.equal(wal.error, 'data_root_outside_environments_root');

    rmSync(sentinelDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 confinement: env_create refuses a sidecar of a registered root, and an existing target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-f1-sidecar-'));
  try {
    const deps = makeLandscapeDeps(dir);
    const develop = envList(deps).environments.find((e) => e.name === 'develop');

    // A -wal sidecar of develop's registered data root (inside the environments root) is refused.
    const sidecar = envCreate(deps, { name: 'side', policy: 'live', dbPath: `${develop.dbPath}-wal`, confirmed: true, idempotencyKey: 's1' });
    assert.equal(sidecar.ok, false, `a sidecar of a registered root must be refused: ${JSON.stringify(sidecar)}`);
    assert.equal(sidecar.error, 'data_root_is_sidecar');

    // An existing file under the root is refused (never overwrite whatever was there).
    const existing = join(deps.environmentsRoot, 'occupied', 'till.db');
    mkdirSync(join(deps.environmentsRoot, 'occupied'), { recursive: true });
    writeFileSync(existing, 'ALREADY HERE');
    const clash = envCreate(deps, { name: 'occ', policy: 'live', dbPath: existing, confirmed: true, idempotencyKey: 's2' });
    assert.equal(clash.ok, false, `an existing target must be refused: ${JSON.stringify(clash)}`);
    assert.equal(clash.error, 'data_root_exists');
    assert.equal(readFileSync(existing, 'utf8'), 'ALREADY HERE', 'the existing file is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 confinement: an UPPERCASE -WAL sidecar is refused too (re-critic R2, case-insensitive FS)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-f1-wal-case-'));
  try {
    const deps = makeLandscapeDeps(dir);
    const develop = envList(deps).environments.find((e) => e.name === 'develop');

    // On a case-insensitive filesystem a `till.db-WAL` handed in aliases the operator's own `-wal`
    // sidecar. Pre-fix the sidecar regex was case-sensitive, so the uppercase spelling slipped through
    // (built a real SQLite file the OS later served as the env's WAL, or answered data_root_exists);
    // with the `i` flag it is refused as a sidecar exactly like the lowercase spelling.
    const upper = envCreate(deps, { name: 'walcase', policy: 'live', dbPath: `${develop.dbPath}-WAL`, confirmed: true, idempotencyKey: 'w1' });
    assert.equal(upper.ok, false, `an uppercase -WAL sidecar must be refused: ${JSON.stringify(upper)}`);
    assert.equal(upper.error, 'data_root_is_sidecar');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 confinement: env_create policy:copy is confined too (the D59 critic bypass), sentinel survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-f1-copy-'));
  try {
    const deps = makeLandscapeDeps(dir);
    const sentinelDir = mkdtempSync(join(tmpdir(), 'till-f1-copyout-'));
    const sentinel = join(sentinelDir, 'victim.sqlite');
    writeFileSync(sentinel, 'COPY-SENTINEL');

    // The critic's bypass: policy:'copy' routed past the confinement (it sat after the copy early
    // return). Now it is confined too, so an out-of-root dbPath is refused BEFORE any copy of main.
    const res = envCreate(deps, {
      name: 'clone',
      policy: 'copy',
      source: 'main',
      dbPath: sentinel,
      confirmed: true,
      idempotencyKey: 'copy1',
    });
    assert.equal(res.ok, false, `policy:copy with an out-of-root dbPath must be refused: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'data_root_outside_environments_root');
    assert.equal(readFileSync(sentinel, 'utf8'), 'COPY-SENTINEL', 'the sentinel was NOT overwritten by a copy of main');

    rmSync(sentinelDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 confinement: a trailing-slash dbPath is refused cleanly (no EISDIR, no stray directory)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-f1-slash-'));
  try {
    const deps = makeLandscapeDeps(dir);
    const target = join(deps.environmentsRoot, 'slashy', 'till.db');
    const res = envCreate(deps, { name: 'slashy', policy: 'live', dbPath: `${target}/`, confirmed: true, idempotencyKey: 'sl1' });
    assert.equal(res.ok, false, `a trailing-slash dbPath must be refused: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'invalid_input');
    assert.equal(existsSync(target), false, 'no directory named till.db is left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 confinement: a LOCAL default env_create is UNAFFECTED (the single-machine flow still works)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-f1-local-'));
  try {
    const deps = makeLandscapeDeps(dir);
    // No dbPath: the default `<environmentsRoot>/<name>/till.db` is under the root and succeeds.
    const res = envCreate(deps, { name: 'dev1', policy: 'live', confirmed: true, idempotencyKey: 'ok1' });
    assert.equal(res.ok, true, `a default local create must still work: ${JSON.stringify(res)}`);
    assert.equal(res.environment.exists, true, 'the data root was populated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
