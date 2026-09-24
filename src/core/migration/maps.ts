/**
 * G10, migration maps: the persisted, reusable, inspectable answer to the three questions nothing
 * can be imported without (which column is which field, which source account is which KMU account,
 * which source tax code is which A05 code), plus the operator-scoped template layer that lets a
 * Treuhänder reuse a finished map on the next client WITHOUT any client figure travelling with it.
 *
 * WHAT THIS MODULE NEVER DOES (the §6b Fixed list, enforced here rather than restated per verb):
 *  - It never computes a rate and never stores one as an input to computation. A tax map names a
 *    CODE and a validity window; the rate for that code is A05's `resolveTax` (P6), and the
 *    `sourceRateBp` an entry may carry is evidence of what the source believed, nothing more.
 *  - It never accepts a target that does not exist in this workspace's A01 chart or A05 code set
 *    at WRITE time. Validating at write is what makes `complete` a trustworthy gate.
 *  - It never resolves overlapping tax windows by row order: an overlapping pair is refused at
 *    write with both windows named (`overlapping_tax_mapping`).
 *  - It never lets an unmapped account carrying a non-zero balance count as complete
 *    (OR Art. 957a Abs. 2 Ziff. 3, Klarheit): those are `blocking[]`, and G09's preview gates on
 *    the `complete` predicate this module computes.
 *  - It never writes a client figure into a template row: `saveMapTemplate` strips balances (and
 *    any other monetary field) before persisting, asserted by the template purity test (§7).
 *
 * THE LOCALE FENCE (spec §7): nothing in this file names a KMU account number or an MWST code.
 * Every Swiss identifier the suggestion path uses comes out of `locale/ch/` as pack data, and the
 * fence test would go red on the first literal that leaks in here.
 *
 * §H-TENANT: every `migration_plan` / `migration_map` query filters on `workspace_id`. Templates
 * are the ONE deliberate exception (operator-scoped, `operator_ref`), fenced by content instead;
 * see `schema.ts` for why their anchor column is not spelled `workspace_id`.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { localePackDef, normalizeToken, DEFAULT_LOCALE_PACK_ID, LOCALE_PACK_IDS } from './locale/registry.js';
import type { LocalePack } from './locale/registry.js';
import { sourceAdapterDef } from './adapters/registry.js';
import type { SourceAdapterDef } from './adapters/registry.js';
import { applySavedView } from '../customization/views.js';

// --- §H-ENUM: the closed sets, each with its single source here --------------------------------

export const MAP_KINDS = ['column', 'account', 'tax', 'currency'] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export const MAP_PROVENANCES = [
  'adapter_preset',
  'locale_pack',
  'saved_template',
  'fuzzy',
  'manual',
  'agent',
] as const;
export type MapProvenance = (typeof MAP_PROVENANCES)[number];

/** The suggestion sources, in the order `suggestMap` consults them (spec §4). */
export const SUGGESTION_SOURCES = ['adapter_preset', 'locale_pack', 'saved_template', 'fuzzy', 'none'] as const;
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number];

/**
 * // SEAM(G09): G09 owns the data-class enum. The map layer needs only the applicability cut the
 * // template-kind check reads: account and tax maps only make sense on a FINANCIAL data class
 * // (a contact or item import carries no chart and no tax codes, spec §2 US-G10.3 boundary).
 * // A plan whose data_class is NULL (every wave-1 plan) passes vacuously.
 */
const FINANCIAL_DATA_CLASSES: ReadonlySet<string> = new Set(['opening_balances', 'journal']);

/** One map entry. `source` is the source-side key; the rest is kind-dependent and optional. */
export interface MapEntry {
  /** Source column header, source account number, source tax code, or source currency. */
  readonly source: string;
  /** A source-side LABEL (a chart label like a cash-account name). Never a client figure. */
  readonly sourceName?: string;
  /** Tax kind: the rate the SOURCE believed, in bp. Evidence only, never an input to arithmetic (P6). */
  readonly sourceRateBp?: number;
  /** Account kind: the balance discovery reported, integer Rappen. STRIPPED from templates. */
  readonly balanceMinor?: number;
  /** The target: A01 account number, A05 tax code, neutral field id, or ISO currency. null = unset. */
  readonly target?: string | null;
  /** Tax kind: INCLUSIVE ISO start of the window this mapping governs. */
  readonly validFrom?: string;
  /** Tax kind: EXCLUSIVE ISO end of the window; absent = open-ended. */
  readonly validTo?: string;
  /** What an applied template proposed, kept so the conflicts read can show both values. */
  readonly templateTarget?: string;
  /** The per-row rule control (UI seam); free text today, single-sourced when a rule set lands. */
  readonly rule?: string;
}

