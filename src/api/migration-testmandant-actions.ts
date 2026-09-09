/**
 * G12's five verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `migrationActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * All five are `ctxAction` registrations (every verb takes `workspaceId`, §H-TENANT). THREE are
 * writes: `migration_create_testmandant` (idempotent, provisions the trial workspace), `go_productive`
 * (destructive: promotion is the least-reversible act in the product, denylisted from automation and
 * gated on `promote_workspace` + `commit_migration`), and `discard_testmandant` (destructive: a hard
 * delete of the trial, denylisted). TWO are reads: `migration_get_testmandant` and
 * `migration_diff_testmandant_to_live` (the family's one deliberate two-workspace read).
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createTestmandant,
  getTestmandant,
  diffTestmandantToLive,
  goProductive,
  discardTestmandant,
} from '../core/migration/index.js';

export interface MigrationTestmandantActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G12 verbs, in append order (the §5 table order). */
export function migrationTestmandantActions(h: MigrationTestmandantActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const BOOL = { type: 'boolean' } as const;

  return [
    ctxAction(
      'migration_create_testmandant',
      'write',
      'Provision the Testmandant for a plan: a disposable trial workspace (workspace.kind = sandbox) that behaves identically to a real one, composed from A00 create_workspace and linked to the plan so every migration_trial_load_step targets it. Idempotent per plan: a second call returns the existing Testmandant, never a second workspace; a plan already live refuses with plan_already_live. The user-facing word is Testmandant, never "Sandbox".',
      ctxSchema({ planId: STR, idempotencyKey: STR }, ['planId', 'idempotencyKey']),
      (ctx, input) => createTestmandant(ctx, as(input)),
    ),
    ctxAction(
      'migration_get_testmandant',
      'read',
      'Read the Testmandant for a plan: its workspace id, its kind (demo|sandbox|live), the steps trial-loaded into it, and the plan\'s last Eröffnungsprüfung id. A plan with no Testmandant returns {none:true}.',
      ctxSchema({ planId: STR }, ['planId']),
      (ctx, input) => getTestmandant(ctx, as(input)),
    ),
    ctxAction(
      'migration_diff_testmandant_to_live',
      'read',
      'What differs between the Testmandant and an existing live workspace of the same UID, per data class: the row counts on each side, so the choice between going productive and running against the live workspace is informed. No live workspace of this UID returns {live:null}. This read touches TWO tenants and demands membership of EACH (forbidden otherwise): it is the migration family\'s one deliberate two-workspace read. It never merges.',
      ctxSchema({ planId: STR }, ['planId']),
      (ctx, input) => diffTestmandantToLive(ctx, as(input)),
    ),
    ctxAction(
      'go_productive',
      'write',
      'Promote a verified Testmandant to real books, in place, with NO re-import: the workspace simply stops being a Testmandant (kind = live), every id and timestamp stable, the A03 audit chain continuous (OR Art. 957a). The least-reversible act in the product and irreversible: it re-runs the WHOLE Eröffnungsprüfung one final time and refuses unless every control passes and none diverges (check_not_clean), no row traces to a demo seed (sandbox_contains_demo_rows), the company profile is real (needs_company_profile), and no live workspace already holds the UID (live_workspace_exists). Requires promote_workspace AND commit_migration. confirmedName is a type-to-confirm against the company legal name, checked engine-side so the agent face cannot skip it; an agent caller is draft-staged until a human confirms. Promoting an already-live workspace is a no-op, never a double-promote.',
      ctxSchema({ planId: STR, confirmedName: STR, idempotencyKey: STR }, ['planId', 'confirmedName', 'idempotencyKey']),
      (ctx, input) => goProductive(ctx, as(input)),
    ),
    ctxAction(
      'discard_testmandant',
      'write',
      'Discard a Testmandant and have it truly gone: a hard delete of the trial workspace and every row under it, because nothing in it is a real fiscal record until it goes productive. Refuses on any workspace whose kind is not sandbox (not_a_testmandant): a demo discards through G03, and a live workspace can never be hard-deleted through this family, so after go_productive this same call refuses. Once any step has committed to a live workspace, discard requires commit_migration. The plan itself survives and returns to planned with its trial-load state reset; the maps and declared controls are kept.',
      ctxSchema({ planId: STR, confirmed: BOOL, idempotencyKey: STR }, ['planId', 'idempotencyKey']),
      (ctx, input) => discardTestmandant(ctx, as(input)),
    ),
  ];
}
