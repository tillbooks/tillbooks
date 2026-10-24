#!/usr/bin/env node
/**
 * marketing-screenshots.mjs: the product screenshots for tillbooks.ch, taken from a real running
 * Studio on the SYNTHETIC Seeblick demo ledger, and nothing else.
 *
 *   npm run shots:marketing                        # every surface, en + de-CH, light + dark
 *   npm run shots:marketing -- --only=journal,bank  # a subset (the manifest keeps the other entries)
 *   npm run shots:marketing -- --keep               # keep the temp dir (db, server log) to inspect
 *
 * What it does, in order:
 *   1. makes a fresh temp dir and seeds Seeblick into `<tmp>/till.db` with `scripts/seed-demo-rich.mjs`
 *      at a FIXED `TILL_SEED_TODAY` (`--today=`, default below), so a re-run reproduces the same books;
 *   2. starts `till up --no-open` on a throwaway port, with `TILL_SUPPORT_DIR` in the temp dir, so the
 *      run's Studio key, lock and diagnostics never touch `~/.till`;
 *   3. drives Playwright (the copy `.claude/ui-tests` already installs) at 1440x900, deviceScaleFactor 2,
 *      in light and dark and in the Studio locales `en` and `de-CH`;
 *   4. writes `web/public/product/<surface>-<en|de>-<theme>.webp` plus `manifest.json` (pixel size and
 *      suggested alt text per locale). The WebP encode runs in the same Chromium, so no image library
 *      is added to the repo.
 *
 * PRIVATE DATA. The database path is checked against the temp dir before the seed runs, before the
 * server starts, and once more against the path the running server reports in its lock: anything
 * outside the temp dir is refused (`scripts/lib/marketing-shots.mjs`). A `TILL_DB_PATH` already set in
 * the caller's shell is never inherited.
 *
 * LOCALE. The Studio has no UI-language setting yet: `I18nProvider` starts in `de-CH` and nothing in
 * the shell changes it. The English catalog is complete, so for the `en` frames this script sets the
 * provider's locale in the page itself, after load (`setStudioLocale`). The pixels are the Studio's own
 * English rendering; only the switch is the script's.
 *
 * Needs `npm run build` (the engine) and a built Studio (`app/dist`, or `TILL_STUDIO_DIR`). `--build`
 * builds both first; without it a missing build is an error, never a silent stale run.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitEnv } from './lib/git-env.mjs';
import {
  SURFACES,
  LOCALES,
  THEMES,
  VIEWPORT,
  DEVICE_SCALE_FACTOR,
  AGENT_DRAFTS,
  assertDbInsideTemp,
  shotFileName,
  buildManifest,
} from './lib/marketing-shots.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'web', 'public', 'product');
const UI_TESTS = join(ROOT, '.claude', 'ui-tests');

// A mid-quarter TODAY: Q3 is closed and due, the current quarter is live, invoices are overdue.
const DEFAULT_SEED_TODAY = '2026-10-20';
const WEBP_QUALITY = 0.86;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const seedToday = opt('today') ?? DEFAULT_SEED_TODAY;
if (!/^\d{4}-\d{2}-\d{2}$/.test(seedToday)) throw new Error(`--today must be YYYY-MM-DD, got ${seedToday}`);
const only = opt('only')?.split(',').filter(Boolean) ?? null;
const onlyLocales = opt('locale')?.split(',').filter(Boolean) ?? LOCALES;
const onlyThemes = opt('theme')?.split(',').filter(Boolean) ?? THEMES;
const port = Number(opt('port') ?? 8797);
for (const id of only ?? []) if (!SURFACES.some((s) => s.id === id)) throw new Error(`unknown surface in --only: ${id}`);

const log = (...m) => console.log('[shots]', ...m);

// ---------------------------------------------------------------------------------------------------
// 0. Builds
// ---------------------------------------------------------------------------------------------------

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, env: gitEnv(), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${r.status}`);
}

const studioDir = process.env.TILL_STUDIO_DIR?.trim() || join(ROOT, 'app', 'dist');
if (flag('build')) {
  run('npm', ['run', 'build']);
  if (!process.env.TILL_STUDIO_DIR) run('npm', ['--prefix', 'app', 'run', 'build']);
}
if (!existsSync(join(ROOT, 'dist', 'api', 'up.js'))) throw new Error('dist/ is missing: run `npm run build` or pass --build');
if (!existsSync(join(studioDir, 'index.html'))) throw new Error(`no built Studio at ${studioDir}: run \`npm --prefix app run build\` or pass --build`);
log(`Studio build: ${studioDir} (built ${statSync(join(studioDir, 'index.html')).mtime.toISOString()})`);

const require = createRequire(join(UI_TESTS, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  throw new Error(`playwright not found under ${UI_TESTS}: run \`npm install\` there (or symlink its node_modules)`);
}

// ---------------------------------------------------------------------------------------------------
// 1. Temp dir + guarded env + seed
// ---------------------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'till-marketing-shots-'));
const dbPath = join(tmp, 'till.db');
const supportDir = join(tmp, 'support');
mkdirSync(supportDir);
assertDbInsideTemp(tmp, dbPath);
log(`temp dir ${tmp}`);

// The child env starts from the caller's, minus every TILL_ variable (a stray TILL_DB_PATH in the shell
// must not leak in), plus exactly what this run decides.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TILL_')));
Object.assign(childEnv, {
  TILL_DB_PATH: dbPath,
  TILL_SUPPORT_DIR: supportDir,
  TILL_SEED_TODAY: seedToday,
  TILL_PORT: String(port),
  TILL_NO_OPEN: '1',
  TILL_STUDIO_DIR: studioDir,
});
assertDbInsideTemp(tmp, childEnv.TILL_DB_PATH);

let server = null;
let browser = null;
let failed = false;

async function cleanup() {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => {
        server.kill('SIGKILL');
        r();
      }, 5000);
      server.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }
  if (flag('keep') || failed) log(`kept temp dir ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

process.once('SIGINT', () => {
  failed = true;
  void cleanup().then(() => process.exit(130));
});

try {
  log(`seeding Seeblick at TODAY=${seedToday} (slow on a loaded box)`);
  run('node', [join(ROOT, 'scripts', 'seed-demo-rich.mjs'), '--reset'], {
    env: childEnv,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  assertDbInsideTemp(tmp, dbPath);

  // -------------------------------------------------------------------------------------------------
  // 2. till up
  // -------------------------------------------------------------------------------------------------

  // A server already on the port would answer the readiness probe and the browser would talk to IT,
  // with a ticket it cannot redeem (or, worse, to someone's real books): refuse a busy port up front.
  const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is already serving something; stop it or pass --port=`);

  const serverLog = join(tmp, 'till-up.log');
  log(`starting till up on 127.0.0.1:${port}`);
  const outChunks = [];
  server = spawn(process.execPath, [join(ROOT, 'bin', 'till.mjs'), 'up', '--no-open'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => outChunks.push(b));
  server.stderr.on('data', (b) => outChunks.push(b));
  server.once('exit', () => writeFileSync(serverLog, Buffer.concat(outChunks)));

  const { readLock } = await import(join(ROOT, 'dist', 'api', 'up-lock.js'));
  const { readStudioLink } = await import(join(ROOT, 'dist', 'api', 'up.js'));
  const lock = await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(`till up exited ${server.exitCode}:\n${Buffer.concat(outChunks)}`);
    const l = readLock(supportDir);
    if (!l || l.pid !== server.pid) return null;
    const r = await fetch(`${l.url}/`).catch(() => null);
    return r?.ok ? l : null;
  }, 120_000, 'till up to bind');
  if (lock.dbPath !== undefined) assertDbInsideTemp(tmp, lock.dbPath);
  log(`serving ${lock.url} (pid ${lock.pid}, db ${lock.dbPath ?? dbPath})`);

  // The seed also creates a thin second company (the empty-state demo); the website shows Seeblick, so
  // every surface opens under its workspace route instead of whichever workspace the Studio picks.
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(assertDbInsideTemp(tmp, dbPath), { readOnly: true });
  const seeblick = ro.prepare("SELECT id FROM workspace WHERE name LIKE 'Seeblick%' ORDER BY id LIMIT 1").get();
  ro.close();
  if (!seeblick) throw new Error('the seed produced no Seeblick workspace');
  const wsBase = `${lock.url}/w/${seeblick.id}`;

  await draftAgentProposals(lock.url, seeblick.id, seedToday);

  // -------------------------------------------------------------------------------------------------
  // 3. Capture
  // -------------------------------------------------------------------------------------------------

  browser = await chromium.launch();
  const encoder = await browser.newPage();
  await encoder.setContent('<!doctype html><title>encoder</title>');

  mkdirSync(OUT_DIR, { recursive: true });
  const entries = [];
  const surfaces = SURFACES.filter((s) => !only || only.includes(s.id));

  // ONE context for the whole run: the Studio ticket is single-use per server process, so a second
  // context could not sign in. The theme preference defaults to `system`, so switching the emulated
  // colour scheme switches the Studio's theme live.
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'reduce',
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
  });
  // Sign in: open a freshly derived one-time ticket link in a fresh tab. A ticket is single-use and
  // short-lived, and on a loaded box the first redeem can lose a race with the Studio's own repair
  // path, so a refused tab is thrown away and the next attempt starts clean with a new ticket.
  let page = null;
  for (let attempt = 1; ; attempt++) {
    page = await context.newPage();
    page.on('response', (r) => {
      if (/\/studio\//.test(r.url())) log(`  ${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
    });
    if (process.env.SHOTS_DEBUG) page.on('console', (m) => log(`  console.${m.type()}: ${m.text()}`));
    await page.emulateMedia({ colorScheme: onlyThemes[0] });
    const link = readStudioLink(supportDir, lock);
    if (!link) throw new Error('no Studio key in the temp support dir; cannot open the Studio');
    await page.goto(link);
    try {
      await settle(page);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`sign-in attempt ${attempt} refused; retrying in a fresh tab`);
      await page.close();
    }
  }
  let invoiceRoute = null;

  for (const theme of onlyThemes) {
    await page.emulateMedia({ colorScheme: theme });

    for (const locale of onlyLocales) {
      for (const surface of surfaces) {
        let route = surface.route;
        if (surface.id === 'qr-invoice') route = invoiceRoute ??= await findQrInvoiceRoute(page, wsBase);
        await page.goto(`${wsBase}${route}`);
        await settle(page);
        if (locale !== 'de-CH') await setStudioLocale(page, locale);
        await prepareFrame(page, surface.id);
        const png = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 180_000 });
        const file = shotFileName(surface.id, locale, theme);
        const { width, height, bytes } = await encodeWebp(encoder, png);
        writeFileSync(join(OUT_DIR, file), bytes);
        entries.push({ file, surface: surface.id, locale, theme, width, height });
        log(`${file} ${width}x${height} ${(bytes.length / 1024).toFixed(0)} KB`);
      }
    }
  }
  await context.close();

  // -------------------------------------------------------------------------------------------------
  // 4. Manifest (merged, so a partial --only run keeps the other entries)
  // -------------------------------------------------------------------------------------------------

  const manifestPath = join(OUT_DIR, 'manifest.json');
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).images ?? {} : {};
  const merged = new Map(
    Object.entries(previous)
      .filter(([file, e]) => existsSync(join(OUT_DIR, file)) && isCurrentName(file, e))
      .map(([file, e]) => [file, { file, ...e }]),
  );
  for (const e of entries) merged.set(e.file, e);
  writeFileSync(manifestPath, JSON.stringify(buildManifest([...merged.values()], { seedToday }), null, 2) + '\n');
  log(`wrote ${entries.length} images and ${manifestPath}`);
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  await cleanup();
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/**
 * Act as an MCP client against the running engine (the agent seat, over `/mcp`) and draft
 * `AGENT_DRAFTS`. At the default dial every write returns a pending proposal instead of posting,
 * which is what the proposals view lists. Idempotency keys make a retry a no-op.
 */
