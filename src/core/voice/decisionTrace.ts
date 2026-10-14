/**
 * D144, the decision record (E05 §10.2, A35 §11): every `decide()` answer a consumer shows a person is
 * written here FIRST, one append-only `model_decision` row, so every machine suggestion stays
 * auditable (which model, which weights, which options, which probabilities, who asked).
 *
 * ONLY A WRITE VERB RECORDS. A read verb leaves the database byte-identical (conformance rule 4), so
 * a consumer runs the model inside its write verb, records here, and its read side shows what was
 * recorded. The row holds no state: `input_sha256` fingerprints the state plus the questions, so a
 * replay can tell "already decided" without the state (which repeats facts that live in their own
 * tables) being copied into a second one. §H-TENANT: every query binds `workspace_id`.
 *
 * THE FINGERPRINT IS KEYED (critic C3). A plain SHA-256 over a bank line's facts is recomputable by
 * anyone holding the other facts and a list of names, so a pseudonymised copy would give its masked
 * counterparty back. `decisionFingerprint` is an HMAC-SHA256 under a per-workspace random key
 * (`model_decision_key`), which every environment copy randomises (landscape `SECRET_COLUMNS`) and whose
 * fingerprints `pseudonymize` re-derives from the row id. The row is still PSEUDONYMOUS data, not
 * anonymous (EDPB Guidelines 01/2025): the key holder, and the line `subject_id` names, can attribute it.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import type { DecideAnswer, DecideQuestion } from './decide.js';
import type { DecideCalibration } from './runtime.js';

export interface ModelDecisionRow {
  id: string;
  workspace_id: string;
  consumer: string;
  subject_kind: string;
  subject_id: string;
  runtime_id: string;
  model_ref: string;
  model_sha256: string;
  input_sha256: string;
  questions_json: string;
  answers_json: string;
  chosen_value: string | null;
  /** The option label the model scored for `chosen_value` (critic C10: a renamed choice is not shown). */
  chosen_label: string | null;
  chosen_probability: number | null;
  /** The model's calibration when it answered (`DecideCalibration` as JSON), or null. */
  calibration_json: string | null;
  created_by: string;
  created_at: string;
}

export interface RecordModelDecisionInput {
  consumer: string;
  subjectKind: string;
  subjectId: string;
  runtimeId: string;
  modelRef: string;
  modelSha256: string;
  inputSha256: string;
  questions: readonly DecideQuestion[];
  answers: readonly DecideAnswer[];
  /** The consumer's reading of the answer (the bank inbox: an account id), or null for none. */
  chosenValue: string | null;
  /** The option label the model scored for that value, exactly as it was offered. */
  chosenLabel: string | null;
  chosenProbability: number | null;
  /** The model row's calibration at the time it answered (owner, 30.09.2026: shown beside the percent). */
  calibration?: DecideCalibration | null;
}

/**
 * A PLAIN content digest of what a model was asked. NEVER STORED (critic C3: a plain digest of a line's
 * facts re-identifies its counterparty from a list of names); kept for callers that compare two inputs
 * in memory. What a decision row stores is `decisionFingerprint`.
 */
export function decisionInputSha256(state: string, questions: readonly DecideQuestion[]): string {
  return createHash('sha256').update(JSON.stringify({ state, questions })).digest('hex');
}

/** The STORED fingerprint: HMAC-SHA256 of the state plus the questions under the workspace's key. */
export function decisionFingerprint(key: string, state: string, questions: readonly DecideQuestion[]): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify({ state, questions })).digest('hex');
}

/** The workspace's fingerprint key, or undefined when it has none yet (no decision was ever recorded). */
export function readDecisionKey(ctx: WorkspaceContext): string | undefined {
  const row = ctx.store.db.prepare('SELECT secret FROM model_decision_key WHERE workspace_id = ?').get(ctx.workspaceId) as
    | { secret: string }
    | undefined;
  return row?.secret;
}

/** The workspace's key, minted (256 random bits) on first use. Call inside the recording transaction. */
export function ensureDecisionKey(ctx: WorkspaceContext): string {
  ctx.store.db
    .prepare('INSERT OR IGNORE INTO model_decision_key (workspace_id, secret, created_at) VALUES (?, ?, ?)')
    .run(ctx.workspaceId, randomBytes(32).toString('hex'), ctx.clock.now());
  return readDecisionKey(ctx)!;
}

/** Insert one decision row. Call inside the consumer's write transaction. */
export function recordModelDecision(ctx: WorkspaceContext, input: RecordModelDecisionInput): string {
  const id = ctx.ids.next('model_decision');
  ctx.store.db
    .prepare(
      `INSERT INTO model_decision (id, workspace_id, consumer, subject_kind, subject_id, runtime_id, model_ref, model_sha256,
         input_sha256, questions_json, answers_json, chosen_value, chosen_label, chosen_probability, calibration_json,
         created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      input.consumer,
      input.subjectKind,
      input.subjectId,
      input.runtimeId,
      input.modelRef,
      input.modelSha256,
      input.inputSha256,
      JSON.stringify(input.questions),
      JSON.stringify(input.answers),
      input.chosenValue,
      input.chosenLabel ?? null,
      input.chosenProbability,
      input.calibration === undefined || input.calibration === null ? null : JSON.stringify(input.calibration),
      ctx.actor,
      ctx.clock.now(),
    );
  return id;
}

/**
 * The decision a model already made on exactly this input, if any: a replay adds no row. Keyed on the
 * model's ref AND its sha256, the same pair `latestModelDecisions` reads (critic C7): the same weights
 * under a renamed row are a new model to the reader, so they are a new model to the writer too.
 */
export function findModelDecision(
  ctx: WorkspaceContext,
  key: { consumer: string; subjectKind: string; subjectId: string; modelRef: string; modelSha256: string; inputSha256: string },
): ModelDecisionRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT * FROM model_decision
        WHERE workspace_id = ? AND consumer = ? AND subject_kind = ? AND subject_id = ? AND model_ref = ? AND model_sha256 = ?
          AND input_sha256 = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, key.consumer, key.subjectKind, key.subjectId, key.modelRef, key.modelSha256, key.inputSha256) as
    | ModelDecisionRow
    | undefined;
}

/**
 * The newest decision per subject that the model `(modelRef, modelSha256)` made for one consumer: what
 * a read side may show while that same model is registered. One query for the whole workspace.
 */
export function latestModelDecisions(
  ctx: WorkspaceContext,
  key: { consumer: string; subjectKind: string; modelRef: string; modelSha256: string },
): Map<string, ModelDecisionRow> {
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM model_decision
        WHERE workspace_id = ? AND consumer = ? AND subject_kind = ? AND model_ref = ? AND model_sha256 = ?
        ORDER BY subject_id, created_at DESC, rowid DESC`,
    )
    .all(ctx.workspaceId, key.consumer, key.subjectKind, key.modelRef, key.modelSha256) as ModelDecisionRow[];
  const latest = new Map<string, ModelDecisionRow>();
  for (const r of rows) if (!latest.has(r.subject_id)) latest.set(r.subject_id, r);
  return latest;
}
