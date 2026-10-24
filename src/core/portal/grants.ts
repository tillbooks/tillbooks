/**
 * F02, the customer portal: scoped, expiring, tokened grants that let one customer self-serve their
 * own invoices, quotes and documents, nothing else. The OSS core mints the grant as a LOCAL ARTIFACT
 * and stops (Pattern OP4): the token record, its scopes and the one-time link exist locally; the
 * hosted portal page and card/TWINT collection are cloud-tier.
 *
 * WHAT THIS MODULE IS. A `portal_grant` row is an ACCESS ARTIFACT, not a document: a random token
 * (CSPRNG >=256-bit) hashed to `token_hash`, a scope list naming exactly which records it exposes,
 * and an expiry. `portal.resolve` is the single verb the hosted page calls; it triple-fences every
 * read (workspace -> contact -> scope) and returns only what the scope names.
 *
 * WHAT THIS MODULE IS NOT. It NEVER posts and NEVER computes money (spec §4, asserted by
 * `test/portal/no-money-path.test.mjs`): open amounts come from the A11/A14 read models as integer
 * Rappen, and settlement is exclusively A14 `record_payment` at the cloud tier. Quote acceptance is
 * NEVER hand-rolled: `portal.quote_accept` fence-checks the token then DELEGATES to C02's real
 * `acceptQuote` (the A10 `sent -> accepted` transition), so F02 owns no quote state and forks no
 * lifecycle (spec §6b fixed; asserted by `test/portal/quote-accept.test.mjs`).
 *
 * THE THREE FENCES (spec §2 US-F02.5, the security invariant this capability exists for):
 *   1. WORKSPACE (§H-TENANT): a resolved token binds ONE workspace, and every read runs against that
 *      workspace id. A token minted in workspace A can never read, pay or accept anything in B.
 *   2. CONTACT: an entity must belong to the grant's own `contact_id`. A token scoped to customer X
 *      requesting Y's invoice by guessed id is denied.
 *   3. SCOPE: only the listed entity ids (or `all_invoices`) resolve; nothing else, even the same
 *      contact's other records.
 * An EXPIRED or REVOKED token resolves to NOTHING, indistinguishably (no oracle for probing).
 *
 * A DRAFT OPENS NOTHING (D157). A customer grant is minted as a draft and its token resolves to
 * nothing until `portal_grant_send` hands it over (stamps `sent_at`). Liveness reads `minted_draft`, an
 * engine-written marker no caller can set: every grant minted since D157 carries 1, and every row
 * written before it reads the column's DEFAULT 0, so a legacy grant of either kind stays live until its
 * own expiry (owner decision 1). `kind` is not caller input: `createGrant` mints customer grants only,
 * and the vendor kind is reachable only through `createVendorGrant` behind the supplier fence, which
 * stamps `sent_at` at mint (owner decision 2: a supplier link is live when it is granted). One rule,
 * `isHandedOver`, feeds `isLive`, the derived status and `isGrantLive`, so every token read path
 * (`resolveToken`, `portalQuoteAccept`, F03's vendor reads) and the status a person sees agree.
 *
 * TX-ATOMICITY (the C02/D03 bug class). `better-sqlite3`'s `db.transaction(fn)` rolls back ONLY when
 * `fn` THROWS: a write-then-return-`{ok:false}` COMMITS the partial write. Every refusal here
 * (past-expiry, invalid scope, revoked, cross-tenant, wrong grantee, quote-not-acceptable) is a
 * PRE-CHECK before any write, so a rejected verb writes ZERO rows and mints no invoice.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { makeContext } from '../context.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Clock } from '../clock.js';
import type { IdGen } from '../ids.js';
import { ledgerPorts } from '../ledger/index.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { acceptQuote, getDocument, listDocuments, buildQrBill } from '../sales/index.js';
import { listOpenItems } from '../debtors/openItems.js';
import { applySavedView } from '../customization/views.js';
import {
  isPortalScopeKind,
  isPortalWildcardScopeKind,
  PORTAL_SCOPE_KINDS,
  PORTAL_MAX_VALIDITY_DAYS,
  VENDOR_PORTAL_SCOPE_KINDS,
} from './enums.js';
import type { PortalGrantKind, PortalScopeKind } from './enums.js';

// --- Types ---------------------------------------------------------------------------------------

/** One scope entry: an entity-explicit `{kind,id}` or the `{kind:'all_invoices'}` wildcard. */
export interface PortalScope {
  kind: PortalScopeKind;
  id?: string | null;
}

export interface PortalGrantRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  kind: string;
  token_hash: string;
  scopes: string;
  expires_at: string;
  sent_at: string | null;
  revoked_at: string | null;
  /** D157: 1 on every grant minted since D157 (engine-written, never caller input); 0 on older rows. */
  minted_draft: number;
  last_resolved_at: string | null;
  local_artifact_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The one wire shape every grant verb answers with, so the verbs cannot drift (P5). */
export interface PortalGrantView {
  id: string;
  contactId: string;
  kind: string;
  scopes: PortalScope[];
  status: 'draft' | 'active' | 'revoked' | 'expired';
  expiresAt: string;
  sentAt: string | null;
  revokedAt: string | null;
  lastResolvedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** OP4/P9: the OSS core mints the artifact and stops. No host is wired here, so always cloud-tier. */
  hosted: false;
  reason: 'cloud_tier';
  /** The link-free local envelope persisted on the row (NEVER carries the token). */
  localArtifact: PortalLocalArtifact;
}

