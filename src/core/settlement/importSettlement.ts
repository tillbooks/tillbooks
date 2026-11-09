/**
 * `import_settlement` (D185): book a `till-settlement/v1` file through the owner's template.
 *
 * Each event of a kind the template books becomes ONE balanced entry, dated the event's `day`, source
 * `import`:
 *
 *   clearing account   amount        (positive = Soll: money into the processor balance)
 *   contra account     -net          (the template's account for the kind, carrying the VAT trace)
 *   VAT account        -vat.amount   (2200 for an output code; 1170, or 1171 for a Ziffer 405 code)
 *
 * An event with `vat: null` under an INPUT code (a seller not registered for VAT, a fee without tax) books
 * its gross as the net with no VAT line and no trace: the file states zero input VAT. Under an output code
 * a `vat: null` is checked like any stated VAT.
 *
 * THE VAT IS THE FILE'S, TO THE RAPPEN. The engine's B2 gate (`reconcileAndStampVat`) recomputes a line's
 * tax from its booked base and accepts exactly two honest one-round readings of a stated tax: the
 * net-forward one (round(net x rate)) and the gross split (round(gross x rate / (1 + rate))). The import
 * hands the file's VAT to the gate as its hint, after checking it is one of the two (`vatFits`), so the
 * MWST-Abrechnung reads the file's own base and tax. A VAT that is neither is refused for that event
 * (`vat_not_exact`): TILL never books a VAT the rate cannot produce, and never silently books another
 * Rappen than the file states. There is no path that books an arbitrary stated tax on a public source:
 * the verbatim path exists only for the engine-only `credit_note` source, by design (A13 §4b.2).
 *
 * IDEMPOTENT ON THE EXTERNAL ID. `settlement_event` holds one row per booked event, unique per
 * (workspace, source.system, source.processor, event id), written in the posting's own transaction, and
 * looked up INSIDE it: each event runs in one IMMEDIATE transaction from the lookup to the commit, so a
 * second TILL process on the same book cannot record the event in between (critic S4). The
 * same event again is `already_imported` (nothing new is written); the same id with a different kind,
 * day, currency, amount, net or VAT refuses `event_amended` naming each change, and the posted entry is
 * never edited or reversed here: a correction is a reversing entry a person makes. On top, the call has
 * its usual `idempotencyKey` (a replay answers the first report).
 *
 * PER EVENT, NEVER THE WHOLE FILE SILENTLY. An event into a locked or closed period, with an inexact VAT,
 * or refused by the format, is refused on its own with a code and a sentence; every other event still
 * books. The whole call refuses only before anything is written: an unknown schema, no template for the
 * source (`settlement_template_missing`), a kind the file carries that the template does not map
 * (`settlement_template_incomplete`), a template whose accounts or codes no longer pass
 * (`settlement_template_invalid`), or a malformed attachment.
 *
 * ATTACHMENTS: `attachments [{ fileName, contentBase64, documentNumber }]`, PDFs, linked as Belege
 * through E00's own upload and link (`attachBytes`, size-capped, deduplicated by content) to every entry
 * whose event carries that `document.number`, booked now or before. A booked event's attachment rides its
 * posting's transaction: an attachment that cannot be linked rolls that event back (`attachment_failed`).
 * On an event booked before, the entry stands and the outcome stays `already_imported`, with the code
 * `attachment_failed` and the engine's refusal as its `cause`. An attachment linked to no entry is listed
 * in `unmatchedAttachments`, whether its number matched no event or every link to it failed.
 *
 * THE RECONCILIATION SIGNAL, read from THIS file's events only (critic S5: a ledger window over the file's
 * days counted overlapping files and manual entries, and missed a payout booked after the last day).
 * `expectedClearingChangeMinor` is the sum of EVERY event amount in the file, payouts included: what the
 * processor balance moved. `bookedClearingChangeMinor` is what the entries of the file's events put on the
 * clearing account (booked now or before, net of any reversal a person booked). An event without an entry
 * is either a bank payout (`bankPayoutsMinor`, left to the bank import) or not booked by the import
 * (`notBookedByImportMinor`: skipped, refused, waiting for a person); an event with an entry is never
 * counted there, whatever the template says today. `differenceMinor` is booked - expected, and
 * `unexplainedMinor` (booked + payouts + not booked - expected) is 0 when every Rappen of the file is
 * accounted for: anything else is an amended event, a reversal or a clearing account changed since. Once
 * the bank books the payouts, the clearing account carries booked + payouts = expected - not booked: the
 * processor balance change less what the import left off it, typically the reserve the processor holds.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { computeLineTax } from '../vat/applyVat.js';
import { postEntryInternalChecked } from '../ledger/innerPosting.js';
import type { LineInput } from '../ledger/postEntry.js';
import { attachBytes } from '../files/attach.js';
import type { AttachedFile } from '../files/attach.js';
import { MAX_FILE_BYTES } from '../files/files.js';
import { readSettlementDocument, SETTLEMENT_KINDS } from './format.js';
import type { SettlementDocument, SettlementEvent, SettlementKind } from './format.js';
import { BOOKABLE_TAX_KINDS, checkTemplate, readStoredTemplate } from './template.js';
import type { KindRule, SettlementTemplate } from './template.js';

/** The largest settlement text one call takes. */
export const SETTLEMENT_MAX_BYTES = 10 * 1024 * 1024;
/** The most attachments one call takes, and their total size (E00's single-upload cap). */
export const SETTLEMENT_MAX_ATTACHMENTS = 200;
export const SETTLEMENT_ATTACHMENTS_MAX_BYTES = MAX_FILE_BYTES;

