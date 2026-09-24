/**
 * G11, the CONTROL REGISTRY of the Eröffnungsprüfung: one pure module per control kind, each a
 * `compute(ctx, plan, step, env) -> findings[]` over the source tables and the shipped read models
 * (P5: a control is a computed read model, never a cached figure that can drift).
 *
 * Adding a control is one module plus one registry row plus a fixture. NOTHING in `check.ts`
 * switches on a kind: status derivation is generic over the finding shape below, which is the same
 * discipline G00's entity registry uses and the reason it scales (spec §4).
 *
 * §H-ENUM: `CONTROL_KINDS` and `CONTROL_STATUSES` are the single sources. `CONTROL_STATUSES` has
 * EXACTLY five values and `amber` is not one of them, asserted in the G11 suite so the retired brand
 * colour cannot re-enter through a data name (spec §7; brand/DESIGN.md retired amber for warnings).
 */

import type { WorkspaceContext } from '../../context.js';
import type { PlanRow, StepRow } from '../plan.js';
import type { ParsedRow } from '../adapters/parse.js';

/** The nine control kinds (spec §4 table, verbatim). */
export const CONTROL_KINDS = [
  'trial_balance_balanced',
  'trial_balance_matches_source',
  'ar_control',
  'ap_control',
  'bank_control',
  'vat_balance_at_cutover',
  'row_count',
  'document_integrity',
  'source_as_at',
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/**
 * The three-status honesty model plus the two resolutions (spec §2 US-G11.5). Exactly five values.
 * `not_asserted` (computable, no expectation stated) is DISTINCT from `not_computable` (the input is
 * missing entirely), because "you did not tell me" and "I could not have known" are different facts.
 */
export const CONTROL_STATUSES = ['passed', 'failed', 'not_asserted', 'not_computable', 'waived'] as const;
export type ControlStatusValue = (typeof CONTROL_STATUSES)[number];

/** Which books a check ran against (spec §4): the trial run, or the live verification. */
export const CHECK_RUNS = ['testmandant', 'live'] as const;
export type CheckRun = (typeof CHECK_RUNS)[number];

/** One linked source file's evidence facts, read from `migration_source_file` (US-G09.8). */
export interface SourceFileFact {
  readonly fileId: string;
  readonly sha256: string | null;
  readonly asAt: string | null;
}

/** What every module is handed, computed ONCE per check so nine modules do not parse nine times. */
export interface ControlEnv {
  readonly against: CheckRun;
  readonly cutoverDate: string | null;
  /** The parsed source rows for THIS step's data class (empty when the plan has no linked file). */
  readonly rows: readonly ParsedRow[];
  /** The plan's linked source files applicable to this step's class. */
  readonly files: readonly SourceFileFact[];
}

/**
 * One computed control result. A module returns ZERO OR MORE findings (per account, per file, per
 * bank account); a kind with nothing to control returns none rather than a fabricated pass.
 *
 * Status derivation is generic in `check.ts`:
 *   - `inputsPresent: false`  -> `not_computable`, with `missingInput` named (P9 degradation).
 *   - `selfStatus` present    -> that status: the module computed BOTH sides itself (a structural
 *                                check needing no declared expectation, e.g. Sigma debit == credit).
 *   - otherwise               -> compared against the operator's declared total for (kind, scope):
 *                                none declared and computed 0 -> `passed` (an empty class ties out
 *                                trivially and says so, US-G11.1); none declared and non-zero ->
 *                                `not_asserted` (never green, US-G11.5); declared -> passed/failed
 *                                by integer subtraction (P2: nothing is recomputed or re-rounded).
 */
export interface ControlFinding {
  readonly scope: string;
  readonly computedMinor: number | null;
  readonly inputsPresent: boolean;
  readonly missingInput?: string;
  readonly selfStatus?: 'passed' | 'failed';
  readonly detail?: string;
}

/** One registry row: a pure module for one kind. */
export interface ControlModule {
  readonly kind: ControlKind;
  /**
   * True when the operator states an expectation for this kind (`migration_declare_control_total`):
   * status then derives from declared vs computed, and a DECLARED scope the module produced no
   * finding for is widened into one (a position missing from the import must fail, not vanish).
   * False for the structural kinds that compute both sides themselves (`selfStatus`).
   */
  readonly declarable: boolean;
  /** Whether this kind applies to a step of this data class at all. */
  appliesTo(step: Pick<StepRow, 'data_class'>): boolean;
  compute(ctx: WorkspaceContext, plan: PlanRow, step: StepRow, env: ControlEnv): ControlFinding[];
}

const CONTROL_KIND_SET: ReadonlySet<string> = new Set(CONTROL_KINDS);

export function isControlKind(value: unknown): value is ControlKind {
  return typeof value === 'string' && CONTROL_KIND_SET.has(value);
}

const CONTROL_STATUS_SET: ReadonlySet<string> = new Set(CONTROL_STATUSES);

export function isControlStatus(value: unknown): value is ControlStatusValue {
  return typeof value === 'string' && CONTROL_STATUS_SET.has(value);
}
