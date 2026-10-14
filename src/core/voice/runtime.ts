/**
 * E05, the OP6 local-runtime seam: the adapter registry, the manifest contract, and the model
 * picker's verbs. THE OSS CORE DECLARES THE INTERFACE AND SHIPS NO IMPLEMENTATION (spec §4): the
 * optional companion package (`@tillbooks/draft-local`, published when the ledger is real) calls
 * `registerRuntime` at process startup, and with nothing registered every consuming verb answers
 * `needs_local_runtime`. There is no cloud fallback, and that is a STRUCTURAL fact rather than a
 * setting: no remote implementation exists in this repo to fall back to.
 *
 * E06 CONSUMES THE ADAPTER AND NEVER REACHES A RUNTIME DIRECTLY, mirroring OP1 (B01 builds
 * `resolveRate`; B02/B03/B04 consume it): `registeredRuntime()` is the one door, and the guard
 * suite asserts no module outside this file names an inference library.
 *
 * THE CATALOG IS A FILE, NEVER A FETCH (spec US-E05.5): the manifest arrives WITH the registration
 * (the companion ships it as static JSON and hands it over at startup), `runtimeCatalog` reads
 * what was handed over, and nothing in this module or its callers opens a socket. Refreshing the
 * catalog is `npm update`. The egress probe wraps every suite here, so the claim is measured.
 *
 * THE MANIFEST IS VALIDATED AT REGISTRATION, FAIL-CLOSED: an entry whose licence a business may
 * not use (`licence.commercialUse !== true`), whose `licence.spdx` is not a nameable identifier,
 * whose `sha256` is not pinned, or whose `upstreamUrl` tracks a moving branch REFUSES the whole
 * registration with the offending row named. A model a business may not bill clients with never
 * reaches the picker (spec §4), and finding that out at registration beats finding it out in
 * front of a court.
 */

import os from 'node:os';
import { existsSync } from 'node:fs';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { isRuntimeSource, isDecideQuestionType, RUNTIME_SOURCES } from './enums.js';
import type { DecideQuestionType } from './enums.js';
import type { DecideAnswer, DecideQuestion } from './decide.js';

/**
 * The OP6 adapter: one local inference engine, loaded by the companion package on this machine.
 * `complete` is the seam E06's drafting consumes; `embed` is what E05's own build and retrieval
 * use. Both are synchronous facades over a local model: nothing here may open a socket, and the
 * test-time egress probe holds that over the adapter too (a registered adapter that dials out
 * fails the suite, which is the load-bearing guarantee that the registry stays local).
 */
export interface Op6Adapter {
  id: string;
  modelRef: string;
  device: string;
  complete(prompt: string, opts?: Record<string, unknown>): string;
  embed(text: string): Float32Array;
  /**
   * D144 (E05 §10.1), OPTIONAL: the "System One" operation. Typed questions about `state` (text or
   * serialised JSON) in, calibrated probabilities out, one answer per question. A runtime without it
   * still drafts and embeds. Consumers never call it directly: `decide()` in `./decide.ts` is the one
   * door, and it validates what comes back fail-closed.
   */
  decide?(state: string, questions: readonly DecideQuestion[]): DecideAnswer[];
}

/**
 * D144: how a decision model's probabilities were checked against reality. `measured:false` claims
 * nothing (the `qualityMeasured` rule applied to calibration): `ece` is then null, and a consumer that
 * shows probabilities to a person may refuse the row.
 */
export interface DecideCalibration {
  /** How the probabilities were calibrated or checked, in a few words (e.g. "temperature scaling"). */
  method: string;
  measured: boolean;
  /** Expected calibration error on the evaluation set, in [0, 1]; null when not measured. */
  ece: number | null;
  /** What it was measured on, in words; null when not measured. */
  evaluatedOn: string | null;
}

/** D144: what a row's model can decide (E05 §10.1). */
export interface DecideCapability {
  questionTypes: DecideQuestionType[];
  /** The most options (or levels) one question may carry: 2 to 255. */
  maxChoices: number;
  calibration: DecideCalibration;
}