/** One sentence per event outcome reason, for an agent reading the answer. */
export const SETTLEMENT_OUTCOME_TEXT: Readonly<Record<string, string>> = {
  template_skip: 'the template skips this kind: it is booked elsewhere or stays on the clearing account',
  needs_attention: 'the template books nothing for this kind and asks a person to look at it',
  zero_amount: 'the event moves no money',
  event_amended: 'this event id was booked before with other figures; the posted entry stands, and a correction is a reversing entry a person makes',
  vat_not_exact: 'the stated VAT is not what the tax code produces on the net or the gross, so it cannot be booked to the Rappen',
  vat_unmapped: 'the event carries VAT but the template books this kind without a tax code',
  vat_not_bookable: 'the tax code does not book a deductible or owed VAT under the workspace VAT method',
  vat_account_missing: 'the chart has no VAT account this tax code books to',
  attachment_failed: 'an attachment for this event could not be linked, so the event was not booked',
  attachment_not_linked: 'the event was booked before and its entry stands, but an attachment for it could not be linked',
  period_locked: 'the period of this day is locked or closed',
};

export interface SettlementAttachmentInput {
  fileName: string;
  documentNumber: string;
  bytes: Buffer;
  sha256: string;
}

export interface ImportSettlementInput {
  settlement?: unknown;
  content?: unknown;
  attachments?: unknown;
  idempotencyKey?: unknown;
}

export interface SettlementEventOutcome {
  index: number;
  id: string | null;
  kind: string | null;
  day: string | null;
  amountMinor: number | null;
  outcome: 'booked' | 'already_imported' | 'skipped' | 'refused';
  entryId?: string;
  reason?: string;
  code?: string;
  sentence?: string;
  changed?: { field: string; was: unknown; now: unknown }[];
  /** What the refusal was about (the tax code, the figures, the account), when there is more to say. */
  detail?: Record<string, unknown>;
  /** The engine refusal behind a refused booking (the period lock, the VAT gate, the attachment). */
  cause?: Record<string, unknown>;
  attached?: { fileId: string; fileName: string; duplicate: boolean }[];
}

export interface KindTotals {
  events: number;
  booked: number;
  alreadyImported: number;
  skipped: number;
  refused: number;
  amountMinor: number;
}

