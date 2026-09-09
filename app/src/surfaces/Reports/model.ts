/**
 * The A08 read-model types and the pure helpers the Auswertungen surface renders through.
 *
 * NOTHING HERE IS INVENTED. Every field below appears in the recordings under this directory, and
 * `test/reports/studio-reports-fixture.test.mjs` pins those recordings to the live engine VALUE for
 * value, asserts the key set exactly, and asserts the ABSENCE of the four fields a statement surface
 * would be tempted to read. That pairing is what stops the defect family this repo has shipped six
 * times, "the Studio assumed a shape the engine never sends".
 *
 * THREE FIELDS THE DESIGN CHECKED FOR AND DID NOT FIND, each of which changed a control:
 *
 *  - `entryId` is on the Kontoblatt line and NOWHERE ELSE. A08 §4 says every read model returns
 *    "entryIds for drill-down"; only `computeGeneralLedger` does. So a Saldenbilanz row drills to an
 *    ACCOUNT (its Kontoblatt), which is the honest one-hop path, and the types below make the wrong
 *    one a compile error rather than a runtime `undefined` in a URL.
 *  - A KMU class header has `debitMinor`, `creditMinor` and `closingMinor` and NO `openingMinor`
 *    (finding F6), so the header's Eröffnung cell renders a dash. A computed fourth figure would be
 *    the browser doing arithmetic on money.
 *  - A section subtotal has `compareSubtotalMinor` and NO `deltaMinor` (finding F4), so the Δ cell is
 *    blank there. Two exact integers subtract exactly and this is still stricter than it needs to be,
 *    deliberately: no displayed money figure on this surface is computed in the GUI.
 *
 * THE PARSERS ARE STRICT ON PURPOSE. A missing figure becomes `null` and the surface renders its
 * error state rather than a plausible zero. On a financial statement a plausible number is the most
 * expensive kind of wrong, which is why `CHF 0.00` never stands in for an unavailable figure here.
 *
 * THE ONLY ARITHMETIC IN THIS FILE IS CALENDAR ARITHMETIC. Adding a year to a date is not money;
 * multiplying an amount is. Every figure the surface prints comes off the wire.
 */

/** The four tabs, which are also the engine's four `STATEMENT_KINDS`. */
export type ReportTab = 'trial' | 'balance' | 'income' | 'ledger';

export const REPORT_TABS: readonly ReportTab[] = ['trial', 'balance', 'income', 'ledger'];

/** The MCP verb behind each tab, so a loading test can name the read it is waiting for. */
export const VERB_FOR_TAB: Readonly<Record<ReportTab, string>> = {
  trial: 'trial_balance',
  balance: 'balance_sheet',
  income: 'income_statement',
  ledger: 'general_ledger',
};

/** The comparison presets (R-S7, G13 adds `archive`). Never two date fields: see the F3 note. */
export type ComparePreset = 'none' | 'period' | 'year' | 'archive';

export const COMPARE_PRESETS: readonly ComparePreset[] = ['none', 'period', 'year', 'archive'];

/**
 * G13: the Vorsystem comparative's label object, present whenever `compareTo.source:'archive'` was
 * asked. THE LABEL IS THE PROPERTY (spec §6 safeguard 5): the column header renders the system and
 * covered range from here, and `partial` / `no_data` means every compare figure is ABSENT, so the
 * cells render a dash with the reason, never a zero.
 */
export interface Comparative {
  source: 'archive';
  status: 'ok' | 'partial' | 'no_data';
  system: string | null;
  coveredFrom: string | null;
  coveredTo: string | null;
  unlistedNetMinor?: number;
}

/** The statutory headings the engine ships in four languages. Never re-typed in a message file. */
export interface SectionLabels {
  de: string;
  fr: string;
  it: string;
  en: string;
}

/** The account identity every account-backed line carries, so a drill needs no second read. */
export interface AccountRef {
  id: string;
  number: string;
  name: string;
  type: string;
}

export interface TrialBalanceRow {
  account: AccountRef;
  kmuClass: string;
  openingMinor: number;
  debitMinor: number;
  creditMinor: number;
  closingMinor: number;
  /** Present only with a comparison. A CUMULATIVE closing balance at the compare date, not a period. */
  compareClosingMinor?: number;
  deltaMinor?: number;
}

