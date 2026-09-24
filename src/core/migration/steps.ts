/**
 * G09, the STEP verbs: preview (zero writes), trial-load (into the G12 Testmandant), commit (into the
 * live books, behind the six-condition gate), rollback (reversing entries, never a delete) and the
 * approval that binds a human to a check result.
 *
 * THE MONEY PATH, STATED ONCE AND ENFORCED BY CONSTRUCTION (D86). A migrated document POSTS NOTHING.
 * `commitStep` never replays a historical document as a journal posting; a money-path class's whole
 * ledger effect arrives through A04's SINGLE opening-balance entry (`set_opening_balances`). The only
 * posting path this file can reach is the OWNING spec's verb named in `dataClasses.ts` (P3 is
 * unavailable to violate, not merely respected): the static no-`postEntry`-import assertion (spec §7)
 * holds because this file imports `setOpeningBalances`/`reverseEntry`, never `postEntry`.
 *
 * §H-IDEMPOTENT: every write memoises under its own verb scope, so a double commit posts once and a
 * concurrent second caller sees the terminal state and gets the stored result (asserted on ROWS).
 * §H-AUDIT: a committed step is append-only; rollback posts REVERSING entries and never mutates
 * history (five SQLite triggers refuse an update/delete of a posted entry below the engine, D85 §1).
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { setOpeningBalances, reverseEntry } from '../ledger/index.js';
import { importContacts } from '../sales/index.js';
import { getFileContent, linkFile, fileIsStreamOnly, readBlobSegmentsSync } from '../files/files.js';
import { allowAllCapabilities } from '../ports.js';
import { markVatPeriodFiled } from '../vat/index.js';
import { importCamt } from '../banking/index.js';
import { parseSource, parseStreamSync, isParseFailure, STREAM_BATCH_ROWS, type ParsedRow } from './adapters/parse.js';
import { dataClassDef } from './dataClasses.js';
import {
  isCrudCommitClass,
  classifyCrudRows,
  commitCrudRows,
  appliedColumnMap,
  parsedResolutions,
  type CrudRowResult,
} from './crudCommit.js';
import { checkStep, testmandantFor, hasPreMigrationBackup, glArchiveImport } from './seams.js';
import { buildOpeningLines } from './openingLines.js';
import { loadPlan, loadStep, loadSourceFiles, type StepRow, type PlanRow, type StepState } from './plan.js';
import { isCutoverPending, cutoverInFuture } from './stichtag.js';

// --- The transition map, single source for the no-dead-end machine-walk test (spec §7) ----------

export const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  pending: ['mapped', 'skipped'],
  mapped: ['previewed', 'skipped'],
  previewed: ['trial_loaded', 'mapped', 'failed'],
  trial_loaded: ['checked', 'mapped', 'failed'],
  checked: ['committed', 'mapped', 'failed'],
  committed: ['verified', 'rolled_back', 'diverged'],
  verified: ['diverged', 'rolled_back'],
  // Every re-entry state returns to `mapped` (canon blocker 1); none is a dead end.
  diverged: ['mapped'],
  failed: ['mapped'],
  rolled_back: ['mapped'],
  // Terminal: an excluded class. The machine-walk test allows this one to have no exit.
  skipped: [],
};

// --- Small helpers ------------------------------------------------------------------------------

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

function setStatus(ctx: WorkspaceContext, step: StepRow, status: StepState, counts?: unknown): void {
  ctx.store.db
    .prepare('UPDATE migration_step SET status = ?, counts = COALESCE(?, counts), updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(status, counts === undefined ? null : JSON.stringify(counts), ctx.clock.now(), step.id, ctx.workspaceId);
}

/**
 * Return a step to `mapped` and VOID every recorded approval on it (canon blocker 6). This is the one
 * mechanism that makes the agent-autonomy boundary enforceable rather than conventional: an agent
 * cannot re-run an import after a human approved a DIFFERENT result, because the approval is gone the
 * moment the step moves.
 */
function returnToMapped(ctx: WorkspaceContext, step: StepRow): void {
  ctx.store.db.prepare('DELETE FROM migration_approval WHERE step_id = ? AND workspace_id = ?').run(step.id, ctx.workspaceId);
  setStatus(ctx, step, 'mapped');
}

/** The delimited-text adapters whose parse can be STREAMED batch by batch (US-G18.4). A structured
 * format (xlsx, XML) needs its whole container, so a large one of those is read materialised instead. */
const STREAMABLE_ADAPTERS: ReadonlySet<string> = new Set(['csv', 'tsv', 'bexio_csv', 'banana_tsv', 'cresus_csv']);

/**
 * Stream a step's source rows in batches of at most `STREAM_BATCH_ROWS` (G18 US-G18.4). A
 * migration-class blob (over the 25 MiB single-call bound) with a streamable delimited adapter is read
 * segment by segment through E00's synchronous byte-range reader and paginated, so peak memory is one
 * batch regardless of source size; a small source (or a structured format) is parsed once and yielded
 * as a single batch. Each batch names the file it came from and any parse failure for that file alone.
 */
