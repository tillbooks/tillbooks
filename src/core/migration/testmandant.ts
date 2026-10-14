/**
 * G12, the Testmandant: a disposable trial workspace, its promotion to real books, and its discard.
 *
 * THE ONE ENUM, NOT TWO FLAGS (spec §0). `workspace.kind` is `demo | sandbox | live`, single-sourced
 * here as `WORKSPACE_KINDS` (no CHECK in the schema, the §D0 convention), additively subsuming G03's
 * `is_demo` boolean. Every combination is a defined state: `demo` never promotes (G03 §6b), `sandbox`
 * is a Testmandant an operator trial-loads, `live` is real books. The ONLY transition is
 * `sandbox -> live`, once, one-way, through `goProductive`; `demo` has no transition at all.
 *
 * THE CENTRAL PROMISE IS NO-COPY (spec §1, US-G12.2). Going productive changes ONE workspace
 * attribute (`kind`), stamps `promoted_at`, and writes ONE A03 audit row. Nothing is copied and
 * nothing re-imports: every id, timestamp and posted entry the trial produced stays byte-identical,
 * which is why the A03 audit chain is continuous (OR Art. 957a) and the continuity assertion (spec §7)
 * is this capability's central regression test.
 *
 * THE GATE IS A CONJUNCTION (spec §2 US-G12.2, §6b Fixed). Promotion refuses, each leg named (P9):
 * the G11 re-check is not clean or diverges (`check_not_clean`), a row traces to a demo seed
 * (`sandbox_contains_demo_rows`, provenance not the flag, because the enum cannot prove a negative),
 * the company profile is a placeholder (`needs_company_profile`), or a live workspace already holds
 * the same UID (`live_workspace_exists`). The fifth leg, the `promote_workspace` + `commit_migration`
 * capabilities, is enforced at the registry boundary. The type-to-confirm against the legal name is
 * checked HERE, engine-side, so the agent face cannot skip it, and an agent caller is P8 draft-staged.
 *
 * ONE PLAN OWNS A TESTMANDANT (owner decision 11.10.2026). The link `migration_plan.testmandant_workspace_id`
 * is written only by the workspace that created the sandbox; a restore clears it and env_copy
 * re-points it (`trialReset.ts`). `owningPlan` settles books restored before that fix, where a copy's
 * plan still links the original's sandbox: discard, abandon and promotion act only for the owner, and
 * a copy may only drop its own link.
 *
 * §H-TENANT on every query; §H-IDEMPOTENT on all three writes. §H-LEDGER: this file posts NOTHING and
 * touches no journal row; the final G11 re-check is what proves the figures were already right.
 *
 * NO IMPORT OF `plan.ts` OR `seams.ts`, deliberately, and for the reason `check.ts` gives: `seams.ts`
 * binds INTO this file (the G12 integration seam), and `plan.ts` imports `seams.ts`, so a runtime
 * import of either here would close a module cycle. The one-line loaders are restated instead; the
 * row types are type-only imports and erase at compile time.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { isGovernedSeat, capabilityPort } from '../access/capability.js';
import { makeContext } from '../context.js';
import { createWorkspace, type SetupDeps } from '../setup/workspace.js';
import { appendAuditLog } from '../ledger/auditLog.js';
import { allowAllCapabilities } from '../ports.js';
import { listVatPeriods, markVatPeriodFiled } from '../vat/index.js';
import { runCheck } from './check.js';
import type { PlanRow, StepRow } from './plan.js';
import { isCutoverPending, cutoverInFuture } from './stichtag.js';
import { unlinkPlanTestmandant } from './trialReset.js';

// --- §H-ENUM: the workspace-kind enum, single-sourced here (no CHECK in schema.ts, the §D0 convention) ---

/** What a workspace IS. `demo` sample data (G03), `sandbox` a Testmandant, `live` real books. */
export const WORKSPACE_KINDS = ['demo', 'sandbox', 'live'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

const WORKSPACE_KIND_SET: ReadonlySet<string> = new Set<string>(WORKSPACE_KINDS);

/** Is `value` one of the three defined kinds? The case-plus-test guard the spec §7/§D0 requires. */
export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === 'string' && WORKSPACE_KIND_SET.has(value);
}

/** The enum admits no fourth value: asserted by test, mirroring `controlStatusExcludesAmber`. */
export function workspaceKindsAreExactlyThree(): boolean {
  return WORKSPACE_KINDS.length === 3 && !WORKSPACE_KIND_SET.has('sandbox_live') && !WORKSPACE_KIND_SET.has('archived');
}

/** What the ownership resolver and the loaders need: the store, nothing tenant-scoped. */
type StoreOnly = Pick<WorkspaceContext, 'store'>;

// --- Row types and local §H-TENANT loaders (restated, never imported: see the module note) -------

interface WorkspaceKindRow {
  id: string;
  name: string;
  legal_form: string | null;
  uid: string | null;
  vat_registered: number;
  mwst_no: string | null;
  is_demo: number;
  kind: string;
  promoted_at: string | null;
}

/** The plan row, workspace-scoped, or undefined when it is not this workspace's. §H-TENANT. */
function loadPlanRow(ctx: WorkspaceContext, planId: unknown): PlanRow | undefined {
  if (typeof planId !== 'string') return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM migration_plan WHERE id = ? AND workspace_id = ?')
    .get(planId, ctx.workspaceId) as PlanRow | undefined;
}

/** Every step of a plan, in creation order. §H-TENANT. */
function loadStepRows(ctx: WorkspaceContext, planId: string): StepRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM migration_step WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at, id')
    .all(planId, ctx.workspaceId) as StepRow[];
}

/** A workspace row by id, unscoped (the target may be a DIFFERENT workspace than ctx's, e.g. the Testmandant). */
function loadWorkspace(ctx: StoreOnly, workspaceId: string): WorkspaceKindRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, name, legal_form, uid, vat_registered, mwst_no, is_demo, kind, promoted_at FROM workspace WHERE id = ?')
    .get(workspaceId) as WorkspaceKindRow | undefined;
}

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

