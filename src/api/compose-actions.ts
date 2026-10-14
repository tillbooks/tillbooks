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
      'Compose a journal entry without booking it. mode "expand" turns lines into the exact post_entry lines: an intent line {account, side, amount, gross, taxCode?, supplyDate?, costCenter?} is expanded with its MWST legs (Vorsteuer, Umsatzsteuer, Bezugsteuer, Einfuhrsteuer, the saldo fold, a refund mirrored), a plain line {account, debit|credit, taxCode?, taxBase?, taxAmount?} passes through, and the answer carries the lines, a caption per taxed line and the verdict post_entry would give (vat_trace_unreconciled, period_locked, unbalanced, ...). mode "decompose" reads a stored entry (entryId) or stored lines back into intent and says whether it roundTrips. Post or save the answered lines verbatim.',
      ctxSchema(
        {
          mode: { type: 'string', enum: ['expand', 'decompose'] },
          date: STR,
          entryId: STR,
          lines: COMPOSE_LINES,
        },
        ['mode'],
      ),
      (ctx, input) => composeEntry(ctx, as<ComposeEntryInput>(input)),
    ),
  ];
}
