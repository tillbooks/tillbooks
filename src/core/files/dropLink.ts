/**
 * N02 (D183), THE DROP LINK: one click from Claude Desktop (no file on disk) to a Beleg on the right
 * booking.
 *
 * `files_drop_link` (the agent's verb) mints a SINGLE-USE token bound to ONE target (a journal entry, a
 * vendor bill, a bank line, or a pending Vorschlag of one of the four attach acts), with an expiry from
 * `files.drop_link_hours`. The token is stored HASHED (sha256), never in clear, and the verb answers it
 * once. The person opens `/drop/<token>` in the Studio and drops the file; the redemption is NOT a
 * registry verb (spec §4a.7): it runs through the Studio-key-seated drop face of the local router, so no
 * MCP client, and therefore no agent, can redeem its own link. The redemption runs the same intake (sniff,
 * size cap, known-receipt rule) and the same link path as `attach` (`attachBytes`), and a drop onto a
 * pending Vorschlag stores the file PENDING, bound to it: linked when the Vorschlag is approved, swept
 * when it is not.
 *
 * WHY THE TOKEN DERIVES FROM TWO MINTED IDS. Production ids are `<prefix>_<uuid v4>` (122 random bits
 * each, `crypto.randomUUID`), so the hash of two of them carries 244 bits; under the suites' sequence
 * ids the token is deterministic, which keeps the REST/MCP parity proof byte-for-byte. A same-key replay
 * answers the minting call's memo (one link, one token); the redemption scrubs the token from that memo,
 * so after use the clear token is stored nowhere.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { editCapabilityForKind } from '../customization/entities.js';
import { isGovernedSeat } from '../access/capability.js';
import { sniffType, SOURCE_PATH_TYPES } from './sourcePath.js';
import { ATTACH_TARGET_KIND, attachBytes, isAttachAct, type AttachedFile } from './attach.js';
import { MAX_FILE_BYTES } from './files.js';
import { storePendingBytes } from './pending.js';
import { addVorschlagHolders, liveReceiptHolders, settledByBankInput, withReceiptOverride } from './receiptGuard.js';

/** What a drop link can point at. */
export const DROP_TARGET_KINDS = ['journal_entry', 'vendor_bill', 'bank_txn', 'drafted_action'] as const;
export type DropTargetKind = (typeof DROP_TARGET_KINDS)[number];

function isDropTargetKind(v: unknown): v is DropTargetKind {
  return typeof v === 'string' && (DROP_TARGET_KINDS as readonly string[]).includes(v);
}

/** The path the Studio serves the drop page at. */
export const DROP_PATH_PREFIX = '/drop/';

interface DropLinkRow {
  id: string;
  workspace_id: string;
  token_hash: string;
  target_kind: DropTargetKind;
  target_id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  file_id: string | null;
  idempotency_key: string | null;
  memo_scrubbed: number;
}

export function hashDropToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mintToken(ctx: WorkspaceContext): string {
  return createHash('sha256').update(`${ctx.ids.next('dtk')}:${ctx.ids.next('dtk')}`).digest('base64url');
}

const TABLE_OF: Readonly<Record<Exclude<DropTargetKind, 'drafted_action'>, string>> = {
  journal_entry: 'journal_entry',
  vendor_bill: 'vendor_bill',
  bank_txn: 'bank_txn',
};

