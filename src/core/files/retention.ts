/**
 * E00's OR 958f half: how long a stored business record must be kept, and where that date comes from.
 *
 * OR Art. 958f Abs. 1, verified against the primary source on 30.07.2026:
 *
 *   "Die Geschäftsbücher und die Buchungsbelege sowie der Geschäftsbericht und der Revisionsbericht
 *    sind während zehn Jahren aufzubewahren."
 *
 * The period runs from the END OF THE FINANCIAL YEAR, not from the document's own date and not from a
 * calendar year end. `workspace.fiscal_year_start` is a real setting (`01-01` is only the default), so
 * the floor is resolved through A03's own exported `fiscalYearOf` rather than by assuming December.
 * The spec as authored said "31 Dec of the linked record's fiscal year + 10 years", which is right for
 * a calendar-year book and silently too short for an April book.
 *
 * WHICH DATE THE TEN YEARS ARE COUNTED FROM: THE LINKED RECORD'S OWN DATE, falling back to the clock
 * only where the record has none.
 *
 * This was the LINK date until 30.07.2026, defended here as the conservative choice on the argument
 * that filing a 2026 voucher in 2027 can only ever derive a longer answer. That argument is false in
 * the direction that matters, and the critic measured it: `post_entry` accepts a FUTURE date (A02 has
 * no future-date guard), so an entry dated 2028-06-01 posted while the clock reads 2026-07-16 derived
 * 2036-12-31 where the entry's own financial year demands 2038-12-31. Under-retained by two years, and
 * no test caught it because a backdated filing (the common case) errs the other way. `record_payment`
 * takes a caller-supplied date with the same shape.
 *
 * So the anchor is the record's own date, which is not the conservative answer but the CORRECT one:
 * OR 958f counts ten years from the end of the financial year the record belongs to, and the record's
 * date is what decides which year that is. Reading it costs one indexed lookup through
 * `ACCOUNTING_DATE_COLUMNS`, three rows keyed on the same G00 registry the link check already uses.
 * Where the record carries no date at all (a draft `document` has no `issue_date` until it is issued)
 * the clock is the fallback, and THAT half is conservative: a file linked today derives from today's
 * financial year end, which is never earlier than the record's.
 *
 * THE FLOOR DERIVES FROM POSTED EVIDENCE, NOT FROM A LINK (D63, owner-decided 30.07.2026). Until
 * then a `files_link` to ANY accounting-kind record derived the floor immediately, drafts included,
 * and the sealed column below turned a mis-click into a permanent lock: link a file to a draft entry
 * dated 2030, delete the draft, and the file was locked to 2040-12-31 with no verb able to lower it.
 * Now a link to a draft derives nothing; the floor attaches at the moment the record POSTS (the A02
 * status flip, or the document issue that stamps the number), through `deriveStatutoryOnPost`, and
 * from that moment it is permanent exactly as before. The accepted cost is a window in which a file
 * attached to a still-draft entry carries no statutory protection until the entry posts: a draft is
 * not yet bookkeeping evidence, and the file keeps whatever manual retention it holds.
 *
 * NEITHER HALF MAY BE FORGOTTEN LATER, which is the other half of the same rail. The derived date is
 * stored in `stored_file.retention_statutory_until`, a column no provenance change and no hand-set
 * date lowers or clears, so the floor stays recomputable after a manual extension, after a re-link to
 * a non-accounting record, and after the workspace changes its fiscal year start. An operator may
 * always extend; `files_set_retention` refuses to shorten below the floor and `deleteFile` compares
 * against the same floor rather than against the stored column alone.
 *
 * GeBüV Art. 3 (Integrität: Echtheit und Unverfälschbarkeit) and Art. 9 (Zulässige Informationsträger)
 * are the other half, and they are answered elsewhere by construction rather than by a date: Art. 9
 * admits a CHANGEABLE information carrier only where technical procedures secure the integrity of the
 * stored information, the time of storage and its traceability, which is what the sha256, the immutable
 * `created_at` and the append-only version chain provide. Art. 6 (Verfügbarkeit) is what
 * `getFileContent` answers.
 */

import type { WorkspaceContext } from '../context.js';
import { fiscalYearOf } from '../ledger/periods.js';
import { entityKindDef } from '../customization/entities.js';

