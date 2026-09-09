/**
 * G22 checklist runs: start, read (checks live), list, complete, skip, reopen, abandon (spec §4).
 *
 * THE STATE IS DERIVED ON EVERY READ. A system check item is done while its check passes and open
 * again the moment it does not; a verb item is done while the hash the engine bound equals the live
 * computed-return hash and reads `stale` (open again) when the figures moved; a sign-off item is done
 * while a live, non-voided sign-off of its kind exists and, for the bridge review, its hash still
 * matches. The run is `done` when every item is done or skipped, never stored: a stored `done` would
 * be a claim a later posting could falsify without anyone noticing.
 *
 * EVIDENCE IS WHAT THE ENGINE COMPUTED, NEVER WHAT A CALLER TYPED. Completing `vat_return_computed`
 * re-runs A07's `computeVatReturn` and binds its hash; completing `ech0217_exported` re-runs the pure
 * export and binds the same hash (the figures the file carries). `vat_export_ech0217` itself stays a
 * read (the conformance gate forbids a read verb from writing), so the recording lives here, in the
 * write, and a GUI click without a successful export cannot flip the item. A caller may pass the ref
 * it saw; it must agree or the completion refuses `evidence_mismatch`.
 *
 * SIGN-OFFS ARE APPEND-ONLY (G20's discipline): a second attestation while one is live is refused
 * `already_attested`; a reopen voids (never deletes) the live sign-off; a re-signed bridge review voids
 * the stale one with `hash_changed`. The actor is RECORDED, not refused: the owner closes alone (D127)
 * and an agent acting on the owner's behalf is named in words on the row and in the audit log.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { listVatPeriods, exportVatReturnEch0217 } from '../vat/index.js';
import { AGENT_ACTOR, SERVED_MEMBER_ACTOR_PREFIX } from '../access/actors.js';
import { checklistTemplate, CHECKLIST_TEMPLATE_IDS } from './canon/index.js';
import { resolveDueDates } from './deadlines.js';
import { evaluateCheck, liveReturnOf, type CheckResult, type LiveReturn } from './checks.js';
import { prerequisitesOf, type ChecklistTemplate, type ChecklistTemplateItem, type ChecklistSignoffKind } from './types.js';

// --- §H-ENUM single sources ----------------------------------------------------------------------

/** A run's derived status. `done` is never stored. */
export const CHECKLIST_RUN_STATUSES = ['open', 'done', 'abandoned'] as const;
export type ChecklistRunStatus = (typeof CHECKLIST_RUN_STATUSES)[number];

/** An item's status, stored AND derived (the derivation may read `open` over a stored `done`). */
export const CHECKLIST_ITEM_STATUSES = ['open', 'done', 'skipped'] as const;
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

/** How an actor id is named on screen: the words for a seat, or a member's display name. */
export type ChecklistActorKind = 'agent' | 'studio' | 'member' | 'unknown';

// --- Rows ----------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  workspace_id: string;
  template_id: string;
  period_label: string;
  period_start: string;
  period_end: string;
  status: string;
  created_by: string;
  created_key: string;
  created_at: string;
  abandoned_at: string | null;
  abandoned_by: string | null;
  abandon_reason: string | null;
}

