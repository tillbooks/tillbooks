/**
 * A39, the proposal on an open bank line (spec §4.3): what the inbox pre-fills, how sure it is, and why,
 * as stable keys the Studio renders (the engine returns no prose, P11).
 *
 * THE PRIORITY IS THE POINT. The strongest fact wins, and each rung only speaks when every stronger one
 * is silent:
 *   (a) an entry ALREADY on the bank ledger account that no line accounts for, same signed amount,
 *       within 10 days: the money is booked, only the link is missing (`sure` when a reference proves
 *       it: a TILL payment with the line's QR/SCOR reference, an A18 item's EndToEndId, its run's
 *       PmtInfId; `check` otherwise, because an amount and a date alone could be a second payment);
 *   (b) a reference: an A18 run in the line's currency by an item's EndToEndId or the run's PmtInfId,
 *       the A21 QR score of a credit, the A36 vendor-bill ranking of a debit (`sure` only when a
 *       reference and the amount agree);
 *   (c) the counterparty IBAN is one of the workspace's own Bankkonten: a transfer, ALWAYS `check`
 *       (D139): the first side proposes the transfer entry, the other side then matches that entry;
 *   (d) history: the account and VAT code this counterparty was booked to last time, with the count:
 *       `learned`;
 *   (e) nothing: `open`.
 *
 * `sure` IS RESERVED FOR A REFERENCE-PROVEN MATCH (owner answer 2: "Alle sicheren buchen" stays
 * limited to reference-proven matches). A reversal-flagged line is capped at `check`: a returned
 * movement is always a human's call.
 *
 * Pure reads, §H-TENANT on every query. One `ProposalContext` per inbox page, so the claimed-entry set,
 * the own-account IBANs and the history index are read once, not once per line.
 */

import type { WorkspaceContext } from '../context.js';
import { normalizeIban } from '../setup/iban.js';
import type { Result } from '../result.js';
import { resolveRole, isRejection } from '../payments/accounts.js';
import { matchIncomingByQrr } from './qrMatch.js';
import { compactReference } from './pain001.js';
import { rankDebitCandidates, readCamtMatchConfig } from './debitRanking.js';
import type { CamtMatchConfig } from './debitRanking.js';
import { HAS_REVERSAL_SQL, bankLegsOf, claimedLegs, lineBookingDate, signedAmountOf } from './bankLines.js';
import type { BankTxnDetailRow, BankTxnRow, BookBankLineTarget, ClaimedLegs } from './bankLines.js';

export const BANK_PROPOSAL_CERTAINTIES = ['sure', 'learned', 'check', 'open'] as const;
export type BankProposalCertainty = (typeof BANK_PROPOSAL_CERTAINTIES)[number];

export const BANK_PROPOSAL_REASONS = [
  'existing_entry_reference',
  'existing_entry_amount_date',
  'qr_reference_exact',
  'qr_reference_amount_differs',
  'payment_batch_reference',
  'payment_batch_total_differs',
  'payment_batch_item',
  'payment_batch_item_amount_differs',
  'vendor_bill_reference',
  'vendor_bill_amount',
  'own_account_transfer',
  'own_account_transfer_booked',
  'history',
  'no_proposal',
] as const;
export type BankProposalReason = (typeof BANK_PROPOSAL_REASONS)[number];

export type BankProposalParams = Record<string, string | number | boolean | null>;

export type BankLineProposal = {
  target: BookBankLineTarget | null;
  certainty: BankProposalCertainty;
  reasonCode: BankProposalReason;
  reasonParams: BankProposalParams;
  vatCode: string | null;
};

/** The existing-entry window (spec §4.3 (a)): an entry dated within this many days of the line. */
export const EXISTING_ENTRY_WINDOW_DAYS = 10;

interface OwnAccount {
  bankAccountId: string;
  ledgerAccountId: string;
  iban: string;
}

interface HistoryHit {
  accountId: string;
  taxCode: string | null;
  date: string;
}

