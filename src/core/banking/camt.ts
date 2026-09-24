/**
 * A20, camt.053/054 parsing: an ISO 20022 Bank-to-Customer Statement or Debit/Credit Notification
 * turned into typed facts. Pure: no store, no clock, no network (the local-first rule §H-FX's
 * `bazgFeed.ts` states and A20 inherits: the engine PARSES a payload the host already has, it never
 * fetches one).
 *
 * PINNED TO THE PRIMARY SOURCE, fetched and read directly (not copied from a citation): Swiss Payment
 * Standards, "Swiss Implementation Guidelines for Customer-Bank Messages (Reports)", version 2.3,
 * 20.02.2026 (`ig-cash-management-sps-2026-en.pdf`). The element paths below are quoted from it:
 *
 *  - `Stmt/Id` (or `Ntfctn/Id`): "Unique Statement Identification. This ID is unique for a period of
 *    at least one calendar year" (p.45), and the note that Statement/Report/Notification share this
 *    B-level shape across camt.053/052/054 "unless mentioned explicitly" (p.44).
 *  - `Stmt/ElctrncSeqNb`: "mandatory for camt.052/camt.053" (p.45).
 *  - `Stmt` itself is "1..n, M": "Only one instance will be provided, one account per camt message"
 *    (p.45): a SECOND `<Stmt>`/`<Ntfctn>` in one message is a non-conforming export this parser
 *    refuses rather than silently truncates (A20-C7).
 *  - `Stmt/StmtPgntn/PgNb` and `LastPgInd` (p.44, Figure 14): a multi-page statement (SPS 2.3 p.54,
 *    below) shares its `Stmt/Id` and `ElctrncSeqNb` across every page by design, so the page number
 *    IS PART OF THE STATEMENT'S IDENTITY (D81), never a duplicate signal.
 *  - `Stmt/Bal`: "camt.053: Is always sent. camt.052: Can be sent. camt.054: Is not sent" (p.53); on
 *    camt.053 the SPS profile is "mandatory OPBD in combination with CLBD" (p.54); `Bal/Tp/SubTp/Cd`
 *    "INTM (Intermediate)": "Multi-page statement: where an account statement is divided into more
 *    than one message ..., the relevant interim balances are identified with the code INTM" (p.54).
 *    An INTM-flagged balance is NEVER stored as the statement's opening/closing figure (D81): it is
 *    not the statement's final position, and treating it as one is exactly A20-C9's defect.
 *  - `Ntry/Sts`: the PDNG variant is allowed on camt.052 and camt.054 and, by omission from that same
 *    table, refused on camt.053 (p.61): a pending movement is never imported (it is not a booked fact).
 *  - `Ntry/RvslInd`: marks a return/reversal (p.61 figure).
 *  - `Ntry/AcctSvcrRef` (p.65): "Unique reference for the entry, assigned by the financial
 *    institution. The element should be sent: the element enables the booking to be linked in
 *    different notification messages (e.g. camt.054, camt.053, MT940) and is used for duplicate
 *    checking at the booking level." This is the bank's own idempotency token for one BOOKING
 *    (C-level, `Ntry`) and the first rung of D81's entry-identity ladder.
 *  - `Ntry/NtryDtls/TxDtls` is `0..n` (p.76): "One booking can combine several transactions" (p.61).
 *    Each `TxDtls` carries its OWN `Amt` (p.77, "Transaction amount") and its own
 *    `Refs/AcctSvcrRef` (p.76: "Unique booking (transaction) reference ... enables the transaction to
 *    be linked in different notification messages ... and enables duplicate checking at transaction
 *    level"), distinct from the Ntry-level one above. A batch entry (`TxDtls.length > 1`) is fanned
 *    out into one parsed entry PER `TxDtls` (D81), each keyed on its own `Refs/AcctSvcrRef` first.
 *  - `TxDtls/RmtInf/Strd/CdtrRefInf`: the structured reference. SCOR is sent under
 *    `Tp/CdOrPrtry/Cd` "in case of IBAN with ISO Creditor Reference"; QRR is sent under
 *    `Tp/CdOrPrtry/Prtry` and "with QR-IBAN: QRR is always sent"; the value itself is in `Ref`
 *    (p.102-103).
 *  - `TxDtls/RltdPties/Dbtr/Pty/Nm`: "Name of the debtor (for credit transfers)" (p.84).
 *
 * A SMALL REGEX EXTRACTOR, NOT A DOM PARSER, and that is the `bazgFeed.ts` precedent applied to a
 * deeper document: this repo has no XML dependency (`package.json` names none) and camt's structure is
 * known and flat enough (no element repeats its own tag name inside itself at the levels this module
 * reads, with one exception handled explicitly below: `AcctSvcrRef` exists at BOTH the Ntry/C-level and
 * the TxDtls/D-level, so the C-level read is scoped to stop before `NtryDtls` rather than matching the
 * first occurrence anywhere in the entry) that a tag-scoped regex is exact rather than approximate. A
 * namespace PREFIX, when a bank's export carries one (`<ns2:Stmt>`), is stripped before any tag is
 * matched, so `Stmt`, `Ntry` and `RmtInf` are found whichever prefix, or none, the file uses.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';

export type CamtMessageType = 'camt053' | 'camt054';
export type CamtCreditDebit = 'CRDT' | 'DBIT';
export type CamtReferenceKind = 'qrr' | 'scor' | 'none';
export type CamtClassification = 'incoming_credit' | 'outgoing_debit' | 'unclassified';

export interface ParsedCamtEntry {
  /**
   * D81's identity ladder, already resolved: `asr:<AcctSvcrRef>` (booking- or transaction-level,
   * whichever this parsed row came from) when the bank sent one; else `nr:<NtryRef>` (a batch line
   * without its own AcctSvcrRef reuses the booking's NtryRef, suffixed `#<ordinal>` since NtryRef is
   * shared across every line of one booking); else a content hash of the identifying fields (date,
   * amount, currency, references, counterparty), also ordinal-suffixed inside a batch. Two entries
   * that would otherwise collide on this key ARE THE SAME BOOKED FACT as far as this parser can tell;
   * `importCamt` is what decides whether a second occurrence is a re-delivery (skip) or an admitted
   * genuine twin (`allowDuplicateEntries`).
   */
  entryKey: string;
  entryRef: string | null;
  amountMinor: number;
  currency: string;
  creditDebit: CamtCreditDebit;
  bookingDate: string | null;
  valueDate: string | null;
  reversalInd: boolean;
  btcDomain: string | null;
  btcFamily: string | null;
  btcSubFamily: string | null;
  batchPmtInfId: string | null;
  referenceKind: CamtReferenceKind;
  referenceValue: string | null;
  payerName: string | null;
}

