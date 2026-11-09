/**
 * A26's verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `recurringActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * FOUR READS (the three convenience reads plus A35's `list_drafted_actions`, the queue's missing
 * read face), the dial PAIR, the two inbox verbs, and A35's two human-side writes over agent
 * artifacts (`agent_ask`, the D90 D-1 composer; `agent_prose_delete`, the D90 D-5 erasure). A26
 * adds no agent-only financial or customization WRITE tool beyond the dial itself (§6b Fixed): the
 * categorize-and-post, invoice and customization stories all reach the existing A00-A25 / G00-G02
 * verbs, routed through the dial at the transport seam (`agent-gate.ts`).
 *
 * `approve_drafted_action` HOLDS AN `ActionInvoker` (the G01 / A12 fire-path shape): approving replays
 * the drafted verb through the SHARED dispatch as the approver, never by a second write path, so it
 * gets the same tenant/boundary/A24/throw guards for free. `assertActionInvokersAreGated` is called
 * over it at module load, the same handshake `recurring-actions.ts` performs, so it can never become
 * ungated without a crash on import.
 *
 * The helpers arrive as a parameter rather than an import, so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import type { ActionInvoker } from '../core/automation/index.js';
import { assertActionInvokersAreGated } from '../core/access/index.js';
import {
  ledgerQa,
  monthEndChecklist,
  detectAnomalies,
  getAgentDial,
  setAgentDial,
  listDraftedActions,
  approveDraftedAction,
  rejectDraftedAction,
  agentAsk,
  agentProseDelete,
} from '../core/agent/index.js';
import type { ActionKind } from './actionKind.js';
import { withBelege } from './chat-belege-actions.js';
import { evidenceContext, vorschlagEvidenceOf } from '../core/banking/belegEvidence.js';
import type { EvidenceContext } from '../core/banking/belegEvidence.js';

/**
 * A41.2 (D184): every PENDING `book_bank_line` row carries `evidence`, the engine's own judgement of the
 * agent's target (its certainty, never the agent's word), the receipts it would carry and the VAT figures;
 * null when the line is gone or no longer open. Every other row carries no `evidence` key. Read time only.
 */
function withEvidence(ctx: WorkspaceContext, listed: Result): Result {
  if (!listed.ok) return listed;
  const actions = (listed as unknown as { actions?: Record<string, unknown>[] }).actions;
  if (!Array.isArray(actions) || !actions.some((a) => a.status === 'pending' && a.actionTool === 'book_bank_line')) return listed;
  let ec: EvidenceContext | null = null;
  return {
    ...listed,
    actions: actions.map((a) => {
      if (a.status !== 'pending' || a.actionTool !== 'book_bank_line') return a;
      ec ??= evidenceContext(ctx);
      const payload = a.payload !== null && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};
      return { ...a, evidence: vorschlagEvidenceOf(ctx, ec, payload) };
    }),
  } as Result;
}
import { storeVorschlagHolders, withReceiptOverride, type ReceiptHolder } from '../core/files/receiptGuard.js';

/**
 * R1 (N02): approve a Vorschlag with the approver's own confirmation of a second booking of a receipt in
 * force, judged against the holders AT APPROVAL TIME. A holder the card did not show refuses
 * `holders_changed`, and the card then shows the new list (stored in a transaction of its own: the act's
 * rolled back), so the next approval decides on what it sees.
 */
function approveWithReceiptConfirmation(ctx: WorkspaceContext, input: ActionInput, approve: () => Result): Result {
  const actionId = typeof input.actionId === 'string' ? input.actionId : null;
  const outcome = withReceiptOverride({ bookAgain: input.bookAgain, overrideReason: input.overrideReason, approvingActionId: actionId }, approve);
  if (!outcome.ok && outcome.error === 'holders_changed' && actionId !== null && Array.isArray(outcome.holders)) {
    const holders = outcome.holders as ReceiptHolder[];
    ctx.store.tx(() => storeVorschlagHolders(ctx, actionId, holders));
  }
  return outcome;
}

