/**
 * D144, `decide()`: the "System One" door on the OP6 seam (E05 §10.1). Typed questions about a state
 * go in, calibrated probabilities come out. The core declares the contract and ships no model, the
 * way it does for `complete()` and `embed()`: the companion package registers an adapter that
 * implements the optional `Op6Adapter.decide`, and the suites register a deterministic stub.
 *
 * THIS IS THE ONE DOOR. A consumer never calls `adapter.decide` itself: this function checks what a
 * consumer asked for against what the registered model's manifest row declares (question types, the
 * option ceiling, the languages, a measured calibration when the consumer shows probabilities to a
 * person), calls the adapter, and validates the answer FAIL-CLOSED before anyone reads a number from
 * it. A malformed answer is `decide_failed`, never a best-effort parse: a probability that does not
 * add up is not a probability.
 *
 * NO DATABASE, NO RECORD. `decide` takes no workspace: it answers or refuses. Recording what a person
 * was shown is the consumer's job, through `recordModelDecision` (`./decisionTrace.ts`), which is why
 * the answer carries the model's ref and its pinned sha256.
 *
 * NO SOCKET. Like every OP6 operation, a registered adapter's `decide` runs under the E07 probe in the
 * suites; nothing in this module or in the core opens a network path, and no remote implementation
 * exists here to fall back to (E05 §3). An opt-in cloud decider is specified in E05 §10.3 and is
 * deliberately NOT part of the core.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { registeredRuntime } from './runtime.js';
import type { DecideCalibration } from './runtime.js';
import type { DecideQuestionType } from './enums.js';
import { isDecideQuestionType } from './enums.js';

/** One typed question. `options` for `choice`, `levels` (ordered, lowest first) for `score`. */
export type DecideQuestion =
  | { id: string; type: 'noul'; text: string }
  | { id: string; type: 'choice'; text: string; options: string[] }
  | { id: string; type: 'score'; text: string; levels: string[] };

/** One answer: the probability of yes, or one probability per option or level (summing to 1). */
export type DecideAnswer =
  | { id: string; type: 'noul'; probability: number }
  | { id: string; type: 'choice'; probabilities: number[] }
  | { id: string; type: 'score'; probabilities: number[] };

export interface DecideInput {
  /** The state the questions are about: text, or serialised JSON. */
  state: string;
  questions: readonly DecideQuestion[];
  /** ISO 639-1 codes the model's manifest row must declare (the bank inbox: de and fr, D144 item 2). */
  requireLanguages?: readonly string[];
  /** Refuse a row whose calibration was never measured (a consumer that shows probabilities to a person). */
  requireMeasuredCalibration?: boolean;
}

export type DecideOk = {
  answers: DecideAnswer[];
  runtimeId: string;
  modelRef: string;
  /** The manifest row's pinned sha256: which weights answered. */
  modelSha256: string;
  calibration: DecideCalibration;
};

/** A distribution may drift by this much from 1 in floating point before it is refused. */
export const DECIDE_SUM_TOLERANCE = 0.001;
/** The longest state `decide` hands a model, in characters: a state is a summary, never a document. */
export const DECIDE_MAX_STATE_CHARS = 8000;
/** The most questions one call may carry. */
export const DECIDE_MAX_QUESTIONS = 32;

function isProbability(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
}

/** Validate the questions against the contract and the row's ceiling; the first offending field, or null. */
function questionFault(questions: readonly DecideQuestion[], maxChoices: number): string | null {
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > DECIDE_MAX_QUESTIONS) return 'questions';
  const ids = new Set<string>();
  for (const [i, q] of questions.entries()) {
    if (q === null || typeof q !== 'object') return `questions[${i}]`;
    if (typeof q.id !== 'string' || q.id.length === 0 || ids.has(q.id)) return `questions[${i}].id`;
    ids.add(q.id);
    if (!isDecideQuestionType(q.type)) return `questions[${i}].type`;
    if (typeof q.text !== 'string' || q.text.trim().length === 0) return `questions[${i}].text`;
    if (q.type === 'choice' || q.type === 'score') {
      const list: unknown = q.type === 'choice' ? q.options : q.levels;
      const field = q.type === 'choice' ? 'options' : 'levels';
      if (!Array.isArray(list) || list.length < 2 || list.length > maxChoices) return `questions[${i}].${field}`;
      if (!list.every((o) => typeof o === 'string' && o.trim().length > 0)) return `questions[${i}].${field}`;
      if (new Set(list).size !== list.length) return `questions[${i}].${field}`;
    }
  }
  return null;
}

/**
 * Check the adapter's answers against the questions, fail-closed. Returns the answers in QUESTION
 * order with each distribution renormalised (its drift is within the tolerance by then), or the
 * reason the answer was refused.
 */