/** One KMU-class bucket, exactly as `groupByKmuClass` returns it. No `openingMinor` (F6). */
export interface KmuGroup {
  key: string;
  labels: SectionLabels;
  accounts: string[];
  debitMinor: number;
  creditMinor: number;
  closingMinor: number;
}

export interface TrialBalanceView {
  /** G13: present when the comparison was drawn from the prior-system archive. */
  comparative?: Comparative;
  period: { start: string; end: string };
  compareTo?: { start: string; end: string };
  baseCurrency: string;
  rows: TrialBalanceRow[];
  groups: KmuGroup[];
  totals: { openingMinor: number; debitMinor: number; creditMinor: number; closingMinor: number };
  noActivity: boolean;
  reconciles: boolean;
  reconciliation: Record<string, boolean>;
}

export interface BalanceSheetLine {
  key: string;
  /** `null` on the two computed equity positions, deliberately: they are not posted to an account. */
  account: AccountRef | null;
  /** Present only on a computed line, which renders its statutory position name instead of a number. */
  labels?: SectionLabels;
  cite?: string;
  balanceMinor: number;
  compareBalanceMinor?: number;
  deltaMinor?: number;
}

export interface BalanceSheetSection {
  key: string;
  side: 'aktiven' | 'passiven';
  labels: SectionLabels;
  cite: string;
  lines: BalanceSheetLine[];
  subtotalMinor: number;
  compareSubtotalMinor?: number;
}

export interface BalanceSheetView {
  /** G13: present when the comparison was drawn from the prior-system archive. */
  comparative?: Comparative;
  asOf: string;
  compareTo?: string;
  baseCurrency: string;
  sections: BalanceSheetSection[];
  aktivenMinor: number;
  passivenMinor: number;
  compareAktivenMinor?: number;
  comparePassivenMinor?: number;
  noActivity: boolean;
  reconciles: boolean;
  reconciliation: Record<string, boolean>;
}

export interface IncomeLine {
  key: string;
  account: AccountRef;
  amountMinor: number;
  compareAmountMinor?: number;
  deltaMinor?: number;
}

export interface IncomeSection {
  key: string;
  nature: 'revenue' | 'expense' | 'mixed';
  labels: SectionLabels;
  cite: string;
  lines: IncomeLine[];
  subtotalMinor: number;
  compareSubtotalMinor?: number;
}

export interface IncomeStatementView {
  /** G13: present when the comparison was drawn from the prior-system archive. */
  comparative?: Comparative;
  period: { start: string; end: string };
  compareTo?: { start: string; end: string };
  baseCurrency: string;
  sections: IncomeSection[];
  reingewinnMinor: number;
  compareReingewinnMinor?: number;
  noActivity: boolean;
  reconciles: boolean;
  reconciliation: Record<string, boolean>;
}

/** The ONE object in A08 that reaches a single journal entry. */
export interface LedgerLine {
  date: string;
  entryId: string;
  ref: string | null;
  description: string | null;
  source: string;
  debitMinor: number;
  creditMinor: number;
  runningMinor: number;
}

export interface GeneralLedgerView {
  account: AccountRef;
  /** Which way this account is expected to lean. Used for the explainer, never rendered raw. */
  naturalSide: 'debit' | 'credit';
  period: { start: string; end: string };
  baseCurrency: string;
  kmuClass: string;
  openingMinor: number;
  lines: LedgerLine[];
  closingMinor: number;
  noActivity: boolean;
  reconciles: boolean;
  reconciliation: Record<string, boolean>;
}

/** One chart row as `list_accounts` returns it, for R-S6. */
export interface PickerAccount {
  id: string;
  number: string;
  name: string;
  archived: boolean;
}

/** What `export_statement` hands back. It writes no file: the browser saves these bytes. */
export interface ExportArtifact {
  kind: string;
  format: string;
  filename: string;
  mediaType: string;
  byteLength: number;
  base64: string;
  reconciles?: boolean;
  /** `null` on a PDF, ABSENT on a CSV. Never upgraded into an archival claim by the surface. */
  pdfaProfile?: null;
}

// --- strict narrowing ------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function optionalNum(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return num(value);
}