/** How a `retention_until` came to be set (§H-ENUM). */
export const RETENTION_SOURCES = ['manual', 'statutory_auto'] as const;
export type RetentionSource = (typeof RETENTION_SOURCES)[number];

/** OR 958f Abs. 1: ten years, counted from the end of the financial year. */
export const OR_958F_YEARS = 10;

/**
 * The registered entity kinds whose records are Buchungsbelege, so that attaching a file to one makes
 * the file a retained business record too.
 *
 * This is E00's judgement about G00's registry and not a copy of it: every name here must be a
 * registered kind (asserted in `test/files/retention.test.mjs`, so the list cannot rot into a set of
 * ghosts), and the kinds deliberately NOT here are the master-data ones. A contact, an item, a bank
 * account, a chart account, a cost centre and an automation rule are not accounting vouchers, and
 * locking a CV attached to a contact for ten years would be the revDSG erasure duty defeated by a rule
 * that no statute asked for.
 */
export const ACCOUNTING_ENTITY_KINDS: readonly string[] = ['document', 'payment', 'journal_entry'];

export function isAccountingEntityKind(kind: unknown): boolean {
  return typeof kind === 'string' && ACCOUNTING_ENTITY_KINDS.includes(kind);
}

/**
 * Where each accounting kind keeps ITS OWN date, which is the date the ten years are counted from.
 *
 * One row per `ACCOUNTING_ENTITY_KINDS` entry and no more, asserted against both that list and the
 * real column in `test/files/retention.test.mjs`, so the map cannot rot into a set of ghosts and
 * cannot silently stop covering a kind. It is E00's judgement in exactly the way
 * `ACCOUNTING_ENTITY_KINDS` is: G00's registry carries `table` and `idColumn` because an existence
 * check needs them, and it deliberately does not carry a date, because most registered kinds do not
 * have one (a contact, an item, a bank account and an automation rule are not dated events).
 *
 * `document` IS THE NULLABLE ONE and it is the reason the fallback exists rather than being a
 * defensive flourish: `issue_date` is NULL on a draft, and attaching the PDF before the invoice is
 * issued is the ordinary order of work.
 */
export const ACCOUNTING_DATE_COLUMNS: ReadonlyMap<string, string> = new Map([
  ['document', 'issue_date'],
  ['payment', 'date'],
  ['journal_entry', 'date'],
]);

/**
 * When a record of each accounting kind IS posted evidence, as a SQL predicate over its own table.
 *
 * D63 (30.07.2026): the statutory floor derives from POSTED evidence, not from a link. A draft is not
 * yet bookkeeping evidence, and deriving a permanent ten-year lock from one was a mis-click trap the
 * sealed floor made irreversible: link a file to a draft entry dated 2030, delete the draft, and the
 * file was locked to 2040-12-31 with no verb able to lower it. So each kind states here what "posted"
 * means for it, and the derivation runs only where the predicate holds:
 *
 *  * `document`: `posted_entry_id`, NOT `issue_date`. A10 stamps `issue_date` on the draft-to-issued
 *    edge of EVERY document type, including `quote` and `order`, whose poster is the no-op
 *    (`posts: false`): an issued Offerte carries a number and writes zero journal entries, and
 *    OR 957a Abs. 3 defines a Buchungsbeleg by the BOOKING it substantiates, so "once numbered" is
 *    not "once posted". `posted_entry_id` is the fact itself, stamped in the issue transaction for
 *    the types that post (invoice, credit note) and left NULL by the ones that do not, and a
 *    cancellation reverses the entry WITHOUT clearing the column, so once it posted an entry it is
 *    evidence forever, exactly as a cancellation of the entry itself would leave the entry posted.
 *    Gating on `type IN (...)` instead would restate A10's poster registry here and rot the day a
 *    posting type is added.
 *  * `payment`: `record_payment` posts its balanced entry in the same call, so a payment row never
 *    exists un-posted. The predicate is the tautology, kept as a row so the map stays total.
 *  * `journal_entry`: the A02 status flip, the exact moment the immutability triggers seal it.
 *
 * One row per `ACCOUNTING_ENTITY_KINDS` entry and no more, asserted in
 * `test/files/posted-floor.test.mjs` the same way `ACCOUNTING_DATE_COLUMNS` is held, so the map
 * cannot rot into a set of ghosts.
 */
