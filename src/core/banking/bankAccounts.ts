/**
 * A19, bank accounts: the anchor A18 (creditor payments), A20 (camt import), A21 (QRR matching)
 * and A22 (FX revaluation) each hang their own tables off.
 *
 * THE ONE DISTINCTION THIS MODULE EXISTS TO MAKE. A14 already has a field called `bankAccountId`,
 * and it means something else: the LEDGER account money moved on (a row in `account`, resolved by
 * `resolveBankAccount`). A19's `bankAccountId` is a `bank_account` row: an IBAN, a currency, and
 * the ledger account it maps to. The two are one-to-one in the simple case and not in general (a
 * business with three CHF accounts at three banks books them all through 1020), which is precisely
 * why reconciliation needs the richer object. A19 does NOT replace A14's field and does not touch
 * `core/payments/**`; the ledger link here is named `ledgerAccountId` so the two never read alike.
 *
 * IBAN VALIDATION IS NOT REIMPLEMENTED HERE. `core/setup/iban.ts` already carries the ISO 7064
 * mod-97-10 check and the QR-IID range, and A11's QR-bill path is already built on it. A second
 * validator would be a second answer to "is this a QR-IBAN?", and the two would drift the first
 * time only one was corrected. This module re-exports that one through a Result-shaped wrapper so
 * the MCP/REST faces get a P9 rejection instead of a bare boolean.
 *
 * WHAT THE QR-IBAN FLAG MEANS DOWNSTREAM, from the primary source. SIX, "Swiss QR-bill: Technical
 * information about the QR-IID and QR-IBAN", v1.1 with effect from 29 February 2020:
 *
 *   §1.3.2  "The QR-IID is derived from the institution identification (IID). QR-IIDs consist
 *            exclusively of numbers from 30000 to 31999."
 *   §3.1    "A QR-IBAN can only be used for incoming payments. Payments debiting a QR-IBAN are not
 *            anticipated. That is why there must always be an IBAN in addition to a QR-IBAN (for
 *            incoming payments with no reference and for outgoing payments)."
 *   §3.3.1  "payments can only be made to the account of an IBAN, i.e. it is not permitted to use a
 *            QR-IBAN to identify the debit account."
 *
 * So the flag is not decoration: an account registered under a QR-IBAN is RECEIVE-ONLY, and A18
 * must never select it as a pain.001 debit account. The read model says `receiveOnly` out loud
 * rather than leaving every downstream caller to re-derive it from the IID.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isValidIban, isQrIban, normalizeIban, QR_IID_MIN, QR_IID_MAX } from '../setup/iban.js';
import { isCurrencyCode } from '../fx/rateMath.js';
import { postEntry, applyFxToLines, statesConversionBasis } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { requireString, optionalId, optionalText, requireDate } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';

/**
 * The reserved QR-IID range, from SIX §1.3.2 above. RE-EXPORTED from `core/setup/iban.ts`, which is
 * where `isQrIban` reads it, so the boundary a test pins is the boundary the engine actually uses.
 * Restating the two digits here would have made this pair decorative: it could drift from the real
 * comparison and the test would keep passing while QRR eligibility broke downstream.
 */
export { QR_IID_MIN, QR_IID_MAX };

/**
 * KMU 9100 Eröffnungsbilanz, the contra account an opening balance is booked against.
 *
 * Resolved by NUMBER, never created here. It is not in A01's shipped core seed and A04 (opening
 * balances) owns seeding it, so today the honest answer to its absence is a structured
 * `needs_account` naming the number to restore, exactly the way A14 answers a missing posting role.
 * Inventing an equity account no Treuhänder approved would be the silent substitution that pattern
 * exists to prevent.
 */
export const OPENING_BALANCE_ACCOUNT_NUMBER = '9100';

export interface BankAccountRow {
  id: string;
  workspace_id: string;
  name: string;
  iban: string;
  is_qr_iban: number;
  currency: string;
  ledger_account_id: string;
  opening_balance_minor: number | null;
  opening_balance_date: string | null;
  opening_entry_id: string | null;
  archived: number;
  created_at: string;
}

