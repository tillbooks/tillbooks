/**
 * A15, the Mahnwesen verb surface: propose, issue, send, and the reads around them.
 *
 * Eight tools, four writes. The vocabulary is the product's own (the A14/A16 rule): the surface is
 * the **Mahnwesen**, a batch is a **Mahnlauf**, the fee is the **Mahngebühr**, the interest note is
 * the **Verzugszins**. A tool description is the only thing an agent has to pick a verb with.
 *
 * THE AGENT STORY IS THE SPLIT (US-A15.5): `propose_dunning_run` persists a reviewable draft and
 * nothing else, so an agent (or a G01 rule) may call it freely; `issue_dunning_run` and
 * `send_dunning_run` are the commitment and the outbound act, each P8-gated inside the engine
 * (`confirmed: true` or the workspace dial), so the human approves what actually reaches a
 * customer. There is deliberately no delete and no un-issue: a mistaken fee is corrected by
 * `reverse_entry` (§H-AUDIT), and a mistaken proposal simply never gets issued.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX established: the registry
 * is one append-only tool list several capability branches append to at once, so the smaller the
 * hunk, the cheaper the merge. The helpers arrive as a parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  getDunningConfig,
  setDunningConfig,
  proposeDunningRun,
  issueDunningRun,
  sendDunningRun,
  renderDunningPdf,
  listDunningRuns,
  getDunningRun,
} from '../core/dunning/index.js';

export interface DunningActionHelpers {
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

export function dunningActions(h: DunningActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  const LEVELS = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        level: INT,
        daysOverdue: INT,
        minIntervalDays: INT,
        feeMinor: INT,
        bookFee: BOOL,
        feeIncomeAccountId: STR,
        showInterest: BOOL,
        interestBp: INT,
        templateKey: STR,
      },
      required: ['level', 'daysOverdue'],
    },
  } as const;

  return [
    ctxAction(
      'get_dunning_config',
      'read',
      `The Mahnwesen policy: the three escalation levels with their days-overdue thresholds, the Mahngebühr per level (amount and fee-income account; a positive fee always books, and its VAT follows the chased invoice's own rates automatically per D69), the Verzugszins note settings (Art. 104 OR: 5% p.a. is the statutory default, only a HIGHER contractual rate is configurable), and whether this workspace chose the policy or is on the shipped defaults (1./2./3. Mahnung at 10/20/30 days overdue, no fee, no interest note). Reads only.`,
      ctxSchema(),
      (ctx) => getDunningConfig(ctx),
    ),
    ctxAction(
      'set_dunning_config',
      'write',
      `Set the Mahnwesen policy: all three levels in one write, thresholds strictly increasing. A Mahngebühr has NO statutory basis and is chargeable only when contractually agreed, so it defaults to zero; a positive fee always BOOKS (the letter demands exactly what books) and needs an income account. There is no tax code to configure: the fee's VAT splits pro rata across the chased invoice's own rate bases at issue (D69, ESTV practice: the fee is part of the underlying supply's Entgelt). minIntervalDays per level is the minimum days that must pass after the previous level's letter issued before this level is reached (default 10), so an invoice already past every threshold escalates one letter per interval rather than 1./2./3. in three days; 0 disables the spacing for that level. The Verzugszins rate floor is 500 bp (Art. 104 OR) and the note is computed on the invoice principal, actual days over 365. A repeat call under the same idempotencyKey writes nothing.`,
      ctxSchema({ levels: LEVELS, idempotencyKey: STR }, ['levels', 'idempotencyKey']),
      (ctx, input) => setDunningConfig(ctx, input as never),
    ),
    ctxAction(
      'propose_dunning_run',
      'write',
      `Propose a Mahnlauf: read the overdue open items from the OP-Liste (A16) as of a date, assign each invoice its next level (1./2./3. Mahnung; an invoice whose 3. Mahnung is issued is terminal), group per debtor, and persist a reviewable DRAFT run. Nothing is booked, rendered or sent: this is the safe half, and the reason an agent or an automation rule may call it without a confirmation. One run per day: re-proposing the same day returns the existing run. A fully paid invoice never appears; a partly paid one appears with its reduced open amount. asOf may look back but never forward.`,
      ctxSchema({ asOf: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => proposeDunningRun(ctx, input as never),
    ),
    ctxAction(
      'issue_dunning_run',
      'write',
      `Issue a proposed Mahnlauf: re-check every item against the OP-Liste as of today (a settled invoice drops out, a shrunken one shrinks) AND against the escalation state (one issued reminder per level per invoice: an item another run already issued at this level drops as stale), freeze the items and the Verzugszins note figures (Art. 104 OR, on the invoice principal), and, when the policy books a Mahngebühr, post ONE entry (debit 1100 Debitoren, credit the fee-income account, the fee's VAT split pro rata across each chased invoice's own rate bases per D69). A locked period skips the fee, names it on the run, and the run still issues; calling issue again on that run with a NEW idempotency key BOOKS the skipped fee once the period is open, and the booking never rewrites the letter (D73: the demand froze at issue; the recovered fee joins the next escalation letter or ordinary collection on the OP-Liste). Reusing the ORIGINAL issue key on such a run replays the issue's own answer while the period is still locked, and refuses recovery_needs_its_own_key once it is open (a retry and a recovery are indistinguishable under one key, so the engine refuses rather than guesses; the payload names the remedy). P8: pass confirmed=true or enable the workspace dial. The letters exist from here on via get_dunning_pdf. A mistaken fee is corrected by reverse_entry, never an edit.`,
      ctxSchema({ runId: STR, confirmed: BOOL, idempotencyKey: STR }, ['runId', 'idempotencyKey']),
      (ctx, input) => issueDunningRun(ctx, input as never),
    ),
    ctxAction(
      'get_dunning_pdf',
      'read',
      `Render one debtor's reminder letter from an issued Mahnlauf, base64-encoded: the creditor block, the overdue invoice list with days overdue (earlier Mahngebühren itemised separately from the invoice's own open amount), the Mahngebühr, the Verzugszins note, and one Swiss QR payment part PER INVOICE (amount = that invoice's open amount + the fee AS DEMANDED AT ISSUE, reference = the invoice's own QRR/SCOR, so the payment still matches the invoice). The demand FREEZES at issue (D73): every FIGURE renders from the issue-time snapshot, so a reprint states exactly the amounts that were mailed, and a fee recovered after a period lock joins the NEXT escalation letter, never this one; the creditor and debtor blocks and the QR payload's party data render CURRENT master data. Nothing is stored. A proposed run has no letter yet.`,
      ctxSchema({ runId: STR, debtorId: STR }, ['runId', 'debtorId']),
      (ctx, input) => renderDunningPdf(ctx, input as never),
    ),
    ctxAction(
      'send_dunning_run',
      'write',
      `Email an issued Mahnlauf's letters, one per debtor, through the configured transport. Settlement is re-checked against the OP-Liste (A16) at the moment of sending: a letter naming ANY invoice that CHANGED since issue (a payment partial OR full, a cancellation, or a credit note) is skipped whole, counted and named by its distinct cause (outcome paid | partially_paid | cancelled | credited, plus a changedItems list and the skippedSettled document ids on the result), because the frozen letter cannot shed an item and must never chase an invoice whose demand is no longer true (US-A15.4); the frozen run record stays untouched (D73). The same re-check rides get_dunning_run, so the Studio warns before a manual download too (the MIT core has no transport). Per-debtor outcomes are recorded (sent, no_email, send_failed, and the four change causes), a retry sends only what has not gone out, and the run turns 'sent' when every debtor's letter has. Degrades honestly: needs_email_config when no transport exists, needs_email_transport when one is configured but not wired, and a debtor without an email keeps a downloadable PDF. P8: outbound is draft-by-default, pass confirmed=true or enable the workspace dial.`,
      ctxSchema({ runId: STR, confirmed: BOOL, idempotencyKey: STR }, ['runId', 'idempotencyKey']),
      (ctx, input) => sendDunningRun(ctx, input as never),
    ),
    ctxAction(
      'list_dunning_runs',
      'read',
      `The Mahnlauf history, newest first: each run's date, status (proposed/issued/sent), item and debtor counts, highest level, and whether a fee was booked or skipped by a period lock. Filter by status or date range. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here. Reads only.`,
      ctxSchema({ status: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listDunningRuns(ctx, input as never),
    ),
    ctxAction(
      'get_dunning_run',
      'read',
      `Read one Mahnlauf in full: every item (invoice, debtor, level, open amount, Mahngebühr, Verzugszins note, days overdue) and the per-debtor letter groups with their send outcomes. Reads only.`,
      ctxSchema({ runId: STR }, ['runId']),
      (ctx, input) => getDunningRun(ctx, input as never),
    ),
  ];
}
