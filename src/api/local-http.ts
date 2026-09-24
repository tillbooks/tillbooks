/**
 * The local HTTP router: the ONE door from HTTP into the action registry.
 *
 * The engine has two HTTP faces, and both resolve the SAME 60-action registry (`registry.ts`):
 *
 *  - `/mcp`, the MCP server over `StreamableHTTPServerTransport` (D12), what the Studio speaks.
 *  - `POST /api/:action`, the older REST dispatcher (`handleRest`), kept as the rollback seam for
 *    `fetchTransport`. It is DEV-BRIDGE ONLY and is off unless a host opts in (`{ rest: true }`).
 *
 * They used to be mounted separately by each host, and that is how Blocker-2 happened: the M-4
 * remediation guarded `/mcp` and left `/api/:action` wide open, so any website in the user's browser
 * could POST `post_entry` at the Studio dev server and land an immutable journal entry in the real
 * ledger. The fix is structural rather than another copy of the check: faces are declared in ONE
 * table here, dispatch walks that table, and the localhost guard runs before the table is consulted
 * for a match. A face added to the table inherits the guard; a face NOT in the table is not reachable
 * at all. `faces` is exported off the router so the guard test probes exactly what dispatch serves,
 * which means a new face cannot be added without the test covering it.
 *
 * Routing decides FIRST, the guard decides SECOND. That order is deliberate and load-bearing for
 * `till serve`, which mounts the MCP face alone: a request for `/api/post_entry` there must 404
 * (that face does not exist on this host) rather than 403 (it exists and you may not have it).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { rejectNonLocal } from './local-guard.js';
import { createMcpHttpHandler } from './mcp-http.js';
import { handleRest } from './rest.js';
import { resolveServedActor } from './session.js';
import { extractSubject, type ServedModeConfig } from './served-mode.js';
import type { ApiDeps } from './registry.js';

/** The mount path for the MCP endpoint. Kept in one place so every host agrees. */
export const MCP_PATH = '/mcp';
/** The mount prefix for the REST twins. */
export const REST_PREFIX = '/api/';

