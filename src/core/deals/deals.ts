/**
 * C01, leads & deals: the pre-financial pipeline spine between C00's contacts and the documents
 * A10/C02 turn money into.
 *
 * A DEAL NEVER TOUCHES THE JOURNAL. Its value is an estimate, not a ledger row: this module imports
 * neither `postEntry` nor `recordPayment` (asserted by test), and the only money math it performs
 * is the read-time weighting over an integer base that §H-FX froze at capture. Revenue exists when
 * A11 issues an invoice, not when a card changes column (P3 satisfied by having nothing to post).
 *
 * THE §H-FX TRIO IS FROZEN AT CAPTURE. `value_minor` (txn), `value_base_minor` (workspace base) and
 * `fx_rate` are derived ONCE, through `resolveFxRate` and `convertMinor` (the same resolver every
 * money verb prices through), when the deal is created or its value/currency is patched. A later
 * rate change never rewrites a row, so C03's cross-currency roll-up sums figures that were all
 * computed the same way (spec §4).
 *
 * STATUS HAS ONE DOOR. `moveDeal` moves freely between OPEN stages and refuses an outcome-flagged
 * one; `markDeal` is the only writer of `status` and performs the terminal move itself (and the
 * reopen, `open` being a legal target so a misclick is corrected by writing the row again). That
 * split is what keeps the automation registry honest: `deal.stage_changed` rides `deals_move`,
 * `deal.won`/`deal.lost` ride `deals_mark` through the result-path null-collapse.
 *
 * EVERY DEAL EVENT LANDS ON THE CONTACT TIMELINE through C00's `logActivity` (OP5): create, stage
 * move, win/lose, reopen, conversion. One seam, one stream, no parallel history (spec §2).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { readContact, resolveMergeChain } from '../sales/contact.js';
import { logActivity } from '../sales/contactActivity.js';
import { applySavedView } from '../customization/views.js';
import { resolveFxRate } from '../fx/rates.js';
import { convertMinor, formatRate, RATE_ONE, isCurrencyCode } from '../fx/rateMath.js';
import { isDealStatus } from './enums.js';
import {
  ensureDefaultPipeline,
  firstOpenStage,
  listStages,
  mapPipeline,
  mapStage,
  outcomeStage,
  readPipeline,
  readStage,
} from './pipelines.js';
import type { PipelineRow, StageRow } from './pipelines.js';
import { buildQuoteInput, QUOTE_CREATE_TOOL, quoteIdOf } from './quoteSeam.js';
import { idempotentWrite } from './memo.js';

/** The dispatch hand the api layer passes in, so a delegated verb's own gate is re-checked live. */
export type DealInvoker = (
  tool: string,
  input: Record<string, unknown>,
  asActor: string,
) => Result;

export interface DealRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  status: string;
  probability: number;
  probability_overridden: number;
  value_minor: number;
  currency: string;
  value_base_minor: number;
  fx_rate: string;
  expected_close_on: string | null;
  lost_reason: string | null;
  quote_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `round-once(valueBaseMinor * probability / 100)`, half away from zero, in integer Rappen (P2). */
export function weightedMinor(valueBaseMinor: number, probability: number): number {
  const scaled = valueBaseMinor * probability;
  const quotient = Math.trunc(scaled / 100);
  const remainder = Math.abs(scaled % 100);
  const bump = remainder * 2 >= 100 ? Math.sign(scaled) || 1 : 0;
  return quotient + bump;
}

function mapDeal(row: DealRow) {
  return {
    id: row.id,
    contactId: row.contact_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    title: row.title,
    status: row.status,
    probability: row.probability,
    probabilityOverridden: row.probability_overridden === 1,
    valueMinor: row.value_minor,
    currency: row.currency,
    valueBaseMinor: row.value_base_minor,
    fxRate: row.fx_rate,
    weightedMinor: weightedMinor(row.value_base_minor, row.probability),
    expectedCloseOn: row.expected_close_on,
    lostReason: row.lost_reason,
    quoteId: row.quote_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readDeal(ctx: WorkspaceContext, dealId: string): DealRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM deal WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, dealId) as DealRow | undefined;
}

