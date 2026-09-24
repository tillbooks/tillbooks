/**
 * G20, the implementation project: the cutover as a first-class object (project, tasks, decisions,
 * sign-offs) and the phase/next-action derivation. The parallel-run reconciliation lives beside it in
 * `parallelRun.ts`; this file orchestrates it and owns the agent/human sign-off split.
 *
 * B00 IS NOT FORKED (spec §3). A B00 project is a client-billing object with rates and a P&L; an
 * implementation project is an internal governance object with phases, sign-offs and statutory
 * deadlines. This file imports NOTHING from the B00 billing-projects engine, asserted by the static
 * test in the suite (which greps for an import of that module).
 *
 * THE LOAD-BEARING INVARIANT (US-G20.5). `projectGet` computes a `passed` status for the parallel run
 * ONLY from (deterministic checks green AND the bound human sign-off). Each leg is independently
 * false-able, so a green sign-off over a failing check does not read as passed, and a clean check with
 * no sign-off does not either. A sign-off is VOIDED when its bound evidence changes (a re-run check
 * with a new hash), logged never silent, exactly as G09 voids approvals.
 *
 * §H-TENANT on every query; §H-IDEMPOTENT on every write. This file posts NOTHING (P3 by absence).
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { AGENT_ACTOR } from '../access/actors.js';
import { applySavedView } from '../customization/views.js';
import {
  MWST_METHODS,
  isMwstMethod,
  runParallelCheck,
  getParallelStatus,
  parallelRunPassed,
  type CheckedFigure,
} from './parallelRun.js';
import { runbookTemplate, listRunbookTemplates, RUNBOOK_TEMPLATE_IDS } from './runbooks/registry.js';

// --- §H-ENUM single sources (no CHECK in the schema; the enum lives here) ------------------------

/** The project phases, in order. The live phase is labelled "Stabilisierung" in the UI, never here. */
export const PHASES = [
  'discovery',
  'extraction',
  'mapping',
  'rehearsal',
  'cutover',
  'parallel_run',
  'live',
  'closed',
] as const;
export type Phase = (typeof PHASES)[number];
/** The terminal non-closed state a project reaches by being abandoned. Not a phase in the ladder. */
export const ABANDONED = 'abandoned' as const;

export const TASK_STATUSES = ['open', 'done', 'blocked', 'not_applicable'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OWNER_KINDS = ['human', 'agent', 'system'] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

/**
 * The FIXED sign-off kind enum (spec law, US-G20.5): what a human must sign. A configurable signer is
 * no split at all, so this enum and who may sign are §6b Fixed. EVERY kind is human-only: an agent is
 * refused all of them (P8: a sign-off is not draftable).
 */
export const SIGNOFF_KINDS = [
  'conversion_date',
  'mwst_method',
  'mapping_approval',
  'tieout',
  'contact_merge',
  'go_nogo',
  'rollback_trigger',
  'parallel_run_close',
  'source_cancellation',
] as const;
export type SignoffKind = (typeof SIGNOFF_KINDS)[number];

/** The sign-off kinds bound to the reconciliation evidence hash (the G11 checkHash discipline). */
const HASH_BOUND_KINDS: ReadonlySet<SignoffKind> = new Set(['tieout', 'parallel_run_close']);

export function isPhase(v: unknown): v is Phase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v);
}
export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}
export function isOwnerKind(v: unknown): v is OwnerKind {
  return typeof v === 'string' && (OWNER_KINDS as readonly string[]).includes(v);
}
export function isSignoffKind(v: unknown): v is SignoffKind {
  return typeof v === 'string' && (SIGNOFF_KINDS as readonly string[]).includes(v);
}

/** A human principal is any actor that is not the automated agent seat and not the system seat. */
export function actorIsHuman(actor: unknown): boolean {
  return typeof actor === 'string' && actor !== AGENT_ACTOR && actor !== 'system';
}

// --- Row types ----------------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  workspace_id: string;
  source_system: string;
  cutover_date: string;
  freeze_start: string | null;
  freeze_end: string | null;
  mwst_method: string;
  method_change: number;
  status: string;
  created_at: string;
  closed_at: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  phase: string;
  title: string;
  owner_kind: string;
  owner_ref: string | null;
  due_date: string | null;
  prerequisite_task_id: string | null;
  evidence_kind: string | null;
  evidence_ref: string | null;
  contingency: string | null;
  status: string;
  reason: string | null;
  template_item_id: string | null;
  undeletable: number;
  created_at: string;
  updated_at: string;
}

interface SignoffRow {
  id: string;
  kind: string;
  actor: string;
  evidence_ref: string;
  hash: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

function loadProjectRow(ctx: WorkspaceContext, projectId: unknown): ProjectRow | undefined {
  if (typeof projectId !== 'string' || projectId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM implementation_project WHERE id = ? AND workspace_id = ?')
    .get(projectId, ctx.workspaceId) as ProjectRow | undefined;
}

function tasksOf(ctx: WorkspaceContext, projectId: string): TaskRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM implementation_task WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId, projectId) as TaskRow[];
}