interface ItemRow {
  id: string;
  workspace_id: string;
  run_id: string;
  item_id: string;
  position: number;
  owner_kind: string;
  due_at: string | null;
  status: string;
  completed_by: string | null;
  completed_at: string | null;
  completed_key: string | null;
  evidence_kind: string | null;
  evidence_ref: string | null;
  evidence_hash: string | null;
  skip_reason: string | null;
  skipped_by: string | null;
  skipped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SignoffRow {
  id: string;
  workspace_id: string;
  run_id: string;
  run_item_id: string;
  kind: string;
  actor: string;
  evidence_ref: string;
  hash: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

// --- Views ---------------------------------------------------------------------------------------

export interface ChecklistSignoffView {
  readonly signoffId: string;
  readonly kind: string;
  readonly actor: string;
  readonly actorKind: ChecklistActorKind;
  readonly actorName: string | null;
  readonly evidenceRef: string;
  readonly hash: string | null;
  readonly createdAt: string;
  /** True when the bound hash no longer equals the live computed return (Freigabe hinfällig). */
  readonly stale: boolean;
}

export interface ChecklistItemView {
  readonly runItemId: string;
  readonly itemId: string;
  readonly position: number;
  readonly title: string;
  readonly ownerKind: string;
  readonly evidenceKind: string;
  readonly check: string | null;
  readonly precondition: string | null;
  readonly verb: string | null;
  readonly deepLink: string | null;
  readonly signoffKind: string | null;
  readonly requiresEvidenceRef: boolean;
  readonly prerequisiteItemIds: readonly string[];
  readonly dueAt: string | null;
  readonly undeletable: boolean;
  /** The LIVE status the read derives. */
  readonly status: ChecklistItemStatus;
  /** The status the row stores (a stored `done` may read `open` when its evidence went stale). */
  readonly storedStatus: string;
  /** A stored completion whose bound hash no longer matches the live return. */
  readonly stale: boolean;
  /** The first prerequisite that is neither done nor skipped, or null. */
  readonly blockedBy: string | null;
  readonly checkResult: CheckResult | null;
  readonly preconditionResult: CheckResult | null;
  readonly completedBy: string | null;
  readonly completedByKind: ChecklistActorKind | null;
  readonly completedByName: string | null;
  readonly completedAt: string | null;
  readonly evidence: { kind: string; ref: string | null } | null;
  readonly signoff: ChecklistSignoffView | null;
  readonly skipReason: string | null;
  readonly skippedBy: string | null;
  readonly skippedAt: string | null;
}

export interface ChecklistRunView {
  readonly runId: string;
  readonly templateId: string;
  readonly templateLabel: string;
  readonly kind: string;
  readonly periodLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: ChecklistRunStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly abandonedAt: string | null;
  readonly abandonedBy: string | null;
  readonly abandonReason: string | null;
  /** The first open item whose prerequisites are all done or skipped, or null. */
  readonly nextItemId: string | null;
  readonly openCount: number;
  readonly doneCount: number;
  readonly skippedCount: number;
  readonly itemCount: number;
  /** The live computed-return hash every verb item and the bridge review are measured against. */
  readonly returnHash: string | null;
  readonly items: readonly ChecklistItemView[];
}

// --- Helpers -------------------------------------------------------------------------------------

function reqStr(v: unknown, field: string): Result | undefined {
  return typeof v === 'string' && v.length > 0 ? undefined : err('invalid_input', { field });
}

function loadRun(ctx: WorkspaceContext, runId: unknown): RunRow | undefined {
  if (typeof runId !== 'string') return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM checklist_run WHERE id = ? AND workspace_id = ?')
    .get(runId, ctx.workspaceId) as RunRow | undefined;
}

function loadItems(ctx: WorkspaceContext, runId: string): ItemRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM checklist_run_item WHERE run_id = ? AND workspace_id = ? ORDER BY position ASC')
    .all(runId, ctx.workspaceId) as ItemRow[];
}

/** The live (non-voided) sign-off per run item, the latest one when several exist. */
function loadLiveSignoffs(ctx: WorkspaceContext, runId: string): Map<string, SignoffRow> {
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM checklist_signoff WHERE run_id = ? AND workspace_id = ? AND voided_at IS NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(runId, ctx.workspaceId) as SignoffRow[];
  const out = new Map<string, SignoffRow>();
  for (const r of rows) out.set(r.run_item_id, r);
  return out;
}

/**
 * Who an actor id is, in words (DESIGN.md C3: an agent origin is named in words, a machine id never
 * reaches the screen). The G15 provider's own resolution, so both surfaces name a person the same way.
 */
function describeActor(ctx: WorkspaceContext, actor: string | null): { kind: ChecklistActorKind; name: string | null } {
  if (actor === null || actor === '') return { kind: 'unknown', name: null };
  if (actor === AGENT_ACTOR) return { kind: 'agent', name: null };
  if (actor === 'studio') return { kind: 'studio', name: null };
  const user = ctx.store.db
    .prepare('SELECT display_name, email, kind FROM user WHERE actor_id = ? LIMIT 1')
    .get(actor) as { display_name: string | null; email: string | null; kind: string | null } | undefined;
  if (user === undefined) return { kind: 'unknown', name: null };
  if (user.kind === 'agent') return { kind: 'agent', name: null };
  const name = user.display_name ?? user.email;
  if (name === null && !actor.startsWith(SERVED_MEMBER_ACTOR_PREFIX)) return { kind: 'unknown', name: null };
  return { kind: 'member', name };
}

function periodOf(run: RunRow): { label: string; periodStart: string; periodEnd: string } {
  return { label: run.period_label, periodStart: run.period_start, periodEnd: run.period_end };
}

function templateOf(run: RunRow): ChecklistTemplate {
  const template = checklistTemplate(run.template_id);
  if (template === undefined) throw new Error(`checklist run ${run.id} names unknown template ${run.template_id}`);
  return template;
}

// --- The derivation ------------------------------------------------------------------------------

/**
 * The live view of one run: every item derived against the checks and the computed return, the
 * next item, the counts and the run status. Exported for the prompt and the G15 provider, so the
 * three faces (verb, prompt, hub) read one derivation.
 */
export function deriveRun(ctx: WorkspaceContext, run: RunRow): ChecklistRunView {
  const template = templateOf(run);
  const period = periodOf(run);
  const rows = loadItems(ctx, run.id);
  const signoffs = loadLiveSignoffs(ctx, run.id);
  const live: LiveReturn = liveReturnOf(ctx, period);
  const byItemId = new Map(template.items.map((i) => [i.itemId, i]));

  // First pass: status per item (without prerequisites, which need every sibling's status).
  const statuses = new Map<string, ChecklistItemStatus>();
  const partial: Array<{ row: ItemRow; item: ChecklistTemplateItem; status: ChecklistItemStatus; stale: boolean; checkResult: CheckResult | null; preconditionResult: CheckResult | null; signoff: SignoffRow | null }> = [];
  for (const row of rows) {
    const item = byItemId.get(row.item_id);
    if (item === undefined) continue;
    const checkResult = item.check === undefined ? null : evaluateCheck(ctx, item.check, period, live);
    const preconditionResult = item.precondition === undefined ? null : evaluateCheck(ctx, item.precondition, period, live);
    const signoff = signoffs.get(row.id) ?? null;
    let status: ChecklistItemStatus = 'open';
    let stale = false;
    if (row.status === 'skipped') {
      status = 'skipped';
    } else if (item.evidenceKind === 'check') {
      status = checkResult?.passed === true ? 'done' : 'open';
    } else if (item.evidenceKind === 'verb_result') {
      if (row.status === 'done') {
        stale = live.hash === null || row.evidence_hash !== live.hash;
        status = stale ? 'open' : 'done';
      }
    } else {
      // signoff | filed_attestation
      if (row.status === 'done' && signoff !== null) {
        stale = signoff.hash !== null && (live.hash === null || signoff.hash !== live.hash);
        status = stale ? 'open' : 'done';
      }
    }
    statuses.set(row.item_id, status);
    partial.push({ row, item, status, stale, checkResult, preconditionResult, signoff });
  }

  const settled = (id: string): boolean => {
    const s = statuses.get(id);
    return s === 'done' || s === 'skipped';
  };

  const items: ChecklistItemView[] = partial.map(({ row, item, status, stale, checkResult, preconditionResult, signoff }) => {
    const prerequisites = prerequisitesOf(item);
    const blockedBy = prerequisites.find((p) => !settled(p)) ?? null;
    const who = describeActor(ctx, row.completed_by);
    const signer = signoff === null ? null : describeActor(ctx, signoff.actor);
    return {
      runItemId: row.id,
      itemId: row.item_id,
      position: row.position,
      title: item.title,
      ownerKind: row.owner_kind,
      evidenceKind: item.evidenceKind,
      check: item.check ?? null,
      precondition: item.precondition ?? null,
      verb: item.verb ?? null,
      deepLink: item.deepLink ?? null,
      signoffKind: item.signoffKind ?? null,
      requiresEvidenceRef: item.requiresEvidenceRef === true,
      prerequisiteItemIds: prerequisites,
      dueAt: row.due_at,
      undeletable: item.undeletable === true,
      status,
      storedStatus: row.status,
      stale,
      blockedBy,
      checkResult,
      preconditionResult,
      completedBy: row.completed_by,
      completedByKind: row.completed_by === null ? null : who.kind,
      completedByName: row.completed_by === null ? null : who.name,
      completedAt: row.completed_at,
      evidence: row.evidence_kind === null ? null : { kind: row.evidence_kind, ref: row.evidence_ref },
      signoff:
        signoff === null || signer === null
          ? null
          : {
              signoffId: signoff.id,
              kind: signoff.kind,
              actor: signoff.actor,
              actorKind: signer.kind,
              actorName: signer.name,
              evidenceRef: signoff.evidence_ref,
              hash: signoff.hash,
              createdAt: signoff.created_at,
              stale,
            },
      skipReason: row.skip_reason,
      skippedBy: row.skipped_by,
      skippedAt: row.skipped_at,
    };
  });

  const openCount = items.filter((i) => i.status === 'open').length;
  const doneCount = items.filter((i) => i.status === 'done').length;
  const skippedCount = items.filter((i) => i.status === 'skipped').length;
  const nextItemId = items.find((i) => i.status === 'open' && i.blockedBy === null)?.itemId ?? null;
  const status: ChecklistRunStatus = run.status === 'abandoned' ? 'abandoned' : openCount === 0 ? 'done' : 'open';

  return {
    runId: run.id,
    templateId: run.template_id,
    templateLabel: template.label,
    kind: template.kind,
    periodLabel: run.period_label,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    status,
    createdBy: run.created_by,
    createdAt: run.created_at,
    abandonedAt: run.abandoned_at,
    abandonedBy: run.abandoned_by,
    abandonReason: run.abandon_reason,
    nextItemId,
    openCount,
    doneCount,
    skippedCount,
    itemCount: items.length,
    returnHash: live.hash,
    items,
  };
}

/** The open runs of a workspace, oldest period first: what the G15 provider and the prompt scan. */
export function openRunRows(ctx: WorkspaceContext): RunRow[] {
  return ctx.store.db
    .prepare(`SELECT * FROM checklist_run WHERE workspace_id = ? AND status = 'open' ORDER BY period_start ASC, created_at ASC`)
    .all(ctx.workspaceId) as RunRow[];
}

/** The run for a template and period start, or undefined. */
export function runRowFor(ctx: WorkspaceContext, templateId: string, periodStart: string): RunRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM checklist_run WHERE workspace_id = ? AND template_id = ? AND period_start = ?')
    .get(ctx.workspaceId, templateId, periodStart) as RunRow | undefined;
}