export type CamtSkipReason = 'pending' | 'unreadable_amount' | 'unsupported_status' | 'duplicate_entry';

/** An `Ntry` the importer did NOT turn into a `bank_txn`, with an honest reason (A20-C6). */
export interface SkippedCamtEntry {
  entryRef: string | null;
  reason: CamtSkipReason;
  /** Present only for `unsupported_status`: the `Ntry/Sts` code that was neither BOOK nor PDNG. */
  status?: string | null;
}

export interface ParsedCamtStatement {
  messageType: CamtMessageType;
  statementId: string;
  electronicSeqNb: string | null;
  /** `StmtPgntn/PgNb` (p.44); 1 when the message carries no pagination element at all. */
  pageNumber: number;
  /** `StmtPgntn/LastPgInd`; true when the message carries no pagination element (an ordinary
   *  single-message statement is trivially its own last page). */
  lastPage: boolean;
  iban: string | null;
  fromDate: string | null;
  toDate: string | null;
  /** Present only when the message carried a genuine (non-INTM) `OPBD`/`CLBD` (camt.053 always on
   *  its last page; camt.054 never, p.53; an interim `INTM` balance is never surfaced here, D81). */
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  balanceCurrency: string | null;
  entries: ParsedCamtEntry[];
  /** Every `Ntry` this parser read but did not turn into a `bank_txn`, and why (A20-C6). */
  skipped: SkippedCamtEntry[];
}

// --- The extraction primitives -------------------------------------------------------------------

