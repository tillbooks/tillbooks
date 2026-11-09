/**
 * G01's run log read models (Pattern P5): what fired, when, why, and what it did.
 *
 * A PERSON MUST BE ABLE TO SEE WHAT AN UNATTENDED SUBSYSTEM DID. That is the whole requirement, and
 * it is why the log records the RESOLVED action input rather than the configured template: the
 * question a human asks is "what was actually sent", and a template plus a payload is a puzzle they
 * would have to solve to answer it.
 *
 * THIS IS NOT A SECOND DIAGNOSTICS MECHANISM. G08 already owns the crash journal in
 * `src/core/support/`, and an unexpected throw inside the fire path is recorded there through the
 * `DiagnosticsPort` the shared dispatch already carries. Two mechanisms, two different facts: the run
 * log says what the automation DID, the diagnostics journal says what BROKE. Collapsing them would
 * either bury a domain record in a crash journal a person has to opt in to, or turn the domain log
 * into a place stack traces live.
 *
 * `error_code` IS THE TARGET VERB'S OWN REJECTION CODE, VERBATIM. A failed run reads
 * `permission_denied` or `period_locked` or `needs_qr_iban`, which is a fact the Studio can translate
 * into the same words that verb's own screen would use. Rewriting it into an automation-flavoured
 * message would lose the one piece of information that tells the operator what to fix.
 */

import type { Capability } from '../access/capabilities.js';
import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { withheldCapability } from './disclosure.js';

export const MAX_RUN_PAGE = 200;
const DEFAULT_RUN_PAGE = 50;

interface StoredRun {
  id: string;
  rule_id: string;
  trigger_event: string;
  event_ref: string;
  status: string;
  action_tool: string;
  action_input: string;
  error_code: string | null;
  actor: string;
  redeliveries: number;
  started_at: string;
  finished_at: string | null;
}

export interface AutomationRunView {
  runId: string;
  ruleId: string;
  ruleName: string | null;
  event: string;
  eventRef: string;
  status: string;
  actionTool: string;
  /** Null when the caller could not have made this call itself. See `withheld` and `disclosure.ts`. */
  actionInput: Record<string, unknown> | null;
  /** The capability that would have been needed to see `actionInput`, or null when nothing was held back. */
  withheld: Capability | null;
  errorCode: string | null;
  actor: string;
  /** How many times this occurrence was delivered again after it was already accounted for. */
  redeliveries: number;
  startedAt: string;
  finishedAt: string | null;
}

function mapRun(ctx: WorkspaceContext, row: StoredRun & { rule_name?: string | null }): AutomationRunView {
  let actionInput: Record<string, unknown> = {};
  let parsed = true;
  try {
    actionInput = JSON.parse(row.action_input) as Record<string, unknown>;
  } catch {
    // A row whose stored input will not parse is still a row worth showing: the status, the tool and
    // the error code are the fields an operator reads first, and losing the whole entry over its
    // least important field would hide the firing entirely.
    actionInput = {};
    parsed = false;
  }
  // THE PER-ROW DISCLOSURE GATE (`disclosure.ts`). `read_automations` buys the automation FACTS;
  // the payload belongs to the domain of the verb that was fired, and the row is the only place that
  // domain is knowable, which is why this cannot live at the boundary. An unparseable payload is
  // treated as unreadable rather than as empty: `{}` would claim the firing sent nothing.
  const withheld = withheldCapability(ctx, row.action_tool, actionInput);
  return {
    runId: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name ?? null,
    event: row.trigger_event,
    eventRef: row.event_ref,
    status: row.status,
    actionTool: row.action_tool,
    actionInput: withheld === undefined && parsed ? actionInput : null,
    withheld: withheld ?? null,
    errorCode: row.error_code,
    actor: row.actor,
    redeliveries: row.redeliveries,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The Verlauf tab's read. Newest first, because the question is always "what just happened".
 *
 * The rule NAME is joined in rather than looked up per row by the client: a run row survives its
 * rule's archival (§H-AUDIT), so the alternative is a history full of ids the Studio cannot resolve.
 */
export function listAutomationRuns(
  ctx: WorkspaceContext,
  input: { ruleId?: string; status?: string; limit?: number } = {},
): Result {
  const where: string[] = ['r.workspace_id = ?'];
  const args: unknown[] = [ctx.workspaceId];
  if (typeof input.ruleId === 'string' && input.ruleId.length > 0) {
    where.push('r.rule_id = ?');
    args.push(input.ruleId);
  }
  if (typeof input.status === 'string' && input.status.length > 0) {
    where.push('r.status = ?');
    args.push(input.status);
  }
  const limit =
    typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_RUN_PAGE)
      : DEFAULT_RUN_PAGE;

  const rows = ctx.store.db
    .prepare(
      `SELECT r.*, a.name AS rule_name
         FROM automation_run r
         LEFT JOIN automation_rule a ON a.id = r.rule_id AND a.workspace_id = r.workspace_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT ?`,
    )
    .all(...args, limit) as (StoredRun & { rule_name: string | null })[];

  return ok({ runs: rows.map((row) => mapRun(ctx, row)), limit });
}

export function getAutomationRun(ctx: WorkspaceContext, input: { runId: string }): Result {
  const row = ctx.store.db
    .prepare(
      `SELECT r.*, a.name AS rule_name
         FROM automation_run r
         LEFT JOIN automation_rule a ON a.id = r.rule_id AND a.workspace_id = r.workspace_id
        WHERE r.workspace_id = ? AND r.id = ?`,
    )
    .get(ctx.workspaceId, input.runId) as (StoredRun & { rule_name: string | null }) | undefined;
  if (row === undefined) return err('not_found', { runId: input.runId });
  return ok({ run: mapRun(ctx, row) });
}
