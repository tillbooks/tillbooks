/**
 * `till up` (M00): ONE loopback process that is the whole product for a human.
 *
 * `till serve` (D23) hosts `/mcp` alone: no REST face, no GUI, and no tick source for the G01/A12/
 * A15/A33 cadences. `till up` is `till serve` PLUS the three things that make TILL reachable by its
 * own personas without a terminal:
 *
 *   1. it serves the BUILT Studio (static files) at `/`, so there is no Vite and no second terminal;
 *   2. it mounts the REST twins (`/api/:action`) beside `/mcp`, behind the SAME localhost guard
 *      (`createLocalHttpRouter({ rest: true })`), which is the shipped form of the dev bridge;
 *   3. it runs the in-process scheduler tick (US-M00.4) so "recurring" does not mean "recurring
 *      whenever an agent happens to poke the tick".
 *
 * IT ADDS NOTHING TO THE TRUST STORY. The bind policy is `till serve`'s, imported verbatim: loopback
 * only, the same `TILL_EXPOSE_LEDGER_UNAUTHENTICATED` escape hatch with the same loud banner, and the
 * same refusal to fall back to a random port (a moving URL breaks bookmarks and the mcpb config). It
 * opens no outbound socket (the E07 posture extends to the new process). Any SERVED deployment goes
 * through M01, not here.
 *
 * SINGLE INSTANCE. A second `till up` detects the first through the advisory lock (`up-lock.ts`),
 * prints its URL, opens the browser at it and exits without starting a second scheduler.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { makeApiDeps } from './mcp.js';
import { resolveEbicsRuntime } from './host-runtime.js';
import { createLocalHttpRouter, pathnameOf } from './local-http.js';
import { resolveServedMode, type ServedModeConfig } from './served-mode.js';
import { rejectNonLocal } from './local-guard.js';
import {
  isBindablePort,
  invalidPortRefusal,
  isLoopbackBindHost,
  nonLoopbackRefusal,
  nonLoopbackWarning,
  normalizeBindHostForUrl,
  DEFAULT_PORT,
  EXPOSE_ENV,
} from './serve.js';
import { resolveSupportDir } from './db-path.js';
import { setDeliveryRuntime, resetDeliveryRuntime } from './runtime-state.js';
import { createScheduler, resolveTickMs, type Scheduler } from './scheduler.js';
import { acquireLock, releaseLock, type UpLock } from './up-lock.js';
import type { SqliteStore } from '../core/store/sqlite-store.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the built Studio lives. THREE candidates, in order, and the first that exists wins:
 *
 *   1. `TILL_STUDIO_DIR`, an explicit override (tests, and an operator who vendored it elsewhere);
 *   2. `dist/studio`, the VENDORED location a packaging step copies `app/dist` into (this file
 *      compiles to `dist/api/up.js`, so `dist/studio` is one directory up and over);
 *   3. `app/dist`, the repo-checkout location `npm --prefix app run build` writes.
 *
 * The `dist/studio` vs `app/dist` choice is the package-layout call §9 flags as owner-gated: this
 * resolver serves whichever is present, so the code does not force the decision and works from a
 * packed tarball and a checkout alike. When NEITHER exists, `till up` still starts and serves the
 * API faces; a GET for the Studio returns a plain message telling the operator to build it.
 */
export function resolveStudioDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.TILL_STUDIO_DIR?.trim();
  const candidates = [
    ...(override !== undefined && override !== '' ? [override] : []),
    resolve(here, '..', 'studio'),
    resolve(here, '..', '..', 'app', 'dist'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

/** A small, sufficient content-type table for a Vite build's asset kinds. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve one GET from the built Studio, with an SPA fallback to `index.html` for a route the router
 * does not own (react-router owns the client paths). Returns true when it answered.
 *
 * PATH TRAVERSAL is refused: the requested path is normalised and rejoined under `studioDir`, and a
 * resolved target that escapes the directory falls back to `index.html` rather than reading it.
 */
export async function serveStudio(
  req: IncomingMessage,
  res: ServerResponse,
  studioDir: string,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = pathnameOf(req);

  // Map the URL path onto a file. A directory or `/` serves index.html; anything with an extension is
  // a concrete asset; a client route (no extension) falls back to index.html so a deep link loads.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let target = join(studioDir, rel);
  if (!target.startsWith(resolve(studioDir))) target = join(studioDir, 'index.html');

  let filePath = target;
  const hasExt = extname(pathname) !== '';
  if (!hasExt || pathname === '/' || pathname.endsWith('/')) {
    filePath = join(studioDir, 'index.html');
  } else {
    try {
      const s = await stat(target);
      if (s.isDirectory()) filePath = join(studioDir, 'index.html');
    } catch {
      // A missing asset with an extension is a genuine 404 (not an SPA route).
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return true;
    }
  }

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  const type = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** Open the default browser at `url`, best-effort. A launch failure is never fatal: the URL is printed. */
export function openBrowser(url: string, log: (line: string) => void = () => {}): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => log(`till up: could not open a browser automatically. Open ${url} yourself.`));
    child.unref();
  } catch {
    log(`till up: could not open a browser automatically. Open ${url} yourself.`);
  }
}

export interface UpOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  supportDir?: string;
  studioDir?: string | null;
  /** Open the browser once bound. Defaults to true; the CLI turns it off with `--no-open`. */
  open?: boolean;
  /** The scheduler tick interval in ms, already resolved. Defaults to `resolveTickMs()`. */
  tickMs?: number;
  /** Permit a non-loopback bind. Defaults to the `till serve` env rule. */
  allowNonLoopback?: boolean;
  /** M01: served-mode config. Defaults to `resolveServedMode()` (env, throws on misconfiguration). */
  servedMode?: ServedModeConfig;
  log?: (line: string) => void;
}

