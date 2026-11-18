/**
 * A41.8 (D193), WHAT A BANK LINE'S RECEIPT SAYS ABOUT ITS VAT: the one reading the proposal's code step
 * (`bankProposals.ts`, through `ReceiptVatSource`), the inbox's `vatCheck` and the autobook verdict share.
 *
 * WHICH RECEIPTS, for a debit line, in order: the line's ACTIVE assignment (A41.3), else the receipts filed on the line
 * (and on a booked line, on the entry its decision booked) with a capture behind them, else the files of EXACTLY ONE
 * candidate group (A41.1; several groups are no receipt: TILL does not guess). Each receipt is read ON ITS OWN, never
 * merged (critic r2), with `covers`: its gross covers the line under A41.1's amount rule. A code is picked only for a
 * line with exactly ONE receipt (`hintOf`). The seat must hold both read rights; otherwise no receipt is read for it.
 *
 * WHAT IT STATES: the gross is the receipt's `amount`. A stated VAT amount (`vat_amount`) is the VAT, and its rate is
 * the statutory rate whose VAT on the gross lies nearest and within `belege.vat_delta_tolerance_rappen` (a tie between
 * classes, or a stated single rate that disagrees, is no rate). Else a stated rate (`vat_breakdown`, else `vat_rate`,
 * Swico S1 tag 32: one rate for the invoice, or a `rate:net` list): one distinct rate is the rate; several are no rate.
 * An explicit zero is "no VAT"; nothing at all is SILENT.
 *
 * TRUST, the level `belege.autobook_figure_trust` sets: `agent` trusts every reading; `confirmed` trusts the figures
 * (`amount`, `vat_amount`) when `figuresTrust` holds, and a rate from `vat_rate` / `vat_breakdown` only when that field
 * was read from the bytes (`qr` / `swico`) AND `figuresTrust` holds: a person's confirmation covers the engine's
 * fields, not those two.
 *
 * Pure reads, §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { IS_HEAD } from '../files/head.js';
import { VAT_RATE_ERAS, vatRatesOn } from '../vat/rateEras.js';
import type { VatRateEra } from '../vat/rateEras.js';
import { lineBookingDate } from './bankLines.js';
import type { BankTxnDetailRow, BankTxnRow, BookBankLineTarget } from './bankLines.js';
import type { BankProposalTarget, ReceiptRateClass, ReceiptVatHint, ReceiptVatSource } from './bankProposals.js';
import { BANK_LINE_READ_CAPABILITY, BELEG_READ_CAPABILITY, amountMatch, belegCandidatesForLine, belegMatchContext, fieldsOf, holdsRead } from './belegMatch.js';
import { bookedLegsOf, compareVat, computedVatOf, receiptVatCheck, targetSelfAssessed } from './belegEvidence.js';
import type { VatCheck } from './belegEvidence.js';
import type { BelegCandidateGroup, BelegMatchContext } from './belegMatch.js';
import { engineFieldsOf, receiptFigures } from './belegFigures.js';
import { figureTrustMode, figuresTrust } from './belegTrust.js';
import type { FigureTrustMode } from './belegTrust.js';
import { activeAssignmentOf } from './belegAssignmentStore.js';
import { readLineFactsMap } from './statementFacts.js';
import type { BankLineFacts } from './statementFacts.js';

/** The setting and its values (the registry entry is the schema). */
export const VAT_FROM_RECEIPT_SETTING = 'belege.vat_from_receipt';
export const VAT_FROM_RECEIPT_MODES = ['propose', 'compare_only'] as const;
export type VatFromReceiptMode = (typeof VAT_FROM_RECEIPT_MODES)[number];

/** `belege.vat_from_receipt`; an unknown stored value reads as the default. */
export function vatFromReceiptMode(ctx: WorkspaceContext): VatFromReceiptMode {
  return getSetting<string>(ctx, VAT_FROM_RECEIPT_SETTING) === 'compare_only' ? 'compare_only' : 'propose';
}

/** Where the line's receipt came from. */
export type ReceiptVatSourceKind = 'assigned' | 'filed' | 'candidate';

