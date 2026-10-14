#!/usr/bin/env node
/**
 * The CLEAN-MACHINE proof for the npm package (M00 §8 "packaging checks", the beta-launch P0.1):
 * pack the tarball, install it the way a user would, start `till up` from the INSTALLED copy, and
 * fetch the Studio. A 200 with the Studio shell is the pass; the 501 `tillbooks@0.1.0` answered is
 * the failure this exists to catch before a publish, not after.
 *
 *   node scripts/verify-packed-studio.mjs --work <dir>                 pack (runs prepack) + verify
 *   node scripts/verify-packed-studio.mjs --work <dir> --tarball <tgz> verify an existing tarball
 *
 * Everything lands under `--work` (default: a fresh temp directory): the tarball, a `prefix/` the
 * package is installed into with `npm install -g --prefix` (the global layout, never the real global
 * prefix), and the ledger and support directory `till up` runs against (`TILL_DB_PATH`,
 * `TILL_SUPPORT_DIR`), so nothing touches `~/.till`. The port is a free loopback port found at run
 * time. The `till up` child is always killed, and the script checks the port is closed afterwards.
 *
 * NOT A SUITE. `npm install` of the tarball fetches its dependencies (better-sqlite3's native
 * binary included) from the registry, and the root suites run offline, so this is a release step:
 * run it before `npm publish`, from the checkout the publish runs in. The offline half (the
 * `files` list carries `dist/studio`, the vendor copy refuses a broken build) is
 * `test/packaging/npm-studio.test.mjs`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { referencedAssets } from './vendor-studio.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`verify-packed-studio: FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

function portIsClosed(port) {
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port });
    sock.once('connect', () => {
      sock.destroy();
      res(false);
    });
    sock.once('error', () => res(true));
  });
}

function pack(work) {
  const res = spawnSync(npm, ['pack', '--json', '--pack-destination', work], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) fail(`npm pack exited ${res.status}`);
  // prepack writes to stderr; stdout is the JSON report (an array with one entry per package).
  const start = res.stdout.indexOf('[');
  const report = JSON.parse(res.stdout.slice(start))[0];
  return { tarball: join(work, report.filename), report };
}

async function main() {
  const work = resolve(arg('--work') ?? mkdtempSync(join(tmpdir(), 'till-pack-')));
  mkdirSync(work, { recursive: true });
  const given = arg('--tarball');
  const summary = { work };

  let tarball;
  if (given !== undefined) {
    tarball = resolve(given);
  } else {
    const packed = pack(work);
    tarball = packed.tarball;
    const files = packed.report.files.map((f) => f.path);
    summary.pack = {
      filename: packed.report.filename,
      version: packed.report.version,
      size: packed.report.size,
      unpackedSize: packed.report.unpackedSize,
      entryCount: packed.report.entryCount,
      studioFiles: files.filter((p) => p.startsWith('dist/studio/')).length,
    };
    if (!files.includes('dist/studio/index.html')) fail('the tarball has no dist/studio/index.html');
  }
  summary.tarball = { path: tarball, bytes: statSync(tarball).size };

  // Install exactly as `npm install -g` would, into a scratch prefix.
  const prefix = join(work, 'prefix');
  const install = spawnSync(npm, ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
    cwd: work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (install.status !== 0) fail(`npm install exited ${install.status}: ${install.stderr}`);
  const bin = join(prefix, 'bin', 'till');
  if (!existsSync(bin)) fail(`the install has no till binary at ${bin}`);
  const installedStudio = join(prefix, 'lib', 'node_modules', 'tillbooks', 'dist', 'studio', 'index.html');
  if (!existsSync(installedStudio)) fail(`the installed package has no ${installedStudio}`);
  summary.installed = { bin, studioIndex: installedStudio };

  const port = await freePort();
  const dataDir = join(work, 'data');
  const supportDir = join(work, 'support');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(supportDir, { recursive: true });
  const env = { ...process.env, TILL_DB_PATH: join(dataDir, 'till.db'), TILL_SUPPORT_DIR: supportDir, TILL_PORT: String(port), TILL_HOST: '127.0.0.1', TILL_NO_OPEN: '1' };
  delete env.TILL_STUDIO_DIR;
  // Run from the scratch dir so no checkout's app/dist can be the thing that answers.
  const child = spawn(bin, ['up', '--no-open'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', () => {});

  try {
    const deadline = Date.now() + 60_000;
    while (!/Studio.* at http/.test(stderr)) {
      if (child.exitCode !== null) fail(`till up exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) fail(`till up did not report its URL within 60 s: ${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const base = `http://127.0.0.1:${port}`;
    const home = await fetch(`${base}/`);
    const html = await home.text();
    summary.studio = {
      stderr: stderr.trim().split('\n'),
      status: home.status,
      contentType: home.headers.get('content-type'),
      bytes: html.length,
    };
    if (home.status !== 200) fail(`GET / answered ${home.status}: ${html.slice(0, 200)}`);
    if (!/<div id="root"/.test(html)) fail('GET / did not return the Studio shell');
    const deep = await fetch(`${base}/agent`);
    summary.studio.deepLinkStatus = deep.status;
    if (deep.status !== 200) fail(`GET /agent answered ${deep.status}`);
    const assets = referencedAssets(html);
    const script = assets.find((p) => p.endsWith('.js'));
    if (script === undefined) fail('the Studio shell references no script');
    const asset = await fetch(`${base}/${script}`);
    summary.studio.asset = { path: script, status: asset.status, bytes: (await asset.arrayBuffer()).byteLength };
    if (asset.status !== 200) fail(`GET /${script} answered ${asset.status}`);
    const status = await fetch(`${base}/api/delivery_status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const delivery = await status.json();
    summary.deliveryStatus = { mode: delivery.mode, studioServed: delivery.studioServed, dbPath: delivery.dbPath };
    if (delivery.studioServed !== true) fail('delivery_status reports studioServed false');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    summary.portClosedAfter = await portIsClosed(port);
    // A clean stop releases the single-instance lock; a lock left behind means it was killed hard.
    summary.lockReleased = !existsSync(join(supportDir, 'up.lock'));
  }
  if (!summary.portClosedAfter) fail(`port ${port} still open after till up was stopped`);
  console.log(JSON.stringify(summary, null, 2));
  console.error('verify-packed-studio: PASS');
}

main().catch((e) => {
  if (process.exitCode !== 1) console.error(e instanceof Error ? e.stack : String(e));
  process.exitCode = 1;
});