export interface UpHandle {
  server: Server;
  store: SqliteStore;
  scheduler: Scheduler;
  url: string;
  studioServed: boolean;
  close(): Promise<void>;
}

/**
 * The result of starting `till up`: either it BOUND (a full handle), or a live instance already
 * holds the lock and this call is a REDIRECT (the caller prints the URL, opens the browser, exits 0).
 */
export type UpResult =
  | ({ started: true } & UpHandle)
  | { started: false; holder: UpLock };

/**
 * Start `till up`. Resolves once the listener is bound (or immediately, on the redirect path). The
 * bind checks run FIRST, exactly as `till serve`, so a refused run neither binds a socket nor leaves
 * a database behind.
 */
export async function startUp(opts: UpOptions = {}): Promise<UpResult> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;
  const log = opts.log ?? ((line: string) => console.error(line));
  const supportDir = opts.supportDir ?? resolveSupportDir();

  // M01: resolve served mode before anything opens; `resolveServedMode` throws the refusal on a
  // misconfiguration (fail closed). Unset env means local mode, so a plain `till up` is unaffected.
  const servedMode = opts.servedMode ?? resolveServedMode();

  // Port before host, so a bad port is never reported as `host:NaN`. Both refuse before anything opens.
  if (!isBindablePort(port)) throw new Error(invalidPortRefusal(port));
  if (!isLoopbackBindHost(host)) {
    const allowed = opts.allowNonLoopback ?? process.env[EXPOSE_ENV] === '1';
    if (!allowed) throw new Error(nonLoopbackRefusal(host, port));
    for (const line of nonLoopbackWarning(host, port)) log(line);
  }

  const authority = normalizeBindHostForUrl(host);
  const startedAt = new Date().toISOString();

  // The single-instance guard, BEFORE the store is opened: a second `till up` must not even touch the
  // database, let alone start a scheduler. A live holder is a redirect; a stale lock is reclaimed. The
  // lock is written with the requested port and rewritten with the BOUND port once listening (they
  // differ only when the caller asked for an ephemeral port, which real fixed-port usage never does).
  const acquired = acquireLock(supportDir, {
    pid: process.pid,
    host,
    port,
    url: `http://${authority}:${port}`,
    startedAt,
  });
  if (!acquired.acquired) {
    return { started: false, holder: acquired.holder };
  }

  const studioDir = opts.studioDir === undefined ? resolveStudioDir() : opts.studioDir;
  const studioServed = studioDir !== null;

  // D108: attach the private live bank wire when configured; otherwise EBICS steps degrade honestly.
  const { deps, store } = makeApiDeps(opts.dbPath, await resolveEbicsRuntime());
  // The REST face's actor is `studio` (D25), the shipped form of the dev bridge's posture: the REST
  // twins are the Studio's own bridge and the Studio is the human. The MCP face NEVER inherits it: it
  // seats every session by the rule in `session.ts` (a `till-studio` client lands `studio`, `till-cli`
  // and EVERY unrecognised client land the governed `agent` seat). Until F-08 (2026-09-05) this value
  // was also the MCP face's fallback, so Claude Desktop on `till up` was seated as the Studio and
  // bypassed the A35 dial and the trace. `till up` changes transport, not rights (A24 is untouched).
  // M01: in served mode BOTH faces require and resolve the proxy-attested subject; the `studio`
  // fallback actor below is used only in local mode (served requests never fall back to it).
  const router = createLocalHttpRouter({ ...deps, actor: 'studio' }, { rest: true, servedMode });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void router
      .handle(req, res)
      .then(async (handled) => {
        if (handled) return;
        // Not an engine face: serve the built Studio, behind the SAME localhost guard the API faces
        // get (a rebound page must not even read the shell from a non-local Host/Origin).
        const rejection = rejectNonLocal(req);
        if (rejection !== null) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: rejection.error, message: rejection.detail }));
          return;
        }
        if (studioDir !== null && (await serveStudio(req, res, studioDir))) return;
        res.writeHead(studioDir === null ? 501 : 404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          studioDir === null
            ? 'The Studio is not built into this install. Build it (npm --prefix app run build) or set TILL_STUDIO_DIR.'
            : 'not found',
        );
      })
      .catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'up_error', detail: String(e) }));
      });
  });

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolvePromise();
      });
    });
  } catch (e) {
    await router.closeAll();
    store.close();
    releaseLock(supportDir, process.pid);
    const detail = e instanceof Error ? e.message : String(e);
    const busy = (e as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
    throw new Error(
      [
        `till up: cannot bind ${host}:${port}. ${detail}`,
        ...(busy
          ? ['', `Port ${port} is already in use. Set TILL_PORT to a free port; till up never moves to a random one.`]
          : []),
      ].join('\n'),
    );
  }

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${authority}:${boundPort}`;
  // Finalise the lock with the real bound port, so a second `till up` redirects to a URL that dials.
  if (boundPort !== port) {
    acquireLock(supportDir, { pid: process.pid, host, port: boundPort, url, startedAt });
  }

  setDeliveryRuntime({ mode: 'up', host, port: boundPort, studioServed });

  const scheduler = createScheduler(deps, { intervalMs: opts.tickMs ?? resolveTickMs() });
  scheduler.start();

  let closed = false;
  const handle: UpHandle = {
    server,
    store,
    scheduler,
    url,
    studioServed,
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      await router.closeAll();
      await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
      store.close();
      releaseLock(supportDir, process.pid);
      resetDeliveryRuntime();
    },
  };

  if (opts.open !== false) openBrowser(url, log);

  return { started: true, ...handle };
}
