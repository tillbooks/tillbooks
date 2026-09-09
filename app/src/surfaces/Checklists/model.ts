/**
 * G22's read models for the Studio: the run summary (`checklist_list`), the run view (`checklist_get`)
 * and the period list (`vat_periods`). Every parser returns `null` on a shape it does not recognise
 * rather than coercing, because a row that reads "bestätigt" over a payload nobody could parse is the
 * defect family this repo keeps meeting. Nothing here derives a state: the engine derives every
 * status live and the surface renders the word for it.
 */

export type ItemStatus = 'open' | 'done' | 'skipped';
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
}

export interface RunView {
  runId: string;
  templateId: string;
  templateLabel: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: RunStatus;
  abandonReason: string | null;
  nextItemId: string | null;
  openCount: number;
  doneCount: number;
  skippedCount: number;
  itemCount: number;
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
const isStatus = (v: unknown): v is ItemStatus => v === 'open' || v === 'done' || v === 'skipped';
const isRunStatus = (v: unknown): v is RunStatus => v === 'open' || v === 'done' || v === 'abandoned';

function parseCheck(raw: unknown): CheckResultView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const key = str(c.key);
  if (key === null) return null;
  return { key, passed: typeof c.passed === 'boolean' ? c.passed : null, count: num(c.count) };
}

function parseSignoff(raw: unknown): SignoffView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const signoffId = str(s.signoffId);
  const kind = str(s.kind);
  const evidenceRef = str(s.evidenceRef);
  const createdAt = str(s.createdAt);
  if (signoffId === null || kind === null || evidenceRef === null || createdAt === null) return null;
  return { signoffId, kind, actorKind: str(s.actorKind) ?? 'unknown', actorName: str(s.actorName), evidenceRef, createdAt, stale: s.stale === true };
}

export function parseItem(raw: unknown): ItemView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const i = raw as Record<string, unknown>;
  const runItemId = str(i.runItemId);
  const itemId = str(i.itemId);
  const position = num(i.position);
  const title = str(i.title);
  const ownerKind = str(i.ownerKind);
  const evidenceKind = str(i.evidenceKind);
  if (runItemId === null || itemId === null || position === null || title === null || ownerKind === null || evidenceKind === null) return null;
  if (!isStatus(i.status)) return null;
  const evidence = typeof i.evidence === 'object' && i.evidence !== null ? (i.evidence as Record<string, unknown>) : null;
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
    requiresEvidenceRef: i.requiresEvidenceRef === true,
    prerequisiteItemIds: Array.isArray(i.prerequisiteItemIds) ? i.prerequisiteItemIds.filter((x): x is string => typeof x === 'string') : [],
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
  };
}

export function parseRun(body: unknown): RunView | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
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
    periodLabel,
    periodStart,
    periodEnd,
    status: b.status,
    abandonReason: str(b.abandonReason),
    nextItemId: str(b.nextItemId),
    openCount: num(b.openCount) ?? items.filter((i) => i.status === 'open').length,
    doneCount: num(b.doneCount) ?? items.filter((i) => i.status === 'done').length,
    skippedCount: num(b.skippedCount) ?? items.filter((i) => i.status === 'skipped').length,
    itemCount: num(b.itemCount) ?? items.length,
    items,
  };
}

export function parseRunList(body: unknown): RunSummary[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.runs)) return null;
  const out: RunSummary[] = [];
  for (const raw of b.runs) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
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
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.periods)) return null;
  const out: PeriodOption[] = [];
  for (const raw of b.periods) {
    if (typeof raw !== 'object' || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const label = str(p.label);
    const periodStart = str(p.periodStart);
    const periodEnd = str(p.periodEnd);
    if (label === null || periodStart === null || periodEnd === null) return null;
    out.push({ label, periodStart, periodEnd, filed: p.filed === true });
  }
  return out;
}

/** `2026-Q2` reads as `Q2/2026`, `2026-H1` as `H1/2026`: how a Swiss filer says a period. */
export function periodTitle(label: string): string {
  const m = /^(\d{4})-(Q[1-4]|H[12])$/.exec(label);
  return m === null ? label : `${m[2]}/${m[1]}`;
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

/** The engine's item id for the eCH-0217 export and the ePortal attestation, as the strip reads them. */
export const EXPORT_ITEM_ID = 'ech0217_exported';
export const ATTEST_ITEM_ID = 'eportal_filed';
export const VAT_PERIOD_TEMPLATE_ID = 'vat_period';