export interface ProposalContext {
  config: CamtMatchConfig;
  claimed: ClaimedLegs;
  ownAccounts: OwnAccount[];
  history: Map<string, HistoryHit[]>;
  ledgerOf: Map<string, { ledgerAccountId: string; openingEntryId: string | null }>;
}

const LEGAL_FORM_STOPWORDS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'inc', 'the', 'und', 'co', 'kg']);

/** Lowercase, fold diacritics, collapse whitespace: the ONE text form history compares in. */
export function foldText(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The normalised counterparty name history groups by: folded, legal forms dropped, tokens joined. */
export function normalisedName(name: string | null): string | null {
  const folded = foldText(name);
  if (folded.length === 0) return null;
  const tokens = folded.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !LEGAL_FORM_STOPWORDS.has(t));
  return tokens.length === 0 ? null : tokens.join(' ');
}

/** The counterparty key of a line (IBAN, else the normalised name), or null when it has neither. */
export function counterpartyKeyOf(row: BankTxnRow, detail: BankTxnDetailRow | undefined): string | null {
  const iban = detail?.counterparty_iban ?? null;
  if (iban !== null && iban.length > 0) return `iban:${normalizeIban(iban)}`;
  const name = normalisedName(detail?.counterparty_name ?? row.payer_name);
  return name === null ? null : `name:${name}`;
}

/** Build the per-page context once. */
export function proposalContext(ctx: WorkspaceContext): ProposalContext {
  const accounts = ctx.store.db
    .prepare('SELECT id, iban, ledger_account_id, opening_entry_id FROM bank_account WHERE workspace_id = ?')
    .all(ctx.workspaceId) as { id: string; iban: string; ledger_account_id: string; opening_entry_id: string | null }[];
  const ledgerOf = new Map<string, { ledgerAccountId: string; openingEntryId: string | null }>();
  for (const a of accounts) ledgerOf.set(a.id, { ledgerAccountId: a.ledger_account_id, openingEntryId: a.opening_entry_id });
  return {
    config: readCamtMatchConfig(ctx),
    claimed: claimedLegs(ctx),
    ownAccounts: accounts.map((a) => ({ bankAccountId: a.id, ledgerAccountId: a.ledger_account_id, iban: normalizeIban(a.iban) })),
    history: historyIndex(ctx),
    ledgerOf,
  };
}

/**
 * Every live `accounts` booking (and every adopted pre-A39 camt entry A20 created from a line), read off
 * the DECISION's declared `entry_id` (never a link's `target_id`, critic A39R2-1), grouped by the line's
 * counterparty key, newest first, each with the account and VAT code of the booking's
 * largest non-bank, non-VAT leg. Bounded to the most recent 2000 bookings: history is a hint, not an
 * audit.
 */
