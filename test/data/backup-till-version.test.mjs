/**
 * A backup names the TILL build that wrote it (owner's Mac, 13.10.2026).
 *
 * THE DEFECT. `TILL_VERSION` was a hand-typed `'0.0.0'` in two places (`src/core/data/catalog.ts`,
 * `src/api/runtime-state.ts`), so every `.tillbackup` manifest, every `backups` row, the API catalog
 * and `delivery_status` of a 1.0.0-beta.1 build said `0.0.0`. Both now read the ONE source,
 * `TILL_PACKAGE_VERSION` (`src/core/version.ts`, the root `package.json` the same way `till --version`
 * reads it). Synthetic book, built from scratch in a tmp dir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { TILL_VERSION as CATALOG_VERSION, getApiCatalog } from '../../dist/core/data/catalog.js';
import { TILL_VERSION as RUNTIME_VERSION } from '../../dist/api/runtime-state.js';
import { TILL_PACKAGE_VERSION } from '../../dist/core/version.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const clock = { now: () => '2026-10-13T10:00:00.000Z' };

test('both TILL_VERSION exports are the package.json version, never a typed 0.0.0', () => {
  assert.equal(TILL_PACKAGE_VERSION, pkg.version);
  assert.equal(CATALOG_VERSION, pkg.version);
  assert.equal(RUNTIME_VERSION, pkg.version);
  assert.notEqual(CATALOG_VERSION, '0.0.0');
  // The packed tarball keeps the same layout: `dist/core/version.js` reads `../../package.json`, which
  // npm always ships, and `dist/` is in `files`.
  assert.ok(pkg.files.includes('dist/'), 'dist/ ships');
});

test('no second version literal: no TILL_VERSION in src is assigned a string', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && /TILL_VERSION\s*(?::\s*string\s*)?=\s*['"`]/.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepEqual(offenders, []);
});

test('a backup manifest, its history row and the API catalog name the running package version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-version-'));
  try {
    const store = new SqliteStore({ location: join(dir, 'book.sqlite'), clock });
    const g = sequenceIdGen();
    const deps = { store, clock, ids: { next: (p) => g.next(p) }, actor: 'user_1', backupDir: join(dir, 'backups') };
    const ws = getAction('create_workspace').run(deps, { name: 'Version GmbH', idempotencyKey: 'ws' });
    assert.equal(ws.ok, true, JSON.stringify(ws));
    const bkp = getAction('create_backup').run(deps, { workspaceId: ws.workspaceId, idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const manifest = JSON.parse(readFileSync(join(bkp.artifactRef, 'manifest.json'), 'utf8'));
    assert.equal(manifest.tillVersion, pkg.version);
    assert.equal(store.db.prepare('SELECT till_version FROM backups WHERE workspace_id = ?').get(ws.workspaceId).till_version, pkg.version);
    const verified = getAction('verify_backup').run(deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.tillVersion, pkg.version);
    const catalog = getApiCatalog([]);
    assert.equal(catalog.ok, true);
    assert.equal(catalog.openapi.info.version, pkg.version);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
