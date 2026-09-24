/**
 * `till serve` (D23 / G1): the production `/mcp` StreamableHTTP host.
 *
 * This is the same MCP server the Studio speaks (D12), mounted on a standalone Node HTTP listener so a
 * demo (the A11 invoice slice) runs against a real ledger WITHOUT Vite in front of it. It reuses
 * `createMcpHttpHandler` verbatim: one registry, one engine, reached over `StreamableHTTPServerTransport`
 * exactly as the browser reaches it. There is no second code path and no bespoke REST bridge here.
 *
 * The listener owns nothing the handler owns: it parses the JSON body for a POST, routes `/mcp` to the
 * handler, and 404s everything else. The store is opened here and returned so the caller checkpoints
 * the WAL on shutdown.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

import { makeApiDeps } from './mcp.js';
import { resolveEbicsRuntime } from './host-runtime.js';
import { createLocalHttpRouter, pathnameOf, MCP_PATH } from './local-http.js';
import { setDeliveryRuntime, resetDeliveryRuntime } from './runtime-state.js';
import { resolveServedMode, type ServedModeConfig } from './served-mode.js';
import type { SqliteStore } from '../core/store/sqlite-store.js';

// Re-exported so `till serve` and the Studio keep agreeing on the mount path through one import.
export { MCP_PATH };

/**
 * The opt-in that allows a non-loopback bind. Named for what it actually does, not for the knob it
 * turns, so nobody sets it while thinking they are choosing an interface. Only the exact value `1`
 * enables it, so `=0` and `=false` read as off rather than as "set, therefore truthy".
 */
export const EXPOSE_ENV = 'TILL_EXPOSE_LEDGER_UNAUTHENTICATED';

/**
 * What every non-loopback bind costs, in one place, because the refusal and the warning must not
 * drift apart. `local-guard.ts` is honest that it is a rebinding defence: this is that same fact
 * restated where the user is about to act on it.
 */
const NOT_AUTHENTICATION = [
  'The /mcp host validates the Host and Origin headers. That is a DNS-rebinding defence against a',
  'page in your own browser, NOT authentication: no caller proves who it is. Any peer that can reach',
  'this port writes its own Host header and drives the entire action registry against the real',
  'ledger, including post_entry, issue_invoice and send_invoice.',
];

const LOOPBACK_SPELLINGS = '127.0.0.1 (all of 127.0.0.0/8), ::1, localhost, and any *.localhost name';

/** The port `till serve` binds when `TILL_PORT` says nothing. */
export const DEFAULT_PORT = 8788;

/** The highest TCP port. Node's own `listen` accepts 0 to 65535 and rejects the rest. */
export const MAX_PORT = 65535;

export interface ServeOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  /**
   * Permit a non-loopback bind. Defaults to `process.env[EXPOSE_ENV] === '1'`, so the CLI and a
   * programmatic embedder obey one rule. Passing it explicitly is what the tests use.
   */
  allowNonLoopback?: boolean;
  /** Where the exposure warning goes. Defaults to stderr, which is where `till serve` already talks. */
  log?: (line: string) => void;
  /**
   * M01: the served-mode config. Defaults to `resolveServedMode()` (from the environment), which THROWS
   * on a misconfiguration before anything binds (fail closed). Passed explicitly by tests.
   */
  servedMode?: ServedModeConfig;
}

