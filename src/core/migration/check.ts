/**
 * G11, the Eröffnungsprüfung: the check that the opening position TILL now holds is the one the old
 * system had. NOT called "reconciliation" (that word is A20's bank surface, and unqualified
 * Abstimmung stays reserved for it) and never "tie-out" anywhere a user can see (spec §0).
 *
 * SIX ENGINE VERBS (spec §4): `declareControlTotal`, `checkStep`, `getCheck`, `listChecks`,
 * `waiveControl`, `exportCheck`. Every control is a COMPUTED read model over the source tables and
 * the shipped A08/A16/A17/A19+A20/A07 reads (P5), derived generically over `controls/`: NOTHING in
 * this file switches on a control kind.
 *
 * THE THREE-STATUS MODEL, AND WHY `clean` IS A CONJUNCTION (spec §4). `clean` is true when EVERY
 * control is `passed` or `waived`. `failed` and `not_asserted` both make it false and both refuse
 * G09's commit (gate condition 2); `not_computable` does not block on its own but is always
 * surfaced. A control nobody declared reports "nicht geprüft" and NEVER green.
 *
 * THE HASH BINDS (US-G11.7). Every check persists append-only (§H-AUDIT) with a `check_hash`
 * computed over LOCALE-NEUTRAL values (raw integer Rappen, ISO dates, never a formatted string), so
 * the same inputs produce the same hash, any input change moves it, and a locale change cannot void
 * an approval. G09's `migration_approval` binds to exactly this hash, which is the whole mechanism
 * behind the agent-autonomy boundary.
 *
 * §H-TENANT on every query; §H-IDEMPOTENT on all three writes, with the check itself keyed on
 * `(stepId, against, inputHash)`: re-checking unchanged inputs returns the stored snapshot rather
 * than a second one. §H-LEDGER: this file posts NOTHING; every figure is read off a posted row or a
 * declared expectation, and differences are integer subtraction (P2).
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { getFileContent } from '../files/files.js';
import { applySavedView } from '../customization/views.js';
import { parseSource, isParseFailure, type ParsedRow } from './adapters/parse.js';
import type { PlanRow, StepRow } from './plan.js';
import {
  CONTROL_REGISTRY,
  isControlKind,
  isControlStatus,
  type CheckRun,
  type ControlEnv,
  type ControlFinding,
  type ControlModule,
  type ControlStatusValue,
  type SourceFileFact,
} from './controls/index.js';

// --- Local §H-TENANT loaders --------------------------------------------------------------------
// Deliberately NOT imported from `plan.ts`: `seams.ts` binds into this file and `plan.ts` imports
// `seams.ts`, so a runtime import here would close a module cycle. The queries are restated (four
// lines each) rather than the cycle accepted; the row types are type-only imports and erase.

function loadPlanRow(ctx: WorkspaceContext, planId: unknown): PlanRow | undefined {
  if (typeof planId !== 'string') return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM migration_plan WHERE id = ? AND workspace_id = ?')
    .get(planId, ctx.workspaceId) as PlanRow | undefined;
}

function loadStepRow(ctx: WorkspaceContext, planId: string, stepId: unknown): StepRow | undefined {
  if (typeof stepId !== 'string') return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM migration_step WHERE id = ? AND plan_id = ? AND workspace_id = ?')
    .get(stepId, planId, ctx.workspaceId) as StepRow | undefined;
}

/** The seam adapter's entry: a step by its id alone (the seam hands no planId). §H-TENANT. */
function loadStepById(ctx: WorkspaceContext, stepId: string): StepRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM migration_step WHERE id = ? AND workspace_id = ?')
    .get(stepId, ctx.workspaceId) as StepRow | undefined;
}

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

// --- The environment every module is handed (computed once per check) ---------------------------

interface SourceFileRow {
  file_id: string;
  sha256: string | null;
  as_at: string | null;
  adapter: string | null;
  data_classes: string | null;
}