/** One offered model: the manifest contract of spec §4. The rows are DATA shipped by the companion. */
export interface RuntimeManifestEntry {
  modelRef: string;
  displayName: string;
  minRamGb: number;
  downloadBytes: number;
  sha256: string;
  upstreamUrl: string;
  licence: { spdx: string; commercialUse: boolean };
  /** A plain de-CH sentence a therapist can read, never a leaderboard score. */
  qualityDe: string;
  qualityEn: string;
  /** False until somebody has RUN the model and READ its German (spec §3): an unmeasured row claims nothing. */
  qualityMeasured: boolean;
  contextTokens: number;
  /** D144: the ISO 639-1 codes of the languages the model reads. Required when `decide` is present. */
  languages?: string[];
  /** D144: present when the model answers `decide()` questions. */
  decide?: DecideCapability;
}

interface Registration {
  adapter: Op6Adapter;
  manifest: readonly RuntimeManifestEntry[];
}

/** Exactly one adapter at a time (§H-ENUM discipline applied to a registry, spec US-E05.4). */
let registration: Registration | undefined;
/** Why the last load failed, if it did: `{registered:false, reason}` beats a silent absence. */
let loadFailureReason: string | undefined;

const SHA256_RE = /^[0-9a-f]{64}$/;
/** SPDX short identifiers: letters, digits, dot, dash, plus. A licence we cannot name in one is refused. */
const SPDX_RE = /^[A-Za-z0-9.+-]+$/;
/** A URL that tracks a moving branch is a latent break in every installation at once (spec §4). */
const MOVING_BRANCH_RE = /\/(main|master)(\/|$)/;
/** ISO 639-1: two lowercase letters. A language we cannot name that way is not one a consumer can require. */
const LANGUAGE_RE = /^[a-z]{2}$/;
/** The `choice` ceiling of the System One contract (Jev's own: 255 options). */
export const DECIDE_MAX_CHOICES_CEILING = 255;

/** D144 (E05 §10.1): the two optional manifest fields, under the same fail-closed gate as the rest. */
function assertDecideFieldsValid(entry: RuntimeManifestEntry, fail: (rule: string) => never): void {
  if (entry.languages !== undefined) {
    const langs: unknown = entry.languages;
    if (!Array.isArray(langs) || langs.length === 0) fail('declares languages that are not a non-empty list');
    const list = langs as unknown[];
    if (!list.every((l) => typeof l === 'string' && LANGUAGE_RE.test(l))) {
      fail('declares a language that is not an ISO 639-1 code (two lowercase letters)');
    }
    if (new Set(list).size !== list.length) fail('declares a language twice');
  }
  if (entry.decide === undefined) return;
  const d: unknown = entry.decide;
  if (d === null || typeof d !== 'object') fail('declares a decide block that is not an object');
  const block = d as Record<string, unknown>;
  if (entry.languages === undefined) fail('declares decide but no languages: a decision model must say what it can read');
  const types = block.questionTypes;
  if (!Array.isArray(types) || types.length === 0 || !types.every((t) => isDecideQuestionType(t))) {
    fail('declares decide questionTypes that are not a non-empty list of noul | choice | score');
  }
  const max = block.maxChoices;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 2 || max > DECIDE_MAX_CHOICES_CEILING) {
    fail(`declares a decide maxChoices outside 2..${DECIDE_MAX_CHOICES_CEILING}`);
  }
  const cal = block.calibration;
  if (cal === null || cal === undefined || typeof cal !== 'object') fail('declares decide without a calibration');
  const c = cal as Record<string, unknown>;
  if (typeof c.method !== 'string' || c.method.trim().length === 0) fail('names no calibration method');
  if (typeof c.measured !== 'boolean') fail('does not say whether its calibration was measured');
  if (c.measured === true) {
    const ece = c.ece;
    if (typeof ece !== 'number' || !Number.isFinite(ece) || ece < 0 || ece > 1) {
      fail('claims a measured calibration without an expected calibration error in [0, 1]');
    }
    if (typeof c.evaluatedOn !== 'string' || c.evaluatedOn.trim().length === 0) {
      fail('claims a measured calibration without saying what it was measured on');
    }
  } else if (c.ece !== null && c.ece !== undefined) {
    fail('states an expected calibration error for a calibration it says was not measured');
  }
}

