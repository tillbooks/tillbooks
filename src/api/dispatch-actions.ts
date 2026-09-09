/**
 * G05 §10's three verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `documentTemplateActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * One write (`dispatch_text_upsert`, gated on `manage_dispatch_texts`, NATURALLY idempotent: it
 * asserts the absolute state of one `(documentKind, locale)` slot, so no idempotencyKey) and two
 * reads (`readOnlyHint`). Composed verbs only (D22): a text slot, a resolved preview, a filtered
 * audit read; no flat CRUD twins (`get_dispatch_text` does not exist, the editor reads the saved
 * slots off `list_dispatches`' `texts` list shape).
 *
 * THE SEND LINE IS IN THE DESCRIPTIONS ON PURPOSE: this surface changes NO send semantics. The
 * three send verbs (A11 `send_invoice`, A15 `send_dunning_run`, C02 `quotes_send`) keep their exact
 * signatures, channels, P8 gates and P9 degradations, and merely append one `dispatches` log row
 * per recipient through the shared `recordDispatch` delegate. An agent reading the tool list must
 * never be led to believe a text edit could send anything.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { dispatchTextUpsert, dispatchPreview, listDispatches } from '../core/customization/index.js';

export interface DispatchActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G05 §10 verbs, in append order (the §10.5 table order). */
export function dispatchActions(h: DispatchActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'dispatch_text_upsert',
      'write',
      "Speichere den Textbaustein (subject + body) for one document kind (invoice, quote or dunning_run) and locale: the workspace's own outbound message text, with {{variable}} interpolation validated against the kind's registered variable set AT SAVE TIME (an unknown variable is refused with unknown_variable naming the valid set, never a broken mail later). Naturally idempotent: it asserts the absolute state of one (documentKind, locale) slot, and a value-identical re-save writes nothing at all. Sends NOTHING and changes no send behaviour; a missing slot falls back to the built-in default text at preview.",
      ctxSchema({ documentKind: STR, locale: STR, subject: STR, body: STR }, ['documentKind', 'locale', 'subject', 'body']),
      (ctx, input) => dispatchTextUpsert(ctx, as(input)),
    ),
    ctxAction(
      'dispatch_preview',
      'read',
      "Render the concrete outbound message(s) as a pure read: nothing is sent, nothing is written. documentId (invoice/quote) yields exactly one resolved message; runId (dunning_run) yields one per debtor (narrowable via contactId), each with the recipient, locale, filled variables and attachment list; with neither, the saved or built-in text renders against MUSTER sample values (the editor's preview; locale picks the slot). A recipient without an email carries the owning send verb's own flag (needs_customer_email per A11, needs_email_transport per A15).",
      ctxSchema({ documentKind: STR, documentId: STR, runId: STR, contactId: STR, locale: STR }, ['documentKind']),
      (ctx, input) => dispatchPreview(ctx, as(input)),
    ),
    ctxAction(
      'list_dispatches',
      'read',
      'Das Versand-Protokoll: the cross-document send log, newest first, one row per recipient per send attempt (send_invoice, send_dunning_run, quotes_send), each carrying kind, document/run link, contact, recipient, channel (smtp|cloud_relay|artifact_only), locale, the resolved subject and body that actually left, outcome (sent|degraded|failed|artifact_created) and a degrade reason. Filter by kind, contact, outcome or date range; savedViewId applies a saved view (G00). Also returns texts, the saved Textbausteine slots, so the editor reads its state in the same call. Append-only: no verb can edit or delete a row.',
      ctxSchema({ documentKind: STR, contactId: STR, outcome: STR, from: STR, to: STR, savedViewId: STR }, []),
      (ctx, input) => listDispatches(ctx, as(input)),
    ),
  ];
}
