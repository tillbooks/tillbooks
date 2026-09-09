/**
 * A19, the bank-account verb surface: the register reachable from every shipped face.
 *
 * Eight verbs: the six §7 enumerates, plus `unarchive_bank_account` (finding F12), which §7 assumed
 * A19 had by parity with A01 and which nothing had ever built (archiving was therefore irreversible
 * from every face), plus `preview_bank_opening_balance` (owner decision D43/B2), the read half of
 * `set_bank_opening_balance`. §6 and US-A19.4 ask for a base-currency readout before the opening
 * balance is booked, and the design proposed shipping without one because no preview verb existed;
 * the owner declined, because the click it defers verification past posts an immutable entry. `validateIban` is deliberately NOT among them: it is a
 * pure predicate A18/A20/A21 call in-process, and exposing it would invite an agent to pre-validate
 * an IBAN and then send a different one, splitting the check from the write it is supposed to guard.
 * `create_bank_account` validates the IBAN it actually stores, which is the only place the answer
 * can be trusted.
 *
 * ONE NAMING RULE, and it is the whole reason this file reads carefully. A14 already ships a field
 * called `bankAccountId` meaning the LEDGER account money moved on. Here `bankAccountId` is a
 * `bank_account` row and the ledger link is `ledgerAccountId`. A tool description is the only thing
 * an agent has to pick a verb and fill a field with, so every description below says which of the
 * two it wants, in the product's own words: the account is a **Bankkonto**, the thing it maps to is
 * the **verknüpftes Konto**, and retiring one is **archivieren**, never "löschen".
 *
 * The opening balance is a SEPARATE verb from create, and that is a contract, not a convenience
 * (Pattern P8, spec US-A19.6): an agent registering an account from an instruction must not be able
 * to move money as a side effect of creating a master-data row. Confirming an opening balance is its
 * own explicit act with its own idempotency key.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX and A14 both established:
 * the registry is the one append-only tool list and several agents append to it at once, so the
 * smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createBankAccount,
  updateBankAccount,
  setBankOpeningBalance,
  previewBankOpeningBalance,
  archiveBankAccount,
  unarchiveBankAccount,
  listBankAccounts,
  getBankAccount,
} from '../core/banking/index.js';

export interface BankActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

export function bankActions(h: BankActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  const as = <T>(input: ActionInput): T => input as unknown as T;

  return [
    ctxAction(
      'create_bank_account',
      'write',
      'Register a Bankkonto: validates the IBAN (ISO 13616 mod-97), derives whether it is a QR-IBAN (QR-IID 30000 to 31999, receive-only), and links it to an asset account in the chart (ledgerAccountId, e.g. 1020 Bankkonto). Does NOT set an opening balance: that is set_bank_opening_balance.',
      ctxSchema(
        { name: STR, iban: STR, currency: STR, ledgerAccountId: STR, idempotencyKey: STR },
        ['name', 'iban', 'ledgerAccountId'],
      ),
      (ctx, input) => createBankAccount(ctx, as(input)),
    ),
    ctxAction(
      'update_bank_account',
      'write',
      'Rename a Bankkonto or correct its details. The IBAN, currency and verknüpftes Konto freeze once the account is referenced by a posted opening balance (account_in_use); the name stays editable for good.',
      ctxSchema(
        { bankAccountId: STR, name: STR, iban: STR, currency: STR, ledgerAccountId: STR, idempotencyKey: STR },
        ['bankAccountId'],
      ),
      (ctx, input) => updateBankAccount(ctx, as(input)),
    ),
    ctxAction(
      'set_bank_opening_balance',
      'write',
      "Post a Bankkonto's opening balance as a real balanced journal entry (debit the bank account, credit 9100 Eröffnungsbilanz), in integer Rappen. Explicitly confirmed and idempotent: re-sending the same idempotencyKey returns the original entry and never posts twice. A correction to a posted opening balance is a reversing entry, never a second opening.",
      ctxSchema(
        {
          bankAccountId: STR,
          amountMinor: INT,
          currency: STR,
          date: STR,
          fxRate: STR,
          idempotencyKey: STR,
        },
        ['bankAccountId', 'amountMinor', 'date', 'idempotencyKey'],
      ),
      (ctx, input) => setBankOpeningBalance(ctx, as(input)),
    ),
    ctxAction(
      'preview_bank_opening_balance',
      'read',
      "Show what set_bank_opening_balance WOULD post for a Bankkonto, in the workspace base currency, without posting anything: the base amount, the rate it converted on, and the two legs (the Bankkonto's verknüpftes Konto against 9100 Eröffnungsbilanz). It runs the posting's own arithmetic, so the FIGURE cannot disagree, and it answers the same refusals the posting answers for the state it reads (needs_account for a missing or archived 9100, currency_mismatch, opening_balance_already_set, needs_fx_rate, period_locked). It is not a promise about the posting. It checks no capability, so a caller without the post right gets the full figure here, and at set_bank_opening_balance that caller is refused permission_denied at every amount, including the zero one that books no journal entry; that refusal is not always the FIRST one, because an unknown Bankkonto, an opening balance already set, or (above zero only) a missing 9100 is answered before the capability is consulted, and an idempotencyKey that replays an already-completed call still replays. It also holds no state, so a period locked, a 9100 archived or another actor posting in between still refuses there. Takes no idempotency key and can never post: use it before Buchen, because a posted opening balance is immutable and its only correction is a reversing entry.",
      ctxSchema(
        { bankAccountId: STR, amountMinor: INT, currency: STR, date: STR, fxRate: STR },
        ['bankAccountId', 'amountMinor', 'date'],
      ),
      (ctx, input) => previewBankOpeningBalance(ctx, as(input)),
    ),
    ctxAction(
      'archive_bank_account',
      'write',
      'Archivieren: hide a closed Bankkonto from pickers while keeping it referenceable by historical statements and entries. Never deletes the account.',
      ctxSchema({ bankAccountId: STR, idempotencyKey: STR }, ['bankAccountId']),
      (ctx, input) => archiveBankAccount(ctx, as(input)),
    ),
    ctxAction(
      'unarchive_bank_account',
      'write',
      'Wiederherstellen: put an archived Bankkonto back in the pickers. The inverse of archive_bank_account, and a Bankkonto that is already active stays active (no rejection). Nothing about the account changes: this only clears the archived flag.',
      ctxSchema({ bankAccountId: STR, idempotencyKey: STR }, ['bankAccountId']),
      (ctx, input) => unarchiveBankAccount(ctx, as(input)),
    ),
    ctxAction(
      'list_bank_accounts',
      'read',
      'List this workspace\'s Bankkonten with their IBAN, currency, verknüpftes Konto, QR-IBAN flag and opening balance. Archived accounts are excluded unless includeArchived is true. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({ includeArchived: BOOL, savedViewId: STR }),
      (ctx, input) => listBankAccounts(ctx, as(input)),
    ),
    ctxAction(
      'get_bank_account',
      'read',
      'Read one Bankkonto, including whether its IBAN is a QR-IBAN and therefore receive-only (a QR-IBAN may only be credited, never used as a debit account).',
      ctxSchema({ bankAccountId: STR }, ['bankAccountId']),
      (ctx, input) => getBankAccount(ctx, as(input)),
    ),
  ];
}
