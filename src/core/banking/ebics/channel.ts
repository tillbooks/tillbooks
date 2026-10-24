/**
 * A33 + A36, the EBICS bank channel: the local, user-owned EBICS 3.0 (H005) client, DOWNLOAD ONLY
 * (spec `docs/specs/specs/A36-live-bank-feed.md`, owner decisions D139, D140). It fetches the day-end
 * camt.053 statements over the owner's own Datalink contract into the one statement door, A20's
 * `importCamt`, and does nothing else: no upload of any kind (D-A36.11), no bank-side block (D-A36.12),
 * no unattended run (D-A36.10). Payments stay manual: TILL writes pain.001, the owner uploads and
 * releases it in eBanking.
 *
 * WHAT THIS MODULE OWNS, and the rule each part keeps:
 *  - THE CEREMONY (§4.2): HEV before any key exists (H005 or `unsupported_ebics_version`, never an
 *    H004 fallback); three RSA 2048 pairs with self-signed X.509 certificates, the A005 private key
 *    dropped before the first keystore write (OD-2); INI and HIA as SEPARATE legs, each confirmed only
 *    by 000000; 091002 read against the OTHER leg (`pending_bank_activation` when it was confirmed,
 *    `init_refused` when neither was); 091201 to 091219 `certificate_refused`; the bank keys pinned
 *    only from a set a human reviewed that equals a fresh HPB; a changed bank key halts the feed.
 *  - ONE SYNC (§4.3): persist, then process, then receipt. The container and every new member are
 *    committed as E00 files with an order-log row each BEFORE anything is imported; every member
 *    without a FINAL outcome is re-run from its persisted bytes at each sync, in position order; the
 *    positive receipt goes out only after that, and a failed commit gets a negative one. Only
 *    `imported`, `already_imported` and `overlap_refused` are final (D-A36.5).
 *  - THE PORT DUTIES (wire A36-7, W2 and W11): the reviewed pin on every call after activation, the
 *    receipt included; a download whose TransactionID the order log already holds is
 *    `untrusted_response`, nothing persisted and no receipt; the receipt carries the TransactionID and
 *    an explicit code (0 after a durable commit, 1 after a failed one), never a processing outcome.
 *
 * A36 POSTS NOTHING (P3 by delegation). Statements enter the books ONLY through `importCamt`, handed the
 * persisted bytes byte-for-byte; the successor rule (`feed.ts`) runs inside it, at every door. The
 * channel tables are metadata and an append-only order log, never a ledger table.
 *
 * OFFLINE BY CONSTRUCTION. The core NEVER opens a socket: every network step goes through the
 * `EbicsTransportPort` seam (context.ts). With no transport wired the verbs degrade honestly
 * (`needs_bank_transport`) and the hand import stays the visible floor.
 *
 * STATE WRITES NAME THEIR SOURCE STATES (§4.2): every `UPDATE ... SET state` carries the states it may
 * leave, so `bank_keys_changed` never overwrites `blocked` or `retired`, and a local `blocked` returns
 * to `active` only through the reviewed confirm. A transport or protocol failure changes no state.
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
  EbicsKeyPurpose,
  EbicsKeyLeg,
  EbicsReturnCodes,
  EbicsTransportFailure,
  EbicsFetchedFile,
} from '../../context.js';
import { createHash, randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { ok, err } from '../../result.js';
import type { Err, Result } from '../../result.js';
import { importCamt } from '../camtReconcile.js';
import { parseCamt } from '../camt.js';
import type { ParsedCamtStatement } from '../camt.js';
import { getBankAccount } from '../bankAccounts.js';
import { uploadFile, linkFile, setFileRetention, getFileContent } from '../../files/index.js';
import { statutoryRetentionUntil } from '../../files/retention.js';
import { getCompanyProfile } from '../../setup/companyProfile.js';
import { applySavedView } from '../../customization/views.js';
import { defaultEbicsKeystore } from './keystore.js';
import { autoSyncActor, autoSyncSettings, autoSyncStatus, isAutoSyncMode, isAutoSyncTime, AUTO_SYNC_MODES } from './autoSync.js';
import {
  ACTIVATION_CHECK_RELATED_KIND,
  activationCheckDecision,
  activationStatus,
  recordActivationCheck,
} from './activationCheck.js';
import type { ActivationCheckOutcome } from './activationCheck.js';
import { bankShortName } from './banks.js';
import { EBICS_DEFAULT_KEY_PARAMS, EBICS_UNLIMITED_VALIDITY } from './enums.js';
import { formatBankHashLines } from './hash-format.js';
import { EBICS_KEY_PURPOSES } from './key-hashes.js';
import { STATEMENT_BTF } from './transport-https.js';
import {
  FEED_FINAL_OUTCOMES,
  dayEndPosition,
  comparePositions,
  decideSuccessor,
  lastNumberJump,
  newestFeedStatement,
  readFeedBook,
} from './feed.js';
import type { FeedNumberJump, FeedPosition } from './feed.js';
import { statementGaps } from '../statementGaps.js';
import type { PendingGapStatement, StatementGap } from '../statementGaps.js';
// A37 dispatch: the managed (bLink) rail sits behind these same verbs (spec A37 §5). This module
// imports the managed engine one-directionally (managed never imports back), so the channel-kind
// dispatch is the whole seam and the managed rail is untouched by A36.
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
  /** D142: the sync lease (null when no sync runs). */
  sync_started_at: string | null;
  /** D142 critic F2: who holds it (`pid:<pid>:boot:<nonce>[:job:<id>]`). */
  sync_lease_owner: string | null;
  /** D142: the daily automatic fetch ('daily' | 'off', NULL reads as daily) and its Swiss time. */
  auto_sync_mode: string | null;
  auto_sync_at: string | null;
  auto_sync_actor: string | null;
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

// --- order-log vocabulary (A36 §4.3, §4.5) ------------------------------------------------------
//
// No new table: the append-only `ebics_order_log` carries every order and every member outcome.
// `order_ref` groups the rows of one thing WITHOUT the connection id (which a G04 restore re-mints;
// the `connection_id` column is the scope and is remapped with it):
//  - `INI` / `HIA` / `HPB` / `HEV`: one row per attempt, `ok` or `failed` with the raw code;
//  - `btd-<TransactionID>`: the persisted container (`ebics_container`) and its receipt
//    (`ebics_receipt`). The TransactionID is stored uppercase (hexBinary is case-insensitive) and is
//    the durable replay record (W11);
//  - `member-<sha256>`: the persisted member (`ebics_member`, `related_id` its E00 file) and each
//    CHANGE of its outcome (`member_outcome`, `bank_reason` the code, `status` `ok` when final, else
//    `failed`). The payload hash is the dedupe: ZKB names members by pickup date, so a re-offer
//    differs only in the container bytes.

const RK_CONTAINER = 'ebics_container';
const RK_RECEIPT = 'ebics_receipt';
const RK_MEMBER = 'ebics_member';
const RK_OUTCOME = 'member_outcome';

const txRef = (transactionId: string): string => `btd-${transactionId.toUpperCase()}`;
const memberRef = (sha: string): string => `member-${sha}`;

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
 * The keystore's unlock state, pre-checked BEFORE a verb asks the store to generate or use key
 * material. `keystore_locked`: a passphrase-encrypted store not yet unlocked this session (never
 * regenerate: a wrong passphrase minting fresh keys would strand the live bank contract);
 * `keystore_unavailable`: the file is missing or corrupt.
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

/** A keystore write that threw: the stable code it names, or null for an unexpected failure. */
function keystoreRefusal(e: unknown): string | null {
  const message = e instanceof Error ? e.message : String(e);
  return ['keystore_locked', 'keystore_unavailable', 'keystore_changed_elsewhere'].includes(message) ? message : null;
}

/**
 * P8: connect, disconnect and the key confirm are deliberate acts. They proceed only when the A26
 * approval dial is on OR a human passed `confirm:true`.
 */
function dialEnabled(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT posting_auto_issue AS v FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { v: number | null } | undefined;
  return row?.v === 1;
}

/** The effective EBICS return code of an answer: the technical level unless it was 000000. */
function effectiveCode(codes: EbicsReturnCodes | undefined): string | null {
  if (codes === undefined) return null;
  if (codes.technical !== null && codes.technical !== '000000') return codes.technical;
  return codes.business;
}

/** 091201 to 091219: the bank refused a key or a certificate; the subscriber is unchanged (§4.2). */
function isCertificateCode(code: string | null): boolean {
  if (code === null || !/^0912\d\d$/.test(code)) return false;
  const n = Number.parseInt(code.slice(4), 10);
  return n >= 1 && n <= 19;
}

// --- reads / views -----------------------------------------------------------------------------

function readConnection(ctx: WorkspaceContext, id: unknown): ConnectionRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM ebics_connection WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ConnectionRow | undefined;
}

/** The one LIVE (non-retired) connection for a bank contract in THIS workspace, if any. */
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

/**
 * Does ANOTHER workspace of this database hold a live connection for this subscriber (§4.5)? Two feeds
 * would split the statements, so the database admits one live connection per ZKB subscriber (the
 * unique index `ebics_connection_one_live_per_subscriber`). This is the one cross-workspace fact the
 * channel reads, and it answers existence only: no row of the other workspace is returned.
 */
function liveConnectionElsewhere(ctx: WorkspaceContext, host: { hostId: string; partnerId: string; userId: string }): boolean {
  const row = ctx.store.db
    .prepare(
      "SELECT 1 AS live FROM ebics_connection WHERE host_id = ? AND partner_id = ? AND user_id_ebics = ? AND state != 'retired' AND workspace_id != ? LIMIT 1",
    )
    .get(host.hostId, host.partnerId, host.userId, ctx.workspaceId) as { live: number } | undefined;
  return row !== undefined;
}

/** The live connection a bank account is routed over, if any. */
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

/** The ref every wire call carries: the reviewed pin travels with it, BTD-ACK included (W2). */
function connectionRef(row: ConnectionRow): EbicsConnectionRef {
  return {
    hostUrl: row.host_url,
    hostId: row.host_id,
    partnerId: row.partner_id,
    userIdEbics: row.user_id_ebics,
    protocolVersion: row.protocol_version,
    keyRef: row.key_ref ?? '',
    bankKeyHashes: parseJson<EbicsKeyHashes>(row.bank_key_hashes),
  };
}

function accountIban(ctx: WorkspaceContext, bankAccountId: string): string | null {
  const view = getBankAccount(ctx, { bankAccountId });
  if (!view.ok) return null;
  return ((view as unknown as { bankAccount: { iban: string } }).bankAccount).iban ?? null;
}

function normaliseIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** The bank hashes printed the way ZKB's sheet prints them: uppercase pairs, 8 per line (§3 step 6). */
function bankKeyLines(h: EbicsKeyHashes): Record<'authentication' | 'encryption', { certificate: string[] | null; key: string[] | null; spki: string[] }> {
  const lines = (purpose: 'authentication' | 'encryption') => ({
    certificate: typeof h.certificateHashes?.[purpose] === 'string' ? formatBankHashLines(h.certificateHashes[purpose] as string) : null,
    key: typeof h.keyHashes?.[purpose] === 'string' ? formatBankHashLines(h.keyHashes[purpose] as string) : null,
    spki: formatBankHashLines(h[purpose]),
  });
  return { authentication: lines('authentication'), encryption: lines('encryption') };
}