export type ImportSettlementOk = {
  system: string;
  processor: string;
  templateId: string;
  events: SettlementEventOutcome[];
  booked: number;
  alreadyImported: number;
  skipped: number;
  refused: number;
  needsAttention: string[];
  totals: Record<string, KindTotals>;
  warnings: string[];
  unmatchedAttachments: { fileName: string; documentNumber: string }[];
  reconciliation: {
    clearingAccountId: string;
    from: string | null;
    to: string | null;
    expectedClearingChangeMinor: number;
    bookedClearingChangeMinor: number;
    differenceMinor: number;
    bankPayoutsMinor: number;
    notBookedByImportMinor: number;
    /** booked + bankPayouts + notBooked - expected: 0 when every Rappen of the file is accounted for. */
    unexplainedMinor: number;
    unreadableAmounts: number;
  };
};

interface Prepared {
  doc: SettlementDocument;
  templateId: string;
  template: SettlementTemplate;
  attachments: SettlementAttachmentInput[];
  scopedKey: string;
}

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with every object's keys sorted, so two spellings of one document scope one question. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The document from the call: `settlement` (the object) or `content` (its JSON text), exactly one. */
function documentOf(input: ImportSettlementInput): unknown | Err {
  const hasObject = input.settlement !== undefined && input.settlement !== null;
  const hasText = typeof input.content === 'string' && input.content.length > 0;
  if (hasObject === hasText) return err('invalid_input', { field: 'settlement', reason: 'exactly one of settlement (the JSON object) or content (its text)' });
  if (hasObject) return input.settlement;
  const text = (input.content as string).replace(/^﻿/, '');
  if (Buffer.byteLength(text, 'utf8') > SETTLEMENT_MAX_BYTES) return err('invalid_input', { field: 'content', reason: `at most ${SETTLEMENT_MAX_BYTES} bytes` });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return err('invalid_settlement', { field: 'content', reason: 'the content is not JSON' });
  }
}

/** The attachments, read and checked before anything is written. */
function readAttachments(input: unknown): SettlementAttachmentInput[] | Err {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return err('invalid_input', { field: 'attachments', reason: 'an array of { fileName, contentBase64, documentNumber }' });
  if (input.length > SETTLEMENT_MAX_ATTACHMENTS) return err('invalid_input', { field: 'attachments', reason: `at most ${SETTLEMENT_MAX_ATTACHMENTS} attachments per call` });
  const out: SettlementAttachmentInput[] = [];
  let total = 0;
  for (const [i, a] of input.entries()) {
    const field = `attachments[${i}]`;
    if (Object.prototype.toString.call(a) !== '[object Object]') return err('invalid_input', { field });
    const r = a as Record<string, unknown>;
    const fileName = r['fileName'];
    const documentNumber = r['documentNumber'];
    const b64raw = r['contentBase64'];
    if (typeof fileName !== 'string' || fileName.trim().length === 0 || fileName.length > 255) return err('invalid_input', { field: `${field}.fileName` });
    if (typeof documentNumber !== 'string' || documentNumber.trim().length === 0 || documentNumber.length > 200) return err('invalid_input', { field: `${field}.documentNumber` });
    if (typeof b64raw !== 'string' || b64raw.length === 0) return err('invalid_input', { field: `${field}.contentBase64` });
    const b64 = b64raw.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return err('invalid_input', { field: `${field}.contentBase64`, reason: 'base64 of the PDF bytes' });
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) return err('invalid_input', { field: `${field}.contentBase64`, reason: 'an empty file' });
    if (bytes.length > MAX_FILE_BYTES) return err('file_too_large', { field, bytes: bytes.length, max: MAX_FILE_BYTES });
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return err('invalid_input', { field: `${field}.contentBase64`, reason: 'a settlement attachment is a PDF' });
    total += bytes.length;
    if (total > SETTLEMENT_ATTACHMENTS_MAX_BYTES) return err('file_too_large', { field: 'attachments', bytes: total, max: SETTLEMENT_ATTACHMENTS_MAX_BYTES, reason: 'the attachments of one call together' });
    out.push({ fileName: fileName.trim(), documentNumber: documentNumber.trim(), bytes, sha256: sha256(bytes) });
  }
  return out;
}

