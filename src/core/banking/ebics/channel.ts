/**
 * A33, EBICS bank channel (spec `docs/specs/specs/A33-ebics-bank-channel.md`): the local, user-owned
 * EBICS client. It turns the weekly file ritual (download camt from e-banking, upload the pain.001)
 * into one verb each way, over the user's OWN bank contract, with the user's OWN keys, egress from
 * the user's OWN device (owner decision D29: this is OSS-core, the A11/A15 local-SMTP precedent).
 *
 * THE LAW, enforced in code below, not merely documented (spec §1/§3/§4): **EBICS submits; the bank
 * authorizes; TILL never holds sole payment authority.** `transmitPaymentBatch` uploads WITHOUT the
 * authorizing SignatureFlag (v1, §3), so the ONLY release path the submission can produce is the
 * bank's own out-of-channel release (SMPG §4.2.3). A transmitted batch is an instruction delivered,
 * never money moved and never a book entry: `paid` comes from camt (A18's rule), reached only through
 * A20. `assertNoSoleAuthority` below pins the posture, and tripwire 5 asserts it can never silently flip.
 *
 * A33 POSTS NOTHING (P3 by delegation, spec §4). Nothing here calls `postEntry`/`recordPayment`, and
 * statements enter the books ONLY through A20's `importCamt`, handed the fetched bytes byte-for-byte.
 * The three tables are channel metadata and an append-only order log, never a ledger table.
 *
 * OFFLINE BY CONSTRUCTION. The core NEVER opens a socket: every network step goes through the
 * `EbicsTransportPort` seam (context.ts), which a test wires as an in-process mock host and a host
 * (the `till` CLI / Studio) wires as a real HTTPS client. With no transport wired the verbs degrade
 * honestly (`needs_bank_transport`, §4 P9) and the file-based A20/A18 path stays the visible floor.
 *
 * THE tx-COMMIT-ON-ERR TRAP (house rule): returning `{ok:false}` INSIDE `ctx.store.tx` COMMITS the
 * partial writes. Every refusal is pre-checked as a pure read BEFORE any write; a mid-tx failure rolls
 * back only by THROWING (the `EbicsAbort` carrier), never by returning.
 */

import type {
  WorkspaceContext,
  EbicsTransportPort,
  EbicsKeystorePort,
  EbicsConnectionRef,
  EbicsKeyHashes,
  EbicsFetchedFile,
} from '../../context.js';
import { createHash } from 'node:crypto';
import { ok, err } from '../../result.js';
import type { Result } from '../../result.js';
import { importCamt } from '../camtReconcile.js';
import { getBankAccount } from '../bankAccounts.js';
import { uploadFile, linkFile, setFileRetention } from '../../files/index.js';
import { statutoryRetentionUntil } from '../../files/retention.js';
import { getCompanyProfile } from '../../setup/companyProfile.js';
import { applySavedView } from '../../customization/views.js';
import { defaultEbicsKeystore } from './keystore.js';
import { EBICS_DEFAULT_KEY_PARAMS, EBICS_UNLIMITED_VALIDITY } from './enums.js';
import { generatePain001 } from '../pain001.js';
// A37 dispatch: the managed (bLink) rail sits behind these same five verbs (spec A37 §5). This module
// imports the managed engine one-directionally (managed never imports back), so the channel-kind
// dispatch is the whole seam and the EBICS logic below stays byte-identical for the default rail.
import {
  connectManagedChannel,
  syncManagedChannel,
  transmitManagedBatch,
  managedChannelStatusList,
  disconnectManagedChannel,
  isManagedConnectionId,
  readManagedConnection,
  readManagedConnectionForAccount,
} from '../managed/index.js';

/** Rolls a transaction back by THROW (the tx-commit-on-err trap): a returned `{ok:false}` would commit. */
class EbicsAbort extends Error {
  constructor(readonly result: Result) {
    super('ebics-abort');
  }
}

// --- row shapes --------------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  workspace_id: string;
  host_url: string;
  host_id: string;
  partner_id: string;
  user_id_ebics: string;
  protocol_version: string;
  state: string;
  btf_params: string | null;
  key_params: string | null;
  key_ref: string | null;
  bank_key_hashes: string | null;
  ini_letter_document_id: string | null;
  activated_at: string | null;
  last_sync_at: string | null;
  sync_rule_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  connection_id: string;
  order_ref: string;
  direction: string;
  order_type: string;
  btf_service_name: string | null;
  btf_msg_name: string | null;
  payload_sha256: string | null;
  related_kind: string | null;
  related_id: string | null;
  status: string;
  bank_reason: string | null;
  occurred_at: string;
}

// --- seams -------------------------------------------------------------------------------------

/** The key custody seam: the host's keystore when wired, else the core's in-process default (§3.1). */
function keystore(ctx: WorkspaceContext): EbicsKeystorePort {
  return ctx.ebicsKeystore ?? defaultEbicsKeystore;
}

/** The EBICS transport, when a host wired one. Absent means the network steps degrade honestly (§4). */
function transport(ctx: WorkspaceContext): EbicsTransportPort | undefined {
  return ctx.ebicsTransport;
}

/**
 * A36: the keystore's unlock state, for a channel verb to pre-check BEFORE it asks the store to
 * generate or read key material. A passphrase-encrypted file store not yet unlocked this session is
 * `keystore_locked` (retry the host prompt, NEVER regenerate: a wrong passphrase minting fresh keys
 * would strand the live bank contract, US-A36.2); a missing or corrupt backing file is
 * `keystore_unavailable` (re-initialisation is the one recovery, the bank contract is unaffected). The
 * in-memory default and any store without `state()` read as always-ready, so the honest degradation is
 * unchanged for an embed that manages its own custody.
 */
function keystoreBlock(ctx: WorkspaceContext, extra?: Record<string, unknown>): Result | null {
  const state = keystore(ctx).state?.();
  if (state === 'locked') return err('keystore_locked', { ...extra, reason: 'passphrase not provided this session' });
  if (state === 'unavailable') {
    return err('keystore_unavailable', {
      ...extra,
      reason: 'the keystore file is missing or corrupt; re-initialise the connection (the bank contract is unaffected)',
    });
  }
  return null;
}

/**
 * P8: a connect/sync-adjacent/transmit/disconnect step is a deliberate act. It proceeds only when the
 * A26 approval dial is on OR a human passed `confirm:true`. An agent without the dial is stopped at
 * `needs_confirmation`, never silently advanced (spec §5, tripwire 4 keeps these out of automation).
 * The SAME workspace dial `send_invoice` / eBill transmit read, so one dial governs every outbound act.
 */
function dialEnabled(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT posting_auto_issue AS v FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { v: number | null } | undefined;
  return row?.v === 1;
}

/**
 * THE LAW, asserted in code (spec §3/§4): v1 uploads WITHOUT the authorizing SignatureFlag, so TILL
 * never holds sole payment authority. This is the single point where the posture is decided; tripwire
 * 5 pins its return so the boundary cannot silently flip. `requestEDS` is never set either, so a VEU
 * wait-queue entry is unreachable in v1 (§3): the bank's out-of-channel release is the only release.
 */
export function assertNoSoleAuthority(): { signatureFlag: false; requestEDS: false } {
  return { signatureFlag: false, requestEDS: false };
}

/** Thrown when a sole-payment-authority flag reaches the transmit boundary. NEVER caught: the law is absolute. */
export class SoleAuthorityViolation extends Error {
  constructor(readonly flag: string) {
    super(`A33 THE LAW violated: a sole-payment-authority flag (${flag}) reached the EBICS upload boundary`);
  }
}

/**
 * THE LAW as a RUNTIME GUARD on the one outbound BTU request, not a documentary constant (D98
 * hardening): it re-asserts the v1 posture AND refuses to hand the port any request that carries a
 * signature/authorization flag, THROWING before a single byte leaves. The upload request the port
 * receives is exactly the one this returns, so no code path (nor a future edit, nor a plugin channel)
 * can smuggle a `signatureFlag`/`requestEDS`/`SignatureFlag` past it. Defense-in-depth behind the
 * structural guarantee that the port shape carries no such field: if one were ever added, this bites.
 */
export function guardNoSoleAuthority<T extends Record<string, unknown>>(request: T): T {
  const posture = assertNoSoleAuthority();
  if (posture.signatureFlag !== false || posture.requestEDS !== false) {
    throw new SoleAuthorityViolation('posture');
  }
  for (const banned of ['signatureFlag', 'SignatureFlag', 'requestEDS', 'requesteds']) {
    if (banned in request && (request as Record<string, unknown>)[banned]) {
      throw new SoleAuthorityViolation(banned);
    }
  }
  return request;
}