function signoffsOf(ctx: WorkspaceContext, projectId: string): SignoffRow[] {
  return ctx.store.db
    .prepare('SELECT id, kind, actor, evidence_ref, hash, voided_at, void_reason, created_at FROM implementation_signoff WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId, projectId) as SignoffRow[];
}

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --- Phase derivation (evidence-derived where possible, US-G20.1) --------------------------------

const PHASE_INDEX: ReadonlyMap<string, number> = new Map(PHASES.map((p, i) => [p, i]));

/**
 * The phase, DERIVED from the project's governance evidence and never allowed to run backwards.
 *
 * The strongest recorded sign-off names how far the implementation has come: `parallel_run_close` over
 * a clean parallel run means the Stabilisierung (live) has been reached; `conversion_date` means the
 * cutover committed; `go_nogo` means the cutover decision was taken; `mapping_approval` means mapping
 * is done. Below that, task completion within a phase advances it (an extraction task done means
 * mapping is open). The result is floored by the stored status so a manual advance is never undone,
 * and `closed`/`abandoned` are terminal.
 *
 * The cross-capability evidence the spec names as authoritative (the G19 manifest completing, a G12
 * Testmandant check passing, G09 money-path steps committing, G12 `go_productive`) is surfaced by a
 * linked plan; this derivation reads the project's own sign-offs and tasks, which record the same
 * milestones as the human acts they gate.
 */
function derivePhase(project: ProjectRow, tasks: readonly TaskRow[], liveSignoffKinds: ReadonlySet<string>, parallelClean: boolean): Phase | typeof ABANDONED {
  if (project.status === 'closed') return 'closed';
  if (project.status === ABANDONED) return ABANDONED;

  let idx = PHASE_INDEX.get(project.status) ?? 0;
  const bump = (phase: Phase): void => {
    const i = PHASE_INDEX.get(phase) ?? 0;
    if (i > idx) idx = i;
  };

  // Evidence gates, each implying the earlier ones.
  const doneInPhase = (phase: string): boolean => tasks.some((t) => t.phase === phase && t.status === 'done');
  if (doneInPhase('discovery')) bump('extraction');
  if (doneInPhase('extraction')) bump('mapping');
  if (liveSignoffKinds.has('mapping_approval') || doneInPhase('mapping')) bump('rehearsal');
  if (liveSignoffKinds.has('go_nogo')) bump('cutover');
  if (liveSignoffKinds.has('conversion_date')) bump('parallel_run');
  if (parallelClean && liveSignoffKinds.has('parallel_run_close')) bump('live');

  return (PHASES[idx] ?? 'discovery') as Phase;
}

// --- The reconciliation evidence hash (what a hash-bound sign-off binds to) -----------------------

/**
 * A locale-neutral hash over the LATEST parallel-run check of every declared period. A hash-bound
 * sign-off (tieout, parallel_run_close) binds this; a re-run check that changes any figure moves it,
 * which is what voids a sign-off whose evidence changed (US-G20.5).
 */
export function reconciliationEvidenceHash(ctx: WorkspaceContext, projectId: string): string {
  const status = getParallelStatus(ctx, { projectId });
  if (!status.ok) return sha256Canonical({ v: 1, empty: projectId });
  const periods = status.periods as ReadonlyArray<{ period: string; status: string; figures: CheckedFigure[] }>;
  return sha256Canonical({
    v: 1,
    projectId,
    periods: [...periods]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((p) => ({
        period: p.period,
        status: p.status,
        figures: p.figures.map((f) => ({ kind: f.kind, ref: f.ref, declaredRappen: f.declaredRappen, computedRappen: f.computedRappen, status: f.status })),
      })),
  });
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Void every live hash-bound sign-off whose bound hash no longer matches the current evidence. */
function voidStaleSignoffs(ctx: WorkspaceContext, projectId: string): void {
  const currentHash = reconciliationEvidenceHash(ctx, projectId);
  const now = ctx.clock.now();
  const stale = ctx.store.db
    .prepare(
      "SELECT id FROM implementation_signoff WHERE workspace_id = ? AND project_id = ? AND voided_at IS NULL AND hash IS NOT NULL AND hash <> ? AND kind IN ('tieout','parallel_run_close')",
    )
    .all(ctx.workspaceId, projectId, currentHash) as Array<{ id: string }>;
  for (const s of stale) {
    ctx.store.db
      .prepare('UPDATE implementation_signoff SET voided_at = ?, void_reason = ? WHERE id = ? AND workspace_id = ?')
      .run(now, 'Gebundener Nachweis hat sich geändert (neuer Prüf-Hash)', s.id, ctx.workspaceId);
  }
}

// --- projectCreate (US-G20.1) -------------------------------------------------------------------

export function projectCreate(
  ctx: WorkspaceContext,
  input: { sourceSystem: unknown; cutoverDate: unknown; freezeStart?: unknown; freezeEnd?: unknown; mwstMethod: unknown; methodChange?: unknown; idempotencyKey: unknown },
): Result {
  const guard =
    reqStr(input.sourceSystem, 'sourceSystem') ??
    reqStr(input.cutoverDate, 'cutoverDate') ??
    reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (typeof input.cutoverDate !== 'string' || !ISO_DAY.test(input.cutoverDate)) {
    return err('invalid_input', { field: 'cutoverDate', expected: 'YYYY-MM-DD' });
  }
  if (!isMwstMethod(input.mwstMethod)) return err('invalid_input', { field: 'mwstMethod', expected: MWST_METHODS });
  const freezeStart = input.freezeStart ?? null;
  const freezeEnd = input.freezeEnd ?? null;
  if (freezeStart !== null && (typeof freezeStart !== 'string' || !ISO_DAY.test(freezeStart))) {
    return err('invalid_input', { field: 'freezeStart', expected: 'YYYY-MM-DD' });
  }
  if (freezeEnd !== null && (typeof freezeEnd !== 'string' || !ISO_DAY.test(freezeEnd))) {
    return err('invalid_input', { field: 'freezeEnd', expected: 'YYYY-MM-DD' });
  }
  if (freezeStart !== null && freezeEnd !== null && (freezeEnd as string) < (freezeStart as string)) {
    return err('freeze_window_inverted', { freezeStart, freezeEnd });
  }
  // The cutover date is the anchor every reconciliation figure is declared against, so a date in the
  // past at creation refuses (P9): a reconciliation window cannot precede its own anchor.
  const today = ctx.clock.now().slice(0, 10);
  if ((input.cutoverDate as string) < today) return err('cutover_in_past', { cutoverDate: input.cutoverDate, today });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_create');
  if (replayed !== undefined) return replayed;

  // One OPEN project per workspace (P9). Checked before the insert so the error is structured; the
  // partial unique index is the structural backstop.
  const open = ctx.store.db
    .prepare("SELECT id FROM implementation_project WHERE workspace_id = ? AND status NOT IN ('closed','abandoned') LIMIT 1")
    .get(ctx.workspaceId) as { id: string } | undefined;
  if (open !== undefined) return err('project_already_open', { projectId: open.id });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_create', () => {
    const now = ctx.clock.now();
    const projectId = ctx.ids.next('implproj');
    ctx.store.db
      .prepare(
        `INSERT INTO implementation_project
           (id, workspace_id, source_system, cutover_date, freeze_start, freeze_end, mwst_method, method_change, status, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovery', ?, NULL)`,
      )
      .run(
        projectId,
        ctx.workspaceId,
        input.sourceSystem as string,
        input.cutoverDate as string,
        freezeStart,
        freezeEnd,
        input.mwstMethod as string,
        input.methodChange === true ? 1 : 0,
        now,
      );
    return ok({ projectId });
  });
}