export const ACCOUNTING_POSTED_CLAUSES: ReadonlyMap<string, string> = new Map([
  ['document', 'posted_entry_id IS NOT NULL'],
  ['payment', '1 = 1'],
  ['journal_entry', "status = 'posted'"],
]);

/**
 * Is this record posted evidence in THIS workspace, right now?
 *
 * False for a missing record, deliberately: a deleted never-posted draft is exactly the case D63
 * releases, and the recorded `retention_statutory_until` column (which only posted evidence ever
 * writes) is what keeps a floor a posted record contributed alive after any later re-link. §H-TENANT
 * on the lookup; the interpolation is safe for the same one reason it is in `accountingRecordDate`:
 * `table`, `idColumn` and the predicate all come from compile-time constant maps, never the caller.
 */
export function isPostedAccountingRecord(
  ctx: WorkspaceContext,
  entityKind: string | null,
  entityId: string | null,
): boolean {
  if (entityKind === null || entityId === null || entityId.length === 0) return false;
  const clause = ACCOUNTING_POSTED_CLAUSES.get(entityKind);
  const def = entityKindDef(entityKind);
  if (clause === undefined || def === undefined) return false;
  const row = ctx.store.db
    .prepare(`SELECT 1 AS one FROM ${def.table} WHERE workspace_id = ? AND ${def.idColumn} = ? AND (${clause})`)
    .get(ctx.workspaceId, entityId);
  return row !== undefined;
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The linked record's own date, or null when there is no reachable dated record.
 *
 * §H-TENANT on the lookup, and the interpolation is safe for the same one reason it is safe in
 * `linkFile`: `table` and `idColumn` come from G00's compile-time registry and the column comes from
 * the constant map above. The caller's `entityKind` only ever selects a row; `entityId` is bound.
 *
 * Returns null rather than throwing for a record that is not there. A file may outlive the record it
 * evidenced (a draft that was deleted), and in that case the stored statutory date is the answer:
 * losing the anchor must never lose the floor.
 */
export function accountingRecordDate(
  ctx: WorkspaceContext,
  entityKind: string | null,
  entityId: string | null,
): string | null {
  if (entityKind === null || entityId === null || entityId.length === 0) return null;
  const column = ACCOUNTING_DATE_COLUMNS.get(entityKind);
  const def = entityKindDef(entityKind);
  if (column === undefined || def === undefined) return null;
  const row = ctx.store.db
    .prepare(`SELECT ${column} AS d FROM ${def.table} WHERE workspace_id = ? AND ${def.idColumn} = ?`)
    .get(ctx.workspaceId, entityId) as { d: string | null } | undefined;
  const value = row?.d;
  return typeof value === 'string' && ISO_DAY_RE.test(value) ? value : null;
}

function fiscalYearStartOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/** `YYYY-MM-DD` for a UTC day count, so the arithmetic below never touches a local timezone. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The last day of the fiscal year that `date` falls in.
 *
 * Derived as "the day before the NEXT fiscal year starts", which is the only formulation that stays
 * right for a February start in a leap year and for `01-01` alike. `fiscalYearOf` labels a fiscal year
 * by the calendar year it STARTS in, so the next one starts in that year plus one.
 */
export function fiscalYearEnd(date: string, fiscalYearStart: string): string {
  const label = Number(fiscalYearOf(date, fiscalYearStart));
  const nextStart = Date.parse(`${label + 1}-${fiscalYearStart}T00:00:00.000Z`);
  return isoDay(nextStart - 86_400_000);
}

/**
 * The OR 958f floor for a file linked at `at`: the fiscal year end plus ten years.
 *
 * The year is added to the fiscal-year-end STRING rather than through date arithmetic, because
 * 29.02 + 10 years is not a date and `Date` would silently roll it into 01.03. A fiscal year end that
 * falls on 29 February exists (a March-start book in a leap year ends 28.02, but a 01.03-start book
 * ends the 29th in a leap year), and rolling into the next month would move a statutory deadline.
 * Clamping instead: the 29th becomes the 28th, which shortens nothing that matters because the day
 * after is still inside the tenth year, and it is the reading every practitioner note takes.
 */
export function statutoryRetentionUntil(ctx: WorkspaceContext, at: string): string {
  const end = fiscalYearEnd(at, fiscalYearStartOf(ctx));
  const year = Number(end.slice(0, 4)) + OR_958F_YEARS;
  const monthDay = end.slice(5);
  return `${year}-${monthDay === '02-29' ? '02-28' : monthDay}`;
}

/** The later of two nullable ISO days. A statutory floor only ever moves outwards. */
export function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** The columns the retention rail reads. Narrower than `StoredFileRow` so a caller can be a test. */
export interface RetentionFacts {
  entity_kind: string | null;
  entity_id: string | null;
  retention_until: string | null;
  retention_statutory_until: string | null;
  created_at: string;
}

/**
 * The OR 958f floor for a stored file, or null when no statute reaches it.
 *
 * THE LATER OF TWO ANSWERS, and neither is redundant:
 *
 *  * the RECORDED one, `retention_statutory_until`, which is what a previous link derived and what no
 *    later provenance change may destroy. It is the whole answer for a file whose link has since moved
 *    to a non-accounting record: OR 958f does not stop applying to a Buchungsbeleg because somebody
 *    re-filed it against a contact.
 *  * the RECOMPUTED one, derived from the linked record's own date against the workspace's CURRENT
 *    fiscal year start. It is what keeps the two guards in step: `set_fiscal_config` may change
 *    `fiscal_year_start` while the ledger is empty, and a floor read off a column written under the
 *    old configuration made `files_set_retention` and `files_delete` answer opposite things about one
 *    statutory date, nine months apart.
 *
 * `created_at` IS THE ANCHOR OF LAST RESORT and it is load-bearing rather than defensive. A draft
 * `document` has no `issue_date`, which is the ordinary case for a PDF attached before the invoice is
 * issued, so without a fallback the recomputation simply would not run and the stale column would stand
 * (that is what a first pass at this fix did, and the fiscal-year case stayed broken). The file's own
 * creation day is never later than its link day, so deriving from it can only produce an equal or
 * earlier answer, and `later` against the recorded date means the floor can rise and never fall. It is
 * a column and therefore stable, which the clock is not: recomputing an unanchored floor from `now`
 * would push every deadline outwards by a year every year and nothing could ever be erased.
 *
 * A purely manual retention on an UNLINKED file has no floor at all. Nothing in OR 958f applies to a
 * photo of an office plant, and inventing a ten-year lock for it would make the revDSG erasure duty
 * unservable.
 */
export function retentionFloor(ctx: WorkspaceContext, file: RetentionFacts): string | null {
  const recorded = file.retention_statutory_until;
  if (!isAccountingEntityKind(file.entity_kind)) return recorded;
  // D63: a link to a still-DRAFT record contributes nothing, so the recomputed half runs only where
  // the linked record is posted evidence. The RECORDED half stands regardless: it is only ever
  // written by posted evidence (the link to a posted record, or the posting-time hook), and a
  // deleted never-posted draft therefore releases exactly the floors it never had while a floor a
  // posted record contributed survives every later re-link, including one to a draft.
  if (!isPostedAccountingRecord(ctx, file.entity_kind, file.entity_id)) return recorded;
  const anchor =
    accountingRecordDate(ctx, file.entity_kind, file.entity_id) ?? file.created_at.slice(0, 10);
  return later(recorded, statutoryRetentionUntil(ctx, anchor));
}

/**
 * The date a file is REALLY kept to: the stored retention, never below the statutory floor.
 *
 * THE ONE EXPRESSION BOTH GUARDS USE. `deleteFile` refuses while this date has not passed, and
 * `setFileRetention` refuses a request below the floor half of it. Comparing against the stored column
 * alone is what let a manual walk-back and a fiscal-year change each release a Buchungsbeleg early,
 * and the two defects were one defect: two guards reading two different answers about one date.
 */
export function effectiveRetentionUntil(ctx: WorkspaceContext, file: RetentionFacts): string | null {
  return later(file.retention_until, retentionFloor(ctx, file));
}

/** Is `kind` a kind G00's registry knows? The single membership test E00 uses (§H-ENUM). */
export function isRegisteredEntityKind(kind: unknown): boolean {
  return entityKindDef(kind) !== undefined;
}
