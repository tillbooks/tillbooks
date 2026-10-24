/**
 * The MCP server over StreamableHTTP: the transport the Studio speaks (D12).
 *
 * The browser cannot speak stdio, so the second adapter face is not a bespoke REST bridge but the
 * SAME MCP server reached over `StreamableHTTPServerTransport`. The Studio is therefore an MCP
 * client in the literal sense, not the semantic one, and the product claim ("the GUI and the agent
 * are two clients of one engine") is true at the wire. `till mcp` keeps stdio for agent subprocesses:
 * both faces build the identical `Server` from the identical registry.
 *
 * Sessions are STATEFUL: `initialize` mints a session id, and every later request carries it in the
 * `mcp-session-id` header. That is what makes D13 possible, because a session is the only place an
 * actor can be declared once and inherited. Each session owns its own `Server` and transport but
 * SHARES the one `SqliteStore`, so the Studio and an agent land on one database by construction.
 *
 * `enableJsonResponse` is on: a tool call is a short request/response, and holding an SSE stream
 * open per browser tab buys nothing here and costs a long-lived connection.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { buildMcpServer } from './mcp.js';
import { rejectNonLocal } from './local-guard.js';
import {
  checkStudioKey,
  resolveServedActor,
  resolveSessionActor,
  STUDIO_CLIENT_NAME,
  type HostStudioKey,
  type ServedIdentity,
  type StudioKeyCheck,
} from './session.js';
import { extractSubject, type ServedModeConfig } from './served-mode.js';
import type { ApiDeps } from './registry.js';

// Re-exported so a caller mounting the HTTP face has the session vocabulary (D13) in one import.
export { resolveSessionActor, STUDIO_CLIENT_NAME, AGENT_CLIENT_NAME, STUDIO_KEY_HEADER } from './session.js';

/** A mounted MCP HTTP endpoint: one handler, N live sessions. */
export interface McpHttpHandler {
  /** Handle one request (POST a message, GET the stream, DELETE the session). */
  handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  /** How many sessions are currently live (used by tests and diagnostics). */
  sessionCount(): number;
  /** Close every live session. The shared store is NOT closed: the caller owns it. */
  closeAll(): Promise<void>;
}

/** Options for the MCP-over-HTTP handler. */
export interface McpHttpOptions {
  /**
   * M01: the served-mode trust boundary. When `enabled`, every request must carry the proxy-attested
   * subject (`missing_subject` otherwise), the resolved identity (D105) is pinned for the session, and
   * a later request whose subject differs is refused (`subject_changed`). Absent means local mode: the
   * header is never read and D13 resolution applies, byte-for-byte as before.
   */
  servedMode?: ServedModeConfig;
  /**
   * The Studio key of the host that serves the Studio (`till up`, the dev bridge), read on every
   * request so a rotation (D166) bites at once, on open sessions too. A session
   * opened with it is the human `studio` seat; a session opened without it is the governed `agent`
   * seat, whatever client name it declares; a session opened with any OTHER key is refused. Absent
   * (`till serve`, which serves no Studio) means no request can hold the Studio seat on this host.
   */
  studioKey?: HostStudioKey;
}

/** One live MCP session: its transport plus, in served mode, the subject it was opened for. */
interface McpSession {
  transport: StreamableHTTPServerTransport;
  /** M01: the proxy-attested subject this session was opened for; undefined in local mode. */
  subject?: string;
  /** True when the session was opened with the Studio key, so every later request must carry it too. */
  studio?: boolean;
}

/** The refusal for a request that presented a Studio key this host did not mint (or not any more). */
const STUDIO_KEY_INVALID = {
  ok: false,
  error: 'studio_key_invalid',
  message:
    'This request carries a Studio key this TILL does not hold (it was never issued here, or it was rotated). The Studio reopens itself with the current key.',
} as const;

/** The refusal for a local session that declares the Studio's name but carries no key. */
const STUDIO_KEY_REQUIRED = {
  ok: false,
  error: 'studio_key_required',
  message:
    'The Studio needs the Studio key, which reaches it out of band (TILL.app, the opened link, or a reopen). An agent connects under its own name.',
} as const;

/** The most an `initialize` body may be before it is refused unread (it is a few hundred bytes). */
const MAX_INIT_BODY_BYTES = 1024 * 1024;

/** Read and parse a JSON request body, bounded. */
function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      total += c.length;
      if (total > MAX_INIT_BODY_BYTES) {
        over = true;
        resolvePromise({ ok: false, status: 413, message: 'Request body too large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolvePromise({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      } catch {
        resolvePromise({ ok: false, status: 400, message: 'Parse error' });
      }
    });
    req.on('error', () => resolvePromise({ ok: false, status: 400, message: 'Request aborted' }));
  });
}

/** Does this JSON-RPC body (one message or a batch) `initialize` under the Studio's client name? */
function declaresStudioName(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    const msg = m as { method?: unknown; params?: { clientInfo?: { name?: unknown } } } | null;
    return msg !== null && typeof msg === 'object' && msg.method === 'initialize' && msg.params?.clientInfo?.name === STUDIO_CLIENT_NAME;
  });
}

/**
 * Build an MCP-over-HTTP handler over the shared registry. `deps.actor` is NOT consulted for the
 * seat, and neither is the client's declared name: every local MCP session is seated by the rule in
 * `session.ts` (the per-launch Studio key seats `studio`, anything else is `agent`), on this host and
 * on every other one. The seat is PINNED at session open (`buildMcpServer`'s `pinnedActor`), so the
 * name a client declares at `initialize` is never consulted for it.
 */