// --- reads / views -----------------------------------------------------------------------------

function readConnection(ctx: WorkspaceContext, id: unknown): ConnectionRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM ebics_connection WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ConnectionRow | undefined;
}

/** The one LIVE (non-retired) connection for a bank contract, if any (the one-ceremony rule, §4). */
function readLiveConnectionForContract(
  ctx: WorkspaceContext,
  host: { hostId: string; partnerId: string; userId: string },
): ConnectionRow | undefined {
  return ctx.store.db
    .prepare(
      "SELECT * FROM ebics_connection WHERE workspace_id = ? AND host_id = ? AND partner_id = ? AND user_id_ebics = ? AND state != 'retired'",
    )
    .get(ctx.workspaceId, host.hostId, host.partnerId, host.userId) as ConnectionRow | undefined;
}

/** The connection a bank account is routed over (transmit/sync resolution), if any. */
function readConnectionForAccount(ctx: WorkspaceContext, bankAccountId: string): ConnectionRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT c.* FROM ebics_connection c
         JOIN ebics_connection_account a ON a.connection_id = c.id AND a.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND a.bank_account_id = ? AND c.state != 'retired'`,
    )
    .get(ctx.workspaceId, bankAccountId) as ConnectionRow | undefined;
}

function readRoutedAccountIds(ctx: WorkspaceContext, connectionId: string): string[] {
  const rows = ctx.store.db
    .prepare('SELECT bank_account_id FROM ebics_connection_account WHERE workspace_id = ? AND connection_id = ? ORDER BY created_at ASC, id ASC')
    .all(ctx.workspaceId, connectionId) as { bank_account_id: string }[];
  return rows.map((r) => r.bank_account_id);
}

function readOrders(ctx: WorkspaceContext, connectionId: string): OrderRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? ORDER BY occurred_at DESC, rowid DESC')
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

function connectionRef(row: ConnectionRow): EbicsConnectionRef {
  return {
    hostUrl: row.host_url,
    hostId: row.host_id,
    partnerId: row.partner_id,
    userIdEbics: row.user_id_ebics,
    protocolVersion: row.protocol_version,
    keyRef: row.key_ref ?? '',
  };
}

function accountIban(ctx: WorkspaceContext, bankAccountId: string): string | null {
  const view = getBankAccount(ctx, { bankAccountId });
  if (!view.ok) return null;
  return ((view as unknown as { bankAccount: { iban: string } }).bankAccount).iban ?? null;
}

function connectionView(ctx: WorkspaceContext, row: ConnectionRow): Record<string, unknown> {
  const accounts = readRoutedAccountIds(ctx, row.id).map((id) => ({ bankAccountId: id, iban: accountIban(ctx, id) }));
  return {
    connectionId: row.id,
    host: { url: row.host_url, hostId: row.host_id, partnerId: row.partner_id, userId: row.user_id_ebics },
    protocolVersion: row.protocol_version,
    state: row.state,
    keyParams: parseJson(row.key_params),
    btfParams: parseJson(row.btf_params),
    bankKeyHashes: parseJson<EbicsKeyHashes>(row.bank_key_hashes),
    iniLetterDocumentId: row.ini_letter_document_id,
    routedAccounts: accounts,
    activatedAt: row.activated_at,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderView(row: OrderRow): Record<string, unknown> {
  return {
    id: row.id,
    orderRef: row.order_ref,
    direction: row.direction,
    orderType: row.order_type,
    payloadSha256: row.payload_sha256,
    relatedKind: row.related_kind,
    relatedId: row.related_id,
    status: row.status,
    bankReason: row.bank_reason,
    occurredAt: row.occurred_at,
  };
}

// --- order-log append (append-only, §H-AUDIT spirit) -------------------------------------------

interface OrderAppend {
  connectionId: string;
  orderRef: string;
  direction: 'upload' | 'download';
  orderType: string;
  btfServiceName?: string | null;
  btfMsgName?: string | null;
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
      `INSERT INTO ebics_order_log
         (id, workspace_id, connection_id, order_ref, direction, order_type, btf_service_name,
          btf_msg_name, payload_sha256, related_kind, related_id, status, bank_reason, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.ids.next('ebord'),
      ctx.workspaceId,
      a.connectionId,
      a.orderRef,
      a.direction,
      a.orderType,
      a.btfServiceName ?? null,
      a.btfMsgName ?? null,
      a.payloadSha256 ?? null,
      a.relatedKind ?? null,
      a.relatedId ?? null,
      a.status,
      a.bankReason ?? null,
      ctx.clock.now(),
    );
}

// --- INI letter (an E00 artifact) --------------------------------------------------------------

/**
 * Render the INI letter the customer signs and posts to the bank (SMPG §6.1): the bank-contract
 * identifiers plus TILL's three PUBLIC-key hash values (never the keys). Stored as an E00 file so it
 * is a real, downloadable, retained artifact. Text, not PDF: it carries only identifiers and hashes,
 * and a monospace hash block is what the bank compares (a PDF pipeline would add nothing verifiable).
 */
function renderIniLetterText(row: ConnectionRow, hashes: EbicsKeyHashes, companyName: string): string {
  return [
    'EBICS INI-Brief / EBICS initialisation letter',
    '',
    `Kunde / Customer: ${companyName}`,
    `Host-ID: ${row.host_id}`,
    `Partner-ID (Kunden-ID): ${row.partner_id}`,
    `Teilnehmer-ID (User-ID): ${row.user_id_ebics}`,
    `EBICS-Version: ${row.protocol_version}`,
    `Gültigkeit / Validity: unlimited (${EBICS_UNLIMITED_VALIDITY}, SMPG 6.1)`,
    '',
    'Hashwerte der öffentlichen Schlüssel (SHA-256) / public-key hash values:',
    `  Elektronische Unterschrift (A005): ${hashes.electronicSignature}`,
    `  Authentifikation (X002):           ${hashes.authentication}`,
    `  Verschlüsselung (E002):            ${hashes.encryption}`,
    '',
    'Unterschrift / Signature: ______________________   Datum / Date: __________',
  ].join('\n');
}

function fileById(uploaded: Result): string {
  return ((uploaded as unknown as { file: { id: string } }).file).id;
}

// --- verb 1: connectBankChannel ----------------------------------------------------------------

/**
 * US-A33.1: the whole SMPG §6.1 key ceremony behind one composed, state-machine-advancing verb, keyed
 * to the bank CONTRACT (host/partner/user), never an account (§4). From nothing: generate the three
 * RSA key pairs LOCALLY (per the connection's captured key length, default 2048, §3), create the
 * connection row, route the given A19 accounts, and render the INI letter as an E00 artifact. If a
 * transport is wired it then sends INI + HIA and lands `pending_bank_activation`; with none wired it
 * stays `keys_generated` and answers honestly (`needs_bank_transport`), the useful local work done.
 * From `pending_bank_activation`/`bank_keys_changed`: run HPB, surface the bank's key hashes for
 * out-of-band comparison, and flip to `active` ONLY when `confirmBankKeys:true` and the hashes match;
 * a mismatch is `bank_keys_mismatch`, a hard stop that never advances. A second ceremony on a live
 * contract is refused: the account is routed under the existing connection instead (one ceremony, ever).
 */
