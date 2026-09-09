/**
 * M00 US-M00.5: the .mcpb desktop-extension manifest is schema-valid and its entry resolves.
 *
 * This is the CI gate the spec §8 names. It runs the SAME `stampAndValidate` the build script's CLI
 * runs, so a manifest that would not load into Claude Desktop reddens here rather than at install time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { stampAndValidate } from '../../scripts/build-mcpb.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

test('the mcpb manifest is schema-valid and its entry resolves', () => {
  const manifest = stampAndValidate(repoRoot);
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'server.mjs');
  assert.equal(manifest.server.mcp_config.command, 'node');
  assert.ok(manifest.server.mcp_config.args.some((a) => a.includes('server.mjs')));
});

test('the manifest version is stamped from package.json (lockstep with npm)', () => {
  assert.equal(stampAndValidate(repoRoot).version, pkg.version);
  assert.equal(stampAndValidate(repoRoot).name, pkg.name);
});

test('the manifest declares TILL_DB_PATH and TILL_SUPPORT_DIR as user-config env, and no secret', () => {
  const manifest = stampAndValidate(repoRoot);
  assert.equal(manifest.server.mcp_config.env.TILL_DB_PATH, '${user_config.db_path}');
  assert.equal(manifest.server.mcp_config.env.TILL_SUPPORT_DIR, '${user_config.support_dir}');
  assert.ok('db_path' in manifest.user_config);
  assert.ok('support_dir' in manifest.user_config);
  // No secrets in the manifest (spec §4): nothing is marked sensitive.
  for (const cfg of Object.values(manifest.user_config)) {
    assert.notEqual(cfg.sensitive, true);
  }
});

test('Windows is excluded from the platform list (D104)', () => {
  const manifest = stampAndValidate(repoRoot);
  assert.ok(manifest.compatibility.platforms.includes('darwin'));
  assert.ok(!manifest.compatibility.platforms.includes('win32'));
});