interface PlanRow {
  id: string;
  status: string;
  source_adapter: string | null;
  locale_pack: string | null;
  data_class: string | null;
}

interface MapRow {
  id: string;
  kind: string;
  entries: string;
  rule_default: string | null;
  provenance: string;
}

interface TemplateRow {
  id: string;
  operator_ref: string;
  name: string;
  source_system: string;
  kinds: string;
  entries: string;
  created_at: string;
  last_used_at: string | null;
}

// --- Shared guards (P9: rejections are returned, never thrown) ---------------------------------

function requireString(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

function isMapKind(value: unknown): value is MapKind {
  return typeof value === 'string' && (MAP_KINDS as readonly string[]).includes(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** §H-TENANT: the plan lookup every verb here starts with. */
function planRow(ctx: WorkspaceContext, planId: string): PlanRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT id, status, source_adapter, locale_pack, data_class FROM migration_plan WHERE id = ? AND workspace_id = ?',
    )
    .get(planId, ctx.workspaceId) as PlanRow | undefined;
}

/** The pack a plan resolves defaults through. An unregistered NAMED pack is a P9 rejection. */
function packFor(plan: PlanRow): LocalePack | Result {
  const id = plan.locale_pack ?? DEFAULT_LOCALE_PACK_ID;
  const pack = localePackDef(id);
  if (pack === undefined) return err('unknown_locale_pack', { localePack: id, registered: LOCALE_PACK_IDS });
  return pack;
}

function isPack(p: LocalePack | Result): p is LocalePack {
  return typeof (p as LocalePack).id === 'string' && (p as { ok?: unknown }).ok === undefined;
}

function mapRowFor(ctx: WorkspaceContext, planId: string, kind: MapKind): MapRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT id, kind, entries, rule_default, provenance FROM migration_map WHERE plan_id = ? AND kind = ? AND workspace_id = ?',
    )
    .get(planId, kind, ctx.workspaceId) as MapRow | undefined;
}

function parseEntries(row: MapRow): MapEntry[] {
  return JSON.parse(row.entries) as MapEntry[];
}

// --- Target validation: a map may only point AT what A01 / A05 really carry (§6b Fixed) --------

function accountNumberExists(ctx: WorkspaceContext, number: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
      .get(ctx.workspaceId, number) !== undefined
  );
}

function taxCodeExists(ctx: WorkspaceContext, code: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT id FROM tax_code WHERE workspace_id = ? AND code = ? AND active = 1')
      .get(ctx.workspaceId, code) !== undefined
  );
}

/** Two half-open windows `[from, to)` overlap. An absent `to` is open-ended. */
function windowsOverlap(a: MapEntry, b: MapEntry): boolean {
  const aFrom = a.validFrom ?? '';
  const bFrom = b.validFrom ?? '';
  const aTo = a.validTo;
  const bTo = b.validTo;
  const aBeforeB = aTo !== undefined && aTo <= bFrom;
  const bBeforeA = bTo !== undefined && bTo <= aFrom;
  return !(aBeforeB || bBeforeA);
}

/**
 * Validate ONE entry against the workspace's real registers. Returns the rejection or undefined.
 * `setMap` rejects the WHOLE map on the first failure and persists nothing (spec §4).
 */
function validateEntry(ctx: WorkspaceContext, kind: MapKind, e: MapEntry): Result | undefined {
  if (typeof e !== 'object' || e === null) return err('invalid_input', { field: 'entries' });
  if (typeof e.source !== 'string' || e.source.length === 0) {
    return err('invalid_input', { field: 'entries[].source' });
  }
  const target = e.target ?? null;
  if (target !== null && (typeof target !== 'string' || target.length === 0)) {
    return err('invalid_input', { field: 'entries[].target' });
  }
  if (kind === 'account') {
    if (e.balanceMinor !== undefined && !Number.isInteger(e.balanceMinor)) {
      return err('invalid_input', { field: 'entries[].balanceMinor' });
    }
    if (target !== null && !accountNumberExists(ctx, target)) {
      // The spec's own payload shape: the SOURCE account is what the operator recognises.
      return err('unknown_account', { sourceAccount: e.source, target });
    }
  }
  if (kind === 'tax') {
    if (!isIsoDate(e.validFrom)) return err('invalid_input', { field: 'entries[].validFrom' });
    if (e.validTo !== undefined) {
      if (!isIsoDate(e.validTo)) return err('invalid_input', { field: 'entries[].validTo' });
      if (e.validTo <= e.validFrom) return err('invalid_window', { sourceCode: e.source, validFrom: e.validFrom, validTo: e.validTo });
    }
    if (e.sourceRateBp !== undefined && !Number.isInteger(e.sourceRateBp)) {
      return err('invalid_input', { field: 'entries[].sourceRateBp' });
    }
    if (target !== null && !taxCodeExists(ctx, target)) {
      return err('unknown_tax_code', { sourceCode: e.source, targetCode: target });
    }
  }
  if (kind === 'currency' && target !== null && !/^[A-Z]{3}$/.test(target)) {
    return err('invalid_currency', { sourceCurrency: e.source, target });
  }
  return undefined;
}

