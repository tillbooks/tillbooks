// N00 environment landscape (D126, Phase A): the acceptance tests from section 5's acceptance column
// and the canon-finding resolutions of section 10. Engine tests run against the operations directly
// with a temp support dir and injected seeders, so the real ~/.till is never touched; the A24 and
// idempotency tests drive the real verbs through the registry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  envList,
  envStatus,
  envCurrent,
  envSwitch,
  envCreate,
  envReset,
  envDelete,
  readLandscape,
  readAuditChain,
  writeLandscape,
  canCopyDown,
  resolveTierRank,
  RANK_MAIN,
  RANK_TEST,
  RANK_DEVELOP,
  RANK_NAMED_DEFAULT,
  CONTROL_FILE_NAME,
  AUDIT_FILE_NAME,
} from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

// --- helpers -----------------------------------------------------------------------------------

function tmp() {
  return mkdtempSync(join(tmpdir(), 'till-landscape-'));
}

/** A seeder that writes a detectable marker row (in the FK-free idempotency table) so a test can */
/** prove a specific db file survived. The empty ledger it produces passes the reset gate. */
function markerSeeder(marker) {
  return (target) => {
    const s = new SqliteStore({ location: target });
    s.db
      .prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('marker', marker, 'seed', '{}', '2020-01-01T00:00:00.000Z');
    s.close();
  };
}

/** A seeder that always fails, for the E3a build-then-swap forgiveness test. */
const failingSeeder = () => {
  throw new Error('deliberate seed failure');
};

/** Read the marker written by `markerSeeder`, or null. */
function readMarker(path) {
  const s = new SqliteStore({ location: path });
  try {
    const row = s.db.prepare('SELECT key FROM idempotency WHERE workspace_id = ?').get('marker');
    return row ? row.key : null;
  } finally {
    s.close();
  }
}

function makeDeps(dir, seeders = { minimal: markerSeeder('base') }) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-09-07T00:00:00.000Z',
    seeders,
  };
}

// --- tier rank (finding #10) -------------------------------------------------------------------

test('landscape: tier ranks order down-only and canCopyDown is strict', () => {
  assert.ok(RANK_MAIN > RANK_TEST && RANK_TEST > RANK_DEVELOP && RANK_DEVELOP > RANK_NAMED_DEFAULT);
  // Down is allowed, up and lateral are not.
  assert.equal(canCopyDown(RANK_MAIN, RANK_TEST), true);
  assert.equal(canCopyDown(RANK_MAIN, RANK_DEVELOP), true);
  assert.equal(canCopyDown(RANK_TEST, RANK_MAIN), false);
  assert.equal(canCopyDown(RANK_TEST, RANK_TEST), false, 'a lateral copy between equal ranks is refused');
  // Rank resolution: standard names get their rank, named default below dev, an explicit rank wins,
  // and an invalid explicit rank is rejected (undefined).
  assert.equal(resolveTierRank('main', undefined), RANK_MAIN);
  assert.equal(resolveTierRank('develop', undefined), RANK_DEVELOP);
  assert.equal(resolveTierRank('scratch', undefined), RANK_NAMED_DEFAULT);
  assert.equal(resolveTierRank('scratch', 250), 250);
  assert.equal(resolveTierRank('scratch', -1), undefined);
  assert.equal(resolveTierRank('scratch', 1.5), undefined);
});

// --- bootstrap + reads -------------------------------------------------------------------------

