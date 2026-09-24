/**
 * A16, Debitoren: the OP-Liste, its aging buckets, and the one number that has to be true.
 *
 * This is a pure read model (Pattern P5). It writes nothing to the ledger, writes no document
 * status, and owns exactly one configuration row (`aging_bucket_config`). "Overdue" is a COMPUTED
 * attribute of an issued item past its due date, never a stored status: A10 and A14 own the document
 * lifecycle, and a second copy of "is this paid" is precisely the drift a receivables view exists to
 * make impossible.
 *
 * ## The invariant
 *
 *     baseTotalOpenMinor == the posted balance of account 1100 Debitoren as of the same date
 *
 * That is the whole capability. A table of plausible-looking open amounts that does not tie back to
 * the ledger is a spreadsheet, and an auditor cannot use it. So `reconciled` is REPORTED on every
 * response rather than assumed, and it is computed from two genuinely independent derivations: the
 * open amounts come from `document` and `payment_allocation`, the target comes from `journal_line`.
 * They agree only if they are both right.
 *
 * The invariant is also what makes the read model self-policing as the rest of the suite lands. Any
 * future movement on 1100 that A16 does not model shows up as `reconciled: false` on a real
 * workspace rather than as a silently wrong total, which is the honest failure mode.
 *
 * ## Point in time, from BUSINESS dates
 *
 * A Treuhänder reviewing receivables at a past month-end needs the answer that was true then, and
 * "then" is a business date, not a row's `created_at`. So membership and settlement are both decided
 * from the dates the LEDGER uses:
 *
 *  - a document is a receivable as of `asOf` when its posted entry is dated on or before `asOf`, and
 *    no posted reversal of that entry is dated on or before `asOf` (which is how a cancelled invoice
 *    stops being a receivable on the day it was actually cancelled, not retroactively);
 *  - an allocation counts when the PAYMENT carrying it is dated on or before `asOf` and has not been
 *    reversed by an entry dated on or before `asOf`.
 *
 * A parked credit allocated later by `allocate_payment` is attributed to its payment's date, because
 * that is the day the money arrived and A14 posts nothing further when the credit is applied. The
 * grand total is unaffected either way (the allocation moves an amount from the on-account row to a
 * document row and 1100 never moves), so the reconciliation holds; only the per-row split of a
 * historical read shows the later shape.
 *
 * ## Credit notes (A13, D68)
 *
 *  An issued Gutschrift is a NEGATIVE open item (direction `outgoing`) carrying
 *  `creditedDocumentId`: the ROW model keeps the un-netted claim and its offset apart, because the
 *  invoice is what legally carries the claim. What IS netted is the AGING (D68, decided
 *  31.07.2026): a linked credit's BUCKET is the bucket of the invoice it offsets, so the per-bucket
 *  totals state the overdue exposure that is really out there, and a credit never files into
 *  `0-30` on its own issue date while its 90+ invoice reports gross. A credit whose invoice has no
 *  open row left keeps the first bucket. The invoice row additionally carries `creditedOpenMinor`
 *  (the sum of its linked credits' open offsets), which is the read A15's chaseable-amount
 *  arithmetic needs (`openMinor - creditedOpenMinor - fee`), so dunning never re-derives the join.
 *
 * ## What is NOT modelled, and why that is stated rather than stubbed
 *
 *  - **Dunning levels and booked Mahngebühren** (A15, landed): A16 READS A15's state and never
 *    forks it. `dunningLevel` is the highest ISSUED level for the document as of the date, and a
 *    BOOKED Mahngebühr (A15 debits it to 1100, `source='dunning'`) joins its document's open item
 *    as an as-of event sum over posted, unreversed fee entries, the same date discipline every
 *    other figure here follows. Without that second half every issued fee would flip `reconciled`
 *    to false, which is this file's honest failure mode doing its job; with it, the fee is part of
 *    what the customer owes and the total still ties to the ledger. A fee whose document has since
 *    been cancelled keeps its own row (the claim survives the invoice's reversal until the fee
 *    entry is itself reversed). A ROW WHOSE OPEN AMOUNT IS ONLY FEE IS NOT DUNNABLE (A15 critic
 *    C3/C4): A15's `chaseableItems` requires `openMinor - dunningFeeMinor > 0`, so a paid or
 *    cancelled invoice's residual fee is never chased by a letter under the invoice's name; it
 *    stays visible HERE as `dunningFeeMinor`, and its remedies are `reverse_entry` on the fee
 *    entry or ordinary collection. THE GAP RECORDED IN A15 §4 PER D59 IS CLOSED: `payment_allocation`
 *    now admits `target_kind = 'dunning_fee'`, naming the FEE (its own `dunning_item` row) rather
 *    than the invoice it rides, so a payment covering invoice + fee allocates BOTH in one call and
 *    the fee row genuinely CLOSES instead of parking as an unrelated Guthaben. `dunningFeeSettledAsOf`
 *    nets a fee's settlement out of `dunningFeeMinor` the same as-of way `allocationsAsOf` nets a
 *    document's, so a paid-off fee drops off this read the moment its payment posts, and the
 *    reconciliation invariant covers it exactly as it always covered the booking.
 *  - **The D68/A15 composition order is load-bearing** (A15 critic N3, honoured in this merge):
 *    the credit netting lands inside `collectOpenItems` BEFORE the Mahngebühr addition, because
 *    A15's overdue detection and its QR payment parts read `openMinor` from exactly this
 *    derivation, and the chaseable amount is `openMinor - dunningFeeMinor`, which therefore nets
 *    linked credits by construction.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalDate, optionalId, requireString } from '../ledger/inputGuards.js';
import { baseCurrencyOf, resolveFxRate } from '../fx/rates.js';
import { parseRate, convertMinor } from '../fx/rateMath.js';
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';
// C00's ONE read-side contact resolver. A16 reads two contact ids (a document's `contact_id`, which a
// merge re-points, and a payment's `counterparty_id`, which A14's immutability trigger freezes) and it
// has to answer for a merged customer as ONE party in both cases: a balance and an aging bucket split
// across a tombstone and its survivor is exactly the splitting C00 exists to end.
import { resolveContactRef } from '../sales/contact.js';
import type { ResolvedContactRef } from '../sales/contact.js';
// A15's ONE "is this booked fee LIVE" predicate, and its shared display label (critic C1/C2/N6 on
// A14's `dunning_fee` allocation target). Imported from the file directly, never the `dunning`
// barrel: the barrel re-exports `run.ts`, which imports THIS module (`../debtors/index.js`), so
// going through it would close a cycle. `reads.ts` itself imports nothing from debtors or payments,
// so this edge is one-way.
import { liveDunningFeeItemsAsOf, dunningFeeLabel } from '../dunning/reads.js';

/** The reconciliation target (§3, fixed): Kontenrahmen KMU 1100 Debitoren, from the one enum point. */
const RECEIVABLE_ACCOUNT = ROLE_ACCOUNT_NUMBER.receivable;