/** Strip the brackets of an IPv6 literal and normalise case and padding. */
function normalizeBindHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * True when a bind address reaches only this machine.
 *
 * This is a BIND-ADDRESS policy and is deliberately not the same question `local-guard.ts` answers.
 * The guard classifies a hostname a peer wrote into a request header; this classifies an address the
 * operator handed to `listen()`, which is an IP literal far more often than a name. Neither one
 * substitutes for the other, and the guard is untouched.
 *
 * Loopback, by the specs:
 *   - the whole of 127.0.0.0/8 (RFC 1122 section 3.2.1.3 reserves `{127, <any>}` as the internal
 *     host loopback address, so 127.0.0.53 is as local as 127.0.0.1)
 *   - `::1` (RFC 4291 section 2.5.3)
 *   - `::ffff:127.0.0.1` in its dotted spelling (RFC 4291 section 2.5.5.2, IPv4-mapped)
 *   - `localhost` and any `*.localhost` name (RFC 6761 section 6.3, which is why these cannot be
 *     rebound by a hostile resolver)
 *
 * Everything else is refused, INCLUDING anything unparseable, an unknown name, and the empty string
 * (Node treats an absent or empty host as "every interface", which is the exact case at issue). The
 * classifier fails closed: a spelling it cannot prove is loopback, such as the hex form
 * `::ffff:7f00:1` or the shorthand `127.1`, is refused rather than guessed at, and the refusal tells
 * the operator which spellings work.
 */
export function isLoopbackBindHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const bare = normalizeBindHost(host);
  if (bare === '') return false;
  const address = bare.split('%')[0] ?? ''; // drop an IPv6 zone id, e.g. `fe80::1%en0`
  switch (isIP(address)) {
    case 4:
      return address.startsWith('127.');
    case 6: {
      if (address === '::1') return true;
      const mapped = '::ffff:';
      return address.startsWith(mapped) && isLoopbackBindHost(address.slice(mapped.length));
    }
    default:
      return address === 'localhost' || address.endsWith('.localhost');
  }
}

/**
 * The host as it must appear in a URL authority: an IPv6 literal gets brackets (RFC 3986 section
 * 3.2.2), everything else is echoed verbatim. Exported so `till up` builds the same URL string
 * `till serve` does, from one rule.
 */
export function normalizeBindHostForUrl(host: string): string {
  const bare = normalizeBindHost(host);
  return isIP(bare) === 6 ? `[${bare}]` : host;
}

/** The refusal text for a non-loopback bind that was not opted into. Thrown, never swallowed. */
export function nonLoopbackRefusal(host: string, port: number): string {
  return [
    `till serve: refusing to bind ${host}:${port}, which is not a loopback address.`,
    '',
    ...NOT_AUTHENTICATION,
    '',
    `Loopback spellings that are accepted: ${LOOPBACK_SPELLINGS}.`,
    '',
    'If you are in a container or a VM and you MEAN to expose the ledger to everything that can',
    `reach this port, set ${EXPOSE_ENV}=1 and put`,
    'your own authentication in front of it: an SSH tunnel, or a reverse proxy that authenticates.',
  ].join('\n');
}

/** The banner printed BEFORE the listener binds when the opt-in is set. Loud on purpose. */
export function nonLoopbackWarning(host: string, port: number): string[] {
  return [
    '!! till serve: EXPOSING THE LEDGER.',
    `!! Binding ${host}:${port}, which is not a loopback address.`,
    ...NOT_AUTHENTICATION.map((line) => `!! ${line}`),
    `!! There is no password and no token. ${EXPOSE_ENV}=1 is set, so TILL is proceeding.`,
  ];
}

/**
 * True when a number is a port `listen` will take: a whole number from 0 to 65535.
 *
 * The BIND-TIME rule, which is why 0 is in it. `port: 0` is a real request an embedder makes on
 * purpose ("give me any free port"), and the test suite depends on it. The rule for a human typing
 * TILL_PORT is stricter, and lives in `resolvePortEnv` below.
 */
export function isBindablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= MAX_PORT;
}

/** The refusal for a port an embedder computed wrong, thrown before anything is opened. */
export function invalidPortRefusal(port: number): string {
  return [
    `till serve: refusing to bind port ${String(port)}, which is not a usable TCP port.`,
    '',
    `A port is a whole number from 0 to ${MAX_PORT}, where 0 asks the operating system for any free`,
    'port. Node would otherwise reject this inside listen(), naming an `options.port` the caller',
    'never wrote.',
  ].join('\n');
}

