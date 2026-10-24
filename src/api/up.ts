/**
 * `till up` (M00): ONE loopback process that is the whole product for a human.
 *
 * `till serve` (D23) hosts `/mcp` alone: no REST face, no GUI, and no tick source for the G01/A12/
 * A15/A33 cadences. `till up` is `till serve` PLUS the three things that make TILL reachable by its
 * own personas without a terminal:
 *
 *   1. it serves the BUILT Studio (static files) at `/`, so there is no Vite and no second terminal;
 *   2. it mounts the REST twins (`/api/:action`) beside `/mcp`, behind the SAME localhost guard
 *      (`createLocalHttpRouter({ rest: true })`), which is the shipped form of the dev bridge, and
 *      both faces hand the human seat only to the Studio it serves, through the Studio key;
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
import { resolveEbicsRuntime, type HostEbicsPorts } from './host-runtime.js';
import { createBankActivationOffload, createBankSyncOffload, isSharableDbPath } from './bank-sync-offload.js';
import { reclaimDeadSyncLeases } from '../core/banking/ebics/index.js';
import type { ApiDeps } from './registry.js';
import { createLocalHttpRouter, pathnameOf } from './local-http.js';
import { resolveServedMode, type ServedModeConfig } from './served-mode.js';
import { rejectNonLocal } from './local-guard.js';
import { studioTicketLink } from './session.js';
import { openStudioKeyStore, readStudioKeyFile, studioKeyPath, type StudioKeySource } from './studio-key-store.js';
import { deriveTicket, instanceIdOf, openStudioDeviceRegistry, type StudioDeviceRegistry } from './studio-devices.js';
import { doorHostKey } from './studio-door.js';
import { adoptBook, forgetBook, probeBook } from './book-adopt.js';
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
import { MEMORY_DB, resolveSupportDir, type AdoptedBookUnavailable } from './db-path.js';
import { setAdoptedBookUnavailable, setDeliveryRuntime, resetDeliveryRuntime } from './runtime-state.js';
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
 * The package-layout call M00 §9 left owner-gated is answered (beta launch plan P0.1, 30.09.2026):
 * VENDORED. `prepack` runs `scripts/vendor-studio.mjs --build`, so a packed tarball carries
 * `dist/studio` and the Docker image already did. The resolver still serves whichever is present, so
 * a checkout works off `app/dist` without a pack. When NEITHER exists, `till up` still starts and
 * serves the API faces; a GET for the Studio returns `STUDIO_NOT_BUILT`, naming both ways out.
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

/**
 * What a Studio GET answers when no build was found. Since the beta (P0.1) the npm package VENDORS
 * the Studio into `dist/studio` at `prepack`, so an npm install that lands here is an older or broken
 * package, and the old advice ("npm --prefix app run build") was a command an installed package
 * cannot run: it has no `app/`. Both ways out are named, the checkout one and the package one.
 */
export const STUDIO_NOT_BUILT = [
  'The Studio is not built into this install.',
  'Installed from npm: reinstall a release that ships it (npm install -g tillbooks@beta).',
  'From a checkout: npm run setup, then npm run build:all.',
  'Or set TILL_STUDIO_DIR to a built Studio.',
].join('\n');

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
 *
 * The files are served AS BUILT. The shell carries no Studio key, in any mode (critic R3-B2): the key
 * reaches the browser only through the link `startUp` prints and opens.
 */