function connectionView(ctx: WorkspaceContext, row: ConnectionRow): Record<string, unknown> {
  const accounts = readRoutedAccountIds(ctx, row.id).map((id) => ({ bankAccountId: id, iban: accountIban(ctx, id) }));
  return {
    connectionId: row.id,
    host: { url: row.host_url, hostId: row.host_id, partnerId: row.partner_id, userId: row.user_id_ebics },
    protocolVersion: row.protocol_version,
    state: row.state,
    keyParams: parseJson(row.key_params),
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
  orderType: 'INI' | 'HIA' | 'HPB' | 'HEV' | 'BTD';
  btfServiceName?: string | null;
  btfMsgName?: string | null;
  payloadSha256?: string | null;
  relatedKind?: string | null;
  relatedId?: string | null;
  status: 'ok' | 'failed';
  bankReason?: string | null;
}

/** Append one order-log row. NEVER updates an existing row: a progression appends a new row. */
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

function appendOrderTx(ctx: WorkspaceContext, a: OrderAppend): void {
  ctx.store.tx(() => {
    appendOrder(ctx, a);
    return ok({});
  });
}

// --- state writes, each naming the states it may leave (§4.2) ---------------------------------

const PRE_ACTIVE: readonly string[] = ['draft', 'keys_generated', 'ini_sent', 'pending_bank_activation'];

/** Move a connection to `to` only from one of `from`. Returns whether the row moved. */
function moveState(ctx: WorkspaceContext, id: string, to: string, from: readonly string[], set: Record<string, unknown> = {}): boolean {
  const cols = Object.keys(set);
  const assignments = ['state = ?', 'updated_at = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
  let moved = false;
  ctx.store.tx(() => {
    const info = ctx.store.db
      .prepare(`UPDATE ebics_connection SET ${assignments} WHERE workspace_id = ? AND id = ? AND state IN (${from.map(() => '?').join(', ')})`)
      .run(to, ctx.clock.now(), ...cols.map((c) => set[c]), ctx.workspaceId, id, ...from);
    moved = info.changes === 1;
    return ok({});
  });
  return moved;
}

// --- INI letter (an E00 artifact) --------------------------------------------------------------

/**
 * The INI letter the owner signs and posts to ZKB (§3 step 4): host ID, partner ID, user ID, H005, the
 * date, and per key the SHA-256 CERTIFICATE hash (what the bank compares for an H005 certificate
 * subscriber), printed as uppercase byte pairs, 8 per line as on ZKB's sheet. The classic key hash is
 * printed beside it, labelled. Text, not PDF: it carries identifiers and hashes only.
 */
function renderIniLetterText(row: ConnectionRow, hashes: EbicsKeyHashes, companyName: string, date: string): string {
  const params = { ...EBICS_DEFAULT_KEY_PARAMS, ...(parseJson<Record<string, unknown>>(row.key_params) ?? {}) };
  const version = (p: EbicsKeyPurpose): string => (typeof params[p] === 'string' ? (params[p] as string) : EBICS_DEFAULT_KEY_PARAMS[p]);
  const labels: Record<EbicsKeyPurpose, string> = {
    electronicSignature: 'Elektronische Unterschrift / electronic signature',
    authentication: 'Authentifikation / authentication',
    encryption: 'Verschlüsselung / encryption',
  };
  const block = (hex: string): string[] => formatBankHashLines(hex).map((line) => `    ${line}`);
  const lines = [
    'EBICS INI-Brief / EBICS initialisation letter',
    '',
    `Kunde / Customer: ${companyName}`,
    `Host-ID: ${row.host_id}`,
    `Partner-ID (Kunden-ID): ${row.partner_id}`,
    `Teilnehmer-ID (User-ID): ${row.user_id_ebics}`,
    `EBICS-Version: ${row.protocol_version}`,
    `Datum / Date: ${date}`,
    'Schlüsselformat / key format: X.509-Zertifikate, selbst signiert / self-signed X.509 certificates',
    `Gültigkeit / Validity: unlimited (${EBICS_UNLIMITED_VALIDITY}, SMPG 6.1)`,
    '',
    'Hashwerte (SHA-256) / hash values (SHA-256):',
  ];
  for (const purpose of EBICS_KEY_PURPOSES) {
    lines.push('', `${labels[purpose]} (${version(purpose)})`);
    const cert = hashes.certificateHashes?.[purpose];
    if (typeof cert === 'string' && cert !== '') lines.push('  Zertifikat / certificate:', ...block(cert));
    const keyHash = hashes.keyHashes?.[purpose];
    if (typeof keyHash === 'string' && keyHash !== '') lines.push('  Öffentlicher Schlüssel / public key:', ...block(keyHash));
    if ((typeof cert !== 'string' || cert === '') && (typeof keyHash !== 'string' || keyHash === '')) {
      lines.push('  Öffentlicher Schlüssel / public key (SPKI):', ...block(hashes[purpose]));
    }
  }
  lines.push('', 'Unterschrift / Signature: ______________________   Datum / Date: __________');
  return lines.join('\n');
}

function fileById(uploaded: Result): string {
  return ((uploaded as unknown as { file: { id: string } }).file).id;
}

// --- routing guards (§4.6) ----------------------------------------------------------------------

/** Does the workspace refuse a live bank channel: a sandbox (Testmandant) or demo workspace? */
function trialWorkspace(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(ctx.workspaceId) as { kind: string | null } | undefined;
  const kind = row?.kind ?? 'live';
  return kind === 'sandbox' || kind === 'demo' ? kind : null;
}

/**
 * Pre-check the accounts a connect would route, BEFORE any key exists and before any row (§4.6): each
 * must exist in this workspace, and none may already hold camt.054-imported lines (the camt.053 lines
 * the feed brings would double them; `camt054_lines_refused`).
 */
function routingGuard(ctx: WorkspaceContext, routeIds: string[]): Result | null {
  for (const bankAccountId of routeIds) {
    const acct = getBankAccount(ctx, { bankAccountId });
    if (!acct.ok) return err('bank_account_not_found', { bankAccountId });
    const camt054 = ctx.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id AND s.workspace_id = t.workspace_id
          WHERE t.workspace_id = ? AND t.bank_account_id = ? AND s.message_type = 'camt054'`,
      )
      .get(ctx.workspaceId, bankAccountId) as { n: number };
    if (camt054.n > 0) return err('camt054_lines_refused', { bankAccountId, camt054Lines: camt054.n });
  }
  return null;
}

/** Route N A19 accounts under a connection (the unique index dedupes a re-route). Guarded beforehand. */
function routeAccounts(ctx: WorkspaceContext, connectionId: string, routeIds: string[]): void {
  for (const bankAccountId of routeIds) {
    ctx.store.db
      .prepare(
        `INSERT INTO ebics_connection_account (id, workspace_id, connection_id, bank_account_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, bank_account_id) DO NOTHING`,
      )
      .run(ctx.ids.next('ebca'), ctx.workspaceId, connectionId, bankAccountId, ctx.clock.now());
  }
}

// --- verb 1: connectBankChannel ----------------------------------------------------------------

/**
 * The key ceremony (§3 steps 3 to 6, §4.2) behind one verb, keyed to the bank CONTRACT (host, partner,
 * user), never an account. A new ceremony: the routing guards, HEV, three certified pairs (the A005
 * private key dropped, OD-2), the connection row, the routed accounts and the INI letter (E00), then
 * INI and HIA. Advancing an existing connection (`connectionId`): resend its unconfirmed legs when it is
 * not yet activated, then HPB; without `confirmBankKeys` the bank hashes come back for the human
 * review, with it the reviewed set (`expectedBankKeyHashes`) is pinned only when it equals the fresh
 * HPB. Human only (P8, the G01 denylist).
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
    /**
     * With `confirmBankKeys`: the bank hashes the human compared against ZKB's sheet (the
     * `bankKeyHashes` a previous non-confirming call returned). REQUIRED for any move INTO `active`;
     * the pin is written only if a fresh HPB equals it exactly (case and whitespace normalised).
     */
    expectedBankKeyHashes?: unknown;
    keyLength?: unknown;
    idempotencyKey?: unknown;
  },
): Result {
  // A37 dispatch (spec §5): `channelKind:'managed_blink'` routes to the managed rail, as does advancing
  // an existing connection whose id names a managed row. The EBICS path below is the default.
  if (input.channelKind === 'managed_blink' || (typeof input.connectionId === 'string' && isManagedConnectionId(ctx, input.connectionId))) {
    return connectManagedChannel(ctx, input);
  }

  // P8 (spec §5): connect is a deliberate act. Pre-checked BEFORE any write.
  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { reason: 'connect_requires_confirmation' });
  }

  // §4.6: a sandbox or demo workspace never talks to a real bank.
  const trial = trialWorkspace(ctx);
  if (trial !== null) return err('trial_workspace_refused', { workspaceKind: trial });

  const routeIds = Array.isArray(input.routeBankAccountIds)
    ? input.routeBankAccountIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  const guarded = routingGuard(ctx, routeIds);
  if (guarded !== null) return guarded;

  if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
    const row = readConnection(ctx, input.connectionId);
    if (row === undefined) return err('not_found', { connectionId: input.connectionId });
    const expected = asKeyHashes(input.expectedBankKeyHashes);
    // A supplied-but-unreadable expectation must not silently degrade to "no check".
    if (input.expectedBankKeyHashes !== undefined && input.expectedBankKeyHashes !== null && expected === null) {
      return err('invalid_input', { field: 'expectedBankKeyHashes' });
    }
    return advanceConnection(ctx, row, { confirmBankKeys: input.confirmBankKeys === true, routeIds, expected });
  }

  const host = input.host;
  const hostUrl = typeof host?.url === 'string' ? host.url : '';
  const hostId = typeof host?.hostId === 'string' ? host.hostId : '';
  const partnerId = typeof host?.partnerId === 'string' ? host.partnerId : '';
  const userId = typeof host?.userId === 'string' ? host.userId : '';
  if (hostUrl === '' || hostId === '' || partnerId === '' || userId === '') {
    return err('invalid_input', { reason: 'host {url, hostId, partnerId, userId} is required to open a channel' });
  }

  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const scopedKey = JSON.stringify(['bank_channel_connect', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'bank_channel_connect');
  if (replayed !== undefined) return replayed;

  // One ceremony per contract: a live connection already exists here -> route the accounts under it.
  const existing = readLiveConnectionForContract(ctx, { hostId, partnerId, userId });
  if (existing !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_channel_connect', () => {
      routeAccounts(ctx, existing.id, routeIds);
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
  }
  // §4.5: one live connection per ZKB subscriber in the database.
  if (liveConnectionElsewhere(ctx, { hostId, partnerId, userId })) {
    return err('live_connection_exists', { hostId, partnerId, userId, reason: 'this subscriber already feeds another workspace of this database' });
  }

  const ksBlock = keystoreBlock(ctx);
  if (ksBlock !== null) return ksBlock;

  const t = transport(ctx);
  const provisional: EbicsConnectionRef = { hostUrl, hostId, partnerId, userIdEbics: userId, protocolVersion: 'H005', keyRef: '', bankKeyHashes: null };
  // D-A36.2: HEV BEFORE any key exists. A host that does not list H005 is refused; H004 is never used.
  if (t !== undefined) {
    const hev = callPort(() => t.hostVersions({ connection: provisional }));
    if (!hev.ok) {
      if (hev.reason === 'unsupported_ebics_version') {
        return err('unsupported_ebics_version', { hostId, offered: hev.detail ?? null, reason: 'the host does not offer EBICS 3.0 (H005)' });
      }
      return err('channel_unreachable', { reason: hev.reason, ...(hev.codes !== undefined ? { codes: hev.codes } : {}), ...(hev.detail !== undefined ? { detail: hev.detail } : {}) });
    }
  }

  const keyLength = Number.isInteger(input.keyLength) ? (input.keyLength as number) : EBICS_DEFAULT_KEY_PARAMS.keyLength;
  // Local crypto, no network. The EBICS user ID is the certificates' CN (§4.2). OD-2 happens inside.
  let generated: { keyRef: string; hashes: EbicsKeyHashes };
  try {
    generated = keystore(ctx).generate({ keyLength, subjectCommonName: userId });
  } catch (e) {
    const code = keystoreRefusal(e);
    if (code !== null) return err(code, {});
    throw e;
  }
  const keyParams = { ...EBICS_DEFAULT_KEY_PARAMS, keyLength };

  const profile = getCompanyProfile(ctx);
  const companyName = profile.ok
    ? (((profile as unknown as { profile: Record<string, unknown> }).profile.name as string | undefined) ?? 'TILL')
    : 'TILL';

  const id = ctx.ids.next('ebconn');
  const at = ctx.clock.now();

  // CREATE the connection locally, memoised under the key. With NO transport wired the memoised result
  // IS the final answer (keys_generated + needs_bank_transport), so a replay is byte-identical; with a
  // transport the legs run AFTER (not memoised, retryable). A write failure THROWS, so the tx rolls back.
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
      routeAccounts(ctx, id, routeIds);

      const row = readConnection(ctx, id) as ConnectionRow;
      const letter = renderIniLetterText(row, generated.hashes, companyName, at.slice(0, 10));
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
      if (t === undefined) return ok({ ...base, transmitted: false, reason: 'needs_bank_transport' });
      return ok(base);
    });
  } catch (e) {
    // The row never landed: forget the keys generated for it (nothing references them).
    try {
      keystore(ctx).destroy(generated.keyRef);
    } catch {
      // best effort: an unreferenced key in the store is inert
    }
    if (e instanceof EbicsAbort) return e.result;
    throw e;
  }

  if (!creationResult.ok) return creationResult;
  if (t === undefined) return creationResult;

  const created = readConnection(ctx, id) as ConnectionRow;
  const legs = runLegs(ctx, t, created);
  const after = readConnection(ctx, id) as ConnectionRow;
  const shaped: Record<string, unknown> = {
    connectionId: id,
    state: after.state,
    routedAccounts: readRoutedAccountIds(ctx, id),
    iniLetterDocumentId: after.ini_letter_document_id,
    bankKeyHashes: null,
    connection: connectionView(ctx, after),
  };
  if (legs.refusal !== null) return err(legs.refusal.code, { connectionId: id, state: after.state, ...legs.refusal.details });
  return ok(shaped);
}

/** Call a port method; a THROW is an outcome nobody knows (a lost answer), reported, never success. */
function callPort<T extends { ok: boolean }>(fn: () => T): T | EbicsTransportFailure {
  try {
    const r = fn();
    if (r === null || typeof r !== 'object' || typeof r.ok !== 'boolean') return { ok: false, reason: 'ebics_wire_contract_error' };
    return r;
  } catch (e) {
    return { ok: false, reason: 'answer_lost', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Which of the two legs the bank has confirmed with 000000 (from the append-only order log). */
function confirmedLegs(ctx: WorkspaceContext, connectionId: string): Record<EbicsKeyLeg, boolean> {
  const rows = ctx.store.db
    .prepare("SELECT order_type FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND order_type IN ('INI', 'HIA') AND status = 'ok'")
    .all(ctx.workspaceId, connectionId) as { order_type: string }[];
  return { INI: rows.some((r) => r.order_type === 'INI'), HIA: rows.some((r) => r.order_type === 'HIA') };
}

interface LegRefusal {
  code: 'init_refused' | 'certificate_refused' | 'key_exchange_refused' | 'channel_unreachable';
  details: Record<string, unknown>;
}

/**
 * Send every UNCONFIRMED leg (INI, then HIA) with the same keys, and move the state (§4.2). A leg is
 * confirmed only by 000000. 091002 means "wrong subscriber or wrong state" and EBICS does not say which
 * (EBICS 3.0 §4.4.1.2): with the OTHER leg confirmed, both landed (`pending_bank_activation`); with
 * neither, `init_refused`. 091201 to 091219 is `certificate_refused`. Any other code is shown raw. A lost
 * answer is `ini_sent`: the owner's retry resends only what is unconfirmed.
 */
function runLegs(ctx: WorkspaceContext, t: EbicsTransportPort, row: ConnectionRow): { refusal: LegRefusal | null } {
  const confirmed = confirmedLegs(ctx, row.id);
  const answers: Partial<Record<EbicsKeyLeg, EbicsTransportFailure>> = {};
  for (const leg of ['INI', 'HIA'] as const) {
    if (confirmed[leg]) continue;
    const r = callPort(() => t.sendKeyLeg({ connection: connectionRef(row), leg }));
    if (r.ok) {
      appendOrderTx(ctx, { connectionId: row.id, orderRef: leg, direction: 'upload', orderType: leg, status: 'ok' });
      confirmed[leg] = true;
    } else {
      answers[leg] = r;
      appendOrderTx(ctx, {
        connectionId: row.id,
        orderRef: leg,
        direction: 'upload',
        orderType: leg,
        status: 'failed',
        bankReason: effectiveCode(r.codes) ?? r.reason,
      });
    }
  }
  const code = (leg: EbicsKeyLeg): string | null => effectiveCode(answers[leg]?.codes);
  const landed = (leg: EbicsKeyLeg): boolean => confirmed[leg] || (code(leg) === '091002' && confirmed[leg === 'INI' ? 'HIA' : 'INI']);
  if (landed('INI') && landed('HIA')) {
    moveState(ctx, row.id, 'pending_bank_activation', ['keys_generated', 'ini_sent']);
    return { refusal: null };
  }
  moveState(ctx, row.id, 'ini_sent', ['keys_generated']);
  const legs = { ini: confirmed.INI ? 'confirmed' : (code('INI') ?? answers.INI?.reason ?? null), hia: confirmed.HIA ? 'confirmed' : (code('HIA') ?? answers.HIA?.reason ?? null) };
  for (const leg of ['INI', 'HIA'] as const) {
    if (isCertificateCode(code(leg))) return { refusal: { code: 'certificate_refused', details: { leg, code: code(leg), legs } } };
  }
  if (!confirmed.INI && !confirmed.HIA && code('INI') === '091002' && code('HIA') === '091002') {
    return { refusal: { code: 'init_refused', details: { code: '091002', legs } } };
  }
  for (const leg of ['INI', 'HIA'] as const) {
    const a = answers[leg];
    if (a !== undefined && a.reason === 'bank_code' && code(leg) !== '091002') {
      return { refusal: { code: 'key_exchange_refused', details: { leg, codes: a.codes ?? null, legs } } };
    }
  }
  const lost = (['INI', 'HIA'] as const).find((leg) => answers[leg] !== undefined && answers[leg]?.reason !== 'bank_code');
  if (lost !== undefined) {
    const a = answers[lost] as EbicsTransportFailure;
    return { refusal: { code: 'channel_unreachable', details: { leg: lost, reason: a.reason, ...(a.detail !== undefined ? { detail: a.detail } : {}), legs } } };
  }
  // A single 091002 with the other leg still unconfirmed and no other answer: wait for the retry.
  return { refusal: { code: 'init_refused', details: { code: '091002', legs } } };
}

/**
 * Advance an existing connection (§3 steps 5 and 6): route any newly named accounts, resend the
 * unconfirmed legs of a connection the bank has not activated yet, then run HPB. A reviewed HPB 000000
 * supersedes an earlier `init_refused` and moves `ini_sent` on (the letter still works after a lost
 * first answer). No transport: honest `needs_bank_transport`.
 */
function advanceConnection(
  ctx: WorkspaceContext,
  row: ConnectionRow,
  opts: { confirmBankKeys: boolean; routeIds: string[]; expected: EbicsKeyHashes | null },
): Result {
  if (row.state === 'retired') {
    return err('invalid_state', { connectionId: row.id, state: 'retired', reason: 'a retired channel cannot be advanced' });
  }
  if (opts.routeIds.length > 0) {
    ctx.store.tx(() => {
      routeAccounts(ctx, row.id, opts.routeIds);
      return ok({});
    });
  }

  // An active channel with no re-confirm is idempotent (nothing is sent).
  if (row.state === 'active' && !opts.confirmBankKeys) {
    return ok({ connectionId: row.id, state: 'active', connection: connectionView(ctx, readConnection(ctx, row.id) as ConnectionRow) });
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
  const ksBlock = keystoreBlock(ctx, { connectionId: row.id });
  if (ksBlock !== null) return ksBlock;

  let legRefusal: LegRefusal | null = null;
  if (row.state === 'keys_generated' || row.state === 'ini_sent' || row.state === 'draft') {
    legRefusal = runLegs(ctx, t, row).refusal;
  }
  const current = readConnection(ctx, row.id) as ConnectionRow;

  const hpb = callPort(() => t.fetchBankKeys({ connection: connectionRef(current) }));
  if (!hpb.ok) {
    appendOrderTx(ctx, { connectionId: row.id, orderRef: 'HPB', direction: 'download', orderType: 'HPB', status: 'failed', bankReason: effectiveCode(hpb.codes) ?? hpb.reason });
    if (legRefusal !== null) return err(legRefusal.code, { connectionId: row.id, state: current.state, ...legRefusal.details });
    if (PRE_ACTIVE.includes(current.state) && hpb.reason === 'bank_code') {
      // The bank has not activated the subscriber yet (ZKB answers HPB only once it has): wait.
      return err('pending_bank_activation', { connectionId: row.id, state: current.state, codes: hpb.codes ?? null });
    }
    return err('channel_unreachable', {
      connectionId: row.id,
      reason: hpb.reason,
      ...(hpb.codes !== undefined ? { codes: hpb.codes } : {}),
      ...(hpb.detail !== undefined ? { detail: hpb.detail } : {}),
    });
  }
  appendOrderTx(ctx, { connectionId: row.id, orderRef: 'HPB', direction: 'download', orderType: 'HPB', status: 'ok' });
  const bankHashes = normaliseKeyHashes(hpb.bankKeyHashes);
  // An HPB 000000 proves the bank holds both keys: the legs landed, whatever their answers said.
  moveState(ctx, row.id, 'pending_bank_activation', ['keys_generated', 'ini_sent', 'draft']);
  const fresh = readConnection(ctx, row.id) as ConnectionRow;

  if (!opts.confirmBankKeys) {
    // Surface the hashes for the human compare step (ZKB's sheet, 8 pairs per line); activate nothing.
    return ok({
      connectionId: row.id,
      state: fresh.state,
      bankKeyHashes: bankHashes,
      bankKeyLines: bankKeyLines(bankHashes),
      awaitingConfirmation: true,
      connection: connectionView(ctx, fresh),
    });
  }
  return decideBankKeys(ctx, fresh, bankHashes, opts.expected);
}

/**
 * The HPB failure reasons that ARE a transient network failure, as the wire and the core send them
 * (critic F5, D143): the wire's `transport_error` (no answer, a timeout) and the core's `answer_lost` (a
 * port that threw). Only these earn the activation check's hourly retry. Everything else (the bank's own
 * code, the wire's `protocol_error`, an untrusted answer, a pre-wire refusal such as
 * `certificate_missing`, `keystore_unavailable`, `invalid_request` or `internal_error`) waits for a person
 * or for the next day: a retry an hour later would get the same answer.
 */
const HPB_TRANSIENT: ReadonlySet<string> = new Set(['transport_error', 'answer_lost']);

/** What one activation check did (D143), for the scheduler's report and the suites. */
export interface ActivationCheckReport {
  connectionId: string;
  localDate: string;
  attempt: number;
  outcome: ActivationCheckOutcome;
  retryable: boolean;
  runAs: string | null;
  bankCode: string | null;
}

/**
 * D143 (A36 §12.1), THE DAILY ACTIVATION CHECK: an HPB-ONLY probe of a connection whose activation is in
 * progress, so TILL notices by itself when ZKB switched the subscriber on. Called ONLY from the explicit
 * `till up` scheduler branch (never by a G01 rule, never over MCP or REST: it is not a verb).
 *
 * WHAT IT NEVER DOES, by construction rather than by care: it sends no INI or HIA leg (`runLegs` is not
 * called), pins nothing and confirms nothing (`decideBankKeys` and `pinAndActivate` are not called, and
 * the fetched hashes are not stored), and never moves a connection into `active`. The one state it may
 * move is `ini_sent` to `pending_bank_activation` on an HPB 000000, the inference `advanceConnection`
 * already makes (an HPB answer proves the bank holds both keys). Comparing the hashes with the bank's
 * sheet stays a human act (P8): `bank_channel_connect` with `confirmBankKeys`.
 *
 * WHO IT RUNS AS: the D142 fetch's seated actor (`autoSyncActor`: the schedule's setter, else the owner
 * seat, never a governed seat), its `pay` right (the right `bank_channel_connect` needs) checked live
 * here. With none, the check is recorded `auto_sync_no_actor` and nothing reaches the bank.
 *
 * Returns null when the connection is not due (the decision is re-read here, so a double tick checks once).
 */
export function checkBankActivation(ctx: WorkspaceContext, input: { connectionId: string; now?: string }): ActivationCheckReport | null {
  const row = readConnection(ctx, input.connectionId);
  if (row === undefined) return null;
  const now = input.now ?? ctx.clock.now();
  const decision = activationCheckDecision(ctx, row, now);
  if (!decision.due) return null;

  const report = (outcome: ActivationCheckOutcome, retryable: boolean, runAs: string | null, bankCode: string | null = null): ActivationCheckReport => {
    ctx.store.tx(() => {
      recordActivationCheck(ctx, {
        connectionId: row.id,
        localDate: decision.localDate,
        attempt: decision.attempt,
        checkedAt: ctx.clock.now(),
        outcome,
        retryable,
        runAs,
        bankCode,
      });
      return ok({});
    });
    return { connectionId: row.id, localDate: decision.localDate, attempt: decision.attempt, outcome, retryable, runAs, bankCode };
  };

  // Critic F7: the attempt is marked BEFORE anything can reach the bank, so an outcome row that cannot be
  // written afterwards still counts against the day's cap; a mark that cannot be written stops here.
  ctx.store.tx(() => {
    recordActivationCheck(ctx, {
      connectionId: row.id,
      localDate: decision.localDate,
      attempt: decision.attempt,
      checkedAt: ctx.clock.now(),
      outcome: 'started',
      retryable: true,
      runAs: null,
      bankCode: null,
    });
    return ok({});
  });

  // The seated actor, checked live now (critic F1 of D142, reused as is).
  const runAs = autoSyncActor(ctx, row);
  if (runAs === null) return report('auto_sync_no_actor', false, null);
  const t = transport(ctx);
  if (t === undefined) return report('needs_bank_transport', false, runAs);
  const ks = keystore(ctx).state?.();
  if (ks === 'locked') return report('keystore_locked', false, runAs);
  if (ks === 'unavailable') return report('keystore_unavailable', false, runAs);

  const hpb = callPort(() => t.fetchBankKeys({ connection: connectionRef(row) }));
  if (!hpb.ok) {
    const code = effectiveCode(hpb.codes);
    appendOrderTx(ctx, {
      connectionId: row.id,
      orderRef: 'HPB',
      direction: 'download',
      orderType: 'HPB',
      relatedKind: ACTIVATION_CHECK_RELATED_KIND,
      status: 'failed',
      bankReason: code ?? hpb.reason,
    });
    if (hpb.reason === 'bank_code') return report('not_activated', false, runAs, code);
    // Only a network hiccup is retried; an answer nobody can trust or read waits, like a code.
    return report('channel_unreachable', HPB_TRANSIENT.has(hpb.reason), runAs, code ?? hpb.reason);
  }
  appendOrderTx(ctx, { connectionId: row.id, orderRef: 'HPB', direction: 'download', orderType: 'HPB', relatedKind: ACTIVATION_CHECK_RELATED_KIND, status: 'ok' });
  // The bank holds both keys. Only `ini_sent` moves; never into `active`, never a pin.
  moveState(ctx, row.id, 'pending_bank_activation', ['ini_sent']);
  return report('bank_ready', false, runAs);
}

/**
 * The trust decision (§4.2, SMPG §6.1 steps 7 and 8). The ORDER is load-bearing:
 *  1. The PIN first. A fresh HPB that contradicts the pin is a rotation or an attacker: an active
 *     channel halts (`bank_keys_changed`) and nothing new is pinned, unless the channel is ALREADY
 *     halted or locally blocked and a human reviewed exactly this fresh set (a reviewed rotation).
 *  2. The review. The pin holds, but the set the human reviewed is not what the bank serves now.
 *  3. Every move INTO `active` needs the reviewed set; re-confirming an unchanged pin on an active
 *     channel is a verification and writes nothing.
 */
function decideBankKeys(ctx: WorkspaceContext, row: ConnectionRow, bankHashes: EbicsKeyHashes, expected: EbicsKeyHashes | null): Result {
  const stored = parseJson<EbicsKeyHashes>(row.bank_key_hashes);
  const pinHolds = stored === null || sameHashes(stored, bankHashes);
  const reviewHolds = expected === null || exactSameHashes(expected, bankHashes);

  if (!pinHolds) {
    if ((row.state === 'bank_keys_changed' || row.state === 'blocked') && expected !== null && reviewHolds) {
      return pinAndActivate(ctx, row, bankHashes);
    }
    flagBankKeysChanged(ctx, row.id);
    return err('bank_keys_mismatch', {
      connectionId: row.id,
      stored,
      fetched: bankHashes,
      ...(expected !== null ? { expected } : {}),
      reason: 'pin_mismatch',
    });
  }
  if (!reviewHolds) {
    flagBankKeysChanged(ctx, row.id);
    return err('bank_keys_mismatch', { connectionId: row.id, expected, fetched: bankHashes, reason: 'changed_since_review' });
  }
  const pinUnchanged = stored !== null && exactSameHashes(stored, bankHashes);
  if (expected === null) {
    if (row.state === 'active' && pinUnchanged) {
      return ok({ connectionId: row.id, state: 'active', bankKeyHashes: bankHashes, connection: connectionView(ctx, row) });
    }
    return err('invalid_input', {
      connectionId: row.id,
      field: 'expectedBankKeyHashes',
      reason: 'expected_bank_key_hashes_required',
      hint: 'Fetch first (call without confirmBankKeys), compare the returned bankKeyHashes with the bank sheet, then confirm with expectedBankKeyHashes set to exactly that set.',
    });
  }
  return pinAndActivate(ctx, row, bankHashes);
}

/** Halt an ACTIVE channel whose bank keys no longer match (no new pin). Never over `blocked`/`retired`. */
function flagBankKeysChanged(ctx: WorkspaceContext, connectionId: string): boolean {
  return moveState(ctx, connectionId, 'bank_keys_changed', ['active']);
}

/**
 * Pin the reviewed set and flip to `active`. `activated_at` keeps the FIRST activation (the account is
 * EBICS-fed from then on, §4.4). `activatedConnectionId` is the OP8 emit path for
 * `bank_channel.activated`, present only on a flip INTO active.
 */
function pinAndActivate(ctx: WorkspaceContext, row: ConnectionRow, bankHashes: EbicsKeyHashes): Result {
  const now = ctx.clock.now();
  const becameActive = row.state !== 'active';
  let moved = false;
  ctx.store.tx(() => {
    const info = ctx.store.db
      .prepare(
        `UPDATE ebics_connection SET state = 'active', bank_key_hashes = ?, activated_at = COALESCE(activated_at, ?), updated_at = ?
          WHERE workspace_id = ? AND id = ? AND state IN ('draft', 'keys_generated', 'ini_sent', 'pending_bank_activation', 'bank_keys_changed', 'blocked', 'active')`,
      )
      .run(JSON.stringify(bankHashes), now, now, ctx.workspaceId, row.id);
    moved = info.changes === 1;
    return ok({});
  });
  if (!moved) return err('invalid_state', { connectionId: row.id, reason: 'the channel changed state while its keys were confirmed' });
  const active = readConnection(ctx, row.id) as ConnectionRow;
  return ok({
    connectionId: row.id,
    state: 'active',
    ...(becameActive ? { activatedConnectionId: row.id } : {}),
    bankKeyHashes: bankHashes,
    connection: connectionView(ctx, active),
  });
}

/** One hash value in comparable form: lowercase, whitespace and colons removed. */
function normHash(v: string | undefined | null): string {
  return typeof v === 'string' ? v.replace(/[\s:]/g, '').toLowerCase() : '';
}

/** A fetched hash set in comparable form (every value normalised; empty maps dropped). */
function normaliseKeyHashes(h: EbicsKeyHashes): EbicsKeyHashes {
  const out: EbicsKeyHashes = {
    electronicSignature: normHash(h.electronicSignature),
    authentication: normHash(h.authentication),
    encryption: normHash(h.encryption),
  };
  for (const field of ['certificateHashes', 'keyHashes'] as const) {
    const src = h[field];
    if (src === undefined || src === null) continue;
    const map: Partial<Record<EbicsKeyPurpose, string>> = {};
    for (const p of EBICS_KEY_PURPOSES) {
      const v = src[p];
      if (typeof v === 'string' && v !== '') map[p] = normHash(v);
    }
    if (Object.keys(map).length > 0) out[field] = map;
  }
  return out;
}

/**
 * Read a caller-supplied `EbicsKeyHashes` STRICTLY: the three primary values must be strings (empty
 * allowed: HPB carries no bank A005 key); `certificateHashes` and `keyHashes`, when present, must be
 * plain objects keyed by known purposes with string values. Anything else is null (`invalid_input`).
 */
function asKeyHashes(v: unknown): EbicsKeyHashes | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const primaries: string[] = [];
  for (const p of EBICS_KEY_PURPOSES) {
    const value = o[p];
    if (typeof value !== 'string') return null;
    primaries.push(normHash(value));
  }
  const out: EbicsKeyHashes = {
    electronicSignature: primaries[0] as string,
    authentication: primaries[1] as string,
    encryption: primaries[2] as string,
  };
  for (const field of ['certificateHashes', 'keyHashes'] as const) {
    const raw = o[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const map: Partial<Record<EbicsKeyPurpose, string>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!(EBICS_KEY_PURPOSES as readonly string[]).includes(key)) return null;
      if (value === undefined) continue;
      if (typeof value !== 'string') return null;
      map[key as EbicsKeyPurpose] = normHash(value);
    }
    out[field] = map;
  }
  return out;
}

/** EXACT, two-directional equality of two hash sets (the reviewed set against a fresh HPB). */
export function exactSameHashes(a: EbicsKeyHashes, b: EbicsKeyHashes): boolean {
  for (const p of EBICS_KEY_PURPOSES) {
    if (normHash(a[p]) !== normHash(b[p])) return false;
  }
  for (const field of ['certificateHashes', 'keyHashes'] as const) {
    for (const p of EBICS_KEY_PURPOSES) {
      if (normHash(a[field]?.[p]) !== normHash(b[field]?.[p])) return false;
    }
  }
  return true;
}

/**
 * Does a fresh HPB result match the PINNED set? Every primary fingerprint, and every certificate and
 * classic key hash the pin holds; a pinned value the fetch no longer carries is a mismatch.
 */
export function sameHashes(stored: EbicsKeyHashes, fetched: EbicsKeyHashes): boolean {
  for (const p of EBICS_KEY_PURPOSES) {
    if (normHash(stored[p]) !== normHash(fetched[p])) return false;
  }
  for (const field of ['certificateHashes', 'keyHashes'] as const) {
    const pinned = stored[field];
    if (pinned === undefined || pinned === null) continue;
    for (const purpose of EBICS_KEY_PURPOSES) {
      const value = pinned[purpose];
      if (value === undefined || normHash(value) === '') continue;
      if (normHash(fetched[field]?.[purpose]) !== normHash(value)) return false;
    }
  }
  return true;
}

/**
 * The HPB compare of §4.2, run after a 091008 or an `untrusted_response`: keys unequal to the pin halt
 * the channel in `bank_keys_changed`. A failed HPB changes nothing (`unknown`).
 */
function compareBankKeys(ctx: WorkspaceContext, t: EbicsTransportPort, conn: ConnectionRow): 'unchanged' | 'changed' | 'unknown' {
  const hpb = callPort(() => t.fetchBankKeys({ connection: connectionRef(conn) }));
  if (!hpb.ok) {
    appendOrderTx(ctx, { connectionId: conn.id, orderRef: 'HPB', direction: 'download', orderType: 'HPB', status: 'failed', bankReason: effectiveCode(hpb.codes) ?? hpb.reason });
    return 'unknown';
  }
  appendOrderTx(ctx, { connectionId: conn.id, orderRef: 'HPB', direction: 'download', orderType: 'HPB', status: 'ok' });
  const stored = parseJson<EbicsKeyHashes>(conn.bank_key_hashes);
  if (stored !== null && sameHashes(stored, normaliseKeyHashes(hpb.bankKeyHashes))) return 'unchanged';
  flagBankKeysChanged(ctx, conn.id);
  return 'changed';
}

/** The specific answer for a channel halted on its bank keys, naming the one way forward. */
function bankKeysChangedErr(conn: ConnectionRow, extra: Record<string, unknown>): Result {
  return err('bank_keys_changed', {
    connectionId: conn.id,
    state: 'bank_keys_changed',
    ...extra,
    hint: 'The bank keys changed. Fetch them (bank_channel_connect without confirmBankKeys), compare them with the current ZKB sheet, then confirm with expectedBankKeyHashes set to exactly that set.',
  });
}

// --- verb 2: syncBankChannel -------------------------------------------------------------------

/** How the BTD answered (§4.3 table). `kind` names the `download_refused` class. */
type DownloadOutcome =
  | { outcome: 'downloaded'; transactionId: string; members: number; newMembers: number }
  | { outcome: 'no_data' }
  | { outcome: 'download_refused'; kind: 'not_granted' | 'busy' | 'too_large' | 'other'; code: string | null; codes: EbicsReturnCodes | null }
  | { outcome: 'untrusted_response'; detail: string | null }
  | { outcome: 'channel_unreachable'; reason: string; detail: string | null }
  | { outcome: 'commit_failed'; detail: string };

function classifyDownloadFailure(f: EbicsTransportFailure): DownloadOutcome {
  if (f.reason === 'untrusted_response') return { outcome: 'untrusted_response', detail: f.detail ?? null };
  if (f.reason === 'bank_code') {
    const code = effectiveCode(f.codes);
    const codes = f.codes ?? null;
    if (code === '090005') return { outcome: 'no_data' };
    if (code === '090003' || code === '091005' || code === '091006') return { outcome: 'download_refused', kind: 'not_granted', code, codes };
    if (code === '091119') return { outcome: 'download_refused', kind: 'busy', code, codes };
    if (code === '091117') return { outcome: 'download_refused', kind: 'too_large', code, codes };
    return { outcome: 'download_refused', kind: 'other', code, codes };
  }
  return { outcome: 'channel_unreachable', reason: f.reason, detail: f.detail ?? null };
}

/** Has this connection's order log already recorded the TransactionID (W11)? */
function transactionSeen(ctx: WorkspaceContext, connectionId: string, transactionId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT 1 AS seen FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND order_ref = ? LIMIT 1')
    .get(ctx.workspaceId, connectionId, txRef(transactionId)) as { seen: number } | undefined;
  return row !== undefined;
}

/** Is a member (by payload hash) already persisted for this connection? */
function memberPersisted(ctx: WorkspaceContext, connectionId: string, sha: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT 1 AS seen FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND order_ref = ? AND related_kind = ? LIMIT 1')
    .get(ctx.workspaceId, connectionId, memberRef(sha), RK_MEMBER) as { seen: number } | undefined;
  return row !== undefined;
}

/** File one fetched artifact under the connection (E00, OR 958f retention). Inside the caller's tx. */
function fileArtifact(ctx: WorkspaceContext, conn: ConnectionRow, title: string, filename: string, mime: string, bytes: Buffer): string {
  const uploaded = uploadFile(ctx, { title, filename, mime, contentBase64: bytes.toString('base64') });
  if (!uploaded.ok) throw new EbicsAbort(uploaded);
  const fileId = fileById(uploaded);
  const linked = linkFile(ctx, { fileId, entityId: conn.id, entityKind: 'ebics_connection' });
  if (!linked.ok) throw new EbicsAbort(linked);
  const retention = setFileRetention(ctx, { fileId, retentionUntil: statutoryRetentionUntil(ctx, ctx.clock.now().slice(0, 10)) });
  if (!retention.ok) throw new EbicsAbort(retention);
  return fileId;
}

const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * §4.3 step 3, PERSIST: the container and every member not yet logged by its payload hash, as E00
 * files, with the TransactionID row and one row per new member, in ONE transaction under the store's
 * durability pragmas (`synchronous = EXTRA`, `fullfsync` on macOS). A failure throws and leaves nothing.
 */
function persistDownload(
  ctx: WorkspaceContext,
  conn: ConnectionRow,
  dl: { transactionId: string; containerBase64: string; files: EbicsFetchedFile[] },
): { members: number; newMembers: number } {
  const container = Buffer.from(dl.containerBase64, 'base64');
  const stamp = ctx.clock.now().slice(0, 10);
  let newMembers = 0;
  ctx.store.tx(() => {
    const containerId = fileArtifact(ctx, conn, `EBICS BTD ${STATEMENT_BTF.msgName} ${conn.host_id} ${stamp}`, `ebics-btd-${dl.transactionId}.zip`, 'application/zip', container);
    appendOrder(ctx, {
      connectionId: conn.id,
      orderRef: txRef(dl.transactionId),
      direction: 'download',
      orderType: 'BTD',
      btfServiceName: STATEMENT_BTF.serviceName,
      btfMsgName: STATEMENT_BTF.msgName,
      payloadSha256: sha256Hex(container),
      relatedKind: RK_CONTAINER,
      relatedId: containerId,
      status: 'ok',
    });
    const seenInThis = new Set<string>();
    for (const file of dl.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      const sha = sha256Hex(bytes);
      if (seenInThis.has(sha) || memberPersisted(ctx, conn.id, sha)) continue;
      seenInThis.add(sha);
      const fileId = fileArtifact(ctx, conn, `EBICS ${STATEMENT_BTF.msgName} ${file.name}`, file.name.split('/').pop() ?? file.name, 'application/xml', bytes);
      appendOrder(ctx, {
        connectionId: conn.id,
        orderRef: memberRef(sha),
        direction: 'download',
        orderType: 'BTD',
        btfServiceName: STATEMENT_BTF.serviceName,
        btfMsgName: STATEMENT_BTF.msgName,
        payloadSha256: sha,
        relatedKind: RK_MEMBER,
        relatedId: fileId,
        status: 'ok',
      });
      newMembers += 1;
    }
    return ok({});
  });
  return { members: dl.files.length, newMembers };
}

interface MemberRecord {
  sha: string;
  fileId: string | null;
  persistedAt: string;
  latestOutcome: { code: string; final: boolean; at: string; relatedId: string | null } | null;
}

/** Every persisted member of a connection with its latest outcome (append-only log, newest wins). */
function readMembers(ctx: WorkspaceContext, connectionId: string): MemberRecord[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT order_ref, payload_sha256, related_kind, related_id, status, bank_reason, occurred_at FROM ebics_order_log
        WHERE workspace_id = ? AND connection_id = ? AND related_kind IN (?, ?)
        ORDER BY occurred_at ASC, rowid ASC`,
    )
    .all(ctx.workspaceId, connectionId, RK_MEMBER, RK_OUTCOME) as {
    order_ref: string;
    payload_sha256: string | null;
    related_kind: string;
    related_id: string | null;
    status: string;
    bank_reason: string | null;
    occurred_at: string;
  }[];
  const byRef = new Map<string, MemberRecord>();
  for (const r of rows) {
    if (r.related_kind === RK_MEMBER) {
      if (!byRef.has(r.order_ref) && r.payload_sha256 !== null) {
        byRef.set(r.order_ref, { sha: r.payload_sha256, fileId: r.related_id, persistedAt: r.occurred_at, latestOutcome: null });
      }
      continue;
    }
    const m = byRef.get(r.order_ref);
    if (m === undefined) continue;
    m.latestOutcome = { code: r.bank_reason ?? 'unknown', final: r.status === 'ok', at: r.occurred_at, relatedId: r.related_id };
  }
  return [...byRef.values()];
}

/**
 * A member's bytes, read back from E00 by its payload hash (restore-proof: a G04 restore re-mints
 * file ids but keeps the content hash). Null when no copy is readable.
 */
function memberBytes(ctx: WorkspaceContext, member: MemberRecord): Buffer | null {
  const candidates = ctx.store.db
    .prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND sha256 = ? ORDER BY created_at ASC')
    .all(ctx.workspaceId, member.sha) as { id: string }[];
  const ids = [...(member.fileId !== null ? [member.fileId] : []), ...candidates.map((c) => c.id)];
  for (const fileId of ids) {
    const content = getFileContent(ctx, { fileId });
    if (!content.ok) continue;
    const bytes = Buffer.from((content as unknown as { contentBase64: string }).contentBase64, 'base64');
    if (sha256Hex(bytes) === member.sha) return bytes;
  }
  return null;
}

interface PendingMember {
  member: MemberRecord;
  xml: string | null;
  parsed: ParsedCamtStatement | null;
  position: FeedPosition | null;
}

/** The members still without a final outcome, parsed, in position order (unpositioned last). */
function pendingMembers(ctx: WorkspaceContext, connectionId: string): PendingMember[] {
  const out: PendingMember[] = [];
  for (const member of readMembers(ctx, connectionId)) {
    if (member.latestOutcome !== null && member.latestOutcome.final) continue;
    const bytes = memberBytes(ctx, member);
    const xml = bytes === null ? null : bytes.toString('utf8');
    const parsed = xml === null ? null : parseCamt(xml);
    const stmt = parsed !== null && parsed.ok ? parsed.statement : null;
    out.push({ member, xml, parsed: stmt, position: stmt === null ? null : dayEndPosition(stmt) });
  }
  return out.sort((a, b) => {
    if (a.position !== null && b.position !== null) return comparePositions(a.position, b.position) || a.member.persistedAt.localeCompare(b.member.persistedAt);
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return a.member.persistedAt.localeCompare(b.member.persistedAt);
  });
}

/**
 * §4.3 step 4, PROCESS: every persisted member without a final outcome, in position order, from its
 * bytes: routed by the parsed `Stmt/Acct/Id/IBAN` (unrouted is `unmatched_account`), imported through
 * `importCamt` under the member's FIXED key (no refusal is memoised, so a re-run decides afresh), and an
 * outcome row appended only when the outcome CHANGES.
 */
function processPending(ctx: WorkspaceContext, conn: ConnectionRow): Record<string, unknown>[] {
  const routedIbans = new Map<string, string>(); // iban -> bankAccountId
  for (const id of readRoutedAccountIds(ctx, conn.id)) {
    const iban = accountIban(ctx, id);
    if (iban !== null) routedIbans.set(normaliseIban(iban), id);
  }
  const results: Record<string, unknown>[] = [];
  for (const p of pendingMembers(ctx, conn.id)) {
    let code: string;
    let statementRowId: string | null = null;
    let bankAccountId: string | null = null;
    // Critic A36C-1: a jump the rule imported (§4.4 rule 2) travels with the statement's result.
    let jump: FeedNumberJump | null = null;
    const iban = p.parsed?.iban ?? null;
    if (p.xml === null) {
      code = 'member_unreadable';
    } else if (p.parsed === null) {
      code = 'schema_invalid';
    } else {
      bankAccountId = iban === null ? null : (routedIbans.get(normaliseIban(iban)) ?? null);
      if (bankAccountId === null) {
        code = 'unmatched_account';
      } else {
        const imported = importCamt(ctx, { bankAccountId, xml: p.xml, idempotencyKey: `a36-${conn.id}-${p.member.sha}` });
        if (imported.ok) {
          code = imported.duplicate ? 'already_imported' : 'imported';
          statementRowId = imported.statementId;
          const j = imported.feed?.jump;
          if (j !== undefined && p.position !== null) {
            jump = { after: { number: j.after.number, year: j.after.year }, statement: { number: p.position.number, year: p.position.year }, skipped: j.skipped };
          }
        } else {
          code = imported.error;
        }
      }
    }
    const final = FEED_FINAL_OUTCOMES.includes(code);
    if (p.member.latestOutcome === null || p.member.latestOutcome.code !== code) {
      appendOrderTx(ctx, {
        connectionId: conn.id,
        orderRef: memberRef(p.member.sha),
        direction: 'download',
        orderType: 'BTD',
        btfServiceName: STATEMENT_BTF.serviceName,
        btfMsgName: STATEMENT_BTF.msgName,
        payloadSha256: p.member.sha,
        relatedKind: RK_OUTCOME,
        relatedId: statementRowId ?? p.member.fileId,
        status: final ? 'ok' : 'failed',
        bankReason: code,
      });
    }
    results.push({
      documentId: p.member.fileId,
      payloadSha256: p.member.sha,
      iban,
      bankAccountId,
      position: p.position,
      outcome: code,
      final,
      ...(statementRowId !== null ? { statementId: statementRowId } : {}),
      ...(jump !== null ? { notice: 'statement_number_jump', jump } : {}),
    });
  }
  return results;
}

/** §4.3 step 5, the receipt: recorded on the order log, never fatal (the data is durable either way). */
function sendReceipt(ctx: WorkspaceContext, t: EbicsTransportPort, conn: ConnectionRow, transactionId: string, receiptCode: 0 | 1): { sent: boolean; reason: string | null } {
  const r = callPort(() => t.acknowledge({ connection: connectionRef(conn), transactionId, receiptCode }));
  appendOrderTx(ctx, {
    connectionId: conn.id,
    orderRef: txRef(transactionId),
    direction: 'download',
    orderType: 'BTD',
    btfServiceName: STATEMENT_BTF.serviceName,
    btfMsgName: STATEMENT_BTF.msgName,
    relatedKind: RK_RECEIPT,
    status: r.ok ? 'ok' : 'failed',
    bankReason: r.ok ? (receiptCode === 0 ? 'positive' : 'negative') : (effectiveCode(r.codes) ?? r.reason),
  });
  return { sent: r.ok, reason: r.ok ? null : r.reason };
}

/**
 * ONE SYNC (§4.3), on demand only (D-A36.10: the Studio button or `bank_sync` when asked; on the G01
 * denylist). Pre-check, download, persist, process, receipt, stamp. A download refusal still processes
 * the members waiting from earlier syncs, so a gap statement imports at the first press after the owner
 * filled the gap by hand, even on 090005.
 */
export function syncBankChannel(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; bankAccountId?: unknown; dateRange?: unknown; idempotencyKey?: unknown },
): Result {
  // A37 dispatch (spec §4/§5): a connectionId naming a managed connection, or a bankAccountId routed
  // over managed (and NOT over EBICS), syncs the managed rail.
  if (typeof input.connectionId === 'string' && isManagedConnectionId(ctx, input.connectionId)) {
    return syncManagedChannel(ctx, input as Parameters<typeof syncManagedChannel>[1]);
  }
  if (
    (input.connectionId === undefined || input.connectionId === null || input.connectionId === '') &&
    typeof input.bankAccountId === 'string' &&
    input.bankAccountId.length > 0 &&
    readConnectionForAccount(ctx, input.bankAccountId) === undefined &&
    readManagedConnectionForAccount(ctx, input.bankAccountId) !== undefined
  ) {
    return syncManagedChannel(ctx, input as Parameters<typeof syncManagedChannel>[1]);
  }

  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // §4.6: a DateRange is not requested (parked: gap fill by DateRange).
  if (input.dateRange !== undefined && input.dateRange !== null) {
    return err('unsupported_date_range', { reason: 'a sync fetches what the bank offers as new; a missing day is imported by hand from eBanking' });
  }
  const scopedKey = JSON.stringify(['bank_sync', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'bank_sync');
  if (replayed !== undefined) return replayed;

  // 1. PRE-CHECK: nothing is sent unless every precondition holds.
  let connection: ConnectionRow | undefined;
  if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
    connection = readConnection(ctx, input.connectionId);
  } else if (typeof input.bankAccountId === 'string' && input.bankAccountId.length > 0) {
    connection = readConnectionForAccount(ctx, input.bankAccountId);
  }
  if (connection === undefined) return err('needs_bank_channel', { reason: 'no connection for the given selector' });
  if (connection.state === 'retired') return err('channel_retired', { connectionId: connection.id });
  if (connection.state === 'blocked') return err('channel_blocked', { connectionId: connection.id });

  const conn = connection;
  const t = transport(ctx);
  if (t === undefined) {
    // No transport is the DOMINANT fact: nothing can be fetched, the hand import stands.
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_sync', () =>
      ok({ connectionId: conn.id, files: [], reason: 'needs_bank_transport', lastSyncAt: conn.last_sync_at }),
    );
  }
  const ksBlock = keystoreBlock(ctx, { connectionId: conn.id });
  if (ksBlock !== null) return ksBlock;
  if (conn.state === 'bank_keys_changed') return bankKeysChangedErr(conn, { reason: 'bank_keys_unconfirmed' });
  if (conn.state !== 'active') return err('pending_bank_activation', { connectionId: conn.id, state: conn.state });
  if (readRoutedAccountIds(ctx, conn.id).length === 0) return err('no_routed_account', { connectionId: conn.id });

  // D142: ONE SYNC PER CONNECTION. The lease is taken with one conditional UPDATE under SQLite's write
  // lock, so it holds across threads (the `till up` sync worker) and processes (an MCP agent beside the
  // Studio); a second call meanwhile is refused, never joined. A lease older than SYNC_LEASE_MS is a
  // process that died mid-sync and is taken over.
  const lease = takeSyncLease(ctx, conn.id);
  if (!lease.ok) return lease;
  try {
    return syncLeased(ctx, conn, t, scopedKey);
  } finally {
    releaseSyncLease(ctx, conn.id, lease.stamp);
  }
}