/** The plan's linked source files applicable to a step's class, plus their parsed rows. Read-only. */
function buildEnv(ctx: WorkspaceContext, plan: PlanRow, step: StepRow, against: CheckRun): ControlEnv {
  const fileRows = ctx.store.db
    .prepare('SELECT file_id, sha256, as_at, adapter, data_classes FROM migration_source_file WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at')
    .all(plan.id, ctx.workspaceId) as SourceFileRow[];
  const files: SourceFileFact[] = [];
  const rows: ParsedRow[] = [];
  for (const file of fileRows) {
    const classes = file.data_classes === null ? [] : (JSON.parse(file.data_classes) as string[]);
    if (classes.length > 0 && !classes.includes(step.data_class)) continue;
    files.push({ fileId: file.file_id, sha256: file.sha256, asAt: file.as_at });
    const content = getFileContent(ctx, { fileId: file.file_id });
    if (!content.ok) continue; // document_integrity reports the broken file; the rows are simply absent.
    const bytes = Buffer.from(content.contentBase64 as string, 'base64');
    const parsed = parseSource(file.adapter ?? 'csv', bytes, step.data_class);
    if (!isParseFailure(parsed)) rows.push(...parsed.rows);
  }
  return { against, cutoverDate: plan.cutover_date, rows, files };
}

// --- Declarations and status derivation (generic over the registry, never over a kind) ----------

interface ControlRow {
  id: string;
  step_id: string | null;
  kind: string;
  scope: string;
  declared_minor: number | null;
  computed_minor: number | null;
  status: string;
  waiver_reason: string | null;
  waived_by: string | null;
  waived_at: string | null;
}

const SEP = '\u0000';

/** Declared expectations for a step: step-scoped rows win over plan-level ones. */
function declarationsFor(ctx: WorkspaceContext, plan: PlanRow, step: StepRow): Map<string, number> {
  const rows = ctx.store.db
    .prepare(
      `SELECT step_id, kind, scope, declared_minor FROM migration_control_total
        WHERE workspace_id = ? AND plan_id = ? AND declared_minor IS NOT NULL
          AND (step_id IS NULL OR step_id = ?)`,
    )
    .all(ctx.workspaceId, plan.id, step.id) as Array<{ step_id: string | null; kind: string; scope: string; declared_minor: number }>;
  const declared = new Map<string, number>();
  for (const row of rows.filter((r) => r.step_id === null)) declared.set(`${row.kind}${SEP}${row.scope}`, row.declared_minor);
  for (const row of rows.filter((r) => r.step_id !== null)) declared.set(`${row.kind}${SEP}${row.scope}`, row.declared_minor);
  return declared;
}

interface DerivedControl {
  kind: string;
  scope: string;
  declaredMinor: number | null;
  computedMinor: number | null;
  differenceMinor: number | null;
  status: ControlStatusValue;
  detail: string | null;
  missingInput: string | null;
}

/** The generic derivation stated in `controls/registry.ts`, applied to one finding. */
function derive(module: ControlModule, finding: ControlFinding, declared: number | undefined): DerivedControl {
  const base = {
    kind: module.kind,
    scope: finding.scope,
    computedMinor: finding.computedMinor,
    detail: finding.detail ?? null,
    missingInput: finding.missingInput ?? null,
  };
  if (!finding.inputsPresent) {
    return { ...base, declaredMinor: declared ?? null, differenceMinor: null, status: 'not_computable' };
  }
  if (finding.selfStatus !== undefined) {
    return { ...base, declaredMinor: declared ?? null, differenceMinor: null, status: finding.selfStatus };
  }
  if (!module.declarable || declared === undefined) {
    if ((finding.computedMinor ?? 0) === 0) {
      return { ...base, declaredMinor: null, differenceMinor: 0, status: 'passed' };
    }
    return { ...base, declaredMinor: null, differenceMinor: null, status: 'not_asserted' };
  }
  const differenceMinor = (finding.computedMinor ?? 0) - declared;
  return { ...base, declaredMinor: declared, differenceMinor, status: differenceMinor === 0 ? 'passed' : 'failed' };
}

// --- The check itself (shared by the verb and the G09 seam adapter) -----------------------------

export interface ControlSnapshotRow {
  controlId: string;
  kind: string;
  scope: string;
  declaredMinor: number | null;
  computedMinor: number | null;
  differenceMinor: number | null;
  status: ControlStatusValue;
  waiverReason: string | null;
  detail: string | null;
  missingInput: string | null;
}

