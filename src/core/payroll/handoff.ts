/**
 * A34, payroll hand-off boundary. The engine (Pattern P1: pure `(ctx, input) -> Result` verbs).
 *
 * TILL NEVER CALCULATES A WAGE (00-README cloud boundary; E02 §3). This capability is the seam
 * AROUND that decision and nothing more: one export hands an external payroll provider the employee
 * master (and the mutations since the last export), and one mapped, previewed posting puts the
 * month's externally-computed aggregate wage journal into the ledger through A02. A18/A20/A21 then
 * pay and reconcile the net wages exactly as they already do.
 *
 * TWO WRITES AND ONE READ (D22, composed verbs):
 *   - `payrollHandoffExport` produces a LOCAL artifact (OP4: nothing transmits) and records the
 *     export event. AHV inclusion is CAPABILITY-DERIVED (`hr.sensitive`), never parameter-derived,
 *     and its absence is stated in the artifact, never silent (revDSG Art. 6 minimisation, the E02
 *     produced-without-and-says-so rule).
 *   - `wageJournalPost` is THE ONE POSTING in this lane. It builds ONE balanced A02 payload from
 *     agent-supplied `lines[]` or a parsed provider file, previews it (P8), and on confirm calls
 *     A02 `postEntry` EXACTLY ONCE (`source:'import'`), recording a `wage_journal_posts` row in the
 *     same transaction. Every money-path invariant (append-only, idempotent-on-ROWS, balanced,
 *     §H-PERIOD, §H-TENANT) is A02's, surfaced unchanged: A34 owns no second posting path (P3).
 *   - `listPayrollHandoffs` is the union read model over the two tables.
 *
 * THE tx-commit-on-err TRAP: returning `{ok:false}` inside `ctx.store.tx` COMMITS partial writes, so
 * a failed delegated write is raised as `HandoffAbort` and rolls the whole transaction back, exactly
 * the A17/A31 `BillAbort`/`CaptureAbort` pattern.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { uploadFile, linkFile, getFileContent } from '../files/index.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { applySavedView } from '../customization/views.js';

/** `journal_entry.source` for the wage journal: the existing §D0 `import` value (no enum change). */
export const WAGE_JOURNAL_SOURCE = 'import';

/** The formats the export artifact is produced in (§H-ENUM, single-sourced). */
export const PAYROLL_HANDOFF_FORMATS = ['csv', 'json'] as const;
export type PayrollHandoffFormat = (typeof PAYROLL_HANDOFF_FORMATS)[number];
export function isPayrollHandoffFormat(v: unknown): v is PayrollHandoffFormat {
  return typeof v === 'string' && (PAYROLL_HANDOFF_FORMATS as readonly string[]).includes(v);
}

/** Raise to abort a write transaction with a structured cause (nothing is memoised on a rejection). */
class HandoffAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof HandoffAbort) return e.result;
    throw e;
  }
}

/** The boolean face of the capability port: read as a fact, so AHV inclusion is capability-derived. */
function holds(ctx: WorkspaceContext, capability: string): boolean {
  return ctx.capabilities.assert(capability).ok;
}

// --- Rows ----------------------------------------------------------------------------------------

interface EmployeeRow {
  id: string;
  contact_id: string | null;
  actor_ref: string | null;
  first_name: string;
  last_name: string;
  ahv_nr: string | null;
  employment_pct: number;
  starts_on: string;
  ends_on: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface ExportRow {
  id: string;
  workspace_id: string;
  as_of: string;
  previous_export_id: string | null;
  format: string;
  employee_count: number;
  mutation_count: number;
  ahv_included: number;
  ahv_excluded_reason: string | null;
  artifact_document_id: string;
  sha256: string;
  actor: string;
  created_at: string;
}

interface PostingRow {
  id: string;
  workspace_id: string;
  posted_entry_id: string;
  entry_date: string;
  mapping_id: string | null;
  source_sha256: string | null;
  line_count: number;
  actor: string;
  created_at: string;
}

// --- Export --------------------------------------------------------------------------------------

export interface PayrollHandoffExportInput {
  format?: string;
  idempotencyKey: string;
}

/** One employee's record for the artifact. AHV is present ONLY when the export includes it. */
function employeeArtifactRecord(row: EmployeeRow, ahvIncluded: boolean): Record<string, unknown> {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    employmentPct: row.employment_pct,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    contactId: row.contact_id,
    actorRef: row.actor_ref,
    archived: row.archived === 1,
    ...(ahvIncluded ? { ahvNr: row.ahv_nr } : {}),
  };
}

