/**
 * A41.3 re-cut v2 (D184, I-F, owner decision 07.11.2026): WHICH RECEIPT FIGURES MAY BACK AN UNATTENDED BOOKING.
 *
 * `belege.autobook_figure_trust` (human-only) = `confirmed` (the default) | `agent`.
 *  - `confirmed`: only figures a PERSON confirmed (the one-click "Zahlen bestätigen", `confirm_capture_figures`,
 *    whose NEWEST confirmation equals the live figures and the capture's bytes) or figures the engine itself
 *    read from the receipt's Swiss QR code (every live figure field of provenance `qr` or `swico`: read from
 *    the stored bytes; a SUPPLIED payload lands with the supplier's provenance, never these) ON A DOCUMENT A
 *    PERSON BROUGHT IN (`captures.intake_seat = 'person'`, or `folder` while `belege.qr_trust_folder` is on;
 *    an agent-uploaded QR bill, or one a person approved from an agent's draft, is the agent's word: `machine`)
 *    back an `engine_unique` assignment.
 *  - `agent`: any stated amount backs one; the owner accepts that risk explicitly.
 * Agent-read figures still drive the evidence and the bulk approval, never an unattended posting.
 *
 * `capture_extract source: 'operator'` is NOT a person's confirmation: any seat may call it with that source,
 * so the provenance alone proves nothing about who typed. Only the human-only verb confirms.
 *
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import { ENGINE_CAPTURE_KEYS } from './belegFigures.js';
import type { ReceiptFigures } from './belegFigures.js';
import { currentEngineSnapshotOf, currentFiguresOf } from './belegAssignmentStore.js';

export const FIGURE_TRUST_SETTING = 'belege.autobook_figure_trust';
export const FIGURE_TRUST_MODES = ['confirmed', 'agent'] as const;
/** Whether a QR code on a Belegeingang folder receipt counts as a person-brought one (default `on`). */
export const QR_TRUST_FOLDER_SETTING = 'belege.qr_trust_folder';
export type FigureTrustMode = (typeof FIGURE_TRUST_MODES)[number];

/** Why a capture's live figures are trusted without the setting's `agent` mode, else null. */
export type FiguresTrust = 'confirmed' | 'qr';

/** The trust mode in force. */
export function figureTrustMode(ctx: WorkspaceContext): FigureTrustMode {
  return getSetting<string>(ctx, FIGURE_TRUST_SETTING) === 'agent' ? 'agent' : 'confirmed';
}

/** The newest person confirmation of a capture's figures, or undefined. */
export function newestConfirmation(
  ctx: WorkspaceContext,
  captureId: string,
): { sha256: string; figures: ReceiptFigures; matchJson: string | null; confirmedBy: string; confirmedAt: string } | undefined {
  const r = ctx.store.db
    .prepare(
      `SELECT sha256, amount_minor, currency, vat_minor, match_json, confirmed_by, confirmed_at FROM capture_figure_confirmation
        WHERE workspace_id = ? AND capture_id = ? ORDER BY confirmed_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, captureId) as
    | { sha256: string; amount_minor: number; currency: string; vat_minor: number | null; match_json: string | null; confirmed_by: string; confirmed_at: string }
    | undefined;
  if (r === undefined) return undefined;
  return { sha256: r.sha256, figures: { amountMinor: r.amount_minor, currency: r.currency, vatMinor: r.vat_minor }, matchJson: r.match_json, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at };
}

/**
 * Are the capture's LIVE figures trusted, and why: `confirmed` (a person's newest confirmation names exactly
 * these figures over these bytes) or `qr` (every live figure field was read from the stored bytes' Swiss QR
 * code). Null otherwise, and for a capture with no amount.
 */
export function figuresTrust(ctx: WorkspaceContext, captureId: string): FiguresTrust | null {
  const capture = ctx.store.db
    .prepare(
      `SELECT c.sha256, c.intake_seat, f.sha256 AS file_sha,
              EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = c.workspace_id AND s.supersedes_id = c.document_id) AS superseded
         FROM captures c LEFT JOIN stored_file f ON f.workspace_id = c.workspace_id AND f.id = c.document_id
        WHERE c.workspace_id = ? AND c.id = ?`,
    )
    .get(ctx.workspaceId, captureId) as { sha256: string; intake_seat: string | null; file_sha: string | null; superseded: number } | undefined;
  if (capture === undefined) return null;
  const now = currentFiguresOf(ctx, captureId);
  if (now === null) return null;
  const confirmed = newestConfirmation(ctx, captureId);
  if (
    confirmed !== undefined &&
    confirmed.sha256 === capture.sha256 &&
    confirmed.figures.amountMinor === now.amountMinor &&
    confirmed.figures.currency === now.currency &&
    confirmed.figures.vatMinor === now.vatMinor &&
    // Critic A41.3 r1 S1/S2: the confirmation covers EVERY engine field (figures and match keys), so a later
    // rewrite of the vendor, IBAN, UID or a date voids it exactly like a rewritten amount.
    confirmed.matchJson === currentEngineSnapshotOf(ctx, captureId)
  ) {
    return 'confirmed';
  }
  // THE QR RULE (orchestrator security review, 07.11.2026): a QR code is only as trustworthy as the person who
  // brought the document in. An agent can upload a PDF carrying a QR bill of its own making, and the engine would
  // read "qr" figures off it. So QR/swico provenance counts ONLY on a capture a PERSON brought in (`intake_seat =
  // 'person'`: a person's capture, or the person-configured Belegeingang folder, which scans as the Studio seat),
  // over its own unchanged bytes (the document the head of its chain, same sha256). Unknown (a capture from
  // before this build) fails closed. Anything else needs the human-only `confirm_capture_figures`.
  // A folder receipt (the Belegeingang scan) counts only while `belege.qr_trust_folder` is on (default): an
  // agent with write access to that folder could plant a QR invoice there.
  const broughtByPerson = capture.intake_seat === 'person' || (capture.intake_seat === 'folder' && getSetting<string>(ctx, QR_TRUST_FOLDER_SETTING) === 'on');
  if (!broughtByPerson || capture.file_sha !== capture.sha256 || capture.superseded !== 0) return null;
  // Every LIVE engine field must be the QR read's own (critic A41.3 r1 S1/S2): a sender, IBAN or date an agent
  // or anyone typed beside the QR figures is not the code's. A QR bill states no invoice date, so a QR-trusted
  // receipt is dated by its capture's own intake day (engine-set), never by an editable field.
  const marks = ENGINE_CAPTURE_KEYS.map(() => '?').join(', ');
  const live = ctx.store.db
    .prepare(`SELECT key, provenance FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0 AND key IN (${marks})`)
    .all(ctx.workspaceId, captureId, ...ENGINE_CAPTURE_KEYS) as { key: string; provenance: string }[];
  if (live.some((f) => f.key === 'amount') && live.every((f) => f.provenance === 'qr' || f.provenance === 'swico')) return 'qr';
  return null;
}

/** May these live figures back an `engine_unique` assignment under the trust mode in force? */
export function figuresBackEngine(ctx: WorkspaceContext, captureId: string, mode: FigureTrustMode = figureTrustMode(ctx)): boolean {
  if (mode === 'agent') return currentFiguresOf(ctx, captureId) !== null;
  return figuresTrust(ctx, captureId) !== null;
}