/** One receipt's VAT as TILL reads it (see the module note). */
export interface ReceiptVatReading {
  source: ReceiptVatSourceKind;
  captureId: string;
  fileId: string;
  /** The figures (gross, VAT amount) are at or above the trust level. */
  trusted: boolean;
  /** `vat`: it states VAT; `zero`: it states none (an explicit 0); `silent`: it says nothing about VAT. */
  states: 'vat' | 'zero' | 'silent';
  /** The one rate it states or implies (0 for `zero`), else null (mixed, or none of Switzerland's). */
  rateBp: number | null;
  rateClass: ReceiptRateClass | null;
  /** The rate is at or above the trust level too (a typed rate is not, under `confirmed`). */
  rateTrusted: boolean;
  /** Its VAT in `currency` (0 for `zero`), stated or computed from its rate(s), else null. */
  amountMinor: number | null;
  grossMinor: number | null;
  currency: string | null;
  /** Critic r2: the receipt's gross covers the line under A41.1's amount rule (set per line, false off a line). */
  covers: boolean;
}

// --- Rates ------------------------------------------------------------------------------------------------

/** The eras a rate is classed in: the line's own first, then every era newest first. */
function erasFor(date: string): VatRateEra[] {
  const own = vatRatesOn(date);
  const rest = [...VAT_RATE_ERAS].reverse().filter((e) => e !== own);
  return own === null ? rest : [own, ...rest];
}

/** The Swiss rate class of a rate (0: `zero`), the line's era first, or null (a foreign rate). */
export function receiptRateClass(rateBp: number, date: string): ReceiptRateClass | null {
  if (rateBp === 0) return 'zero';
  for (const era of erasFor(date)) {
    if (rateBp === era.normalBp) return 'normal';
    if (rateBp === era.reducedBp) return 'reduced';
    if (rateBp === era.accommodationBp) return 'accommodation';
  }
  return null;
}

/** The VAT included in a gross at `rateBp`, rounded half up (Rappen). */
function vatInGross(grossMinor: number, rateBp: number): number {
  return Math.floor((grossMinor * rateBp * 2 + (10_000 + rateBp)) / (2 * (10_000 + rateBp)));
}

/** The VAT on a net at `rateBp`, rounded half up (Rappen). */
function vatOnNet(netMinor: number, rateBp: number): number {
  return Math.floor((netMinor * rateBp * 2 + 10_000) / 20_000);
}

/**
 * The statutory rate whose VAT on `grossMinor` lies nearest `vatMinor`, within `toleranceMinor`; null when none does
 * or two classes are equally near.
 */
function snapRate(grossMinor: number, vatMinor: number, toleranceMinor: number, date: string): number | null {
  let best: { rateBp: number; d: number } | null = null;
  let tie = false;
  const seen = new Set<number>();
  for (const era of erasFor(date)) {
    for (const r of [era.normalBp, era.reducedBp, era.accommodationBp]) {
      if (seen.has(r)) continue;
      seen.add(r);
      const d = Math.abs(vatInGross(grossMinor, r) - vatMinor);
      if (d > toleranceMinor) continue;
      if (best === null || d < best.d) {
        best = { rateBp: r, d };
        tie = false;
      } else if (d === best.d) {
        tie = true;
      }
    }
  }
  return best === null || tie ? null : best.rateBp;
}

/** A percentage (`8.1`, `8.1%`, a number) in basis points, else null. */
function percentBp(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v < 100 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%?\s*$/.exec(v);
  return m === null ? null : Math.round(Number(m[1]!.replace(',', '.')) * 100);
}

