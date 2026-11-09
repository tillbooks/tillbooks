/**
 * A41.3 re-cut v2 (D184), the person's three receipt verbs: `assign_beleg` (Studio "Anhängen" on an open bank
 * line), `release_beleg` ("Lösen") and `confirm_capture_figures` ("Zahlen bestätigen", bulk). Three writes,
 * spread into `ACTIONS` as ONE line (the `autopilotActions` precedent). The helpers arrive as a parameter to
 * keep the module graph acyclic.
 *
 * All three are a PERSON's acts: a governed seat (the agent, a served agent member, a plugin call) is refused
 * `human_only` under every dial, before a Vorschlag is drafted (`prevalidate`) and in the engine at execution
 * alike, and all three are on the G01 denylist (no rule fires them). They decide what an unattended booking may
 * rest on (D184 point 2, I-B, I-F), so no machine may make, move or vouch for that evidence.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { assignBeleg, assignBelegFile, assignHumanOnly, confirmCaptureFigures, releaseBeleg } from '../core/banking/belegAssignment.js';
import type { ActionKind } from './actionKind.js';

export interface BelegActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
}

export function belegActions(h: BelegActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR } = h;
  const as = <T>(input: ActionInput): T => input as unknown as T;
  const IDS = { type: 'array', items: STR } as const;

  return [
    withPrevalidate(
      ctxAction(
        'assign_beleg',
        'write:reversible:human-only',
        'A PERSON says which captured receipt is the Beleg of an OPEN bank line (Studio "Anhängen"): fileIds are the documents of captures under review (an invoice and its receipt may go together, one to ten), each with an amount. Each document is filed on the line while its capture stays under review; booking the line (by hand or by the automatic booking) closes the capture. With rules.autobook_requires_beleg on, a switched-on rule books a line that needs a receipt only with its assigned receipt, and this is how a person settles a line TILL could not pair on its own. A person always wins: an earlier assignment of the same line or of the same receipt (TILL\'s own or a person\'s) is replaced. Refused: human_only for an agent seat under every dial (an agent can neither do it nor propose it), permission_denied without the right to read receipts (read_master_data) and bank lines (read_sales), not_found (a line or file of another workspace), line_not_open (a booked line takes its receipt with files_link), beleg_not_captured, beleg_without_amount, not_head_version, file_filed_elsewhere (the document belongs to another record), receipt_already_booked (the bytes evidence a live booking). Assigning the standing assignment again answers alreadyAssigned. The way back is release_beleg.',
        ctxSchema({ bankTxnId: STR, fileIds: IDS, idempotencyKey: STR }, ['bankTxnId', 'fileIds', 'idempotencyKey']),
        (ctx, input) => assignBeleg(ctx, as(input)),
      ),
      (ctx) => assignHumanOnly(ctx),
    ),
    withPrevalidate(
      ctxAction(
        'assign_beleg_file',
        'write:reversible:human-only',
        'A PERSON says one FILED file is the receipt of an OPEN bank line, and TILL captures and assigns it in one act (Studio: a file dropped on the row, after files_upload; or "Zuordnen" on the new version of a receipt that stayed filed on the line). fileId is unlinked or already filed on this line. Under belege.drop_on_open_line = assign (the default) the file is filed on the line, captured, and assigned as the person\'s receipt; a file that states no amount of its own (no Swiss QR code) takes the line\'s amount and currency as the person\'s statement (amountFrom line), but ONLY the person\'s own fresh upload (a person seat uploaded it and it was never filed); any other file (an agent\'s, an approved draft\'s, one filed before, a new version) is assigned only on an amount of its own. The capture records where the bytes came from, never who assigned them, so an agent\'s QR bill stays untrusted until a person confirms its figures. assign_if_stated assigns only a file that states its amount, else it files and captures it and the line waits (notAssigned beleg_without_amount). file only files it (the drag-and-drop path before this verb). A receipt another line holds follows belege.assigned_move, and TILL\'s own pairing always gives way; bytes a live booking holds follow files.duplicate_beleg (under confirm: bookAgain with overrideReason). Refused: human_only for an agent seat under every dial, permission_denied without read_master_data and read_sales or the line\'s edit right or manage_files, not_found, line_not_open, line_assigned (release the line\'s receipt first), not_head_version, file_filed_elsewhere, unsupported_mime, beleg_already_captured (the same bytes wait as another capture: assign that one), receipt_assigned, receipt_already_booked, reason_required. The standing assignment of exactly this file answers alreadyAssigned. The way back is release_beleg.',
        ctxSchema({ bankTxnId: STR, fileId: STR, idempotencyKey: STR, bookAgain: { type: 'boolean' }, overrideReason: STR }, ['bankTxnId', 'fileId', 'idempotencyKey']),
        (ctx, input) => assignBelegFile(ctx, as(input)),
      ),
      (ctx) => assignHumanOnly(ctx),
    ),
    withPrevalidate(
      ctxAction(
        'release_beleg',
        'write:reversible:human-only',
        'A PERSON takes the assigned receipt off an open bank line ("Lösen"): the line\'s active assignment ends, and TILL never pairs that receipt with that line on its own again until a person assigns it anew; a document the assignment filed on the line goes back to the receipts without a booking. Posts nothing. Refused: human_only for an agent seat under every dial, permission_denied without read_master_data and read_sales, not_found. A line with no assignment answers alreadyReleased. The way back is assign_beleg.',
        ctxSchema({ bankTxnId: STR, idempotencyKey: STR }, ['bankTxnId', 'idempotencyKey']),
        (ctx, input) => releaseBeleg(ctx, as(input)),
      ),
      (ctx) => assignHumanOnly(ctx),
    ),
    withPrevalidate(
      ctxAction(
        'confirm_capture_figures',
        'write:reversible:human-only',
        'A PERSON confirms one or more captures under review exactly as they SAW them ("Zahlen bestätigen", one to a hundred): captures [{ captureId, expected: { sha256, fields } }], where expected is the capture\'s sha256 and engineFields as list_captures or get_capture answered them (every field TILL pairs a receipt with a bank line on: amount, currency, vat_amount, vendor_name, iban, vendor_uid, invoice_date, due_date; an absent one absent). If any capture\'s bytes or fields differ from what the person saw, the whole call is refused figures_changed naming the captureIds, and nothing is confirmed. Under belege.autobook_figure_trust = confirmed (the default) only confirmed fields, or fields read from the Swiss QR code of a receipt a person brought in, let TILL pair a receipt with a bank line on its own for the automatic booking (figuresTrusted on the capture). A later change of any of those fields needs a new confirmation. All or nothing; a capture already confirmed as it stands answers alreadyConfirmed. Refused: human_only for an agent seat under every dial, permission_denied without read_master_data, invalid_input (an entry without expected), not_found, invalid_state (not under review), figures_changed, beleg_without_amount.',
        ctxSchema(
          {
            captures: {
              type: 'array',
              items: {
                type: 'object',
                properties: { captureId: STR, expected: { type: 'object', properties: { sha256: STR, fields: { type: 'object' } }, required: ['sha256', 'fields'] } },
                required: ['captureId', 'expected'],
              },
            },
            idempotencyKey: STR,
          },
          ['captures', 'idempotencyKey'],
        ),
        (ctx, input) => confirmCaptureFigures(ctx, as(input)),
      ),
      (ctx) => assignHumanOnly(ctx),
    ),
  ];
}
