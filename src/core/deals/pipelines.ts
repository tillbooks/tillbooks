/**
 * C01 pipelines & stages: the configurable per-workspace funnel the deal spine hangs on.
 *
 * This IS the OP10 flexible surface for pipeline shape (spec §6b): each workspace defines its own
 * stage set per pipeline, including which stage flags `won`/`lost` and each stage's default
 * `probability`. The one FIXED mechanism threaded through it is the stage→status derivation: an
 * `outcome`-flagged stage closes a deal, and only `markDeal` may perform that move (spec §6b Fixed,
 * "one door"), so the configurable names can never smuggle a fourth terminal state past C02/C03.
 *
 * SEEDING IS A WRITE-SIDE ACT. `ensureDefaultPipeline` runs from `createDeal` (and nothing else):
 * a workspace that has never touched deals gets the default funnel the moment it mints its first
 * deal, and `deals_list`, a read verb, writes nothing ever (spec §2 US-C01.1 Empty, reconciled).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { isStageOutcome } from './enums.js';
import { idempotentWrite } from './memo.js';

export interface PipelineRow {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface StageRow {
  id: string;
  workspace_id: string;
  pipeline_id: string;
  name: string;
  sort: number;
  probability: number;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

export function mapPipeline(row: PipelineRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapStage(row: StageRow) {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    name: row.name,
    sort: row.sort,
    probability: row.probability,
    outcome: row.outcome,
  };
}

export function readPipeline(ctx: WorkspaceContext, pipelineId: string): PipelineRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM pipeline WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, pipelineId) as PipelineRow | undefined;
}

export function readStage(ctx: WorkspaceContext, stageId: string): StageRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM pipeline_stage WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, stageId) as StageRow | undefined;
}

export function listStages(ctx: WorkspaceContext, pipelineId: string): StageRow[] {
  return ctx.store.db
    .prepare(
      'SELECT * FROM pipeline_stage WHERE workspace_id = ? AND pipeline_id = ? ORDER BY sort, created_at',
    )
    .all(ctx.workspaceId, pipelineId) as StageRow[];
}

/** The first non-terminal stage in sort order: where a new or reopened deal lands. */
export function firstOpenStage(ctx: WorkspaceContext, pipelineId: string): StageRow | undefined {
  return listStages(ctx, pipelineId).find((s) => s.outcome === null);
}

/** The pipeline's outcome stage for a terminal status, when the workspace configured one. */
export function outcomeStage(
  ctx: WorkspaceContext,
  pipelineId: string,
  outcome: string,
): StageRow | undefined {
  return listStages(ctx, pipelineId).find((s) => s.outcome === outcome);
}

/**
 * The default funnel, seeded ONCE per workspace by the first deal write when no pipeline exists.
 * Stage names are workspace DATA from that moment on (de-CH, the product's home register, and
 * freely renameable through `pipeline_stages_upsert`); the probabilities are conventional defaults,
 * not statutory figures.
 */
const DEFAULT_STAGES: readonly { name: string; probability: number; outcome: string | null }[] = [
  { name: 'Lead', probability: 10, outcome: null },
  { name: 'Qualifiziert', probability: 35, outcome: null },
  { name: 'Offerte', probability: 60, outcome: null },
  { name: 'Gewonnen', probability: 100, outcome: 'won' },
  { name: 'Verloren', probability: 0, outcome: 'lost' },
];