async function draftAgentProposals(origin, workspaceId, today) {
  let session = null;
  let id = 0;
  const rpc = async (method, params, notify = false) => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
    });
    session ??= res.headers.get('mcp-session-id');
    if (notify) return null;
    const body = await res.json();
    if (body.error) throw new Error(`MCP ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const out = JSON.parse(r.content[0].text);
    if (out.ok === false) throw new Error(`MCP ${name}: ${JSON.stringify(out)}`);
    return out;
  };

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Demo agent', version: '1.0' } });
  await rpc('notifications/initialized', {}, true);
  const { accounts } = await tool('list_accounts', { workspaceId });
  const acc = (number) => {
    const a = accounts.find((x) => x.number === number);
    if (!a) throw new Error(`Seeblick has no account ${number}`);
    return a.id;
  };
  for (const [i, d] of AGENT_DRAFTS.entries()) {
    const out = await tool('post_entry', {
      workspaceId,
      date: today,
      description: d.description,
      source: 'manual',
      idempotencyKey: `shots:agent:${i}`,
      lines: [
        { account: acc(d.debit), debit: d.amount },
        { account: acc(d.credit), credit: d.amount },
      ],
    });
    if (out.drafted !== true) throw new Error(`post_entry was not drafted (did the dial change?): ${JSON.stringify(out)}`);
  }
  log(`the demo agent drafted ${AGENT_DRAFTS.length} proposals over MCP`);
}

/** A previous manifest entry still matches today's naming contract (a renamed surface drops out). */
function isCurrentName(file, e) {
  try {
    return shotFileName(e.surface, e.locale, e.theme) === file;
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Wait until the surface has loaded: network quiet, no busy region, no skeleton, fonts ready. */
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page
    .waitForFunction(
      () =>
        document.querySelector('#root')?.childElementCount > 0 &&
        !document.querySelector('[aria-busy="true"], .skeleton, [data-loading="true"]'),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  // A tab without a credential shows the Studio-key notice instead of the product: never capture it.
  // The notice also shows while a ticket redeem is still in flight, which on a loaded box can take a
  // while, so give it time to clear before calling it a refusal.
  const cleared = await page
    .waitForFunction(() => !document.querySelector('#till-studio-key-notice'), null, {
      timeout: 90_000,
    })
    .then(() => true, () => false);
  if (!cleared) {
    throw new Error(`the Studio refused this tab's credential at ${page.url()} (a Studio build older than the engine?)`);
  }
}