/**
 * The shipped bucket boundaries: 0-30 / 31-60 / 61-90 / 90+ (§3).
 *
 * The standard Swiss and DACH OP-Liste convention, and explicitly NOT a statutory figure, which is
 * why §6b makes it configurable. Verzug and Mahnwesen deadlines are OR Art. 102 ff. and belong to
 * A15; nothing here treats 30 days as a legal period.
 */
export const DEFAULT_AGING_BOUNDARIES: readonly number[] = [30, 60, 90];

// --- Aging buckets --------------------------------------------------------------------------------

/**
 * The bucket keys for a boundary set, as locale-neutral machine keys (P11).
 *
 * `[30, 60, 90]` yields `0-30`, `31-60`, `61-90`, `90+`. The keys are derived from the boundaries
 * rather than hardcoded, because the bucket COUNT is the thing §6b makes configurable: a fixed set
 * of four labels would quietly mislabel a workspace that chose three or five. The GUI renders these
 * through its own catalogue (`debtors.aging.*`), so no display string is minted here.
 */
export function bucketKeys(boundaries: readonly number[]): string[] {
  const keys: string[] = [];
  for (const [i, boundary] of boundaries.entries()) {
    keys.push(i === 0 ? `0-${boundary}` : `${boundaries[i - 1]! + 1}-${boundary}`);
  }
  keys.push(`${boundaries[boundaries.length - 1]!}+`);
  return keys;
}

/** The bucket a given overdue age falls into. Not-yet-due is age 0, so it lands in the first bucket. */
function bucketFor(daysOverdue: number, boundaries: readonly number[], keys: readonly string[]): string {
  for (const [i, boundary] of boundaries.entries()) {
    if (daysOverdue <= boundary) return keys[i]!;
  }
  return keys[keys.length - 1]!;
}

/** Whole days between two ISO dates, in UTC. Both are calendar dates, so no clock arithmetic. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// --- The bucket configuration (§6b, the one write) ------------------------------------------------

interface ConfigRow {
  boundaries_days_json: string;
  idempotency_key: string | null;
  updated_at: string;
}

function readConfigRow(ctx: WorkspaceContext): ConfigRow | undefined {
  return ctx.store.db
    .prepare('SELECT boundaries_days_json, idempotency_key, updated_at FROM aging_bucket_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as ConfigRow | undefined;
}

/**
 * The workspace's boundaries, or the default when it has never configured any.
 *
 * A stored value that fails validation (hand-edited file, a future version's shape) falls back to
 * the default rather than throwing: a malformed view preference must not take the receivables list
 * down with it, and the total is identical either way because bucketing only re-partitions it (P9).
 */
export function agingBoundariesOf(ctx: WorkspaceContext): number[] {
  const row = readConfigRow(ctx);
  if (row === undefined) return [...DEFAULT_AGING_BOUNDARIES];
  try {
    const parsed: unknown = JSON.parse(row.boundaries_days_json);
    return validateBoundaries(parsed) === null ? (parsed as number[]) : [...DEFAULT_AGING_BOUNDARIES];
  } catch {
    return [...DEFAULT_AGING_BOUNDARIES];
  }
}

/** A strictly increasing list of positive integers, or the reason it is not one. */
function validateBoundaries(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return 'a non-empty list of day counts';
  let previous = 0;
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || (entry as number) <= 0) return 'positive whole day counts';
    if ((entry as number) <= previous) return 'strictly increasing day counts';
    previous = entry as number;
  }
  return null;
}

export function getAgingBucketConfig(ctx: WorkspaceContext): Result {
  const row = readConfigRow(ctx);
  return ok({
    boundariesDays: agingBoundariesOf(ctx),
    // Which of "never configured" and "deliberately chose these" the caller is looking at. The GUI
    // needs the difference to decide whether its popover shows a default or a choice.
    configured: row !== undefined,
    bucketKeys: bucketKeys(agingBoundariesOf(ctx)),
  });
}

export interface SetAgingBucketConfigInput {
  boundariesDays?: unknown;
  idempotencyKey?: string;
}

/**
 * Redefine where the aging buckets cut (§6b). The only write this capability performs.
 *
 * §H-IDEMPOTENT through the STORE's idempotency table, exactly like every other key-carrying write
 * in the engine. That is not a stylistic preference: the key cannot live on the config row, because
 * `workspace_id` is that row's PRIMARY KEY and the write replaces it in place, so the row remembers
 * only the MOST RECENT key. A late retry of an older key would then be unrecognisable as a replay
 * and would silently roll a newer edit back, which is the one failure an idempotency key exists to
 * prevent. The side table remembers every key the workspace has completed, so an out-of-order retry
 * replays its own original answer and writes nothing.
 *
 * The replay is byte-identical because `recallIdempotent` returns the stored Result verbatim: a
 * retrying client must not be able to tell that it retried, so there is no `replayed` discriminator.
 *
 * The row itself is still replaced in place under a new key, never appended, because a view
 * preference is current rather than historical.
 */
export function setAgingBucketConfig(ctx: WorkspaceContext, input: SetAgingBucketConfigInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const key = input.idempotencyKey as string;

  // Replay a completed call BEFORE validating, the order postEntry and createCostCenter use, so a
  // retry never re-runs a guard that the first call already got past.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'set_aging_bucket_config');
  if (replayed !== undefined) return replayed;

  const invalid = validateBoundaries(input.boundariesDays);
  if (invalid !== null) return err('invalid_input', { field: 'boundariesDays', expected: invalid });
  const boundaries = input.boundariesDays as number[];

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'set_aging_bucket_config', () => {
    ctx.store.db
      .prepare(
        `INSERT INTO aging_bucket_config (workspace_id, boundaries_days_json, idempotency_key, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           boundaries_days_json = excluded.boundaries_days_json,
           idempotency_key      = excluded.idempotency_key,
           updated_at           = excluded.updated_at`,
      )
      .run(ctx.workspaceId, JSON.stringify(boundaries), key, ctx.clock.now());

    return ok({ boundariesDays: boundaries, bucketKeys: bucketKeys(boundaries) });
  });
}

// --- The read model --------------------------------------------------------------------------------

/**
 * Which way the cash on a row moves, from A14's own `payment.direction` enum (§6b fixed).
 *
 * NOT a restatement of the sign, and a caller that treats it as one will be wrong. Sign is decided
 * by the PAIR: an incoming document row is positive (an unpaid invoice is money owed to us), an
 * incoming parked payment is negative (a Guthaben the customer holds), and an outgoing parked
 * payment is positive (a refund paid out and not yet matched, which increases the receivable). The
 * field exists so that no consumer ever has to run that table backwards from a number.
 */
