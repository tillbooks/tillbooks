/**
 * F03, the vendor portal: the CREDITOR-side mirror of F02. It lets a supplier (or their agent) see
 * exactly their own open purchase orders (D02) and a remittance advice for each payment made to them
 * (A14 settling A17 bills), and nothing else. The OSS core mints the grant and the advice as LOCAL
 * artifacts and stops (OP4); hosting the portal and notifying the supplier are cloud-tier.
 *
 * WHAT THIS MODULE IS. Three thin operator wrappers over F02's shared grant machinery
 * (`vendorPortalGrant`/`vendorPortalRevoke`/`vendorPortalGrantsList`, all `kind='vendor'`, no second
 * token implementation, spec §4), two scoped READ MODELS over D02 and over the advices, and ONE
 * derived-document write (`createRemittanceAdvice`).
 *
 * WHAT THIS MODULE IS NOT. It NEVER posts and NEVER computes money (spec §4/§7, asserted by
 * `test/portal/vendor-no-money-path.test.mjs`): a remittance advice is a POINT-IN-TIME SNAPSHOT of
 * A14 allocation figures copied as integer-Rappen VALUES, never recomputed, and the payment it
 * describes was already posted by A14. There is no `postEntry`/`recordPayment` import anywhere below.
 *
 * THE THREE FENCES (spec §2 US-F03.2, the isolation invariant this capability exists for):
 *   1. WORKSPACE (§H-TENANT): every read is `ctxAction`-scoped, so it runs against ONE workspace, and
 *      the token read additionally requires `token_hash AND workspace_id AND kind='vendor'`, so a
 *      token minted in another tenant resolves to nothing.
 *   2. CONTACT: the effective supplier is the GRANT's own `contact_id` (token path) or the operator's
 *      explicit `contactId` (preview path). A grant for supplier X can never read supplier Y's rows.
 *   3. SCOPE: the PO read requires the grant to carry `pos.read`; the advice read requires
 *      `remittance.read`.
 * An expired or revoked token denies as `grant_invalid`, indistinguishably (no oracle, spec §2).
 *
 * TX-ATOMICITY (the C02/D03/F02 bug class). `better-sqlite3`'s transaction rolls back only when the
 * function THROWS: a write-then-return-`{ok:false}` COMMITS the partial write. Every refusal here is
 * a PRE-CHECK before any write, so a rejected verb writes ZERO rows.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { uploadFile, linkFile } from '../files/index.js';
import { applySavedView } from '../customization/views.js';
import {
  createGrant,
  revokeGrant,
  listGrants,
  readGrant,
  grantByTokenInWorkspace,
  isGrantLive,
  grantHasScope,
} from './grants.js';
import type { PortalScope } from './grants.js';
import { VENDOR_PORTAL_SCOPE_KINDS } from './enums.js';

// --- Shared helpers ------------------------------------------------------------------------------

/** The bare day (YYYY-MM-DD) of the injected clock. */
function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** The uniform token denial (spec §2 US-F03.2 error): no oracle for expired vs revoked vs never. */
const GRANT_INVALID = () => err('grant_invalid', {});

// --- Grant lifecycle wrappers (F02's shared verbs, kind='vendor') --------------------------------

export interface VendorPortalGrantInput {
  contactId: string;
  expiresAt: string;
  scopes?: { kind: string; id?: string | null }[];
  actor?: string;
  idempotencyKey?: string;
}

/**
 * Mint a scoped, expiring vendor grant (US-F03.1). A THIN wrapper over F02's `createGrant` with
 * `kind='vendor'` and the vendor scope set (`pos.read`, `remittance.read`) as the default: F03 opens
 * no second grant path (spec §4). The one extra fence F03 adds is that the contact must be a SUPPLIER
 * (`party_role IN ('vendor','both')`), so a customer contact cannot be handed a vendor grant
 * (spec §2 US-F03.1 error: `contact_not_found`, the same opaque code a missing contact returns).
 */