/** Strip a namespace prefix from every tag (`<ns2:Stmt>` -> `<Stmt>`, `</ns2:Stmt>` -> `</Stmt>`). */
function stripPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1');
}

/** The inner content of the FIRST `<tag ...>...</tag>` at this nesting level, or null if absent. */
function firstTagBody(xml: string | null, tag: string): string | null {
  if (xml === null) return null;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(xml);
  return m === null ? null : (m[1] as string);
}

/** Every `<tag ...>...</tag>` block's inner content at this nesting level, in document order. */
function allTagBodies(xml: string | null, tag: string): string[] {
  if (xml === null) return [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] as string);
  return out;
}

/** Every top-level `<tag` OPEN occurrence, counted (not parsed) so a second sibling is detectable
 *  even though `firstTagBody` above only ever returns the first (A20-C7). */
function countTagOpenings(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}(?:[\\s>])`, 'g');
  const m = xml.match(re);
  return m === null ? 0 : m.length;
}

/** The trimmed text of the first `<tag>...</tag>`, or null. Never descends into a nested element. */
function tagText(xml: string | null, tag: string): string | null {
  const body = firstTagBody(xml, tag);
  if (body === null) return null;
  const trimmed = body.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A decimal string to integer Rappen (Pattern P2): exact, never via float. Refuses more than two
 * fractional digits rather than rounding one away, because a silently rounded Rappen is a wrong fact
 * about what the bank reported, not a convenience.
 */
function decimalToMinor(decimal: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(decimal)) return null;
  const [whole, frac = ''] = decimal.split('.') as [string, string?];
  const fracPadded = (frac + '00').slice(0, 2);
  return Number(whole) * 100 + Number(fracPadded);
}

/** `<Tag Ccy="CHF">1234.55</Tag>` at THIS nesting level, or null when absent or malformed. */
function extractAmount(xml: string | null, tag: string): { minor: number; currency: string } | null {
  if (xml === null) return null;
  const re = new RegExp(`<${tag}\\s+Ccy="([A-Z]{3})"\\s*>\\s*([\\d.]+)\\s*<\\/${tag}>`);
  const m = re.exec(xml);
  if (m === null) return null;
  const minor = decimalToMinor(m[2] as string);
  if (minor === null) return null;
  return { minor, currency: m[1] as string };
}

/**
 * `Ntry/AcctSvcrRef` (p.65, C-level, booking identity), scoped to STOP before `NtryDtls`: a batch
 * `TxDtls` carries its OWN `Refs/AcctSvcrRef` at the D-level (p.76, transaction identity), and a
 * naive `tagText(ntry, 'AcctSvcrRef')` would only be safe by accident of field ordering. Truncating
 * at the first `NtryDtls` makes the C-level read exact regardless of how a bank orders its export.
 */
function entryLevelAcctSvcrRef(ntry: string): string | null {
  const boundary = ntry.indexOf('<NtryDtls');
  const scoped = boundary === -1 ? ntry : ntry.slice(0, boundary);
  return tagText(scoped, 'AcctSvcrRef');
}

// --- The structured reference and the payer name, TxDtls/RmtInf and TxDtls/RltdPties --------------

function parseStructuredReference(txDtls: string): { kind: CamtReferenceKind; value: string | null } {
  const rmtInf = firstTagBody(txDtls, 'RmtInf');
  const strd = firstTagBody(rmtInf, 'Strd');
  const cdtrRefInf = firstTagBody(strd, 'CdtrRefInf');
  if (cdtrRefInf === null) return { kind: 'none', value: null };
  const tp = firstTagBody(cdtrRefInf, 'Tp');
  const cdOrPrtry = firstTagBody(tp, 'CdOrPrtry');
  const code = tagText(cdOrPrtry, 'Cd');
  const prtry = tagText(cdOrPrtry, 'Prtry');
  const ref = tagText(cdtrRefInf, 'Ref');
  if (ref === null) return { kind: 'none', value: null };
  // QRR travels under Prtry (p.102: "QR: With QR-IBAN: QRR is always sent", under CdOrPrtry/Prtry).
  if (prtry !== null && prtry.toUpperCase() === 'QRR') return { kind: 'qrr', value: ref };
  // SCOR travels under Cd (p.102: "QR: SCOR is sent in case of IBAN with ISO Creditor Reference").
  if (code !== null && code.toUpperCase() === 'SCOR') return { kind: 'scor', value: ref };
  return { kind: 'none', value: null };
}

/** `TxDtls/RltdPties/Dbtr/Pty/Nm` (p.84): the payer's name, for a credit transfer. */
function parsePayerName(txDtls: string): string | null {
  const rltdPties = firstTagBody(txDtls, 'RltdPties');
  const dbtr = firstTagBody(rltdPties, 'Dbtr');
  const pty = firstTagBody(dbtr, 'Pty') ?? dbtr;
  return tagText(pty, 'Nm');
}

/** `TxDtls/Refs/AcctSvcrRef` (p.76): the transaction's own idempotency token, distinct from the
 *  booking-level one above. */
function txDtlsAcctSvcrRef(txDtls: string): string | null {
  const refs = firstTagBody(txDtls, 'Refs');
  return tagText(refs, 'AcctSvcrRef');
}

// --- D81's identity ladder --------------------------------------------------------------------------

/** A stable, deterministic string over the identifying fields (D81's third rung): never a real hash
 *  function, just a delimited join, because this is a DB key, not a security boundary. */
function contentKey(fields: (string | number | null)[]): string {
  return 'ck:' + fields.map((f) => (f === null ? '' : String(f))).join('|');
}

/**
 * D81: `Ntry/AcctSvcrRef` (or the TxDtls-level one for a batch line), falling back to `NtryRef`,
 * falling back to a content hash of (date, amount, currency, references, counterparty). `ordinal` is
 * set only for a batch line (more than one `TxDtls`), because `NtryRef` and a plain content hash are
 * both shared across every line of one booking and need the line's position to stay distinct.
 */
function entryIdentityKey(opts: {
  acctSvcrRef: string | null;
  entryRef: string | null;
  date: string | null;
  amountMinor: number;
  currency: string;
  creditDebit: string;
  referenceKind: string;
  referenceValue: string | null;
  payerName: string | null;
  ordinal?: number;
}): string {
  if (opts.acctSvcrRef !== null) return `asr:${opts.acctSvcrRef}`;
  const suffix = opts.ordinal === undefined ? '' : `#${opts.ordinal}`;
  if (opts.entryRef !== null) return `nr:${opts.entryRef}${suffix}`;
  return (
    contentKey([
      opts.date,
      opts.amountMinor,
      opts.currency,
      opts.creditDebit,
      opts.referenceKind,
      opts.referenceValue,
      opts.payerName,
    ]) + suffix
  );
}

