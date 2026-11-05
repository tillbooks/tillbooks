/**
 * N00, the workspace brief and the Hausbuch: four verbs (two reads, two writes), defined here and spread
 * into `ACTIONS` as ONE line (the `settingsActions` / `prefsActions` precedent), so several agents
 * appending to the append-only registry at once collide over a line rather than a block.
 *
 * `workspace_brief` is the one read an agent makes first (the server instructions name it beside
 * `whoami`); its sections each assert their source verb's read gate in the engine. The two note writes
 * need `manage_settings` and are governed by the agent dial under `customize`: an agent's note waits for
 * the owner as a Vorschlag at the default level.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { archiveNote, listNotes, setNote, workspaceBrief } from '../core/hausbuch/index.js';
import type { ActionKind } from './actionKind.js';

export interface HausbuchActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

const OBJ = { type: 'object' } as const;

export function hausbuchActions(h: HausbuchActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'workspace_brief',
      'read',
      "Read FIRST, after whoami: how this workspace books, in one call. Returns identity (whoami's actor, role and, for an agent seat, its dial levels), workspace (name, base currency, fiscal year start, VAT method), and the sections: accounts (every active account as rows [number, name, type, vat] under columns), vatCodes (every active code as [code, kind, rateBp, label]), bankAccounts ([id, name, iban, currency, ledger]), rules (each live Buchungsregel and Vorlage: id, scope bank|manual, name, counterparty, direction, match text, its legs in one line such as '6500 VST81 rest; 1170 ?MWST', invalid when it went quiet), notes (the active Hausregeln, the owner's conventions: follow them; a hint when there are none) and counts (Pendenzen's open queues as {queueId: count}, the same numbers attention_summary answers). sections narrows the answer (accounts, vatCodes, bankAccounts, rules, notes, counts); without it the workspace setting hausbuch.brief_sections decides (all by default). Each section asserts its own source verb's read right: a refused one is listed in omitted with permission_denied and the capability, never answered. Reads only.",
      ctxSchema({ sections: { type: 'array', items: STR } }),
      (ctx, input) => workspaceBrief(ctx, input),
    ),
    ctxAction(
      'hausbuch_notes',
      'read',
      "List the workspace's house notes (Hausregeln), newest change first, each with its scope ({kind, ref, label}: kind workspace, account (ref the account id), counterparty (ref the bank key iban:<IBAN> or name:<folded name>, the key Buchungsregeln use) or topic), text, status and who changed it when. status: active (default), archived or all. scope narrows to a kind ({kind}) or one scope ({kind, ref}; an account by number or id, a counterparty by its key, an IBAN or a name). counterparty ({name?, iban?}, a bank line's counterparty) answers the active counterparty notes keyed by its IBAN or its name, the ones the bank line Details show. Reads only.",
      ctxSchema({ scope: OBJ, status: STR, counterparty: OBJ }),
      (ctx, input) => listNotes(ctx, input),
    ),
    ctxAction(
      'hausbuch_note_set',
      'write:reversible:internal',
      "Write a house note (Hausregel), the owner's convention every agent reads in workspace_brief: without id a new note, with id a change (an archived note comes back active). text: 1 to 500 characters (invalid_input naming text otherwise). scope: {kind:'workspace'}, {kind:'account', ref:<number or id>}, {kind:'counterparty', ref:<iban:..., name:..., an IBAN or a name>} (folded into the bank's counterparty key, so the note shows beside that payer's bank lines) or {kind:'topic', ref:<1 to 40 characters>}; an unknown account is scope_not_found. Needs manage_settings. Notes are guidance only: nothing books, posts or files from one. The old and new text and scope go into the note's history and the audit trail; the same text and scope again changes nothing (changed:false). An agent's call waits for the owner as a Vorschlag at the default dial level. The way back is hausbuch_note_set with the previous text, or hausbuch_note_archive.",
      ctxSchema({ id: STR, text: STR, scope: OBJ, idempotencyKey: STR }, ['text', 'scope', 'idempotencyKey']),
      (ctx, input) => setNote(ctx, input),
    ),
    ctxAction(
      'hausbuch_note_archive',
      'write:reversible:internal',
      'Archive a house note: it leaves workspace_brief and the bank line Details and keeps its row and history (archive is a status, never a delete). An archived note is left as it is (changed:false). Needs manage_settings; an unknown id is not_found. An agent\'s call waits for the owner as a Vorschlag at the default dial level. The way back is hausbuch_note_set with the note\'s id, which brings it back active.',
      ctxSchema({ id: STR, idempotencyKey: STR }, ['id', 'idempotencyKey']),
      (ctx, input) => archiveNote(ctx, input),
    ),
  ];
}