// --- checklist_start -----------------------------------------------------------------------------

export interface ChecklistStartInput {
  templateId: unknown;
  period: unknown;
  idempotencyKey: unknown;
}

/**
 * Start a run for a template and a period. Idempotent on the natural key `(workspace, template,
 * periodStart)` whatever the idempotency key: a second start returns the existing run with
 * `created:false` (row 1.3), while a replay of the SAME key returns its stored answer unchanged.
 */
export function checklistStart(ctx: WorkspaceContext, input: ChecklistStartInput): Result {
  const guard = reqStr(input.templateId, 'templateId') ?? reqStr(input.period, 'period') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const template = checklistTemplate(input.templateId);
  if (template === undefined) return err('unknown_template', { templateId: input.templateId, known: CHECKLIST_TEMPLATE_IDS });
  if (template.periodKind !== 'vat_period') return err('invalid_input', { field: 'templateId', reason: 'unsupported_period_kind' });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'checklist_start');
  if (replayed !== undefined) return replayed;

  const period = input.period as string;
  const year = period.slice(0, 4);
  const periods = listVatPeriods(ctx, { year });
  if (!periods.ok) return periods;
  const known = Array.isArray(periods.periods)
    ? (periods.periods as { label: string; periodStart: string; periodEnd: string }[])
    : [];
  const match = known.find((p) => p.label === period);
  if (match === undefined) return err('period_not_filable', { period, periods: known.map((p) => p.label) });

  const existing = runRowFor(ctx, template.templateId, match.periodStart);
  if (existing !== undefined) {
    return ok({ created: false, ...deriveRun(ctx, existing) });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_start', () => {
    const now = ctx.clock.now();
    const runId = ctx.ids.next('chkrun');
    ctx.store.db
      .prepare(
        `INSERT INTO checklist_run (id, workspace_id, template_id, period_label, period_start, period_end, status, created_by, created_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(runId, ctx.workspaceId, template.templateId, match.label, match.periodStart, match.periodEnd, ctx.actor, key, now);
    const due = resolveDueDates(template.items, match.periodEnd);
    const insert = ctx.store.db.prepare(
      `INSERT INTO checklist_run_item (id, workspace_id, run_id, item_id, position, owner_kind, due_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    );
    template.items.forEach((item, i) => {
      insert.run(ctx.ids.next('chkitem'), ctx.workspaceId, runId, item.itemId, i + 1, item.ownerKind, due.get(item.itemId) ?? null, now, now);
    });
    ctx.audit.record({ entityKind: 'checklist_run', entityId: runId, action: 'create', actor: ctx.actor, at: now });
    const row = loadRun(ctx, runId) as RunRow;
    return ok({ created: true, ...deriveRun(ctx, row) });
  });
}

