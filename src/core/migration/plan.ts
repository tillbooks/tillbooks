/**
 * G09, the migration harness: the PLAN and its state machine, discovery, scope, and the reads
 * (`getPlan`, `listPlans`, `readiness`). The step verbs live in `steps.ts`; this file owns the plan
 * object every step hangs on.
 *
 * P3 IS THE SPINE (spec §4). G09 NEVER writes a domain row itself. This file writes only migration
 * tables (plan, step, source_file); the moment a class's data reaches the ledger is `steps.ts`
 * routing through the OWNING spec's verb, never a writer of its own. The static no-`postEntry`-import
 * assertion (spec §7) holds by construction here: nothing in this file imports a posting path.
 *
 * §H-TENANT: every query filters on `workspace_id`, and `listPlans` is workspace-scoped like every
 * other read (US-G09.5 boundary). The cross-client Treuhänder roster composes N of these scoped
 * reads over A23's memberships; it is NOT a read that reaches across the fence, and widening this is
 * exactly what §H-TENANT exists against.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { getFileContent, uploadFile } from '../files/files.js';
import { dataClassDef, DATA_CLASS_IDS, isDataClass } from './dataClasses.js';
import { sourceAdapterDef, detectAdapterFromHeaders, SOURCE_ADAPTERS, SOURCE_ADAPTER_IDS } from './adapters/registry.js';
import { parseSource, isParseFailure, isSourceEncoding, SOURCE_ENCODINGS, DELIMITER_NAMES } from './adapters/parse.js';
import type { SourceEncoding } from './adapters/parse.js';
import { unzip, type ZipMember } from './adapters/zip.js';
import { hasPreMigrationBackup } from './seams.js';
import { isCutoverPending } from './stichtag.js';
import { applySavedView } from '../customization/views.js';
import { listVatPeriods } from '../vat/index.js';

// --- §H-ENUM: the closed sets, each single-sourced here (no CHECK in schema.ts, the §D0 convention) ---

/** Plan lifecycle: draft -> planned -> trial -> live -> closed, with `abandoned` from any non-closed. */
export const PLAN_STATES = ['draft', 'planned', 'trial', 'live', 'closed', 'abandoned'] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/**
 * The journey phase a PLAN STATE places the plan at, as a `journey[]` name (see `getPlan`) or `null`
 * when the plan is off the journey. EXHAUSTIVE over `PLAN_STATES` by the Record type, so no plan state
 * can fall through a display mapping to a wrong default (K-30). This is the engine's single source for
 * that placement; a surface may still refine the middle of the journey from the STEP states, but it
 * never has to guess a plan state:
 *   - `trial` is now a real, WRITTEN state (the first `migration_trial_load_step` writes it), so it
 *     places the plan at `'trial'` (Probelauf) instead of being a state nothing could reach.
 *   - `abandoned` maps to `null`: an abandoned plan has LEFT the journey, so a surface renders no phase
 *     for it rather than placing it at a fabricated step (the K-23 "hide the strip" rule, made explicit
 *     here rather than left to each caller to remember).
 */
export const PLAN_PHASE: Readonly<Record<PlanState, string | null>> = {
  draft: 'discover',
  planned: 'map',
  trial: 'trial',
  live: 'golive',
  closed: 'verified',
  abandoned: null,
};

/**
 * Step lifecycle. Every state has an exit (canon blocker 1): `failed`, `rolled_back` and `diverged`
 * all return to `mapped`, and every return to `mapped` VOIDS the recorded approval (canon blocker 6).
 * `skipped` is terminal and is what an excluded class gets; `verified` is the happy terminal.
 */
export const STEP_STATES = [
  'pending',
  'mapped',
  'previewed',
  'trial_loaded',
  'checked',
  'committed',
  'verified',
  'diverged',
  'failed',
  'rolled_back',
  'skipped',
] as const;
export type StepState = (typeof STEP_STATES)[number];

/** A step-row outcome (US-G09.9's classifier). Single source; `migration_step_row.outcome` holds it. */
export const CONFLICT_OUTCOMES = ['created', 'skipped', 'failed', 'conflict'] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOMES)[number];

// --- Row types ----------------------------------------------------------------------------------

export interface PlanRow {
  id: string;
  workspace_id: string;
  status: string;
  source_adapter: string | null;
  locale_pack: string | null;
  data_class: string | null;
  created_at: string;
  source_system: string | null;
  cutover_date: string | null;
  testmandant_workspace_id: string | null;
  created_by: string | null;
  closed_at: string | null;
  backup_ref: string | null;
}

export interface StepRow {
  id: string;
  workspace_id: string;
  plan_id: string;
  data_class: string;
  depth: string | null;
  status: string;
  counts: string | null;
  conflict_resolutions: string | null;
  last_check_id: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Guards -------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

// --- Shared loaders (steps.ts imports these) ----------------------------------------------------

/** The plan row, workspace-scoped, or undefined when it is not this workspace's. §H-TENANT. */
export function loadPlan(ctx: WorkspaceContext, planId: unknown): PlanRow | undefined {
  if (typeof planId !== 'string') return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM migration_plan WHERE id = ? AND workspace_id = ?')
    .get(planId, ctx.workspaceId) as PlanRow | undefined;
}

/** One step of a plan, workspace-scoped. §H-TENANT. */
export function loadStep(ctx: WorkspaceContext, planId: string, stepId: unknown): StepRow | undefined {
  if (typeof stepId !== 'string') return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM migration_step WHERE id = ? AND plan_id = ? AND workspace_id = ?')
    .get(stepId, planId, ctx.workspaceId) as StepRow | undefined;
}

/** Every step of a plan, in creation order. */
export function loadSteps(ctx: WorkspaceContext, planId: string): StepRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM migration_step WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at, id')
    .all(planId, ctx.workspaceId) as StepRow[];
}