/**
 * // INTEGRATION-SEAM(G12) target resolver, the binding `seams.ts` points at. The plan's Testmandant
 * workspace id when this engine has provisioned one, else null. It is the SAME field `getPlan` reads;
 * a function so the seam binds the real engine rather than reaching into a column directly.
 */
export function testmandantWorkspaceId(plan: { testmandant_workspace_id?: string | null }): string | null {
  return plan.testmandant_workspace_id ?? null;
}

/** Is `actor` a member of `workspaceId`? Mirrors `listWorkspaces`: an unprovisioned workspace is everyone's. */
function isMemberOf(ctx: WorkspaceContext, workspaceId: string): boolean {
  const provisioned = ctx.store.db
    .prepare('SELECT 1 FROM workspace_member WHERE workspace_id = ? LIMIT 1')
    .get(workspaceId) as unknown;
  if (provisioned === undefined) return true;
  const seat = ctx.store.db
    .prepare(
      `SELECT 1 FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.actor_id = ? AND m.accepted_at IS NOT NULL LIMIT 1`,
    )
    .get(workspaceId, ctx.actor) as unknown;
  return seat !== undefined;
}

// --- createTestmandant (US-G12.1) ----------------------------------------------------------------

/**
 * Compose A00's `createWorkspace` (never a second mint path), stamp `kind='sandbox'`, and link the
 * plan to it. Idempotent per plan: a second call returns the existing Testmandant, never a second
 * workspace (§H-IDEMPOTENT). A plan already `live` refuses with `plan_already_live` (P9).
 */
export function createTestmandant(
  ctx: WorkspaceContext,
  input: { planId: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  if (plan.status === 'live') return err('plan_already_live', { planId: plan.id });

  // Replay a completed create for this key BEFORE the state guards, so a retry never rejects and the
  // double-call returns the byte-identical stored result (the store's `recallIdempotent` contract).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_create_testmandant');
  if (replayed !== undefined) return replayed;

  // Idempotent per plan, independent of the key: an already-provisioned Testmandant is returned as is
  // (US-G12.1 error), so a second create (with a DIFFERENT key) can never mint a second workspace.
  if (plan.testmandant_workspace_id !== null) {
    return ok({ workspaceId: plan.testmandant_workspace_id, created: false });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_create_testmandant', () => {
    // The source workspace names the trial so the operator recognises whose books it stands in for.
    const source = loadWorkspace(ctx, ctx.workspaceId);
    const name = `${source?.name ?? 'Testmandant'} (Testmandant)`;
    const minted = createWorkspace(
      { store: ctx.store, clock: ctx.clock, ids: ctx.ids, actor: ctx.actor },
      { name },
    );
    if (!minted.ok) return minted;
    const workspaceId = (minted as unknown as { workspaceId: string }).workspaceId;
    // Stamp the kind. `createWorkspace` opened it as 'live' (the default every real book gets); this
    // is the one place a workspace is set to 'sandbox', and the transition the other way (-> live) is
    // `goProductive`'s alone.
    ctx.store.db.prepare('UPDATE workspace SET kind = ? WHERE id = ?').run('sandbox', workspaceId);
    // Link it to the plan (the SEAM G09's trial-load reads through `testmandantWorkspaceId`).
    ctx.store.db
      .prepare('UPDATE migration_plan SET testmandant_workspace_id = ? WHERE id = ? AND workspace_id = ?')
      .run(workspaceId, plan.id, ctx.workspaceId);
    // OP8: the event a rule may react to. `createdTestmandantId` resolves the occurrence id.
    return ok({ workspaceId, created: true, createdTestmandantId: workspaceId });
  });
}

// --- getTestmandant (US-G12.1, read) -------------------------------------------------------------

/**
 * The Testmandant for a plan: its workspace id, its kind, the steps trial-loaded into it, and the
 * plan's last check id. A plan with no Testmandant returns `{none:true}` (US-G12.1 empty). Read (P5).
 */
export function getTestmandant(ctx: WorkspaceContext, input: { planId: unknown }): Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  if (plan.testmandant_workspace_id === null) return ok({ none: true });
  const ws = loadWorkspace(ctx, plan.testmandant_workspace_id);
  const steps = loadStepRows(ctx, plan.id);
  const loadedSteps = steps
    .filter((s) => ['trial_loaded', 'checked', 'committed', 'verified'].includes(s.status))
    .map((s) => ({ stepId: s.id, dataClass: s.data_class, state: s.status, lastCheckId: s.last_check_id }));
  const lastCheckId = steps.map((s) => s.last_check_id).filter((h) => h !== null).slice(-1)[0] ?? null;
  return ok({
    workspaceId: plan.testmandant_workspace_id,
    kind: ws?.kind ?? null,
    promotedAt: ws?.promoted_at ?? null,
    loadedSteps,
    lastCheckId,
  });
}

// --- diffTestmandantToLive (US-G12.3, read) ------------------------------------------------------

/**
 * What differs between the Testmandant and an existing live workspace of the same UID, per data class
 * (US-G12.3). The family's ONE deliberate two-workspace read: it demands membership of BOTH sides
 * (`forbidden` otherwise), stated in the spec §2/§3 and asserted by test. No live workspace of this
 * UID returns `{live:null}` (the question does not arise). A read (P5); it never merges.
 */
