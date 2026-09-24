/**
 * A37, managed bank connectivity (spec `docs/specs/specs/A37-managed-bank-connectivity.md`): the
 * LOCAL seam behind A33's five verbs for the bLink managed rail. It dispatches by channel kind, holds
 * the managed connection/order tables, and degrades honestly when the cloud tier is off. It is an OP4
 * cloud tier end to end (owner decision D108/D109).
 *
 * THE TRUST BOUNDARY, enforced in code (spec §3, tripwires 1/2): NOTHING here reads or writes a
 * password, token, or certificate. The bLink platform identity and the per-customer Provider Tokens
 * live relay-side; the local engine only ever hands the relay an opaque `consentRef` and receives
 * opaque handles back. The `ManagedChannelPort` interface exports no key operation, so the boundary is
 * mechanical, not documentary.
 *
 * A37 POSTS NOTHING (P3 by delegation, spec §4). Nothing here calls `postEntry`/`recordPayment`, and
 * statements enter the books ONLY through A20's `importCamt`, handed the fetched bytes byte-for-byte.
 * No camt is ever synthesised: a JSON-only bank yields `format_unsupported`, never a fabricated file.
 *
 * OFFLINE BY CONSTRUCTION. The core NEVER opens a socket: every relay step goes through the
 * `ManagedChannelPort` seam (context.ts), which a test wires as an in-process mock relay and a host
 * wires as the real HTTPS poll client. With NO port wired every managed action returns the honest OP4
 * shape (`{ ok:false, error:'cloud_tier' }`) with ZERO side effects (tripwire 5): no row, no socket,
 * no simulated consent.
 *
 * THE tx-COMMIT-ON-ERR TRAP (house rule): returning `{ok:false}` INSIDE `ctx.store.tx` COMMITS the
 * partial writes. Every refusal is pre-checked as a pure read BEFORE any write; a mid-tx failure rolls
 * back only by THROWING (the `ManagedAbort` carrier), never by returning.
 */

import type { WorkspaceContext, ManagedChannelPort, ManagedConnectionRef, ManagedFetchedFile } from '../../context.js';
import { createHash } from 'node:crypto';
import { ok, err } from '../../result.js';
import type { Result } from '../../result.js';
import { importCamt } from '../camtReconcile.js';
import { getBankAccount } from '../bankAccounts.js';
import { uploadFile, linkFile, setFileRetention } from '../../files/index.js';
import { statutoryRetentionUntil } from '../../files/retention.js';
import { applySavedView } from '../../customization/views.js';
import { generatePain001 } from '../pain001.js';
import { MANAGED_SCOPE } from './enums.js';

/** Rolls a transaction back by THROW (the tx-commit-on-err trap): a returned `{ok:false}` would commit. */
class ManagedAbort extends Error {
  constructor(readonly result: Result) {
    super('managed-abort');
  }
}

// --- row shapes --------------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  bank_ref: string;
  state: string;
  scopes: string | null;
  consent_ref: string | null;
  bank_consent_expires_at: string | null;
  last_sync_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  connection_id: string;
  order_ref: string;
  direction: string;
  kind: string;
  msg_name: string | null;
  payload_sha256: string | null;
  related_kind: string | null;
  related_id: string | null;
  status: string;
  bank_reason: string | null;
  occurred_at: string;
}

// --- seams -------------------------------------------------------------------------------------

/** The managed relay, when a host wired one. Absent means the cloud tier is OFF: degrade to cloud_tier. */
function relay(ctx: WorkspaceContext): ManagedChannelPort | undefined {
  return ctx.managedChannel;
}

/** The OP4 degradation shape: the tier is off, and NO managed state exists to mislead (spec §3). */
function cloudTierOff(extra?: Record<string, unknown>): Result {
  return err('cloud_tier', {
    ...extra,
    reason: 'managed connectivity is an optional owner-gated tier; EBICS and file import work without it',
  });
}

/**
 * P8: connect/transmit/disconnect are deliberate acts. They proceed only when the A26 approval dial is
 * on OR a human passed `confirm:true` (spec §5, the A33 posture verbatim). The SAME workspace dial the
 * EBICS rail and eBill transmit read, so one dial governs every outbound act.
 */
function dialEnabled(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT posting_auto_issue AS v FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { v: number | null } | undefined;
  return row?.v === 1;
}

// --- reads / views -----------------------------------------------------------------------------

function readConnection(ctx: WorkspaceContext, id: unknown): ConnectionRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM managed_connection WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ConnectionRow | undefined;
}

/** The one LIVE (non-retired) connection for a (provider, bankRef), if any (the one-consent rule, §4). */
function readLiveConnectionForRef(ctx: WorkspaceContext, provider: string, bankRef: string): ConnectionRow | undefined {
  return ctx.store.db
    .prepare("SELECT * FROM managed_connection WHERE workspace_id = ? AND provider = ? AND bank_ref = ? AND state != 'retired'")
    .get(ctx.workspaceId, provider, bankRef) as ConnectionRow | undefined;
}

