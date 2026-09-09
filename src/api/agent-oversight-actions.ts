/**
 * A35's three verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `agentActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * THREE READS AND NOT ONE WRITE. A35 is the oversight FACE over A26's mechanics: the transcript
 * archive (`list_agent_sessions`, `get_agent_session`) and the longitudinal trust evidence
 * (`agent_trust_summary`). The only thing A35 could otherwise want to write, the session recording
 * itself, happens at the transport seam (`src/api/agent-gate.ts`) and is deliberately NOT a verb any
 * caller may ask for: a client that could pick its own session id could hide a call in a session
 * nobody reads. All three ride `read_books` (the trace renders the arguments of ledger writes; it IS
 * the books, operationally) and pass §H-TENANT through the workspace in every lookup key.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { listAgentSessions, getAgentSession, agentTrustSummary } from '../core/agent/index.js';

export interface AgentOversightActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The A35 verbs, in append order. */
export function agentOversightActions(h: AgentOversightActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;
  return [
    ctxAction(
      'list_agent_sessions',
      'read',
      'List the agent sessions (Gespräche) of a workspace, newest first, each with its call, write and proposal counts. The trace records at the dispatch seam, so every session an agent seat ever opened is here; from/to filter on last activity, openOnly keeps running sessions, entityRef keeps the sessions whose trace created or approved that one object (the id a verb answered with), which is how a detail view links into the conversation it came from.',
      ctxSchema({ from: STR, to: STR, openOnly: BOOL, entityRef: STR }),
      (ctx, input) => listAgentSessions(ctx, as(input)),
    ),
    ctxAction(
      'get_agent_session',
      'read',
      'Read one agent session in full: its turns in order, each with its recorded calls (verb, arguments, execute/draft/deny decision, dial capability, outcome, duration, and the created object where one exists). A foreign sessionId reads as not_found, never as another tenant’s transcript.',
      ctxSchema({ sessionId: STR }, ['sessionId']),
      (ctx, input) => getAgentSession(ctx, as(input)),
    ),
    ctxAction(
      'agent_trust_summary',
      'read',
      'The trust evidence per dial capability (Vertrauen): stored and effective level, who set it and when, and the proposed/approved/rejected/auto-executed counts over a stated window (default the last 90 days). Derived from the trace at read time; never stored, never a score.',
      ctxSchema({ from: STR, to: STR }),
      (ctx, input) => agentTrustSummary(ctx, as(input)),
    ),
  ];
}
