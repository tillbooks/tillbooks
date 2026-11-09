/**
 * G22's read models for the Studio: the run summary (`checklist_list`), the run view (`checklist_get`)
 * and the period list (`vat_periods`). Every parser returns `null` on a shape it does not recognise
 * rather than coercing, because a row that reads "bestätigt" over a payload nobody could parse is the
 * defect family this repo keeps meeting. Nothing here derives a state: the engine derives every
 * status live and the surface renders the word for it.
 *
 * Leg 2 (D129): the four new item kinds ride the same view. A `choice` carries its options and the
 * live answer with its source; a `preview` carries the read's payload and hash; a `posting` carries
 * the probe (what the ledger proved); a `validation` carries the figures, the formula key and the
 * result. `excluded` is derived by the engine and mirrored here (`ItemStatus`), never stored.
 */

import localEn from './messages.en.json';
import globalEn from '../../i18n/en.json';

/** Mirrors the engine's `CHECKLIST_DERIVED_ITEM_STATUSES` (runs.ts): the stored triple plus `excluded`, derived, never stored. */
export type ItemStatus = 'open' | 'done' | 'skipped' | 'excluded';
export type RunStatus = 'open' | 'done' | 'abandoned';

export interface CheckResultView {
  key: string;
  passed: boolean | null;
  count: number | null;
}

export interface SignoffView {
  signoffId: string;
  kind: string;
  actorKind: string;
  actorName: string | null;
  evidenceRef: string;
  createdAt: string;
  stale: boolean;
}

export interface ChoiceOptionView {
  id: string;
  labelKey: string;
  consequenceKey: string;
}

export interface ChoiceAnswerView {
  optionId: string;
  source: 'human' | 'derived';
}

export interface PreviewView {
  ok: boolean;
  hash: string | null;
  error: string | null;
  payload: Record<string, unknown> | null;
  empty: boolean;
  postedBelow: boolean;
}

export interface ProbeView {
  key: string;
  /** `true`: the artefact stands; `false`: none; `null`: the probe could not look (`reason`). */
  found: boolean | null;
  reason: string | null;
  entryIds: string[];
  reversalDate: string | null;
  detail: Record<string, unknown>;
}

export type ValidationOutcome = 'pass' | 'fail' | 'unavailable';

export interface ValidationView {
  key: string;
  result: ValidationOutcome;
  /** An i18n key: the formula text is copy, never engine text. */
  formula: string;
  figures: Record<string, unknown>;
  explanation: string;
  reason: string | null;
  hash: string;
}

export interface ItemView {
  runItemId: string;
  itemId: string;
  position: number;
  title: string;
  ownerKind: string;
  evidenceKind: string;
  check: string | null;
  precondition: string | null;
  verb: string | null;
  deepLink: string | null;
  signoffKind: string | null;
  requiresEvidenceRef: boolean;
  prerequisiteItemIds: string[];
  dueAt: string | null;
  undeletable: boolean;
  status: ItemStatus;
  stale: boolean;
  blockedBy: string | null;
  checkResult: CheckResultView | null;
  preconditionResult: CheckResultView | null;
  completedByKind: string | null;
  completedByName: string | null;
  completedAt: string | null;
  evidenceRef: string | null;
  signoff: SignoffView | null;
  skipReason: string | null;
  // Leg 2
  options: ChoiceOptionView[] | null;
  derive: string | null;
  defaultOptionId: string | null;
  choice: ChoiceAnswerView | null;
  verbInput: string | null;
  verbInputValue: string | null;
  reverseVerb: string | null;
  probe: string | null;
  previewOf: string | null;
  validation: string | null;
  severity: 'block' | 'warn' | null;
  fixLink: string | null;
  excludedBy: { itemId: string; optionId: string } | null;
  previewResult: PreviewView | null;
  probeResult: ProbeView | null;
  validationResult: ValidationView | null;
}

export interface RunView {
  runId: string;
  templateId: string;
  templateLabel: string;
  periodKind: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: RunStatus;
  createdBy: string | null;
  createdAt: string | null;
  abandonReason: string | null;
  nextItemId: string | null;
  openCount: number;
  doneCount: number;
  skippedCount: number;
  excludedCount: number;
  itemCount: number;
  anchorHash: string | null;
  items: ItemView[];
}

export interface RunSummary {
  runId: string;
  templateId: string;
  templateLabel: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: RunStatus;
  createdBy: string | null;
  nextItemId: string | null;
  openCount: number;
  doneCount: number;
  skippedCount: number;
  itemCount: number;
}

