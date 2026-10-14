#!/usr/bin/env node
/**
 * Vendor the built Studio into the npm package (M00, the beta-launch P0.1).
 *
 * THE DEFECT THIS EXISTS FOR. `tillbooks@0.1.0` shipped `bin/` and `dist/core` + `dist/api` and not
 * one Studio file, because `prepack` only ran `tsc`. Every `npm i -g tillbooks && till up` therefore
 * answered the browser with HTTP 501 ("The Studio is not built into this install") and told the
 * operator to run `npm --prefix app run build`, a command an npm install cannot run: the package has
 * no `app/`. The documented install gave you no GUI at all.
 *
 * WHAT IT DOES. `resolveStudioDir` in `src/api/up.ts` already looks for `dist/studio` (the vendored
 * location, the one the Docker image uses) before `app/dist`. So the package only has to CONTAIN it:
 *
 *   node scripts/vendor-studio.mjs           copy an existing `app/dist` into `dist/studio`
 *   node scripts/vendor-studio.mjs --build   build the Studio first (`npm --prefix app run build`),
 *                                            then copy. This is what `prepack` runs.
 *
 * It FAILS rather than packs a tarball without a Studio: a missing `app/node_modules` (run
 * `npm run setup` first), a build that exits non-zero, or a build with no `index.html` all exit 1
 * with a sentence saying which. A silent Studio-less tarball is exactly the 0.1.0 defect, so it is
 * the one outcome this script refuses to produce.
 *
 * `vendorStudio` is exported so `test/packaging/npm-studio.test.mjs` runs the same copy on temp
 * directories with no process spawn and no real build.
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(scriptDir, '..');

/** Every file under `dir`, as paths relative to it (POSIX separators, sorted). */
export function listFiles(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The asset paths an `index.html` references with a root-relative `src`/`href` (`/assets/x.js`).
 * Vite emits exactly those, so a copy that lost one would serve an HTML shell whose script 404s: a
 * blank page instead of a 501, which is the same defect with a friendlier status code.
 */
export function referencedAssets(indexHtml) {
  const refs = new Set();
  for (const m of indexHtml.matchAll(/\s(?:src|href)="\/([^"?#]+)"/g)) {
    const path = m[1];
    if (path !== undefined && path.length > 0) refs.add(path);
  }
  return [...refs].sort();
}

/**
 * Copy a built Studio (`from`, normally `app/dist`) to `to` (normally `dist/studio`), replacing
 * whatever was there. Returns what was copied; throws with a sentence when the build is not usable.
 */
export function vendorStudio({ from, to }) {
  const index = join(from, 'index.html');
  if (!existsSync(index)) {
    throw new Error(
      `vendor-studio: no built Studio at ${from} (index.html missing). Run \`npm --prefix app run build\` first, or \`node scripts/vendor-studio.mjs --build\`.`,
    );
  }
  const missing = referencedAssets(readFileSync(index, 'utf8')).filter((p) => !existsSync(join(from, p)));
  if (missing.length > 0) {
    throw new Error(`vendor-studio: ${from}/index.html references files the build does not contain: ${missing.join(', ')}`);
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  const files = listFiles(to);
  if (!files.includes('index.html')) throw new Error(`vendor-studio: the copy to ${to} has no index.html`);
  return { from, to, files };
}

/** Build the Studio in `app/` with the checkout's own toolchain. Throws with the reason on failure. */
export function buildStudio(repoRoot = REPO_ROOT) {
  const appDir = join(repoRoot, 'app');
  if (!existsSync(join(appDir, 'package.json'))) {
    throw new Error(`vendor-studio: no app/ in ${repoRoot}. The Studio is built from a checkout, not from an installed package.`);
  }
  if (!existsSync(join(appDir, 'node_modules'))) {
    throw new Error(
      'vendor-studio: app/node_modules is missing, so the Studio cannot be built. Run `npm run setup` (npm ci at the root and in app/) and pack again.',
    );
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['--prefix', appDir, 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (res.error !== undefined) throw new Error(`vendor-studio: could not start the Studio build: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`vendor-studio: the Studio build exited ${res.status}; nothing was vendored.`);
}

function main(argv) {
  const from = join(REPO_ROOT, 'app', 'dist');
  const to = join(REPO_ROOT, 'dist', 'studio');
  try {
    if (argv.includes('--build')) buildStudio(REPO_ROOT);
    const { files } = vendorStudio({ from, to });
    console.error(`vendor-studio: ${files.length} Studio files copied to ${relative(REPO_ROOT, to)}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
