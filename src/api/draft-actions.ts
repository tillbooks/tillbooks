/**
 * E06's three verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `mailActions` / `voiceActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * Two writes (generate, regenerate) and one read. THERE IS NO `draft_send` TOOL AND THERE WILL
 * NOT BE ONE (spec §5): the draft lands in the mail client's LOCAL Drafts folder via E04, where
 * the human reviews and sends it in the app they already use (P8 by construction: TILL has no
 * SMTP and no send verb anywhere). The consent toggle is deliberately NOT an E06 tool either: it
 * rides C00's `contacts_update`, because `contact` is C00's table and one table takes one write
 * path. `purgeDraftRunsForContact` is internal to C00 `contacts_anonymise`, the E04/E05 rule.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { generateDraft, regenerateDraft, listDraftRuns } from '../core/drafting/index.js';

export interface DraftActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The E06 verbs, in append order. */
export function draftActions(h: DraftActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'draft_generate',
      'write',
      'Erstelle einen Antwortentwurf für einen Mail-Thread, lokal und in den Entwurfsordner des eigenen Mail-Programms (nie versendet: TILL hat kein Sende-Verb und kein SMTP). Der Entwurf spricht mit dem gelernten Schreibstil (E05) und wird NUR für einen Kontakt mit eingeschalteter Einwilligung (contact.ledger_grounding_enabled, via contacts_update) mit den Buchhaltungs-Fakten aus A16/A11/B00 fundiert; groundInLedger:false schaltet die Fundierung zusätzlich AUS, einschalten kann kein Parameter (die Einwilligungs-Asymmetrie). Ein unbekannter Absender fundiert nie; ohne read_sales fundiert nichts. Antwortet nothing_to_reply_to wenn die neuste Nachricht schon von Ihnen ist, needs_voice_profile ohne Schreibstil, needs_local_runtime ohne lokale Engine (kein Cloud-Fallback existiert), source_changed wenn die Nachricht sich geändert hat. Ein Schlüssel schreibt genau EINEN Entwurf.',
      ctxSchema(
        { threadId: STR, profileId: STR, groundInLedger: BOOL, idempotencyKey: STR },
        ['threadId', 'idempotencyKey'],
      ),
      (ctx, input) => generateDraft(ctx, as(input)),
    ),
    ctxAction(
      'draft_regenerate',
      'write',
      'Erstelle einen Entwurf neu, mit optionalem Hinweis ("kürzer", "förmlicher"): schreibt eine NEUE draft_run-Zeile (die Versuchsfolge bleibt nachvollziehbar) und ERSETZT die Nachricht im Entwurfsordner statt eine zweite daneben zu legen. Ein Entwurf, den der Mensch schon gesendet oder gelöscht hat, antwortet draft_gone und wird nicht neu erzeugt: gesendet heisst seiner. Einwilligung und RBAC werden neu gelesen, nie vom früheren Lauf geerbt.',
      ctxSchema({ draftRunId: STR, hint: STR, idempotencyKey: STR }, ['draftRunId', 'idempotencyKey']),
      (ctx, input) => regenerateDraft(ctx, as(input)),
    ),
    ctxAction(
      'draft_list',
      'read',
      'Die Entwurfs-Läufe (P5), neuste zuerst, je Thread oder über den Arbeitsbereich: welches Modell welchen Entwurf schrieb (runtime, model_ref, prompt_sha256, nie der Prompt selbst), ob die Buchhaltung einbezogen war (grounded), der Status (ok, needs_local_runtime, needs_mailstore, failed), und der Entwurfstext ON DEMAND aus dem Entwurfsordner gelesen, nie aus SQLite. draftGone sagt, dass der Mensch ihn gesendet oder gelöscht hat; modelChanged, dass ein anderes Modell registriert ist als das, das ihn schrieb.',
      ctxSchema({ threadId: STR }),
      (ctx, input) => listDraftRuns(ctx, as(input)),
    ),
  ];
}