export interface RunCheckOutcome {
  checkId: string;
  checkHash: string;
  clean: boolean;
  controls: ControlSnapshotRow[];
  diverged: boolean;
  divergedControls: Array<{ kind: string; scope: string; checkedMinor: number | null; liveMinor: number | null }>;
}

/**
 * Compute every applicable control, persist the per-control rows and an APPEND-ONLY snapshot, and
 * return the result. Idempotent on `(stepId, against, inputHash)`: unchanged inputs return the
 * stored snapshot rather than minting a second one (§H-IDEMPOTENT, §H-AUDIT).
 */
export function runCheck(ctx: WorkspaceContext, plan: PlanRow, step: StepRow, against: CheckRun): RunCheckOutcome {
  const env = buildEnv(ctx, plan, step, against);
  const declared = declarationsFor(ctx, plan, step);
  const now = ctx.clock.now();

  const derivedRows: DerivedControl[] = [];
  for (const module of CONTROL_REGISTRY) {
    if (!module.appliesTo(step)) continue;
    const findings = module.compute(ctx, plan, step, env);
    const seenScopes = new Set(findings.map((f) => f.scope));
    for (const finding of findings) {
      derivedRows.push(derive(module, finding, declared.get(`${module.kind}${SEP}${finding.scope}`)));
    }
    if (module.declarable) {
      // Widen with every DECLARED scope the module produced no finding for: a declared position the
      // import never touched compares against zero and FAILS, rather than vanishing (US-G11.1 error).
      for (const [key, value] of declared.entries()) {
        const [kind, scope] = key.split(SEP) as [string, string];
        if (kind !== module.kind || seenScopes.has(scope)) continue;
        derivedRows.push(
          derive(module, { scope, computedMinor: 0, inputsPresent: true, detail: 'in der Übernahme nicht vorhanden' }, value),
        );
      }
    }
  }

  // Persist the control rows (upsert per (plan, step, kind, scope)), carrying a WAIVER forward only
  // while its computed value is unchanged: a waiver is set aside FOR a result, and a result that
  // moved is a new fact the operator has not seen (the same reasoning that voids the approval).
  const snapshot: ControlSnapshotRow[] = [];
  for (const row of derivedRows.sort((a, b) => (a.kind + SEP + a.scope).localeCompare(b.kind + SEP + b.scope))) {
    const existing = ctx.store.db
      .prepare(
        'SELECT id, step_id, kind, scope, declared_minor, computed_minor, status, waiver_reason, waived_by, waived_at FROM migration_control_total WHERE workspace_id = ? AND plan_id = ? AND step_id = ? AND kind = ? AND scope = ?',
      )
      .get(ctx.workspaceId, plan.id, step.id, row.kind, row.scope) as ControlRow | undefined;
    const keepWaiver = existing !== undefined && existing.status === 'waived' && existing.computed_minor === row.computedMinor;
    const status: ControlStatusValue = keepWaiver ? 'waived' : row.status;
    const waiverReason = keepWaiver ? existing.waiver_reason : null;
    let controlId: string;
    if (existing === undefined) {
      controlId = ctx.ids.next('migctl');
      ctx.store.db
        .prepare(
          `INSERT INTO migration_control_total
             (id, workspace_id, plan_id, step_id, kind, scope, declared_minor, computed_minor, difference_minor,
              status, waiver_reason, waived_by, waived_at, source_map_id, computed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(controlId, ctx.workspaceId, plan.id, step.id, row.kind, row.scope, row.declaredMinor, row.computedMinor, row.differenceMinor, status, waiverReason, now, now, now);
    } else {
      controlId = existing.id;
      ctx.store.db
        .prepare(
          `UPDATE migration_control_total
              SET declared_minor = ?, computed_minor = ?, difference_minor = ?, status = ?,
                  waiver_reason = ?, waived_by = CASE WHEN ? THEN waived_by ELSE NULL END,
                  waived_at = CASE WHEN ? THEN waived_at ELSE NULL END, computed_at = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .run(row.declaredMinor, row.computedMinor, row.differenceMinor, status, waiverReason, keepWaiver ? 1 : 0, keepWaiver ? 1 : 0, now, now, controlId, ctx.workspaceId);
    }
    snapshot.push({
      controlId,
      kind: row.kind,
      scope: row.scope,
      declaredMinor: row.declaredMinor,
      computedMinor: row.computedMinor,
      differenceMinor: row.differenceMinor,
      status,
      waiverReason,
      detail: row.detail,
      missingInput: row.missingInput,
    });
  }

  const clean = snapshot.every((c) => c.status === 'passed' || c.status === 'waived');

  // The hash, over LOCALE-NEUTRAL values only (raw Rappen, ISO dates): stable under a locale change,
  // moved by any input change. `detail` is presentation and deliberately outside it.
  const checkHash = sha256Canonical({
    v: 1,
    planId: plan.id,
    stepId: step.id,
    against,
    cutoverDate: plan.cutover_date,
    files: env.files.map((f) => ({ fileId: f.fileId, sha256: f.sha256, asAt: f.asAt })),
    controls: snapshot.map((c) => ({
      kind: c.kind,
      scope: c.scope,
      declaredMinor: c.declaredMinor,
      computedMinor: c.computedMinor,
      status: c.status,
      waiverReason: c.waiverReason,
    })),
  });

  // Idempotent on (stepId, against, inputHash): unchanged inputs return the stored snapshot.
  const latest = ctx.store.db
    .prepare('SELECT id, check_hash FROM migration_check WHERE workspace_id = ? AND step_id = ? AND against = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(ctx.workspaceId, step.id, against) as { id: string; check_hash: string } | undefined;
  let checkId: string;
  if (latest !== undefined && latest.check_hash === checkHash) {
    checkId = latest.id;
  } else {
    checkId = ctx.ids.next('migcheck');
    ctx.store.db
      .prepare(
        `INSERT INTO migration_check (id, workspace_id, plan_id, step_id, against, check_hash, clean, controls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(checkId, ctx.workspaceId, plan.id, step.id, against, checkHash, clean ? 1 : 0, JSON.stringify(snapshot), now);
  }

  // The step's current check hash is what a G09 approval binds to; both faces set it the same way.
  ctx.store.db
    .prepare('UPDATE migration_step SET last_check_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(checkHash, now, step.id, ctx.workspaceId);

  // US-G11.7: the two runs must agree. A live check compares itself against the latest trial check
  // per (kind, scope); a control not computable on either side cannot disagree, so it is skipped.
  let diverged = false;
  const divergedControls: RunCheckOutcome['divergedControls'] = [];
  if (against === 'live') {
    const trial = ctx.store.db
      .prepare("SELECT controls FROM migration_check WHERE workspace_id = ? AND step_id = ? AND against = 'testmandant' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(ctx.workspaceId, step.id) as { controls: string } | undefined;
    if (trial !== undefined) {
      const trialControls = JSON.parse(trial.controls) as ControlSnapshotRow[];
      const byKey = new Map(trialControls.map((c) => [`${c.kind}${SEP}${c.scope}`, c]));
      for (const control of snapshot) {
        const other = byKey.get(`${control.kind}${SEP}${control.scope}`);
        if (other === undefined) continue;
        if (other.status === 'not_computable' || control.status === 'not_computable') continue;
        if (other.computedMinor !== control.computedMinor) {
          diverged = true;
          divergedControls.push({ kind: control.kind, scope: control.scope, checkedMinor: other.computedMinor, liveMinor: control.computedMinor });
        }
      }
    }
  }

  return { checkId, checkHash, clean, controls: snapshot, diverged, divergedControls };
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// --- declareControlTotal (US-G11.5) -------------------------------------------------------------

export function declareControlTotal(
  ctx: WorkspaceContext,
  input: { planId: unknown; stepId?: unknown; kind: unknown; scope: unknown; declaredMinor: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.scope, 'scope') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!isControlKind(input.kind)) return err('unknown_control_kind', { kind: input.kind });
  if (typeof input.declaredMinor !== 'number' || !Number.isInteger(input.declaredMinor)) {
    return err('invalid_input', { field: 'declaredMinor', expected: 'integer Rappen' });
  }
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  let stepId: string | null = null;
  if (input.stepId !== undefined) {
    const step = loadStepRow(ctx, plan.id, input.stepId);
    if (step === undefined) return err('not_found', { stepId: input.stepId });
    stepId = step.id;
  }

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_declare_control_total');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_declare_control_total', () => {
    const now = ctx.clock.now();
    const existing = ctx.store.db
      .prepare(
        `SELECT id FROM migration_control_total
          WHERE workspace_id = ? AND plan_id = ? AND kind = ? AND scope = ?
            AND ((step_id IS NULL AND ? IS NULL) OR step_id = ?)`,
      )
      .get(ctx.workspaceId, plan.id, input.kind, input.scope, stepId, stepId) as { id: string } | undefined;
    if (existing !== undefined) {
      // A NEW expectation reopens the control: the computed side and any waiver are for a question
      // that has changed, so both reset until the next check answers it (spec §7: the hash moves).
      ctx.store.db
        .prepare(
          `UPDATE migration_control_total
              SET declared_minor = ?, computed_minor = NULL, difference_minor = NULL, status = 'not_asserted',
                  waiver_reason = NULL, waived_by = NULL, waived_at = NULL, computed_at = NULL, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .run(input.declaredMinor, now, existing.id, ctx.workspaceId);
      return ok({ controlId: existing.id });
    }
    const controlId = ctx.ids.next('migctl');
    ctx.store.db
      .prepare(
        `INSERT INTO migration_control_total
           (id, workspace_id, plan_id, step_id, kind, scope, declared_minor, computed_minor, difference_minor,
            status, waiver_reason, waived_by, waived_at, source_map_id, computed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'not_asserted', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(controlId, ctx.workspaceId, plan.id, stepId, input.kind, input.scope, input.declaredMinor, now, now);
    return ok({ controlId });
  });
}

// --- checkStep, the verb (US-G11.1 to G11.4, G11.7) ---------------------------------------------

export function checkStepVerb(
  ctx: WorkspaceContext,
  input: { planId: unknown; stepId: unknown; against?: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const against: unknown = input.against ?? 'testmandant';
  if (against !== 'testmandant' && against !== 'live') {
    return err('invalid_input', { field: 'against', expected: ['testmandant', 'live'] });
  }
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const step = loadStepRow(ctx, plan.id, input.stepId);
  if (step === undefined) return err('not_found', { stepId: input.stepId });
  if (step.status === 'skipped') return err('step_excluded', { stepId: step.id });

  // The verb itself is idempotent on (stepId, against, inputHash) INSIDE runCheck; the key wrapper
  // additionally memoises the exact call for the conformance double-call contract (§H-IDEMPOTENT).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_check_step');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_check_step', () => {
    const outcome = runCheck(ctx, plan, step, against);
    const failedCount = outcome.controls.filter((c) => c.status === 'failed').length;
    return ok({
      checkId: outcome.checkId,
      checkHash: outcome.checkHash,
      clean: outcome.clean,
      controls: outcome.controls,
      diverged: outcome.diverged,
      divergedControls: outcome.divergedControls,
      // OP8 null-collapse anchors: `migration.check_clean` / `migration.check_failed` resolve from
      // exactly one of these, so an occurrence exists only for the moment that happened.
      cleanCheckId: outcome.clean ? outcome.checkId : null,
      failedCheckId: failedCount > 0 ? outcome.checkId : null,
    });
  });
}

// --- getCheck / listChecks (US-G11.7) -----------------------------------------------------------

interface CheckDbRow {
  id: string;
  plan_id: string;
  step_id: string;
  against: string;
  check_hash: string;
  clean: number;
  controls: string;
  created_at: string;
}

function checkView(row: CheckDbRow): Record<string, unknown> {
  const controls = JSON.parse(row.controls) as ControlSnapshotRow[];
  const statusCounts: Record<string, number> = {};
  for (const c of controls) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  return {
    checkId: row.id,
    planId: row.plan_id,
    stepId: row.step_id,
    against: row.against,
    checkHash: row.check_hash,
    clean: row.clean === 1,
    createdAt: row.created_at,
    statusCounts,
  };
}

export function getCheck(ctx: WorkspaceContext, input: { checkId: unknown }): Result {
  if (typeof input.checkId !== 'string' || input.checkId.length === 0) return err('invalid_input', { field: 'checkId' });
  const row = ctx.store.db
    .prepare('SELECT * FROM migration_check WHERE id = ? AND workspace_id = ?')
    .get(input.checkId, ctx.workspaceId) as CheckDbRow | undefined;
  if (row === undefined) return err('not_found', { checkId: input.checkId });
  const controls = JSON.parse(row.controls) as ControlSnapshotRow[];
  return ok({
    check: checkView(row),
    controls,
    waivers: controls.filter((c) => c.status === 'waived').map((c) => ({ controlId: c.controlId, kind: c.kind, scope: c.scope, reason: c.waiverReason })),
  });
}

export function listChecks(
  ctx: WorkspaceContext,
  input: { planId: unknown; stepId?: unknown; against?: unknown; savedViewId?: unknown },
): Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  if (input.savedViewId !== undefined && typeof input.savedViewId !== 'string') {
    return err('invalid_input', { field: 'savedViewId' });
  }
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });

  // The G00 saved-view seam (F5 pattern): a stored stepId/against filter applies when only
  // savedViewId is named, and an explicit filter in the request wins over the stored one.
  const viewed = applySavedView(ctx, 'migration_check', {
    savedViewId: input.savedViewId as string | undefined,
    stepId: input.stepId,
    against: input.against,
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { stepId?: unknown; against?: unknown };

  const rows = ctx.store.db
    .prepare('SELECT * FROM migration_check WHERE workspace_id = ? AND plan_id = ? ORDER BY created_at DESC, id DESC')
    .all(ctx.workspaceId, plan.id) as CheckDbRow[];
  const checks = rows
    .filter((r) => (f.stepId === undefined || r.step_id === f.stepId) && (f.against === undefined || r.against === f.against))
    .map(checkView);
  return ok({ checks });
}

// --- waiveControl (US-G11.5) --------------------------------------------------------------------

export function waiveControl(
  ctx: WorkspaceContext,
  input: { controlId: unknown; reason: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.controlId, 'controlId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  // A waiver whose reason is blank is a silent one: refused, empty string included (P9, spec §2).
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return err('waiver_needs_reason', { controlId: input.controlId });
  }
  const row = ctx.store.db
    .prepare('SELECT id, status FROM migration_control_total WHERE id = ? AND workspace_id = ?')
    .get(input.controlId, ctx.workspaceId) as { id: string; status: string } | undefined;
  if (row === undefined) return err('not_found', { controlId: input.controlId });
  if (row.status === 'passed') return err('control_not_waivable', { controlId: row.id, status: row.status });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_waive_control');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_waive_control', () => {
    const now = ctx.clock.now();
    // WHO and WHY are recorded (spec: a waiver is part of the check and part of the export), and the
    // status is `waived`, never a silent pass: readiness renders "bereit, mit N Ausnahmen".
    ctx.store.db
      .prepare(
        `UPDATE migration_control_total SET status = 'waived', waiver_reason = ?, waived_by = ?, waived_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      )
      .run((input.reason as string).trim(), ctx.actor, now, now, row.id, ctx.workspaceId);
    return ok({ ok: true, controlId: row.id, status: 'waived' });
  });
}

// --- exportCheck: the Prüfbericht (US-G11.7) ----------------------------------------------------

export function exportCheck(ctx: WorkspaceContext, input: { checkId: unknown; format?: unknown }): Result {
  if (typeof input.checkId !== 'string' || input.checkId.length === 0) return err('invalid_input', { field: 'checkId' });
  const format = input.format ?? 'json';
  if (format !== 'json') return err('invalid_input', { field: 'format', supported: ['json'] });
  const row = ctx.store.db
    .prepare('SELECT * FROM migration_check WHERE id = ? AND workspace_id = ?')
    .get(input.checkId, ctx.workspaceId) as CheckDbRow | undefined;
  if (row === undefined) return err('not_found', { checkId: input.checkId });
  const plan = loadPlanRow(ctx, row.plan_id);
  const controls = JSON.parse(row.controls) as ControlSnapshotRow[];
  const files = ctx.store.db
    .prepare('SELECT file_id, sha256, as_at FROM migration_source_file WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at')
    .all(row.plan_id, ctx.workspaceId) as Array<{ file_id: string; sha256: string | null; as_at: string | null }>;

  // The machine layer stays LOCALE-NEUTRAL (raw integer Rappen, ISO dates), so the artifact is the
  // same bytes whoever exported it and the hash inside it stays checkable (P11, spec §6).
  const bericht = {
    artifact: 'migration_pruefbericht',
    version: 1,
    // OR 957a Abs. 2 Ziff. 1/2/5 (Vollständigkeit, Belegnachweis, Nachprüfbarkeit); OR 958c Abs. 1
    // Ziff. 2/7 and Abs. 2: the declared expectations are the Inventar of the opening position.
    basis: ['OR 957a Abs. 2 Ziff. 1', 'OR 957a Abs. 2 Ziff. 2', 'OR 957a Abs. 2 Ziff. 5', 'OR 958c Abs. 1 Ziff. 2', 'OR 958c Abs. 1 Ziff. 7', 'OR 958c Abs. 2'],
    checkId: row.id,
    checkHash: row.check_hash,
    clean: row.clean === 1,
    against: row.against,
    createdAt: row.created_at,
    plan: {
      planId: row.plan_id,
      sourceSystem: plan?.source_system ?? null,
      cutoverDate: plan?.cutover_date ?? null,
    },
    stepId: row.step_id,
    controls,
    waivers: controls.filter((c) => c.status === 'waived').map((c) => ({ controlId: c.controlId, kind: c.kind, scope: c.scope, reason: c.waiverReason })),
    sourceFiles: files.map((f) => ({ fileId: f.file_id, sha256: f.sha256, asAt: f.as_at })),
  };
  const content = JSON.stringify(bericht, null, 2);
  return ok({
    checkId: row.id,
    format: 'json',
    filename: ['migration_pruefbericht', row.id].join('_') + '.json',
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    checkHash: row.check_hash,
  });
}

// --- The G09 seam adapter (seams.ts binds to this; steps.ts is untouched) -----------------------

export interface SeamCheckControl {
  readonly id: string;
  readonly status: ControlStatusValue;
  readonly detail?: string;
}

/**
 * The shape `seams.ts` `checkStep` returns to `commitStep`: the real trial-run check, adapted to
 * the seam's own signature. The commit gate reads exactly this and refuses on any `failed` or
 * `not_asserted` control (G09 §4 condition 2), which is what makes `migration_check_step` the GATE
 * that lets G09 commit opening balances: a mis-tied total fails here and the commit refuses.
 */
export function seamCheckStep(
  ctx: WorkspaceContext,
  step: { readonly id: string },
): { controls: readonly SeamCheckControl[]; checkHash: string } {
  const stepRow = loadStepById(ctx, step.id);
  if (stepRow === undefined) {
    // A step the workspace does not hold asserts NOTHING (the honest seam default): the gate then
    // judges the commit on its other legs, and the not_found surfaces from the loaders that own it.
    return { controls: [], checkHash: sha256Canonical({ v: 1, missing: step.id }) };
  }
  const plan = loadPlanRow(ctx, stepRow.plan_id);
  if (plan === undefined) return { controls: [], checkHash: sha256Canonical({ v: 1, missing: stepRow.plan_id }) };
  const outcome = runCheck(ctx, plan, stepRow, 'testmandant');
  return {
    controls: outcome.controls.map((c) =>
      c.detail === null ? { id: c.controlId, status: c.status } : { id: c.controlId, status: c.status, detail: c.detail },
    ),
    checkHash: outcome.checkHash,
  };
}

/** An assertable fact for the §7 guard: the status enum EXCLUDES the retired brand word. */
export function controlStatusExcludesAmber(): boolean {
  return !isControlStatus('amber');
}