export interface BankAccountView {
  id: string;
  name: string;
  iban: string;
  isQrIban: boolean;
  /** SIX §3.1/§3.3.1: a QR-IBAN may only be credited. A18 must not choose this as a debit account. */
  receiveOnly: boolean;
  currency: string;
  ledgerAccountId: string;
  ledgerAccountNumber: string | null;
  openingBalanceMinor: number | null;
  openingBalanceDate: string | null;
  openingEntryId: string | null;
  archived: boolean;
  createdAt: string;
}

/**
 * ISO 13616 validity plus the SIX QR-IID derivation, as a P9 Result.
 *
 * Pure and reusable by A18/A20/A21 (spec §4). Delegates to `core/setup/iban.ts`: this is a shape
 * adapter, not a second implementation.
 */
export function validateIban(iban: unknown): Result {
  if (typeof iban !== 'string' || iban.length === 0) {
    return err('invalid_iban', { reason: 'missing' });
  }
  const normalized = normalizeIban(iban);
  if (!isValidIban(normalized)) {
    return err('invalid_iban', { reason: 'check_digits_or_structure' });
  }
  return ok({ iban: normalized, isQrIban: isQrIban(normalized) });
}

// --- internals ---------------------------------------------------------------------------------

/** §H-TENANT on every read: the workspace is part of the predicate, never checked afterwards. */
function readRow(ctx: WorkspaceContext, bankAccountId: unknown): BankAccountRow | undefined {
  if (typeof bankAccountId !== 'string' || bankAccountId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as BankAccountRow | undefined;
}

function ledgerAccountNumber(ctx: WorkspaceContext, accountId: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT number FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as { number: string } | undefined;
  return row?.number ?? null;
}

function toView(ctx: WorkspaceContext, row: BankAccountRow): BankAccountView {
  return {
    id: row.id,
    name: row.name,
    iban: row.iban,
    isQrIban: row.is_qr_iban === 1,
    receiveOnly: row.is_qr_iban === 1,
    currency: row.currency,
    ledgerAccountId: row.ledger_account_id,
    ledgerAccountNumber: ledgerAccountNumber(ctx, row.ledger_account_id),
    openingBalanceMinor: row.opening_balance_minor,
    openingBalanceDate: row.opening_balance_date,
    openingEntryId: row.opening_entry_id,
    archived: row.archived === 1,
    createdAt: row.created_at,
  };
}

/**
 * The ledger account a bank account may link to: present, in this workspace, an ASSET, not archived.
 *
 * The rejection is deliberately ONE code for all four cases. An id must not be probeable across
 * tenants, and the caller's next action ("give me a usable asset account") is identical whichever
 * of the four it was.
 */
function resolveLedgerAccount(ctx: WorkspaceContext, ledgerAccountId: unknown): Result {
  if (typeof ledgerAccountId !== 'string' || ledgerAccountId.length === 0) {
    return err('needs_ledger_account', { reason: 'missing' });
  }
  const row = ctx.store.db
    .prepare('SELECT id, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, ledgerAccountId) as { id: string; type: string; archived: number } | undefined;
  if (row === undefined || row.archived === 1) {
    return err('needs_ledger_account', { reason: 'unusable' });
  }
  if (row.type !== 'asset') {
    return err('needs_ledger_account', { reason: 'not_an_asset_account' });
  }
  return ok({ ledgerAccountId: row.id });
}

/**
 * Is this account referenced by something that has to keep meaning what it meant?
 *
 * Today that is the posted opening entry: once money is on the books against this account, its
 * IBAN, currency and ledger link are the anchor A20/A21/A22 key their own correctness off, and
 * §H-AUDIT will not let the entry be rewritten to match a changed key field. A20 adds `bank_txn`
 * and A21 `reconciliation_match` to exactly this predicate (spec §4); they do not exist yet, and
 * claiming to check tables that are not there would be a test asserting nothing.
 */
function isReferenced(row: BankAccountRow): boolean {
  return row.opening_entry_id !== null;
}

// --- verbs -------------------------------------------------------------------------------------

export interface CreateBankAccountInput {
  name: string;
  iban: string;
  currency?: string;
  ledgerAccountId: string;
  idempotencyKey?: string;
}

export function createBankAccount(ctx: WorkspaceContext, input: CreateBankAccountInput): Result {
  const guard = requireString(input.name, 'name') ?? optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const validated = validateIban(input.iban);
  if (!validated.ok) return validated;
  const iban = validated.iban as string;

  const currency = input.currency ?? 'CHF';
  if (!isCurrencyCode(currency)) return err('invalid_input', { field: 'currency' });

  const ledger = resolveLedgerAccount(ctx, input.ledgerAccountId);
  if (!ledger.ok) return ledger;

  // Replay a completed create BEFORE the duplicate guard (§H-IDEMPOTENT). Without this ordering the
  // guard fires on the row the FIRST call wrote, so a retry, the one thing an idempotency key exists
  // to make safe, comes back as `duplicate_iban` and the caller cannot tell its own successful write
  // from someone else's collision. Same order `createAccount` and `postEntry` use.
  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'create_bank_account');
    if (replayed !== undefined) return replayed;
  }

  const existing = ctx.store.db
    .prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND iban = ?')
    .get(ctx.workspaceId, iban) as { id: string } | undefined;
  if (existing !== undefined) return err('duplicate_iban', { iban });

  const run = (): Result => {
    const id = ctx.ids.next('bank');
    ctx.store.db
      .prepare(
        `INSERT INTO bank_account
           (id, workspace_id, name, iban, is_qr_iban, currency, ledger_account_id, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.name,
        iban,
        validated.isQrIban === true ? 1 : 0,
        currency,
        ledger.ledgerAccountId as string,
        ctx.clock.now(),
      );
    ctx.audit.record({
      entityKind: 'bank_account',
      entityId: id,
      action: 'create',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ bankAccountId: id, isQrIban: validated.isQrIban === true });
  };
  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'create_bank_account', run)
    : run();
}

export interface UpdateBankAccountInput {
  bankAccountId: string;
  name?: string;
  iban?: string;
  currency?: string;
  ledgerAccountId?: string;
  idempotencyKey?: string;
}

/**
 * `idempotencyKey` is optional in the SHAPE and load-bearing when given (§H-IDEMPOTENT).
 *
 * An update is naturally idempotent for a fixed payload, so this is not about the row: it is about
 * the AUDIT trail and about a retry that crossed with a second, different edit. Replaying a key
 * returns the original result and applies nothing further, so a network retry cannot quietly land
 * a payload the caller has since revised.
 */
export function updateBankAccount(ctx: WorkspaceContext, input: UpdateBankAccountInput): Result {
  const guard = optionalText(input.name, 'name') ?? optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key as string, 'update_bank_account');
    if (replayed !== undefined) return replayed;
  }

  const row = readRow(ctx, input.bankAccountId);
  if (row === undefined) return err('bank_account_not_found');

  const wantsKeyChange =
    input.iban !== undefined || input.currency !== undefined || input.ledgerAccountId !== undefined;
  if (wantsKeyChange && isReferenced(row)) {
    // Name the field, so the GUI can flag the one that is frozen rather than the whole form.
    const field = input.iban !== undefined ? 'iban' : input.currency !== undefined ? 'currency' : 'ledgerAccountId';
    return err('account_in_use', { field, reason: 'opening_balance_posted' });
  }

  let iban = row.iban;
  let isQr = row.is_qr_iban;
  if (input.iban !== undefined) {
    const validated = validateIban(input.iban);
    if (!validated.ok) return validated;
    iban = validated.iban as string;
    // Re-derive the flag from the NEW IBAN. Carrying the old one forward would leave a plain IBAN
    // marked QRR-eligible (or the reverse), which is the one way this row can lie to A21.
    isQr = validated.isQrIban === true ? 1 : 0;
    if (iban !== row.iban) {
      const clash = ctx.store.db
        .prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND iban = ? AND id <> ?')
        .get(ctx.workspaceId, iban, row.id) as { id: string } | undefined;
      if (clash !== undefined) return err('duplicate_iban', { iban });
    }
  }

  let currency = row.currency;
  if (input.currency !== undefined) {
    if (!isCurrencyCode(input.currency)) return err('invalid_input', { field: 'currency' });
    currency = input.currency;
  }

  let ledgerAccountId = row.ledger_account_id;
  if (input.ledgerAccountId !== undefined) {
    const ledger = resolveLedgerAccount(ctx, input.ledgerAccountId);
    if (!ledger.ok) return ledger;
    ledgerAccountId = ledger.ledgerAccountId as string;
  }

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE bank_account
            SET name = ?, iban = ?, is_qr_iban = ?, currency = ?, ledger_account_id = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(input.name ?? row.name, iban, isQr, currency, ledgerAccountId, ctx.workspaceId, row.id);

    ctx.audit.record({
      entityKind: 'bank_account',
      entityId: row.id,
      action: 'update',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ bankAccountId: row.id });
  };
  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'update_bank_account', run)
    : run();
}

export interface SetBankOpeningBalanceInput {
  bankAccountId: string;
  amountMinor: number;
  currency?: string;
  date: string;
  fxRate?: string;
  idempotencyKey: string;
}

/**
 * The guards, the row and the currency check every opening-balance caller shares.
 *
 * Extracted so `previewBankOpeningBalance` cannot answer a different question from the one
 * `setBankOpeningBalance` will act on. A preview that resolved its own account, or judged the
 * currency by its own rule, could come back clean and be followed by a rejection, which is worse
 * than no preview: the operator would have trusted it. The idempotency key is NOT guarded here,
 * because a read has none.
 */
function resolveOpeningTarget(
  ctx: WorkspaceContext,
  input: { bankAccountId: string; amountMinor: number; currency?: string | undefined; date: string; fxRate?: string | undefined },
): { ok: true; row: BankAccountRow; currency: string } | { ok: false; result: Err } {
  const guard = requireDate(input.date, 'date') ?? optionalId(input.fxRate, 'fxRate');
  if (guard) return { ok: false, result: guard };
  if (!Number.isInteger(input.amountMinor)) {
    // Pattern P2: money is integer Rappen on the wire. A float here would round somewhere invisible.
    return { ok: false, result: err('invalid_input', { field: 'amountMinor' }) };
  }

  const row = readRow(ctx, input.bankAccountId);
  if (row === undefined) return { ok: false, result: err('bank_account_not_found') };

  const currency = input.currency ?? row.currency;
  if (!isCurrencyCode(currency)) return { ok: false, result: err('invalid_input', { field: 'currency' }) };
  if (currency !== row.currency) {
    return { ok: false, result: err('currency_mismatch', { accountCurrency: row.currency, given: currency }) };
  }
  return { ok: true, row, currency };
}

/**
 * The refusal for an account that already carries an opening balance, or null.
 *
 * Posting a second one would stack it onto the same account and silently double the bank's starting
 * position. A correction to a posted opening balance is a reversing entry (A02), never a second
 * opening, and the preview says so before the click rather than after it.
 */
function openingAlreadySet(row: BankAccountRow): Err | null {
  if (row.opening_entry_id === null) return null;
  return err('opening_balance_already_set', {
    openingEntryId: row.opening_entry_id,
    openingBalanceMinor: row.opening_balance_minor,
  });
}

/** One prepared leg of the opening entry, before A02 sees it. */
interface OpeningLeg {
  account: string;
  debit: number;
  credit: number;
}

/**
 * Resolve 9100 and build the two legs: the ONE place the opening entry's shape is decided.
 *
 * A positive balance is an asset the business holds, so it debits the bank and credits the opening
 * equity. A negative one is an overdraft, which is the same entry with the sides swapped and not a
 * special case with its own accounts. The preview renders these legs and the posting books them, so
 * "which account, which side" has one answer.
 */
function buildOpeningLegs(
  ctx: WorkspaceContext,
  row: BankAccountRow,
  amountMinor: number,
): { ok: true; legs: [OpeningLeg, OpeningLeg]; contraId: string } | { ok: false; result: Err } {
  const contra = ctx.store.db
    .prepare('SELECT id, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, OPENING_BALANCE_ACCOUNT_NUMBER) as { id: string; archived: number } | undefined;
  if (contra === undefined || contra.archived === 1) {
    return {
      ok: false,
      result: err('needs_account', {
        role: 'openingBalance',
        number: OPENING_BALANCE_ACCOUNT_NUMBER,
        reason: contra === undefined ? 'missing' : 'archived',
      }),
    };
  }

  const magnitude = Math.abs(amountMinor);
  const positive = amountMinor > 0;
  const legs: [OpeningLeg, OpeningLeg] = positive
    ? [
        { account: row.ledger_account_id, debit: magnitude, credit: 0 },
        { account: contra.id, debit: 0, credit: magnitude },
      ]
    : [
        { account: row.ledger_account_id, debit: 0, credit: magnitude },
        { account: contra.id, debit: magnitude, credit: 0 },
      ];
  return { ok: true, legs, contraId: contra.id };
}

/** A19's half of `postEntry`'s `LineInput`: the legs, with the zero side dropped as A02 expects. */
function legsAsLines(legs: readonly OpeningLeg[]): LineInput[] {
  return legs.map((leg) => (leg.debit > 0 ? { account: leg.account, debit: leg.debit } : { account: leg.account, credit: leg.credit }));
}

/**
 * Post the opening balance as a real, balanced journal entry (Pattern P3: no second posting path).
 *
 * The money is booked by A02's `postEntry` and nowhere else, so the period gate, the §H-FX
 * conversion, the audit stamp and the immutability trigger all apply here without A19 restating
 * any of them. The row's `opening_balance_minor` is a cached read of that entry, never the source.
 */
export function setBankOpeningBalance(ctx: WorkspaceContext, input: SetBankOpeningBalanceInput): Result {
  const keyGuard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (keyGuard) return keyGuard;

  const target = resolveOpeningTarget(ctx, input);
  if (!target.ok) return target.result;
  const { row, currency } = target;

  // Replay BEFORE the already-set guard, for the reason `createBankAccount` spells out: a retry of a
  // successful post must return the ORIGINAL entry, not be told it is a duplicate of itself.
  const replayed = ctx.store.recallIdempotent<Result>(
    ctx.workspaceId,
    input.idempotencyKey,
    'set_bank_opening_balance',
  );
  if (replayed !== undefined) return replayed;

  const already = openingAlreadySet(row);
  if (already !== null) return already;

  // CHF 0.00 is not an economic event. Recording the intent without an entry keeps the trial balance
  // honest and still lets the account read as "opening balance confirmed".
  //
  // IT IS STILL A WRITE, AND IT IS STILL GATED. Every non-zero amount asserts `post` inside
  // `postEntry`; this branch never reaches `postEntry`, so for a while it asserted nothing and a
  // caller A24 had denied `post` could write `opening_balance_minor` and `opening_balance_date` and
  // be told `ok`. That is not a smaller version of posting money, it is the act that makes
  // `openingAlreadySet` true, after which the real opening balance needs a correction to record. The
  // capability is asserted here rather than at the top of the verb so the guards that already ran
  // still answer first: a replay still replays and an already-set account still says
  // `opening_balance_already_set`, at zero exactly as above it.
  //
  // It is NOT true that this leaves the precedence identical at every amount, and saying so would be
  // the same kind of overclaim this whole review is about. Above zero a missing 9100 answers
  // `needs_account` first, because the legs are built before `postEntry` asserts anything. At zero
  // there are no legs and 9100 is never resolved, so a missing 9100 is not an answer this branch can
  // give at all, and a denied caller meets `permission_denied` instead. Measured, both ways.
  //
  // The PERIOD gate is deliberately NOT applied here, and that is A03's call rather than an
  // oversight: whether writing a dated field into a sealed period is a lock violation when no journal
  // entry is created at all is a question about what a lock covers, and A19 is not the capability
  // that decides it. Both faces skip it identically, so the preview and the posting still agree.
  if (input.amountMinor === 0) {
    const capable = ctx.capabilities.assert('post');
    if (!capable.ok) return capable;
    ctx.store.db
      .prepare('UPDATE bank_account SET opening_balance_minor = 0, opening_balance_date = ? WHERE workspace_id = ? AND id = ?')
      .run(input.date, ctx.workspaceId, row.id);
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'set_bank_opening_balance', () =>
      ok({ bankAccountId: row.id, posted: false }),
    );
  }

  const built = buildOpeningLegs(ctx, row, input.amountMinor);
  if (!built.ok) return built.result;
  const lines = legsAsLines(built.legs);

  const posted = postEntry(ctx, {
    date: input.date,
    description: `Eröffnungsbilanz ${row.name}`,
    ref: row.iban,
    lines,
    source: 'import',
    idempotencyKey: `bank-opening:${row.id}:${input.idempotencyKey}`,
    ...(currency !== undefined ? { currency } : {}),
    ...(input.fxRate !== undefined ? { fxRate: input.fxRate } : {}),
  });
  // Every A02 rejection (`period_locked`, `needs_fx_rate`, a capability denial) rides straight out
  // unchanged. Re-coding it here would give the same condition two names on two surfaces.
  if (!posted.ok) return posted;

  const entryId = posted.entryId;
  ctx.store.db
    .prepare(
      `UPDATE bank_account
          SET opening_balance_minor = ?, opening_balance_date = ?, opening_entry_id = ?
        WHERE workspace_id = ? AND id = ?`,
    )
    .run(input.amountMinor, input.date, entryId, ctx.workspaceId, row.id);

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'set_bank_opening_balance', () =>
    ok({ bankAccountId: row.id, entryId, posted: true, amountMinor: input.amountMinor }),
  );
}

export interface PreviewBankOpeningBalanceInput {
  bankAccountId: string;
  amountMinor: number;
  currency?: string;
  date: string;
  fxRate?: string;
}

/** One leg of the preview, in both currencies, with the chart NUMBER so no raw id reaches a screen. */
export interface PreviewOpeningLine {
  accountId: string;
  accountNumber: string | null;
  debitMinor: number;
  creditMinor: number;
  baseDebitMinor: number;
  baseCreditMinor: number;
}

export type PreviewBankOpeningBalanceOk = {
  readonly bankAccountId: string;
  /** The transaction currency this opening balance is stated in. */
  readonly currency: string;
  /** The amount exactly as given, signed: negative is an overdraft. */
  readonly amountMinor: number;
  readonly baseCurrency: string;
  /** The same position in base currency, signed the same way. THE figure this verb exists for. */
  readonly baseAmountMinor: number;
  /** False for 0.00, which records the intent and books no entry at all. */
  readonly posts: boolean;
  /** The two legs that WOULD be written, or empty when nothing would be. */
  readonly lines: readonly PreviewOpeningLine[];
  /** §H-FX, present only when a conversion actually happens, exactly as the posting reports it. */
  readonly fxRate?: string;
  readonly fxRateAsOf?: string | null;
  readonly fxRateSource?: string;
}

/**
 * A19 §6 / US-A19.4: what `set_bank_opening_balance` WOULD post, in base currency, writing nothing.
 *
 * WHY THIS VERB EXISTS, AND WHY THE STUDIO MAY NOT DO THE SUM INSTEAD. The click it sits in front of
 * is **Buchen**, which posts an immutable journal entry whose only correction is a reversing entry
 * (A02, §H-AUDIT). Sending an operator through an irreversible ledger write without showing them its
 * principal figure is a defect; showing them a figure the browser multiplied is the same defect
 * wearing a number, because a decimal rate times an integer amount in JavaScript rounds where no test
 * is watching and where no audit trail records what was shown. A14 shipped `preview_payment` on
 * exactly this reasoning and A19 shipped nothing equivalent (owner decision D43/B2 bought it).
 *
 * IT IS THE POSTING'S OWN ARITHMETIC, NOT A SECOND IMPLEMENTATION, and that is the whole design.
 * `resolveOpeningTarget`, `openingAlreadySet` and `buildOpeningLegs` above are shared with
 * `setBankOpeningBalance` line for line, so the two agree on which account, which side and which
 * refusal. The CONVERSION is A02's exported `applyFxToLines`, the same call `postEntry` makes on the
 * same line shape, so the rounding is one rounding: one `resolveFxRate`, one `allocateBase` per side,
 * one half-away-from-zero. `test/banking/bank-opening-preview.test.mjs` pins the agreement against
 * the ledger ROWS on a rate that does not round cleanly, which is where a second implementation
 * drifts.
 *
 * IT IS A PURE READ. Every step is a SELECT or arithmetic on objects this function owns: no INSERT,
 * no UPDATE, no `ctx.audit.record`, and deliberately no idempotency key, since a key is a promise
 * about a write that never happens. The whole-database snapshot in the suite is what holds that
 * claim, because an audit row would leave every A19 row count untouched and still be a write.
 *
 * THE ONE THING IT DOES NOT ANSWER, said plainly rather than implied: A24 capabilities. `postEntry`
 * asserts `post` before anything else, and this verb does not re-code that assertion, because a
 * condition coded twice gets two names on two surfaces (the law this module already states for
 * `period_locked`). It reads `ctx.periods.assertOpen` directly, which is A03's own function and not
 * a copy of it, so a locked period IS refused here. A `permission_denied` therefore still arrives at
 * the Buchen click, which is the correct place for it: the preview is about the FIGURE.
 */
export function previewBankOpeningBalance(
  ctx: WorkspaceContext,
  input: PreviewBankOpeningBalanceInput,
): Result<PreviewBankOpeningBalanceOk> {
  const target = resolveOpeningTarget(ctx, input);
  if (!target.ok) return target.result;
  const { row, currency } = target;

  const already = openingAlreadySet(row);
  if (already !== null) return already;

  const baseCurrency = baseCurrencyOf(ctx);

  // 0.00 books no entry, so there is nothing to convert and no rate to resolve. Answering a rate here
  // would state a conversion basis for a posting that never happens.
  if (input.amountMinor === 0) {
    return ok<PreviewBankOpeningBalanceOk>({
      bankAccountId: row.id,
      currency,
      amountMinor: 0,
      baseCurrency,
      baseAmountMinor: 0,
      posts: false,
      lines: [],
    });
  }

  const built = buildOpeningLegs(ctx, row, input.amountMinor);
  if (!built.ok) return built.result;

  // The conversion, through A02's exported step. `baseDebit`/`baseCredit` start equal to the
  // transaction amounts exactly as `validatePostingLines` prepares them, so a base-currency preview
  // needs no special case and a foreign one takes the identical path the posting takes.
  const lines = built.legs.map((leg) => ({
    account: leg.account,
    debit: leg.debit,
    credit: leg.credit,
    baseDebit: leg.debit,
    baseCredit: leg.credit,
  }));
  const fx = applyFxToLines(ctx, { date: input.date, currency, ...(input.fxRate !== undefined ? { fxRate: input.fxRate } : {}) }, lines);
  if (!fx.ok) return fx.error;

  // §H-PERIOD, read through A03's own port rather than re-derived, and read AFTER the conversion for
  // the same reason `postEntry` reads it after `applyFxToLines`: with a locked period AND no
  // admissible rate, both refusals are true, and a preview that named the other one would send an
  // operator to fix the wrong thing first. The ORDER is part of the agreement, not just the set.
  const periodOpen = ctx.periods.assertOpen(input.date);
  if (!periodOpen.ok) return periodOpen;

  // The bank leg carries the position; the sign follows the amount, so an overdraft previews as a
  // negative figure and never as an absolute value of money the business owes.
  const bankLeg = lines[0] as (typeof lines)[number];
  const baseMagnitude = bankLeg.baseDebit > 0 ? bankLeg.baseDebit : bankLeg.baseCredit;
  const baseAmountMinor = input.amountMinor > 0 ? baseMagnitude : -baseMagnitude;

  return ok<PreviewBankOpeningBalanceOk>({
    bankAccountId: row.id,
    currency,
    amountMinor: input.amountMinor,
    baseCurrency,
    baseAmountMinor,
    posts: true,
    lines: lines.map((line) => ({
      accountId: line.account,
      accountNumber: ledgerAccountNumber(ctx, line.account),
      debitMinor: line.debit,
      creditMinor: line.credit,
      baseDebitMinor: line.baseDebit,
      baseCreditMinor: line.baseCredit,
    })),
    // The SAME predicate the posting reports on, so a preview and the entry it precedes disclose the
    // same basis: a base-currency posting converted nothing and states none.
    ...(statesConversionBasis(fx.resolved)
      ? { fxRate: fx.resolved.rate, fxRateAsOf: fx.resolved.rateAsOf, fxRateSource: fx.resolved.rateSource }
      : {}),
  });
}

export function archiveBankAccount(
  ctx: WorkspaceContext,
  input: { bankAccountId: string; idempotencyKey?: string },
): Result {
  const guard = optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key as string, 'archive_bank_account');
    if (replayed !== undefined) return replayed;
  }

  const row = readRow(ctx, input.bankAccountId);
  if (row === undefined) return err('bank_account_not_found');

  const run = (): Result => {
    // Never a DELETE. A20's `bank_txn` and A21's `reconciliation_match` carry a durable reference to
    // this row, so removing it would orphan historical reconciliation (§H-AUDIT spirit).
    ctx.store.db
      .prepare('UPDATE bank_account SET archived = 1 WHERE workspace_id = ? AND id = ?')
      .run(ctx.workspaceId, row.id);
    ctx.audit.record({
      entityKind: 'bank_account',
      entityId: row.id,
      action: 'archive',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ bankAccountId: row.id, archived: true });
  };
  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'archive_bank_account', run)
    : run();
}

/**
 * The inverse of `archiveBankAccount`: put the Bankkonto back in the picker.
 *
 * IT WAS MISSING, and that was the defect. `archiveBankAccount` set the flag and nothing anywhere
 * cleared it, so retiring an account was irreversible from every surface (a greenfield A19 design
 * assumed parity with A01 and had to withdraw its undo affordance). A01 has shipped
 * `unarchiveAccount` since Wave 0 and this follows it: clear the soft flag, an already-active row is
 * a no-op `ok` rather than a rejection, and an unknown id is a structured refusal.
 *
 * TWO DELIBERATE DEVIATIONS FROM A01's TWIN, both because the closer sibling is A19's own archive.
 *
 *  - It takes an OPTIONAL `idempotencyKey`, which `unarchiveAccount` does not. `archiveBankAccount`
 *    takes one, and an inverse that could not be retried the way its forward verb can would be an
 *    asymmetry a caller has to remember. The key buys the same thing it buys there: the AUDIT trail
 *    records one unarchive per key, and a retry that crossed with a later archive cannot silently
 *    undo it.
 *  - It answers `bank_account_not_found` rather than A01's bare `not_found`, because that is the one
 *    code every other A19 verb uses for a row that is absent or belongs to someone else.
 *
 * Archiving stays non-destructive at both ends: this is a flag flip on a surviving row, never an
 * INSERT that recreates something a DELETE removed, and the round-trip test counts the rows to say so.
 */
export function unarchiveBankAccount(
  ctx: WorkspaceContext,
  input: { bankAccountId: string; idempotencyKey?: string },
): Result {
  const guard = optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key as string, 'unarchive_bank_account');
    if (replayed !== undefined) return replayed;
  }

  // §H-TENANT through the same `readRow` predicate every other verb uses: the workspace is part of
  // the lookup, never a check applied to a row that was already found.
  const row = readRow(ctx, input.bankAccountId);
  if (row === undefined) return err('bank_account_not_found');

  const run = (): Result => {
    ctx.store.db
      .prepare('UPDATE bank_account SET archived = 0 WHERE workspace_id = ? AND id = ?')
      .run(ctx.workspaceId, row.id);
    ctx.audit.record({
      entityKind: 'bank_account',
      entityId: row.id,
      action: 'unarchive',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ bankAccountId: row.id, archived: false });
  };
  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'unarchive_bank_account', run)
    : run();
}

export function listBankAccounts(
  ctx: WorkspaceContext,
  input: { includeArchived?: boolean; savedViewId?: string } = {},
): Result {
  // The G00 seam, one unconditional call, exactly as `listDocuments` makes it (F5 retrofit: the
  // `bank_account` kind could store views that no verb applied).
  const viewed = applySavedView(ctx, 'bank_account', input);
  if (!viewed.ok) return viewed;
  input = viewed.filter;
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM bank_account
        WHERE workspace_id = ? AND (archived = 0 OR ? = 1)
        ORDER BY name, id`,
    )
    .all(ctx.workspaceId, input.includeArchived === true ? 1 : 0) as BankAccountRow[];
  return ok({ bankAccounts: rows.map((r) => toView(ctx, r)) });
}

export function getBankAccount(ctx: WorkspaceContext, input: { bankAccountId: string }): Result {
  const row = readRow(ctx, input.bankAccountId);
  if (row === undefined) return err('bank_account_not_found');
  return ok({ bankAccount: toView(ctx, row) });
}