function* streamStepBatches(
  ctx: WorkspaceContext,
  plan: PlanRow,
  step: StepRow,
): Generator<{ rows: readonly ParsedRow[]; warnings: readonly string[]; errors: readonly string[] }> {
  for (const file of loadSourceFiles(ctx, plan.id)) {
    const classes = file.data_classes === null ? [] : (JSON.parse(file.data_classes as string) as string[]);
    if (classes.length > 0 && !classes.includes(step.data_class)) continue;
    const fileId = file.file_id as string;
    const adapter = (file.adapter as string) ?? 'csv';

    if (fileIsStreamOnly(ctx, fileId) && STREAMABLE_ADAPTERS.has(adapter)) {
      // The large-source path: never materialise the whole file. `getFileContent` would refuse this
      // blob with `file_too_large_use_stream`, so the rows arrive through the segment reader instead.
      for (const batch of parseStreamSync(readBlobSegmentsSync(ctx, fileId), step.data_class)) {
        yield { rows: batch.rows, warnings: batch.warnings, errors: [] };
      }
      continue;
    }

    const content = getFileContent(ctx, { fileId });
    if (!content.ok) {
      yield { rows: [], warnings: [], errors: [`source_integrity_mismatch:${fileId}`] };
      continue;
    }
    const bytes = Buffer.from(content.contentBase64 as string, 'base64');
    const parsed = parseSource(adapter, bytes, step.data_class);
    if (isParseFailure(parsed)) {
      yield { rows: [], warnings: [], errors: [`source_unparseable:${fileId}`] };
      continue;
    }
    yield { rows: parsed.rows, warnings: parsed.warnings, errors: [] };
  }
}

/**
 * Read the plan's linked source files for a step's class and materialise them into rows. Built over the
 * streaming reader, so a migration-class blob is READABLE here (the old `getFileContent` base64 path
 * would refuse it), but this collects the batches into one array for the commit routes that need the
 * whole set. The bounded, memory-flat consumer is `previewStep`, which classifies batch by batch and
 * never holds the array; a commit route materialises because its owning verb takes rows, not a stream.
 */
function gatherRows(ctx: WorkspaceContext, plan: PlanRow, step: StepRow): { rows: ParsedRow[]; warnings: string[]; errors: string[] } {
  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const batch of streamStepBatches(ctx, plan, step)) {
    rows.push(...batch.rows);
    warnings.push(...batch.warnings);
    errors.push(...batch.errors);
  }
  return { rows, warnings, errors };
}

/** A stable ref for a source row, for the row-level audit trail and conflict resolution keys. */
function rowRef(index: number): string {
  return `row:${index}`;
}

// --- The classifier (US-G09.9): willCreate | willSkip | willConflict ----------------------------

interface Classified {
  willCreate: number;
  willSkip: number;
  willConflict: Array<{ ref: string; reason: string }>;
  errors: string[];
  sample: ParsedRow[];
}

function classify(ctx: WorkspaceContext, plan: PlanRow, step: StepRow, rows: readonly ParsedRow[]): Classified {
  const out: Classified = { willCreate: 0, willSkip: 0, willConflict: [], errors: [], sample: rows.slice(0, 10) };
  const def = dataClassDef(step.data_class);

  if (isCrudCommitClass(step.data_class)) {
    // US-G09.9 over the class's declared match key: exact match -> willSkip (nothing to do), key
    // match with differing fields -> willConflict, no match -> willCreate. The G10 applied column
    // map translates arbitrary source headers first; the alias table covers a plain unmapped CSV.
    const map = appliedColumnMap(ctx, plan.id);
    for (const c of classifyCrudRows(ctx, step.data_class, rows, map, rowRef)) {
      if (c.outcome === 'create') out.willCreate++;
      else if (c.outcome === 'skip') out.willSkip++;
      else if (c.outcome === 'conflict') out.willConflict.push({ ref: c.ref, reason: c.reason ?? 'exists_differs' });
      else out.errors.push(`${c.ref}:${c.reason ?? 'invalid_row'}`);
    }
    return out;
  }

  if (step.data_class === 'opening_balances') {
    // Match key: account. A conflict is an account that already carries an opening balance, which A04
    // refuses with `account_already_has_balance`. Whole-position: if an opening entry already exists,
    // every mapped account is a conflict; otherwise all create.
    // A04 posts the opening position with `source = 'import'` (openingBalances.ts): its presence is
    // the signal that this workspace already holds an opening balance, which A04 itself refuses to
    // double with `account_already_has_balance`. Detecting it here turns that into a preview conflict.
    const existing = ctx.store.db
      .prepare("SELECT 1 FROM journal_entry WHERE workspace_id = ? AND source = 'import' LIMIT 1")
      .get(ctx.workspaceId) as unknown;
    rows.forEach((_r, i) => {
      if (existing !== undefined) out.willConflict.push({ ref: rowRef(i), reason: 'account_already_has_balance' });
      else out.willCreate++;
    });
    return out;
  }

  if (step.data_class === 'contacts') {
    // Match key: uid, then name+postcode (C00's own three signals). A name already present is a
    // conflict; nothing present is a create. Kept intentionally simple: the real matcher is C00's.
    rows.forEach((r, i) => {
      const name = r.name ?? r.Name ?? '';
      if (name === '') {
        out.errors.push(`${rowRef(i)}:missing_name`);
        return;
      }
      const hit = ctx.store.db
        .prepare('SELECT 1 FROM contact WHERE workspace_id = ? AND name = ? LIMIT 1')
        .get(ctx.workspaceId, name) as unknown;
      if (hit !== undefined) out.willConflict.push({ ref: rowRef(i), reason: 'contact_exists' });
      else out.willCreate++;
    });
    return out;
  }

  // Every other class: without the applied column map (G10) the harness cannot match, so it treats
  // every row as a create. The owner is named on commit if the class is not wired this wave.
  void def;
  out.willCreate = rows.length;
  return out;
}