/** The overlap refusal, per source code, both windows named (spec §2 US-G10.3 boundary). */
function findTaxOverlap(entries: readonly MapEntry[]): Result | undefined {
  const bySource = new Map<string, MapEntry[]>();
  for (const e of entries) {
    const list = bySource.get(e.source);
    if (list === undefined) bySource.set(e.source, [e]);
    else list.push(e);
  }
  for (const [source, list] of bySource) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a !== undefined && b !== undefined && windowsOverlap(a, b)) {
          return err('overlapping_tax_mapping', {
            sourceCode: source,
            first: { validFrom: a.validFrom, validTo: a.validTo ?? null },
            second: { validFrom: b.validFrom, validTo: b.validTo ?? null },
          });
        }
      }
    }
  }
  return undefined;
}

// --- The completeness read model (US-G10.2): what G09's preview gates on -----------------------

export interface MapAssessment {
  complete: boolean;
  blocking: { source: string; sourceName: string | null; balanceMinor: number | null }[];
  ignorable: { source: string; sourceName: string | null }[];
  collapsed: { target: string; sources: string[] }[];
  conflicts: { source: string; target: string; templateTarget: string }[];
}

function assessEntries(kind: MapKind, entries: readonly MapEntry[]): MapAssessment {
  const blocking: MapAssessment['blocking'] = [];
  const ignorable: MapAssessment['ignorable'] = [];
  const conflicts: MapAssessment['conflicts'] = [];
  const byTarget = new Map<string, string[]>();
  for (const e of entries) {
    const target = e.target ?? null;
    if (target === null) {
      // The zero-balance leniency is ACCOUNT-specific (spec §2 US-G10.2 boundary): a source
      // account the business stopped using is listed, never hidden, and never blocks. Every
      // other kind's unset target blocks: there is no balance to make it ignorable.
      if (kind === 'account' && (e.balanceMinor === undefined || e.balanceMinor === 0)) {
        ignorable.push({ source: e.source, sourceName: e.sourceName ?? null });
      } else {
        blocking.push({
          source: e.source,
          sourceName: e.sourceName ?? null,
          balanceMinor: e.balanceMinor ?? null,
        });
      }
      continue;
    }
    const sources = byTarget.get(target);
    if (sources === undefined) byTarget.set(target, [e.source]);
    else sources.push(e.source);
    if (e.templateTarget !== undefined && e.templateTarget !== target) {
      conflicts.push({ source: e.source, target, templateTarget: e.templateTarget });
    }
  }
  const collapsed = [...byTarget.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([target, sources]) => ({ target, sources }));
  return { complete: blocking.length === 0, blocking, ignorable, collapsed, conflicts };
}

// --- suggestMap (US-G10.1): four sources in a fixed order, each named, nothing written ----------

interface Proposal {
  entries: MapEntry[];
  confidence: number;
  source: SuggestionSource;
}

/** The confidence floor a proposal must clear to be returned (spec §4). */
const CONFIDENCE_FLOOR = 0.5;

const NEUTRAL_FIELDS: ReadonlySet<string> = new Set([
  'date',
  'description',
  'amount',
  'debit',
  'credit',
  'account',
  'contraAccount',
  'taxCode',
  'currency',
  'reference',
  'balance',
]);

function proposeFromPairs(
  headers: readonly string[],
  lookup: (normalized: string) => string | undefined,
  source: SuggestionSource,
): Proposal {
  const entries: MapEntry[] = headers.map((h) => {
    const target = lookup(normalizeToken(h));
    return target === undefined ? { source: h, target: null } : { source: h, target };
  });
  const matched = entries.filter((e) => e.target !== null).length;
  return { entries, confidence: headers.length === 0 ? 0 : matched / headers.length, source };
}

/** A rate spelled inside a header ("8.1%", "MWST 7.7"), as basis points, or undefined. */
function rateBpIn(header: string): number | undefined {
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%?/.exec(header);
  if (m === null || m[1] === undefined) return undefined;
  const bp = Math.round(Number.parseFloat(m[1].replace(',', '.')) * 100);
  return Number.isFinite(bp) && bp > 0 ? bp : undefined;
}

