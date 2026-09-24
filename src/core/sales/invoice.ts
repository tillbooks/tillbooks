/**
 * A11, invoice: the invoice-scoped half of the A10 document lifecycle.
 *
 * A10 owns the state machine, the gap-free numbering, and the transition/idempotency machinery. A11
 * plugs into A10's poster seam (`registerDocumentPoster('invoice', ...)`, done in `index.ts`) and adds
 * the three genuinely invoice-shaped concerns:
 *
 *  - `buildInvoicePosting` (the A10 `onIssue` delegate, Pattern P3): the ONE place invoicing posts.
 *    It composes A06's `buildVatLines` per position into a single balanced entry (gross Debitoren
 *    1100 / net revenue per item account / output VAT 2200) and posts it through A02 `postEntry`, the
 *    single posting path. It never re-checks the balance (A02's §H-LEDGER owns that) and never opens a
 *    second posting path. `onCancel` reverses via A02 (§H-AUDIT), never deletes.
 *  - `buildQrBill` (qrbill.ts does the statutory encoding): resolves the workspace creditor + customer
 *    into a Swiss QR Code payload, choosing QRR (QR-IBAN) or SCOR (plain IBAN), D31 eBill/Swico
 *    emitted.
 *  - `renderInvoicePdf` + `sendInvoice`: the PDF artifact and the email channel (OP4).
 *
 * `issueInvoice`/`sendInvoice` are thin invoice wrappers over A10's `transitionDocument`; there is no
 * `createInvoice`/`getInvoice` MCP tool (D14): create/read/list ride A10's generic document verbs.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry, statesConversionBasis } from '../ledger/postEntry.js';
import { resolveFxRate, baseCurrencyOf } from '../fx/rates.js';
import { allocateBase, RATE_ONE } from '../fx/rateMath.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { buildVatLines, computeLineTax } from '../vat/applyVat.js';
import { transitionDocument, getDocument, assertTransition } from './document.js';
import type { DocumentRow, DocumentPoster, DocumentStatus } from './document.js';
import { isValidIban, isQrIban } from '../setup/iban.js';
import {
  buildQrBillPayload,
  validateQrBill,
  buildQrrReference,
  buildScorReference,
  isQrCurrency,
  buildSwicoS1,
  bpToPercentString,
  formatQrAmount,
} from './qrbill.js';
import type { BuildQrBillInput, QrStructuredAddress, QrReferenceType } from './qrbill.js';
import {
  renderSwissQrCodePdfOps,
  swissQrGraphicSizePt,
  buildSwissQrCodeGraphic,
  SwissQrPayloadTooLongError,
  PT_PER_MM,
} from './swiss-qr-graphic.js';
// G05: the template seam. Layout-only (footer lines in the resolved locale); it never sees the QR
// payload, and the byte-identity of the payload under any template is asserted by test.
import { resolveRenderTemplate } from '../customization/documentTemplates.js';
import { recordDispatch } from '../customization/dispatch.js';

/**
 * The date from which the Swiss QR-bill's QR-IBAN and QR reference (QRR) are CHF-only.
 *
 * SIX Swiss Implementation Guidelines for the QR-bill **v2.4**, cover page: "Version 2.4, valid from
 * 14 November 2026" (verified against ig-qr-bill-v2.4-en.pdf on six-group.com, 2026-07-25). The rule
 * itself appears four times in that document: ch. 2.10 on the QR-IBAN, "It can only be used for
 * invoicing and payments in CHF"; ch. 4.3.2 on the QR reference, "It can only be used for invoicing
 * in CHF"; the QRCH+RmtInf++Ref data element, "May only be used for invoices in CHF"; and the change
 * note for EUR invoicing, "only the combination IBAN/SCOR reference and IBAN/unstructured message is
 * possible".
 *
 * Two qualifications, both from the same document and both deliberately NOT flattened away here:
 * v2.3 remains valid until November 2027, so this is an overlapping window rather than a flag day;
 * and SIX says nothing at all about what a creditor holding only a QR-IBAN should do for a EUR bill
 * after the cutover. TILL therefore refuses the QR-BILL (never the invoice, never the posting) and
 * names the remedy, rather than emitting a payment part that a v2.4 bank will reject.
 */
export const QR_IBAN_CHF_ONLY_FROM = '2026-11-14';

/** The currency the Swiss QR-bill's QR-IBAN / QR reference is restricted to from the cutover. */
const QR_REFERENCE_CURRENCY = 'CHF';

/** The KMU chart accounts A11 books against (spec §2/US-A11.1). */
const DEBTOR_ACCOUNT = '1100';
const DEFAULT_REVENUE_ACCOUNT = '3200';

interface DocumentLineRow {
  id: string;
  document_id: string;
  position: number;
  item_id: string | null;
  description: string | null;
  quantity_milli: number;
  unit_price_minor: number;
  line_total_minor: number;
  tax_code: string | null;
  supply_date: string | null;
}

interface WorkspaceQrRow {
  creditor_name: string | null;
  creditor_address: string | null;
  creditor_iban: string | null;
  mwst_no: string | null;
  base_currency: string;
}

interface ContactRow {
  name: string;
  address_street: string | null;
  address_house_no: string | null;
  address_zip: string | null;
  address_city: string | null;
  address_country: string | null;
  email: string | null;
}

export function accountByNumber(ctx: WorkspaceContext, number: string): string | undefined {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as { id: string } | undefined;
  return row?.id;
}

function readLines(ctx: WorkspaceContext, documentId: string): DocumentLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM document_line WHERE document_id = ? ORDER BY position')
    .all(documentId) as DocumentLineRow[];
}

/** The revenue account for a position: the item's own account, else the default merchandise account.
 *  EXPORTED (A13): the credit note's mirror books the SAME account the invoice's poster resolves,
 *  through the same route, so the pair nets on the account the sale was booked to. */