/** The connection a bank account is routed over (transmit/sync resolution), if any. */
export function readManagedConnectionForAccount(ctx: WorkspaceContext, bankAccountId: string): ConnectionRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT c.* FROM managed_connection c
         JOIN managed_connection_account a ON a.connection_id = c.id AND a.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND a.bank_account_id = ? AND c.state != 'retired'`,
    )
    .get(ctx.workspaceId, bankAccountId) as ConnectionRow | undefined;
}

function readRoutedAccountIds(ctx: WorkspaceContext, connectionId: string): string[] {
  const rows = ctx.store.db
    .prepare('SELECT bank_account_id FROM managed_connection_account WHERE workspace_id = ? AND connection_id = ? ORDER BY created_at ASC, id ASC')
    .all(ctx.workspaceId, connectionId) as { bank_account_id: string }[];
  return rows.map((r) => r.bank_account_id);
}

function readOrders(ctx: WorkspaceContext, connectionId: string): OrderRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM managed_order_log WHERE workspace_id = ? AND connection_id = ? ORDER BY occurred_at DESC, rowid DESC')
    .all(ctx.workspaceId, connectionId) as OrderRow[];
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function connectionRef(row: ConnectionRow): ManagedConnectionRef {
  return {
    connectionId: row.id,
    provider: row.provider,
    bankRef: row.bank_ref,
    ...(row.consent_ref !== null ? { consentRef: row.consent_ref } : {}),
  };
}

function accountIban(ctx: WorkspaceContext, bankAccountId: string): string | null {
  const view = getBankAccount(ctx, { bankAccountId });
  if (!view.ok) return null;
  return ((view as unknown as { bankAccount: { iban: string } }).bankAccount).iban ?? null;
}

function orderView(row: OrderRow): Record<string, unknown> {
  return {
    id: row.id,
    orderRef: row.order_ref,
    direction: row.direction,
    kind: row.kind,
    msgName: row.msg_name,
    payloadSha256: row.payload_sha256,
    relatedKind: row.related_kind,
    relatedId: row.related_id,
    status: row.status,
    bankReason: row.bank_reason,
    occurredAt: row.occurred_at,
  };
}

/** The full connection view (the panel's state card reads it, spec §6). Carries `channelKind` as data. */
function connectionView(ctx: WorkspaceContext, row: ConnectionRow): Record<string, unknown> {
  const accounts = readRoutedAccountIds(ctx, row.id).map((id) => ({ bankAccountId: id, iban: accountIban(ctx, id) }));
  return {
    connectionId: row.id,
    channelKind: 'managed_blink',
    provider: row.provider,
    bankRef: row.bank_ref,
    state: row.state,
    scopes: parseJson<string[]>(row.scopes) ?? [],
    consentRef: row.consent_ref,
    bankConsentExpiresAt: row.bank_consent_expires_at,
    routedAccounts: accounts,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- order-log append (append-only, §H-AUDIT spirit) -------------------------------------------

interface OrderAppend {
  connectionId: string;
  orderRef: string;
  direction: 'upload' | 'download';
  kind: string;
  msgName?: string | null;
  payloadSha256?: string | null;
  relatedKind?: string | null;
  relatedId?: string | null;
  status: string;
  bankReason?: string | null;
}

/** Append one order-log row. NEVER updates an existing row: a progression appends a new row (§4). */
function appendOrder(ctx: WorkspaceContext, a: OrderAppend): void {
  ctx.store.db
    .prepare(
      `INSERT INTO managed_order_log
         (id, workspace_id, connection_id, order_ref, direction, kind, msg_name, payload_sha256,
          related_kind, related_id, status, bank_reason, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.ids.next('mgord'),
      ctx.workspaceId,
      a.connectionId,
      a.orderRef,
      a.direction,
      a.kind,
      a.msgName ?? null,
      a.payloadSha256 ?? null,
      a.relatedKind ?? null,
      a.relatedId ?? null,
      a.status,
      a.bankReason ?? null,
      ctx.clock.now(),
    );
}

function appendOrderTx(ctx: WorkspaceContext, a: OrderAppend): void {
  ctx.store.tx(() => {
    appendOrder(ctx, a);
    return ok({});
  });
}

/** Route N A19 accounts under a connection (unique index dedupes a re-route). Validates each id. */
function routeAccounts(ctx: WorkspaceContext, connectionId: string, routeIds: string[]): Result {
  for (const bankAccountId of routeIds) {
    const acct = getBankAccount(ctx, { bankAccountId });
    if (!acct.ok) return err('bank_account_not_found', { bankAccountId });
    ctx.store.db
      .prepare(
        `INSERT INTO managed_connection_account (id, workspace_id, connection_id, bank_account_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, bank_account_id) DO NOTHING`,
      )
      .run(ctx.ids.next('mgca'), ctx.workspaceId, connectionId, bankAccountId, ctx.clock.now());
  }
  return ok({});
}

