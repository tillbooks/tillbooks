/**
 * G19, the EXTRACTION COMPANION core: the guide reads and the export-completeness manifest.
 *
 * P1 (pure verbs), P9 (structured refusals), P11 (locale-neutral machine responses). This file NEVER
 * touches an amount: declared row counts and date ranges are integers and ISO dates, compared by
 * G11's existing controls, and no figure is computed here (spec §4 "money correctness").
 *
 * TWO KINDS OF READ, deliberately different. The guide reads (`listExtractionGuides`,
 * `getExtractionGuide`) describe the SOFTWARE (shipped guide data) and carry no workspace: they are
 * registered as `depsAction`s and are ungated (the `migration_list_source_adapters` precedent). The
 * manifest reads and writes are workspace data (one row per plan, §H-TENANT) and gate on
 * `manage_import` like every other migration verb.
 *
 * THE CORE STORES NO CREDENTIAL, COOKIE OR SESSION STATE, EVER (spec §3): the manifest links E00
 * fileIds and nothing else. The browser companion is a separate optional package the core knows
 * nothing about except that files arrive in E00.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { loadPlan } from './plan.js';
import { applySavedView } from '../customization/views.js';
import {
  EXTRACTION_GUIDES,
  EXTRACTION_GUIDE_IDS,
  resolveGuide,
  extractionGuideDef,
  guideHasCompanion,
} from './guides/registry.js';
import type { ExtractionGuide } from './guides/types.js';

// --- §H-ENUM: the manifest item status, single-sourced here (no CHECK in schema, the §D0 convention) ---

/** A manifest item's status. `not_used` is excluded from the completeness denominator (US-G19.1). */
export const MANIFEST_ITEM_STATUSES = ['open', 'exported', 'not_used', 'blocked'] as const;
export type ManifestItemStatus = (typeof MANIFEST_ITEM_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(MANIFEST_ITEM_STATUSES);
export function isManifestItemStatus(value: unknown): value is ManifestItemStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One manifest item entry, stored in the row's `items` JSON (§H-AUDIT stamp on every write). */
export interface ManifestItemEntry {
  itemId: string;
  status: ManifestItemStatus;
  fileIds: string[];
  rowCount?: number;
  dateFrom?: string;
  dateTo?: string;
  note?: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface ManifestRow {
  id: string;
  workspace_id: string;
  plan_id: string;
  source_system: string;
  source_access_until: string | null;
  items: string;
  created_at: string;
  updated_at: string;
}

function loadManifest(ctx: WorkspaceContext, planId: string): ManifestRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM migration_extraction_manifest WHERE plan_id = ? AND workspace_id = ?')
    .get(planId, ctx.workspaceId) as ManifestRow | undefined;
}

function parseItems(row: ManifestRow): ManifestItemEntry[] {
  return JSON.parse(row.items) as ManifestItemEntry[];
}

// --- Completeness (US-G19.3): open count over the denominator, not_used excluded ------------------

export interface Completeness {
  total: number;
  open: number;
  exported: number;
  notUsed: number;
  blocked: number;
  /** total minus not_used: the count "complete" is measured against (US-G19.3, §6b fixed). */
  denominator: number;
  /** True when every counted item is exported (open and blocked both zero). */
  complete: boolean;
}

function computeCompleteness(items: readonly ManifestItemEntry[]): Completeness {
  let open = 0;
  let exported = 0;
  let notUsed = 0;
  let blocked = 0;
  for (const it of items) {
    if (it.status === 'open') open += 1;
    else if (it.status === 'exported') exported += 1;
    else if (it.status === 'not_used') notUsed += 1;
    else if (it.status === 'blocked') blocked += 1;
  }
  const total = items.length;
  const denominator = total - notUsed;
  // A manifest with every item not_used is vacuously complete: nothing remains to export.
  const complete = open === 0 && blocked === 0;
  return { total, open, exported, notUsed, blocked, denominator, complete };
}

// --- Guide reads (depsActions, ungated: they describe the software) ------------------------------

/** US-G19.1: the guide catalog, one summary per registered source system. Read, ungated. */
export function listExtractionGuides(): Result {
  return ok({
    guides: EXTRACTION_GUIDES.map((g) => ({
      sourceSystem: g.sourceSystem,
      label: g.label,
      itemCount: g.items.length,
      hasCompanion: guideHasCompanion(g),
    })),
  });
}

/**
 * US-G19.1/US-G19.2/US-G19.5: one guide, its items with their tactic-ladder rungs and quirks, its
 * deletion clock and the Datenherausgabe letter template. An unregistered source system returns the
 * GENERIC guide with `fellBack:true`, so "no guide" is unreachable. Read, ungated.
 */
export function getExtractionGuide(input: { sourceSystem?: unknown; strict?: unknown }): Result {
  // Strict callers ask for an exact match and are told when there is none (US-G19.1 error state).
  if (input.strict === true) {
    const def = extractionGuideDef(input.sourceSystem);
    if (def === undefined) {
      return err('unknown_source_system', { sourceSystem: input.sourceSystem, known: [...EXTRACTION_GUIDE_IDS] });
    }
    return ok({ guide: guideView(def), fellBack: false });
  }
  const { guide, fellBack } = resolveGuide(input.sourceSystem);
  return ok({ guide: guideView(guide), fellBack });
}

/** Serialise a guide with `hasCompanion` derived, so the wire never restates the gate flag. */
function guideView(guide: ExtractionGuide): Record<string, unknown> {
  return {
    sourceSystem: guide.sourceSystem,
    label: guide.label,
    items: guide.items.map((it) => ({
      id: it.id,
      what: it.what,
      sourceArea: it.sourceArea,
      formats: [...it.formats],
      dataClasses: [...it.dataClasses],
      rung: it.rung,
      rungGated: it.rung === 3 || it.rung === 4,
      quirks: [...it.quirks],
      statutory: it.statutory,
      ...(it.moduleQuestion !== undefined ? { moduleQuestion: it.moduleQuestion } : {}),
    })),
    deletionClock: guide.deletionClock,
    letterTemplate: guide.letterTemplate,
    hasCompanion: guideHasCompanion(guide),
    cleanRoomSource: [...guide.cleanRoomSource],
  };
}

// --- setManifest (write, manage_import) ----------------------------------------------------------

/**
 * US-G19.3: instantiate the manifest from the plan's source-system guide, one item per guide row at
 * status `open`. Idempotent on its key. If a manifest already exists for the plan it is NOT reset
 * (recorded item statuses survive); only `sourceAccessUntil` is updated when supplied.
 */
export function setManifest(
  ctx: WorkspaceContext,
  input: { planId?: unknown; sourceAccessUntil?: unknown; idempotencyKey?: unknown },
): Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (input.sourceAccessUntil !== undefined && input.sourceAccessUntil !== null) {
    if (typeof input.sourceAccessUntil !== 'string' || !ISO_DATE.test(input.sourceAccessUntil)) {
      return err('invalid_input', { field: 'sourceAccessUntil' });
    }
  }
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'migration_set_manifest');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'migration_set_manifest', () => {
    const now = ctx.clock.now();
    const { guide } = resolveGuide(plan.source_system);
    const accessUntil = typeof input.sourceAccessUntil === 'string' ? input.sourceAccessUntil : null;
    const existing = loadManifest(ctx, plan.id);

    if (existing !== undefined) {
      // Do NOT reset recorded item statuses; only refresh the deadline when one is supplied.
      if (accessUntil !== null) {
        ctx.store.db
          .prepare('UPDATE migration_extraction_manifest SET source_access_until = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run(accessUntil, now, existing.id, ctx.workspaceId);
      }
      const refreshed = loadManifest(ctx, plan.id)!;
      return ok({ manifestId: refreshed.id, items: parseItems(refreshed) });
    }

    const items: ManifestItemEntry[] = guide.items.map((it) => ({
      itemId: it.id,
      status: 'open' as const,
      fileIds: [],
      updatedAt: now,
      updatedBy: ctx.actor,
    }));
    const id = ctx.ids.next('migextm');
    ctx.store.db
      .prepare(
        `INSERT INTO migration_extraction_manifest
           (id, workspace_id, plan_id, source_system, source_access_until, items, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, plan.id, guide.sourceSystem, accessUntil, JSON.stringify(items), now, now);
    return ok({ manifestId: id, items });
  });
}

// --- setManifestItem (write, manage_import) ------------------------------------------------------

/**
 * US-G19.3: record one item's status and evidence. Refuses a cross-workspace fileId (§H-TENANT), a
 * date range whose end precedes its start (P9), an unknown item id or an invalid status. Idempotent
 * on its key. `completedManifestId` is set only on the write that made the manifest FIRST complete
 * (the null-collapse pattern G11's check events use), so the automation event fires once.
 */
export function setManifestItem(
  ctx: WorkspaceContext,
  input: {
    planId?: unknown;
    itemId?: unknown;
    status?: unknown;
    fileIds?: unknown;
    rowCount?: unknown;
    dateFrom?: unknown;
    dateTo?: unknown;
    note?: unknown;
    idempotencyKey?: unknown;
  },
): Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) return err('invalid_input', { field: 'itemId' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!isManifestItemStatus(input.status)) {
    return err('invalid_input', { field: 'status', allowed: [...MANIFEST_ITEM_STATUSES] });
  }
  // fileIds, when given, must be an array of strings.
  let fileIds: string[] = [];
  if (input.fileIds !== undefined && input.fileIds !== null) {
    if (!Array.isArray(input.fileIds) || input.fileIds.some((f) => typeof f !== 'string')) {
      return err('invalid_input', { field: 'fileIds' });
    }
    fileIds = input.fileIds as string[];
  }
  if (input.rowCount !== undefined && input.rowCount !== null) {
    if (!Number.isInteger(input.rowCount) || (input.rowCount as number) < 0) {
      return err('invalid_input', { field: 'rowCount' });
    }
  }
  for (const field of ['dateFrom', 'dateTo'] as const) {
    const v = input[field];
    if (v !== undefined && v !== null && (typeof v !== 'string' || !ISO_DATE.test(v))) {
      return err('invalid_input', { field });
    }
  }
  if (typeof input.dateFrom === 'string' && typeof input.dateTo === 'string' && input.dateTo < input.dateFrom) {
    return err('invalid_date_range', { dateFrom: input.dateFrom, dateTo: input.dateTo });
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    return err('invalid_input', { field: 'note' });
  }

  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const manifest = loadManifest(ctx, plan.id);
  if (manifest === undefined) return err('manifest_not_found', { planId: input.planId });

  const items = parseItems(manifest);
  const idx = items.findIndex((it) => it.itemId === input.itemId);
  if (idx === -1) return err('unknown_manifest_item', { itemId: input.itemId });

  // §H-TENANT: every referenced file must be an E00 row in THIS workspace, or the write refuses.
  for (const fileId of fileIds) {
    const found = ctx.store.db
      .prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, fileId) as { id: string } | undefined;
    if (found === undefined) return err('file_not_found', { fileId });
  }

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'migration_set_manifest_item');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'migration_set_manifest_item', () => {
    const now = ctx.clock.now();
    const completeBefore = computeCompleteness(items).complete;
    const entry: ManifestItemEntry = {
      itemId: input.itemId as string,
      status: input.status as ManifestItemStatus,
      fileIds,
      updatedAt: now,
      updatedBy: ctx.actor,
    };
    if (typeof input.rowCount === 'number') entry.rowCount = input.rowCount;
    if (typeof input.dateFrom === 'string') entry.dateFrom = input.dateFrom;
    if (typeof input.dateTo === 'string') entry.dateTo = input.dateTo;
    if (typeof input.note === 'string') entry.note = input.note;
    items[idx] = entry;

    const completeness = computeCompleteness(items);
    ctx.store.db
      .prepare('UPDATE migration_extraction_manifest SET items = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(JSON.stringify(items), now, manifest.id, ctx.workspaceId);

    // Null-collapse: name the MOMENT the manifest became complete, so the event fires once.
    const completedManifestId = !completeBefore && completeness.complete ? manifest.id : null;
    return ok({ manifestId: manifest.id, item: entry, completeness, completedManifestId });
  });
}

// --- getManifest (read, manage_import) -----------------------------------------------------------

/**
 * US-G19.3: the manifest, its items, completeness and the deletion clock as a date with the days
 * remaining. A plan with no manifest returns `manifest:null` so the surface can offer "create".
 */
export function getManifest(ctx: WorkspaceContext, input: { planId?: unknown; savedViewId?: unknown; status?: unknown }): Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  if (input.savedViewId !== undefined && typeof input.savedViewId !== 'string') {
    return err('invalid_input', { field: 'savedViewId' });
  }
  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  const manifest = loadManifest(ctx, plan.id);
  if (manifest === undefined) {
    return ok({ manifest: null, items: [], completeness: null, deadline: null });
  }
  const items = parseItems(manifest);
  // The G00 saved-view seam over the checklist ITEMS (spec §6b: "Offene Exporte", "Blockiert"): a
  // stored status filter applies when only savedViewId is named; an explicit status wins. The
  // completeness and deadline are computed over the WHOLE manifest, never the filtered view (the
  // migration_get_plan precedent, where the journey is computed over all steps).
  const viewed = applySavedView(ctx, 'migration_extraction_manifest', { savedViewId: input.savedViewId as string | undefined, status: input.status });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { status?: unknown };
  const shownItems = f.status === undefined ? items : items.filter((it) => it.status === f.status);
  const completeness = computeCompleteness(items);
  const deadline = deadlineOf(manifest.source_access_until, ctx.clock.now());
  return ok({
    manifest: {
      manifestId: manifest.id,
      planId: manifest.plan_id,
      sourceSystem: manifest.source_system,
      sourceAccessUntil: manifest.source_access_until,
      createdAt: manifest.created_at,
      updatedAt: manifest.updated_at,
    },
    items: shownItems,
    completeness,
    deadline,
  });
}

/** The deletion clock as a date plus signed days remaining (negative when past). Null when unset. */
export function deadlineOf(sourceAccessUntil: string | null, nowIso: string): { sourceAccessUntil: string; daysRemaining: number } | null {
  if (sourceAccessUntil === null) return null;
  const today = nowIso.slice(0, 10);
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${sourceAccessUntil}T00:00:00Z`);
  const daysRemaining = Math.round((b - a) / 86_400_000);
  return { sourceAccessUntil, daysRemaining };
}