test('landscape: first read bootstraps the three standard tiers, pinned first, main protected', () => {
  const dir = tmp();
  try {
    const res = envList(makeDeps(dir));
    assert.equal(res.ok, true);
    const names = res.environments.map((e) => e.name);
    assert.deepEqual(names, ['main', 'test', 'develop'], 'standard tiers pinned in order, no named yet');
    const main = res.environments.find((e) => e.name === 'main');
    assert.equal(main.guardTier, 'protected');
    assert.equal(main.runtimeTarget, 'local');
    assert.equal(main.tierRank, RANK_MAIN);
    assert.equal(res.active, 'main', 'the default active env is main, the real books (D135)');
    // The bootstrap wrote a genesis audit record, and the chain verifies.
    const chain = readAuditChain(dir);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].outcome, 'bootstrap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: at scale the three tiers stay pinned and named envs sort after (E5b)', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    envCreate(deps, { name: 'zeta', policy: 'live', confirmed: true, idempotencyKey: 'k1' });
    envCreate(deps, { name: 'alpha', policy: 'live', confirmed: true, idempotencyKey: 'k2' });
    const names = envList(deps).environments.map((e) => e.name);
    assert.deepEqual(names, ['main', 'test', 'develop', 'alpha', 'zeta']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: current + status report the active env, drift unknown without a built channel', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    const cur = envCurrent(deps);
    assert.equal(cur.ok, true);
    assert.equal(cur.active, 'main', 'the default active env is main (D135)');
    // main bootstraps as LOCAL + protected (D135), so its `readOnly` VIEW flag is false: a local main
    // is the real books and stays writable. The flag reports a served (hosted) face only, and no write
    // verb consults it either way.
    assert.equal(cur.readOnly, false, 'a local main is writable (D135), not a read-only face');
    const st = envStatus(deps, { name: 'develop' });
    assert.equal(st.ok, true);
    assert.equal(st.environment.readOnly, false, 'a local develop env is writable');
    assert.equal(envStatus(deps, { name: 'main' }).environment.readOnly, false, 'a local main is writable (D135)');
    assert.equal(st.codeChannelDrift, 'unknown');
    assert.equal(envStatus(deps, { name: 'nope' }).error, 'environment_not_found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- create synthetic + live (happy) -----------------------------------------------------------

test('landscape: create synthetic seeds and gates the data root, records last_refresh', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { minimal: markerSeeder('created') });
    const res = envCreate(deps, { name: 'dev1', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 'c1' });
    assert.equal(res.ok, true);
    assert.equal(res.environment.dataPolicy, 'synthetic');
    assert.equal(res.environment.exists, true);
    assert.equal(res.environment.lastRefreshAt, '2026-09-07T00:00:00.000Z');
    assert.equal(readMarker(res.environment.dbPath), 'created', 'the seed actually ran into the data root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: create policy=copy delegates to the Phase B copy path (no longer a stub)', () => {
  const dir = tmp();
  try {
    // Phase B implements policy=copy. On a bootstrapped-but-unpopulated landscape, main has no data root,
    // so the copy refuses on the SOURCE (source_data_missing) rather than the old phase_b_not_implemented
    // stub. The full copy behaviour is covered in copy.test.mjs against a populated source.
    const res = envCreate(makeDeps(dir), { name: 'clone', policy: 'copy', source: 'main', confirmed: true, idempotencyKey: 'c1' });
    assert.equal(res.ok, false);
    assert.notEqual(res.error, 'phase_b_not_implemented');
    assert.equal(res.error, 'source_data_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: an unknown seed is refused with the available list', () => {
  const dir = tmp();
  try {
    const res = envCreate(makeDeps(dir, { minimal: markerSeeder('x') }), {
      name: 'dev1',
      policy: 'synthetic',
      seed: 'seeblick',
      confirmed: true,
      idempotencyKey: 'c1',
    });
    assert.equal(res.error, 'unknown_seed');
    assert.deepEqual(res.available, ['minimal']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- main protection by DATA ROOT (finding #3, E7) ---------------------------------------------

test('landscape: create refuses a data root that aliases main, and one that collides with a sibling', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    // Aliasing main's volume is refused, regardless of the name.
    const aliasMain = envCreate(deps, { name: 'sneaky', policy: 'live', dbPath: deps.mainDbPath, confirmed: true, idempotencyKey: 'k1' });
    assert.equal(aliasMain.error, 'data_root_is_main');
    // Colliding with develop's existing data root is refused.
    const develop = envList(deps).environments.find((e) => e.name === 'develop');
    const collide = envCreate(deps, { name: 'dup', policy: 'live', dbPath: develop.dbPath, confirmed: true, idempotencyKey: 'k2' });
    assert.equal(collide.error, 'data_root_collision');
    assert.equal(collide.collidesWith, 'develop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: reset and delete refuse main, by data root AND guard (E7)', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    envList(deps); // bootstrap
    assert.equal(envReset(deps, { name: 'main', force: true, confirmed: true }).error, 'environment_protected');
    assert.equal(envDelete(deps, { name: 'main', force: true, confirmed: true }).error, 'environment_protected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: reset refuses a named env aliasing main by DATA ROOT, not just by name (finding #3)', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    envList(deps); // bootstrap
    // Inject an OPEN env whose data root is main's, bypassing create's own guard, to prove the reset
    // guard keys on the resolved data root and not on the name or the guard tier.
    const file = readLandscape(dir);
    const aliased = { ...file.environments.develop, name: 'aliased', db_path: deps.mainDbPath, guard_tier: 'open', tier_rank: RANK_NAMED_DEFAULT };
    writeLandscape(
      dir,
      { version: 1, environments: { ...file.environments, aliased }, active: file.active },
      { at: '2026-09-07T00:00:00.000Z', actor: 'owner', action: 'test_inject', target: 'aliased', outcome: 'injected' },
      file.audit_head,
    );
    const r = envReset(deps, { name: 'aliased', confirmed: true });
    assert.equal(r.error, 'environment_protected', 'the data-root guard bites even for an open, non-main-named env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- reset build-then-swap forgiveness (finding #5, E3a) ---------------------------------------

test('landscape: a failed reset leaves the prior env intact (build-then-swap, E3a)', () => {
  const dir = tmp();
  try {
    // Create dev1 with a marker in its data root.
    const created = envCreate(makeDeps(dir, { minimal: markerSeeder('ORIGINAL') }), {
      name: 'dev1',
      policy: 'synthetic',
      seed: 'minimal',
      confirmed: true,
      idempotencyKey: 'c1',
    });
    assert.equal(created.ok, true);
    const dbPath = created.environment.dbPath;
    assert.equal(readMarker(dbPath), 'ORIGINAL');

    // Reset dev1 with a seeder that fails. The build-then-swap must never touch the live file.
    const failDeps = makeDeps(dir, { minimal: failingSeeder });
    const reset = envReset(failDeps, { name: 'dev1', seed: 'minimal', confirmed: true, idempotencyKey: 'r1' });
    assert.equal(reset.ok, false);
    assert.equal(reset.error, 'seed_failed');
    assert.equal(reset.phase, 'seed');

    // The ORIGINAL data root survived, and no half-written .building file was promoted or left behind.
    assert.equal(readMarker(dbPath), 'ORIGINAL', 'the prior env db is intact after a failed reset');
    assert.equal(existsSync(dbPath + '.building'), false, 'the failed build file is cleaned up');
    // The control file still records the env, unchanged (last_refresh untouched by the failed reset).
    const env = envStatus(failDeps, { name: 'dev1' }).environment;
    assert.equal(env.exists, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: a successful synthetic reset swaps in the new seed (non-active env)', () => {
  const dir = tmp();
  try {
    const deps1 = makeDeps(dir, { minimal: markerSeeder('OLD') });
    const created = envCreate(deps1, { name: 'dev1', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 'c1' });
    const dbPath = created.environment.dbPath;
    const deps2 = makeDeps(dir, { minimal: markerSeeder('NEW') });
    const reset = envReset(deps2, { name: 'dev1', seed: 'minimal', confirmed: true, idempotencyKey: 'r1' });
    assert.equal(reset.ok, true);
    assert.equal(reset.reset, true);
    assert.equal(readMarker(dbPath), 'NEW', 'the new seed is swapped in on success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: reset of a copy-policy env (test) delegates to the Phase B re-copy path', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    envList(deps); // bootstrap: test is data_policy=copy, source_env=main
    // Phase B implements reset of a copy-policy env as a re-copy from its recorded source. main has no
    // data root here, so it refuses on the source rather than the old phase_b_not_implemented stub.
    const r = envReset(deps, { name: 'test', confirmed: true });
    assert.equal(r.ok, false);
    assert.notEqual(r.error, 'phase_b_not_implemented');
    assert.equal(r.error, 'source_data_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- P8: unconfirmed returns a plan and changes nothing ----------------------------------------

test('landscape: every write verb unconfirmed returns a plan and changes nothing (P8)', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { minimal: markerSeeder('base') });
    // Seed a non-active env for the reset/delete plan targets.
    envCreate(deps, { name: 'p8reset', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 's1' });
    envCreate(deps, { name: 'p8del', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 's2' });
    const before = readLandscape(dir);

    const sw = envSwitch(deps, { name: 'test' });
    assert.equal(sw.ok, true);
    assert.equal(sw.staged, true);
    assert.equal(sw.plan.to, 'test');

    const cr = envCreate(deps, { name: 'p8create', policy: 'synthetic', seed: 'minimal' });
    assert.equal(cr.staged, true);
    assert.equal(cr.plan.name, 'p8create');

    const rs = envReset(deps, { name: 'p8reset', seed: 'minimal' });
    assert.equal(rs.staged, true);
    assert.equal(rs.plan.willRebuild, true);

    const dl = envDelete(deps, { name: 'p8del' });
    assert.equal(dl.staged, true);
    assert.equal(dl.plan.willRemoveDataRoot, before.environments.p8del.db_path);

    // Nothing moved: same active, same env set, same marker in the reset target, del target present.
    const after = readLandscape(dir);
    assert.equal(after.active, before.active);
    assert.deepEqual(Object.keys(after.environments).sort(), Object.keys(before.environments).sort());
    assert.equal('p8create' in after.environments, false, 'a planned create wrote no env');
    assert.equal(readMarker(after.environments.p8reset.db_path), 'base', 'a planned reset left the data root untouched');
    assert.equal(after.audit_head.seq, before.audit_head.seq, 'no plan appended an audit record');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- delete guards (E9a / E9b) -----------------------------------------------------------------

test('landscape: delete refuses a standard tier without force and refuses the active env', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { minimal: markerSeeder('x') });
    // A standard tier without force is refused (E9a).
    assert.equal(envDelete(deps, { name: 'develop', confirmed: true }).error, 'standard_tier');
    // The active env is refused even with force (E9b). main is active by default now (D135), so switch
    // to develop first to make it the active tier and prove force cannot delete the active env.
    assert.equal(envSwitch(deps, { name: 'develop', confirmed: true, idempotencyKey: 'sw0' }).ok, true);
    assert.equal(envDelete(deps, { name: 'develop', force: true, confirmed: true }).error, 'environment_active');

    // Create + switch to a scratch env, then it (now active) refuses deletion; and develop (now not
    // active) can be force-deleted as a standard tier.
    envCreate(deps, { name: 'scratch', policy: 'live', confirmed: true, idempotencyKey: 's1' });
    const sw = envSwitch(deps, { name: 'scratch', confirmed: true, idempotencyKey: 'sw1' });
    assert.equal(sw.ok, true);
    assert.equal(envDelete(deps, { name: 'scratch', confirmed: true }).error, 'environment_active');
    const delDev = envDelete(deps, { name: 'develop', force: true, confirmed: true, idempotencyKey: 'd1' });
    assert.equal(delDev.ok, true);
    assert.equal(delDev.deleted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: delete removes the data root and the landscape entry (E9)', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { minimal: markerSeeder('x') });
    const created = envCreate(deps, { name: 'gone', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 'c1' });
    const dbPath = created.environment.dbPath;
    assert.equal(existsSync(dbPath), true);
    const del = envDelete(deps, { name: 'gone', confirmed: true, idempotencyKey: 'd1' });
    assert.equal(del.ok, true);
    assert.equal(existsSync(dbPath), false, 'the data root is removed');
    assert.equal(envStatus(deps, { name: 'gone' }).error, 'environment_not_found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- switch to main keeps a local main writable (D135) -----------------------------------------

test('landscape: switch to main records the pointer and a local main stays writable', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    const sw = envSwitch(deps, { name: 'main', confirmed: true, idempotencyKey: 'sw1' });
    assert.equal(sw.ok, true);
    assert.equal(sw.active, 'main');
    assert.equal(sw.readOnly, false, 'a local main is the real books and stays writable (D135)');
    assert.equal(envCurrent(deps).readOnly, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- control-file integrity (finding #2) -------------------------------------------------------

test('landscape: a hand-edited control file is detected and every read FAILS LOUD', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir);
    envList(deps); // bootstrap writes a valid, checksummed control file
    const path = join(dir, CONTROL_FILE_NAME);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    // Hand-edit an environment's data root WITHOUT recomputing the checksum.
    file.environments.develop.db_path = '/tmp/attacker/till.db';
    writeFileSync(path, JSON.stringify(file, null, 2));

    for (const read of [() => envList(deps), () => envCurrent(deps), () => envStatus(deps, { name: 'main' })]) {
      const res = read();
      assert.equal(res.ok, false, 'a read must never silently fall back on a tampered control file');
      assert.equal(res.error, 'landscape_integrity_failed');
      assert.equal(res.reason, 'control_checksum_mismatch');
    }
    // A mutation on a tampered file is refused too, before it can launder the tamper.
    assert.equal(envSwitch(deps, { name: 'main', confirmed: true, idempotencyKey: 'x' }).error, 'landscape_integrity_failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: a tampered audit chain is detected via the control-file binding', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { minimal: markerSeeder('x') });
    envCreate(deps, { name: 'dev1', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 'c1' });
    // Truncate the audit log: the control file's audit_head no longer matches the chain tip.
    writeFileSync(join(dir, AUDIT_FILE_NAME), '');
    const res = envList(deps);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'landscape_integrity_failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: each mutation appends one verified, chained audit record', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { minimal: markerSeeder('x') });
    envCreate(deps, { name: 'a', policy: 'live', confirmed: true, idempotencyKey: 'c1' });
    envSwitch(deps, { name: 'a', confirmed: true, idempotencyKey: 's1' });
    const chain = readAuditChain(dir); // throws if the chain does not verify end to end
    assert.deepEqual(
      chain.map((r) => r.outcome),
      ['bootstrap', 'created', 'switched'],
    );
    assert.deepEqual(chain.map((r) => r.seq), [1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- A24 gate + host idempotency, through the real verbs ---------------------------------------

test('landscape: the env_* verbs declare their A24 gates (landscape.read / landscape.manage)', () => {
  // The wiring: reads gate on landscape.read, writes on landscape.manage (D-ENV-7), enforced at the
  // shared A24 boundary every verb goes through (assertActionCapability in registry.ts).
  for (const w of ['env_switch', 'env_create', 'env_reset', 'env_delete']) {
    assert.deepEqual(requiredCapabilitiesFor(w, {}), ['landscape.manage'], `${w} must gate on landscape.manage`);
  }
  for (const r of ['env_list', 'env_status', 'env_current']) {
    assert.deepEqual(requiredCapabilitiesFor(r, {}), ['landscape.read'], `${r} must gate on landscape.read`);
  }
});

test('landscape: the A24 gate really bites (a served non-member is denied, a local owner allowed)', () => {
  const dir = tmp();
  try {
    const deps = freshDeps();
    deps.supportDir = dir;
    const { workspaceId } = mintWorkspace(deps);
    // The local operator (holds the file) is granted, per the solo-owner model: allowed.
    const okRes = getAction('env_create').run(deps, {
      workspaceId,
      name: 'dev1',
      policy: 'live',
      confirmed: true,
      idempotencyKey: 'c1',
    });
    assert.equal(okRes.ok, true);
    // A SERVED subject that is not a member of this workspace never receives the blanket local grant
    // (capability.ts step 1): the landscape.manage gate denies it. This is the real A24 enforcement.
    const denied = getAction('env_create').run(
      { ...deps, actor: 'member:stranger', identitySource: 'served_subject' },
      { workspaceId, name: 'dev2', policy: 'live', confirmed: true, idempotencyKey: 'c2' },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'permission_denied');
    assert.equal(denied.capability, 'landscape.manage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('landscape: a confirmed write replays under the same idempotency key (host-level)', () => {
  const dir = tmp();
  try {
    const deps = freshDeps();
    deps.supportDir = dir;
    const { workspaceId } = mintWorkspace(deps);
    const first = getAction('env_create').run(deps, {
      workspaceId,
      name: 'dev1',
      policy: 'live',
      confirmed: true,
      idempotencyKey: 'dup',
    });
    const second = getAction('env_create').run(deps, {
      workspaceId,
      name: 'dev1',
      policy: 'live',
      confirmed: true,
      idempotencyKey: 'dup',
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(JSON.stringify(second), JSON.stringify(first), 'the replay returns the stored success, not environment_exists');
    // Exactly one env was created (the replay did not mint a second).
    const listed = getAction('env_list').run(deps, { workspaceId });
    assert.equal(listed.environments.filter((e) => e.name === 'dev1').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