// --- One entry (Ntry, C-level), fanned out into 1..n parsed rows (SPS 2.3 p.61, D81) ---------------

type EntryParseResult =
  | { kind: 'ok'; entries: ParsedCamtEntry[] }
  | { kind: 'skip'; skipped: SkippedCamtEntry }
  | { kind: 'error'; reason: string };

/** `Ntry/Sts`: `Cd` under the `EntryStatus2Code` choice, or the bare text on an older shape. */
function entryStatusCode(ntry: string): string | null {
  const sts = firstTagBody(ntry, 'Sts');
  if (sts === null) return null;
  return tagText(sts, 'Cd') ?? tagText(ntry, 'Sts');
}

function parseEntry(ntry: string): EntryParseResult {
  const entryRef = tagText(ntry, 'NtryRef');
  const status = entryStatusCode(ntry);
  // A camt.053 entry is BOOK-only by the SPS profile (p.61); camt.054 may carry PDNG, and a pending
  // movement is not a booked fact. Anything else (a proprietary code, a typo, a future ISO addition)
  // is reported rather than silently dropped (A20-C6): the caller decides what an unsupported status
  // means for the operator, this module just names it honestly.
  if (status !== null && status !== 'BOOK') {
    if (status === 'PDNG') return { kind: 'skip', skipped: { entryRef, reason: 'pending' } };
    return { kind: 'skip', skipped: { entryRef, reason: 'unsupported_status', status } };
  }

  const amt = extractAmount(ntry, 'Amt');
  const creditDebit = tagText(ntry, 'CdtDbtInd');
  if (amt === null || (creditDebit !== 'CRDT' && creditDebit !== 'DBIT')) {
    return { kind: 'skip', skipped: { entryRef, reason: 'unreadable_amount' } };
  }

  const acctSvcrRef = entryLevelAcctSvcrRef(ntry);
  const bookgDt = firstTagBody(ntry, 'BookgDt');
  const valDt = firstTagBody(ntry, 'ValDt');
  const bookingDate = tagText(bookgDt, 'Dt') ?? (tagText(bookgDt, 'DtTm')?.slice(0, 10) ?? null);
  const valueDate = tagText(valDt, 'Dt') ?? (tagText(valDt, 'DtTm')?.slice(0, 10) ?? null);

  const bkTxCd = firstTagBody(ntry, 'BkTxCd');
  const domn = firstTagBody(bkTxCd, 'Domn');
  const fmly = firstTagBody(domn, 'Fmly');
  const btcDomain = tagText(domn, 'Cd');
  const btcFamily = tagText(fmly, 'Cd');
  const btcSubFamily = tagText(fmly, 'SubFmlyCd');

  const ntryDtls = firstTagBody(ntry, 'NtryDtls');
  const btch = firstTagBody(ntryDtls, 'Btch');
  const batchPmtInfId = tagText(btch, 'PmtInfId');
  const reversalInd = tagText(ntry, 'RvslInd') === 'true';
  const identityDate = valueDate ?? bookingDate;

  const shared = {
    entryRef,
    bookingDate,
    valueDate,
    reversalInd,
    btcDomain,
    btcFamily,
    btcSubFamily,
    batchPmtInfId,
    creditDebit: creditDebit as CamtCreditDebit,
  };

  const txDtlsList = allTagBodies(ntry, 'TxDtls');

  if (txDtlsList.length <= 1) {
    const txDtls = txDtlsList[0] ?? null;
    const reference = txDtls === null ? { kind: 'none' as const, value: null } : parseStructuredReference(txDtls);
    const payerName = txDtls === null ? null : parsePayerName(txDtls);
    const key = entryIdentityKey({
      acctSvcrRef,
      entryRef,
      date: identityDate,
      amountMinor: amt.minor,
      currency: amt.currency,
      creditDebit: shared.creditDebit,
      referenceKind: reference.kind,
      referenceValue: reference.value,
      payerName,
    });
    return {
      kind: 'ok',
      entries: [
        {
          entryKey: key,
          amountMinor: amt.minor,
          currency: amt.currency,
          referenceKind: reference.kind,
          referenceValue: reference.value,
          payerName,
          ...shared,
        },
      ],
    };
  }

  // A batch entry (SPS 2.3 p.61: "One booking can combine several transactions"). D81: fan out one
  // parsed row per `TxDtls`, each with its own reference, payer and `TxDtls/Amt`; the fan-out MUST
  // sum exactly to the entry amount or the whole message is refused (a batch this parser cannot
  // account for to the Rappen is not a batch it can safely present as several separate credits).
  const lines: ParsedCamtEntry[] = [];
  let sum = 0;
  for (let i = 0; i < txDtlsList.length; i++) {
    const txDtls = txDtlsList[i] as string;
    const txAmt = extractAmount(txDtls, 'Amt');
    if (txAmt === null) {
      return {
        kind: 'error',
        reason: `a batch entry's TxDtls[${i}] has no readable Amt (NtryRef ${entryRef ?? 'none'})`,
      };
    }
    sum += txAmt.minor;
    const reference = parseStructuredReference(txDtls);
    const payerName = parsePayerName(txDtls);
    const key = entryIdentityKey({
      acctSvcrRef: txDtlsAcctSvcrRef(txDtls),
      entryRef,
      date: identityDate,
      amountMinor: txAmt.minor,
      currency: txAmt.currency,
      creditDebit: shared.creditDebit,
      referenceKind: reference.kind,
      referenceValue: reference.value,
      payerName,
      ordinal: i,
    });
    lines.push({
      entryKey: key,
      amountMinor: txAmt.minor,
      currency: txAmt.currency,
      referenceKind: reference.kind,
      referenceValue: reference.value,
      payerName,
      ...shared,
    });
  }
  if (sum !== amt.minor) {
    return {
      kind: 'error',
      reason: `a batch entry's ${txDtlsList.length} TxDtls sum to ${sum} but the entry Amt is ${amt.minor} (NtryRef ${entryRef ?? 'none'})`,
    };
  }
  return { kind: 'ok', entries: lines };
}