export type OpenItemDirection = 'incoming' | 'outgoing';

export interface OpenItem {
  /** `document` for an unpaid invoice, `on_account` for a parked customer payment (US-A16.3). */
  kind: 'document' | 'on_account';
  /**
   * The direction the cash moves, ALWAYS present (finding F13).
   *
   * An `on_account` row exists for outgoing payments as well as incoming ones, and the two carry
   * opposite signs, so a surface that labelled every parked row "Guthaben" stated the opposite of
   * the fact for half of them. Before this field the only way to tell them apart was to read the
   * sign of `openMinor`, which is exact and fragile: it is the kind of inference that survives
   * review and then gets made backwards once. Deriving it here costs nothing, because the payment
   * row the item is built from already carries it.
   */
  direction: OpenItemDirection;
  documentId: string | null;
  paymentId: string | null;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  grossMinor: number;
  paidMinor: number;
  openMinor: number;
  baseOpenMinor: number;
  daysOverdue: number;
  overdue: boolean;
  bucket: string;
  /** A15's dunning state: the highest ISSUED level for this document as of the date (0 = never mahnt). Read, never forked (§6b fixed). */
  dunningLevel: number;
  /**
   * The BOOKED Mahngebühr still riding this document (A15), included in `openMinor` and
   * `baseOpenMinor`, reported separately so a surface can say which part of the open amount is fee.
   * Always 0 on an `on_account` row, and always base-currency (A15 books fees in base only).
   */
  dunningFeeMinor: number;
  /** A13: the invoice a credit-note row offsets; null on every other row. */
  creditedDocumentId: string | null;
  /** D68: on an INVOICE row, the sum of its linked credits' open offsets (a positive figure); 0
   *  elsewhere. The read A15's chaseable-amount arithmetic composes on. */
  creditedOpenMinor: number;
}

interface DocRow {
  id: string;
  type: 'invoice' | 'credit_note';
  number: string | null;
  status: string;
  contact_id: string | null;
  contact_name: string | null;
  currency: string;
  total_minor: number;
  issue_date: string | null;
  due_date: string | null;
  /** NULL for a G21 migrated open item (it posts nothing); a native receivable always carries one. */
  posted_entry_id: string | null;
  credited_document_id: string | null;
  /** G21: `native` or `migrated`. A migrated receivable is counted from its stored `total_minor`,
   *  since it has no posted entry to read a base figure off. */
  origin: string;
}

interface AllocRow {
  target_id: string;
  amount_minor: number;
  base_amount_minor: number;
  skonto_minor: number;
  skonto_vat_minor: number;
  writeoff_minor: number;
}

interface OnAccountRow {
  id: string;
  direction: string;
  currency: string;
  fx_rate: string | null;
  amount_minor: number;
  allocated_minor: number;
  counterparty_id: string | null;
  counterparty_name: string | null;
  date: string;
}

/**
 * Documents that are receivables as of `asOf`, decided entirely from ledger dates.
 *
 * The reversal clause is what makes a CANCELLED invoice behave: A10 cancels by reversing the posted
 * entry (§H-AUDIT, never a delete), so the document stops being a receivable on the date that
 * reversal is dated and not one day earlier. Filtering on today's `document.status` instead would
 * retroactively erase a receivable that was genuinely outstanding at a past cut-off, and the
 * reconciliation would fail on exactly the historical review a Treuhänder asked for.
 */
function receivableDocuments(ctx: WorkspaceContext, asOf: string): DocRow[] {
  return ctx.store.db
    .prepare(
      `SELECT d.id, d.type, d.number, d.status, d.contact_id, c.name AS contact_name, d.currency,
              d.total_minor, d.issue_date, d.due_date, d.posted_entry_id, d.credited_document_id, d.origin
         FROM document d
         LEFT JOIN contact c ON c.id = d.contact_id AND c.workspace_id = ?
        WHERE d.workspace_id = ?
          AND d.type IN ('invoice', 'credit_note')
          AND (
            -- Native receivables: decided entirely from ledger dates off the posted entry, exactly
            -- as before (this branch is byte-identical to the pre-G21 query; a migrated row has a
            -- NULL posted_entry_id so it never matches here).
            (d.posted_entry_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM journal_entry e
                           WHERE e.id = d.posted_entry_id AND e.workspace_id = d.workspace_id
                             AND e.status = 'posted' AND e.date <= ?)
              AND NOT EXISTS (SELECT 1 FROM journal_entry r
                               WHERE r.workspace_id = d.workspace_id
                                 AND r.reverses_entry_id = d.posted_entry_id
                                 AND r.status = 'posted' AND r.date <= ?))
            OR
            -- G21 migrated open items: they post nothing, so membership is the document's OWN dates.
            -- A migrated item is a receivable as of asOf when it issued on or before asOf and is
            -- still in a live-OPEN status. It is corrected by reversal in A04's opening journal plus
            -- a status='cancelled' mark (never a destructive edit), so a cancelled/converted/draft
            -- migrated row drops out here the same day. 'settled' is EXCLUDED too: a live-imported,
            -- already-settled prior-year item (D112 Q2 'live' path) posts nothing AND nets to zero
            -- open by never being counted here, so it never double-recognises revenue. There is NO
            -- origin BRANCH in the arithmetic below: a migrated receivable is counted from total_minor
            -- like any other.
            (d.origin = 'migrated'
              AND d.status NOT IN ('draft', 'cancelled', 'converted', 'settled')
              AND d.issue_date IS NOT NULL AND d.issue_date <= ?)
          )`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, asOf, asOf, asOf) as DocRow[];
}

/**
 * Every allocation in force as of `asOf`, §H-TENANT on BOTH sides of the join.
 *
 * The payment and the allocation are each scoped to this workspace, exactly as A14's `settledMinor`
 * does it, so a foreign payment can never reduce a local invoice's open amount. A reversed payment
 * drops out from the date its reversing ENTRY is dated, which is how a reversal re-opens the
 * documents it touched without a single allocation row being rewritten.
 */
function allocationsAsOf(ctx: WorkspaceContext, asOf: string): AllocRow[] {
  return ctx.store.db
    .prepare(
      `SELECT a.target_id, a.amount_minor, a.base_amount_minor, a.skonto_minor,
              a.skonto_vat_minor, a.writeoff_minor
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
        WHERE a.workspace_id = ? AND a.target_kind = 'document'
          AND p.date <= ?
          AND (p.reversal_entry_id IS NULL
               OR (SELECT e.date FROM journal_entry e WHERE e.id = p.reversal_entry_id) > ?)`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, asOf, asOf) as AllocRow[];
}