function labels(value: unknown): SectionLabels | null {
  if (!isRecord(value)) return null;
  const de = str(value.de);
  const fr = str(value.fr);
  const it = str(value.it);
  const en = str(value.en);
  if (de === null || fr === null || it === null || en === null) return null;
  return { de, fr, it, en };
}

function accountRef(value: unknown): AccountRef | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const number = str(value.number);
  const name = str(value.name);
  const type = str(value.type);
  if (id === null || number === null || name === null || type === null) return null;
  return { id, number, name, type };
}

/** A `{start, end}` window as the three period reports echo it back. */
function window(value: unknown): { start: string; end: string } | null {
  if (!isRecord(value)) return null;
  const start = str(value.start);
  const end = str(value.end);
  if (start === null || end === null) return null;
  return { start, end };
}

/** A `Record<string, boolean>` of named checks, or null if any member is not a boolean. */
function checks(value: unknown): Record<string, boolean> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'boolean') return null;
    out[key] = raw;
  }
  return Object.keys(out).length === 0 ? null : out;
}


/** G13: parse the comparative label. Absent stays absent; a malformed one fails the whole parse. */
function comparative(raw: unknown): Comparative | null | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  if (raw.source !== 'archive') return null;
  const status = raw.status;
  if (status !== 'ok' && status !== 'partial' && status !== 'no_data') return null;
  const system = raw.system === null ? null : str(raw.system);
  const coveredFrom = raw.coveredFrom === null || raw.coveredFrom === undefined ? null : str(raw.coveredFrom);
  const coveredTo = raw.coveredTo === null || raw.coveredTo === undefined ? null : str(raw.coveredTo);
  if (system === null && raw.system !== null) return null;
  const unlistedNetMinor = optionalNum(raw.unlistedNetMinor);
  if (coveredFrom === null && raw.coveredFrom !== null && raw.coveredFrom !== undefined) return null;
  if (coveredTo === null && raw.coveredTo !== null && raw.coveredTo !== undefined) return null;
  if (unlistedNetMinor === null) return null;
  return {
    source: 'archive',
    status,
    system,
    coveredFrom,
    coveredTo,
    ...(unlistedNetMinor === undefined ? {} : { unlistedNetMinor }),
  };
}

export function parseTrialBalance(body: Record<string, unknown>): TrialBalanceView | null {
  const period = window(body.period);
  const baseCurrency = str(body.baseCurrency);
  const reconciliation = checks(body.reconciliation);
  const totalsRaw = isRecord(body.totals) ? body.totals : null;
  if (period === null || baseCurrency === null || reconciliation === null || totalsRaw === null) return null;
  if (typeof body.noActivity !== 'boolean' || typeof body.reconciles !== 'boolean') return null;

  const openingMinor = num(totalsRaw.openingMinor);
  const debitMinor = num(totalsRaw.debitMinor);
  const creditMinor = num(totalsRaw.creditMinor);
  const closingMinor = num(totalsRaw.closingMinor);
  if (openingMinor === null || debitMinor === null || creditMinor === null || closingMinor === null) {
    return null;
  }

  if (!Array.isArray(body.rows) || !Array.isArray(body.groups)) return null;
  const rows: TrialBalanceRow[] = [];
  for (const raw of body.rows) {
    if (!isRecord(raw)) return null;
    const account = accountRef(raw.account);
    const kmuClass = str(raw.kmuClass);
    const opening = num(raw.openingMinor);
    const debit = num(raw.debitMinor);
    const credit = num(raw.creditMinor);
    const closing = num(raw.closingMinor);
    const compareClosingMinor = optionalNum(raw.compareClosingMinor);
    const deltaMinor = optionalNum(raw.deltaMinor);
    if (account === null || kmuClass === null) return null;
    if (opening === null || debit === null || credit === null || closing === null) return null;
    if (compareClosingMinor === null || deltaMinor === null) return null;
    rows.push({
      account,
      kmuClass,
      openingMinor: opening,
      debitMinor: debit,
      creditMinor: credit,
      closingMinor: closing,
      ...(compareClosingMinor === undefined ? {} : { compareClosingMinor }),
      ...(deltaMinor === undefined ? {} : { deltaMinor }),
    });
  }

  const groups: KmuGroup[] = [];
  for (const raw of body.groups) {
    if (!isRecord(raw)) return null;
    const key = str(raw.key);
    const groupLabels = labels(raw.labels);
    const debit = num(raw.debitMinor);
    const credit = num(raw.creditMinor);
    const closing = num(raw.closingMinor);
    if (key === null || groupLabels === null) return null;
    if (debit === null || credit === null || closing === null) return null;
    if (!Array.isArray(raw.accounts)) return null;
    const accounts: string[] = [];
    for (const account of raw.accounts) {
      const number = str(account);
      if (number === null) return null;
      accounts.push(number);
    }
    groups.push({ key, labels: groupLabels, accounts, debitMinor: debit, creditMinor: credit, closingMinor: closing });
  }

  const compareTo = body.compareTo === undefined ? undefined : window(body.compareTo);
  if (compareTo === null) return null;
  const cmp = comparative(body.comparative);
  if (cmp === null) return null;

  return {
    period,
    ...(compareTo === undefined ? {} : { compareTo }),
    ...(cmp === undefined ? {} : { comparative: cmp }),
    baseCurrency,
    rows,
    groups,
    totals: { openingMinor, debitMinor, creditMinor, closingMinor },
    noActivity: body.noActivity,
    reconciles: body.reconciles,
    reconciliation,
  };
}