function checkAnswers(
  questions: readonly DecideQuestion[],
  raw: unknown,
): { answers: DecideAnswer[] } | { reason: string; questionId?: string } {
  if (!Array.isArray(raw)) return { reason: 'answer_malformed' };
  const byId = new Map<string, Record<string, unknown>>();
  for (const a of raw as unknown[]) {
    if (a === null || typeof a !== 'object') return { reason: 'answer_malformed' };
    const rec = a as Record<string, unknown>;
    if (typeof rec.id !== 'string') return { reason: 'answer_malformed' };
    if (byId.has(rec.id)) return { reason: 'answer_duplicated', questionId: rec.id };
    byId.set(rec.id, rec);
  }
  const unknownId = [...byId.keys()].find((id) => !questions.some((q) => q.id === id));
  if (unknownId !== undefined) return { reason: 'answer_for_unknown_question', questionId: unknownId };
  const answers: DecideAnswer[] = [];
  for (const q of questions) {
    const a = byId.get(q.id);
    if (a === undefined) return { reason: 'answer_missing', questionId: q.id };
    if (a.type !== q.type) return { reason: 'answer_malformed', questionId: q.id };
    if (q.type === 'noul') {
      if (!isProbability(a.probability)) return { reason: 'answer_malformed', questionId: q.id };
      answers.push({ id: q.id, type: 'noul', probability: a.probability });
      continue;
    }
    const n = q.type === 'choice' ? q.options.length : q.levels.length;
    const given = a.probabilities;
    if (!Array.isArray(given) || given.length !== n) return { reason: 'answer_malformed', questionId: q.id };
    // Index every slot (critic C6a): `every` and `reduce` skip the HOLES of a sparse array, so
    // `[1, <hole>, <hole>]` would pass as a distribution. A copy by index turns a hole into undefined.
    const ps: unknown[] = [];
    for (let i = 0; i < n; i += 1) ps.push((given as unknown[])[i]);
    if (!ps.every(isProbability)) return { reason: 'answer_malformed', questionId: q.id };
    const sum = (ps as number[]).reduce((s, p) => s + p, 0);
    if (Math.abs(sum - 1) > DECIDE_SUM_TOLERANCE) return { reason: 'probabilities_do_not_sum', questionId: q.id };
    const normalised = (ps as number[]).map((p) => p / sum);
    answers.push(q.type === 'choice' ? { id: q.id, type: 'choice', probabilities: normalised } : { id: q.id, type: 'score', probabilities: normalised });
  }
  return { answers };
}

/**
 * The model behind the registered adapter, as a consumer must see it before asking: the row, or the
 * refusal a consumer answers when there is none fit to ask. Pure over the process registry: it asks
 * the model nothing. `suggest_bank_lines` and the bank inbox's rung both read it, so the two cannot
 * disagree about which model may speak.
 */
export function decideModel(opts: {
  questionTypes: readonly DecideQuestionType[];
  requireLanguages?: readonly string[];
  requireMeasuredCalibration?: boolean;
}): Result<{ runtimeId: string; modelRef: string; modelSha256: string; maxChoices: number; calibration: DecideCalibration; languages: string[] }> {
  const registration = registeredRuntime();
  if (registration === undefined) return err('needs_local_runtime', {});
  const { adapter, manifest } = registration;
  if (typeof adapter.decide !== 'function') return err('needs_decide_model', { reason: 'adapter_has_no_decide', modelRef: adapter.modelRef });
  const row = manifest.find((m) => m.modelRef === adapter.modelRef);
  if (row === undefined) return err('needs_decide_model', { reason: 'model_not_in_manifest', modelRef: adapter.modelRef });
  if (row.decide === undefined) return err('needs_decide_model', { reason: 'manifest_declares_no_decide', modelRef: row.modelRef });
  const missingType = opts.questionTypes.find((t) => !row.decide!.questionTypes.includes(t));
  if (missingType !== undefined) {
    return err('needs_decide_model', { reason: 'question_type_unsupported', modelRef: row.modelRef, questionType: missingType });
  }
  const have = row.languages ?? [];
  const need = opts.requireLanguages ?? [];
  if (need.some((l) => !have.includes(l))) {
    return err('unsupported_model_language', { modelRef: row.modelRef, need: [...need], have: [...have] });
  }
  if (opts.requireMeasuredCalibration === true && row.decide.calibration.measured !== true) {
    return err('needs_decide_model', { reason: 'calibration_unmeasured', modelRef: row.modelRef });
  }
  return ok({
    runtimeId: adapter.id,
    modelRef: row.modelRef,
    modelSha256: row.sha256,
    maxChoices: row.decide.maxChoices,
    calibration: row.decide.calibration,
    languages: [...have],
  });
}

/** Ask the registered model. See the module comment: the one door, validated fail-closed. */
export function decide(input: DecideInput): Result<DecideOk> {
  if (typeof input.state !== 'string' || input.state.length === 0 || input.state.length > DECIDE_MAX_STATE_CHARS) {
    return err('invalid_input', { field: 'state' });
  }
  const questions = input.questions;
  const types = Array.isArray(questions)
    ? [...new Set(questions.map((q) => q?.type).filter((t): t is DecideQuestionType => isDecideQuestionType(t)))]
    : [];
  const model = decideModel({
    questionTypes: types,
    ...(input.requireLanguages !== undefined ? { requireLanguages: input.requireLanguages } : {}),
    ...(input.requireMeasuredCalibration !== undefined ? { requireMeasuredCalibration: input.requireMeasuredCalibration } : {}),
  });
  if (!model.ok) return model;
  const fault = questionFault(questions, model.maxChoices);
  if (fault !== null) return err('invalid_input', { field: fault });

  const adapter = registeredRuntime()!.adapter;
  let raw: unknown;
  try {
    // Critic C6b: the adapter gets its OWN copy. The caller records its questions as the audit trail
    // and fingerprints them; an adapter scribbling on what it was handed must change neither.
    raw = adapter.decide!(input.state, structuredClone(questions) as DecideQuestion[]);
  } catch (e) {
    return err('decide_failed', { reason: 'adapter_threw', modelRef: model.modelRef, message: e instanceof Error ? e.message : String(e) });
  }
  const checked = checkAnswers(questions, raw);
  if ('reason' in checked) {
    return err('decide_failed', { reason: checked.reason, modelRef: model.modelRef, ...(checked.questionId !== undefined ? { questionId: checked.questionId } : {}) });
  }
  return ok({
    answers: checked.answers,
    runtimeId: model.runtimeId,
    modelRef: model.modelRef,
    modelSha256: model.modelSha256,
    calibration: model.calibration,
  });
}