/** Everything the import decides before it writes; shared, step for step, with the pre-draft check. */
function prepare(ctx: WorkspaceContext, input: ImportSettlementInput): Prepared | Err {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  const raw = documentOf(input);
  if (isErr(raw)) return raw;
  const read = readSettlementDocument(raw, baseCurrencyOf(ctx));
  if (!read.ok) return err(read.error, { ...(read.field !== undefined ? { field: read.field } : {}), reason: read.reason });
  const doc = read.document;
  const attachments = readAttachments(input.attachments);
  if (isErr(attachments)) return attachments;
  if (attachments.length > 0) {
    const capable = ctx.capabilities.assert('manage_files');
    if (!capable.ok) return capable as Err;
  }
  const stored = readStoredTemplate(ctx, doc.system, doc.processor);
  if (stored === null) {
    return err('settlement_template_missing', {
      system: doc.system,
      processor: doc.processor,
      reason: `no booking template for ${doc.system} / ${doc.processor}: set one with set_settlement_template (the clearing account, and per kind the contra account and tax code)`,
    });
  }
  const invalid = checkTemplate(ctx, stored.template);
  if (invalid !== null) {
    return err('settlement_template_invalid', {
      system: doc.system,
      processor: doc.processor,
      templateId: stored.templateId,
      cause: invalid,
      reason: 'the template names an account or a tax code that no longer passes: save it again with set_settlement_template',
    });
  }
  const unmapped = [...new Set(doc.events.map((e) => e.kind))].filter((k) => stored.template.kinds[k] === undefined);
  if (unmapped.length > 0) {
    return err('settlement_template_incomplete', {
      system: doc.system,
      processor: doc.processor,
      templateId: stored.templateId,
      unmappedKinds: SETTLEMENT_KINDS.filter((k) => unmapped.includes(k)),
      reason: `the file carries ${unmapped.join(', ')}, which the template does not map: give each a contra account and tax code (book), or skip it`,
    });
  }
  const attachDigest = sha256(canonicalJson(attachments.map((a) => [a.fileName, a.documentNumber, a.sha256])));
  const scopedKey = JSON.stringify(['import_settlement', input.idempotencyKey, sha256(canonicalJson(raw)), attachDigest]);
  return { doc, templateId: stored.templateId, template: stored.template, attachments, scopedKey };
}

/** The account id of a chart number, or undefined. */
function accountIdByNumber(ctx: WorkspaceContext, number: string): string | undefined {
  return (ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number) as { id: string } | undefined)?.id;
}

/** A signed amount on its side: positive is Soll, negative is Haben. */
function sided(account: string, signedMinor: number, extra: Partial<LineInput> = {}): LineInput {
  return signedMinor > 0 ? { account, debit: signedMinor, ...extra } : { account, credit: 0 - signedMinor, ...extra };
}

type LinesOrRefusal = { lines: LineInput[] } | { code: string; detail?: Record<string, unknown> };

/**
 * Is the stated VAT one of the two honest one-round readings the B2 gate accepts on this base? Net-forward
 * (round(net x rate)) or the gross split of net + VAT (which must give back the same net). Magnitudes:
 * the gate signs the trace by the line's side.
 */
function vatFits(ctx: WorkspaceContext, taxCode: string, day: string, netAbs: number, vatAbs: number): boolean {
  const forward = computeLineTax(ctx, { amountMinor: netAbs, amountIsGross: false, taxCode, supplyDate: day });
  if (forward.ok && forward.taxMinor === vatAbs) return true;
  const split = computeLineTax(ctx, { amountMinor: netAbs + vatAbs, amountIsGross: true, taxCode, supplyDate: day });
  return split.ok && split.taxMinor === vatAbs && split.netMinor === netAbs;
}