/** A CSV field, quoted when it carries a comma, quote or newline (RFC 4180). */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build the artifact bytes (as a UTF-8 string) in the requested format. The header ALWAYS states
 * whether AHV numbers were included and, when they were not, WHY: an omission a reader cannot see is
 * exactly what revDSG Art. 6 minimisation forbids (the E02 produced-without-and-says-so rule). The
 * artifact also states it is local-only (OP4): there is no transmitter in the OSS core.
 */
function buildArtifact(
  format: PayrollHandoffFormat,
  meta: {
    asOf: string;
    employeeCount: number;
    mutationCount: number;
    previousExportId: string | null;
    ahvIncluded: boolean;
    firstExport: boolean;
  },
  employees: EmployeeRow[],
  mutations: EmployeeRow[],
): string {
  const ahvNote = meta.ahvIncluded
    ? 'AHV numbers included.'
    : 'AHV numbers omitted (hr.sensitive permission missing).';
  const localNote = 'This artifact stays on this device. TILL does not transmit to payroll providers.';
  const firstNote = meta.firstExport ? 'First export, full master data (no predecessor).' : null;

  if (format === 'json') {
    return JSON.stringify(
      {
        header: {
          generatedAt: meta.asOf,
          employeeCount: meta.employeeCount,
          mutationCount: meta.mutationCount,
          previousExportId: meta.previousExportId,
          firstExport: meta.firstExport,
          ahvIncluded: meta.ahvIncluded,
          ...(meta.ahvIncluded ? {} : { ahvExcludedReason: 'missing_hr_sensitive' }),
          ahvNote,
          localOnly: localNote,
          ...(firstNote ? { note: firstNote } : {}),
        },
        employees: employees.map((e) => employeeArtifactRecord(e, meta.ahvIncluded)),
        mutations: mutations.map((e) => employeeArtifactRecord(e, meta.ahvIncluded)),
      },
      null,
      2,
    );
  }

  // CSV: a `#` header block (skippable comment lines), then a flat table with a `section` column so
  // the master and the mutations round-trip through one file.
  const lines: string[] = [];
  lines.push(`# generatedAt: ${meta.asOf}`);
  lines.push(`# employeeCount: ${meta.employeeCount}`);
  lines.push(`# mutationCount: ${meta.mutationCount}`);
  lines.push(`# ahvIncluded: ${meta.ahvIncluded}`);
  lines.push(`# ${ahvNote}`);
  if (firstNote) lines.push(`# ${firstNote}`);
  lines.push(`# ${localNote}`);
  const columns = ['section', 'id', 'firstName', 'lastName', 'employmentPct', 'startsOn', 'endsOn', 'archived'];
  if (meta.ahvIncluded) columns.push('ahvNr');
  lines.push(columns.join(','));
  const rowFor = (section: string, e: EmployeeRow): string => {
    const cells = [
      section,
      e.id,
      e.first_name,
      e.last_name,
      e.employment_pct,
      e.starts_on,
      e.ends_on ?? '',
      e.archived === 1,
    ];
    if (meta.ahvIncluded) cells.push(e.ahv_nr ?? '');
    return cells.map(csvField).join(',');
  };
  for (const e of employees) lines.push(rowFor('master', e));
  for (const e of mutations) lines.push(rowFor('mutation', e));
  return `${lines.join('\n')}\n`;
}

/**
 * Export the employee master plus the mutations since the previous export, as a LOCAL artifact
 * stored via E00 and linked to a `payroll_handoff` record (OP3). Gated by `hr.manage`; AHV inclusion
 * is decided by whether the actor additionally holds `hr.sensitive`, and the artifact says which.
 */