/** The willConflict rows the operator has NOT resolved yet (US-G09.9: an unresolved one blocks commit). */
function unresolvedConflicts(step: StepRow, conflicts: ReadonlyArray<{ ref: string; reason: string }>): string[] {
  const resolved = step.conflict_resolutions === null ? {} : (JSON.parse(step.conflict_resolutions) as Record<string, unknown>);
  return conflicts.filter((c) => resolved[c.ref] === undefined).map((c) => c.ref);
}

// --- previewStep (zero writes anywhere) ---------------------------------------------------------

/**
 * US-G09.3/US-G09.9: dry-run a step. Writes NOTHING ANYWHERE, not even a status note (spec §7: "a
 * preview of a large fixture leaves the database byte-identical"), which is why it is a READ verb.
 * It classifies every row willCreate | willSkip | willConflict against the class's match key and
 * returns the result; the operator resolves conflicts through the step's companion write, never here.
 */
export function previewStep(ctx: WorkspaceContext, input: { planId: unknown; stepId: unknown }): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId');
  if (guard) return guard;
  const plan = loadPlan(ctx, input.planId as string);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const step = loadStep(ctx, plan.id, input.stepId);
  if (step === undefined) return err('not_found', { stepId: input.stepId });
  if (step.status === 'skipped') return err('step_excluded', { stepId: step.id });

  // US-G18.4: classify BATCH BY BATCH so a multi-hundred-megabyte source is previewed without ever
  // materialising its rows. Peak memory is one batch (STREAM_BATCH_ROWS) plus a bounded sample and the
  // conflict list; the response carries the first ten rows as the sample, never the whole source. For a
  // small source this is one batch and identical to the materialised path. `willConflict` is bounded by
  // the number of genuine conflicts, which the operator must resolve anyway (it is not the row count).
  const willConflict: Array<{ ref: string; reason: string }> = [];
  const sample: ParsedRow[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let willCreate = 0;
  let willSkip = 0;
  let rowOffset = 0;
  let batches = 0;
  for (const batch of streamStepBatches(ctx, plan, step)) {
    errors.push(...batch.errors);
    warnings.push(...batch.warnings);
    if (batch.rows.length === 0) continue;
    batches += 1;
    // Classify this batch against the DB; the ref index is offset by the rows already consumed, so a
    // conflict ref is stable across the whole (paginated) source rather than resetting each batch.
    const c = classify(ctx, plan, step, batch.rows);
    willCreate += c.willCreate;
    willSkip += c.willSkip;
    for (const cf of c.willConflict) willConflict.push({ ref: offsetRef(cf.ref, rowOffset), reason: cf.reason });
    for (const e of c.errors) errors.push(offsetErr(e, rowOffset));
    if (sample.length < 10) sample.push(...batch.rows.slice(0, 10 - sample.length));
    rowOffset += batch.rows.length;
  }
  return {
    ok: true,
    willCreate,
    willSkip,
    willConflict,
    errors,
    sample,
    warnings,
    // The resume marker: how many rows and batches the source spans. A step that persists a batch
    // offset (trial-load/commit) reads it from here so a resume never re-reads consumed batches.
    counts: { sourceRows: rowOffset, batches, batchSize: STREAM_BATCH_ROWS },
  };
}

/** Shift a `row:N` ref by the rows already consumed, so a paginated preview keeps stable refs. */
function offsetRef(ref: string, offset: number): string {
  const m = /^row:(\d+)$/.exec(ref);
  return m === null ? ref : `row:${Number(m[1]) + offset}`;
}

/** Shift the `row:N` prefix inside an error string (e.g. `row:3:missing_name`) by the batch offset. */
function offsetErr(errStr: string, offset: number): string {
  const m = /^row:(\d+)(:.*)?$/.exec(errStr);
  return m === null ? errStr : `row:${Number(m[1]) + offset}${m[2] ?? ''}`;
}