export function parseBalanceSheet(body: Record<string, unknown>): BalanceSheetView | null {
  const asOf = str(body.asOf);
  const baseCurrency = str(body.baseCurrency);
  const aktivenMinor = num(body.aktivenMinor);
  const passivenMinor = num(body.passivenMinor);
  const reconciliation = checks(body.reconciliation);
  const compareTo = body.compareTo === undefined ? undefined : str(body.compareTo);
  const compareAktivenMinor = optionalNum(body.compareAktivenMinor);
  const comparePassivenMinor = optionalNum(body.comparePassivenMinor);
  if (asOf === null || baseCurrency === null || reconciliation === null) return null;
  if (aktivenMinor === null || passivenMinor === null || compareTo === null) return null;
  if (compareAktivenMinor === null || comparePassivenMinor === null) return null;
  if (typeof body.noActivity !== 'boolean' || typeof body.reconciles !== 'boolean') return null;
  if (!Array.isArray(body.sections)) return null;

  const sections: BalanceSheetSection[] = [];
  for (const raw of body.sections) {
    if (!isRecord(raw)) return null;
    const key = str(raw.key);
    const side = str(raw.side);
    const sectionLabels = labels(raw.labels);
    const cite = str(raw.cite);
    const subtotalMinor = num(raw.subtotalMinor);
    const compareSubtotalMinor = optionalNum(raw.compareSubtotalMinor);
    if (key === null || sectionLabels === null || cite === null || subtotalMinor === null) return null;
    if (side !== 'aktiven' && side !== 'passiven') return null;
    if (compareSubtotalMinor === null) return null;
    if (!Array.isArray(raw.lines)) return null;

    const lines: BalanceSheetLine[] = [];
    for (const rawLine of raw.lines) {
      if (!isRecord(rawLine)) return null;
      const lineKey = str(rawLine.key);
      const balanceMinor = num(rawLine.balanceMinor);
      const compareBalanceMinor = optionalNum(rawLine.compareBalanceMinor);
      const deltaMinor = optionalNum(rawLine.deltaMinor);
      if (lineKey === null || balanceMinor === null) return null;
      if (compareBalanceMinor === null || deltaMinor === null) return null;
      // `account: null` is the whole of R29 and must survive the parse as a null, never as a miss.
      const account = rawLine.account === null ? null : accountRef(rawLine.account);
      if (account === null && rawLine.account !== null) return null;
      const lineLabels = rawLine.labels === undefined ? undefined : labels(rawLine.labels);
      if (lineLabels === null) return null;
      const lineCite = rawLine.cite === undefined ? undefined : str(rawLine.cite);
      if (lineCite === null) return null;
      lines.push({
        key: lineKey,
        account,
        ...(lineLabels === undefined ? {} : { labels: lineLabels }),
        ...(lineCite === undefined ? {} : { cite: lineCite }),
        balanceMinor,
        ...(compareBalanceMinor === undefined ? {} : { compareBalanceMinor }),
        ...(deltaMinor === undefined ? {} : { deltaMinor }),
      });
    }

    sections.push({
      key,
      side,
      labels: sectionLabels,
      cite,
      lines,
      subtotalMinor,
      ...(compareSubtotalMinor === undefined ? {} : { compareSubtotalMinor }),
    });
  }

  const cmpB = comparative(body.comparative);
  if (cmpB === null) return null;
  return {
    asOf,
    ...(compareTo === undefined ? {} : { compareTo }),
    ...(cmpB === undefined ? {} : { comparative: cmpB }),
    baseCurrency,
    sections,
    aktivenMinor,
    passivenMinor,
    ...(compareAktivenMinor === undefined ? {} : { compareAktivenMinor }),
    ...(comparePassivenMinor === undefined ? {} : { comparePassivenMinor }),
    noActivity: body.noActivity,
    reconciles: body.reconciles,
    reconciliation,
  };
}