export interface PeriodOption {
  label: string;
  periodStart: string;
  periodEnd: string;
  filed: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isStatus = (v: unknown): v is ItemStatus => v === 'open' || v === 'done' || v === 'skipped' || v === 'excluded';
const isRunStatus = (v: unknown): v is RunStatus => v === 'open' || v === 'done' || v === 'abandoned';

function parseCheck(raw: unknown): CheckResultView | null {
  const c = rec(raw);
  if (c === null) return null;
  const key = str(c.key);
  if (key === null) return null;
  return { key, passed: typeof c.passed === 'boolean' ? c.passed : null, count: num(c.count) };
}

function parseSignoff(raw: unknown): SignoffView | null {
  const s = rec(raw);
  if (s === null) return null;
  const signoffId = str(s.signoffId);
  const kind = str(s.kind);
  const evidenceRef = str(s.evidenceRef);
  const createdAt = str(s.createdAt);
  if (signoffId === null || kind === null || evidenceRef === null || createdAt === null) return null;
  return { signoffId, kind, actorKind: str(s.actorKind) ?? 'unknown', actorName: str(s.actorName), evidenceRef, createdAt, stale: s.stale === true };
}

function parseOptions(raw: unknown): ChoiceOptionView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChoiceOptionView[] = [];
  for (const o of raw) {
    const r = rec(o);
    const id = r === null ? null : str(r.id);
    if (r === null || id === null) return null;
    out.push({ id, labelKey: str(r.labelKey) ?? `checklists.choice.${id}`, consequenceKey: str(r.consequenceKey) ?? `checklists.choice.${id}.consequence` });
  }
  return out;
}

function parseChoice(raw: unknown): ChoiceAnswerView | null {
  const c = rec(raw);
  if (c === null) return null;
  const optionId = str(c.optionId);
  if (optionId === null) return null;
  return { optionId, source: c.source === 'human' ? 'human' : 'derived' };
}

function parsePreview(raw: unknown): PreviewView | null {
  const p = rec(raw);
  if (p === null) return null;
  return { ok: p.ok === true, hash: str(p.hash), error: str(p.error), payload: rec(p.payload), empty: p.empty === true, postedBelow: p.postedBelow === true };
}

function parseProbe(raw: unknown): ProbeView | null {
  const p = rec(raw);
  if (p === null) return null;
  const key = str(p.key);
  if (key === null) return null;
  return {
    key,
    found: typeof p.found === 'boolean' ? p.found : null,
    reason: str(p.reason),
    entryIds: strs(p.entryIds),
    reversalDate: str(p.reversalDate),
    detail: rec(p.detail) ?? {},
  };
}

function parseValidation(raw: unknown): ValidationView | null {
  const v = rec(raw);
  if (v === null) return null;
  const key = str(v.key);
  const result = v.result;
  const hash = str(v.hash);
  if (key === null || hash === null || (result !== 'pass' && result !== 'fail' && result !== 'unavailable')) return null;
  return { key, result, formula: str(v.formula) ?? `checklists.validation.${key}.formula`, figures: rec(v.figures) ?? {}, explanation: str(v.explanation) ?? '', reason: str(v.reason), hash };
}

export function parseItem(raw: unknown): ItemView | null {
  const i = rec(raw);
  if (i === null) return null;
  const runItemId = str(i.runItemId);
  const itemId = str(i.itemId);
  const position = num(i.position);
  const title = str(i.title);
  const ownerKind = str(i.ownerKind);
  const evidenceKind = str(i.evidenceKind);
  if (runItemId === null || itemId === null || position === null || title === null || ownerKind === null || evidenceKind === null) return null;
  if (!isStatus(i.status)) return null;
  const evidence = rec(i.evidence);
  const excludedBy = rec(i.excludedBy);
  const severity = i.severity === 'block' || i.severity === 'warn' ? i.severity : null;
  return {
    runItemId,
    itemId,
    position,
    title,
    ownerKind,
    evidenceKind,
    check: str(i.check),
    precondition: str(i.precondition),
    verb: str(i.verb),
    deepLink: str(i.deepLink),
    signoffKind: str(i.signoffKind),
    requiresEvidenceRef: i.requiresEvidenceRef === true,
    prerequisiteItemIds: strs(i.prerequisiteItemIds),
    dueAt: str(i.dueAt),
    undeletable: i.undeletable === true,
    status: i.status,
    stale: i.stale === true,
    blockedBy: str(i.blockedBy),
    checkResult: parseCheck(i.checkResult),
    preconditionResult: parseCheck(i.preconditionResult),
    completedByKind: str(i.completedByKind),
    completedByName: str(i.completedByName),
    completedAt: str(i.completedAt),
    evidenceRef: evidence === null ? null : str(evidence.ref),
    signoff: parseSignoff(i.signoff),
    skipReason: str(i.skipReason),
    options: parseOptions(i.options),
    derive: str(i.derive),
    defaultOptionId: str(i.defaultOptionId),
    choice: parseChoice(i.choice),
    verbInput: str(i.verbInput),
    verbInputValue: str(i.verbInputValue),
    reverseVerb: str(i.reverseVerb),
    probe: str(i.probe),
    previewOf: str(i.previewOf),
    validation: str(i.validation),
    severity,
    fixLink: str(i.fixLink),
    excludedBy: excludedBy === null || str(excludedBy.itemId) === null || str(excludedBy.optionId) === null ? null : { itemId: excludedBy.itemId as string, optionId: excludedBy.optionId as string },
    previewResult: parsePreview(i.previewResult),
    probeResult: parseProbe(i.probeResult),
    validationResult: parseValidation(i.validationResult),
  };
}

