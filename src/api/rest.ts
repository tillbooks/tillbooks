/**
 * Phase E, the REST twins: the second thin adapter over the shared action registry.
 *
 * These are pure request -> verb -> response functions with no bound HTTP server and no framework: a
 * host mounts them however it likes. Each call resolves the SAME `ActionDef` the MCP server does and
 * calls its `run`, so the two faces cannot diverge (that is the whole point of the shared registry).
 *
 * Status mapping: a successful verb `Result` is `200`, a verb rejection (`{ ok:false, ... }`) is `422`
 * (the request was well-formed but the domain refused it), and an unknown action name is `404`.
 */

import type { Result } from '../core/result.js';
import { getAction } from './registry.js';
import { runGoverned } from './agent-gate.js';
import type { ApiDeps } from './registry.js';

export interface RestResponse {
  status: number;
  body: Result;
}

/**
 * Dispatch a REST call to its action. `input` is the decoded request body (camelCase, `workspaceId`
 * included for ctx tools). Returns the status and the verb's `Result` as the body.
 */
export function handleRest(actionName: string, input: Record<string, unknown>, deps: ApiDeps): RestResponse {
  const action = getAction(actionName);
  if (action === undefined) {
    return { status: 404, body: { ok: false, error: 'unknown_action', action: actionName } };
  }
  // A35: the governed transport dispatch. Identical to `action.run` for every non-agent actor; for
  // the agent seat it records the call and routes a dial-governed write. REST has no connection, so
  // no transport key rides along and the recorder's idle-gap session rule applies.
  const result = runGoverned(deps, action, input ?? {});
  return { status: result.ok ? 200 : 422, body: result };
}

export { getAction } from './registry.js';
export type { ApiDeps } from './registry.js';
