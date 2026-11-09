/**
 * The anchor model (spec G22 §10.2, F8): what a run's hash-bound evidence measures against, computed
 * ONCE per read and shared by every item, every check and the evidence binding.
 *
 *   - `vat_return`: A07's computed return, `returnHashOf` over its payload (the D127 hash; it stays
 *     key-order-sensitive so bound hashes on filed runs never move on upgrade).
 *   - `statements`: the canonical projection of the POSTED ledger over the period,
 *     `{v:1, periodStart, periodEnd, balance, income, postedCount, lastPostedAt}` (base minor, sorted by
 *     account number, no labels, no comparatives: the G20 `reconciliationEvidenceHash` shape). A posting
 *     dated inside the period moves it; a posting dated after does not. Entries with `source='close'`
 *     are EXCLUDED: the seal's own closing entry is dated the last day of the year and would otherwise
 *     void the statements sign-off the seal stands on (A08's Erfolgsrechnung excludes it for the same
 *     reason). The A08 verbs return no hash (F6): the projection lives here.
 *
 * `ReadMemo` is the per-read memo: the anchor, and the VAT return fetched lazily for the two VAT-only
 * checks when the anchor is not the return. `VERB_EVIDENCE` is the dispatcher the `verb_result` and
 * `preview` kinds bind through: one row per read verb a template may name, each answering the hash
 * and the reference the engine computed (never what a caller typed). The A25 handover and archive
 * verbs (`prepare_period`, `export_journal`, `export_statements`) are registered; the A38 preview
 * verbs join this table when their capability lands; an unregistered verb answers `read_refused`.
 */

import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '../context.js';
import { computeVatReturn, exportVatReturnEch0217, vatBridgeOf, type VatBridge } from '../vat/index.js';
import { computeFxRevaluation } from '../fx/index.js';
import { previewDepreciation } from '../assets/index.js';
import { accrualList, provisionList, taxProvisionPreview, vatAnnualReconciliation, vatSettlementPreview } from '../accruals/index.js';
import { exportJournal, exportStatements, reviewStatus } from '../review/index.js';
import { canonicalHashOf, returnHashOf } from './hash.js';
import type { ChecklistPeriod } from './periods.js';
import type { ChecklistAnchor, ChecklistTemplate, ChecklistVerbInputKey } from './types.js';

/**
 * The computed return, evaluated once per read and shared by every check and by the evidence
 * binding: `vat_return_computed`, `abstimmung_resolved`, and the hash a verb item is bound to.
 */
export interface LiveReturn {
  readonly ok: boolean;
  readonly error?: string;
  readonly hash: string | null;
  readonly bridge: VatBridge | null;
  readonly payload: Record<string, unknown> | null;
}

export function liveReturnOf(ctx: WorkspaceContext, period: ChecklistPeriod): LiveReturn {
  const res = computeVatReturn(ctx, { periodStart: period.periodStart, periodEnd: period.periodEnd });
  if (!res.ok) return { ok: false, error: res.error, hash: null, bridge: null, payload: null };
  const payload = res as unknown as Record<string, unknown>;
  const bridge =
    typeof payload.bridge === 'object' && payload.bridge !== null
      ? (payload.bridge as VatBridge)
      : vatBridgeOf(payload as never);
  return { ok: true, hash: returnHashOf(payload), bridge, payload };
}

/** The anchor of one read. `ok:false` carries the refusal (no A05 configuration, an empty book is fine). */
export interface LiveAnchor {
  readonly kind: ChecklistAnchor;
  readonly ok: boolean;
  readonly hash: string | null;
  readonly payload: Record<string, unknown> | null;
  readonly error?: string;
}

