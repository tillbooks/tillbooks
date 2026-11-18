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
 * looked up INSIDE it: the lookup and the commit sit in one IMMEDIATE transaction (since the D198 re-cut the
 * import's whole memo transaction), so a second TILL process on the same book cannot record the event in
 * between (critic S4). The
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
 *
 * D198 RE-CUT (12.11.2026): THE ONE DOOR decides for a pull and a file alike.
 *  - A document with `complete: false` is refused whole (`settlement_incomplete`, R3): nothing written.
 *  - The whole import runs inside its own idempotent memo transaction, after every whole-file check, so a
 *    refused import and a replay leave nothing behind (security review, 12.11.2026). First it records what it SAW: the flags of every event
 *    (`flags.ts`, from the raw event), the observed record of every readable event (`settlement_feed_event`,
 *    first sighting, its pull id or NULL for a file: the import is its one writer) and every stated payout
 *    link (`settlement_feed_payout_ref`).
 *  - PER EVENT, in this order: ONE COMPARISON ON ARRIVAL (the owner's answer of 12.11.2026, `restated.ts`):
 *    the event is compared with the producer's LATEST STATED figures for its id (the first sighting, or its
 *    newest restatement), and any difference in kind, day, amount, net or VAT logs a `restated` row (code
 *    `event_amended`, `changed` from the latest stated to this arrival), whatever the template, the stored
 *    row or the override says; the answer carries it as `restated`. Then the stored-event lookup (D185:
 *    `event_amended` when the arrival differs from the booked figures, whatever the template does with the
 *    kind now; else `already_imported`, or the template's skip answer naming the entry), the OVERRIDE (a
 *    person marked the event `handled_outside` with `resolve_settlement_event`: `skipped`, reason
 *    `handled_outside`), the from-date floor (R2: `skipped`, reason `before_from_date`), the test check (R1:
 *    `skipped`, reason `test_event`, under the settings `settlement.test_events` and
 *    `settlement.test_fees`), then the template. Only an event with no stored row can be skipped by the last
 *    four. The override and the test track are read inside the event's own transaction, so a concurrent
 *    answer cannot slip between the read and the booking.
 *  - AFTER the loop, one `settlement_feed_outcome` row per event: the import's append-only LOG (the facts of
 *    a reader refusal are read from it by the pre-filing check).
 *  The per-event steps run as savepoints of that one transaction.
 *  - A `third_party_payout`, `third_party_payout_reversal` or `processing_fee` without a transaction key is
 *    named in `warnings`: it cannot be tied to a test payment.
 *
 * D206, THE WHOLE-DAY MODE, ENFORCED HERE AGAIN (paper critic F4, the chokepoint). A whole-day event (`day:` id,
 * minted by the table door) is booked only while `settlement.table_event_id` is `column_else_day` and the source's
 * saved mapping, confirmed by a person to list whole days, minted it (`day_mode_unconfirmed`, whole file, nothing
 * written). INSIDE the memo transaction, BEFORE anything is recorded as observed, each day of such events is compared
 * with what the source holds on it (`dayMode.ts`): a new day, or a held day of exactly these whole-day events, goes
 * on to the events loop; any other held day refuses EVERY one of its events `day_differs` (never already_imported,
 * never event_amended), and its events are not recorded as observed, so the held day stays as the books know it. A
 * day of today or later refuses `day_not_over`. A table event with an id column on a day the source holds by whole
 * days, whose id the source has not seen, refuses `day_differs` too (F7). Two previews of one new day, booked one
 * after the other, therefore book the day once: the second meets the first's events here.
 *
 * THE EDGES (security review, 16.11.2026: never from the document). The import itself takes the first and the last
 * day of the document's whole-day events and, when such a day is new to the source, applies
 * `settlement.table_edge_days`: `include` books it, `exclude` refuses its events `edge_day_excluded`, `ask` books it
 * only when THIS CALL's `confirmEdgeDays` names it (the person's answer that the day is complete), else
 * `edge_day_unconfirmed`. The answer is honoured from a person only: a governed seat executing a call that carries
 * it is refused `person_decides` (its import is drafted as a Vorschlag first, the card shows the answer, and the
 * approval replays it as the approving person; the approval never adds it, `APPROVAL_CONFIRM_NOT_SET`). Each edge day
 * the answer lets in is audited `confirm_edge_day`. A held edge day of exactly its own whole-day events was let in
 * when it was first booked, so it passes through without a new answer. A person's `fileDays` (the whole file's first
 * and last day) replaces the document's edges; a new first or last day of the document it says is not an edge is
 * audited `file_days_inner` (critic r2 M-B). Any new day carrying an amount the source holds on the day before or after
 * (`nearHeldOf`, critic r2 M-A and r4 H-1) is decided as `ask` whatever the setting (an edge under `exclude` stays out).
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
import {
  KEYLESS_WARNED_KINDS,
  isTestEvent,
  rawFlagEventsOf,
  recordFlags,
  recordPayoutRefs,
  testEventsModeOf,
  testFeesModeOf,
  testSkips,
} from './flags.js';
import type { RawFlagEvent } from './flags.js';
import { figureChanges, latestStatedOf } from './restated.js';
import type { FigureChange } from './restated.js';
import { activeOverridesOf } from './overrides.js';
import { dayModeRefusalOf, edgeVerdictOf, readConfirmEdgeDays, readFileDays, readStoredTableMapping, unconfirmedRecipesOf } from './tableMapping.js';
import { daysBetween, heldVerdictOf, holdsDayIds, isDayId, movedFromNeighbourOf, nearHeldOf, newDayModeOf, observedByDay, shiftDay, silentHeldDaysOf, swissTodayOf, tableEdgeDaysModeOf } from './dayMode.js';
import type { HeldVerdict } from './dayMode.js';
import { isGovernedSeat } from '../access/index.js';
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
  before_from_date: "the event is dated before the source's from-date, so it is never booked here (save another from-date to book it)",
  test_event: 'the event belongs to a test payment, which settlement.test_events keeps off the books',
  handled_outside: 'a person marked this event handled outside the import (resolve_settlement_event handled_outside), so the import books nothing for it',
  ignored: 'a person ignored this event in the Umsatz review (set_settlement_event_ignored), so the import books nothing for it',
  day_differs: 'the books already hold this day otherwise (another file, another door, or other amounts): nothing of the day is booked again; book the difference by hand',
  day_not_over: 'the day is today or later, so a whole-day table cannot list it whole yet: nothing of it is booked',
  edge_day_excluded: 'the first or last day of a whole-day file may be cut at a time of day, and settlement.table_edge_days leaves it out',
  edge_day_unconfirmed: 'the first or last day of a whole-day file may be cut at a time of day: a person names it in confirmEdgeDays to book it',
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
  /**
   * A42: the `reviewSha256` of the Umsatz review the person booked from. Given, the import refuses
   * `review_stale`, rolling everything back, when what it is about to do (`reviewSha256` of its own answer)
   * differs from what the review showed.
   */
  expectReviewSha256?: unknown;
  /**
   * D206: the days of a whole-day document a PERSON says are complete (ISO days), so its first and last day book
   * under `settlement.table_edge_days` `ask`. Read from the call, never from the document.
   */
  confirmEdgeDays?: unknown;
  /**
   * D206 (critic r1 M2): the first and last day of the whole file a whole-day document came from, a PERSON's call
   * input, so a period's part keeps the file's real edges. Absent, the document's own first and last day.
   */
  fileDays?: unknown;
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
  /** The producer restated the event: what differs from its latest stated figures (logged `event_amended`). */
  restated?: FigureChange[];
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
  /**
   * A42: the digest of WHAT THIS IMPORT DOES (`outcomeDigestOf`): every event's outcome and reason or code, its
   * figures, and the lines of every entry it books. The Umsatz review shows it; a booking that passes it back as
   * `expectReviewSha256` refuses `review_stale` when the import would now do anything else.
   */
  reviewSha256: string;
};