/**
 * Set the Studio's UI locale in the running page. `I18nProvider` holds it in its first `useState`
 * (`app/src/i18n/index.tsx`); this finds the shallowest component whose first hook holds a Studio
 * locale and dispatches the new one, which is exactly what a language setting would call.
 */
async function setStudioLocale(page, locale) {
  const ok = await page.evaluate((next) => {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    if (!key) return false;
    const queue = [root[key]];
    while (queue.length) {
      const f = queue.shift();
      if (!f) continue;
      const hook = typeof f.type === 'function' ? f.memoizedState : null;
      if (hook && (hook.memoizedState === 'de-CH' || hook.memoizedState === 'en') && hook.queue?.dispatch) {
        hook.queue.dispatch(next);
        document.documentElement.lang = next;
        return true;
      }
      for (let c = f.child; c; c = c.sibling) queue.push(c);
    }
    return false;
  }, locale);
  if (!ok) throw new Error(`could not set the Studio locale to ${locale}`);
  await settle(page);
}

/** Hide what is not product: focus rings from the last click, toasts, the caret, scrollbars. */
async function prepareFrame(page, surfaceId) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after { caret-color: transparent !important; transition: none !important; animation: none !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      [role="status"].toast, .toast, .action-feedback, [data-dev-only] { display: none !important; }
    `,
  });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.mouse.move(0, VIEWPORT.height - 1);
  if (surfaceId === 'qr-invoice') {
    // Bring the QR payment part into the frame, with the invoice header still above it if it fits.
    await page.evaluate(() => {
      const qr = document.querySelector('.invoice-qr-panel');
      const scroller = qr && (function find(el) {
        for (let n = el.parentElement; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
        }
        return document.scrollingElement;
      })(qr);
      if (!qr || !scroller) return;
      const top = qr.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const slack = Math.max(0, scroller.clientHeight - qr.getBoundingClientRect().height - 24);
      scroller.scrollTop += Math.max(0, top - Math.min(slack, 260));
    });
  }
  await page.waitForTimeout(150);
}

/** The route of an issued Seeblick invoice whose QR payment part renders. */
async function findQrInvoiceRoute(page, base) {
  await page.goto(`${base}/documents`);
  await settle(page);
  const hrefs = await page.$$eval('a[href*="/documents/"]', (as) =>
    [...new Set(as.map((a) => new URL(a.href).pathname.replace(/^\/w\/[^/]+/, '')))].filter(
      (h) => /^\/documents\/[^/]+$/.test(h) && h !== '/documents/new',
    ),
  );
  for (const href of hrefs.slice(0, 25)) {
    await page.goto(`${base}${href}`);
    await settle(page);
    if (await page.$('.invoice-qr-panel .invoice-qr-svg svg')) return href;
  }
  throw new Error('no issued invoice with a QR payment part found in the seeded ledger');
}

/** PNG bytes to WebP bytes, encoded by Chromium's own canvas encoder. */
async function encodeWebp(encoder, png) {
  const res = await encoder.evaluate(
    async ({ b64, q }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') throw new Error('this Chromium cannot encode WebP');
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { width: canvas.width, height: canvas.height, b64: btoa(bin) };
    },
    { b64: png.toString('base64'), q: WEBP_QUALITY },
  );
  return { width: res.width, height: res.height, bytes: Buffer.from(res.b64, 'base64') };
}
