/**
 * D178 E3, the owner's decision of 21.10.2026: VAT on a RECEIVED customer Anzahlung (MWSTG Art. 40: under
 * agreed consideration the tax on an advance payment arises when it is collected), behind the setting
 * `bank.anzahlung_vat` (default OFF: the VAT arises with the invoice, as before).
 *
 * WHEN ON. A `contact` booking of money IN from a CUSTOMER books the Umsatzsteuer on receipt with the code
 * of `bank.anzahlung_vat_code` (default `UST81`, the normal rate), priced on the base-currency gross on the
 * line's date, as a pair on 1300 Aktive Rechnungsabgrenzung: debit 1300 gross, credit 1300 net (the base
 * line carrying the trace, A06's convention) and credit 2200 the tax. The customer's balance is untouched
 * (the Guthaben stays gross on 1100, A16's OP-Liste and its reconciliation to 1100 unchanged); 1300 holds
 * the tax paid ahead until the invoice carries it.
 *
 * CLEARED ON APPLICATION. The invoice books its own full Umsatzsteuer. So when A14's `allocate_payment`
 * applies the Guthaben to an invoice, the share of the receipt VAT that the applied cash carries is
 * reversed (`clearAnzahlungVatOnAllocation`, the mirrored pair: debit 2200, credit 1300, the trace
 * negated), dated the day of the application, at the RECEIPT's rate and code. Across a quarter boundary:
 * the receipt quarter declares the Anzahlung's base and tax, the invoice quarter declares the invoice and
 * the clearing, which net to zero. Each clearing is on record (`bank_anzahlung_vat_clearing`), and
 * `reopen_bank_line` reverses the clearings and the receipt VAT with the payment.
 *
 * With the Anzahlungen account (mode `anzahlung`) there is no application step in TILL (the
 * reclassification to 1100 is a manual entry), so the receipt VAT is booked the same way and the answer
 * warns `anzahlung_vat_clears_on_reclassification`: that manual entry must reverse it.
 *
 * A leaf module: it imports neither the payments nor the banking barrels, so A14's `allocatePayment` can
 * call it without a cycle (the `reimbursementReversal.ts` precedent).
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { buildVatLines, mirrorVatLine } from '../vat/applyVat.js';
import { getSetting } from '../settings/settings.js';

/** The account the tax paid ahead on a received Anzahlung waits on until the invoice carries it. */
export const ANZAHLUNG_VAT_ACCOUNT = '1300';

/** The receipt VAT of one booking: the code, the account and the lines (debit 1300 gross, credit net and tax). */
export interface AnzahlungVatPlan {
  taxCode: string;
  accountId: string;
  grossMinor: number;
  lines: LineInput[];
}

