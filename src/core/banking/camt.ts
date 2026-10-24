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
import { deriveFacts, emptyFacts } from './statementFacts.js';
import type { BankCodeFact, ChargeRecordFact, ChargesFact, ExchangeFact, FactSource, LineFacts, MoneyFact } from './statementFacts.js';

export type CamtMessageType = 'camt053' | 'camt054';
/** D178 (A20 §11): every statement format the one insertion takes. */
export type StatementMessageType = CamtMessageType | 'mt940' | 'csv';
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
  /**
   * A39 L6: `TxDtls/Refs/PmtInfId`, where a bank reports the run's PmtInfId per transaction rather than in
   * `Btch`. Kept OUT of `hashCamtStatement` (like the counterparty facts), so a statement imported before
   * it was read still answers `duplicate: true`; `importCamt` stores it where `Btch` is absent.
   */
  txPmtInfId: string | null;
  referenceKind: CamtReferenceKind;
  referenceValue: string | null;
  payerName: string | null;
  /**
   * A39: the OTHER party of the movement, read for the inbox and the proposals: the debtor of a credit
   * (`RltdPties/Dbtr`, `DbtrAcct`), the creditor of a debit (`RltdPties/Cdtr`, `CdtrAcct`). These four
   * are deliberately NOT part of `entryKey` nor of `hashCamtStatement`: a statement imported before
   * A39 read none of them, and its re-import must still answer `duplicate: true`.
   */
  counterpartyName: string | null;
  counterpartyIban: string | null;
  /** The unstructured remittance (`RmtInf/Ustrd`, else `AddtlTxInf`, else the entry's `AddtlNtryInf`). */
  remittanceText: string | null;
  /** `TxDtls/Refs/EndToEndId`, the payer's own reference (SPS 2.3 p.76); `NOTPROVIDED` reads as null. */
  endToEndId: string | null;
  /**
   * D178 (A20 §11.1): what the statement says about the movement beyond its booked fact (the bank code,
   * the separate texts, the references, the amount details, the exchange, the charges, the derived fee).
   * Kept OUT of `entryKey` and `hashCamtStatement`, like the counterparty facts, so a statement imported
   * before it still re-imports as `duplicate: true`. Optional only for a hand-built entry; every parser
   * sets it.
   */
  facts?: LineFacts;
}

/**
 * Why a parsed line was not imported. The first four are A20's; D178 (A20 §11) adds the cross-format
 * rule's `cross_format_duplicate` and the CSV row reasons.
 */
export type CamtSkipReason =
  | 'pending'
  | 'unreadable_amount'
  | 'unsupported_status'
  | 'duplicate_entry'
  | 'cross_format_duplicate'
  | 'unreadable_date'
  | 'zero_amount'
  | 'currency_differs'
  | 'not_a_movement';

/** An `Ntry` the importer did NOT turn into a `bank_txn`, with an honest reason (A20-C6). */
export interface SkippedCamtEntry {
  entryRef: string | null;
  reason: CamtSkipReason;
  /** Present only for `unsupported_status`: the `Ntry/Sts` code that was neither BOOK nor PDNG. */
  status?: string | null;
  /** D178: a CSV row's number in the file (1-based, the header row counted), for the row reasons. */
  row?: number;
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
  /**
   * A36 §4.4 rule 0: true when this message is ONE PAGE of a statement the bank split over several
   * messages. Read from either pagination element (`GrpHdr/MsgPgntn`, where ZKB and SPS put it, or
   * `Stmt/StmtPgntn`, which ZKB fills for CBPR+ only) with a page number above 1 or `LastPgInd`
   * false, or from an `INTM` balance. The successor rule refuses such a page until TILL reads pages.
   */
  splitPage: boolean;
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

/**
 * D178 (A20 §11.4): a parsed statement of ANY format, the shape the one insertion takes. A camt statement
 * is one; the MT940 and CSV parsers produce one with their own `messageType`.
 */
export interface ParsedBankStatement extends Omit<ParsedCamtStatement, 'messageType'> {
  messageType: StatementMessageType;
}

// --- The extraction primitives -------------------------------------------------------------------

/** Strip a namespace prefix from every tag (`<ns2:Stmt>` -> `<Stmt>`, `</ns2:Stmt>` -> `</Stmt>`). */
function stripPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z][\w.-]{0,40}:/g, '<$1');
}