/** The lines of one booked event, or the refusal that keeps it out of the books. */
function linesFor(ctx: WorkspaceContext, template: SettlementTemplate, rule: Extract<KindRule, { action: 'book' }>, event: SettlementEvent): LinesOrRefusal {
  const amount = event.amountMinor;
  const net = event.netMinor;
  const vat = event.vatMinor ?? 0;
  const lines: LineInput[] = [];
  if (amount !== 0) lines.push(sided(template.clearingAccountId, amount));
  if (vat !== 0 && rule.taxCode === null) return { code: 'vat_unmapped' };
  if (rule.taxCode === null) {
    if (net !== 0) lines.push(sided(rule.accountId, 0 - net));
    return { lines };
  }
  const probe = computeLineTax(ctx, { amountMinor: Math.max(Math.abs(net), 1), amountIsGross: false, taxCode: rule.taxCode, supplyDate: event.day });
  if (!probe.ok) return { code: (probe as Err).error, detail: { taxCode: rule.taxCode } };
  const kind = probe.kind as string;
  if (!BOOKABLE_TAX_KINDS.has(kind)) return { code: 'vat_not_bookable', detail: { taxCode: rule.taxCode, kind } };
  // A PURCHASE THE FILE STATES WITHOUT VAT (`vat: null`): a payout to a seller who is not registered for
  // VAT, a fee charged without tax. One kind mixes both (`third_party_payout` pays registered and
  // unregistered sellers alike), so the input code cannot refuse it: the file states zero input VAT, and
  // zero input VAT is what is booked, the gross as the net, with no VAT line and no VAT trace (nothing to
  // deduct, so the code's deductibility does not matter here). A SALE stays strict: under an output code a
  // `vat: null` is checked like any stated VAT, and refuses `vat_not_exact` when the code owes tax on it.
  if (kind === 'input' && event.vatMinor === null) {
    if (net !== 0) lines.push(sided(rule.accountId, 0 - net));
    return { lines };
  }
  if (kind === 'input' && probe.deductible !== true) return { code: 'vat_not_bookable', detail: { taxCode: rule.taxCode, deductible: false } };
  // The VAT runs with its base: a sale owes tax on a positive net, a refund reduces it on a negative one.
  if (vat !== 0 && (net === 0 || Math.sign(vat) !== Math.sign(net))) return { code: 'vat_not_exact', detail: { netMinor: net, vatMinor: vat } };
  if (net !== 0 && !vatFits(ctx, rule.taxCode, event.day, Math.abs(net), Math.abs(vat))) {
    return { code: 'vat_not_exact', detail: { taxCode: rule.taxCode, netMinor: net, vatMinor: vat } };
  }
  if (net !== 0) lines.push(sided(rule.accountId, 0 - net, { taxCode: rule.taxCode, taxAmount: Math.abs(vat) }));
  if (vat !== 0) {
    const vatNumber = kind === 'output' ? '2200' : probe.formLine === '405' ? '1171' : '1170';
    const vatAccount = accountIdByNumber(ctx, vatNumber);
    if (vatAccount === undefined) return { code: 'vat_account_missing', detail: { account: vatNumber } };
    lines.push(sided(vatAccount, 0 - vat));
  }
  return { lines };
}

interface StoredEventRow {
  kind: string;
  day: string;
  currency: string;
  amount_minor: number;
  net_minor: number;
  vat_minor: number | null;
  entry_id: string;
}

/** What differs between a booked event and the file's event of the same id. */
function amendments(stored: StoredEventRow, e: SettlementEvent): { field: string; was: unknown; now: unknown }[] {
  const out: { field: string; was: unknown; now: unknown }[] = [];
  const cmp = (field: string, was: unknown, now: unknown): void => {
    if (was !== now) out.push({ field, was, now });
  };
  cmp('kind', stored.kind, e.kind);
  cmp('day', stored.day, e.day);
  cmp('currency', stored.currency, e.currency);
  cmp('amountMinor', stored.amount_minor, e.amountMinor);
  cmp('netMinor', stored.net_minor, e.netMinor);
  cmp('vatMinor', stored.vat_minor, e.vatMinor);
  return out;
}

/**
 * Thrown inside a booking's transaction to roll it back with a refusal. `step` says which step refused:
 * the posting, or the attachment (so the outcome names `attachment_failed` whatever E00's own code is).
 */
class SettlementAbort extends Error {
  constructor(
    readonly result: Err,
    readonly step: 'post' | 'attach' = 'post',
  ) {
    super(result.error);
  }
}

