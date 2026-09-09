/**
 * The Studio's MCP transport (D12): the browser speaks MCP, literally.
 *
 * This is the default implementation of the `Transport` seam in `client.ts`. It opens ONE MCP
 * session over StreamableHTTP against the engine and calls every action as an MCP tool. The Studio
 * is therefore an MCP client in the same sense an agent subprocess is, and the product claim stops
 * being a description of the architecture and starts being the architecture.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: it maps MCP results and errors back onto the exact
 * `RestResponse` shape the surfaces already branch on (`isErr(body)`, `resp.status` 200 / 422 / 404).
 * A domain rejection arrives as `{ status: 422, body: { ok: false, error: '<code>' } }` whether it
 * came over MCP or over the older REST bridge, so not one line of surface code has to know which
 * transport it is talking to, and swapping back is a one-line change in `client.ts`.
 *
 * The session is opened lazily on the first call and reused. `initialize` is where the audit actor
 * is declared (D13): the client name below is what makes a human action land in the audit trail as
 * `studio` rather than `agent`.
 */
import type { Err, Result, RestResponse, Transport } from './client';

/** The client name the Studio declares at `initialize`. Mirrors `STUDIO_CLIENT_NAME` in the engine. */
export const STUDIO_CLIENT_NAME = 'till-studio';

/** Where the engine mounts its MCP endpoint (same origin: the dev bridge, or the host in production). */
export const MCP_ENDPOINT = '/mcp';

/** The slice of an MCP client this transport uses. Narrow on purpose, so a test can supply one. */
export interface McpToolCaller {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** A transport fault: the call never reached a verb, so there is no domain answer to report. */
function transportError(detail: string): Err {
  return { ok: false, error: 'transport_error', detail };
}

/**
 * The status a verb `Result` gets, matching `handleRest` exactly: 200 for a success, 404 for an
 * action the engine does not know, 422 for a domain rejection (well-formed request, refused).
 */
export function statusFor(result: Result): number {
  if (result.ok) return 200;
  return result.error === 'unknown_action' ? 404 : 422;
}

/** Is this an engine `Result`, rather than some other JSON that happened to parse? */
function isResult(value: unknown): value is Result {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; error?: unknown };
  if (candidate.ok === true) return true;
  return candidate.ok === false && typeof candidate.error === 'string';
}

/**
 * Unwrap the single JSON text block the engine's `callTool` emits back into a verb `Result`.
 * Anything that is not that shape is a transport fault, never a silent success: a surface must not
 * be handed a body it cannot narrow.
 */
export function parseToolResult(raw: unknown): Result {
  const content = (raw as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return transportError('empty_tool_result');
  }
  const text = (content[0] as { text?: unknown }).text;
  if (typeof text !== 'string') return transportError('non_text_tool_result');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return transportError('non_json_tool_result');
  }
  return isResult(parsed) ? parsed : transportError('unrecognised_tool_result');
}

/**
 * Build a `Transport` over a connect function that yields an MCP caller.
 *
 * The session is opened once and reused. A failure at ANY point (handshake or call) drops the
 * session and is reported as a `transport_error` with status 0, mirroring `fetchTransport`: the next
 * call re-handshakes rather than staying dead, which is what makes the Studio survive an engine
 * restart without a page reload.
 */
export function mcpTransportOver(connect: () => Promise<McpToolCaller>): Transport {
  let session: Promise<McpToolCaller> | null = null;

  const transport: Transport = async (action, input) => {
    const attempt = session ?? connect();
    session = attempt;

    let caller: McpToolCaller;
    try {
      caller = await attempt;
    } catch (cause) {
      session = null;
      return { status: 0, body: transportError(String(cause)) };
    }

    try {
      const raw = await caller.callTool({ name: action, arguments: input ?? {} });
      const body = parseToolResult(raw);
      return { status: body.ok ? 200 : statusFor(body), body } satisfies RestResponse;
    } catch (cause) {
      // A mid-session failure (the engine restarted, the session id expired) invalidates the session.
      session = null;
      return { status: 0, body: transportError(String(cause)) };
    }
  };

  // M01/M03 (S4.3): the served MCP session pins its resolved identity at open, so a client whose
  // membership just changed (accept_invite) drops the session here and the next call opens a fresh
  // one that resolves the NEW identity. The stale session is closed best-effort: the server would
  // otherwise keep it live until shutdown.
  transport.resetSession = () => {
    const stale = session;
    session = null;
    void stale
      ?.then((caller) => (caller as { close?: () => Promise<void> }).close?.())
      .catch(() => undefined);
  };

  return transport;
}

/** The real transport: one MCP session over StreamableHTTP against the same-origin engine. */
export function mcpTransport(
  options: { url?: string; clientName?: string; clientVersion?: string } = {},
): Transport {
  const { url = MCP_ENDPOINT, clientName = STUDIO_CLIENT_NAME, clientVersion = '0.0.0' } = options;
  return mcpTransportOver(async () => {
    // Imported dynamically: the SDK and its schema validator are a large slice of the bundle, and
    // nothing needs them until the first engine call. This keeps them out of the first paint.
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(url, window.location.origin)));
    return client as unknown as McpToolCaller;
  });
}