/** The §H-FX capture: value + currency in, the frozen trio out. Never a client input (spec §5). */
function captureValue(
  ctx: WorkspaceContext,
  valueMinor: number,
  currency: string,
): Result<{ valueBaseMinor: number; fxRate: string }> {
  const resolution = resolveFxRate(ctx, { currency, date: ctx.clock.now().slice(0, 10) });
  if (!resolution.ok) return resolution;
  const { rateScaled, rate } = resolution.resolved;
  if (rateScaled === RATE_ONE) return ok({ valueBaseMinor: valueMinor, fxRate: formatRate(RATE_ONE) });
  return ok({ valueBaseMinor: convertMinor(valueMinor, rateScaled), fxRate: rate });
}

// --- createDeal ---------------------------------------------------------------------------------

export interface CreateDealInput {
  contactId: string;
  title: string;
  valueMinor: number;
  currency?: string;
  pipelineId?: string;
  stageId?: string;
  expectedCloseOn?: string;
  idempotencyKey?: string;
}

export function createDeal(ctx: WorkspaceContext, input: CreateDealInput): Result {
  const contact = readContact(ctx, input.contactId);
  if (contact === undefined) return err('contact_not_found', { contactId: input.contactId });
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return err('invalid_input', { field: 'title' });
  }
  if (!Number.isInteger(input.valueMinor) || input.valueMinor < 0) {
    return err('invalid_input', { field: 'valueMinor' });
  }
  if (input.currency !== undefined && !isCurrencyCode(input.currency)) {
    return err('invalid_input', { field: 'currency' });
  }

  const run = (): Result => {
    // Seeding is a write-side act: the first deal write mints the default funnel (spec §2 Empty).
    const pipeline: PipelineRow | undefined =
      input.pipelineId !== undefined ? readPipeline(ctx, input.pipelineId) : ensureDefaultPipeline(ctx);
    if (pipeline === undefined) return err('not_found', { pipelineId: input.pipelineId });

    let stage: StageRow | undefined;
    if (input.stageId !== undefined) {
      stage = readStage(ctx, input.stageId);
      if (stage === undefined || stage.pipeline_id !== pipeline.id) {
        return err('stage_not_in_pipeline', { stageId: input.stageId, pipelineId: pipeline.id });
      }
      // A deal is born open: entering a terminal stage is markDeal's move, never a birth state.
      if (stage.outcome !== null) return err('terminal_stage_use_mark', { stageId: stage.id });
    } else {
      stage = firstOpenStage(ctx, pipeline.id);
      if (stage === undefined) return err('pipeline_has_no_open_stage', { pipelineId: pipeline.id });
    }

    const workspaceCurrency = input.currency ?? baseCurrency(ctx);
    const captured = captureValue(ctx, input.valueMinor, workspaceCurrency);
    if (!captured.ok) return captured;

    // A merge tombstone is not a place to hang a funnel: land on the survivor (the OP5 rule).
    const owner = resolveMergeChain(ctx, contact);
    const now = ctx.clock.now();
    const id = ctx.ids.next('deal');
    ctx.store.db
      .prepare(
        `INSERT INTO deal (
           id, workspace_id, contact_id, pipeline_id, stage_id, title, status,
           probability, probability_overridden, value_minor, currency, value_base_minor, fx_rate,
           expected_close_on, lost_reason, quote_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        owner.id,
        pipeline.id,
        stage.id,
        input.title.trim(),
        stage.probability,
        input.valueMinor,
        workspaceCurrency,
        captured.valueBaseMinor,
        captured.fxRate,
        input.expectedCloseOn ?? null,
        now,
        now,
      );
    logActivity(ctx, {
      contactId: owner.id,
      dealId: id,
      kind: 'note',
      body: `Deal angelegt: ${input.title.trim()}`,
    });
    return ok({ dealId: id, deal: mapDeal(readDeal(ctx, id) as DealRow) });
  };

  return idempotentWrite(ctx, 'deals_create', input.idempotencyKey, run);
}

function baseCurrency(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string };
  return row.base_currency;
}

// --- updateDeal ---------------------------------------------------------------------------------

export interface DealPatch {
  title?: string;
  contactId?: string;
  valueMinor?: number;
  currency?: string;
  expectedCloseOn?: string | null;
  /** A manual probability pins the deal until the next stage move clears the override. */
  probability?: number;
}

export function updateDeal(
  ctx: WorkspaceContext,
  input: { dealId: string; patch: DealPatch; idempotencyKey?: string },
): Result {
  const deal = readDeal(ctx, input.dealId);
  if (deal === undefined) return err('not_found', { dealId: input.dealId });
  if (deal.status !== 'open') return err('deal_closed', { dealId: deal.id, status: deal.status });
  const patch = input.patch ?? {};

  if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim().length === 0)) {
    return err('invalid_input', { field: 'title' });
  }
  if (patch.valueMinor !== undefined && (!Number.isInteger(patch.valueMinor) || patch.valueMinor < 0)) {
    return err('invalid_input', { field: 'valueMinor' });
  }
  if (patch.currency !== undefined && !isCurrencyCode(patch.currency)) {
    return err('invalid_input', { field: 'currency' });
  }
  if (patch.probability !== undefined) {
    if (!Number.isInteger(patch.probability) || patch.probability < 0 || patch.probability > 100) {
      return err('invalid_input', { field: 'probability' });
    }
  }
  let contactId = deal.contact_id;
  if (patch.contactId !== undefined) {
    const contact = readContact(ctx, patch.contactId);
    if (contact === undefined) return err('contact_not_found', { contactId: patch.contactId });
    contactId = resolveMergeChain(ctx, contact).id;
  }

  const run = (): Result => {
    // The §H-FX freeze: only a patch naming value or currency re-derives the trio (spec §4).
    let valueMinor = deal.value_minor;
    let currency = deal.currency;
    let valueBaseMinor = deal.value_base_minor;
    let fxRate = deal.fx_rate;
    if (patch.valueMinor !== undefined || patch.currency !== undefined) {
      valueMinor = patch.valueMinor ?? deal.value_minor;
      currency = patch.currency ?? deal.currency;
      const captured = captureValue(ctx, valueMinor, currency);
      if (!captured.ok) return captured;
      valueBaseMinor = captured.valueBaseMinor;
      fxRate = captured.fxRate;
    }
    ctx.store.db
      .prepare(
        `UPDATE deal SET
           title = ?, contact_id = ?, value_minor = ?, currency = ?, value_base_minor = ?, fx_rate = ?,
           expected_close_on = ?, probability = ?, probability_overridden = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        patch.title !== undefined ? patch.title.trim() : deal.title,
        contactId,
        valueMinor,
        currency,
        valueBaseMinor,
        fxRate,
        patch.expectedCloseOn === undefined ? deal.expected_close_on : patch.expectedCloseOn,
        patch.probability ?? deal.probability,
        patch.probability !== undefined ? 1 : deal.probability_overridden,
        ctx.clock.now(),
        ctx.workspaceId,
        deal.id,
      );
    return ok({ dealId: deal.id, deal: mapDeal(readDeal(ctx, deal.id) as DealRow) });
  };

  return idempotentWrite(ctx, 'deals_update', input.idempotencyKey, run);
}