/**
 * Turn a raw `TILL_PORT` into a port, or throw the refusal.
 *
 * The parsing is deliberately stricter than `Number()`, which is what the old one-liner used and
 * which reinterprets rather than refuses. Measured on the code this replaces: `TILL_PORT=0x1f` bound
 * port 31, a port nobody typed, and `8.788e3`, `+8788`, `08788` and `8788.0` all silently became
 * 8788. So the rule is decimal digits only, and anything else is refused with the value quoted back.
 *
 * TWO DECISIONS worth naming, because neither is forced:
 *
 * 1. BLANK IS UNSET. An empty or whitespace-only `TILL_PORT` falls back to the default rather than
 *    failing, matching `resolveDbPath`, which already rules that a blank environment variable is a
 *    misconfiguration and not a request. `docker run -e TILL_PORT` hands over an empty string for a
 *    variable the operator never set, and breaking that would buy nothing. This is still a fix: a
 *    whitespace-only value used to reach `Number('   ') === 0` and bind a RANDOM ephemeral port.
 *
 * 2. `TILL_PORT=0` IS REFUSED, though `startHttpServer({ port: 0 })` is not. In code, 0 is an
 *    explicit request for an ephemeral port and the caller reads back `handle.url`. In an
 *    environment variable it is almost always a typo or an unfilled template, and honouring it moves
 *    the server to a different address on every restart, so nothing can be configured to reach it.
 *    An API and a human typing into a shell are not the same caller, and the refusal says how to ask
 *    for an ephemeral port properly.
 *
 * ACCEPTED DELIBERATELY: the privileged range 1 to 1023. Binding one without privileges fails with
 * EACCES naming the port the operator actually chose, which is already a good error, and refusing it
 * outright would be TILL inventing a policy the operating system enforces better.
 */
export function resolvePortEnv(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_PORT;

  if (!/^\d+$/.test(value)) {
    throw new Error(
      [
        `till serve: refusing to start, TILL_PORT is not a port number: ${JSON.stringify(raw)}`,
        '',
        `TILL_PORT must be decimal digits only, 1 to ${MAX_PORT}. Spellings like 0x1f, 8.788e3,`,
        '8788.5, +8788 and 8788abc are refused rather than reinterpreted: 0x1f used to bind port 31.',
        '',
        `Leave TILL_PORT unset for the default ${DEFAULT_PORT}.`,
      ].join('\n'),
    );
  }

  const port = Number(value);
  if (port === 0) {
    throw new Error(
      [
        'till serve: refusing to start, TILL_PORT is 0.',
        '',
        'Port 0 asks the operating system for any free port, so the address changes on every restart',
        'and nothing can be configured to reach it. If that is really what you want, ask for it in',
        'code: startHttpServer({ port: 0 }).',
        '',
        `Otherwise pick a port from 1 to ${MAX_PORT}, or leave TILL_PORT unset for the default ${DEFAULT_PORT}.`,
      ].join('\n'),
    );
  }
  if (port > MAX_PORT) {
    throw new Error(
      [
        `till serve: refusing to start, TILL_PORT is out of range: ${value}`,
        '',
        `A TCP port is a 16 bit number, so the highest one is ${MAX_PORT}.`,
        '',
        `Leave TILL_PORT unset for the default ${DEFAULT_PORT}.`,
      ].join('\n'),
    );
  }
  return port;
}

export interface ServeHandle {
  server: Server;
  store: SqliteStore;
  /** The bound origin, e.g. `http://127.0.0.1:8788`, once listening. */
  url: string;
  /** Close the listener AND the store (checkpoints the WAL). */
  close(): Promise<void>;
}

/**
 * Start the `/mcp` HTTP host. Resolves once the listener is bound (so a caller, and the smoke test,
 * can connect immediately). `port: 0` binds an ephemeral port, which the returned `url` reports.
 *
 * The transport reads and parses the request body itself from the raw request (the same mount the
 * Studio uses), so this listener only routes on the path and hands `/mcp` straight through.
 */
