/**
 * I01 (Advanced Purchase Order) OP14, the VERSION side: on-demand version-1 materialisation and the
 * immutable version read models (`po_version_list`, `po_version_get`, `po_version_diff`). The amendment
 * side (start/update/preview/submit/apply/cancel/reject) lives in `poAmendment.ts` and shares the
 * snapshot + supersession helpers exported here.
 *
 * OP14 core guarantee: the `po_version` rows for a PO are complete, ordered (1..N, gap-free) and
 * immutable, and exactly one is `active`. The active version always equals the live D02
 * `purchase_order` + `po_line` state. Historical versions never change. §H-TENANT on every query;
 * money is integer Rappen (P2). Nothing here posts (P3): a version is DATA, not a ledger event.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { readPo, readPoLines, poNotFound } from './poShared.js';
import type { PoRow, PoLineRow } from './poShared.js';

const READ_CAP = 'read_master_data';

export interface PoVersionRow {
  id: string;
  workspace_id: string;
  po_id: string;
  version_number: number;
  status: string;
  header_snapshot: string;
  lines_snapshot: string;
  sent_artifact_ref: string | null;
  created_from_amendment_id: string | null;
  created_by: string | null;
  created_at: string;
}

/** The frozen header image stored on a version (a plain object, serialised to `header_snapshot`). */
export interface HeaderSnapshot {
  number: string;
  supplierContactId: string;
  status: string;
  revision: number;
  currency: string;
  totalRappen: number;
  totalBaseRappen: number;
  fxRate: string | null;
  expectedOn: string | null;
  note: string | null;
  sourceDocumentType: string | null;
  sourceDocumentId: string | null;
}

/** The frozen image of one PO line (`lines_snapshot` is an array of these). */
export interface LineSnapshot {
  poLineId: string;
  itemId: string | null;
  description: string | null;
  qty: number;
  unitPriceRappen: number;
  unitPriceBaseRappen: number;
  taxCode: string | null;
  projectId: string | null;
  receivedQty: number;
  billedQty: number;
  sort: number;
}

export function headerSnapshotOf(po: PoRow): HeaderSnapshot {
  return {
    number: po.number,
    supplierContactId: po.supplier_contact_id,
    status: po.status,
    revision: po.revision,
    currency: po.currency,
    totalRappen: po.total_rappen,
    totalBaseRappen: po.total_base_rappen,
    fxRate: po.fx_rate,
    expectedOn: po.expected_on,
    note: po.note,
    sourceDocumentType: po.source_document_type,
    sourceDocumentId: po.source_document_id,
  };
}

export function lineSnapshotsOf(lines: PoLineRow[]): LineSnapshot[] {
  return lines.map((l) => ({
    poLineId: l.id,
    itemId: l.item_id,
    description: l.description,
    qty: l.qty,
    unitPriceRappen: l.unit_price_rappen,
    unitPriceBaseRappen: l.unit_price_base_rappen,
    taxCode: l.tax_code,
    projectId: l.project_id,
    receivedQty: l.received_qty,
    billedQty: l.billed_qty,
    sort: l.sort,
  }));
}

/** The single active version for a PO (§H-TENANT), or undefined when none is materialised yet. */
export function readActiveVersion(ctx: WorkspaceContext, poId: string): PoVersionRow | undefined {
  return ctx.store.db
    .prepare("SELECT * FROM po_version WHERE workspace_id = ? AND po_id = ? AND status = 'active'")
    .get(ctx.workspaceId, poId) as PoVersionRow | undefined;
}

/** Every version row for a PO in version order (§H-TENANT). */
export function readVersions(ctx: WorkspaceContext, poId: string): PoVersionRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM po_version WHERE workspace_id = ? AND po_id = ? ORDER BY version_number')
    .all(ctx.workspaceId, poId) as PoVersionRow[];
}

/** The highest version number written for a PO, or 0 when none exists. */
export function maxVersionNumber(ctx: WorkspaceContext, poId: string): number {
  const row = ctx.store.db
    .prepare('SELECT MAX(version_number) AS n FROM po_version WHERE workspace_id = ? AND po_id = ?')
    .get(ctx.workspaceId, poId) as { n: number | null };
  return row.n ?? 0;
}

