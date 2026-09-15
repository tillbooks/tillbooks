/**
 * G22 checklist runs: start, read (checks live), list, complete, skip, reopen, abandon (spec §4, §10).
 *
 * THE STATE IS DERIVED ON EVERY READ. A system check item is done while its check passes and open
 * again the moment it does not; a verb item is done while the hash the engine bound equals the live
 * hash and reads `stale` (open again) when the figures moved; a sign-off item is done while a live,
 * non-voided sign-off of its kind exists and, where it is hash-bound, its hash still matches the
 * anchor. The run is `done` when every item is done, skipped or excluded, never stored: a stored
 * `done` would be a claim a later posting could falsify without anyone noticing.
 *
 * THE FOUR LEG 2 KINDS (spec §10.1) are derivations of the same discipline. A `choice` is done while
 * a human answer is stored or the books derive one (re-derived on every read until overruled); an
 * item whose governing choice carries another answer reads `excluded` (never stored, settled for
 * prerequisites, outside `openCount`). A `preview` is done while its bound hash equals the read's
 * live canonical hash, done ("gebucht") once its paired posting is done, and excluded when its
 * `emptyWhen` pointer is empty and the paired posting's probe finds nothing. A `posting` is done
 * while its PROBE finds a live, unreversed artefact, whatever the preview reads: the domain verb is
 * the act, the checklist engine never posts, and completing the row by hand refuses `check_item_live`
 * exactly like item 8's lock. A `validation` is done on pass, on `warn` only with a live acknowledgement
 * bound to the figures' hash, and open on `fail` or `unavailable`.
 *
 * EVIDENCE IS WHAT THE ENGINE COMPUTED, NEVER WHAT A CALLER TYPED. Completing a `verb_result` or
 * `preview` item re-runs the read through `VERB_EVIDENCE` and binds its hash; a caller may pass the
 * ref it saw, and it must agree or the completion refuses `evidence_mismatch`. `vat_export_ech0217`
 * itself stays a read (the conformance gate forbids a read verb from writing), so the recording lives
 * here, in the write, and a GUI click without a successful export cannot flip the item.
 *
 * SIGN-OFFS ARE APPEND-ONLY (G20's discipline): a second attestation while one is live is refused
 * `already_attested`; a reopen voids (never deletes) the live sign-off; a re-signed hash-bound
 * sign-off voids the stale one with `hash_changed`. The actor is RECORDED, not refused: the owner
 * closes alone (D127) and an agent acting on the owner's behalf is named in words on the row and in
 * the audit log.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { AGENT_ACTOR, SERVED_MEMBER_ACTOR_PREFIX } from '../access/actors.js';
import { computeFxRevaluation } from '../fx/index.js';
import { methodsGoverning } from '../vat/index.js';
import { checklistTemplate, CHECKLIST_TEMPLATE_IDS } from './canon/index.js';
import { YEAR_CLOSE_TEMPLATE_ID } from './canon/yearClose.js';
import { resolveDueDates } from './deadlines.js';
import { evaluateCheck, type CheckResult } from './checks.js';
import { readMemoOf, verbEvidenceOf, verbInputValueOf, pointerIsEmpty, type ReadMemo, type VerbEvidence } from './anchor.js';
import { evaluateProbe, type ProbeResult } from './probes.js';
import { evaluateValidation, type ValidationResult } from './validations.js';
import { fiscalYearOf } from '../ledger/index.js';
import { automationRuleIdOfKey } from '../automation/fire.js';
import { fiscalYearBounds, fiscalYearStartOf, resolveChecklistPeriod, type ChecklistPeriod } from './periods.js';
import {
  prerequisitesOf,
  type ChecklistChoiceOption,
  type ChecklistDeriveKey,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
  type ChecklistSignoffKind,
} from './types.js';

// --- §H-ENUM single sources ----------------------------------------------------------------------

/** A run's derived status. `done` is never stored. */
export const CHECKLIST_RUN_STATUSES = ['open', 'done', 'abandoned'] as const;
export type ChecklistRunStatus = (typeof CHECKLIST_RUN_STATUSES)[number];

/** An item's STORED status (the derivation may read `open` over a stored `done`). */
export const CHECKLIST_ITEM_STATUSES = ['open', 'done', 'skipped'] as const;
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

/**
 * An item's DERIVED status: the stored triple plus `excluded` (spec §10.1), which is never written.
 * The Studio mirrors THIS list (`studio-mirrors-engine-enums`).
 */
export const CHECKLIST_DERIVED_ITEM_STATUSES = ['open', 'done', 'skipped', 'excluded'] as const;
export type ChecklistDerivedItemStatus = (typeof CHECKLIST_DERIVED_ITEM_STATUSES)[number];

/** How an actor id is named on screen: the words for a seat, or a member's display name. */
export type ChecklistActorKind = 'agent' | 'studio' | 'member' | 'unknown';

