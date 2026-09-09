/**
 * A04, the opening-balance verb surface: four verbs, of which TWO are read-only.
 *
 * The read/write split is the point rather than the count. An agent can establish the whole opening
 * position (which accounts, which sides, which rows the chart does not know) through
 * `preview_opening_import` before it commits to anything, and a human sees the identical figures
 * because both faces render the same read model. `preview_opening_import` is the read half of
 * `import_opening_balances` and nothing about it can write.
 *
 * ONE NAMING RULE binds both faces, the way "Ausstellen" binds them for issuing. The product's word
 * for this position is **Eröffnungsbilanz** and these descriptions say "opening position"; the word
 * for fixing one is **stornieren**, so the descriptions say a correction is a reversing entry and
 * never "edit" or "delete". A tool description is the only thing an agent has to choose a verb with,
 * so it uses the product's own vocabulary and states the refusals it will actually meet.
 *
 * WHAT THESE DESCRIPTIONS DELIBERATELY DO NOT PROMISE: that a successful import is a reconciled one.
 * The balance check compares Sigma debit against Sigma credit and cannot see a transposed pair, a
 * position missing from both sides, or the wrong file entirely. Saying "reconciled" here would be
 * the same overclaim A07 shipped, so the preview hands back its per-account lines and its unmapped
 * rows and lets the caller compare them against the Beleg.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX established: the registry is
 * the one append-only tool list and several agents append to it at once, so the smaller the hunk the
 * cheaper the merge. The helpers arrive as a parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  setOpeningBalances,
  getOpeningBalances,
  importMigration,
  OPENING_CONTRA_ACCOUNT_NUMBER,
} from '../core/ledger/index.js';
import type { ImportMigrationInput } from '../core/ledger/index.js';

export interface OpeningActionHelpers {
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

export function openingActions(h: OpeningActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  /** One account's opening position: the account by id or number, and exactly one side in Rappen. */
  const OPENING_LINES = {
    type: 'array',
    items: {
      type: 'object',
      properties: { account: STR, debitMinor: INT, creditMinor: INT },
      required: ['account'],
    },
  } as const;

  /** The column roles an import maps. `balance` is the single-signed-column alternative. */
  const MAPPING = {
    type: 'object',
    properties: { account: STR, name: STR, debit: STR, credit: STR, balance: STR },
  } as const;

  const ROWS = { type: 'array', items: { type: 'object' } } as const;

  const IMPORT_FIELDS = {
    format: STR,
    mapping: MAPPING,
    rows: ROWS,
    asOf: STR,
    differenceAccount: STR,
    reference: STR,
  } as const;

  return [
    ctxAction(
      'set_opening_balances',
      'write',
      `Seed the workspace's opening position as ONE balanced, posted, immutable opening entry (Eröffnungsbilanz), each account carrying exactly one side in integer Rappen. Accounts are named by id or by chart number. If the set does not tie out it is REFUSED with the signed Rappen difference and nothing is written: pass differenceAccount (KMU ${OPENING_CONTRA_ACCOUNT_NUMBER} Eröffnungsbilanz is the usual one) to book the delta explicitly, because a difference is never plugged silently. asOf defaults to the fiscal-year start. Once the prior year is closed the position is carried from that close and this verb answers carried_forward. An account that already carries a balance on that date is refused with account_already_has_balance, naming what it holds: seeding on top of it would double-count, and a bank opening balance from set_bank_opening_balance is the usual reason. A posted position has no edit path: correct it with a reversing entry (reverse_entry) and a fresh call under a new key, which this verb accepts once the storno has unwound the old position. reference records the Inventar or Beleg the position is traced to, and get_opening_balances reads it back.`,
      ctxSchema(
        {
          asOf: STR,
          lines: OPENING_LINES,
          differenceAccount: STR,
          reference: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['lines', 'idempotencyKey'],
      ),
      (ctx, input) => setOpeningBalances(ctx, input as never),
    ),
    ctxAction(
      'preview_opening_import',
      'read',
      'Dry-run already-parsed migration rows into an opening position without writing anything: normalises a signed balance column or a debit/credit pair into integer Rappen, resolves each account number against the chart, and reports the rows the chart does not know (unmapped) alongside the balance check. Takes rows as an array of column-value objects, NOT a CSV string: parsing the export into rows is the caller\'s step. It refuses the same things import_opening_balances refuses, including an account named twice, so a preview that comes back clean is not followed by a surprise rejection. This reports what the FILE says and whether its own two sides agree; it cannot tell you the file is the right one, so compare the per-account lines against the Beleg. It takes no idempotency key and can never post.',
      ctxSchema(IMPORT_FIELDS, ['rows']),
      (ctx, input) => importMigration(ctx, { ...(input as unknown as ImportMigrationInput), dryRun: true }),
    ),
    ctxAction(
      'import_opening_balances',
      'write',
      'Import already-parsed migration rows as the opening position, posting exactly what preview_opening_import showed. Takes rows as an array of column-value objects, NOT a CSV string: this verb parses no file, and turning an export into rows is the caller\'s step. Refuses with unmapped_account when any row names an account the chart does not have, because importing the rest would post a position that balances only because a row was dropped. A row with no account at all (what a subtotal or Total line looks like) is refused as invalid_row naming that row, rather than blamed on the mapping. format accepts csv or bexio, which select default column names; mapping overrides them field by field for an export with different headers. Retrying the same idempotencyKey returns the existing entry and never a second opening position.',
      ctxSchema({ ...IMPORT_FIELDS, dryRun: BOOL, idempotencyKey: STR }, ['rows', 'idempotencyKey']),
      // `dryRun` is pinned false rather than passed through: a WRITE verb that a flag could turn into
      // a read is a verb whose annotation lies, and `preview_opening_import` already IS that read.
      (ctx, input) => importMigration(ctx, { ...(input as unknown as ImportMigrationInput), dryRun: false }),
    ),
    ctxAction(
      'get_opening_balances',
      'read',
      "Read the opening position for a fiscal year: the seeded entry when there is one, or the balance sheet carried from the prior year's close (source=carried_forward, editable=false), or none. Returns each account with its number, name, type and side in Rappen, plus the totals and the reference (the Inventar or Beleg the position is traced to, null when none was given). A position that was reversed reads as source=none, because the ledger no longer holds it. A carried position is derived from the close and is not re-keyable: A03 owns the year-end result posting. If a carried position does not tie out it is REFUSED with carried_position_unbalanced rather than handed on, naming the signed difference and unclosedYears: an unclosed prior year leaves its result on Erfolgsrechnung accounts that a balance sheet does not carry, and every report above this one would be built on the gap.",
      ctxSchema({ year: STR }),
      (ctx, input) => getOpeningBalances(ctx, input as never),
    ),
  ];
}