/** Payments in force as of `asOf` with their allocated cash, so the parked remainder is derivable. */
function paymentsAsOf(ctx: WorkspaceContext, asOf: string): OnAccountRow[] {
  return ctx.store.db
    .prepare(
      `SELECT p.id, p.direction, p.currency, p.fx_rate, p.amount_minor, p.date,
              p.counterparty_id, c.name AS counterparty_name,
              COALESCE((SELECT SUM(a.payment_amount_minor) FROM payment_allocation a
                         WHERE a.workspace_id = p.workspace_id AND a.payment_id = p.id), 0) AS allocated_minor
         FROM payment p
         LEFT JOIN contact c ON c.id = p.counterparty_id AND c.workspace_id = p.workspace_id
        WHERE p.workspace_id = ?
          AND (p.counterparty_kind IS NULL OR p.counterparty_kind = 'customer')
          AND p.date <= ?
          AND (p.reversal_entry_id IS NULL
               OR (SELECT e.date FROM journal_entry e WHERE e.id = p.reversal_entry_id) > ?)`,
    )
    .all(ctx.workspaceId, asOf, asOf) as OnAccountRow[];
}

interface DunningFeeRow {
  document_id: string;
  debtor_id: string;
  number: string | null;
  due_date: string | null;
  fee_minor: number;
}

interface DunningFeeItemSettlementRow {
  item_id: string;
  document_id: string;
  debtor_id: string;
  number: string | null;
  due_date: string | null;
  level: number;
  settled_minor: number;
}

/**
 * The booked Mahngebühr already SETTLED by a payment, PER `dunning_item` (critic N5, re-critic on
 * the A14 dunning-fee allocation target). Same as-of discipline as `allocationsAsOf` (§H-TENANT on
 * both sides of the join): a settlement counts when its PAYMENT is dated on or before `asOf` and has
 * not been reversed by an entry dated on or before `asOf`.
 *
 * KEYED ON THE ITEM, NEVER THE DOCUMENT. A document-keyed version (this file's shape until N5) let
 * two fees on ONE invoice net against EACH OTHER: a live, unsettled level-1 fee and a settled,
 * then-reversed level-2 fee summed to one document-level figure, and a live 2000 reported
 * `dunningFeeMinor: 0` while an unrelated -1000 "orphan" absorbed the difference. Reconciliation and
 * A15's chaseable principal stayed correct in AGGREGATE (equal and opposite errors), which is
 * exactly why it went unnoticed: the misstatement was on the SPLIT, not the sum. Per-item targeting
 * is the entire premise of this increment (a `dunningItemId`, not a `documentId`, per D59), and A15
 * escalates 1 -> 2 -> 3 with a fee per run, so a second booked fee on one invoice is the NORMAL case,
 * not an edge one. Netting per item first (in `collectOpenItems` below) and aggregating to the
 * document only AFTER is what keeps two fees from ever touching each other's figures.
 *
 * Deliberately UNCONDITIONAL on the fee's own liveness: this is cash that landed on 1100, and it
 * stays counted here whether or not the fee it named is still live, because the netting below (C2)
 * has to know the full settled amount to tell a fully-paid fee apart from one over-settled by a
 * later reversal.
 */
function dunningFeeSettledByItemAsOf(ctx: WorkspaceContext, asOf: string): Map<string, DunningFeeItemSettlementRow> {
  const rows = ctx.store.db
    .prepare(
      `SELECT a.target_id AS item_id, i.document_id AS document_id, i.debtor_id AS debtor_id,
              i.number AS number, i.due_date AS due_date, i.level AS level,
              COALESCE(SUM(a.amount_minor + a.skonto_minor + a.skonto_vat_minor + a.writeoff_minor), 0) AS settled
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
         JOIN dunning_item i ON i.id = a.target_id AND i.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.target_kind = 'dunning_fee'
          AND p.date <= ?
          AND (p.reversal_entry_id IS NULL
               OR (SELECT e.date FROM journal_entry e WHERE e.id = p.reversal_entry_id) > ?)
        GROUP BY a.target_id`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, asOf, asOf) as {
    item_id: string;
    document_id: string;
    debtor_id: string;
    number: string | null;
    due_date: string | null;
    level: number;
    settled: number;
  }[];
  return new Map(
    rows.map((r) => [
      r.item_id,
      {
        item_id: r.item_id,
        document_id: r.document_id,
        debtor_id: r.debtor_id,
        number: r.number,
        due_date: r.due_date,
        level: r.level,
        settled_minor: r.settled,
      },
    ]),
  );
}

interface OrphanedFeeSettlement {
  documentId: string;
  debtorId: string;
  number: string | null;
  dueDate: string | null;
  level: number;
  amountMinor: number;
}

interface DunningFeeState {
  /** Per document: the sum of every LIVE fee's own remaining (`feeMinor` minus that SAME item's
   *  settled amount), never one item's remainder absorbing another's. */
  feesByDoc: Map<string, DunningFeeRow>;
  /** ONE row per non-live item that still carries a settlement (critic N5/N6: never merged across
   *  items, so a reader can tell which escalation level's fee the credit came from). */
  orphanedSettlements: OrphanedFeeSettlement[];
}

/**
 * The fee state a document's open item is built from, netted PER `dunning_item` (critic N5) from the
 * ONE shared "is this fee live" predicate (`liveDunningFeeItemsAsOf`, `src/core/dunning/reads.ts`)
 * that A14's `readTarget` also consults (critic C1/C2): the read model and the settlement planner
 * used to carry two different definitions of "a live booked fee", and there is now exactly one,
 * imported, never restated.
 *
 * Two passes, because a LIVE item's own remainder and an ORPHANED item's own settlement are two
 * different facts and must never be netted against each other, on pain of exactly the N5 defect:
 *  1. every LIVE item contributes its OWN `feeMinor - settled` to its document (guaranteed >= 0: the
 *     A14 allocation guard never lets a live item's settled amount exceed its own face);
 *  2. every settlement whose OWN item is NOT live (reversed, or not yet booked, which cannot itself
 *     carry a settlement) contributes its FULL settled amount as an orphaned credit: the claim is
 *     gone, the cash on 1100 is not.
 */
