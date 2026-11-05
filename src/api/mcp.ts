/**
 * Phase E, the MCP stdio server: one thin adapter over the shared action registry.
 *
 * Each `ActionDef` becomes an MCP tool with a human `title` derived from its name (`toolTitle`, carried
 * both as `Tool.title` and as `annotations.title`). A `read` tool advertises `annotations.readOnlyHint`; every write
 * advertises `destructiveHint` from its declared D159 class (false only for an append-only `correctable`
 * one), that class under `_meta['tillbooks/reversibility']`, its D160 consequence tag (plus the D156
 * sentence in both languages where the catalogue has one) under `_meta['tillbooks/consequence']`, and, when
 * it is idempotent for the same arguments, says so. Every
 * tool's input schema is the action's minimal JSON Schema. The server sends `instructions`. The tool handler calls `action.run` and
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
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

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
import type { ActionDef } from './registry.js';
import type { ConsequenceTag, Reversibility } from './actionKind.js';
import { CONSEQUENCE_ENTRY_FOR_ACTION } from '../core/agent/dialMap.js';
import { runGoverned, runGovernedAsync } from './agent-gate.js';
import { resolveSessionActor, type ServedIdentity } from './session.js';
import { makeDiagnosticsPort } from './support-actions.js';
import { resolveEbicsRuntime, type HostEbicsPorts } from './host-runtime.js';
import type { ApiDeps } from './registry.js';
import { TILL_PACKAGE_VERSION } from '../core/version.js';

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
 * D142: `callTool` for the live handler, which can await. Identical for every verb except one the host
 * runs off the main thread (`bank_sync` under `till up`): its answer arrives when the worker finishes,
 * and meanwhile this process keeps answering every other request. The parity suite drives `callTool`.
 */
