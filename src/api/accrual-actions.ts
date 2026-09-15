/**
 * A38, Abgrenzungen und Rückstellungen: the verb surface, defined here and spread into `ACTIONS`
 * as ONE line (the `fxActions` / `assetActions` precedent), so several agents appending to the
 * append-only registry at once collide over a line rather than a block.
 *
 * TWO OWNERS BY BLOCK (D129 build graph). The TOP block is N2's: the six `accrual_*` verbs, the
 * eight `provision_*` verbs and `tax_provision_preview`. The BOTTOM block, below the marked seam, is
 * N3's: the four `vat_settlement_*` verbs and `vat_annual_reconciliation`. Each block is appended in
 * its own hunk so the union merge keeps both.
 *
 * Every write gates on `post` (the posting domain: every one of them reaches `postEntry`, which
 * asserts it), every read on `read_books`. The entry-minting writes sit at the `post` dial tier
 * (`src/core/agent/dialMap.ts`) and all writes are in `NOT_AUTOMATABLE`: a rule must never accrue,
 * provision or settle unattended.
 *
 * The helpers arrive as a parameter rather than an import to keep the module graph acyclic (see
 * `fx-actions.ts`).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  accrualCreate,
  accrualGet,
  accrualList,
  accrualDiscard,
  accrualPost,
  accrualReverse,
  provisionCreate,
  provisionGet,
  provisionList,
  provisionDiscard,
  provisionPost,
  provisionRelease,
  provisionReleaseReverse,
  provisionReverse,
  taxProvisionPreview,
  vatSettlementPreview,
  vatSettlementPost,
  vatSettlementReverse,
  vatSettlementList,
  vatAnnualReconciliation,
} from '../core/accruals/index.js';

export interface AccrualActionHelpers {
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
}

/** The A38 verbs, in append order: N2's block first, N3's block after the seam. */
export function accrualActions(h: AccrualActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;
  return [
    // --- N2: accruals (OR 958b) -------------------------------------------------------------------
    ctxAction(
      'accrual_create',
      'write',
      "Describe an Abgrenzung (OR Art. 958b) and save it as a DRAFT: `kind` is one of prepaid_expense (Aufwand vorausbezahlt, Dr 1300), accrued_income (Ertrag noch nicht fakturiert, Dr 1300), accrued_expense (Aufwand noch nicht fakturiert, Cr 2300) or deferred_income (Ertrag vorausbezahlt erhalten, Cr 2300); `contraAccount` is the P&L account (number or id, income for the income kinds, expense for the expense kinds); `amountMinor` is integer Rappen; `periodEnd` is the balance-sheet date. Returns the draft with the exact lines the post will write and the reversal lines dated the day after. Nothing is posted.",
      ctxSchema(
        {
          kind: STR,
          periodEnd: STR,
          amountMinor: INT,
          contraAccount: STR,
          description: STR,
          sourceRef: STR,
          costCenterId: STR,
          currency: STR,
          idempotencyKey: STR,
        },
        ['kind', 'periodEnd', 'amountMinor', 'contraAccount', 'description', 'idempotencyKey'],
      ),
      (ctx, input) => accrualCreate(ctx, input as never),
    ),
    ctxAction(
      'accrual_post',
      'write',
      "Post a drafted Abgrenzung as an atomic PAIR: the accrual entry dated `periodEnd` (source `accrual`) and its automatic Rückbuchung dated the first day after (a real reversal, linked). A locked reversal date rolls the whole pair back, so the books never carry an accrual without the reversal that backs it out. Idempotent per accrual: the same key replays, a different key on a posted accrual is `already_posted`, a discarded draft is `draft_discarded`.",
      ctxSchema({ accrualId: STR, idempotencyKey: STR }, ['accrualId', 'idempotencyKey']),
      (ctx, input) => accrualPost(ctx, input as never),
    ),
    ctxAction(
      'accrual_reverse',
      'write',
      "Revert a posted Abgrenzung without editing history: posts the MIRROR pair (the Storno dated `periodEnd`, its own reversal dated the day after), so all four entries net to zero on every account in both periods. Refuses `already_reversed` a second time and `not_posted` on a draft.",
      ctxSchema({ accrualId: STR, reason: STR, idempotencyKey: STR }, ['accrualId', 'idempotencyKey']),
      (ctx, input) => accrualReverse(ctx, input as never),
    ),
    ctxAction(
      'accrual_discard',
      'write',
      'Retire a drafted Abgrenzung before it posts. The row stays on record as `discarded` with its reason; a posted accrual cannot be discarded (`already_posted`), reverse it instead.',
      ctxSchema({ accrualId: STR, reason: STR, idempotencyKey: STR }, ['accrualId', 'idempotencyKey']),
      (ctx, input) => accrualDiscard(ctx, input as never),
    ),
    ctxAction(
      'accrual_get',
      'read',
      'Read one Abgrenzung: the row, its lines and reversal lines (from the same function the post uses), and the journal entries it has produced (the accrual, its reversal, the Storno pair).',
      ctxSchema({ accrualId: STR }, ['accrualId']),
      (ctx, input) => accrualGet(ctx, input as never),
    ),
    ctxAction(
      'accrual_list',
      'read',
      'List Abgrenzungen, newest period first, filtered by periodEnd, status (draft | posted | reversed | discarded) or kind. `totalMinor` sums the drafts and the posted ones. savedViewId applies a saved view (G00).',
      ctxSchema({ periodEnd: STR, status: STR, kind: STR, savedViewId: STR }),
      (ctx, input) => accrualList(ctx, input as never),
    ),

    // --- N2: provisions (OR 960e) -----------------------------------------------------------------
    ctxAction(
      'provision_create',
      'write',
      "Describe a Rückstellung (OR Art. 960e) and save it as a DRAFT: `reason` is one of the eight statutory ids (Garantie, Ferien und Überzeit, Prozess, Grossreparatur, Sanierung, Restrukturierung, Steuern, Sonstige; `invalid_reason` names the exact ids, and `sonstige` needs a description of at least 10 characters); `provisionAccount` is 2330, 2600 or a liability numbered 23xx/26xx; `expenseAccount` is the P&L account the formation is charged to. Returns the draft with its lines (Dr expense / Cr provision). Nothing is posted.",
      ctxSchema(
        {
          reason: STR,
          periodEnd: STR,
          amountMinor: INT,
          provisionAccount: STR,
          expenseAccount: STR,
          description: STR,
          idempotencyKey: STR,
        },
        ['reason', 'periodEnd', 'amountMinor', 'provisionAccount', 'expenseAccount', 'description', 'idempotencyKey'],
      ),
      (ctx, input) => provisionCreate(ctx, input as never),
    ),
    ctxAction(
      'provision_post',
      'write',
      'Post a drafted Rückstellung as ONE entry (Dr expense / Cr provision, source `provision`) dated `periodEnd`. No automatic reversal: OR 960e Abs. 4 does not release a provision by the calendar. Idempotent per provision; a different key on a posted one is `already_posted`.',
      ctxSchema({ provisionId: STR, idempotencyKey: STR }, ['provisionId', 'idempotencyKey']),
      (ctx, input) => provisionPost(ctx, input as never),
    ),
    ctxAction(
      'provision_release',
      'write',
      'Release part or all of a posted Rückstellung: posts Dr provision / Cr `targetAccount` (the original expense account, or an income account) for `amountMinor` on `date`. Refuses `release_exceeds_balance` above the open balance; the provision reads `released` at zero. Idempotent on `idempotencyKey` for as long as the release that key booked still stands; a key whose release was undone refuses `already_reversed_key` (release again under a new key). A release is undone only with `provision_release_reverse`; the raw `reverse_entry` refuses its entry with `owned_by`.',
      ctxSchema(
        { provisionId: STR, date: STR, amountMinor: INT, targetAccount: STR, idempotencyKey: STR },
        ['provisionId', 'date', 'amountMinor', 'targetAccount', 'idempotencyKey'],
      ),
      (ctx, input) => provisionRelease(ctx, input as never),
    ),
    ctxAction(
      'provision_reverse',
      'write',
      'Reverse the formation entry of a posted Rückstellung (a real reversing entry, dated `periodEnd` unless `date` names another open day). Refuses `release_blocked` while any release stands unreversed (undo the releases first through `provision_release_reverse`, newest first) and `already_reversed` a second time. This is the ONLY way to reverse the formation: the raw `reverse_entry` refuses it with `owned_by`.',
      ctxSchema({ provisionId: STR, date: STR, reason: STR, idempotencyKey: STR }, ['provisionId', 'idempotencyKey']),
      (ctx, input) => provisionReverse(ctx, input as never),
    ),
    ctxAction(
      'provision_release_reverse',
      'write',
      'Undo one release of a Rückstellung with a real reversing entry (dated the release date unless `date` names another open day), so the open balance and the `posted` / `released` reading follow from the journal again. This is the ONLY way to reverse a release entry: the raw `reverse_entry` refuses it with `owned_by`, and so it refuses the undo itself. Refuses `not_found` and `already_reversed`. Idempotent on `idempotencyKey`.',
      ctxSchema({ releaseId: STR, date: STR, reason: STR, idempotencyKey: STR }, ['releaseId', 'idempotencyKey']),
      (ctx, input) => provisionReleaseReverse(ctx, input as never),
    ),
    ctxAction(
      'provision_discard',
      'write',
      'Retire a drafted Rückstellung before it posts. The row stays on record as `discarded` with its reason; a posted provision cannot be discarded (`already_posted`), reverse or release it instead.',
      ctxSchema({ provisionId: STR, reason: STR, idempotencyKey: STR }, ['provisionId', 'idempotencyKey']),
      (ctx, input) => provisionDiscard(ctx, input as never),
    ),
    ctxAction(
      'provision_get',
      'read',
      'Read one Rückstellung: the row, its formation lines, every release with its entry (and the reversal of that entry, when one exists) and the open balance, derived as the formation amount minus the live releases.',
      ctxSchema({ provisionId: STR }, ['provisionId']),
      (ctx, input) => provisionGet(ctx, input as never),
    ),
    ctxAction(
      'provision_list',
      'read',
      'List Rückstellungen, newest period first, each with its open balance, filtered by periodEnd, status (draft | posted | released | reversed | discarded) or reason. `openTotalMinor` sums the open balances. savedViewId applies a saved view (G00).',
      ctxSchema({ periodEnd: STR, status: STR, reason: STR, savedViewId: STR }),
      (ctx, input) => provisionList(ctx, input as never),
    ),
    ctxAction(
      'tax_provision_preview',
      'read',
      "Propose the Steuerrückstellung for the fiscal year to `periodEnd` the way Kanton Zürich ZStB 27/1 computes it: profit before tax times s/(1+s) at `rateBp` (default 2000 = 20 %, the rate is cantonal and yours to set), minus the instalments already charged to 8900, never below zero. Returns the figures and a ready `provision_create` draft (reason steuern, Dr 8900 / Cr 2330). On an Einzelfirma answers applicable:false. A read: nothing is posted.",
      ctxSchema({ periodEnd: STR, rateBp: INT }, ['periodEnd']),
      (ctx, input) => taxProvisionPreview(ctx, input as never),
    ),
  ];
}