/** The source files linked to a plan (US-G09.8), newest first. */
export function loadSourceFiles(ctx: WorkspaceContext, planId: string): Array<Record<string, unknown>> {
  return ctx.store.db
    .prepare('SELECT * FROM migration_source_file WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at')
    .all(planId, ctx.workspaceId) as Array<Record<string, unknown>>;
}

/** Serialise a step for a machine response, with its counts parsed. */
export function stepView(step: StepRow): Record<string, unknown> {
  return {
    stepId: step.id,
    dataClass: step.data_class,
    depth: step.depth,
    state: step.status,
    counts: step.counts === null ? null : (JSON.parse(step.counts) as unknown),
    lastCheckId: step.last_check_id,
    committedAt: step.committed_at,
  };
}

// --- discoverSource -----------------------------------------------------------------------------

/** What one blob classified to: the shape a discovery `files[]` entry carries (minus its `fileId`). */
interface Classification {
  adapter: string;
  dataClasses: string[];
  rowCount: number;
  headers: string[];
  confidence: string;
  asAt: string | null;
  warnings: string[];
  worksheets?: string[];
  worksheet?: string;
}

type ClassifyResult =
  | { ok: true; cls: Classification }
  | { ok: false; reason: string; detectedEncoding?: string | undefined; detectedDelimiter?: string | undefined };

/** The zip magic (`PK`): a real xlsx or a bundle both begin with it, so it only gates the unzip probe. */
function looksZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * THE DISAMBIGUATION FOOTGUN (US-G18.2 vs US-G18.3): an `.xlsx` IS a zip (the Open Packaging
 * Convention), so "has zip magic" is NOT enough to call something a bundle. A zip whose members carry
 * the OOXML markers (`[Content_Types].xml` AND `xl/workbook.xml`) is a workbook and takes the xlsx
 * path; every other zip is an export bundle and is unpacked. This is the single check that keeps a
 * spreadsheet from being torn apart as if it were a folder of files.
 */
function isXlsxPackage(members: readonly ZipMember[]): boolean {
  let hasContentTypes = false;
  let hasWorkbook = false;
  for (const m of members) {
    if (m.name === '[Content_Types].xml') hasContentTypes = true;
    if (m.name === 'xl/workbook.xml') hasWorkbook = true;
  }
  return hasContentTypes && hasWorkbook;
}

