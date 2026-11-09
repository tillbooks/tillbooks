/**
 * `journal_numbering_plan`, A02's Belegnummer inspection read (D178 point 2, A02 §4b.6), defined here and
 * spread into `ACTIONS` as one line under the A02 banner (the `composeActions` / `fxActions` precedent), so
 * several agents appending to the append-only registry at once collide over a line rather than a block.
 *
 * There is deliberately NO write verb beside it: a number is assigned only inside `postEntry`'s own
 * transaction (the chokepoint in `core/ledger/entryNumber.ts`), and the backfill after an upgrade is the
 * generation-17 data step. A verb that could number, renumber or skip would be a second door to the run.
 *
 * The helpers arrive as a parameter rather than an import, so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { journalNumberingPlan } from '../core/ledger/index.js';
import type { ActionKind } from './actionKind.js';

export interface JournalNumberingActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
}

export function journalNumberingActions(h: JournalNumberingActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema } = h;
  return [
    ctxAction(
      'journal_numbering_plan',
      'read',
      'Inspect the Belegnummer run of the book without writing anything: the numbering settings in force (ledger.belegnummer_mode, _start, _prefix, _split_voucher), how many posted entries are numbered, unnumbered and adopted, whether a catch-up is owed, every series with its next number, the migrated entries (source import) classified by their ref (plain integers and bexio refs, the highest migrated number, the split vouchers, the duplicates: claims that do not read their old number because different vouchers claim it, with the entry that keeps it, and groups of entries with identical content flagged as a possible double import for a person to check, and the non-numeric refs), and the numbers the next catch-up would assign to the posted entries still without one. Lists are capped at 200 rows, each with its total.',
      ctxSchema(),
      (ctx) => journalNumberingPlan(ctx),
    ),
  ];
}
