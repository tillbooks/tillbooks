/**
 * A35 THE COMPOSER VERB (`agent_ask`, D90 D-1): the one door prose enters TILL through.
 *
 * THE RUNTIME IS THE GATE AND THE CLASSIFIER, NEVER THE ANSWERER. D90 D-1 chose a composer bound to
 * E05's local runtime, and named the risk in the same breath: a small local model choosing among
 * hundreds of verbs on the money path. This verb manages that risk BY CONSTRUCTION: the runtime's
 * completion is parsed against a CLOSED intent set (the three A26 read models), an unparseable
 * answer falls back to `ledger_qa`'s own deterministic keyword classifier, and the executed verb is
 * always a READ. No write is reachable from prose, so the composer cannot touch the money path at
 * all, and every figure in every answer is computed by the statutory owner of that figure, never by
 * a model.
 *
 * With no runtime registered (the shipped OSS core: the companion package registers one at startup)
 * the verb refuses `needs_local_runtime`, and the Studio renders NO input anywhere (design row
 * 14.2): the honest absent state, not a broken one.
 *
 * D90 D-5: the prose persists on the turn (workspace-scoped, excluded from every A25 export,
 * deletable per session via `agent_prose_delete`, pruned with the trace).
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { registeredRuntime } from '../voice/index.js';
import { ledgerQa } from './ledgerQa.js';
import { monthEndChecklist } from './checklist.js';
import { detectAnomalies } from './anomalies.js';
import { insertCall, recordProseTurn, resolveAgentSession } from './trace.js';

export interface AgentAskInput {
  text?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  idempotencyKey?: unknown;
}

const INTENTS = ['ledger_qa', 'month_end_checklist', 'detect_anomalies'] as const;
type ComposerIntent = (typeof INTENTS)[number];

/**
 * Ask the runtime which read model answers the question, and trust its answer ONLY when it names a
 * member of the closed set verbatim. Anything else (prose, hedging, a verb we did not offer, a
 * thrown adapter) falls back to the deterministic classifier, so the model can route a question and
 * can never invent a capability.
 */
function classifyWithRuntime(complete: (prompt: string) => string, text: string): ComposerIntent {
  try {
    const answer = complete(
      'Classify this bookkeeping question into exactly one of: ledger_qa (a figure question: turnover, ' +
        'open items, VAT), month_end_checklist (closing a month), detect_anomalies (finding mistakes). ' +
        `Reply with the single identifier only.\nQuestion: ${text}`,
    )
      .trim()
      .toLowerCase();
    const hit = INTENTS.find((intent) => answer === intent);
    if (hit !== undefined) return hit;
  } catch {
    // A broken adapter must not break the question: the deterministic fallback answers.
  }
  return 'ledger_qa';
}

/** A YYYY-MM mentioned in the question, for the checklist/anomaly intents. Deterministic, no model. */
function periodIn(text: string): string | undefined {
  const m = /(\d{4})-(\d{2})/.exec(text);
  return m === null ? undefined : `${m[1]}-${m[2]}`;
}

export function agentAsk(ctx: WorkspaceContext, input: AgentAskInput): Result {
  const guard = requireString(input.text, 'text') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const text = (input.text as string).trim();
  if (text.length === 0) return err('invalid_input', { field: 'text' });
  const key = input.idempotencyKey as string;

  // Replay a completed ask BEFORE the runtime guard (the store's own recall-first pattern): a retry
  // of a finished question must answer the same thing even if the runtime was unloaded in between.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'agent_ask');
  if (replayed !== undefined) return replayed;

  const runtime = registeredRuntime();
  if (runtime === undefined) return err('needs_local_runtime', {});

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'agent_ask', () => {
    const sessionId = resolveAgentSession(ctx, {
      transportKey: `composer:${ctx.actor}`,
      clientLabel: 'TILL Composer',
    });
    recordProseTurn(ctx, sessionId, 'user', text);

    const intent = classifyWithRuntime((p) => runtime.adapter.complete(p), text);
    const period = periodIn(text);
    const started = Date.now();
    let verb: string;
    let answer: Result;
    if (intent === 'month_end_checklist' && period !== undefined) {
      verb = 'month_end_checklist';
      answer = monthEndChecklist(ctx, { period });
    } else if (intent === 'detect_anomalies') {
      verb = 'detect_anomalies';
      answer = detectAnomalies(ctx, period !== undefined ? { period } : {});
    } else {
      verb = 'ledger_qa';
      answer = ledgerQa(ctx, {
        question: text,
        ...(typeof input.periodStart === 'string' ? { periodStart: input.periodStart } : {}),
        ...(typeof input.periodEnd === 'string' ? { periodEnd: input.periodEnd } : {}),
      });
    }

    // The answer becomes an agent turn with its one READ call recorded, so the composer exchange is
    // as legible after the fact as an external client's calls are. The turn carries NO fabricated
    // prose: the Studio derives its display line from the structured answer.
    const turnId = recordProseTurn(ctx, sessionId, 'agent', null);
    insertCall(ctx, turnId, {
      verb,
      kind: 'read',
      argsJson: JSON.stringify({ question: text, ...(period !== undefined ? { period } : {}) }),
      mode: 'execute',
      decisionReason: 'read',
      callOk: answer.ok,
      ...(answer.ok ? {} : { errorCode: answer.error }),
      durationMs: Date.now() - started,
    });

    if (!answer.ok) {
      // The one refusal a composer answer forwards structurally (class 4): the caller supplies the
      // missing input in place and re-issues. Everything else in the read models answers ok.
      return answer;
    }
    return ok({ sessionId, turnId, verb, answer });
  });
}