function historyIndex(ctx: WorkspaceContext): Map<string, HistoryHit[]> {
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id AS txnId, t.payer_name, d2.counterparty_name, d2.counterparty_iban,
              e.id AS entryId, e.date AS date, t.bank_account_id AS bankAccountId
         FROM bank_line_decision d
         JOIN bank_txn t ON t.workspace_id = d.workspace_id AND t.id = d.bank_txn_id
         JOIN journal_entry e ON e.workspace_id = d.workspace_id AND e.id = d.entry_id
         LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id
        WHERE d.workspace_id = ? AND d.superseded_at IS NULL
          AND (d.target_kind = 'accounts' OR (d.target_kind = 'legacy' AND d.state = 'booked' AND e.source = 'camt'))
        ORDER BY e.date DESC, d.rowid DESC
        LIMIT 2000`,
    )
    .all(ctx.workspaceId) as {
    txnId: string;
    payer_name: string | null;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    entryId: string;
    date: string;
    bankAccountId: string;
  }[];
  const vatAccounts = new Set(
    (
      ctx.store.db
        .prepare("SELECT id FROM account WHERE workspace_id = ? AND number IN ('1170', '1171', '2200')")
        .all(ctx.workspaceId) as { id: string }[]
    ).map((r) => r.id),
  );
  const bankLedger = new Map(
    (
      ctx.store.db.prepare('SELECT id, ledger_account_id FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as {
        id: string;
        ledger_account_id: string;
      }[]
    ).map((r) => [r.id, r.ledger_account_id]),
  );
  // Critic A39-9: every booking's legs in ONE read per 500 entries (the index used to query once per
  // booking, up to 2000 queries each time a context was built).
  const controlAccounts = new Set(
    (['receivable', 'payable'] as const)
      .map((role) => resolveRole(ctx, role))
      .filter((r): r is Exclude<ReturnType<typeof resolveRole>, Result> => !isRejection(r))
      .map((r) => r.id),
  );
  const legsByEntry = new Map<string, { accountId: string; taxCode: string | null; amount: number }[]>();
  const entryIds = [...new Set(rows.map((r) => r.entryId))];
  for (let i = 0; i < entryIds.length; i += 500) {
    const chunk = entryIds.slice(i, i + 500);
    const found = ctx.store.db
      .prepare(
        `SELECT entry_id AS entryId, account_id AS accountId, tax_code AS taxCode, debit_minor + credit_minor AS amount
           FROM journal_line WHERE entry_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY entry_id, (debit_minor + credit_minor) DESC, rowid`,
      )
      .all(...chunk) as { entryId: string; accountId: string; taxCode: string | null; amount: number }[];
    for (const l of found) {
      const list = legsByEntry.get(l.entryId) ?? [];
      list.push({ accountId: l.accountId, taxCode: l.taxCode, amount: l.amount });
      legsByEntry.set(l.entryId, list);
    }
  }
  const index = new Map<string, HistoryHit[]>();
  for (const r of rows) {
    const key =
      r.counterparty_iban !== null && r.counterparty_iban.length > 0
        ? `iban:${normalizeIban(r.counterparty_iban)}`
        : (() => {
            const n = normalisedName(r.counterparty_name ?? r.payer_name);
            return n === null ? null : `name:${n}`;
          })();
    if (key === null) continue;
    const bank = bankLedger.get(r.bankAccountId);
    const main = (legsByEntry.get(r.entryId) ?? []).find((l) => l.accountId !== bank && !vatAccounts.has(l.accountId));
    if (main === undefined) continue;
    // Critic A39-11: history never pre-fills a control-account booking (settling is open_item).
    if (controlAccounts.has(main.accountId)) continue;
    const list = index.get(key) ?? [];
    list.push({ accountId: main.accountId, taxCode: main.taxCode, date: r.date });
    index.set(key, list);
  }
  return index;
}

function sameReference(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const x = a.replace(/\s+/g, '').toUpperCase();
  const y = b.replace(/\s+/g, '').toUpperCase();
  return x.length > 0 && x === y;
}

/** Do two ISO dates fall in the same calendar month (the unit `transfer_crosses_period` refuses on)? */
function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));
}

/** (a) an unclaimed entry on the bank ledger account with the line's signed amount, within the window. */
function existingEntryProposal(
  ctx: WorkspaceContext,
  pc: ProposalContext,
  row: BankTxnRow,
  detail: BankTxnDetailRow | undefined,
): BankLineProposal | null {
  const bank = pc.ledgerOf.get(row.bank_account_id);
  if (bank === undefined) return null;
  const date = lineBookingDate(row);
  const signed = signedAmountOf(row);
  const candidates = ctx.store.db
    .prepare(
      `SELECT jl.id AS lineId, jl.entry_id AS entryId, e.date AS date, e.description AS description,
              (jl.debit_minor - jl.credit_minor) AS signed
         FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND jl.account_id = ? AND jl.currency = ?
          AND e.reverses_entry_id IS NULL
          AND e.date BETWEEN date(?, '-${EXISTING_ENTRY_WINDOW_DAYS} days') AND date(?, '+${EXISTING_ENTRY_WINDOW_DAYS} days')
          AND NOT ${HAS_REVERSAL_SQL('e.id', 'e.workspace_id')}
        ORDER BY e.date, jl.rowid`,
    )
    .all(ctx.workspaceId, bank.ledgerAccountId, row.currency, date, date) as {
    lineId: string;
    entryId: string;
    date: string;
    description: string | null;
    signed: number;
  }[];
  // Leg-level (critic A39-1): an entry whose OTHER bank leg another account's line already claims (the
  // far side of an own-account transfer) still offers THIS account's leg.
  const open = candidates.filter((c) => c.signed === signed && c.entryId !== bank.openingEntryId && !pc.claimed.lineIds.has(c.lineId));
  if (open.length === 0) return null;
  open.sort((a, b) => dayDistance(a.date, date) - dayDistance(b.date, date));

  // The TILL payment behind each candidate, and the A18 item behind that payment.
  const paymentOf = ctx.store.db.prepare('SELECT id, reference_value FROM payment WHERE workspace_id = ? AND journal_entry_id = ?');
  const itemOf = ctx.store.db.prepare('SELECT id, batch_id FROM payment_batch_item WHERE workspace_id = ? AND posted_payment_id = ?');
  const facts = open.map((c) => {
    const payment = paymentOf.get(ctx.workspaceId, c.entryId) as { id: string; reference_value: string | null } | undefined;
    const item = payment === undefined ? undefined : (itemOf.get(ctx.workspaceId, payment.id) as { id: string; batch_id: string } | undefined);
    return { candidate: c, payment, item };
  });
  // Critic H1 (lean): a line that names an A18 item by TILL's own EndToEndId is THAT item's payment, never
  // the nearest-dated sibling of the same amount in the same run.
  const e2e = detail?.end_to_end_id ?? null;
  const named =
    e2e !== null
      ? facts.find((f) => f.item !== undefined && compactReference('E', f.item.id) === e2e)
      : facts.find((f) => f.payment !== undefined && sameReference(f.payment.reference_value, row.reference_value));
  const chosen = named ?? facts[0]!;
  const best = chosen.candidate;

  // A reference proves it: a TILL payment on this entry with the line's QR/SCOR reference, or the A18
  // item behind that payment carrying the line's EndToEndId. The run's PmtInfId proves the RUN, so it
  // proves an item only when the line names no EndToEndId and the item is the run's ONE open payment of
  // this amount (critic H1). An own account's IBAN never proves anything (D139: a transfer is never
  // `sure`): it names the reason only.
  let proven = false;
  const { payment, item } = chosen;
  if (item !== undefined && e2e !== null) {
    proven = e2e === compactReference('E', item.id);
  } else if (payment !== undefined && sameReference(payment.reference_value, row.reference_value)) {
    proven = true;
  } else if (item !== undefined && row.batch_pmt_inf_id !== null && row.batch_pmt_inf_id === compactReference('P', item.batch_id)) {
    proven = facts.filter((f) => f.item !== undefined && f.item.batch_id === item.batch_id).length === 1;
  }
  let transfer: OwnAccount | undefined;
  const ownIban = detail?.counterparty_iban ? normalizeIban(detail.counterparty_iban) : null;
  if (!proven && ownIban !== null) {
    const own = pc.ownAccounts.find((a) => a.iban === ownIban && a.bankAccountId !== row.bank_account_id);
    if (own !== undefined) {
      const touches = ctx.store.db
        .prepare('SELECT 1 AS p FROM journal_line WHERE entry_id = ? AND account_id = ? LIMIT 1')
        .get(best.entryId, own.ledgerAccountId);
      if (touches !== undefined) transfer = own;
    }
  }
  if (transfer !== undefined) {
    // Re-critic L3 (lean): side one booked in ANOTHER month refuses `transfer_crosses_period` at the
    // match, so the proposal names that entry and offers nothing to book.
    const crossesMonth = !sameMonth(best.date, date);
    return {
      target: crossesMonth ? null : { kind: 'existing_entry', entryId: best.entryId },
      certainty: 'check',
      reasonCode: 'own_account_transfer_booked',
      reasonParams: {
        otherBankAccountId: transfer.bankAccountId,
        entryId: best.entryId,
        entryDate: best.date,
        daysApart: dayDistance(best.date, date),
        candidates: open.length,
        crossesMonth,
      },
      vatCode: null,
    };
  }
  return {
    target: { kind: 'existing_entry', entryId: best.entryId },
    certainty: proven && row.reversal_ind !== 1 ? 'sure' : 'check',
    reasonCode: proven ? 'existing_entry_reference' : 'existing_entry_amount_date',
    reasonParams: {
      entryId: best.entryId,
      entryDate: best.date,
      description: best.description,
      daysApart: dayDistance(best.date, date),
      candidates: open.length,
    },
    vatCode: null,
  };
}

/**
 * (b) an A18 run on this Bankkonto, in the LINE's currency (spec L6), generated or paid: by an item's
 * EndToEndId (TILL's own `compactReference('E', item.id)`, one payment per camt.053 line "mit Details"),
 * else by the run's PmtInfId (the line is the run total). `sure` on the item's EndToEndId with its amount,
 * or on the PmtInfId with the total. A paid run whose leg another line already accounts for is not
 * proposed again (critic A39-2: the claim set the booking guard reads).
 */
function batchProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  if (row.credit_debit !== 'DBIT') return null;
  const e2e = detail?.end_to_end_id ?? null;
  const pmtInfId = row.batch_pmt_inf_id !== null && row.batch_pmt_inf_id.length > 0 ? row.batch_pmt_inf_id : null;
  if (e2e === null && pmtInfId === null) return null;
  const batches = ctx.store.db
    .prepare(
      `SELECT id, status, ctrl_sum_minor FROM payment_batch
        WHERE workspace_id = ? AND bank_account_id = ? AND status IN ('generated', 'paid')`,
    )
    .all(ctx.workspaceId, row.bank_account_id) as { id: string; status: string; ctrl_sum_minor: number | null }[];
  const ledger = pc.ledgerOf.get(row.bank_account_id);
  const itemsOf = (batchId: string) =>
    ctx.store.db
      .prepare(
        `SELECT i.id AS id, i.amount_minor AS amountMinor, i.currency AS currency, p.journal_entry_id AS entryId
           FROM payment_batch_item i LEFT JOIN payment p ON p.workspace_id = i.workspace_id AND p.id = i.posted_payment_id
          WHERE i.workspace_id = ? AND i.batch_id = ? ORDER BY i.rowid`,
      )
      .all(ctx.workspaceId, batchId) as { id: string; amountMinor: number; currency: string; entryId: string | null }[];
  const takenBy = (entryIds: (string | null)[]): boolean =>
    ledger !== undefined && bankLegsOf(ctx, ledger.ledgerAccountId, entryIds).some((l) => pc.claimed.lineIds.has(l.lineId));
  for (const b of batches) {
    const items = itemsOf(b.id);
    if (items.length === 0 || items[0]!.currency !== row.currency) continue;
    const item = e2e === null ? undefined : items.find((i) => compactReference('E', i.id) === e2e);
    if (item !== undefined) {
      if (b.status === 'paid' && takenBy([item.entryId])) continue;
      const exact = item.amountMinor === row.amount_minor;
      // Critic M5 (lean): a differing amount always refuses `amount_mismatch` through `payment_batch`, so
      // the proposal names the run and carries no target to book; the reason says the way out.
      return {
        target: exact ? { kind: 'payment_batch', batchId: b.id } : null,
        certainty: exact && row.reversal_ind !== 1 ? 'sure' : 'check',
        reasonCode: exact ? 'payment_batch_item' : 'payment_batch_item_amount_differs',
        reasonParams: { batchId: b.id, batchStatus: b.status, itemId: item.id, itemAmountMinor: item.amountMinor, lineAmountMinor: row.amount_minor },
        vatCode: null,
      };
    }
    if (pmtInfId === null || compactReference('P', b.id) !== pmtInfId) continue;
    if (b.status === 'paid' && takenBy(items.map((i) => i.entryId))) continue;
    const total = b.ctrl_sum_minor ?? items.reduce((sum, i) => sum + i.amountMinor, 0);
    const totalMatches = total === row.amount_minor;
    return {
      target: totalMatches ? { kind: 'payment_batch', batchId: b.id } : null,
      certainty: totalMatches && row.reversal_ind !== 1 ? 'sure' : 'check',
      reasonCode: totalMatches ? 'payment_batch_reference' : 'payment_batch_total_differs',
      reasonParams: { batchId: b.id, batchStatus: b.status, batchTotalMinor: total, lineAmountMinor: row.amount_minor },
      vatCode: null,
    };
  }
  return null;
}

/** (b) the A21 QR score of a credit. */
function qrProposal(ctx: WorkspaceContext, row: BankTxnRow): BankLineProposal | null {
  if (row.credit_debit !== 'CRDT') return null;
  const scored = matchIncomingByQrr(ctx, {
    reference: row.reference_value,
    amountMinor: row.amount_minor,
    currency: row.currency,
  });
  if (!scored.ok || scored.match.invoiceId === null || scored.match.confidence === 'none') return null;
  const m = scored.match;
  const exact = m.confidence === 'high';
  return {
    target: { kind: 'open_item', documentId: m.invoiceId as string },
    certainty: exact && row.reversal_ind !== 1 ? 'sure' : 'check',
    reasonCode: exact ? 'qr_reference_exact' : 'qr_reference_amount_differs',
    reasonParams: {
      documentId: m.invoiceId,
      documentNumber: m.invoiceNumber,
      contactName: m.contactName,
      openMinor: m.invoiceOpenMinor,
      dunningFeeMinor: m.dunningFeeMinor,
      totalDueMinor: m.totalDueMinor,
      deltaMinor: m.deltaMinor,
      scoreReason: m.reason,
    },
    vatCode: null,
  };
}

/** The shortest supplier reference that can prove a bill on its own (critic L12 lean). */
const MIN_PROVING_REFERENCE = 6;

/**
 * Does the line quote the bill's reference WHOLE: at least `MIN_PROVING_REFERENCE` characters, bounded
 * on both sides by a non-alphanumeric character (or the text's end) in the line's reference, remittance
 * or EndToEndId? A36's ranking signal is a substring of 3 characters, which ranks but proves nothing.
 */
function quotesWholeReference(ctx: WorkspaceContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined, billId: string): boolean {
  const bill = ctx.store.db
    .prepare('SELECT vendor_reference AS ref FROM vendor_bill WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, billId) as { ref: string | null } | undefined;
  const ref = (bill?.ref ?? '').trim().toLowerCase();
  if (ref.length < MIN_PROVING_REFERENCE) return false;
  const text = [row.reference_value, detail?.remittance_text, detail?.end_to_end_id, row.entry_ref]
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .toLowerCase();
  for (let at = text.indexOf(ref); at !== -1; at = text.indexOf(ref, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]!;
    const after = text[at + ref.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

/** (b) the A36 vendor-bill ranking of a debit: `sure` only when the line quotes the bill's reference whole. */
function vendorBillProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  if (row.credit_debit !== 'DBIT') return null;
  const ranked = rankDebitCandidates(ctx, row, pc.config);
  if (ranked === null || ranked.kind !== 'vendor_bill') return null;
  const byReference = (ranked.signals ?? []).includes('reference');
  const proven = byReference && ranked.confidence === 'high' && quotesWholeReference(ctx, row, detail, ranked.targetId);
  return {
    target: { kind: 'open_item', documentId: ranked.targetId },
    certainty: proven && row.reversal_ind !== 1 ? 'sure' : 'check',
    reasonCode: byReference ? 'vendor_bill_reference' : 'vendor_bill_amount',
    reasonParams: { documentId: ranked.targetId, confidence: ranked.confidence, signals: (ranked.signals ?? []).join(',') },
    vatCode: null,
  };
}

/**
 * (c) the counterparty IBAN is one of our own Bankkonten: a transfer to its ledger account, ALWAYS
 * `check` (D139: nothing moves between own accounts unattended). NEVER a new transfer while one is
 * already on the books (critic A39-1): an unclaimed leg on THIS account's ledger with the line's signed
 * amount, in an entry that also books the other own account, is the transfer the other side already
 * booked, whatever its date; this rung proposes matching it (`own_account_transfer_booked`).
 */
function ownAccountProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  const iban = detail?.counterparty_iban ? normalizeIban(detail.counterparty_iban) : null;
  if (iban === null) return null;
  const own = pc.ownAccounts.find((a) => a.iban === iban && a.bankAccountId !== row.bank_account_id);
  if (own === undefined) return null;
  const mine = pc.ledgerOf.get(row.bank_account_id);
  if (mine !== undefined) {
    const booked = ctx.store.db
      .prepare(
        `SELECT jl.id AS lineId, jl.entry_id AS entryId, e.date AS date
           FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND jl.account_id = ? AND jl.currency = ?
            AND (jl.debit_minor - jl.credit_minor) = ? AND e.reverses_entry_id IS NULL
            AND EXISTS (SELECT 1 FROM journal_line o WHERE o.entry_id = e.id AND o.account_id = ?)
            AND NOT ${HAS_REVERSAL_SQL('e.id', 'e.workspace_id')}
          ORDER BY abs(julianday(e.date) - julianday(?)), jl.rowid`,
      )
      .all(ctx.workspaceId, mine.ledgerAccountId, row.currency, signedAmountOf(row), own.ledgerAccountId, lineBookingDate(row)) as {
      lineId: string;
      entryId: string;
      date: string;
    }[];
    const free = booked.filter((b) => !pc.claimed.lineIds.has(b.lineId) && b.entryId !== mine.openingEntryId);
    if (free.length > 0) {
      const best = free[0]!;
      const crossesMonth = !sameMonth(best.date, lineBookingDate(row));
      return {
        target: crossesMonth ? null : { kind: 'existing_entry', entryId: best.entryId },
        certainty: 'check',
        reasonCode: 'own_account_transfer_booked',
        reasonParams: {
          otherBankAccountId: own.bankAccountId,
          entryId: best.entryId,
          entryDate: best.date,
          daysApart: dayDistance(best.date, lineBookingDate(row)),
          candidates: free.length,
          crossesMonth,
        },
        vatCode: null,
      };
    }
  }
  // D139 (replacing A39R2-2's `sure` on the money-leaving side): both sides read `check`, so "Alle
  // sicheren buchen" never posts a transfer; a person confirms side one, side two then matches it.
  return {
    target: { kind: 'accounts', legs: [{ accountId: own.ledgerAccountId, amountMinor: row.amount_minor }] },
    certainty: 'check',
    reasonCode: 'own_account_transfer',
    reasonParams: { otherBankAccountId: own.bankAccountId, accountId: own.ledgerAccountId },
    vatCode: null,
  };
}

/** Every rung in order; the first that speaks is the proposal. */
export function proposeForLine(
  ctx: WorkspaceContext,
  pc: ProposalContext,
  row: BankTxnRow,
  detail: BankTxnDetailRow | undefined,
): BankLineProposal {
  const reversalCap = (p: BankLineProposal): BankLineProposal =>
    row.reversal_ind === 1 && p.certainty === 'sure' ? { ...p, certainty: 'check' } : p;

  const a = existingEntryProposal(ctx, pc, row, detail);
  if (a !== null) return reversalCap(a);
  const b = batchProposal(ctx, pc, row, detail) ?? qrProposal(ctx, row) ?? vendorBillProposal(ctx, pc, row, detail);
  if (b !== null) return reversalCap(b);
  const c = ownAccountProposal(ctx, pc, row, detail);
  if (c !== null) return reversalCap(c);

  const key = counterpartyKeyOf(row, detail);
  const hits = key === null ? undefined : pc.history.get(key);
  if (hits !== undefined && hits.length > 0) {
    const last = hits[0]!;
    const count = hits.filter((h) => h.accountId === last.accountId && h.taxCode === last.taxCode).length;
    return {
      target: {
        kind: 'accounts',
        legs: [{ accountId: last.accountId, amountMinor: row.amount_minor, ...(last.taxCode !== null ? { taxCode: last.taxCode } : {}) }],
      },
      certainty: 'learned',
      reasonCode: 'history',
      reasonParams: { accountId: last.accountId, taxCode: last.taxCode, count, lastDate: last.date },
      vatCode: last.taxCode,
    };
  }

  return { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null };
}