export function diffTestmandantToLive(ctx: WorkspaceContext, input: { planId: unknown }): Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  if (plan.testmandant_workspace_id === null) return err('not_a_testmandant', { planId: plan.id });
  const testmandant = loadWorkspace(ctx, plan.testmandant_workspace_id);
  if (testmandant === undefined) return err('not_found', { workspaceId: plan.testmandant_workspace_id });

  // A live workspace of the SAME non-null UID, other than the Testmandant itself. A null UID never
  // collides (two unconfigured workspaces are not "the same company"), the same rule gate leg 4 uses.
  const live =
    testmandant.uid === null
      ? undefined
      : (ctx.store.db
          .prepare("SELECT id FROM workspace WHERE kind = 'live' AND uid = ? AND id <> ? LIMIT 1")
          .get(testmandant.uid, testmandant.id) as { id: string } | undefined);
  if (live === undefined) return ok({ live: null });

  // The two-workspace membership fence: this read touches TWO tenants and demands membership of EACH.
  if (!isMemberOf(ctx, testmandant.id) || !isMemberOf(ctx, live.id)) {
    return err('forbidden', { reason: 'diff_requires_both_memberships' });
  }

  // Per data class in the plan's scope, the row counts on each side, keyed on the class's own tables.
  const perClass: Array<Record<string, unknown>> = [];
  for (const step of loadStepRows(ctx, plan.id)) {
    const testmandantCount = countClassRows(ctx, plan.testmandant_workspace_id, step.data_class);
    const liveCount = countClassRows(ctx, live.id, step.data_class);
    perClass.push({ dataClass: step.data_class, testmandantCount, liveCount });
  }
  return ok({ live: { workspaceId: live.id }, perClass });
}

/** The row count for a data class in a workspace, over the class's home table. Read-only, §H-TENANT. */
function countClassRows(ctx: WorkspaceContext, workspaceId: string, dataClass: string): number {
  const table = CLASS_TABLE[dataClass];
  if (table === undefined) return 0;
  const row = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
    .get(workspaceId) as { n: number };
  return row.n;
}

/** The home table each data class counts over for the diff. A class with no home table counts zero. */
const CLASS_TABLE: Readonly<Record<string, string>> = {
  contacts: 'contact',
  items: 'item',
  chart_of_accounts: 'account',
  opening_balances: 'journal_entry',
  documents: 'document',
  vendor_bills: 'vendor_bill',
  gl_history: 'gl_archive_entry',
};

// --- goProductive (US-G12.2) ---------------------------------------------------------------------

/**
 * Promote a Testmandant to real books, in place (US-G12.2). The five-leg gate, then `kind='live'`,
 * `promoted_at`, one A03 audit row, nothing copied. The type-to-confirm (`confirmedName` must equal
 * the Testmandant's legal name) is checked HERE so the agent face cannot skip it; an agent caller is
 * P8 draft-staged. Promoting an already-live workspace is an idempotent no-op, never a double-promote.
 */