// --- The statement (Stmt or Ntfctn, B-level) and the message root -----------------------------------

/**
 * `Stmt/Bal` (p.53-54): an `INTM`-flagged balance (`Bal/Tp/SubTp/CdOrPrtry/Cd`) is a multi-page
 * statement's interim figure and is NEVER surfaced as the statement's opening/closing position
 * (D81): a page that is not the last one has no genuine OPBD/CLBD to compare against at all.
 */
function parseBalances(stmt: string): {
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  balanceCurrency: string | null;
} {
  let opening: number | null = null;
  let closing: number | null = null;
  let currency: string | null = null;
  for (const bal of allTagBodies(stmt, 'Bal')) {
    const tp = firstTagBody(bal, 'Tp');
    const cdOrPrtry = firstTagBody(tp, 'CdOrPrtry');
    const code = tagText(cdOrPrtry, 'Cd');
    const subTp = firstTagBody(tp, 'SubTp');
    const subCdOrPrtry = firstTagBody(subTp, 'CdOrPrtry');
    const subCode = tagText(subCdOrPrtry, 'Cd');
    if (subCode !== null && subCode.toUpperCase() === 'INTM') continue;
    const amt = extractAmount(bal, 'Amt');
    const cdtDbtInd = tagText(bal, 'CdtDbtInd');
    if (amt === null || code === null) continue;
    // A DBIT balance is a negative position (an overdraft): the sign is a fact about the account, not
    // decoration, and it is what lets `listReconciliation`'s D64 comparison hold to the Rappen on an
    // account that closed overdrawn.
    const signed = cdtDbtInd === 'DBIT' ? -amt.minor : amt.minor;
    if (code === 'OPBD') {
      opening = signed;
      currency = amt.currency;
    } else if (code === 'CLBD') {
      closing = signed;
      currency = amt.currency;
    }
  }
  return { openingBalanceMinor: opening, closingBalanceMinor: closing, balanceCurrency: currency };
}