// --- checklist_get / checklist_list -------------------------------------------------------------

export function checklistGet(ctx: WorkspaceContext, input: { runId: unknown }): Result {
  const guard = reqStr(input.runId, 'runId');
  if (guard) return guard;
  const run = loadRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  return ok(deriveRun(ctx, run) as unknown as Record<string, unknown>);
}

export interface ChecklistListInput {
  templateId?: unknown;
  status?: unknown;
}

export function checklistList(ctx: WorkspaceContext, input: ChecklistListInput = {}): Result {
  if (input.templateId !== undefined && typeof input.templateId !== 'string') return err('invalid_input', { field: 'templateId' });
  if (input.status !== undefined && !(CHECKLIST_RUN_STATUSES as readonly string[]).includes(input.status as string)) {
    return err('invalid_input', { field: 'status', expected: CHECKLIST_RUN_STATUSES });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM checklist_run WHERE workspace_id = ? ${input.templateId === undefined ? '' : 'AND template_id = ?'}
        ORDER BY period_start DESC, created_at DESC`,
    )
    .all(...(input.templateId === undefined ? [ctx.workspaceId] : [ctx.workspaceId, input.templateId])) as RunRow[];
  const runs = rows
    .map((row) => {
      const view = deriveRun(ctx, row);
      return {
        runId: view.runId,
        templateId: view.templateId,
        templateLabel: view.templateLabel,
        kind: view.kind,
        periodLabel: view.periodLabel,
        periodStart: view.periodStart,
        periodEnd: view.periodEnd,
        status: view.status,
        nextItemId: view.nextItemId,
        openCount: view.openCount,
        doneCount: view.doneCount,
        skippedCount: view.skippedCount,
        itemCount: view.itemCount,
        createdAt: view.createdAt,
        abandonedAt: view.abandonedAt,
      };
    })
    .filter((r) => input.status === undefined || r.status === input.status);
  // Open first, then done, then abandoned; newest period first within a group (row 10.1).
  const order: Record<string, number> = { open: 0, done: 1, abandoned: 2 };
  runs.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.periodStart.localeCompare(a.periodStart));
  return ok({ runs });
}

// --- checklist_item_complete ---------------------------------------------------------------------

export interface ChecklistItemCompleteInput {
  runId: unknown;
  itemId: unknown;
  evidence?: unknown;
  idempotencyKey: unknown;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function itemOf(view: ChecklistRunView, itemId: string): ChecklistItemView | undefined {
  return view.items.find((i) => i.itemId === itemId);
}

function liveSignoffFor(ctx: WorkspaceContext, runItemId: string): SignoffRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT * FROM checklist_signoff WHERE workspace_id = ? AND run_item_id = ? AND voided_at IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, runItemId) as SignoffRow | undefined;
}

function voidSignoff(ctx: WorkspaceContext, signoffId: string, reason: string, now: string): void {
  ctx.store.db
    .prepare('UPDATE checklist_signoff SET voided_at = ?, void_reason = ? WHERE id = ? AND workspace_id = ? AND voided_at IS NULL')
    .run(now, reason, signoffId, ctx.workspaceId);
}

function insertSignoff(
  ctx: WorkspaceContext,
  run: RunRow,
  runItemId: string,
  kind: ChecklistSignoffKind,
  evidenceRef: string,
  hash: string | null,
  now: string,
): string {
  const id = ctx.ids.next('chksign');
  ctx.store.db
    .prepare(
      `INSERT INTO checklist_signoff (id, workspace_id, run_id, run_item_id, kind, actor, evidence_ref, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, run.id, runItemId, kind, ctx.actor, evidenceRef, hash, now);
  return id;
}

function markDone(
  ctx: WorkspaceContext,
  runItemId: string,
  key: string,
  evidence: { kind: string; ref: string; hash: string | null },
  now: string,
): void {
  ctx.store.db
    .prepare(
      `UPDATE checklist_run_item
          SET status = 'done', completed_by = ?, completed_at = ?, completed_key = ?,
              evidence_kind = ?, evidence_ref = ?, evidence_hash = ?,
              skip_reason = NULL, skipped_by = NULL, skipped_at = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    )
    .run(ctx.actor, now, key, evidence.kind, evidence.ref, evidence.hash, now, runItemId, ctx.workspaceId);
}

/**
 * Complete one item. The evidence a verb item carries is what the engine computed by re-running the
 * verb; a sign-off item records an append-only sign-off; a check item cannot be completed by hand.
 */
export function checklistItemComplete(ctx: WorkspaceContext, input: ChecklistItemCompleteInput): Result {
  const guard = reqStr(input.runId, 'runId') ?? reqStr(input.itemId, 'itemId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'checklist_item_complete');
  if (replayed !== undefined) return replayed;

  const run = loadRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'abandoned') return err('run_abandoned', { runId: run.id, reason: run.abandon_reason });
  const view = deriveRun(ctx, run);
  const item = itemOf(view, input.itemId as string);
  if (item === undefined) return err('not_found', { runId: run.id, itemId: input.itemId });
  const template = templateOf(run).items.find((i) => i.itemId === item.itemId) as ChecklistTemplateItem;
  const evidence = (input.evidence ?? {}) as { kind?: unknown; ref?: unknown };
  const suppliedRef = typeof evidence.ref === 'string' && evidence.ref.length > 0 ? evidence.ref : null;

  if (template.evidenceKind === 'check') {
    return err('check_item_live', { itemId: item.itemId, check: template.check, passed: item.checkResult?.passed ?? null });
  }
  if (item.blockedBy !== null) {
    return err('prerequisite_open', { itemId: item.itemId, prerequisiteItemId: item.blockedBy });
  }
  if (item.status === 'done') {
    // A live attestation is refused, never overwritten (plan finding 7): a second date or a second
    // actor on the ePortal step must reopen first. The same date by the same actor is a replay.
    if (template.evidenceKind === 'filed_attestation' && item.signoff !== null) {
      const same = suppliedRef === item.signoff.evidenceRef && item.signoff.actor === ctx.actor;
      if (!same) {
        return err('already_attested', { itemId: item.itemId, attestedOn: item.signoff.evidenceRef, actor: item.signoff.actor, signoffId: item.signoff.signoffId });
      }
    }
    return ok({ runId: run.id, itemId: item.itemId, alreadyDone: true, item });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_item_complete', () => {
    const now = ctx.clock.now();
    const period = periodOf(run);
    const finish = (): Result => {
      const fresh = deriveRun(ctx, loadRun(ctx, run.id) as RunRow);
      ctx.audit.record({ entityKind: 'checklist_run', entityId: run.id, action: 'complete', actor: ctx.actor, at: now });
      return ok({ runId: run.id, itemId: item.itemId, alreadyDone: false, item: itemOf(fresh, item.itemId) as ChecklistItemView });
    };

    if (template.evidenceKind === 'verb_result') {
      const live = liveReturnOf(ctx, period);
      if (!live.ok || live.hash === null) return err(live.error ?? 'needs_vat_config', { itemId: item.itemId, verb: template.verb });
      let ref = `vat_return:${live.hash}`;
      if (template.verb === 'vat_export_ech0217') {
        const exported = exportVatReturnEch0217(ctx, { periodStart: period.periodStart, periodEnd: period.periodEnd });
        if (!exported.ok) return exported;
        ref = `ech0217:${String((exported as Record<string, unknown>).filename ?? '')}:${live.hash}`;
      }
      if (suppliedRef !== null && suppliedRef !== ref && suppliedRef !== `vat_return:${live.hash}`) {
        return err('evidence_mismatch', { itemId: item.itemId, supplied: suppliedRef, expected: ref });
      }
      markDone(ctx, item.runItemId, key, { kind: 'verb_result', ref, hash: live.hash }, now);
      return finish();
    }

    if (template.evidenceKind === 'filed_attestation') {
      const date = suppliedRef;
      if (evidence.kind !== 'filed_attestation' || date === null || !ISO_DAY.test(date)) {
        return err('evidence_required', { itemId: item.itemId, evidenceKind: 'filed_attestation', expected: 'YYYY-MM-DD' });
      }
      const existing = liveSignoffFor(ctx, item.runItemId);
      if (existing !== undefined) {
        if (existing.evidence_ref === date && existing.actor === ctx.actor) {
          return ok({ runId: run.id, itemId: item.itemId, alreadyDone: true, item });
        }
        return err('already_attested', { itemId: item.itemId, attestedOn: existing.evidence_ref, actor: existing.actor, signoffId: existing.id });
      }
      const exportItem = view.items.find((i) => i.itemId === template.prerequisiteItemId);
      const exportedAt = exportItem?.completedAt?.slice(0, 10) ?? null;
      if (exportedAt !== null && date < exportedAt) {
        return err('attestation_before_export', { itemId: item.itemId, attestedOn: date, exportedAt });
      }
      const signoffId = insertSignoff(ctx, run, item.runItemId, 'filed_attestation', date, null, now);
      markDone(ctx, item.runItemId, key, { kind: 'filed_attestation', ref: date, hash: null }, now);
      return ok({ ...(finish() as Record<string, unknown>), signoffId });
    }

    // signoff: the bridge review (hash-bound, precondition-gated) or the settlement (reference required).
    const kind = template.signoffKind ?? 'settlement_booked';
    if (template.precondition !== undefined && item.preconditionResult?.passed !== true) {
      return err('check_not_passed', { itemId: item.itemId, check: template.precondition, result: item.preconditionResult });
    }
    if (template.requiresEvidenceRef === true && suppliedRef === null) {
      return err('evidence_required', { itemId: item.itemId, evidenceKind: 'signoff', expected: 'a reference the sign-off names (a bank transaction, a journal entry)' });
    }
    let hash: string | null = null;
    if (kind === 'abstimmung_reviewed') {
      const live = liveReturnOf(ctx, period);
      if (!live.ok || live.hash === null) return err(live.error ?? 'needs_vat_config', { itemId: item.itemId });
      hash = live.hash;
      const existing = liveSignoffFor(ctx, item.runItemId);
      if (existing !== undefined && existing.hash !== hash) voidSignoff(ctx, existing.id, 'hash_changed', now);
    }
    const ref = suppliedRef ?? (hash === null ? `signoff:${kind}` : `vat_return:${hash}`);
    const signoffId = insertSignoff(ctx, run, item.runItemId, kind, ref, hash, now);
    markDone(ctx, item.runItemId, key, { kind: 'signoff', ref, hash }, now);
    return ok({ ...(finish() as Record<string, unknown>), signoffId });
  });
}

// --- checklist_item_skip / checklist_item_reopen ------------------------------------------------

export interface ChecklistItemSkipInput {
  runId: unknown;
  itemId: unknown;
  reason: unknown;
  idempotencyKey: unknown;
}

export function checklistItemSkip(ctx: WorkspaceContext, input: ChecklistItemSkipInput): Result {
  const guard = reqStr(input.runId, 'runId') ?? reqStr(input.itemId, 'itemId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'checklist_item_skip');
  if (replayed !== undefined) return replayed;
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return err('skip_needs_reason', { itemId: input.itemId });
  }
  const run = loadRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'abandoned') return err('run_abandoned', { runId: run.id, reason: run.abandon_reason });
  const view = deriveRun(ctx, run);
  const item = itemOf(view, input.itemId as string);
  if (item === undefined) return err('not_found', { runId: run.id, itemId: input.itemId });
  if (item.undeletable) return err('undeletable', { itemId: item.itemId });
  const reason = input.reason.trim();
  if (item.status === 'skipped' && item.skipReason === reason) {
    return ok({ runId: run.id, itemId: item.itemId, alreadySkipped: true, item });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_item_skip', () => {
    const now = ctx.clock.now();
    const existing = liveSignoffFor(ctx, item.runItemId);
    if (existing !== undefined) voidSignoff(ctx, existing.id, 'skipped', now);
    ctx.store.db
      .prepare(
        `UPDATE checklist_run_item
            SET status = 'skipped', skip_reason = ?, skipped_by = ?, skipped_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      )
      .run(reason, ctx.actor, now, now, item.runItemId, ctx.workspaceId);
    ctx.audit.record({ entityKind: 'checklist_run', entityId: run.id, action: 'skip', actor: ctx.actor, at: now });
    const fresh = deriveRun(ctx, loadRun(ctx, run.id) as RunRow);
    return ok({ runId: run.id, itemId: item.itemId, alreadySkipped: false, item: itemOf(fresh, item.itemId) as ChecklistItemView });
  });
}