export function parseIncomeStatement(body: Record<string, unknown>): IncomeStatementView | null {
  const period = window(body.period);
  const baseCurrency = str(body.baseCurrency);
  const reingewinnMinor = num(body.reingewinnMinor);
  const reconciliation = checks(body.reconciliation);
  const compareTo = body.compareTo === undefined ? undefined : window(body.compareTo);
  const compareReingewinnMinor = optionalNum(body.compareReingewinnMinor);
  if (period === null || baseCurrency === null || reingewinnMinor === null) return null;
  if (reconciliation === null || compareTo === null || compareReingewinnMinor === null) return null;
  if (typeof body.noActivity !== 'boolean' || typeof body.reconciles !== 'boolean') return null;
  if (!Array.isArray(body.sections)) return null;

  const sections: IncomeSection[] = [];
  for (const raw of body.sections) {
    if (!isRecord(raw)) return null;
    const key = str(raw.key);
    const nature = str(raw.nature);
    const sectionLabels = labels(raw.labels);
    const cite = str(raw.cite);
    const subtotalMinor = num(raw.subtotalMinor);
    const compareSubtotalMinor = optionalNum(raw.compareSubtotalMinor);
    if (key === null || sectionLabels === null || cite === null || subtotalMinor === null) return null;
    if (nature !== 'revenue' && nature !== 'expense' && nature !== 'mixed') return null;
    if (compareSubtotalMinor === null) return null;
    if (!Array.isArray(raw.lines)) return null;

    const lines: IncomeLine[] = [];
    for (const rawLine of raw.lines) {
      if (!isRecord(rawLine)) return null;
      const lineKey = str(rawLine.key);
      const account = accountRef(rawLine.account);
      const amountMinor = num(rawLine.amountMinor);
      const compareAmountMinor = optionalNum(rawLine.compareAmountMinor);
      const deltaMinor = optionalNum(rawLine.deltaMinor);
      if (lineKey === null || account === null || amountMinor === null) return null;
      if (compareAmountMinor === null || deltaMinor === null) return null;
      lines.push({
        key: lineKey,
        account,
        amountMinor,
        ...(compareAmountMinor === undefined ? {} : { compareAmountMinor }),
        ...(deltaMinor === undefined ? {} : { deltaMinor }),
      });
    }

    sections.push({
      key,
      nature,
      labels: sectionLabels,
      cite,
      lines,
      subtotalMinor,
      ...(compareSubtotalMinor === undefined ? {} : { compareSubtotalMinor }),
    });
  }

  const cmpI = comparative(body.comparative);
  if (cmpI === null) return null;
  return {
    period,
    ...(compareTo === undefined ? {} : { compareTo }),
    ...(cmpI === undefined ? {} : { comparative: cmpI }),
    baseCurrency,
    sections,
    reingewinnMinor,
    ...(compareReingewinnMinor === undefined ? {} : { compareReingewinnMinor }),
    noActivity: body.noActivity,
    reconciles: body.reconciles,
    reconciliation,
  };
}

