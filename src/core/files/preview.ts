/**
 * N02 (D183, critic round 2), `files_pending_preview`: the bytes of ONE Beleg a pending Vorschlag will
 * link, for the person who decides it.
 *
 * WHO MAY READ IT. Exactly the seats that may decide a Vorschlag: `manage_agent_dial` (approve/reject),
 * which a governed seat NEVER holds (A24 step 0), so the proposing agent learns nothing beyond what it
 * sent, plus `read_file_content` (a viewer who may list the filing may not download it, D62). The A24 map
 * asks both; the engine asserts them again for an embedder that calls it directly.
 *
 * WHAT IT READS. Only a Beleg of that Vorschlag (`vorschlagBelege`): its own pending files (proposed or
 * dropped) and the filed files its payload names. A filed one goes through `getFileContent` itself, every
 * gate of `files_get_content` included; a pending one is re-hashed against its sha256 the same way. The
 * answer names the type the bytes are (`sniffedMime`), which is all the Studio may act on. A decided
 * Vorschlag has nothing pending to preview (`invalid_state`): its files are filed or gone.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { vorschlagBelege } from './belegeView.js';
import { getFileContent } from './files.js';
import { sniffType } from './sourcePath.js';

export function previewVorschlagBeleg(ctx: WorkspaceContext, input: { actionId?: unknown; fileId?: unknown }): Result {
  for (const capability of ['manage_agent_dial', 'read_file_content']) {
    const capable = ctx.capabilities.assert(capability);
    if (!capable.ok) return capable;
  }
  if (typeof input.actionId !== 'string' || input.actionId.length === 0) return err('invalid_input', { field: 'actionId' });
  if (typeof input.fileId !== 'string' || input.fileId.length === 0) return err('invalid_input', { field: 'fileId' });
  const action = ctx.store.db
    .prepare('SELECT status, payload_json FROM agent_action WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.actionId) as { status: string; payload_json: string } | undefined;
  if (action === undefined) return err('not_found', { actionId: input.actionId });
  if (action.status !== 'pending') return err('invalid_state', { actionId: input.actionId, status: action.status });
  let attach: unknown;
  try {
    attach = (JSON.parse(action.payload_json) as { attach?: unknown }).attach;
  } catch {
    attach = undefined;
  }
  const beleg = vorschlagBelege(ctx, input.actionId, attach).find((b) => b.fileId === input.fileId);
  if (beleg === undefined) return err('not_found', { actionId: input.actionId, fileId: input.fileId });
  // Security review: a FILED Beleg is read through `files_get_content`'s own path, so every gate it
  // applies (the size bound, the payroll sensitivity seam) applies here too.
  if (!beleg.pending) {
    const filed = getFileContent(ctx, { fileId: beleg.fileId });
    if (!filed.ok) return filed;
    const content = typeof filed.contentBase64 === 'string' ? filed.contentBase64 : '';
    return ok({ actionId: input.actionId, beleg, sniffedMime: sniffedOf(Buffer.from(content, 'base64')), contentBase64: content });
  }
  // A pending Beleg is a receipt by construction: its bytes were sniffed and size-capped at intake.
  const blob = ctx.store.db
    .prepare('SELECT content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(ctx.workspaceId, beleg.sha256) as { content: Buffer } | undefined;
  if (blob === undefined) return err('content_not_found', { fileId: beleg.fileId });
  const actual = createHash('sha256').update(blob.content).digest('hex');
  if (actual !== beleg.sha256) return err('integrity_mismatch', { fileId: beleg.fileId, expected: beleg.sha256, actual });
  const bytes = Buffer.from(blob.content);
  return ok({ actionId: input.actionId, beleg, sniffedMime: sniffedOf(bytes), contentBase64: bytes.toString('base64') });
}

/**
 * Security review: the type the BYTES are, never the stored free-text mime. The Studio decides from this
 * alone whether a Beleg may open in a tab (a PDF or an image) or only downloads as octet-stream, so an HTML
 * or SVG file can never render in the Studio's origin.
 */
function sniffedOf(bytes: Buffer): string {
  return sniffType(bytes.subarray(0, 32)) ?? 'application/octet-stream';
}