export function createMcpHttpHandler(deps: ApiDeps, opts: McpHttpOptions = {}): McpHttpHandler {
  const sessions = new Map<string, McpSession>();
  const servedMode = opts.servedMode;
  const studioKey = opts.studioKey;

  async function openSession(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
    served: ServedIdentity | undefined,
    key: StudioKeyCheck,
  ): Promise<void> {
    const session: McpSession = { transport: undefined as unknown as StreamableHTTPServerTransport };
    if (served !== undefined) session.subject = served.subject;
    if (key === 'valid') session.studio = true;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    session.transport = transport;
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
    };
    // One Server per session, so the session's actor (D13, or the M01 served identity) is bound for the
    // life of that session. The cast is a tsconfig artefact, not a doubt about the transport: this repo
    // runs `exactOptionalPropertyTypes`, and the SDK declares `onclose` through a getter/setter pair
    // whose getter can return undefined, which that flag reads as incompatible with the `Transport` port.
    //
    // THE SEAT IS PINNED HERE, from the Studio key the request carried, and never left to the name the
    // client declares at `initialize` (critic probe P6). A served identity still wins over the pin
    // inside `buildMcpServer`, exactly as before.
    const pinnedActor = resolveSessionActor(undefined, key);
    await buildMcpServer(deps, served !== undefined ? { servedIdentity: served, pinnedActor } : { pinnedActor }).connect(
      transport as unknown as Transport,
    );
    await transport.handleRequest(req, res, parsedBody);
  }

  /**
   * M01: the served identity for this request, or a refusal already written to `res`, or null (local).
   * `missing_subject` refuses a served request with no header BEFORE any session opens or any tool is
   * listed (spec §8). This runs inside `createMcpHttpHandler` rather than only in the router because
   * the handler is exported and must be safe mounted alone, exactly as `rejectNonLocal` is.
   */
  function servedIdentityFor(req: IncomingMessage, res: ServerResponse): ServedIdentity | 'refused' | null {
    if (servedMode === undefined || !servedMode.enabled) return null;
    const subject = extractSubject(req.headers, servedMode);
    if (subject === null) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: 'missing_subject',
          message: 'Served mode is on: every /mcp request must carry the proxy-attested subject header.',
        }),
      );
      return 'refused';
    }
    return resolveServedActor(deps.store, subject);
  }

  return {
    async handleRequest(req, res, parsedBody) {
      // M-4: the localhost guard runs FIRST, on every request. A rebound page must never reach the
      // transport (and through it post_entry / send_invoice) at all.
      //
      // `local-http.ts` already applies the SAME shared function in front of every face, so for a
      // routed request this is a second evaluation of one implementation, not a second copy of the
      // rule. It stays because `createMcpHttpHandler` is exported: a host that mounts this handler
      // on its own must not be able to end up unguarded, which is exactly the mistake Blocker-2 was.
      const rejection = rejectNonLocal(req);
      if (rejection !== null) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: rejection.error, message: rejection.detail }));
        return;
      }

      // M01: resolve (and require) the served subject before any session work, so `missing_subject`
      // is answered on /mcp before a tool is ever listed.
      const served = servedIdentityFor(req, res);
      if (served === 'refused') return;

      // The Studio key, checked on EVERY request in constant time (`session.ts`). A key this host did
      // not mint is refused outright rather than demoted: it is either a Studio tab left over from an
      // earlier start (which must re-open the printed link, not silently become an agent) or a guess.
      const key = checkStudioKey(req.headers, studioKey);
      if (key === 'invalid') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(STUDIO_KEY_INVALID));
        return;
      }

      const header = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (existing !== undefined) {
        // A Studio session stays bound to the key: a request on it WITHOUT the key is not the Studio,
        // however it learned the session id, and is refused rather than served under the human seat.
        if (existing.studio === true && key !== 'valid') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: 'studio_key_required',
              message: 'This MCP session belongs to the Studio: every request on it must carry the Studio key.',
            }),
          );
          return;
        }
        // M01: a session belongs to ONE authenticated subject. The proxy strips and resets the subject
        // on every request, so a request on this session carrying a DIFFERENT subject is a reused
        // session id, never a legitimate identity switch: refuse rather than serve it under the pinned
        // actor. (In local mode `served` is null and `existing.subject` is undefined, so this is inert.)
        if (served !== null && existing.subject !== undefined && served.subject !== existing.subject) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: 'subject_changed',
              message: 'This MCP session was opened for a different subject. Start a new session.',
            }),
          );
          return;
        }
        await existing.transport.handleRequest(req, res, parsedBody);
        return;
      }
      // No session yet (or an id we do not know): this must be an `initialize`. The transport itself
      // rejects anything else with the protocol's own 400/404, so no hand-rolled check is needed.
      //
      // A LOCAL session opened WITHOUT the key that declares the Studio's own name is REFUSED rather
      // than seated as the agent (critic R3-B2). The name never grants the Studio seat; here it can
      // only lose one: a Studio tab that has no key (opened without the printed link, or holding the
      // key of an earlier start) is told so (`studio_key_required`) and shows the person how to get
      // back in, instead of quietly running the person's clicks through the agent dial. In served mode
      // the proxy-attested subject is the identity and the key plays no part, so this does not apply.
      let body = parsedBody;
      if (key === 'absent' && served === null && req.method === 'POST') {
        if (body === undefined) {
          const read = await readJsonBody(req);
          if (!read.ok) {
            res.writeHead(read.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: read.message }, id: null }));
            return;
          }
          body = read.value;
        }
        if (declaresStudioName(body)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify(STUDIO_KEY_REQUIRED));
          return;
        }
      }
      await openSession(req, res, body, served ?? undefined, key);
    },

    sessionCount: () => sessions.size,

    async closeAll() {
      const live = [...sessions.values()];
      sessions.clear();
      await Promise.all(live.map((s) => s.transport.close()));
    },
  };
}
