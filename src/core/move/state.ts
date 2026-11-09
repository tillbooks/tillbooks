/**
 * M03, the Hosting panel's move checklist resume pointer (spec §3.1, the Move record).
 *
 * TWO VERBS OVER ONE ROW, AND THE ROW IS BOOKKEEPING, NEVER A GATE: the G03
 * `getOnboardingProgress`/`advanceOnboardingStep` precedent, applied to the go-online journey.
 * `advanceMoveStep` is an absolute upsert of the per-workspace move pointer (direction plus which
 * of the five checklist steps are done) so a closed tab resumes at the first unchecked step, and
 * `getMoveState` reads it back. Nothing in the engine consults this row to decide whether any verb
 * may run: the real actions of the journey (`create_backup`, `archive_workspace`, the manual legs)
 * keep their own validation, which is why a replayed or skipped step costs nothing. That is also
 * why the write sits on the conformance idempotency-key exemption list: re-asserting the same
 * pointer is the idempotency (a done step keeps its ORIGINAL timestamp on replay, COALESCE below).
 *
 * WHAT THE FIELDS MEAN, honestly:
 *  - `direction` is which way the books are moving (§H-ENUM, `MOVE_DIRECTIONS`). Asserting a
 *    DIFFERENT direction than the stored one is a fresh start: the step states reset, because the
 *    five steps of "local to self-host" are not the five steps of "managed to local".
 *  - `stepN_at` is when the human (or agent) checked step N off. Steps 2 and 3 are MANUAL legs the
 *    Studio cannot verify (they happen on another machine); the timestamp records the claim, not a
 *    proof, and the surface says so (spec §4 V3, data honesty).
 *  - `completed_at` is derived: stamped when all five steps are done, cleared when one is un-done
 *    (unlike G03's wizard, un-checking step 4 after a failed trial-balance comparison genuinely
 *    un-completes the move; pretending otherwise would keep the S7.5 notice alive on a move that
 *    is admittedly not finished).
 *  - A COMPLETED row is kept, never deleted: the S7.5 stale-writable notice needs it (see
 *    `schema.ts`). `abandon: true` deletes the row, which is the checklist's "Umzug abbrechen".
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { WorkspaceContext } from '../context.js';

// --- §H-ENUM: the move directions, single-sourced here -----------------------------------------

/**
 * Every leg of the D104 ladder a move can traverse (spec §3.1). Both directions exist for every
 * pair because exit is a first-class journey (S6.1), not an error path.
 */
export const MOVE_DIRECTIONS = [
  'local_to_selfhost',
  'local_to_managed',
  'selfhost_to_managed',
  'selfhost_to_local',
  'managed_to_local',
  'managed_to_selfhost',
] as const;

export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

export function isMoveDirection(value: unknown): value is MoveDirection {
  return typeof value === 'string' && (MOVE_DIRECTIONS as readonly string[]).includes(value);
}

/** The checklist is FIXED at five steps in every direction (spec §4 V3: the structure may not vary). */
export const MOVE_STEP_COUNT = 5;

interface MoveRow {
  direction: string;
  step1_at: string | null;
  step2_at: string | null;
  step3_at: string | null;
  step4_at: string | null;
  step5_at: string | null;
  started_at: string;
  completed_at: string | null;
}

/** One checklist step as the wire sees it: its 1-based number and when it was checked off (or null). */
export interface MoveStep {
  step: number;
  doneAt: string | null;
}

export interface MoveState {
  direction: string;
  steps: MoveStep[];
  startedAt: string;
  completedAt: string | null;
}

export type GetMoveStateOk = {
  /** The workspace's move pointer, or null when no move was ever started (or it was abandoned). */
  move: MoveState | null;
};

const SELECT_ROW =
  'SELECT direction, step1_at, step2_at, step3_at, step4_at, step5_at, started_at, completed_at' +
  ' FROM move_record WHERE workspace_id = ?';