/** How long a sync lease holds before it counts as abandoned (a process that died mid-sync). */
export const SYNC_LEASE_MS = 15 * 60_000;

/**
 * CRITIC F2: the lease names its HOLDER, so an abnormal end is cleared by whoever can see it rather than
 * left for the 15-minute expiry. `pid:<pid>:boot:<nonce>` identifies this process (the nonce tells a
 * restarted process that got the same pid back from the dead one); the host's sync worker adds
 * `:job:<id>` (`setSyncLeaseHolder`), so the host clears exactly the lease of the job it gave up on.
 */
const PROCESS_BOOT = randomUUID();
const PROCESS_HOLDER = `pid:${process.pid}:boot:${PROCESS_BOOT}`;
let leaseHolder = threadId === 0 ? PROCESS_HOLDER : `${PROCESS_HOLDER}:thread:${threadId}`;

/** This process's holder prefix (`pid:<pid>:boot:<nonce>`), for the host to mint job holders from. */
export function processSyncLeaseHolder(): string {
  return PROCESS_HOLDER;
}

/** The holder the next lease this thread takes is stamped with (the sync worker sets its job's). */
export function setSyncLeaseHolder(holder: string): void {
  leaseHolder = holder;
}

/** When a lease stamped at `startedAt` frees itself if nobody clears it. */
export function syncLeaseFreesAt(startedAt: string): string {
  return new Date(Date.parse(startedAt) + SYNC_LEASE_MS).toISOString();
}