// --- trialLoadStep (into the G12 Testmandant) ---------------------------------------------------

/**
 * US-G09.3: trial-load into the plan's Testmandant (G12). Until G12 provisions one
 * (// INTEGRATION-SEAM(G12)) the harness records the row-level outcomes and advances the step to
 * `trial_loaded` WITHOUT writing to the live books, which is the safe default. Idempotent on its key.
 */
export function trialLoadStep(ctx: WorkspaceContext, input: { planId: unknown; stepId: unknown; idempotencyKey: unknown }): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlan(ctx, input.planId as string);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const step = loadStep(ctx, plan.id, input.stepId);
  if (step === undefined) return err('not_found', { stepId: input.stepId });
  // Trial-load is the first write in the arc. It runs from `mapped` (preview is a pure read that does
  // not advance the step) or `previewed`, and is idempotent on a re-run from `trial_loaded`.
  if (!['mapped', 'previewed', 'trial_loaded'].includes(step.status)) return err('step_not_ready', { state: step.status });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_trial_load_step');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_trial_load_step', () => {
    const { rows } = gatherRows(ctx, plan, step);
    const c = classify(ctx, plan, step, rows);
    const target = testmandantFor(plan);
    const created: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ ref: string; reason: string }> = [];
    rows.forEach((_r, i) => {
      const ref = rowRef(i);
      if (c.willConflict.some((x) => x.ref === ref)) skipped.push(ref);
      else created.push(ref);
    });
    // US-G18.4: record the batch offset (rows consumed and the batch span) on the step, so a resume of
    // a paginated source knows where it left off and never re-reads a consumed batch.
    setStatus(ctx, step, 'trial_loaded', {
      willCreate: c.willCreate,
      willConflict: c.willConflict.length,
      trialTarget: target,
      sourceRows: rows.length,
      batches: Math.max(1, Math.ceil(rows.length / STREAM_BATCH_ROWS)),
      batchSize: STREAM_BATCH_ROWS,
    });
    // K-30 (owner decision "write 'trial'"): the first trial-load advances the PLAN from `planned` to
    // the `trial` state PLAN_STATES declares, so the state the machine names is actually reachable (it
    // was dead before: nothing wrote it, and K-23 was a Studio-side workaround for that gap). The guard
    // is in the WHERE clause (`AND status = 'planned'`), which makes it idempotent and race-safe: a
    // re-run from `trial_loaded`, or a plan already at `trial`/`live`/`closed`, flips nothing and never
    // thrashes the status. `commitStep` reads `trial` on its way to `live`; `discardTestmandant` resets
    // it to `planned`.
    ctx.store.db
      .prepare("UPDATE migration_plan SET status = 'trial' WHERE id = ? AND workspace_id = ? AND status = 'planned'")
      .run(plan.id, ctx.workspaceId);
    return ok({ created, skipped, failed, testmandant: target });
  });
}

// --- The commit gate (six conditions, stated as a conjunction) ----------------------------------

/**
 * US-G09.3/US-G09.4: commit into the LIVE workspace, behind the six-condition gate. Any one failing
 * returns a structured refusal naming WHICH (P9); a money-path class failing only the approval leg
 * returns the P8 draft-stage shape rather than an error, because nothing is wrong, a human simply has
 * not looked yet.
 */