/**
 * The vendor adapter whose column knowledge a plan's suggestion should use, plus the data classes the
 * linked file carries. `plan.source_adapter` is the operator's declared source, but F-09 discovery may
 * LINK a file to a vendor adapter without touching the plan row: the classification lands on
 * `migration_source_file`, not the plan (a "bexio Saldenliste" recognised by header signature, spec
 * §4 / friction ledger J1.4). So the suggestion path must read the linked source file to reach that
 * vendor's presets. §H-TENANT: the read is workspace-scoped, exactly like `planRow`.
 */
function linkedSourceAdapter(
  ctx: WorkspaceContext,
  planId: string,
): { adapter: SourceAdapterDef; dataClasses: string[] } | undefined {
  const rows = ctx.store.db
    .prepare(
      'SELECT adapter, data_classes FROM migration_source_file WHERE plan_id = ? AND workspace_id = ? ORDER BY created_at ASC',
    )
    .all(planId, ctx.workspaceId) as { adapter: string | null; data_classes: string | null }[];
  for (const row of rows) {
    const def = sourceAdapterDef(row.adapter ?? undefined);
    // A vendor adapter is one that carries column knowledge; the generic csv row has none and cannot
    // seed a map, which is the correct degradation (the operator maps by hand).
    if (def !== undefined && def.columnPresets.length > 0) {
      const dataClasses = row.data_classes !== null ? (JSON.parse(row.data_classes) as string[]) : [];
      return { adapter: def, dataClasses };
    }
  }
  return undefined;
}