export async function callToolAsync(deps: ApiDeps, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const action = getAction(name);
  const result = action === undefined ? err('unknown_action', { action: name }) : await runGovernedAsync(deps, action, args ?? {});
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
 * D156: the server `instructions` an MCP client reads at `initialize`, in the agreed positioning. Every
 * claim is checked against the code: `whoami` answers the governed seat's effective dial level per
 * capability (`agentDial`), a governed write at `ask` returns a drafted proposal (A35), every write that
 * mints or moves something carries an `idempotencyKey` while the few without one are safe to repeat
 * (the conformance gate's `IDEMPOTENCY_KEY_EXEMPT`: absolute setters or verbs that key themselves), and
 * posted entries and issued documents are
 * corrected by a linked reversal or credit note, never edited.
 */
export const MCP_SERVER_INSTRUCTIONS =
  'TILL is an agent-first ERP for Swiss SMEs: sales, purchasing, payments, stock, projects, books and MWST in one local file. ' +
  // N00: the brief joins the whoami sentence, so the instructions stay at the D156 two to four sentences.
  'Call whoami first, then workspace_brief: whoami names your seat and which areas run at ask, where a write returns a proposal a person approves instead of executing; the brief says how this workspace books, and its Hausregeln (house notes) are the owner\'s rules to follow. ' +
  'Every write that adds or moves something takes an idempotencyKey, and resending the same key never doubles a result; the few without one are safe to repeat: they set an absolute state or key themselves. ' +
  'Posted entries and issued documents are corrected by a new linked document (correcting entry, credit note), never edited.';

/**
 * N01 US-N01.9: THE TOOL PROFILE, a property of the MCP PROCESS (`tools/list` carries no workspace, so it
 * cannot be a workspace setting). `full` (the default, D183 rule 5) lists every verb; `essentials` lists the
 * verbs an agent books a month with (`ESSENTIALS_TOOLS`) and reaches every other verb through
 * `get_api_catalog { query }` and `call_tool { name, args }`, which dispatches through the same governed
 * door. A profile changes what is LISTED, never what may run: a listed or unlisted verb meets the same
 * permissions, dial and trace.
 */
export const TOOL_PROFILES = ['full', 'essentials'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

/** The environment variable `till mcp` reads when no `--profile` is given. */
export const TOOL_PROFILE_ENV = 'TILL_MCP_PROFILE';

/**
 * The essentials profile, in the order an agent meets them: orient, then the ledger, the bank inbox, sales,
 * purchases, payments, the Vorschläge, and the two doors to everything else. Every name is held to the
 * registry by `test/api/mcp-tool-profile.test.mjs`.
 */
export const ESSENTIALS_TOOLS: readonly string[] = [
  // orient
  'whoami',
  'workspace_brief',
  'list_workspaces',
  'hausbuch_notes',
  'hausbuch_note_set',
  'search_global',
  'get_company_profile',
  // the two doors to every other verb
  'get_api_catalog',
  'call_tool',
  // the ledger
  'list_accounts',
  'vat_codes',
  'list_journal',
  'get_entry',
  'compose_entry',
  'post_entry',
  'post_entries',
  'reverse_entry',
  'list_period_locks',
  'trial_balance',
  'balance_sheet',
  'income_statement',
  // the bank inbox
  'list_bank_inbox',
  'book_bank_line',
  'book_bank_lines',
  'ignore_bank_line',
  'reopen_bank_line',
  'list_bank_standards',
  'set_bank_standard',
  // sales and purchases
  'list_contacts',
  'create_contact',
  'list_items',
  'list_documents',
  'get_document',
  'create_document',
  'issue_invoice',
  'list_open_items',
  'record_expense',
  'create_vendor_bill',
  'list_vendor_bills',
  'record_payment',
  // Belege and the Vorschläge
  'files_upload',
  'list_drafted_actions',
];

/** The tools one profile advertises, in registry order. */
export function actionsForProfile(profile: ToolProfile): readonly ActionDef[] {
  if (profile === 'full') return ACTIONS;
  const wanted = new Set(ESSENTIALS_TOOLS);
  return ACTIONS.filter((a) => wanted.has(a.name));
}

/**
 * The profile `till mcp` runs: `--profile <name>` or `--profile=<name>` on the command line, else
 * `TILL_MCP_PROFILE`, else `full`. An unknown name THROWS (the CLI prints it and exits): a typo must not
 * silently serve the full list to a client that asked for a lean one.
 */
export function resolveToolProfile(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ToolProfile {
  let named: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--profile') named = argv[i + 1] ?? '';
    else if (arg.startsWith('--profile=')) named = arg.slice('--profile='.length);
  }
  const value = (named ?? env[TOOL_PROFILE_ENV] ?? 'full').trim();
  if ((TOOL_PROFILES as readonly string[]).includes(value)) return value as ToolProfile;
  throw new Error(`Unknown tool profile "${value}": choose ${TOOL_PROFILES.join(' or ')} (--profile or ${TOOL_PROFILE_ENV}).`);
}

/** The server instructions for a profile: the essentials connection says how to reach the rest. */
export function instructionsFor(profile: ToolProfile): string {
  return profile === 'full'
    ? MCP_SERVER_INSTRUCTIONS
    : `${MCP_SERVER_INSTRUCTIONS} This connection lists the essential tools only: get_api_catalog { query } finds any other verb and its input, and call_tool { name, args } runs it through the same checks.`;
}

/**
 * D156/D160: the namespaced `_meta` key carrying a write's consequence (MCP `_meta` key rules): on EVERY
 * write its D160 `tag` (what it touches), and where the D156 catalogue has a sentence for the verb, that
 * sentence in both languages (`en`, `de-CH`) beside the verb's declared class (`reversibility`).
 */
export const CONSEQUENCE_META_KEY = 'tillbooks/consequence';

/**
 * D159: the namespaced `_meta` key carrying a write's DECLARED reversibility class (`ActionDef.reversibility`,
 * from its `write:<class>:<tag>` registration). Sent for every write; a read carries none.
 */
export const REVERSIBILITY_META_KEY = 'tillbooks/reversibility';

/**
 * Critic B1 (claude/rmap-land): the `correctable` writes that still advertise `destructiveHint: true`,
 * each with the reason. The declared class describes the verb's way back (an issued document is cancelled
 * or credited), but `destructiveHint: false` claims every call is additive, and these verbs have an edge
 * that is not: the hint follows the worst edge, the class and `_meta` stay the declared ones.
 */
export const DESTRUCTIVE_DESPITE_CLASS: Readonly<Record<string, string>> = {
  transition_document:
    "its quote `accepted` edge is quotes_accept, which the D161 map classes final (the quote binds both sides), and its `cancelled` edge on a draft deletes the draft",
};

/** What a write's tool says under `CONSEQUENCE_META_KEY`. */
export interface ConsequenceMeta {
  tag: ConsequenceTag;
  en?: string;
  'de-CH'?: string;
  reversibility?: Reversibility;
}

/**
 * How one snake_case word of a verb name is written in its human title, where plain lower case would be
 * wrong: an acronym or a standard's own spelling (`VAT`, `eBill`, `pain.001`, `eCH-0217`), an abbreviation
 * a reader should not have to decode (`txn`, `prefs`, `defs`), and the de-CH nouns the product keeps in
 * German (a German noun is capitalised wherever it stands). Every other word stays as it is.
 */
export const TOOL_TITLE_WORDS: Readonly<Record<string, string>> = {
  api: 'API',
  belegeingang: 'Belegeingang',
  camt: 'camt',
  compat: 'compatibility',
  csv: 'CSV',
  defs: 'definitions',
  ebill: 'eBill',
  ech0217: 'eCH-0217',
  env: 'environment',
  fx: 'FX',
  gl: 'GL',
  grir: 'GR/IR',
  hausbuch: 'Hausbuch',
  hr: 'HR',
  kpis: 'KPIs',
  nbv: 'NBV',
  pain001: 'pain.001',
  pdf: 'PDF',
  pl: 'P&L',
  po: 'PO',
  pos: 'POs',
  prefs: 'preferences',
  qa: 'QA',
  qr: 'QR',
  saldo: 'Saldo',
  skonto: 'Skonto',
  testmandant: 'Testmandant',
  txn: 'transaction',
  vat: 'VAT',
  vorlage: 'Vorlage',
  wip: 'WIP',
};

/** The verbs whose name is not a phrase of its words, titled whole. */
export const TOOL_TITLE_WHOLE: Readonly<Record<string, string>> = {
  whoami: 'Who am I',
};

/**
 * The human `title` a tool advertises (MCP 2025-06-18: `Tool.title`, and `annotations.title` for clients
 * that read the older place), DERIVED from the verb's own name so 844 verbs carry one without 844
 * hand-written strings to drift: the words in sentence case, each one spelled through `TOOL_TITLE_WORDS`
 * (`post_entry` -> "Post entry", `vat_export_ech0217` -> "VAT export eCH-0217"). Presentation only: the
 * name stays the tool's identity (§H-ENUM) and the description stays the summary.
 */
export function toolTitle(name: string): string {
  const whole = TOOL_TITLE_WHOLE[name];
  if (whole !== undefined) return whole;
  // Sentence case: only the first word is raised, and only when it is a plain word (an acronym or a
  // standard's spelling such as `camt` or `eBill` keeps its own form wherever it stands).
  return name
    .split('_')
    .filter((w) => w.length > 0)
    .map((w, i) => TOOL_TITLE_WORDS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** The MCP `Tool` this server advertises for one action (exported so the parity test reads the same shape). */
export function toolFor(a: ActionDef): Record<string, unknown> {
  const props = a.inputSchema.properties;
  const title = toolTitle(a.name);
  if (a.kind === 'read') {
    return {
      name: a.name,
      title,
      description: a.consequence === undefined ? a.summary : `${a.summary} CONSEQUENCE: ${a.consequence}`,
      inputSchema: a.inputSchema,
      annotations: { title, readOnlyHint: true },
    };
  }
  // Every write carries both (the registry asserts it at load); a hand-built ActionDef that does not is
  // refused here rather than advertised with a guessed hint.
  const reversibility = a.reversibility;
  const tag = a.consequenceTag;
  if (reversibility === undefined || tag === undefined) {
    throw new Error(`toolFor: the write '${a.name}' declares no reversibility class or consequence tag (D159/D160).`);
  }
  const sentence = CONSEQUENCE_ENTRY_FOR_ACTION[a.name];
  // A write is idempotent for the SAME arguments when its key is required (§H-IDEMPOTENT) or when it
  // takes none at all (an absolute setter, the conformance gate's `IDEMPOTENCY_KEY_EXEMPT`). A write
  // whose key is optional only replays when the caller passes one, so it claims nothing.
  const idempotent = a.inputSchema.required.includes('idempotencyKey') || !('idempotencyKey' in props);
  const annotations = {
    title,
    // MCP: `destructiveHint: false` means additive-only. Only a `correctable` write is (append-only); a
    // `reversible` one may overwrite state and a `final` one has no way back. D159: the verb's own
    // declared class decides, never the catalogue's.
    // A verb in DESTRUCTIVE_DESPITE_CLASS has a non-additive edge, so it claims nothing either.
    destructiveHint: reversibility !== 'correctable' || DESTRUCTIVE_DESPITE_CLASS[a.name] !== undefined,
    ...(idempotent ? { idempotentHint: true } : {}),
  };
  const consequence: ConsequenceMeta = {
    tag,
    ...(sentence === undefined ? {} : { en: sentence.en, 'de-CH': sentence['de-CH'], reversibility }),
  };
  return {
    name: a.name,
    title,
    // A35 (critic F11): the consequence sentence reaches the MCP CLIENT here, appended to the
    // advertised description, so "the MCP client's confirmation prose" consumer is real: a client
    // deciding whether to call a governed write reads what it does and what can still be done after.
    description: a.consequence === undefined ? a.summary : `${a.summary} CONSEQUENCE: ${a.consequence}`,
    inputSchema: a.inputSchema,
    annotations,
    // D156: the description stays English; `_meta` carries both languages, the same entry the Studio
    // renders. D159/D160: every write also carries its declared class and its consequence tag.
    _meta: { [CONSEQUENCE_META_KEY]: consequence, [REVERSIBILITY_META_KEY]: reversibility },
  };
}

/**
 * N00: the workspace brief as an MCP RESOURCE, for clients that load resources. The URI names the
 * workspace (a book holds several, A23), so the brief is a TEMPLATE (`resources/templates/list`) and one
 * concrete resource per workspace the session may open (`resources/list`, through `list_workspaces`).
 */
export const BRIEF_RESOURCE_TEMPLATE = 'till://workspace/{id}/brief';

/** The brief's URI for one workspace. */
export function briefResourceUri(workspaceId: string): string {
  return `till://workspace/${encodeURIComponent(workspaceId)}/brief`;
}

const BRIEF_URI = /^till:\/\/workspace\/([^/]+)\/brief$/;

/**
 * `resources/list`: one brief per workspace the session may open, read through the governed
 * `list_workspaces` exactly as a tool call would (a served subject sees only its own mandates).
 */
export function listBriefResources(deps: ApiDeps): { uri: string; name: string; description: string; mimeType: string }[] {
  const action = getAction('list_workspaces');
  if (action === undefined) return [];
  const listed = runGoverned(deps, action, {});
  if (!listed.ok || !Array.isArray(listed.workspaces)) return [];
  return (listed.workspaces as { workspaceId: string; name: string }[]).map((w) => ({
    uri: briefResourceUri(w.workspaceId),
    name: `${w.name}: workspace brief`,
    description: 'How this workspace books: the chart, VAT codes, Bankkonten, Buchungsregeln, the Hausregeln to follow, and what waits in Pendenzen (workspace_brief).',
    mimeType: 'application/json',
  }));
}

/**
 * `resources/read`: the brief of the workspace the URI names, rendered by running `workspace_brief`
 * through the GOVERNED dispatch under the session's seat (the G22 prompt precedent), so the per-section
 * read gates and the A35 trace apply exactly as for the tool. A verb refusal reads back as its Result
 * JSON; a URI that names no brief THROWS, which the client sees as a protocol error.
 */
export function readBriefResource(deps: ApiDeps, uri: string): { uri: string; mimeType: string; text: string } {
  const match = BRIEF_URI.exec(uri);
  if (match === null) throw new Error(`unknown_resource: ${uri}`);
  const workspaceId = decodeURIComponent(match[1] as string);
  const action = getAction('workspace_brief');
  const result = action === undefined ? err('unknown_action', { action: 'workspace_brief' }) : runGoverned(deps, action, { workspaceId });
  return { uri, mimeType: 'application/json', text: JSON.stringify(result) };
}

/**
 * Build the MCP `Server` with every action registered as a tool. No transport is connected yet.
 *
 * `pinnedActor` (A35 critic F12): the D13 actor is normally resolved from the client's DECLARED name
 * at `initialize`, which is a claim and not a credential. On a transport where the seat is knowable
 * from the CONNECTION itself (stdio: `till mcp` is by definition an agent process, and the Studio
 * never speaks stdio), the caller pins the actor and the declared name stops mattering, so a client
 * naming itself `till-studio` over stdio cannot shed the dial and the trace. On the shared HTTP door
 * the host pins the seat from the per-launch Studio key (`checkStudioKey`, `src/api/session.ts`):
 * the Studio seat needs the key, every other session is the governed `agent` seat, and a declared
 * client name is a trace label only. The residue (a local program that can read the served Studio
 * page) is stated in the A35 spec's threat model.
 */
export function buildMcpServer(
  deps: ApiDeps,
  opts: { pinnedActor?: string; servedIdentity?: ServedIdentity; profile?: ToolProfile } = {},
): Server {
  const profile = opts.profile ?? 'full';
  const server = new Server(
    // The running package's version, so a client (and every directory that scans the server) sees
    // the release it talks to, not a placeholder.
    { name: 'tillbooks', version: TILL_PACKAGE_VERSION },
    // G22 (D127): `prompts` beside `tools`. One prompt per checklist template, rendered from the
    // governed `checklist_get` under the session actor (see `renderPromptOverActions`).
    // N00: `resources` beside them, the workspace brief per workspace (see `readBriefResource`).
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: instructionsFor(profile) },
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

  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: listBriefResources(sessionDeps()) }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: BRIEF_RESOURCE_TEMPLATE,
        name: 'workspace brief',
        description: 'How a workspace books, in one read (workspace_brief); {id} is the workspace id from list_workspaces.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
    contents: [readBriefResource(sessionDeps(), request.params.uri)],
  }));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // N01 US-N01.9: the process's profile decides what is LISTED; every verb still answers a call.
    tools: actionsForProfile(profile).map(toolFor),
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
    return callToolAsync(sessionDeps(), request.params.name, args) as unknown as Promise<ServerResult>;
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
  opts: { dbPath?: string; profile?: ToolProfile } = {},
): Promise<{ server: Server; store: SqliteStore }> {
  // D108: attach the private live bank wire when the operator configured one; otherwise the EBICS
  // network steps degrade honestly. Resolved once at startup and shared by every session's deps.
  const hostPorts = await resolveEbicsRuntime();
  const opened = makeApiDeps(opts.dbPath, hostPorts);
  const { store } = opened;
  // N02 (D183): stdio is a LOCAL door (the agent runs on this computer), so it may hand TILL a receipt by
  // path, confined to `files.source_roots`. `till serve` builds its deps through `makeApiDeps` too and
  // never gets this grant.
  const deps: ApiDeps = { ...opened.deps, localFiles: { home: homedir() } };
  // F12: the stdio door IS the agent door (the Studio never speaks stdio), so the seat is pinned
  // from the transport and a client-declared `till-studio` name cannot shed the dial or the trace.
  const server = buildMcpServer(deps, { pinnedActor: 'agent', ...(opts.profile !== undefined ? { profile: opts.profile } : {}) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, store };
}
