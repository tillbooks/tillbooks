/**
 * `compose_entry`, the A02 composer's one read (D152 amendment, owner 02.10.2026), defined here and spread
 * into `ACTIONS` as one line under the A02 banner (the `draftActions` / `fxActions` precedent).
 *
 * The verb composes a journal entry's lines the way `post_entry` would store them and WRITES NOTHING: a
 * surface sends intent (an amount on a side, gross or net, a code) and receives the exact lines, the
 * captions and the engine's own verdict, then posts or saves those lines verbatim. Its reason to exist is
 * that a Studio derivation of VAT legs and traces drifted from the engine three critic rounds in a row; the
 * engine now composes, through the same pre-write steps `postEntry` runs (`previewPostingLines`). The
 * contract is in `src/core/ledger/compose.ts` and A02 §6.
 *
 * The helpers arrive as a parameter rather than an import, so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { composeEntry } from '../core/ledger/compose.js';
import type { ComposeEntryInput } from '../core/ledger/compose.js';
import { composeBankLine } from '../core/banking/bankBooking.js';
import type { ComposeBankLineInput } from '../core/banking/bankBooking.js';
import { composeTemplate } from '../core/banking/bankTemplates.js';
import type { ComposeTemplateInput } from '../core/banking/bankTemplates.js';
import { err } from '../core/result.js';
import type { ActionKind } from './actionKind.js';

export interface ComposeActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
  /** The registry's `post_entry` line shape; an intent line adds `side`, `amount` and `gross` to it. */
  LINES: { readonly type: 'array'; readonly items: { readonly properties: Record<string, unknown> } };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

export function composeActions(h: ComposeActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL, LINES } = h;
  const COMPOSE_LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        ...LINES.items.properties,
        side: { type: 'string', enum: ['debit', 'credit'] },
        amount: INT,
        gross: BOOL,
      },
      required: ['account'],
    },
  } as const;

  return [
    ctxAction(
      'compose_entry',
      'read',
      'Compose a journal entry without booking it. mode "expand" turns lines into the exact post_entry lines: an intent line {account, side, amount, gross, taxCode?, supplyDate?, costCenter?} is expanded with its MWST legs (Vorsteuer, Umsatzsteuer, Bezugsteuer, Einfuhrsteuer, the saldo fold, a refund mirrored), a plain line {account, debit|credit, taxCode?, taxBase?, taxAmount?} passes through, and the answer carries the lines, a caption per taxed line and the verdict post_entry would give (vat_trace_unreconciled, period_locked, unbalanced, ...). mode "decompose" reads a stored entry (entryId) or stored lines back into intent and says whether it roundTrips. A bank line instead: mode "expand" with bankTxnId and target (a book_bank_line target of kind accounts, viaAccountId included, or rule with its asks; a computed leg needs no ask) answers exactly the lines book_bank_line would post for it, the rule expanded on the line (target: the accounts target it expands to, computed amounts filled in), and its refusal as the verdict (rule_not_found, ask_missing, rest_is_zero, legs_do_not_sum, line_not_open, ...). D178: EVERY book_bank_line target previews this way (open_item with documentId or allocations, payment_batch, existing_entry, contact, expense_claims, accounts with fx legs), and a bank line\'s answer carries booking { targetKind, bookable, blockedBy (the refusal code book_bank_line would give now, else null), verdict, deviationMinor (line minus legs, allocations or claims), remainder, remainderOptions (what remainder may be now), documents [{ documentId, kind, contactId, openMinor, allocatedMinor, writeOffMinor, openAfterMinor }], contact { contactId, name, counterpartyKind, mode, settingMode, overridden, accountNumber }, claims [{ claimId, title, employeeId, status, totalMinor }], fx { currency, foreignMinor, baseMinor, rate, conversionLines }, entries [{ currency, lines }] (every entry the booking would post, with accountNumber and CHF per line), warnings, consequences [{ code, en, de-CH, reversibility }], acknowledgementsRequired (fx_counter_leg: book with acknowledgeFx: true) }; a settlement, contact or Spesen target is previewed by running the booking and rolling it back, so nothing is written. A Vorlage instead of lines: mode \"expand\" with date and template { standardId (a Vorlage, scope manual, from list_bank_standards), asks { legIndex: amountMinor } } answers the lines post_entry { template } would post (asked amounts are gross on a taxed leg, a same leg copies the asked leg it names, the rest leg balances the entry on its own side) with template { standardId, label, amounts [{ legIndex, side, amount }] }, and its refusal as the verdict (rule_not_found, rule_invalid, wrong_scope for a bank rule, ask_missing, rest_is_zero, rest_changes_side, plus every refusal of typed lines). Post or save the answered lines verbatim.',
      ctxSchema(
        {
          mode: { type: 'string', enum: ['expand', 'decompose'] },
          date: STR,
          entryId: STR,
          lines: COMPOSE_LINES,
          // D175 (A39 §14.2): the bank inbox's preview of a booking, the rule expanded on the line.
          bankTxnId: STR,
          target: { type: 'object' },
          // D176 (A39 §15.2): the composer's Vorlage, expanded into lines by the engine.
          template: { type: 'object' },
        },
        ['mode'],
      ),
      (ctx, input) => {
        // Critic D176-R2-2: a null template is absent (the capability rule reads it the same way).
        if (input['template'] !== undefined && input['template'] !== null && input['mode'] === 'expand') {
          if (input['bankTxnId'] !== undefined || input['lines'] !== undefined) {
            return err('invalid_input', { field: 'template', reason: 'a template replaces the lines, and a bank line is composed with a target' });
          }
          return composeTemplate(ctx, as<ComposeTemplateInput>(input));
        }
        return input['bankTxnId'] !== undefined && input['mode'] === 'expand'
          ? composeBankLine(ctx, as<ComposeBankLineInput>(input))
          : composeEntry(ctx, as<ComposeEntryInput>(input));
      },
    ),
  ];
}