/**
 * The opening tag (`<tag>` or `<tag attr="...">`), its attribute run bounded. D178 (bounded parsing): the
 * body is found with `indexOf` of the closing tag, never with a lazy `[\s\S]*?` pattern, so a file full of
 * opening tags that never close costs one scan instead of one scan per tag. The answer is the same: the
 * first closing tag after the opening one, and when the first opening tag has no closing tag after it,
 * no later one has either.
 */
function openTagRe(tag: string, flags: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]{0,1000})?>`, flags);
}

/** The inner content of the FIRST `<tag ...>...</tag>` at this nesting level, or null if absent. */
function firstTagBody(xml: string | null, tag: string): string | null {
  if (xml === null) return null;
  const m = openTagRe(tag, '').exec(xml);
  if (m === null) return null;
  const start = m.index + m[0].length;
  const close = xml.indexOf(`</${tag}>`, start);
  return close === -1 ? null : xml.slice(start, close);
}

/** Every `<tag ...>...</tag>` block's inner content at this nesting level, in document order. */
function allTagBodies(xml: string | null, tag: string): string[] {
  if (xml === null) return [];
  const re = openTagRe(tag, 'g');
  const closing = `</${tag}>`;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const start = m.index + m[0].length;
    const close = xml.indexOf(closing, start);
    if (close === -1) break;
    out.push(xml.slice(start, close));
    re.lastIndex = close + closing.length;
  }
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
  const re = new RegExp(`<${tag}\\s{1,20}Ccy="([A-Z]{3})"\\s{0,20}>\\s{0,200}([\\d.]{1,40})\\s{0,200}<\\/${tag}>`);
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

/**
 * A39: the counterparty of a movement, `RltdPties/Dbtr` + `DbtrAcct` for money arriving and
 * `RltdPties/Cdtr` + `CdtrAcct` for money leaving (SPS 2.3 p.84-86). Name and IBAN, either may be absent.
 */
function parseCounterparty(txDtls: string | null, creditDebit: string): { name: string | null; iban: string | null } {
  if (txDtls === null) return { name: null, iban: null };
  const rltdPties = firstTagBody(txDtls, 'RltdPties');
  const partyTag = creditDebit === 'CRDT' ? 'Dbtr' : 'Cdtr';
  const party = firstTagBody(rltdPties, partyTag);
  const pty = firstTagBody(party, 'Pty') ?? party;
  const acct = firstTagBody(rltdPties, `${partyTag}Acct`);
  const iban = tagText(firstTagBody(acct, 'Id'), 'IBAN');
  return { name: tagText(pty, 'Nm'), iban: iban === null ? null : iban.replace(/\s+/g, '').toUpperCase() };
}

/** A39: the unstructured remittance text of a transaction, else its additional info, else the entry's. */
function parseRemittanceText(txDtls: string | null, ntry: string): string | null {
  const ustrd = txDtls === null ? [] : allTagBodies(firstTagBody(txDtls, 'RmtInf'), 'Ustrd').map((u) => u.trim()).filter((u) => u.length > 0);
  if (ustrd.length > 0) return ustrd.join(' ');
  const addtlTx = txDtls === null ? null : tagText(txDtls, 'AddtlTxInf');
  if (addtlTx !== null) return addtlTx;
  return tagText(ntry, 'AddtlNtryInf');
}

/** A39: `TxDtls/Refs/EndToEndId`; the SPS placeholder `NOTPROVIDED` is no reference at all. */
function parseEndToEndId(txDtls: string | null): string | null {
  if (txDtls === null) return null;
  const e2e = tagText(firstTagBody(txDtls, 'Refs'), 'EndToEndId');
  return e2e === null || e2e.toUpperCase() === 'NOTPROVIDED' ? null : e2e;
}

/** `TxDtls/Refs/AcctSvcrRef` (p.76): the transaction's own idempotency token, distinct from the
 *  booking-level one above. */
function txDtlsAcctSvcrRef(txDtls: string): string | null {
  const refs = firstTagBody(txDtls, 'Refs');
  return tagText(refs, 'AcctSvcrRef');
}

/** A39 L6: `TxDtls/Refs/PmtInfId`, the run's PmtInfId where a bank reports it per transaction, not in `Btch`. */
function txDtlsPmtInfId(txDtls: string | null): string | null {
  if (txDtls === null) return null;
  return tagText(firstTagBody(txDtls, 'Refs'), 'PmtInfId');
}

// --- D178 (A20 §11.1): the facts beyond the booked amount -------------------------------------------

/** The entry WITHOUT its `NtryDtls` block: the C-level elements only (SPS 2.3 p.61-72). */
function cLevelOf(ntry: string): string {
  // String positions, never a `[\s\S]*` pattern: an entry without a closing tag costs one scan.
  const open = ntry.search(/<NtryDtls[\s>]/);
  if (open === -1) return ntry;
  const close = ntry.lastIndexOf('</NtryDtls>');
  if (close < open) return ntry.slice(0, open);
  return ntry.slice(0, open) + ntry.slice(close + '</NtryDtls>'.length);
}

/** `BkTxCd` (SPS p.66 C-level, p.80 D-level): Domain/Family/Sub-Family and the proprietary code. */
function readBankCode(scope: string | null): BankCodeFact | null {
  const bk = firstTagBody(scope, 'BkTxCd');
  if (bk === null) return null;
  const domn = firstTagBody(bk, 'Domn');
  const fmly = firstTagBody(domn, 'Fmly');
  const prtry = firstTagBody(bk, 'Prtry');
  const code: BankCodeFact = {
    domain: tagText(domn, 'Cd'),
    family: tagText(fmly, 'Cd'),
    subFamily: tagText(fmly, 'SubFmlyCd'),
    proprietary: tagText(prtry, 'Cd'),
    issuer: tagText(prtry, 'Issr'),
  };
  return Object.values(code).every((v) => v === null) ? null : code;
}

/** `CcyXchg` (SPS p.68/78): the bank's rate VERBATIM, a decimal string, with its three currencies. */
function readExchange(scope: string | null): ExchangeFact | null {
  const x = firstTagBody(scope, 'CcyXchg');
  if (x === null) return null;
  const rate = tagText(x, 'XchgRate');
  return {
    sourceCurrency: tagText(x, 'SrcCcy'),
    targetCurrency: tagText(x, 'TrgtCcy'),
    unitCurrency: tagText(x, 'UnitCcy'),
    rate: rate !== null && /^\d+(\.\d+)?$/.test(rate) ? rate : null,
    effectiveRate: null,
    origin: 'structured',
  };
}

/** `AmtDtls` (SPS §3.3, p.18-19): the instructed amount, the transaction amount, the counter value. */
function readAmountDetails(scope: string | null): {
  instructed: MoneyFact | null;
  transactionAmount: MoneyFact | null;
  counterValue: MoneyFact | null;
  exchange: ExchangeFact | null;
} {
  const ad = firstTagBody(scope, 'AmtDtls');
  if (ad === null) return { instructed: null, transactionAmount: null, counterValue: null, exchange: null };
  const instd = firstTagBody(ad, 'InstdAmt');
  const tx = firstTagBody(ad, 'TxAmt');
  const cv = firstTagBody(ad, 'CntrValAmt');
  const money = (body: string | null): MoneyFact | null => {
    const a = extractAmount(body, 'Amt');
    return a === null ? null : { amountMinor: a.minor, currency: a.currency };
  };
  return {
    instructed: money(instd),
    transactionAmount: money(tx),
    counterValue: money(cv),
    exchange: readExchange(instd) ?? readExchange(tx) ?? readExchange(cv),
  };
}

/** `Chrgs` (SPS p.69-71 C-level, p.80-81 D-level): the total and every record; an older shape with
 *  the amount directly under `Chrgs` reads as one record. */
function readCharges(scope: string | null): ChargesFact | null {
  const ch = firstTagBody(scope, 'Chrgs');
  if (ch === null) return null;
  const total = extractAmount(ch, 'TtlChrgsAndTaxAmt');
  const bodies = allTagBodies(ch, 'Rcrd');
  const records: ChargeRecordFact[] = [];
  for (const r of bodies.length > 0 ? bodies : [ch]) {
    const amt = extractAmount(r, 'Amt');
    if (amt === null) continue;
    const cd = tagText(r, 'CdtDbtInd');
    const incl = tagText(r, 'ChrgInclInd');
    const tp = firstTagBody(r, 'Tp');
    records.push({
      amountMinor: amt.minor,
      currency: amt.currency,
      creditDebit: cd === 'CRDT' || cd === 'DBIT' ? cd : null,
      included: incl === 'true' ? true : incl === 'false' ? false : null,
      type: tagText(tp, 'Cd') ?? tagText(firstTagBody(tp, 'Prtry'), 'Id'),
    });
  }
  if (total === null && records.length === 0) return null;
  return { totalMinor: total?.minor ?? null, currency: total?.currency ?? records[0]?.currency ?? null, records, origin: 'structured' };
}

/**
 * The facts of one parsed row (A20 §11.1). `txDtls` is the row's own detail (null for an entry without
 * one, or a batch kept as one line); `cLevelToo` lets the C-level amount details, charges and
 * `AcctSvcrRef` speak for the row, which is right only when the row IS the whole booking (an entry with
 * at most one detail, or a batch kept as one line), never for one line of a fanned-out batch.
 */
function factsOfRow(
  ntry: string,
  txDtls: string | null,
  cLevelToo: boolean,
  source: FactSource,
  line: { amountMinor: number; currency: string; creditDebit: CamtCreditDebit },
): LineFacts {
  const cLevel = cLevelOf(ntry);
  const facts = emptyFacts(source);
  facts.bankCode = readBankCode(txDtls) ?? readBankCode(cLevel);
  const ustrd = txDtls === null ? [] : allTagBodies(firstTagBody(txDtls, 'RmtInf'), 'Ustrd').map((u) => u.trim()).filter((u) => u.length > 0);
  facts.bankText = ustrd.length > 0 ? ustrd.join(' ') : null;
  facts.additionalInfo = txDtls === null ? null : tagText(txDtls, 'AddtlTxInf');
  facts.entryInfo = tagText(cLevel, 'AddtlNtryInf');
  const refs = firstTagBody(txDtls, 'Refs');
  facts.refs = {
    endToEndId: parseEndToEndId(txDtls),
    accountServicerRef: tagText(refs, 'AcctSvcrRef') ?? (cLevelToo ? entryLevelAcctSvcrRef(ntry) : null),
    instructionId: tagText(refs, 'InstrId'),
    transactionId: tagText(refs, 'TxId'),
  };
  const d = readAmountDetails(txDtls);
  const hasD = d.instructed !== null || d.transactionAmount !== null || d.counterValue !== null || d.exchange !== null;
  const amounts = hasD || !cLevelToo ? d : readAmountDetails(cLevel);
  facts.instructed = amounts.instructed;
  facts.transactionAmount = amounts.transactionAmount;
  facts.counterValue = amounts.counterValue;
  facts.exchange = amounts.exchange;
  facts.charges = readCharges(txDtls) ?? (cLevelToo ? readCharges(cLevel) : null);
  return deriveFacts(facts, line);
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

function parseEntry(ntry: string, source: FactSource): EntryParseResult {
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

  /**
   * One row for the whole entry: an entry with at most one `TxDtls`, and (A39 L7 (b)) a batch whose
   * `TxDtls` are not all in the entry's currency (EUR details under a CHF booking) or do not sum to it.
   * The bank's entry amount is the booked fact; such a batch is ONE line of it, keyed like a single-line
   * entry (so it keeps `asr:<Ntry AcctSvcrRef>`), with the run's PmtInfId kept.
   */
  const singleLine = (txDtls: string | null): EntryParseResult => {
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
    const counterparty = parseCounterparty(txDtls, shared.creditDebit);
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
          counterpartyName: counterparty.name,
          counterpartyIban: counterparty.iban,
          remittanceText: parseRemittanceText(txDtls, ntry),
          endToEndId: parseEndToEndId(txDtls),
          ...shared,
          txPmtInfId: txDtlsPmtInfId(txDtls),
          facts: factsOfRow(ntry, txDtls, true, source, { amountMinor: amt.minor, currency: amt.currency, creditDebit: shared.creditDebit }),
        },
      ],
    };
  };

  if (txDtlsList.length <= 1) return singleLine(txDtlsList[0] ?? null);

  // A batch entry (SPS 2.3 p.61: "One booking can combine several transactions"). D81: fan out one
  // parsed row per `TxDtls`, each with its own reference, payer and `TxDtls/Amt`. The fan-out must sum
  // exactly to the entry amount in the entry's currency; a batch that does not (A39 L7 (b): EUR details
  // under a CHF booking) is ONE line of the entry amount, never a refused file.
  const amounts: { minor: number; currency: string }[] = [];
  for (let i = 0; i < txDtlsList.length; i++) {
    const txAmt = extractAmount(txDtlsList[i] as string, 'Amt');
    if (txAmt === null) {
      return {
        kind: 'error',
        reason: `a batch entry's TxDtls[${i}] has no readable Amt (NtryRef ${entryRef ?? 'none'})`,
      };
    }
    amounts.push(txAmt);
  }
  const sum = amounts.reduce((total, a) => total + a.minor, 0);
  if (sum !== amt.minor || amounts.some((a) => a.currency !== amt.currency)) return singleLine(null);

  // A39 L7 (a): a bank may give every payment of one collective booking the SAME `TxDtls/Refs/AcctSvcrRef`
  // (SPS 2025 wants it unique; this only tolerates the deviation). Inside ONE `Ntry`, a ref that repeats an
  // earlier one keys `asr:<ref>#<n>`, n counting its earlier repeats there (R, S, R key asr:R, asr:S,
  // asr:R#1); the first keeps `asr:<ref>`, so an unrepeated statement keeps its keys and its content hash,
  // and a ref stored from another `Ntry` or file still answers `duplicate_entry`.
  const seenRefs = new Map<string, number>();
  const lines: ParsedCamtEntry[] = [];
  for (let i = 0; i < txDtlsList.length; i++) {
    const txDtls = txDtlsList[i] as string;
    const txAmt = amounts[i] as { minor: number; currency: string };
    const reference = parseStructuredReference(txDtls);
    const payerName = parsePayerName(txDtls);
    const ref = txDtlsAcctSvcrRef(txDtls);
    let acctSvcrRef = ref;
    if (ref !== null) {
      const repeats = seenRefs.get(ref) ?? 0;
      seenRefs.set(ref, repeats + 1);
      if (repeats > 0) acctSvcrRef = `${ref}#${repeats}`;
    }
    const key = entryIdentityKey({
      acctSvcrRef,
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
    const counterparty = parseCounterparty(txDtls, shared.creditDebit);
    lines.push({
      entryKey: key,
      amountMinor: txAmt.minor,
      currency: txAmt.currency,
      referenceKind: reference.kind,
      referenceValue: reference.value,
      payerName,
      counterpartyName: counterparty.name,
      counterpartyIban: counterparty.iban,
      remittanceText: parseRemittanceText(txDtls, ntry),
      endToEndId: parseEndToEndId(txDtls),
      ...shared,
      txPmtInfId: txDtlsPmtInfId(txDtls),
      facts: factsOfRow(ntry, txDtls, false, source, { amountMinor: txAmt.minor, currency: txAmt.currency, creditDebit: shared.creditDebit }),
    });
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
  intermediate: boolean;
} {
  let intermediate = false;
  let opening: number | null = null;
  let closing: number | null = null;
  let currency: string | null = null;
  for (const bal of allTagBodies(stmt, 'Bal')) {
    const tp = firstTagBody(bal, 'Tp');
    const cdOrPrtry = firstTagBody(tp, 'CdOrPrtry');
    const code = tagText(cdOrPrtry, 'Cd');
    // `Bal/Tp/SubTp/Cd` (ISO 20022 BalanceSubType1Choice holds `Cd` directly, SPS 2.3 p.54). The
    // first `<Cd>` anywhere under SubTp also reads the older `SubTp/CdOrPrtry/Cd` form this parser
    // used to expect, so both shapes are recognised (A36 §4.4 rule 0).
    const subTp = firstTagBody(tp, 'SubTp');
    const subCode = tagText(subTp, 'Cd');
    if (subCode !== null && subCode.toUpperCase() === 'INTM') {
      intermediate = true;
      continue;
    }
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
  return { openingBalanceMinor: opening, closingBalanceMinor: closing, balanceCurrency: currency, intermediate };
}

/** One pagination element (`StmtPgntn` or `MsgPgntn`, the same Pagination1 shape), or null. */
function readPagination(pgntn: string | null): { pageNumber: number; lastPage: boolean } | null {
  if (pgntn === null) return null;
  const pgNb = tagText(pgntn, 'PgNb');
  const pageNumber = pgNb === null ? 1 : (Number.parseInt(pgNb, 10) || 1);
  const lastPage = tagText(pgntn, 'LastPgInd') === 'true';
  return { pageNumber, lastPage };
}

/**
 * The page of this message. `Stmt/StmtPgntn` (p.44) when present, else `GrpHdr/MsgPgntn` (A36 §4.4
 * rule 0: ZKB and SPS put the page there, and ZKB fills `StmtPgntn` for CBPR+ only), else an ordinary
 * single-message statement, trivially its own last page. The page number is part of the statement's
 * identity (D81), so a page 2 flagged only in `MsgPgntn` no longer collides with its page 1.
 */
function parsePagination(stmt: string, grpHdr: string | null): { pageNumber: number; lastPage: boolean; split: boolean } {
  const onStatement = readPagination(firstTagBody(stmt, 'StmtPgntn'));
  const onMessage = readPagination(firstTagBody(grpHdr, 'MsgPgntn'));
  const page = onStatement ?? onMessage ?? { pageNumber: 1, lastPage: true };
  const split = [onStatement, onMessage].some((p) => p !== null && (p.pageNumber > 1 || !p.lastPage));
  return { ...page, split };
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

  const { intermediate, ...balances } = parseBalances(stmt);
  const pagination = parsePagination(stmt, firstTagBody(normalized, 'GrpHdr'));

  const entries: ParsedCamtEntry[] = [];
  const skipped: SkippedCamtEntry[] = [];
  for (const ntry of allTagBodies(stmt, 'Ntry')) {
    const parsed = parseEntry(ntry, messageType);
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
      splitPage: pagination.split || intermediate,
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
export function hashCamtStatement(stmt: ParsedBankStatement): string {
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

/** Why `splitCamt053` refused to split a multi-statement message (A36 §4.7). */
export type CamtSplitRefusal = 'iban_differs' | 'currency_differs' | 'no_sequence_number' | 'not_camt053' | 'part_unreadable';

/**
 * A36 §4.7 (D150): split a camt.053 message that carries SEVERAL `<Stmt>` (an eBanking "Datei abholen"
 * over a date range can return one file for many days) into single-statement messages, each keeping the
 * envelope (`Document`, `BkToCstmrStmt`, `GrpHdr`) byte for byte, so each part goes through the ONE
 * parser and the ONE statement door (`parseCamt`, `importCamt`) exactly as a one-day file would. A
 * message with one `<Stmt>` (or none: `parseCamt` will name why) is returned unchanged.
 *
 * Refuses to split, rather than guessing, when the parts disagree on the account IBAN or on the balance
 * currency (one account per message is the SPS rule, p.45), or when a part has no `ElctrncSeqNb` (it
 * could not be ordered against the books). Pure: no store, no clock.
 */
export function splitCamt053(xml: unknown): Result<{ parts: string[]; split: boolean }> {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    return err('schema_invalid', { reason: 'the payload is not a non-empty XML string' });
  }
  // A `Stmt` element with or without a namespace prefix; `StmtPgntn` and the like are not matched. A
  // `Stmt` never contains another `Stmt`, so the lazy match ends at its own close tag.
  // D178 (bounded parsing): the opening tag by a bounded pattern, its close by `indexOf`, never a lazy
  // `[\s\S]*?` with a backreference (one scan per unclosed `<Stmt>` would make a crafted file quadratic).
  const re = /<((?:[A-Za-z_][\w.-]{0,40}:)?)Stmt(?=[\s>])[^>]{0,1000}>/g;
  const blocks: { start: number; end: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  // A prefix whose closing tag is absent from the rest of the file is never searched again; a file
  // trying many such prefixes is not a camt this splitter reads further.
  const unclosed = new Set<string>();
  while ((m = re.exec(xml)) !== null) {
    const prefix = m[1] ?? '';
    if (unclosed.has(prefix)) continue;
    const closing = `</${prefix}Stmt>`;
    const close = xml.indexOf(closing, m.index + m[0].length);
    if (close === -1) {
      unclosed.add(prefix);
      if (unclosed.size > 8) break;
      continue;
    }
    const end = close + closing.length;
    blocks.push({ start: m.index, end, text: xml.slice(m.index, end) });
    re.lastIndex = end;
  }
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (blocks.length <= 1 || first === undefined || last === undefined) return ok({ parts: [xml], split: false });

  const head = xml.slice(0, first.start);
  const tail = xml.slice(last.end);
  const parts = blocks.map((b) => `${head}${b.text}${tail}`);
  let iban: string | null | undefined;
  let currency: string | null | undefined;
  for (let i = 0; i < parts.length; i += 1) {
    const parsed = parseCamt(parts[i]);
    const refuse = (reason: CamtSplitRefusal, extra: Record<string, unknown> = {}) => err('camt_split_refused', { reason, part: i + 1, parts: parts.length, ...extra });
    if (!parsed.ok) return refuse('part_unreadable', { detail: (parsed as { reason?: unknown }).reason ?? parsed.error });
    const s = parsed.statement;
    if (s.messageType !== 'camt053') return refuse('not_camt053');
    if (s.electronicSeqNb === null) return refuse('no_sequence_number', { statementId: s.statementId });
    if (iban === undefined) iban = s.iban;
    else if (iban !== s.iban) return refuse('iban_differs', { iban: s.iban, firstIban: iban });
    if (currency === undefined) currency = s.balanceCurrency;
    else if (currency !== s.balanceCurrency) return refuse('currency_differs', { currency: s.balanceCurrency, firstCurrency: currency });
  }
  return ok({ parts, split: true });
}