/**
 * Clear the lease a holder took (the host, after its worker timed out, errored or exited without an
 * answer). Only that holder's lease: a lease another sync took since is left alone. §H-TENANT.
 */
export function releaseSyncLeaseOf(store: WorkspaceContext['store'], workspaceId: string, holder: string): number {
  return Number(
    store.tx(() =>
      store.db
        .prepare('UPDATE ebics_connection SET sync_started_at = NULL, sync_lease_owner = NULL WHERE workspace_id = ? AND sync_lease_owner = ?')
        .run(workspaceId, holder).changes,
    ),
  );
}

/**
 * AT `till up` BOOT (critic F2): take over every lease whose holder process is gone, so a book whose
 * process was killed mid-sync (Cmd-Q, an upgrade restart, a reboot) does not say "a fetch is running"
 * for 15 minutes. A holder is gone when its pid is not alive, or when the pid is THIS process's but the
 * boot nonce is another (the same pid, handed back after a restart). A live foreign holder (an MCP
 * agent process beside till up) keeps its lease; a lease with no holder (an older build's) waits for
 * the expiry. Walks every workspace, each update tenant-bound. Returns how many it freed.
 */
export function reclaimDeadSyncLeases(store: WorkspaceContext['store'], isAlive: (pid: number) => boolean): number {
  const rows = store.db
    .prepare('SELECT workspace_id, id, sync_lease_owner FROM ebics_connection WHERE sync_started_at IS NOT NULL AND sync_lease_owner IS NOT NULL')
    .all() as { workspace_id: string; id: string; sync_lease_owner: string }[];
  let freed = 0;
  for (const r of rows) {
    const m = /^pid:(\d+):boot:([^:]+)/.exec(r.sync_lease_owner);
    if (m === null) continue;
    const pid = Number(m[1]);
    const dead = pid === process.pid ? m[2] !== PROCESS_BOOT : !isAlive(pid);
    if (!dead) continue;
    freed += Number(
      store.tx(() =>
        store.db
          .prepare('UPDATE ebics_connection SET sync_started_at = NULL, sync_lease_owner = NULL WHERE workspace_id = ? AND id = ? AND sync_lease_owner = ?')
          .run(r.workspace_id, r.id, r.sync_lease_owner).changes,
      ),
    );
  }
  return freed;
}