export function commitStep(ctx: WorkspaceContext, input: { planId: unknown; stepId: unknown; idempotencyKey: unknown }): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlan(ctx, input.planId as string);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const step = loadStep(ctx, plan.id, input.stepId);
  if (step === undefined) return err('not_found', { stepId: input.stepId });

  // Idempotent replay of a completed commit: a double-commit returns the stored result (asserted on ROWS).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_commit_step');
  if (replayed !== undefined) return replayed;
  if (step.status === 'committed' || step.status === 'verified') {
    return ok({ created: [], skipped: [], failed: [], alreadyCommitted: true });
  }

  const def = dataClassDef(step.data_class);
  if (def === undefined) return err('unknown_data_class', { dataClass: step.data_class });

  // (0) F-09: the Übernahmestichtag must have arrived. A plan is PREPARED ahead of its date (scope,
  // map, trial load, check all run), but the commit into the live books waits for the calendar, for
  // every caller and before anything below advances a status. Named refusal (P9), both dates carried.
  if (isCutoverPending(ctx, plan)) return cutoverInFuture(ctx, plan);

  // (1) The step must be trial-loaded (or already checked). Preview alone is not enough: trial-load is
  // the safety this whole capability exists for.
  if (!['trial_loaded', 'checked'].includes(step.status)) return err('step_not_ready', { state: step.status, need: 'trial_loaded' });

  // The G11 check runs here (// INTEGRATION-SEAM(G11)), advancing trial_loaded -> checked and producing
  // the checkHash the approval binds to.
  const check = checkStep(ctx, { id: step.id, dataClass: step.data_class, counts: step.counts === null ? null : (JSON.parse(step.counts) as Record<string, unknown>) });
  ctx.store.db
    .prepare('UPDATE migration_step SET status = ?, last_check_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run('checked', check.checkHash, ctx.clock.now(), step.id, ctx.workspaceId);

  // (2) G11 reports no `failed` and no `not_asserted` control.
  const bad = check.controls.find((c) => c.status === 'failed' || c.status === 'not_asserted');
  if (bad !== undefined) return err('check_failed', { control: bad.id, status: bad.status });

  // (3) No unresolved willConflict row.
  const { rows } = gatherRows(ctx, plan, step);
  const classified = classify(ctx, plan, step, rows);
  const unresolved = unresolvedConflicts(step, classified.willConflict);
  if (unresolved.length > 0) return err('unresolved_conflicts', { count: unresolved.length, first: unresolved[0] });

  // (5) The actor holds `commit_migration` for a money-path class (the verb itself gates on
  // `manage_import`; a money-path commit needs the stronger, deliberately distinct capability).
  if (def.moneyPath) {
    const cap = ctx.capabilities.assert('commit_migration');
    if (!cap.ok) return cap;
  }

  // (4) A money-path class needs a `migration_approval` bound to exactly (stepId, checkHash). Missing
  // is not an error: it is the P8 draft-stage state, nothing is wrong, a human has not looked yet.
  if (def.moneyPath) {
    const approval = ctx.store.db
      .prepare('SELECT id FROM migration_approval WHERE step_id = ? AND workspace_id = ? AND check_hash = ? LIMIT 1')
      .get(step.id, ctx.workspaceId, check.checkHash) as { id: string } | undefined;
    if (approval === undefined) {
      return ok({ ok: true, staged: true, checkHash: check.checkHash, plan: plan.id, step: step.id });
    }
  }

  // (6) A G04 create_backup is on record for the FIRST live commit of a money-path plan
  // (// INTEGRATION-SEAM(G04)).
  if (def.moneyPath) {
    const priorCommit = ctx.store.db
      .prepare("SELECT 1 FROM migration_step WHERE plan_id = ? AND workspace_id = ? AND status IN ('committed','verified') LIMIT 1")
      .get(plan.id, ctx.workspaceId) as unknown;
    if (priorCommit === undefined && !hasPreMigrationBackup(plan)) {
      return err('needs_backup', { reason: 'a G04 create_backup must be on record before the first live commit' });
    }
  }

  // All six hold. Route to the owning verb (P3): the ONLY posting path this file can reach.
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_commit_step', () => {
    const outcome = commitRoute(ctx, plan, step, def, rows, input.idempotencyKey as string);
    if (!outcome.ok) return outcome;
    // The plan is live once a step has COMMITTED into the real books. Judged on the step's landed
    // state, not on `outcome.ok`: a CRUD step whose every row failed returns ok (row-level partial
    // success, US-G09.3) but lands `failed` and moved nothing, so it must not flip the plan live.
    const landed = loadStep(ctx, plan.id, step.id);
    const stepCommitted = landed !== undefined && (landed.status === 'committed' || landed.status === 'verified');
    if (stepCommitted && (plan.status === 'planned' || plan.status === 'trial')) {
      ctx.store.db.prepare("UPDATE migration_plan SET status = 'live' WHERE id = ? AND workspace_id = ?").run(plan.id, ctx.workspaceId);
    }
    return outcome;
  });
}