export function payrollHandoffExport(ctx: WorkspaceContext, input: PayrollHandoffExportInput): Result {
  const capable = ctx.capabilities.assert('hr.manage');
  if (!capable.ok) return err('forbidden', { capability: 'hr.manage' });

  const format: PayrollHandoffFormat = input.format === undefined ? 'json' : (input.format as PayrollHandoffFormat);
  if (input.format !== undefined && !isPayrollHandoffFormat(input.format)) {
    return err('invalid_input', { field: 'format', allowed: [...PAYROLL_HANDOFF_FORMATS] });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  // Replay a completed export FIRST, so a retry returns the original record and artifact and never
  // creates a second one (§H-IDEMPOTENT).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'payroll_handoff_export');
  if (replayed !== undefined) return replayed;

  // §H-TENANT: only this workspace's employees. The full master (including archived / ended), because
  // the payroll provider needs the complete roster, not the currently-active subset.
  const employees = ctx.store.db
    .prepare('SELECT * FROM employee WHERE workspace_id = ? ORDER BY last_name, first_name, id')
    .all(ctx.workspaceId) as EmployeeRow[];
  if (employees.length === 0) return err('no_employees', {});

  const ahvIncluded = holds(ctx, 'hr.sensitive');

  const previous = ctx.store.db
    .prepare('SELECT * FROM payroll_handoff_exports WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(ctx.workspaceId) as ExportRow | undefined;
  const previousAsOf = previous?.as_of ?? null;
  // Mutations are employees changed since the previous export's `as_of`. The first export has no
  // predecessor: the full master with an empty mutations section (US-A34.1 boundary).
  const mutations = previousAsOf === null ? [] : employees.filter((e) => e.updated_at > previousAsOf);

  const asOf = ctx.clock.now();
  const artifact = buildArtifact(
    format,
    {
      asOf,
      employeeCount: employees.length,
      mutationCount: mutations.length,
      previousExportId: previous?.id ?? null,
      ahvIncluded,
      firstExport: previous === undefined,
    },
    employees,
    mutations,
  );
  const sha256 = createHash('sha256').update(artifact, 'utf8').digest('hex');

  const run = (): Result => {
    const uploaded = uploadFile(ctx, {
      contentBase64: Buffer.from(artifact, 'utf8').toString('base64'),
      mime: format === 'csv' ? 'text/csv' : 'application/json',
      filename: `payroll-handoff-${asOf}.${format}`,
      title: `Lohnübergabe ${asOf}`,
    });
    if (!uploaded.ok) throw new HandoffAbort(uploaded);
    const documentId = (uploaded as unknown as { file: { id: string } }).file.id;

    const exportId = ctx.ids.next('phe');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO payroll_handoff_exports
           (id, workspace_id, as_of, previous_export_id, format, employee_count, mutation_count,
            ahv_included, ahv_excluded_reason, artifact_document_id, sha256, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        exportId,
        ctx.workspaceId,
        asOf,
        previous?.id ?? null,
        format,
        employees.length,
        mutations.length,
        ahvIncluded ? 1 : 0,
        ahvIncluded ? null : 'missing_hr_sensitive',
        documentId,
        sha256,
        ctx.actor,
        at,
      );

    // OP3: link the artifact to the payroll_handoff record. The E00-side read-back gate
    // (`getFileContent`) then gates this document on `hr.manage` (+ `hr.sensitive` when AHV present).
    const linked = linkFile(ctx, {
      fileId: documentId,
      entityKind: 'payroll_handoff',
      entityId: exportId,
      idempotencyKey: `${input.idempotencyKey}:link`,
    });
    if (!linked.ok) throw new HandoffAbort(linked);

    ctx.audit.record({ entityKind: 'payroll_handoff', entityId: exportId, action: 'export', actor: ctx.actor, at });
    return ok({
      exportId,
      artifactDocumentId: documentId,
      employeeCount: employees.length,
      mutationCount: mutations.length,
      previousExportId: previous?.id ?? null,
      ahvIncluded,
      ...(ahvIncluded ? {} : { ahvExcludedReason: 'missing_hr_sensitive' }),
      sha256,
    });
  };

  return runGuarded(() => ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'payroll_handoff_export', run));
}

// --- Wage journal posting ------------------------------------------------------------------------

/** One agent-supplied wage-journal line. Amounts are integer Rappen; exactly one side is positive. */
export interface WageJournalLineInput {
  accountNumber?: string;
  accountId?: string;
  debitMinor?: number;
  creditMinor?: number;
  costCenter?: string;
  description?: string;
}

export interface WageJournalPostInput {
  lines?: WageJournalLineInput[];
  fileRef?: string;
  /** For the `fileRef` path: a map from canonical column name to the provider file's header. */
  columnMap?: Record<string, string>;
  /** A saved-mapping label, recorded for provenance only (never resolved to a second posting path). */
  mappingId?: string;
  entryDate?: string;
  description?: string;
  ref?: string;
  confirm?: boolean;
  idempotencyKey: string;
}

/** A wage-journal line normalised to a resolved account id and integer Rappen sides. */
interface PreparedWageLine {
  accountId: string;
  accountNumber: string;
  debitMinor: number;
  creditMinor: number;
  costCenterId: string | null;
  costCenter: string | null;
  description: string | null;
}

/** A raw (pre-resolution) wage line, from `lines[]` or a parsed file row. */
interface RawWageLine {
  accountNumber?: string;
  accountId?: string;
  debitMinor: number;
  creditMinor: number;
  costCenter?: string;
  description?: string;
}

const CANONICAL_WAGE_COLUMNS = [
  'account_number',
  'debit_rappen',
  'credit_rappen',
  'cost_center',
  'description',
] as const;

/** A minimal RFC-4180-ish CSV row splitter (handles quoted fields and doubled quotes). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse an integer Rappen amount from a cell; empty is 0, anything non-integer is a defect. */
function parseRappen(value: string | undefined): number | null {
  const s = (value ?? '').trim();
  if (s === '') return 0;
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Parse a provider wage file (CSV) into raw lines, translating provider headers through `columnMap`
 * (canonical column -> provider header) when given. Refuses a non-CHF currency column rather than
 * converting (a Swiss wage journal posts in CHF; a foreign line arrives pre-converted, §H-FX absent).
 */
function parseWageFile(content: string, columnMap: Record<string, string> | undefined): { ok: true; lines: RawWageLine[] } | { ok: false; error: Result } {
  const rows = content
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (rows.length === 0) return { ok: false, error: err('no_rows', {}) };
  const header = splitCsvLine(rows[0] as string).map((h) => h.trim());
  // Resolve which file column supplies each canonical field.
  const colIndex: Record<string, number> = {};
  for (const canonical of CANONICAL_WAGE_COLUMNS) {
    const providerHeader = columnMap?.[canonical] ?? canonical;
    const idx = header.indexOf(providerHeader);
    if (idx >= 0) colIndex[canonical] = idx;
  }
  // A currency column is refused outright (CHF-only, stated honestly rather than half-supported).
  const currencyHeader = columnMap?.['currency'] ?? 'currency';
  if (header.indexOf(currencyHeader) >= 0) {
    return { ok: false, error: err('unsupported_currency', { reason: 'a wage journal posts in CHF; remove the currency column' }) };
  }
  if (colIndex['account_number'] === undefined || colIndex['debit_rappen'] === undefined || colIndex['credit_rappen'] === undefined) {
    return { ok: false, error: err('missing_columns', { required: ['account_number', 'debit_rappen', 'credit_rappen'], header }) };
  }
  const lines: RawWageLine[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = splitCsvLine(rows[r] as string);
    const at = (canonical: string): string | undefined => {
      const idx = colIndex[canonical];
      return idx === undefined ? undefined : cells[idx];
    };
    const debit = parseRappen(at('debit_rappen'));
    const credit = parseRappen(at('credit_rappen'));
    if (debit === null || credit === null) {
      return { ok: false, error: err('invalid_amount', { row: r, reason: 'debit_rappen / credit_rappen must be integer Rappen' }) };
    }
    const accountNumber = (at('account_number') ?? '').trim();
    if (accountNumber === '') {
      return { ok: false, error: err('missing_account', { row: r }) };
    }
    const costCenter = (at('cost_center') ?? '').trim();
    const description = (at('description') ?? '').trim();
    lines.push({
      accountNumber,
      debitMinor: debit,
      creditMinor: credit,
      ...(costCenter !== '' ? { costCenter } : {}),
      ...(description !== '' ? { description } : {}),
    });
  }
  return { ok: true, lines };
}

/** Resolve raw lines to accounts and validate each side. §H-TENANT: accounts are workspace-scoped. */
function prepareWageLines(ctx: WorkspaceContext, raw: RawWageLine[]): { ok: true; lines: PreparedWageLine[] } | { ok: false; error: Result } {
  if (raw.length < 2) return { ok: false, error: err('unbalanced', { reason: 'at least two lines are required' }) };
  const prepared: PreparedWageLine[] = [];
  for (const [i, line] of raw.entries()) {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0) {
      return { ok: false, error: err('invalid_line', { index: i, reason: 'debit/credit must be non-negative integer Rappen' }) };
    }
    if (debit > 0 === credit > 0) {
      return { ok: false, error: err('invalid_line', { index: i, reason: 'each line is exactly one of debit or credit' }) };
    }
    // Resolve the account by id or by number, both §H-TENANT scoped.
    let accountId: string | undefined;
    let accountNumber: string | undefined;
    if (typeof line.accountId === 'string' && line.accountId.length > 0) {
      const row = ctx.store.db
        .prepare('SELECT id, number FROM account WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, line.accountId) as { id: string; number: string } | undefined;
      if (row === undefined) return { ok: false, error: err('unknown_account', { index: i, accountId: line.accountId }) };
      accountId = row.id;
      accountNumber = row.number;
    } else if (typeof line.accountNumber === 'string' && line.accountNumber.length > 0) {
      const row = ctx.store.db
        .prepare('SELECT id, number FROM account WHERE workspace_id = ? AND number = ?')
        .get(ctx.workspaceId, line.accountNumber) as { id: string; number: string } | undefined;
      if (row === undefined) return { ok: false, error: err('unknown_account', { index: i, accountNumber: line.accountNumber }) };
      accountId = row.id;
      accountNumber = row.number;
    } else {
      return { ok: false, error: err('invalid_line', { index: i, reason: 'each line names an accountNumber or accountId' }) };
    }
    let costCenterId: string | null = null;
    if (typeof line.costCenter === 'string' && line.costCenter.length > 0) {
      const cc = ctx.store.db
        .prepare('SELECT id FROM cost_center WHERE workspace_id = ? AND code = ?')
        .get(ctx.workspaceId, line.costCenter) as { id: string } | undefined;
      if (cc === undefined) return { ok: false, error: err('unknown_cost_center', { index: i, costCenter: line.costCenter }) };
      costCenterId = cc.id;
    }
    prepared.push({
      accountId: accountId as string,
      accountNumber: accountNumber as string,
      debitMinor: debit,
      creditMinor: credit,
      costCenterId,
      costCenter: line.costCenter ?? null,
      description: line.description ?? null,
    });
  }
  return { ok: true, lines: prepared };
}

/** The balance check, in BigInt so a set that only "balances" by float loss cannot slip through. */
function balanceOf(lines: PreparedWageLine[]): { debitMinor: number; creditMinor: number; balanced: boolean; diffRappen: number } {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    debit += BigInt(l.debitMinor);
    credit += BigInt(l.creditMinor);
  }
  return { debitMinor: Number(debit), creditMinor: Number(credit), balanced: debit === credit, diffRappen: Number(debit - credit) };
}

function previewPayload(entryDate: string, lines: PreparedWageLine[]): Record<string, unknown> {
  const bal = balanceOf(lines);
  return {
    entryDate,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      accountNumber: l.accountNumber,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      costCenter: l.costCenter,
      description: l.description,
    })),
    totalDebitMinor: bal.debitMinor,
    totalCreditMinor: bal.creditMinor,
    balanced: bal.balanced,
  };
}