/** The prefix a stored choice answer carries in `evidence_ref`. */
const CHOICE_REF_PREFIX = 'choice:';

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
  /** True when the bound hash no longer equals the live anchor or figures (Freigabe hinfällig). */
  readonly stale: boolean;
}

/** What a `preview` row shows: the live read, its canonical hash, and whether `emptyWhen` holds. */
export interface ChecklistPreviewView {
  readonly ok: boolean;
  readonly hash: string | null;
  readonly error: string | null;
  readonly payload: Record<string, unknown> | null;
  /** The `emptyWhen` pointer is empty on the live read ("nichts zu tun"). */
  readonly empty: boolean;
  /** The paired posting is done, so the preview reads "gebucht, siehe unten". */
  readonly postedBelow: boolean;
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
  readonly status: ChecklistDerivedItemStatus;
  /** The status the row stores (a stored `done` may read `open` when its evidence went stale). */
  readonly storedStatus: string;
  /** A stored completion whose bound hash no longer matches the live anchor or read. */
  readonly stale: boolean;
  /** The first prerequisite that is neither done, skipped nor excluded, or null. */
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
  // --- Leg 2 (spec §10.1) ---
  /** `choice`: the bounded answers. */
  readonly options: readonly ChecklistChoiceOption[] | null;
  readonly derive: string | null;
  readonly defaultOptionId: string | null;
  /** `choice`: the live answer and where it came from; null while the row is open. */
  readonly choice: { readonly optionId: string; readonly source: 'human' | 'derived' } | null;
  /** `preview` / `posting`: the verb input key and the value the run's period maps it onto. */
  readonly verbInput: string | null;
  readonly verbInputValue: string | null;
  readonly emptyWhen: string | null;
  readonly reverseVerb: string | null;
  readonly probe: string | null;
  readonly previewOf: string | null;
  readonly validation: string | null;
  readonly severity: string | null;
  readonly fixLink: string | null;
  readonly includedWhen: { readonly itemId: string; readonly optionId: string | readonly string[] } | null;
  /** When `excluded`: the governing choice and the answer it carries. */
  readonly excludedBy: { readonly itemId: string; readonly optionId: string | null } | null;
  readonly previewResult: ChecklistPreviewView | null;
  readonly probeResult: ProbeResult | null;
  readonly validationResult: ValidationResult | null;
}

