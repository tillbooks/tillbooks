/**
 * The npm package carries the Studio (M00 §8 packaging checks, the beta-launch P0.1).
 *
 * THE DEFECT. `tillbooks@0.1.0` had 1'795 files and not one of them was the Studio, because `prepack`
 * ran `tsc` and nothing else. `till up` from an npm install answered HTTP 501 on every browser GET.
 *
 * WHAT THIS PROVES OFFLINE (the suites never touch the network):
 *
 *   1. `prepack` builds the engine, THEN builds and vendors the Studio (`scripts/vendor-studio.mjs
 *      --build`), in that order: the Studio build loads `../dist` at config time.
 *   2. The `files` whitelist ships `dist/studio`: `npm pack --dry-run --ignore-scripts` over a staging
 *      copy of the REAL package.json lists `dist/studio/index.html` and leaves `app/` out.
 *   3. The vendor copy refuses what would pack a broken Studio (no index.html, or an index.html whose
 *      script the build does not contain) and copies a good build whole.
 *   4. (The version lockstep of every shipped version string is `version-lockstep.test.mjs`.)
 *
 * The ONLINE half (pack for real, `npm install -g --prefix <scratch>`, `till up` from the installed
 * copy, GET / answers 200 with the Studio shell) is `scripts/verify-packed-studio.mjs`, a release step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { vendorStudio, referencedAssets, listFiles } from '../../scripts/vendor-studio.mjs';
import { STUDIO_NOT_BUILT } from '../../dist/api/up.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A minimal Vite-shaped build: an index.html that references one script and one stylesheet. */
function fakeBuild(dir, { withScript = true } = {}) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>',
  );
  if (withScript) writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'index-abc.css'), 'body{}');
  return dir;
}

test('prepack builds the engine, then builds and vendors the Studio into dist/studio', () => {
  const prepack = pkg.scripts.prepack;
  assert.equal(typeof prepack, 'string');
  const build = prepack.indexOf('npm run build');
  const vendor = prepack.indexOf('node scripts/vendor-studio.mjs --build');
  assert.ok(build >= 0, `prepack must run the engine build: ${prepack}`);
  assert.ok(vendor > build, `prepack must vendor the Studio AFTER the engine build: ${prepack}`);
  assert.ok(existsSync(join(repoRoot, 'scripts', 'vendor-studio.mjs')));
});

test('the files whitelist ships dist/studio and leaves app/ out (npm pack --dry-run on the real package.json)', () => {
  const stage = scratch('till-pack-stage-');
  copyFileSync(join(repoRoot, 'package.json'), join(stage, 'package.json'));
  for (const f of ['LICENSE', 'README.md']) copyFileSync(join(repoRoot, f), join(stage, f));
  mkdirSync(join(stage, 'bin'), { recursive: true });
  writeFileSync(join(stage, 'bin', 'till.mjs'), '#!/usr/bin/env node\n');
  mkdirSync(join(stage, 'dist', 'api'), { recursive: true });
  writeFileSync(join(stage, 'dist', 'api', 'up.js'), 'export {};\n');
  fakeBuild(join(stage, 'dist', 'studio'));
  // A stray checkout build must NOT ride along: the package serves the vendored copy only.
  fakeBuild(join(stage, 'app', 'dist'));

  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: stage,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const report = JSON.parse(out.slice(out.indexOf('[')))[0];
  const files = report.files.map((f) => f.path);
  assert.ok(files.includes('dist/studio/index.html'), files.join('\n'));
  assert.ok(files.includes('dist/studio/assets/index-abc.js'), files.join('\n'));
  assert.ok(files.includes('bin/till.mjs'));
  assert.equal(files.filter((p) => p.startsWith('app/')).length, 0, 'app/ must not ship');
  assert.equal(report.version, pkg.version);
});

test('vendorStudio copies a whole build and replaces a stale copy', () => {
  const from = fakeBuild(scratch('till-app-dist-'));
  const to = join(scratch('till-dist-'), 'studio');
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, 'stale.js'), 'old');
  const res = vendorStudio({ from, to });
  assert.deepEqual(res.files, ['assets/index-abc.css', 'assets/index-abc.js', 'index.html']);
  assert.deepEqual(listFiles(to), res.files, 'the stale file from an earlier pack is gone');
});

test('vendorStudio refuses a missing build and a build whose shell references a missing script', () => {
  const to = join(scratch('till-dist-'), 'studio');
  assert.throws(() => vendorStudio({ from: scratch('till-empty-'), to }), /no built Studio/);
  const broken = fakeBuild(scratch('till-broken-'), { withScript: false });
  assert.throws(() => vendorStudio({ from: broken, to }), /assets\/index-abc\.js/);
  assert.equal(existsSync(join(to, 'index.html')), false, 'a refused copy writes nothing');
});

test('referencedAssets reads the root-relative src/href a Vite shell carries', () => {
  const html = '<script src="/assets/a.js"></script><link href="/assets/b.css"><a href="https://x.ch/">x</a><link href="/favicon.svg">';
  assert.deepEqual(referencedAssets(html), ['assets/a.js', 'assets/b.css', 'favicon.svg']);
});

test('a Studio-less install names both ways out, never the checkout-only command alone', () => {
  assert.match(STUDIO_NOT_BUILT, /not built into this install/);
  assert.match(STUDIO_NOT_BUILT, /npm install -g tillbooks@beta/);
  assert.match(STUDIO_NOT_BUILT, /npm run build:all/);
  assert.match(STUDIO_NOT_BUILT, /TILL_STUDIO_DIR/);
});