/** Refuse a manifest whose rows fail the contract, naming the first offending row and rule. */
function assertManifestValid(manifest: readonly RuntimeManifestEntry[]): void {
  const seen = new Set<string>();
  for (const entry of manifest) {
    const fail = (rule: string): never => {
      throw new Error(`OP6 manifest refused: model '${entry.modelRef}' ${rule}`);
    };
    if (typeof entry.modelRef !== 'string' || entry.modelRef.length === 0) fail('has no stable modelRef');
    if (seen.has(entry.modelRef)) fail('appears twice: modelRef must be unique');
    seen.add(entry.modelRef);
    if (entry.licence?.commercialUse !== true) {
      fail('does not permit commercial use: a model a business may not bill clients with never reaches the picker');
    }
    if (typeof entry.licence.spdx !== 'string' || !SPDX_RE.test(entry.licence.spdx)) {
      fail('carries no nameable SPDX identifier: a licence we cannot name in one is a licence we cannot hand a solo practitioner');
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) fail('does not pin a sha256');
    if (typeof entry.upstreamUrl !== 'string' || MOVING_BRANCH_RE.test(entry.upstreamUrl)) {
      fail('tracks a moving branch: pin an immutable revision so the pinned sha256 cannot go stale under us');
    }
    if (typeof entry.minRamGb !== 'number' || entry.minRamGb <= 0) fail('states no RAM floor');
    if (typeof entry.qualityDe !== 'string' || entry.qualityDe.length === 0) fail('states no German-quality sentence');
    assertDecideFieldsValid(entry, fail);
  }
}

/**
 * Called by the companion package at process startup, NEVER an MCP tool (spec §5: exposing it
 * would let an agent swap the model out from under a user). Replaces any prior registration and
 * reports what it replaced. The suites register a deterministic stub through the same door.
 */
export function registerRuntime(adapter: Op6Adapter, manifest: readonly RuntimeManifestEntry[]): {
  replaced: string | undefined;
} {
  assertManifestValid(manifest);
  const replaced = registration?.adapter.id;
  registration = { adapter, manifest };
  loadFailureReason = undefined;
  return { replaced };
}

/** An adapter that failed to LOAD reports itself rather than being silently absent (US-E05.4). */
export function reportRuntimeLoadFailure(reason: string): void {
  registration = undefined;
  loadFailureReason = reason;
}

/** The one door to the adapter: E06 consumes this and never names an inference library itself. */
export function registeredRuntime(): Registration | undefined {
  return registration;
}

/** Test seam: back to the shipped state (nothing registered, no failure recorded). */
export function resetRuntimeRegistration(): void {
  registration = undefined;
  loadFailureReason = undefined;
}

/** This machine's installed RAM in whole GB: a local read, no socket (the probe holds it to that). */
export function machineRamGb(): number {
  return Math.round(os.totalmem() / 1024 ** 3);
}

/**
 * PURE (spec §4): given the manifest and the machine's RAM, the row to preselect. Never a model
 * above the floor; among the rows that fit, a MEASURED German-quality row beats an unmeasured one,
 * then the largest floor wins (the biggest model this machine can actually run), then manifest
 * order. Pure means "what does an 8GB Mac get" is a unit test rather than a support ticket.
 */
export function recommendModel(
  manifest: readonly RuntimeManifestEntry[],
  ramGb: number,
): RuntimeManifestEntry | undefined {
  const fitting = manifest.filter((entry) => entry.minRamGb <= ramGb);
  if (fitting.length === 0) return undefined;
  return [...fitting].sort((a, b) => {
    if (a.qualityMeasured !== b.qualityMeasured) return a.qualityMeasured ? -1 : 1;
    if (a.minRamGb !== b.minRamGb) return b.minRamGb - a.minRamGb;
    return manifest.indexOf(a) - manifest.indexOf(b);
  })[0];
}

interface RuntimeSelectionRow {
  workspace_id: string;
  model_ref: string;
  source: string;
  gguf_path: string | null;
  selected_at: string;
  updated_at: string;
}

/** The workspace's persisted selection, or undefined (§H-TENANT: keyed by the tenant itself). */
export function readRuntimeSelection(ctx: WorkspaceContext): RuntimeSelectionRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM runtime_selection WHERE workspace_id = ?')
    .get(ctx.workspaceId) as RuntimeSelectionRow | undefined;
}

function mapSelection(row: RuntimeSelectionRow | undefined) {
  if (row === undefined) return null;
  return {
    modelRef: row.model_ref,
    source: row.source,
    ggufPath: row.gguf_path,
    selectedAt: row.selected_at,
  };
}