/**
 * Insert a version row. The single point that writes `po_version`, so the one-active invariant and the
 * gap-free numbering are enforced in exactly one place. The caller guarantees no other active row
 * exists (it has just superseded it, or this is v1); the partial unique index is the belt to that
 * bracer, turning a logic slip into a storage-layer rejection rather than a second live commitment.
 */
export function insertVersion(
  ctx: WorkspaceContext,
  poId: string,
  versionNumber: number,
  header: HeaderSnapshot,
  lines: LineSnapshot[],
  sentArtifactRef: string | null,
  fromAmendmentId: string | null,
): PoVersionRow {
  const id = ctx.ids.next('pover');
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO po_version (id, workspace_id, po_id, version_number, status, header_snapshot, lines_snapshot, sent_artifact_ref, created_from_amendment_id, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, poId, versionNumber, JSON.stringify(header), JSON.stringify(lines), sentArtifactRef, fromAmendmentId, ctx.actor ?? null, now);
  return ctx.store.db.prepare('SELECT * FROM po_version WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as PoVersionRow;
}

/**
 * Materialise version 1 for a PO IF none exists, assuming the caller already holds a transaction
 * (US-I01.1). Idempotent and non-destructive: when any version row already exists it does nothing;
 * otherwise it freezes the current live header + lines as version 1. Used by the amendment writers,
 * which run inside `runTx`; `ensureVersioned` below is the read-path wrapper that opens its own tx.
 */
export function ensureVersionedInline(ctx: WorkspaceContext, po: PoRow): PoVersionRow {
  const active = readActiveVersion(ctx, po.id);
  if (active !== undefined) return active;
  if (maxVersionNumber(ctx, po.id) > 0) {
    // Versions exist but none is active: an inconsistent state that should never occur. Surface it.
    throw new Error('po_version_no_active');
  }
  return insertVersion(ctx, po.id, 1, headerSnapshotOf(po), lineSnapshotsOf(readPoLines(ctx, po.id)), po.sent_artifact_ref, null);
}

/**
 * Ensure a PO has a materialised version 1 (US-I01.1) from a READ verb, which holds no transaction.
 * Idempotent and non-destructive. A legacy D02 PO created before I01 gets its history completed the
 * first time an I01 verb touches it. The partial unique index catches a concurrent double-materialise.
 */
export function ensureVersioned(ctx: WorkspaceContext, poId: string): Result {
  const po = readPo(ctx, poId);
  if (po === undefined) return poNotFound(poId);
  if (maxVersionNumber(ctx, poId) > 0) return ok({ po });
  try {
    ctx.store.tx(() => ensureVersionedInline(ctx, po));
  } catch (e) {
    // A concurrent opener materialised v1 first: the partial unique index rejected the second insert.
    // That is the intended outcome, not a fault; fall through and read the row it wrote.
    const message = e instanceof Error ? e.message : String(e);
    if (!message.toLowerCase().includes('unique')) throw e;
  }
  return ok({ po });
}

function versionSummary(v: PoVersionRow) {
  const header = JSON.parse(v.header_snapshot) as HeaderSnapshot;
  return {
    id: v.id,
    versionNumber: v.version_number,
    status: v.status,
    reason: null as string | null,
    createdFromAmendmentId: v.created_from_amendment_id,
    createdBy: v.created_by,
    createdAt: v.created_at,
    sentArtifactRef: v.sent_artifact_ref,
    number: header.number,
    totalRappen: header.totalRappen,
    currency: header.currency,
  };
}

// --- Reads -------------------------------------------------------------------------------------

/** `po_version_list` (P5): the ordered version history (1..N) for a PO. Materialises v1 on first touch. */
export function poVersionList(ctx: WorkspaceContext, input: { poId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const poId = typeof input.poId === 'string' ? input.poId : '';
  const ensured = ensureVersioned(ctx, poId);
  if (!ensured.ok) return ensured;
  const versions = readVersions(ctx, poId);
  // Attach each amendment's reason to the version it produced, so the timeline reads with context.
  const reasons = new Map<string, string | null>();
  const amds = ctx.store.db
    .prepare('SELECT to_version_id, reason FROM po_amendment WHERE workspace_id = ? AND po_id = ? AND to_version_id IS NOT NULL')
    .all(ctx.workspaceId, poId) as { to_version_id: string; reason: string | null }[];
  for (const a of amds) reasons.set(a.to_version_id, a.reason);
  return ok({
    poId,
    versions: versions.map((v) => ({ ...versionSummary(v), reason: reasons.get(v.id) ?? null })),
  });
}

/** `po_version_get` (P5): the full frozen snapshot of ONE version (§H-TENANT). */
export function poVersionGet(ctx: WorkspaceContext, input: { versionId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const versionId = typeof input.versionId === 'string' ? input.versionId : '';
  const v = ctx.store.db.prepare('SELECT * FROM po_version WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, versionId) as PoVersionRow | undefined;
  if (v === undefined) return err('not_found', { versionId });
  return ok({
    version: {
      ...versionSummary(v),
      poId: v.po_id,
      header: JSON.parse(v.header_snapshot) as HeaderSnapshot,
      lines: JSON.parse(v.lines_snapshot) as LineSnapshot[],
    },
  });
}

const DIFF_HEADER_FIELDS: readonly (keyof HeaderSnapshot)[] = ['status', 'revision', 'currency', 'totalRappen', 'totalBaseRappen', 'fxRate', 'expectedOn', 'note'];
const DIFF_LINE_FIELDS: readonly (keyof LineSnapshot)[] = ['itemId', 'description', 'qty', 'unitPriceRappen', 'taxCode'];

/**
 * `po_version_diff` (P5): the exact header- and line-level changes between two versions of the SAME PO.
 * Pure. Lines are keyed by `poLineId`: a line present in `to` but not `from` is `added`, the reverse is
 * `removed`, and a line in both with any changed field is `changed`. §H-TENANT: both versions must
 * belong to this workspace and to one PO.
 */
export function poVersionDiff(ctx: WorkspaceContext, input: { fromVersionId?: string; toVersionId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const fromId = typeof input.fromVersionId === 'string' ? input.fromVersionId : '';
  const toId = typeof input.toVersionId === 'string' ? input.toVersionId : '';
  const from = ctx.store.db.prepare('SELECT * FROM po_version WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, fromId) as PoVersionRow | undefined;
  const to = ctx.store.db.prepare('SELECT * FROM po_version WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, toId) as PoVersionRow | undefined;
  if (from === undefined) return err('not_found', { versionId: fromId });
  if (to === undefined) return err('not_found', { versionId: toId });
  if (from.po_id !== to.po_id) return err('invalid_reference', { reason: 'versions_of_different_pos' });

  const fromHeader = JSON.parse(from.header_snapshot) as HeaderSnapshot;
  const toHeader = JSON.parse(to.header_snapshot) as HeaderSnapshot;
  const headerChanges = DIFF_HEADER_FIELDS.filter((f) => fromHeader[f] !== toHeader[f]).map((f) => ({ field: f, from: fromHeader[f], to: toHeader[f] }));

  const fromLines = new Map((JSON.parse(from.lines_snapshot) as LineSnapshot[]).map((l) => [l.poLineId, l]));
  const toLines = new Map((JSON.parse(to.lines_snapshot) as LineSnapshot[]).map((l) => [l.poLineId, l]));
  const lineDiffs: { poLineId: string; op: 'added' | 'removed' | 'changed'; changes: { field: string; from: unknown; to: unknown }[] }[] = [];
  for (const [id, toLine] of toLines) {
    const fromLine = fromLines.get(id);
    if (fromLine === undefined) {
      lineDiffs.push({ poLineId: id, op: 'added', changes: DIFF_LINE_FIELDS.map((f) => ({ field: f, from: null, to: toLine[f] })) });
    } else {
      const changes = DIFF_LINE_FIELDS.filter((f) => fromLine[f] !== toLine[f]).map((f) => ({ field: f, from: fromLine[f], to: toLine[f] }));
      if (changes.length > 0) lineDiffs.push({ poLineId: id, op: 'changed', changes });
    }
  }
  for (const [id, fromLine] of fromLines) {
    if (!toLines.has(id)) lineDiffs.push({ poLineId: id, op: 'removed', changes: DIFF_LINE_FIELDS.map((f) => ({ field: f, from: fromLine[f], to: null })) });
  }

  return ok({
    poId: from.po_id,
    fromVersion: from.version_number,
    toVersion: to.version_number,
    headerChanges,
    lineChanges: lineDiffs,
  });
}