export function goProductive(
  ctx: WorkspaceContext,
  input: { planId: unknown; confirmedName: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });

  // Replay a completed promotion for this key BEFORE the state guards, so the double-call returns the
  // byte-identical stored result and a retry of a done promotion never rejects (recallIdempotent).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'go_productive');
  if (replayed !== undefined) return replayed;

  // D158 critic round 2: a TERMINAL plan never goes productive. The promotion below writes the plan
  // `live` unconditionally, so before this guard an abandoned plan whose Testmandant was still a
  // sandbox flipped back to `live`. `abandoned` and `closed` are the two terminal states (G09 §4).
  // A closed plan is refused below, after the already-live no-op, so promote-twice stays idempotent.
  if (plan.status === 'abandoned') return err('plan_abandoned', { planId: plan.id });

  if (plan.testmandant_workspace_id === null) return err('not_a_testmandant', { planId: plan.id });
  const testmandant = loadWorkspace(ctx, plan.testmandant_workspace_id);
  if (testmandant === undefined) return err('not_found', { workspaceId: plan.testmandant_workspace_id });
  // Only the plan that OWNS the Testmandant promotes it (`owningPlan`, owner decision 11.10.2026). A
  // copy's plan that still links the original's sandbox (a book restored before the fix) is refused
  // with no write, and it says nothing about the other workspace; the owner is never blocked by a copy.
  if (owningPlan(ctx, plan) !== 'owner') return err('testmandant_not_owned', { planId: plan.id });

  // One-way and idempotent, INDEPENDENT of the key: an already-live workspace is a no-op, never a
  // second promotion (spec §4 "the kind moves sandbox -> live exactly once"). A fresh key on an
  // already-promoted workspace lands here (its own key never stored) and no-ops rather than re-running.
  if (testmandant.kind === 'live') return ok({ workspaceId: testmandant.id, alreadyLive: true });
  // A closed plan's sandbox would otherwise be promoted and the plan reopened to `live` (code as in
  // `abandonPlan`).
  if (plan.status === 'closed') return err('plan_closed', { planId: plan.id });
  // `demo` never promotes (G03 §6b), and no other kind is promotable through this family.
  if (testmandant.kind !== 'sandbox') return err('not_a_testmandant', { workspaceId: testmandant.id, kind: testmandant.kind });

  // F-09: the promotion waits for the Übernahmestichtag, for every caller, BEFORE the type-to-confirm
  // and the draft stage. A plan prepared ahead of its date rehearses everything up to here; going
  // productive on books whose opening position is dated in the future is the one thing it must not do.
  if (isCutoverPending(ctx, plan)) return cutoverInFuture(ctx, plan);

  // The type-to-confirm, engine-side: `confirmedName` must equal the Testmandant's legal name.
  const nameConfirmed = typeof input.confirmedName === 'string' && input.confirmedName === testmandant.name;

  // P8 (spec §2 boundary): an agent invoking this is DRAFT-STAGED until a human confirmation is on
  // record. Passing the exact legal name IS that confirmation (the files.ts `confirmed:true` shape one
  // family over); without it the agent gets `{staged:true}` and a human performs the type-to-confirm.
  // The governed-seat rule (`isGovernedSeat`), so a served agent member stages like the local agent.
  if (isGovernedSeat(ctx.store, ctx.actor) && !nameConfirmed) {
    return ok({ ok: true, staged: true, plan: plan.id, workspaceId: testmandant.id });
  }
  // Checked for EVERY transport: a wrong (or absent) legal name refuses, whoever the caller is (P9).
  if (!nameConfirmed) return err('confirm_name_mismatch', { workspaceId: testmandant.id });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'go_productive', () => {
    // --- The gate, each leg named in its refusal (spec §2 US-G12.2) ---

    // Leg 1: the WHOLE G11 check, one final time, against 'live'. Any control failed or not_asserted,
    // or a divergence from the last stored (trial) check, refuses (US-G11.7's divergence is leg 1).
    const badControls: Array<{ stepId: string; kind: string; scope: string; status: string }> = [];
    const diverged: Array<{ kind: string; scope: string }> = [];
    for (const step of loadStepRows(ctx, plan.id)) {
      if (step.status === 'skipped') continue;
      const outcome = runCheck(ctx, plan, step, 'live');
      for (const c of outcome.controls) {
        if (c.status === 'failed' || c.status === 'not_asserted') {
          badControls.push({ stepId: step.id, kind: c.kind, scope: c.scope, status: c.status });
        }
      }
      if (outcome.diverged) {
        for (const d of outcome.divergedControls) diverged.push({ kind: d.kind, scope: d.scope });
      }
    }
    if (badControls.length > 0 || diverged.length > 0) {
      return err('check_not_clean', { controls: badControls, diverged });
    }

    // Leg 2: provenance beats the flag. A Testmandant holding any demo-seeded row can never become
    // real books (G03 §6b), and the enum alone cannot prove the negative, so this reads the rows.
    const demoRow = demoSeededRow(ctx, testmandant);
    if (demoRow !== null) return err('sandbox_contains_demo_rows', { row: demoRow });

    // Leg 3: the company profile must be real (legal form, UID, and MWST number where registered).
    if (!companyProfileComplete(testmandant)) {
      const missing: string[] = [];
      if (testmandant.legal_form === null) missing.push('legalForm');
      if (testmandant.uid === null) missing.push('uid');
      if (testmandant.vat_registered === 1 && testmandant.mwst_no === null) missing.push('mwstNo');
      return err('needs_company_profile', { workspaceId: testmandant.id, missing });
    }

    // Leg 4: no OTHER live workspace already holds this UID (offer the run-against-live path instead).
    if (testmandant.uid !== null) {
      const clash = ctx.store.db
        .prepare("SELECT id FROM workspace WHERE kind = 'live' AND uid = ? AND id <> ? LIMIT 1")
        .get(testmandant.uid, testmandant.id) as { id: string } | undefined;
      if (clash !== undefined) return err('live_workspace_exists', { workspaceId: clash.id, uid: testmandant.uid });
    }

    // --- The promotion: ONE attribute, ONE timestamp, ONE audit row. Nothing copied (the no-copy
    // promise; the continuity assertion in the test proves every other byte is unchanged). ---
    const now = ctx.clock.now();
    ctx.store.db.prepare("UPDATE workspace SET kind = 'live', promoted_at = ? WHERE id = ?").run(now, testmandant.id);
    // §H-AUDIT: the A03 chain of the workspace that just became real records who promoted it and when.
    // Written INTO the Testmandant's own chain, so its continuity across going productive is intact.
    appendAuditLog(
      { store: ctx.store, workspaceId: testmandant.id, ids: ctx.ids },
      { entityKind: 'workspace', entityId: testmandant.id, action: 'go_productive', actor: ctx.actor, at: now },
    );
    // The plan is `live` now (its Testmandant is real books); the banner is gone because the state is.
    ctx.store.db.prepare("UPDATE migration_plan SET status = 'live' WHERE id = ? AND workspace_id = ?").run(plan.id, ctx.workspaceId);

    // R2 (G18, US-G09.7): the go-live VAT freeze. EVERY VAT period WHOLLY BEFORE the
    // Übernahmestichtag was already filed in the old system, so TILL must never generate a return for
    // it. The freeze is UNBOUNDED (spec §9 DoD): it seals every such period, not a fixed window, back
    // to the earliest fiscal footprint this business carries. Each period is marked filed (A07
    // `vat_mark_filed`) and hard-locked (A03), inside this same promotion transaction, in the
    // workspace that just became real books (the Testmandant). DELEGATED ENTIRELY to A07/A03: not one
    // lock is written here. The freeze runs with system capabilities scoped to the now-live
    // workspace, because the promotion is already authorised by `promote_workspace` +
    // `commit_migration` (spec §3: no new capability). Idempotent: a period already filed is a no-op,
    // and the whole freeze replays under go_productive's key. The opening entry, dated AT the
    // Stichtag, sits in a period the freeze does NOT touch: only months STRICTLY before the Stichtag's
    // month seal, so the Stichtag period stays unsealed (US-G09.6 boundary).
    const frozenPeriods = freezeFiledVatPeriods(ctx, testmandant.id, plan.cutover_date);

    // OP8: `promotedWorkspaceId` resolves the `migration.went_productive` occurrence (null on the
    // staged and already-live paths, so exactly the moment that happened emits one).
    return ok({ workspaceId: testmandant.id, promotedAt: now, promotedWorkspaceId: testmandant.id, frozenPeriods });
  });
}

/**
 * R2 (G18): seal EVERY VAT period wholly before the Übernahmestichtag in the now-live workspace.
 *
 * UNBOUNDED (spec §9 DoD: "hard-locks every period wholly before the Stichtag"). The freeze is not
 * confined to a fixed year window: it walks from the earliest fiscal footprint this business carries
 * up to the Stichtag and seals every VAT period that falls WHOLLY before it, so TILL can never emit a
 * return for a pre-cutover period however far back it lies. The floor year is the earlier of the year
 * running into the Stichtag (`stichtagYear - 1`, the minimum lookback: a workspace with no imported
 * history still seals the fiscal year up to go-live, so this never regresses below the old go-live
 * window) and the year of the earliest archived prior-system period (`gl_archive_period`, the
 * migration's own record of how far back the books reach). Enumeration goes through A07's own period
 * model (`listVatPeriods`), which reads the method that governed each year; a year with no VAT method
 * configured yields no periods and is skipped. Returns the labels of the periods newly frozen (an
 * already-filed period is a no-op and is not listed). A malformed or absent Stichtag freezes nothing.
 */
