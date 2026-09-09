/**
 * G11's six verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `migrationActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * All six are `ctxAction` registrations (every verb takes `workspaceId`, §H-TENANT). Three are
 * writes (declare/check/waive), three are reads (get/list/export). `migration_check_step` is a
 * WRITE because it persists a hashed snapshot that a G09 approval binds to: a read that produced a
 * hash nothing stored would make the binding meaningless (spec §5). No verb here is outbound or
 * irreversible, so none is draft-staged (P8); the gate this capability feeds lives in G09's
 * `migration_commit_step`, which is where the irreversible act is.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  declareControlTotal,
  checkStepVerb,
  getCheck,
  listChecks,
  waiveControl,
  exportCheck,
} from '../core/migration/index.js';

export interface MigrationCheckActionHelpers {
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

/** The G11 verbs, in append order (the §5 table order). */
export function migrationCheckActions(h: MigrationCheckActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const INT = { type: 'integer' } as const;

  return [
    ctxAction(
      'migration_declare_control_total',
      'write',
      'Declare an expectation for one Eröffnungsprüfung control: the figure the old system said (a per-account trial-balance total, the open AR or AP total, the VAT position at the Übernahmestichtag), in integer Rappen against a scope (an account number, an IBAN, or workspace). A control nobody declared reports "nicht geprüft" and never green; declaring reopens the control until the next check.',
      ctxSchema({ planId: STR, stepId: STR, kind: STR, scope: STR, declaredMinor: INT, idempotencyKey: STR }, ['planId', 'kind', 'scope', 'declaredMinor', 'idempotencyKey']),
      (ctx, input) => declareControlTotal(ctx, as(input)),
    ),
    ctxAction(
      'migration_check_step',
      'write',
      'Run the Eröffnungsprüfung for a step: every applicable control (trial balance balanced and per-account against the declared source, open AR/AP against their control accounts, each bank opening against the camt.053 OPBD, the VAT position at the Stichtag, row counts, document integrity, the export date against the Übernahmestichtag), persisted as an append-only snapshot whose hash a commit approval binds to. Idempotent: unchanged inputs return the stored snapshot. clean means every control passed or was waived; a failed or undeclared control refuses the commit.',
      ctxSchema({ planId: STR, stepId: STR, against: STR, idempotencyKey: STR }, ['planId', 'stepId', 'idempotencyKey']),
      (ctx, input) => checkStepVerb(ctx, as(input)),
    ),
    ctxAction(
      'migration_get_check',
      'read',
      'Read one persisted Eröffnungsprüfung: every control with its declared and computed figures in Rappen, its status (passed, failed, not_asserted, not_computable, waived), and every waiver with its recorded reason. The snapshot is append-only: this is the record an approval was bound to.',
      ctxSchema({ checkId: STR }, ['checkId']),
      (ctx, input) => getCheck(ctx, as(input)),
    ),
    ctxAction(
      'migration_list_checks',
      'read',
      "List a plan's Eröffnungsprüfungen, newest first, optionally for one step or one run kind (testmandant or live). Accepts a saved view (savedViewId) over the check history; an explicit stepId/against filter wins over the stored one.",
      ctxSchema({ planId: STR, stepId: STR, against: STR, savedViewId: STR }, ['planId']),
      (ctx, input) => listChecks(ctx, as(input)),
    ),
    ctxAction(
      'migration_waive_control',
      'write',
      'Set one control aside with a RECORDED reason, which becomes part of the check and of the Prüfbericht. A waiver without a reason is refused (waiver_needs_reason), empty string included; a waived control reports "waived", never "passed", and readiness renders "bereit, mit N Ausnahmen" rather than plain ready. A passed control cannot be waived.',
      ctxSchema({ controlId: STR, reason: STR, idempotencyKey: STR }, ['controlId', 'reason', 'idempotencyKey']),
      (ctx, input) => waiveControl(ctx, as(input)),
    ),
    ctxAction(
      'migration_export_check',
      'read',
      'Export the Prüfbericht for one check: every control with its declared and computed figures, its status, every waiver and its reason, the source files with their sha256 and as-of date, and the check hash, as a locale-neutral artifact (raw integer Rappen, ISO dates) a Treuhänder can file. It joins the A25 filing export set rather than becoming a second export mechanism.',
      ctxSchema({ checkId: STR, format: STR }, ['checkId']),
      (ctx, input) => exportCheck(ctx, as(input)),
    ),
  ];
}
