/**
 * E05's seven verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `mailActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Two writes (build a profile, choose a model) and five reads. `runtime.register` IS NOT A TOOL
 * AND WILL NOT BECOME ONE (spec §5): registration is a process-startup concern of the installed
 * companion package, and exposing it would let an agent swap the model out from under a user (P8's
 * spirit: agent-initiated changes to how drafts are produced are exactly what the human must stay
 * in front of). `purgeVoiceForContact` is deliberately NOT a tool either: erasure belongs to C00
 * `contacts_anonymise`, the same single-entry-point rule E04 holds for its own purge.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  buildVoiceProfile,
  getVoiceProfile,
  listVoiceProfiles,
  retrieveVoiceExemplars,
  runtimeStatus,
  runtimeCatalog,
  selectRuntimeModel,
} from '../core/voice/index.js';

export interface VoiceActionHelpers {
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

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The E05 verbs, in append order. */
export function voiceActions(h: VoiceActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;
  const STR_ARRAY = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'voice_build',
      'write',
      'Lerne den Schreibstil aus gesendeten Nachrichten: reads the outbound corpus of one E04 mail account (plus optional E00 documents by id), distils a readable style card, and embeds every exemplar through the LOCAL OP6 runtime, storing locators, vectors and hashes and NEVER an excerpt (Art. 321 index-never-copy). Fewer than 20 sent messages answers corpus_too_small with the honest have/need counts; no installed runtime answers needs_local_runtime, never a cloud fallback; no chosen model answers needs_model_selection. Re-running with a new key rebuilds and supersedes by row, the previous profile retained.',
      ctxSchema({ accountId: STR, documentIds: STR_ARRAY, name: STR, idempotencyKey: STR }, ['accountId']),
      (ctx, input) => buildVoiceProfile(ctx, as(input)),
    ),
    ctxAction(
      'voice_profile_get',
      'read',
      'Ein Schreibstil-Profil (P5): the readable style card (greeting, sign-off, formality, sentence length, language mix), exemplar count, when it was built, on which model, and stale:true when the sent-mail corpus changed since the build.',
      ctxSchema({ profileId: STR }, ['profileId']),
      (ctx, input) => getVoiceProfile(ctx, as(input)),
    ),
    ctxAction(
      'voice_profiles_list',
      'read',
      'Alle Schreibstil-Profile (P5), newest first: supersession is by row, so history stays interpretable (a draft references the profile that produced it).',
      ctxSchema(),
      (ctx) => listVoiceProfiles(ctx),
    ),
    ctxAction(
      'voice_retrieve',
      'read',
      'Die ähnlichsten Beispiele zu einem Text (P5, computed at query time): embeds queryText through the local runtime, cosine-ranks the profile exemplars, and returns the top k with bodies read ON DEMAND from their source (E04 mail store, E00 document blob), never from SQLite. A source deleted in its own application is skipped and counted, never fatal; a moved corpus answers stale:true. This is the E06 drafting agent, and every other consumer, reaching the corpus through its only door.',
      ctxSchema({ profileId: STR, queryText: STR, k: INT }, ['profileId', 'queryText']),
      (ctx, input) => retrieveVoiceExemplars(ctx, as(input)),
    ),
    ctxAction(
      'runtime_status',
      'read',
      'Der Status der lokalen Entwurfs-Engine (P5): whether an OP6 adapter is registered, which runtime, model and device, why a load failed if it did, and the persisted model selection of the workspace. With nothing installed the answer is registered:false, and no cloud path exists to fall back to.',
      ctxSchema(),
      (ctx) => runtimeStatus(ctx),
    ),
    ctxAction(
      'runtime_catalog',
      'read',
      'Die angebotenen Modelle (P5): the static manifest the installed companion package shipped, a pure read of a local file and never a fetch (new models arrive via npm update). Per row the plain-language German-quality sentence, RAM floor, download size and licence; rows over the RAM of this machine come back fits:false with the have/need figures, and exactly one fitting row is recommended and preselected.',
      ctxSchema(),
      (ctx) => runtimeCatalog(ctx),
    ),
    ctxAction(
      'runtime_select',
      'write',
      'Wähle das Modell der lokalen Entwurfs-Engine: persists the choice of the workspace from the shipped catalog (source=catalog, validated against the manifest AND the RAM floor of the machine IN THE VERB, so an agent cannot select a model the machine cannot run: unknown_model_ref retains the old selection, insufficient_ram names the have/need GB) or a local .gguf path behind Erweitert (source=byo, unsupported, no quality claim). Reversible and visible in runtime_status.',
      ctxSchema({ modelRef: STR, source: STR, ggufPath: STR, idempotencyKey: STR }, ['source']),
      (ctx, input) => selectRuntimeModel(ctx, as(input)),
    ),
  ];
}