/** `Stmt/StmtPgntn` (p.44): absent on an ordinary single-message statement, which is trivially its
 *  own last page. */
function parsePagination(stmt: string): { pageNumber: number; lastPage: boolean } {
  const pgntn = firstTagBody(stmt, 'StmtPgntn');
  if (pgntn === null) return { pageNumber: 1, lastPage: true };
  const pgNb = tagText(pgntn, 'PgNb');
  const pageNumber = pgNb === null ? 1 : (Number.parseInt(pgNb, 10) || 1);
  const lastPage = tagText(pgntn, 'LastPgInd') === 'true';
  return { pageNumber, lastPage };
}

export type ParseCamtResult = Result<{ statement: ParsedCamtStatement }>;

/**
 * Parse a camt.053 or camt.054 payload. Pure and total: never throws, `{ok:false}` names WHY (the
 * `schema_invalid` P9 rejection `importCamt` returns verbatim).
 */
export function parseCamt(xml: unknown): ParseCamtResult {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    return err('schema_invalid', { reason: 'the payload is not a non-empty XML string' });
  }
  const normalized = stripPrefixes(xml);

  // The camt.054 B-level element is `Ntfctn` (Notification). This is the real ISO 20022 abbreviation
  // (`BkToCstmrDbtCdtNtfctnV08 > Ntfctn`), confirmed against the SIX SPS Cash Management guidelines and
  // every bank MIG (ZKB, BNY, Clearstream). An earlier revision of this parser detected the malformed
  // `Ntfcn` (a dropped `t`): it therefore matched only the repo's own hand-built test XML and rejected
  // every REAL bank camt.054 with "no notification element found". The ZKB Sammelbuchung Rung A fixture
  // (`zkb-camt054-01-sammelbuchung-qrr.xml`), built to the real ISO element, is what surfaced it.
  let messageType: CamtMessageType;
  let stmt: string | null;
  let rootTag: 'Stmt' | 'Ntfctn';
  if (/<Stmt[\s>]/.test(normalized)) {
    messageType = 'camt053';
    rootTag = 'Stmt';
    stmt = firstTagBody(normalized, 'Stmt');
  } else if (/<Ntfctn[\s>]/.test(normalized)) {
    messageType = 'camt054';
    rootTag = 'Ntfctn';
    stmt = firstTagBody(normalized, 'Ntfctn');
  } else if (/<Rpt[\s>]/.test(normalized)) {
    return err('schema_invalid', {
      reason: 'a camt.052 intraday report is not imported here: only camt.053 (statement) and camt.054 (notification) are',
    });
  } else {
    return err('schema_invalid', {
      reason: 'no <Stmt> (camt.053) or <Ntfctn> (camt.054) element found',
    });
  }
  if (stmt === null) {
    return err('schema_invalid', { reason: 'the message envelope has no Statement/Notification body' });
  }
  // SPS 2.3 p.45: "Only one instance will be provided, one account per camt message". A second
  // top-level Stmt/Ntfctn is a non-conforming export; refusing it converts silent truncation
  // (A20-C7) into an honest P9 rejection.
  if (countTagOpenings(normalized, rootTag) > 1) {
    return err('schema_invalid', {
      reason: `more than one <${rootTag}> element in one message: only one account per camt message is supported`,
    });
  }

  const statementId = tagText(stmt, 'Id');
  if (statementId === null) {
    return err('schema_invalid', { reason: 'Stmt/Id (or Ntfctn/Id) is mandatory and absent' });
  }

  const acct = firstTagBody(stmt, 'Acct');
  const ibanRaw = tagText(acct, 'IBAN');
  const iban = ibanRaw === null ? null : ibanRaw.replace(/\s+/g, '').toUpperCase();

  const frToDt = firstTagBody(stmt, 'FrToDt');
  const fromDate = tagText(frToDt, 'FrDtTm')?.slice(0, 10) ?? null;
  const toDate = tagText(frToDt, 'ToDtTm')?.slice(0, 10) ?? null;

  const balances = parseBalances(stmt);
  const pagination = parsePagination(stmt);

  const entries: ParsedCamtEntry[] = [];
  const skipped: SkippedCamtEntry[] = [];
  for (const ntry of allTagBodies(stmt, 'Ntry')) {
    const parsed = parseEntry(ntry);
    if (parsed.kind === 'error') {
      return err('schema_invalid', { reason: parsed.reason });
    }
    if (parsed.kind === 'skip') {
      skipped.push(parsed.skipped);
      continue;
    }
    entries.push(...parsed.entries);
  }

  return ok<{ statement: ParsedCamtStatement }>({
    statement: {
      messageType,
      statementId,
      electronicSeqNb: tagText(stmt, 'ElctrncSeqNb'),
      pageNumber: pagination.pageNumber,
      lastPage: pagination.lastPage,
      iban,
      fromDate,
      toDate,
      ...balances,
      entries,
      skipped,
    },
  });
}

/**
 * A stable, deterministic fingerprint of a parsed statement's CONTENT (never its metadata like
 * import timestamps): used to tell a byte-identical re-import (D81: `{ok:true, duplicate:true}`,
 * writes nothing) from a bank re-issuing the same statement identity with corrected figures
 * (A20-C2: `statement_amended`, naming what changed). Not a cryptographic hash, a delimited join
 * over the identifying facts, in the same spirit as `entryIdentityKey` above.
 */
export function hashCamtStatement(stmt: ParsedCamtStatement): string {
  const parts = [
    stmt.messageType,
    stmt.fromDate,
    stmt.toDate,
    stmt.openingBalanceMinor,
    stmt.closingBalanceMinor,
    stmt.balanceCurrency,
    ...stmt.entries
      .map((e) =>
        [
          e.entryKey,
          e.amountMinor,
          e.currency,
          e.creditDebit,
          e.bookingDate,
          e.valueDate,
          e.reversalInd ? '1' : '0',
          e.referenceKind,
          e.referenceValue,
          e.payerName,
          e.batchPmtInfId,
        ].join(':'),
      )
      .sort(),
  ];
  return 'h1:' + parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|');
}