/** The instant before which a lease stamp is stale, for `now`. */
export function syncLeaseCutoff(now: string): string {
  return new Date(Date.parse(now) - SYNC_LEASE_MS).toISOString();
}

/**
 * Take the connection's sync lease, or refuse `sync_in_progress` naming when the running one began.
 * The lease and its release are the sync's own bookkeeping, not the sync: they never mark an approved
 * `bank_sync` as having run (D165, `withoutCommitMark`), so an approval whose sync imported nothing
 * stays rejectable, while one that imported a statement keeps its mark.
 */
function takeSyncLease(ctx: WorkspaceContext, connectionId: string): { ok: true; stamp: string } | Err {
  const stamp = ctx.clock.now();
  const taken = ctx.store.withoutCommitMark(() =>
    ctx.store.tx(() =>
      ctx.store.db
        .prepare(
          `UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ?
            WHERE workspace_id = ? AND id = ? AND (sync_started_at IS NULL OR sync_started_at < ?)`,
        )
        .run(stamp, leaseHolder, ctx.workspaceId, connectionId, syncLeaseCutoff(stamp)).changes,
    ),
  );
  if (Number(taken) === 1) return { ok: true, stamp };
  const running = ctx.store.db
    .prepare('SELECT sync_started_at AS s FROM ebics_connection WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, connectionId) as { s: string | null } | undefined;
  const startedAt = running?.s ?? null;
  // Critic F2: say what is KNOWN. The lease may belong to a fetch that is still running or to one that
  // ended abnormally where nobody could clear it; either way it frees itself at `freesAt`.
  return err('sync_in_progress', {
    connectionId,
    syncStartedAt: startedAt,
    freesAt: startedAt === null ? null : syncLeaseFreesAt(startedAt),
    retryable: true,
    reason:
      'a statement fetch for this connection is marked running since syncStartedAt; if none is running any more, the mark frees itself at freesAt',
  });
}

/** Clear the lease this sync took (and only that one: a stale lease another process took over stays). */
function releaseSyncLease(ctx: WorkspaceContext, connectionId: string, stamp: string): void {
  ctx.store.withoutCommitMark(() =>
    ctx.store.tx(() =>
      ctx.store.db
        .prepare('UPDATE ebics_connection SET sync_started_at = NULL, sync_lease_owner = NULL WHERE workspace_id = ? AND id = ? AND sync_started_at = ?')
        .run(ctx.workspaceId, connectionId, stamp),
    ),
  );
}

/** Steps 2 to 6 of §4.3, run under the connection's sync lease. */
function syncLeased(ctx: WorkspaceContext, conn: ConnectionRow, t: EbicsTransportPort, scopedKey: string): Result {
  // 2. DOWNLOAD (D-A36.3, D-A36.4). The wire authenticates; the core refuses a replayed TransactionID.
  let download: DownloadOutcome;
  let receiptFor: string | null = null;
  let keysCheck = false;
  const dl = callPort(() => t.download({ connection: connectionRef(conn), service: 'statements' }));
  if (dl.ok && (typeof dl.transactionId !== 'string' || !/^[0-9A-Fa-f]{32}$/.test(dl.transactionId) || !Array.isArray(dl.files))) {
    // W2: a success that names no TransactionID (or carries no member list) cannot be receipted and is
    // not used: nothing is persisted, no receipt follows.
    download = { outcome: 'channel_unreachable', reason: 'ebics_wire_contract_error', detail: 'a BTD success without a TransactionID or members' };
  } else if (dl.ok) {
    const transactionId = dl.transactionId.toUpperCase();
    if (transactionSeen(ctx, conn.id, transactionId)) {
      // W11: the wire's replay record lives for one process; the order log is the durable one. A
      // genuine initialisation served again is refused: nothing persisted, no receipt, no log row. It
      // was signed with the pinned key, so it says nothing about the bank keys: no HPB compare.
      download = { outcome: 'untrusted_response', detail: 'replayed_transaction' };
    } else {
      // 3. PERSIST, one transaction. A failed commit gets a NEGATIVE receipt: ZKB offers the data again.
      try {
        const persisted = persistDownload(ctx, conn, { ...dl, transactionId });
        download = { outcome: 'downloaded', transactionId, members: persisted.members, newMembers: persisted.newMembers };
        receiptFor = transactionId;
      } catch (e) {
        if (!(e instanceof EbicsAbort) && !(e instanceof Error)) throw e;
        download = { outcome: 'commit_failed', detail: e instanceof EbicsAbort ? JSON.stringify(e.result) : e.message };
        sendReceipt(ctx, t, conn, transactionId, 1);
      }
    }
  } else {
    download = classifyDownloadFailure(dl);
    if (dl.reason === 'untrusted_response' || dl.reason === 'bank_keys_unverified' || effectiveCode(dl.codes) === '091008') keysCheck = true;
  }

  // The HPB compare of §4.2: keys unequal to the pin halt the channel (never over blocked/retired).
  const bankKeys = keysCheck ? compareBankKeys(ctx, t, conn) : null;

  // 4. PROCESS, whatever step 2 answered.
  const statements = processPending(ctx, conn);

  // 5. RECEIPT: positive once the commit above held and every new member has an outcome row.
  let receipt: { sent: boolean; reason: string | null } | null = null;
  if (receiptFor !== null) receipt = sendReceipt(ctx, t, conn, receiptFor, 0);

  // 6. STAMP when the bank answered the download (a completed exchange, data or none).
  const answered = download.outcome === 'downloaded' || download.outcome === 'no_data';
  const now = ctx.clock.now();
  if (answered) {
    ctx.store.tx(() => {
      ctx.store.db
        .prepare('UPDATE ebics_connection SET last_sync_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(now, now, ctx.workspaceId, conn.id);
      return ok({});
    });
  }
  const lastSyncAt = answered ? now : conn.last_sync_at;
  const pending = statements.filter((s) => s.final !== true).length;
  const body: Record<string, unknown> = {
    connectionId: conn.id,
    download,
    statements,
    pendingStatements: pending,
    lastSyncAt,
    ...(receipt !== null ? { receipt: receipt.sent ? 'positive' : 'not_sent', ...(receipt.reason !== null ? { receiptReason: receipt.reason } : {}) } : {}),
  };

  if (bankKeys === 'changed') return bankKeysChangedErr(conn, { ...body });
  switch (download.outcome) {
    case 'download_refused':
      return err('download_refused', { ...body, kind: download.kind, code: download.code, btf: { ...STATEMENT_BTF } });
    case 'untrusted_response':
      return err('untrusted_response', { ...body, detail: download.detail });
    case 'channel_unreachable':
      return err('channel_unreachable', { ...body, reason: download.reason, lastSyncAt: conn.last_sync_at });
    case 'commit_failed':
      return err('commit_failed', { ...body });
    default:
      return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'bank_sync', () => ok(body));
  }
}

// --- verb 3: transmitPaymentBatch --------------------------------------------------------------

/**
 * D-A36.11: no upload of any kind. A generated A18 batch whose debtor account is routed over EBICS is
 * refused `upload_disabled` before any port call (the owner uploads and releases the pain.001 in
 * eBanking; ZKB rejects uploads without SignatureFlag and OD-2 leaves TILL no key to set it with). The
 * `needs_bank_channel` degrade and A37's managed rail are untouched. Posts nothing, marks nothing paid.
 */
export function transmitPaymentBatch(
  ctx: WorkspaceContext,
  input: { batchId?: unknown; confirm?: unknown; idempotencyKey?: unknown },
): Result {
  if (typeof input.batchId !== 'string' || input.batchId.length === 0) {
    return err('invalid_input', { field: 'batchId' });
  }
  // D156 critic F1: the schema REQUIRES the key, so the engine does too. With it optional, a call
  // without one ran unkeyed (and, from a governed seat, fell past the dial's draft screen).
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const batchId = input.batchId;
  const batch = ctx.store.db
    .prepare('SELECT id, status, bank_account_id FROM payment_batch WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, batchId) as { id: string; status: string; bank_account_id: string } | undefined;
  if (batch === undefined) return err('not_found', { batchId });
  if (batch.status !== 'generated') {
    return err('needs_batch_generated', { batchId, status: batch.status });
  }

  const connection = readConnectionForAccount(ctx, batch.bank_account_id);
  if (connection !== undefined) {
    return err('upload_disabled', {
      batchId,
      connectionId: connection.id,
      reason: 'the EBICS channel downloads statements only: upload the pain.001 in eBanking and release it there',
    });
  }
  const managedConn = readManagedConnectionForAccount(ctx, batch.bank_account_id);
  if (managedConn !== undefined) return transmitManagedBatch(ctx, input, managedConn);
  return ok({ transmitted: false, reason: 'needs_bank_channel', batchId });
}

// --- verb 4: getBankChannelStatus --------------------------------------------------------------

/** The legs of the ceremony as the order log records them: confirmed, the last refusal code, or unsent. */
function ceremonyFacet(orders: OrderRow[]): { ini: string; hia: string; refusal: string | null } {
  const legState = (leg: 'INI' | 'HIA'): string => {
    const rows = orders.filter((o) => o.order_type === leg);
    if (rows.some((o) => o.status === 'ok')) return 'confirmed';
    const latest = rows[0];
    return latest === undefined ? 'unsent' : (latest.bank_reason ?? 'failed');
  };
  const ini = legState('INI');
  const hia = legState('HIA');
  let refusal: string | null = null;
  if (isCertificateCode(ini === 'confirmed' ? null : ini) || isCertificateCode(hia === 'confirmed' ? null : hia)) refusal = 'certificate_refused';
  else if (ini === '091002' && hia === '091002') refusal = 'init_refused';
  return { ini, hia, refusal };
}

/**
 * The message a pending member shows (§5 status row): the refusal the successor rule gives it NOW, with
 * the facts it names, re-derived from the persisted bytes and the books (pure; nothing is written).
 */
function pendingView(ctx: WorkspaceContext, p: PendingMember, routed: Map<string, string>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    documentId: p.member.fileId,
    payloadSha256: p.member.sha,
    since: p.member.persistedAt,
    code: p.member.latestOutcome?.code ?? 'not_processed',
    statement:
      p.parsed === null
        ? null
        : { number: p.position?.number ?? null, year: p.position?.year ?? null, fromDate: p.parsed.fromDate, toDate: p.parsed.toDate, iban: p.parsed.iban },
  };
  if (p.parsed === null) return base;
  const bankAccountId = p.parsed.iban === null ? null : (routed.get(normaliseIban(p.parsed.iban)) ?? null);
  base.bankAccountId = bankAccountId;
  if (bankAccountId === null) return { ...base, code: 'unmatched_account' };
  const decision = decideSuccessor(p.parsed, readFeedBook(ctx, bankAccountId));
  if (decision.verdict === 'refused') return { ...base, code: decision.code, details: decision.details };
  // The rule would admit it now (the owner filled the gap): the next press imports it.
  return { ...base, readyToImport: true };
}

/**
 * A36 §4.7: the downloaded statements of one connection the successor rule refuses as `gap_refused`
 * NOW (re-derived from the stored bytes and the books, as `pendingView` does), in the gap read model's
 * shape. Pure read; nothing is written.
 */
function pendingGapsOf(ctx: WorkspaceContext, pendings: readonly PendingMember[], routed: Map<string, string>): PendingGapStatement[] {
  const out: PendingGapStatement[] = [];
  for (const p of pendings) {
    if (p.parsed === null || p.position === null || p.parsed.iban === null) continue;
    const bankAccountId = routed.get(normaliseIban(p.parsed.iban));
    if (bankAccountId === undefined) continue;
    const decision = decideSuccessor(p.parsed, readFeedBook(ctx, bankAccountId));
    if (decision.verdict !== 'refused' || decision.code !== 'gap_refused') continue;
    const details = decision.details as { differenceMinor?: unknown; reason?: unknown };
    out.push({
      bankAccountId,
      documentId: p.member.fileId ?? p.member.sha,
      position: p.position,
      fromDate: p.parsed.fromDate,
      toDate: p.parsed.toDate,
      openingBalanceMinor: p.parsed.openingBalanceMinor,
      closingBalanceMinor: p.parsed.closingBalanceMinor,
      currency: p.parsed.balanceCurrency,
      differenceMinor: typeof details.differenceMinor === 'number' ? details.differenceMinor : 0,
      reason: typeof details.reason === 'string' ? details.reason : 'balance_does_not_chain',
    });
  }
  return out;
}

/** The routed IBANs of one connection (normalised IBAN to Bankkonto id). */
function routedIbanMap(ctx: WorkspaceContext, connectionId: string): Map<string, string> {
  const routed = new Map<string, string>();
  for (const id of readRoutedAccountIds(ctx, connectionId)) {
    const iban = accountIban(ctx, id);
    if (iban !== null) routed.set(normaliseIban(iban), id);
  }
  return routed;
}

/** Every downloaded statement of the workspace's live connections waiting as `gap_refused` (§4.7). */
export function pendingGapStatements(ctx: WorkspaceContext): PendingGapStatement[] {
  const rows = ctx.store.db
    .prepare("SELECT id FROM ebics_connection WHERE workspace_id = ? AND state != 'retired' ORDER BY created_at, rowid")
    .all(ctx.workspaceId) as { id: string }[];
  return rows.flatMap((r) => pendingGapsOf(ctx, pendingMembers(ctx, r.id), routedIbanMap(ctx, r.id)));
}

/**
 * A36 §4.7, THE GAP READ MODEL WITH THE CHANNEL'S WAITING STATEMENTS: every open gap of every Bankkonto
 * (or the one named), book gaps and the gaps a refused download stands behind. The one reader the
 * status, the Übersicht tile, the attention hub and the repair dialog share.
 */
export function readStatementGaps(ctx: WorkspaceContext, input: { bankAccountId?: string } = {}): StatementGap[] {
  return statementGaps(ctx, input, pendingGapStatements(ctx));
}

/**
 * The status read (§5): per channel the state, the ceremony legs, the keystore, per routed account the
 * newest statement (position, date, CLBD), every pending member with its message, and the last sync.
 * Upload and protocol fields are gone with BTU, PSR and HAC. Read-only.
 */
export function getBankChannelStatus(
  ctx: WorkspaceContext,
  input: { bankAccountId?: unknown; status?: unknown; savedViewId?: unknown },
): Result {
  // The G00 saved-view seam (OP10) over the order log: it narrows `recentOrders`, never the health facts.
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
      .prepare('SELECT * FROM ebics_connection WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(ctx.workspaceId) as ConnectionRow[];
  }

  const channels = rows.map((row) => {
    const allOrders = readOrders(ctx, row.id);
    const recent = orderStatusFilter === null ? allOrders : allOrders.filter((o) => o.status === orderStatusFilter);
    const routedIds = readRoutedAccountIds(ctx, row.id);
    const routed = new Map<string, string>();
    // The statements this channel imported (the order log's `imported` outcomes), for the last jump.
    const feedStatementIds = new Set(
      readMembers(ctx, row.id)
        .filter((m) => m.latestOutcome?.code === 'imported' && m.latestOutcome.relatedId !== null)
        .map((m) => m.latestOutcome?.relatedId as string),
    );
    const accounts = routedIds.map((id) => {
      const iban = accountIban(ctx, id);
      if (iban !== null) routed.set(normaliseIban(iban), id);
      const book = readFeedBook(ctx, id);
      return { bankAccountId: id, iban, newestStatement: newestFeedStatement(book), lastNumberJump: lastNumberJump(book, feedStatementIds) };
    });
    const pendings = pendingMembers(ctx, row.id);
    const pendingStatements = pendings.map((p) => pendingView(ctx, p, routed));
    // A36 §4.7 (D150): the durable gaps per routed account, the jump notice's successor.
    const pendingGaps = pendingGapsOf(ctx, pendings, routed);
    const accountsWithGaps = accounts.map((a) => ({ ...a, statementGaps: statementGaps(ctx, { bankAccountId: a.bankAccountId }, pendingGaps) }));
    return {
      connectionId: row.id,
      channelKind: 'ebics',
      host: { hostId: row.host_id, partnerId: row.partner_id, userId: row.user_id_ebics },
      protocolVersion: row.protocol_version,
      state: row.state,
      activatedAt: row.activated_at,
      ceremony: ceremonyFacet(allOrders),
      accounts: accountsWithGaps,
      lastSyncAt: row.last_sync_at,
      // D142: a fetch running right now, in this process or another (the lease on the row).
      ...syncLeaseFacet(ctx, row),
      // D142: the daily automatic fetch: its mode and time, the last automatic attempt, the next run.
      autoSync: autoSyncStatus(ctx, row, ctx.clock.now()),
      // D143: the bank's short name for the band's mark, and the daily activation check. `bankReady`
      // means ZKB answered HPB: a PERSON compares the hashes with the bank's sheet and confirms
      // (bank_channel_connect with confirmBankKeys); no agent and no tick may do it.
      bankName: bankShortName({ hostId: row.host_id, hostUrl: row.host_url }),
      activation: activationStatus(ctx, row, ctx.clock.now()),
      pendingIniLetter: PRE_ACTIVE.includes(row.state) ? row.ini_letter_document_id : null,
      iniLetterDocumentId: row.ini_letter_document_id,
      pendingStatements,
      recentOrders: recent.slice(0, 20).map(orderView),
      keystore: keystoreFacet(ctx),
    };
  });

  // A37: the managed (bLink) channels ride the SAME read model, kind-labelled.
  const managed = managedChannelStatusList(ctx, input).channels;
  return ok({ channels: [...channels, ...managed] });
}

/** D142: whether a sync holds the connection's lease right now, and since when. */
export function syncLeaseFacet(ctx: WorkspaceContext, row: { sync_started_at: string | null }): { syncInProgress: boolean; syncStartedAt: string | null } {
  const live = row.sync_started_at !== null && row.sync_started_at >= syncLeaseCutoff(ctx.clock.now());
  return { syncInProgress: live, syncStartedAt: live ? row.sync_started_at : null };
}

/** The keystore health for the status card (`keystore:{kind,state,persistent}`). */
function keystoreFacet(ctx: WorkspaceContext): { kind: string; state: string; persistent: boolean } {
  const ks = keystore(ctx);
  return {
    kind: ks.kind ?? 'memory',
    state: ks.state?.() ?? 'ready',
    persistent: ks.persistent ?? false,
  };
}

// --- verb 5: disconnectBankChannel -------------------------------------------------------------

/**
 * Retire or block a channel (P8-gated). `retire` is the local, terminal close: the connection flips to
 * `retired`, its order history stays readable, and its keys are destroyed in the keystore. `block` is
 * LOCAL ONLY (D-A36.12): TILL stops at once and sends nothing (SPR needs the ES key, OD-2); a block at
 * ZKB is the owner's phone call. The way back from `blocked` is the reviewed HPB confirm.
 */
export function disconnectBankChannel(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; mode?: unknown; confirm?: unknown; idempotencyKey?: unknown },
): Result {
  const managedRow = readManagedConnection(ctx, input.connectionId);
  if (managedRow !== undefined) {
    return disconnectManagedChannel(ctx, input, managedRow);
  }

  const row = readConnection(ctx, input.connectionId);
  if (row === undefined) return err('not_found', { connectionId: input.connectionId });
  const mode = input.mode === 'block' ? 'block' : input.mode === 'retire' ? 'retire' : null;
  if (mode === null) return err('invalid_input', { field: 'mode', expected: ['retire', 'block'] });

  if (mode === 'retire' && row.state === 'retired') return ok({ connectionId: row.id, state: 'retired' });
  if (mode === 'block' && row.state === 'blocked') return ok({ connectionId: row.id, state: 'blocked', bankBlock: 'not_sent' });
  if (mode === 'block' && row.state === 'retired') {
    return err('invalid_state', { connectionId: row.id, state: 'retired', reason: 'a retired channel cannot be blocked' });
  }

  if (!dialEnabled(ctx) && input.confirm !== true) {
    return err('needs_confirmation', { connectionId: row.id, reason: 'disconnect_requires_confirmation' });
  }

  if (mode === 'block') {
    moveState(ctx, row.id, 'blocked', ['draft', 'keys_generated', 'ini_sent', 'pending_bank_activation', 'active', 'bank_keys_changed']);
    return ok({ connectionId: row.id, state: 'blocked', bankBlock: 'not_sent', reason: 'block_local_only' });
  }

  // retire: destroy the keys first (a keystore that changed elsewhere refuses, and nothing moves), then
  // flip terminal and clear the key locator and the schedule pointer. Order history stays readable.
  if (row.key_ref !== null) {
    try {
      keystore(ctx).destroy(row.key_ref);
    } catch (e) {
      const code = keystoreRefusal(e);
      if (code !== null) return err(code, { connectionId: row.id });
      throw e;
    }
  }
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        "UPDATE ebics_connection SET state = 'retired', key_ref = NULL, sync_rule_id = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND state != 'retired'",
      )
      .run(ctx.clock.now(), ctx.workspaceId, row.id);
    return ok({});
  });
  return ok({ connectionId: row.id, state: 'retired' });
}

