/**
 * Phase E, the MCP stdio server: one thin adapter over the shared action registry.
 *
 * Each `ActionDef` becomes an MCP tool. A `read` tool advertises `annotations.readOnlyHint`; every
 * tool's input schema is the action's minimal JSON Schema. The tool handler calls `action.run` and
 * returns the verb's `Result` as JSON content: a verb rejection (`{ ok:false, ... }`) is a normal
 * result the caller reads, NOT an MCP protocol error, so `isError` is never set for a verb outcome.
 *
 * `callTool` is exported and used BOTH by the live server's request handler AND by the parity test, so
 * the test drives the exact code path the transport does.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';

import { SqliteStore } from '../core/store/sqlite-store.js';
import { systemClock } from '../core/clock.js';
import { systemIdGen } from '../core/ids.js';
import { err } from '../core/result.js';
import type { Result } from '../core/result.js';
import {
  CHECKLIST_PROMPT_ARGUMENTS,
  checklistTemplate,
  listChecklistPrompts,
  pickChecklistPeriod,
  renderChecklistPromptRefusal,
  renderChecklistPromptText,
  templateForPrompt,
  type ChecklistRunView,
} from '../core/checklists/index.js';
import { ACTIONS, getAction } from './registry.js';
import { runGoverned } from './agent-gate.js';
import { resolveSessionActor, type ServedIdentity } from './session.js';
import { makeDiagnosticsPort } from './support-actions.js';
import { resolveEbicsRuntime, type HostEbicsPorts } from './host-runtime.js';
import type { ApiDeps } from './registry.js';

/** The MCP `CallToolResult` shape this server emits: a single JSON text block. */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * Invoke a tool by name and serialise the verb `Result` as a JSON text block. An unknown tool name is
 * the one structural miss (the registry drives the advertised list, so it should not happen); it is
 * reported as a normal `unknown_action` Result, not a thrown protocol error.
 */