function attachAll(ctx: WorkspaceContext, files: readonly SettlementAttachmentInput[], entryId: string): AttachedFile[] {
  const out: AttachedFile[] = [];
  for (const f of files) {
    const linked = attachBytes(ctx, { bytes: f.bytes, mime: 'application/pdf', filename: f.fileName, sha256: f.sha256 }, 'journal_entry', entryId);
    if (isErr(linked)) throw new SettlementAbort(linked, 'attach');
    out.push(linked);
  }
  return out;
}

const attachedView = (files: AttachedFile[], byId: Map<string, string>): { fileId: string; fileName: string; duplicate: boolean }[] =>
  files.map((f) => ({ fileId: f.fileId, fileName: byId.get(f.sha256) ?? f.filename, duplicate: f.duplicate }));

/**
 * What THESE entries put on one account, base currency: each entry and every posted entry that reverses
 * it (a person's correction), and nothing else in the ledger.
 */
function movementOfEntries(ctx: WorkspaceContext, accountId: string, entryIds: readonly string[]): number {
  const one = ctx.store.db.prepare(
    `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND (e.id = ? OR e.reverses_entry_id = ?)`,
  );
  let net = 0;
  for (const id of entryIds) net += (one.get(ctx.workspaceId, accountId, id, id) as { net: number }).net;
  return net;
}

/** The import's internal posting key: the external identity, never anything a caller chooses. */
function postingKeyOf(system: string, processor: string, eventId: string): string {
  return `settlement:${sha256(JSON.stringify([system, processor, eventId]))}`;
}

/**
 * `import_settlement`: book a settlement file through the owner's template (module header). Needs `post`
 * (and `manage_files` when it carries attachments).
 */