export async function serveStudio(req: IncomingMessage, res: ServerResponse, studioDir: string): Promise<boolean> {
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
  // The shell is never cached (critic H1/M1): every load of the Studio must come from the process on
  // the port now, so a window always runs the code the live `till up` serves. Hashed assets may cache.
  const isShell = filePath.endsWith('index.html');
  res.writeHead(200, { 'content-type': type, ...(isShell ? { 'cache-control': 'no-store' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/**
 * The URL as it may be WRITTEN anywhere (a log line, a non-terminal banner): the fragment, which
 * carries a one-time ticket (`/#t=`) or, from the dev bridge, a key (`/#k=`), is cut. A log file is
 * not owner-only, and a ticket is a credential until it is spent.
 */
export function redactStudioLink(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Open the default browser at `url`, best-effort. A launch failure is never fatal: the URL is logged, minus any key. */
export function openBrowser(url: string, log: (line: string) => void = () => {}): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const failed = () => log(`till up: could not open a browser automatically. TILL is at ${redactStudioLink(url)}.`);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', failed);
    child.unref();
  } catch {
    failed();
  }
}

/**
 * Open a Studio link (it carries a one-time ticket, D166) through the operating system. On macOS the
 * link goes to `osascript` on stdin (`open location`), not on a command line: an argument is visible to
 * every account on the machine through `ps` while the process lives, and the reopen door can be fired
 * by any local program. Elsewhere it falls back to `openBrowser` (`xdg-open` takes the URL as an
 * argument; a ticket seen there is single-use and expires, DECISIONS D166). Best-effort, never fatal.
 */
export function openStudioLink(url: string, log: (line: string) => void = () => {}): void {
  // The link is ours (`studioTicketLink`): http(s), a host, a port, `#t=` (or the dev bridge's `#k=`)
  // and base64url. Anything else is not embedded in a script, whatever produced it.
  if (process.platform !== 'darwin' || !/^https?:\/\/[A-Za-z0-9.:[\]-]+\/#[tk]=[A-Za-z0-9_.-]+$/.test(url)) {
    openBrowser(url, log);
    return;
  }
  try {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    child.on('error', () => openBrowser(url, log));
    child.stdin?.end(`open location "${url}"\n`);
    child.unref();
  } catch {
    openBrowser(url, log);
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
  /**
   * D142: the ports module the sync worker builds its wire from, instead of the live-wire recipe. For
   * the suites (a slow synthetic bank behind the worker); production leaves it unset.
   */
  bankSyncPorts?: { portsModule: string; portsOptions?: unknown };
  /**
   * How a URL is opened through the operating system: the browser at start, and the D166 reopen.
   * Defaults to `openBrowser`. Suites pass a recorder so no real browser opens.
   */
  openUrl?: (url: string) => void;
  /**
   * Print the Studio link (with its one-time ticket) in the start banner. Defaults to FALSE, the safe
   * side; the CLI passes true only when stderr is a terminal (D166): a banner in a log file
   * (`~/Library/Logs/TILL.log`, a launcher's log) would keep a live credential in a file that is not
   * owner-only. Off, the banner names the bare URL.
   */
  announceStudioLink?: boolean;
  /**
   * D166 point 8: how this process restarts itself after the Studio adopted an existing book
   * (`POST /studio/adopt-book`), so the next start opens it. Called once, after the answer is out.
   * The CLI passes it (`bin/till.mjs`: exit 75 under TILL.app, else a detached successor); without
   * it the door refuses an adopt with `restart_unavailable` and records nothing.
   */
  onRestartRequested?: () => void;
  /**
   * D166 point 8 (critic F1/F2): `dbPath` is the ADOPTED book (`resolveDbChoice` source `adopted`).
   * Then a failed open does not stop `till up`: it starts on an in-memory book and reports the adopted
   * book unavailable (`unopenable`). `unavailable: 'missing'` says the file is already known to be gone.
   */
  adoptedBook?: { path: string; unavailable?: 'missing' };
  log?: (line: string) => void;
}

export interface UpHandle {
  server: Server;
  store: SqliteStore;
  scheduler: Scheduler;
  url: string;
  /**
   * The link the person opens the Studio through: `url` plus `/#t=<one-time ticket>` (D166; the key
   * itself is never in a link). The fragment never reaches
   * a server, which is how the key reaches the browser and nothing else (critic R3-B2).
   */
  studioUrl: string;
  studioServed: boolean;
  /**
   * The Studio key at start. In process only: the caller that started `till up` already holds the
   * store, so handing it the key grants nothing new. Tests use it to act as the Studio over HTTP.
   * After a rotation (D166) the live key is `studioKeys.current()`.
   */
  studioKey: string;
  /** The live key source the faces read on every request (D166). */
  studioKeys: StudioKeySource;
  /** The paired browsers (D166 layer 2). */
  studioDevices: StudioDeviceRegistry;
  close(): Promise<void>;
}

/**
 * The Studio link a live `till up` can be reopened through, for a SECOND `till up` (the redirect): the
 * holder's URL with a one-time ticket DERIVED from the owner-only key file for exactly that process
 * (its pid and start time, from the lock). The key itself never goes into a link (D166), and the lock
 * `till mcp` reads carries neither. Null when the support directory holds no trustworthy key: the
 * redirect then opens the bare URL and the tab repairs itself.
 */
export function readStudioLink(supportDir: string, holder: Pick<UpLock, 'url' | 'pid' | 'startedAt'>): string | null {
  const key = readStudioKeyFile(supportDir);
  return key === null ? null : studioTicketLink(holder.url, deriveTicket(key, instanceIdOf(holder.pid, holder.startedAt)));
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
/** Is a process with this pid alive? `EPERM` means it exists but is not ours: alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
  // P0.5: the lock names the ledger too, so an agent's `till mcp` can tell whether this Studio has its book open.
  let lockDbPath: { dbPath?: string } = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  const acquired = acquireLock(supportDir, {
    pid: process.pid,
    host,
    port,
    url: `http://${authority}:${port}`,
    startedAt,
    ...lockDbPath,
  });
  if (!acquired.acquired) {
    // The redirect opens the live instance's Studio LINK (its URL plus the persisted key, D166), so a
    // second `till up` lands in a working Studio. Only the returned copy carries it: the lock on disk
    // keeps the bare URL `till mcp` reads.
    const link = readStudioLink(supportDir, acquired.holder);
    return { started: false, holder: link === null ? acquired.holder : { ...acquired.holder, url: link } };
  }

  const studioDir = opts.studioDir === undefined ? resolveStudioDir() : opts.studioDir;
  const studioServed = studioDir !== null;

  // D108: attach the private live bank wire when configured; otherwise EBICS steps degrade honestly.
  // An open the store refuses (a book a newer TILL wrote, `schema_newer_than_runtime`) releases the
  // single-instance lock taken above: nothing is serving, and a lock naming this still-live pid would
  // turn a retry in the same process into a redirect to a server that never started.
  let opened: ReturnType<typeof makeApiDeps>;
  let hostPorts: HostEbicsPorts;
  try {
    hostPorts = await resolveEbicsRuntime();
  } catch (e) {
    releaseLock(supportDir, process.pid);
    throw e;
  }
  // D166 point 8 (critic F1/F2): an ADOPTED book that is missing, or whose open fails, never makes
  // this process open another book and never stops it: it starts on an in-memory book that writes
  // nowhere, runs no cadence, and tells the Studio, which offers "Erneut versuchen", "Anderes
  // Hauptbuch wählen" and "Vergessen und neu beginnen". Any other refused open fails as before.
  let unavailable: AdoptedBookUnavailable | null =
    opts.adoptedBook?.unavailable === 'missing' ? { path: opts.adoptedBook.path, reason: 'missing' } : null;
  // The adopted book is PROBED read-only before the writable open, exactly as the door probed it, so a
  // file that is no longer a TILL book this runtime can open (a foreign SQLite, a newer generation, a
  // lost permission) is never written to, not even a WAL header (critic F2).
  if (unavailable === null && opts.adoptedBook !== undefined) {
    const probe = probeBook(opts.adoptedBook.path);
    if (!probe.ok) unavailable = { path: opts.adoptedBook.path, reason: probe.error === 'book_not_found' ? 'missing' : 'unopenable' };
  }
  let dbPath = unavailable === null ? opts.dbPath : MEMORY_DB;
  try {
    opened = makeApiDeps(dbPath, hostPorts);
  } catch (e) {
    if (opts.adoptedBook === undefined || unavailable !== null) {
      releaseLock(supportDir, process.pid);
      throw e;
    }
    unavailable = { path: opts.adoptedBook.path, reason: 'unopenable' };
    dbPath = MEMORY_DB;
    log(`till up: the adopted book could not be opened (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); TILL shows what to do.`);
    opened = makeApiDeps(dbPath, hostPorts);
  }
  if (unavailable !== null) log(`till up: the adopted book is not reachable (${unavailable.reason}): ${unavailable.path}. Nothing is written until it is chosen again or forgotten.`);
  const { store } = opened;
  // D142 critic F2: a process killed mid-sync left its lease; the single-instance lock above proves no
  // other till up runs, so a lease whose holder process is gone is taken over now, not in 15 minutes.
  reclaimDeadSyncLeases(store, isPidAlive);
  // D142: `bank_sync` runs in a worker thread on its own connection to the same book, so the Studio
  // keeps answering while the bank wire waits. An in-memory book cannot be shared with a thread; there
  // the verb runs in process, exactly as before.
  const baseDeps: ApiDeps = isSharableDbPath(dbPath)
    ? {
        ...opened.deps,
        bankSyncRunner: createBankSyncOffload({
          dbPath,
          ...(hostPorts.recipe !== undefined ? { recipe: hostPorts.recipe } : {}),
          ...(opts.bankSyncPorts !== undefined ? opts.bankSyncPorts : {}),
        }),
        // D143 critic F1: the daily activation check's HPB runs in the same kind of worker.
        bankActivationRunner: createBankActivationOffload({
          dbPath,
          ...(hostPorts.recipe !== undefined ? { recipe: hostPorts.recipe } : {}),
          ...(opts.bankSyncPorts !== undefined ? opts.bankSyncPorts : {}),
        }),
      }
    : opened.deps;
  // D166 point 8 (critic N1): while the adopted book is unavailable, the transport dispatch refuses every
  // verb but delivery_status (agent-gate.ts), so nothing writes into the stand-in book.
  const deps: ApiDeps = unavailable === null ? baseDeps : { ...baseDeps, adoptedBookUnavailable: unavailable };
  // Critic L-a: the lock names the book this process actually OPENED (`:memory:` for the stand-in), so
  // `till mcp` and a second `till up` read the truth, not the book that was asked for.
  if (dbPath !== opts.dbPath && dbPath !== undefined) {
    lockDbPath = { dbPath };
    acquireLock(supportDir, { pid: process.pid, host, port, url: `http://${authority}:${port}`, startedAt, ...lockDbPath });
  }
  // The REST twins are the Studio's own bridge (D25) and the Studio is the human; the MCP face seats
  // every session by the rule in `session.ts`. Until F-08 (2026-09-05) the REST actor was also the MCP
  // face's fallback, so Claude Desktop on `till up` was seated as the Studio and bypassed the A35 dial
  // and the trace. `till up` changes transport, not rights (A24 is untouched).
  // M01: in served mode BOTH faces require and resolve the proxy-attested subject.
  //
  // THE STUDIO KEY (critic probe P6, 2026-10-12; delivery reworked for critic R3-B2 and D166). The
  // human seat used to be granted to a NAME (an MCP client declaring `till-studio`) and, on the REST
  // twins, to any caller at all. It is now granted only to a request carrying the Studio key, or a
  // session token a ticket or a paired device unlocked, checked on both faces (`session.ts`).
  //
  // HOW THE SEAT REACHES THE BROWSER: OUT OF BAND, THROUGH A LINK, never through anything served.
  // Browsers never send a URL fragment to the server, so `http://HOST:PORT/#t=<ticket>` reaches the
  // person's browser and nothing else. The served HTML carries NO credential: the first version wrote
  // the key into the page as a `<meta>` tag, and any local HTTP client (a fetch tool, a browser-driving
  // agent, curl) could GET `/`, read it and issue an invoice as the person with 0 Vorschläge (R3-B2).
  //
  // WHY A REQUEST HEADER AND NOT A COOKIE. Cookies are not isolated by port, so a page on
  // `http://localhost:3000` (any other dev server, any local tool's UI) is SAME-SITE with this one:
  // `SameSite=Strict` still attaches the cookie to its cross-origin `fetch`, the port-agnostic Origin
  // check passes it (`localhost` is local), and a `text/plain` POST needs no preflight, so that page
  // could issue an invoice as the person. The cookie would also be sent to every other server on
  // localhost. A custom header has neither problem: another origin cannot attach one without a CORS
  // preflight, which no face here answers.
  //
  // KEPT BETWEEN LAUNCHES, NEVER IN A LINK (D166, owner decision 14.10.2026). The key is read from (or,
  // on the first start, written to) `<support dir>/studio.key`, owner-only, and links carry one-time
  // tickets instead (`studio-devices.ts`): this host mints one for each link it opens, and TILL.app
  // derives one from the key file for exactly this process. A browser that redeemed a ticket pairs a
  // non-extractable device key, so bookmarks and new tabs unlock by themselves after a restart, and a
  // tab with nothing left asks the door below to reopen the Studio through the operating system. No
  // answer carries the key. Served mode keeps the key in memory: there the proxy-attested subject
  // seats the person and the key seats nobody, so it has no business on disk, and no door is mounted.
  const local = !servedMode.enabled;
  const studioKeys = openStudioKeyStore(supportDir, { persist: local });
  // D166 layer 2: the paired browsers, whose session tokens seat the person like the key does.
  const studioDevices = openStudioDeviceRegistry(supportDir, {
    persist: local,
    key: () => studioKeys.current(),
    instanceId: instanceIdOf(process.pid, startedAt),
  });
  const studioSeat = doorHostKey({ keys: studioKeys, devices: studioDevices });
  const openUrl = opts.openUrl ?? ((target: string) => openStudioLink(target, log));
  // The URL is known only once bound; the door reads it at call time.
  let boundUrl: string | null = null;
  const router = createLocalHttpRouter(deps, {
    rest: true,
    servedMode,
    studioKey: studioSeat,
    ...(local && studioDir !== null
      ? {
          studioDoor: {
            keys: studioKeys,
            devices: studioDevices,
            openStudio: openUrl,
            baseUrl: () => boundUrl,
            // D166 point 8: adopt an existing book from the first-run door, then restart onto it.
            // The open book is named so adopting it again is refused rather than restarting for nothing.
            ...(opts.onRestartRequested !== undefined
              ? {
                  adoptBook: (path: unknown) => adoptBook(supportDir, path, { openPath: dbPath }),
                  forgetBook: () => forgetBook(supportDir),
                  restart: opts.onRestartRequested,
                }
              : {}),
          },
        }
      : {}),
  });

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
        res.end(studioDir === null ? STUDIO_NOT_BUILT : 'not found');
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
  boundUrl = url;
  // Finalise the lock with the real bound port, so a second `till up` redirects to a URL that dials.
  if (boundPort !== port) {
    acquireLock(supportDir, { pid: process.pid, host, port: boundPort, url, startedAt, ...lockDbPath });
  }

  setDeliveryRuntime({ mode: 'up', host, port: boundPort, studioServed });
  setAdoptedBookUnavailable(unavailable);

  // No cadence runs against the stand-in in-memory book of an unavailable adopted one (D166 point 8).
  const scheduler = createScheduler(deps, { intervalMs: opts.tickMs ?? resolveTickMs() });
  if (unavailable === null) scheduler.start();

  // The link the person opens the Studio through: a ONE-TIME ticket, never the key (D166). The key
  // itself stays in the owner-only file; no link, log line or HTTP response carries it.
  const studioKey = studioKeys.current();
  const studioUrl = local ? studioTicketLink(url, studioDevices.mintTicket()) : url;

  let closed = false;
  const handle: UpHandle = {
    server,
    store,
    scheduler,
    url,
    studioUrl,
    studioServed,
    studioKey,
    studioKeys,
    studioDevices,
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

  if (studioServed) {
    log(
      opts.announceStudioLink !== true
        ? `till up: the Studio is at ${url} (its key is kept owner-only in ${studioKeyPath(supportDir)})`
        : `till up: open the Studio through ${studioUrl}`,
    );
  }
  if (opts.open !== false) openUrl(studioUrl);

  return { started: true, ...handle };
}