export function parseRun(body: unknown): RunView | null {
  const b = rec(body);
  if (b === null) return null;
  const runId = str(b.runId);
  const templateId = str(b.templateId);
  const periodLabel = str(b.periodLabel);
  const periodStart = str(b.periodStart);
  const periodEnd = str(b.periodEnd);
  if (runId === null || templateId === null || periodLabel === null || periodStart === null || periodEnd === null) return null;
  if (!isRunStatus(b.status) || !Array.isArray(b.items)) return null;
  const items: ItemView[] = [];
  for (const raw of b.items) {
    const item = parseItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  return {
    runId,
    templateId,
    templateLabel: str(b.templateLabel) ?? templateId,
    periodKind: str(b.periodKind) ?? 'vat_period',
    periodLabel,
    periodStart,
    periodEnd,
    status: b.status,
    createdBy: str(b.createdBy),
    createdAt: str(b.createdAt),
    abandonReason: str(b.abandonReason),
    nextItemId: str(b.nextItemId),
    openCount: num(b.openCount) ?? items.filter((i) => i.status === 'open').length,
    doneCount: num(b.doneCount) ?? items.filter((i) => i.status === 'done').length,
    skippedCount: num(b.skippedCount) ?? items.filter((i) => i.status === 'skipped').length,
    excludedCount: num(b.excludedCount) ?? items.filter((i) => i.status === 'excluded').length,
    itemCount: num(b.itemCount) ?? items.length,
    anchorHash: str(b.anchorHash),
    items,
  };
}

export function parseRunList(body: unknown): RunSummary[] | null {
  const b = rec(body);
  if (b === null || !Array.isArray(b.runs)) return null;
  const out: RunSummary[] = [];
  for (const raw of b.runs) {
    const r = rec(raw);
    if (r === null) return null;
    const runId = str(r.runId);
    const templateId = str(r.templateId);
    const periodLabel = str(r.periodLabel);
    const periodStart = str(r.periodStart);
    const periodEnd = str(r.periodEnd);
    if (runId === null || templateId === null || periodLabel === null || periodStart === null || periodEnd === null || !isRunStatus(r.status)) return null;
    out.push({
      runId,
      templateId,
      templateLabel: str(r.templateLabel) ?? templateId,
      periodLabel,
      periodStart,
      periodEnd,
      status: r.status,
      createdBy: str(r.createdBy),
      nextItemId: str(r.nextItemId),
      openCount: num(r.openCount) ?? 0,
      doneCount: num(r.doneCount) ?? 0,
      skippedCount: num(r.skippedCount) ?? 0,
      itemCount: num(r.itemCount) ?? 0,
    });
  }
  return out;
}

export function parsePeriods(body: unknown): PeriodOption[] | null {
  const b = rec(body);
  if (b === null || !Array.isArray(b.periods)) return null;
  const out: PeriodOption[] = [];
  for (const raw of b.periods) {
    const p = rec(raw);
    if (p === null) return null;
    const label = str(p.label);
    const periodStart = str(p.periodStart);
    const periodEnd = str(p.periodEnd);
    if (label === null || periodStart === null || periodEnd === null) return null;
    out.push({ label, periodStart, periodEnd, filed: p.filed === true });
  }
  return out;
}

/**
 * `2026-Q2` reads as `Q2/2026`, `2026-H1` as `H1/2026` (how a Swiss filer says a period), `2026-06`
 * as `06/2026` (a month), and a bare year stays `2026`.
 */
export function periodTitle(label: string): string {
  const vat = /^(\d{4})-(Q[1-4]|H[12])$/.exec(label);
  if (vat !== null) return `${vat[2]}/${vat[1]}`;
  const month = /^(\d{4})-(\d{2})$/.exec(label);
  if (month !== null) return `${month[2]}/${month[1]}`;
  return label;
}

/** Today as an ISO day, in the operator's own timezone rather than UTC. */
export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** The last period that has ended, the Start dialog's default (row 1.1). */
export function lastEndedPeriod(periods: PeriodOption[], today: string): PeriodOption | null {
  const ended = periods.filter((p) => p.periodEnd < today);
  return ended[ended.length - 1] ?? null;
}

function endOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** The last `count` ended calendar months before `today`, newest first, as period options. */
export function lastEndedMonths(today: string, count: number): PeriodOption[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const out: PeriodOption[] = [];
  let year = y;
  let month = m - 1;
  for (let i = 0; i < count; i += 1) {
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    const label = `${year}-${String(month).padStart(2, '0')}`;
    out.push({ label, periodStart: `${label}-01`, periodEnd: endOfMonth(year, month), filed: false });
    month -= 1;
  }
  return out;
}

/**
 * The last `count` ended CALENDAR years before `today`, newest first. A workspace with a fiscal year
 * that does not start in January gets the engine's own bounds back on the run; the dialog only
 * offers the labels, and the engine refuses `period_not_ended` while a year is still running.
 */
export function lastEndedYears(today: string, count: number): PeriodOption[] {
  const y = Number(today.slice(0, 4));
  return Array.from({ length: count }, (_, i) => {
    const year = String(y - 1 - i);
    return { label: year, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, filed: false };
  });
}

/** The engine's item id for the eCH-0217 export and the ePortal attestation, as the strip reads them. */
export const EXPORT_ITEM_ID = 'ech0217_exported';
export const ATTEST_ITEM_ID = 'eportal_filed';
export const VAT_PERIOD_TEMPLATE_ID = 'vat_period';
export const MONTH_CLOSE_TEMPLATE_ID = 'month_close';
export const YEAR_CLOSE_TEMPLATE_ID = 'year_close';
/** The shipped templates in picker order (mirrors `CHECKLIST_TEMPLATES` in canon/index.ts). */
export const TEMPLATE_IDS = [VAT_PERIOD_TEMPLATE_ID, MONTH_CLOSE_TEMPLATE_ID, YEAR_CLOSE_TEMPLATE_ID] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
/** The seal of the year (`close_year`): no undo, the consequence sentence on the row and the confirm. */
export const SEAL_ITEM_ID = 'year_sealed';
/** The typed bank balance the Q7 fallback reads (spec §10.5 item 6a). */
export const BANK_TYPED_ITEM_ID = 'bank_balance_typed';

/**
 * The rows whose due date is a statutory rule, rendered "Frist" (the article in the tooltip); every
 * other date is product pacing and reads "empfohlen bis". Mirrors the `deadlineRule` fields of the
 * shipped templates, which `checklist_get` does not carry per item.
 */
export const STATUTORY_ITEMS: ReadonlySet<string> = new Set(['eportal_filed', 'period_locked', 'settlement_booked', 'vat_settled', 'umsatzabstimmung', 'berichtigung_filed', 'gv_approved', 'year_sealed']);

/** The prefix of a seeded auto-start rule id (`autostart.ts`); the run's `created_by` when a rule started it. */
const AUTOSTART_PREFIX = 'builtin:checklist_autostart:';

/** The template a seeded rule id was seeded for, or null when a person or an agent started the run. */
export function autostartTemplateOf(createdBy: string | null): string | null {
  if (createdBy === null || !createdBy.startsWith(AUTOSTART_PREFIX)) return null;
  const rest = createdBy.slice(AUTOSTART_PREFIX.length);
  const template = rest.split(':')[0];
  return template === undefined || template === '' ? null : template;
}

/**
 * Is `key` a catalogue key? The i18n `t()` logs a console error on a miss, and the row bodies resolve
 * labels that MAY be missing (a figure the engine added, a verb without a human label), so every such
 * lookup asks first and falls back silently. The en catalogues are the key sets (every locale mirrors
 * them, `test/guidance` and the i18n parity guard hold that).
 */
export function knownKey(key: string): boolean {
  const walk = (root: unknown): boolean => {
    let cursor: unknown = root;
    for (const part of key.split('.')) {
      if (typeof cursor !== 'object' || cursor === null || !(part in (cursor as Record<string, unknown>))) return false;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return typeof cursor === 'string';
  };
  return walk(localEn) || walk(globalEn);
}

/** The engine's `consequenceKey` (`checklists.choice.<x>.consequence`) as the catalogue spells it (`checklists.choiceConsequence.<x>`). */
export function consequenceKeyOf(labelKey: string): string {
  return labelKey.replace(/^checklists\.choice\./, 'checklists.choiceConsequence.');
}

/** The engine's formula key (`checklists.validation.<key>.formula`) as the catalogue spells it (`checklists.formula.<key>`). */
export function formulaKeyOf(validationKey: string): string {
  return `checklists.formula.${validationKey}`;
}

/** `Minor` figures a validation or a preview carries, rendered as money; everything else as text. */
export function isMinorKey(key: string): boolean {
  return /Minor$/.test(key);
}