export function parseGeneralLedger(body: Record<string, unknown>): GeneralLedgerView | null {
  const account = accountRef(body.account);
  const naturalSide = str(body.naturalSide);
  const period = window(body.period);
  const baseCurrency = str(body.baseCurrency);
  const kmuClass = str(body.kmuClass);
  const openingMinor = num(body.openingMinor);
  const closingMinor = num(body.closingMinor);
  const reconciliation = checks(body.reconciliation);
  if (account === null || period === null || baseCurrency === null || kmuClass === null) return null;
  if (naturalSide !== 'debit' && naturalSide !== 'credit') return null;
  if (openingMinor === null || closingMinor === null || reconciliation === null) return null;
  if (typeof body.noActivity !== 'boolean' || typeof body.reconciles !== 'boolean') return null;
  if (!Array.isArray(body.lines)) return null;

  const lines: LedgerLine[] = [];
  for (const raw of body.lines) {
    if (!isRecord(raw)) return null;
    const date = str(raw.date);
    const entryId = str(raw.entryId);
    const source = str(raw.source);
    const ref = nullableStr(raw.ref);
    const description = nullableStr(raw.description);
    const debitMinor = num(raw.debitMinor);
    const creditMinor = num(raw.creditMinor);
    const runningMinor = num(raw.runningMinor);
    if (date === null || entryId === null || source === null) return null;
    if (ref === undefined || description === undefined) return null;
    if (debitMinor === null || creditMinor === null || runningMinor === null) return null;
    lines.push({ date, entryId, ref, description, source, debitMinor, creditMinor, runningMinor });
  }

  return {
    account,
    naturalSide,
    period,
    baseCurrency,
    kmuClass,
    openingMinor,
    lines,
    closingMinor,
    noActivity: body.noActivity,
    reconciles: body.reconciles,
    reconciliation,
  };
}

/** `list_accounts` reduced to what the picker shows: a number, a name and whether it is archived. */
export function parsePickerAccounts(body: Record<string, unknown>): PickerAccount[] | null {
  if (!Array.isArray(body.accounts)) return null;
  const out: PickerAccount[] = [];
  for (const raw of body.accounts) {
    if (!isRecord(raw)) return null;
    const id = str(raw.id);
    const number = str(raw.number);
    const name = str(raw.name);
    if (id === null || number === null || name === null) return null;
    if (typeof raw.archived !== 'boolean') return null;
    out.push({ id, number, name, archived: raw.archived });
  }
  return out;
}

export function parseArtifact(body: Record<string, unknown>): ExportArtifact | null {
  if (!isRecord(body.artifact)) return null;
  const raw = body.artifact;
  const kind = str(raw.kind);
  const format = str(raw.format);
  const filename = str(raw.filename);
  const mediaType = str(raw.mediaType);
  const byteLength = num(raw.byteLength);
  const base64 = str(raw.base64);
  if (kind === null || format === null || filename === null) return null;
  if (mediaType === null || byteLength === null || base64 === null) return null;
  return {
    kind,
    format,
    filename,
    mediaType,
    byteLength,
    base64,
    ...(typeof raw.reconciles === 'boolean' ? { reconciles: raw.reconciles } : {}),
  };
}

// --- calendar arithmetic, and nothing else ----------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a string is a real calendar day, so a hand-edited URL never reaches the engine (R16). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The same calendar day one year earlier. 29 February lands on 28 February, as the engine's would. */
function yearBefore(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  const earlier = `${String(Number(year) - 1)}-${month}-${day}`;
  return isIsoDate(earlier) ? earlier : shiftDays(isoDate, -365);
}

export function dayBefore(isoDate: string): string {
  return shiftDays(isoDate, -1);
}

/** Today as an ISO date. Used for the default period end, never for a figure. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The default reporting window: the current FISCAL year to date.
 *
 * `fiscalYearStart` is the workspace's own `MM-DD` from `get_company_profile`, never hardcoded to
 * 01-01. A workspace whose year starts in July would otherwise open every report on a window that
 * means nothing to it, and the figure on screen would be right about a period nobody asked for.
 */
export function defaultPeriod(fiscalYearStart: string, today: string = todayIso()): { from: string; to: string } {
  const monthDay = /^\d{2}-\d{2}$/.test(fiscalYearStart) ? fiscalYearStart : '01-01';
  const year = Number(today.slice(0, 4));
  const startThisYear = `${String(year)}-${monthDay}`;
  const from = today >= startThisYear ? startThisYear : `${String(year - 1)}-${monthDay}`;
  return { from, to: today };
}