export function vendorPortalGrant(ctx: WorkspaceContext, input: VendorPortalGrantInput): Result {
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
  // Pass the scopes through to F02's `createGrant`, which is the ONE validator (it rejects an unknown
  // scope kind, so the cast here cannot smuggle a bad value past the enum check).
  const scopes = (
    Array.isArray(input.scopes) && input.scopes.length > 0
      ? input.scopes
      : VENDOR_PORTAL_SCOPE_KINDS.map((kind) => ({ kind }))
  ) as unknown as PortalScope[];
  // NAMESPACE the idempotency key before it reaches F02's `createGrant`, which memoises under the
  // FIXED verb `'portal_grant_create'` SHARED with the customer `portal_grant_create` door. A raw key
  // reused across the two audiences would replay a customer grant for a vendor request (the F02
  // critic's cross-namespace idempotency finding, one audience over). Prefixing keeps the vendor
  // keyspace disjoint: a vendor replay still returns the same grant, and it can never collide with a
  // customer grant's stored result.
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify(['vendor', input.idempotencyKey])
      : undefined;
  return createGrant(ctx, {
    contactId: input.contactId,
    scopes,
    expiresAt: input.expiresAt,
    kind: 'vendor',
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    ...(scopedKey !== undefined ? { idempotencyKey: scopedKey } : {}),
  });
}

/**
 * Revoke a vendor grant (US-F03.4). A wrapper over F02's `revokeGrant`, fenced to `kind='vendor'` so
 * the vendor verb never touches a customer grant: a non-vendor id returns `not_found`, the same code
 * a missing grant returns (revokeGrant's own contract), so the vendor and customer grant spaces stay
 * separate through their own verbs.
 */