/** Persist one fetched file as an E00 artifact (OR 958f retention), COMMITTED before any import. */
function persistFetchedArtifact(ctx: WorkspaceContext, conn: ConnectionRow, file: ManagedFetchedFile, label: string): string {
  let fileId = '';
  ctx.store.tx(() => {
    const uploaded = uploadFile(ctx, {
      title: `${label} ${file.msgName} ${conn.bank_ref}`,
      filename: `managed-${conn.id}-${file.msgName}-${ctx.ids.next('f')}.xml`,
      mime: 'application/xml',
      contentBase64: file.contentBase64,
    });
    if (!uploaded.ok) throw new ManagedAbort(uploaded);
    fileId = ((uploaded as unknown as { file: { id: string } }).file).id;
    const linked = linkFile(ctx, { fileId, entityId: conn.id, entityKind: 'managed_connection' });
    if (!linked.ok) throw new ManagedAbort(linked);
    const retention = setFileRetention(ctx, { fileId, retentionUntil: statutoryRetentionUntil(ctx, ctx.clock.now().slice(0, 10)) });
    if (!retention.ok) throw new ManagedAbort(retention);
    return ok({});
  });
  return fileId;
}

function readStatementIban(xml: string): string | null {
  const m = /<IBAN>\s*([A-Z0-9]+)\s*<\/IBAN>/i.exec(xml);
  return m ? (m[1] ?? null) : null;
}

function normaliseIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Sanitise the requested scopes to the §H-ENUM set; default AIS-only (spec §4). */
function cleanScopes(raw: unknown): string[] {
  const allowed = MANAGED_SCOPE as readonly string[];
  if (!Array.isArray(raw)) return ['ais'];
  const picked = raw.filter((v): v is string => typeof v === 'string' && allowed.includes(v));
  return picked.length > 0 ? [...new Set(picked)] : ['ais'];
}

// --- verb 1 (managed branch): connect ----------------------------------------------------------

/**
 * US-A37.1: connect a managed (bLink) channel behind `bank_channel_connect` with
 * `channelKind:'managed_blink'`. With the tier OFF (no port) this returns the OP4 shape with zero side
 * effects (tripwire 5). With it on: P8-gated, it asks the relay for a fresh bank consent URL, creates
 * the `managed_connection` in `consent_pending`, and hands the customer to their bank's own e-banking.
 * The next status poll (advance) finds the consent granted and flips to `active`. TILL never sees,
 * asks for, or stores an e-banking credential.
 *
 * Idempotency is the NATURAL key (one live connection per provider+bankRef, the unique index), NOT a
 * memoized result: a memoized consentUrl would replay an EXPIRED URL, and the spec is explicit that a
 * fresh URL is a new relay call, never a stored secret. A resume re-requests a fresh URL for the
 * existing `consent_pending` row.
 */