export function revenueAccountFor(ctx: WorkspaceContext, line: { item_id: string | null }): string | undefined {
  if (line.item_id !== null) {
    const row = ctx.store.db
      .prepare('SELECT revenue_account_id FROM item WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, line.item_id) as { revenue_account_id: string | null } | undefined;
    if (row?.revenue_account_id != null) return row.revenue_account_id;
  }
  return accountByNumber(ctx, DEFAULT_REVENUE_ACCOUNT);
}

/** `quantity_milli * unit_price_minor / 1000`, rounded half away from zero (matches A10's lineTotal). */
function lineGross(line: DocumentLineRow): number {
  const scaled = line.quantity_milli * line.unit_price_minor;
  return scaled < 0 ? -Math.round(-scaled / 1000) : Math.round(scaled / 1000);
}

/**
 * The A10 `onIssue` poster delegate (Pattern P3): build the balanced VAT-traced entry for an issued
 * invoice and post it through A02 `postEntry`. Runs INSIDE the transition A10 opened, so numbering and
 * posting commit or roll back together. Returns `ok({ postedEntryId })` or a structured P9 rejection
 * (which aborts the whole transition: no number consumed, §H-PERIOD honoured by postEntry itself).
 *
 * Composition: each position is expanded by A06's `buildVatLines` (direction 'output', counter = 1100
 * Debitoren, revenue = the item's account) into its own balanced triple (debtor gross / revenue net +
 * trace / output VAT 2200). Concatenated, the whole entry balances line-by-line, carries one
 * §H-VAT-TRACE per revenue leg, and A02's own §H-LEDGER check owns the final Sigma-debit==Sigma-credit
 * assertion (A11 does not re-check it).
 */
export function buildInvoicePosting(ctx: WorkspaceContext, doc: DocumentRow): Result {
  const lines = readLines(ctx, doc.id);
  if (lines.length === 0) return err('needs_lines', { documentId: doc.id });

  const debtor = accountByNumber(ctx, DEBTOR_ACCOUNT);
  if (debtor === undefined) return err('missing_account', { account: DEBTOR_ACCOUNT });

  const entryDate = ctx.clock.now().slice(0, 10);

  // §H-FX / US-A11.3. A non-CHF invoice posts in base CHF at the rate that governs the INVOICE DATE,
  // which is this same `entryDate` (A10 stamps `issue_date` from it in the same transaction).
  //
  // That date is not a convenience. MWSTV Art. 45 Abs. 1 (SR 641.201) requires conversion "im
  // Zeitpunkt der Entstehung der Steuerforderung", and MWSTG Art. 40 puts that moment, for a
  // taxpayer accounting nach vereinbarten Entgelten, at the Rechnungsstellung. So the sales side
  // converts at the invoice date, full stop; the purchase side (A17) will convert at the date the
  // invoice was RECEIVED, which is a different date for the same transaction, by design.
  //
  // The rate itself is resolved by A19's store, never invented here. No admissible rate means the
  // whole issue aborts (no number consumed, no entry, no totals rewritten), and the rejection names
  // the pair, the date and the verb that fixes it. This is a configuration state a user can clear in
  // one call, NOT the permanent floor this branch used to describe.
  const workspaceBase = baseCurrencyOf(ctx);
  const resolution = resolveFxRate(ctx, { currency: doc.currency, date: entryDate });
  if (!resolution.ok) return resolution;
  const fx = resolution.resolved;

  const journalLines: {
    account: string;
    debit?: number;
    credit?: number;
    costCenter?: string;
    taxCode?: string;
    taxBase?: number;
    taxAmount?: number;
    supplyDate?: string;
  }[] = [];

  // B-1: the QR-bill and the PDF read `document.total_minor`, and the books post GROSS to 1100, so
  // the two must be the SAME figure. The per-line net and gross are accumulated here (the gross is
  // the debtor leg buildVatLines just built) and persisted below, inside the issue transaction.
  let subtotalMinor = 0;
  let taxMinor = 0;

  for (const line of lines) {
    const revenue = revenueAccountFor(ctx, line);
    if (revenue === undefined) return err('missing_account', { account: DEFAULT_REVENUE_ACCOUNT });
    try {
      const netMinor = lineGross(line);
      // A11 prices with `supply_date ?? null`, which falls back to the code's STORED rate; A02's
      // `reconcileAndStampVat` re-prices the same leg with `supplyDate ?? input.date`, which resolves
      // the rate from the ENTRY DATE's era (F2). For every seeded code the two agree, because the
      // stored rate IS the current era's rate. For a workspace-defined HISTORIC code with no
      // Leistungsdatum they disagree, and the invoice died on A02's `vat_trace_unreconciled`, an
      // error naming account 2200 and two Rappen figures: fail-closed but unactionable.
      //
      // The disagreement is a genuine ambiguity, not a bug to paper over. Pricing at the code's rate
      // ignores the entry date that F2 says governs; pricing at the entry date's rate overrides the
      // rate the operator picked the code FOR. Only the operator can settle it, and the fact that
      // settles it is the Leistungsdatum. So the refusal stands and is simply made legible here,
      // before anything is posted. A02 keeps the last word: this is a better message in front of its
      // gate, not a second opinion about the rate.
      const ambiguous = supplyDateAmbiguity(ctx, line, netMinor, entryDate);
      if (ambiguous !== null) return ambiguous;
      const vatLines = buildVatLines(ctx, {
        counterAccount: debtor,
        revenueOrExpenseAccount: revenue,
        amountMinor: netMinor,
        amountIsGross: false,
        taxCode: line.tax_code,
        direction: 'output',
        supplyDate: line.supply_date ?? null,
      });
      journalLines.push(...vatLines);
      // The line's gross is its debtor leg (the ONE debit buildVatLines books against 1100); the
      // line's tax is gross minus net. Summing these keeps the persisted totals equal to the posted
      // receivable by construction, to the Rappen, single- and mixed-rate alike.
      const debtorLeg = vatLines.find((l) => l.account === debtor && typeof l.debit === 'number');
      const grossMinor = debtorLeg?.debit ?? netMinor;
      subtotalMinor += netMinor;
      taxMinor += grossMinor - netMinor;
    } catch (e) {
      // buildVatLines throws a structured cause (unknown code, missing VAT account) rather than
      // returning a Result; surface it as a P9 rejection so the transition aborts cleanly.
      return err('vat_build_failed', { line: line.position, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Persist the VAT total and the GROSS total on the document (B-1). This runs inside the issue
  // transaction A10 opened, so a failed post rolls it back with everything else. The schema comment
  // "A11 fills tax" is made true here; the QR `Amt` and the PDF then read the gross.
  ctx.store.db
    .prepare('UPDATE document SET subtotal_minor = ?, tax_minor = ?, total_minor = ? WHERE workspace_id = ? AND id = ?')
    .run(subtotalMinor, taxMinor, subtotalMinor + taxMinor, ctx.workspaceId, doc.id);

  // §7 P3, and B-1. The key A11 posts under is MINTED, not derived. `invoice-post-<id>` was
  // computable by anyone holding the document id, so any caller with the `post` capability could
  // occupy it first and A02's §H-IDEMPOTENT would hand that squatter's entry back here as though
  // A11 had written it. Deriving the key bought nothing: the issue transition runs inside ONE A10
  // transaction, so replay protection comes from the document state machine plus A10's own
  // `transition_document` memo, never from this key. Minting follows the pattern `reverseEntry` and
  // `transitionDocument` already use (put the key in a namespace outside callers cannot address);
  // the `invoice-post-<id>-` prefix keeps it greppable, and the document's `posted_entry_id` remains
  // the link between invoice and entry.
  const postingKey = `invoice-post-${doc.id}-${ctx.ids.next('ipk')}`;

  const posted = postEntry(ctx, {
    date: entryDate,
    source: 'invoice',
    ...(doc.number !== null ? { ref: doc.number } : {}),
    description: `Rechnung ${doc.number ?? doc.id}`,
    idempotencyKey: postingKey,
    lines: journalLines,
    // The rate is passed EXPLICITLY rather than re-resolved inside postEntry, so the figures the
    // document persists and the figures the ledger posts cannot be priced by two different rates
    // if the store changes between the two calls.
    ...(doc.currency !== workspaceBase ? { currency: doc.currency, fxRate: fx.rate } : {}),
  });
  if (!posted.ok) return posted;

  // §H-FX widens the identity below rather than weakening it: the transaction amount, the base CHF
  // amount, the currency and the resolved rate are ALL part of what makes the entry ours, so a
  // squatter's CHF entry cannot stand in for a EUR invoice by happening to carry the right integer.
  // The entry that comes back is still VERIFIED to be the entry A11 just built, not trusted,
  // because unguessability is a defence and not a guarantee: a deterministic id generator, a leaked
  // key, or a future re-derivation would all put a foreign entry back on this line. There is
  // deliberately no separate "is this key already occupied" pre-check in front of it. That check
  // would shadow this one (an occupied key would never reach it), leaving the real verification as
  // untested defensive code, which is precisely how the one-aggregate guard below got shipped. One
  // mechanism, exercised by the attack tests, beats two where only the weaker one runs.
  //
  // The predecessor of this check compared ONE aggregate (the summed 1100 debit) and an independent
  // critic walked through it three ways, because that number says nothing about the counter-accounts
  // (revenue and output VAT both missing), nothing about credits on the same account (a receivable
  // netting to zero behind a CHF 1081.00 QR-bill), and nothing about the date (a posting parked in a
  // prior financial year, past its period lock). So the identity checked here is provenance, period
  // and the FULL line set: source, ref, date, and every posted row matched against the prepared
  // journal lines as a multiset. A mismatch aborts the whole transition (no number consumed, no
  // status change, no partial write), which is the right answer whether the cause is a squatter or a
  // future refactor that quietly changes what gets posted.
  // What A02 will have written, asked with A02's OWN predicate rather than a second copy of it: a
  // base-currency posting stores a NULL rate (nothing converted), a foreign-currency posting stores
  // the basis it converted on, including at a pegged rate of exactly 1. Re-deriving the rule here was
  // how the pegged case desynchronised: A11 predicted NULL, A02 wrote NULL, and both were wrong
  // together, which is the only way a prediction check fails silently (§H-FX,
  // docs/specs/03-fx-foundation.md section 13).
  const expectedRate = statesConversionBasis({ currency: doc.currency, baseCurrency: workspaceBase })
    ? fx.rate
    : null;
  const mismatch = verifyPostedEntryIsOurs(ctx, posted.entryId as string, {
    source: 'invoice',
    date: entryDate,
    ref: doc.number,
    currency: doc.currency,
    fxRate: expectedRate,
    rateScaled: fx.rateScaled,
    lines: journalLines,
  });
  const expectedGross = subtotalMinor + taxMinor;
  // What the books actually hold, read back for the rejection payload and for the FX summary below.
  // This aggregate does not GUARD anything: the one-aggregate guard it descends from was defeated
  // three ways by an independent critic and is superseded by the full-row identity check above.
  //
  // `INDEXED BY journal_line_entry` is doing real work here and is not decoration. Both columns in
  // the WHERE are indexed, and the store deliberately collects NO table statistics (ANALYZE is a
  // write, and D12 puts a second writer on the file: the full reasoning is on `SqliteStore.close()`).
  // With nothing to compare selectivity against, the planner picks journal_line_account, so this
  // read walks EVERY line ever posted to the debtor account and grows with the book. The entry index
  // is three rows, once. Re-measured on this branch, 10'000 entries / 30'000 lines, file-backed,
  // 21 interleaved rounds of 500 calls, median round: 93.1 us as-is, 2.6 us hinted, 36x. A full
  // ANALYZE reaches only 7.5 us, so the hint BEATS the statistics it substitutes for, and it takes
  // no lock and cannot go stale.
  //
  // `INDEXED BY` is a hard constraint, not a hint: drop journal_line_entry and this statement stops
  // PREPARING rather than quietly degrading. That is the behaviour we want on the money path, and it
  // is safe because the index set is pinned by an exact-match assertion in
  // test/core/journal-line-indexes.test.mjs, which turns red before this ever could.
  const receivable = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(debit_minor), 0) AS txn,
              COALESCE(SUM(base_debit_minor), 0) AS base
         FROM journal_line INDEXED BY journal_line_entry WHERE entry_id = ? AND account_id = ?`,
    )
    .get(posted.entryId, debtor) as { txn: number; base: number };
  if (mismatch !== null) {
    return err('posting_key_conflict', {
      documentId: doc.id,
      entryId: posted.entryId,
      expectedReceivableMinor: expectedGross,
      postedReceivableMinor: receivable.txn,
      expectedCurrency: doc.currency,
      expectedFxRate: expectedRate,
      postedReceivableBaseMinor: receivable.base,
      baseCurrency: workspaceBase,
      mismatch,
      reason: 'the entry under this invoice posting key is not this invoice: refusing to issue against it',
    });
  }
  return ok({
    postedEntryId: posted.entryId,
    // §9 DoD, said out loud to the caller: what was billed, at what rate, and what the books hold.
    ...(doc.currency === workspaceBase
      ? {}
      : {
          currency: doc.currency,
          fxRate: fx.rate,
          fxRateAsOf: fx.rateAsOf,
          totalMinor: expectedGross,
          totalBaseMinor: receivable.base,
          baseCurrency: workspaceBase,
        }),
  });
}

/**
 * Does this position's tax code price differently under A11's fallback (the code's stored rate) than
 * under A02's (the entry date's era rate)? Returns the P9 rejection naming the position, the code,
 * both rates and the fix, or null when the two agree (every seeded current-era code, and every line
 * that carries its own Leistungsdatum, where both sides use the same date).
 */
function supplyDateAmbiguity(
  ctx: WorkspaceContext,
  line: { position: number; tax_code: string | null; supply_date: string | null },
  netMinor: number,
  entryDate: string,
): Result | null {
  // A line with its own Leistungsdatum is unambiguous by construction: both sides price on that date.
  if (line.supply_date !== null) return null;
  if (line.tax_code === null || line.tax_code === 'none') return null;

  const asPriced = computeLineTax(ctx, {
    amountMinor: netMinor,
    amountIsGross: false,
    taxCode: line.tax_code,
    supplyDate: null,
  });
  const asReconciled = computeLineTax(ctx, {
    amountMinor: netMinor,
    amountIsGross: false,
    taxCode: line.tax_code,
    supplyDate: entryDate,
  });
  // A code that does not resolve is not this check's business: `buildVatLines` reports it as
  // `vat_build_failed` a few lines below, with its own structured cause.
  if (!asPriced.ok || !asReconciled.ok) return null;
  if (asPriced.rateBp === asReconciled.rateBp) return null;

  return err('needs_supply_date', {
    position: line.position,
    taxCode: line.tax_code,
    codeRateBp: asPriced.rateBp,
    entryDateRateBp: asReconciled.rateBp,
    entryDate,
    reason:
      'this tax code carries a rate from a different era than the invoice date, so the position needs its Leistungsdatum (supply date) to say which era applies',
  });
}

/**
 * Reproduce, exactly, the base amounts `postEntry` will store for a set of prepared lines at a rate.
 *
 * This is not a second implementation of the conversion: it calls `allocateBase`, the same pure
 * function `applyFx` calls, with the same per-SIDE partition in the same line order. §H-FX converts
 * once per side on the side TOTAL and allocates back by largest remainder, so a per-line base amount
 * is NOT the line's own amount times the rate, and any check that assumes it is will be right for
 * CHF and quietly wrong for everything else (see docs/specs/03-fx-foundation.md section 6).
 *
 * The `RATE_ONE` short-circuit below is ARITHMETIC, not disclosure: at a rate of 1 the allocation is
 * the identity in integer arithmetic, so base == transaction bit for bit, exactly as the pre-FX
 * engine stored it. `postEntry`'s `applyFx` skips the allocation on the same condition, so the two
 * agree line for line. Whether the ROW then states a conversion basis is a separate question with a
 * separate predicate (`statesConversionBasis`): a pegged EUR invoice takes this short-circuit and
 * still stamps its rate.
 */
function expectedBaseAmounts(
  lines: readonly { debit?: number; credit?: number }[],
  rateScaled: bigint,
): { baseDebit: number; baseCredit: number }[] {
  const out = lines.map((l) => ({ baseDebit: l.debit ?? 0, baseCredit: l.credit ?? 0 }));
  if (rateScaled === RATE_ONE) return out;

  // `postEntry` partitions on `debit > 0`, and this mirrors that predicate rather than re-deriving
  // it, because the two must agree line for line or the check is noise. The partition is total and
  // unambiguous by the time it runs: `validatePostingLines` rejects any line where
  // `(debit > 0) === (credit > 0)` (`invalid_line`, "each line is exactly one of debit or credit")
  // before `applyFx` is ever called, so a line that is zero on BOTH sides cannot reach either
  // partition. There is no "a zero-debit line lands on the credit side" agreement to observe here:
  // every surviving line has exactly one positive side, and `debit > 0` names it.
  const debitIdx: number[] = [];
  const creditIdx: number[] = [];
  lines.forEach((l, i) => ((l.debit ?? 0) > 0 ? debitIdx : creditIdx).push(i));

  const spread = (idx: number[], pick: (i: number) => number, put: (i: number, v: number) => void): void => {
    const allocated = allocateBase(idx.map(pick), rateScaled);
    idx.forEach((i, k) => put(i, allocated[k] as number));
  };
  spread(
    debitIdx,
    (i) => lines[i]?.debit ?? 0,
    (i, v) => {
      const row = out[i] as { baseDebit: number; baseCredit: number };
      row.baseDebit = v;
      row.baseCredit = 0;
    },
  );
  spread(
    creditIdx,
    (i) => lines[i]?.credit ?? 0,
    (i, v) => {
      const row = out[i] as { baseDebit: number; baseCredit: number };
      row.baseCredit = v;
      row.baseDebit = 0;
    },
  );
  return out;
}

/**
 * Is `entryId` the entry A11 just built? Returns null when it is, or a short reason naming the first
 * clause that failed.
 *
 * The comparison is on the money-bearing dimensions A11 controls: `source='invoice'`, the invoice's
 * own `ref` and `date`, and the full row multiset of the posted lines against the prepared ones.
 *
 * §H-FX widens what "the full row" means, and this is the part the CHF-only version got wrong. A
 * foreign-currency row carries THREE money facts, not one: the transaction amount (what happened),
 * the base CHF amount (what the books hold) and the rate that turned one into the other. Comparing
 * a bare integer against `base_debit_minor` was right only because at rate 1 the two coincide. It
 * had two failure modes the moment a rate other than 1 existed:
 *
 *   - every legitimate EUR invoice refused, because the prepared TRANSACTION amount (EUR 1081.00)
 *     never equals the posted BASE amount (CHF 1017.44);
 *   - and, had the comparison simply been moved to the transaction columns, a squatter's CHF entry
 *     carrying the same integer would have passed, booking CHF 1081.00 for a receivable really
 *     worth CHF 1017.44, with no rate stored and nothing recording that the debt is in euros.
 *
 * So all four dimensions are compared per row: account, transaction debit/credit, base debit/credit,
 * `currency` and `fx_rate`. The base figures are the ones `postEntry` will itself compute
 * (`expectedBaseAmounts`, the same `allocateBase` call), which also makes this an end-to-end check on
 * the allocation rather than a restatement of it: a future refactor that changes how the converted
 * total is spread over the lines reddens here.
 *
 * The stored VAT trace is deliberately NOT compared: A02 owns it (`reconcileAndStampVat` recomputes
 * and re-stamps the canonical base/tax, and rejects an entry whose 2200/1170 movements do not
 * reconcile), so re-asserting it here would duplicate A02's check and break the moment its canonical
 * rounding legitimately differs from the hint A11 handed in.
 */
export function verifyPostedEntryIsOurs(
  ctx: WorkspaceContext,
  entryId: string,
  expected: {
    /** The engine source the entry must carry ('invoice' for A11, 'credit_note' for A13). */
    source: string;
    date: string;
    ref: string | null;
    currency: string;
    fxRate: string | null;
    rateScaled: bigint;
    lines: { account: string; debit?: number; credit?: number }[];
    /**
     * A13 (§4b.3): the per-line STATED base amounts, aligned with `lines`, for an entry posted
     * through the stated-base seam. When present the expected base figures ARE these statements
     * (that is what `postEntry` stored); absent, they are re-derived through the same
     * `allocateBase` call the posting used, exactly as before.
     */
    statedBases?: number[];
  },
): string | null {
  const entry = ctx.store.db
    .prepare('SELECT date, ref, source, status FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { date: string; ref: string | null; source: string; status: string } | undefined;
  if (entry === undefined) return 'entry_not_in_workspace';
  if (entry.source !== expected.source) return `source:${entry.source}`;
  if (entry.status !== 'posted') return `status:${entry.status}`;
  if (entry.date !== expected.date) return `date:${entry.date}`;
  if ((entry.ref ?? null) !== (expected.ref ?? null)) return `ref:${entry.ref ?? 'null'}`;

  // The line multiset. Counting per full row catches a row that is missing, extra, booked to a
  // foreign account, duplicated, denominated in the wrong currency, or converted at the wrong rate,
  // and it is order-independent because the insert order of `journal_line` is not part of the
  // contract. The currency and the rate ride INSIDE the key rather than being checked separately, so
  // there is no row the multiset accepts and a later loop would have had to catch.
  const stated = expected.statedBases;
  const base =
    stated !== undefined
      ? expected.lines.map((l, i) =>
          (l.debit ?? 0) > 0
            ? { baseDebit: stated[i] ?? 0, baseCredit: 0 }
            : { baseDebit: 0, baseCredit: stated[i] ?? 0 },
        )
      : expectedBaseAmounts(expected.lines, expected.rateScaled);
  const tally = new Map<string, number>();
  const bump = (key: string, by: number): void => {
    tally.set(key, (tally.get(key) ?? 0) + by);
  };
  expected.lines.forEach((line, i) => {
    const b = base[i] as { baseDebit: number; baseCredit: number };
    bump(
      `${line.account}|${line.debit ?? 0}|${line.credit ?? 0}|${b.baseDebit}|${b.baseCredit}|${expected.currency}|${expected.fxRate ?? ''}`,
      1,
    );
  });
  const postedRows = ctx.store.db
    .prepare(
      `SELECT account_id, debit_minor AS d, credit_minor AS c,
              base_debit_minor AS bd, base_credit_minor AS bc, currency, fx_rate
         FROM journal_line WHERE entry_id = ?`,
    )
    .all(entryId) as {
    account_id: string;
    d: number;
    c: number;
    bd: number;
    bc: number;
    currency: string;
    fx_rate: string | null;
  }[];
  for (const row of postedRows) {
    bump(`${row.account_id}|${row.d}|${row.c}|${row.bd}|${row.bc}|${row.currency}|${row.fx_rate ?? ''}`, -1);
  }
  for (const [key, count] of tally) {
    if (count !== 0) return `lines:${key}:${count > 0 ? 'missing' : 'unexpected'}`;
  }
  return null;
}

/**
 * The registered invoice poster. `onIssue` posts; `onCancel` reverses the posted entry via A02
 * (§H-AUDIT), never deletes. Registered into A10's seam by `index.ts`.
 */
export const invoicePoster: DocumentPoster = {
  posts: true,
  onIssue: (ctx, doc) => buildInvoicePosting(ctx, doc),
  onCancel: (ctx, doc) => {
    if (doc.posted_entry_id === null) return ok({});
    const reversed = reverseEntry(ctx, {
      entryId: doc.posted_entry_id,
      idempotencyKey: `doc-cancel-${doc.id}`,
    });
    if (!reversed.ok) return reversed;
    return ok({ reversalEntryId: reversed.reversalId });
  },
};

// --- QR-bill resolution ------------------------------------------------------------------------

function readWorkspaceQr(ctx: WorkspaceContext): WorkspaceQrRow | undefined {
  return ctx.store.db
    .prepare('SELECT creditor_name, creditor_address, creditor_iban, mwst_no, base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as WorkspaceQrRow | undefined;
}

function readContact(ctx: WorkspaceContext, contactId: string): ContactRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT name, address_street, address_house_no, address_zip, address_city, address_country, email FROM contact WHERE workspace_id = ? AND id = ?',
    )
    .get(ctx.workspaceId, contactId) as ContactRow | undefined;
}

function creditorToQrAddress(name: string, addressJson: string): QrStructuredAddress {
  const a = JSON.parse(addressJson) as { street?: string; buildingNo?: string; zip?: string; town?: string; country?: string };
  return {
    name,
    street: a.street ?? null,
    buildingNo: a.buildingNo ?? null,
    postalCode: a.zip ?? '',
    town: a.town ?? '',
    country: a.country ?? '',
  };
}

function contactToQrAddress(contact: ContactRow): QrStructuredAddress {
  return {
    name: contact.name,
    street: contact.address_street,
    buildingNo: contact.address_house_no,
    postalCode: contact.address_zip ?? '',
    town: contact.address_city ?? '',
    country: contact.address_country ?? '',
  };
}

/** Round half away from zero in exact integer arithmetic (P2), the same split A06 posts with. */
function roundHalfAwayFromZero(numer: number, denom: number): number {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

/**
 * The Swico S1 /32/ VAT details, built so the RECIPIENT's arithmetic lands back on the QR `Amt`.
 *
 * IG v2.3 Annex D Table 30 (fetched 2026-07-25, ig-qr-bill-v2.3-en.pdf page 69):
 *   "VAT details contain either: a single percentage that is to be applied to the whole invoiced
 *    amount, or a list of the VAT amounts, defined by a percentage rate and a net amount... If a
 *    list is given, the total of the net amounts and the VAT calculated on them must correspond to
 *    the amount in the QR Code."
 *
 * The old version skipped every 0%/exempt position (`if (rateBp <= 0) continue`). On a mixed
 * invoice that left ONE positive rate standing, which then emitted the single-percentage form, and
 * the single-percentage form applies to the WHOLE invoiced amount: an invoice of 500 export + 300
 * exempt + 1000 at 8.1% declared `/32/8.1` against an `Amt` of 1881.00, so the recipient derived
 * 140.94 of VAT where 81.00 was owed. The list form had the mirror bug: the untaxed 500.00 was
 * simply missing, so the list totalled 1127.68 against an `Amt` of 1627.68.
 *
 * Zero-rated and exempt positions belong IN the list at rate 0. SIX's own Example 2 shows exactly
 * that: `/32/3.7:400.19;7.7:553.39;0:14`.
 *
 * The reconciliation is an INVARIANT, checked here rather than assumed: the per-rate nets are
 * pooled, the recipient's derivation is recomputed on them, and the tag is emitted only when it
 * reproduces both the posted `Amt` and the posted VAT to the Rappen. When it cannot (a line whose
 * VAT will not resolve, an import-tax line whose amount belongs in /33/ and not /32/, or a rounding
 * shape the two-decimal list cannot express), the tag is OMITTED: Table 29 says "a tag with no data
 * is the equivalent of an omitted tag", and no statement beats a wrong one on a payment part.
 */
function swicoVatDetails(
  ctx: WorkspaceContext,
  lines: DocumentLineRow[],
  totalMinor: number,
  taxMinor: number,
): string | null {
  const byRate = new Map<number, number>();
  for (const line of lines) {
    const computed = computeLineTax(ctx, {
      amountMinor: lineGross(line),
      amountIsGross: false,
      taxCode: line.tax_code,
      supplyDate: line.supply_date ?? null,
    });
    // A line whose VAT will not resolve leaves a hole in the reconciliation, so nothing is statable.
    if (!computed.ok) return null;
    // Einfuhrsteuer is a pure tax amount with no rate-bearing net: Table 30 puts it in /33/, and
    // pooling it into /32/ at rate 0 would understate the declared total by its own tax.
    if (computed.kind === 'import') return null;
    const rateBp = computed.rateBp as number;
    byRate.set(rateBp, (byRate.get(rateBp) ?? 0) + (computed.netMinor as number));
  }
  if (byRate.size === 0) return null;

  const entries = [...byRate.entries()].sort((a, b) => a[0] - b[0]);

  // The recipient's own derivation over the list, in integer Rappen.
  let declaredMinor = 0;
  let derivedTaxMinor = 0;
  for (const [rateBp, netMinor] of entries) {
    const vatMinor = roundHalfAwayFromZero(netMinor * rateBp, 10000);
    declaredMinor += netMinor + vatMinor;
    derivedTaxMinor += vatMinor;
  }
  if (declaredMinor !== totalMinor || derivedTaxMinor !== taxMinor) return null;

  if (entries.length === 1) {
    const [rateBp] = entries[0]!;
    // The idiomatic single-percentage form (IG Example 1), but only when splitting the WHOLE
    // invoiced amount at that rate actually reproduces the VAT the books posted. A 0% invoice is
    // the degenerate case of the same statement: 0% of the whole amount is the posted zero.
    if (rateBp === 0) return bpToPercentString(0);
    const grossSplitTax = roundHalfAwayFromZero(totalMinor * rateBp, 10000 + rateBp);
    if (grossSplitTax === taxMinor) return bpToPercentString(rateBp);
  }

  return entries
    .map(([rateBp, netMinor]) => `${bpToPercentString(rateBp)}:${formatQrAmount(netMinor)}`)
    .join(';');
}

/**
 * The Swico S1 /40/ payment condition, derived from the document's own due date (MINOR 3).
 *
 * IG v2.3 Annex D Table 30: "The indication with a percentage rate equal to zero defines the default
 * payment date of the invoice (e.g. '0:30' for 30 days net)", and, on /11/: "Together with the field
 * /40/0:n, a maturity date of the invoice can be calculated (payable within n days after the voucher
 * date)." Without it an eBill network partner cannot derive `dueDate` from the payload at all.
 *
 * Discounts are not modelled anywhere in A11, so the only condition TILL can state truthfully is the
 * net term. No due date, or a due date on/before the voucher date, emits NOTHING: an absent tag is
 * honest, an invented or negative term is not.
 */
function swicoPaymentConditions(issueDate: string | null, dueDate: string | null): string | null {
  if (issueDate === null || dueDate === null) return null;
  const from = Date.parse(`${issueDate}T00:00:00Z`);
  const to = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.round((to - from) / 86_400_000);
  if (days <= 0) return null;
  return `0:${days}`;
}

/**
 * Resolve a workspace + issued invoice into a Swiss QR-bill payload (qrbill.ts encodes it). Returns:
 *  - `needs_qr_iban` when NO IBAN of any kind is configured (M9); a plain PDF can still be produced.
 *  - `needs_creditor_address` / `needs_customer` / `needs_customer_address` when a structured address
 *    is incomplete (M10: a flagged, fixable error, never an unstructured fallback).
 *  - `unsupported_currency` when the invoice is not CHF/EUR (M13).
 *  - `invalid_qr_bill` (with the structural issues) if validation fails.
 * Reference: QRR (mod-10) when the stored IBAN is a QR-IBAN, else SCOR (ISO 11649). D31: the eBill
 * AltPmt (from the customer email) and Swico S1 StrdBkgInf are emitted when their data exists.
 */
export function buildQrBill(ctx: WorkspaceContext, invoiceId: string): Result {
  const view = getDocument(ctx, { documentId: invoiceId });
  if (!view.ok) return view;
  const document = view.document as {
    id: string;
    type: string;
    number: string | null;
    status: string;
    currency: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    contactId: string | null;
    issueDate: string | null;
    dueDate: string | null;
  };
  if (document.type !== 'invoice') return err('not_an_invoice', { documentId: invoiceId });

  // M-1: a DRAFT has no QR-bill. A draft-time reference would be fabricated from the internal doc id
  // and CHANGE on issue (the real number seeds it), and the rendered QR would be fully payable with
  // an unstable reference. The editor shows QR-READINESS instead; the QR exists from `issued` on.
  if (document.status === 'draft' || document.number === null) {
    return err('not_available', { documentId: invoiceId, status: document.status, reason: 'draft_has_no_qr_bill' });
  }

  const ws = readWorkspaceQr(ctx);
  if (ws === undefined) return err('workspace_not_found', { workspaceId: ctx.workspaceId });

  const iban = ws.creditor_iban;
  // M9: needs_qr_iban fires ONLY when there is no IBAN of any kind (the column is the sole creditor
  // IBAN store today). A plain IBAN would yield SCOR; a QR-IBAN yields QRR. The error CODE still
  // says qr_iban because it is a published wire code the Studio maps; the COLUMN it reads no longer
  // does, since it never held only QR-IBANs after M-2.
  if (iban === null || iban.length === 0) return err('needs_qr_iban', { documentId: invoiceId });
  if (!isValidIban(iban)) return err('needs_qr_iban', { documentId: invoiceId, reason: 'invalid_iban' });

  if (ws.creditor_name === null || ws.creditor_address === null) {
    return err('needs_creditor_address', { documentId: invoiceId });
  }
  if (!isQrCurrency(document.currency)) {
    return err('unsupported_currency', { documentId: invoiceId, currency: document.currency });
  }
  // m-3: the IG treats an empty Amt as an OPEN QR-bill, payable with any amount the payer types.
  // That is right for a donation slip and wrong for an invoice: a zero-total invoice has nothing to
  // collect, so emitting an open QR would invite an arbitrary payment against a CHF 0.00 receivable.
  // Deliberate refusal, never a silent open amount; the plain PDF (no payment part) still renders.
  if (document.totalMinor <= 0) {
    return err('zero_total', { documentId: invoiceId, reason: 'qr_bill_would_be_open_amount' });
  }
  if (document.contactId === null) return err('needs_customer', { documentId: invoiceId });
  const contact = readContact(ctx, document.contactId);
  if (contact === undefined) return err('needs_customer', { documentId: invoiceId });

  // The reference type used to be a pure function of the IBAN kind. From the v2.4 cutover it is a
  // function of the IBAN kind AND the currency: a QR-IBAN, and therefore the QRR reference it
  // mandates, is CHF-only (see QR_IBAN_CHF_ONLY_FROM for the four citations).
  //
  // A workspace holds exactly ONE creditor IBAN today, so a QR-IBAN-only creditor billing in EUR on
  // or after the cutover has no conformant payment part available at all. That is refused here,
  // explicitly and readably, rather than discovered by a customer whose bank rejects the slip. The
  // INVOICE is unaffected: it still issues, still posts, and still renders as a PDF without a
  // payment part, exactly as it does for any other currency the QR-bill cannot carry.
  //
  // The bill is dated by its own issue date, not by today, so re-rendering a bill issued before the
  // cutover keeps producing the bill that was actually sent.
  const billDate = document.issueDate ?? ctx.clock.now().slice(0, 10);
  if (isQrIban(iban) && document.currency !== QR_REFERENCE_CURRENCY && billDate >= QR_IBAN_CHF_ONLY_FROM) {
    return err('qr_iban_chf_only', {
      documentId: invoiceId,
      currency: document.currency,
      issueDate: billDate,
      effectiveFrom: QR_IBAN_CHF_ONLY_FROM,
      guideline: 'SIX Implementation Guidelines QR-bill v2.4, ch. 2.10 / 4.3.2',
      remedy: 'bill this invoice against a plain IBAN (SCOR reference); a QR-IBAN carries CHF only',
      note: 'v2.3 remains valid until November 2027, so a bill already sent under it stays payable',
    });
  }
  const referenceType: QrReferenceType = isQrIban(iban) ? 'QRR' : 'SCOR';
  // The reference is seeded from the REAL number only (the draft gate above guarantees it exists),
  // so it is stable for the life of the issued invoice: re-rendering can never change it (M-1).
  const numberSeed = document.number;
  const reference =
    referenceType === 'QRR' ? buildQrrReference(numberSeed) : buildScorReference(numberSeed);

  const lines = readLines(ctx, document.id);
  const voucherDate = document.issueDate ?? ctx.clock.now().slice(0, 10);
  const billingInfo =
    document.number !== null
      ? buildSwicoS1({
          invoiceNumber: document.number,
          invoiceDate: voucherDate,
          vatNumber: ws.mwst_no,
          // The /32/ tag reconciles to `Amt` and to the posted VAT, or it is omitted entirely.
          vatRatePercent: swicoVatDetails(ctx, lines, document.totalMinor, document.taxMinor),
          paymentConditions: swicoPaymentConditions(document.issueDate, document.dueDate),
        })
      : null;

  const qrInput: BuildQrBillInput = {
    iban,
    creditor: creditorToQrAddress(ws.creditor_name, ws.creditor_address),
    // Always the concrete gross (the zero-total guard above ran): an invoice never emits the
    // IG's open (amount-less) form, which is for donation-style slips, not receivables.
    amountMinor: document.totalMinor,
    currency: document.currency,
    debtor: contactToQrAddress(contact),
    referenceType,
    reference,
    unstructuredMessage: document.number !== null ? `Rechnung ${document.number}` : null,
    billingInfo,
    ebillIdentifier: contact.email,
  };

  const issues = validateQrBill(qrInput);
  if (issues.length > 0) {
    // A structural miss on the creditor/customer address is the fixable-address case (M10), named so
    // the GUI can point at the field instead of falling back to an unstructured address.
    const addressIssue = issues.find((i) => i.field.startsWith('creditor') || i.field.startsWith('debtor'));
    if (addressIssue !== undefined) {
      const which = addressIssue.field.startsWith('creditor') ? 'needs_creditor_address' : 'needs_customer_address';
      return err(which, { documentId: invoiceId, field: addressIssue.field, reason: addressIssue.reason });
    }
    return err('invalid_qr_bill', { documentId: invoiceId, issues });
  }

  const bill = buildQrBillPayload(qrInput);
  return ok({ qr: bill });
}

// --- PDF rendering -----------------------------------------------------------------------------

/**
 * Escape a text string for a PDF literal (the minimal set: backslash and the two parentheses).
 */
export function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Where the Swiss QR Code's outer edge (the 46 mm symbol plus its 5 mm quiet zone) is placed on the
 * A4 page, as the LEFT and BOTTOM edges in PDF points.
 *
 * This is a placement, not a payment part. IG chapter 6 fixes the SYMBOL (46 x 46 mm, the 5 mm
 * border, the 7 x 7 mm recognition symbol) and `swiss-qr-graphic.ts` draws exactly that; the
 * millimetre-exact receipt/payment-part grid of the Style Guide (the 62 mm receipt column, the
 * perforation, the field blocks) is still NOT drawn, and nothing here should be read as claiming it.
 * The code sits in the lower-left of the page where the payment part will eventually begin, far
 * enough from the body text that the quiet zone is genuinely unprinted.
 */
const QR_GRAPHIC_X_PT = 20 * PT_PER_MM;
const QR_GRAPHIC_Y_PT = 15 * PT_PER_MM;

/** What the PDF renderer resolved about the payment part: the drawn graphic, or the reason there is none. */
interface QrGraphicOutcome {
  payload: string | null;
  ops: string | null;
  /** The machine code + human detail behind a missing payment part. Null when one was drawn. */
  unavailable: { code: string; detail: string } | null;
  /** The encoded symbol's measurements, for a caller that has to act on a too-dense code. */
  graphic: {
    version: number;
    moduleCount: number;
    moduleSizeMm: number;
    meetsMinimumModuleSize: boolean;
    sizePt: number;
  } | null;
}

/**
 * Resolve the invoice into a drawn Swiss QR Code, or into the honest reason there is none.
 *
 * Two things can go wrong and they are NOT the same thing. `buildQrBill` refuses on missing or
 * malformed data (no IBAN, an unstructured address, a forbidden character), which is what the
 * printed reason has always named. The SYMBOL can also refuse a payload that passed every one of
 * those field-level checks: `validateQrBill` caps each field but nothing caps their SUM, and IG
 * chapter 6.2 caps the code itself at 997 characters / UTF-8 bytes. A long creditor address plus a
 * full 140-character AddInf plus an eBill AltPmt can clear every field cap and still overflow the
 * symbol. That case used to be impossible to reach because no symbol was drawn; now that one is, it
 * gets its own named cause rather than arriving as `unknown`.
 */
function resolveQrGraphic(ctx: WorkspaceContext, invoiceId: string): QrGraphicOutcome {
  const qrResult = buildQrBill(ctx, invoiceId);
  if (!qrResult.ok) {
    const code = (qrResult as unknown as { error?: string }).error ?? 'unknown';
    return { payload: null, ops: null, unavailable: { code, detail: qrBillFailureReason(qrResult) }, graphic: null };
  }

  const payload = (qrResult.qr as { swissQrPayload: string }).swissQrPayload;
  try {
    // The symbol is built ONCE and then handed to the renderer, rather than built here for its
    // measurements and rebuilt inside the renderer from the payload. Encoding is by far the most
    // expensive thing on this path, and this one runs on every issued invoice and every PDF
    // re-render, not on a page view. `renderSwissQrCodePdfOps` takes either form and draws the same
    // operators from both, so nothing about the printed code depends on which arm was used.
    const symbol = buildSwissQrCodeGraphic(payload);
    const ops = renderSwissQrCodePdfOps(symbol, { xPt: QR_GRAPHIC_X_PT, yPt: QR_GRAPHIC_Y_PT });
    return {
      payload,
      ops,
      unavailable: null,
      graphic: {
        version: symbol.version,
        moduleCount: symbol.moduleCount,
        moduleSizeMm: symbol.moduleSizeMm,
        // IG 6.3 wants at least 0.4 mm per printed module and IG 6.4 fixes the code at 46 mm for
        // every version, which the guideline itself cannot satisfy at version 25 (46/117 = 0.393).
        // The flag is reported, never acted on by refusing: a caller who shortens the additional
        // information gets a code back under the floor, and a caller who does not still gets a code.
        meetsMinimumModuleSize: symbol.meetsMinimumModuleSize,
        sizePt: swissQrGraphicSizePt(),
      },
    };
  } catch (error) {
    if (error instanceof SwissQrPayloadTooLongError) {
      // A payload the symbol cannot carry is a payment part that does not exist. Saying so, and
      // shipping no QR comment either, keeps `hasQrBill` telling the truth and keeps `sendInvoice`
      // from mailing an invoice whose payment part is a claim rather than a code.
      return {
        payload: null,
        ops: null,
        unavailable: { code: 'swiss_qr_payload_too_long', detail: error.message },
        graphic: null,
      };
    }
    throw error;
  }
}

/**
 * Render the invoice as a minimal single-page PDF that lays out the payment-part / receipt fields
 * (creditor, debtor, amount, reference) as text, DRAWS the scannable Swiss QR Code, and EMBEDS the
 * raw Swiss QR Code payload as document metadata, so `get_document(include:['pdf','qr'])` returns a
 * self-describing artifact.
 *
 * Honestly scoped, and the scope moved: the code itself is now real (a genuine ISO/IEC 18004 symbol
 * at 46 mm with the 5 mm border and the 7 x 7 mm recognition symbol, proven by decoding the rendered
 * operators with an independent reader). What is still NOT drawn is the millimetre-exact SIX
 * payment-part/receipt GEOMETRY around it, and any G05 branding. Nothing here is SIX-certified:
 * scanning against the SIX reference validator is an open item and a process with SIX, not a
 * property of this file. PDF/A-3b (A32-OI1) is DEFERRED per D31 and is NOT claimed here.
 */
export function renderInvoicePdf(
  ctx: WorkspaceContext,
  invoiceId: string,
  opts?: { templateId?: string },
): Result {
  const view = getDocument(ctx, { documentId: invoiceId });
  if (!view.ok) return view;
  const document = view.document as {
    type: string;
    number: string | null;
    status: string;
    currency: string;
    totalMinor: number;
    contactId: string | null;
  };
  if (document.type !== 'invoice') return err('not_an_invoice', { documentId: invoiceId });

  // M-1: a draft has no invoice artifact. The number, the totals, and the QR reference all
  // crystallise at issue; a draft-time PDF would print fabricated stand-ins for every one of them.
  if (document.status === 'draft' || document.number === null) {
    return err('not_available', { documentId: invoiceId, status: document.status, reason: 'draft_has_no_invoice_pdf' });
  }

  const qr = resolveQrGraphic(ctx, invoiceId);

  const amount = (document.totalMinor / 100).toFixed(2);
  // The printed reason is the reason the ENGINE gave. It used to be hardcoded to "kein IBAN
  // konfiguriert" for every `buildQrBill` failure, which put a false explanation on a real invoice:
  // observed on a run where a valid QR-IBAN WAS configured and the actual cause was
  // `needs_customer_address / illegal_character`. The operator checked the IBAN, found it fine, and
  // had nothing else to go on. A PDF that names the wrong field is worse than one that names none.
  const bodyLines = [
    `Rechnung ${document.number}`,
    `Betrag: ${document.currency} ${amount}`,
    qr.unavailable === null
      ? 'Swiss QR-bill: payment part enclosed'
      : `QR-bill: not available (${qr.unavailable.detail})`,
  ];

  // G05: the template SEAM. Resolution reads the snapshot frozen at issue (or the preview
  // override), and contributes ONLY footer text lines in the resolved locale. It runs strictly
  // AFTER `resolveQrGraphic` and touches neither `qr.payload` nor `qr.ops`: there is no code path
  // from a template to the Swiss QR payload, and `test/customization/document-templates.test.mjs`
  // asserts the byte-identity rather than trusting this comment.
  const tpl = resolveRenderTemplate(ctx, {
    documentKind: 'invoice',
    table: 'document',
    rowId: invoiceId,
    ...(opts?.templateId !== undefined ? { templateId: opts.templateId } : {}),
    contactId: document.contactId,
  });

  const text = bodyLines
    .map((line, i) => `BT /F1 12 Tf 60 ${760 - i * 20} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');
  // The footer occupies a fixed y-band (240pt, stepping down 14pt for at most MAX_FOOTER_LINES
  // lines, so its lowest line sits at 198pt), which stays clear of the QR zone: the 46mm symbol
  // draws from 15mm above the sheet's bottom edge and tops out around 175pt. Layout only: the QR
  // ops below are appended verbatim, after the footer, unchanged.
  const footerOps = tpl.footerLines
    .map((line, i) => `BT /F1 9 Tf 60 ${240 - i * 14} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');
  const body = footerOps.length === 0 ? text : `${text}\n${footerOps}`;
  // The graphic is appended AFTER the text, in its own `q`/`Q` pair, so its fill colour cannot leak
  // into anything the page draws before or after it.
  const content = qr.ops === null ? body : `${body}\n${qr.ops}`;
  // The QR payload ALSO rides as a PDF comment line (%) so it is inside the bytes but invisible to a
  // text renderer. That is what lets a reader recover the exact payload without rasterizing, and it
  // is emitted only when a real symbol was drawn, so the comment can never advertise a payment part
  // the page does not carry.
  const pdf = buildMinimalPdf(content, qr.payload);

  const pdfBase64 = Buffer.from(pdf, 'latin1').toString('base64');
  return ok({
    pdf: {
      base64: pdfBase64,
      byteLength: Buffer.byteLength(pdf, 'latin1'),
      hasQrBill: qr.payload !== null,
      // The named cause when there is no payment part, or null when one was drawn. `sendInvoice`
      // reads this instead of re-deriving the cause, so the refusal an operator sees and the reason
      // printed on the artifact are literally the same string.
      qrUnavailable: qr.unavailable,
      // The drawn symbol's measurements, including whether the scaled module still clears IG 6.3's
      // 0.4 mm print floor. Reported so a caller can shorten the additional information rather than
      // find out at a bank counter; never a refusal (IG 6.4's 46 mm is unconditional).
      qrGraphic: qr.graphic,
      // PDF/A-3b is not asserted (A32-OI1 deferred, D31): a downstream eBill step must verify, not
      // assume, conformance.
      pdfaProfile: null,
      // G05: which template shaped the LAYOUT (frozen at issue, or the preview override), and the
      // locale its footer resolved to. Null template = the built-in fixed default. Never a claim
      // about the QR payload, which no template can reach.
      templateApplied: tpl.templateId,
      templateLocale: tpl.locale,
    },
  });
}

/**
 * The real cause of a `buildQrBill` refusal, rendered for the invoice PDF and for the `sendInvoice`
 * rejection. The engine's error code leads (it is the thing an operator can search for and a GUI can
 * map to a field), followed by the offending field and the structural reason when the refusal names
 * them. Never invents a cause, and never falls back to a guess.
 */
function qrBillFailureReason(qrResult: Result): string {
  const detail = qrResult as unknown as { error?: string; field?: string; reason?: string };
  const parts = [detail.error ?? 'unknown'];
  if (typeof detail.field === 'string') parts.push(detail.field);
  if (typeof detail.reason === 'string') parts.push(detail.reason);
  return parts.join(': ');
}

/** Assemble a minimal, valid single-page PDF from a content stream, with the QR payload as a comment. */
export function buildMinimalPdf(content: string, qrPayload: string | null): string {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    // /WinAnsiEncoding so the umlauts on the invoice survive: the content stream is latin1, and a
    // base-14 Type1 font with NO /Encoding resolves through StandardEncoding, where 0xFC is `ae`
    // and every ü in a Swiss address or line description corrupts. Same fix, same reason, as
    // `src/core/reports/export.ts` and `src/core/dunning/pdf.ts` (A15 critic, filed against A11).
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  if (qrPayload !== null) {
    // A PDF comment carrying the exact Swiss QR payload (newlines escaped) so the artifact is
    // self-describing and testable without decoding a QR graphic.
    pdf += `%SwissQR:${qrPayload.replace(/\r?\n/g, '\\n')}\n`;
  }
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

// --- Verbs -------------------------------------------------------------------------------------

/**
 * Issue an invoice: A10's `transitionDocument(..., 'issued')` runs the guard + gap-free numbering and
 * invokes A11's registered poster (which posts the balanced VAT entry) atomically. On success the QR
 * summary is attached (or the `needs_qr_iban` reason surfaced) so the caller learns issue + QR state
 * in one round-trip. Idempotent on `idempotencyKey` (§H-IDEMPOTENT via A10).
 */
export function issueInvoice(
  ctx: WorkspaceContext,
  input: { invoiceId: string; idempotencyKey?: string },
): Result {
  const transition = transitionDocument(ctx, {
    documentId: input.invoiceId,
    to: 'issued',
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  if (!transition.ok) return transition;

  const qr = buildQrBill(ctx, input.invoiceId);
  const qrSummary = qr.ok
    ? { available: true, ...(qr.qr as object) }
    : { available: false, reason: qr.error };
  return ok({ ...transition, qr: qrSummary });
}

/** Abort the send transaction so a relay/transition failure is never memoised as the key's result. */
class SendAbort {
  constructor(public readonly result: Result) {}
}

/**
 * The idempotency verb the send's INTENT is recorded under, distinct from the completed result. The
 * `send_invoice` verb holds the finished outcome; this one holds the fact that a transport call was
 * about to happen (`dispatching`) or has happened but its records have not landed (`transmitted`).
 */
const SEND_ATTEMPT_VERB = 'send_invoice_attempt';

type SendAttempt = { phase: 'dispatching' | 'transmitted'; to: string };

/** Read the durable attempt record for a key, if one survived a prior crash. */
function readSendAttempt(ctx: WorkspaceContext, scopedKey: string): SendAttempt | undefined {
  return ctx.store.recallIdempotent<SendAttempt>(ctx.workspaceId, scopedKey, SEND_ATTEMPT_VERB);
}

/** Write or advance the attempt record in its OWN committed transaction, outside the send's unit. */
function writeSendAttempt(ctx: WorkspaceContext, scopedKey: string, attempt: SendAttempt): void {
  ctx.store.tx(() => {
    ctx.store.db
      .prepare('DELETE FROM idempotency WHERE workspace_id = ? AND verb = ? AND key = ?')
      .run(ctx.workspaceId, SEND_ATTEMPT_VERB, scopedKey);
    ctx.store.db
      .prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ctx.workspaceId, scopedKey, SEND_ATTEMPT_VERB, JSON.stringify(attempt), ctx.clock.now());
  });
}

/** Clear the attempt record: only ever after a transport said, definitively, that nothing was sent. */
function clearSendAttempt(ctx: WorkspaceContext, scopedKey: string): void {
  ctx.store.tx(() => {
    ctx.store.db
      .prepare('DELETE FROM idempotency WHERE workspace_id = ? AND verb = ? AND key = ?')
      .run(ctx.workspaceId, SEND_ATTEMPT_VERB, scopedKey);
  });
}

/**
 * Send an issued invoice by email (OP4). Renders the PDF, attaches it, dispatches via the injected
 * relay, records `sent_to_email`, and transitions the document to `sent` via A10.
 *
 * THE RULE (US-A11.5): no path here may write a `sent` status record, set `sent_to_email`, or return
 * `transmitted: true` without a real transmission having occurred. Every rejection states
 * `transmitted: false` explicitly, which is the shape the spec words for `needs_email_config`.
 *
 * Honest P9 degradation, status stays `issued` and the PDF stays downloadable in every case:
 *  - `needs_customer_email` (M17): no recipient on file.
 *  - `needs_email_config` (M18): no transport wired at all.
 *  - `needs_email_transport`: `workspace.email_relay` names a relay but no transport is wired. This
 *    used to be the silent failure: it returned a `{ok:true}` STUB, so `sendInvoice` reported
 *    success and appended a `sent` row with no email ever sent. There is no transport in the MIT
 *    core, deliberately (see `EmailRelayPort`), so a configured mode alone can never mean "sent".
 *  - `needs_confirmation` (M15/P8): outbound is draft-by-default.
 *
 * M-2 ordering: the transmission is the ONE irreversible act, so EVERY guard runs before
 * `relay.send`.
 *
 * m-1 ordering (the outbound effect is not transactional): the transport call is made OUTSIDE any
 * transaction, and the intent to call it is committed BEFORE it. A rollback after a successful
 * transmission used to erase the record of it and let the retry send a second email. The attempt
 * record now survives the rollback and drives the retry:
 *  - `dispatching` and no completed result: the outcome is UNKNOWN, so the retry refuses with
 *    `send_outcome_unknown` rather than gambling on a duplicate.
 *  - `transmitted`: the mail definitively went out but its records did not land, so the retry
 *    reconciles by writing them, transmitting nothing.
 *  - an `{ok:false}` transport (nothing left the building) clears the attempt, so a later retry may
 *    transmit once the fault clears.
 */
export function sendInvoice(
  ctx: WorkspaceContext,
  input: { invoiceId: string; email?: string; idempotencyKey?: string; confirmed?: boolean },
): Result {
  // The send's idempotency identity is (this invoice, this key), the transitionDocument pattern.
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.invoiceId, input.idempotencyKey])
      : undefined;

  // Replay a COMPLETED send before any guard: retrying a committed send returns the original result
  // (and transmits nothing) instead of tripping the status guard on `sent`.
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'send_invoice');
    if (replayed !== undefined) return replayed;
  }

  // An unresolved prior attempt outranks every guard below, because it is the one thing that can
  // make a second transport call a duplicate email rather than a first send.
  const priorAttempt = scopedKey === undefined ? undefined : readSendAttempt(ctx, scopedKey);
  if (priorAttempt?.phase === 'dispatching') {
    return err('send_outcome_unknown', {
      documentId: input.invoiceId,
      transmitted: null,
      email: priorAttempt.to,
      reason: 'a prior attempt reached the transport and its outcome is unknown; resolve it by hand',
    });
  }

  const view = getDocument(ctx, { documentId: input.invoiceId });
  if (!view.ok) return view;
  const document = view.document as { type: string; status: string; contactId: string | null };
  if (document.type !== 'invoice') return err('not_an_invoice', { documentId: input.invoiceId, transmitted: false });

  // Status legality BEFORE any side effect: a draft (or cancelled) invoice transmits ZERO emails.
  // This is the same guard the transition inside will re-check; running it first keeps the
  // `illegal_transition` from arriving only after the email left the building.
  const legal = assertTransition(document.status as DocumentStatus, 'sent', 'invoice');
  if (!legal.ok) return { ...legal, transmitted: false };

  // P8 (M15): sending is outbound and draft-by-default. Unless the workspace's `posting.autoIssue`
  // dial is on OR a human passed `confirmed`, the outbound step waits for a human.
  if (!autoSendEnabled(ctx) && input.confirmed !== true) {
    return err('needs_confirmation', {
      documentId: input.invoiceId,
      transmitted: false,
      reason: 'outbound_send_requires_confirmation',
    });
  }

  // M17: resolve the recipient (explicit override, else the contact's email); preserve typed input.
  let email = input.email ?? null;
  if (email === null && document.contactId !== null) {
    const contact = ctx.store.db
      .prepare('SELECT email FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, document.contactId) as { email: string | null } | undefined;
    email = contact?.email ?? null;
  }
  if (email === null || email.length === 0) {
    // G05 §10: an attempt that sent nothing is exactly what the "never arrived" conversation needs
    // to see, so the refusal is logged as a degraded dispatch. Log-only: the refusal is unchanged.
    recordDispatch(ctx, {
      documentKind: 'invoice',
      documentId: input.invoiceId,
      contactId: document.contactId,
      recipientEmail: null,
      channel: 'smtp',
      locale: sendLocaleOf(ctx, input.invoiceId, document.contactId),
      subjectResolved: invoiceEmailSubject(readInvoiceNumber(ctx, input.invoiceId)),
      bodyResolved: '',
      defaulted: true,
      outcome: 'degraded',
      degradeReason: 'needs_customer_email',
    });
    return err('needs_customer_email', { documentId: input.invoiceId, transmitted: false });
  }

  const pdf = renderInvoicePdf(ctx, input.invoiceId);
  if (!pdf.ok) return { ...pdf, transmitted: false };

  // An invoice with no payment part is not one a Swiss customer can pay, and `renderInvoicePdf`
  // returns `ok` for it (the PDF is a valid artifact, it just carries no QR). Sending it anyway is
  // how a false explanation used to reach the customer while the document advanced to `sent`, so
  // this refuses instead, naming the cause the operator has to fix. It fails CLOSED: the failures
  // that reach here are all data defects (no IBAN, an unstructured or incomplete address, a
  // character the IG forbids), never a legitimate "this invoice wants no QR".
  if ((pdf.pdf as { hasQrBill: boolean }).hasQrBill !== true) {
    // The cause comes from the render that just ran, not from a second `buildQrBill` call. The
    // second call was a second source of truth: once the SYMBOL could refuse a payload `buildQrBill`
    // had accepted, re-deriving the cause answered `unknown` for exactly the failure the operator
    // most needs named.
    const gap = (pdf.pdf as { qrUnavailable: { code: string; detail: string } | null }).qrUnavailable;
    return err('needs_qr_bill', {
      documentId: input.invoiceId,
      transmitted: false,
      reason: gap?.code ?? 'unknown',
      detail: gap?.detail ?? 'unknown',
    });
  }
  const invoiceNumber = readInvoiceNumber(ctx, input.invoiceId);
  const to = email;
  // G05 §10: the locale and subject the log row records, resolved once for every path below.
  const sendLocale = sendLocaleOf(ctx, input.invoiceId, document.contactId);
  const sentSubject = invoiceEmailSubject(invoiceNumber);

  /** The post-transmission records, committed as one unit. Never reached without a real send. */
  const recordSent = (): Result => {
    const run = (): Result => {
      ctx.store.db
        .prepare('UPDATE document SET sent_to_email = ? WHERE workspace_id = ? AND id = ?')
        .run(to, ctx.workspaceId, input.invoiceId);
      const transition = transitionDocument(ctx, { documentId: input.invoiceId, to: 'sent' });
      if (!transition.ok) throw new SendAbort(transition);
      // G05 §10: the log row lands IN THE SAME WRITE as the send's own status transition (spec
      // §10.4), so a send that recorded its outcome also recorded its log row, or neither landed.
      // The email that left carried `sentSubject` and the PDF, nothing else: the row records
      // exactly that (`dispatch_text_defaulted:true`; saved texts do not drive sends this pass,
      // spec §0 item 8a).
      recordDispatch(ctx, {
        documentKind: 'invoice',
        documentId: input.invoiceId,
        contactId: document.contactId,
        recipientEmail: to,
        channel: 'smtp',
        locale: sendLocale,
        subjectResolved: sentSubject,
        bodyResolved: '',
        defaulted: true,
        outcome: 'sent',
      });
      return ok({ ...transition, sentToEmail: to, transmitted: true });
    };
    try {
      if (scopedKey !== undefined) {
        const result = ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'send_invoice', run);
        // The completed result is now the durable record; the attempt row has served its purpose.
        clearSendAttempt(ctx, scopedKey);
        return result;
      }
      return ctx.store.tx(run);
    } catch (e) {
      if (e instanceof SendAbort) return { ...e.result, transmitted: true };
      throw e;
    }
  };

  // A prior attempt that definitively TRANSMITTED, whose records did not land: reconcile without
  // touching the transport again.
  if (priorAttempt?.phase === 'transmitted') return recordSent();

  // M18/OP4: the transport. A `workspace.email_relay` mode with nothing wired behind it is named
  // explicitly rather than stubbed, so a configured-but-inert relay can never look like a send.
  const relay = ctx.emailRelay;
  if (relay === undefined) {
    const configured = configuredRelayMode(ctx);
    // G05 §10: a degraded attempt is logged with the verb's own P9 reason before the refusal
    // returns unchanged.
    recordDispatch(ctx, {
      documentKind: 'invoice',
      documentId: input.invoiceId,
      contactId: document.contactId,
      recipientEmail: to,
      channel: 'smtp',
      locale: sendLocale,
      subjectResolved: sentSubject,
      bodyResolved: '',
      defaulted: true,
      outcome: 'degraded',
      degradeReason: configured === null ? 'needs_email_config' : 'needs_email_transport',
    });
    return configured === null
      ? err('needs_email_config', { documentId: input.invoiceId, email, transmitted: false })
      : err('needs_email_transport', {
          documentId: input.invoiceId,
          email,
          transmitted: false,
          configured,
          reason: 'workspace.email_relay names a relay but no transport is wired into the context',
        });
  }

  // Commit the INTENT before the irreversible act, so a crash between the two is recoverable.
  if (scopedKey !== undefined) writeSendAttempt(ctx, scopedKey, { phase: 'dispatching', to });

  // The transport runs OUTSIDE any transaction: an outbound side effect cannot live inside something
  // that can roll back after it. A throw here leaves the attempt at `dispatching` (outcome unknown).
  const sent = relay.send({
    to,
    subject: invoiceEmailSubject(invoiceNumber),
    pdfBase64: (pdf.pdf as { base64: string }).base64,
  });

  if (!sent.ok) {
    // The port contract: `{ok:false}` means nothing left the building, so the intent is retractable
    // and a later retry with the same key may transmit once the fault clears.
    if (scopedKey !== undefined) clearSendAttempt(ctx, scopedKey);
    // G05 §10: the failed attempt is a log row too, with the transport's own reason.
    recordDispatch(ctx, {
      documentKind: 'invoice',
      documentId: input.invoiceId,
      contactId: document.contactId,
      recipientEmail: to,
      channel: 'smtp',
      locale: sendLocale,
      subjectResolved: sentSubject,
      bodyResolved: '',
      defaulted: true,
      outcome: 'failed',
      degradeReason: sent.reason,
    });
    return err('email_send_failed', {
      documentId: input.invoiceId,
      transmitted: false,
      reason: sent.reason,
    });
  }

  // It went out. Record that fact durably BEFORE attempting the bookkeeping, so a fault in the
  // bookkeeping can never be mistaken for "nothing was sent".
  if (scopedKey !== undefined) writeSendAttempt(ctx, scopedKey, { phase: 'transmitted', to });
  return recordSent();
}

/** The configured relay MODE, which is a setting and never by itself a transport. */
function configuredRelayMode(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare('SELECT email_relay AS mode FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { mode: string | null } | undefined;
  return row?.mode == null || row.mode.length === 0 ? null : row.mode;
}

/**
 * G05 §10: the locale a dispatch LOG ROW records for this invoice, resolved through the same
 * template chain the attached PDF renders in (frozen snapshot, else built-in de-CH), so the row's
 * language and its attachment's never disagree. Read-only, log-only: the outbound subject itself
 * stays `invoiceEmailSubject` unchanged this pass (spec §0 item 8a).
 */
function sendLocaleOf(ctx: WorkspaceContext, invoiceId: string, contactId: string | null): string {
  return resolveRenderTemplate(ctx, {
    documentKind: 'invoice',
    table: 'document',
    rowId: invoiceId,
    contactId,
  }).locale;
}

/** The issued invoice's number (the send path only runs post-issue, so it exists). */
function readInvoiceNumber(ctx: WorkspaceContext, invoiceId: string): string {
  const row = ctx.store.db
    .prepare('SELECT number FROM document WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, invoiceId) as { number: string | null } | undefined;
  return row?.number ?? '';
}

/**
 * The outbound email subject (m-4): carries the statutory invoice number, de-CH first (the app's
 * default correspondence language), with an en fallback for a future per-contact language field.
 * There is no workspace/contact language column yet, so de-CH is the deliberate default, not an
 * accident; when E04 (local correspondence) lands a language, this is the one seam to widen.
 */
export function invoiceEmailSubject(invoiceNumber: string, locale: 'de-CH' | 'en' = 'de-CH'): string {
  const templates: Record<'de-CH' | 'en', (n: string) => string> = {
    'de-CH': (n) => (n.length > 0 ? `Rechnung ${n}` : 'Rechnung'),
    en: (n) => (n.length > 0 ? `Invoice ${n}` : 'Invoice'),
  };
  return templates[locale](invoiceNumber);
}

/**
 * The P8 outbound approval dial (M15). `workspace.posting_auto_issue = 1` lets an agent send without a
 * per-invoice human confirmation; 0/NULL (the safe default) makes the outbound step wait.
 */
function autoSendEnabled(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT posting_auto_issue AS v FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { v: number | null } | undefined;
  return row?.v === 1;
}

// The relay port itself lives on `WorkspaceContext` as `EmailRelayPort` (context.ts): a typed,
// injected seam like the clock and the ids, not an untyped cast. There is deliberately NO transport
// in the MIT core, and there is deliberately no stub standing in for one: the `{ok:true}` stub that
// used to answer for a configured `workspace.email_relay` is what let the audit trail lie.