export interface ChecklistRunView {
  readonly runId: string;
  readonly templateId: string;
  readonly templateLabel: string;
  readonly kind: string;
  readonly periodKind: string;
  readonly periodLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: ChecklistRunStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly abandonedAt: string | null;
  readonly abandonedBy: string | null;
  readonly abandonReason: string | null;
  /** The first open item whose prerequisites are all settled, or null. */
  readonly nextItemId: string | null;
  readonly openCount: number;
  readonly doneCount: number;
  readonly skippedCount: number;
  readonly excludedCount: number;
  readonly itemCount: number;
  /** The live anchor hash every hash-bound item is measured against (the return hash on `vat_period`). */
  readonly returnHash: string | null;
  readonly anchorKind: string;
  readonly anchorHash: string | null;
  readonly anchorError: string | null;
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

function periodOf(run: RunRow): ChecklistPeriod {
  return { label: run.period_label, periodStart: run.period_start, periodEnd: run.period_end };
}

function templateOf(run: RunRow): ChecklistTemplate {
  const template = checklistTemplate(run.template_id);
  if (template === undefined) throw new Error(`checklist run ${run.id} names unknown template ${run.template_id}`);
  return template;
}

/** The stored human answer of a choice row, or null. */
function storedChoiceOf(row: ItemRow): string | null {
  if (row.status !== 'done' || row.evidence_ref === null || !row.evidence_ref.startsWith(CHOICE_REF_PREFIX)) return null;
  return row.evidence_ref.slice(CHOICE_REF_PREFIX.length);
}

/**
 * Derive a choice answer from the books (spec §10.1): the legal form and the VAT method off the
 * workspace row, the FC positions off A22's read, the assets off the register. Null when the books
 * carry no answer (an unset legal form): the row stays open and a human answers.
 */
function deriveChoice(ctx: WorkspaceContext, key: ChecklistDeriveKey, period: ChecklistPeriod, options: readonly ChecklistChoiceOption[]): string | null {
  const admits = (id: string | null): string | null => (id !== null && options.some((o) => o.id === id) ? id : null);
  try {
    switch (key) {
      case 'legal_form': {
        const row = ctx.store.db.prepare('SELECT legal_form FROM workspace WHERE id = ?').get(ctx.workspaceId) as { legal_form: string | null } | undefined;
        return admits(row?.legal_form ?? null);
      }
      case 'vat_method': {
        // The method that GOVERNED the run's period, not the workspace's current one: closed eras
        // live in `vat_method_era` (A07), so a year_close over FY2025 after a 1.1.2026 switch still
        // reads effektiv. Two eras over one period carry no single answer: the human chooses.
        const eras = methodsGoverning(ctx, period.periodStart, period.periodEnd);
        return eras.length === 1 ? admits(eras[0]?.method ?? null) : null;
      }
      case 'has_fc_positions': {
        const res = computeFxRevaluation(ctx, { periodEnd: period.periodEnd });
        if (!res.ok) return null;
        const positions = Array.isArray(res.positions) ? res.positions : [];
        const needsRate = Array.isArray(res.needsRate) ? res.needsRate : [];
        return admits(positions.length > 0 || needsRate.length > 0 ? 'yes' : 'no');
      }
      case 'has_assets': {
        // Active only: a fully depreciated asset has nothing left to charge, and counting it would
        // open the depreciation pair (8a has no emptyWhen, the probe answers found:false) on a
        // register with nothing eligible, leaving 8b open unless skipped.
        const row = ctx.store.db
          .prepare(`SELECT COUNT(*) AS n FROM asset WHERE workspace_id = ? AND status = 'active'`)
          .get(ctx.workspaceId) as { n: number };
        return admits(row.n > 0 ? 'yes' : 'no');
      }
    }
  } catch {
    return null;
  }
}

// --- The derivation ------------------------------------------------------------------------------

interface PartialItem {
  row: ItemRow;
  item: ChecklistTemplateItem;
  status: ChecklistDerivedItemStatus;
  stale: boolean;
  checkResult: CheckResult | null;
  preconditionResult: CheckResult | null;
  signoff: SignoffRow | null;
  choice: ChecklistItemView['choice'];
  excludedBy: ChecklistItemView['excludedBy'];
  previewResult: ChecklistPreviewView | null;
  probeResult: ProbeResult | null;
  validationResult: ValidationResult | null;
}

/**
 * The live view of one run: every item derived against the anchor, the checks, the probes and the
 * validations, the next item, the counts and the run status. Exported for the prompt and the G15
 * provider, so the three faces (verb, prompt, hub) read one derivation.
 */
export function deriveRun(ctx: WorkspaceContext, run: RunRow): ChecklistRunView {
  const template = templateOf(run);
  const period = periodOf(run);
  const rows = loadItems(ctx, run.id);
  const signoffs = loadLiveSignoffs(ctx, run.id);
  const memo: ReadMemo = readMemoOf(ctx, template, period);
  const anchor = memo.anchor;
  const byItemId = new Map(template.items.map((i) => [i.itemId, i]));
  const rowByItemId = new Map(rows.map((r) => [r.item_id, r]));

  // Pass 1: the choice answers (human first, then derived), which every exclusion hangs on.
  const answers = new Map<string, ChecklistItemView['choice']>();
  for (const row of rows) {
    const item = byItemId.get(row.item_id);
    if (item === undefined || item.evidenceKind !== 'choice') continue;
    const stored = storedChoiceOf(row);
    if (stored !== null) {
      answers.set(item.itemId, { optionId: stored, source: 'human' });
      continue;
    }
    const derived = item.derive === undefined ? null : deriveChoice(ctx, item.derive, period, item.options ?? []);
    answers.set(item.itemId, derived === null ? null : { optionId: derived, source: 'derived' });
  }

  // Pass 2: exclusion by the governing choice (spec §10.1 `includedWhen`).
  const excludedBy = new Map<string, ChecklistItemView['excludedBy']>();
  for (const item of template.items) {
    if (item.includedWhen === undefined) continue;
    const answer = answers.get(item.includedWhen.itemId) ?? null;
    const admitted = item.includedWhen.optionId;
    const included = answer === null ? true : typeof admitted === 'string' ? answer.optionId === admitted : admitted.includes(answer.optionId);
    if (answer !== null && !included) {
      excludedBy.set(item.itemId, { itemId: item.includedWhen.itemId, optionId: answer.optionId });
    }
  }

  // Pass 3: the probes (a posting's own state, and the partner of a preview's `excluded`).
  const probes = new Map<string, ProbeResult>();
  for (const item of template.items) {
    if (item.evidenceKind === 'posting' && item.probe !== undefined && rowByItemId.has(item.itemId)) {
      probes.set(item.itemId, evaluateProbe(ctx, item.probe, period));
    }
  }
  const postingFor = new Map<string, ChecklistTemplateItem>();
  for (const item of template.items) if (item.evidenceKind === 'posting' && item.previewOf !== undefined) postingFor.set(item.previewOf, item);

  // Pass 4: status per item (without prerequisites, which need every sibling's status).
  const statuses = new Map<string, ChecklistDerivedItemStatus>();
  const partial: PartialItem[] = [];
  const previewEmpty = new Map<string, boolean>();
  for (const row of rows) {
    const item = byItemId.get(row.item_id);
    if (item === undefined) continue;
    const checkResult = item.check === undefined ? null : evaluateCheck(ctx, item.check, period, memo);
    const preconditionResult = item.precondition === undefined ? null : evaluateCheck(ctx, item.precondition, period, memo);
    const signoff = signoffs.get(row.id) ?? null;
    const choice = answers.get(item.itemId) ?? null;
    const exclusion = excludedBy.get(item.itemId) ?? null;
    let status: ChecklistDerivedItemStatus = 'open';
    let stale = false;
    let previewResult: ChecklistPreviewView | null = null;
    let probeResult: ProbeResult | null = null;
    let validationResult: ValidationResult | null = null;

    if (item.evidenceKind === 'preview') {
      const live: VerbEvidence = verbEvidenceOf(ctx, item.verb, period, memo);
      const payload = live.ok ? live.payload : null;
      const empty = item.emptyWhen !== undefined && live.ok && pointerIsEmpty(payload, item.emptyWhen);
      previewEmpty.set(item.itemId, empty);
      const pairedPosting = postingFor.get(item.itemId);
      const pairedProbe = pairedPosting === undefined ? undefined : probes.get(pairedPosting.itemId);
      const postedBelow = pairedProbe?.found === true;
      previewResult = { ok: live.ok, hash: live.ok ? live.hash : null, error: live.ok ? null : live.error, payload, empty, postedBelow };
      // The probe wins (spec §10.1): a posting on the books makes the pair `done` whatever the
      // governing choice says, so an answer of "no" never hides an artefact that stands.
      if (postedBelow) {
        status = 'done';
      } else if (exclusion !== null) {
        status = 'excluded';
      } else if (row.status === 'skipped') {
        status = 'skipped';
      } else if (empty && (pairedProbe === undefined || pairedProbe.found === false)) {
        status = 'excluded';
      } else if (row.status === 'done') {
        stale = !live.ok || row.evidence_hash !== live.hash;
        status = stale ? 'open' : 'done';
      }
    } else if (item.evidenceKind === 'posting') {
      probeResult = probes.get(item.itemId) ?? null;
      const pairedPreviewEmpty = item.previewOf === undefined ? false : previewEmpty.get(item.previewOf) === true;
      const pairedPreviewExcluded = item.previewOf === undefined ? false : excludedBy.has(item.previewOf) || (pairedPreviewEmpty && probeResult?.found === false);
      // The probe wins (spec §10.1): `excluded` only when the governing choice or the paired preview
      // excludes the row AND the probe finds nothing.
      if (probeResult?.found === true) status = 'done';
      else if (exclusion !== null) status = 'excluded';
      else if (row.status === 'skipped') status = 'skipped';
      else if (pairedPreviewExcluded && probeResult?.found === false) status = 'excluded';
      else status = 'open';
    } else if (exclusion !== null) {
      status = 'excluded';
    } else if (row.status === 'skipped') {
      status = 'skipped';
    } else if (item.evidenceKind === 'check') {
      status = checkResult?.passed === true ? 'done' : 'open';
    } else if (item.evidenceKind === 'choice') {
      status = choice === null ? 'open' : 'done';
    } else if (item.evidenceKind === 'validation') {
      validationResult = item.validation === undefined ? null : evaluateValidation(ctx, item.validation, period);
      if (validationResult?.result === 'pass') {
        status = 'done';
      } else if (validationResult?.result === 'fail' && item.severity === 'warn') {
        if (signoff !== null && signoff.kind === 'validation_acknowledged') {
          stale = signoff.hash !== validationResult.hash;
          status = stale ? 'open' : 'done';
        }
      }
    } else if (item.evidenceKind === 'verb_result') {
      if (row.status === 'done') {
        const live = verbEvidenceOf(ctx, item.verb, period, memo);
        stale = !live.ok || row.evidence_hash !== live.hash;
        status = stale ? 'open' : 'done';
      }
    } else {
      // signoff | filed_attestation: hash-bound kinds measure against the anchor.
      if (row.status === 'done' && signoff !== null) {
        stale = signoff.hash !== null && (anchor.hash === null || signoff.hash !== anchor.hash);
        status = stale ? 'open' : 'done';
      }
    }
    statuses.set(row.item_id, status);
    partial.push({ row, item, status, stale, checkResult, preconditionResult, signoff, choice, excludedBy: exclusion, previewResult, probeResult, validationResult });
  }

  const settled = (id: string): boolean => {
    const s = statuses.get(id);
    return s === 'done' || s === 'skipped' || s === 'excluded';
  };

  const items: ChecklistItemView[] = partial.map((p) => {
    const { row, item, status, stale, checkResult, preconditionResult, signoff } = p;
    const prerequisites = prerequisitesOf(item);
    const blockedBy = status === 'excluded' ? null : (prerequisites.find((id) => !settled(id)) ?? null);
    const who = describeActor(ctx, row.completed_by);
    const signer = signoff === null ? null : describeActor(ctx, signoff.actor);
    const signoffStale = signoff === null ? false : item.evidenceKind === 'validation' ? stale : signoff.hash !== null && (anchor.hash === null || signoff.hash !== anchor.hash);
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
              stale: signoffStale,
            },
      skipReason: row.skip_reason,
      skippedBy: row.skipped_by,
      skippedAt: row.skipped_at,
      options: item.options ?? null,
      derive: item.derive ?? null,
      defaultOptionId: item.defaultOptionId ?? null,
      choice: p.choice,
      verbInput: item.verbInput ?? null,
      verbInputValue: item.evidenceKind === 'preview' || item.evidenceKind === 'posting' ? verbInputValueOf(item.verbInput, period) : null,
      emptyWhen: item.emptyWhen ?? null,
      reverseVerb: item.reverseVerb ?? null,
      probe: item.probe ?? null,
      previewOf: item.previewOf ?? null,
      validation: item.validation ?? null,
      severity: item.severity ?? null,
      fixLink: item.fixLink ?? null,
      includedWhen: item.includedWhen ?? null,
      excludedBy: p.excludedBy,
      previewResult: p.previewResult,
      probeResult: p.probeResult,
      validationResult: p.validationResult,
    };
  });

  const openCount = items.filter((i) => i.status === 'open').length;
  const doneCount = items.filter((i) => i.status === 'done').length;
  const skippedCount = items.filter((i) => i.status === 'skipped').length;
  const excludedCount = items.filter((i) => i.status === 'excluded').length;
  const nextItemId = items.find((i) => i.status === 'open' && i.blockedBy === null)?.itemId ?? null;
  const status: ChecklistRunStatus = run.status === 'abandoned' ? 'abandoned' : openCount === 0 ? 'done' : 'open';

  return {
    runId: run.id,
    templateId: run.template_id,
    templateLabel: template.label,
    kind: template.kind,
    periodKind: template.periodKind,
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
    excludedCount,
    itemCount: items.length,
    returnHash: anchor.hash,
    anchorKind: anchor.kind,
    anchorHash: anchor.hash,
    anchorError: anchor.error ?? null,
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
  /** Optional since leg 2 (spec §10.3): the last ENDED period of the template's kind when omitted. */
  period?: unknown;
  idempotencyKey: unknown;
}

