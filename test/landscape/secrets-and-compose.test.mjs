// N00 Phase B: the secret-floor drift tripwire, the never-copied identity tables, and the two COMPOSED
// paths (env_create policy=copy, env_reset of a copy-policy env). These lean on the shared rich-source
// fixture in copy.test.mjs`s style but are kept separate so the floor`s structural guards are legible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  envCreate,
  envReset,
  envCopy,
  readLandscape,
  findUnclassifiedSecretColumns,
  SECRET_COLUMNS,
  looksLikeSecretColumnName,
} from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'till-secrets-'));
}

function makeDeps(dir, seeders) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-09-07T00:00:00.000Z',
    seeders,
    ids: systemIdGen,
    clock: { now: () => '2026-09-07T00:00:00.000Z' },
  };
}

/** A source seeder: a workspace + a portal_grant secret + an invite (identity, must never be copied). */
function seederWithSecretAndInvite(path) {
  const store = new SqliteStore({ location: path });
  const at = '2026-01-01T00:00:00.000Z';
  const created = createWorkspace({ store, clock: { now: () => at }, ids: systemIdGen, actor: 'seed' }, { name: 'SrcCo' });
  const wsId = created.workspaceId;
  const contactId = systemIdGen.next('contact');
  store.db.prepare('INSERT INTO contact (id, workspace_id, party_role, name, created_at, kind) VALUES (?,?,?,?,?,?)').run(
    contactId, wsId, 'customer', 'Someone', at, 'company',
  );
  store.db.prepare(
    'INSERT INTO portal_grant (id, workspace_id, contact_id, kind, token_hash, scopes, expires_at, local_artifact_json, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(systemIdGen.next('pg'), wsId, contactId, 'customer', 'ZZQSECRETONLY', '[]', '2030-01-01', '{}', 'seed', at, at);
  store.db.prepare('INSERT INTO invite (token, workspace_id, email, role, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(
    'ZZQINVITETOKEN', wsId, 'invitee@example.com', 'bookkeeper', '2030-01-01', 'seed', at,
  );
  store.close();
}

function scanForValue(dbPath, needle) {
  const store = new SqliteStore({ location: dbPath });
  try {
    const db = store.db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const hits = [];
    for (const t of tables) {
      for (const c of db.pragma(`table_info("${t}")`)) {
        try {
          if (db.prepare(`SELECT 1 FROM "${t}" WHERE CAST("${c.name}" AS TEXT) LIKE ? LIMIT 1`).get(`%${needle}%`)) hits.push(`${t}.${c.name}`);
        } catch {
          /* unscannable column */
        }
      }
    }
    return hits;
  } finally {
    store.close();
  }
}

// --- the drift tripwire: every secret-looking column is classified or in a never-copied table -------

test('secrets/drift: no unclassified secret-looking column exists in the live schema', () => {
  const store = new SqliteStore();
  try {
    const unclassified = findUnclassifiedSecretColumns(store.db);
    assert.deepEqual(
      unclassified,
      [],
      `every secret-looking column a copy carries must be in SECRET_COLUMNS. Unclassified: ${unclassified.join(', ')}`,
    );
  } finally {
    store.close();
  }
});

test('secrets/registry: the pattern flags real secrets and spares natural/business keys', () => {
  assert.ok(SECRET_COLUMNS.length >= 6, 'the six known secret columns at least');
  // Every curated column carries a rationale and a strategy.
  for (const s of SECRET_COLUMNS) {
    assert.ok(s.why && s.why.length > 0, `${s.table}.${s.column} needs a documented reason`);
    assert.ok(s.strategy === 'null' || s.strategy === 'randomize', `${s.table}.${s.column} needs a strategy`);
  }
  // The high-signal pattern flags the obvious secret names...
  for (const s of ['token_hash', 'accept_token_hash', 'key_ref', 'consent_ref', 'transport_key', 'client_secret', 'api_key', 'oauth_token']) {
    assert.equal(looksLikeSecretColumnName(s), true, `${s} should match the secret pattern`);
  }
  // ...and must NOT flag common natural/business keys (or it would corrupt real data).
  for (const notSecret of ['period_key', 'thread_key', 'entry_key', 'method_key', 'idempotency_key', 'summary_i18n_key', 'order_ref', 'storage_ref']) {
    assert.equal(looksLikeSecretColumnName(notSecret), false, `${notSecret} must not be treated as a secret`);
  }
});

// --- identity tables (invite.token, the one plaintext token) never travel into a copy --------------

test('secrets/identity: a copy carries no invite row, so the plaintext invite token never travels', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { rich: seederWithSecretAndInvite, minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); } });
    assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'rich', tierRank: 250, confirmed: true }).ok, true);
    assert.equal(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }).ok, true);
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    const dstPath = join(dir, 'environments', 'dst', 'till.db');
    // The secret was neutralized, AND the invite token never travelled (identity table excluded).
    assert.deepEqual(scanForValue(dstPath, 'ZZQSECRETONLY'), [], 'the portal secret is neutralized');
    assert.deepEqual(scanForValue(dstPath, 'ZZQINVITETOKEN'), [], 'the invite token never travels');
    const store = new SqliteStore({ location: dstPath });
    try {
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM invite').get().n, 0, 'no invite rows in a copy');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- composed paths: env_create policy=copy, then env_reset of that copy-policy env ----------------

test('compose/create-copy: env_create policy=copy provisions a new env from a source, sanitized', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { rich: seederWithSecretAndInvite, minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); } });
    assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'rich', tierRank: 250, confirmed: true }).ok, true);

    // Unconfirmed create-copy returns a plan and creates nothing.
    const plan = envCreate(deps, { name: 'fresh', policy: 'copy', source: 'src', sanitize: 'pseudonymize', tierRank: 30 });
    assert.equal(plan.ok, true);
    assert.equal(plan.staged, true);
    assert.equal(plan.plan.policy, 'copy');
    assert.equal(readLandscape(dir).environments.fresh, undefined, 'the plan created nothing');

    // Confirmed: the env is created, sourced, sanitized, and its secret is neutralized.
    const made = envCreate(deps, { name: 'fresh', policy: 'copy', source: 'src', sanitize: 'pseudonymize', tierRank: 30, confirmed: true });
    assert.equal(made.ok, true, JSON.stringify(made));
    const file = readLandscape(dir);
    assert.equal(file.environments.fresh.data_policy, 'copy');
    assert.equal(file.environments.fresh.source_env, 'src');
    assert.equal(file.environments.fresh.sanitization, 'pseudonymize');
    const dstPath = join(dir, 'environments', 'fresh', 'till.db');
    assert.deepEqual(scanForValue(dstPath, 'ZZQSECRETONLY'), [], 'create-copy neutralizes the secret');

    // env_reset of a copy-policy env re-copies from its recorded source (build-then-swap).
    const reset = envReset(deps, { name: 'fresh', confirmed: true });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.reset, true);
    assert.equal(reset.source, 'src');
    assert.deepEqual(scanForValue(dstPath, 'ZZQSECRETONLY'), [], 'reset re-copies and re-neutralizes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- SECURITY: the owner-only retain override cannot be reached through the create door -------------

test('compose/create-retain: env_create policy=copy refuses the owner-only retainSecrets override', () => {
  const dir = tmp();
  try {
    const deps = makeDeps(dir, { rich: seederWithSecretAndInvite, minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); } });
    assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'rich', tierRank: 250, confirmed: true }).ok, true);
    // env_create is gated on landscape.manage (not owner-only), so it must not honour retainSecrets: the
    // secret-retaining path is exclusively env_copy (landscape.retain_secrets). It is refused outright.
    const res = envCreate(deps, { name: 'fresh', policy: 'copy', source: 'src', sanitize: 'raw', retainSecrets: true, tierRank: 30, confirmed: true });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'retain_secrets_not_allowed_on_create', JSON.stringify(res));
    assert.equal(readLandscape(dir).environments.fresh, undefined, 'nothing was created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