interface Prepared {
  doc: SettlementDocument;
  rawEvents: RawFlagEvent[];
  templateId: string;
  template: SettlementTemplate;
  attachments: SettlementAttachmentInput[];
  scopedKey: string;
  confirmEdgeDays: string[];
  fileDays: { first: string; last: string } | null;
}

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A42 (code critic r1 H1/H2, the chokepoint): the digest of WHAT AN IMPORT DOES, read from its own outcomes
 * inside its own transaction: per event (sorted, so the producer's order does not matter) its id, outcome,
 * reason or code, kind, day and amount, and for an event it books the lines of the entry (account number,
 * base debit and credit, tax code and tax amount) and the entry's own date, reference and text (code critic r2
 * L1: a changed payer name changes what is booked, so it changes the digest). Whatever input moved between a review and its booking (the
 * document, an answer, a setting, the template, the from-date, a lock), the digest moves only when the import
 * would do something else, and then the booking refuses `review_stale`. Entry ids, keys and times are left out.
 */
export function outcomeDigestOf(ctx: WorkspaceContext, outcomes: readonly SettlementEventOutcome[]): string {
  const lines = ctx.store.db.prepare(
    `SELECT a.number AS account, l.base_debit_minor AS d, l.base_credit_minor AS c, l.tax_code AS code, l.tax_amount_minor AS tax
       FROM journal_line l JOIN account a ON a.id = l.account_id AND a.workspace_id = ?
      WHERE l.entry_id = ? ORDER BY a.number, l.base_debit_minor, l.base_credit_minor, l.tax_code`,
  );
  const header = ctx.store.db.prepare('SELECT date, ref, description FROM journal_entry WHERE workspace_id = ? AND id = ?');
  const rows = outcomes.map((o) => [
    o.id,
    o.index,
    o.outcome,
    o.reason ?? o.code ?? null,
    o.kind,
    o.day,
    o.amountMinor,
    o.outcome === 'booked' && o.entryId !== undefined ? { entry: header.get(ctx.workspaceId, o.entryId) ?? null, lines: lines.all(ctx.workspaceId, o.entryId) } : null,
  ]);
  rows.sort((x, y) => {
    const a = JSON.stringify([x[0], x[3] === null ? '' : x[3], x[1]]);
    const b = JSON.stringify([y[0], y[3] === null ? '' : y[3], y[1]]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return sha256(canonicalJson(rows.map((r) => [r[0], r[2], r[3], r[4], r[5], r[6], r[7]])));
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
  // R3 (D198 re-cut): an INCOMPLETE document (the producer could not read every list) is never imported, on
  // either door; nothing of it is written here. Absent `complete` counts as true (pack files before PR 1055).
  if ((raw as Record<string, unknown>)['complete'] === false) {
    return err('settlement_incomplete', {
      system: doc.system,
      processor: doc.processor,
      reason: 'the document says complete: false (the producer could not read every list): it is never imported; fetch or export it again once it is complete',
    });
  }
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
  // A43 §2 (re-critic round 3, L2): a table document whose events were minted under an id derivation the source has
  // not booked under and no saved mapping holds would book booked rows again under new ids. Refused whole, before
  // anything is written; a person confirms the new derivation by saving the mapping with confirmIdChange.
  const unconfirmed = unconfirmedRecipesOf(ctx, doc.system, doc.processor, doc.events.map((e) => e.refsJson));
  if (unconfirmed.length > 0) {
    return err('event_id_derivation_changed', {
      system: doc.system,
      processor: doc.processor,
      recipes: unconfirmed,
      reason: 'the table events of this file were minted under an id derivation this source has not booked under: save the mapping with confirmIdChange (a person) before importing it',
    });
  }
  // D206: whole-day events only from a whole-day mapping a person saved, under the setting that allows them.
  const dayRefusal = dayModeRefusalOf(ctx, doc.system, doc.processor, doc.events);
  if (dayRefusal !== null) return dayRefusal;
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
  const confirmEdgeDays = readConfirmEdgeDays(input.confirmEdgeDays);
  if (isErr(confirmEdgeDays)) return confirmEdgeDays;
  const fileDays = readFileDays(input.fileDays);
  if (fileDays !== null && isErr(fileDays)) return fileDays;
  if (fileDays !== null) {
    const days = doc.events.filter((e) => isDayId(e.id)).map((e) => e.day).sort();
    if (days.length > 0 && (fileDays.first > (days[0] as string) || fileDays.last < (days[days.length - 1] as string))) {
      return err('invalid_input', { field: 'fileDays', reason: `the file's days must cover the document's whole-day days (${days[0]} to ${days[days.length - 1]})` });
    }
  }
  const attachDigest = sha256(canonicalJson(attachments.map((a) => [a.fileName, a.documentNumber, a.sha256])));
  const scopedKey = JSON.stringify(['import_settlement', input.idempotencyKey, sha256(canonicalJson(raw)), attachDigest, ...(confirmEdgeDays.length > 0 ? [[...confirmEdgeDays].sort()] : []), ...(fileDays !== null ? [[fileDays.first, fileDays.last]] : [])]);
  return { doc, rawEvents: rawFlagEventsOf(raw), templateId: stored.templateId, template: stored.template, attachments, scopedKey, confirmEdgeDays, fileDays };
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

/** What only the pull hands the import: never part of the public input. */
export interface ImportSettlementInternal {
  /** The pull this import runs under (its observed rows and outcomes carry it); absent for a file. */
  pullId?: string;
}

/**
 * The observed record (`settlement_feed_event`): every readable event of the document, FIRST sighting only
 * (append-only, unique per external id). `test` is the raw flag of that sighting; the live status is read
 * from `settlement_feed_flag` (`flags.ts`). The one writer, on both doors (paper critic r8 L5).
 */
function recordObserved(ctx: WorkspaceContext, doc: SettlementDocument, rawEvents: readonly RawFlagEvent[], pullId: string | null, skip: ReadonlySet<number> = new Set()): void {
  const rawTest = new Set(rawEvents.filter((r) => r.test).map((r) => r.id));
  const rawPayout = new Map(rawEvents.map((r) => [r.id, r.payoutId]));
  const insert = ctx.store.db.prepare(
    `INSERT OR IGNORE INTO settlement_feed_event (id, workspace_id, source_system, source_processor, event_id, kind, day, amount_minor, net_minor, vat_minor, payout_ref, test, refs_json, pull_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = ctx.clock.now();
  for (const e of doc.events) {
    if (skip.has(e.index)) continue;
    insert.run(
      ctx.ids.next('stlfev'),
      ctx.workspaceId,
      doc.system,
      doc.processor,
      e.id,
      e.kind,
      e.day,
      e.amountMinor,
      e.netMinor,
      e.vatMinor,
      rawPayout.get(e.id) ?? null,
      rawTest.has(e.id) ? 1 : 0,
      e.refsJson,
      pullId,
      now,
    );
  }
}

/** R4: one `settlement_feed_outcome` row per event of the document (latest wins). */
function recordOutcomes(ctx: WorkspaceContext, system: string, processor: string, outcomes: readonly SettlementEventOutcome[], pullId: string | null): void {
  const insert = ctx.store.db.prepare(
    `INSERT INTO settlement_feed_outcome (id, workspace_id, source_system, source_processor, event_id, pull_id, outcome, code, changed_json, kind, day, amount_minor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = ctx.clock.now();
  for (const o of outcomes) {
    insert.run(
      ctx.ids.next('stlout'),
      ctx.workspaceId,
      system,
      processor,
      o.id,
      pullId,
      o.outcome,
      o.code ?? o.reason ?? null,
      o.changed !== undefined ? JSON.stringify(o.changed) : null,
      o.kind,
      o.day,
      o.amountMinor,
      now,
    );
  }
}

/** The keyless warning (module header): events that cannot be tied to a test payment. */
function keylessWarnings(doc: SettlementDocument, rawEvents: readonly RawFlagEvent[]): string[] {
  const keyed = new Set(rawEvents.filter((r) => r.keys.length > 0).map((r) => r.id));
  return doc.events
    .filter((e) => KEYLESS_WARNED_KINDS.has(e.kind) && !keyed.has(e.id))
    .map((e) => `${e.kind} ${e.id} carries no chargeId, paymentIntentId, paymentId or transferId: TILL cannot tie it to a test payment`);
}

/**
 * `import_settlement`: book a settlement file through the owner's template (module header). Needs `post`
 * (and `manage_files` when it carries attachments).
 */
export function importSettlement(ctx: WorkspaceContext, input: ImportSettlementInput, internal: ImportSettlementInternal = {}): Result<ImportSettlementOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepare(ctx, input);
  if (isErr(prepared)) return prepared;
  const { doc, rawEvents, template, templateId, attachments, scopedKey, confirmEdgeDays, fileDays } = prepared;
  // D206: the answer that a day is complete is a person's; a governed seat's call carrying it is refused here (its
  // draft check lets it through, so the Vorschlag shows it and the approving person runs it).
  if (confirmEdgeDays.length > 0 && isGovernedSeat(ctx.store, ctx.actor)) {
    return err('person_decides', { field: 'confirmEdgeDays', reason: 'whether the first and last day of a file are complete is a person\'s answer; an agent proposes it' });
  }
  // D206 (critic r1 M2, L1): which days are the file's edges is a person's input too; an agent's import keeps the
  // document's own edges (safe: it may ask about more days, never fewer).
  if (fileDays !== null && isGovernedSeat(ctx.store, ctx.actor)) {
    return err('person_decides', { field: 'fileDays', reason: 'the first and last day of the whole file come from the person\'s own read of it; an agent\'s import keeps the document\'s own edges' });
  }
  const replayed = ctx.store.recallIdempotent<Result<ImportSettlementOk>>(ctx.workspaceId, scopedKey, 'import_settlement');
  if (replayed !== undefined) return replayed;
  const pullId = internal.pullId ?? null;

  try {
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_settlement', () => {
    // WHAT WAS SEEN, before anything is decided (module header, R1 and R4): the flags of every event, the
    // observed record of every readable event, every stated payout link. Written only AFTER every whole-file
    // check passed (`prepare` above) and INSIDE the import's own memo transaction (security review,
    // 12.11.2026): a refused import and a replay of the same key leave nothing behind. The per-event
    // transactions below run as savepoints inside it.
    // D206 (F4): the whole-day check, BEFORE this document is recorded as observed (else every day would equal
    // itself). A day that is not new and not exactly its own whole-day events refuses every one of its events.
    const { refused: dayRefused, letIn: edgesLetIn, movedOff: edgesMovedOff } = wholeDayRefusalsOf(ctx, doc, confirmEdgeDays, fileDays);
    recordFlags(ctx, doc.system, doc.processor, rawEvents);
    recordObserved(ctx, doc, rawEvents, pullId, new Set(dayRefused.keys()));
    recordPayoutRefs(ctx, doc.system, doc.processor, rawEvents, pullId);
    const warnings = [...doc.warnings, ...keylessWarnings(doc, rawEvents)];
    const testModes = { events: testEventsModeOf(ctx), fees: testFeesModeOf(ctx) };
    // R2, the from-date floor: only when a source row exists for this system and processor.
    const fromDate =
      (ctx.store.db
        .prepare('SELECT from_date FROM settlement_source WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
        .get(ctx.workspaceId, doc.system, doc.processor) as { from_date: string } | undefined)?.from_date ?? null;

    const byDocument = new Map<string, SettlementAttachmentInput[]>();
    for (const a of attachments) byDocument.set(a.documentNumber, [...(byDocument.get(a.documentNumber) ?? []), a]);
    const nameBySha = new Map(attachments.map((a) => [a.sha256, a.fileName]));
    const usedDocuments = new Set<string>();

    const outcomes: SettlementEventOutcome[] = [];
    for (const r of doc.refused) {
      outcomes.push({ index: r.index, id: r.id, kind: r.kind, day: r.day, amountMinor: r.amountMinor, outcome: 'refused', code: r.code, sentence: r.reason });
    }
    const insertRestated = ctx.store.db.prepare(
      `INSERT INTO settlement_feed_outcome (id, workspace_id, source_system, source_processor, event_id, pull_id, outcome, code, changed_json, kind, day, amount_minor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'restated', 'event_amended', ?, ?, ?, ?, ?)`,
    );
    const findStored = ctx.store.db.prepare(
      'SELECT kind, day, currency, amount_minor, net_minor, vat_minor, entry_id FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ?',
    );
    const insertEvent = ctx.store.db.prepare(
      `INSERT INTO settlement_event (id, workspace_id, source_system, source_processor, event_id, kind, day, currency, amount_minor, net_minor, vat_minor,
         entry_id, document_number, counterparty, refs_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const skippedAs = (base: Pick<SettlementEventOutcome, 'index' | 'id' | 'kind' | 'day' | 'amountMinor'>, reason: string): SettlementEventOutcome => ({
      ...base,
      outcome: 'skipped',
      reason,
      sentence: SETTLEMENT_OUTCOME_TEXT[reason] as string,
    });

    for (const e of doc.events) {
      const base = { index: e.index, id: e.id, kind: e.kind, day: e.day, amountMinor: e.amountMinor };
      const dayCode = dayRefused.get(e.index);
      if (dayCode !== undefined) {
        outcomes.push({ ...base, outcome: 'refused', code: dayCode, sentence: SETTLEMENT_OUTCOME_TEXT[dayCode] as string });
        continue;
      }
      const rule = template.kinds[e.kind] as KindRule;
      const files = e.documentNumber !== null ? (byDocument.get(e.documentNumber) ?? []) : [];
      // The per-event steps after the comparison (run inside the event's savepoint below).
      const decide = (): SettlementEventOutcome => {
        const stored = findStored.get(ctx.workspaceId, doc.system, doc.processor, e.id) as StoredEventRow | undefined;
        // 1. THE STORED EVENT (D185): a booked event is answered from its row, whatever else holds. Figures that
        // differ from the booked ones refuse `event_amended` whatever the template does with the kind now.
        if (stored !== undefined) {
          const changed = amendments(stored, e);
          if (changed.length > 0) {
            return { ...base, outcome: 'refused', code: 'event_amended', sentence: SETTLEMENT_OUTCOME_TEXT['event_amended'] as string, entryId: stored.entry_id, changed };
          }
          if (rule.action === 'skip' || rule.action === 'attention') {
            // A kind the template skips NOW was booked by an earlier template: the outcome names that entry, and
            // the reconciliation counts the event as booked, not as left off the clearing account.
            return { ...skippedAs(base, rule.action === 'skip' ? 'template_skip' : 'needs_attention'), entryId: stored.entry_id };
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
        // 2. THE OVERRIDE (the owner's answer of 12.11.2026): a person marked the event handled outside the
        // import, or ignored it in the Umsatz review (A42, `overrides.ts`), so the import books nothing for it
        // (both pinned for a governed seat's draft, vorschlagPin.ts).
        const kept = activeOverridesOf(ctx, doc.system, doc.processor, e.id).get(e.id);
        if (kept !== undefined) return skippedAs(base, kept.source === 'ignored' ? 'ignored' : 'handled_outside');
        // 3. THE FROM-DATE FLOOR (R2), on both doors.
        if (fromDate !== null && e.day < fromDate) return skippedAs(base, 'before_from_date');
        // 4. THE TEST CHECK (R1), after the stored lookup, so a stored event still answers as stored.
        if (testSkips(e.kind, testModes) && isTestEvent(ctx, doc.system, doc.processor, e.id)) return skippedAs(base, 'test_event');
        // 5. THE TEMPLATE.
        if (rule.action === 'skip' || rule.action === 'attention') return skippedAs(base, rule.action === 'skip' ? 'template_skip' : 'needs_attention');
        if (e.amountMinor === 0 && e.netMinor === 0 && (e.vatMinor ?? 0) === 0) return skippedAs(base, 'zero_amount');
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
      };
      // ONE SAVEPOINT PER EVENT inside the memo's IMMEDIATE transaction, the comparison, the lookup of its
      // external id and its override INCLUDED. The write lock is held from the first lookup to the commit, so a
      // second TILL process (D12: the Studio beside `till mcp`) cannot record the same event, or answer it, in
      // between: it waits, and finds the rows this call wrote. Inside, the booking and an attachment to an
      // earlier entry run as nested savepoints, so a refusal rolls back only that step.
      const outcome = ctx.store.tx((): SettlementEventOutcome => {
        // 0. ONE COMPARISON ON ARRIVAL (module header): before the template, the stored row or the override is
        // read, the arrival is compared with the producer's latest stated figures and a difference is logged.
        const latest = latestStatedOf(ctx, doc.system, doc.processor, e.id);
        const restated = latest === undefined ? [] : figureChanges(latest.figures, { kind: e.kind, day: e.day, amountMinor: e.amountMinor, netMinor: e.netMinor, vatMinor: e.vatMinor });
        if (restated.length > 0) {
          insertRestated.run(ctx.ids.next('stlout'), ctx.workspaceId, doc.system, doc.processor, e.id, pullId, JSON.stringify(restated), e.kind, e.day, e.amountMinor, ctx.clock.now());
        }
        const answer = decide();
        return restated.length > 0 ? { ...answer, restated } : answer;
      });
      // A document counts as used only once its files are linked: a failed link leaves it in
      // `unmatchedAttachments`, so the answer never hides a Beleg that was filed nowhere.
      if (outcome.attached !== undefined && e.documentNumber !== null) usedDocuments.add(e.documentNumber);
      outcomes.push(outcome);
    }
    outcomes.sort((a, b) => a.index - b.index);
    // D206: the person's answer that a first or last day is complete, recorded once per day it let in.
    recordEdgeDayAnswers(ctx, doc, edgesLetIn, edgesMovedOff);

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
      warnings,
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
      reviewSha256: outcomeDigestOf(ctx, outcomes),
    };
    // R4: one outcome row per event of the document, written by the import itself on both doors, so a file
    // import updates the reason too (latest wins).
    recordOutcomes(ctx, doc.system, doc.processor, outcomes, pullId);
    // A42: a booking that passes the review's digest refuses when the import would now do anything else; the
    // throw rolls back everything this call wrote (the memo transaction), so nothing is booked unseen.
    if (input.expectReviewSha256 !== undefined && input.expectReviewSha256 !== body.reviewSha256) {
      throw new ReviewStaleAbort(
        err('review_stale', {
          system: doc.system,
          processor: doc.processor,
          reason: 'what the import would book differs from the review you booked from (the file or feed, an answer, a setting, the template, the from-date or a lock changed): review it again',
        }) as Err,
      );
    }
    return ok<ImportSettlementOk>(body);
  });
  } catch (x) {
    if (x instanceof ReviewStaleAbort) return x.refusal as Result<ImportSettlementOk>;
    throw x;
  }
}

/** Whether an event's refs (parsed, never searched as text) name the table id recipe that minted it. */
function isTableEvent(refsJson: string | null): boolean {
  if (refsJson === null) return false;
  try {
    const refs = JSON.parse(refsJson) as unknown;
    return refs !== null && typeof refs === 'object' && typeof (refs as Record<string, unknown>)['tableIdRecipe'] === 'string';
  } catch {
    return false;
  }
}

type DayRefusal = 'day_differs' | 'day_not_over' | 'edge_day_excluded' | 'edge_day_unconfirmed';

/**
 * D206 (F4, F7, the edges): the whole-day check of one document against what the source holds, by event index, and
 * the edge days a person's answer let in. Read inside the import's memo transaction, before the document is recorded
 * as observed. The edges are the first and the last day of the document's whole-day events (module header).
 */
function wholeDayRefusalsOf(ctx: WorkspaceContext, doc: SettlementDocument, confirmEdgeDays: readonly string[], fileDays: { first: string; last: string } | null): { refused: Map<number, DayRefusal>; letIn: string[]; movedOff: string[] } {
  const refused = new Map<number, DayRefusal>();
  const letIn: string[] = [];
  const movedOff: string[] = [];
  const byDay = new Map<string, SettlementEvent[]>();
  const columnByDay = new Map<string, SettlementEvent[]>();
  for (const e of doc.events) {
    if (isDayId(e.id)) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
    else if (isTableEvent(e.refsJson)) columnByDay.set(e.day, [...(columnByDay.get(e.day) ?? []), e]);
  }
  if (byDay.size === 0 && columnByDay.size === 0) return { refused, letIn, movedOff };
  // Critic r3 H-1: every calendar day of the document's whole-day range, so a held day it is silent on is seen too.
  const sortedDays = [...byDay.keys()].sort();
  const rangeDays = sortedDays.length > 0 ? daysBetween(sortedDays[0] as string, sortedDays[sortedDays.length - 1] as string) : [];
  const observed = observedByDay(ctx, doc.system, doc.processor, [...rangeDays, ...columnByDay.keys()]);
  const today = swissTodayOf(ctx);
  const verdicts = new Map<string, HeldVerdict>();
  const refuseDay = (events: readonly SettlementEvent[], code: DayRefusal): void => {
    for (const e of events) refused.set(e.index, code);
  };
  for (const [day, events] of byDay) {
    if (day >= today) {
      refuseDay(events, 'day_not_over');
      continue;
    }
    const verdict = heldVerdictOf(observed.get(day), events.map((e) => ({ eventId: e.id, amountMinor: e.amountMinor })));
    verdicts.set(day, verdict);
    if (verdict === 'in_books' || verdict === 'differs') refuseDay(events, 'day_differs');
  }
  if (sortedDays.length > 0) {
    for (const day of silentHeldDaysOf(new Set(sortedDays), sortedDays[0] as string, sortedDays[sortedDays.length - 1] as string, observed, today)) verdicts.set(day, 'differs');
  }
  // A row a re-export without zones moved across midnight (`movedFromNeighbourOf`): its new day books nothing.
  const fileByDay = new Map([...byDay].map(([d, es]) => [d, es.map((e) => ({ eventId: e.id, amountMinor: e.amountMinor }))]));
  for (const day of movedFromNeighbourOf(verdicts, observed, fileByDay).keys()) {
    refuseDay(byDay.get(day) ?? [], 'day_differs');
    verdicts.set(day, 'differs');
  }
  // THE EDGES: the first and last day of the WHOLE file (the person's `fileDays`), else of this document, when new.
  const days = [...byDay.keys()].sort();
  if (days.length > 0) {
    const mode = tableEdgeDaysModeOf(ctx);
    const [first, last] = fileDays === null ? [days[0] as string, days[days.length - 1] as string] : [fileDays.first, fileDays.last];
    // Critic r4 H-1: EVERY new day carrying an amount the books hold on the day before or after asks (`nearHeldOf`).
    const around = observedByDay(ctx, doc.system, doc.processor, daysBetween(shiftDay(days[0] as string, -1), shiftDay(days[days.length - 1] as string, 1)));
    for (const day of days) {
      if (verdicts.get(day) !== 'new') continue;
      const near = nearHeldOf(day, fileByDay.get(day) ?? [], around);
      const rule = newDayModeOf(mode, day === first || day === last, near !== null);
      if (rule === null) continue;
      const verdict = edgeVerdictOf(rule, day, confirmEdgeDays);
      if (verdict !== null) refuseDay(byDay.get(day) ?? [], verdict);
      else if (rule === 'ask') letIn.push(day);
    }
    // Critic r2 M-B: a person's `fileDays` that takes the edge off a new first or last day of THIS document is
    // audited, naming the day, so a wider value than the file never switches the edge rule off unseen.
    if (fileDays !== null) {
      for (const day of new Set([days[0] as string, days[days.length - 1] as string])) {
        if (day !== first && day !== last && verdicts.get(day) === 'new') movedOff.push(day);
      }
    }
  }
  // F7: a table event with an id column, new to the source, on a day the source holds by whole days.
  for (const [day, events] of columnByDay) {
    const held = observed.get(day);
    if (!holdsDayIds(held)) continue;
    const seen = new Set((held ?? []).map((o) => o.eventId));
    for (const e of events) if (!seen.has(e.id)) refused.set(e.index, 'day_differs');
  }
  return { refused, letIn, movedOff };
}

/**
 * D206: one audit row per edge day a person's answer (`confirmEdgeDays` in this call, a person's by the check above)
 * let in. A replay or a refused import writes none: the memo transaction holds it.
 */
function recordEdgeDayAnswers(ctx: WorkspaceContext, doc: SettlementDocument, letIn: readonly string[], movedOff: readonly string[] = []): void {
  if ((letIn.length === 0 && movedOff.length === 0) || isGovernedSeat(ctx.store, ctx.actor)) return;
  const mapping = readStoredTableMapping(ctx, doc.system, doc.processor);
  if (mapping === null) return;
  const now = ctx.clock.now();
  // Critic r1 L4: the row names the day (`<mappingId>#<day>`; an audit event carries no payload of its own).
  for (const day of letIn) {
    ctx.audit.record({ entityKind: 'settlement_table_mapping', entityId: `${mapping.mappingId}#${day}`, action: 'confirm_edge_day', actor: ctx.actor, at: now });
  }
  // Critic r2 M-B: a day of the document the person's `fileDays` said is not an edge of the file.
  for (const day of movedOff) {
    ctx.audit.record({ entityKind: 'settlement_table_mapping', entityId: `${mapping.mappingId}#${day}`, action: 'file_days_inner', actor: ctx.actor, at: now });
  }
}

/** Thrown inside the import's memo to roll back a booking whose outcome differs from its review (A42). */
class ReviewStaleAbort extends Error {
  constructor(readonly refusal: Err) {
    super(refusal.error);
  }
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