// A38, MWST-Saldierung und Abstimmung.
//
// Four settlement verbs (two writes, two reads) and the annual reconciliation read. The two reads are
// PURE (design doc §7.7): `vat_settlement_preview` returns the model `vat_settlement_post` writes,
// so what the human saw is what posts, by construction rather than by agreement. Every write carries
// `workspaceId` + `idempotencyKey`, gates on `post`, sits at the `post` dial tier with its consequence
// sentence, and is in `NOT_AUTOMATABLE`: a rule must never settle a filed period unattended.


/** The MWST-Saldierung verbs, in append order. */
export function vatSettlementActions(h: AccrualActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'vat_settlement_preview',
      'read',
      "Preview the MWST-Saldierung of one filed period (`period` is the A07 label, `2026-Q3` or `2026-H1`): the booked movement on 2200 (Umsatzsteuer), 1170 and 1171 (Vorsteuer) over the period beside the return's Ziffer 399 and 400 + 405 with the differences, and the exact lines the post would book (Dr 2200 / Cr 2201, Dr 2201 / Cr 1170, Dr 2201 / Cr 1171; under the Saldosteuersatz the flat-rate tax due against 3809). Settlement entries and their reversals are excluded from the read, so a settled period previews as settled, never twice. A read: nothing is posted.",
      ctxSchema({ period: STR }, ['period']),
      (ctx, input) => vatSettlementPreview(ctx, input as never),
    ),
    ctxAction(
      'vat_settlement_post',
      'write',
      "Book the MWST-Saldierung the preview showed: transfer the filed period's balances on 2200, 1170 and 1171 to 2201 (MWST-Abrechnungskonto), dated the period end, `source='vat_settlement'`, so the three tax accounts read zero and 2201 carries what the ESTV is owed. Admitted inside the filed, hard-locked period under three enforced conditions (no VAT trace, only the tax accounts, never into a year-close seal); the filed return and the Abstimmung are unchanged by it. Refuses `period_not_filed` before the filing, `nothing_to_settle` on an empty period, `already_posted` while a settlement of the period stands, `period_locked` with reason `year_close` on a sealed year. Idempotent on `idempotencyKey` for as long as the settlement that key booked still stands; a key whose settlement was reversed refuses `already_reversed_key` (post again under a new key, which books a new settlement). The correction is `vat_settlement_reverse`.",
      ctxSchema({ period: STR, idempotencyKey: STR }, ['period', 'idempotencyKey']),
      (ctx, input) => vatSettlementPost(ctx, input as never),
    ),
    ctxAction(
      'vat_settlement_reverse',
      'write',
      'Reverse a posted MWST-Saldierung with a reversing entry dated the period end, so 2200, 1170, 1171 and 2201 net to zero again inside the settled period; the settlement row reads `reversed` and keeps its history, and a later `vat_settlement_post` for the period books a new settlement. This is the ONLY way to reverse a settlement entry: the generic `reverse_entry` refuses it with `owned_by`, because the settlement row must move with the mirror. Refuses `not_found` and `already_reversed`. Idempotent on `idempotencyKey`.',
      ctxSchema({ settlementId: STR, idempotencyKey: STR }, ['settlementId', 'idempotencyKey']),
      (ctx, input) => vatSettlementReverse(ctx, input as never),
    ),
    ctxAction(
      'vat_settlement_list',
      'read',
      'List the MWST-Saldierungen on record, newest period first, posted and reversed, with the moved figures and the entry ids. `year` (YYYY) narrows to one Steuerperiode. A read.',
      ctxSchema({ year: STR }),
      (ctx, input) => vatSettlementList(ctx, input as never),
    ),
    ctxAction(
      'vat_annual_reconciliation',
      'read',
      "The two annual MWST reconciliations of a calendar year as figures (Art. 128 Abs. 2 and 3 MWSTV, the ESTV's Umsatz- and Vorsteuerabstimmung): the class-3 revenue per the books adjusted for the accruals and disposal proceeds the ledger can name against the sum of Ziffer 200 of the year's returns, and the booked Vorsteuer on 1170 + 1171 against the sum of Ziffer 400 + 405, each with its difference and a status (`match`, `warn`, or `unavailable` naming the periods not yet filed). Under the Saldosteuersatz the Vorsteuer half is not applicable; a workspace with no MWST method answers `applicable: false`. A read.",
      ctxSchema({ year: STR }, ['year']),
      (ctx, input) => vatAnnualReconciliation(ctx, input as never),
    ),
  ];
}