export interface ChecklistItemReopenInput {
  runId: unknown;
  itemId: unknown;
  idempotencyKey: unknown;
}

export function checklistItemReopen(ctx: WorkspaceContext, input: ChecklistItemReopenInput): Result {
  const guard = reqStr(input.runId, 'runId') ?? reqStr(input.itemId, 'itemId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'checklist_item_reopen');
  if (replayed !== undefined) return replayed;
  const run = loadRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'abandoned') return err('run_abandoned', { runId: run.id, reason: run.abandon_reason });
  const view = deriveRun(ctx, run);
  const item = itemOf(view, input.itemId as string);
  if (item === undefined) return err('not_found', { runId: run.id, itemId: input.itemId });
  if (item.evidenceKind === 'check' && item.storedStatus !== 'skipped') {
    return err('check_item_live', { itemId: item.itemId, check: item.check, passed: item.checkResult?.passed ?? null });
  }
  if (item.storedStatus === 'open' && item.signoff === null) {
    return ok({ runId: run.id, itemId: item.itemId, alreadyOpen: true, item });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_item_reopen', () => {
    const now = ctx.clock.now();
    const existing = liveSignoffFor(ctx, item.runItemId);
    let voidedSignoffId: string | null = null;
    if (existing !== undefined) {
      voidSignoff(ctx, existing.id, 'reopened', now);
      voidedSignoffId = existing.id;
    }
    ctx.store.db
      .prepare(
        `UPDATE checklist_run_item
            SET status = 'open', completed_by = NULL, completed_at = NULL, completed_key = NULL,
                evidence_kind = NULL, evidence_ref = NULL, evidence_hash = NULL,
                skip_reason = NULL, skipped_by = NULL, skipped_at = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      )
      .run(now, item.runItemId, ctx.workspaceId);
    ctx.audit.record({ entityKind: 'checklist_run', entityId: run.id, action: 'reopen', actor: ctx.actor, at: now });
    const fresh = deriveRun(ctx, loadRun(ctx, run.id) as RunRow);
    return ok({ runId: run.id, itemId: item.itemId, alreadyOpen: false, voidedSignoffId, item: itemOf(fresh, item.itemId) as ChecklistItemView });
  });
}

// --- checklist_abandon ---------------------------------------------------------------------------

export interface ChecklistAbandonInput {
  runId: unknown;
  reason: unknown;
  idempotencyKey: unknown;
}

export function checklistAbandon(ctx: WorkspaceContext, input: ChecklistAbandonInput): Result {
  const guard = reqStr(input.runId, 'runId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'checklist_abandon');
  if (replayed !== undefined) return replayed;
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) return err('invalid_input', { field: 'reason' });
  const run = loadRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'abandoned') return ok({ alreadyAbandoned: true, ...deriveRun(ctx, run) });

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_abandon', () => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(`UPDATE checklist_run SET status = 'abandoned', abandoned_at = ?, abandoned_by = ?, abandon_reason = ? WHERE id = ? AND workspace_id = ?`)
      .run(now, ctx.actor, (input.reason as string).trim(), run.id, ctx.workspaceId);
    ctx.audit.record({ entityKind: 'checklist_run', entityId: run.id, action: 'cancel', actor: ctx.actor, at: now });
    return ok({ alreadyAbandoned: false, ...deriveRun(ctx, loadRun(ctx, run.id) as RunRow) });
  });
}