function dunningFeeStateAsOf(ctx: WorkspaceContext, asOf: string): DunningFeeState {
  const liveItems = liveDunningFeeItemsAsOf(ctx, asOf);
  const settledByItem = dunningFeeSettledByItemAsOf(ctx, asOf);

  const feesByDoc = new Map<string, DunningFeeRow>();
  for (const item of liveItems) {
    const itemSettled = settledByItem.get(item.id)?.settled_minor ?? 0;
    const remaining = item.feeMinor - itemSettled;
    if (remaining <= 0) continue;
    const row = feesByDoc.get(item.documentId) ?? {
      document_id: item.documentId,
      debtor_id: item.debtorId,
      number: item.number,
      due_date: item.dueDate,
      fee_minor: 0,
    };
    row.fee_minor += remaining;
    feesByDoc.set(item.documentId, row);
  }

  // ONE row per item (critic N6: never merged), so a document that lost two different levels'
  // fees to a reversal shows two distinct, correctly-labelled rows rather than one blended figure.
  const liveItemIds = new Set(liveItems.map((i) => i.id));
  const orphanedSettlements: OrphanedFeeSettlement[] = [];
  for (const settlement of settledByItem.values()) {
    if (liveItemIds.has(settlement.item_id) || settlement.settled_minor <= 0) continue;
    orphanedSettlements.push({
      documentId: settlement.document_id,
      debtorId: settlement.debtor_id,
      number: settlement.number,
      dueDate: settlement.due_date,
      level: settlement.level,
      amountMinor: settlement.settled_minor,
    });
  }

  return { feesByDoc, orphanedSettlements };
}

/** The highest ISSUED dunning level per document as of `asOf`: A15's state machine, read-only. */
function dunningLevelsAsOf(ctx: WorkspaceContext, asOf: string): Map<string, number> {
  const rows = ctx.store.db
    .prepare(
      `SELECT i.document_id AS documentId, MAX(i.level) AS level
         FROM dunning_item i
         JOIN dunning_run r ON r.id = i.run_id AND r.workspace_id = i.workspace_id
        WHERE i.workspace_id = ? AND r.status IN ('issued', 'sent') AND r.run_date <= ?
        GROUP BY i.document_id`,
    )
    .all(ctx.workspaceId, asOf) as { documentId: string; level: number }[];
  return new Map(rows.map((r) => [r.documentId, r.level]));
}

/**
 * A proportional share of a document's booked base value, rounded half away from zero (P2).
 *
 * The same arithmetic A14 applies when it books a settlement, so the base an item still carries is
 * the base the ledger released it at. Integer throughout: no float touches this path.
 */
function baseShare(bookedBaseMinor: number, partMinor: number, totalMinor: number): number {
  if (totalMinor === 0 || bookedBaseMinor === totalMinor) return partMinor;
  const sign = partMinor < 0 ? -1 : 1;
  const a = Math.abs(bookedBaseMinor * partMinor);
  return sign * Math.floor((a + Math.trunc(totalMinor / 2)) / totalMinor);
}

/**
 * The base-currency value a document's receivable actually carries, read off its OWN posted entry.
 *
 * Never re-converted at today's rate: A16 shows what the books hold and A22 owns revaluation (§3).
 * A base-currency document short-circuits to its face amount, so the ordinary Swiss invoice costs no
 * query at all.
 */