export function suggestMap(
  ctx: WorkspaceContext,
  input: { planId: string; kind: string; dataClass?: string; headers?: unknown },
): Result {
  const guard = requireString(input.planId, 'planId');
  if (guard) return guard;
  if (!isMapKind(input.kind)) return err('invalid_map_kind', { kind: input.kind, allowed: [...MAP_KINDS] });
  const kind = input.kind;
  const plan = planRow(ctx, input.planId);
  if (plan === undefined) return err('unknown_plan', { planId: input.planId });
  const pack = packFor(plan);
  if (!isPack(pack)) return pack;
  if (input.headers !== undefined && !Array.isArray(input.headers)) {
    return err('invalid_input', { field: 'headers' });
  }
  const headers = (input.headers ?? []).filter((h): h is string => typeof h === 'string' && h.length > 0);

  const proposals: Proposal[] = [];

  // The effective column adapter: the plan's own adapter when it carries presets, else the vendor
  // adapter F-09 discovery linked a source file to. The linked-vendor fact lives on
  // `migration_source_file`, not the plan row, so a Saldenliste recognised by header signature still
  // reaches its presets here (friction ledger J1.4: without this the suggest step returned none).
  const planAdapter = sourceAdapterDef(plan.source_adapter ?? undefined);
  const linked = linkedSourceAdapter(ctx, input.planId);
  const adapter =
    planAdapter !== undefined && planAdapter.columnPresets.length > 0 ? planAdapter : linked?.adapter;

  // F-09 seam: a linked vendor adapter can SEED the column map when the operator has typed no headers
  // yet (the mapping draft is empty until a map is saved). Take the header signature for the data
  // class this plan maps (the caller's `dataClass`, else the linked file's own class) and let the
  // pipeline below map those columns through the adapter's presets. Only the column kind seeds this
  // way: account and tax sources are the file's own account numbers and codes, discovered elsewhere.
  let columnHeaders = headers;
  if (kind === 'column' && columnHeaders.length === 0 && adapter?.headerSignatures !== undefined) {
    const wantClass = typeof input.dataClass === 'string' ? input.dataClass : linked?.dataClasses[0];
    const signature =
      adapter.headerSignatures.find((s) => s.dataClass === wantClass) ??
      (adapter.headerSignatures.length === 1 ? adapter.headerSignatures[0] : undefined);
    if (signature !== undefined) columnHeaders = [...signature.headers];
  }

  // 1. The adapter preset for the plan's source (column maps only: presets are header knowledge).
  if (kind === 'column' && adapter !== undefined && adapter.columnPresets.length > 0) {
    const byHeader = new Map(adapter.columnPresets.map((p) => [p.header, p.field]));
    proposals.push(proposeFromPairs(columnHeaders, (n) => byHeader.get(n), 'adapter_preset'));
  }

  // 2. The plan's locale pack.
  if (kind === 'column') {
    const byHeader = new Map(pack.headerSynonyms.map((s) => [s.header, s.field]));
    proposals.push(proposeFromPairs(columnHeaders, (n) => byHeader.get(n), 'locale_pack'));
  } else if (kind === 'account') {
    const byLabel = new Map(pack.chartSynonyms.map((s) => [s.label, s.targetNumber]));
    proposals.push(proposeFromPairs(headers, (n) => byLabel.get(n), 'locale_pack'));
  } else if (kind === 'tax') {
    const byRate = new Map(pack.taxRateSuggestions.map((s) => [s.rateBp, s]));
    const entries: MapEntry[] = headers.map((h) => {
      const bp = rateBpIn(h);
      if (bp === undefined) return { source: h, target: null };
      const hit = byRate.get(bp);
      if (hit === undefined) return { source: h, target: null };
      return { source: h, sourceRateBp: bp, target: hit.targetCode, validFrom: hit.validFrom };
    });
    const matched = entries.filter((e) => e.target !== null).length;
    proposals.push({ entries, confidence: headers.length === 0 ? 0 : matched / headers.length, source: 'locale_pack' });
  }

  // 3. This operator's saved templates for the plan's EFFECTIVE source system. Keyed off the same
  // effective adapter G10 seeds the presets from (the plan's own adapter when it has column knowledge,
  // else the vendor F-09 discovery linked), not the stale `plan.source_adapter`: a Saldenliste linked
  // to `bexio_csv` while the plan row still declares the generic `csv` must still find the operator's
  // saved bexio template. Falls back to the declared adapter when nothing effective resolved.
  const templateSourceSystem = adapter?.id ?? plan.source_adapter ?? '';
  const templates = ctx.store.db
    .prepare(
      'SELECT id, operator_ref, name, source_system, kinds, entries, created_at, last_used_at FROM migration_map_template WHERE operator_ref = ? AND source_system = ? ORDER BY last_used_at DESC, created_at DESC',
    )
    .all(ctx.actor, templateSourceSystem) as TemplateRow[];
  for (const t of templates) {
    const kinds = JSON.parse(t.kinds) as string[];
    if (!kinds.includes(kind)) continue;
    const templateEntries = (JSON.parse(t.entries) as Record<string, MapEntry[]>)[kind] ?? [];
    if (templateEntries.length === 0) continue;
    if (headers.length === 0) {
      // No discovered headers to match against: the template's own entry set IS the proposal.
      proposals.push({ entries: templateEntries.map((e) => ({ ...e })), confidence: 1, source: 'saved_template' });
    } else {
      const bySource = new Map(templateEntries.map((e) => [normalizeToken(e.source), e]));
      const entries: MapEntry[] = headers.map((h) => {
        const hit = bySource.get(normalizeToken(h));
        return hit === undefined ? { source: h, target: null } : { ...hit, source: h };
      });
      const matched = entries.filter((e) => e.target !== null).length;
      proposals.push({ entries, confidence: matched / headers.length, source: 'saved_template' });
    }
    break; // Most recently used template only: two proposals from one source would be noise.
  }

  // 4. The fuzzy fallback.
  if (kind === 'column') {
    const byField = new Map([...NEUTRAL_FIELDS].map((f) => [normalizeToken(f), f]));
    proposals.push(proposeFromPairs(columnHeaders, (n) => byField.get(n), 'fuzzy'));
  } else if (kind === 'account') {
    // A source chart on the standard Swiss numbering maps onto itself: a header that IS a number
    // the pack's target chart carries suggests that same number.
    const numbers = new Set(pack.targetChartSeed.accountNumbers);
    const entries: MapEntry[] = headers.map((h) => {
      const token = /\d{3,5}/.exec(h)?.[0];
      return token !== undefined && numbers.has(token) ? { source: h, target: token } : { source: h, target: null };
    });
    const matched = entries.filter((e) => e.target !== null).length;
    proposals.push({ entries, confidence: headers.length === 0 ? 0 : matched / headers.length, source: 'fuzzy' });
  }

  for (const p of proposals) {
    if (p.entries.length > 0 && p.confidence >= CONFIDENCE_FLOOR) {
      return ok({ kind, entries: p.entries, confidence: p.confidence, source: p.source });
    }
  }
  // Nothing cleared the floor: the raw headers come back so the operator maps by hand rather
  // than seeing an empty screen (US-G10.1 empty state).
  return ok({ kind, entries: [], confidence: 0, source: 'none', headers });
}

// --- setMap (US-G10.1, US-G10.3): validate whole, persist whole, or persist nothing ------------