export interface AgentActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** Builds the invoker that reaches the shared dispatch. Supplied by `registry.ts`, which owns it. */
  invokerFor(deps: ApiDeps): ActionInvoker;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The A26 verbs, in append order. */
export function agentActions(h: AgentActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, invokerFor, STR, BOOL } = h;

  const actions: readonly ActionDef[] = [
    ctxAction(
      'ledger_qa',
      'read',
      'Answer a question from the books without opening a report: Umsatz (turnover), offene Posten (open debtors) or MWST (VAT). Reads the existing A08/A16/A07 models and never mutates; a VAT question needs periodStart and periodEnd.',
      ctxSchema({ question: STR, periodStart: STR, periodEnd: STR }, ['question']),
      (ctx, input) => ledgerQa(ctx, as(input)),
    ),
    ctxAction(
      'month_end_checklist',
      'read',
      'A month-end close checklist (period YYYY-MM): dangling drafts (A02), open debtors (A16), open creditor bills (A17) and a MWST preview (A07), each with drill-down ids. Writes nothing; FX revaluation is reported as not_available until A22 builds it.',
      ctxSchema({ period: STR }, ['period']),
      (ctx, input) => monthEndChecklist(ctx, as(input)),
    ),
    ctxAction(
      'detect_anomalies',
      'read',
      'Surface likely mistakes as flags, never auto-corrections: probable duplicate entries, stale drafts, missing tax codes and round-number outliers over the posted ledger (optional period YYYY or YYYY-MM). Writes nothing; the user confirms before any fix is drafted.',
      ctxSchema({ period: STR }),
      (ctx, input) => detectAnomalies(ctx, as(input)),
    ),
    ctxAction(
      'get_agent_dial',
      'read',
      'Read the raw approval-dial levels for every governed capability (post, issue, send, dun, pay, vat-file, customize, plugin-install, close-period, go-live). Each defaults to ask when never set. Owner-facing view of what the agent may auto-execute versus draft.',
      ctxSchema(),
      (ctx) => getAgentDial(ctx),
    ),
    ctxAction(
      'set_agent_dial',
      'write:reversible:access',
      'Set one approval-dial level to ask or auto for one governed capability (post/issue/send/dun/pay/vat-file/customize/plugin-install/close-period/go-live). ask drafts the agent write for human approval; auto executes it when RBAC also permits. An unknown capability or level is rejected. Owner-only (manage_agent_dial).',
      ctxSchema({ capability: STR, level: STR, idempotencyKey: STR }, ['capability', 'level', 'idempotencyKey']),
      (ctx, input) => setAgentDial(ctx, as(input)),
    ),
    ctxAction(
      'list_drafted_actions',
      'read',
      'List the drafted agent actions (Vorschläge) of a workspace: pending by default (oldest first), or executed/rejected via status. Each row carries its verb, parsed payload, dial capability, proposer and resolution, so the approval queue renders from one read on every face. A pending row whose approval links Belege names them under belege (file name, type, size, and whether the agent attached it, a person dropped it, or it is an existing file); files_pending_preview reads one for the person who decides. A41: a pending book_bank_line row carries evidence { certainty (sure | learned | check | open), agrees, reasons (agrees | differs_from_engine | no_engine_proposal | beleg_amount_differs | vat_differs | vat_rounding | vat_not_booked (a note: the receipt states VAT, the booking taxes no leg) | vat_not_compared (a note: the receipt states its VAT in another currency) | belege_not_readable: the receipts were judged but this seat may not read them, so no figure is shown and the certainty is check), engine { certainty, reasonCode, reasonParams, target }, belege [{ fileId, captureId, amountMinor, currency, amountAgrees }], vat { belegMinor, computedMinor, deltaMinor, toleranceMinor, withinTolerance, currency? (of the receipt, when not that of the line), untaxed? (computedMinor 0: the booking taxes no leg), notCompared? } | null }: TILL\'s own proposal for the line compared with the agent\'s target (same booking: the engine\'s certainty; different or none: check), each receipt it would carry against the line amount, and the receipt\'s printed VAT against the computed VAT (belege.vat_delta_tolerance_rappen); the agent\'s agentReason is never the source of the certainty, and TILL always books the computed VAT; null when the line is no longer open.',
      ctxSchema({ status: STR }),
      // N02 (critic round 2): the Belege a pending Vorschlag will link ride on the row (`withBelege`).
      (ctx, input) => withEvidence(ctx, withBelege(ctx, listDraftedActions(ctx, as(input)))),
    ),
    // The one A26 verb holding an invoker: registered through the same handshake G01/A12 use, below.
    ctxAction(
      'approve_drafted_action',
      'write:final:access',
      'Approve a drafted agent action from the inbox: replay its verb through the shared dispatch as the approver (RBAC re-checked, idempotent on the stored key, so approve-twice never double-posts) and mark it executed. allowFuture additionally records the standing per-capability grant to auto (D103): the same attributed, revocable dial write set_agent_dial performs. The agent can never self-approve; a second, independent actor must review. Owner-gated (manage_agent_dial). Receipt uniqueness (R1): when the act would book a receipt that already evidences another live booking, the approval is judged against the holders as they are NOW: a holder the card did not show refuses holders_changed (the card then lists it), and a holder it showed needs bookAgain: true with an overrideReason (receipt_already_booked otherwise), recorded on the audit chain.',
      ctxSchema({ actionId: STR, allowFuture: BOOL, bookAgain: BOOL, overrideReason: STR }, ['actionId']),
      (ctx, input, deps) => approveWithReceiptConfirmation(ctx, input, () => approveDraftedAction(ctx, invokerFor(deps), as(input))),
    ),
    ctxAction(
      'reject_drafted_action',
      'write:correctable:human-only',
      'Reject a drafted agent action from the inbox: drop it unexecuted (idempotent on actionId; an already-executed action refuses). reason is the human\'s optional sentence on why, stored on the proposal and shown in the trace beside the drafting call, so the next session reads it. Owner-gated (manage_agent_dial).',
      ctxSchema({ actionId: STR, reason: STR }, ['actionId']),
      (ctx, input) => rejectDraftedAction(ctx, as(input)),
    ),
    ctxAction(
      'agent_ask',
      'write:correctable:internal',
      'Ask the books a question in prose (the Studio composer, D90 D-1). Needs a registered E05 local runtime (needs_local_runtime otherwise); the runtime only classifies the question onto one of the three A26 read models and the executed verb is ALWAYS a read, so no write is reachable from prose. Persists the sentence as a turn (D-5) and records the answering call in the trace.',
      ctxSchema({ text: STR, periodStart: STR, periodEnd: STR, idempotencyKey: STR }, ['text', 'idempotencyKey']),
      (ctx, input) => agentAsk(ctx, as(input)),
    ),
    ctxAction(
      'agent_prose_delete',
      'write:final:erase',
      'Delete one agent session’s stored prose (D90 D-5): every turn text of the session is cleared, the call trace stays. The words are the user’s to remove; what actually ran is the trust view’s substrate and remains. Owner-gated (manage_agent_dial); idempotent per key.',
      ctxSchema({ sessionId: STR, idempotencyKey: STR }, ['sessionId', 'idempotencyKey']),
      (ctx, input) => agentProseDelete(ctx, as(input)),
    ),
  ];

  // The load-time handshake (A24): a verb that can invoke another verb as a different actor may never
  // be ungated. The fact is supplied here, the rule lives in `actionCapabilities.ts`.
  assertActionInvokersAreGated(['approve_drafted_action']);
  return actions;
}

export type { ApiDeps };