/** US-E05.4: whether a local runtime is present, and what it is. Honest in every direction. */
export function runtimeStatus(ctx: WorkspaceContext): Result {
  if (registration === undefined) {
    return ok({
      registered: false,
      ...(loadFailureReason === undefined ? {} : { reason: loadFailureReason }),
      selection: mapSelection(readRuntimeSelection(ctx)),
    });
  }
  return ok({
    registered: true,
    runtimeId: registration.adapter.id,
    modelRef: registration.adapter.modelRef,
    device: registration.adapter.device,
    selection: mapSelection(readRuntimeSelection(ctx)),
  });
}

/**
 * US-E05.5: the catalog the installed companion shipped, a PURE READ of what registration handed
 * over. Rows over the RAM floor come back with `fits:false` and the have/need figures IN PLACE
 * (shown rather than hidden: a user who cannot see the better option cannot understand why theirs
 * is worse); exactly one fitting row is `recommended`.
 */
export function runtimeCatalog(ctx: WorkspaceContext): Result {
  if (registration === undefined) {
    return err('needs_local_runtime', loadFailureReason === undefined ? {} : { reason: loadFailureReason });
  }
  const ramGb = machineRamGb();
  const recommended = recommendModel(registration.manifest, ramGb);
  const models = registration.manifest.map((entry) => ({
    ...entry,
    fits: entry.minRamGb <= ramGb,
    recommended: entry.modelRef === recommended?.modelRef,
  }));
  return ok({
    models,
    recommendedModelRef: recommended?.modelRef ?? null,
    machineRamGb: ramGb,
    selection: mapSelection(readRuntimeSelection(ctx)),
  });
}

export interface SelectRuntimeInput {
  modelRef?: string;
  source: string;
  ggufPath?: string;
  idempotencyKey?: string;
}

/**
 * US-E05.5: persist the workspace's model choice. THE RAM FLOOR AND THE MANIFEST CHECK LIVE HERE,
 * IN THE VERB AND NOT THE GUI, so an agent cannot select a model the machine cannot run. A
 * `modelRef` absent from the shipped manifest refuses with `unknown_model_ref` and RETAINS the old
 * selection (a package downgrade must not destroy it; the upgrade restores it). BYO takes a local
 * `.gguf` path, unsupported and quality-unclaimed (spec §6b: the one flexible surface, local only).
 */
export function selectRuntimeModel(ctx: WorkspaceContext, input: SelectRuntimeInput): Result {
  if (registration === undefined) {
    return err('needs_local_runtime', loadFailureReason === undefined ? {} : { reason: loadFailureReason });
  }
  if (!isRuntimeSource(input.source)) {
    return err('invalid_input', { field: 'source', allowed: [...RUNTIME_SOURCES] });
  }

  let modelRef: string;
  let ggufPath: string | null = null;
  if (input.source === 'catalog') {
    if (typeof input.modelRef !== 'string' || input.modelRef.length === 0) {
      return err('invalid_input', { field: 'modelRef' });
    }
    const entry = registration.manifest.find((row) => row.modelRef === input.modelRef);
    if (entry === undefined) return err('unknown_model_ref', { modelRef: input.modelRef });
    const haveGb = machineRamGb();
    if (entry.minRamGb > haveGb) {
      return err('insufficient_ram', { modelRef: entry.modelRef, needGb: entry.minRamGb, haveGb });
    }
    modelRef = entry.modelRef;
  } else {
    if (typeof input.ggufPath !== 'string' || !input.ggufPath.endsWith('.gguf')) {
      return err('invalid_input', { field: 'ggufPath' });
    }
    if (!existsSync(input.ggufPath)) return err('not_found', { ggufPath: input.ggufPath });
    modelRef = input.ggufPath;
    ggufPath = input.ggufPath;
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const existing = readRuntimeSelection(ctx);
    if (existing === undefined) {
      ctx.store.db
        .prepare(
          `INSERT INTO runtime_selection (workspace_id, model_ref, source, gguf_path, selected_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.workspaceId, modelRef, input.source, ggufPath, now, now);
    } else {
      ctx.store.db
        .prepare(
          `UPDATE runtime_selection SET model_ref = ?, source = ?, gguf_path = ?, updated_at = ?
            WHERE workspace_id = ?`,
        )
        .run(modelRef, input.source, ggufPath, now, ctx.workspaceId);
    }
    return ok({ selection: mapSelection(readRuntimeSelection(ctx)) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'runtime_select', run);
  }
  return ctx.store.tx(run);
}
