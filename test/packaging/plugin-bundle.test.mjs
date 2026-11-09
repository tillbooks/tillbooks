// @ts-check
/**
 * The PLUGIN BUNDLE (Claude directory and Cursor Marketplace) stays installable and in lockstep.
 *
 * The Claude directory no longer takes a local server as an `.mcpb`; it takes a plugin folder
 * (`.claude-plugin/plugin.json` + `.mcp.json`, a README with a "Privacy Policy" section, a license).
 * Cursor reads the same folder through `.cursor-plugin/plugin.json` + `mcp.json`. The folder lives at
 * `plugins/tillbooks`, not at the repo root, because a root plugin would carry the repo's top-level
 * `bin/` (which stops claude.ai and Cowork from installing a plugin at all), its lockfile and its
 * thousands of files (both held for a reviewer).
 *
 * What is held here, so a release bump that forgets a copy reddens the gate instead of shipping:
 *   - both manifests carry the root `package.json` version, and both MCP configs pin `npx` to exactly
 *     that version (the directory BLOCKS an unpinned launcher: a dist-tag such as `@beta` is not a pin);
 *   - both marketplaces list the plugin under its manifest name, from the folder that exists;
 *   - the README carries the Privacy Policy the directory requires, and the `.mcpb` manifest names
 *     HTTPS privacy policies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = 'plugins/tillbooks';
const read = (/** @type {string} */ rel) => readFileSync(join(repoRoot, rel), 'utf8');
const json = (/** @type {string} */ rel) => JSON.parse(read(rel));
const pkg = json('package.json');

test('both plugin manifests carry the package version, name and license', () => {
  for (const rel of [`${PLUGIN}/.claude-plugin/plugin.json`, `${PLUGIN}/.cursor-plugin/plugin.json`]) {
    const m = json(rel);
    assert.equal(m.name, 'tillbooks', `${rel}: name`);
    assert.match(m.name, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, `${rel}: lowercase, digits and hyphens`);
    assert.equal(m.version, pkg.version, `${rel}: version follows package.json`);
    assert.equal(m.license, 'MIT', `${rel}: license`);
    assert.ok(typeof m.description === 'string' && m.description.length > 0, `${rel}: description`);
    assert.ok(typeof m.author?.name === 'string', `${rel}: author.name`);
  }
  assert.equal(json(`${PLUGIN}/.cursor-plugin/plugin.json`).mcpServers, './mcp.json', 'Cursor reads mcp.json');
  const logo = json(`${PLUGIN}/.cursor-plugin/plugin.json`).logo;
  assert.ok(existsSync(join(repoRoot, PLUGIN, logo)), `the Cursor logo ${logo} exists in the plugin folder`);
  assert.ok(existsSync(join(repoRoot, PLUGIN, 'assets/icon.png')), 'the Claude listing icon exists');
});

test('Claude connects to the local Studio over HTTP; Cursor starts the pinned server', () => {
  // The Claude directory accepts a server that runs on the user's machine only from a Verified
  // organization (policy finding of 2026-11-06), so the Claude config reaches the server `till up`
  // already hosts at 127.0.0.1:8788/mcp instead of spawning it. Cursor keeps the pinned npx launcher.
  const claude = json(`${PLUGIN}/.mcp.json`);
  const cursor = json(`${PLUGIN}/mcp.json`);
  assert.deepEqual(Object.keys(claude.mcpServers), ['tillbooks']);
  assert.deepEqual(claude.mcpServers.tillbooks, { type: 'http', url: 'http://127.0.0.1:8788/mcp' });
  assert.deepEqual(Object.keys(cursor.mcpServers), ['tillbooks']);
  const server = cursor.mcpServers.tillbooks;
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', `${pkg.name}@${pkg.version}`, 'mcp'], 'an exact pin, never a dist-tag or a range');
  assert.equal(server.env, undefined, 'no environment is required (TILL_DB_PATH and TILL_SUPPORT_DIR are optional)');
  // Every pin the plugin README prints is the same version.
  for (const m of read(`${PLUGIN}/README.md`).matchAll(/tillbooks@([0-9A-Za-z.-]+)/g)) {
    assert.equal(m[1], pkg.version, `plugin README pins tillbooks@${m[1]}`);
  }
});

test('the Claude and Cursor marketplaces list the plugin from the folder that holds it', () => {
  const claude = json('.claude-plugin/marketplace.json');
  const cursor = json('.cursor-plugin/marketplace.json');
  for (const [label, m] of [['claude', claude], ['cursor', cursor]]) {
    assert.equal(m.name, 'tillbooks', `${label}: marketplace name`);
    assert.ok(typeof m.owner?.name === 'string', `${label}: owner.name`);
    assert.equal(m.plugins.length, 1, `${label}: one plugin`);
    assert.equal(m.plugins[0].name, 'tillbooks', `${label}: the entry name is the manifest name`);
    const source = String(m.plugins[0].source).replace(/^\.\//, '');
    assert.equal(source, PLUGIN, `${label}: source`);
    assert.doesNotMatch(String(m.plugins[0].source), /\.\./, `${label}: no .. in the source`);
  }
});

test('the plugin folder holds nothing the directory would hold back', () => {
  assert.equal(existsSync(join(repoRoot, PLUGIN, 'bin')), false, 'a top-level bin/ stops claude.ai and Cowork installing the plugin');
  for (const f of ['package.json', 'package-lock.json', '.npmrc']) {
    assert.equal(existsSync(join(repoRoot, PLUGIN, f)), false, `${f} in the plugin folder triggers an install or a registry hold`);
  }
});

test('the README (root and plugin) carries the Privacy Policy, and the .mcpb manifest names HTTPS policies', () => {
  const sections = ['Data collection', 'Usage and storage', 'Third-party sharing', 'Data retention', 'Contact'];
  for (const rel of ['README.md', `${PLUGIN}/README.md`]) {
    const md = read(rel);
    const at = md.indexOf('\n## Privacy Policy\n');
    assert.ok(at >= 0, `${rel}: a "Privacy Policy" section`);
    const body = md.slice(at).split('\n## ')[1] ?? '';
    for (const s of sections) assert.ok(body.includes(`**${s}.**`), `${rel}: the policy covers ${s}`);
    assert.ok(body.includes('hello@tillbooks.ch'), `${rel}: a contact address`);
  }
  // The directory counts README words outside code blocks, and asks for at least 40.
  const prose = read(`${PLUGIN}/README.md`).replace(/```[\s\S]*?```/g, '');
  assert.ok(prose.split(/\s+/).filter(Boolean).length >= 40, 'the plugin README has at least 40 words of prose');
  const mcpb = json('packaging/mcpb/manifest.json');
  assert.ok(Array.isArray(mcpb.privacy_policies) && mcpb.privacy_policies.length > 0, 'privacy_policies');
  for (const url of mcpb.privacy_policies) assert.match(url, /^https:\/\//, `${url}: an HTTPS URL`);
});