function documentBookedBase(ctx: WorkspaceContext, doc: DocRow, baseCurrency: string): number {
  if (doc.currency === baseCurrency) return doc.total_minor;
  // G21: a migrated open item has no posted entry to read a base figure off. It is valued in base by
  // resolving the admissible rate at its own issue date (import refused the row if no rate existed at
  // the Stichtag, §H-FX, so a rate is present). This is best-effort: TILL stores no base column on a
  // document, so a foreign migrated item that does not tie out surfaces honestly as a red ar_control
  // rather than a silently wrong total. A base-currency migration (the common Swiss case) is exact.
  if (doc.posted_entry_id === null) {
    if (doc.origin === 'migrated' && doc.issue_date !== null) {
      const resolution = resolveFxRate(ctx, { currency: doc.currency, date: doc.issue_date });
      if (resolution.ok) return convertMinor(doc.total_minor, resolution.resolved.rateScaled);
    }
    return doc.total_minor;
  }
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ? AND a.number = ?`,
    )
    .get(doc.posted_entry_id, ctx.workspaceId, RECEIVABLE_ACCOUNT) as { net: number };
  return row.net === 0 ? doc.total_minor : Math.abs(row.net);
}

/**
 * The posted balance of 1100 Debitoren as of a date: the reconciliation target, from the ledger.
 *
 * Deliberately NOT derived from anything the open-item side touches. This is the second opinion, and
 * a second opinion that shares a code path with the first is not one.
 */
export function receivablesBalanceAsOf(ctx: WorkspaceContext, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(ctx.workspaceId, RECEIVABLE_ACCOUNT, asOf) as { net: number };
  return row.net;
}

/**
 * A memoised `resolveContactRef` for one read.
 *
 * The resolution is per-ROW on a list that can carry hundreds, and the same handful of customers
 * repeat across them, so the walk runs once per distinct id rather than once per item.
 */
function contactResolver(ctx: WorkspaceContext): (id: string | null) => ResolvedContactRef | null {
  const memo = new Map<string, ResolvedContactRef | null>();
  return (id: string | null) => {
    if (id === null || id.length === 0) return null;
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const resolved = resolveContactRef(ctx, id);
    memo.set(id, resolved);
    return resolved;
  };
}

/** Every open item in the workspace as of `asOf`, unfiltered: the one derivation all three verbs read. */
function collectOpenItems(ctx: WorkspaceContext, asOf: string, boundaries: number[]): OpenItem[] {
  const keys = bucketKeys(boundaries);
  const baseCurrency = baseCurrencyOf(ctx);
  const resolve = contactResolver(ctx);

  const settled = new Map<string, { faceMinor: number; baseMinor: number }>();
  const docs = receivableDocuments(ctx, asOf);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const bookedBase = new Map<string, number>();
  for (const doc of docs) bookedBase.set(doc.id, documentBookedBase(ctx, doc, baseCurrency));

  for (const a of allocationsAsOf(ctx, asOf)) {
    const doc = byId.get(a.target_id);
    if (doc === undefined) continue;
    const face = a.amount_minor + a.skonto_minor + a.skonto_vat_minor + a.writeoff_minor;
    // The base a settlement RELEASED from 1100. The cash share is read off the allocation row, which
    // is the figure A14 booked; the non-cash reductions (Skonto, its VAT, a write-off) carry no base
    // column of their own, so their share is recomputed with A14's own proportional rule. For a
    // base-currency document, the overwhelming case, every share is the identity and this is exact.
    const nonCash = a.skonto_minor + a.skonto_vat_minor + a.writeoff_minor;
    const base =
      a.base_amount_minor + (nonCash === 0 ? 0 : baseShare(bookedBase.get(doc.id)!, nonCash, doc.total_minor));
    const prior = settled.get(a.target_id) ?? { faceMinor: 0, baseMinor: 0 };
    settled.set(a.target_id, { faceMinor: prior.faceMinor + face, baseMinor: prior.baseMinor + base });
  }

  // A15's fee state (critic C1/C2/N5): the booked, LIVE fee total each document still carries,
  // netted PER ITEM so two fees on one invoice can never net against each other, plus any cash
  // settled against a fee that stopped being live. See `dunningFeeStateAsOf`'s own docblock.
  const { feesByDoc, orphanedSettlements } = dunningFeeStateAsOf(ctx, asOf);
  const dunningLevels = dunningLevelsAsOf(ctx, asOf);

  const items: OpenItem[] = [];
  for (const doc of docs) {
    const paid = settled.get(doc.id) ?? { faceMinor: 0, baseMinor: 0 };
    // A13: a Gutschrift is the OUTGOING case, a negative open item. Its face figures are stored
    // positive (the sign lives in the posting), so the row negates them; a refund payout (an A14
    // outgoing allocation against the credit note) reduces the magnitude exactly as a receipt
    // reduces an invoice's. It is never overdue: it is an offset, not a claim, and it never
    // carries a Mahngebühr (A15 fees ride the invoice they chase).
    const isCredit = doc.type === 'credit_note';
    const sign = isCredit ? -1 : 1;
    // The booked Mahngebühr is part of what this customer owes on this document, and it is what
    // keeps the total tied to 1100 once a fee entry has debited it. A15 books fees in the BASE
    // currency and only onto base-currency documents, so the face and base additions are the same
    // integer. The row is consumed from the map: a fee whose document dropped out of the
    // receivable set (a cancelled invoice) surfaces as its own row below instead of vanishing.
    const feeMinor = isCredit ? 0 : (feesByDoc.get(doc.id)?.fee_minor ?? 0);
    if (!isCredit) feesByDoc.delete(doc.id);
    const openMinor = doc.total_minor - paid.faceMinor + feeMinor;
    if (openMinor === 0) continue;
    const daysOverdue =
      isCredit || doc.due_date === null ? 0 : Math.max(0, daysBetween(doc.due_date, asOf));
    // A document's `contact_id` IS re-pointed by a merge, so this is normally the identity. It goes
    // through the resolver anyway: the FK re-point list is a list somebody has to remember to extend,
    // and a read model that resolves is correct whether or not that list is complete.
    const docParty = resolve(doc.contact_id);
    items.push({
      kind: 'document',
      direction: isCredit ? 'outgoing' : 'incoming',
      documentId: doc.id,
      paymentId: null,
      number: doc.number,
      customerId: docParty?.id ?? doc.contact_id,
      customerName: docParty?.name ?? doc.contact_name,
      issueDate: doc.issue_date,
      dueDate: isCredit ? null : doc.due_date,
      currency: doc.currency,
      grossMinor: sign * doc.total_minor,
      paidMinor: sign * paid.faceMinor,
      openMinor: sign * openMinor,
      baseOpenMinor: sign * (bookedBase.get(doc.id)! - paid.baseMinor + feeMinor),
      daysOverdue,
      overdue: daysOverdue > 0,
      // A linked credit's bucket is remapped to its invoice's below (D68); this is the fallback.
      bucket: isCredit ? keys[0]! : bucketFor(daysOverdue, boundaries, keys),
      dunningLevel: isCredit ? 0 : (dunningLevels.get(doc.id) ?? 0),
      dunningFeeMinor: feeMinor,
      creditedDocumentId: isCredit ? doc.credited_document_id : null,
      creditedOpenMinor: 0,
    });
  }

  // Booked fees whose DOCUMENT is no longer a receivable (a cancelled invoice whose reversal is
  // dated on or before asOf). The fee claim survives the invoice's reversal until the fee entry is
  // itself reversed, and 1100 still carries it, so it gets its own row rather than a silent hole
  // in the reconciliation. The remedy the row points at is `reverse_entry` on the fee entry.
  for (const fee of feesByDoc.values()) {
    const daysOverdue = fee.due_date === null ? 0 : Math.max(0, daysBetween(fee.due_date, asOf));
    const party = resolve(fee.debtor_id);
    items.push({
      kind: 'document',
      direction: 'incoming',
      documentId: fee.document_id,
      paymentId: null,
      number: fee.number,
      customerId: party?.id ?? fee.debtor_id,
      customerName: party?.name ?? null,
      issueDate: null,
      dueDate: fee.due_date,
      currency: baseCurrency,
      grossMinor: fee.fee_minor,
      paidMinor: 0,
      openMinor: fee.fee_minor,
      baseOpenMinor: fee.fee_minor,
      daysOverdue,
      overdue: daysOverdue > 0,
      bucket: bucketFor(daysOverdue, boundaries, keys),
      dunningLevel: dunningLevels.get(fee.document_id) ?? 0,
      dunningFeeMinor: fee.fee_minor,
      creditedDocumentId: null,
      creditedOpenMinor: 0,
    });
  }

  // Settlements whose fee has gone (critic C2's fix, the mirror of the orphan-fee-row loop above):
  // a payment settled a booked Mahngebühr, and its own booking entry was reversed AFTERWARD (A15
  // §4's stated remedy for a residual fee, applied to one the customer had already paid). Reversing
  // the BOOKING does not reverse the PAYMENT, so the cash the customer sent never left 1100: it
  // surfaces here as its own NEGATIVE `on_account` row rather than vanishing from the reconciliation
  // the way it did before that fix.
  //
  // SELF-DESCRIBING (critic N6): a plain over-payment and this row look identical in every FIGURE
  // (same sign, same shape), and the only thing that tells them apart is what they are CALLED. The
  // `number` field is `dunningFeeLabel`, the SAME label `readTarget` and `mapAllocation` render for
  // the live fee, so a reader sees "R-2026-0001 Mahngebühr Stufe 1" here and can tell at a glance
  // this is a written-off Mahngebühr, never a customer's unexplained overpayment. `paymentId` is
  // null because more than one payment, or a payment plus a later reversal, can compose the figure;
  // `documentId` still names the invoice the fee rode, for traceability.
  for (const orphan of orphanedSettlements) {
    const party = resolve(orphan.debtorId);
    items.push({
      kind: 'on_account',
      direction: 'incoming',
      documentId: orphan.documentId,
      paymentId: null,
      number: dunningFeeLabel(orphan.number, orphan.level),
      customerId: party?.id ?? orphan.debtorId,
      customerName: party?.name ?? null,
      issueDate: null,
      dueDate: orphan.dueDate,
      currency: baseCurrency,
      grossMinor: -orphan.amountMinor,
      paidMinor: 0,
      openMinor: -orphan.amountMinor,
      baseOpenMinor: -orphan.amountMinor,
      daysOverdue: 0,
      overdue: false,
      bucket: keys[0]!,
      dunningLevel: 0,
      dunningFeeMinor: 0,
      creditedDocumentId: null,
      creditedOpenMinor: 0,
    });
  }

  // --- D68 (spec A13 §4b.4): the aging nets linked credits into the bucket of the claim they ------
  // offset. The ROW model is untouched (the un-netted claim and its offset stay separate rows, with
  // their own dates and their own overdue flags); what moves is the credit row's BUCKET, so the
  // per-bucket totals answer "how much overdue money is really out there". A credit whose invoice
  // has no open row left keeps the first bucket. The invoice row's `creditedOpenMinor` is the sum
  // of its linked credits' open offsets, the figure A15's chaseable-amount arithmetic reads.
  //
  // A15 SEAM: the Mahngebühr addition composes AFTER this point, on rows that are already net.
  {
    const invoiceRows = new Map(items.filter((i) => i.kind === 'document' && i.direction === 'incoming').map((i) => [i.documentId as string, i]));
    for (const item of items) {
      if (item.creditedDocumentId === null) continue;
      const invoiceRow = invoiceRows.get(item.creditedDocumentId);
      if (invoiceRow === undefined) continue;
      item.bucket = invoiceRow.bucket;
      invoiceRow.creditedOpenMinor += -item.openMinor;
    }
  }

  // The parked payments (US-A16.3). They belong on this list because they are part of what account
  // 1100 holds: an over-payment credits the receivable without naming a document, so a list that
  // omitted them would report a total the ledger contradicts.
  //
  // NOT ALL OF THEM ARE GUTHABEN, which is finding F13 and the reason `direction` is on the row.
  // The query takes every unallocated payment attached to a customer in BOTH directions, and the
  // two carry opposite signs, so "parked" and "credit" are not the same statement.
  for (const p of paymentsAsOf(ctx, asOf)) {
    const remainder = p.amount_minor - p.allocated_minor;
    if (remainder === 0) continue;
    const rate = p.fx_rate === null ? null : parseRate(p.fx_rate);
    const baseRemainder = rate === null ? remainder : convertMinor(remainder, rate);
    // Incoming money parked on account REDUCES the receivable; outgoing money parked against a
    // customer increases it. The sign follows the direction the cash moved, never a convention.
    const direction: OpenItemDirection = p.direction === 'incoming' ? 'incoming' : 'outgoing';
    const sign = direction === 'incoming' ? -1 : 1;
    // A14 FREEZES `payment.counterparty_id`, so a merge cannot re-point it and this is the reader that
    // has to move instead. Without it a merged customer's parked Guthaben stayed filed under the
    // retired duplicate: `aging_report` returned two rows for one party, one of them under a name
    // `list_contacts` hides, and the operator dunned the survivor for money already received.
    const party = resolve(p.counterparty_id);
    items.push({
      kind: 'on_account',
      direction,
      documentId: null,
      paymentId: p.id,
      number: null,
      customerId: party?.id ?? p.counterparty_id,
      customerName: party?.name ?? p.counterparty_name,
      issueDate: p.date,
      dueDate: null,
      currency: p.currency,
      grossMinor: sign * remainder,
      paidMinor: 0,
      openMinor: sign * remainder,
      baseOpenMinor: sign * baseRemainder,
      daysOverdue: 0,
      overdue: false,
      bucket: keys[0]!,
      dunningLevel: 0,
      dunningFeeMinor: 0,
      creditedDocumentId: null,
      creditedOpenMinor: 0,
    });
  }

  // Oldest due date first, so the list is worked from the top down. This is A14's ordering rule for
  // its candidate list and the order a Treuhänder settles in; it is also the order A15 needs, since
  // the items to chase are the ones that have been outstanding longest. An item with no due date and
  // a parked credit sort last: neither is overdue and neither is what the operator came here for.
  items.sort((a, b) => {
    const da = a.dueDate ?? '9999-12-31';
    const db = b.dueDate ?? '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return (a.number ?? '').localeCompare(b.number ?? '');
  });
  return items;
}

function emptyBuckets(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, 0]));
}

/**
 * Bucket subtotals in the FACE currency of each item.
 *
 * Meaningful only when one currency is in view. In a mixed workspace this adds francs to euros, so
 * it is a number with no unit and must never be rendered with a currency prefix: see
 * `baseBucketTotalsOf` below, which is the figure a header can actually carry.
 */
function bucketTotalsOf(items: readonly OpenItem[], keys: readonly string[]): Record<string, number> {
  const totals = emptyBuckets(keys);
  for (const item of items) totals[item.bucket] = (totals[item.bucket] ?? 0) + item.openMinor;
  return totals;
}

/**
 * The same partition, summed in BASE currency (finding F11).
 *
 * NOT A NEW DERIVATION. `baseOpenMinor` has been on every item since this read model shipped, read
 * off the entry the receivable was actually booked at; all that was missing was the reduction. The
 * response already carried `baseTotalOpenMinor`, so the surface had an honest grand total and no
 * honest way to break it down, and a tile prefixed `CHF` over a mixed face sum would have been a
 * fabricated figure sitting under a passing reconciliation mark.
 *
 * Signs ride through untouched. A16's first bucket can be NEGATIVE (a parked Guthaben is filed into
 * `keys[0]` with a negative open), and clamping or absolute-valuing that to make it render would be
 * the same class of lie in the other direction.
 */
function baseBucketTotalsOf(items: readonly OpenItem[], keys: readonly string[]): Record<string, number> {
  const totals = emptyBuckets(keys);
  for (const item of items) totals[item.bucket] = (totals[item.bucket] ?? 0) + item.baseOpenMinor;
  return totals;
}

export interface ListOpenItemsInput {
  asOf?: string;
  customerId?: string;
  currency?: string;
}

/**
 * The OP-Liste (US-A16.1, US-A16.2, US-A16.4, US-A16.5).
 *
 * `reconciled` describes the WORKSPACE, not the filtered slice: a caller who asked a narrower
 * question must not be told the ledger disagrees just because they narrowed it. The ✓ in the header
 * is a statement about the books, and it stays true while the table below it shows one customer.
 */
export function listOpenItems(ctx: WorkspaceContext, input: ListOpenItemsInput = {}): Result {
  const guard =
    optionalDate(input.asOf, 'asOf') ??
    optionalId(input.customerId, 'customerId') ??
    (input.currency !== undefined && typeof input.currency !== 'string'
      ? err('invalid_input', { field: 'currency' })
      : null);
  if (guard) return guard;

  const asOf = input.asOf ?? ctx.clock.now().slice(0, 10);
  const boundaries = agingBoundariesOf(ctx);
  const keys = bucketKeys(boundaries);
  const all = collectOpenItems(ctx, asOf, boundaries);

  // The FILTER resolves too, so a caller holding a retired duplicate's id is answered with the
  // survivor's consolidated items rather than an empty list. The same redirect `get_contact` performs.
  const wanted = resolveContactRef(ctx, input.customerId ?? null);
  const filtered = all.filter(
    (i) =>
      (wanted === null || i.customerId === wanted.id) &&
      (input.currency === undefined || i.currency === input.currency),
  );

  const workspaceBase = all.reduce((n, i) => n + i.baseOpenMinor, 0);
  const ledger = receivablesBalanceAsOf(ctx, asOf);

  return ok({
    asOf,
    items: filtered,
    boundariesDays: boundaries,
    bucketTotals: bucketTotalsOf(filtered, keys),
    /** The tiles' figure: the ONE bucket breakdown that is an amount in a currency (F11). */
    baseBucketTotals: baseBucketTotalsOf(filtered, keys),
    totalOpenMinor: filtered.reduce((n, i) => n + i.openMinor, 0),
    baseTotalOpenMinor: filtered.reduce((n, i) => n + i.baseOpenMinor, 0),
    baseCurrency: baseCurrencyOf(ctx),
    currencies: [...new Set(filtered.map((i) => i.currency))].sort(),
    filtered: input.customerId !== undefined || input.currency !== undefined,
    /** The workspace-wide figure the reconciliation is about, whatever the caller filtered to. */
    workspaceBaseTotalOpenMinor: workspaceBase,
    receivablesBalanceMinor: ledger,
    reconciled: workspaceBase === ledger,
    reconciliationDifferenceMinor: workspaceBase - ledger,
  });
}

export interface CustomerBalanceInput {
  customerId?: string;
  asOf?: string;
}

/**
 * One customer's outstanding position (US-A16.3), including their parked credits.
 *
 * An unknown or foreign customer id reads as an EMPTY balance rather than `not_found`, and that is a
 * §H-TENANT property as much as a P9 one: a rejection that distinguished "no such customer" from
 * "not your customer" would make a neighbour's contact ids probeable one call at a time.
 */
export function customerBalance(ctx: WorkspaceContext, input: CustomerBalanceInput): Result {
  const guard = requireString(input.customerId, 'customerId') ?? optionalDate(input.asOf, 'asOf');
  if (guard) return guard;

  const asOf = input.asOf ?? ctx.clock.now().slice(0, 10);
  const boundaries = agingBoundariesOf(ctx);
  const keys = bucketKeys(boundaries);
  // ONE PARTY, ONE BALANCE. A merged customer used to answer twice: the survivor reported the invoices
  // and the tombstone reported the parked credit, with neither figure being the customer's position.
  // The id asked for resolves through the tombstone, and `mergedFrom` says so rather than pretending
  // the caller asked about the survivor all along.
  const asked = resolveContactRef(ctx, input.customerId ?? null);
  const customerId = asked?.id ?? (input.customerId as string);
  const mine = collectOpenItems(ctx, asOf, boundaries).filter((i) => i.customerId === customerId);

  const overdue = mine.filter((i) => i.overdue).map((i) => i.daysOverdue);
  return ok({
    customerId,
    mergedFrom: asked?.mergedFrom ?? null,
    customerName: asked?.name ?? mine[0]?.customerName ?? null,
    asOf,
    items: mine,
    boundariesDays: boundaries,
    bucketTotals: bucketTotalsOf(mine, keys),
    baseBucketTotals: baseBucketTotalsOf(mine, keys),
    totalOpenMinor: mine.reduce((n, i) => n + i.openMinor, 0),
    baseTotalOpenMinor: mine.reduce((n, i) => n + i.baseOpenMinor, 0),
    baseCurrency: baseCurrencyOf(ctx),
    currencies: [...new Set(mine.map((i) => i.currency))].sort(),
    oldestOverdueDays: overdue.length === 0 ? 0 : Math.max(...overdue),
    // Reported POSITIVE, because a Guthaben is a credit the customer holds. Its contribution to the
    // balance above is negative, and the two are different questions with different signs.
    onAccountMinor: mine
      .filter((i) => i.kind === 'on_account')
      .reduce((n, i) => n - i.openMinor, 0),
  });
}

export interface AgingReportInput {
  asOf?: string;
}

/**
 * The aging summary (US-A16.2): the same numbers `listOpenItems` itemises, aggregated two ways.
 *
 * It reads the identical `collectOpenItems` derivation rather than running its own aggregate SQL, so
 * the bar in the header can never disagree with the table under it. A summary that queries
 * separately is a second source of truth wearing a chart.
 */
export function agingReport(ctx: WorkspaceContext, input: AgingReportInput = {}): Result {
  const guard = optionalDate(input.asOf, 'asOf');
  if (guard) return guard;

  const asOf = input.asOf ?? ctx.clock.now().slice(0, 10);
  const boundaries = agingBoundariesOf(ctx);
  const keys = bucketKeys(boundaries);
  const items = collectOpenItems(ctx, asOf, boundaries);

  const perCustomer = new Map<string, { customerId: string | null; customerName: string | null; items: OpenItem[] }>();
  for (const item of items) {
    const key = item.customerId ?? '';
    const entry = perCustomer.get(key) ?? {
      customerId: item.customerId,
      customerName: item.customerName,
      items: [],
    };
    entry.items.push(item);
    perCustomer.set(key, entry);
  }

  const byCustomer = [...perCustomer.values()]
    .map((c) => {
      const overdue = c.items.filter((i) => i.overdue).map((i) => i.daysOverdue);
      return {
        customerId: c.customerId,
        customerName: c.customerName,
        openItemCount: c.items.length,
        totalOpenMinor: c.items.reduce((n, i) => n + i.openMinor, 0),
        baseTotalOpenMinor: c.items.reduce((n, i) => n + i.baseOpenMinor, 0),
        bucketTotals: bucketTotalsOf(c.items, keys),
        baseBucketTotals: baseBucketTotalsOf(c.items, keys),
        oldestOverdueDays: overdue.length === 0 ? 0 : Math.max(...overdue),
      };
    })
    // Largest debtor first: the question this report answers is who owes the most.
    .sort((a, b) => b.baseTotalOpenMinor - a.baseTotalOpenMinor);

  const total = items.reduce((n, i) => n + i.baseOpenMinor, 0);
  const ledger = receivablesBalanceAsOf(ctx, asOf);
  return ok({
    asOf,
    boundariesDays: boundaries,
    byBucket: bucketTotalsOf(items, keys),
    /**
     * The bucket breakdown that ties to `baseTotalOpenMinor` on this same response (F11).
     *
     * `byBucket` is a face sum, so in a mixed-currency workspace the report disagreed with its own
     * grand total two lines down. Both are returned rather than one replaced, because a
     * single-currency workspace legitimately wants the face figure and they are equal there anyway.
     */
    baseByBucket: baseBucketTotalsOf(items, keys),
    byCustomer,
    totalOpenMinor: items.reduce((n, i) => n + i.openMinor, 0),
    baseTotalOpenMinor: total,
    baseCurrency: baseCurrencyOf(ctx),
    receivablesBalanceMinor: ledger,
    reconciled: total === ledger,
    reconciliationDifferenceMinor: total - ledger,
  });
}