/** Route a commit through the owning spec's verb. NEVER `postEntry` directly (P3, spec §7). */
function commitRoute(
  ctx: WorkspaceContext,
  plan: PlanRow,
  step: StepRow,
  def: ReturnType<typeof dataClassDef> & object,
  rows: readonly ParsedRow[],
  idempotencyKey: string,
): Result {
  const now = ctx.clock.now();

  if (step.data_class === 'opening_balances') {
    // The migrated open item posts NOTHING of its own (D86 §2): the whole ledger effect is A04's
    // SINGLE opening entry, posted once through set_opening_balances. One entry regardless of row count.
    // buildOpeningLines is the ONE reading of the source (explicit debit/credit OR a signed Saldo), and
    // the G11 trial_balance control reads through the exact same builder so check and commit see one
    // number. Group / non-postable rows come back in `skipped`, recorded so the operator SEES them.
    const { lines, skipped } = buildOpeningLines(ctx, rows);
    const skippedRefs = skipped.map((s) => s.ref);
    if (lines.length === 0) {
      setStatus(ctx, step, 'committed', { created: 0, skipped: skipped.length, failed: 0 });
      recordStepRows(ctx, step, skippedRefs, 'skipped', 'journal_entry');
      ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
      return ok({ created: [], skipped: skippedRefs, failed: [] });
    }
    const res = setOpeningBalances(ctx, {
      lines: lines.map((l) => ({ account: l.account, debitMinor: l.debitMinor, creditMinor: l.creditMinor })),
      idempotencyKey: `migstep:${step.id}:${idempotencyKey}`,
      reference: `migration:${plan.id}`,
      description: 'Datenübernahme Eröffnungsbilanz',
    });
    if (!res.ok) return res;
    const entryId = (res as { entryId?: string }).entryId ?? null;
    setStatus(ctx, step, 'committed', { created: lines.length, skipped: skipped.length, failed: 0, openingEntryId: entryId });
    recordStepRows(ctx, step, lines.map((l) => l.ref), 'created', 'journal_entry', entryId ?? undefined);
    if (skippedRefs.length > 0) recordStepRows(ctx, step, skippedRefs, 'skipped', 'journal_entry');
    ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
    return ok({ created: [entryId], skipped: skippedRefs, failed: [], openingEntryId: entryId });
  }

  if (step.data_class === 'contacts') {
    const res = importContacts(ctx, { rows: rows as unknown, idempotencyKey: `migstep:${step.id}:${idempotencyKey}` });
    if (!res.ok) return res;
    const created = ((res as { created?: unknown[] }).created ?? []) as unknown[];
    setStatus(ctx, step, 'committed', { created: created.length, skipped: 0, failed: 0 });
    recordStepRows(ctx, step, rows.map((_r, i) => rowRef(i)), 'created', 'contact');
    ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
    return ok({ created, skipped: [], failed: [] });
  }

  if (step.data_class === 'gl_history') {
    return glArchiveImport(ctx, { planId: plan.id, stepId: step.id });
  }

  if (isCrudCommitClass(step.data_class)) {
    // The five master-data classes route PER ROW through the owning spec's verb (P3): create_item,
    // create_account, vat_code_upsert, update_contact, create_bank_account. Idempotent on ROWS: a
    // row whose match key already exists exactly is skipped, so a re-import creates zero extra.
    const map = appliedColumnMap(ctx, plan.id);
    const classifiedRows = classifyCrudRows(ctx, step.data_class, rows, map, rowRef);
    const results = commitCrudRows(ctx, step.data_class, classifiedRows, parsedResolutions(step.conflict_resolutions), step.id);
    const created = results.filter((r) => r.outcome === 'created');
    const skipped = results.filter((r) => r.outcome === 'skipped');
    const failed = results.filter((r) => r.outcome === 'failed').map((r) => ({ ref: r.ref, reason: r.reason ?? 'failed' }));
    recordRowOutcomes(ctx, step, results);
    if (created.length === 0 && skipped.length === 0 && failed.length > 0) {
      // US-G09.3 step level: a step that could not complete AT ALL lands `failed`, never `committed`.
      setStatus(ctx, step, 'failed', { created: 0, skipped: 0, failed: failed.length });
      return ok({ created: [], skipped: [], failed });
    }
    setStatus(ctx, step, 'committed', { created: created.length, skipped: skipped.length, failed: failed.length });
    ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
    return ok({
      created: created.map((r) => r.targetId ?? r.ref),
      skipped: skipped.map((r) => r.targetId ?? r.ref),
      failed,
    });
  }

  if (step.data_class === 'vat_history') {
    // R5: A07 seals each historical VAT period the OLD system filed. Delegated ENTIRELY to
    // vat_mark_filed (A07 posts nothing, P3 by absence). The six-leg money-path gate has already
    // cleared (approval + backup + commit_migration + a clean check), which is the authorisation for
    // the seal, so the period lock runs system-scoped rather than adding a manage_periods requirement
    // (spec §3: no new capability). Idempotent per period. The historical returns' source files stay
    // retained Belege (OR 958f / G13 archive), linked at discovery; the sealing is the act here.
    const sealCtx: WorkspaceContext = { ...ctx, capabilities: allowAllCapabilities };
    const created: string[] = [];
    const failed: Array<{ ref: string; reason: string }> = [];
    rows.forEach((r, i) => {
      const period = String(r.period ?? r.Periode ?? '').trim();
      if (period === '') {
        failed.push({ ref: rowRef(i), reason: 'missing_period' });
        return;
      }
      const res = markVatPeriodFiled(sealCtx, { period, idempotencyKey: `migstep:${step.id}:${idempotencyKey}:${period}` });
      if (res.ok) created.push(period);
      else failed.push({ ref: rowRef(i), reason: (res as { error?: string }).error ?? 'filing_failed' });
    });
    recordStepRows(ctx, step, created.map((_p, i) => rowRef(i)), 'created', 'vat_filing');
    if (created.length === 0 && failed.length > 0) {
      setStatus(ctx, step, 'failed', { created: 0, skipped: 0, failed: failed.length });
      return ok({ created: [], skipped: [], failed });
    }
    setStatus(ctx, step, 'committed', { created: created.length, skipped: 0, failed: failed.length });
    ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
    return ok({ created, skipped: [], failed });
  }

  if (step.data_class === 'documents') {
    // R5: each source file for the documents class is ALREADY stored in E00 (files_upload at
    // discovery); the commit LINKS each to the plan as a retained Beleg (E00 files_link). Delegated to
    // E00: no new storage path. Idempotent on rows: a file already linked returns its existing link,
    // so a re-commit creates zero extra.
    const created: string[] = [];
    const failed: Array<{ ref: string; reason: string }> = [];
    const files = loadSourceFiles(ctx, plan.id).filter((f) => {
      const classes = f.data_classes === null ? [] : (JSON.parse(f.data_classes as string) as string[]);
      return classes.length === 0 || classes.includes('documents');
    });
    files.forEach((f, i) => {
      const res = linkFile(ctx, { fileId: f.file_id as string, entityKind: 'migration_plan', entityId: plan.id, idempotencyKey: `migstep:${step.id}:${idempotencyKey}:${f.file_id}` });
      if (res.ok) created.push(f.file_id as string);
      else failed.push({ ref: rowRef(i), reason: (res as { error?: string }).error ?? 'link_failed' });
    });
    recordStepRows(ctx, step, created.map((_f, i) => rowRef(i)), 'created', 'file_link');
    if (created.length === 0 && failed.length > 0) {
      setStatus(ctx, step, 'failed', { created: 0, skipped: 0, failed: failed.length });
      return ok({ created: [], skipped: [], failed });
    }
    setStatus(ctx, step, 'committed', { created: created.length, skipped: 0, failed: failed.length });
    ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
    return ok({ created, skipped: [], failed });
  }

  if (step.data_class === 'bank_statements') {
    // R5: A20 imports each camt statement onto its registered A19 Bankkonto. Delegated ENTIRELY to
    // import_camt, which posts NO journal (it records bank facts and queues credits): no posting path
    // is opened here. The target account is resolved by A20's OWN IBAN check: import_camt is tried
    // against each registered account and the one whose IBAN matches the statement accepts it; a
    // statement matching no registered account fails that file honestly, never a guessed target.
    const importCtx: WorkspaceContext = { ...ctx, capabilities: allowAllCapabilities };
    const accounts = ctx.store.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as Array<{ id: string }>;
    const files = loadSourceFiles(ctx, plan.id).filter((f) => {
      const classes = f.data_classes === null ? [] : (JSON.parse(f.data_classes as string) as string[]);
      return classes.length === 0 || classes.includes('bank_statements');
    });
    const created: string[] = [];
    const failed: Array<{ ref: string; reason: string }> = [];
    files.forEach((f, i) => {
      const content = getFileContent(ctx, { fileId: f.file_id as string });
      if (!content.ok) {
        failed.push({ ref: rowRef(i), reason: 'source_integrity_mismatch' });
        return;
      }
      const xml = Buffer.from(content.contentBase64 as string, 'base64').toString('utf-8');
      let done = false;
      let lastReason = 'needs_bank_account';
      for (const acc of accounts) {
        const res = importCamt(importCtx, { bankAccountId: acc.id, xml, idempotencyKey: `migstep:${step.id}:${idempotencyKey}:${f.file_id}` });
        if (res.ok) {
          created.push(f.file_id as string);
          done = true;
          break;
        }
        lastReason = (res as { error?: string }).error ?? 'import_failed';
        if (lastReason !== 'iban_mismatch') break; // a real error, not merely the wrong account.
      }
      if (!done) failed.push({ ref: rowRef(i), reason: lastReason });
    });
    recordStepRows(ctx, step, created.map((_f, i) => rowRef(i)), 'created', 'bank_statement');
    if (created.length === 0 && failed.length > 0) {
      setStatus(ctx, step, 'failed', { created: 0, skipped: 0, failed: failed.length });
      return ok({ created: [], skipped: [], failed });
    }
    setStatus(ctx, step, 'committed', { created: created.length, skipped: 0, failed: failed.length });
    ctx.store.db.prepare('UPDATE migration_step SET committed_at = ? WHERE id = ? AND workspace_id = ?').run(now, step.id, ctx.workspaceId);
    return ok({ created, skipped: [], failed });
  }

  // A class whose owning verb is not built this wave (the migrated open items await A10's
  // `origin='migrated'` shape; the seams await their wave): route to the owner BY NAME, never guess
  // a writer (US-G09.2 boundary). The step stays committable once the owning verb lands.
  return err('class_commit_unavailable', { dataClass: step.data_class, owner: def.owner, commitVerb: def.commitVerb });
}

