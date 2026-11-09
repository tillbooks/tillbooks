/**
 * G12, the TRIAL RESET: what a migration plan looks like once its link to a Testmandant is cleared
 * without the plan's own `discard_testmandant` (a restore, an env_copy that did not carry the
 * Testmandant, a copy that never owned it, a Testmandant that is already gone).
 *
 * ONE LINK, WRITTEN ONLY BY THE WORKSPACE THAT CREATED IT. `migration_plan.testmandant_workspace_id`
 * names a sibling workspace. A restore cannot know whether the sibling it names is the plan's own
 * (it is not, beside the original: the original still holds it), so every restore CLEARS the link,
 * and env_copy re-points it only where it copied the Testmandant too. No state in which two plans
 * share one Testmandant is ever written; the resolver in `testmandant.ts` (`owningPlan`) settles the
 * legacy books that already hold one.
 *
 * Clearing the link resets what only existed because a trial ran (owner decision, 11.10.2026): a
 * plan in `trial` goes back to `planned`, and a step in `trial_loaded` or `checked` goes back to
 * `mapped` with its last check id cleared, the shape `discard_testmandant` leaves. `live`, `closed`
 * and `abandoned` keep their status; maps, declared controls and approvals survive.
 *
 * IMPORTS NOTHING, so the restore (`data/portability.ts`), env_copy (`landscape/copy.ts`) and the
 * Testmandant verbs share it without a module cycle.
 */

import type Database from 'better-sqlite3';

/**
 * The step states that exist only because a trial ran. A step reset out of one goes back to `mapped`
 * and its approvals are voided with it (canon blocker 6): `unlinkPlanTestmandant` deletes them, and a
 * restore never carries them (`approvalSurvivesRestore`).
 */
export const TRIAL_STEP_STATES: readonly string[] = ['trial_loaded', 'checked'];

type Row = Record<string, unknown>;

/** A `migration_plan` row with its Testmandant link cleared and its trial state reset. */
export function planRowWithoutLink(row: Row): Row {
  return { ...row, testmandant_workspace_id: null, status: row['status'] === 'trial' ? 'planned' : row['status'] };
}

/**
 * A `migration_step` row with no trace of the Testmandant left: reset out of a trial state
 * (`trial_loaded`/`checked` to `mapped`, its last check id cleared), and the `trialTarget` its counts
 * record (the workspace a trial-load wrote into, `steps.ts`) set to null whatever the state, since
 * the plan no longer links that workspace. A restore runs this on the SOURCE row, before the id
 * chokepoint reads it: a `trialTarget` naming the original's sandbox would otherwise refuse the whole
 * restore beside the original as a foreign reference.
 */
export function stepRowWithoutTrial(row: Row, now: string): Row {
  const out: Row = { ...row, counts: countsWithoutTrialTarget(row['counts']) };
  if (!TRIAL_STEP_STATES.includes(String(row['status']))) return out;
  return { ...out, status: 'mapped', last_check_id: null, updated_at: now };
}

/** The step's `counts` JSON with `trialTarget` nulled; anything else (absent, not JSON) as it was. */
function countsWithoutTrialTarget(counts: unknown): unknown {
  if (typeof counts !== 'string') return counts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(counts);
  } catch {
    return counts;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return counts;
  const record = parsed as Record<string, unknown>;
  if (record['trialTarget'] === undefined || record['trialTarget'] === null) return counts;
  return JSON.stringify({ ...record, trialTarget: null });
}

/**
 * Does a `migration_approval` row of a backup survive a restore? Not when its step is in a trial state
 * in the same backup: that step lands `mapped` (`stepRowWithoutTrial`), and an approval never outlives
 * its step's return to `mapped` (canon blocker 6). `stepStatus` is the step's status in the backup.
 */
export function approvalSurvivesRestore(stepStatus: unknown): boolean {
  return !TRIAL_STEP_STATES.includes(String(stepStatus));
}

/**
 * Clear one plan's link and reset its trial state, in place. Scoped to the plan's own workspace
 * (§H-TENANT). When `resetTrial` is false only the link is cleared (an abandoned plan keeps its
 * history as it stood).
 */
export function unlinkPlanTestmandant(
  db: Database.Database,
  workspaceId: string,
  planId: string,
  now: string,
  resetTrial = true,
): void {
  db.prepare('UPDATE migration_plan SET testmandant_workspace_id = NULL WHERE id = ? AND workspace_id = ?').run(planId, workspaceId);
  // The workspace the plan no longer links is not left behind in its steps' counts either.
  db.prepare(
    `UPDATE migration_step SET counts = json_set(counts, '$.trialTarget', NULL)
      WHERE plan_id = ? AND workspace_id = ? AND json_valid(counts) AND json_type(counts, '$.trialTarget') = 'text'`,
  ).run(planId, workspaceId);
  if (!resetTrial) return;
  db.prepare("UPDATE migration_plan SET status = 'planned' WHERE id = ? AND workspace_id = ? AND status = 'trial'").run(planId, workspaceId);
  // Canon blocker 6 (G09, `steps.ts` returnToMapped): a step that moves back to `mapped` loses every
  // approval recorded on it, so no approval outlives the check result a human looked at. Voided
  // BEFORE the status update, while the step still reads as trial.
  db.prepare(
    `DELETE FROM migration_approval WHERE workspace_id = ? AND step_id IN (
       SELECT id FROM migration_step WHERE plan_id = ? AND workspace_id = ? AND status IN (${TRIAL_STEP_STATES.map(() => '?').join(', ')}))`,
  ).run(workspaceId, planId, workspaceId, ...TRIAL_STEP_STATES);
  db.prepare(
    `UPDATE migration_step SET status = 'mapped', last_check_id = NULL, updated_at = ?
      WHERE plan_id = ? AND workspace_id = ? AND status IN (${TRIAL_STEP_STATES.map(() => '?').join(', ')})`,
  ).run(now, planId, workspaceId, ...TRIAL_STEP_STATES);
}

/**
 * env_copy's sweep: after `remapCopiedWorkspaceIds` re-pointed every link whose Testmandant was copied
 * too, any link in the copied workspaces that still names a workspace OUTSIDE `keep` (the copies this
 * target holds) points back into the source instance, or at nothing. It is cleared, with the trial
 * reset. Returns the number of plans unlinked.
 */
export function sweepUnpairedTestmandantLinks(
  db: Database.Database,
  keep: ReadonlySet<string>,
  scope: readonly string[],
  now: string,
): number {
  let swept = 0;
  for (const wsId of scope) {
    const linked = db
      .prepare('SELECT id, testmandant_workspace_id AS link FROM migration_plan WHERE workspace_id = ? AND testmandant_workspace_id IS NOT NULL')
      .all(wsId) as { id: string; link: string }[];
    for (const plan of linked) {
      if (keep.has(plan.link)) continue;
      unlinkPlanTestmandant(db, wsId, plan.id, now);
      swept += 1;
    }
  }
  return swept;
}