export function importSettlement(ctx: WorkspaceContext, input: ImportSettlementInput): Result<ImportSettlementOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepare(ctx, input);
  if (isErr(prepared)) return prepared;
  const { doc, template, templateId, attachments, scopedKey } = prepared;
  const replayed = ctx.store.recallIdempotent<Result<ImportSettlementOk>>(ctx.workspaceId, scopedKey, 'import_settlement');
  if (replayed !== undefined) return replayed;

  const byDocument = new Map<string, SettlementAttachmentInput[]>();
  for (const a of attachments) byDocument.set(a.documentNumber, [...(byDocument.get(a.documentNumber) ?? []), a]);
  const nameBySha = new Map(attachments.map((a) => [a.sha256, a.fileName]));
  const usedDocuments = new Set<string>();

  const outcomes: SettlementEventOutcome[] = [];
  for (const r of doc.refused) {
    outcomes.push({ index: r.index, id: r.id, kind: r.kind, day: null, amountMinor: r.amountMinor, outcome: 'refused', code: r.code, sentence: r.reason });
  }
  const findStored = ctx.store.db.prepare(
    'SELECT kind, day, currency, amount_minor, net_minor, vat_minor, entry_id FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ?',
  );
  const insertEvent = ctx.store.db.prepare(
    `INSERT INTO settlement_event (id, workspace_id, source_system, source_processor, event_id, kind, day, currency, amount_minor, net_minor, vat_minor,
       entry_id, document_number, counterparty, refs_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const e of doc.events) {
    const base = { index: e.index, id: e.id, kind: e.kind, day: e.day, amountMinor: e.amountMinor };
    const rule = template.kinds[e.kind] as KindRule;
    if (rule.action === 'skip' || rule.action === 'attention') {
      const reason = rule.action === 'skip' ? 'template_skip' : 'needs_attention';
      // A kind the template skips NOW may have been booked by an earlier template: the outcome names that
      // entry, and the reconciliation counts the event as booked, not as left off the clearing account.
      const earlier = findStored.get(ctx.workspaceId, doc.system, doc.processor, e.id) as StoredEventRow | undefined;
      outcomes.push({ ...base, outcome: 'skipped', reason, sentence: SETTLEMENT_OUTCOME_TEXT[reason] as string, ...(earlier !== undefined ? { entryId: earlier.entry_id } : {}) });
      continue;
    }
    const files = e.documentNumber !== null ? (byDocument.get(e.documentNumber) ?? []) : [];
    // ONE IMMEDIATE TRANSACTION PER EVENT, the lookup of its external id INCLUDED. The write lock is held
    // from the lookup to the commit, so a second TILL process (D12: the Studio beside `till mcp`) cannot
    // record the same event in between: it waits, and finds the row this call wrote. Inside, the booking
    // and an attachment to an earlier entry run as savepoints, so a refusal rolls back only that step.
    const outcome = ctx.store.tx((): SettlementEventOutcome => {
      const stored = findStored.get(ctx.workspaceId, doc.system, doc.processor, e.id) as StoredEventRow | undefined;
      if (stored !== undefined) {
        const changed = amendments(stored, e);
        if (changed.length > 0) {
          return { ...base, outcome: 'refused', code: 'event_amended', sentence: SETTLEMENT_OUTCOME_TEXT['event_amended'] as string, entryId: stored.entry_id, changed };
        }
        if (files.length === 0) return { ...base, outcome: 'already_imported', entryId: stored.entry_id };
        try {
          const attached = ctx.store.tx(() => attachAll(ctx, files, stored.entry_id));
          return { ...base, outcome: 'already_imported', entryId: stored.entry_id, ...(attached.length > 0 ? { attached: attachedView(attached, nameBySha) } : {}) };
        } catch (x) {
          if (!(x instanceof SettlementAbort)) throw x;
          // The event stays booked (its entry stands); only the Beleg is missing, and the answer says so.
          return {
            ...base,
            outcome: 'already_imported',
            entryId: stored.entry_id,
            code: 'attachment_failed',
            sentence: SETTLEMENT_OUTCOME_TEXT['attachment_not_linked'] as string,
            cause: x.result as unknown as Record<string, unknown>,
          };
        }
      }
      if (e.amountMinor === 0 && e.netMinor === 0 && (e.vatMinor ?? 0) === 0) {
        return { ...base, outcome: 'skipped', reason: 'zero_amount', sentence: SETTLEMENT_OUTCOME_TEXT['zero_amount'] as string };
      }
      const built = linesFor(ctx, template, rule, e);
      if ('code' in built) {
        return { ...base, outcome: 'refused', code: built.code, sentence: SETTLEMENT_OUTCOME_TEXT[built.code] ?? built.code, ...(built.detail !== undefined ? { detail: built.detail } : {}) };
      }
      const description = [e.description, e.counterparty].filter((s): s is string => s !== null).join(' - ');
      try {
        const done = ctx.store.tx(() => {
          const posted = postEntryInternalChecked(
            ctx,
            {
              date: e.day,
              ...(description.length > 0 ? { description } : {}),
              ...(e.documentNumber !== null ? { ref: e.documentNumber } : {}),
              lines: built.lines,
              source: 'import',
              idempotencyKey: postingKeyOf(doc.system, doc.processor, e.id),
            },
            'import_settlement_internal',
          );
          if (!posted.ok) throw new SettlementAbort(posted as Err);
          insertEvent.run(
            ctx.ids.next('stlevt'),
            ctx.workspaceId,
            doc.system,
            doc.processor,
            e.id,
            e.kind,
            e.day,
            e.currency,
            e.amountMinor,
            e.netMinor,
            e.vatMinor,
            posted.entryId,
            e.documentNumber,
            e.counterparty,
            e.refsJson,
            ctx.actor,
            ctx.clock.now(),
          );
          return { entryId: posted.entryId, attached: attachAll(ctx, files, posted.entryId) };
        });
        return { ...base, outcome: 'booked', entryId: done.entryId, ...(done.attached.length > 0 ? { attached: attachedView(done.attached, nameBySha) } : {}) };
      } catch (x) {
        if (!(x instanceof SettlementAbort)) throw x;
        const r = x.result as unknown as Record<string, unknown>;
        const raw = typeof r['error'] === 'string' ? (r['error'] as string) : 'refused';
        const fromAttach = x.step === 'attach';
        const code = raw === 'vat_trace_unreconciled' ? 'vat_not_exact' : raw;
        return {
          ...base,
          outcome: 'refused',
          code: fromAttach ? 'attachment_failed' : code,
          sentence: SETTLEMENT_OUTCOME_TEXT[fromAttach ? 'attachment_failed' : code] ?? (typeof r['reason'] === 'string' ? (r['reason'] as string) : code),
          cause: r,
        };
      }
    });
    // A document counts as used only once its files are linked: a failed link leaves it in
    // `unmatchedAttachments`, so the answer never hides a Beleg that was filed nowhere.
    if (outcome.attached !== undefined && e.documentNumber !== null) usedDocuments.add(e.documentNumber);
    outcomes.push(outcome);
  }
  outcomes.sort((a, b) => a.index - b.index);

  const totals: Record<string, KindTotals> = {};
  for (const o of outcomes) {
    const k = o.kind ?? 'unreadable';
    const t = (totals[k] ??= { events: 0, booked: 0, alreadyImported: 0, skipped: 0, refused: 0, amountMinor: 0 });
    t.events += 1;
    if (o.outcome === 'booked') t.booked += 1;
    else if (o.outcome === 'already_imported') t.alreadyImported += 1;
    else if (o.outcome === 'skipped') t.skipped += 1;
    else t.refused += 1;
    t.amountMinor += o.amountMinor ?? 0;
  }

  const days = doc.events.map((e) => e.day).sort();
  const from = days[0] ?? null;
  const to = days[days.length - 1] ?? null;
  const expected = outcomes.reduce((s, o) => s + (o.amountMinor ?? 0), 0);
  // Each event is classified by whether it HAS an entry (booked now, booked before, amended since, or
  // booked before under a template that now skips its kind), never by the template in force.
  const isPayout = (k: string | null): boolean => k === 'bank_payout' || k === 'bank_payout_summary';
  const sumOf = (list: SettlementEventOutcome[]): number => list.reduce((s, o) => s + (o.amountMinor ?? 0), 0);
  const withoutEntry = outcomes.filter((o) => o.entryId === undefined);
  const bankPayouts = sumOf(withoutEntry.filter((o) => isPayout(o.kind)));
  const notBooked = sumOf(withoutEntry.filter((o) => !isPayout(o.kind)));
  const entryIds = [...new Set(outcomes.flatMap((o) => (o.entryId !== undefined ? [o.entryId] : [])))];
  const booked = movementOfEntries(ctx, template.clearingAccountId, entryIds);

  const count = (k: SettlementEventOutcome['outcome']): number => outcomes.filter((o) => o.outcome === k).length;
  const body: ImportSettlementOk = {
    system: doc.system,
    processor: doc.processor,
    templateId,
    events: outcomes,
    booked: count('booked'),
    alreadyImported: count('already_imported'),
    skipped: count('skipped'),
    refused: count('refused'),
    needsAttention: outcomes.filter((o) => o.reason === 'needs_attention' && o.id !== null).map((o) => o.id as string),
    totals,
    warnings: doc.warnings,
    unmatchedAttachments: attachments.filter((a) => !usedDocuments.has(a.documentNumber)).map((a) => ({ fileName: a.fileName, documentNumber: a.documentNumber })),
    reconciliation: {
      clearingAccountId: template.clearingAccountId,
      from,
      to,
      expectedClearingChangeMinor: expected,
      bookedClearingChangeMinor: booked,
      differenceMinor: booked - expected,
      bankPayoutsMinor: bankPayouts,
      notBookedByImportMinor: notBooked,
      unexplainedMinor: booked + bankPayouts + notBooked - expected,
      unreadableAmounts: outcomes.filter((o) => o.amountMinor === null).length,
    },
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_settlement', () => ok<ImportSettlementOk>(body));
}

/**
 * D158/D162: the import's own validation with nothing written, for the transport seam to run before it
 * drafts a governed seat's call: the schema, the template (present, complete, still valid) and the
 * attachments. Per-event outcomes are the answer, not a refusal, so they are not decided here. Undefined
 * when the import would run, or would replay its key.
 */
export function prevalidateImportSettlement(ctx: WorkspaceContext, input: ImportSettlementInput): Result | undefined {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepare(ctx, input);
  if (isErr(prepared)) return prepared;
  return undefined;
}

/** The kinds `import_settlement` reports totals for, in the format's order (for a reader building a table). */
export const SETTLEMENT_TOTAL_KINDS: readonly SettlementKind[] = SETTLEMENT_KINDS;