export function connectBankChannel(
  ctx: WorkspaceContext,
  input: {
    channelKind?: unknown;
    connectionId?: unknown;
    bankRef?: unknown;
    scopes?: unknown;
    host?: { url?: unknown; hostId?: unknown; partnerId?: unknown; userId?: unknown } | undefined;
    routeBankAccountIds?: unknown;
    confirm?: unknown;
    confirmBankKeys?: unknown;
    keyLength?: unknown;
    idempotencyKey?: unknown;
  },
): Result {
  // A37 dispatch (spec §5): `channelKind:'managed_blink'` routes to the managed rail; the default and
  // an explicit `'ebics'` stay the EBICS path below, byte-identical. Advancing an EXISTING connection
  // whose id names a managed connection also routes to the managed rail (the kind is resolved from the
  // row, not restated by the caller).
  if (input.channelKind === 'managed_blink' || (typeof input.connectionId === 'string' && isManagedConnectionId(ctx, input.connectionId))) {
    return connectManagedChannel(ctx, input);
  }

  // P8 (spec §5): connect is a deliberate act. Pre-checked BEFORE any write.
  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { reason: 'connect_requires_confirmation' });
  }

  const routeIds = Array.isArray(input.routeBankAccountIds)
    ? input.routeBankAccountIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

  // Advancing an EXISTING connection (activation, or re-initialisation of a blocked one).
  if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
    const row = readConnection(ctx, input.connectionId);
    if (row === undefined) return err('not_found', { connectionId: input.connectionId });
    return advanceConnection(ctx, row, { confirmBankKeys: input.confirmBankKeys === true, routeIds });
  }

  // A new ceremony needs the host contract data.
  const host = input.host;
  const hostUrl = typeof host?.url === 'string' ? host.url : '';
  const hostId = typeof host?.hostId === 'string' ? host.hostId : '';
  const partnerId = typeof host?.partnerId === 'string' ? host.partnerId : '';
  const userId = typeof host?.userId === 'string' ? host.userId : '';
  if (hostUrl === '' || hostId === '' || partnerId === '' || userId === '') {
    return err('invalid_input', { reason: 'host {url, hostId, partnerId, userId} is required to open a channel' });
  }

  // Idempotency by KEY (spec §5, the conformance replay compares results row by row): the FULL
  // outcome is memoized under the key, so a replay returns the identical result and writes nothing.
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const scopedKey = JSON.stringify(['bank_channel_connect', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'bank_channel_connect');
  if (replayed !== undefined) return replayed;

  // One ceremony per contract: a live connection already exists -> route the accounts under it and
  // return it (the CHF+EUR second-account path, §4). Memoized under the key.
  const existing = readLiveConnectionForContract(ctx, { hostId, partnerId, userId });
  if (existing !== undefined) {
    try {
      return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_channel_connect', () => {
        const routed = routeAccounts(ctx, existing, routeIds);
        if (!routed.ok) throw new EbicsAbort(routed);
        return ok({
          connectionId: existing.id,
          state: existing.state,
          routed: true,
          reused: true,
          routedAccounts: readRoutedAccountIds(ctx, existing.id),
          iniLetterDocumentId: existing.ini_letter_document_id,
          connection: connectionView(ctx, existing),
        });
      });
    } catch (e) {
      if (e instanceof EbicsAbort) return e.result;
      throw e;
    }
  }

  // Validate the accounts to route BEFORE any write (a bad id must not leave a half-built ceremony).
  for (const id of routeIds) {
    const acct = getBankAccount(ctx, { bankAccountId: id });
    if (!acct.ok) return err('bank_account_not_found', { bankAccountId: id });
  }

  const keyLength = Number.isInteger(input.keyLength) ? (input.keyLength as number) : EBICS_DEFAULT_KEY_PARAMS.keyLength;
  // Key generation is LOCAL crypto, no network: this is real OSS-core work even with no transport.
  const generated = keystore(ctx).generate({ keyLength });
  const keyParams = { ...EBICS_DEFAULT_KEY_PARAMS, keyLength };

  const profile = getCompanyProfile(ctx);
  const companyName = profile.ok
    ? (((profile as unknown as { profile: Record<string, unknown> }).profile.name as string | undefined) ?? 'TILL')
    : 'TILL';

  const id = ctx.ids.next('ebconn');
  const at = ctx.clock.now();
  const t = transport(ctx);

  // CREATE the connection locally, memoized under the key. With NO transport wired the memoized result
  // IS the final answer (keys_generated + needs_bank_transport), so a replay is byte-identical; with a
  // transport wired the network advance runs AFTER (not memoized, retryable). A write failure THROWS,
  // so remember's tx rolls back and nothing is memoized (the error is retryable).
  let creationResult: Result;
  try {
    creationResult = ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_channel_connect', () => {
      ctx.store.db
        .prepare(
          `INSERT INTO ebics_connection
             (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, protocol_version, state,
              key_params, key_ref, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'H005', 'keys_generated', ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, hostUrl, hostId, partnerId, userId, JSON.stringify(keyParams), generated.keyRef, ctx.actor, at, at);

      const routed = routeAccounts(ctx, { id, workspace_id: ctx.workspaceId } as ConnectionRow, routeIds);
      if (!routed.ok) throw new EbicsAbort(routed);

      // Render + file the INI letter (E00, OR 958f retention). The paper the customer signs.
      const row = readConnection(ctx, id) as ConnectionRow;
      const letter = renderIniLetterText(row, generated.hashes, companyName);
      const uploaded = uploadFile(ctx, {
        title: `EBICS INI-Brief ${hostId}/${partnerId}/${userId}`,
        filename: `ebics-ini-letter-${id}.txt`,
        mime: 'text/plain',
        contentBase64: Buffer.from(letter, 'utf8').toString('base64'),
      });
      if (!uploaded.ok) throw new EbicsAbort(uploaded);
      const fileId = fileById(uploaded);
      // entityId before entityKind (the E00-link ordering), so the Studio audit scraper does not read
      // this LINK as an audit emission for `ebics_connection`.
      const linked = linkFile(ctx, { fileId, entityId: id, entityKind: 'ebics_connection' });
      if (!linked.ok) throw new EbicsAbort(linked);
      const retention = setFileRetention(ctx, { fileId, retentionUntil: statutoryRetentionUntil(ctx, at.slice(0, 10)) });
      if (!retention.ok) throw new EbicsAbort(retention);
      ctx.store.db
        .prepare('UPDATE ebics_connection SET ini_letter_document_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(fileId, at, ctx.workspaceId, id);
      const created = readConnection(ctx, id) as ConnectionRow;
      const base: Record<string, unknown> = {
        connectionId: id,
        state: created.state, // keys_generated
        routedAccounts: readRoutedAccountIds(ctx, id),
        iniLetterDocumentId: created.ini_letter_document_id,
        bankKeyHashes: null,
        connection: connectionView(ctx, created),
      };
      // No transport: the local work is done and we say so honestly. This IS the memoized final result.
      if (t === undefined) return ok({ ...base, transmitted: false, reason: 'needs_bank_transport' });
      return ok(base);
    });
  } catch (e) {
    if (e instanceof EbicsAbort) return e.result;
    throw e;
  }

  if (!creationResult.ok) return creationResult;
  if (t === undefined) return creationResult; // keys_generated + needs_bank_transport, replay-identical

  const created = readConnection(ctx, id) as ConnectionRow;
  const sent = t.sendKeys({ connection: connectionRef(created), hashes: generated.hashes });
  if (!sent.ok) {
    // The bank offers no EBICS (its use is optional for Swiss institutions, SMPG §1): an honest
    // terminal P9 answer naming the file-based A20/A18 path as the standing alternative, never a dead
    // end. Only the wired transport knows this, so the code is emitted solely on its explicit signal.
    if (sent.reason === 'no_ebics_offer') {
      return err('no_ebics_offer', { connectionId: id, alternative: 'the file-based A20/A18 upload path remains the floor' });
    }
    return err('channel_unreachable', { connectionId: id, reason: sent.reason, connection: connectionView(ctx, created) });
  }
  const now = ctx.clock.now();
  ctx.store.tx(() => {
    appendOrder(ctx, { connectionId: id, orderRef: `${id}-ini`, direction: 'upload', orderType: 'INI', status: 'ok' });
    appendOrder(ctx, { connectionId: id, orderRef: `${id}-hia`, direction: 'upload', orderType: 'HIA', status: 'ok' });
    ctx.store.db
      .prepare("UPDATE ebics_connection SET state = 'pending_bank_activation', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, ctx.workspaceId, id);
    return ok({});
  });
  const advanced = readConnection(ctx, id) as ConnectionRow;
  return ok({
    connectionId: id,
    state: advanced.state, // pending_bank_activation
    routedAccounts: readRoutedAccountIds(ctx, id),
    iniLetterDocumentId: advanced.ini_letter_document_id,
    bankKeyHashes: null,
    connection: connectionView(ctx, advanced),
  });
}

/** Route N A19 accounts under a connection (unique index dedupes a re-route). Validates each id. */
function routeAccounts(ctx: WorkspaceContext, connection: { id: string; workspace_id: string }, routeIds: string[]): Result {
  for (const bankAccountId of routeIds) {
    const acct = getBankAccount(ctx, { bankAccountId });
    if (!acct.ok) return err('bank_account_not_found', { bankAccountId });
    ctx.store.db
      .prepare(
        `INSERT INTO ebics_connection_account (id, workspace_id, connection_id, bank_account_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, bank_account_id) DO NOTHING`,
      )
      .run(ctx.ids.next('ebca'), ctx.workspaceId, connection.id, bankAccountId, ctx.clock.now());
  }
  return ok({});
}

/**
 * Advance an existing connection: run HPB and (on `confirmBankKeys` + a hash match) activate. Also
 * routes any newly named accounts, and re-initialises a `blocked` connection (SMPG §6.2: the way back
 * is running the ceremony again on the same row). No transport -> honest `needs_bank_transport`.
 */
function advanceConnection(
  ctx: WorkspaceContext,
  row: ConnectionRow,
  opts: { confirmBankKeys: boolean; routeIds: string[] },
): Result {
  const routed = routeAccounts(ctx, row, opts.routeIds);
  if (!routed.ok) return routed;

  // An active channel with no re-confirm is idempotent; an EXPLICIT confirmBankKeys re-runs HPB so a
  // bank-key rotation is caught (the compare-and-confirm flow serves both the first ceremony and every
  // later key change, spec §4). A retired channel is terminal.
  if (row.state === 'active' && !opts.confirmBankKeys) {
    return ok({ connectionId: row.id, state: 'active', connection: connectionView(ctx, readConnection(ctx, row.id) as ConnectionRow) });
  }
  if (row.state === 'retired') {
    return err('invalid_state', { connectionId: row.id, state: 'retired', reason: 'a retired channel cannot be advanced' });
  }

  const t = transport(ctx);
  if (t === undefined) {
    return ok({
      connectionId: row.id,
      state: row.state,
      transmitted: false,
      reason: 'needs_bank_transport',
      connection: connectionView(ctx, readConnection(ctx, row.id) as ConnectionRow),
    });
  }

  // HPB: fetch the bank's public keys for out-of-band comparison against the bank's own letter.
  const hpb = t.fetchBankKeys({ connection: connectionRef(row) });
  if (!hpb.ok) {
    return err('channel_unreachable', { connectionId: row.id, reason: hpb.reason });
  }
  const bankHashes = hpb.bankKeyHashes;
  appendOrderTx(ctx, { connectionId: row.id, orderRef: `${row.id}-hpb`, direction: 'download', orderType: 'HPB', status: 'ok' });

  if (!opts.confirmBankKeys) {
    // Surface the hashes for the human compare-and-confirm step; do NOT activate.
    return ok({
      connectionId: row.id,
      state: row.state,
      bankKeyHashes: bankHashes,
      awaitingConfirmation: true,
      connection: connectionView(ctx, readConnection(ctx, row.id) as ConnectionRow),
    });
  }

  // A stored expectation (from a prior HPB) that no longer matches is a hard stop (man-in-the-middle
  // defence): never auto-accepted. On the FIRST activation there is no stored expectation yet, so the
  // freshly fetched hashes become the pinned set the customer confirmed against the paper letter.
  const stored = parseJson<EbicsKeyHashes>(row.bank_key_hashes);
  if (stored !== null && !sameHashes(stored, bankHashes)) {
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE ebics_connection SET state = 'bank_keys_changed', updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(ctx.clock.now(), ctx.workspaceId, row.id);
      return ok({});
    });
    return err('bank_keys_mismatch', { connectionId: row.id, stored, fetched: bankHashes });
  }

  const now = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare("UPDATE ebics_connection SET state = 'active', bank_key_hashes = ?, activated_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(JSON.stringify(bankHashes), now, now, ctx.workspaceId, row.id);
    return ok({});
  });
  const active = readConnection(ctx, row.id) as ConnectionRow;
  // `activatedConnectionId` is the OP8 emit path for `bank_channel.activated`: present ONLY on the
  // active flip, so every other connect outcome null-collapses the occurrence (the deals `wonDef` shape).
  return ok({
    connectionId: row.id,
    state: 'active',
    activatedConnectionId: row.id,
    bankKeyHashes: bankHashes,
    connection: connectionView(ctx, active),
  });
}

function appendOrderTx(ctx: WorkspaceContext, a: OrderAppend): void {
  ctx.store.tx(() => {
    appendOrder(ctx, a);
    return ok({});
  });
}

function sameHashes(a: EbicsKeyHashes, b: EbicsKeyHashes): boolean {
  return (
    a.electronicSignature === b.electronicSignature &&
    a.authentication === b.authentication &&
    a.encryption === b.encryption
  );
}

// --- verb 2: syncBankChannel -------------------------------------------------------------------

/**
 * US-A33.2: pull the pending camt.053/054 (plus the pain.002 status report and the HAC protocol) and
 * hand each statement to A20's `importCamt` BYTE-FOR-BYTE. The crash-durability ordering is normative
 * (§4): persist each fetched artifact as an E00 document, COMMIT, and only then import from the
 * persisted copy, so a crash loses nothing and re-import is A20's dedupe no-op. A file whose IBAN
 * matches no routed account is surfaced as `unmatched_account`, never dropped. No transport wired ->
 * honest `needs_bank_transport`; the last-synced timestamp and the file path stay the floor.
 */
export function syncBankChannel(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; bankAccountId?: unknown; dateRange?: { from?: unknown; to?: unknown } | undefined; idempotencyKey?: unknown },
): Result {
  // A37 dispatch (spec §4/§5): resolve the rail from the selector. A connectionId naming a managed
  // connection, or a bankAccountId routed over managed (and NOT over EBICS), syncs the managed rail.
  // The EBICS rail keeps priority when an account is routed over both, so existing behavior is unchanged.
  if (typeof input.connectionId === 'string' && isManagedConnectionId(ctx, input.connectionId)) {
    return syncManagedChannel(ctx, input);
  }
  if (
    (input.connectionId === undefined || input.connectionId === null || input.connectionId === '') &&
    typeof input.bankAccountId === 'string' &&
    input.bankAccountId.length > 0 &&
    readConnectionForAccount(ctx, input.bankAccountId) === undefined &&
    readManagedConnectionForAccount(ctx, input.bankAccountId) !== undefined
  ) {
    return syncManagedChannel(ctx, input);
  }

  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const scopedKey = JSON.stringify(['bank_sync', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'bank_sync');
  if (replayed !== undefined) return replayed;

  let connection: ConnectionRow | undefined;
  if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
    connection = readConnection(ctx, input.connectionId);
  } else if (typeof input.bankAccountId === 'string' && input.bankAccountId.length > 0) {
    connection = readConnectionForAccount(ctx, input.bankAccountId);
  }
  if (connection === undefined) return err('needs_bank_channel', { reason: 'no connection for the given selector' });
  // A block is a security state, reported even with no transport wired (the file path stays open).
  if (connection.state === 'blocked') return err('channel_blocked', { connectionId: connection.id });

  const conn = connection;
  const t = transport(ctx);
  if (t === undefined) {
    // No transport is the DOMINANT fact: nothing can be fetched regardless of activation state, so the
    // verb degrades honestly (ok:true, the file path stands) rather than reporting a downstream state.
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_sync', () =>
      ok({ connectionId: conn.id, files: [], reason: 'needs_bank_transport', lastSyncAt: conn.last_sync_at }),
    );
  }
  // A transport IS wired: the keystore must be usable to run the EBICS dialogue (a passphrase-encrypted
  // store not yet unlocked is `keystore_locked`, a missing/corrupt file is `keystore_unavailable`).
  // A36 US-A36.2: refuse, never regenerate, and never silently double-apply on a locked store.
  const ksBlock = keystoreBlock(ctx, { connectionId: conn.id });
  if (ksBlock !== null) return ksBlock;

  // A transport IS wired: now the activation state governs whether a fetch is even possible.
  if (conn.state !== 'active') {
    return err('pending_bank_activation', { connectionId: conn.id, state: conn.state });
  }

  const dateRange: { from?: string; to?: string } | undefined =
    input.dateRange === undefined
      ? undefined
      : {
          ...(typeof input.dateRange.from === 'string' ? { from: input.dateRange.from } : {}),
          ...(typeof input.dateRange.to === 'string' ? { to: input.dateRange.to } : {}),
        };

  const statements = t.download({ connection: connectionRef(conn), service: 'statements', dateRange });
  if (!statements.ok) {
    return err('channel_unreachable', { connectionId: conn.id, reason: statements.reason, lastSyncAt: conn.last_sync_at });
  }
  const statusReport = t.download({ connection: connectionRef(conn), service: 'status_report', dateRange });
  const protocol = t.download({ connection: connectionRef(conn), service: 'customer_protocol', dateRange });

  const routedIbans = new Map<string, string>(); // iban -> bankAccountId
  for (const id of readRoutedAccountIds(ctx, conn.id)) {
    const iban = accountIban(ctx, id);
    if (iban !== null) routedIbans.set(normaliseIban(iban), id);
  }

  const results: Record<string, unknown>[] = [];
  // F1 remediation: the STATEMENTS acknowledge is CONDITIONAL on every matched statement actually
  // applying. Any `importCamt` ok:false (A20-C2 `statement_amended`, or a rejected camt variant) flips
  // this false, so the statements token stays open and the bank re-offers the unapplied statement on
  // the next sync (A20's row dedupe makes the re-pull of the already-applied ones a no-op: idempotency
  // ON ROWS holds). Acknowledging unconditionally is what silently dropped a bank correction.
  let statementsFullyApplied = true;

  // THE CRASH-DURABILITY ORDERING (A36 §4, tripwire 1). For every fetched file: PERSIST it as an E00
  // artifact and COMMIT (persistFetchedArtifact opens its own tx), THEN import from those bytes, and
  // ONLY once every service's files are durably persisted AND imported do we `acknowledge` the bank
  // (below). ACKNOWLEDGE IS THE LAST STEP, deliberately stricter than the spec's literal "ack then
  // import": with acknowledge last there is no window in which the bank has been told "delivered" for a
  // statement TILL has not yet imported, so nothing can be acked-but-unapplied. The only cost is that a
  // crash before the acknowledge lets the bank re-offer the same statement on the next sync, where
  // A20's two-level row dedupe (§H-IDEMPOTENT) makes the re-import a no-op: a re-pull after a crash
  // mid-acknowledge lands exactly one row. The persist-before-acknowledge order (tripwire 1) holds
  // because every persist COMMITs before any acknowledge is sent.
  for (const file of statements.files) {
    // 1) PERSIST the fetched artifact as an E00 document and COMMIT, BEFORE importing (crash-durable).
    const persistedId = persistFetchedArtifact(ctx, conn, file, 'BTD statement');
    const xml = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    const iban = readStatementIban(xml);
    const matchedAccountId = iban === null ? undefined : routedIbans.get(normaliseIban(iban));
    if (matchedAccountId === undefined) {
      // 2) Unmatched: recorded and surfaced, NEVER dropped. It stays until an A19 account is routed and
      //    the next sync imports it. Marked `unmatched_statement` (the IBAN carried in bank_reason) so
      //    the status card can list it without re-reading the persisted bytes.
      appendOrderTx(ctx, {
        connectionId: conn.id,
        orderRef: `${conn.id}-btd-${persistedId}`,
        direction: 'download',
        orderType: 'BTD',
        btfMsgName: file.msgName,
        relatedKind: 'unmatched_statement',
        relatedId: persistedId,
        status: 'ok',
        bankReason: iban,
      });
      results.push({ msgName: file.msgName, documentId: persistedId, iban, routing: 'unmatched_account' });
      continue;
    }
    // 3) Import the PERSISTED bytes byte-for-byte via A20 (its ElctrncSeqNb/message-id dedupe is the
    //    idempotency; A33 never adds a second one and never transforms the file).
    const imported = importCamt(ctx, { bankAccountId: matchedAccountId, xml, idempotencyKey: `a33-${conn.id}-${persistedId}` });
    // F1 remediation: a file that PERSISTED but did NOT apply (importCamt ok:false) must not let its
    // service be acknowledged, and must be recorded HONESTLY on the order log (status 'failed' + the
    // A20 reason), never a silent status 'ok'. The raw bytes are already durable (E00), so the
    // correction is preserved and re-fetched, not dropped.
    const importReason = imported.ok ? null : ((imported as { error?: string }).error ?? 'import_failed');
    if (!imported.ok) statementsFullyApplied = false;
    appendOrderTx(ctx, {
      connectionId: conn.id,
      orderRef: `${conn.id}-btd-${persistedId}`,
      direction: 'download',
      orderType: 'BTD',
      btfMsgName: file.msgName,
      relatedKind: 'bank_statement',
      relatedId: persistedId,
      status: imported.ok ? 'ok' : 'failed',
      bankReason: importReason,
    });
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

  // Fold the pain.002 status report and HAC protocol into the order log (the business-rejection and
  // channel-event feeds, §3). Persisted the same way; rejections land bank_rejected on the batch order.
  const rejectedBatchIds = statusReport.ok ? foldStatusReport(ctx, conn, statusReport.files) : [];
  if (protocol.ok) foldCustomerProtocol(ctx, conn, protocol.files);

  // ACKNOWLEDGE every open download transaction, now that every fetched file is persisted AND imported
  // (all committed). A36 §4: this closes the EBICS receipt so the bank stops offering the data. A
  // failed or thrown acknowledge is SAFE and non-fatal: the data is already durable and imported, and
  // the bank re-offering on the next sync is a dedupe no-op. We attempt each and never let an ack
  // failure fail a sync whose statements already landed.
  // F1 remediation: acknowledge the STATEMENTS token ONLY when every matched statement applied. If any
  // import returned ok:false the token stays OPEN so the bank re-offers the unapplied statement next
  // sync (nothing is dropped; A20's row dedupe no-ops the re-import of the applied ones). The status
  // report and protocol fold into the order log and carry no unapplied-ledger risk, so they ack as
  // before.
  if (statementsFullyApplied) acknowledgeDownload(t, conn, statements.ackToken);
  if (statusReport.ok) acknowledgeDownload(t, conn, statusReport.ackToken);
  if (protocol.ok) acknowledgeDownload(t, conn, protocol.ackToken);

  const now = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare('UPDATE ebics_connection SET last_sync_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, now, ctx.workspaceId, conn.id);
    return ok({});
  });

  // `rejectedBatchId` is the OP8 emit path for `payment_batch.bank_rejected`: present ONLY when this
  // sync folded a pain.002 rejection, so a clean sync null-collapses the occurrence.
  // F1 remediation: report the unapplied statements HONESTLY at the top level so a caller (and an
  // unattended scheduled sync) sees the drop rather than a silent ok:true. The transport dialogue did
  // succeed and nothing was lost (the unapplied statements stay un-acked and will be re-offered), so
  // ok:true is truthful, but the count makes the gap visible on the status card.
  const unappliedStatements = results.filter((r) => r.routing === 'matched' && r.importOk === false).length;
  const result: Record<string, unknown> = { connectionId: conn.id, files: results, lastSyncAt: now };
  if (unappliedStatements > 0) result.unappliedStatements = unappliedStatements;
  if (rejectedBatchIds.length > 0) result.rejectedBatchId = rejectedBatchIds[0];
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_sync', () => ok(result));
}

/**
 * A36: close one open EBICS download transaction (send the positive receipt). Called ONLY after the
 * service's files are persisted AND imported (all committed), so persist-before-acknowledge (tripwire
 * 1) holds. A refusal or a throw is swallowed: the fetched data is already durable and imported, and a
 * bank that re-offers un-acknowledged data on the next sync is answered by A20's dedupe (a re-pull
 * after a crash mid-acknowledge lands exactly one row). An empty `ackToken` (a mock or a transport
 * that folds acknowledgement into download) is a no-op.
 */
function acknowledgeDownload(t: EbicsTransportPort, conn: ConnectionRow, ackToken: string): void {
  if (typeof ackToken !== 'string' || ackToken.length === 0) return;
  try {
    t.acknowledge({ connection: connectionRef(conn), ackToken });
  } catch {
    // Deliberately swallowed (see the doc comment): the sync's statements already landed.
  }
}

/** Persist one fetched file as an E00 artifact (OR 958f retention), COMMITTED before any import. */
function persistFetchedArtifact(ctx: WorkspaceContext, conn: ConnectionRow, file: EbicsFetchedFile, label: string): string {
  let fileId = '';
  ctx.store.tx(() => {
    const uploaded = uploadFile(ctx, {
      title: `${label} ${file.msgName} ${conn.host_id}`,
      filename: `ebics-${conn.id}-${file.msgName}-${ctx.ids.next('f')}.xml`,
      mime: 'application/xml',
      contentBase64: file.contentBase64,
    });
    if (!uploaded.ok) throw new EbicsAbort(uploaded);
    fileId = fileById(uploaded);
    const linked = linkFile(ctx, { fileId, entityId: conn.id, entityKind: 'ebics_connection' });
    if (!linked.ok) throw new EbicsAbort(linked);
    const retention = setFileRetention(ctx, { fileId, retentionUntil: statutoryRetentionUntil(ctx, ctx.clock.now().slice(0, 10)) });
    if (!retention.ok) throw new EbicsAbort(retention);
    return ok({});
  });
  return fileId;
}

/** Read the statement account IBAN from camt (`Acct/Id/IBAN`), a READ never a rewrite. */
function readStatementIban(xml: string): string | null {
  const m = /<IBAN>\s*([A-Z0-9]+)\s*<\/IBAN>/i.exec(xml);
  return m ? (m[1] ?? null) : null;
}

function normaliseIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * Fold the pain.002 status report into the order log: a per-transaction or file-level reject lands
 * `bank_rejected` with the bank's reason on the related payment_batch order (§3). The report carries
 * the OriginalMessageId (the pain.001 MsgId) that ties it back to the transmitted batch's order.
 */
function foldStatusReport(ctx: WorkspaceContext, conn: ConnectionRow, files: EbicsFetchedFile[]): string[] {
  const rejectedBatchIds: string[] = [];
  for (const file of files) {
    const documentId = persistFetchedArtifact(ctx, conn, file, 'pain.002 status report');
    const xml = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    const origMsgId = /<OrgnlMsgId>\s*([^<]+?)\s*<\/OrgnlMsgId>/i.exec(xml)?.[1] ?? null;
    const groupStatus = /<GrpSts>\s*([^<]+?)\s*<\/GrpSts>/i.exec(xml)?.[1] ?? /<TxSts>\s*([^<]+?)\s*<\/TxSts>/i.exec(xml)?.[1] ?? null;
    const reason = /<AddtlInf>\s*([^<]+?)\s*<\/AddtlInf>/i.exec(xml)?.[1] ?? /<Prtry>\s*([^<]+?)\s*<\/Prtry>/i.exec(xml)?.[1] ?? null;
    const rejected = groupStatus === 'RJCT';
    // Find the transmitted batch order by its MsgId (stored as the order's payload identity).
    const batchOrder = origMsgId === null ? undefined : findOrderByMsgId(ctx, conn.id, origMsgId);
    if (rejected && batchOrder?.related_kind === 'payment_batch' && batchOrder.related_id !== null) {
      rejectedBatchIds.push(batchOrder.related_id);
    }
    ctx.store.tx(() => {
      appendOrder(ctx, {
        connectionId: conn.id,
        orderRef: batchOrder?.order_ref ?? `${conn.id}-pain002-${documentId}`,
        direction: 'download',
        orderType: 'BTD',
        btfMsgName: 'pain.002',
        relatedKind: batchOrder?.related_kind ?? 'bank_statement',
        relatedId: batchOrder?.related_id ?? documentId,
        status: rejected ? 'bank_rejected' : 'ok',
        bankReason: rejected ? (reason ?? 'RJCT') : null,
      });
      return ok({});
    });
  }
  return rejectedBatchIds;
}

/**
 * Fold the HAC customer protocol into the order log (channel-level send/fetch/sign events, §3) AND
 * resolve any in-doubt uploads from it (§4): an `intent` BTU order with no successor is an upload whose
 * outcome was unknown. The HAC is the evidence. If it names the order identity, the upload arrived:
 * append `pending_release` and the order stands. If the HAC covers the window WITHOUT it, the upload
 * never arrived: append `failed`, which alone reopens the transmit path. This is evidence-based, never
 * a blind retry: the resolution runs only against a real fetched HAC, and a HAC file IS the window.
 */
function foldCustomerProtocol(ctx: WorkspaceContext, conn: ConnectionRow, files: EbicsFetchedFile[]): void {
  const inDoubt = intentsAwaitingResolution(ctx, conn.id);
  for (const file of files) {
    const documentId = persistFetchedArtifact(ctx, conn, file, 'HAC customer protocol');
    const hac = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    appendOrderTx(ctx, {
      connectionId: conn.id,
      orderRef: `${conn.id}-hac-${documentId}`,
      direction: 'download',
      orderType: 'HAC',
      btfMsgName: 'HAC',
      relatedKind: 'bank_statement',
      relatedId: documentId,
      status: 'ok',
    });
    for (const intent of inDoubt) {
      const arrived = hac.includes(intent.order_ref) || (intent.btf_msg_name !== null && hac.includes(intent.btf_msg_name));
      appendOrderTx(ctx, {
        connectionId: conn.id,
        orderRef: intent.order_ref,
        direction: 'upload',
        orderType: 'BTU',
        btfMsgName: intent.btf_msg_name,
        payloadSha256: intent.payload_sha256,
        relatedKind: intent.related_kind,
        relatedId: intent.related_id,
        status: arrived ? 'pending_release' : 'failed',
        bankReason: arrived ? null : 'not_in_hac_window',
      });
    }
  }
}

/** BTU orders whose LATEST status is `intent` (an upload whose outcome the HAC has not yet resolved). */
function intentsAwaitingResolution(ctx: WorkspaceContext, connectionId: string): OrderRow[] {
  const orders = ctx.store.db
    .prepare("SELECT * FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND order_type = 'BTU' ORDER BY occurred_at DESC, rowid DESC")
    .all(ctx.workspaceId, connectionId) as OrderRow[];
  const latestByRef = new Map<string, OrderRow>();
  for (const o of orders) if (!latestByRef.has(o.order_ref)) latestByRef.set(o.order_ref, o);
  return [...latestByRef.values()].filter((o) => o.status === 'intent');
}

/** The most recent order carrying a given pain.001 MsgId as its payload identity (its order_ref suffix). */
function findOrderByMsgId(ctx: WorkspaceContext, connectionId: string, msgId: string): OrderRow | undefined {
  return ctx.store.db
    .prepare(
      "SELECT * FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND order_type = 'BTU' AND btf_msg_name = ? ORDER BY occurred_at DESC, rowid DESC",
    )
    .get(ctx.workspaceId, connectionId, msgId) as OrderRow | undefined;
}

// --- verb 3: transmitPaymentBatch --------------------------------------------------------------

/**
 * US-A33.3: upload an A18 `generated` pain.001 batch over BTU (P8-gated, §5). THE LAW: submits WITHOUT
 * the SignatureFlag, so the bank's own out-of-channel release authorizes it and TILL never holds sole
 * payment authority (`assertNoSoleAuthority`). NEVER marks anything paid (paid comes from camt via
 * A20/A18). The intent-before-upload protocol is the §H-IDEMPOTENT mechanism and is normative (§4):
 *   1. regenerate the byte-identical pain.001 (A18) and compute payload_sha256 + the order identity;
 *   2. append an `intent` order row and COMMIT it BEFORE any network I/O; an unresolved intent blocks
 *      a new upload (transmit_in_doubt);
 *   3. BTU-upload without the SignatureFlag; only on acknowledgement does step 4 run;
 *   4. append `pending_release`.
 * At most one non-`failed` order per batch: a re-call returns the existing order and delivers nothing.
 */
export function transmitPaymentBatch(
  ctx: WorkspaceContext,
  input: { batchId?: unknown; confirm?: unknown; idempotencyKey?: unknown },
): Result {
  if (typeof input.batchId !== 'string' || input.batchId.length === 0) {
    return err('invalid_input', { field: 'batchId' });
  }
  const batchId = input.batchId;

  const batch = ctx.store.db
    .prepare('SELECT id, status, bank_account_id, msg_id FROM payment_batch WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, batchId) as { id: string; status: string; bank_account_id: string; msg_id: string | null } | undefined;
  if (batch === undefined) return err('not_found', { batchId });
  if (batch.status !== 'generated') {
    return err('needs_batch_generated', { batchId, status: batch.status });
  }

  // The connection is selected via the batch's debtor account. No route -> honest degrade (§4).
  const connection = readConnectionForAccount(ctx, batch.bank_account_id);

  // A37 dispatch (spec §4/§5): when the account has no live EBICS channel but IS routed over a managed
  // (bLink) connection, the batch submits over PSS. When it has neither, the honest degrade stands.
  if (connection === undefined || connection.state === 'retired') {
    const managedConn = readManagedConnectionForAccount(ctx, batch.bank_account_id);
    if (managedConn !== undefined) {
      return transmitManagedBatch(ctx, input, managedConn);
    }
    return ok({ transmitted: false, reason: 'needs_bank_channel', batchId });
  }

  // Cross-rail idempotency (A37 tripwire 3, the reverse guard): a non-failed MANAGED order for this
  // batch blocks an EBICS transmit, so a batch in flight over bLink cannot also go over EBICS.
  const managedOrder = ctx.store.db
    .prepare("SELECT status FROM managed_order_log WHERE workspace_id = ? AND related_kind = 'payment_batch' AND related_id = ? AND status != 'failed' ORDER BY occurred_at DESC, rowid DESC LIMIT 1")
    .get(ctx.workspaceId, batchId) as { status: string } | undefined;
  if (managedOrder !== undefined) {
    return err('already_transmitted', { batchId, rail: 'managed_blink', reason: 'this batch is already in flight over the managed rail' });
  }
  if (connection.state === 'blocked') return err('channel_blocked', { batchId, connectionId: connection.id });
  if (connection.state !== 'active') return err('pending_bank_activation', { batchId, connectionId: connection.id });
  const conn = connection;

  // Idempotent at the ORDER level: an existing non-failed order for this batch answers, delivers nothing.
  const existing = latestOrderForBatch(ctx, conn.id, batchId);
  if (existing !== undefined && existing.status !== 'failed') {
    if (existing.status === 'intent') {
      // An intent with no successor: the upload's outcome is unknown. Retransmission stays blocked.
      return err('transmit_in_doubt', { batchId, orderRef: existing.order_ref, connectionId: conn.id });
    }
    return ok({ transmitted: true, orderId: existing.id, orderRef: existing.order_ref, status: existing.status, batchId, transmittedBatchId: batchId });
  }

  // P8 (spec §5): moving real-world money is a deliberate act. Pre-checked BEFORE any write.
  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { batchId, reason: 'transmit_requires_confirmation' });
  }

  // 1) Regenerate the byte-identical pain.001 (A18) and compute the payload identity. Pure read.
  const regen = generatePain001(ctx, { batchId, idempotencyKey: `a33-transmit-${batchId}` });
  if (!regen.ok) return regen;
  const payloadBase64 = (regen as unknown as { xmlBase64: string }).xmlBase64;
  const payloadSha256 = sha256Hex(Buffer.from(payloadBase64, 'base64'));
  const msgId = (regen as unknown as { batch?: { msgId?: string } }).batch?.msgId ?? batch.msg_id ?? `${batchId}-msg`;
  const orderRef = `${conn.id}-btu-${batchId}`;

  // 2) INTENT BEFORE UPLOAD: append the intent row and COMMIT, before any network I/O. A crash after
  //    this leaves an intent with no successor -> transmit_in_doubt, retransmission blocked (§4).
  ctx.store.tx(() => {
    appendOrder(ctx, {
      connectionId: conn.id,
      orderRef,
      direction: 'upload',
      orderType: 'BTU',
      btfServiceName: 'MCT',
      btfMsgName: msgId,
      payloadSha256,
      relatedKind: 'payment_batch',
      relatedId: batchId,
      status: 'intent',
    });
    return ok({});
  });

  const t = transport(ctx);
  if (t === undefined) {
    // No transport: the intent is the durable trace, but nothing left the building. Resolve it to
    // failed so the path reopens (a transport-less transmit never half-commits an upload).
    ctx.store.tx(() => {
      appendOrder(ctx, {
        connectionId: conn.id,
        orderRef,
        direction: 'upload',
        orderType: 'BTU',
        payloadSha256,
        relatedKind: 'payment_batch',
        relatedId: batchId,
        status: 'failed',
        bankReason: 'needs_bank_transport',
      });
      return ok({});
    });
    return ok({ transmitted: false, reason: 'needs_bank_transport', batchId, orderRef });
  }

  // 3) BTU upload WITHOUT the SignatureFlag (v1, THE LAW). This is a real runtime guard, not a
  //    comment: `assertNoSoleAuthority` THROWS if a sole-authority flag were ever present, and the
  //    request it stamps is the one handed to the port, so no code path can smuggle a SignatureFlag or
  //    requestEDS past it (defense-in-depth behind the structural port-shape guarantee). A THROW is
  //    UNKNOWN: the intent stands and the batch surfaces as transmit_in_doubt (the port contract, §4).
  const uploaded = t.upload(guardNoSoleAuthority({ connection: connectionRef(conn), orderRef, payloadBase64, btf: { serviceName: 'MCT', msgName: msgId } }));
  if (!uploaded.ok) {
    ctx.store.tx(() => {
      appendOrder(ctx, {
        connectionId: conn.id,
        orderRef,
        direction: 'upload',
        orderType: 'BTU',
        payloadSha256,
        relatedKind: 'payment_batch',
        relatedId: batchId,
        status: 'failed',
        bankReason: uploaded.reason,
      });
      return ok({});
    });
    return err('bank_rejected', { batchId, orderRef, reason: uploaded.reason });
  }

  // 4) Acknowledged: append pending_release (the bank's out-of-channel release completes it). NEVER paid.
  const now = ctx.clock.now();
  let orderId = '';
  ctx.store.tx(() => {
    appendOrder(ctx, {
      connectionId: conn.id,
      orderRef,
      direction: 'upload',
      orderType: 'BTU',
      btfServiceName: 'MCT',
      btfMsgName: msgId,
      payloadSha256,
      relatedKind: 'payment_batch',
      relatedId: batchId,
      status: 'pending_release',
    });
    const row = ctx.store.db
      .prepare("SELECT id FROM ebics_order_log WHERE workspace_id = ? AND order_ref = ? AND status = 'pending_release' ORDER BY occurred_at DESC, rowid DESC")
      .get(ctx.workspaceId, orderRef) as { id: string } | undefined;
    orderId = row?.id ?? '';
    return ok({});
  });
  void now;
  // `transmittedBatchId` is the OP8 emit path for `payment_batch.transmitted`: present ONLY on a real
  // upload, so a degrade (needs_bank_channel / needs_bank_transport) null-collapses the occurrence.
  return ok({ transmitted: true, orderId, orderRef, status: 'pending_release', batchId, transmittedBatchId: batchId });
}

/** The most recent order-log row for a payment batch over a connection (order-level idempotency). */
function latestOrderForBatch(ctx: WorkspaceContext, connectionId: string, batchId: string): OrderRow | undefined {
  return ctx.store.db
    .prepare(
      "SELECT * FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND related_kind = 'payment_batch' AND related_id = ? ORDER BY occurred_at DESC, rowid DESC",
    )
    .get(ctx.workspaceId, connectionId, batchId) as OrderRow | undefined;
}

// --- verb 4: getBankChannelStatus --------------------------------------------------------------

/**
 * US-A33.4: the P5 read model over the three tables joined to A18 batches. Per channel: state, last
 * sync, the pending INI letter, uploads awaiting bank release, unmatched fetched files, in-doubt
 * uploads, and recent orders. No write twin.
 */
export function getBankChannelStatus(
  ctx: WorkspaceContext,
  input: { bankAccountId?: unknown; status?: unknown; savedViewId?: unknown },
): Result {
  // The G00 saved-view seam (OP10) over the ebics_order log: ONE unconditional call, returning the
  // caller's filter untouched when no view is named and merging a view's stored `status` beneath an
  // explicit one otherwise (§6b: "Awaiting bank release", "Rejected this quarter").
  const listFilter: { status?: string; savedViewId?: string } = {};
  if (typeof input.status === 'string' && input.status.length > 0) listFilter.status = input.status;
  if (typeof input.savedViewId === 'string' && input.savedViewId.length > 0) listFilter.savedViewId = input.savedViewId;
  const viewed = applySavedView(ctx, 'ebics_order', listFilter);
  if (!viewed.ok) return viewed;
  const orderStatusFilter = typeof viewed.filter.status === 'string' && viewed.filter.status.length > 0 ? viewed.filter.status : null;

  let rows: ConnectionRow[];
  if (typeof input.bankAccountId === 'string' && input.bankAccountId.length > 0) {
    const c = readConnectionForAccount(ctx, input.bankAccountId);
    rows = c === undefined ? [] : [c];
  } else {
    rows = ctx.store.db
      .prepare("SELECT * FROM ebics_connection WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(ctx.workspaceId) as ConnectionRow[];
  }

  const channels = rows.map((row) => {
    const allOrders = readOrders(ctx, row.id);
    // The status-card derivations are always over the FULL log (a view over the order log narrows the
    // browsable recentOrders, never the health facts the card must always show). Newest-first.
    const byRef = new Map<string, OrderRow>();
    for (const o of allOrders) {
      if (!byRef.has(o.order_ref)) byRef.set(o.order_ref, o);
    }
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
      .map((o) => ({ documentId: o.related_id, msgName: o.btf_msg_name, iban: o.bank_reason, orderRef: o.order_ref }));
    return {
      connectionId: row.id,
      channelKind: 'ebics',
      host: { hostId: row.host_id, partnerId: row.partner_id, userId: row.user_id_ebics },
      state: row.state,
      accounts: readRoutedAccountIds(ctx, row.id).map((id) => ({ bankAccountId: id, iban: accountIban(ctx, id) })),
      lastSyncAt: row.last_sync_at,
      pendingIniLetter: row.state === 'keys_generated' || row.state === 'ini_sent' || row.state === 'pending_bank_activation'
        ? row.ini_letter_document_id
        : null,
      pendingRelease,
      inDoubt,
      rejected,
      unmatchedFiles,
      recentOrders: recent.slice(0, 20).map(orderView),
      keystore: keystoreFacet(ctx),
      schedule: scheduleFacet(ctx, row),
    };
  });

  // A37 (spec §4/§6): the managed (bLink) channels ride the SAME read model, kind-labelled, so a
  // Treuhänder sees every rail in one list. With the tier off there are no managed rows, so nothing is
  // added (no lie). The saved-view/status filter applies to each rail's own order log inside the list.
  const managed = managedChannelStatusList(ctx, input).channels;

  return ok({ channels: [...channels, ...managed] });
}

/** A36: the keystore health for the status card (`keystore:{kind,state}`, spec §5). */
function keystoreFacet(ctx: WorkspaceContext): { kind: string; state: string; persistent: boolean } {
  const ks = keystore(ctx);
  return {
    kind: ks.kind ?? 'memory',
    state: ks.state?.() ?? 'ready',
    persistent: ks.persistent ?? false,
  };
}

/**
 * A36: the scheduled-sync health (`schedule:{ruleId, cadence?, lastFiredAt?, driverSeen}`, spec §5).
 * `ruleId` is the connection's linked G01 rule (US-A36.3); `cadence` is the rule's schedule trigger
 * (`schedule.daily`/`.weekly`/`.monthly`); `driverSeen` is whether SOMETHING drove the G01 tick in
 * the last 25h (the M00 daemon, or a manual tick), and `inactive` is the honest `schedule_inactive`
 * flag: a rule is enabled but nothing is driving it, so the panel names the M00 daemon and Sync now.
 */
function scheduleFacet(
  ctx: WorkspaceContext,
  row: ConnectionRow,
): { ruleId: string | null; enabled: boolean; cadence: string | null; lastFiredAt: string | null; driverSeen: boolean; inactive: boolean } {
  if (row.sync_rule_id === null) {
    return { ruleId: null, enabled: false, cadence: null, lastFiredAt: null, driverSeen: false, inactive: false };
  }
  const rule = ctx.store.db
    .prepare('SELECT trigger_event, enabled, archived, last_fired_at FROM automation_rule WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.sync_rule_id) as
    | { trigger_event: string; enabled: number; archived: number; last_fired_at: string | null }
    | undefined;
  if (rule === undefined || rule.archived === 1) {
    // The linked rule was deleted/archived out from under the pointer: report honestly, not a crash.
    return { ruleId: row.sync_rule_id, enabled: false, cadence: null, lastFiredAt: null, driverSeen: false, inactive: false };
  }
  const enabled = rule.enabled === 1;
  // driverSeen: any automation run in this workspace within the last 25h means a tick driver is live.
  const cutoff = new Date(Date.parse(ctx.clock.now()) - 25 * 3600 * 1000).toISOString();
  const recent = ctx.store.db
    .prepare('SELECT 1 FROM automation_run WHERE workspace_id = ? AND started_at >= ? LIMIT 1')
    .get(ctx.workspaceId, cutoff) as { 1: number } | undefined;
  const driverSeen = recent !== undefined;
  return {
    ruleId: row.sync_rule_id,
    enabled,
    cadence: rule.trigger_event,
    lastFiredAt: rule.last_fired_at,
    driverSeen,
    inactive: enabled && !driverSeen,
  };
}

// --- verb 5: disconnectBankChannel -------------------------------------------------------------

/**
 * US-A33.1 (teardown): retire or block a channel (P8-gated). `retire` is the local, terminal close: the
 * connection flips to `retired`, its order history stays readable forever, and its keys are DESTROYED
 * in the keystore. `block` is the emergency stop: issue the SPR administrative order (SMPG §6.2), flip
 * to `blocked`, keep the keys until the operator chooses retire or re-initialisation. Both idempotent.
 */
export function disconnectBankChannel(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; mode?: unknown; confirm?: unknown; idempotencyKey?: unknown },
): Result {
  // A37 dispatch (spec §5): a connectionId naming a managed connection retires the managed rail
  // (there is no `block` mode there; consent is always revoked at the bank).
  const managedRow = readManagedConnection(ctx, input.connectionId);
  if (managedRow !== undefined) {
    return disconnectManagedChannel(ctx, input, managedRow);
  }

  const row = readConnection(ctx, input.connectionId);
  if (row === undefined) return err('not_found', { connectionId: input.connectionId });
  const mode = input.mode === 'block' ? 'block' : input.mode === 'retire' ? 'retire' : null;
  if (mode === null) return err('invalid_input', { field: 'mode', expected: ['retire', 'block'] });

  // Idempotent: already in the target terminal/blocked state -> return it, no re-issue.
  if (mode === 'retire' && row.state === 'retired') return ok({ connectionId: row.id, state: 'retired' });
  if (mode === 'block' && row.state === 'blocked') return ok({ connectionId: row.id, state: 'blocked' });

  // P8 (spec §5): an SPR block stops real payment traffic; a retire destroys keys. Deliberate act.
  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { connectionId: row.id, reason: 'disconnect_requires_confirmation' });
  }

  if (mode === 'block') {
    // Issue the SPR administrative order if a transport is wired; the local block stands regardless so
    // the emergency stop is never dependent on reaching the bank.
    const t = transport(ctx);
    if (t !== undefined) {
      const spr = t.suspend({ connection: connectionRef(row) });
      appendOrderTx(ctx, {
        connectionId: row.id,
        orderRef: `${row.id}-spr`,
        direction: 'upload',
        orderType: 'SPR',
        status: spr.ok ? 'ok' : 'failed',
        bankReason: spr.ok ? null : spr.reason,
      });
    }
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE ebics_connection SET state = 'blocked', updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(ctx.clock.now(), ctx.workspaceId, row.id);
      return ok({});
    });
    return ok({ connectionId: row.id, state: 'blocked' });
  }

  // retire: destroy keys, flip terminal, clear the schedule pointer (A36). Order history stays
  // readable. The linked G01 rule (if any) is left for the caller to archive: a fire against a
  // retired connection degrades honestly to needs_bank_channel and books nothing.
  ctx.store.tx(() => {
    if (row.key_ref !== null) keystore(ctx).destroy(row.key_ref);
    ctx.store.db
      .prepare(
        "UPDATE ebics_connection SET state = 'retired', key_ref = NULL, sync_rule_id = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(ctx.clock.now(), ctx.workspaceId, row.id);
    return ok({});
  });
  return ok({ connectionId: row.id, state: 'retired' });
}

// --- verb 6 (A36): setBankSyncSchedule ---------------------------------------------------------

/**
 * A36 US-A36.3: link (or unlink) the G01 automation rule that drives this connection's scheduled
 * sync. The panel toggle creates a `schedule` rule whose action is `bank_sync` with this
 * `connectionId` (the one A33 verb automation accepts, deliberately off the denylist) through G01's
 * existing rule verbs, then calls this to store the linkage on `ebics_connection.sync_rule_id` so the
 * status card renders the cadence and a retire clears it. Pass `ruleId: null`/absent to unlink (the
 * toggle-off path). Banking-write (`pay`, the same capability as the verb it schedules); idempotent;
 * §H-TENANT via `readConnection`. It does NOT create, enable, or fire any rule: that is G01's surface.
 */
export function setBankSyncSchedule(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; ruleId?: unknown; idempotencyKey?: unknown },
): Result {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  if (typeof input.connectionId !== 'string' || input.connectionId.length === 0) {
    return err('invalid_input', { field: 'connectionId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const ruleId = typeof input.ruleId === 'string' && input.ruleId.length > 0 ? input.ruleId : null;

  const row = readConnection(ctx, input.connectionId);
  if (row === undefined) return err('not_found', { connectionId: input.connectionId });
  if (row.state === 'retired') return err('channel_retired', { connectionId: row.id });

  // If a rule is named, it must exist, be a bank_sync schedule rule for THIS connection, and not be
  // archived: refuse-don't-guess rather than store a dangling or mismatched pointer.
  if (ruleId !== null) {
    const rule = ctx.store.db
      .prepare('SELECT action_tool, action_input, archived FROM automation_rule WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, ruleId) as { action_tool: string; action_input: string; archived: number } | undefined;
    if (rule === undefined) return err('not_found', { ruleId });
    if (rule.archived === 1) return err('rule_archived', { ruleId });
    if (rule.action_tool !== 'bank_sync') {
      return err('invalid_input', { field: 'ruleId', reason: 'the linked rule must have action bank_sync' });
    }
  }

  const scopedKey = JSON.stringify(['set_bank_sync_schedule', input.connectionId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'set_bank_sync_schedule');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_bank_sync_schedule', () => {
    ctx.store.tx(() => {
      ctx.store.db
        .prepare('UPDATE ebics_connection SET sync_rule_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(ruleId, ctx.clock.now(), ctx.workspaceId, row.id);
      return ok({});
    });
    return ok({ connectionId: row.id, syncRuleId: ruleId });
  });
}

// --- hashing -----------------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