/**
 * The provider-agnostic OP4 envelope persisted on the row. It deliberately carries NO token and NO
 * usable link: a full DB read can never yield a working portal link (spec §3). The one-time link is
 * returned by `createGrant` ONCE, in memory, and is never re-derivable.
 */
export interface PortalLocalArtifact {
  grantId: string;
  workspaceId: string;
  contactId: string;
  kind: string;
  scopes: PortalScope[];
  expiresAt: string;
  hosted: false;
  reason: 'cloud_tier';
}

// --- Helpers -------------------------------------------------------------------------------------

/** The SHA-256 hash stored for a token: the token itself is returned once and never persisted. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A CSPRNG token, 32 bytes = 256 bits of entropy, hex-encoded (spec §4: unguessable, >=256-bit). */
function mintToken(): string {
  return randomBytes(32).toString('hex');
}

/** The bare day (YYYY-MM-DD) of the injected clock. */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** Add `days` to an ISO day, returning a YYYY-MM-DD string (UTC arithmetic, no local-tz drift). */
function addDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** A sortable ISO day: `YYYY-MM-DD` and parseable. Refused, never coerced. */
function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function parseScopes(raw: string): PortalScope[] {
  try {
    const parsed = JSON.parse(raw) as PortalScope[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Has this grant been handed over (D157)? A grant minted since D157 (`minted_draft = 1`) is handed over
 * once `sent_at` is stamped: by `portal_grant_send` for a customer grant, at mint for a vendor grant. A
 * row written before D157 reads the column's DEFAULT 0 and counts as handed over whatever its
 * `sent_at`, because before D157 a grant was live from creation and an old vendor grant never carried
 * a `sent_at` at all (owner decision 1: such links stay live until their own expiry).
 */
function isHandedOver(row: PortalGrantRow): boolean {
  return row.sent_at !== null || Number(row.minted_draft) === 0;
}

/**
 * The effective status of a grant, derived on read (spec §4: no bespoke state machine). Revocation
 * wins over expiry (a revoked-then-lapsed grant reads `revoked`); a grant not yet handed over is a
 * `draft`. `active` holds exactly when `isLive` does, so the panel never shows a dead link as active.
 */
function effectiveStatus(row: PortalGrantRow, day: string): PortalGrantView['status'] {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at < day) return 'expired';
  return isHandedOver(row) ? 'active' : 'draft';
}

/**
 * Is this grant usable RIGHT NOW: not revoked, not past expiry, and handed over (a draft opens
 * nothing, D157)? The one gate every token read path goes through.
 */
function isLive(row: PortalGrantRow, day: string): boolean {
  return row.revoked_at === null && row.expires_at >= day && isHandedOver(row);
}

export function readGrant(ctx: WorkspaceContext, id: unknown): PortalGrantRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM portal_grant WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as PortalGrantRow | undefined;
}

export function mapGrant(row: PortalGrantRow, day: string): PortalGrantView {
  return {
    id: row.id,
    contactId: row.contact_id,
    kind: row.kind,
    scopes: parseScopes(row.scopes),
    status: effectiveStatus(row, day),
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    revokedAt: row.revoked_at,
    lastResolvedAt: row.last_resolved_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hosted: false,
    reason: 'cloud_tier',
    localArtifact: parseArtifact(row.local_artifact_json),
  };
}

function parseArtifact(raw: string): PortalLocalArtifact {
  try {
    return JSON.parse(raw) as PortalLocalArtifact;
  } catch {
    return {
      grantId: '',
      workspaceId: '',
      contactId: '',
      kind: 'customer',
      scopes: [],
      expiresAt: '',
      hosted: false,
      reason: 'cloud_tier',
    };
  }
}

/**
 * Does entity `id` of `kind` belong to `contactId` within this workspace? The CONTACT fence, shared
 * by scope validation (create) and the resolver (read), so the two can never diverge. Airtight per
 * kind: an invoice/quote is a `document` row whose `contact_id` matches; a `document` (E00 file) is
 * one linked directly to the contact OR to one of the contact's own documents.
 */
function entityBelongsToContact(
  ctx: WorkspaceContext,
  kind: 'invoice' | 'quote' | 'document',
  id: string,
  contactId: string,
): boolean {
  if (kind === 'invoice' || kind === 'quote') {
    const row = ctx.store.db
      .prepare("SELECT contact_id FROM document WHERE workspace_id = ? AND id = ? AND type = ?")
      .get(ctx.workspaceId, id, kind) as { contact_id: string | null } | undefined;
    return row !== undefined && row.contact_id === contactId;
  }
  // kind === 'document' (an E00 stored_file): linked to the contact, or to one of its documents.
  const file = ctx.store.db
    .prepare('SELECT entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { entity_kind: string | null; entity_id: string | null } | undefined;
  if (file === undefined) return false;
  if (file.entity_kind === 'contact' && file.entity_id === contactId) return true;
  if ((file.entity_kind === 'document' || file.entity_kind === 'quote') && typeof file.entity_id === 'string') {
    const doc = ctx.store.db
      .prepare('SELECT contact_id FROM document WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, file.entity_id) as { contact_id: string | null } | undefined;
    return doc !== undefined && doc.contact_id === contactId;
  }
  return false;
}

// --- Create --------------------------------------------------------------------------------------

/**
 * What a caller may pass to `portal_grant_create`. `kind` is NOT an input (D157): it is listed only so
 * the refusal is typed. Anything but `undefined` or `'customer'` is refused with
 * `invalid_input {field:'kind'}` before any write, because a caller who could name the kind could mint
 * a vendor grant, which is live at mint, and skip the send. `sent_at`, `minted_draft` and `status` are
 * never read from input at all.
 */
export interface CreateGrantInput {
  contactId: string;
  scopes: PortalScope[];
  expiresAt: string;
  kind?: unknown;
  actor?: string;
  idempotencyKey?: string;
}

/** The engine-chosen part of a mint: never derived from caller input. */
interface MintOptions {
  kind: PortalGrantKind;
  /** Stamp `sent_at` at mint (a vendor grant, owner decision 2), or leave the grant a draft. */
  sentAtMint: boolean;
  /**
   * The idempotency namespace this door stores and recalls under (critic F2): `portal_grant_create`
   * for the customer door, `vendor_portal_grant` for the vendor door. A key prefix alone does not
   * separate the doors, because a caller can send the prefixed string as its own key.
   */
  verb: 'portal_grant_create' | 'vendor_portal_grant';
}

/** The kind a stored create result carries, or undefined for a refusal (which is never memoised). */
function storedGrantKind(prior: Result): string | undefined {
  const grant = (prior as unknown as { grant?: { kind?: unknown } }).grant;
  return typeof grant?.kind === 'string' ? grant.kind : undefined;
}

/** The caller-supplied part of a mint, copied field by field so no other input key can reach a row. */
interface MintInput {
  contactId: unknown;
  scopes: unknown;
  expiresAt: unknown;
  idempotencyKey?: unknown;
}

/**
 * Mint a scoped, expiring, tokened grant. PRIVATE: the kind and the hand-over are the engine's choice
 * (`opts`), reachable only through `createGrant` (customer, a draft) and `createVendorGrant` (vendor,
 * handed over at mint). Every scope ref is validated to belong to `contactId` within the workspace
 * BEFORE any write (so an invalid scope leaves zero rows). The token is CSPRNG >=256-bit; only its
 * SHA-256 is persisted, and the row's artifact carries NO token. The one-time link is returned exactly
 * once as `tokenOnce` / `localLink`. Every row this writes carries `minted_draft = 1` (D157).
 */
function mintGrant(ctx: WorkspaceContext, input: MintInput, opts: MintOptions): Result {
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;
  // Replay FIRST (the E01 pattern): a retried create answers the original grant rather than minting
  // a second token for the same key (§H-IDEMPOTENT).
  if (idempotencyKey !== undefined) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, idempotencyKey, opts.verb);
    if (prior !== undefined) {
      // A door only ever replays its OWN kind (critic F2): a stored result of the other kind under
      // this key is refused, never handed out with its one-time token.
      if (storedGrantKind(prior) !== opts.kind) {
        return err('idempotency_key_conflict', { idempotencyKey, reason: 'this key belongs to another kind of grant' });
      }
      return prior;
    }
  }

  if (typeof input.contactId !== 'string' || input.contactId.length === 0) {
    return err('invalid_input', { field: 'contactId' });
  }
  const contactId = input.contactId;
  const kind = opts.kind;

  // The contact must exist in THIS workspace (§H-TENANT): a foreign contact is refused, not silently
  // scoped across tenants.
  const contact = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { id: string } | undefined;
  if (contact === undefined) return err('contact_not_found', { contactId });

  // Expiry must be a valid future day (spec §2 error: a past expiry is refused, never created loosely).
  if (!isIsoDay(input.expiresAt)) return err('invalid_input', { field: 'expiresAt' });
  const day = today(ctx);
  if (input.expiresAt < day) return err('expiry_in_past', { expiresAt: input.expiresAt, today: day });

  // Boundary (spec §2): a validity longer than the max is CLAMPED and flagged, never refused.
  const maxExpiry = addDays(day, PORTAL_MAX_VALIDITY_DAYS);
  const clamped = input.expiresAt > maxExpiry;
  const expiresAt = clamped ? maxExpiry : input.expiresAt;

  // SCOPE VALIDATION, entirely before any write (tx-atomicity: an invalid scope writes zero rows).
  const scopesInput: unknown[] = Array.isArray(input.scopes) ? input.scopes : [];
  if (scopesInput.length === 0) return err('invalid_scope', { reason: 'a grant must name at least one scope' });
  const scopes: PortalScope[] = [];
  for (const [index, scope] of scopesInput.entries()) {
    const position = index + 1;
    if (scope === null || typeof scope !== 'object' || !isPortalScopeKind((scope as PortalScope).kind)) {
      return err('invalid_scope', { position, reason: 'kind must be one of PORTAL_SCOPE_KINDS', allowed: [...PORTAL_SCOPE_KINDS] });
    }
    const scopeKind = (scope as PortalScope).kind;
    // WILDCARD scopes (`all_invoices`, F03's `pos.read`/`remittance.read`) carry no id and pass no
    // per-entity contact fence here: the fence they ride is the grant's own `contact_id` at read
    // time (F02's resolver for `all_invoices`, F03's vendor read verbs for the vendor set).
    if (isPortalWildcardScopeKind(scopeKind)) {
      scopes.push({ kind: scopeKind });
      continue;
    }
    const scopeId = (scope as PortalScope).id;
    if (typeof scopeId !== 'string' || scopeId.length === 0) {
      return err('invalid_scope', { position, kind: scopeKind, reason: 'an entity scope needs an id' });
    }
    if (!entityBelongsToContact(ctx, scopeKind, scopeId, contactId)) {
      // The CONTACT fence at write time: a scope may never reference an entity that is not this
      // contact's own, so a grant is never created loosely (spec §2 US-F02.1 error / US-F02.5).
      return err('invalid_scope', { position, kind: scopeKind, id: scopeId, reason: 'not this contact\'s record' });
    }
    scopes.push({ kind: scopeKind, id: scopeId });
  }

  const run = (): Result => {
    const id = ctx.ids.next('pgrant');
    const now = ctx.clock.now();
    const token = mintToken();
    const artifact: PortalLocalArtifact = {
      grantId: id,
      workspaceId: ctx.workspaceId,
      contactId,
      kind,
      scopes,
      expiresAt,
      hosted: false,
      reason: 'cloud_tier',
    };
    // `minted_draft` is NAMED and written as 1 here, never left to the column's DEFAULT 0, which would
    // read as a pre-D157 grant and open at once (the structural guard in grant-liveness.test.mjs).
    ctx.store.db
      .prepare(
        `INSERT INTO portal_grant (
           id, workspace_id, contact_id, kind, token_hash, scopes, expires_at, sent_at, revoked_at,
           minted_draft, last_resolved_at, local_artifact_json, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        contactId,
        kind,
        hashToken(token),
        JSON.stringify(scopes),
        expiresAt,
        opts.sentAtMint ? now : null,
        JSON.stringify(artifact),
        ctx.actor,
        now,
        now,
      );
    ctx.audit.record({ entityKind: 'portal_grant', entityId: id, action: 'create', actor: ctx.actor, at: now });
    const row = readGrant(ctx, id) as PortalGrantRow;
    return ok({
      grantId: id,
      grant: mapGrant(row, day),
      // The ONE-TIME artifacts, returned in memory only and never persisted (spec §3/§4).
      tokenOnce: token,
      localLink: `/portal?token=${token}`,
      clamped,
      hosted: false,
      reason: 'cloud_tier',
    });
  };

  if (idempotencyKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, opts.verb, run);
  }
  return ctx.store.tx(run);
}

/**
 * Mint a customer grant as a DRAFT (`portal_grant_create`). P8 and D157: the grant is created inactive
 * (`sent_at` null, status `draft`) and its token opens nothing until `sendGrant` hands it over. The
 * kind is fixed to `customer`: an `input.kind` other than undefined or `'customer'` is refused before
 * any write (a vendor grant is live at mint, so naming the kind would skip the send).
 */
export function createGrant(ctx: WorkspaceContext, input: CreateGrantInput): Result {
  if (input.kind !== undefined && input.kind !== 'customer') {
    return err('invalid_input', { field: 'kind', reason: 'portal_grant_create mints customer grants only; a supplier link is vendor_portal_grant' });
  }
  return mintGrant(
    ctx,
    { contactId: input.contactId, scopes: input.scopes, expiresAt: input.expiresAt, idempotencyKey: input.idempotencyKey },
    { kind: 'customer', sentAtMint: false, verb: 'portal_grant_create' },
  );
}

/** What `createVendorGrant` takes. The scopes default to the vendor set; the kind is not an input. */
export interface CreateVendorGrantInput {
  contactId: string;
  scopes: PortalScope[];
  expiresAt: string;
  idempotencyKey?: string;
}

/**
 * Mint a VENDOR grant, handed over at mint (owner decision 2, D157: a supplier link is live when it is
 * granted; `vendor_portal_grant` is the governed hand-over). The SUPPLIER fence lives here, beside the
 * one place the vendor kind is chosen: the contact must be a supplier (`party_role IN
 * ('vendor','both')`), so a customer contact is never handed a vendor grant (spec F03 §2 US-F03.1
 * error: `contact_not_found`, the same opaque code a missing contact returns). The caller namespaces
 * the idempotency key (`vendorPortalGrant` passes `['vendor', key]`). NOT exported from the barrel:
 * the only door to it is `vendor_portal_grant`.
 */
export function createVendorGrant(ctx: WorkspaceContext, input: CreateVendorGrantInput): Result {
  if (typeof input.contactId !== 'string' || input.contactId.length === 0) {
    return err('invalid_input', { field: 'contactId' });
  }
  // The SUPPLIER fence, a pre-check before any write. A contact that is not a vendor (or does not
  // exist) is refused with the single opaque `contact_not_found` (spec §2: no customer/vendor oracle).
  const contact = ctx.store.db
    .prepare('SELECT party_role FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.contactId) as { party_role: string } | undefined;
  if (contact === undefined || (contact.party_role !== 'vendor' && contact.party_role !== 'both')) {
    return err('contact_not_found', { contactId: input.contactId });
  }
  // The VENDOR SCOPE fence (critic F1), a pre-check before any write: a vendor grant is live at mint,
  // so it may name only the vendor read set. A customer scope (`all_invoices`, `invoice`, `quote`,
  // `document`) on it would open a customer's records with no send step.
  const scopesInput: unknown[] = Array.isArray(input.scopes) ? input.scopes : [];
  for (const [index, scope] of scopesInput.entries()) {
    const kind = scope !== null && typeof scope === 'object' ? (scope as { kind?: unknown }).kind : undefined;
    if (typeof kind !== 'string' || !(VENDOR_PORTAL_SCOPE_KINDS as readonly string[]).includes(kind)) {
      return err('invalid_scope', { position: index + 1, reason: 'a supplier grant names only the vendor scopes', allowed: [...VENDOR_PORTAL_SCOPE_KINDS] });
    }
  }
  // The vendor door's replays. Its own namespace first; then, for a replay stored before the
  // namespaces were split (D157), the shared `portal_grant_create` one.
  //
  // THE LEGACY REPLAY HAS A CUTOFF (D165, independent critic A2-1). Since D157 `portal_grant_create`
  // mints CUSTOMER grants only (`createGrant`), so a VENDOR result in the shared scope can only have
  // been written by a build from before the split: that, and only that, is replayed. Anything else
  // there was written by the free customer verb, possibly by an agent seat under `["vendor",K]` while
  // the person's `vendor_portal_grant {K}` Vorschlag waited, and until D165 it made the approval refuse
  // `idempotency_key_conflict` for good: a public verb decided the outcome of a governed one. It is
  // now not consulted at all; the vendor door mints its own grant in its own scope, never adopting
  // the customer grant (the K1 defect) and never refusing over it.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const own = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'vendor_portal_grant');
    if (own === undefined) {
      const legacy = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'portal_grant_create');
      if (legacy !== undefined && storedGrantKind(legacy) === 'vendor') return legacy;
    }
  }
  return mintGrant(
    ctx,
    { contactId: input.contactId, scopes: input.scopes, expiresAt: input.expiresAt, idempotencyKey: input.idempotencyKey },
    { kind: 'vendor', sentAtMint: true, verb: 'vendor_portal_grant' },
  );
}

// --- Send (P8 draft-gated outbound) --------------------------------------------------------------

/**
 * Hand the grant link over (US-F02.1). P8: the grant is created `draft` and this is the outbound
 * moment, so it confirm-gates for human and agent callers identically. D157: this is what ACTIVATES
 * the link: until `sent_at` is stamped here, the token of a grant minted since D157 opens nothing. OP4:
 * the OSS core produces the local artifact and STOPS, and there is no relay in the MIT core, so send
 * degrades honestly to `sent:false, reason:'cloud_tier'` and activates the grant (draft -> active)
 * without transmitting.
 * The token/link is NOT re-derivable here (only its hash is stored), which is the OP4 boundary made
 * structural: the operator received the one-time link at create.
 */
export function sendGrant(
  ctx: WorkspaceContext,
  input: { grantId: string; confirmed?: boolean; idempotencyKey?: string },
): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.grantId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'portal_grant_send');
    if (replayed !== undefined) return replayed;
  }

  const row = readGrant(ctx, input.grantId);
  if (row === undefined) return err('not_found', { grantId: input.grantId });
  const day = today(ctx);
  // Pre-checks BEFORE any write (tx-atomicity): a revoked or expired grant cannot be sent.
  if (row.revoked_at !== null) return err('grant_revoked', { grantId: row.id });
  if (row.expires_at < day) return err('grant_expired', { grantId: row.id, expiresAt: row.expires_at });

  // P8 confirm-gate: sending is outbound, and an unconfirmed send returns the honest degradation
  // WITHOUT activating the grant (the draft stays dead), so an agent may draft freely (the E01/A11
  // shape).
  if (input.confirmed !== true) {
    return err('needs_confirmation', {
      grantId: row.id,
      sent: false,
      reason: 'outbound_send_requires_confirmation',
      confirmWith: { grantId: row.id, confirmed: true },
    });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    // Activate (draft -> active). A re-send keeps the FIRST `sent_at` (COALESCE) and re-stamps only
    // updated_at.
    ctx.store.db
      .prepare('UPDATE portal_grant SET sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'portal_grant', entityId: row.id, action: 'send', actor: ctx.actor, at: now });
    const after = readGrant(ctx, row.id) as PortalGrantRow;
    return ok({
      grantId: row.id,
      grant: mapGrant(after, today(ctx)),
      // OP4/P9: no host wired, so nothing left the device. The grant is active and ready the moment
      // a cloud tier is configured.
      sent: false,
      transmitted: false,
      hosted: false,
      reason: 'cloud_tier',
      dispatch: 'needs_dispatch_module',
    });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'portal_grant_send', run);
  }
  return ctx.store.tx(run);
}

// --- Revoke --------------------------------------------------------------------------------------

/**
 * End access immediately (US-F02.4). Stamps `revoked_at`; the row is NEVER deleted (§H-AUDIT spirit,
 * the grant history is the revDSG access trail). Revoking an already-revoked grant is a no-op that
 * returns the original state (idempotent by nature, not just by key).
 */
export function revokeGrant(
  ctx: WorkspaceContext,
  input: { grantId: string; idempotencyKey?: string },
): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.grantId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'portal_grant_revoke');
    if (replayed !== undefined) return replayed;
  }

  const row = readGrant(ctx, input.grantId);
  if (row === undefined) return err('not_found', { grantId: input.grantId });

  // Already revoked: a no-op returning the original state (spec §2 US-F02.4 empty). No write, no
  // second audit row.
  if (row.revoked_at !== null) {
    return ok({ grantId: row.id, grant: mapGrant(row, today(ctx)), alreadyRevoked: true });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('UPDATE portal_grant SET revoked_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'portal_grant', entityId: row.id, action: 'revoke', actor: ctx.actor, at: now });
    const after = readGrant(ctx, row.id) as PortalGrantRow;
    return ok({ grantId: row.id, grant: mapGrant(after, today(ctx)) });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'portal_grant_revoke', run);
  }
  return ctx.store.tx(run);
}

// --- List (P5) -----------------------------------------------------------------------------------

export interface ListGrantsFilter {
  contactId?: string;
  savedViewId?: string;
}

/**
 * The Portal-Zugang panel's read model (P5): every grant, optionally per contact, with its derived
 * status and per-grant `hosted:false` truth (spec §2 US-F02.6). The G00 saved-view seam is one
 * unconditional `applySavedView` call (the `listSignRequests` shape): the view's stored filters
 * merge UNDER the caller's explicit ones.
 */
export function listGrants(ctx: WorkspaceContext, filter: ListGrantsFilter = {}): Result {
  const viewed = applySavedView(ctx, 'portal_grant', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter as ListGrantsFilter;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.contactId !== undefined) {
    clauses.push('contact_id = ?');
    params.push(filter.contactId);
  }
  const day = today(ctx);
  const rows = ctx.store.db
    .prepare(`SELECT * FROM portal_grant WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id`)
    .all(...params) as PortalGrantRow[];
  return ok({
    grants: rows.map((r) => mapGrant(r, day)),
    total: rows.length,
    // The list carries the identical P9 truth an agent sees (spec §2 US-F02.6): no host is wired.
    hosted: false,
    reason: 'cloud_tier',
  });
}

// --- Token-authenticated verbs (depsAction: no workspace session) -------------------------------

/**
 * The store-bearing deps a token verb resolves against. The registry hands the same `ApiDeps` every
 * face uses; the token, not a workspace session, is the authorisation (the `accept_invite` shape).
 */
export interface PortalTokenDeps {
  store: SqliteStore;
  clock: Clock;
  ids: IdGen;
  actor: string;
}

/** The uniform denial (spec §2 US-F02.4 boundary): no oracle distinguishes not-found/expired/revoked. */
const GRANT_DENIED = () => err('grant_denied', {});

/**
 * Look a grant up by its presented token, across ALL workspaces (the token hash is globally unique,
 * and it is what BINDS the workspace: the hosted page knows only the token). Returns the row, or
 * undefined for a token that resolves to nothing. This is where §H-TENANT is anchored: the resolved
 * grant carries its workspace, and every downstream read uses THAT workspace id, never the caller's.
 */
function grantByToken(deps: PortalTokenDeps, token: unknown): PortalGrantRow | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  return deps.store.db
    .prepare('SELECT * FROM portal_grant WHERE token_hash = ?')
    .get(hashToken(token)) as PortalGrantRow | undefined;
}

/**
 * F03's token fence, kept HERE so token hashing is single-sourced in F02 (spec F03 §4: "F03 adds no
 * second grant implementation"). Unlike F02's `grantByToken`, this is WORKSPACE-scoped: the vendor
 * read verbs are `ctxAction`s that already bind a tenant, so the token is a SECOND fence within that
 * workspace. A token minted in another tenant (or none) resolves to `undefined` and the caller
 * denies identically (no oracle). The `kind` guard keeps the vendor verbs off customer grants.
 */
export function grantByTokenInWorkspace(
  ctx: WorkspaceContext,
  token: unknown,
  kind: string,
): PortalGrantRow | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM portal_grant WHERE workspace_id = ? AND token_hash = ? AND kind = ?')
    .get(ctx.workspaceId, hashToken(token), kind) as PortalGrantRow | undefined;
}

/**
 * Is this grant usable RIGHT NOW (not revoked, not past `day`, handed over)? Exported for F03's read
 * verbs, so they share the one D157 rule with the resolver and the derived status.
 */
export function isGrantLive(row: PortalGrantRow, day: string): boolean {
  return isLive(row, day);
}

/** Does the grant's scope list contain this wildcard scope kind? F03's per-verb scope check. */
export function grantHasScope(row: PortalGrantRow, scopeKind: string): boolean {
  return parseScopes(row.scopes).some((s) => s.kind === scopeKind);
}

/** Build a wired ctx for the grant's OWN workspace, acting as `portal:<grantId>` (spec §4). */
function ctxForGrant(deps: PortalTokenDeps, row: PortalGrantRow): WorkspaceContext {
  return makeContext(deps.store, {
    workspaceId: row.workspace_id,
    actor: `portal:${row.id}`,
    clock: deps.clock,
    ids: deps.ids,
    ...ledgerPorts({ store: deps.store, workspaceId: row.workspace_id, ids: deps.ids }),
  });
}

/**
 * The audited portal denial (revDSG access trail). It is a refusal's own record, never the act: under
 * an approval it runs under `withoutCommitMark` (D165, critic round 2 on the follow-ups), so a governed
 * `portal_quote_accept` whose grant lapsed before the person decided stays rejectable instead of being
 * marked as run and stuck.
 */
function auditDenial(ctx: WorkspaceContext, grantId: string, at: string): void {
  ctx.store.withoutCommitMark(() =>
    ctx.audit.record({ entityKind: 'portal_grant', entityId: grantId, action: 'deny', actor: ctx.actor, at }),
  );
}

/**
 * Resolve a token to exactly what it may see (spec §4, the single verb the hosted page calls). Hashes
 * the presented token, loads the grant, enforces expiry/revocation and the THREE FENCES, and returns
 * the scoped read model: invoices (number, dates, total + open amount from A11/A14, QR reference),
 * quotes (C02 state), documents (E00 metadata). Every resolve/denial lands in `audit_log`.
 *
 * F02 COMPUTES NO MONEY: open amounts come from A14's allocation read model (`listOpenItems`) as
 * integer Rappen, and the QR reference is A11's own, read verbatim via `buildQrBill` (never
 * regenerated). A read posts nothing and mints nothing.
 */
export function resolveToken(deps: PortalTokenDeps, input: { token?: unknown }): Result {
  const row = grantByToken(deps, input.token);
  if (row === undefined) return GRANT_DENIED();

  const ctx = ctxForGrant(deps, row);
  const now = ctx.clock.now();
  const day = now.slice(0, 10);

  // FENCE 0 (spec §2 US-F02.4 boundary, D157): an expired, revoked or not-yet-sent (draft) token
  // resolves to nothing, denied identically. So does a token that is not a CUSTOMER grant (critic F1):
  // a vendor grant is live at mint and must never reach the customer portal. The denial is audited
  // (revDSG access trail) and NO scoped data is read.
  if (row.kind !== 'customer' || !isLive(row, day)) {
    auditDenial(ctx, row.id, now);
    return GRANT_DENIED();
  }

  const scopes = parseScopes(row.scopes);
  const invoices: unknown[] = [];
  const quotes: unknown[] = [];
  const documents: unknown[] = [];

  // A14 open-amount read model, fetched ONCE for the contact, keyed by document id. F02 reads it, it
  // does not compute it (spec §4 money correctness).
  const openByDoc = new Map<string, number>();
  const openItems = listOpenItems(ctx, { customerId: row.contact_id });
  if (openItems.ok) {
    for (const item of (openItems as unknown as { items: { documentId: string | null; openMinor: number }[] }).items) {
      if (typeof item.documentId === 'string') openByDoc.set(item.documentId, item.openMinor);
    }
  }

  const invoiceIds = new Set<string>();
  for (const scope of scopes) {
    if (scope.kind === 'all_invoices') {
      // FENCE 2/3: every invoice belonging to THIS contact, current AND future (the explicit wildcard).
      const listed = listDocuments(ctx, { type: 'invoice', contactId: row.contact_id });
      if (listed.ok) {
        for (const d of (listed as unknown as { documents: { id: string }[] }).documents) invoiceIds.add(d.id);
      }
    } else if (scope.kind === 'invoice' && typeof scope.id === 'string') {
      // FENCE 1/2/3: the id must belong to this contact within this workspace. A guessed foreign id
      // fails the contact fence and contributes nothing (no leak, US-F02.5).
      if (entityBelongsToContact(ctx, 'invoice', scope.id, row.contact_id)) invoiceIds.add(scope.id);
    }
  }
  for (const id of invoiceIds) {
    const view = getDocument(ctx, { documentId: id });
    if (!view.ok) continue;
    const d = (view as unknown as { document: Record<string, unknown> }).document;
    let qrReference: string | null = null;
    const qr = buildQrBill(ctx, id);
    if (qr.ok) qrReference = ((qr as unknown as { qr: { reference: string } }).qr.reference) ?? null;
    invoices.push({
      id,
      number: d.number ?? null,
      status: d.status,
      issueDate: d.issueDate ?? null,
      dueDate: d.dueDate ?? null,
      currency: d.currency,
      totalMinor: d.totalMinor,
      openMinor: openByDoc.get(id) ?? null,
      qrReference,
    });
  }

  for (const scope of scopes) {
    if (scope.kind !== 'quote' || typeof scope.id !== 'string') continue;
    if (!entityBelongsToContact(ctx, 'quote', scope.id, row.contact_id)) continue;
    const view = getDocument(ctx, { documentId: scope.id });
    if (!view.ok) continue;
    const d = (view as unknown as { document: Record<string, unknown> }).document;
    quotes.push({
      id: scope.id,
      number: d.number ?? null,
      status: d.status,
      currency: d.currency,
      totalMinor: d.totalMinor,
    });
  }

  for (const scope of scopes) {
    if (scope.kind !== 'document' || typeof scope.id !== 'string') continue;
    if (!entityBelongsToContact(ctx, 'document', scope.id, row.contact_id)) continue;
    const file = ctx.store.db
      .prepare('SELECT id, title, filename, mime, bytes, sha256, storage_ref FROM stored_file WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, scope.id) as
      | { id: string; title: string; filename: string; mime: string; bytes: number; sha256: string; storage_ref: string }
      | undefined;
    if (file === undefined) continue;
    documents.push({
      id: file.id,
      title: file.title,
      filename: file.filename,
      mime: file.mime,
      bytes: file.bytes,
      sha256: file.sha256,
      storageRef: file.storage_ref,
    });
  }

  // Stamp the resolve and audit it (spec §3: every resolve lands in audit_log).
  ctx.store.db
    .prepare('UPDATE portal_grant SET last_resolved_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
    .run(now, now, ctx.workspaceId, row.id);
  ctx.audit.record({ entityKind: 'portal_grant', entityId: row.id, action: 'view', actor: ctx.actor, at: now });

  return ok({
    grantId: row.id,
    contactId: row.contact_id,
    // Minimisation (spec §3): only the scoped records, no contact master data beyond what the caller
    // already named. Money figures pass through as integer Rappen, formatted at the cloud-tier edge.
    invoices,
    quotes,
    documents,
    hosted: false,
    reason: 'cloud_tier',
  });
}

/**
 * Accept a quote through the portal (US-F02.3). Fence-checks the token (the quote must be in scope
 * AND belong to the grant's contact), then DELEGATES to C02's real `acceptQuote` with
 * `actor:'portal:<grantId>'`. F02 owns no quote state: the C02 `sent -> accepted` transition, its
 * figure freeze and its follow-on are untouched, and idempotency is C02's (a same-key re-accept
 * returns the original, never a second acceptance, so no double-issue).
 *
 * TX-ATOMICITY: every fence is a PRE-CHECK before the delegation, so a refused accept writes zero
 * rows and mints no invoice. The delegation itself runs inside C02's own throw-on-err transaction.
 */
export function portalQuoteAccept(
  deps: PortalTokenDeps,
  input: { token?: unknown; quoteId?: unknown; idempotencyKey?: string },
): Result {
  const row = grantByToken(deps, input.token);
  if (row === undefined) return GRANT_DENIED();

  const ctx = ctxForGrant(deps, row);
  const now = ctx.clock.now();
  const day = now.slice(0, 10);

  // FENCE 0: expired, revoked, a draft (D157) or not a customer grant (critic F1) denies identically,
  // and the attempt is audited. A pre-check: the quote is not touched.
  if (row.kind !== 'customer' || !isLive(row, day)) {
    auditDenial(ctx, row.id, now);
    return GRANT_DENIED();
  }

  const quoteId = input.quoteId;
  if (typeof quoteId !== 'string' || quoteId.length === 0) {
    return err('invalid_input', { field: 'quoteId' });
  }

  // FENCE 1/2/3: the quote must be named by a `quote` scope AND belong to this contact. A quote not
  // in scope (or another contact's, by guessed id) is denied WITHOUT touching it (US-F02.5), and the
  // attempt is audited. This is a pre-check: zero rows written on refusal.
  const scopes = parseScopes(row.scopes);
  const inScope = scopes.some((s) => s.kind === 'quote' && s.id === quoteId);
  if (!inScope || !entityBelongsToContact(ctx, 'quote', quoteId, row.contact_id)) {
    auditDenial(ctx, row.id, now);
    return GRANT_DENIED();
  }

  // Read the quote's status BEFORE delegating, so the portal-side audit fires ONCE, on the genuine
  // `sent -> accepted` transition, and never again on an idempotent replay (a second same-key call
  // finds the quote already `accepted`, C02 replays without writing, and this audit is skipped): a
  // replayed accept must change ZERO rows, audit included.
  const before = getDocument(ctx, { documentId: quoteId });
  const preStatus = before.ok ? String((before as unknown as { document: { status: string } }).document.status) : null;

  // SECURITY: scope the external caller's raw idempotencyKey by grant AND quote BEFORE it reaches C02.
  // C02's `acceptQuote` memoises under `(workspace_id, key, 'quotes_accept')`, a namespace SHARED with
  // the operator `quotes_accept` verb and with every other grant's portal accept in the workspace. A
  // raw key forwarded verbatim would let a replay return a DIFFERENT quote's or contact's stored result
  // across the grantee fence (an operator's key='shared' colliding with a portal caller's, or the same
  // grant's key reused across two quotes). We mirror sendGrant/revokeGrant, which scope by grant via
  // `JSON.stringify([grantId, key])` (this file, ~L392/L457), and add the quote id so the derived key
  // can only ever collide with the SAME grant's SAME quote: a replay never crosses grantee or quote.
  const scopedIdempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([row.id, quoteId, input.idempotencyKey])
      : undefined;

  // DELEGATE to C02's REAL accept (the A10 sent -> accepted transition). Never a hand-rolled invoice:
  // F02 opens no posting path and forks no lifecycle. C02's own error (e.g. invalid_transition on a
  // non-sent quote, quote_expired) surfaces unchanged. Idempotent via the grant/quote-scoped key above.
  //
  // K1 (04.10.2026): scoping the KEY was not enough. A wire key is any string, so an operator
  // `quotes_accept` under the key `["<grant>","<quote>","K"]` (on any quote) landed exactly where this
  // call looks, and the portal accept replayed it. The delegated accept now memoises in this
  // composite's own idempotency scope (`portal_quote_accept>quotes_accept`), which no public verb writes.
  //
  // The accept and its portal-side audit commit as ONE unit (D165 round 2: the mid-act crash census
  // found that a death between the two left an accepted quote whose replay, finding it no longer
  // `sent`, never wrote the portal attribution). A refusal from C02 writes nothing, so returning it
  // from inside the transaction commits nothing.
  const accepted = ctx.store.tx(() => {
    const result = ctx.store.innerWrite('portal_quote_accept', () =>
      acceptQuote(ctx, {
        quoteId,
        actor: `portal:${row.id}`,
        ...(scopedIdempotencyKey !== undefined ? { idempotencyKey: scopedIdempotencyKey } : {}),
      }),
    );
    // Audit the portal-side attribution ONLY on the real transition (spec §3/§7: the accept lands in
    // audit_log). The C02 transition keeps its own trail; this is the portal act, written once.
    if (result.ok && preStatus === 'sent') {
      ctx.audit.record({ entityKind: 'portal_grant', entityId: row.id, action: 'accept', actor: ctx.actor, at: ctx.clock.now() });
    }
    return result;
  });
  if (!accepted.ok) return accepted;

  return ok({
    grantId: row.id,
    quoteId,
    ...(accepted as unknown as Record<string, unknown>),
  });
}