export function connectManagedChannel(
  ctx: WorkspaceContext,
  input: {
    connectionId?: unknown;
    bankRef?: unknown;
    scopes?: unknown;
    routeBankAccountIds?: unknown;
    confirm?: unknown;
    idempotencyKey?: unknown;
  },
): Result {
  const port = relay(ctx);
  if (port === undefined) return cloudTierOff();

  // P8 (spec §5): connect is a deliberate act (the consent hand-off is the managed twin of the key
  // ceremony). Pre-checked BEFORE any write.
  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { reason: 'connect_requires_confirmation' });
  }

  const routeIds = Array.isArray(input.routeBankAccountIds)
    ? input.routeBankAccountIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

  // Advancing an EXISTING connection: poll consent state and (on granted) activate.
  if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
    const row = readConnection(ctx, input.connectionId);
    if (row === undefined) return err('not_found', { connectionId: input.connectionId });
    return advanceManaged(ctx, port, row, routeIds);
  }

  // A new consent needs the bank reference.
  const bankRef = typeof input.bankRef === 'string' ? input.bankRef : '';
  if (bankRef === '') {
    return err('invalid_input', { reason: 'bankRef is required to open a managed channel' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const scopes = cleanScopes(input.scopes);
  const provider = 'blink';

  // Validate the accounts to route BEFORE any write (a bad id must not leave a half-built consent).
  for (const id of routeIds) {
    const acct = getBankAccount(ctx, { bankAccountId: id });
    if (!acct.ok) return err('bank_account_not_found', { bankAccountId: id });
  }

  // One consent per (provider, bankRef): a live connection already exists -> route the accounts under
  // it and request a FRESH consent URL for the resume, never a stored one (spec §4).
  const existing = readLiveConnectionForRef(ctx, provider, bankRef);
  if (existing !== undefined) {
    const routed = routeAccounts(ctx, existing.id, routeIds);
    if (!routed.ok) return routed;
    if (existing.state === 'active') {
      return ok({
        connectionId: existing.id,
        channelKind: 'managed_blink',
        state: 'active',
        routed: true,
        reused: true,
        routedAccounts: readRoutedAccountIds(ctx, existing.id),
        connection: connectionView(ctx, existing),
      });
    }
    // consent_pending / consent_revoked / suspended: ask the relay for a fresh URL.
    const begun = port.beginConsent({ connection: connectionRef(existing), scopes, bankRef });
    if (!begun.ok) return err('channel_unreachable', { connectionId: existing.id, reason: begun.reason });
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE managed_connection SET state = 'consent_pending', consent_ref = ?, scopes = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(begun.consentRef, JSON.stringify(scopes), ctx.clock.now(), ctx.workspaceId, existing.id);
      return ok({});
    });
    const refreshed = readConnection(ctx, existing.id) as ConnectionRow;
    return ok({
      connectionId: existing.id,
      channelKind: 'managed_blink',
      state: 'consent_pending',
      reused: true,
      consentUrl: begun.consentUrl,
      consentRef: begun.consentRef,
      routedAccounts: readRoutedAccountIds(ctx, existing.id),
      connection: connectionView(ctx, refreshed),
    });
  }

  // Ask the relay for a fresh consent URL BEFORE creating the row: a relay refusal leaves no orphaned
  // managed state (the OP4 "no state to mislead" posture holds even on the unhappy path).
  const id = ctx.ids.next('mconn');
  const begun = port.beginConsent({ connection: { connectionId: id, provider, bankRef }, scopes, bankRef });
  if (!begun.ok) {
    if (begun.reason === 'format_unsupported') {
      return err('format_unsupported', { bankRef, reason: 'this bank delivers only JSON over bLink; the file rails remain the floor' });
    }
    return err('channel_unreachable', { bankRef, reason: begun.reason });
  }

  const at = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `INSERT INTO managed_connection
           (id, workspace_id, provider, bank_ref, state, scopes, consent_ref, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'consent_pending', ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, provider, bankRef, JSON.stringify(scopes), begun.consentRef, ctx.actor, at, at);
    const routed = routeAccounts(ctx, id, routeIds);
    if (!routed.ok) throw new ManagedAbort(routed);
    appendOrder(ctx, { connectionId: id, orderRef: `${id}-consent`, direction: 'download', kind: 'consent', status: 'ok' });
    return ok({});
  });
  const created = readConnection(ctx, id) as ConnectionRow;
  return ok({
    connectionId: id,
    channelKind: 'managed_blink',
    state: 'consent_pending',
    consentUrl: begun.consentUrl,
    consentRef: begun.consentRef,
    routedAccounts: readRoutedAccountIds(ctx, id),
    connection: connectionView(ctx, created),
  });
}

/** Advance an existing managed connection: poll consent state and (on granted) activate (spec §4). */
function advanceManaged(ctx: WorkspaceContext, port: ManagedChannelPort, row: ConnectionRow, routeIds: string[]): Result {
  const routed = routeAccounts(ctx, row.id, routeIds);
  if (!routed.ok) return routed;
  if (row.state === 'retired') {
    return err('invalid_state', { connectionId: row.id, state: 'retired', reason: 'a retired channel cannot be advanced' });
  }
  if (row.consent_ref === null) {
    return err('consent_pending', { connectionId: row.id, reason: 'no consent in flight; start a fresh connect' });
  }

  const consent = port.getConsentState({ connection: connectionRef(row), consentRef: row.consent_ref });
  if (!consent.ok) return err('channel_unreachable', { connectionId: row.id, reason: consent.reason });

  if (consent.state === 'granted') {
    const scopes = cleanScopes(consent.scopes);
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE managed_connection SET state = 'active', scopes = ?, bank_consent_expires_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(JSON.stringify(scopes), consent.bankConsentExpiresAt ?? null, ctx.clock.now(), ctx.workspaceId, row.id);
      return ok({});
    });
    const active = readConnection(ctx, row.id) as ConnectionRow;
    // `activatedConnectionId` is the OP8 emit path for `bank_channel.activated`: present ONLY on the
    // active flip, so every other connect outcome null-collapses the occurrence.
    return ok({
      connectionId: row.id,
      channelKind: 'managed_blink',
      state: 'active',
      activatedConnectionId: row.id,
      connection: connectionView(ctx, active),
    });
  }
  if (consent.state === 'revoked' || consent.state === 'expired') {
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE managed_connection SET state = 'consent_revoked', updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(ctx.clock.now(), ctx.workspaceId, row.id);
      return ok({});
    });
    return err('consent_revoked', { connectionId: row.id, reason: 'consent was revoked at the bank; reconnect to re-request it' });
  }
  // Still pending: the customer has not finished at the bank. Resume-or-cancel stays available.
  return ok({
    connectionId: row.id,
    channelKind: 'managed_blink',
    state: 'consent_pending',
    awaitingConsent: true,
    connection: connectionView(ctx, readConnection(ctx, row.id) as ConnectionRow),
  });
}

// --- verb 2 (managed branch): sync -------------------------------------------------------------

/**
 * US-A37.2: poll the relay for queued statement/status files, persist each as an E00 artifact, COMMIT,
 * acknowledge, and hand each camt XML BYTE-FOR-BYTE to A20's `importCamt`. The crash-durability
 * ordering is normative (spec §4, tripwire 4): persist + COMMIT precede every acknowledge, so a crash
 * loses nothing and a redelivery double-imports nothing (A20's dedupe). With the tier off -> cloud_tier.
 */
export function syncManagedChannel(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; bankAccountId?: unknown; idempotencyKey?: unknown },
): Result {
  const port = relay(ctx);
  if (port === undefined) return cloudTierOff();
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  let connection: ConnectionRow | undefined;
  if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
    connection = readConnection(ctx, input.connectionId);
  } else if (typeof input.bankAccountId === 'string' && input.bankAccountId.length > 0) {
    connection = readManagedConnectionForAccount(ctx, input.bankAccountId);
  }
  if (connection === undefined) return err('needs_bank_channel', { reason: 'no managed connection for the given selector' });
  const conn = connection;

  if (conn.state === 'consent_revoked') return err('consent_revoked', { connectionId: conn.id });
  if (conn.state === 'suspended') return err('cloud_tier_suspended', { connectionId: conn.id, reason: 'the vendor account lapsed; EBICS and file rails are unaffected' });
  if (conn.state !== 'active') return err('consent_pending', { connectionId: conn.id, state: conn.state });

  const fetched = port.fetchQueued({ connection: connectionRef(conn) });
  if (!fetched.ok) {
    if (fetched.reason === 'consent_revoked') {
      ctx.store.tx(() => {
        ctx.store.db
          .prepare("UPDATE managed_connection SET state = 'consent_revoked', updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(ctx.clock.now(), ctx.workspaceId, conn.id);
        return ok({});
      });
      return err('consent_revoked', { connectionId: conn.id });
    }
    if (fetched.reason === 'format_unsupported') {
      return err('format_unsupported', { connectionId: conn.id });
    }
    return err('channel_unreachable', { connectionId: conn.id, reason: fetched.reason, lastSyncAt: conn.last_sync_at });
  }

  const routedIbans = new Map<string, string>();
  for (const id of readRoutedAccountIds(ctx, conn.id)) {
    const iban = accountIban(ctx, id);
    if (iban !== null) routedIbans.set(normaliseIban(iban), id);
  }

  const results: Record<string, unknown>[] = [];
  const appliedQueueIds: string[] = [];
  const rejectedBatchIds: string[] = [];

  // THE CRASH-DURABILITY ORDERING (spec §4, tripwire 4): PERSIST + COMMIT before importing, and
  // acknowledge ONLY the queue ids whose files fully landed, LAST, so nothing is acked-but-unapplied.
  for (const file of fetched.files) {
    const persistedId = persistFetchedArtifact(ctx, conn, file, 'bLink file');
    const xml = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    const isStatement = /camt\.05[234]/i.test(file.msgName);

    if (!isStatement) {
      // A pain.002 status report folds into the order log (bank rejections), the A33 shape.
      const origMsgId = /<OrgnlMsgId>\s*([^<]+?)\s*<\/OrgnlMsgId>/i.exec(xml)?.[1] ?? null;
      const groupStatus = /<GrpSts>\s*([^<]+?)\s*<\/GrpSts>/i.exec(xml)?.[1] ?? /<TxSts>\s*([^<]+?)\s*<\/TxSts>/i.exec(xml)?.[1] ?? null;
      const reason = /<AddtlInf>\s*([^<]+?)\s*<\/AddtlInf>/i.exec(xml)?.[1] ?? /<Prtry>\s*([^<]+?)\s*<\/Prtry>/i.exec(xml)?.[1] ?? null;
      const rejected = groupStatus === 'RJCT';
      const batchOrder = origMsgId === null ? undefined : findOrderByMsgId(ctx, conn.id, origMsgId);
      if (rejected && batchOrder?.related_kind === 'payment_batch' && batchOrder.related_id !== null) {
        rejectedBatchIds.push(batchOrder.related_id);
      }
      appendOrderTx(ctx, {
        connectionId: conn.id,
        orderRef: batchOrder?.order_ref ?? `${conn.id}-pain002-${persistedId}`,
        direction: 'download',
        kind: 'status_report',
        msgName: file.msgName,
        relatedKind: batchOrder?.related_kind ?? 'bank_statement',
        relatedId: batchOrder?.related_id ?? persistedId,
        status: rejected ? 'bank_rejected' : 'ok',
        bankReason: rejected ? (reason ?? 'RJCT') : null,
      });
      appliedQueueIds.push(file.queueId);
      results.push({ msgName: file.msgName, documentId: persistedId, kind: 'status_report', rejected });
      continue;
    }

    const iban = readStatementIban(xml);
    const matchedAccountId = iban === null ? undefined : routedIbans.get(normaliseIban(iban));
    if (matchedAccountId === undefined) {
      appendOrderTx(ctx, {
        connectionId: conn.id,
        orderRef: `${conn.id}-stmt-${persistedId}`,
        direction: 'download',
        kind: 'statements',
        msgName: file.msgName,
        relatedKind: 'unmatched_statement',
        relatedId: persistedId,
        status: 'ok',
        bankReason: iban,
      });
      // Unmatched files stay UN-acknowledged so the relay re-offers them once an account is routed.
      results.push({ msgName: file.msgName, documentId: persistedId, iban, routing: 'unmatched_account' });
      continue;
    }

    const imported = importCamt(ctx, { bankAccountId: matchedAccountId, xml, idempotencyKey: `a37-${conn.id}-${persistedId}` });
    const importReason = imported.ok ? null : ((imported as { error?: string }).error ?? 'import_failed');
    appendOrderTx(ctx, {
      connectionId: conn.id,
      orderRef: `${conn.id}-stmt-${persistedId}`,
      direction: 'download',
      kind: 'statements',
      msgName: file.msgName,
      relatedKind: 'bank_statement',
      relatedId: persistedId,
      status: imported.ok ? 'ok' : 'failed',
      bankReason: importReason,
    });
    if (imported.ok) appliedQueueIds.push(file.queueId);
    results.push({
      msgName: file.msgName,
      documentId: persistedId,
      bankAccountId: matchedAccountId,
      iban,
      routing: 'matched',
      importOk: imported.ok,
      ...(imported.ok ? {} : { importReason }),
    });
  }

  // ACKNOWLEDGE LAST, and ONLY the fully-applied queue ids: the persist-before-acknowledge invariant
  // (tripwire 4). A refusal/throw is swallowed: the data is durable and imported, and a redelivery is
  // A20's dedupe no-op.
  if (appliedQueueIds.length > 0) {
    try {
      port.acknowledge({ connection: connectionRef(conn), queueIds: appliedQueueIds });
    } catch {
      // Deliberately swallowed: the fetched data already landed.
    }
  }

  const now = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare('UPDATE managed_connection SET last_sync_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, now, ctx.workspaceId, conn.id);
    return ok({});
  });

  const unappliedStatements = results.filter((r) => r.routing === 'matched' && r.importOk === false).length;
  const result: Record<string, unknown> = { connectionId: conn.id, channelKind: 'managed_blink', files: results, lastSyncAt: now };
  if (unappliedStatements > 0) result.unappliedStatements = unappliedStatements;
  if (rejectedBatchIds.length > 0) result.rejectedBatchId = rejectedBatchIds[0];
  return ok(result);
}

/** The most recent managed order carrying a given pain.001 MsgId (its `msg_name`), for pain.002 folding. */
function findOrderByMsgId(ctx: WorkspaceContext, connectionId: string, msgId: string): OrderRow | undefined {
  return ctx.store.db
    .prepare(
      "SELECT * FROM managed_order_log WHERE workspace_id = ? AND connection_id = ? AND kind = 'payment_submit' AND msg_name = ? ORDER BY occurred_at DESC, rowid DESC",
    )
    .get(ctx.workspaceId, connectionId, msgId) as OrderRow | undefined;
}

// --- verb 3 (managed branch): transmit ---------------------------------------------------------

/**
 * US-A37.3: submit an A18 `generated` pain.001 batch over bLink PSS (P8-gated). Release stays at the
 * bank (the no-sole-authority boundary, spec §3): NEVER marks anything paid (paid comes from camt via
 * A20/A18). The intent-before-submit protocol is the §H-IDEMPOTENT mechanism (spec §4): an intent row
 * committed before any relay I/O, at most one non-failed order per batch, CROSS-RAIL (a batch already
 * submitted over EBICS cannot also be submitted over bLink; the intent chain is per batch, not per rail).
 */
export function transmitManagedBatch(
  ctx: WorkspaceContext,
  input: { batchId?: unknown; confirm?: unknown; idempotencyKey?: unknown },
  conn: ConnectionRow,
): Result {
  const port = relay(ctx);
  if (port === undefined) return cloudTierOff();
  if (typeof input.batchId !== 'string' || input.batchId.length === 0) {
    return err('invalid_input', { field: 'batchId' });
  }
  const batchId = input.batchId;

  const batch = ctx.store.db
    .prepare('SELECT id, status, bank_account_id, msg_id FROM payment_batch WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, batchId) as { id: string; status: string; bank_account_id: string; msg_id: string | null } | undefined;
  if (batch === undefined) return err('not_found', { batchId });
  if (batch.status !== 'generated') return err('needs_batch_generated', { batchId, status: batch.status });

  if (conn.state === 'consent_revoked') return err('consent_revoked', { batchId, connectionId: conn.id });
  if (conn.state === 'suspended') return err('cloud_tier_suspended', { batchId, connectionId: conn.id });
  if (conn.state !== 'active') return err('consent_pending', { batchId, connectionId: conn.id, state: conn.state });

  // The PSS scope must be consented (spec §4): AIS-only cannot submit a payment. Never a silent fallback.
  const scopes = parseJson<string[]>(conn.scopes) ?? [];
  if (!scopes.includes('pss')) {
    return err('consent_scope_missing', { batchId, connectionId: conn.id, needed: 'pss' });
  }

  // CROSS-RAIL idempotency (tripwire 3): a non-failed EBICS order for this batch blocks a managed
  // submit. The reverse guard lives in the EBICS transmit path, so both orders are refused.
  const ebicsOrder = ctx.store.db
    .prepare("SELECT status FROM ebics_order_log WHERE workspace_id = ? AND related_kind = 'payment_batch' AND related_id = ? AND status != 'failed' ORDER BY occurred_at DESC, rowid DESC LIMIT 1")
    .get(ctx.workspaceId, batchId) as { status: string } | undefined;
  if (ebicsOrder !== undefined) {
    return err('already_transmitted', { batchId, rail: 'ebics', reason: 'this batch is already in flight over the EBICS rail' });
  }

  // Order-level idempotency on the managed rail: an existing non-failed order answers, delivers nothing.
  const existing = latestOrderForBatch(ctx, conn.id, batchId);
  if (existing !== undefined && existing.status !== 'failed') {
    if (existing.status === 'intent') {
      return err('transmit_in_doubt', { batchId, orderRef: existing.order_ref, connectionId: conn.id });
    }
    return ok({ transmitted: true, orderId: existing.id, orderRef: existing.order_ref, status: existing.status, batchId, transmittedBatchId: batchId, channelKind: 'managed_blink' });
  }

  // P8 (spec §5): moving real-world money is a deliberate act. Pre-checked BEFORE any write.
  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { batchId, reason: 'transmit_requires_confirmation' });
  }

  // 1) Regenerate the byte-identical pain.001 (A18) and compute the payload identity. Pure read.
  const regen = generatePain001(ctx, { batchId, idempotencyKey: `a37-transmit-${batchId}` });
  if (!regen.ok) return regen;
  const payloadBase64 = (regen as unknown as { xmlBase64: string }).xmlBase64;
  const payloadSha256 = sha256Hex(Buffer.from(payloadBase64, 'base64'));
  const msgId = (regen as unknown as { batch?: { msgId?: string } }).batch?.msgId ?? batch.msg_id ?? `${batchId}-msg`;
  const orderRef = `${conn.id}-pss-${batchId}`;

  // 2) INTENT BEFORE SUBMIT: append the intent row and COMMIT, before any relay I/O (spec §4).
  ctx.store.tx(() => {
    appendOrder(ctx, {
      connectionId: conn.id,
      orderRef,
      direction: 'upload',
      kind: 'payment_submit',
      msgName: msgId,
      payloadSha256,
      relatedKind: 'payment_batch',
      relatedId: batchId,
      status: 'intent',
    });
    return ok({});
  });

  // 3) Submit over PSS. A THROW is UNKNOWN: the intent stands and the batch surfaces as
  //    transmit_in_doubt (the port contract). A returned {ok:false} means the relay refused: failed.
  const submitted = port.submitPayment({ connection: connectionRef(conn), orderRef, payloadBase64 });
  if (!submitted.ok) {
    ctx.store.tx(() => {
      appendOrder(ctx, {
        connectionId: conn.id,
        orderRef,
        direction: 'upload',
        kind: 'payment_submit',
        msgName: msgId,
        payloadSha256,
        relatedKind: 'payment_batch',
        relatedId: batchId,
        status: 'failed',
        bankReason: submitted.reason,
      });
      return ok({});
    });
    return err('bank_rejected', { batchId, orderRef, reason: submitted.reason });
  }

  // 4) Accepted for delivery: pending_release (the customer releases at the bank). NEVER paid.
  let orderId = '';
  ctx.store.tx(() => {
    appendOrder(ctx, {
      connectionId: conn.id,
      orderRef,
      direction: 'upload',
      kind: 'payment_submit',
      msgName: msgId,
      payloadSha256,
      relatedKind: 'payment_batch',
      relatedId: batchId,
      status: 'pending_release',
    });
    const row = ctx.store.db
      .prepare("SELECT id FROM managed_order_log WHERE workspace_id = ? AND order_ref = ? AND status = 'pending_release' ORDER BY occurred_at DESC, rowid DESC")
      .get(ctx.workspaceId, orderRef) as { id: string } | undefined;
    orderId = row?.id ?? '';
    return ok({});
  });
  return ok({ transmitted: true, orderId, orderRef, status: 'pending_release', batchId, transmittedBatchId: batchId, channelKind: 'managed_blink' });
}

/** The most recent managed order-log row for a payment batch over a connection (order-level idempotency). */
function latestOrderForBatch(ctx: WorkspaceContext, connectionId: string, batchId: string): OrderRow | undefined {
  return ctx.store.db
    .prepare(
      "SELECT * FROM managed_order_log WHERE workspace_id = ? AND connection_id = ? AND related_kind = 'payment_batch' AND related_id = ? ORDER BY occurred_at DESC, rowid DESC",
    )
    .get(ctx.workspaceId, connectionId, batchId) as OrderRow | undefined;
}

// --- verb 4 (managed branch): status -----------------------------------------------------------

/**
 * US-A37.4: the P5 read model over the managed tables, one channel view per connection, kind-labelled
 * (`channelKind:'managed_blink'`) with consent fields. Returns the raw channel array; the dispatcher
 * merges it with the EBICS channels so the panel renders both rails in one list. Works with the tier
 * off too: no managed rows exist, so the list is simply empty (no lie).
 */
export function managedChannelStatusList(
  ctx: WorkspaceContext,
  input: { bankAccountId?: unknown; status?: unknown; savedViewId?: unknown },
): { channels: Record<string, unknown>[] } {
  // The G00 saved-view seam (OP10) over the managed order log, the A33 shape.
  const listFilter: { status?: string; savedViewId?: string } = {};
  if (typeof input.status === 'string' && input.status.length > 0) listFilter.status = input.status;
  if (typeof input.savedViewId === 'string' && input.savedViewId.length > 0) listFilter.savedViewId = input.savedViewId;
  const viewed = applySavedView(ctx, 'managed_order', listFilter);
  const orderStatusFilter = viewed.ok && typeof viewed.filter.status === 'string' && viewed.filter.status.length > 0 ? viewed.filter.status : null;

  let rows: ConnectionRow[];
  if (typeof input.bankAccountId === 'string' && input.bankAccountId.length > 0) {
    const c = readManagedConnectionForAccount(ctx, input.bankAccountId);
    rows = c === undefined ? [] : [c];
  } else {
    rows = ctx.store.db
      .prepare('SELECT * FROM managed_connection WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(ctx.workspaceId) as ConnectionRow[];
  }

  const channels = rows.map((row) => {
    const allOrders = readOrders(ctx, row.id);
    const byRef = new Map<string, OrderRow>();
    for (const o of allOrders) if (!byRef.has(o.order_ref)) byRef.set(o.order_ref, o);
    const recent = orderStatusFilter === null ? allOrders : allOrders.filter((o) => o.status === orderStatusFilter);
    const latest = [...byRef.values()];
    const pendingRelease = latest
      .filter((o) => o.status === 'pending_release')
      .map((o) => ({ batchId: o.related_id, orderId: o.id, orderRef: o.order_ref, since: o.occurred_at }));
    const inDoubt = latest
      .filter((o) => o.status === 'intent')
      .map((o) => ({ batchId: o.related_id, orderRef: o.order_ref, since: o.occurred_at }));
    const rejected = latest
      .filter((o) => o.status === 'bank_rejected')
      .map((o) => ({ batchId: o.related_id, orderRef: o.order_ref, reason: o.bank_reason, since: o.occurred_at }));
    const unmatchedFiles = latest
      .filter((o) => o.related_kind === 'unmatched_statement')
      .map((o) => ({ documentId: o.related_id, msgName: o.msg_name, iban: o.bank_reason, orderRef: o.order_ref }));
    return {
      connectionId: row.id,
      channelKind: 'managed_blink',
      provider: row.provider,
      bankRef: row.bank_ref,
      state: row.state,
      scopes: parseJson<string[]>(row.scopes) ?? [],
      accounts: readRoutedAccountIds(ctx, row.id).map((id) => ({ bankAccountId: id, iban: accountIban(ctx, id) })),
      lastSyncAt: row.last_sync_at,
      bankConsentExpiresAt: row.bank_consent_expires_at,
      pendingRelease,
      inDoubt,
      rejected,
      unmatchedFiles,
      recentOrders: recent.slice(0, 20).map(orderView),
    };
  });
  return { channels };
}

// --- verb 5 (managed branch): disconnect -------------------------------------------------------

/**
 * US-A37.1/4 (teardown): retire a managed channel (P8-gated). `retire` is the local, terminal close:
 * the connection flips to `retired`, its order history stays readable. Consent revocation itself
 * always lives at the bank (spec §5); there is no `block` mode on the managed rail. Idempotent.
 */
export function disconnectManagedChannel(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; mode?: unknown; confirm?: unknown; idempotencyKey?: unknown },
  row: ConnectionRow,
): Result {
  const mode = input.mode === 'retire' ? 'retire' : input.mode === undefined || input.mode === null ? 'retire' : input.mode;
  if (mode !== 'retire') {
    return err('invalid_input', { field: 'mode', expected: ['retire'], reason: 'the managed rail has no block mode; consent is revoked at the bank' });
  }
  if (row.state === 'retired') return ok({ connectionId: row.id, channelKind: 'managed_blink', state: 'retired' });

  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { connectionId: row.id, reason: 'disconnect_requires_confirmation' });
  }

  ctx.store.tx(() => {
    ctx.store.db
      .prepare("UPDATE managed_connection SET state = 'retired', consent_ref = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.clock.now(), ctx.workspaceId, row.id);
    return ok({});
  });
  return ok({ connectionId: row.id, channelKind: 'managed_blink', state: 'retired' });
}

// --- dispatch helpers (read by the EBICS-verb channel-kind dispatch) ---------------------------

/** Whether a connection id names a MANAGED connection (dispatch by id, §4). */
export function isManagedConnectionId(ctx: WorkspaceContext, id: unknown): boolean {
  return readConnection(ctx, id) !== undefined;
}

/** The managed connection row for a disconnect/advance selector, if any. */
export function readManagedConnection(ctx: WorkspaceContext, id: unknown): ConnectionRow | undefined {
  return readConnection(ctx, id);
}