/**
 * Preview then post the month's wage journal. Exactly ONE of `lines[]` (agent path) or `fileRef`
 * (parsed provider file) supplies the rows; both meet at one balanced-payload builder.
 *
 * Without `confirm` (dial off) it returns the full-entry PREVIEW and writes NOTHING, and does not
 * consume the idempotency key (P8): the natural preview-then-`confirm:true` sequence with one key
 * works. With `confirm` it calls A02 `postEntry` EXACTLY ONCE (`source:'import'`) and appends a
 * `wage_journal_posts` row in the same transaction. A02 is the sole ledger authority: it enforces the
 * `post` capability, §H-LEDGER balance and §H-PERIOD, and §H-IDEMPOTENT; a `{ok:false}` from it is
 * raised as an abort so a failed post leaves ZERO rows (the tx-commit-on-err trap).
 */
export function wageJournalPost(ctx: WorkspaceContext, input: WageJournalPostInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (typeof input.entryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate)) {
    return err('invalid_input', { field: 'entryDate' });
  }
  const hasLines = Array.isArray(input.lines);
  const hasFile = typeof input.fileRef === 'string' && input.fileRef.length > 0;
  if (hasLines === hasFile) {
    return err('invalid_input', { field: 'lines/fileRef', reason: 'give exactly one of lines[] or fileRef' });
  }

  // Build the raw lines. The file path reads the stored provider file (E00) and parses it; the agent
  // path takes pre-structured rows directly. Both are validated BEFORE any write.
  let sourceSha256: string | null = null;
  let raw: RawWageLine[];
  if (hasFile) {
    const content = getFileContent(ctx, { fileId: input.fileRef as string });
    if (!content.ok) return content;
    const b64 = (content as { contentBase64?: string }).contentBase64;
    if (typeof b64 !== 'string') return err('file_unreadable', { fileRef: input.fileRef });
    sourceSha256 = (content as { sha256?: string }).sha256 ?? null;
    const parsed = parseWageFile(Buffer.from(b64, 'base64').toString('utf8'), input.columnMap);
    if (!parsed.ok) return parsed.error;
    raw = parsed.lines;
  } else {
    const arr = input.lines as WageJournalLineInput[];
    raw = arr.map((l) => ({
      ...(l.accountNumber !== undefined ? { accountNumber: l.accountNumber } : {}),
      ...(l.accountId !== undefined ? { accountId: l.accountId } : {}),
      debitMinor: l.debitMinor ?? 0,
      creditMinor: l.creditMinor ?? 0,
      ...(l.costCenter !== undefined ? { costCenter: l.costCenter } : {}),
      ...(l.description !== undefined ? { description: l.description } : {}),
    }));
  }

  const prepared = prepareWageLines(ctx, raw);
  if (!prepared.ok) return prepared.error;

  // The balance is validated at the control (preview time), BEFORE A02 sees it, so an unbalanced file
  // is refused with the Rappen difference rather than sent to the ledger. A02 re-enforces §H-LEDGER
  // as the final authority.
  const bal = balanceOf(prepared.lines);
  if (!bal.balanced) {
    return err('unbalanced', { diffRappen: bal.diffRappen, debitMinor: bal.debitMinor, creditMinor: bal.creditMinor });
  }

  // P8: the dial-off preview writes nothing and does not consume the key.
  if (input.confirm !== true) {
    return ok({ preview: previewPayload(input.entryDate, prepared.lines) });
  }

  // Replay a completed post before the state-dependent guards, so a retry returns the original
  // posted entry rather than posting a second one (§H-IDEMPOTENT, asserted on ROWS).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'wage_journal_post');
  if (replayed !== undefined) return replayed;

  const entryDate = input.entryDate;
  const postingLines: LineInput[] = prepared.lines.map((l) => ({
    account: l.accountId,
    ...(l.debitMinor > 0 ? { debit: l.debitMinor } : { credit: l.creditMinor }),
    ...(l.costCenterId !== null ? { costCenter: l.costCenterId } : {}),
  }));

  const run = (): Result => {
    // THE ONE posting (P3): A02 is the only path to the ledger. A02 asserts `post`, checks the
    // period lock and the balance, and is itself idempotent. A `{ok:false}` MUST be raised, not
    // returned, or the surrounding tx would commit the partial write.
    const posted = postEntry(ctx, {
      date: entryDate,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      description: input.description ?? 'Lohnbuchung',
      lines: postingLines,
      source: WAGE_JOURNAL_SOURCE,
      idempotencyKey: `${input.idempotencyKey}:wjp`,
    });
    if (!posted.ok) throw new HandoffAbort(posted);
    const postedEntryId = (posted as unknown as { entryId: string }).entryId;

    const wjpId = ctx.ids.next('wjp');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO wage_journal_posts
           (id, workspace_id, posted_entry_id, entry_date, mapping_id, source_sha256, line_count, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wjpId,
        ctx.workspaceId,
        postedEntryId,
        entryDate,
        input.mappingId ?? null,
        sourceSha256,
        prepared.lines.length,
        ctx.actor,
        at,
      );
    ctx.audit.record({ entityKind: 'payroll_handoff', entityId: wjpId, action: 'post', actor: ctx.actor, at });
    // `entryId` is present so the `payroll.wage_journal_posted` automation event resolves (a preview,
    // which returns no `entryId`, emits nothing).
    return ok({ wageJournalPostId: wjpId, postedEntryId, entryId: postedEntryId });
  };

  return runGuarded(() => ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'wage_journal_post', run));
}