export function setMap(
  ctx: WorkspaceContext,
  input: { planId: string; kind: string; entries: unknown; ruleDefault?: string; idempotencyKey: string },
): Result {
  const guard = requireString(input.planId, 'planId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!isMapKind(input.kind)) return err('invalid_map_kind', { kind: input.kind, allowed: [...MAP_KINDS] });
  const kind = input.kind;
  if (!Array.isArray(input.entries)) return err('invalid_input', { field: 'entries' });
  const entries = input.entries as MapEntry[];

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'migration_set_map');
  if (replayed !== undefined) return replayed;

  const plan = planRow(ctx, input.planId);
  if (plan === undefined) return err('unknown_plan', { planId: input.planId });

  for (const e of entries) {
    const bad = validateEntry(ctx, kind, e);
    if (bad) return bad;
  }
  if (kind === 'tax') {
    const overlap = findTaxOverlap(entries);
    if (overlap) return overlap;
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const provenance: MapProvenance = ctx.actor === 'agent' ? 'agent' : 'manual';
    ctx.store.db
      .prepare(
        `INSERT INTO migration_map (id, workspace_id, plan_id, kind, entries, rule_default, provenance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (plan_id, kind) DO UPDATE SET
           entries = excluded.entries,
           rule_default = excluded.rule_default,
           provenance = excluded.provenance,
           updated_at = excluded.updated_at`,
      )
      .run(
        ctx.ids.next('migmap'),
        ctx.workspaceId,
        input.planId,
        kind,
        JSON.stringify(entries),
        input.ruleDefault ?? null,
        provenance,
        now,
        now,
      );
    const row = mapRowFor(ctx, input.planId, kind);
    if (row === undefined) return err('not_found', { planId: input.planId, kind });
    const a = assessEntries(kind, entries);
    return ok({
      mapId: row.id,
      complete: a.complete,
      blocking: a.blocking,
      ignorable: a.ignorable,
      // The automation occurrence key: null unless the map is complete, so the
      // `migration.map_completed` event fires only on the moment it names (the null-collapse
      // pattern events.ts documents on `dunning.proposed`).
      completedMapId: a.complete ? row.id : null,
    });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'migration_set_map', run);
}

// --- getMap (US-G10.2): the completeness read model ---------------------------------------------

export function getMap(ctx: WorkspaceContext, input: { planId: string; kind: string }): Result {
  const guard = requireString(input.planId, 'planId');
  if (guard) return guard;
  if (!isMapKind(input.kind)) return err('invalid_map_kind', { kind: input.kind, allowed: [...MAP_KINDS] });
  const plan = planRow(ctx, input.planId);
  if (plan === undefined) return err('unknown_plan', { planId: input.planId });
  const row = mapRowFor(ctx, input.planId, input.kind);
  if (row === undefined) {
    // No map yet IS an incomplete map, not an error: G09's preview gates on `complete` and a
    // plan whose mapping step has not run must not read as ready.
    return ok({ mapId: null, entries: [], complete: false, blocking: [], ignorable: [], collapsed: [], conflicts: [] });
  }
  const entries = parseEntries(row);
  const a = assessEntries(input.kind, entries);
  return ok({
    mapId: row.id,
    entries,
    complete: a.complete,
    blocking: a.blocking,
    ignorable: a.ignorable,
    collapsed: a.collapsed,
    conflicts: a.conflicts,
  });
}

/**
 * Resolve a tax-map entry by SUPPLY DATE (US-G10.3): the seam G09's stages call per row. Returns
 * the target CODE only; the rate for that code is A05's `resolveTax` (P6), never this module's.
 */
export function resolveTaxTarget(
  entries: readonly MapEntry[],
  sourceCode: string,
  supplyDate: string,
): Result {
  if (!isIsoDate(supplyDate)) return err('invalid_input', { field: 'supplyDate' });
  for (const e of entries) {
    if (e.source !== sourceCode || e.target === null || e.target === undefined) continue;
    const from = e.validFrom ?? '';
    if (supplyDate >= from && (e.validTo === undefined || supplyDate < e.validTo)) {
      return ok({ targetCode: e.target });
    }
  }
  // The MAP is what needs fixing, so the rejection names it through the source code and date
  // rather than pretending the row is at fault (spec §2 US-G10.3 error state).
  return err('no_tax_mapping_for_date', { sourceCode, supplyDate });
}

// --- Templates (US-G10.5): operator-scoped reuse that carries no client figure ------------------

/** What a template entry keeps: source labels, source keys and target ids. NOTHING monetary. */
function stripForTemplate(e: MapEntry): MapEntry {
  const kept: MapEntry = { source: e.source };
  const out = kept as { -readonly [K in keyof MapEntry]: MapEntry[K] };
  if (e.sourceName !== undefined) out.sourceName = e.sourceName;
  if (e.sourceRateBp !== undefined) out.sourceRateBp = e.sourceRateBp;
  if (e.target !== undefined) out.target = e.target;
  if (e.validFrom !== undefined) out.validFrom = e.validFrom;
  if (e.validTo !== undefined) out.validTo = e.validTo;
  if (e.rule !== undefined) out.rule = e.rule;
  // Deliberately dropped: balanceMinor (a client figure) and templateTarget (apply-time state).
  return kept;
}

