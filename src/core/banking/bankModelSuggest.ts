/**
 * A39 §12 (D144), `suggest_bank_lines`: the model rung's WRITE half. For each open line whose ladder
 * ends at `open`, code builds the candidate accounts, the registered model answers ONE `choice`
 * question, and the answer is recorded as a `model_decision` row (E05 §10.2, A35 §11) before anything
 * shows it. The inbox then reads the record (`bankModelRung.ts`); it never runs a model itself.
 *
 * WHAT IT DOES NOT DO. It posts nothing, books nothing, and changes no line's state: a suggestion is
 * confirmed only through `book_bank_line` and the A26 dial, exactly like every other proposal. It is on
 * the G01 denylist (a model nobody asked is a model nobody watches) and outside the dial (no posting).
 *
 * REFUSALS ARE NEVER MEMOISED, and they come before any model call: no runtime (`needs_local_runtime`),
 * no chosen model (`needs_model_selection`, E05 US-E05.5), a model that cannot decide a `choice` or
 * whose calibration was never measured (`needs_decide_model`), one that lacks German or French
 * (`unsupported_model_language`, D144 item 2). A model failing MID-BATCH answers `decide_failed` and
 * records nothing.
 *
 * IDEMPOTENT ON ROWS. A line whose input (state plus candidates) this same model already decided is
 * `unchanged` and adds no row, so a second key moves nothing either; the same key replays its stored
 * answer. The model runs OUTSIDE the write transaction (a local model may take half a second a line),
 * and the rows land in one. §H-TENANT: every id is resolved inside the workspace, a foreign one is
 * `not_found`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import {
  decide,
  decisionFingerprint,
  ensureDecisionKey,
  findModelDecision,
  readDecisionKey,
  readRuntimeSelection,
  recordModelDecision,
} from '../voice/index.js';
import type { DecideQuestion } from '../voice/index.js';
import { LINE_STATE_EXPR, LINE_STATE_JOINS } from './bankLines.js';
import type { BankTxnDetailRow, BankTxnRow } from './bankLines.js';
import { proposalContext, proposeForLine } from './bankProposals.js';
import {
  BANK_INBOX_MODEL_CONSUMER,
  BANK_INBOX_MODEL_LANGUAGES,
  BANK_INBOX_MODEL_SUBJECT,
  MODEL_SUGGEST_MIN_PROBABILITY,
  MODEL_SUGGEST_TOP_K,
  bankInboxDecideModel,
  bankLineCandidates,
  bankLineDecisionState,
  bankLineQuestion,
  modelCandidateBase,
} from './bankModelRung.js';
import type { ModelCandidate } from './bankModelRung.js';

/**
 * The most lines one call PUTS TO THE MODEL; `remaining` counts the rest. A line this model already
 * decided on the same input is reported `unchanged` and does not count (critic C1): otherwise the
 * newest 50 decided lines would fill every later batch and line 51 would never be reached.
 */
export const MODEL_SUGGEST_BATCH_MAX = 50;
/** The most `bankTxnIds` one call may name: a page of the inbox (the Studio sends the lines in view). */
export const MODEL_SUGGEST_IDS_MAX = 200;

/** Why a line in scope was not put to the model. */
export const MODEL_SUGGEST_SKIP_REASONS = ['not_open', 'has_proposal', 'too_few_candidates'] as const;
export type ModelSuggestSkipReason = (typeof MODEL_SUGGEST_SKIP_REASONS)[number];

export interface SuggestBankLinesInput {
  bankAccountId?: unknown;
  bankTxnIds?: unknown;
  idempotencyKey?: unknown;
}

export type SuggestBankLinesDecision = {
  bankTxnId: string;
  decisionId: string;
  /** The chosen account, or null when the model's best choice stayed below the floor. */
  accountId: string | null;
  probability: number | null;
  unchanged: boolean;
};

export type SuggestBankLinesOk = {
  runtimeId: string;
  modelRef: string;
  modelSha256: string;
  /** Lines put to the model (or found already decided) in this call. */
  considered: number;
  /** Decisions whose choice clears the floor and now shows on its line. */
  suggested: number;
  /** Decisions recorded with no choice: the best probability stayed below the floor, or tied (critic C5a). */
  belowFloor: number;
  /** Lines this model had already decided on the same input: no new row. */
  unchanged: number;
  /** Eligible lines beyond this call's batch. */
  remaining: number;
  skipped: Record<ModelSuggestSkipReason, number>;
  decisions: SuggestBankLinesDecision[];
};

type LineRow = BankTxnRow & BankTxnDetailRow & { line_state: string };

interface Pending {
  row: LineRow;
  candidates: ModelCandidate[];
  question: DecideQuestion;
  /** The state the model read: kept in memory only, to fingerprint it under the workspace key. */
  state: string;
  probabilities: number[] | null;
  existingId: string | null;
  existingChosen: string | null;
  existingProbability: number | null;
}

