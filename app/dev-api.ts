/**
 * The Vite dev bridge (Node-only glue, NOT part of the browser bundle).
 *
 * It mounts TWO faces of the same engine, because the Studio moved onto MCP (D12) and the REST twins
 * did not go away:
 *
 * - `POST|GET|DELETE /mcp` is the MCP server over `StreamableHTTPServerTransport`. This is what the
 *   Studio speaks now: the browser is an MCP client in the literal sense, and the audit actor for
 *   the session is declared once at `initialize` (D13).
 * - `POST /api/:action` is the older REST dispatcher (`handleRest`), kept so the `fetchTransport`
 *   seam still has something to talk to and the swap back is one line in `app/src/lib/client.ts`.
 *
 * SECURITY, and the reason this file has exactly ONE mount: both faces reach the same 60-action
 * registry, which includes `post_entry`, `issue_invoice` and `send_invoice`, over a loopback port
 * that any page in the user's browser can reach. This file used to mount the two faces separately,
 * and only `/mcp` was guarded: a website could POST `/api/post_entry` at the dev server and land an
 * immutable journal entry in the real ledger (Blocker-2, 2026-07-25). Routing and the localhost
 * guard now both live in `src/api/local-http.ts`, and this file hands the raw request to it. Do NOT
 * add a second mount, and do NOT import `api/rest.js` or `api/mcp-http.js` here: a face outside the
 * router is a face outside the guard, and `test/api/local-http-guard.test.mjs` fails if either
 * happens.
 *
 * The browser reaches the engine ONLY through this bridge, because better-sqlite3 is native and
 * cannot run in a browser bundle.
 *
 * ROOT BUILD FIRST: this imports the COMPILED engine from `../dist/**`. Run `npm install && npm run
 * build` at the repo ROOT before `npm run dev` here, or the dynamic import will fail. The imports are
 * dynamic and loosely typed on purpose, so this file never drags the engine into the app `tsc` build
 * and never breaks `vite build`.
 *
 * ONE DATABASE: the path comes from `TILL_DB_PATH`, defaulting to `~/.till/till.db`, resolved by the
 * engine's own `resolveDbPath`. It used to be hardcoded to `app/.dev-data/till.db` while `till mcp`
 * defaulted to `:memory:`, so the Studio and the agent were not on one ledger at all.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = (rel: string) => resolve(here, '..', 'dist', rel);

// Loose engine surface: the compiled JS has no types visible to the app tsconfig, and we do not want
// it to. This mirrors src/api/local-http.ts just enough to call it.
type LocalHttpRouter = {
  handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<boolean>;
  closeAll: () => Promise<void>;
};

let ready: Promise<{ router: LocalHttpRouter }> | null = null;

/** Load the compiled engine, open the one database, and assemble the router over both faces, once. */
function boot() {
  if (ready === null) {
    ready = (async () => {
      const { SqliteStore } = (await import(DIST('core/store/sqlite-store.js'))) as {
        SqliteStore: new (opts: { location: string }) => unknown;
      };
      const { systemClock } = (await import(DIST('core/clock.js'))) as { systemClock: unknown };
      const { systemIdGen } = (await import(DIST('core/ids.js'))) as { systemIdGen: unknown };
      const { ensureDbPath } = (await import(DIST('api/db-path.js'))) as {
        ensureDbPath: () => string;
      };
      const { createLocalHttpRouter } = (await import(DIST('api/local-http.js'))) as {
        createLocalHttpRouter: (deps: unknown, opts?: { rest?: boolean; servedMode?: unknown }) => LocalHttpRouter;
      };
      // M01 DEV OPT-IN. `resolveServedMode` reads TILL_SERVED_MODE (throws on a bad value, fail closed).
      const { resolveServedMode, SERVED_MODE_ENV } = (await import(DIST('api/served-mode.js'))) as {
        resolveServedMode: (env?: NodeJS.ProcessEnv) => unknown;
        SERVED_MODE_ENV: string;
      };
      // G08 §4. `guarded()` records through `deps.diagnostics`, and the core ships a no-op, so a host
      // that does not build one records nothing however loudly the engine fails. The port reads the
      // user's `capture` preference on every call and writes nothing while it is off, so this is not
      // a default change: without it the opt-in switch governs a file nothing ever writes.
      const { makeDiagnosticsPort } = (await import(DIST('api/support-actions.js'))) as {
        makeDiagnosticsPort: (supportDir?: string) => unknown;
      };

      const dbPath = ensureDbPath();
      const store = new SqliteStore({ location: dbPath }) as { close: () => void };
      // The REST face keeps its own actor, and that actor is DEV-BRIDGE-ONLY (D25): the
      // `/api/:action` twin exists as the rollback path until StreamableHTTP has survived one full
      // wave, and its server-side 'studio' stamp is the weaker actor story. Nothing production-facing
      // may inherit it. On the MCP face the actor is decided per session at `initialize` (D13) by the
      // seating rule in `src/api/session.ts`: a `till-studio` client is the Studio, ANY other client
      // is the governed `agent` seat. This value is NOT the MCP fallback (it was until F-08, which is
      // how an unrecognised client here was seated as the Studio and bypassed the dial).
      const deps = {
        store,
        clock: systemClock,
        ids: systemIdGen,
        actor: 'studio',
        diagnostics: makeDiagnosticsPort(),
      };
      // Closing the store checkpoints the write-ahead log. Without it, every `npm run dev` session
      // ends with its writes still sitting in `till.db-wal`, which is why that sidecar grew to 2 MB
      // against a 4 KB database.
      let closed = false;
      const closeStore = () => {
        if (closed) return;
        closed = true;
        store.close();
      };
      process.once('SIGINT', closeStore);
      process.once('SIGTERM', closeStore);
      process.once('exit', closeStore);

      // M01 DEV OPT-IN, DEFAULT OFF. Normal `npm run dev` runs in LOCAL mode: the subject header is
      // inert and the identity chip / resolver pages cannot be reached, so served mode is never
      // consulted here. To exercise M01 in a browser, run the dev server with `TILL_DEV_SERVED_MODE=proxy`
      // (its value is read as TILL_SERVED_MODE; TILL_SUBJECT_HEADER still names the subject header, and
      // a browser tool that sets that header then attests a subject). Leaving it unset keeps dev
      // unchanged, and it never reads an ambient TILL_SERVED_MODE, so an env set for `till serve` in the
      // same shell does not silently flip the dev bridge into served mode.
      const devServed = process.env.TILL_DEV_SERVED_MODE?.trim();
      const servedMode =
        devServed === undefined || devServed === ''
          ? undefined
          : resolveServedMode({ ...process.env, [SERVED_MODE_ENV]: devServed });

      // eslint-disable-next-line no-console
      console.log(`[till] ledger at ${dbPath}, MCP on /mcp${servedMode !== undefined ? ' (served mode: opt-in)' : ''}`);
      // `rest: true` mounts the REST twins BEHIND the same localhost guard as /mcp. This is the only
      // host that opts into them: `till serve` runs the MCP face alone.
      const routerOpts: { rest: boolean; servedMode?: unknown } = { rest: true };
      if (servedMode !== undefined) routerOpts.servedMode = servedMode;
      return { router: createLocalHttpRouter(deps, routerOpts) };
    })();
  }
  return ready;
}

/**
 * Which URLs belong to the engine, used ONLY to decide whether a FAILED boot is reported loudly or
 * ignored: without a root `dist/` build we still want Vite to serve the Studio shell, so the error
 * surfaces on the engine call instead of blanking the page. It never gates the guard, and it never
 * decides routing: both of those live in the router. A stale pattern here can therefore only make a
 * boot failure quieter, never make a face reachable unguarded.
 */
const ENGINE_PATH_RE = /^\/(mcp|api)(\/|$|\?)/;

/** The Vite plugin exposing the bridge under `configureServer`. */
export function devApiPlugin(): Plugin {
  return {
    name: 'till-dev-api',
    configureServer(server) {
      // THE mount. One middleware, one router, one guard, both faces. See the security note at the
      // top of this file before adding anything beside it.
      server.middlewares.use(async (req: Connect.IncomingMessage, res, next) => {
        let router: LocalHttpRouter;
        try {
          ({ router } = await boot());
        } catch (cause) {
          if (!ENGINE_PATH_RE.test(req.url ?? '')) return next();
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'bridge_error', detail: String(cause) }));
          return;
        }
        const handled = await router.handle(req as IncomingMessage, res as ServerResponse);
        if (!handled) next();
      });
    },
  };
}