// --- moveDeal -----------------------------------------------------------------------------------

export function moveDeal(
  ctx: WorkspaceContext,
  input: { dealId: string; stageId: string; idempotencyKey?: string },
): Result {
  const deal = readDeal(ctx, input.dealId);
  if (deal === undefined) return err('not_found', { dealId: input.dealId });
  if (deal.status !== 'open') return err('deal_closed', { dealId: deal.id, status: deal.status });
  const stage = readStage(ctx, input.stageId);
  if (stage === undefined || stage.pipeline_id !== deal.pipeline_id) {
    return err('stage_not_in_pipeline', { stageId: input.stageId, pipelineId: deal.pipeline_id });
  }
  if (stage.outcome !== null) {
    return err('terminal_stage_use_mark', { stageId: stage.id, outcome: stage.outcome });
  }

  const run = (): Result => {
    if (stage.id === deal.stage_id) {
      return ok({ dealId: deal.id, deal: mapDeal(deal) });
    }
    const from = readStage(ctx, deal.stage_id);
    // A stage move re-defaults the probability unless a hand pinned it (US-C01.2).
    ctx.store.db
      .prepare('UPDATE deal SET stage_id = ?, probability = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(
        stage.id,
        deal.probability_overridden === 1 ? deal.probability : stage.probability,
        ctx.clock.now(),
        ctx.workspaceId,
        deal.id,
      );
    logActivity(ctx, {
      contactId: deal.contact_id,
      dealId: deal.id,
      kind: 'note',
      body: `Phase gewechselt: ${from?.name ?? '?'} zu ${stage.name} (${deal.title})`,
    });
    return ok({ dealId: deal.id, deal: mapDeal(readDeal(ctx, deal.id) as DealRow) });
  };

  return idempotentWrite(ctx, 'deals_move', input.idempotencyKey, run);
}

