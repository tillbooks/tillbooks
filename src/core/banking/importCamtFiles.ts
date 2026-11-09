/**
 * A36 §4.7 (D150), THE HAND REPAIR'S DOOR: several camt.053 files at once, imported in number order.
 *
 * Filling a statement gap by hand means fetching several days from eBanking. They arrive as several
 * files, or as one file with several `<Stmt>`, in whatever order the person drops them, and the successor
 * rule (A36 §4.4) only admits a hole filler that opens on its lower neighbour, so the order matters.
 * This verb does the ordering and nothing else:
 *
 *  1. every file is split into single-statement messages (`splitCamt053`, envelope kept), a split that
 *     would have to guess is refused for that file;
 *  2. every statement is parsed and sorted by its position (calendar year of `FrDtTm`, `ElctrncSeqNb`);
 *  3. ONE ordered pass calls `importCamt`, the one statement door, once per statement, each in its own
 *     transaction, under the idempotency key `camt-files:<bankAccountId>:<sha256 of that statement>`.
 *
 * Nothing here decides what imports: `importCamt` and `decideSuccessor` do, exactly as for one file. No
 * retry loop: once the statements are in position order a refusal is a real one (a gap below the first
 * file, an overlap) and is reported, never hidden by a second try. Dropping the same files again imports
 * nothing twice (the statement dedupe and the per-statement key), and is reported as `already_imported`.
 *
 * §H-TENANT through `importCamt` and the workspace-fenced reads below.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { err, ok } from '../result.js';
import type { Result } from '../result.js';
import { parseCamt, splitCamt053 } from './camt.js';
import { importCamt } from './camtReconcile.js';
import { comparePositions, dayEndPosition } from './ebics/feed.js';
import type { FeedPosition } from './ebics/feed.js';

/** At most this many files in one call (a month of days, with room). */
export const IMPORT_CAMT_FILES_MAX = 100;

export interface ImportCamtFilesInput {
  bankAccountId?: unknown;
  files?: unknown;
  idempotencyKey?: unknown;
}

/** One statement's outcome, in the order the pass ran. */
export interface CamtFileOutcome {
  file: string;
  /** The statement's place in the file (1 for a single-statement file). */
  part: number;
  number: number | null;
  year: number | null;
  fromDate: string | null;
  outcome: 'imported' | 'already_imported' | 'refused';
  statementId?: string;
  txnCount?: number;
  warnings?: string[];
  code?: string;
  reason?: string;
  differenceMinor?: number;
}

interface Pending {
  file: string;
  part: number;
  xml: string;
  position: FeedPosition | null;
  fromDate: string | null;
  order: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function statementCount(ctx: WorkspaceContext, bankAccountId: string): number {
  const row = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?')
    .get(ctx.workspaceId, bankAccountId) as { n: number };
  return row.n;
}

function readFiles(raw: unknown): { name: string; xml: string }[] | Result {
  if (!Array.isArray(raw) || raw.length === 0) return err('invalid_input', { field: 'files', reason: 'one or more files, each { name, xml }' });
  if (raw.length > IMPORT_CAMT_FILES_MAX) return err('invalid_input', { field: 'files', reason: `at most ${IMPORT_CAMT_FILES_MAX} files in one call` });
  const out: { name: string; xml: string }[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const f = raw[i] as { name?: unknown; xml?: unknown } | null;
    if (f === null || typeof f !== 'object' || typeof f.xml !== 'string' || f.xml.trim().length === 0) {
      return err('invalid_input', { field: `files[${i}].xml` });
    }
    out.push({ name: typeof f.name === 'string' && f.name.length > 0 ? f.name : `file ${i + 1}`, xml: f.xml });
  }
  return out;
}

/**
 * `import_camt_files`: split, sort by position, import in ONE ordered pass through `importCamt`, and
 * answer one outcome per statement. Idempotent per call key (a replay returns the first report).
 */
export function importCamtFiles(ctx: WorkspaceContext, input: ImportCamtFilesInput): Result {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  if (typeof input.bankAccountId !== 'string' || input.bankAccountId.length === 0) return err('invalid_input', { field: 'bankAccountId' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  const files = readFiles(input.files);
  if (!Array.isArray(files)) return files;
  const bankAccountId = input.bankAccountId;

  // Critic LOW 7: the call key is scoped by the account AND the payload (the sorted SHA-256 of every
  // file), the convention of the scoped keys that carry their subject (`set_bank_sync_schedule` keys on
  // its connection). A reused key with other files is a new question, never a replay of the first
  // report about files it did not carry; the per-statement content keys still import nothing twice.
  const payloadDigest = sha256(files.map((f) => sha256(f.xml)).sort().join('\n'));
  const scopedKey = JSON.stringify(['import_camt_files', bankAccountId, input.idempotencyKey, payloadDigest]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'import_camt_files');
  if (replayed !== undefined) return replayed;
  const account = ctx.store.db
    .prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as { id: string } | undefined;
  if (account === undefined) return err('needs_bank_account', { bankAccountId });

  const outcomes: CamtFileOutcome[] = [];
  const pending: Pending[] = [];
  let order = 0;
  for (const f of files) {
    const split = splitCamt053(f.xml);
    if (!split.ok) {
      const why = (split as unknown as { reason?: unknown }).reason;
      outcomes.push({
        file: f.name,
        part: 0,
        number: null,
        year: null,
        fromDate: null,
        outcome: 'refused',
        code: split.error,
        ...(typeof why === 'string' ? { reason: why } : {}),
      });
      continue;
    }
    split.parts.forEach((xml, i) => {
      const parsed = parseCamt(xml);
      const statement = parsed.ok ? parsed.statement : null;
      order += 1;
      pending.push({
        file: f.name,
        part: i + 1,
        xml,
        position: statement === null ? null : dayEndPosition(statement),
        fromDate: statement?.fromDate ?? null,
        order,
      });
    });
  }

  // Position order; a statement without a position (not a day-end statement, unreadable) keeps its drop
  // order after the others, so `importCamt` names why it refuses it.
  pending.sort((a, b) => {
    if (a.position !== null && b.position !== null) return comparePositions(a.position, b.position) || a.order - b.order;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return a.order - b.order;
  });

  for (const p of pending) {
    const before = statementCount(ctx, bankAccountId);
    const res = importCamt(ctx, { bankAccountId, xml: p.xml, idempotencyKey: `camt-files:${bankAccountId}:${sha256(p.xml)}` });
    const base = { file: p.file, part: p.part, number: p.position?.number ?? null, year: p.position?.year ?? null, fromDate: p.fromDate };
    if (!res.ok) {
      const r = res as Record<string, unknown>;
      outcomes.push({
        ...base,
        outcome: 'refused',
        code: res.error,
        ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
        ...(typeof r.differenceMinor === 'number' ? { differenceMinor: r.differenceMinor } : {}),
      });
      continue;
    }
    const added = statementCount(ctx, bankAccountId) > before;
    outcomes.push({
      ...base,
      outcome: added && res.duplicate !== true ? 'imported' : 'already_imported',
      statementId: res.statementId,
      txnCount: added ? res.txnCount : 0,
      warnings: res.warnings,
    });
  }

  const body = {
    bankAccountId,
    statements: outcomes,
    imported: outcomes.filter((o) => o.outcome === 'imported').length,
    alreadyImported: outcomes.filter((o) => o.outcome === 'already_imported').length,
    refused: outcomes.filter((o) => o.outcome === 'refused').length,
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_camt_files', () => ok(body));
}
