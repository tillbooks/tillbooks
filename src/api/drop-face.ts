/**
 * N02 (D183), THE DROP FACE: how the Studio's drop page (`/drop/:token`) reads and redeems a one-time
 * drop link, and the one deliberate exception to Pattern P4's parity pair.
 *
 *   POST /studio-drop/resolve  `{ token }`: what the link points at and whether it is still open.
 *   POST /studio-drop/redeem   `{ token, contentBase64, filename, bookAgain?, overrideReason? }`: the person's
 *                              drop (R1: the reason confirms a receipt that is already booked elsewhere).
 *
 * WHY NOT A VERB. Every registry verb is an MCP tool too, and an agent that could call the redemption
 * could redeem the very link it minted, which would turn "a person drops the receipt" into "the agent
 * attaches whatever it likes". So the redemption is a face of the local router, seated EXACTLY like the
 * REST twins (the Studio key or a paired session token, `session.ts`, checked before a byte of the body
 * is read), mounted only by a host that serves the Studio in LOCAL mode. An MCP session never reaches
 * it, and the engine refuses a governed seat anyway (`redeemDropLink`).
 *
 * The engine calls run with the same wired context a ctx verb gets (`wiredContext`), in the link's own
 * workspace, so A24 decides for the seated person exactly as it would for a verb.
 */

import { err } from '../core/result.js';
import type { Result } from '../core/result.js';
import { isBusyError } from '../core/store/sqlite-store.js';
import { SchemaNewerThanRuntimeError, SCHEMA_NEWER_THAN_RUNTIME, refusalFields } from '../core/store/generation.js';
import { dropLinkByToken, redeemDropLinkGuarded, resolveDropLink } from '../core/files/index.js';
import { wiredContext, type ApiDeps } from './registry.js';

/** The mount prefix of the drop face. Not under `/studio/` (the door's 4 KiB body cap) nor `/api/` (the verbs). */
export const DROP_FACE_PREFIX = '/studio-drop/';
export const DROP_RESOLVE_PATH = '/studio-drop/resolve';
export const DROP_REDEEM_PATH = '/studio-drop/redeem';

/** The HTTP status a refusal answers with, so the page can tell a gone link from a bad file. */
function statusOf(result: Result): number {
  if (result.ok) return 200;
  switch (result.error) {
    case 'drop_link_unknown':
      return 404;
    case 'drop_link_used':
    case 'drop_link_expired':
      return 410;
    case 'permission_denied':
    case 'human_only':
      return 403;
    case 'file_too_large':
      return 413;
    case 'store_busy':
      return 503;
    default:
      return 422;
  }
}

/**
 * Serve one drop call for an already seated caller. `op` is `resolve` or `redeem`; anything else is not
 * this face's (404). Never throws for a caller's input.
 */
export function handleDropCall(deps: ApiDeps, op: string, input: Record<string, unknown>): { status: number; body: Result } {
  if (op !== 'resolve' && op !== 'redeem') return { status: 404, body: err('not_found', { path: `${DROP_FACE_PREFIX}${op}` }) };
  const row = dropLinkByToken(deps.store, input.token);
  if (row === undefined) return { status: 404, body: err('drop_link_unknown', {}) };
  try {
    deps.store.assertGenerationKnown();
    const ctx = wiredContext(deps, row.workspace_id);
    const body = op === 'resolve' ? resolveDropLink(ctx, input.token) : redeemDropLinkGuarded(ctx, input);
    return { status: statusOf(body), body };
  } catch (e) {
    if (e instanceof SchemaNewerThanRuntimeError) {
      const body = err(SCHEMA_NEWER_THAN_RUNTIME, { action: `drop_${op}`, ...refusalFields(e) });
      return { status: 409, body };
    }
    if (isBusyError(e)) return { status: 503, body: err('store_busy', { action: `drop_${op}`, retryable: true }) };
    throw e;
  }
}
