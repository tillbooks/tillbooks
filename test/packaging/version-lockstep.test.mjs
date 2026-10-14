/**
 * Every version string TILL SHIPS follows the root `package.json` (beta launch P0.1).
 *
 * THE DEFECT. The version lived in a handful of hand-typed copies and they had drifted apart: npm
 * said 0.1.0, the repo 1.0.0-rc.1, the MCP registry manifest 1.0.0-rc.1, the `.mcpb` manifest 0.0.0,
 * and every eCH-0217 file handed to the ESTV named its sending application "TILL 0.0.0". A release
 * bump (`ops/release.mjs bump`) edits `package.json`; everything below must either read it or be held
 * equal to it here, so a copy that drifts reddens the gate instead of shipping.
 *
 *   - `app/package.json`, `server.json` (both fields: the registry entry and its npm package),
 *     `CITATION.cff`, `packaging/mcpb/manifest.json`: static copies, held EQUAL here.
 *   - `TILL_PACKAGE_VERSION` (`src/core/version.ts`): read from `package.json` at runtime.
 *   - The eCH-0217 `sendingApplication.productVersion`: that runtime version, in the at most 10
 *     characters eCH-0058 allows (`ech0058ProductVersion`), asserted on a real exported file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILL_PACKAGE_VERSION } from '../../dist/core/version.js';
import { exportVatReturnEch0217, ech0058ProductVersion } from '../../dist/core/vat/ech0217.js';
import { Q2, effektivWorld } from '../vat/ech0217-world.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('every static version copy equals package.json (Studio, MCP registry, CITATION, .mcpb)', () => {
  const app = JSON.parse(read('app/package.json'));
  const server = JSON.parse(read('server.json'));
  const mcpb = JSON.parse(read('packaging/mcpb/manifest.json'));
  const citation = read('CITATION.cff').match(/^version:\s*(\S+)/m)?.[1];
  assert.equal(app.version, pkg.version, 'app/package.json');
  assert.equal(server.version, pkg.version, 'server.json version');
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version, 'server.json packages[0].version');
  assert.equal(citation, pkg.version, 'CITATION.cff');
  assert.equal(mcpb.version, pkg.version, 'packaging/mcpb/manifest.json');
});

test('the two lockfiles carry the root version at both of their root copies (critic phase0-installable r1)', () => {
  // Not shipped, but `npm ci` and every audit read them, and both still said 0.1.0 at 1.0.0-beta.1.
  // `ops/release.mjs bump` now edits all four copies in place.
  for (const rel of ['package-lock.json', 'app/package-lock.json']) {
    const lock = JSON.parse(read(rel));
    assert.equal(lock.version, pkg.version, `${rel} version`);
    assert.equal(lock.packages[''].version, pkg.version, `${rel} packages[""].version`);
  }
});

test('the engine reads its version from package.json at runtime, never a typed copy', () => {
  assert.equal(TILL_PACKAGE_VERSION, pkg.version);
});

test('an exported eCH-0217 file names the running package version as its sending application', () => {
  const out = exportVatReturnEch0217(effektivWorld(), Q2);
  assert.equal(out.ok, true, JSON.stringify(out));
  const tag = out.xml.match(/<(?:[A-Za-z0-9-]+:)?productVersion>([^<]*)<\/(?:[A-Za-z0-9-]+:)?productVersion>/);
  assert.ok(tag !== null, 'the file carries a productVersion element');
  const carried = tag[1];
  assert.equal(carried, ech0058ProductVersion(pkg.version));
  assert.notEqual(carried, '0.0.0');
  assert.ok(carried.length >= 1 && carried.length <= 10, `eCH-0058 caps productVersion at 10: ${carried}`);
  assert.ok(carried.startsWith(pkg.version.split('-')[0]), `${carried} names the release line of ${pkg.version}`);
});

test('ech0058ProductVersion fits eCH-0058\'s 10 characters without ever reading as a different release', () => {
  assert.equal(ech0058ProductVersion('1.0.0'), '1.0.0');
  assert.equal(ech0058ProductVersion('1.0.0-rc.1'), '1.0.0-rc.1', 'exactly 10 fits as it is');
  assert.equal(ech0058ProductVersion('1.0.0-beta.1'), '1.0.0-b.1');
  assert.equal(ech0058ProductVersion('1.0.0-alpha.12'), '1.0.0-a.12');
  assert.equal(ech0058ProductVersion('10.20.30-beta.100'), '10.20.30-b', 'too long even compact: the stage alone, still a prerelease');
});

test('critic phase0-installable r1: a long release candidate stays a prerelease within 10 characters', () => {
  // `1.0.0-rc.10` used to collapse to `1.0.0`, the final release, in a file handed to the ESTV.
  assert.equal(ech0058ProductVersion('1.0.0-rc.10'), '1.0.0-r.10');
  assert.equal(ech0058ProductVersion('1.0.0-rc.123'), '1.0.0-r123');
  assert.equal(ech0058ProductVersion('10.2.3-beta.10'), '10.2.3-b10');
  for (const v of ['1.0.0-rc.10', '1.0.0-rc.123', '1.0.0-beta.99', '1.0.0-alpha.100', '10.20.30-rc.1', '1.0.0-rc.10000']) {
    const carried = ech0058ProductVersion(v);
    assert.ok(carried.length <= 10, `${v} -> ${carried} is over eCH-0058's 10 characters`);
    assert.match(carried, /^\d+\.\d+\.\d+-[0-9A-Za-z.]+$/, `${v} -> ${carried} must stay a prerelease, never the final release`);
    assert.ok(carried.startsWith(v.split('-')[0]), `${v} -> ${carried} keeps its release line`);
  }
  // The identifier letters are whole identifiers only: an `rc` inside another word is not rewritten.
  assert.equal(ech0058ProductVersion('1.0.0-arc.1'), '1.0.0-arc1');
});