/** The member extensions the generic tabular adapters read; everything else is a documents candidate. */
const DATA_MEMBER_EXTENSIONS: ReadonlySet<string> = new Set(['csv', 'tsv', 'txt', 'xml']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function mimeForMember(name: string): string {
  switch (extensionOf(name)) {
    case 'csv':
      return 'text/csv';
    case 'tsv':
    case 'txt':
      return 'text/plain';
    case 'xml':
      return 'application/xml';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pdf':
      return 'application/pdf';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

/** A non-tabular member (a PDF, an image, a nested zip): a `documents`-class candidate, never an error. */
function documentsClassification(warning?: string): Classification {
  return {
    adapter: 'documents',
    dataClasses: ['documents'],
    rowCount: 0,
    headers: [],
    confidence: 'low',
    asAt: null,
    warnings: warning !== undefined ? [warning] : [],
  };
}

/** A forced classification format (K-15): any subset of adapter is chosen by the caller; encoding and
 *  delimiter ride here so the generic reader can be pinned. Every field is optional; an absent field
 *  keeps the auto behaviour, so `undefined`/`{}` is byte-for-byte the historical path. */
interface ForceFormat {
  encoding?: SourceEncoding | undefined;
  delimiter?: string | undefined;
}

/** Parse a blob with one adapter and shape the discovery facts, or report why it could not parse. */
function classifyBytes(
  adapterId: string,
  bytes: Buffer,
  opts?: { sheet?: string | undefined; force?: ForceFormat | undefined; infer?: boolean | undefined },
): ClassifyResult {
  const sheet = opts?.sheet;
  const force = opts?.force;
  // F-09: header inference is on unless the caller pinned the adapter (K-15's forced format).
  const infer = opts?.infer !== false;
  // Build the parse options only when something is actually set, so a plain csv with no sheet and no
  // override reaches `parseSource` with `undefined` opts: the exact byte-for-byte auto path (K-15).
  const parseOpts =
    sheet !== undefined || force?.encoding !== undefined || force?.delimiter !== undefined
      ? {
          ...(sheet !== undefined ? { sheet } : {}),
          ...(force?.encoding !== undefined ? { encoding: force.encoding } : {}),
          ...(force?.delimiter !== undefined ? { delimiter: force.delimiter } : {}),
        }
      : undefined;
  const parsed = parseSource(adapterId, bytes, undefined, parseOpts);
  if (isParseFailure(parsed)) {
    return { ok: false, reason: parsed.reason, detectedEncoding: parsed.detectedEncoding, detectedDelimiter: parsed.detectedDelimiter };
  }
  // F-09 (J1.4 ideal step 3): a header line that IS a vendor export is classified as that vendor,
  // with the one data class the export carries, so the source list says "bexio (CSV)" and scope
  // defaults to Eröffnungssaldi instead of asking the operator to pick from nine classes. Only the
  // generic tabular path infers (a forced or plan-pinned vendor adapter is the operator's word and
  // stands; a vendor adapter then still narrows to the matching class). No match keeps the historical
  // classification byte for byte.
  const detected = infer ? detectAdapterFromHeaders(parsed.headers) : null;
  const inferredAdapter = adapterId === 'csv' && detected !== null ? detected.adapter : adapterId;
  const adapter = sourceAdapterDef(inferredAdapter);
  const narrowedClasses =
    detected !== null && detected.adapter === inferredAdapter && adapter?.dataClasses.includes(detected.dataClass)
      ? [detected.dataClass]
      : adapter
        ? [...adapter.dataClasses]
        : [];
  const cls: Classification = {
    adapter: inferredAdapter,
    dataClasses: narrowedClasses,
    rowCount: parsed.rows.length,
    headers: [...parsed.headers],
    confidence: adapter && adapter.columnPresets.length > 0 ? 'high' : 'low',
    // US-G09.1 boundary: a format carrying no as-of date returns null, never a guess; G11's
    // source_as_at control then reports not_computable with the file named.
    asAt: parsed.asAt,
    warnings: [...parsed.warnings],
  };
  // US-G18.2: a workbook reports its worksheet catalog (+ which sheet these rows came from) so the
  // Studio worksheet picker has data; a tabular parse carries neither field.
  if (parsed.worksheets !== undefined) cls.worksheets = [...parsed.worksheets];
  if (parsed.worksheet !== undefined) cls.worksheet = parsed.worksheet;
  return { ok: true, cls };
}

/**
 * Classify ONE bundle member exactly as if it were uploaded alone, but WITHOUT recursing into a
 * nested zip (US-G18.3 boundary: a nested `.zip` member is listed as a documents candidate, never
 * unpacked). An xlsx member still surfaces its worksheets; a data-extension member is parsed; a PDF
 * or image is a documents candidate.
 */
function classifyMember(plan: PlanRow | undefined, bytes: Buffer, name: string, sheet?: string, force?: ForceFormat): ClassifyResult {
  if (looksZip(bytes)) {
    const inner = unzip(bytes);
    if (inner.ok) {
      if (isXlsxPackage(inner.members)) return classifyBytes('xlsx', bytes, { sheet });
      // A nested zip is listed, one level only, never recursed.
      return { ok: true, cls: documentsClassification('nested_zip_not_recursed') };
    }
  }
  if (DATA_MEMBER_EXTENSIONS.has(extensionOf(name))) {
    return classifyBytes((plan?.source_adapter as string | undefined) ?? 'csv', bytes, { sheet, force });
  }
  return { ok: true, cls: documentsClassification() };
}

/** Link a classified (or member) file to the plan as a Beleg (US-G09.8), once per file. §H-TENANT. */
function linkFileToPlan(
  ctx: WorkspaceContext,
  plan: PlanRow,
  fileId: string,
  adapterId: string,
  sha256: string,
  asAt: string | null,
  dataClasses: readonly string[],
): void {
  const already = ctx.store.db
    .prepare('SELECT id FROM migration_source_file WHERE plan_id = ? AND workspace_id = ? AND file_id = ?')
    .get(plan.id, ctx.workspaceId, fileId) as { id: string } | undefined;
  if (already !== undefined) return;
  ctx.store.db
    .prepare(
      `INSERT INTO migration_source_file
         (id, workspace_id, plan_id, file_id, adapter, sha256, as_at, data_classes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('migsrc'), ctx.workspaceId, plan.id, fileId, adapterId, sha256, asAt, JSON.stringify([...dataClasses]), ctx.clock.now());
}

/**
 * US-G09.1: read each uploaded blob back through E00, hand the bytes to the pure adapter registry,
 * and report what is in them plus how current they are. Zero domain rows are written anywhere. A file
 * no adapter can parse is returned in `failures[]` for THAT file only; the others are still classified.
 * When `planId` is given, each classified file is linked to the plan as a Beleg (US-G09.8).
 *
 * G18 wires the two container formats end to end:
 *   - US-G18.2 (xlsx): an `.xlsx` blob is detected (a zip carrying the OOXML markers), parsed through
 *     the xlsx adapter, and its `worksheets`/`worksheet` surfaced so the Studio picker has data. A
 *     per-file worksheet choice arrives on `input.sheets` (fileId -> sheet name) and re-parses.
 *   - US-G18.3 (zip bundle): a non-workbook zip is unpacked into member blobs, each REGISTERED back
 *     through E00 (tagged to the bundle) and classified exactly as if uploaded alone. The bundle
 *     renders as a group: its entry carries `members[]`. A member that failed to inflate is a
 *     per-member `source_unparseable`; the rest still classify. Nested zips are listed, not recursed.
 */
export function discoverSource(
  ctx: WorkspaceContext,
  input: {
    fileIds: unknown;
    planId?: string;
    idempotencyKey?: string;
    sheets?: Record<string, string>;
    // K-15: force the classification format instead of auto-detecting it, for when the sniffer got the
    // adapter, text encoding or delimiter wrong. Every field is optional; an absent field (or an absent
    // `override`) keeps the auto behaviour unchanged.
    override?: { adapter?: unknown; encoding?: unknown; delimiter?: unknown };
  },
): Result {
  if (!Array.isArray(input.fileIds) || input.fileIds.length === 0) {
    return err('invalid_input', { field: 'fileIds', reason: 'at least one fileId' });
  }
  const plan = input.planId === undefined ? undefined : loadPlan(ctx, input.planId);
  if (input.planId !== undefined && plan === undefined) return err('not_found', { planId: input.planId });

  // K-15: validate the override up front, so a garbage value is a structured refusal naming the field
  // (P9) and never a silent wrong parse. Each field is validated against the engine's own single-source
  // vocab (the adapter registry ids, the encoding set, the delimiter names): the verb never guesses.
  const override =
    input.override !== null && typeof input.override === 'object' && !Array.isArray(input.override)
      ? (input.override as { adapter?: unknown; encoding?: unknown; delimiter?: unknown })
      : undefined;
  let forcedAdapter: string | undefined;
  let forcedEncoding: SourceEncoding | undefined;
  let forcedDelimiter: string | undefined;
  if (override !== undefined) {
    if (override.adapter !== undefined) {
      if (typeof override.adapter !== 'string' || !SOURCE_ADAPTER_IDS.includes(override.adapter)) {
        return err('invalid_input', { field: 'override.adapter', known: [...SOURCE_ADAPTER_IDS] });
      }
      forcedAdapter = override.adapter;
    }
    if (override.encoding !== undefined) {
      if (!isSourceEncoding(override.encoding)) {
        return err('invalid_input', { field: 'override.encoding', known: [...SOURCE_ENCODINGS] });
      }
      forcedEncoding = override.encoding;
    }
    if (override.delimiter !== undefined) {
      if (typeof override.delimiter !== 'string' || !DELIMITER_NAMES.includes(override.delimiter)) {
        return err('invalid_input', { field: 'override.delimiter', known: [...DELIMITER_NAMES] });
      }
      forcedDelimiter = override.delimiter;
    }
  }
  const force: ForceFormat = { encoding: forcedEncoding, delimiter: forcedDelimiter };

  const sheetChoice: Record<string, string> =
    input.sheets !== null && typeof input.sheets === 'object' && !Array.isArray(input.sheets) ? (input.sheets as Record<string, string>) : {};

  const files: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];

  for (const fileId of input.fileIds) {
    if (typeof fileId !== 'string') {
      failures.push({ fileId, error: 'invalid_input', reason: 'fileId must be a string' });
      continue;
    }
    // §H-TENANT: getFileContent reads workspace-scoped, so a foreign fileId is not_found here and
    // never reaches the parser, the E00 registration or the plan link.
    const content = getFileContent(ctx, { fileId });
    if (!content.ok) {
      failures.push({ fileId, error: 'source_integrity_mismatch', reason: (content as { error?: string }).error });
      continue;
    }
    const bytes = Buffer.from(content.contentBase64 as string, 'base64');

    // K-15: a FORCED adapter bypasses container auto-detection and classifies the file directly under
    // the chosen format (respecting a forced encoding/delimiter). This is the "the sniffer got the
    // format wrong, pin it" path: an operator's explicit adapter choice wins over what the bytes look
    // like. A forced adapter the file cannot parse is a structured per-file source_unparseable, never a
    // throw. Encoding/delimiter WITHOUT a forced adapter do not take this branch: they only refine the
    // generic tabular parse below, so the container disambiguation stays intact for them.
    if (forcedAdapter !== undefined) {
      const result = classifyBytes(forcedAdapter, bytes, { sheet: sheetChoice[fileId], force, infer: false });
      if (!result.ok) {
        failures.push({ fileId, error: 'source_unparseable', reason: result.reason, detectedEncoding: result.detectedEncoding, detectedDelimiter: result.detectedDelimiter });
        continue;
      }
      files.push({ fileId, ...result.cls });
      if (plan !== undefined) linkFileToPlan(ctx, plan, fileId, forcedAdapter, content.sha256 as string, result.cls.asAt, result.cls.dataClasses);
      continue;
    }

    // Container disambiguation. A zip that is a workbook takes the xlsx path; a non-workbook zip is a
    // bundle; everything else (and a zip we cannot read) is the generic tabular path, unchanged.
    if (looksZip(bytes)) {
      const zip = unzip(bytes);
      if (zip.ok && isXlsxPackage(zip.members)) {
        const result = classifyBytes('xlsx', bytes, { sheet: sheetChoice[fileId] });
        if (!result.ok) {
          failures.push({ fileId, error: 'source_unparseable', reason: result.reason });
          continue;
        }
        files.push({ fileId, ...result.cls });
        if (plan !== undefined) linkFileToPlan(ctx, plan, fileId, 'xlsx', content.sha256 as string, result.cls.asAt, result.cls.dataClasses);
        continue;
      }
      if (zip.ok) {
        // A bundle. Unpack each member, register it back through E00 tagged to the bundle, classify it.
        const memberEntries: Array<Record<string, unknown>> = [];
        for (const m of zip.members) {
          if (m.bytes === undefined) {
            // A member that failed to inflate (or exceeded the zip-bomb ceiling): unparseable, alone.
            failures.push({ fileId, member: m.name, error: 'source_unparseable', reason: m.error ?? 'corrupt' });
            continue;
          }
          const up = uploadFile(ctx, {
            contentBase64: Buffer.from(m.bytes).toString('base64'),
            filename: m.name,
            mime: mimeForMember(m.name),
            tags: ['migration_bundle_member', fileId],
            idempotencyKey: `migbundle-${fileId}-${m.name}`,
          });
          if (!up.ok) {
            failures.push({ fileId, member: m.name, error: 'source_unparseable', reason: (up as { error?: string }).error });
            continue;
          }
          const memberFile = up.file as { id: string; sha256: string };
          const cls = classifyMember(plan, Buffer.from(m.bytes), m.name, sheetChoice[memberFile.id], force);
          if (!cls.ok) {
            failures.push({ fileId: memberFile.id, member: m.name, error: 'source_unparseable', reason: cls.reason });
            continue;
          }
          if (plan !== undefined) linkFileToPlan(ctx, plan, memberFile.id, cls.cls.adapter, memberFile.sha256, cls.cls.asAt, cls.cls.dataClasses);
          memberEntries.push({ fileId: memberFile.id, filename: m.name, ...cls.cls });
        }
        // The bundle's own entry offers the UNION of member classes to scope, and lists its members
        // so the source list renders it as a group (US-G18.3 GUI boundary).
        const union = new Set<string>();
        for (const e of memberEntries) for (const c of e.dataClasses as string[]) union.add(c);
        files.push({
          fileId,
          adapter: 'bundle',
          dataClasses: [...union],
          rowCount: 0,
          headers: [],
          confidence: 'low',
          asAt: null,
          warnings: [],
          members: memberEntries,
        });
        continue;
      }
      // PK magic but not a readable zip: fall through to the tabular path (a truncated or odd file).
    }

    // The generic adapter reads any tabular export; a vendor adapter is chosen on demand (spec §4). A
    // forced encoding/delimiter (K-15) with no forced adapter refines THIS parse; both are undefined
    // when no override is given, so this stays byte-for-byte the historical auto path.
    const adapterId = (plan?.source_adapter as string | undefined) ?? 'csv';
    const result = classifyBytes(adapterId, bytes, { sheet: sheetChoice[fileId], force });
    if (!result.ok) {
      failures.push({
        fileId,
        error: 'source_unparseable',
        reason: result.reason,
        detectedEncoding: result.detectedEncoding,
        detectedDelimiter: result.detectedDelimiter,
      });
      continue;
    }
    files.push({ fileId, ...result.cls });
    // Linked under the adapter the file CLASSIFIED to (F-09: a bexio-shaped header is bexio), not the
    // adapter the parse was requested with.
    if (plan !== undefined) linkFileToPlan(ctx, plan, fileId, result.cls.adapter, content.sha256 as string, result.cls.asAt, result.cls.dataClasses);
  }

  return ok({ files, failures });
}

// --- createPlan ---------------------------------------------------------------------------------

export function createPlan(
  ctx: WorkspaceContext,
  input: { sourceSystem: unknown; cutoverDate: unknown; localePack?: unknown; idempotencyKey: unknown },
): Result {
  const guard =
    reqStr(input.sourceSystem, 'sourceSystem') ??
    reqStr(input.cutoverDate, 'cutoverDate') ??
    reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!ISO_DATE.test(input.cutoverDate as string)) return err('invalid_input', { field: 'cutoverDate' });
  // F-09 (2026-09-06, friction ledger J1.4 ideal step 4): a FUTURE Übernahmestichtag is accepted here.
  // A cutover is prepared BEFORE its date (the owner's own go-live is 01.10.2026, prepared through
  // September): scope, map, preview, trial load into the Testmandant and the Eröffnungsprüfung are
  // all rehearsal, and none of them writes the live books. What waits for the date is the COMMIT:
  // `commitStep` and `goProductive` refuse `cutover_in_future` until the Stichtag has arrived, and
  // `readiness` names that wait as a blocking item (`cutover_pending`). This verb used to refuse the
  // future date outright, which made the 20-minute migration budget (D-K) unreachable by construction.

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_create_plan');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_create_plan', () => {
    const id = ctx.ids.next('migplan');
    const now = ctx.clock.now();
    const localePack = typeof input.localePack === 'string' ? input.localePack : null;
    // The source adapter defaults to the generic one; discovery or the map layer may set a vendor id.
    const sourceAdapter = SOURCE_ADAPTERS.some((a) => a.id === input.sourceSystem) ? (input.sourceSystem as string) : 'csv';
    ctx.store.db
      .prepare(
        `INSERT INTO migration_plan
           (id, workspace_id, status, source_adapter, locale_pack, data_class, created_at,
            source_system, cutover_date, testmandant_workspace_id, created_by, closed_at)
         VALUES (?, ?, 'draft', ?, ?, NULL, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(id, ctx.workspaceId, sourceAdapter, localePack, now, input.sourceSystem as string, input.cutoverDate as string, ctx.actor);
    return ok({ planId: id });
  });
}

// --- setScope -----------------------------------------------------------------------------------

interface ScopeClassInput {
  dataClass: string;
  include?: boolean;
  depth?: string;
}

export function setScope(
  ctx: WorkspaceContext,
  input: { planId: unknown; classes: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!Array.isArray(input.classes)) return err('invalid_input', { field: 'classes' });
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_set_scope');
  if (replayed !== undefined) return replayed;

  // Validate before writing anything: one unknown class rejects the whole scope (P9, atomic).
  for (const raw of input.classes as ScopeClassInput[]) {
    if (!isDataClass(raw?.dataClass)) {
      return err('unknown_data_class', { dataClass: raw?.dataClass, known: [...DATA_CLASS_IDS] });
    }
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_set_scope', () => {
    const now = ctx.clock.now();
    const unavailable: Array<Record<string, unknown>> = [];
    const defaultsApplied: Array<Record<string, unknown>> = [];

    for (const raw of input.classes as ScopeClassInput[]) {
      const def = dataClassDef(raw.dataClass)!;
      const include = raw.include !== false;
      const existing = ctx.store.db
        .prepare('SELECT id FROM migration_step WHERE plan_id = ? AND workspace_id = ? AND data_class = ?')
        .get(plan.id, ctx.workspaceId, def.dataClass) as { id: string } | undefined;

      if (!include) {
        // Excluding removes the step entirely; it can never import by accident (US-G09.2 boundary).
        if (existing !== undefined) {
          ctx.store.db.prepare('DELETE FROM migration_step WHERE id = ? AND workspace_id = ?').run(existing.id, ctx.workspaceId);
        }
        continue;
      }
      if (!def.firstScope) {
        // A class outside first scope is named with its owner, never silently absent (US-G09.2).
        unavailable.push({ dataClass: def.dataClass, owner: def.owner, reason: 'not_in_first_scope' });
        continue;
      }
      if (existing !== undefined) continue;
      // A scoped class lands its step at `mapped`: the default map comes from discovery (spec §6),
      // so the common case is one confirmation. G10's `migration_set_map` refines it; the pending
      // state is the transient pre-map moment the machine still defines.
      ctx.store.db
        .prepare(
          `INSERT INTO migration_step
             (id, workspace_id, plan_id, data_class, depth, status, counts, conflict_resolutions,
              last_check_id, committed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'mapped', NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(ctx.ids.next('migstep'), ctx.workspaceId, plan.id, def.dataClass, raw.depth ?? null, now, now);
      defaultsApplied.push({ dataClass: def.dataClass, depth: raw.depth ?? 'default' });
    }

    // The plan advances draft -> planned once it has a scope (the state condition 6 measures against).
    if (plan.status === 'draft') {
      ctx.store.db.prepare('UPDATE migration_plan SET status = ? WHERE id = ? AND workspace_id = ?').run('planned', plan.id, ctx.workspaceId);
    }

    const steps = loadSteps(ctx, plan.id).map(stepView);
    return ok({ steps, unavailable, defaultsApplied });
  });
}

// --- getPlan ------------------------------------------------------------------------------------

/**
 * US-G09.2/US-G09.3: the plan, every step with its state, and `nextAction`, the resume answer and the
 * plan surface's single primary action. `nextAction` names the FIRST step not in a terminal state and
 * the one verb that advances it, so resume is a read and never a re-run of prior steps.
 */
export function getPlan(ctx: WorkspaceContext, input: { planId: unknown; savedViewId?: unknown; dataClass?: unknown; state?: unknown }): Result {
  if (typeof input.planId !== 'string') return err('invalid_input', { field: 'planId' });
  if (input.savedViewId !== undefined && typeof input.savedViewId !== 'string') {
    return err('invalid_input', { field: 'savedViewId' });
  }
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const allSteps = loadSteps(ctx, plan.id);
  const nextAction = computeNextAction(allSteps);
  const journey = ['discover', 'map', 'trial', 'check', 'golive', 'verified'];

  // The G00 saved-view seam over the STEP LIST (spec §6b: "Fehlgeschlagene Schritte"): a stored
  // dataClass/state filter applies when only savedViewId is named; an explicit filter wins. The
  // journey and nextAction are computed over the WHOLE plan, never the filtered view.
  const viewed = applySavedView(ctx, 'migration_step', { savedViewId: input.savedViewId as string | undefined, dataClass: input.dataClass, state: input.state });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { dataClass?: unknown; state?: unknown };
  const steps = allSteps.filter(
    (s) => (f.dataClass === undefined || s.data_class === f.dataClass) && (f.state === undefined || s.status === f.state),
  );

  return ok({
    plan: planView(ctx, plan),
    steps: steps.map(stepView),
    nextAction,
    journey,
  });
}

function planView(ctx: WorkspaceContext, plan: PlanRow): Record<string, unknown> {
  return {
    planId: plan.id,
    state: plan.status,
    // F-09: true while the Stichtag is still ahead. The Studio renders "vorbereitet, Stichtag ..." and
    // disables the promotion with the reason ON the control; an agent reads it before trying a commit.
    cutoverPending: isCutoverPending(ctx, plan),
    // K-30: the journey phase this plan state sits at, exhaustively (`abandoned` -> null, off the
    // journey), so no consumer has to re-derive it or let a state fall through a default.
    planPhase: PLAN_PHASE[plan.status as PlanState] ?? null,
    sourceSystem: plan.source_system,
    sourceAdapter: plan.source_adapter,
    localePack: plan.locale_pack,
    cutoverDate: plan.cutover_date,
    testmandantWorkspaceId: plan.testmandant_workspace_id,
    createdBy: plan.created_by,
    createdAt: plan.created_at,
    closedAt: plan.closed_at,
  };
}

const TERMINAL_STEP_STATES: ReadonlySet<string> = new Set(['verified', 'skipped']);
/** The verb that advances a step from each non-terminal state (§6: one action per step row). */
const ADVANCE_VERB: Readonly<Record<string, string>> = {
  pending: 'migration_set_map',
  mapped: 'migration_preview_step',
  previewed: 'migration_trial_load_step',
  trial_loaded: 'migration_commit_step',
  checked: 'migration_commit_step',
  committed: 'migration_readiness',
  failed: 'migration_preview_step',
  rolled_back: 'migration_preview_step',
  diverged: 'migration_rollback_step',
};

function computeNextAction(steps: readonly StepRow[]): Record<string, unknown> | null {
  const open = steps.find((s) => !TERMINAL_STEP_STATES.has(s.status));
  if (open === undefined) return null;
  return { stepId: open.id, dataClass: open.data_class, state: open.status, verb: ADVANCE_VERB[open.status] ?? 'migration_get_plan' };
}

// --- listPlans (workspace-scoped, §H-TENANT) ----------------------------------------------------

export function listPlans(ctx: WorkspaceContext, input: { status?: unknown; savedViewId?: unknown }): Result {
  if (input.savedViewId !== undefined && typeof input.savedViewId !== 'string') {
    return err('invalid_input', { field: 'savedViewId' });
  }
  // The G00 saved-view seam (F5 pattern), one unconditional call like every other list verb: a
  // stored roster filter (e.g. "Offene Freigaben", spec §6b) applies when only savedViewId is named,
  // and an explicit status in the request wins over the stored one.
  const viewed = applySavedView(ctx, 'migration_plan', { savedViewId: input.savedViewId as string | undefined, status: input.status });
  if (!viewed.ok) return viewed;
  const status = (viewed.filter as { status?: unknown }).status;
  const rows =
    typeof status === 'string'
      ? (ctx.store.db
          .prepare('SELECT * FROM migration_plan WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC')
          .all(ctx.workspaceId, status) as PlanRow[])
      : (ctx.store.db
          .prepare('SELECT * FROM migration_plan WHERE workspace_id = ? ORDER BY created_at DESC')
          .all(ctx.workspaceId) as PlanRow[]);
  return ok({ plans: rows.map((row) => planView(ctx, row)) });
}

// --- readiness ----------------------------------------------------------------------------------

/**
 * The actor who must move an open step (R3): a human judgment is `du`, an agent-safe advance is
 * `ein Agent`, a step the system carries after commit is `das System`. Derived from the step's state
 * and whether its class is money-path (a money-path step waiting on the human approval is `du`),
 * never a stub. The three values match the `migration.readiness.owner.{you,agent,system}` i18n keys.
 */
function readinessOwner(step: StepRow): 'du' | 'ein Agent' | 'das System' {
  const def = dataClassDef(step.data_class);
  if (step.status === 'diverged') return 'du'; // a divergence is a human reconciliation
  if (step.status === 'pending') return 'du'; // an unmapped step needs a human to map it
  if (step.status === 'committed') return 'das System'; // the system verifies a committed step
  if (def?.moneyPath === true && (step.status === 'trial_loaded' || step.status === 'checked')) return 'du';
  // mapped, previewed, failed, rolled_back, and non-money trial_loaded/checked: an agent may advance.
  return 'ein Agent';
}

/** The ISO day one day before `day` (YYYY-MM-DD), for the pre-Stichtag half of a straddled period. */
function priorDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface VatPeriodView {
  label: string;
  periodStart: string;
  periodEnd: string;
  months: string[];
  filed: boolean;
}

/**
 * US-G09.7: the go-live checklist. Every included step with its state, the backup precondition, and,
 * for each open item, WHO must move it (du / ein Agent / das System). Ready means every included step
 * is `verified` and no control is failed or not_asserted. A plan with no steps returns ready:false
 * with one blocking item, never an empty list that reads as ready.
 *
 * R3 (G18) makes three formerly-stubbed fields real: the per-item `owner` is derived from the step,
 * `waivers` surfaces every waived G11 control so "bereit, mit N Ausnahmen" can render, and
 * `vat_period_straddled` warns (never blocks) when the Übernahmestichtag falls inside a VAT period.
 */
export function readiness(ctx: WorkspaceContext, input: { planId: unknown }): Result {
  if (typeof input.planId !== 'string') return err('invalid_input', { field: 'planId' });
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const steps = loadSteps(ctx, plan.id);

  const blocking: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const waivers: Array<Record<string, unknown>> = [];

  if (steps.length === 0) {
    blocking.push({ item: 'scope_empty', owner: 'du', reason: 'Es ist noch nichts im Umfang' });
  }

  // F-09: a plan prepared ahead of its Stichtag is blocked by the calendar, not by a person. The
  // item names the date; the owner is the system, because nobody can move it. `commitStep` and
  // `goProductive` refuse `cutover_in_future` for the same reason until the date arrives.
  if (isCutoverPending(ctx, plan)) {
    blocking.push({
      item: 'cutover_pending',
      owner: 'das System',
      cutoverDate: plan.cutover_date,
      reason: 'Der Übernahmestichtag ist noch nicht erreicht',
    });
  }

  for (const step of steps) {
    if (!TERMINAL_STEP_STATES.has(step.status)) {
      blocking.push({ item: step.data_class, step: step.id, state: step.status, owner: readinessOwner(step), reason: `Schritt ist ${step.status}` });
    }
    if (step.status === 'diverged') {
      blocking.push({ item: step.data_class, step: step.id, state: 'diverged', owner: 'du', reason: 'Die Prüfung nach der Übernahme weicht vom Probelauf ab' });
    }
  }

  // R3: surface every WAIVED G11 control (US-G11.5), so a plan that is otherwise ready renders
  // "bereit, mit N Ausnahmen" rather than a plain ready. A waiver is a recorded human judgment
  // (who + why); making it visible here is the safety, so it is never silently carried into go-live.
  const waivedRows = ctx.store.db
    .prepare(
      "SELECT step_id, kind, scope, waiver_reason, waived_by FROM migration_control_total WHERE workspace_id = ? AND plan_id = ? AND status = 'waived'",
    )
    .all(ctx.workspaceId, plan.id) as Array<{ step_id: string; kind: string; scope: string; waiver_reason: string | null; waived_by: string | null }>;
  for (const w of waivedRows) {
    waivers.push({ step: w.step_id, control: w.kind, scope: w.scope, reason: w.waiver_reason, waivedBy: w.waived_by, owner: 'du' });
  }

  // R3: vat_period_straddled (US-G09.7, warned never blocked). When the Stichtag falls inside a VAT
  // period rather than on its boundary, that period is split between the old system (up to the day
  // before the Stichtag) and TILL (from the Stichtag). Both ranges are returned. Computed only when a
  // VAT method is configured; an unconfigured workspace simply has no straddle to warn about.
  const stichtag = plan.cutover_date;
  if (typeof stichtag === 'string' && ISO_DATE.test(stichtag)) {
    const listed = listVatPeriods(ctx, { year: stichtag.slice(0, 4) });
    if (listed.ok) {
      const stichtagMonth = stichtag.slice(0, 7);
      const period = ((listed as unknown as { periods: VatPeriodView[] }).periods ?? []).find((p) => p.months.includes(stichtagMonth));
      if (period !== undefined && period.periodStart !== stichtag) {
        warnings.push({
          item: 'vat_period_straddled',
          period: period.label,
          oldSystemRange: { from: period.periodStart, to: priorDay(stichtag) },
          tillRange: { from: stichtag, to: period.periodEnd },
          reason: 'Der Übernahmestichtag liegt mitten in einer MWST-Periode',
        });
      }
    }
  }

  // G19: the export manifest is a readiness INPUT, never a gate leg. An incomplete manifest is a
  // warning naming the open items, and a deletion clock within 14 days (or past) is a warning naming
  // the date (US-G19.3). Warnings, not blocks: the operator may know better and the six commit
  // conditions are untouched. Read raw here (no import into G19's manifest module) so this file stays
  // acyclic. A plan with no manifest simply has no extraction warning to add.
  const manifestRow = ctx.store.db
    .prepare('SELECT source_access_until, items FROM migration_extraction_manifest WHERE plan_id = ? AND workspace_id = ?')
    .get(plan.id, ctx.workspaceId) as { source_access_until: string | null; items: string } | undefined;
  if (manifestRow !== undefined) {
    const manifestItems = JSON.parse(manifestRow.items) as Array<{ itemId: string; status: string }>;
    const openItems = manifestItems.filter((i) => i.status === 'open' || i.status === 'blocked').map((i) => i.itemId);
    if (openItems.length > 0) {
      warnings.push({
        item: 'extraction_incomplete',
        openItems,
        owner: 'du',
        reason: 'Die Exportliste ist noch nicht vollständig',
      });
    }
    if (manifestRow.source_access_until !== null && ISO_DATE.test(manifestRow.source_access_until)) {
      const today = ctx.clock.now().slice(0, 10);
      const daysRemaining = Math.round(
        (Date.parse(`${manifestRow.source_access_until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
      );
      if (daysRemaining <= 14) {
        warnings.push({
          item: 'source_access_expiring',
          sourceAccessUntil: manifestRow.source_access_until,
          daysRemaining,
          owner: 'du',
          reason: 'Der Zugriff auf das alte System läuft bald ab',
        });
      }
    }
  }

  // Condition 6, surfaced as a blocking item until a G04 create_backup is on record (// INTEGRATION-SEAM(G04)).
  const moneyStepExists = steps.some((s) => dataClassDef(s.data_class)?.moneyPath === true);
  const backupOnRecord = hasPreMigrationBackup(plan);
  if (moneyStepExists && !backupOnRecord) {
    blocking.push({ item: 'backup_required', owner: 'du', reason: 'Vor der ersten Übernahme in die echten Bücher braucht es eine Sicherung' });
  }

  // "Never plain ready": a plan clear of blockers but carrying waivers is ready WITH exceptions.
  const ready = blocking.length === 0;
  return ok({ ready, readyWithWaivers: ready && waivers.length > 0, blocking, warnings, waivers, backupOnRecord });
}

// --- abandonPlan --------------------------------------------------------------------------------

/**
 * US-G09.6: close the plan and discard its Testmandant. Belege for any step that reached `live` are
 * RETAINED (OR 958f), so abandoning never deletes the evidence of what was committed. After any
 * commit this verb additionally requires `commit_migration` (enforced at the registry boundary,
 * US-G09.4); the confirm gate is here.
 */
export function abandonPlan(
  ctx: WorkspaceContext,
  input: { planId: unknown; confirmed?: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  if (input.confirmed !== true) return err('needs_confirmation', { planId: plan.id });
  if (plan.status === 'closed') return err('plan_closed', { planId: plan.id });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_abandon_plan');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_abandon_plan', () => {
    const belegeRetained = loadSourceFiles(ctx, plan.id).map((f) => f.file_id as string);
    ctx.store.db
      .prepare("UPDATE migration_plan SET status = 'abandoned', closed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(ctx.clock.now(), plan.id, ctx.workspaceId);
    return ok({ ok: true, testmandantDiscarded: plan.testmandant_workspace_id !== null, belegeRetained });
  });
}

// --- closePlan (R4, US-G18.6) -------------------------------------------------------------------

/**
 * R4 (US-G18.6): close a finished Datenübernahme, moving `live -> closed` (the state the machine
 * declared but nothing could reach). A close is the human judgment that the übernahme is DONE, which
 * is why it is denylisted from automation (G01) and needs a confirmation. It is legal only from
 * `live` (the books went productive) and refuses, naming the first blocker (P9), while any step is
 * non-terminal or any G11 control is `failed`. Idempotent on its key; a re-close of an already-closed
 * plan is a no-op. Closing writes no domain row and delegates no posting: it stamps the plan only.
 * G20 calls this when a project's stabilisation phase exits; it also stands alone for plan-only use.
 */
export function closePlan(
  ctx: WorkspaceContext,
  input: { planId: unknown; confirmed?: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.planId, 'planId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });

  // §H-IDEMPOTENT before the state guards: a retry of a completed close replays its result even
  // though the plan is now `closed` (the set_opening_balances order).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'migration_close_plan');
  if (replayed !== undefined) return replayed;
  if (plan.status === 'closed') return ok({ ok: true, planId: plan.id, state: 'closed', alreadyClosed: true });

  if (input.confirmed !== true) return err('needs_confirmation', { planId: plan.id });
  // Closing a plan that has moved the live books is commit-family work (US-G18.6 permission split).
  const cap = ctx.capabilities.assert('commit_migration');
  if (!cap.ok) return cap;
  // Legal only from `live`: an übernahme is finished only once its books went productive.
  if (plan.status !== 'live') return err('plan_not_live', { state: plan.status });

  // A non-terminal step blocks the close, named (P9): a plan is not finished while a step is open.
  const openStep = loadSteps(ctx, plan.id).find((s) => !TERMINAL_STEP_STATES.has(s.status));
  if (openStep !== undefined) {
    return err('step_not_terminal', { step: openStep.id, dataClass: openStep.data_class, state: openStep.status });
  }
  // A failed G11 control blocks the close, named (P9): a failed opening check is not something a
  // close may paper over. A waived control does NOT block (it is a recorded, surfaced judgment).
  const failed = ctx.store.db
    .prepare("SELECT step_id, kind, scope FROM migration_control_total WHERE workspace_id = ? AND plan_id = ? AND status = 'failed' LIMIT 1")
    .get(ctx.workspaceId, plan.id) as { step_id: string; kind: string; scope: string } | undefined;
  if (failed !== undefined) {
    return err('control_failed', { step: failed.step_id, control: failed.kind, scope: failed.scope });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'migration_close_plan', () => {
    ctx.store.db
      .prepare("UPDATE migration_plan SET status = 'closed', closed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(ctx.clock.now(), plan.id, ctx.workspaceId);
    return ok({ ok: true, planId: plan.id, state: 'closed' });
  });
}