function freezeFiledVatPeriods(ctx: WorkspaceContext, liveWorkspaceId: string, stichtag: string | null): string[] {
  if (typeof stichtag !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(stichtag)) return [];
  const stichtagMonth = stichtag.slice(0, 7); // 'YYYY-MM'
  const stichtagYear = Number(stichtag.slice(0, 4));
  // A system-capable context scoped to the workspace that just became real books: the freeze is a
  // consequence of an already-authorised promotion, not a separate manage_periods act by the actor.
  const liveCtx: WorkspaceContext = { ...ctx, workspaceId: liveWorkspaceId, capabilities: allowAllCapabilities };
  // How far back the books actually reach: the earliest prior-system period the migration archived
  // ('YYYY-MM'), if any. This is the real lower bound on periods the business ever had.
  const earliestArchived = (
    ctx.store.db
      .prepare('SELECT MIN(period) AS m FROM gl_archive_period WHERE workspace_id = ?')
      .get(liveWorkspaceId) as { m: string | null } | undefined
  )?.m ?? null;
  const floorYear = Math.min(
    stichtagYear - 1,
    earliestArchived !== null ? Number(earliestArchived.slice(0, 4)) : stichtagYear,
  );
  const frozen: string[] = [];
  for (let year = floorYear; year <= stichtagYear; year += 1) {
    const listed = listVatPeriods(liveCtx, { year: String(year) });
    if (!listed.ok) continue; // needs_vat_config: no VAT method that year, nothing to freeze.
    const periods = (listed as { periods?: Array<{ label: string; months: string[]; filed: boolean }> }).periods ?? [];
    for (const p of periods) {
      // WHOLLY before the Stichtag: every month strictly earlier than the Stichtag's own month.
      if (!p.months.every((m) => m < stichtagMonth)) continue;
      if (p.filed) continue; // already filed: idempotent no-op, not re-sealed, not reported.
      // K1: the key is derivable from the workspace and the period label, so the seal runs in this
      // composite's own idempotency scope, never the public `lock_period` one a caller could pre-claim.
      const r = ctx.store.innerWrite('go_productive', () =>
        markVatPeriodFiled(liveCtx, { period: p.label, idempotencyKey: `migfreeze:${liveWorkspaceId}:${p.label}` }),
      );
      if (r.ok) frozen.push(p.label);
    }
  }
  return frozen;
}

/** A demo-seeded row in a workspace, or null: `is_demo` set, or any posting stamped `source='demo_seed'`. */
function demoSeededRow(ctx: WorkspaceContext, ws: WorkspaceKindRow): { kind: string; id: string } | null {
  if (ws.is_demo === 1 || ws.kind === 'demo') return { kind: 'workspace', id: ws.id };
  const entry = ctx.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND source = 'demo_seed' LIMIT 1")
    .get(ws.id) as { id: string } | undefined;
  return entry === undefined ? null : { kind: 'journal_entry', id: entry.id };
}

/** The company profile is real when its legal form and UID are set, and its MWST number if registered. */
function companyProfileComplete(ws: WorkspaceKindRow): boolean {
  if (ws.legal_form === null || ws.uid === null) return false;
  if (ws.vat_registered === 1 && ws.mwst_no === null) return false;
  return true;
}

// --- Ownership: the one plan a Testmandant belongs to (US-G12.4, owner decision 11.10.2026) ------

/**
 * What `owningPlan` answers about a plan's linked Testmandant: this plan OWNS it (it may discard,
 * abandon with it, and promote it), it does NOT (another plan does; this one may only drop its own
 * link), or it is GONE (the linked workspace no longer exists). There is no fourth, shared, answer.
 */
export type TestmandantOwnership = 'owner' | 'not_owner' | 'gone';

/** Every plan, in ANY workspace, that links `sandboxId`: the oldest workspace first, then the oldest plan. */
function plansLinking(ctx: StoreOnly, sandboxId: string): Array<{ id: string; workspace_id: string }> {
  // A deliberate read across workspaces, and its whole reach: plan ids and their workspace ids, never
  // a field of another tenant's plan, and nothing of it is returned to the caller. Settling which
  // single plan owns a sandbox needs to know which others claim it.
  return ctx.store.db
    .prepare(
      `SELECT p.id, p.workspace_id FROM migration_plan p JOIN workspace w ON w.id = p.workspace_id
        WHERE p.testmandant_workspace_id = ? ORDER BY w.rowid, p.rowid`,
    )
    .all(sandboxId) as Array<{ id: string; workspace_id: string }>;
}

/**
 * Does `workspaceId` hold the creation receipt for `sandboxId`: the idempotency row
 * `migration_create_testmandant` wrote when it minted it? `idempotency` is an OPERATIONAL table a
 * backup never carries (`data/portability.ts`), so no restored copy can hold one.
 */