export function saveMapTemplate(
  ctx: WorkspaceContext,
  input: { planId: string; name: string; sourceSystem: string; kinds: unknown; idempotencyKey: string },
): Result {
  const guard =
    requireString(input.planId, 'planId') ??
    requireString(input.name, 'name') ??
    requireString(input.sourceSystem, 'sourceSystem') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!Array.isArray(input.kinds) || input.kinds.length === 0 || !input.kinds.every(isMapKind)) {
    return err('invalid_input', { field: 'kinds', allowed: [...MAP_KINDS] });
  }
  const kinds = input.kinds as MapKind[];

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'migration_save_map_template');
  if (replayed !== undefined) return replayed;

  const plan = planRow(ctx, input.planId);
  if (plan === undefined) return err('unknown_plan', { planId: input.planId });

  const snapshot: Record<string, MapEntry[]> = {};
  for (const kind of kinds) {
    const row = mapRowFor(ctx, input.planId, kind);
    if (row === undefined) return err('no_map_for_kind', { planId: input.planId, kind });
    snapshot[kind] = parseEntries(row).map(stripForTemplate);
  }

  const run = (): Result => {
    const id = ctx.ids.next('migtpl');
    ctx.store.db
      .prepare(
        `INSERT INTO migration_map_template
           (id, operator_ref, name, source_system, kinds, entries, created_in_workspace_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        ctx.actor,
        input.name,
        input.sourceSystem,
        JSON.stringify(kinds),
        JSON.stringify(snapshot),
        ctx.workspaceId,
        ctx.clock.now(),
      );
    return ok({ templateId: id });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'migration_save_map_template', run);
}

export function listMapTemplates(
  ctx: WorkspaceContext,
  rawInput: { sourceSystem?: unknown; kind?: unknown; savedViewId?: unknown },
): Result {
  if (rawInput.savedViewId !== undefined && typeof rawInput.savedViewId !== 'string') {
    return err('invalid_input', { field: 'savedViewId' });
  }
  // The G00 saved-view seam, one unconditional call like every other list verb (the F5 pattern):
  // a stored "Abacus-Vorlagen" filter (spec §6b) applies when only `savedViewId` is named, and an
  // explicit filter in the request wins over the stored one.
  const viewed = applySavedView(ctx, 'migration_map_template', {
    savedViewId: rawInput.savedViewId as string | undefined,
    sourceSystem: rawInput.sourceSystem,
    kind: rawInput.kind,
  });
  if (!viewed.ok) return viewed;
  const input: { sourceSystem?: unknown; kind?: unknown } = viewed.filter;
  if (input.sourceSystem !== undefined && typeof input.sourceSystem !== 'string') {
    return err('invalid_input', { field: 'sourceSystem' });
  }
  if (input.kind !== undefined && !isMapKind(input.kind)) {
    return err('invalid_map_kind', { kind: input.kind, allowed: [...MAP_KINDS] });
  }
  // OPERATOR-scoped on purpose, and on `operator_ref` ALONE: the whole point of a template is to
  // cross client workspaces (spec §4), and the §H-TENANT fence for this one table is content
  // (no client figures), not a workspace filter.
  const rows =
    typeof input.sourceSystem === 'string'
      ? (ctx.store.db
          .prepare(
            'SELECT id, operator_ref, name, source_system, kinds, entries, created_at, last_used_at FROM migration_map_template WHERE operator_ref = ? AND source_system = ? ORDER BY last_used_at DESC, created_at DESC',
          )
          .all(ctx.actor, input.sourceSystem) as TemplateRow[])
      : (ctx.store.db
          .prepare(
            'SELECT id, operator_ref, name, source_system, kinds, entries, created_at, last_used_at FROM migration_map_template WHERE operator_ref = ? ORDER BY last_used_at DESC, created_at DESC',
          )
          .all(ctx.actor) as TemplateRow[]);
  const templates = rows
    .map((r) => ({
      templateId: r.id,
      name: r.name,
      sourceSystem: r.source_system,
      kinds: JSON.parse(r.kinds) as string[],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }))
    .filter((t) => input.kind === undefined || t.kinds.includes(input.kind as string));
  return ok({ templates });
}

export function applyMapTemplate(
  ctx: WorkspaceContext,
  input: { planId: string; templateId: string; idempotencyKey: string },
): Result {
  const guard =
    requireString(input.planId, 'planId') ??
    requireString(input.templateId, 'templateId') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'migration_apply_map_template');
  if (replayed !== undefined) return replayed;

  const plan = planRow(ctx, input.planId);
  if (plan === undefined) return err('unknown_plan', { planId: input.planId });

  // The operator fence: another operator's template is simply not visible here, the same answer
  // `listMapTemplates` gives, so a guessed id leaks nothing.
  const template = ctx.store.db
    .prepare(
      'SELECT id, operator_ref, name, source_system, kinds, entries, created_at, last_used_at FROM migration_map_template WHERE id = ? AND operator_ref = ?',
    )
    .get(input.templateId, ctx.actor) as TemplateRow | undefined;
  if (template === undefined) return err('unknown_template', { templateId: input.templateId });

  const kinds = (JSON.parse(template.kinds) as string[]).filter(isMapKind);
  // The template-kind check (US-G10.5 error state): account and tax maps have no meaning on a
  // non-financial data class. NULL (the wave-1 seam state) passes vacuously; G09 owns the enum.
  if (plan.data_class !== null && !FINANCIAL_DATA_CLASSES.has(plan.data_class)) {
    const offending = kinds.find((k) => k === 'account' || k === 'tax');
    if (offending !== undefined) {
      return err('template_kind_mismatch', { kind: offending, dataClass: plan.data_class });
    }
  }

  const templateEntries = JSON.parse(template.entries) as Record<string, MapEntry[]>;

  const run = (): Result => {
    const applied: { kind: MapKind; source: string; target: string }[] = [];
    const unmatched: { kind: MapKind; source: string; target: string }[] = [];
    const fresh: { kind: MapKind; source: string }[] = [];
    const conflicts: { kind: MapKind; source: string; current: string; template: string }[] = [];
    const now = ctx.clock.now();

    for (const kind of kinds) {
      const fromTemplate = templateEntries[kind] ?? [];
      const row = mapRowFor(ctx, input.planId, kind);
      const existing = row === undefined ? [] : parseEntries(row);
      const byTemplateSource = new Map(fromTemplate.map((e) => [normalizeToken(e.source), e]));

      let merged: MapEntry[];
      if (existing.length === 0) {
        // No discovered entries yet: the template's own entry set pre-fills the map, each target
        // re-validated against THIS workspace (a template target the client's chart lacks lands in
        // `unmatched[]` and the entry arrives unset, never invalid).
        merged = fromTemplate.map((e) => {
          const target = e.target ?? null;
          if (target === null) return { ...e, target: null };
          const valid =
            kind === 'account' ? accountNumberExists(ctx, target)
            : kind === 'tax' ? taxCodeExists(ctx, target)
            : true;
          if (!valid) {
            unmatched.push({ kind, source: e.source, target });
            return { ...e, target: null, templateTarget: target };
          }
          applied.push({ kind, source: e.source, target });
          return { ...e, target, templateTarget: target };
        });
      } else {
        merged = existing.map((e) => {
          const hit = byTemplateSource.get(normalizeToken(e.source));
          if (hit === undefined || hit.target === null || hit.target === undefined) {
            fresh.push({ kind, source: e.source });
            return e;
          }
          const proposed = hit.target;
          const currentTarget = e.target ?? null;
          if (currentTarget !== null) {
            // NEVER overwrite a hand-set entry (spec §2 US-G10.5 boundary): the hand-set value
            // wins, and a differing proposal is surfaced instead of applied.
            if (currentTarget !== proposed) {
              conflicts.push({ kind, source: e.source, current: currentTarget, template: proposed });
              return { ...e, templateTarget: proposed };
            }
            return e;
          }
          const valid =
            kind === 'account' ? accountNumberExists(ctx, proposed)
            : kind === 'tax' ? taxCodeExists(ctx, proposed)
            : true;
          if (!valid) {
            unmatched.push({ kind, source: e.source, target: proposed });
            return { ...e, templateTarget: proposed };
          }
          applied.push({ kind, source: e.source, target: proposed });
          const filled: MapEntry = { ...e, target: proposed, templateTarget: proposed };
          if (kind === 'tax' && e.validFrom === undefined && hit.validFrom !== undefined) {
            return { ...filled, validFrom: hit.validFrom, ...(hit.validTo !== undefined ? { validTo: hit.validTo } : {}) };
          }
          return filled;
        });
      }

      ctx.store.db
        .prepare(
          `INSERT INTO migration_map (id, workspace_id, plan_id, kind, entries, rule_default, provenance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'saved_template', ?, ?)
           ON CONFLICT (plan_id, kind) DO UPDATE SET
             entries = excluded.entries,
             provenance = excluded.provenance,
             updated_at = excluded.updated_at`,
        )
        .run(ctx.ids.next('migmap'), ctx.workspaceId, input.planId, kind, JSON.stringify(merged), now, now);
    }

    ctx.store.db
      .prepare('UPDATE migration_map_template SET last_used_at = ? WHERE id = ?')
      .run(now, template.id);

    return ok({ applied, unmatched, new: fresh, conflicts });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'migration_apply_map_template', run);
}