/**
 * Start a run for a template and a period. Idempotent on the natural key `(workspace, template,
 * periodStart)` whatever the idempotency key: a second start returns the existing run with
 * `created:false` (row 1.3), while a replay of the SAME key returns its stored answer unchanged.
 */

/**
 * The non-abandoned `year_close` run over the fiscal year a month ENDS, when that month is the
 * year's last (spec §10.6); undefined for every other month and when no such run exists.
 */
function yearCloseRunOverLastMonth(ctx: WorkspaceContext, month: ChecklistPeriod): { id: string; period_label: string } | undefined {
  const fys = fiscalYearStartOf(ctx);
  const fy = fiscalYearBounds(fiscalYearOf(month.periodEnd, fys), fys);
  if (month.periodEnd !== fy.periodEnd) return undefined;
  return ctx.store.db
    .prepare(
      `SELECT id, period_label FROM checklist_run
        WHERE workspace_id = ? AND template_id = ? AND period_label = ? AND status <> 'abandoned'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, YEAR_CLOSE_TEMPLATE_ID, fy.label) as { id: string; period_label: string } | undefined;
}

export function checklistStart(ctx: WorkspaceContext, input: ChecklistStartInput): Result {
  const guard = reqStr(input.templateId, 'templateId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (input.period !== undefined && input.period !== null && typeof input.period !== 'string') return err('invalid_input', { field: 'period' });
  const key = input.idempotencyKey as string;
  const template = checklistTemplate(input.templateId);
  if (template === undefined) return err('unknown_template', { templateId: input.templateId, known: CHECKLIST_TEMPLATE_IDS });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'checklist_start');
  if (replayed !== undefined) return replayed;

  const resolved = resolveChecklistPeriod(ctx, template.periodKind, input.period);
  if (!resolved.ok) return resolved;
  const match = resolved;

  const existing = runRowFor(ctx, template.templateId, match.periodStart);
  if (existing !== undefined) {
    return ok({ created: false, ...deriveRun(ctx, existing) });
  }

  // Spec §10.6: the last fiscal month of a year that carries a live `year_close` run is not started
  // (the year's item 4 covers the months and item 19 is the December lock). The auto-start rule
  // makes this same call, so its silence and this refusal are one mechanism; a December run that
  // already exists is returned above, never refused.
  if (template.periodKind === 'month') {
    const yearRun = yearCloseRunOverLastMonth(ctx, match);
    if (yearRun !== undefined) {
      return err('year_close_in_progress', { period: match.label, fiscalYear: yearRun.period_label, yearRunId: yearRun.id });
    }
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_start', () => {
    const now = ctx.clock.now();
    const runId = ctx.ids.next('chkrun');
    // Spec §10.8: a run the seeded daily rule started records the RULE ID as its creator, so nobody
    // reads that they started a run they did not. The fire path derives its idempotency key from the
    // rule id (`auto:<ruleId>:<digest>`), and that key is the smallest seam there is: no column, no
    // change to the fire path. A key naming a rule this workspace does not carry is not provenance.
    const ruleId = automationRuleIdOfKey(key);
    const startedByRule =
      ruleId !== undefined &&
      ctx.store.db.prepare('SELECT 1 AS one FROM automation_rule WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, ruleId) !== undefined;
    const createdBy = startedByRule ? ruleId : ctx.actor;
    ctx.store.db
      .prepare(
        `INSERT INTO checklist_run (id, workspace_id, template_id, period_label, period_start, period_end, status, created_by, created_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(runId, ctx.workspaceId, template.templateId, match.label, match.periodStart, match.periodEnd, createdBy, key, now);
    const due = resolveDueDates(template.items, match.periodEnd, template.periodKind);
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
        periodKind: view.periodKind,
        periodLabel: view.periodLabel,
        periodStart: view.periodStart,
        periodEnd: view.periodEnd,
        status: view.status,
        nextItemId: view.nextItemId,
        openCount: view.openCount,
        doneCount: view.doneCount,
        skippedCount: view.skippedCount,
        excludedCount: view.excludedCount,
        itemCount: view.itemCount,
        createdBy: view.createdBy,
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
 * The items a choice governs that are already done and are a posting or a sign-off: re-answering
 * would exclude a row whose artefact or attestation stands (spec §10.1 `choice_locked`).
 */
function governedDoneItems(view: ChecklistRunView, template: ChecklistTemplate, choiceItemId: string): string[] {
  const governed = new Set(template.items.filter((i) => i.includedWhen?.itemId === choiceItemId).map((i) => i.itemId));
  return view.items
    .filter((i) => governed.has(i.itemId) && i.status === 'done')
    .filter((i) => i.evidenceKind === 'posting' || i.evidenceKind === 'signoff' || i.evidenceKind === 'filed_attestation')
    .map((i) => i.itemId);
}

/**
 * Complete one item. The evidence a verb or preview item carries is what the engine computed by
 * re-running the read; a sign-off item records an append-only sign-off; a choice stores its answer;
 * a check or posting item cannot be completed by hand.
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
  const fullTemplate = templateOf(run);
  const template = fullTemplate.items.find((i) => i.itemId === item.itemId) as ChecklistTemplateItem;
  const evidence = (input.evidence ?? {}) as { kind?: unknown; ref?: unknown; reason?: unknown };
  const suppliedRef = typeof evidence.ref === 'string' && evidence.ref.length > 0 ? evidence.ref : null;

  if (item.status === 'excluded') {
    return err('item_excluded', { itemId: item.itemId, excludedBy: item.excludedBy });
  }
  if (template.evidenceKind === 'check') {
    return err('check_item_live', { itemId: item.itemId, check: template.check, passed: item.checkResult?.passed ?? null });
  }
  if (template.evidenceKind === 'posting') {
    return err('check_item_live', { itemId: item.itemId, probe: template.probe, verb: template.verb, found: item.probeResult?.found ?? null, reason: item.probeResult?.reason ?? null });
  }

  // A choice may be re-answered while nothing it governs stands; it is not gated by prerequisites
  // or by its own done state (a derived answer is exactly what a human overrules).
  if (template.evidenceKind === 'choice') {
    const options = template.options ?? [];
    if (evidence.kind !== 'choice' || suppliedRef === null || !options.some((o) => o.id === suppliedRef)) {
      return err('invalid_choice', { itemId: item.itemId, supplied: suppliedRef, options: options.map((o) => o.id) });
    }
    if (item.choice?.source === 'human' && item.choice.optionId === suppliedRef) {
      return ok({ runId: run.id, itemId: item.itemId, alreadyDone: true, item });
    }
    if (item.choice !== null && item.choice.optionId !== suppliedRef) {
      const locked = governedDoneItems(view, fullTemplate, item.itemId);
      if (locked.length > 0) return err('choice_locked', { itemId: item.itemId, current: item.choice.optionId, supplied: suppliedRef, lockedBy: locked });
    }
    return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'checklist_item_complete', () => {
      const now = ctx.clock.now();
      markDone(ctx, item.runItemId, key, { kind: 'choice', ref: `${CHOICE_REF_PREFIX}${suppliedRef}`, hash: null }, now);
      const fresh = deriveRun(ctx, loadRun(ctx, run.id) as RunRow);
      ctx.audit.record({ entityKind: 'checklist_run', entityId: run.id, action: 'complete', actor: ctx.actor, at: now });
      return ok({ runId: run.id, itemId: item.itemId, alreadyDone: false, item: itemOf(fresh, item.itemId) as ChecklistItemView });
    });
  }

  if (item.blockedBy !== null) {
    return err('prerequisite_open', { itemId: item.itemId, prerequisiteItemId: item.blockedBy });
  }
  if (item.status === 'done') {
    // A live attestation is refused, never overwritten (plan finding 7): a second date or a second
    // actor on the ePortal step must reopen first. The same date by the same actor is a replay.
    if ((template.evidenceKind === 'filed_attestation' || template.signoffKind === 'gv_attestation') && item.signoff !== null) {
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
    const memo = readMemoOf(ctx, fullTemplate, period);
    const finish = (): Result => {
      const fresh = deriveRun(ctx, loadRun(ctx, run.id) as RunRow);
      ctx.audit.record({ entityKind: 'checklist_run', entityId: run.id, action: 'complete', actor: ctx.actor, at: now });
      return ok({ runId: run.id, itemId: item.itemId, alreadyDone: false, item: itemOf(fresh, item.itemId) as ChecklistItemView });
    };

    if (template.evidenceKind === 'verb_result' || template.evidenceKind === 'preview') {
      const live = verbEvidenceOf(ctx, template.verb, period, memo);
      if (!live.ok) {
        // A refused read on a preview is `read_refused` (the row shows the refusal); on the D127 verb
        // items the return's own code is passed through unchanged.
        return template.evidenceKind === 'preview'
          ? err('read_refused', { itemId: item.itemId, verb: template.verb, refusal: live.error, ...(live.details ?? {}) })
          : err(live.error, { itemId: item.itemId, verb: template.verb });
      }
      const ref = live.ref;
      if (suppliedRef !== null && suppliedRef !== ref && !(template.evidenceKind === 'verb_result' && suppliedRef === `vat_return:${live.hash}`)) {
        return err('evidence_mismatch', { itemId: item.itemId, supplied: suppliedRef, expected: ref });
      }
      markDone(ctx, item.runItemId, key, { kind: template.evidenceKind, ref, hash: live.hash }, now);
      return finish();
    }

    if (template.evidenceKind === 'validation') {
      const result = item.validationResult;
      if (template.severity !== 'warn' || result === null || result.result !== 'fail') {
        return err('check_not_passed', { itemId: item.itemId, validation: template.validation, severity: template.severity ?? null, result });
      }
      const reason = suppliedRef ?? (typeof evidence.reason === 'string' && evidence.reason.trim().length > 0 ? evidence.reason.trim() : null);
      if (evidence.kind !== 'signoff' || reason === null) {
        return err('acknowledge_needs_reason', { itemId: item.itemId, validation: template.validation, expected: 'evidence {kind: "signoff", ref: <reason>}' });
      }
      const existing = liveSignoffFor(ctx, item.runItemId);
      if (existing !== undefined && existing.hash !== result.hash) voidSignoff(ctx, existing.id, 'hash_changed', now);
      const signoffId = insertSignoff(ctx, run, item.runItemId, 'validation_acknowledged', reason, result.hash, now);
      markDone(ctx, item.runItemId, key, { kind: 'signoff', ref: reason, hash: result.hash }, now);
      return ok({ ...(finish() as Record<string, unknown>), signoffId });
    }

    if (template.evidenceKind === 'filed_attestation' || template.signoffKind === 'gv_attestation') {
      const kind: ChecklistSignoffKind = template.signoffKind === 'gv_attestation' ? 'gv_attestation' : 'filed_attestation';
      const date = suppliedRef;
      if (evidence.kind !== kind || date === null || !ISO_DAY.test(date)) {
        return err('evidence_required', { itemId: item.itemId, evidenceKind: kind, expected: 'YYYY-MM-DD' });
      }
      const existing = liveSignoffFor(ctx, item.runItemId);
      if (existing !== undefined) {
        // The stored ref is the date, or `date:reason` on a GV attestation that predates the sign-off.
        const sameDate = existing.evidence_ref === date || existing.evidence_ref.startsWith(`${date}:`);
        if (!sameDate || existing.actor !== ctx.actor) {
          return err('already_attested', { itemId: item.itemId, attestedOn: existing.evidence_ref, actor: existing.actor, signoffId: existing.id });
        }
        // The same date by the same actor: a replay while the attestation stands, or a REFRESH of a
        // hash-bound one the anchor has moved away from (the row reads stale, so this branch is
        // reached): the stale row is voided `hash_changed` and re-inserted, as `statements_signoff` does.
        if (kind === 'filed_attestation' || existing.hash === memo.anchor.hash) {
          return ok({ runId: run.id, itemId: item.itemId, alreadyDone: true, item });
        }
        voidSignoff(ctx, existing.id, 'hash_changed', now);
      }
      if (kind === 'filed_attestation') {
        const exportItem = view.items.find((i) => i.itemId === template.prerequisiteItemId);
        const exportedAt = exportItem?.completedAt?.slice(0, 10) ?? null;
        if (exportedAt !== null && date < exportedAt) {
          return err('attestation_before_export', { itemId: item.itemId, attestedOn: date, exportedAt });
        }
        const signoffId = insertSignoff(ctx, run, item.runItemId, kind, date, null, now);
        markDone(ctx, item.runItemId, key, { kind, ref: date, hash: null }, now);
        return ok({ ...(finish() as Record<string, unknown>), signoffId });
      }
      // gv_attestation (spec §10.1): a date before the statements sign-off is a WARN with a required
      // reason, never a refusal (a cutover workspace closes a year whose GV already happened); bound
      // to the anchor like every acknowledgement.
      const statementsItem = view.items.find((i) => i.signoffKind === 'statements_signoff');
      const signedAt = statementsItem?.signoff?.createdAt.slice(0, 10) ?? null;
      const reason = typeof evidence.reason === 'string' && evidence.reason.trim().length > 0 ? evidence.reason.trim() : null;
      if (signedAt !== null && date < signedAt && reason === null) {
        return err('acknowledge_needs_reason', { itemId: item.itemId, attestedOn: date, statementsSignedAt: signedAt, expected: 'evidence.reason: why the GV predates the statements sign-off' });
      }
      const ref = reason === null ? date : `${date}:${reason}`;
      const signoffId = insertSignoff(ctx, run, item.runItemId, kind, ref, memo.anchor.hash, now);
      markDone(ctx, item.runItemId, key, { kind, ref, hash: memo.anchor.hash }, now);
      return ok({ ...(finish() as Record<string, unknown>), signoffId, warnedBeforeStatements: signedAt !== null && date < signedAt });
    }

    // signoff: the bridge review (hash-bound, precondition-gated), the statements sign-off
    // (anchor-bound) or the settlement (reference required).
    const kind = template.signoffKind ?? 'settlement_booked';
    if (template.precondition !== undefined && item.preconditionResult?.passed !== true) {
      return err('check_not_passed', { itemId: item.itemId, check: template.precondition, result: item.preconditionResult });
    }
    if (template.requiresEvidenceRef === true && suppliedRef === null) {
      return err('evidence_required', { itemId: item.itemId, evidenceKind: 'signoff', expected: 'a reference the sign-off names (a bank transaction, a journal entry)' });
    }
    // The statements sign-off is the input the post-tier dial rule keys on (spec §10.1): the engine
    // refuses the other spelling, so a governed sign-off cannot be recorded under an ungoverned name.
    if (kind === 'statements_signoff' && evidence.kind !== 'statements_signoff') {
      return err('evidence_required', { itemId: item.itemId, evidenceKind: 'statements_signoff', expected: 'evidence {kind: "statements_signoff"}' });
    }
    let hash: string | null = null;
    if (kind === 'abstimmung_reviewed' || kind === 'statements_signoff') {
      if (!memo.anchor.ok || memo.anchor.hash === null) return err(memo.anchor.error ?? 'needs_vat_config', { itemId: item.itemId, anchor: memo.anchor.kind });
      hash = memo.anchor.hash;
      const existing = liveSignoffFor(ctx, item.runItemId);
      if (existing !== undefined && existing.hash !== hash) voidSignoff(ctx, existing.id, 'hash_changed', now);
    }
    const ref = suppliedRef ?? (hash === null ? `signoff:${kind}` : `${memo.anchor.kind}:${hash}`);
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
  if (item.status === 'excluded') return err('item_excluded', { itemId: item.itemId, excludedBy: item.excludedBy });
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
  if ((item.evidenceKind === 'check' || item.evidenceKind === 'posting') && item.storedStatus !== 'skipped') {
    return err('check_item_live', { itemId: item.itemId, check: item.check, probe: item.probe, passed: item.checkResult?.passed ?? item.probeResult?.found ?? null });
  }
  if (item.evidenceKind === 'choice' && item.choice?.source === 'human') {
    // Clearing a human answer falls back to the derived one (or to open), which may exclude rows
    // whose artefact stands: the same lock as re-answering (spec §10.1 `choice_locked`).
    const locked = governedDoneItems(view, templateOf(run), item.itemId);
    if (locked.length > 0) return err('choice_locked', { itemId: item.itemId, current: item.choice.optionId, lockedBy: locked });
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