// --- verb 6: setBankSyncSchedule ---------------------------------------------------------------

/**
 * The connection's schedule. `ruleId` is still refused `sync_schedule_parked` (D-A36.10's protection for
 * stored rules stands: no G01 rule fires `bank_sync`). D142 (A36 §12): `mode` (`daily` | `off`) and
 * `atTime` (`HH:MM`, Swiss time) set the daily automatic fetch the `till up` scheduler runs; either one
 * alone changes only itself. The unlink call (neither, no `ruleId`) stays valid and clears the pointer an
 * older build stored. Idempotent per (connection, key); banking-write; §H-TENANT.
 */
export function setBankSyncSchedule(
  ctx: WorkspaceContext,
  input: { connectionId?: unknown; ruleId?: unknown; mode?: unknown; atTime?: unknown; idempotencyKey?: unknown },
): Result {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  if (typeof input.connectionId !== 'string' || input.connectionId.length === 0) {
    return err('invalid_input', { field: 'connectionId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (typeof input.ruleId === 'string' && input.ruleId.length > 0) {
    return err('sync_schedule_parked', {
      connectionId: input.connectionId,
      reason: 'no automation rule fetches statements; the daily fetch is set with mode and atTime (D142)',
    });
  }
  if (input.mode !== undefined && input.mode !== null && !isAutoSyncMode(input.mode)) {
    return err('invalid_input', { field: 'mode', allowed: [...AUTO_SYNC_MODES] });
  }
  if (input.atTime !== undefined && input.atTime !== null && !isAutoSyncTime(input.atTime)) {
    return err('invalid_input', { field: 'atTime', reason: 'a Swiss local time HH:MM, 00:00 to 23:59' });
  }

  const row = readConnection(ctx, input.connectionId);
  if (row === undefined) return err('not_found', { connectionId: input.connectionId });
  if (row.state === 'retired') return err('channel_retired', { connectionId: row.id });

  const scopedKey = JSON.stringify(['set_bank_sync_schedule', input.connectionId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'set_bank_sync_schedule');
  if (replayed !== undefined) return replayed;

  const mode = isAutoSyncMode(input.mode) ? input.mode : row.auto_sync_mode;
  const atTime = isAutoSyncTime(input.atTime) ? input.atTime : row.auto_sync_at;
  // Critic F1: setting the schedule names who the automatic fetch runs as (its rights are checked live
  // at every attempt). The unlink-only call sets nothing, so it names nobody.
  const setsSchedule = isAutoSyncMode(input.mode) || isAutoSyncTime(input.atTime);
  const actor = setsSchedule ? ctx.actor : row.auto_sync_actor;
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_bank_sync_schedule', () => {
    ctx.store.db
      .prepare(
        `UPDATE ebics_connection SET sync_rule_id = NULL, auto_sync_mode = ?, auto_sync_at = ?, auto_sync_actor = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(mode, atTime, actor, ctx.clock.now(), ctx.workspaceId, row.id);
    const settings = autoSyncSettings({ auto_sync_mode: mode, auto_sync_at: atTime });
    return ok({ connectionId: row.id, syncRuleId: null, autoSync: { mode: settings.mode, atTime: settings.atTime, explicit: settings.explicit } });
  });
}
