/**
 * A15, Mahnwesen: the view model and the parsers between the engine's answers and the surface.
 *
 * Every figure rendered on the surface is the ENGINE's: nothing here computes money, levels, or
 * overdue days, it only narrows the wire shape and refuses what it does not recognise (a `null`
 * parse renders the error state, never a half-table). The parsers read exactly the fields the
 * engine sends; a field the engine renamed becomes a visible failure here rather than an
 * `undefined` rendered as blank.
 */

export const DUNNING_RUN_STATUSES = ['proposed', 'issued', 'sent'] as const;
export type DunningRunStatus = (typeof DUNNING_RUN_STATUSES)[number];

/** K-31 f2: the distinct cause a named invoice changed since the run was issued. */
export const DUNNING_ITEM_CHANGES = ['paid', 'partially_paid', 'cancelled', 'credited'] as const;
export type DunningItemChange = (typeof DUNNING_ITEM_CHANGES)[number];

function parseChange(value: unknown): DunningItemChange | null {
  return typeof value === 'string' && (DUNNING_ITEM_CHANGES as readonly string[]).includes(value)
    ? (value as DunningItemChange)
    : null;
}

export interface DunningLevelConfig {
  level: 1 | 2 | 3;
  daysOverdue: number;
  /**
   * The minimum days after the previous level's letter issued before this level is reached (K-60).
   * Level 1 is never interval-gated. Defaults to 10 for a config that predates the field.
   */
  minIntervalDays: number;
  /** A positive fee always BOOKS (C6: the letter demands exactly what books). */
  feeMinor: number;
  bookFee: boolean;
  feeIncomeAccountId: string | null;
  showInterest: boolean;
  interestBp: number;
  templateKey: string;
}

export interface DunningConfigView {
  levels: DunningLevelConfig[];
  configured: boolean;
  interestFloorBp: number;
}

export interface DunningItemView {
  documentId: string;
  debtorId: string;
  debtorName: string | null;
  number: string | null;
  level: number;
  currency: string;
  overdueMinor: number;
  /** The fee the POLICY charges at this level, frozen at issue. What the letter asked for may differ. */
  feeMinor: number;
  /**
   * D73's frozen demand: the fee THIS letter actually asks for, snapshotted at issue.
   *
   * It equals `feeMinor` exactly when the fee booked at issue, and stays 0 for a fee a period lock
   * deferred, even after the C8 recovery books it later. It is therefore the ONLY honest figure for
   * an issued run's fee column: `feeMinor` there would print a franc amount the debtor's letter
   * never mentions (critic N6).
   */
  demandedFeeMinor: number;
  /** True when the fee is on the ledger; a period-skipped fee is recorded but demanded by nothing. */
  feeBooked: boolean;
  interestMinor: number | null;
  daysOverdue: number;
  dueDate: string | null;
  sentAt: string | null;
  sendError: string | null;
  /**
   * K-31: the distinct cause this named invoice changed since the run was ISSUED, or null when it is
   * unchanged. The engine computes it as of today from the live OP-Liste, so the review table can
   * warn the operator BEFORE they manually mail or download a letter that names a paid, partially
   * paid, cancelled or credited invoice. The frozen figures are never rewritten (D73).
   */
  changeSinceIssue: DunningItemChange | null;
}

export interface DunningDebtorGroup {
  debtorId: string;
  debtorName: string | null;
  itemCount: number;
  maxLevel: number;
  totalsByCurrency: Record<string, number>;
  sent: boolean;
  sendError: string | null;
  /** K-31 f1: true when ANY invoice this letter names changed since issue, so the letter is held. */
  changedSinceIssue: boolean;
  /** The first changed invoice's distinct cause, for the per-letter warning; null when unchanged. */
  changeReason: DunningItemChange | null;
  /** Every invoice on this letter that changed since issue. */
  changedDocumentIds: string[];
}

export interface DunningRunView {
  runId: string;
  runDate: string;
  status: DunningRunStatus;
  feeEntryId: string | null;
  feeSkippedReason: string | null;
  /** C3: the member seat that proposed the run, from `dunning_run.created_by`. Null when unnamed. */
  createdBy: string | null;
  /** C3: when the run was proposed, from `dunning_run.created_at`. Null on a legacy row. */
  createdAt: string | null;
  issuedAt: string | null;
  sentAt: string | null;
  items: DunningItemView[];
  debtors: DunningDebtorGroup[];
}

export interface DunningRunSummary {
  runId: string;
  runDate: string;
  status: DunningRunStatus;
  itemCount: number;
  debtorCount: number;
  maxLevel: number;
  feeEntryId: string | null;
  feeSkippedReason: string | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isStatus(value: unknown): value is DunningRunStatus {
  return typeof value === 'string' && (DUNNING_RUN_STATUSES as readonly string[]).includes(value);
}

function parseLevel(value: unknown): DunningLevelConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const level = num(raw.level);
  const daysOverdue = num(raw.daysOverdue);
  const feeMinor = num(raw.feeMinor);
  const interestBp = num(raw.interestBp);
  if (level === null || daysOverdue === null || feeMinor === null || interestBp === null) return null;
  if (level !== 1 && level !== 2 && level !== 3) return null;
  // K-60: a response from before this field existed omits it; read it as the shipped default (10)
  // rather than rejecting the whole config.
  const minIntervalDays = num(raw.minIntervalDays) ?? 10;
  return {
    level,
    daysOverdue,
    minIntervalDays,
    feeMinor,
    bookFee: raw.bookFee === true,
    feeIncomeAccountId: str(raw.feeIncomeAccountId),
    showInterest: raw.showInterest === true,
    interestBp,
    templateKey: str(raw.templateKey) ?? 'standard',
  };
}