export function callTool(deps: ApiDeps, name: string, args: Record<string, unknown>): ToolCallResult {
  const action = getAction(name);
  // A35: `runGoverned` is the transport dispatch. For every non-agent actor it IS `action.run`;
  // for the agent seat it records the call in the trace and routes a dial-governed write through
  // `decideAction` (execute / draft / deny). Direct `action.run` callers bypass it by construction.
  const result = action === undefined ? err('unknown_action', { action: name }) : runGoverned(deps, action, args ?? {});
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * G22 (D127): render one template prompt by walking the GOVERNED actions under the session's deps,
 * exactly as a tool call would: `vat_periods` picks the period, `checklist_list` finds the run,
 * `checklist_get` derives it, and the shared renderer turns that view into text. Because every step
 * is `runGoverned` over a registry action, the A24 gate and the A35 trace are inherited rather than
 * re-implemented, and the prompt's open items are BY CONSTRUCTION the ones `checklist_get` returns.
 *
 * Exported (like `callTool`) so the parity test drives the exact code path the handler does. An
 * unknown prompt name and a missing `workspaceId` THROW: those are protocol-level misuse the MCP
 * client should see as errors, unlike a verb refusal, which renders verbatim as text.
 */
export function renderPromptOverActions(
  deps: ApiDeps,
  name: string,
  args: Record<string, unknown>,
): { description: string; text: string } {
  const templateId = templateForPrompt(name);
  const template = templateId === undefined ? undefined : checklistTemplate(templateId);
  if (template === undefined) throw new Error(`unknown_prompt: ${name}`);
  const workspaceId = args.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) throw new Error('invalid_input: workspaceId is required');
  const description = `The "${template.label}" checklist for ${typeof args.period === 'string' ? args.period : 'the last ended period'}.`;
  const govern = (verb: string, input: Record<string, unknown>): Result => {
    const action = getAction(verb);
    return action === undefined ? err('unknown_action', { action: verb }) : runGoverned(deps, action, { workspaceId, ...input });
  };
  // G22 leg 2 (spec §10.3): the period kind is the template's; a month or year resolves from the clock
  // and the fiscal year start alone, and `vat_periods` is consulted only for the MWST-Periode.
  const fiscalYearStart =
    (deps.store.db.prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?').get(workspaceId) as { fiscal_year_start: string | null } | undefined)
      ?.fiscal_year_start ?? '01-01';
  const picked = pickChecklistPeriod((year) => govern('vat_periods', { year }), deps.clock.now().slice(0, 10), args.period, template.periodKind, fiscalYearStart);
  if (!picked.ok) return { description, text: renderChecklistPromptRefusal(template.periodKind === 'vat_period' ? 'vat_periods' : 'period', picked) };
  const listed = govern('checklist_list', { templateId: template.templateId });
  if (!listed.ok) return { description, text: renderChecklistPromptRefusal('checklist_list', listed) };
  const runs = Array.isArray(listed.runs) ? (listed.runs as { runId: string; periodStart: string }[]) : [];
  const match = runs.find((r) => r.periodStart === picked.periodStart);
  let run: ChecklistRunView | null = null;
  if (match !== undefined) {
    const got = govern('checklist_get', { runId: match.runId });
    if (!got.ok) return { description, text: renderChecklistPromptRefusal('checklist_get', got) };
    run = got as unknown as ChecklistRunView;
  }
  return { description, text: renderChecklistPromptText({ template, workspaceId, period: picked, run }).text };
}

/**
 * Build the MCP `Server` with every action registered as a tool. No transport is connected yet.
 *
 * `pinnedActor` (A35 critic F12): the D13 actor is normally resolved from the client's DECLARED name
 * at `initialize`, which is a claim and not a credential. On a transport where the seat is knowable
 * from the CONNECTION itself (stdio: `till mcp` is by definition an agent process, and the Studio
 * never speaks stdio), the caller pins the actor and the declared name stops mattering, so a client
 * naming itself `till-studio` over stdio cannot shed the dial and the trace. On the shared HTTP door
 * no such pin exists in the MIT core (there is no authentication to derive a seat from): that
 * residue is stated in the A35 spec's threat model rather than papered over.
 */
export function buildMcpServer(
  deps: ApiDeps,
  opts: { pinnedActor?: string; servedIdentity?: ServedIdentity } = {},
): Server {
  const server = new Server(
    { name: 'tillbooks', version: '0.0.0' },
    // G22 (D127): `prompts` beside `tools`. One prompt per checklist template, rendered from the
    // governed `checklist_get` under the session actor (see `renderPromptOverActions`).
    { capabilities: { tools: {}, prompts: {} } },
  );

  // A35 §2a: ONE MCP CONNECTION IS ONE SESSION. The key is minted per `Server` (one per stdio
  // process, one per MCP-over-HTTP session), never taken from the client, so a session is not a
  // thing a caller can choose.
  const transportKey = `mcp-${randomUUID()}`;

  /**
   * The deps every request in THIS session runs under: the session actor (D13 / F12 pin / M01
   * served identity, resolved below exactly as before), the transport key and the client label.
   * Shared by the tool handler and the prompt handler, so a prompt can never run under a seat a
   * tool call would not.
   */
  const sessionDeps = (): ApiDeps => {
    const clientInfo = server.getClientVersion();
    const served = opts.servedIdentity;
    const actor = served?.actor ?? opts.pinnedActor ?? resolveSessionActor(clientInfo);
    return {
      ...deps,
      actor,
      agentTransportKey: transportKey,
      ...(typeof clientInfo?.name === 'string' ? { agentClientLabel: clientInfo.name } : {}),
      ...(served !== undefined ? { subject: served.subject, identitySource: served.identitySource } : {}),
    };
  };

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: listChecklistPrompts().map((p) => ({
      name: p.name,
      description: p.description,
      arguments: CHECKLIST_PROMPT_ARGUMENTS.map((a) => ({ name: a.name, description: a.description, required: a.required })),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const rendered = renderPromptOverActions(sessionDeps(), request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
    return {
      description: rendered.description,
      messages: [{ role: 'user', content: { type: 'text', text: rendered.text } }],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ACTIONS.map((a) => ({
      name: a.name,
      // A35 (critic F11): the consequence sentence reaches the MCP CLIENT here, appended to the
      // advertised description, so "the MCP client's confirmation prose" consumer is real: a client
      // deciding whether to call a money-path write reads what it irreversibly does.
      description: a.consequence === undefined ? a.summary : `${a.summary} CONSEQUENCE: ${a.consequence}`,
      inputSchema: a.inputSchema,
      ...(a.kind === 'read' ? { annotations: { readOnlyHint: true } } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // D13: the audit actor is whatever THIS session declared at `initialize`, not a per-call field
    // and not a server-wide constant. `getClientVersion()` returns the client identity captured
    // during the initialize handshake, so it is fixed for the life of the session and every call in
    // that session inherits it. An unrecognised client is the governed `agent` seat on EVERY host
    // (the seating rule in `session.ts`); `deps.actor` is the REST face's actor and is never a
    // fallback here, which is what closed the `till up` / dev-bridge bypass (F-08).
    // M01: in served mode the identity came from the reverse proxy (D105), so the proxy-attested actor
    // WINS over both the stdio pin and the client's declared D13 name (a served client cannot shed its
    // subject by naming itself something else), and its subject + identity source ride onto the deps so
    // `whoami` can name them. Local sessions have no `servedIdentity`, so this is the pre-M01 path.
    // All of that is `sessionDeps()`, shared with the prompt handler.
    // The SDK's handler return type is a broad union (it also covers task results); our content-only
    // shape is a valid CallToolResult, so widen it to ServerResult for the registration.
    return callTool(sessionDeps(), request.params.name, args) as unknown as ServerResult;
  });

  return server;
}

/**
 * Open a store and assemble the per-server `ApiDeps` (agent actor, system clock/ids).
 *
 * `hostPorts` carries the RUNTIME-wired live ports (the EBICS bank wire, D108). In the OSS core it is
 * absent and every network step degrades honestly; the packaged runtime resolves it via
 * `resolveEbicsRuntime()` and passes it here. Absent members stay ABSENT (not explicit `undefined`),
 * which is what the honest-degradation path reads under `exactOptionalPropertyTypes`.
 */
export function makeApiDeps(dbPath?: string, hostPorts: HostEbicsPorts = {}): { deps: ApiDeps; store: SqliteStore } {
  const store = new SqliteStore({ location: dbPath ?? ':memory:' });
  // G08 §4: the host is the ONLY thing that wires `DiagnosticsPort`, and until it did, `guarded()`'s
  // `deps.diagnostics?.record(...)` was permanently undefined. The port itself records nothing while
  // the user's `capture` preference is off, which is the opt-in, so wiring it here is not a default
  // change: it is what makes the opt-in reachable at all.
  const deps: ApiDeps = {
    store,
    clock: systemClock,
    ids: systemIdGen,
    actor: 'agent',
    diagnostics: makeDiagnosticsPort(),
    ...(hostPorts.ebicsTransport !== undefined ? { ebicsTransport: hostPorts.ebicsTransport } : {}),
    ...(hostPorts.ebicsKeystore !== undefined ? { ebicsKeystore: hostPorts.ebicsKeystore } : {}),
  };
  return { deps, store };
}

/**
 * Start the MCP server on stdio. Opens a SqliteStore at `dbPath` (or an ephemeral `:memory:` db when
 * none is given), builds the server, and connects the stdio transport.
 *
 * The STORE is returned alongside the server because the caller owns shutdown: closing it is what
 * checkpoints the write-ahead log, and a process that exits without doing so leaves the WAL to grow.
 */
export async function startMcpServer(
  opts: { dbPath?: string } = {},
): Promise<{ server: Server; store: SqliteStore }> {
  // D108: attach the private live bank wire when the operator configured one; otherwise the EBICS
  // network steps degrade honestly. Resolved once at startup and shared by every session's deps.
  const hostPorts = await resolveEbicsRuntime();
  const { deps, store } = makeApiDeps(opts.dbPath, hostPorts);
  // F12: the stdio door IS the agent door (the Studio never speaks stdio), so the seat is pinned
  // from the transport and a client-declared `till-studio` name cannot shed the dial or the trace.
  const server = buildMcpServer(deps, { pinnedActor: 'agent' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, store };
}