function toState(row: MoveRow): MoveState {
  const stamps = [row.step1_at, row.step2_at, row.step3_at, row.step4_at, row.step5_at];
  return {
    direction: row.direction,
    steps: stamps.map((doneAt, i) => ({ step: i + 1, doneAt })),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** The move checklist resume point, or null (spec §3.1; §H-TENANT: the one row is keyed by workspace). */
export function getMoveState(ctx: WorkspaceContext): Result<GetMoveStateOk> {
  const row = ctx.store.db.prepare(SELECT_ROW).get(ctx.workspaceId) as MoveRow | undefined;
  return ok<GetMoveStateOk>({ move: row === undefined ? null : toState(row) });
}

export interface AdvanceMoveStepInput {
  direction: unknown;
  step?: unknown;
  done?: unknown;
  abandon?: unknown;
}

export type AdvanceMoveStepOk = GetMoveStateOk;

/**
 * Persist the move pointer, absolutely (spec §2 S3.1/S3.4; the G03 `advanceOnboardingStep` shape).
 *
 *  - `{direction}` alone starts (or re-asserts) the move: the "Umzug starten" press.
 *  - `{direction, step, done?}` checks step 1..5 off (`done` defaults true) or un-checks it
 *    (`done: false`, the step-4 mismatch recovery).
 *  - `{direction, abandon: true}` deletes the row: "Umzug abbrechen". Replaying an abandon of an
 *    already-absent row succeeds and returns `move: null`, the same absolute-state contract as the
 *    rest of the verb.
 *
 * A direction different from the stored one resets the checklist (a fresh `started_at`, all steps
 * unchecked): the steps of one direction are not evidence about another's.
 */
export function advanceMoveStep(
  ctx: WorkspaceContext,
  input: AdvanceMoveStepInput,
): Result<AdvanceMoveStepOk> {
  if (!isMoveDirection(input.direction)) return err('invalid_direction', { direction: input.direction });
  if (input.abandon !== undefined && typeof input.abandon !== 'boolean') {
    return err('invalid_input', { field: 'abandon' });
  }
  if (input.done !== undefined && typeof input.done !== 'boolean') {
    return err('invalid_input', { field: 'done' });
  }
  if (
    input.step !== undefined &&
    (typeof input.step !== 'number' || !Number.isInteger(input.step) || input.step < 1 || input.step > MOVE_STEP_COUNT)
  ) {
    return err('invalid_step', { step: input.step });
  }

  const now = ctx.clock.now();

  if (input.abandon === true) {
    ctx.store.db.prepare('DELETE FROM move_record WHERE workspace_id = ?').run(ctx.workspaceId);
    return ok<AdvanceMoveStepOk>({ move: null });
  }

  const existing = ctx.store.db.prepare(SELECT_ROW).get(ctx.workspaceId) as MoveRow | undefined;

  // The base row this call asserts onto: the stored one if the direction matches, a fresh one
  // otherwise (a direction change is a fresh start, never a half-carried checklist).
  const base: MoveRow =
    existing !== undefined && existing.direction === input.direction
      ? existing
      : {
          direction: input.direction,
          step1_at: null,
          step2_at: null,
          step3_at: null,
          step4_at: null,
          step5_at: null,
          started_at: now,
          completed_at: null,
        };

  const stamps = [base.step1_at, base.step2_at, base.step3_at, base.step4_at, base.step5_at];
  if (typeof input.step === 'number') {
    const i = input.step - 1;
    // COALESCE semantics: a replayed "done" keeps the original timestamp, so the double-call settles.
    stamps[i] = input.done === false ? null : (stamps[i] ?? now);
  }

  // Derived, honestly: complete exactly when all five are done. Un-doing a step un-completes.
  const allDone = stamps.every((s) => s !== null);
  const completedAt = allDone ? (base.completed_at ?? now) : null;

  ctx.store.db
    .prepare(
      `INSERT INTO move_record
         (workspace_id, direction, step1_at, step2_at, step3_at, step4_at, step5_at, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         direction = excluded.direction,
         step1_at = excluded.step1_at,
         step2_at = excluded.step2_at,
         step3_at = excluded.step3_at,
         step4_at = excluded.step4_at,
         step5_at = excluded.step5_at,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      ctx.workspaceId,
      input.direction,
      stamps[0],
      stamps[1],
      stamps[2],
      stamps[3],
      stamps[4],
      base.started_at,
      completedAt,
      now,
    );

  const row = ctx.store.db.prepare(SELECT_ROW).get(ctx.workspaceId) as MoveRow;
  return ok<AdvanceMoveStepOk>({ move: toState(row) });
}