function readLines(ctx: WorkspaceContext, bankAccountId: string | undefined, ids: string[] | undefined): LineRow[] {
  const clauses = ['t.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (bankAccountId !== undefined) {
    clauses.push('t.bank_account_id = ?');
    params.push(bankAccountId);
  }
  if (ids !== undefined) {
    clauses.push(`t.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  } else {
    clauses.push(`${LINE_STATE_EXPR('t')} = 'open'`);
  }
  return ctx.store.db
    .prepare(
      `SELECT t.*, ${LINE_STATE_EXPR('t')} AS line_state,
              d2.counterparty_name, d2.counterparty_iban, d2.remittance_text, d2.end_to_end_id
         FROM bank_txn t ${LINE_STATE_JOINS('t')}
         LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10)) DESC, t.rowid DESC`,
    )
    .all(...params) as LineRow[];
}

function detailOf(r: LineRow): BankTxnDetailRow {
  return {
    counterparty_name: r.counterparty_name,
    counterparty_iban: r.counterparty_iban,
    remittance_text: r.remittance_text,
    end_to_end_id: r.end_to_end_id,
  };
}

/** Two probabilities closer than this are a tie: the model expressed no preference between them. */
const TIE_EPSILON = 1e-9;

/**
 * Argmax of a distribution: index, probability, and whether it is a CLEAR winner. A tie at the top is
 * no choice at all (critic C5a): taking the first index would show the code's candidate order as the
 * model's preference.
 */
function best(ps: readonly number[]): { index: number; p: number; clear: boolean } {
  let index = 0;
  for (let i = 1; i < ps.length; i += 1) if (ps[i]! > ps[index]!) index = i;
  const runnerUp = ps.reduce((m, q, i) => (i === index ? m : Math.max(m, q)), 0);
  return { index, p: ps[index]!, clear: ps[index]! - runnerUp > TIE_EPSILON };
}

export function suggestBankLines(ctx: WorkspaceContext, input: SuggestBankLinesInput): Result<SuggestBankLinesOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const keyGuard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (keyGuard) return keyGuard;
  const bankAccountId = input.bankAccountId;
  if (bankAccountId !== undefined && (typeof bankAccountId !== 'string' || bankAccountId.length === 0)) {
    return err('invalid_input', { field: 'bankAccountId' });
  }
  let ids: string[] | undefined;
  if (input.bankTxnIds !== undefined) {
    const raw = input.bankTxnIds;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > MODEL_SUGGEST_IDS_MAX ||
      !raw.every((x) => typeof x === 'string' && x.length > 0)
    ) {
      return err('invalid_input', { field: 'bankTxnIds', max: MODEL_SUGGEST_IDS_MAX });
    }
    ids = [...new Set(raw as string[])];
  }

  const verb = 'suggest_bank_lines';
  const scopedKey = JSON.stringify([verb, bankAccountId ?? null, ids ?? null, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<SuggestBankLinesOk>>(ctx.workspaceId, scopedKey, verb);
  if (replayed !== undefined) return replayed;

  if (bankAccountId !== undefined) {
    const found = ctx.store.db.prepare('SELECT 1 AS p FROM bank_account WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, bankAccountId);
    if (found === undefined) return err('not_found', { field: 'bankAccountId', bankAccountId });
  }

  // §H-TENANT first: a foreign id is `not_found` whatever the model; then the model rules, before any
  // line is put to it.
  const rows = readLines(ctx, bankAccountId as string | undefined, ids);
  if (ids !== undefined) {
    const seen = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !seen.has(id));
    if (missing.length > 0) return err('not_found', { field: 'bankTxnIds', bankTxnIds: missing });
  }
  const model = bankInboxDecideModel();
  if (!model.ok) return model;
  if (readRuntimeSelection(ctx) === undefined) return err('needs_model_selection', {});

  const skipped: Record<ModelSuggestSkipReason, number> = { not_open: 0, has_proposal: 0, too_few_candidates: 0 };
  const pc = proposalContext(ctx, { withModel: false });
  const base = modelCandidateBase(ctx);
  const k = Math.min(MODEL_SUGGEST_TOP_K, model.maxChoices);
  const pending: Pending[] = [];
  let remaining = 0;
  /** Lines put to the model in this call: the only thing the batch cap counts (critic C1). */
  let asked = 0;
  // Critic C3: the stored fingerprint is keyed. No key yet means no decision was ever recorded here,
  // so there is nothing to find; the key is minted inside the recording transaction.
  const key = readDecisionKey(ctx);

  for (const row of rows) {
    if (row.line_state !== 'open') {
      skipped.not_open += 1;
      continue;
    }
    const detail = detailOf(row);
    if (proposeForLine(ctx, pc, row, detail).reasonCode !== 'no_proposal') {
      skipped.has_proposal += 1;
      continue;
    }
    const candidates = bankLineCandidates(base, row, detail, k);
    if (candidates.length < 2) {
      skipped.too_few_candidates += 1;
      continue;
    }
    const question = bankLineQuestion(candidates);
    const state = bankLineDecisionState(row, detail);
    const existing =
      key === undefined
        ? undefined
        : findModelDecision(ctx, {
            consumer: BANK_INBOX_MODEL_CONSUMER,
            subjectKind: BANK_INBOX_MODEL_SUBJECT,
            subjectId: row.id,
            modelRef: model.modelRef,
            modelSha256: model.modelSha256,
            inputSha256: decisionFingerprint(key, state, [question]),
          });
    if (existing !== undefined) {
      pending.push({
        row,
        candidates,
        question,
        state,
        probabilities: null,
        existingId: existing.id,
        existingChosen: existing.chosen_value,
        existingProbability: existing.chosen_probability,
      });
      continue;
    }
    if (asked >= MODEL_SUGGEST_BATCH_MAX) {
      remaining += 1;
      continue;
    }
    asked += 1;
    // The model runs here, outside any transaction.
    const answered = decide({ state, questions: [question], requireLanguages: BANK_INBOX_MODEL_LANGUAGES, requireMeasuredCalibration: true });
    if (!answered.ok) return answered;
    if (answered.modelSha256 !== model.modelSha256) {
      // The registration changed under the call: nothing is recorded against the wrong weights.
      return err('decide_failed', { reason: 'model_changed', modelRef: answered.modelRef });
    }
    const a = answered.answers[0];
    if (a === undefined || a.type !== 'choice') return err('decide_failed', { reason: 'answer_malformed', modelRef: answered.modelRef });
    pending.push({ row, candidates, question, state, probabilities: a.probabilities, existingId: null, existingChosen: null, existingProbability: null });
  }

  const compute = (): Result<SuggestBankLinesOk> => {
    const decisions: SuggestBankLinesDecision[] = [];
    let suggested = 0;
    let belowFloor = 0;
    let unchanged = 0;
    const recordKey = pending.some((p) => p.existingId === null) ? ensureDecisionKey(ctx) : key;
    for (const p of pending) {
      const inputSha256 = p.existingId === null ? decisionFingerprint(recordKey!, p.state, [p.question]) : '';
      // A concurrent call may have recorded the same input since it was read: never twice.
      const already =
        p.existingId !== null
          ? { id: p.existingId, chosen_value: p.existingChosen, chosen_probability: p.existingProbability }
          : findModelDecision(ctx, {
              consumer: BANK_INBOX_MODEL_CONSUMER,
              subjectKind: BANK_INBOX_MODEL_SUBJECT,
              subjectId: p.row.id,
              modelRef: model.modelRef,
              modelSha256: model.modelSha256,
              inputSha256,
            });
      let id: string;
      let chosen: string | null;
      let probability: number | null;
      let isUnchanged: boolean;
      if (already !== undefined) {
        id = already.id;
        chosen = already.chosen_value;
        probability = already.chosen_probability;
        isUnchanged = true;
        unchanged += 1;
      } else {
        const top = best(p.probabilities!);
        const clears = top.clear && top.p >= MODEL_SUGGEST_MIN_PROBABILITY;
        chosen = clears ? p.candidates[top.index]!.accountId : null;
        const chosenLabel = clears ? p.candidates[top.index]!.label : null;
        probability = top.p;
        id = recordModelDecision(ctx, {
          consumer: BANK_INBOX_MODEL_CONSUMER,
          subjectKind: BANK_INBOX_MODEL_SUBJECT,
          subjectId: p.row.id,
          runtimeId: model.runtimeId,
          modelRef: model.modelRef,
          modelSha256: model.modelSha256,
          inputSha256,
          questions: [p.question],
          answers: [{ id: p.question.id, type: 'choice', probabilities: p.probabilities! }],
          chosenValue: chosen,
          chosenLabel,
          chosenProbability: probability,
          calibration: model.calibration,
        });
        isUnchanged = false;
      }
      if (chosen !== null && probability !== null && probability >= MODEL_SUGGEST_MIN_PROBABILITY) suggested += 1;
      else belowFloor += 1;
      decisions.push({ bankTxnId: p.row.id, decisionId: id, accountId: chosen, probability, unchanged: isUnchanged });
    }
    return ok<SuggestBankLinesOk>({
      runtimeId: model.runtimeId,
      modelRef: model.modelRef,
      modelSha256: model.modelSha256,
      considered: pending.length,
      suggested,
      belowFloor,
      unchanged,
      remaining,
      skipped,
      decisions,
    });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, verb, compute);
}