export async function startHttpServer(opts: ServeOptions = {}): Promise<ServeHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;
  const log = opts.log ?? ((line: string) => console.error(line));

  // M01: resolve served mode FIRST of all. `resolveServedMode` throws the refusal on a misconfiguration
  // (an unrecognised `TILL_SERVED_MODE`, a blank header name), which fails the start closed before the
  // store is opened or anything binds. Served mode does NOT relax the loopback rule below: a served
  // deployment still binds toward its proxy over loopback (or opts into exposure explicitly).
  const servedMode = opts.servedMode ?? resolveServedMode();

  // BOTH checks run FIRST, before the store is opened and long before anything listens. A refusal
  // that arrives after the socket is bound is not a refusal. `till serve` therefore cannot expose a
  // ledger it then apologises for, and a refused run leaves no database file behind either.
  //
  // The port is checked before the host so a bad port is never reported as `0.0.0.0:NaN`.
  if (!isBindablePort(port)) throw new Error(invalidPortRefusal(port));
  if (!isLoopbackBindHost(host)) {
    const allowed = opts.allowNonLoopback ?? process.env[EXPOSE_ENV] === '1';
    if (!allowed) throw new Error(nonLoopbackRefusal(host, port));
    for (const line of nonLoopbackWarning(host, port)) log(line);
  }

  // D108: attach the private live bank wire when configured; otherwise EBICS steps degrade honestly.
  const { deps, store } = makeApiDeps(opts.dbPath, await resolveEbicsRuntime());
  // The MCP face ONLY: the REST twins carry the dev-bridge REST actor (D25) and are not mounted on
  // the production host. The MCP seat is the `session.ts` rule (an unrecognised client is `agent`),
  // the same rule `till up` and the dev bridge consume, so no host seats a client differently. An `/api/...` request here therefore matches no face and 404s, which is
  // the pre-existing behaviour and is asserted by the Host/Origin matrix.
  //
  // M01: `servedMode` reaches the router (and through it the MCP face), so a served `till serve` behind
  // a reverse proxy requires and resolves the subject on every /mcp request.
  const router = createLocalHttpRouter(deps, { servedMode });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void router
      .handle(req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found', path: pathnameOf(req) }));
      })
      .catch((e) => {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad_request', message: e instanceof Error ? e.message : String(e) }));
      });
  });

  // A failed `listen` used to emit an unhandled `error` event: the promise never settled, so the
  // process died on an uncaught exception with a raw stack and a leaked store handle. The commonest
  // case by far is EADDRINUSE on the default port, which is the operator's problem to solve and
  // deserves a sentence, not a stack.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (e) {
    await router.closeAll();
    store.close();
    const detail = e instanceof Error ? e.message : String(e);
    const busy = (e as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
    throw new Error(
      [
        `till serve: cannot bind ${host}:${port}. ${detail}`,
        ...(busy ? ['', 'Another process already owns that port. Pick a different one with TILL_PORT.'] : []),
      ].join('\n'),
    );
  }
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  // An IPv6 literal needs brackets in a URL (RFC 3986 section 3.2.2), or `http://::1:8788` parses as
  // nothing a client can dial. The host is echoed verbatim otherwise.
  const authority = isIP(normalizeBindHost(host)) === 6 ? `[${normalizeBindHost(host)}]` : host;
  const url = `http://${authority}:${boundPort}`;

  // M00: report `mode:'serve'` to `delivery_status` while this headless host runs. `till serve` is
  // the MCP-only subset (no Studio, no scheduler), so `studio_served` is false and the scheduler line
  // stays off. Reset on close so a later in-process `till up` or a bare read is not misreported.
  setDeliveryRuntime({ mode: 'serve', host, port: boundPort, studioServed: false });

  return {
    server,
    store,
    url,
    async close() {
      await router.closeAll();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      // Force-close lingering keep-alive / SSE sockets so `server.close()` resolves promptly instead
      // of blocking on an idle StreamableHTTP client. Without this a served host hangs on shutdown:
      // Ctrl-C waits forever, and the node test runner's per-file child never exits, wedging the whole
      // gate (a served test's teardown could not close in bounded time). `closeAllConnections` is the
      // node:http mechanism for exactly this.
      server.closeAllConnections();
      await closed;
      store.close();
      resetDeliveryRuntime();
    },
  };
}