/** The entity kind a drop onto this target is linked as (a Vorschlag's: the kind its act links to). */
function linkKindOf(ctx: WorkspaceContext, kind: DropTargetKind, id: string): string | Err {
  if (kind !== 'drafted_action') return kind;
  const action = ctx.store.db
    .prepare('SELECT action_tool, status FROM agent_action WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { action_tool: string; status: string } | undefined;
  if (action === undefined) return err('entity_not_found', { entityKind: kind, entityId: id }) as Err;
  if (!isAttachAct(action.action_tool)) {
    return err('invalid_target', { field: 'target', reason: 'not_an_attach_act', actionTool: action.action_tool, acts: Object.keys(ATTACH_TARGET_KIND) }) as Err;
  }
  if (action.status !== 'pending') return err('invalid_state', { field: 'target', reason: 'vorschlag_not_pending', status: action.status }) as Err;
  return ATTACH_TARGET_KIND[action.action_tool];
}

function targetExists(ctx: WorkspaceContext, kind: DropTargetKind, id: string): boolean {
  if (kind === 'drafted_action') return true; // checked by linkKindOf
  return ctx.store.db.prepare(`SELECT 1 AS p FROM ${TABLE_OF[kind]} WHERE workspace_id = ? AND id = ?`).get(ctx.workspaceId, id) !== undefined;
}

export interface DropLinkInput {
  target?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Mint a one-time drop link (`files_drop_link`). Needs `manage_files` and the target's own write right
 * (for a Vorschlag: the right its act's record needs), exactly what attaching would need.
 */
export function mintDropLink(ctx: WorkspaceContext, input: DropLinkInput): Result {
  const target = input.target;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return err('invalid_input', { field: 'target' });
  const kind = (target as { kind?: unknown }).kind;
  const id = (target as { id?: unknown }).id;
  if (!isDropTargetKind(kind)) return err('invalid_input', { field: 'target.kind', allowed: [...DROP_TARGET_KINDS] });
  if (typeof id !== 'string' || id.length === 0) return err('invalid_input', { field: 'target.id' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });

  const linkKind = linkKindOf(ctx, kind, id);
  if (typeof linkKind !== 'string') return linkKind;
  for (const capability of ['manage_files', editCapabilityForKind(linkKind)]) {
    const capable = ctx.capabilities.assert(capability);
    if (!capable.ok) return capable;
  }
  if (!targetExists(ctx, kind, id)) return err('entity_not_found', { entityKind: kind, entityId: id });

  const key = input.idempotencyKey;
  // Idempotent on its key the house way (rule 8: a replay answers the SAME result and writes nothing).
  // The clear token therefore lives in exactly one place, this call's own memo, and only until the link
  // is used: the redemption scrubs it there (`scrubMintMemo`). The link table holds only its hash.
  return ctx.store.rememberIdempotent(ctx.workspaceId, key, MINT_VERB, () => {
    const now = ctx.clock.now();
    const token = mintToken(ctx);
    const hours = getSetting<number>(ctx, 'files.drop_link_hours');
    const expiresAt = new Date(Date.parse(now) + hours * 3_600_000).toISOString();
    const linkId = ctx.ids.next('drop');
    ctx.store.db
      .prepare(
        `INSERT INTO file_drop_link (id, workspace_id, token_hash, target_kind, target_id, created_by, created_at, expires_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(linkId, ctx.workspaceId, hashDropToken(token), kind, id, ctx.actor, now, expiresAt, key);
    return ok({ linkId, token, path: `${DROP_PATH_PREFIX}${token}`, expiresAt, target: { kind, id } });
  });
}

/** The idempotency scope the mint memo is filed under (the verb's own name). */
const MINT_VERB = 'files_drop_link';

/**
 * Once a link is used or expired, its minting memo no longer needs the clear token (critic F7): a replay
 * of the mint then answers the link without a token anything could redeem, so the clear token is stored
 * nowhere at all. Runs inside the redemption, and on the scheduler tick for an expired link.
 */
function scrubMintMemo(ctx: WorkspaceContext, row: DropLinkRow, closedAt: string, why: 'used' | 'expired'): void {
  if (row.idempotency_key !== null) {
    const scrubbed = ok({
      linkId: row.id,
      token: null,
      path: null,
      expiresAt: row.expires_at,
      target: { kind: row.target_kind, id: row.target_id },
      ...(why === 'used' ? { usedAt: closedAt } : { expired: true }),
    });
    ctx.store.db
      .prepare('UPDATE idempotency SET result_json = ? WHERE workspace_id = ? AND verb = ? AND key = ?')
      .run(JSON.stringify(scrubbed), ctx.workspaceId, MINT_VERB, row.idempotency_key);
  }
  ctx.store.db.prepare('UPDATE file_drop_link SET memo_scrubbed = 1 WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, row.id);
}

/**
 * Critic F3/F7, the scheduler's housekeeping of drop links: an expired link's minting memo loses its
 * clear token, and a link that expired more than `files.drop_link_keep_days` ago is removed (the receipt
 * it brought stays where it was linked). Answers what it did. Idempotent.
 */
export function pruneDropLinks(ctx: WorkspaceContext): { scrubbed: number; deleted: number } {
  const now = ctx.clock.now();
  let scrubbed = 0;
  const expired = ctx.store.db
    .prepare('SELECT * FROM file_drop_link WHERE workspace_id = ? AND memo_scrubbed = 0 AND expires_at <= ?')
    .all(ctx.workspaceId, now) as DropLinkRow[];
  for (const row of expired) {
    ctx.store.tx(() => scrubMintMemo(ctx, row, now, row.used_at !== null ? 'used' : 'expired'));
    scrubbed += 1;
  }
  const keepDays = getSetting<number>(ctx, 'files.drop_link_keep_days');
  const cutoff = new Date(Date.parse(now) - keepDays * 86_400_000).toISOString();
  const deleted = ctx.store.tx(
    () => ctx.store.db.prepare('DELETE FROM file_drop_link WHERE workspace_id = ? AND expires_at < ?').run(ctx.workspaceId, cutoff).changes,
  );
  return { scrubbed, deleted };
}

/** Find a link by its clear token, in any workspace (the token IS the address). */
export function dropLinkByToken(store: WorkspaceContext['store'], token: unknown): DropLinkRow | undefined {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return undefined;
  return store.db.prepare('SELECT * FROM file_drop_link WHERE token_hash = ?').get(hashDropToken(token)) as DropLinkRow | undefined;
}

/** What the page shows about the target before anything is dropped. */
export interface DropTargetView {
  kind: DropTargetKind;
  id: string;
  /** The booking number or the bill's reference, when it has one. */
  number: string | null;
  text: string | null;
  date: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** For a Vorschlag: the act it proposes. */
  actionTool: string | null;
  /** The Studio route that opens the target, for "Zur Buchung". */
  route: string;
}

function describeTarget(ctx: WorkspaceContext, kind: DropTargetKind, id: string): DropTargetView {
  const base: DropTargetView = { kind, id, number: null, text: null, date: null, amountMinor: null, currency: null, actionTool: null, route: '/journal' };
  if (kind === 'journal_entry') {
    const e = ctx.store.db
      .prepare(
        `SELECT e.date, e.description, e.ref, n.display AS display,
                (SELECT SUM(l.base_debit_minor) FROM journal_line l WHERE l.entry_id = e.id) AS total
           FROM journal_entry e LEFT JOIN journal_entry_number n ON n.entry_id = e.id
          WHERE e.workspace_id = ? AND e.id = ?`,
      )
      .get(ctx.workspaceId, id) as { date: string; description: string | null; ref: string | null; display: string | null; total: number | null } | undefined;
    if (e === undefined) return base;
    return { ...base, number: e.display ?? e.ref, text: e.description, date: e.date, amountMinor: e.total, currency: null, route: `/journal?entry=${encodeURIComponent(id)}` };
  }
  if (kind === 'vendor_bill') {
    const b = ctx.store.db
      .prepare(
        `SELECT b.bill_date, b.vendor_reference, b.gross_minor, b.currency, c.name AS vendor
           FROM vendor_bill b LEFT JOIN contact c ON c.id = b.contact_id AND c.workspace_id = b.workspace_id
          WHERE b.workspace_id = ? AND b.id = ?`,
      )
      .get(ctx.workspaceId, id) as { bill_date: string; vendor_reference: string | null; gross_minor: number; currency: string; vendor: string | null } | undefined;
    if (b === undefined) return { ...base, route: '/bills' };
    return { ...base, number: b.vendor_reference, text: b.vendor, date: b.bill_date, amountMinor: b.gross_minor, currency: b.currency, route: `/bills?bill=${encodeURIComponent(id)}` };
  }
  if (kind === 'bank_txn') {
    const t = ctx.store.db
      .prepare('SELECT booking_date, amount_minor, currency, payer_name, reference_value FROM bank_txn WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as { booking_date: string; amount_minor: number; currency: string; payer_name: string | null; reference_value: string | null } | undefined;
    if (t === undefined) return { ...base, route: '/bank' };
    return { ...base, text: t.payer_name ?? t.reference_value, date: t.booking_date, amountMinor: t.amount_minor, currency: t.currency, route: `/bank?line=${encodeURIComponent(id)}` };
  }
  const a = ctx.store.db
    .prepare('SELECT action_tool, payload_json FROM agent_action WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { action_tool: string; payload_json: string } | undefined;
  if (a === undefined) return { ...base, route: '/agent' };
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(a.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const text = [payload.description, payload.text, payload.vendorReference].find((v): v is string => typeof v === 'string' && v.length > 0) ?? null;
  const date = [payload.date, payload.billDate].find((v): v is string => typeof v === 'string') ?? null;
  const amountMinor = typeof payload.amountMinor === 'number' ? payload.amountMinor : null;
  return { ...base, text, date, amountMinor, actionTool: a.action_tool, route: '/agent' };
}

/** The state of a link as the page renders it. */
export type DropLinkState = 'ready' | 'used' | 'expired';

export interface ResolvedDropLink {
  state: DropLinkState;
  linkId: string;
  workspaceId: string;
  expiresAt: string;
  usedAt: string | null;
  fileId: string | null;
  target: DropTargetView;
}

function stateOf(row: DropLinkRow, now: string): DropLinkState {
  if (row.used_at !== null) return 'used';
  return row.expires_at <= now ? 'expired' : 'ready';
}

/**
 * What the drop page shows for a token (the face calls it with a context in the link's own workspace,
 * seated as the Studio). Reading it needs `read_master_data`, like the filing.
 */
export function resolveDropLink(ctx: WorkspaceContext, token: unknown): Result {
  const row = dropLinkByToken(ctx.store, token);
  if (row === undefined || row.workspace_id !== ctx.workspaceId) return err('drop_link_unknown', {});
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const resolved: ResolvedDropLink = {
    state: stateOf(row, ctx.clock.now()),
    linkId: row.id,
    workspaceId: row.workspace_id,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    fileId: row.file_id,
    target: describeTarget(ctx, row.target_kind, row.target_id),
  };
  return ok({ link: resolved });
}

export interface RedeemDropInput {
  token?: unknown;
  contentBase64?: unknown;
  filename?: unknown;
  /** R1: the person books a receipt a second time (needs `overrideReason`). */
  bookAgain?: unknown;
  overrideReason?: unknown;
}

const BASE64_RE = /^[A-Za-z0-9+/\r\n\t ]*={0,2}$/;

/**
 * Redeem a link: the person's drop. Human-only (a governed seat is refused `human_only`, whatever the
 * face), single-use (a compare-and-set on `used_at` inside the link's transaction), and the same intake
 * and link path as `attach`.
 */
export function redeemDropLink(ctx: WorkspaceContext, input: RedeemDropInput): Result {
  if (isGovernedSeat(ctx.store, ctx.actor)) return err('human_only', { reason: 'a drop link is redeemed by a person in the Studio' });
  // R1: the person's own confirmation of a second booking of the receipt, for the link this drop makes.
  return withReceiptOverride({ bookAgain: input.bookAgain, overrideReason: input.overrideReason, approvingActionId: null }, () => redeem(ctx, input));
}

function redeem(ctx: WorkspaceContext, input: RedeemDropInput): Result {
  const row = dropLinkByToken(ctx.store, input.token);
  if (row === undefined || row.workspace_id !== ctx.workspaceId) return err('drop_link_unknown', {});
  const state = stateOf(row, ctx.clock.now());
  if (state === 'used') return err('drop_link_used', { usedAt: row.used_at, fileId: row.file_id });
  if (state === 'expired') return err('drop_link_expired', { expiresAt: row.expires_at });

  const linkKind = linkKindOf(ctx, row.target_kind, row.target_id);
  if (typeof linkKind !== 'string') return linkKind;
  for (const capability of ['manage_files', editCapabilityForKind(linkKind)]) {
    const capable = ctx.capabilities.assert(capability);
    if (!capable.ok) return capable;
  }

  const content = input.contentBase64;
  if (typeof content !== 'string' || content.length === 0 || !BASE64_RE.test(content)) {
    return err('file_unreadable', { field: 'contentBase64', reason: 'not_base64' });
  }
  if (content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4096) return err('file_too_large', { max: MAX_FILE_BYTES });
  const bytes = Buffer.from(content, 'base64');
  if (bytes.byteLength === 0) return err('file_unreadable', { field: 'contentBase64', reason: 'empty' });
  if (bytes.byteLength > MAX_FILE_BYTES) return err('file_too_large', { bytes: bytes.byteLength, max: MAX_FILE_BYTES });
  const mime = sniffType(bytes.subarray(0, 32));
  if (mime === null) return err('unsupported_type', { field: 'contentBase64', accepted: [...SOURCE_PATH_TYPES] });
  const filename =
    typeof input.filename === 'string' && input.filename.trim().length > 0 ? input.filename.trim().slice(0, 200) : `beleg.${mime.split('/')[1] ?? 'bin'}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return ctx.store.tx(() => {
    // The single use, decided under the write lock: a second tab that read `ready` loses here.
    const usedAt = ctx.clock.now();
    const claimed = ctx.store.db
      .prepare('UPDATE file_drop_link SET used_at = ?, used_by = ? WHERE workspace_id = ? AND id = ? AND used_at IS NULL')
      .run(usedAt, ctx.actor, ctx.workspaceId, row.id);
    if (claimed.changes !== 1) return err('drop_link_used', {});
    scrubMintMemo(ctx, row, usedAt, 'used');
    let fileId: string;
    let duplicate = false;
    let duplicateOf: string | null = null;
    let holder: { fileId: string; entityKind: string | null; entityId: string | null } | null = null;
    if (row.target_kind === 'drafted_action') {
      // R1: a drop onto a Vorschlag is a RESERVATION, judged when the Vorschlag is approved (only the
      // reservations before it count then). The holders it meets now go on the card at once, so the
      // approver sees them before deciding.
      const stored = storePendingBytes(ctx, bytes, { filename, title: filename, mime }, { actionId: row.target_id, source: 'drop' });
      if ((stored as { ok?: unknown }).ok === false) throw new DropAbort(stored as Err);
      fileId = (stored as { fileId: string }).fileId;
      noteDropHolders(ctx, row.target_id, fileId, sha256);
    } else {
      const attached = attachBytes(ctx, { bytes, mime, filename, sha256 }, linkKind, row.target_id);
      if ((attached as { ok?: unknown }).ok === false) throw new DropAbort(attached as Err);
      const linked = attached as AttachedFile;
      fileId = linked.fileId;
      duplicate = linked.duplicate;
      duplicateOf = linked.duplicateOf;
      if (linked.duplicateOf !== null) {
        const t = ctx.store.db
          .prepare('SELECT id, entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, linked.duplicateOf) as { id: string; entity_kind: string | null; entity_id: string | null } | undefined;
        if (t !== undefined) holder = { fileId: t.id, entityKind: t.entity_kind, entityId: t.entity_id };
      }
    }
    ctx.store.db.prepare('UPDATE file_drop_link SET file_id = ? WHERE workspace_id = ? AND id = ?').run(fileId, ctx.workspaceId, row.id);
    return ok({
      fileId,
      mime,
      filename,
      duplicate,
      duplicateOf,
      holder,
      pending: row.target_kind === 'drafted_action',
      target: describeTarget(ctx, row.target_kind, row.target_id),
    });
  });
}

/**
 * R1: the holders a receipt dropped onto a Vorschlag meets, added to its card: the act's own target (a
 * bank line it books; the record the others create does not exist yet), only reservations before this
 * one, the Vorschlag's own excluded.
 */
function noteDropHolders(ctx: WorkspaceContext, actionId: string, fileId: string, sha256: string): void {
  const action = ctx.store.db.prepare('SELECT action_tool, payload_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, actionId) as
    | { action_tool: string; payload_json: string }
    | undefined;
  if (action === undefined || !isAttachAct(action.action_tool)) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(action.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const mark = ctx.store.db.prepare('SELECT created_at, rowid FROM stored_file_pending WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, fileId) as
    | { created_at: string; rowid: number }
    | undefined;
  const kind = ATTACH_TARGET_KIND[action.action_tool];
  const target = { kind, id: action.action_tool === 'book_bank_line' && typeof payload.bankTxnId === 'string' ? payload.bankTxnId : null };
  const holders = liveReceiptHolders(ctx, sha256, {
    target,
    exceptFileIds: [fileId],
    exceptActionId: actionId,
    ...(mark !== undefined ? { reservationBefore: { createdAt: mark.created_at, rowid: mark.rowid } } : {}),
    ...(action.action_tool === 'book_bank_line' ? { alsoSettled: settledByBankInput(ctx, payload.target) } : {}),
  });
  addVorschlagHolders(ctx, actionId, holders);
}

class DropAbort extends Error {
  constructor(public readonly result: Err) {
    super(result.error);
  }
}

/** `redeemDropLink`, with an abort inside its transaction answered as the refusal it carries. */
export function redeemDropLinkGuarded(ctx: WorkspaceContext, input: RedeemDropInput): Result {
  try {
    return redeemDropLink(ctx, input);
  } catch (e) {
    if (e instanceof DropAbort) return e.result;
    throw e;
  }
}