/** A decimal amount (`100.00`) in minor units, else null. */
function decimalMinor(s: string): number | null {
  if (!/^\s*\d+(?:\.\d{1,2})?\s*$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** The rates a field states (`8.1`, or `8.1:100.00;2.6:50`), each with its net when given; null when unreadable. */
function statedRates(v: unknown): { rateBp: number; netMinor: number | null }[] | null {
  const single = percentBp(v);
  if (single !== null) return [{ rateBp: single, netMinor: null }];
  if (typeof v !== 'string' || v.trim() === '') return null;
  const out: { rateBp: number; netMinor: number | null }[] = [];
  for (const part of v.split(';')) {
    if (part.trim() === '') continue;
    const [r, net, extra] = part.split(':');
    if (extra !== undefined) return null;
    const rateBp = percentBp(r);
    const netMinor = net === undefined ? null : decimalMinor(net);
    if (rateBp === null || (net !== undefined && netMinor === null)) return null;
    out.push({ rateBp, netMinor });
  }
  return out.length === 0 ? null : out;
}

// --- One capture ------------------------------------------------------------------------------------------

/** What the reader shares across one request. */
interface ReadConfig {
  mode: FigureTrustMode;
  toleranceMinor: number;
  base: string;
  /** A41.1's `belege.match_fx_tolerance_pct`, for `covers`. */
  fxTolerancePct: number;
}

/** The live provenance of a capture's field, or null. */
function provenanceOf(ctx: WorkspaceContext, captureId: string, key: string): string | null {
  const r = ctx.store.db
    .prepare('SELECT provenance FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = ? AND superseded = 0 ORDER BY rowid DESC LIMIT 1')
    .get(ctx.workspaceId, captureId, key) as { provenance: string } | undefined;
  return r?.provenance ?? null;
}

/** One capture's VAT reading on a line dated `date` (see the module note). */
export function readCaptureVat(
  ctx: WorkspaceContext,
  cfg: ReadConfig,
  captureId: string,
  fileId: string,
  source: ReceiptVatSourceKind,
  date: string,
): ReceiptVatReading {
  const fields = fieldsOf(ctx, captureId);
  const figures = receiptFigures(engineFieldsOf(fields), cfg.base);
  const figureTrusted = cfg.mode === 'agent' ? figures !== null : figures !== null && figuresTrust(ctx, captureId) !== null;
  const rateKey = fields.has('vat_breakdown') ? 'vat_breakdown' : fields.has('vat_rate') ? 'vat_rate' : null;
  const rates = rateKey === null ? null : statedRates(fields.get(rateKey));
  const rateFieldTrusted =
    rateKey !== null &&
    (cfg.mode === 'agent' || (figureTrusted && ['qr', 'swico'].includes(provenanceOf(ctx, captureId, rateKey) ?? '')));
  const gross = figures?.amountMinor ?? null;
  const base: Omit<ReceiptVatReading, 'states' | 'rateBp' | 'rateClass' | 'rateTrusted' | 'amountMinor'> = {
    source,
    captureId,
    fileId,
    trusted: figureTrusted,
    grossMinor: gross,
    currency: figures?.currency ?? null,
    covers: false,
  };
  const distinct = rates === null ? [] : [...new Set(rates.map((r) => r.rateBp))];
  const singleStated = distinct.length === 1 && distinct[0]! > 0 ? distinct[0]! : null;
  const rawVat = fields.get('vat_amount');
  const zeroAmount = rawVat !== null && typeof rawVat === 'object' && (rawVat as { minor?: unknown }).minor === 0;
  // 1. A stated VAT amount: the rate it implies on the gross (a stated single rate must agree).
  if (figures !== null && figures.vatMinor !== null) {
    const snapped = snapRate(figures.amountMinor, figures.vatMinor, cfg.toleranceMinor, date);
    const rate = snapped !== null && (singleStated === null || singleStated === snapped) ? snapped : null;
    return { ...base, states: 'vat', rateBp: rate, rateClass: rate === null ? null : receiptRateClass(rate, date), rateTrusted: figureTrusted, amountMinor: figures.vatMinor };
  }
  // 2. An explicit zero: the receipt states no VAT.
  if (zeroAmount || (rates !== null && distinct.length === 1 && distinct[0] === 0)) {
    return { ...base, states: 'zero', rateBp: 0, rateClass: 'zero', rateTrusted: zeroAmount ? figureTrusted : rateFieldTrusted, amountMinor: 0 };
  }
  // 3. A stated rate (or list): one distinct rate is the rate; the VAT from the nets, else from the gross.
  if (rates !== null) {
    const nets = rates.every((r) => r.netMinor !== null);
    const amount = nets ? rates.reduce((s, r) => s + vatOnNet(r.netMinor as number, r.rateBp), 0) : singleStated !== null && gross !== null ? vatInGross(gross, singleStated) : null;
    return {
      ...base,
      states: 'vat',
      rateBp: singleStated,
      rateClass: singleStated === null ? null : receiptRateClass(singleStated, date),
      rateTrusted: rateFieldTrusted,
      amountMinor: amount,
    };
  }
  return { ...base, states: 'silent', rateBp: null, rateClass: null, rateTrusted: false, amountMinor: null };
}

/**
 * The trusted hint the code step reads (critic r2 ruling, rule 1): ONLY for a line with exactly ONE receipt, whose gross
 * covers the line (A41.1's amount rule, `covers`), in the line's currency, trusted, stating exactly one Swiss rate (or a
 * trusted zero) with a VAT figure. Null otherwise: two or more receipts, a gross that does not cover the line, another
 * currency, untrusted, silent, several rates, a foreign rate. The code's computed VAT must then match it (`fits`).
 */
export function hintOf(readings: readonly ReceiptVatReading[], row: Pick<BankTxnRow, 'currency'>): ReceiptVatHint | null {
  if (readings.length !== 1) return null;
  const r = readings[0]!;
  if (!r.covers || r.currency !== row.currency || !r.trusted || !r.rateTrusted || r.states === 'silent') return null;
  if (r.rateBp === null || r.rateClass === null || r.amountMinor === null || r.currency === null) return null;
  return { rateBp: r.rateBp, rateClass: r.rateClass, amountMinor: r.amountMinor, currency: r.currency };
}

// --- The line's receipts ------------------------------------------------------------------------------------

/** How a line stands, for which receipts count. */
export interface ReceiptLineState {
  state: 'open' | 'booked' | 'other';
  /** The entry a booked line's decision booked, or null. */
  entryId: string | null;
  /** A booked line holds no receipt (the "Ohne Beleg" facet): its single candidate counts. */
  needsReceipt: boolean;
}

/** The request's reader: the readings, the candidates (memoised per line) and the proposal's source. */
export interface ReceiptVatContext {
  /** False: the seat may not read receipts and bank lines, and every answer is empty. */
  readsBelege: boolean;
  /** The line's receipts, ONE reading each (never merged, critic r2), each with `covers`; empty when it has none. */
  readingsFor(row: BankTxnRow, detail: BankTxnDetailRow | undefined, line: ReceiptLineState): ReceiptVatReading[];
  /** A41.1's candidate groups of a line, computed once per request (empty without the match context). */
  candidatesFor(row: BankTxnRow, detail: BankTxnDetailRow | undefined): BelegCandidateGroup[];
  /** The proposal's source (open lines): the code step (under `propose`) and the bulk-safety cap (always). */
  source: ReceiptVatSource;
}

/** The captured receipts filed on the line (and on a booked line's entry), as `{ fileId, captureId }`, oldest first. */
function filedCaptures(ctx: WorkspaceContext, bankTxnId: string, entryId: string | null): { fileId: string; captureId: string }[] {
  const files = ctx.store.db
    .prepare(
      `SELECT f.id, f.sha256 FROM stored_file f
        WHERE f.workspace_id = ? AND ${IS_HEAD('f')}
          AND ((f.entity_kind = 'bank_txn' AND f.entity_id = ?) OR (? IS NOT NULL AND f.entity_kind = 'journal_entry' AND f.entity_id = ?))
        ORDER BY f.created_at, f.rowid`,
    )
    .all(ctx.workspaceId, bankTxnId, entryId, entryId) as { id: string; sha256: string }[];
  const capture = ctx.store.db.prepare(
    `SELECT c.id FROM captures c WHERE c.workspace_id = ? AND (c.document_id = ? OR c.sha256 = ?) AND c.status != 'discarded'
      ORDER BY (c.document_id = ?) DESC, c.created_at, c.rowid LIMIT 1`,
  );
  const out: { fileId: string; captureId: string }[] = [];
  for (const f of files) {
    const c = capture.get(ctx.workspaceId, f.id, f.sha256, f.id) as { id: string } | undefined;
    if (c !== undefined) out.push({ fileId: f.id, captureId: c.id });
  }
  return out;
}

/** The request's read configuration. */
function readConfigOf(ctx: WorkspaceContext): ReadConfig {
  return {
    mode: figureTrustMode(ctx),
    toleranceMinor: getSetting<number>(ctx, 'belege.vat_delta_tolerance_rappen'),
    base: baseCurrencyOf(ctx),
    fxTolerancePct: getSetting<number>(ctx, 'belege.match_fx_tolerance_pct'),
  };
}

/** Each receipt read on the line: its VAT reading and whether its gross covers the line (A41.1's amount rule). */
function readOnLine(
  ctx: WorkspaceContext,
  cfg: ReadConfig,
  files: readonly { fileId: string; captureId: string }[],
  source: ReceiptVatSourceKind,
  row: BankTxnRow,
  facts: BankLineFacts | null,
  fx: Map<string, bigint | null>,
): ReceiptVatReading[] {
  const date = lineBookingDate(row);
  return files.map((f) => {
    const r = readCaptureVat(ctx, cfg, f.captureId, f.fileId, source, date);
    const covers =
      r.grossMinor !== null &&
      r.currency !== null &&
      amountMatch(ctx, { fxTolerancePct: cfg.fxTolerancePct }, { row, facts }, { amountMinor: r.grossMinor, currency: r.currency, date }, fx) !== null;
    return { ...r, covers };
  });
}

/** The line's receipts beside what `target` books on it: the one check (`receiptVatCheck`). */
function checkAgainst(
  ctx: WorkspaceContext,
  cfg: ReadConfig,
  readings: readonly ReceiptVatReading[],
  row: BankTxnRow,
  target: BankProposalTarget | BookBankLineTarget | null,
): { vatCheck: VatCheck; caps: boolean } {
  if (readings.length === 0) return { vatCheck: 'none', caps: false };
  const booking = { booksAccounts: bookedLegsOf(ctx, row, target) !== null, vatMinor: computedVatOf(ctx, row, target), selfAssessed: targetSelfAssessed(ctx, row, target) };
  return receiptVatCheck(readings, row, cfg.base, booking, cfg.toleranceMinor);
}

/**
 * The request's reader. `mc` is A41.1's match context (null under `belege.match_mode = off`, or when the caller read
 * no pool): without it, only an assigned or filed receipt counts.
 */
export function receiptVatContext(
  ctx: WorkspaceContext,
  mc: BelegMatchContext | null,
  factsOf: (bankTxnId: string) => BankLineFacts | null = (id) => readLineFactsMap(ctx, [id]).get(id) ?? null,
): ReceiptVatContext {
  const readsBelege = holdsRead(ctx, BELEG_READ_CAPABILITY) && holdsRead(ctx, BANK_LINE_READ_CAPABILITY);
  let cfg: ReadConfig | null = null;
  const config = (): ReadConfig => (cfg ??= readConfigOf(ctx));
  const fx = new Map<string, bigint | null>();
  const candidates = new Map<string, BelegCandidateGroup[]>();
  const readings = new Map<string, ReceiptVatReading[]>();

  const candidatesFor = (row: BankTxnRow, detail: BankTxnDetailRow | undefined): BelegCandidateGroup[] => {
    if (mc === null) return [];
    let found = candidates.get(row.id);
    if (found === undefined) {
      found = belegCandidatesForLine(ctx, mc, { row, detail, facts: factsOf(row.id) });
      candidates.set(row.id, found);
    }
    return found;
  };

  const readingsFor = (row: BankTxnRow, detail: BankTxnDetailRow | undefined, line: ReceiptLineState): ReceiptVatReading[] => {
    if (!readsBelege || row.credit_debit !== 'DBIT' || line.state === 'other') return [];
    const key = `${row.id}|${line.state}|${line.entryId ?? ''}|${line.needsReceipt ? 1 : 0}`;
    const known = readings.get(key);
    if (known !== undefined) return known;
    const read = (files: readonly { fileId: string; captureId: string }[], source: ReceiptVatSourceKind): ReceiptVatReading[] =>
      readOnLine(ctx, config(), files, source, row, factsOf(row.id), fx);
    let out: ReceiptVatReading[] = [];
    const assigned = line.state === 'open' ? activeAssignmentOf(ctx, row.id) : undefined;
    if (assigned !== undefined && assigned.files.length > 0) {
      out = read(assigned.files, 'assigned');
    } else {
      const filed = filedCaptures(ctx, row.id, line.state === 'booked' ? line.entryId : null);
      if (filed.length > 0) out = read(filed, 'filed');
      else if (line.state === 'open' || line.needsReceipt) {
        // Several candidate groups are no receipt (TILL does not guess which); one group is its files.
        const groups = candidatesFor(row, detail);
        if (groups.length === 1) out = read(groups[0]!.files, 'candidate');
      }
    }
    readings.set(key, out);
    return out;
  };

  const open: ReceiptLineState = { state: 'open', entryId: null, needsReceipt: false };
  return {
    readsBelege,
    readingsFor,
    candidatesFor,
    source: {
      propose: vatFromReceiptMode(ctx) === 'propose',
      hintFor: (row, detail) => hintOf(readingsFor(row, detail, open), row),
      // Critic r1 F3: the code is the receipt's only when the VAT it computes on the line matches the receipt's.
      fits: (row, target, hint) =>
        hint.currency === row.currency && compareVat(hint.amountMinor, computedVatOf(ctx, row, target) ?? 0, config().toleranceMinor).withinTolerance,
      capsFor: (row, detail, target) => checkAgainst(ctx, config(), readingsFor(row, detail, open), row, target).caps,
    },
  };
}

/**
 * Attach the reader to a proposal context: the bulk-safety cap in both modes, the code step under `propose`
 * (`source.propose`). A seat that may not read receipts and bank lines gets none (as before A41.8).
 */
export function attachReceiptVat(pc: { receiptVat?: ReceiptVatSource }, rc: ReceiptVatContext): void {
  if (rc.readsBelege) pc.receiptVat = rc.source;
}

/**
 * Build the reader for `pc` (the pool read once, when the seat may read it) and attach it: for a caller that counts
 * open lines the way the inbox lists them (the band, the hub).
 */
export function withReceiptReader<P extends { receiptVat?: ReceiptVatSource }>(ctx: WorkspaceContext, pc: P): P {
  attachReceiptVat(pc, receiptVatContext(ctx, holdsRead(ctx, BELEG_READ_CAPABILITY) ? belegMatchContext(ctx) : null));
  return pc;
}

/**
 * A41.8 (D193) for the autobook verdict: does the line's ASSIGNED receipt set (its `files`, read by their capture ids
 * only: the verdict's chokepoint) contradict what `target` books (`vatCheck` = `differs`)? In both modes of
 * `belege.vat_from_receipt`. An `unread` set does not wait here: the verdict's own checks already hold it (an engine
 * assignment needs trusted figures, `beleg_changed`; every file must fit the line amount, `beleg_amount_differs`).
 */
export function assignedReceiptDiffers(
  ctx: WorkspaceContext,
  line: BankTxnRow,
  files: readonly { fileId: string; captureId: string }[],
  target: BankProposalTarget | BookBankLineTarget | null,
): boolean {
  if (line.credit_debit !== 'DBIT' || files.length === 0) return false;
  const cfg = readConfigOf(ctx);
  const readings = readOnLine(ctx, cfg, files, 'assigned', line, readLineFactsMap(ctx, [line.id]).get(line.id) ?? null, new Map());
  return checkAgainst(ctx, cfg, readings, line, target).vatCheck === 'differs';
}