export function vendorPortalRevoke(
  ctx: WorkspaceContext,
  input: { grantId: string; actor?: string; idempotencyKey?: string },
): Result {
  const row = readGrant(ctx, input.grantId);
  if (row === undefined || row.kind !== 'vendor') return err('not_found', { grantId: input.grantId });
  return revokeGrant(ctx, {
    grantId: input.grantId,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

/**
 * List the vendor grants (US-F03.1/4), P5. Reuses F02's `listGrants` (so the G00 saved-view seam is
 * shared, one `applySavedView` call there) and filters to `kind='vendor'` plus an optional status.
 */
export function vendorPortalGrantsList(
  ctx: WorkspaceContext,
  input: { contactId?: string; status?: string; savedViewId?: string } = {},
): Result {
  const listed = listGrants(ctx, {
    ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!listed.ok) return listed;
  const all = (listed as unknown as { grants: { kind: string; status: string }[] }).grants;
  const grants = all.filter(
    (g) => g.kind === 'vendor' && (input.status === undefined || g.status === input.status),
  );
  return ok({ grants, total: grants.length, hosted: false, reason: 'cloud_tier' });
}

// --- Scoped read models (P5) ---------------------------------------------------------------------

/**
 * Resolve the effective supplier contact id for a scoped read: from the grant token (fences on the
 * grant's own contact) or from the operator's explicit `contactId` (the workspace-scoped drawer
 * preview). Returns a Result carrying `{ contactId }` on success, or the uniform denial.
 *
 * `requiredScope` is the wildcard scope the grant must carry (`pos.read` / `remittance.read`), so a
 * grant scoped to advices only cannot read POs and vice versa.
 */
function resolveSupplier(
  ctx: WorkspaceContext,
  input: { grantToken?: unknown; contactId?: unknown },
  requiredScope: string,
): Result {
  if (typeof input.grantToken === 'string' && input.grantToken.length > 0) {
    const row = grantByTokenInWorkspace(ctx, input.grantToken, 'vendor');
    if (row === undefined) return GRANT_INVALID();
    // FENCE 0: an expired or revoked token denies identically (spec §2, no oracle).
    if (!isGrantLive(row, today(ctx))) return GRANT_INVALID();
    // FENCE 3 (scope): the grant must carry the scope this read needs.
    if (!grantHasScope(row, requiredScope)) return GRANT_INVALID();
    return ok({ contactId: row.contact_id });
  }
  // The operator preview path: a workspace-scoped, A24-gated read by an explicit contact id.
  if (typeof input.contactId === 'string' && input.contactId.length > 0) {
    return ok({ contactId: input.contactId });
  }
  return err('invalid_input', { field: 'grantToken|contactId' });
}

/**
 * The supplier's open purchase orders (US-F03.2), a pure read model over D02. Filters
 * `supplier_contact_id = <effective supplier>`, `status IN ('sent','received')`, `workspace_id`
 * (§H-TENANT). Draft/closed/cancelled POs are NEVER exposed (D02 internal state). Reads nothing but
 * D02 rows and mutates none.
 */
export function vendorPortalListPOs(
  ctx: WorkspaceContext,
  input: { grantToken?: unknown; contactId?: unknown },
): Result {
  const resolved = resolveSupplier(ctx, input, 'pos.read');
  if (!resolved.ok) return resolved;
  const contactId = (resolved as unknown as { contactId: string }).contactId;

  const pos = ctx.store.db
    .prepare(
      `SELECT id, number, supplier_contact_id, status, currency, total_rappen, total_base_rappen,
              fx_rate, expected_on
         FROM purchase_order
        WHERE workspace_id = ? AND supplier_contact_id = ? AND status IN ('sent', 'received')
        ORDER BY created_at DESC, id DESC`,
    )
    .all(ctx.workspaceId, contactId) as Record<string, unknown>[];

  const byPo = ctx.store.db.prepare(
    `SELECT item_id, description, qty, unit_price_rappen, unit_price_base_rappen, received_qty
       FROM po_line WHERE workspace_id = ? AND po_id = ? ORDER BY sort, id`,
  );
  const out = pos.map((po) => {
    const lines = byPo.all(ctx.workspaceId, po.id) as Record<string, unknown>[];
    return {
      id: po.id,
      number: po.number,
      supplierContactId: po.supplier_contact_id,
      status: po.status,
      currency: po.currency,
      totalRappen: po.total_rappen,
      totalBaseRappen: po.total_base_rappen,
      fxRate: po.fx_rate,
      expectedOn: po.expected_on,
      lines: lines.map((l) => ({
        itemId: l.item_id,
        description: l.description,
        qty: l.qty,
        unitPriceRappen: l.unit_price_rappen,
        unitPriceBaseRappen: l.unit_price_base_rappen,
        receivedQty: l.received_qty,
      })),
    };
  });
  return ok({ pos: out, total: out.length });
}

/** Map one advice header row to the wire shape. */
function mapAdvice(ctx: WorkspaceContext, row: RemittanceAdviceRow): Record<string, unknown> {
  const lines = ctx.store.db
    .prepare(
      `SELECT bill_id, amount_rappen, currency, amount_base_rappen, fx_rate, sort
         FROM remittance_advice_line WHERE workspace_id = ? AND advice_id = ? ORDER BY sort, id`,
    )
    .all(ctx.workspaceId, row.id) as Record<string, unknown>[];
  return {
    id: row.id,
    paymentId: row.payment_id,
    supplierContactId: row.supplier_contact_id,
    paymentDate: row.payment_date,
    totalRappen: row.total_rappen,
    currency: row.currency,
    totalBaseRappen: row.total_base_rappen,
    fxRate: row.fx_rate,
    artifactDocumentId: row.artifact_document_id,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    lines: lines.map((l) => ({
      billId: l.bill_id,
      amountRappen: l.amount_rappen,
      currency: l.currency,
      amountBaseRappen: l.amount_base_rappen,
      fxRate: l.fx_rate,
    })),
  };
}

/**
 * The supplier's remittance advices (US-F03.3 portal read), P5, same fences as `vendorPortalListPOs`.
 * Requires the `remittance.read` scope on the token path.
 */
export function vendorPortalListRemittances(
  ctx: WorkspaceContext,
  input: { grantToken?: unknown; contactId?: unknown; savedViewId?: string },
): Result {
  const resolved = resolveSupplier(ctx, input, 'remittance.read');
  if (!resolved.ok) return resolved;
  const contactId = (resolved as unknown as { contactId: string }).contactId;
  // The G00 saved-view seam (OP10): one unconditional `applySavedView` call over the `remittance_advice`
  // kind (the `listGrants` shape). A view's stored presets are for the advice history's layout; the
  // supplier CONTACT fence above is never widened by a view, so a saved view cannot cross the tenant
  // or contact isolation this capability exists to hold.
  const viewed = applySavedView(ctx, 'remittance_advice', input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {});
  if (!viewed.ok) return viewed;
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM remittance_advice
        WHERE workspace_id = ? AND supplier_contact_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(ctx.workspaceId, contactId) as RemittanceAdviceRow[];
  return ok({ advices: rows.map((r) => mapAdvice(ctx, r)), total: rows.length });
}

// --- Remittance advice (the one derived-document write) -----------------------------------------

interface RemittanceAdviceRow {
  id: string;
  workspace_id: string;
  payment_id: string;
  supplier_contact_id: string;
  payment_date: string;
  total_rappen: number;
  currency: string;
  total_base_rappen: number;
  fx_rate: string | null;
  artifact_document_id: string | null;
  supersedes_id: string | null;
  created_by: string;
  created_at: string;
}

interface PaymentRow {
  id: string;
  direction: string;
  date: string;
  currency: string;
  fx_rate: string | null;
  counterparty_id: string | null;
  reversed_at: string | null;
}

interface VendorAllocRow {
  target_id: string;
  amount_minor: number;
  payment_amount_minor: number;
  base_amount_minor: number;
  bill_currency: string;
  supplier_contact_id: string;
}

export interface CreateRemittanceAdviceInput {
  paymentId: string;
  actor?: string;
  idempotencyKey?: string;
}

/**
 * File a remittance advice for a supplier payment (US-F03.3). Reads the A14 payment and its
 * `payment_allocation` rows against A17 vendor bills, SNAPSHOTS each into a `remittance_advice_line`
 * (integer-Rappen values copied verbatim, §H-FX at row level), and files a rendered advice artifact
 * into E00. It POSTS NOTHING: A14 already posted the payment.
 *
 * Idempotency (spec §2 US-F03.3 boundary): with a key, a replay returns the SAME advice; WITHOUT a
 * key, a re-file supersedes the current advice for the payment (`supersedes_id`), never a silent
 * overwrite. Every refusal (payment missing, not an outgoing supplier settlement, no vendor-bill
 * allocation) is a PRE-CHECK before any write (tx-atomicity), returning the opaque `payment_not_found`
 * (spec §2: no cross-supplier oracle).
 */
export function createRemittanceAdvice(ctx: WorkspaceContext, input: CreateRemittanceAdviceInput): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.paymentId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'remittance_advice_create');
    if (prior !== undefined) return prior;
  }

  if (typeof input.paymentId !== 'string' || input.paymentId.length === 0) {
    return err('invalid_input', { field: 'paymentId' });
  }

  // The payment must exist in THIS workspace (§H-TENANT) and be an OUTGOING settlement (money paid TO
  // a supplier). Anything else is the opaque `payment_not_found` (no oracle). The supplier is derived
  // from the SETTLED BILLS below, not from `counterparty_id`, which is null on a fully-allocated
  // payment (A14 requires a counterparty only when a remainder is parked).
  const payment = ctx.store.db
    .prepare('SELECT id, direction, date, currency, fx_rate, counterparty_id, reversed_at FROM payment WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.paymentId) as PaymentRow | undefined;
  if (payment === undefined || payment.direction !== 'outgoing') {
    return err('payment_not_found', { paymentId: input.paymentId });
  }

  // The A17 vendor-bill allocations this payment settled, joined to the bill for its currency AND its
  // supplier. A payment with no vendor-bill allocation (pure on-account, or a customer payment) has
  // nothing to advise: opaque `payment_not_found` (spec §2).
  const allocs = ctx.store.db
    .prepare(
      `SELECT a.target_id AS target_id, a.amount_minor AS amount_minor,
              a.payment_amount_minor AS payment_amount_minor, a.base_amount_minor AS base_amount_minor,
              b.currency AS bill_currency, b.contact_id AS supplier_contact_id
         FROM payment_allocation a
         JOIN vendor_bill b ON b.id = a.target_id AND b.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.payment_id = ? AND a.target_kind = 'vendor_bill'
        ORDER BY a.created_at, a.id`,
    )
    .all(ctx.workspaceId, input.paymentId) as VendorAllocRow[];
  if (allocs.length === 0) return err('payment_not_found', { paymentId: input.paymentId });

  // A remittance advice is per-supplier: every settled bill must belong to ONE supplier (the normal
  // case, one payment to one vendor). A payment spanning vendors cannot be one advice, so it is
  // refused before any write (an honest, distinct code, not an oracle: it names a shape, not an id).
  let supplierContactId = '';
  for (const a of allocs) {
    if (supplierContactId === '') supplierContactId = a.supplier_contact_id;
    else if (a.supplier_contact_id !== supplierContactId) {
      return err('multiple_suppliers', { paymentId: input.paymentId });
    }
  }

  const base = baseCurrencyOf(ctx);

  // Compute the header and line snapshots BEFORE any write (integer arithmetic only: sums, never a
  // division, so there is no rounding point, spec §4 P2 trivially holds).
  const lines = allocs.map((a) => {
    const isBase = a.bill_currency === base;
    return {
      billId: a.target_id,
      amountRappen: a.amount_minor,
      currency: a.bill_currency,
      // §H-FX at row level: the CHF base is the allocation's OWN booked base, and the rate is '1' for a
      // base-currency line or the payment's own rate for a foreign one (snapshot, never re-derived).
      amountBaseRappen: a.base_amount_minor,
      fxRate: isBase ? '1' : (payment.fx_rate ?? '1'),
    };
  });
  const totalRappen = allocs.reduce((sum, a) => sum + a.payment_amount_minor, 0);
  const totalBaseRappen = lines.reduce((sum, l) => sum + l.amountBaseRappen, 0);

  // The advice this one supersedes: the current head for the payment (the latest not-yet-superseded
  // advice). A keyed replay never reaches here (it returned above); an unkeyed re-file supersedes.
  const head = ctx.store.db
    .prepare(
      `SELECT id FROM remittance_advice
        WHERE workspace_id = ? AND payment_id = ?
          AND id NOT IN (SELECT supersedes_id FROM remittance_advice WHERE workspace_id = ? AND supersedes_id IS NOT NULL)
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, input.paymentId, ctx.workspaceId) as { id: string } | undefined;

  const run = (): Result => {
    const id = ctx.ids.next('remadv');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO remittance_advice
           (id, workspace_id, payment_id, supplier_contact_id, payment_date, total_rappen, currency,
            total_base_rappen, fx_rate, artifact_document_id, supersedes_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.paymentId,
        supplierContactId,
        payment.date,
        totalRappen,
        payment.currency,
        totalBaseRappen,
        payment.fx_rate,
        head?.id ?? null,
        ctx.actor,
        now,
      );
    let sort = 0;
    for (const l of lines) {
      ctx.store.db
        .prepare(
          `INSERT INTO remittance_advice_line
             (id, advice_id, workspace_id, bill_id, amount_rappen, currency, amount_base_rappen, fx_rate, sort, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('remln'), id, ctx.workspaceId, l.billId, l.amountRappen, l.currency, l.amountBaseRappen, l.fxRate, sort, now);
      sort += 1;
    }
    ctx.audit.record({ entityKind: 'remittance_advice', entityId: id, action: 'create', actor: ctx.actor, at: now });

    // File the advice artifact into E00 (OP4: a LOCAL Beleg, nothing transmitted). Follows F01's
    // retention-link idiom: upload the rendered bytes, then link them to this advice. The artifact id
    // is stamped back onto the row (NULL -> value, the ONE update the immutability trigger permits).
    const rendered = renderAdvice(ctx, id, { supplierContactId, paymentDate: payment.date, currency: payment.currency, totalRappen, totalBaseRappen, lines });
    const uploaded = uploadFile(ctx, {
      title: `Zahlungsavis ${id}`,
      filename: `remittance-advice-${id}.txt`,
      mime: 'text/plain',
      contentBase64: Buffer.from(rendered, 'utf8').toString('base64'),
      idempotencyKey: `${id}-file`,
    }) as unknown as Result;
    let artifactDocumentId: string | null = null;
    if (uploaded.ok) {
      artifactDocumentId = (uploaded as unknown as { file: { id: string } }).file.id;
      linkFile(ctx, {
        fileId: artifactDocumentId,
        entityKind: 'remittance_advice',
        entityId: id,
        idempotencyKey: `${id}-link`,
      });
      ctx.store.db
        .prepare('UPDATE remittance_advice SET artifact_document_id = ? WHERE workspace_id = ? AND id = ? AND artifact_document_id IS NULL')
        .run(artifactDocumentId, ctx.workspaceId, id);
    }

    const row = ctx.store.db
      .prepare('SELECT * FROM remittance_advice WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as RemittanceAdviceRow;
    return ok({
      adviceId: id,
      advice: mapAdvice(ctx, row),
      artifactDocumentId,
      ...(head !== undefined ? { supersedes: head.id } : {}),
      // OP4/P9: the OSS core files the local artifact and stops. No host is wired, so nothing left.
      transmitted: false,
      reason: 'cloud_tier',
    });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'remittance_advice_create', run);
  }
  return ctx.store.tx(run);
}

/** A deterministic, locale-neutral text rendering of the advice (P11: ISO dates, raw integers). */
function renderAdvice(
  ctx: WorkspaceContext,
  adviceId: string,
  a: {
    supplierContactId: string;
    paymentDate: string;
    currency: string;
    totalRappen: number;
    totalBaseRappen: number;
    lines: { billId: string; amountRappen: number; currency: string; amountBaseRappen: number; fxRate: string }[];
  },
): string {
  const supplier = ctx.store.db
    .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, a.supplierContactId) as { name: string | null } | undefined;
  const head = [
    `Zahlungsavis / Remittance advice ${adviceId}`,
    `Lieferant / Supplier: ${supplier?.name ?? a.supplierContactId}`,
    `Zahlungsdatum / Payment date: ${a.paymentDate}`,
    `Total: ${a.currency} ${a.totalRappen} (Basis/base CHF ${a.totalBaseRappen})`,
    '',
    'Beglichene Rechnungen / Settled bills:',
  ];
  const body = a.lines.map(
    (l) => `  ${l.billId}\t${l.currency} ${l.amountRappen}\tCHF ${l.amountBaseRappen}\tKurs/rate ${l.fxRate}`,
  );
  return [...head, ...body, ''].join('\n');
}