export function ensureDefaultPipeline(ctx: WorkspaceContext): PipelineRow {
  const existing = ctx.store.db
    .prepare('SELECT * FROM pipeline WHERE workspace_id = ? ORDER BY created_at LIMIT 1')
    .get(ctx.workspaceId) as PipelineRow | undefined;
  if (existing !== undefined) return existing;

  const now = ctx.clock.now();
  const id = ctx.ids.next('pipeline');
  ctx.store.db
    .prepare('INSERT INTO pipeline (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, ctx.workspaceId, 'Pipeline', now, now);
  DEFAULT_STAGES.forEach((stage, index) => {
    ctx.store.db
      .prepare(
        `INSERT INTO pipeline_stage (id, workspace_id, pipeline_id, name, sort, probability, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.ids.next('stage'), ctx.workspaceId, id, stage.name, index, stage.probability, stage.outcome, now, now);
  });
  return readPipeline(ctx, id) as PipelineRow;
}

// --- The §6b write pair -------------------------------------------------------------------------

export interface UpsertPipelineInput {
  pipelineId?: string;
  name?: string;
  idempotencyKey?: string;
}

/** Create a pipeline, or rename an existing one by its id. */
export function upsertPipeline(ctx: WorkspaceContext, input: UpsertPipelineInput): Result {
  const run = (): Result => {
    if (input.pipelineId !== undefined) {
      const row = readPipeline(ctx, input.pipelineId);
      if (row === undefined) return err('not_found', { pipelineId: input.pipelineId });
      if (typeof input.name === 'string' && input.name.trim().length > 0) {
        ctx.store.db
          .prepare('UPDATE pipeline SET name = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
          .run(input.name.trim(), ctx.clock.now(), ctx.workspaceId, row.id);
      }
      return ok({ pipelineId: row.id, pipeline: mapPipeline(readPipeline(ctx, row.id) as PipelineRow), created: false });
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      return err('invalid_input', { field: 'name' });
    }
    const now = ctx.clock.now();
    const id = ctx.ids.next('pipeline');
    ctx.store.db
      .prepare('INSERT INTO pipeline (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ctx.workspaceId, input.name.trim(), now, now);
    return ok({ pipelineId: id, pipeline: mapPipeline(readPipeline(ctx, id) as PipelineRow), created: true });
  };

  return idempotentWrite(ctx, 'pipelines_upsert', input.idempotencyKey, run);
}

export interface UpsertStageInput {
  pipelineId: string;
  stageId?: string;
  name?: string;
  sort?: number;
  probability?: number;
  /** 'won' | 'lost' to flag a terminal stage, null to clear the flag, absent to leave it. */
  outcome?: string | null;
  idempotencyKey?: string;
}

/**
 * Create a stage on a pipeline, or patch one by its id (name, sort, default probability, outcome
 * flag). A stage's `probability` is validated 0-100 HERE, the one place a default enters the system
 * (spec §2 US-C01.1 Boundary: never silently clamped later).
 */
export function upsertPipelineStage(ctx: WorkspaceContext, input: UpsertStageInput): Result {
  const pipeline = readPipeline(ctx, input.pipelineId);
  if (pipeline === undefined) return err('not_found', { pipelineId: input.pipelineId });
  if (input.probability !== undefined) {
    if (!Number.isInteger(input.probability) || input.probability < 0 || input.probability > 100) {
      return err('invalid_input', { field: 'probability' });
    }
  }
  if (input.outcome !== undefined && input.outcome !== null && !isStageOutcome(input.outcome)) {
    return err('invalid_input', { field: 'outcome', allowed: ['won', 'lost', null] });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    if (input.stageId !== undefined) {
      const row = readStage(ctx, input.stageId);
      if (row === undefined || row.pipeline_id !== pipeline.id) {
        return err('not_found', { stageId: input.stageId });
      }
      ctx.store.db
        .prepare(
          `UPDATE pipeline_stage
              SET name = ?, sort = ?, probability = ?, outcome = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : row.name,
          input.sort ?? row.sort,
          input.probability ?? row.probability,
          input.outcome === undefined ? row.outcome : input.outcome,
          now,
          ctx.workspaceId,
          row.id,
        );
      return ok({ stageId: row.id, stage: mapStage(readStage(ctx, row.id) as StageRow), created: false });
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      return err('invalid_input', { field: 'name' });
    }
    const id = ctx.ids.next('stage');
    const maxSort = ctx.store.db
      .prepare('SELECT COALESCE(MAX(sort), -1) AS s FROM pipeline_stage WHERE workspace_id = ? AND pipeline_id = ?')
      .get(ctx.workspaceId, pipeline.id) as { s: number };
    ctx.store.db
      .prepare(
        `INSERT INTO pipeline_stage (id, workspace_id, pipeline_id, name, sort, probability, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        pipeline.id,
        input.name.trim(),
        input.sort ?? maxSort.s + 1,
        input.probability ?? 0,
        input.outcome ?? null,
        now,
        now,
      );
    return ok({ stageId: id, stage: mapStage(readStage(ctx, id) as StageRow), created: true });
  };

  return idempotentWrite(ctx, 'pipeline_stages_upsert', input.idempotencyKey, run);
}