/**
 * The comparison window a preset produces for the two PERIOD statements.
 *
 * "Vorperiode" is the window of equal length immediately before; "Vorjahr" is the same window one
 * year earlier. On the Saldenbilanz the engine reads only `periodEnd` and computes a cumulative
 * closing balance at it (finding F3), which is exactly why this is a preset and not two fields: an
 * operator typing a start date here would be typing a value the engine discards.
 */
export function comparePeriodFor(
  preset: ComparePreset,
  from: string,
  to: string,
): { periodStart: string; periodEnd: string } | null {
  if (preset === 'none') return null;
  // G13's `archive` preset compares the SAME window one year earlier, drawn from the prior-system
  // archive rather than the live ledger; the source flag rides separately (`compareSourceFor`).
  if (preset === 'year' || preset === 'archive') return { periodStart: yearBefore(from), periodEnd: yearBefore(to) };
  const periodEnd = dayBefore(from);
  const lengthDays = Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000,
  );
  return { periodStart: shiftDays(periodEnd, -lengthDays), periodEnd };
}

/** The comparison DATE a preset produces for the Bilanz, whose `compareTo` is one `asOf`. */
export function compareAsOfFor(preset: ComparePreset, from: string, asOf: string): string | null {
  if (preset === 'none') return null;
  return preset === 'year' || preset === 'archive' ? yearBefore(asOf) : dayBefore(from);
}

/** G13: the `compareTo.source` value a preset asks for, or undefined for the live default. */
export function compareSourceFor(preset: ComparePreset): 'archive' | undefined {
  return preset === 'archive' ? 'archive' : undefined;
}

/** The preset a URL parameter names, defaulting to no comparison rather than to a guess. */
export function comparePresetFrom(value: string | null): ComparePreset {
  return value === 'period' || value === 'year' || value === 'archive' ? value : 'none';
}

/** The tab a URL parameter names. Absent means the Saldenbilanz, never a second value. */
export function tabFrom(value: string | null): ReportTab {
  return REPORT_TABS.includes(value as ReportTab) ? (value as ReportTab) : 'trial';
}

// --- vocabulary, so no raw key ever reaches the screen ------------------------------------------------

/**
 * The i18n key for a Kontoblatt line's `source`, or null for `manual`.
 *
 * `manual` renders as NOTHING: it is the default, and a column reading "Manuell" 240 times is noise
 * rather than information. `close` is the one that matters and renders as **Abschluss**, because the
 * engine keeps the column "precisely so a close line is identifiable on sight".
 */
export function sourceLabelKey(source: string): string | null {
  if (source === 'manual' || source === '') return null;
  return `reports.source.${source}`;
}

/** Whether the period contains a year-end close, which is what the closed-year note turns on. */
export function hasCloseEntry(lines: readonly LedgerLine[]): boolean {
  return lines.some((line) => line.source === 'close');
}

/**
 * The named checks that came back FALSE, in the engine's own key order.
 *
 * R-S9 names WHICH check failed rather than reporting one badge, because a Bilanz whose Aktiven and
 * Passiven differ is a bucketing bug in the report and a Bilanz whose ledger does not net to zero is
 * a corrupt database. The engine says so explicitly and the two need different sentences.
 */
export function failedChecks(reconciliation: Record<string, boolean>): string[] {
  return Object.entries(reconciliation)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
}

/** The copy key for one failing check. Every check the four verbs can return has one. */
export function mismatchKey(check: string): string {
  return `reports.mismatch.${check}`;
}

/** The passing sentence differs per report, because the checks do. Never a verdict on correctness. */
export function reconciledKey(tab: ReportTab): string {
  if (tab === 'balance') return 'reports.reconciled.balance';
  if (tab === 'ledger') return 'reports.reconciled.ledger';
  return 'reports.reconciled.trial';
}

/** Decode the engine's base64 artifact into a Blob the browser can save under the engine's name. */
export function artifactBlob(artifact: ExportArtifact): Blob {
  const binary = atob(artifact.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: artifact.mediaType });
}