// --- projectInstantiateRunbook (US-G20.2) -------------------------------------------------------

/** The fiscal-year end for a cutover, from the workspace fiscal_year_start (defaults to calendar). */
function fiscalYearEndFor(ctx: WorkspaceContext, cutoverDate: string, priorYear: boolean): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string | null } | undefined;
  const cutYear = Number(cutoverDate.slice(0, 4));
  const start = row?.fiscal_year_start ?? '';
  // Accept a MM-DD fiscal-year start; otherwise fall back to the calendar year (Dec 31).
  const mmdd = /^(\d{2})-(\d{2})$/.exec(start);
  const year = priorYear ? cutYear - 1 : cutYear;
  if (mmdd === null || (mmdd[1] === '01' && mmdd[2] === '01')) {
    return `${year}-12-31`;
  }
  // Fiscal year ending: the day before the fiscal-year start, in the target year.
  const startThisYear = `${year}-${mmdd[1]}-${mmdd[2]}`;
  return addDays(startThisYear, -1);
}

export function projectInstantiateRunbook(
  ctx: WorkspaceContext,
  input: { projectId: unknown; templateId: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.projectId, 'projectId') ?? reqStr(input.templateId, 'templateId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const project = loadProjectRow(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });
  const template = runbookTemplate(input.templateId);
  if (template === undefined) return err('unknown_runbook_template', { templateId: input.templateId, known: RUNBOOK_TEMPLATE_IDS });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_instantiate_runbook');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_instantiate_runbook', () => {
    const now = ctx.clock.now();
    // Map template item ids to the minted task ids so prerequisites resolve within the batch.
    const idByItem = new Map<string, string>();
    for (const item of template.items) idByItem.set(item.itemId, ctx.ids.next('impltask'));

    const created: Array<Record<string, unknown>> = [];
    for (const item of template.items) {
      const taskId = idByItem.get(item.itemId) as string;
      let dueDate: string | null = null;
      if (item.deadlineRule === 'umsatzabstimmung_180') dueDate = addDays(fiscalYearEndFor(ctx, project.cutover_date, false), 180);
      else if (item.deadlineRule === 'berichtigung_240') dueDate = addDays(fiscalYearEndFor(ctx, project.cutover_date, false), 240);
      else if (item.deadlineRule === 'prior_year_umsatzabstimmung') dueDate = addDays(fiscalYearEndFor(ctx, project.cutover_date, true), 180);
      else if (item.dueOffsetDays !== undefined) dueDate = addDays(project.cutover_date, item.dueOffsetDays);

      const prereq = item.prerequisiteItemId === undefined ? null : idByItem.get(item.prerequisiteItemId) ?? null;
      ctx.store.db
        .prepare(
          `INSERT INTO implementation_task
             (id, workspace_id, project_id, phase, title, owner_kind, owner_ref, due_date, prerequisite_task_id,
              evidence_kind, evidence_ref, contingency, status, reason, template_item_id, undeletable, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', NULL, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          ctx.workspaceId,
          project.id,
          item.phase,
          item.title,
          item.ownerKind,
          item.ownerRef ?? null,
          dueDate,
          prereq,
          item.evidenceKind ?? null,
          item.contingency ?? null,
          item.itemId,
          item.undeletable === true ? 1 : 0,
          now,
          now,
        );
      created.push({ taskId, itemId: item.itemId, phase: item.phase, title: item.title, ownerKind: item.ownerKind, dueDate, undeletable: item.undeletable === true });
    }
    return ok({ projectId: project.id, templateId: template.templateId, tasks: created });
  });
}

// --- projectSetTask (US-G20.2) ------------------------------------------------------------------

function taskView(t: TaskRow): Record<string, unknown> {
  return {
    taskId: t.id,
    phase: t.phase,
    title: t.title,
    ownerKind: t.owner_kind,
    ownerRef: t.owner_ref,
    dueDate: t.due_date,
    prerequisiteTaskId: t.prerequisite_task_id,
    evidenceKind: t.evidence_kind,
    evidenceRef: t.evidence_ref,
    contingency: t.contingency,
    status: t.status,
    reason: t.reason,
    templateItemId: t.template_item_id,
    undeletable: t.undeletable === 1,
  };
}

export function projectSetTask(
  ctx: WorkspaceContext,
  input: { projectId: unknown; taskId?: unknown; fields?: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.projectId, 'projectId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const project = loadProjectRow(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });
  const fields = (input.fields ?? {}) as Record<string, unknown>;

  if (fields.status !== undefined && !isTaskStatus(fields.status)) {
    return err('invalid_input', { field: 'fields.status', expected: TASK_STATUSES });
  }
  if (fields.ownerKind !== undefined && !isOwnerKind(fields.ownerKind)) {
    return err('invalid_input', { field: 'fields.ownerKind', expected: OWNER_KINDS });
  }
  if (fields.phase !== undefined && !isPhase(fields.phase)) {
    return err('invalid_input', { field: 'fields.phase', expected: PHASES.filter((p) => p !== 'closed') });
  }

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_set_task');
  if (replayed !== undefined) return replayed;

  // Load the existing task (update) or prepare a create. Validation that can refuse happens BEFORE the
  // idempotent remember so a refusal is not memoised as a success.
  let existing: TaskRow | undefined;
  if (input.taskId !== undefined) {
    if (typeof input.taskId !== 'string') return err('invalid_input', { field: 'taskId' });
    existing = ctx.store.db
      .prepare('SELECT * FROM implementation_task WHERE id = ? AND project_id = ? AND workspace_id = ?')
      .get(input.taskId, project.id, ctx.workspaceId) as TaskRow | undefined;
    if (existing === undefined) return err('not_found', { taskId: input.taskId });
  }

  const nextStatus = (fields.status as TaskStatus | undefined) ?? (existing?.status as TaskStatus | undefined) ?? 'open';
  const evidenceKind = fields.evidenceKind !== undefined ? (fields.evidenceKind as string | null) : (existing?.evidence_kind ?? null);
  const evidenceRef = fields.evidenceRef !== undefined ? (fields.evidenceRef as string | null) : (existing?.evidence_ref ?? null);
  const prerequisiteId = existing?.prerequisite_task_id ?? null;
  const undeletable = existing?.undeletable === 1;

  // Completing a task whose prerequisite is still open refuses, naming it (US-G20.2).
  if (nextStatus === 'done' && prerequisiteId !== null) {
    const prereq = ctx.store.db
      .prepare('SELECT status FROM implementation_task WHERE id = ? AND workspace_id = ?')
      .get(prerequisiteId, ctx.workspaceId) as { status: string } | undefined;
    if (prereq !== undefined && prereq.status !== 'done' && prereq.status !== 'not_applicable') {
      return err('prerequisite_open', { taskId: input.taskId, prerequisiteTaskId: prerequisiteId, prerequisiteStatus: prereq.status });
    }
  }
  // Completing a task that requires evidence without it refuses, naming the kind (US-G20.2).
  if (nextStatus === 'done' && evidenceKind !== null && (evidenceRef === null || evidenceRef.length === 0)) {
    return err('evidence_required', { taskId: input.taskId, evidenceKind });
  }
  // not_applicable needs a recorded reason: the canon may be waived consciously, never dropped
  // silently (US-G20.2). This is the only status an undeletable go/no-go or rollback task may take
  // other than done/open/blocked.
  const reason = fields.reason !== undefined ? (fields.reason as string | null) : (existing?.reason ?? null);
  if (nextStatus === 'not_applicable' && (reason === null || (reason as string).trim().length === 0)) {
    return err('not_applicable_needs_reason', { taskId: input.taskId, undeletable });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_set_task', () => {
    const now = ctx.clock.now();
    let task: TaskRow;
    let blocked = false;
    if (existing === undefined) {
      const title = typeof fields.title === 'string' && fields.title.length > 0 ? fields.title : 'Aufgabe';
      const phase = isPhase(fields.phase) ? (fields.phase as string) : 'discovery';
      const ownerKind = isOwnerKind(fields.ownerKind) ? (fields.ownerKind as string) : 'human';
      const taskId = ctx.ids.next('impltask');
      ctx.store.db
        .prepare(
          `INSERT INTO implementation_task
             (id, workspace_id, project_id, phase, title, owner_kind, owner_ref, due_date, prerequisite_task_id,
              evidence_kind, evidence_ref, contingency, status, reason, template_item_id, undeletable, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
        )
        .run(
          taskId, ctx.workspaceId, project.id, phase, title, ownerKind,
          (fields.ownerRef as string | undefined) ?? null,
          (fields.due as string | undefined) ?? null,
          evidenceKind, evidenceRef,
          (fields.contingency as string | undefined) ?? null,
          nextStatus, reason, now, now,
        );
      task = ctx.store.db.prepare('SELECT * FROM implementation_task WHERE id = ? AND workspace_id = ?').get(taskId, ctx.workspaceId) as TaskRow;
    } else {
      ctx.store.db
        .prepare(
          `UPDATE implementation_task
              SET phase = ?, title = ?, owner_kind = ?, owner_ref = ?, due_date = ?, evidence_kind = ?, evidence_ref = ?,
                  contingency = ?, status = ?, reason = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .run(
          isPhase(fields.phase) ? (fields.phase as string) : existing.phase,
          typeof fields.title === 'string' && fields.title.length > 0 ? fields.title : existing.title,
          isOwnerKind(fields.ownerKind) ? (fields.ownerKind as string) : existing.owner_kind,
          fields.ownerRef !== undefined ? (fields.ownerRef as string | null) : existing.owner_ref,
          fields.due !== undefined ? (fields.due as string | null) : existing.due_date,
          evidenceKind, evidenceRef,
          fields.contingency !== undefined ? (fields.contingency as string | null) : existing.contingency,
          nextStatus, reason, now, existing.id, ctx.workspaceId,
        );
      task = ctx.store.db.prepare('SELECT * FROM implementation_task WHERE id = ? AND workspace_id = ?').get(existing.id, ctx.workspaceId) as TaskRow;
    }
    blocked = task.status === 'blocked';

    // Recompute the derived phase now the task set may have advanced it, and persist it so the roster
    // and reads see it without a recompute. `phaseChangedTo` is the OP8 null-collapse anchor: the
    // project id when the phase advanced, null otherwise, so `project.phase_changed` fires once per
    // real transition (other transitions are observed on the next read).
    const allTasks = tasksOf(ctx, project.id);
    const liveSignoffKinds = new Set(signoffsOf(ctx, project.id).filter((s) => s.voided_at === null).map((s) => s.kind));
    const parallelClean = parallelRunPassed(ctx, project.id);
    const newPhase = derivePhase(project, allTasks, liveSignoffKinds, parallelClean);
    let phaseChangedTo: string | null = null;
    if (newPhase !== project.status && newPhase !== ABANDONED) {
      ctx.store.db
        .prepare("UPDATE implementation_project SET status = ? WHERE id = ? AND workspace_id = ?")
        .run(newPhase, project.id, ctx.workspaceId);
      phaseChangedTo = project.id;
    }

    return ok({
      task: taskView(task),
      // OP8 null-collapse anchors: each event fires only for the moment that happened.
      blockedTaskId: blocked ? task.id : null,
      phaseChangedTo,
    });
  });
}

// --- projectRecordDecision (US-G20.1, append-only) ----------------------------------------------

export function projectRecordDecision(
  ctx: WorkspaceContext,
  input: { projectId: unknown; title: unknown; context?: unknown; decision: unknown; idempotencyKey: unknown },
): Result {
  const guard =
    reqStr(input.projectId, 'projectId') ??
    reqStr(input.title, 'title') ??
    reqStr(input.decision, 'decision') ??
    reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const project = loadProjectRow(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_record_decision');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_record_decision', () => {
    const now = ctx.clock.now();
    const decisionId = ctx.ids.next('impldec');
    ctx.store.db
      .prepare(
        `INSERT INTO implementation_decision (id, workspace_id, project_id, title, context, decision, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(decisionId, ctx.workspaceId, project.id, input.title as string, (input.context as string | undefined) ?? null, input.decision as string, ctx.actor, now);
    return ok({ decisionId });
  });
}

// --- projectRecordSignoff (US-G20.5, human-only, hash-bound where required) ----------------------

export function projectRecordSignoff(
  ctx: WorkspaceContext,
  input: { projectId: unknown; kind: unknown; evidenceRef: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.projectId, 'projectId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!isSignoffKind(input.kind)) return err('invalid_input', { field: 'kind', expected: SIGNOFF_KINDS });
  if (typeof input.evidenceRef !== 'string' || input.evidenceRef.length === 0) {
    return err('invalid_input', { field: 'evidenceRef' });
  }
  const project = loadProjectRow(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });

  // THE HUMAN-ONLY REFUSAL (P8, spec law): every kind is a human act. A sign-off is not draftable: an
  // agent (or the system seat) is refused rather than staged, whatever capability it holds.
  if (!actorIsHuman(ctx.actor)) {
    return err('signoff_needs_human', { kind: input.kind, actor: ctx.actor });
  }

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_record_signoff');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_record_signoff', () => {
    const now = ctx.clock.now();
    const signoffId = ctx.ids.next('implsig');
    // Hash-bound kinds bind the current reconciliation evidence hash (the G11 checkHash discipline):
    // a later check that changes the evidence voids this sign-off.
    const hash = HASH_BOUND_KINDS.has(input.kind as SignoffKind) ? reconciliationEvidenceHash(ctx, project.id) : null;
    ctx.store.db
      .prepare(
        `INSERT INTO implementation_signoff (id, workspace_id, project_id, kind, actor, evidence_ref, hash, voided_at, void_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(signoffId, ctx.workspaceId, project.id, input.kind as string, ctx.actor, input.evidenceRef as string, hash, now);
    return ok({ signoffId, kind: input.kind, hash, boundToEvidence: hash !== null });
  });
}

// --- projectDeclareParallelFigures / runParallelCheck (delegated to parallelRun.ts) --------------

export { declareParallelFigures, getParallelStatus } from './parallelRun.js';

/**
 * The check verb wrapper: runs the parallel check, then voids any hash-bound sign-off whose evidence
 * changed (US-G20.5). The voiding lives HERE (not in parallelRun.ts) because it writes to the sign-off
 * table this file owns; the check verb is a WRITE, so voiding on evidence change is a legitimate write.
 */
export function runParallelCheckVerb(ctx: WorkspaceContext, input: { projectId: unknown; period: unknown; idempotencyKey: unknown }): Result {
  const outcome = runParallelCheck(ctx, input);
  if (outcome.ok && typeof input.projectId === 'string') voidStaleSignoffs(ctx, input.projectId);
  return outcome;
}

// --- projectGet (US-G20.1 / US-G20.5, the load-bearing invariant) --------------------------------

/** The blocked-first, phase-ordered task ordering the surface and the nextAction both read. */
function orderedTasks(tasks: readonly TaskRow[]): TaskRow[] {
  const phaseRank = (p: string): number => PHASE_INDEX.get(p) ?? 99;
  const statusRank = (s: string): number => (s === 'blocked' ? 0 : s === 'open' ? 1 : s === 'not_applicable' ? 2 : 3);
  return [...tasks].sort((a, b) => statusRank(a.status) - statusRank(b.status) || phaseRank(a.phase) - phaseRank(b.phase) || a.created_at.localeCompare(b.created_at));
}

export function projectGet(ctx: WorkspaceContext, input: { projectId: unknown; savedViewId?: unknown }): Result {
  const project = loadProjectRow(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });
  if (input.savedViewId !== undefined && typeof input.savedViewId !== 'string') return err('invalid_input', { field: 'savedViewId' });

  // The G00 saved-view seam: project_get is the coverage read over the task list (its `tasks[]`), the
  // `migration_get_plan` / `project_get` precedent. A saved view over `implementation_task` stores a
  // status/phase filter applied to the returned tasks; an explicit filter is not offered here (the
  // read returns the whole project), so a stored filter narrows the task list only.
  const viewed = applySavedView(ctx, 'implementation_task', { savedViewId: input.savedViewId as string | undefined });
  if (!viewed.ok) return viewed;
  const taskFilter = viewed.filter as { status?: unknown; phase?: unknown };

  const tasks = tasksOf(ctx, project.id);
  const signoffs = signoffsOf(ctx, project.id);
  const liveSignoffKinds = new Set(signoffs.filter((s) => s.voided_at === null).map((s) => s.kind));
  const parallelClean = parallelRunPassed(ctx, project.id);
  const phase = derivePhase(project, tasks, liveSignoffKinds, parallelClean);

  const currentHash = reconciliationEvidenceHash(ctx, project.id);
  const liveHashBound = (kind: SignoffKind): boolean =>
    signoffs.some((s) => s.voided_at === null && s.kind === kind && s.hash === currentHash);

  // THE PASSED CONJUNCTIONS (US-G20.5): passed ONLY from deterministic checks green AND the bound
  // human sign-off. Each leg independently false-able.
  const parallelPassed = parallelClean && liveHashBound('parallel_run_close');
  const tieoutPassed = parallelClean && liveHashBound('tieout');

  const ordered = orderedTasks(tasks);
  const firstBlocking = ordered.find((t) => t.status === 'blocked' || t.status === 'open');
  const nextAction = nextActionFor(phase, firstBlocking);
  // A stored view narrows the DISPLAYED task list only (never the phase derivation above).
  const orderedForView = ordered.filter(
    (task) =>
      (taskFilter.status === undefined || task.status === taskFilter.status) &&
      (taskFilter.phase === undefined || task.phase === taskFilter.phase),
  );

  const parallel = getParallelStatus(ctx, { projectId: project.id });

  return ok({
    project: {
      projectId: project.id,
      sourceSystem: project.source_system,
      cutoverDate: project.cutover_date,
      freezeStart: project.freeze_start,
      freezeEnd: project.freeze_end,
      mwstMethod: project.mwst_method,
      methodChange: project.method_change === 1,
      status: phase,
      createdAt: project.created_at,
      closedAt: project.closed_at,
    },
    phase,
    phases: PHASES.filter((p) => p !== 'closed'),
    nextAction,
    tasks: orderedForView.map(taskView),
    decisions: (ctx.store.db
      .prepare('SELECT id, title, context, decision, actor, created_at FROM implementation_decision WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id')
      .all(ctx.workspaceId, project.id) as Array<{ id: string; title: string; context: string | null; decision: string; actor: string; created_at: string }>).map((d) => ({
      decisionId: d.id,
      title: d.title,
      context: d.context,
      decision: d.decision,
      actor: d.actor,
      createdAt: d.created_at,
    })),
    signoffs: signoffs.map((s) => ({
      signoffId: s.id,
      kind: s.kind,
      actor: s.actor,
      evidenceRef: s.evidence_ref,
      hash: s.hash,
      voided: s.voided_at !== null,
      voidedAt: s.voided_at,
      voidReason: s.void_reason,
      createdAt: s.created_at,
    })),
    parallelRun: parallel.ok ? { periods: parallel.periods, overall: parallel.overall } : { periods: [], overall: 'not_asserted' },
    // The empty-state picker (US-G20.2): what each shipped runbook template covers. Kept on the read
    // rather than minting a 12th verb; the Studio offers these when no runbook is instantiated yet.
    availableRunbookTemplates: listRunbookTemplates(),
    // The load-bearing computed statuses: NEVER presented as passed without both legs (US-G20.5).
    tieout: { passed: tieoutPassed, checksClean: parallelClean, signoffBound: liveHashBound('tieout') },
    parallel: { passed: parallelPassed, checksClean: parallelClean, signoffBound: liveHashBound('parallel_run_close') },
  });
}

function nextActionFor(phase: Phase | typeof ABANDONED, task: TaskRow | undefined): string {
  if (task !== undefined) return task.title;
  if (phase === 'discovery') return 'Exportliste anlegen';
  if (phase === 'closed') return 'Projekt abgeschlossen';
  return 'Keine offene Aufgabe';
}

// --- projectList (US-G20.4, workspace-scoped roster metadata) -------------------------------------

/**
 * The roster metadata for THIS workspace (the roster composes N of these over A23, client-side). Each
 * row is metadata only (phase, first blocker + owner kind, days to cutover): no figure, no contact, no
 * document. §H-TENANT: this reads only the current workspace, never across the fence.
 */
export function projectList(ctx: WorkspaceContext, input: { status?: unknown; savedViewId?: unknown }): Result {
  if (input.savedViewId !== undefined && typeof input.savedViewId !== 'string') return err('invalid_input', { field: 'savedViewId' });
  // The G00 saved-view seam (F5 pattern): a stored status filter applies when only savedViewId is
  // named, and an explicit status in the request wins over the stored one.
  const viewed = applySavedView(ctx, 'implementation_project', {
    savedViewId: input.savedViewId as string | undefined,
    status: input.status,
  });
  if (!viewed.ok) return viewed;
  const statusFilter = (viewed.filter as { status?: unknown }).status;
  if (statusFilter !== undefined && typeof statusFilter !== 'string') return err('invalid_input', { field: 'status' });
  const rows = ctx.store.db
    .prepare('SELECT * FROM implementation_project WHERE workspace_id = ? ORDER BY created_at DESC, id DESC')
    .all(ctx.workspaceId) as ProjectRow[];
  const today = ctx.clock.now().slice(0, 10);
  const projects = rows
    .filter((r) => statusFilter === undefined || r.status === statusFilter)
    .map((project) => {
      const tasks = tasksOf(ctx, project.id);
      const signoffs = signoffsOf(ctx, project.id);
      const liveSignoffKinds = new Set(signoffs.filter((s) => s.voided_at === null).map((s) => s.kind));
      const parallelClean = parallelRunPassed(ctx, project.id);
      const phase = derivePhase(project, tasks, liveSignoffKinds, parallelClean);
      const firstBlocker = orderedTasks(tasks).find((t) => t.status === 'blocked' || t.status === 'open');
      return {
        projectId: project.id,
        phase,
        firstBlocker: firstBlocker === undefined ? null : { taskId: firstBlocker.id, title: firstBlocker.title, ownerKind: firstBlocker.owner_kind, blocked: firstBlocker.status === 'blocked' },
        daysToCutover: Math.round((Date.parse(`${project.cutover_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000),
      };
    });
  // Blocked-first, then by cutover proximity (US-G20.4).
  projects.sort((a, b) => {
    const ab = a.firstBlocker?.blocked === true ? 0 : 1;
    const bb = b.firstBlocker?.blocked === true ? 0 : 1;
    return ab - bb || a.daysToCutover - b.daysToCutover;
  });
  return ok({ projects });
}

// --- projectClose (US-G20.1) --------------------------------------------------------------------

export function projectClose(
  ctx: WorkspaceContext,
  input: { projectId: unknown; confirmed?: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.projectId, 'projectId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const project = loadProjectRow(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });
  if (input.confirmed !== true) return err('confirmation_required', { projectId: project.id });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_close');
  if (replayed !== undefined) return replayed;

  // Already closed: idempotent no-op (a second confirmed close of a closed project).
  if (project.status === 'closed') {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_close', () => ok({ ok: true, projectId: project.id, alreadyClosed: true }));
  }

  const tasks = tasksOf(ctx, project.id);
  const signoffs = signoffsOf(ctx, project.id);
  const liveSignoffKinds = new Set(signoffs.filter((s) => s.voided_at === null).map((s) => s.kind));
  const parallelClean = parallelRunPassed(ctx, project.id);
  const phase = derivePhase(project, tasks, liveSignoffKinds, parallelClean);

  // Each close leg refuses in ISOLATION, naming what is open (§8).
  if (phase !== 'live') return err('project_not_live', { projectId: project.id, phase });

  const liveOrParallelTasksTerminal = tasks
    .filter((t) => t.phase === 'live' || t.phase === 'parallel_run')
    .every((t) => t.status === 'done' || t.status === 'not_applicable');
  if (!liveOrParallelTasksTerminal) {
    const openTask = tasks.find((t) => (t.phase === 'live' || t.phase === 'parallel_run') && t.status !== 'done' && t.status !== 'not_applicable');
    return err('stabilisation_tasks_open', { projectId: project.id, taskId: openTask?.id, title: openTask?.title });
  }

  const signoffOrWaived = (kind: SignoffKind, itemId: string): boolean => {
    if (liveSignoffKinds.has(kind)) return true;
    // Or the corresponding canon task marked not_applicable with a reason.
    return tasks.some((t) => t.template_item_id === itemId && t.status === 'not_applicable');
  };
  if (!signoffOrWaived('parallel_run_close', 'parallel_run_close')) {
    return err('parallel_run_not_closed', { projectId: project.id, needs: 'parallel_run_close' });
  }
  if (!signoffOrWaived('source_cancellation', 'source_cancellation')) {
    return err('source_not_cancelled', { projectId: project.id, needs: 'source_cancellation' });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_close', () => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE implementation_project SET status = 'closed', closed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, project.id, ctx.workspaceId);
    return ok({ ok: true, projectId: project.id, closedAt: now });
  });
}