function holdsCreationReceipt(ctx: StoreOnly, workspaceId: string, sandboxId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS r FROM idempotency
        WHERE workspace_id = ? AND verb = 'migration_create_testmandant'
          AND json_valid(result_json) AND json_extract(result_json, '$.createdTestmandantId') = ? LIMIT 1`,
    )
    .get(workspaceId, sandboxId) as { r: number } | undefined;
  return row !== undefined;
}

/**
 * THE OWNERSHIP RESOLVER. The link is written by one workspace only (`createTestmandant`), and since
 * 11.10.2026 a restore clears it and env_copy re-points it (`trialReset.ts`), so a book written from
 * then on holds at most one plan per Testmandant. Books restored before the fix can hold several, and
 * they are settled, never shared:
 *   1. the linked workspace no longer exists: `gone`;
 *   2. exactly one plan links it: that plan is the owner;
 *   3. several do: the owner is the linking plan whose workspace holds the creation receipt;
 *   4. none holds one (a receipt is lost only by hand): the plan of the linking workspace with the
 *      lowest rowid, the oldest, which a restored copy (a workspace minted later) never is.
 * Returns `gone` for a plan with no link at all (nothing to own). It reads only the store, so env_copy
 * can ask it of the source before copying (`landscape/copy.ts`, which carries owner links only).
 *
 * LEGACY-ONLY LIMIT: rule 4 trusts rowid order, which a book written by this engine never needs (one
 * linker at most). An old target filled by mandate-scope env_copy runs before 11.10.2026 can hold copies
 * in copy order with no receipts; there a copy-of-copy may be resolved as owner. Still never shared.
 */
export function owningPlan(
  ctx: StoreOnly,
  plan: { id: string; workspace_id: string; testmandant_workspace_id: string | null },
): TestmandantOwnership {
  const sandboxId = plan.testmandant_workspace_id;
  if (sandboxId === null || loadWorkspace(ctx, sandboxId) === undefined) return 'gone';
  const linking = plansLinking(ctx, sandboxId);
  let owner = linking[0];
  if (linking.length > 1) owner = linking.find((p) => holdsCreationReceipt(ctx, p.workspace_id, sandboxId)) ?? owner;
  return owner !== undefined && owner.id === plan.id && owner.workspace_id === plan.workspace_id ? 'owner' : 'not_owner';
}

/** How a Testmandant deletion was asked for, recorded in the source workspace's audit row. */
export type TestmandantDeletionVia = 'discard' | 'abandon';

/**
 * THE ONE GUARDED PATH THAT DELETES A PLAN'S TESTMANDANT, for `discard_testmandant` and
 * `migration_abandon_plan` alike. The caller holds the transaction and has run its own checks; this
 * re-asserts the fence itself, so a caller that skipped one is a wiring defect that THROWS (rolling
 * the transaction back) rather than deletes: the plan must OWN the Testmandant (`owningPlan`) and its
 * kind must be `sandbox` (never `live` real books, never a G03 `demo`). Then it hard-deletes the
 * sandbox, clears the plan's link, and writes ONE audit row in the SOURCE workspace's chain, because
 * the sandbox's own chain goes with it: entity `migration_plan` and the plan id, the action
 * `testmandant_deleted_by_<via>`, the actor and the time. The row does not carry the deleted
 * workspace's id: a foreign workspace id in a row of the source makes every later backup of the
 * source refuse to restore as a foreign reference. Returns the deleted workspace's id.
 */
export function deleteOwnedTestmandant(ctx: WorkspaceContext, plan: PlanRow, via: TestmandantDeletionVia): string {
  const sandboxId = plan.testmandant_workspace_id;
  if (sandboxId === null || owningPlan(ctx, plan) !== 'owner') {
    throw new Error(`deleteOwnedTestmandant: plan ${plan.id} does not own a Testmandant`);
  }
  if (loadWorkspace(ctx, sandboxId)?.kind !== 'sandbox') {
    throw new Error(`deleteOwnedTestmandant: the Testmandant of plan ${plan.id} is not a sandbox`);
  }
  hardDeleteWorkspace(ctx, sandboxId);
  ctx.store.db
    .prepare('UPDATE migration_plan SET testmandant_workspace_id = NULL WHERE id = ? AND workspace_id = ?')
    .run(plan.id, ctx.workspaceId);
  appendAuditLog(
    { store: ctx.store, workspaceId: ctx.workspaceId, ids: ctx.ids },
    { entityKind: 'migration_plan', entityId: plan.id, action: `testmandant_deleted_by_${via}`, actor: ctx.actor, at: ctx.clock.now() },
  );
  return sandboxId;
}

// --- discardTestmandant (US-G12.4) ---------------------------------------------------------------

/** A plan in one of these states has left the journey; a discard never moves it back to `planned`. */
const TERMINAL_PLAN_STATES: ReadonlySet<string> = new Set(['abandoned', 'closed']);

/**
 * Hard-delete a Testmandant and every row under it (US-G12.4), the shape G03's `discardDemoWorkspace`
 * defines for a demo: nothing in a Testmandant is a real fiscal record until it goes productive. It is
 * STRUCTURALLY incapable of reaching a live workspace: it refuses unless `kind='sandbox'` (a `demo`
 * discards through G03's verb, and after `goProductive` the kind is `live`, so the same call refuses),
 * and the delete targets ONLY `workspace_id = <the sandbox>`, which can never match a live tenant's
 * rows. And it deletes only a Testmandant THIS plan owns (`owningPlan`): a copy's plan that still
 * links the original's sandbox (a book restored before 11.10.2026) drops its own link and deletes
 * nothing (`unlinkedOnly`), and a link to a workspace that is already gone is cleared (`alreadyGone`).
 *
 * After a delete the plan survives and returns to `planned` with its trial-load state reset (the maps
 * and declared controls are the operator's work; the Testmandant was always the disposable part). An
 * `abandoned` or `closed` plan keeps its status: a discard never revives a plan that left the journey.
 *
 * A sandbox no plan links any more is discarded by `discardOrphanTestmandant` below, the orphan exit.
 */
export function discardTestmandant(
  ctx: WorkspaceContext,
  input: { planId: unknown; confirmed: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlanRow(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });

  // Replay a completed discard for this key BEFORE the state guards, so the double-call returns the
  // byte-identical stored result: after a discard the plan's link is null, and without this replay a
  // retry of a done discard would reject with not_a_testmandant (the store's recallIdempotent contract).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'discard_testmandant');
  if (replayed !== undefined) return replayed;

  if (plan.testmandant_workspace_id === null) return err('not_a_testmandant', { planId: plan.id });
  const linkedId = plan.testmandant_workspace_id;
  const ownership = owningPlan(ctx, plan);

  // GONE: the linked workspace no longer exists. Clear the dangling link (with the trial reset), and
  // say so; there is nothing to confirm, because nothing is deleted.
  if (ownership === 'gone') {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'discard_testmandant', () => {
      unlinkPlanTestmandant(ctx.store.db, ctx.workspaceId, plan.id, ctx.clock.now(), !TERMINAL_PLAN_STATES.has(plan.status));
      return ok({ ok: true, alreadyGone: true, discardedWorkspaceId: null, planId: plan.id });
    });
  }

  // NOT THE OWNER: another plan owns this Testmandant (the original this book was copied from). The
  // copy's plan drops its own link, with the trial reset, and deletes nothing, whatever the linked
  // workspace's kind (nothing is deleted, so the kind fence below has nothing to protect here).
  if (ownership === 'not_owner') {
    if (input.confirmed !== true) return err('needs_confirmation', { planId: plan.id });
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'discard_testmandant', () => {
      unlinkPlanTestmandant(ctx.store.db, ctx.workspaceId, plan.id, ctx.clock.now(), !TERMINAL_PLAN_STATES.has(plan.status));
      return ok({ ok: true, unlinkedOnly: true, discardedWorkspaceId: null, planId: plan.id });
    });
  }

  const testmandant = loadWorkspace(ctx, linkedId);
  // THE STRUCTURAL FENCE: discard proceeds ONLY for a `sandbox`. A `demo` (G03's verb) and a `live`
  // (never, through this family) both refuse here, so a live workspace's ledger can never be reached.
  if (testmandant === undefined || testmandant.kind !== 'sandbox') {
    return err('not_a_testmandant', { workspaceId: linkedId, kind: testmandant?.kind ?? null });
  }
  if (input.confirmed !== true) return err('needs_confirmation', { workspaceId: testmandant.id });

  // Agent safety (US-G12.4 boundary, G09 US-G09.4's rule): once ANY step has committed to a live
  // workspace, discard/abandon require the stronger `commit_migration`, not just `manage_import`.
  const steps = loadStepRows(ctx, plan.id);
  const anyCommitted = steps.some((s) => s.status === 'committed' || s.status === 'verified');
  if (anyCommitted) {
    const cap = ctx.capabilities.assert('commit_migration');
    if (!cap.ok) return cap;
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'discard_testmandant', () => {
    const targetId = deleteOwnedTestmandant(ctx, plan, 'discard');
    // A plan that left the journey (abandoned, closed) keeps its status and its steps as they stood.
    if (!TERMINAL_PLAN_STATES.has(plan.status)) {
      // Reset the plan: back to `planned`, every non-terminal step to `mapped`, approvals voided, so
      // the operator can re-run the trial. The plan, maps and declared controls survive.
      ctx.store.db
        .prepare("UPDATE migration_plan SET status = 'planned' WHERE id = ? AND workspace_id = ?")
        .run(plan.id, ctx.workspaceId);
      const now = ctx.clock.now();
      for (const step of steps) {
        if (step.status === 'skipped') continue;
        ctx.store.db
          .prepare("UPDATE migration_step SET status = 'mapped', last_check_id = NULL, committed_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?")
          .run(now, step.id, ctx.workspaceId);
        ctx.store.db.prepare('DELETE FROM migration_approval WHERE step_id = ? AND workspace_id = ?').run(step.id, ctx.workspaceId);
      }
    }
    // OP8: `discardedWorkspaceId` resolves the `migration.testmandant_discarded` occurrence.
    return ok({ ok: true, discardedWorkspaceId: targetId, planId: plan.id });
  });
}

// --- discardOrphanTestmandant (US-G12.4, the orphan exit) ------------------------------------------

/** The orphan exit's input: the sandbox itself, named as data (a deps verb, see below). */
export interface DiscardOrphanTestmandantInput {
  workspaceId: unknown;
  confirmed: unknown;
  idempotencyKey: unknown;
}

/**
 * The orphan exit (US-G12.4): hard-delete a sandbox no plan links any more (an env_copy that carried
 * the Testmandant without its plan). `discard_orphan_testmandant` is a DEPS verb on purpose, shaped
 * like G03's `discardDemoWorkspace`: its success deletes the very workspace it names, so the shared
 * boundary's workspace_not_found check would refuse the replay of a completed discard (critic,
 * 11.10.2026). The boundary's order is restated here: the replay FIRST, then existence, then the A24
 * gate (`manage_import`, the `discard_testmandant` right, through the same `capabilityPort`), then the
 * archive refusal, then the fences: the kind must be `sandbox` (`not_a_testmandant`) and no plan in
 * any workspace may link it (`testmandant_linked`: that plan's own discard is the way). §H-TENANT by
 * construction: the only workspace it can reach is the one it names and was authorised on.
 *
 * The memo lives in the `_system` namespace (the workspace is gone afterwards) under a key scoped to
 * the workspace (`<workspaceId>:<key>`), so two orphans discarded with the same key never answer each
 * other's call.
 */
export function discardOrphanTestmandant(deps: SetupDeps, input: DiscardOrphanTestmandantInput): Result {
  const guard = reqStr(input.workspaceId, 'workspaceId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const workspaceId = input.workspaceId as string;
  const memoKey = `${workspaceId}:${input.idempotencyKey as string}`;
  const replayed = deps.store.recallIdempotent<Result>('_system', memoKey, 'discard_orphan_testmandant');
  if (replayed !== undefined) return replayed;

  const ctx = makeContext(deps.store, { workspaceId, actor: deps.actor ?? 'system', clock: deps.clock, ids: deps.ids });
  const self = loadWorkspace(ctx, workspaceId);
  if (self === undefined) return err('workspace_not_found', { workspaceId });
  const gate = capabilityPort(deps.store, workspaceId, deps.actor ?? 'system', deps.identitySource).assert('manage_import');
  if (!gate.ok) return gate;
  const archived = (deps.store.db.prepare('SELECT archived FROM workspace WHERE id = ?').get(workspaceId) as { archived: number }).archived;
  if (archived === 1) return err('workspace_archived', { workspaceId });
  if (self.kind !== 'sandbox') return err('not_a_testmandant', { workspaceId, kind: self.kind });
  if (plansLinking(ctx, workspaceId).length > 0) return err('testmandant_linked', { workspaceId });
  if (input.confirmed !== true) return err('needs_confirmation', { workspaceId });
  return deps.store.rememberIdempotent('_system', memoKey, 'discard_orphan_testmandant', () => {
    hardDeleteWorkspace(ctx, workspaceId);
    return ok({ ok: true, discardedWorkspaceId: workspaceId });
  });
}

/**
 * Hard-delete a workspace and every row that lives under it. Deletes ONLY rows whose `workspace_id`
 * is the target (plus the two anchor tables that fence a workspace by a differently-named column), so
 * no other tenant's row is reachable by construction. `defer_foreign_keys` lets the deletes run in any
 * order inside the one transaction: the final state is self-consistent because everything that
 * references a deleted row is itself deleted (a Testmandant is isolated; nothing outside it points in).
 *
 * EXPORTED for exactly one other caller: G03's `discardDemoWorkspace` (`core/onboarding/demo.ts`),
 * which deletes a `kind='demo'` workspace under the same "nothing in it is a real fiscal record"
 * contract. The kind guards stay with each caller; the deletion mechanic stays single-sourced here
 * so a schema change never has to be mirrored into a second delete loop.
 *
 * THE PROTECTIVE TRIGGERS ARE DROPPED FOR THE DURATION OF THE DELETE, AND WHY THAT IS CORRECT
 * RATHER THAN A HOLE. The §H-AUDIT immutability triggers (`journal_entry_no_delete_posted` and
 * friends, plus G13's archive walls) exist so no code path can destroy a posted row of REAL books.
 * A Testmandant or a demo holds posted rows too (a trial-loaded opening position; a demo's seeded
 * invoices), and those rows are exactly what both specs define as "not a real fiscal record until
 * it goes productive": without this, any disposable workspace that ever posted became undiscardable
 * (`posted_immutable` aborting the delete), which inverted the safety argument by making the ONLY
 * exit for sample data impossible. The fence that protects real books is the KIND GUARD in each
 * caller (`sandbox` here, `demo` in G03), checked BEFORE this function runs, plus the `WHERE
 * workspace_id = ?` scope on every delete. The drop is transactional (SQLite DDL rolls back with
 * the enclosing transaction) and the stored `sql` is re-executed before returning, so the triggers
 * are back in force in the same transaction that ends the delete; even a crash between the two is
 * healed by `CREATE TRIGGER IF NOT EXISTS` in SCHEMA_SQL on the next open (`store/migrations.ts`
 * note 4).
 */
export function hardDeleteWorkspace(ctx: WorkspaceContext, workspaceId: string): void {
  const db = ctx.store.db;
  // Defer FK enforcement to COMMIT (settable inside a transaction, unlike `foreign_keys`); it resets
  // when the transaction ends. The idempotency wrapper already opened one around this compute.
  db.pragma('defer_foreign_keys = ON');
  // Lift the protective triggers for the fenced delete, remembering their DDL to restore below.
  const triggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all() as { name: string; sql: string | null }[];
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const columnsOf = (name: string): string[] =>
    (db.pragma(`table_info(${name})`) as { name: string }[]).map((c) => c.name);
  // FIRST the child tables that carry NO tenant column of their own and fence by parent instead
  // (`journal_line` by `entry_id`): delete every row whose parent row belongs to the target
  // workspace, BEFORE the parent rows go, or the deferred FK check fails at COMMIT on rows the
  // tenant loop below can not see. Derived from the real FK graph rather than a hand-kept list, so
  // a future parent-fenced table is swept without editing this function.
  for (const { name } of tables) {
    const cols = columnsOf(name);
    if (cols.includes('workspace_id') || cols.includes('created_in_workspace_id')) continue;
    const fks = db.pragma(`foreign_key_list(${name})`) as { table: string; from: string; to: string | null }[];
    for (const fk of fks) {
      if (fk.table === 'workspace') {
        db.prepare(`DELETE FROM ${name} WHERE ${fk.from} = ?`).run(workspaceId);
        continue;
      }
      const parentCols = columnsOf(fk.table);
      if (!parentCols.includes('workspace_id')) continue;
      const parentKey = fk.to ?? 'id';
      db.prepare(
        `DELETE FROM ${name} WHERE ${fk.from} IN (SELECT ${parentKey} FROM ${fk.table} WHERE workspace_id = ?)`,
      ).run(workspaceId);
    }
  }
  for (const { name } of tables) {
    if (name === 'workspace') continue;
    const cols = columnsOf(name);
    if (cols.includes('workspace_id')) {
      db.prepare(`DELETE FROM ${name} WHERE workspace_id = ?`).run(workspaceId);
    }
    // The map-template table fences a workspace by `created_in_workspace_id` (never `workspace_id`, by
    // design, spec G10 §schema); a Testmandant that authored one has its provenance rows removed too.
    if (cols.includes('created_in_workspace_id')) {
      db.prepare(`DELETE FROM ${name} WHERE created_in_workspace_id = ?`).run(workspaceId);
    }
  }
  db.prepare('DELETE FROM workspace WHERE id = ?').run(workspaceId);
  // Restore every trigger in the same transaction, so the walls are up before anything else runs.
  for (const t of triggers) {
    if (t.sql !== null) db.exec(t.sql);
  }
}