// --- Read model ----------------------------------------------------------------------------------

export interface ListPayrollHandoffsInput {
  from?: string;
  to?: string;
  savedViewId?: string;
}

/** The typed union of exports and postings, ordered by `created_at` (P5). §H-TENANT on every query. */
export function listPayrollHandoffs(ctx: WorkspaceContext, input: ListPayrollHandoffsInput): Result {
  // The G00 saved-view seam (OP10): a stored `payroll_handoff` view merges its filters underneath
  // anything named explicitly here.
  const applied = applySavedView(ctx, 'payroll_handoff', {
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  });
  if (!applied.ok) return applied;
  const filter = applied.filter as ListPayrollHandoffsInput;

  const range = (rows: { created_at: string }[]): boolean[] =>
    rows.map((r) => {
      if (typeof filter.from === 'string' && filter.from.length > 0 && r.created_at < filter.from) return false;
      if (typeof filter.to === 'string' && filter.to.length > 0 && r.created_at > filter.to) return false;
      return true;
    });

  const exports = ctx.store.db
    .prepare('SELECT * FROM payroll_handoff_exports WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(ctx.workspaceId) as ExportRow[];
  const postings = ctx.store.db
    .prepare('SELECT * FROM wage_journal_posts WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(ctx.workspaceId) as PostingRow[];

  const exportKeep = range(exports);
  const postingKeep = range(postings);

  const rows: Record<string, unknown>[] = [];
  exports.forEach((e, i) => {
    if (!exportKeep[i]) return;
    rows.push({
      type: 'export',
      id: e.id,
      actor: e.actor,
      createdAt: e.created_at,
      asOf: e.as_of,
      format: e.format,
      employeeCount: e.employee_count,
      mutationCount: e.mutation_count,
      ahvIncluded: e.ahv_included === 1,
      ahvExcludedReason: e.ahv_excluded_reason,
      artifactDocumentId: e.artifact_document_id,
      previousExportId: e.previous_export_id,
    });
  });
  postings.forEach((p, i) => {
    if (!postingKeep[i]) return;
    rows.push({
      type: 'posting',
      id: p.id,
      actor: p.actor,
      createdAt: p.created_at,
      entryDate: p.entry_date,
      postedEntryId: p.posted_entry_id,
      mappingId: p.mapping_id,
      lineCount: p.line_count,
    });
  });
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return ok({ handoffs: rows, total: rows.length });
}