/** The pair on the VAT account for `grossMinor` in the base currency, priced at `supplyDate`. */
function vatPair(ctx: WorkspaceContext, accountId: string, grossMinor: number, taxCode: string, supplyDate: string): LineInput[] | Err {
  try {
    const lines = buildVatLines(ctx, {
      counterAccount: accountId,
      revenueOrExpenseAccount: accountId,
      amountMinor: grossMinor,
      amountIsGross: true,
      taxCode,
      direction: 'output',
      supplyDate,
    }) as LineInput[];
    return lines.map((l) => (l.taxCode !== undefined ? { ...l, supplyDate } : l));
  } catch (e) {
    return err('vat_lines_refused', { field: 'bank.anzahlung_vat_code', taxCode, reason: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The receipt VAT a `contact` booking owes, or null when the setting is off or the booking is not money in
 * from a customer. Refuses `invalid_anzahlung_vat_code` (the configured code is missing, archived or not an
 * output code) and `needs_account` (no 1300 in the chart).
 */
export function planAnzahlungVat(
  ctx: WorkspaceContext,
  input: { counterpartyKind: 'customer' | 'supplier'; moneyIn: boolean; grossBaseMinor: number; date: string },
): { vat: AnzahlungVatPlan | null } | { error: Err } {
  if (getSetting<boolean>(ctx, 'bank.anzahlung_vat') !== true) return { vat: null };
  if (input.counterpartyKind !== 'customer' || !input.moneyIn) return { vat: null };
  const taxCode = getSetting<string>(ctx, 'bank.anzahlung_vat_code').trim();
  const code = ctx.store.db
    .prepare('SELECT kind, active FROM tax_code WHERE workspace_id = ? AND code = ?')
    .get(ctx.workspaceId, taxCode) as { kind: string; active: number } | undefined;
  if (code === undefined || code.active !== 1 || code.kind !== 'output') {
    return {
      error: err('invalid_anzahlung_vat_code', {
        settingKey: 'bank.anzahlung_vat_code',
        taxCode,
        reason: code === undefined ? 'missing' : code.active !== 1 ? 'archived' : 'not_an_output_code',
        sentence: {
          en: 'The VAT code for prepayments is not an active output code. Name one in the settings, or turn VAT on prepayments off.',
          'de-CH': 'Der MWST-Code für Anzahlungen ist kein aktiver Umsatzsteuer-Code. Wähle einen in den Einstellungen oder schalte die MWST auf Anzahlungen aus.',
        },
      }),
    };
  }
  const account = ctx.store.db
    .prepare('SELECT id, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, ANZAHLUNG_VAT_ACCOUNT) as { id: string; archived: number } | undefined;
  if (account === undefined || account.archived === 1) {
    return { error: err('needs_account', { role: 'anzahlung_vat', number: ANZAHLUNG_VAT_ACCOUNT, reason: account === undefined ? 'missing' : 'archived' }) };
  }
  const lines = vatPair(ctx, account.id, input.grossBaseMinor, taxCode, input.date);
  if (!Array.isArray(lines)) return { error: lines };
  return { vat: { taxCode, accountId: account.id, grossMinor: input.grossBaseMinor, lines } };
}

/** The receipt VAT entry a payment's live contact decision names, with its code, date and gross, or null. */
function receiptVatOf(ctx: WorkspaceContext, paymentId: string): { entryId: string; taxCode: string; supplyDate: string; accountId: string; grossMinor: number } | null {
  const row = ctx.store.db
    .prepare(
      `SELECT d.entry_id AS entryId, e.date AS date FROM bank_line_decision d
         JOIN journal_entry e ON e.id = d.entry_id AND e.workspace_id = d.workspace_id
        WHERE d.workspace_id = ? AND d.payment_id = ? AND d.target_kind = 'contact' AND d.superseded_at IS NULL
          AND e.source = 'camt' AND e.status = 'posted'`,
    )
    .get(ctx.workspaceId, paymentId) as { entryId: string; date: string } | undefined;
  if (row === undefined) return null;
  const base = ctx.store.db
    .prepare(
      `SELECT l.account_id AS accountId, l.tax_code AS taxCode, l.supply_date AS supplyDate FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ? AND a.number = ? AND l.tax_code IS NOT NULL LIMIT 1`,
    )
    .get(row.entryId, ctx.workspaceId, ANZAHLUNG_VAT_ACCOUNT) as { accountId: string; taxCode: string; supplyDate: string | null } | undefined;
  if (base === undefined) return null;
  const gross = ctx.store.db
    .prepare('SELECT COALESCE(SUM(debit_minor), 0) AS g FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(row.entryId, base.accountId) as { g: number };
  return { entryId: row.entryId, taxCode: base.taxCode, supplyDate: base.supplyDate ?? row.date, accountId: base.accountId, grossMinor: gross.g };
}

/**
 * SQL: the clearing `c` still stands (security review: a clearing whose entry has a posted reversal no
 * longer clears anything, so it counts neither as cleared cash nor as an earlier clearing to re-book).
 */
const LIVE_CLEARING = (c: string): string =>
  `NOT EXISTS (SELECT 1 FROM journal_entry rv WHERE rv.workspace_id = ${c}.workspace_id AND rv.reverses_entry_id = ${c}.entry_id AND rv.status = 'posted')`;

/** The cash a payment's receipt VAT has already been cleared for (applications and refunds), from the record. */
function clearedCashOf(ctx: WorkspaceContext, paymentId: string): number {
  return (
    ctx.store.db
      .prepare(`SELECT COALESCE(SUM(c.applied_minor), 0) AS n FROM bank_anzahlung_vat_clearing c
                 WHERE c.workspace_id = ? AND c.payment_id = ? AND ${LIVE_CLEARING('c')}`)
      .get(ctx.workspaceId, paymentId) as { n: number }
  ).n;
}

/** The VAT lines of a posted entry on the VAT-on-Anzahlung account and 2200, as plain lines to post again. */
function vatLinesOf(ctx: WorkspaceContext, entryId: string, accountId: string): LineInput[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT l.account_id AS account, l.debit_minor AS debit, l.credit_minor AS credit, l.tax_code AS taxCode, l.supply_date AS supplyDate
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ? AND (l.account_id = ? OR a.number = '2200') ORDER BY l.rowid`,
    )
    .all(entryId, ctx.workspaceId, accountId) as { account: string; debit: number; credit: number; taxCode: string | null; supplyDate: string | null }[];
  return rows.map((r) => ({
    account: r.account,
    ...(r.debit > 0 ? { debit: r.debit } : {}),
    ...(r.credit > 0 ? { credit: r.credit } : {}),
    ...(r.taxCode !== null ? { taxCode: r.taxCode } : {}),
    ...(r.taxCode !== null && r.supplyDate !== null ? { supplyDate: r.supplyDate } : {}),
  }));
}

export type AnzahlungVatClearingKind = 'application' | 'refund';

/**
 * Clear the share of a Guthaben's receipt VAT that `cashMinor` more of it carries: applied to an invoice
 * (`application`, from A14's `allocate_payment`) or handed back to the customer (`refund`, an
 * Entgeltsminderung, from a refund booked on a bank line). Inside the caller's transaction; answers a
 * refusal (the caller aborts and nothing commits), or the clearing entry's id, or null when the payment
 * carries no receipt VAT.
 *
 * EXACT TO THE RAPPEN (critic E3-R2-3). The share is taken on the CUMULATIVE cash (what earlier clearings
 * covered is on record, `applied_minor`). An intermediate clearing is the canonical pair for its gross
 * share, so every tagged line passes A02's gate. The clearing that covers the LAST of the Guthaben does not
 * re-derive a tax: it posts the exact mirror of the receipt pair and re-books every earlier clearing pair in
 * the receipt's direction, so it nets to exactly what is left (each line still canonical) and the clearings
 * add up to the receipt's base and tax.
 */
export function clearAnzahlungVat(
  ctx: WorkspaceContext,
  payment: { id: string; amountMinor: number },
  cashMinor: number,
  opts: { kind: AnzahlungVatClearingKind; date?: string; linkId?: string | null },
): { entryId: string | null } | { error: Err } {
  if (cashMinor <= 0 || payment.amountMinor <= 0) return { entryId: null };
  const receipt = receiptVatOf(ctx, payment.id);
  if (receipt === null) return { entryId: null };
  const before = Math.min(clearedCashOf(ctx, payment.id), payment.amountMinor);
  const after = Math.min(before + cashMinor, payment.amountMinor);
  if (after <= before) return { entryId: null };
  const share = (cash: number) => Math.round((receipt.grossMinor * cash) / payment.amountMinor);
  const grossMinor = share(after) - share(before);
  let lines: LineInput[];
  if (after === payment.amountMinor) {
    const earlier = (
      ctx.store.db
        .prepare(`SELECT c.entry_id AS e FROM bank_anzahlung_vat_clearing c WHERE c.workspace_id = ? AND c.payment_id = ? AND ${LIVE_CLEARING('c')} ORDER BY c.rowid`)
        .all(ctx.workspaceId, payment.id) as { e: string }[]
    ).map((r) => r.e);
    lines = [
      ...vatLinesOf(ctx, receipt.entryId, receipt.accountId).map((l) => mirrorVatLine(l)),
      ...earlier.flatMap((e) => vatLinesOf(ctx, e, receipt.accountId).map((l) => mirrorVatLine(l))),
    ];
  } else {
    if (grossMinor <= 0) return { entryId: null };
    const pair = vatPair(ctx, receipt.accountId, grossMinor, receipt.taxCode, receipt.supplyDate);
    if (!Array.isArray(pair)) return { error: pair };
    lines = pair.map((l) => mirrorVatLine(l));
  }
  const posted = postEntry(ctx, {
    date: opts.date ?? ctx.clock.now().slice(0, 10),
    source: 'camt',
    description:
      opts.kind === 'refund'
        ? 'Anzahlung zurückbezahlt: MWST auf Anzahlung korrigiert (Entgeltsminderung)'
        : 'Anzahlung angerechnet: MWST auf Anzahlung zurückgebucht',
    // MINTED: the clearing is identified by its record row, never by a key a caller could derive.
    idempotencyKey: `anzahlung-vat-clear-${payment.id}-${ctx.ids.next('avc')}`,
    lines,
  });
  if (!posted.ok) return { error: posted };
  ctx.store.db
    .prepare(
      `INSERT INTO bank_anzahlung_vat_clearing
         (entry_id, workspace_id, payment_id, receipt_entry_id, gross_minor, applied_minor, kind, link_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(posted.entryId, ctx.workspaceId, payment.id, receipt.entryId, grossMinor, after - before, opts.kind, opts.linkId ?? null, ctx.actor, ctx.clock.now());
  return { entryId: posted.entryId };
}

/** A14's hook: the receipt VAT share of `cashMinor` newly applied to invoices. Null, or a refusal. */
export function clearAnzahlungVatOnAllocation(ctx: WorkspaceContext, payment: { id: string; amountMinor: number }, cashMinor: number): Err | null {
  const done = clearAnzahlungVat(ctx, payment, cashMinor, { kind: 'application' });
  return 'error' in done ? done.error : null;
}

/**
 * Owner, 21.10.2026: a customer's Guthaben that carry receipt VAT and cash not yet cleared (applied or
 * refunded), oldest first: what a refund to that customer hands back first. Pure read.
 */
export function refundableVatGuthabenOf(ctx: WorkspaceContext, contactId: string): { paymentId: string; amountMinor: number; openMinor: number }[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT p.id AS paymentId, p.amount_minor AS amountMinor FROM bank_line_decision d
         JOIN payment p ON p.workspace_id = d.workspace_id AND p.id = d.payment_id
        WHERE d.workspace_id = ? AND d.contact_id = ? AND d.target_kind = 'contact' AND d.superseded_at IS NULL
          AND p.status = 'posted' AND p.direction = 'incoming'
        ORDER BY d.created_at, d.rowid`,
    )
    .all(ctx.workspaceId, contactId) as { paymentId: string; amountMinor: number }[];
  return rows
    .filter((r) => receiptVatOf(ctx, r.paymentId) !== null)
    .map((r) => {
      // Security review: a refund can only hand back cash the Guthaben still holds. Capped by A14's own
      // unallocated rest of THIS payment (what was applied to invoices is gone) and by what earlier
      // clearings (applications, refunds) have not already covered.
      const allocated = (
        ctx.store.db
          .prepare('SELECT COALESCE(SUM(payment_amount_minor), 0) AS n FROM payment_allocation WHERE workspace_id = ? AND payment_id = ?')
          .get(ctx.workspaceId, r.paymentId) as { n: number }
      ).n;
      // What earlier refunds already handed back from this Guthaben is spent too (a live refund clearing
      // records the cash it netted against this payment), so a second refund cannot hand it back again.
      const refunded = (
        ctx.store.db
          .prepare(`SELECT COALESCE(SUM(c.applied_minor), 0) AS n FROM bank_anzahlung_vat_clearing c
                     WHERE c.workspace_id = ? AND c.payment_id = ? AND c.kind = 'refund' AND ${LIVE_CLEARING('c')}`)
          .get(ctx.workspaceId, r.paymentId) as { n: number }
      ).n;
      const unallocated = Math.max(0, r.amountMinor - allocated - refunded);
      const uncleared = r.amountMinor - Math.min(clearedCashOf(ctx, r.paymentId), r.amountMinor);
      return { ...r, openMinor: Math.min(unallocated, uncleared) };
    })
    .filter((r) => r.openMinor > 0);
}

/** The clearing entries recorded against a payment, oldest first (for `reopen_bank_line` to reverse). */
export function anzahlungVatClearingsOf(ctx: WorkspaceContext, paymentId: string): string[] {
  return (
    ctx.store.db
      .prepare('SELECT entry_id AS e FROM bank_anzahlung_vat_clearing WHERE workspace_id = ? AND payment_id = ? ORDER BY rowid')
      .all(ctx.workspaceId, paymentId) as { e: string }[]
  ).map((r) => r.e);
}

/** The refund corrections a refund line's decision posted (for its own `reopen_bank_line`). */
export function anzahlungVatCorrectionsOfLink(ctx: WorkspaceContext, linkId: string): string[] {
  return (
    ctx.store.db
      .prepare("SELECT entry_id AS e FROM bank_anzahlung_vat_clearing WHERE workspace_id = ? AND link_id = ? AND kind = 'refund' ORDER BY rowid")
      .all(ctx.workspaceId, linkId) as { e: string }[]
  ).map((r) => r.e);
}