/** The statements projection and its hash. Pure read over the posted ledger. */
export function statementsHashOf(
  ctx: WorkspaceContext,
  periodStart: string,
  periodEnd: string,
): { hash: string; payload: Record<string, unknown> } {
  const db = ctx.store.db;
  const balance = db
    .prepare(
      `SELECT a.number AS number, SUM(l.base_debit_minor) - SUM(l.base_credit_minor) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source <> 'close' AND e.date <= ?
        GROUP BY a.number HAVING net <> 0
        ORDER BY a.number ASC`,
    )
    .all(ctx.workspaceId, periodEnd) as { number: string; net: number }[];
  const income = db
    .prepare(
      `SELECT a.number AS number, SUM(l.base_debit_minor) - SUM(l.base_credit_minor) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source <> 'close'
          AND e.date >= ? AND e.date <= ? AND a.type IN ('income', 'expense')
        GROUP BY a.number HAVING net <> 0
        ORDER BY a.number ASC`,
    )
    .all(ctx.workspaceId, periodStart, periodEnd) as { number: string; net: number }[];
  const posted = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM journal_entry
        WHERE workspace_id = ? AND status = 'posted' AND source <> 'close' AND date <= ?`,
    )
    .get(ctx.workspaceId, periodEnd) as { n: number; last: string | null };
  const payload: Record<string, unknown> = {
    v: 1,
    periodStart,
    periodEnd,
    balance: balance.map((r) => [r.number, r.net]),
    income: income.map((r) => [r.number, r.net]),
    postedCount: posted.n,
    lastPostedAt: posted.last,
  };
  return { hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload };
}

/** The anchor for a template's period. */
export function liveAnchorOf(ctx: WorkspaceContext, anchor: ChecklistAnchor, period: ChecklistPeriod, live?: LiveReturn): LiveAnchor {
  if (anchor === 'vat_return') {
    const ret = live ?? liveReturnOf(ctx, period);
    return ret.ok
      ? { kind: anchor, ok: true, hash: ret.hash, payload: ret.payload }
      : { kind: anchor, ok: false, hash: null, payload: null, error: ret.error ?? 'refused' };
  }
  try {
    const s = statementsHashOf(ctx, period.periodStart, period.periodEnd);
    return { kind: anchor, ok: true, hash: s.hash, payload: s.payload };
  } catch (e) {
    return { kind: anchor, ok: false, hash: null, payload: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The per-read memo: the anchor once, the VAT return at most once. */
export interface ReadMemo {
  readonly template: ChecklistTemplate;
  readonly period: ChecklistPeriod;
  readonly anchor: LiveAnchor;
  vatReturn(): LiveReturn;
}

export function readMemoOf(ctx: WorkspaceContext, template: ChecklistTemplate, period: ChecklistPeriod): ReadMemo {
  let ret: LiveReturn | undefined;
  const vatReturn = (): LiveReturn => {
    if (ret === undefined) ret = liveReturnOf(ctx, period);
    return ret;
  };
  const anchor = template.anchor === 'vat_return' ? liveAnchorOf(ctx, 'vat_return', period, vatReturn()) : liveAnchorOf(ctx, 'statements', period);
  return { template, period, anchor, vatReturn };
}

// --- VERB_EVIDENCE -------------------------------------------------------------------------------

/** What a read verb answered when the engine re-ran it: the hash it binds and the reference it stores. */
export type VerbEvidence =
  | { readonly ok: true; readonly hash: string; readonly ref: string; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly error: string; readonly details?: Record<string, unknown> };

export type VerbEvidenceFn = (ctx: WorkspaceContext, period: ChecklistPeriod, memo: ReadMemo) => VerbEvidence;

/** The value a `verbInput` key maps the run's period onto (what the agent passes the verb). */
export function verbInputValueOf(key: ChecklistVerbInputKey | undefined, period: ChecklistPeriod): string {
  switch (key) {
    case 'periodEnd':
      return period.periodEnd;
    case 'year':
      return period.label.length === 4 ? period.label : period.periodEnd.slice(0, 4);
    case 'lastMonth':
      return period.periodEnd.slice(0, 7);
    case 'period':
    case undefined:
      return period.label;
  }
}

function refused(res: { ok: boolean; error?: string } & Record<string, unknown>): VerbEvidence {
  const { ok: _ok, error, ...details } = res;
  return { ok: false, error: error ?? 'refused', details };
}

function canonical(verb: string, res: Record<string, unknown>): VerbEvidence {
  const hash = canonicalHashOf(res);
  return { ok: true, hash, ref: `${verb}:${hash}`, payload: res };
}

export const VERB_EVIDENCE: Readonly<Record<string, VerbEvidenceFn>> = {
  // G22 (D127): the computed return and its export bind the RETURN hash (the figures the file carries).
  vat_return: (_ctx, _period, memo) => {
    const live = memo.vatReturn();
    if (!live.ok || live.hash === null || live.payload === null) return { ok: false, error: live.error ?? 'needs_vat_config' };
    return { ok: true, hash: live.hash, ref: `vat_return:${live.hash}`, payload: live.payload };
  },
  vat_export_ech0217: (ctx, period, memo) => {
    const live = memo.vatReturn();
    if (!live.ok || live.hash === null || live.payload === null) return { ok: false, error: live.error ?? 'needs_vat_config' };
    const exported = exportVatReturnEch0217(ctx, { periodStart: period.periodStart, periodEnd: period.periodEnd });
    if (!exported.ok) return refused(exported);
    const filename = String((exported as Record<string, unknown>).filename ?? '');
    return { ok: true, hash: live.hash, ref: `ech0217:${filename}:${live.hash}`, payload: live.payload };
  },
  // Leg 2 previews (spec §10.2): canonical hashes over the read's payload.
  fx_revaluation: (ctx, period) => {
    const res = computeFxRevaluation(ctx, { periodEnd: period.periodEnd });
    if (!res.ok) return refused(res);
    return canonical('fx_revaluation', res as Record<string, unknown>);
  },
  asset_depreciation_preview: (ctx, period) => {
    const res = previewDepreciation(ctx, { period: verbInputValueOf('lastMonth', period) });
    if (!res.ok) return refused(res);
    return canonical('asset_depreciation_preview', res as Record<string, unknown>);
  },
  // A38 (D129 leg 2, N4): the drafts a period carries, the settlement model, the tax helper and the
  // annual reconciliation, each a pure read whose canonical hash the preview row binds.
  accrual_list: (ctx, period) => {
    const res = accrualList(ctx, { periodEnd: period.periodEnd, status: 'draft' });
    if (!res.ok) return refused(res);
    return canonical('accrual_list', res as Record<string, unknown>);
  },
  provision_list: (ctx, period) => {
    const res = provisionList(ctx, { periodEnd: period.periodEnd, status: 'draft' });
    if (!res.ok) return refused(res);
    return canonical('provision_list', res as Record<string, unknown>);
  },
  vat_settlement_preview: (ctx, period) => {
    const res = vatSettlementPreview(ctx, { period: verbInputValueOf('period', period) });
    if (!res.ok) return refused(res);
    return canonical('vat_settlement_preview', res as Record<string, unknown>);
  },
  tax_provision_preview: (ctx, period) => {
    const res = taxProvisionPreview(ctx, { periodEnd: period.periodEnd });
    if (!res.ok) return refused(res);
    return canonical('tax_provision_preview', res as Record<string, unknown>);
  },
  vat_annual_reconciliation: (ctx, period) => {
    const res = vatAnnualReconciliation(ctx, { year: period.periodEnd.slice(0, 4) });
    if (!res.ok) return refused(res);
    return canonical('vat_annual_reconciliation', res as Record<string, unknown>);
  },
  // A25, the handover and the archive (spec §10.5 items 16 and 20). These bind READ evidence: a
  // derivation runs on every `checklist_get`, so nothing here may write.
  //
  // `prepare_period` is a write (the machine flags) whose packet is NOT persisted and carries no id,
  // so the evidence is the packet's review block re-read through `reviewStatus`: a posting or an
  // approval landing in the period moves it and the row reads stale, which is the claim the row
  // makes ("the packet reflects the books"). The agent runs the verb itself under its own gate.
  prepare_period: (ctx, period) => {
    const res = reviewStatus(ctx, { period: verbInputValueOf('period', period) });
    if (!res.ok) return refused(res);
    // The seal's own closing entry (`source='close'`, dated the year end) is EXCLUDED from the digest,
    // for the reason the statements hash excludes it (spec §10.2): the packet the Treuhänder received
    // described the books before the seal, that claim still holds after it, and a handover row that
    // went stale the moment item 19 posts would leave every sealed year's run unable to read done
    // (measured at the N4 build, 2026-09-10). A posting or a review event in the year still moves it.
    const entries = (Array.isArray(res.entries) ? res.entries : []) as { source?: unknown; status?: unknown }[];
    const live = entries.filter((e) => e.source !== 'close');
    const counts = { approved: 0, flagged: 0, open: 0 };
    for (const e of live) {
      if (e.status === 'approved') counts.approved += 1;
      else if (e.status === 'flagged') counts.flagged += 1;
      else counts.open += 1;
    }
    return canonical('prepare_period', { period: res.period, periodStart: res.periodStart, periodEnd: res.periodEnd, total: live.length, ...counts });
  },
  // The exports bind the BYTES (sha256 of the CSV, the locale-neutral shape: "same period, same
  // bytes"), never the base64 itself, so the payload stays small and the hash still moves on any
  // posted line of the period.
  export_journal: (ctx, period) => {
    const res = exportJournal(ctx, { period: verbInputValueOf('period', period), format: 'csv' });
    if (!res.ok) return refused(res);
    const { artifact, ...rest } = res as Record<string, unknown>;
    return canonical('export_journal', { ...rest, artifact: artifactDigest(artifact) });
  },
  export_statements: (ctx, period) => {
    const res = exportStatements(ctx, { period: verbInputValueOf('period', period), format: 'csv' });
    if (!res.ok) return refused(res);
    const { artifacts, ...rest } = res as Record<string, unknown>;
    return canonical('export_statements', { ...rest, artifacts: (Array.isArray(artifacts) ? artifacts : []).map(artifactDigest) });
  },
};

/** An export artifact without its bytes: the name, the size and the sha256 over the decoded content. */
function artifactDigest(artifact: unknown): Record<string, unknown> {
  const a = (typeof artifact === 'object' && artifact !== null ? artifact : {}) as Record<string, unknown>;
  const { base64, ...rest } = a;
  const sha256 = typeof base64 === 'string' ? createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') : null;
  return { ...rest, sha256 };
}

/** Re-run a read verb and bind its evidence; an unregistered verb is a refusal, never a guess. */
export function verbEvidenceOf(ctx: WorkspaceContext, verb: string | undefined, period: ChecklistPeriod, memo: ReadMemo): VerbEvidence {
  const fn = verb === undefined ? undefined : VERB_EVIDENCE[verb];
  if (fn === undefined) return { ok: false, error: 'read_refused', details: { verb: verb ?? null, reason: 'verb_not_registered', registered: Object.keys(VERB_EVIDENCE) } };
  try {
    return fn(ctx, period, memo);
  } catch (e) {
    return { ok: false, error: 'read_refused', details: { verb, reason: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * Resolve a JSON pointer (`/positions`, `/proposedMinor`) into a payload and say whether it is empty:
 * an empty array, `0`, `null`, `false`, an empty string or a missing path (spec §10.1 `emptyWhen`).
 */
export function pointerIsEmpty(payload: Record<string, unknown> | null, pointer: string): boolean {
  if (payload === null) return false;
  let cursor: unknown = payload;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object') return true;
    cursor = Array.isArray(cursor) ? cursor[Number(key)] : (cursor as Record<string, unknown>)[key];
  }
  if (cursor === undefined || cursor === null || cursor === false || cursor === 0 || cursor === '') return true;
  if (Array.isArray(cursor)) return cursor.length === 0;
  return false;
}