/** One HTTP face of the engine. Every face in the router's table reaches the shared registry. */
export interface LocalFace {
  /** Diagnostic name, and what the guard test reports when a face is unprotected. */
  name: string;
  /** A concrete path this face serves, so a test can probe every declared face generically. */
  probePath: string;
  /** Does this face serve that path? */
  matches(pathname: string): boolean;
  /** Serve it. The guard has already passed by the time this runs. */
  serve(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<boolean>;
}

/**
 * The hard cap on a single REST request body (G18 US-G18.4, the named prerequisite before the E00
 * chunk lane ships). An unbounded body reader in front of a 500 MB migration workflow is an
 * invitation to discover the limit in production, so `readBody` refuses a body over this cap with a
 * structured 413-shaped Result rather than buffering it. Sized to admit ONE chunk-lane payload: a
 * chunk carries at most `MAX_FILE_BYTES` of binary, ~1.34x as base64, inside a small JSON envelope.
 */
export const MAX_BODY_BYTES = 48 * 1024 * 1024;

/** A body over the cap. Carried out of `readBody` so the REST face can answer 413, never 500. */
class BodyTooLargeError extends Error {
  constructor(readonly bytes: number, readonly max: number) {
    super('request_body_too_large');
  }
}

export interface LocalHttpOptions {
  /**
   * Mount the REST twins alongside `/mcp`. The Studio dev bridge sets this; `till serve` does not,
   * because the REST face carries the dev-only fallback actor (D25) and has no business on the
   * production host.
   */
  rest?: boolean;
  /** Override the REST body cap (`MAX_BODY_BYTES`). For tests; production uses the default. */
  maxBodyBytes?: number;
  /**
   * M01: the served-mode trust boundary (see `served-mode.ts`). When `enabled`, BOTH faces require the
   * proxy-attested subject header on every request (`missing_subject` otherwise) and resolve identity
   * from it (D105). Absent or disabled means local mode: the header is never read, D13 resolution
   * applies, and this is byte-for-byte the pre-M01 behaviour.
   */
  servedMode?: ServedModeConfig;
}

export interface LocalHttpRouter {
  /** The faces this router serves, in dispatch order. */
  faces: readonly LocalFace[];
  /**
   * Serve one request. Resolves `true` when this router answered it (including a 403 refusal), and
   * `false` when no face matched, which is the host's cue to 404 or fall through to its own stack.
   */
  handle(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<boolean>;
  /** How many MCP sessions are live (diagnostics and tests). */
  sessionCount(): number;
  /** Close every live MCP session. The shared store is NOT closed: the caller owns it. */
  closeAll(): Promise<void>;
}

/** The request path, independent of the Host header (which an attacker controls and we do not trust). */
export function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/**
 * Read a full request body as a UTF-8 string, BOUNDED by `cap` (G18 US-G18.4). The running total is
 * checked as chunks arrive, so a hostile or runaway body is refused (and the socket destroyed) the
 * moment it crosses the cap, never after it is fully buffered.
 */
function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return; // already over the cap: drain and discard so the socket does not stall.
      total += c.length;
      if (total > cap) {
        // Reject the moment the cap is crossed, but keep draining rather than destroying the socket,
        // so the REST face can flush its 413 response to the client instead of aborting the connection.
        over = true;
        reject(new BodyTooLargeError(total, cap));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Assemble the router over the shared registry. `deps.actor` is the session FALLBACK actor for the
 * MCP face, used when a client declares a name the registry does not recognise (D13).
 */
export function createLocalHttpRouter(deps: ApiDeps, opts: LocalHttpOptions = {}): LocalHttpRouter {
  const servedMode = opts.servedMode;
  // The MCP face owns its served handling end to end (it holds the sessions), so it gets the config
  // directly. This mirrors why `rejectNonLocal` is applied in both places: `createMcpHttpHandler` is
  // exported and must be safe when mounted on its own, never dependent on a wrapper remembering a rule.
  const mcp = createMcpHttpHandler(deps, servedMode !== undefined ? { servedMode } : {});
  const bodyCap = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  /**
   * M01: the REST face's per-request served identity, or a `missing_subject` refusal, or null when
   * local. Returns `{ deps }` to dispatch with, or `{ refused: true }` when the response was already
   * written (served mode with no subject). In local mode the shared `deps` pass straight through.
   */
  function resolveRestDeps(req: IncomingMessage, res: ServerResponse): { deps: ApiDeps } | { refused: true } {
    if (servedMode === undefined || !servedMode.enabled) return { deps };
    const subject = extractSubject(req.headers, servedMode);
    if (subject === null) {
      sendJson(res, 401, {
        ok: false,
        error: 'missing_subject',
        message: 'Served mode is on: every request must carry the proxy-attested subject header.',
      });
      return { refused: true };
    }
    const identity = resolveServedActor(deps.store, subject);
    return {
      deps: {
        ...deps,
        actor: identity.actor,
        subject: identity.subject,
        identitySource: identity.identitySource,
      },
    };
  }

  const mcpFace: LocalFace = {
    name: 'mcp',
    probePath: MCP_PATH,
    matches: (pathname) => pathname === MCP_PATH,
    async serve(req, res, parsedBody) {
      await mcp.handleRequest(req, res, parsedBody);
      return true;
    },
  };

  const restFace: LocalFace = {
    name: 'rest',
    probePath: `${REST_PREFIX}create_workspace`,
    matches: (pathname) => pathname.startsWith(REST_PREFIX),
    async serve(req, res) {
      // Anything but a POST, or a bare `/api/`, is not a REST call: report it unserved so the host
      // falls through to its own stack (in dev, that is Vite serving the SPA).
      const action = pathnameOf(req).slice(REST_PREFIX.length);
      if (req.method !== 'POST' || action === '') return false;
      let raw: string;
      try {
        raw = await readBody(req, bodyCap);
      } catch (e) {
        // A body over the cap is a bounded, structured refusal (413), never an unbounded buffer and
        // never the generic 500 the outer handler would otherwise report (G18 US-G18.4).
        if (e instanceof BodyTooLargeError) {
          sendJson(res, 413, { ok: false, error: 'request_body_too_large', max: e.max, bytes: e.bytes });
          return true;
        }
        throw e;
      }
      // M01: resolve the served identity for THIS request (or refuse missing_subject). Done after the
      // body cap and method checks so a malformed request is answered the same way in either mode, but
      // BEFORE dispatch, so no verb ever runs under the shared fallback actor in served mode.
      const restDeps = resolveRestDeps(req, res);
      if ('refused' in restDeps) return true;
      const input = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const result = handleRest(action, input, restDeps.deps);
      sendJson(res, result.status, result.body);
      return true;
    },
  };

  const faces: readonly LocalFace[] = opts.rest === true ? [mcpFace, restFace] : [mcpFace];

  return {
    faces,

    async handle(req, res, parsedBody) {
      const pathname = pathnameOf(req);
      const face = faces.find((f) => f.matches(pathname));
      if (face === undefined) return false;

      // THE guard, in front of every face, before a body is read or a verb is resolved. A rebound
      // page must never reach the registry (and through it post_entry / issue_invoice / send_invoice).
      const rejection = rejectNonLocal(req);
      if (rejection !== null) {
        sendJson(res, 403, { ok: false, error: rejection.error, message: rejection.detail });
        return true;
      }

      try {
        return await face.serve(req, res, parsedBody);
      } catch (cause) {
        // A bridge fault (bad JSON, a missing dist build) is reported as a readable Result, never as
        // a crash and never as a protocol error.
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'bridge_error', detail: String(cause) });
        } else {
          res.end();
        }
        return true;
      }
    },

    sessionCount: () => mcp.sessionCount(),
    closeAll: () => mcp.closeAll(),
  };
}
