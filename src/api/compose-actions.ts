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

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { composeEntry } from '../core/ledger/compose.js';
import type { ComposeEntryInput } from '../core/ledger/compose.js';
import { composeBankLine } from '../core/banking/bankBooking.js';
import type { ComposeBankLineInput } from '../core/banking/bankBooking.js';
import { composeTemplate } from '../core/banking/bankTemplates.js';
import type { ComposeTemplateInput } from '../core/banking/bankTemplates.js';
import { err, ok } from '../core/result.js';
import type { ActionKind } from './actionKind.js';
import { batchMaxItems } from './batch-actions.js';
// N01 US-N01.1: a bank target's account fields take an id or its number, resolved at the input boundary.
import { ACCOUNT_REF, unknownFields, unknownFieldsMode, unknownFieldRefusal } from './input-boundary.js';
import { isGovernedSeat } from '../core/access/index.js';

export interface ComposeActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
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

  /**
   * N01 US-N01.1: the account fields of a bank target, marked so the input boundary resolves a number to
   * its id exactly as for `book_bank_line`. Only the account fields are declared: the rest of the target
   * passes through untouched, and `book_bank_line`'s own schema documents it.
   */
  const COMPOSE_TARGET = {
    type: 'object',
    properties: {
      legs: { type: 'array', items: { type: 'object', properties: { accountId: ACCOUNT_REF } } },
      writeOffAccountId: ACCOUNT_REF,
      viaAccountId: ACCOUNT_REF,
    },
  } as const;

  /**
   * N01 US-N01.2: many compositions in one read. Every item is one `compose_entry` input with its own
   * `mode`, run through THIS verb's own dispatch (`self.run`: the tenant check, the A24 gate and the input
   * boundary per item), so an item answers exactly what the single call would, and one item's malformed
   * input or unknown account is that item's refusal, never the batch's. Writes nothing, like every compose.
   */
  const composeItems = (ctx: WorkspaceContext, deps: ApiDeps, input: ActionInput): Result => {
    const items = input['items'];
    if (!Array.isArray(items) || items.length === 0) {
      return err('invalid_input', { field: 'items', reason: 'items is a non-empty list of compose_entry inputs' });
    }
    for (const other of ['mode', 'date', 'entryId', 'lines', 'bankTxnId', 'target', 'template']) {
      if (input[other] !== undefined) return err('invalid_input', { field: other, reason: 'with items, every item carries its own fields' });
    }
    const max = batchMaxItems(ctx);
    if (items.length > max) return err('batch_too_large', { field: 'items', count: items.length, max, setting: 'agent.batch_max_items' });
    const answers = items.map((item: unknown, index: number) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item) || 'items' in item) {
        return { index, ok: false, refusal: err('invalid_input', { field: `items[${index}]`, reason: 'an item is one compose_entry input (an object, no nested items)' }) };
      }
      // N01 critic: an item meets the unknown-field check a single call meets at the transport seam.
      const unknown = unknownFields(self.inputSchema, item as Record<string, unknown>);
      const mode = unknown.length === 0 ? 'ignore' : unknownFieldsMode(ctx, isGovernedSeat(ctx.store, ctx.actor));
      if (mode === 'refuse') return { index, ok: false, refusal: unknownFieldRefusal('compose_entry', unknown) };
      // The outer workspace wins: an item never composes in another tenant (§H-TENANT).
      const answer = self.run(deps, { ...(item as Record<string, unknown>), workspaceId: input['workspaceId'] });
      const warnings = mode === 'warn' ? { warnings: unknown } : {};
      if (!answer.ok) return { index, ok: false, refusal: answer, ...warnings };
      const verdict = (answer as { verdict?: unknown }).verdict ?? { ok: true };
      return { index, ok: true, verdict, result: answer, ...warnings };
    });
    const bookable = answers.filter((a) => a.ok && 'verdict' in a && (a.verdict as { ok?: unknown }).ok === true).length;
    return ok({ items: answers, count: answers.length, bookable, notBookable: answers.length - bookable });
  };

  const self: ActionDef = ctxAction(
      'compose_entry',
      'read',
      'Compose a journal entry without booking it. mode "expand" turns lines into the exact post_entry lines: an intent line {account, side, amount, gross, taxCode?, supplyDate?, costCenter?} is expanded with its MWST legs (Vorsteuer, Umsatzsteuer, Bezugsteuer, Einfuhrsteuer, the saldo fold, a refund mirrored), a plain line {account, debit|credit, taxCode?, taxBase?, taxAmount?} passes through, and the answer carries the lines, a caption per taxed line and the verdict post_entry would give (vat_trace_unreconciled, period_locked, unbalanced, ...). mode "decompose" reads a stored entry (entryId) or stored lines back into intent and says whether it roundTrips. A bank line instead: mode "expand" with bankTxnId and target (a book_bank_line target of kind accounts, viaAccountId included, or rule with its asks; a computed leg needs no ask) answers exactly the lines book_bank_line would post for it, the rule expanded on the line (target: the accounts target it expands to, computed amounts filled in), and its refusal as the verdict (rule_not_found, ask_missing, rest_is_zero, legs_do_not_sum, line_not_open, ...). D178: EVERY book_bank_line target previews this way (open_item with documentId or allocations, payment_batch, existing_entry, contact, expense_claims, accounts with fx legs), and a bank line\'s answer carries booking { targetKind, bookable, blockedBy (the refusal code book_bank_line would give now, else null), verdict, deviationMinor (line minus legs, allocations or claims), remainder, remainderOptions (what remainder may be now), documents [{ documentId, kind, contactId, openMinor, allocatedMinor, writeOffMinor, openAfterMinor }], contact { contactId, name, counterpartyKind, mode, settingMode, overridden, accountNumber }, claims [{ claimId, title, employeeId, status, totalMinor }], fx { currency, foreignMinor, baseMinor, rate, conversionLines }, entries [{ currency, lines }] (every entry the booking would post, with accountNumber and CHF per line), warnings, consequences [{ code, en, de-CH, reversibility }], acknowledgementsRequired (fx_counter_leg: book with acknowledgeFx: true) }; a settlement, contact or Spesen target is previewed by running the booking and rolling it back, so nothing is written. A Vorlage instead of lines: mode \"expand\" with date and template { standardId (a Vorlage, scope manual, from list_bank_standards), asks { legIndex: amountMinor } } answers the lines post_entry { template } would post (asked amounts are gross on a taxed leg, a same leg copies the asked leg it names, the rest leg balances the entry on its own side) with template { standardId, label, amounts [{ legIndex, side, amount }] }, and its refusal as the verdict (rule_not_found, rule_invalid, wrong_scope for a bank rule, ask_missing, rest_is_zero, rest_changes_side, plus every refusal of typed lines). Post or save the answered lines verbatim. N01: items [{ mode, ... }] composes many in one call: one answer per item { index, ok, verdict, result } (or { index, ok: false, refusal } for an item the single call would refuse), plus count, bookable and notBookable; nothing is written, and items is bounded by the setting agent.batch_max_items (batch_too_large). An account in lines or in a bank target may be named by its number (6500).',
      ctxSchema(
        {
          mode: { type: 'string', enum: ['expand', 'decompose'] },
          date: STR,
          entryId: STR,
          lines: COMPOSE_LINES,
          // D175 (A39 §14.2): the bank inbox's preview of a booking, the rule expanded on the line.
          bankTxnId: STR,
          target: COMPOSE_TARGET,
          // D176 (A39 §15.2): the composer's Vorlage, expanded into lines by the engine.
          template: { type: 'object' },
          // N01 US-N01.2: many compositions, each a compose_entry input with its own mode.
          items: { type: 'array', items: { type: 'object' } },
        },
        // N01: `mode` is required per composition; with `items` each item carries its own.
        [],
      ),
      (ctx, input, deps) => {
        if (input['items'] !== undefined) return composeItems(ctx, deps, input);
        if (input['mode'] !== 'expand' && input['mode'] !== 'decompose') {
          return err('invalid_input', { field: 'mode', allowed: ['expand', 'decompose'] });
        }
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
    );
  return [self];
}