// --- markDeal -----------------------------------------------------------------------------------

export interface MarkDealInput {
  dealId: string;
  status: string;
  lostReason?: string;
  idempotencyKey?: string;
}

/**
 * The ONE door to `status`. Won and lost move the deal into the pipeline's outcome stage (when the
 * workspace configured one) and pin the probability at 100/0; `open` reopens into the first open
 * stage with its default. The result carries `wonDealId`/`lostDealId` ONLY when this call actually
 * closed the deal, which is what the automation registry's null-collapse keys on: a re-mark of an
 * already-won deal is a state assertion, not a second victory.
 */
export function markDeal(ctx: WorkspaceContext, input: MarkDealInput): Result {
  const deal = readDeal(ctx, input.dealId);
  if (deal === undefined) return err('not_found', { dealId: input.dealId });
  if (!isDealStatus(input.status)) {
    return err('invalid_input', { field: 'status', allowed: ['open', 'won', 'lost'] });
  }
  if (input.status === 'lost' && (typeof input.lostReason !== 'string' || input.lostReason.trim().length === 0)) {
    return err('lost_reason_required', { dealId: deal.id });
  }

  const run = (): Result => {
    if (deal.status === input.status) {
      return ok({ dealId: deal.id, deal: mapDeal(deal), wonDealId: null, lostDealId: null });
    }
    const now = ctx.clock.now();
    let stageId = deal.stage_id;
    let probability = deal.probability;
    let lostReason: string | null = deal.lost_reason;
    if (input.status === 'open') {
      const stage = firstOpenStage(ctx, deal.pipeline_id);
      if (stage === undefined) return err('pipeline_has_no_open_stage', { pipelineId: deal.pipeline_id });
      stageId = stage.id;
      probability = deal.probability_overridden === 1 ? deal.probability : stage.probability;
      lostReason = null;
    } else {
      const stage = outcomeStage(ctx, deal.pipeline_id, input.status);
      if (stage !== undefined) stageId = stage.id;
      probability = input.status === 'won' ? 100 : 0;
      lostReason = input.status === 'lost' ? (input.lostReason as string).trim() : null;
    }
    ctx.store.db
      .prepare(
        `UPDATE deal SET status = ?, stage_id = ?, probability = ?, lost_reason = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(input.status, stageId, probability, lostReason, now, ctx.workspaceId, deal.id);
    const bodies: Record<string, string> = {
      won: `Deal gewonnen: ${deal.title}`,
      lost: `Deal verloren: ${deal.title} (${lostReason ?? ''})`,
      open: `Deal wieder geöffnet: ${deal.title}`,
    };
    logActivity(ctx, {
      contactId: deal.contact_id,
      dealId: deal.id,
      kind: 'note',
      body: bodies[input.status] as string,
    });
    return ok({
      dealId: deal.id,
      deal: mapDeal(readDeal(ctx, deal.id) as DealRow),
      wonDealId: input.status === 'won' ? deal.id : null,
      lostDealId: input.status === 'lost' ? deal.id : null,
    });
  };

  return idempotentWrite(ctx, 'deals_mark', input.idempotencyKey, run);
}

// --- logDealActivity ----------------------------------------------------------------------------

export interface LogDealActivityInput {
  dealId: string;
  kind: string;
  body: string;
  occurredAt?: string;
  reminderAt?: string;
  idempotencyKey?: string;
}

/**
 * OP5 with a follow-up: the note lands on the contact timeline through C00's `logActivity` (the
 * single stream), and a `reminderAt` becomes an E03 task INVOKED THROUGH THE DISPATCH, so E03's own
 * `tasks.write` gate and its reminder validation (`reminder_in_past`) apply to this caller exactly
 * as they would to a direct `tasks_create`. One idempotency key covers note + task together.
 */
export function logDealActivity(
  ctx: WorkspaceContext,
  invoke: DealInvoker | undefined,
  input: LogDealActivityInput,
): Result {
  const deal = readDeal(ctx, input.dealId);
  if (deal === undefined) return err('not_found', { dealId: input.dealId });

  const run = (): Result => {
    const logged = logActivity(ctx, {
      contactId: deal.contact_id,
      dealId: deal.id,
      kind: input.kind,
      body: input.body,
      ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    });
    if (!logged.ok) return logged;

    let taskId: string | null = null;
    if (input.reminderAt !== undefined) {
      if (invoke === undefined) return err('needs_tasks_module', { reminderAt: input.reminderAt });
      const task = invoke(
        'tasks_create',
        {
          workspaceId: ctx.workspaceId,
          title: `Nachfassen: ${deal.title}`,
          assigneeUserId: ctx.actor,
          reminderAt: input.reminderAt,
          // The OP3 task link, stated id-first: this is E03 input, NOT an audit emission, and the
          // Periods audit-vocabulary scraper keys on the `entityKind:` then `entityId:` shape.
          entityId: deal.id,
          entityKind: 'deal',
        },
        ctx.actor,
      );
      if (!task.ok) return task;
      taskId = typeof task['taskId'] === 'string' ? (task['taskId'] as string) : null;
    }
    return ok({ activity: (logged as Record<string, unknown>)['activity'], taskId });
  };

  return idempotentWrite(ctx, 'deals_log_activity', input.idempotencyKey, run);
}

// --- listDeals ----------------------------------------------------------------------------------

export interface ListDealsFilter {
  pipelineId?: string;
  status?: string;
  contactId?: string;
  includeClosed?: boolean;
  savedViewId?: string;
}

/**
 * The board in one read (P5): every pipeline for the picker, the selected pipeline's stages in sort
 * order, its deals, and the weighted total over OPEN deals only (a closed deal's weight is
 * informational, never summed). Writes NOTHING: an unseeded workspace answers empty lists and the
 * first write seeds. Rides the G00 saved-view seam like every other list verb.
 */
export function listDeals(ctx: WorkspaceContext, filter: ListDealsFilter = {}): Result {
  const viewed = applySavedView(ctx, 'deal', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  if (filter.status !== undefined && !isDealStatus(filter.status)) {
    return err('invalid_input', { field: 'status', allowed: ['open', 'won', 'lost'] });
  }

  const pipelines = ctx.store.db
    .prepare('SELECT * FROM pipeline WHERE workspace_id = ? ORDER BY created_at')
    .all(ctx.workspaceId) as PipelineRow[];

  let pipeline: PipelineRow | undefined;
  if (filter.pipelineId !== undefined) {
    pipeline = pipelines.find((p) => p.id === filter.pipelineId);
    if (pipeline === undefined) return err('not_found', { pipelineId: filter.pipelineId });
  } else {
    pipeline = pipelines[0];
  }

  if (pipeline === undefined) {
    return ok({
      pipelines: [],
      pipeline: null,
      stages: [],
      deals: [],
      weightedTotalMinor: 0,
      total: 0,
      baseCurrency: baseCurrency(ctx),
    });
  }

  const clauses = ['workspace_id = ?', 'pipeline_id = ?'];
  const params: string[] = [ctx.workspaceId, pipeline.id];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  } else if (filter.includeClosed !== true) {
    clauses.push(`status = 'open'`);
  }
  if (filter.contactId !== undefined) {
    clauses.push('contact_id = ?');
    params.push(filter.contactId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM deal WHERE ${clauses.join(' AND ')} ORDER BY created_at`)
    .all(...params) as DealRow[];

  const deals = rows.map(mapDeal);
  const weightedTotalMinor = rows
    .filter((row) => row.status === 'open')
    .reduce((sum, row) => sum + weightedMinor(row.value_base_minor, row.probability), 0);

  return ok({
    pipelines: pipelines.map(mapPipeline),
    pipeline: mapPipeline(pipeline),
    stages: listStages(ctx, pipeline.id).map(mapStage),
    deals,
    weightedTotalMinor,
    total: deals.length,
    // The one figure the board's weighted pill is denominated in (§H-FX: the total sums base
    // amounts, so the label must say whose base).
    baseCurrency: baseCurrency(ctx),
  });
}

// --- dealToQuote --------------------------------------------------------------------------------

/**
 * The C02 hand-off (US-C01.5): delegation ONLY, through the shared dispatch, as the caller. See
 * `quoteSeam.ts` for the seam contract and the C02 rebinding point. Idempotent on the deal: a deal
 * already carrying a quote answers that quote and spawns nothing.
 */
export function dealToQuote(
  ctx: WorkspaceContext,
  invoke: DealInvoker | undefined,
  input: { dealId: string; idempotencyKey?: string },
): Result {
  const deal = readDeal(ctx, input.dealId);
  if (deal === undefined) return err('not_found', { dealId: input.dealId });

  const run = (): Result => {
    if (deal.quote_id !== null) {
      return ok({ dealId: deal.id, quoteId: deal.quote_id, created: false });
    }
    if (invoke === undefined) return err('needs_quotes_module', { dealId: deal.id });
    const seeded = invoke(
      QUOTE_CREATE_TOOL,
      buildQuoteInput({
        workspaceId: ctx.workspaceId,
        contactId: deal.contact_id,
        title: deal.title,
        valueMinor: deal.value_minor,
        currency: deal.currency,
        idempotencyKey: `deal-quote-${deal.id}`,
      }),
      ctx.actor,
    );
    if (!seeded.ok) return seeded;
    const quoteId = quoteIdOf(seeded as Record<string, unknown>);
    if (quoteId === undefined) {
      return err('needs_quotes_module', { dealId: deal.id, reason: 'the seam verb answered no document id' });
    }
    ctx.store.db
      .prepare('UPDATE deal SET quote_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(quoteId, ctx.clock.now(), ctx.workspaceId, deal.id);
    logActivity(ctx, {
      contactId: deal.contact_id,
      dealId: deal.id,
      kind: 'note',
      body: `In Offerte umgewandelt: ${deal.title}`,
    });
    return ok({ dealId: deal.id, quoteId, created: true });
  };

  return idempotentWrite(ctx, 'deals_to_quote', input.idempotencyKey, run);
}