export function parseConfig(body: Record<string, unknown>): DunningConfigView | null {
  if (!Array.isArray(body.levels)) return null;
  const levels: DunningLevelConfig[] = [];
  for (const raw of body.levels) {
    const level = parseLevel(raw);
    if (level === null) return null;
    levels.push(level);
  }
  const interestFloorBp = num(body.interestFloorBp);
  if (levels.length !== 3 || interestFloorBp === null) return null;
  return { levels, configured: body.configured === true, interestFloorBp };
}

function parseItem(value: unknown): DunningItemView | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const documentId = str(raw.documentId);
  const debtorId = str(raw.debtorId);
  const level = num(raw.level);
  const currency = str(raw.currency);
  const overdueMinor = num(raw.overdueMinor);
  const feeMinor = num(raw.feeMinor);
  const demandedFeeMinor = num(raw.demandedFeeMinor);
  const daysOverdue = num(raw.daysOverdue);
  if (
    documentId === null ||
    debtorId === null ||
    level === null ||
    currency === null ||
    overdueMinor === null ||
    feeMinor === null ||
    demandedFeeMinor === null ||
    daysOverdue === null
  ) {
    return null;
  }
  return {
    documentId,
    debtorId,
    debtorName: str(raw.debtorName),
    number: str(raw.number),
    level,
    currency,
    overdueMinor,
    feeMinor,
    demandedFeeMinor,
    feeBooked: raw.feeBooked === true,
    interestMinor: num(raw.interestMinor),
    daysOverdue,
    dueDate: str(raw.dueDate),
    sentAt: str(raw.sentAt),
    sendError: str(raw.sendError),
    changeSinceIssue: parseChange(raw.changeSinceIssue),
  };
}

function parseGroup(value: unknown): DunningDebtorGroup | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const debtorId = str(raw.debtorId);
  const itemCount = num(raw.itemCount);
  const maxLevel = num(raw.maxLevel);
  if (debtorId === null || itemCount === null || maxLevel === null) return null;
  const totals = raw.totalsByCurrency;
  if (typeof totals !== 'object' || totals === null) return null;
  const totalsByCurrency: Record<string, number> = {};
  for (const [currency, amount] of Object.entries(totals as Record<string, unknown>)) {
    const minor = num(amount);
    if (minor === null) return null;
    totalsByCurrency[currency] = minor;
  }
  const changedDocumentIds = Array.isArray(raw.changedDocumentIds)
    ? raw.changedDocumentIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    debtorId,
    debtorName: str(raw.debtorName),
    itemCount,
    maxLevel,
    totalsByCurrency,
    sent: raw.sent === true,
    sendError: str(raw.sendError),
    changedSinceIssue: raw.changedSinceIssue === true,
    changeReason: parseChange(raw.changeReason),
    changedDocumentIds,
  };
}

export function parseRun(body: Record<string, unknown>): DunningRunView | null {
  const runId = str(body.runId);
  const runDate = str(body.runDate);
  if (runId === null || runDate === null || !isStatus(body.status)) return null;
  if (!Array.isArray(body.items) || !Array.isArray(body.debtors)) return null;
  const items: DunningItemView[] = [];
  for (const raw of body.items) {
    const item = parseItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  const debtors: DunningDebtorGroup[] = [];
  for (const raw of body.debtors) {
    const group = parseGroup(raw);
    if (group === null) return null;
    debtors.push(group);
  }
  return {
    runId,
    runDate,
    status: body.status,
    feeEntryId: str(body.feeEntryId),
    feeSkippedReason: str(body.feeSkippedReason),
    createdBy: str(body.createdBy),
    createdAt: str(body.createdAt),
    issuedAt: str(body.issuedAt),
    sentAt: str(body.sentAt),
    items,
    debtors,
  };
}

export function parseRuns(body: Record<string, unknown>): DunningRunSummary[] | null {
  if (!Array.isArray(body.runs)) return null;
  const runs: DunningRunSummary[] = [];
  for (const value of body.runs) {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as Record<string, unknown>;
    const runId = str(raw.runId);
    const runDate = str(raw.runDate);
    const itemCount = num(raw.itemCount);
    const debtorCount = num(raw.debtorCount);
    const maxLevel = num(raw.maxLevel);
    if (runId === null || runDate === null || !isStatus(raw.status)) return null;
    if (itemCount === null || debtorCount === null || maxLevel === null) return null;
    runs.push({
      runId,
      runDate,
      status: raw.status,
      itemCount,
      debtorCount,
      maxLevel,
      feeEntryId: str(raw.feeEntryId),
      feeSkippedReason: str(raw.feeSkippedReason),
    });
  }
  return runs;
}