/** Write the per-row audit trail for a CRUD-class commit: one row per source row, with its outcome. */
function recordRowOutcomes(ctx: WorkspaceContext, step: StepRow, results: readonly CrudRowResult[]): void {
  const now = ctx.clock.now();
  const stmt = ctx.store.db.prepare(
    `INSERT INTO migration_step_row (id, workspace_id, step_id, source_row_ref, outcome, target_kind, target_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of results) {
    stmt.run(ctx.ids.next('migrow'), ctx.workspaceId, step.id, r.ref, r.outcome === 'created' ? 'created' : r.outcome === 'skipped' ? 'skipped' : 'failed', r.targetKind, r.targetId ?? null, r.reason ?? null, now);
  }
}

/** Write the row-level audit trail for a committed step (spec §4: makes row_count checkable). */
function recordStepRows(ctx: WorkspaceContext, step: StepRow, refs: readonly string[], outcome: string, targetKind: string, targetId?: string): void {
  const now = ctx.clock.now();
  const stmt = ctx.store.db.prepare(
    `INSERT INTO migration_step_row (id, workspace_id, step_id, source_row_ref, outcome, target_kind, target_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  for (const ref of refs) {
    stmt.run(ctx.ids.next('migrow'), ctx.workspaceId, step.id, ref, outcome, targetKind, targetId ?? null, now);
  }
}

// --- recordApproval -----------------------------------------------------------------------------

/**
 * US-G09.4: bind a human approval to a check result. A row exists for exactly (stepId, checkHash);
 * the UNIQUE constraint makes it idempotent. Every return to `mapped` deletes it (see returnToMapped),
 * so an agent cannot re-run the import after the human approved a different result.
 */
export function recordApproval(
  ctx: WorkspaceContext,
  input: { planId: unknown; stepId: unknown; checkHash: unknown; idempotencyKey: unknown },
): Result {
  const g = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId') ?? reqStr(input.checkHash, 'checkHash') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (g) return g;
  const plan = loadPlan(ctx, input.planId as string);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const step = loadStep(ctx, plan.id, input.stepId);
  if (step === undefined) return err('not_found', { stepId: input.stepId });
  // The approval binds to the step's CURRENT check hash: approving a stale hash is refused, which is
  // what stops an approval outliving the result it was for.
  if (step.last_check_id !== input.checkHash) return err('check_hash_stale', { expected: step.last_check_id, got: input.checkHash });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_record_approval');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_record_approval', () => {
    const id = ctx.ids.next('migappr');
    ctx.store.db
      .prepare(
        `INSERT INTO migration_approval (id, workspace_id, plan_id, step_id, check_hash, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(step_id, check_hash) DO NOTHING`,
      )
      .run(id, ctx.workspaceId, plan.id, step.id, input.checkHash as string, ctx.actor, ctx.clock.now());
    const row = ctx.store.db
      .prepare('SELECT id FROM migration_approval WHERE step_id = ? AND workspace_id = ? AND check_hash = ?')
      .get(step.id, ctx.workspaceId, input.checkHash as string) as { id: string };
    return ok({ approvalId: row.id });
  });
}

// --- rollbackStep (reversing entries, never a delete) -------------------------------------------

/**
 * US-G09.6: reverse a committed step. Posts REVERSING entries via A02 `reverseEntry` for every money
 * effect (never a delete: posted entries are append-only, §H-AUDIT, and five SQLite triggers refuse a
 * delete regardless, D85 §1). The step returns to `mapped` and the approval is voided. After any
 * commit the verb requires `commit_migration` (enforced at the registry boundary); the confirm gate
 * is here.
 */
export function rollbackStep(
  ctx: WorkspaceContext,
  input: { planId: unknown; stepId: unknown; confirmed?: unknown; idempotencyKey: unknown },
): Result {
  const g = reqStr(input.planId, 'planId') ?? reqStr(input.stepId, 'stepId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (g) return g;
  const plan = loadPlan(ctx, input.planId as string);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const step = loadStep(ctx, plan.id, input.stepId);
  if (step === undefined) return err('not_found', { stepId: input.stepId });

  // §H-IDEMPOTENT before the state-dependent guards (the set_opening_balances order): a retry of the
  // same rollback must replay its original result, never meet `step_not_committed` because the first
  // call already returned the step to `mapped`.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_rollback_step');
  if (replayed !== undefined) return replayed;

  if (input.confirmed !== true) return err('needs_confirmation', { stepId: step.id });
  if (!['committed', 'verified', 'diverged'].includes(step.status)) return err('step_not_committed', { state: step.status });

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_rollback_step', () => {
    const reversed: string[] = [];
    const archived: string[] = [];
    const couldNotUndo: string[] = [];
    const counts = step.counts === null ? {} : (JSON.parse(step.counts) as Record<string, unknown>);
    const openingEntryId = counts.openingEntryId as string | undefined;
    if (openingEntryId !== undefined && openingEntryId !== null) {
      const rev = reverseEntry(ctx, { entryId: openingEntryId, idempotencyKey: `migrollback:${step.id}:${input.idempotencyKey}`, description: 'Datenübernahme rückgängig' });
      if (rev.ok) reversed.push((rev as { entryId?: string }).entryId ?? openingEntryId);
      else couldNotUndo.push(openingEntryId);
    }
    // Consumed ids stay consumed and document numbers are not reused: the honest-limit column (spec §2).
    returnToMapped(ctx, step);
    return ok({ reversed, archived, couldNotUndo });
  });
}
