/**
 * A40, planned flows (US-A40.3): the known fixed costs and incomes the books do not schedule
 * themselves, such as rent, salaries or a loan instalment.
 *
 * A planned flow is a FORECAST INPUT and nothing else: it posts nothing, pays nothing, and is never
 * mistaken for a booked fact (the forecast labels every flow with its source). It is retired with
 * `active: false`, never deleted, so a proposal that used it stays explainable.
 *
 * The occurrence arithmetic is A12's (`occurrenceAt`, anchored on the first date, month-end clamped),
 * so a flow on the 31st behaves exactly like a recurring invoice on the 31st.
 *
 * §H-TENANT on every statement; §H-IDEMPOTENT under the caller's key.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalDate, optionalId, requireDate, requireString } from '../ledger/inputGuards.js';
import { occurrenceAt } from '../recurring/dates.js';

/** §H-ENUM: which way the money goes. */
export const PLANNED_FLOW_DIRECTIONS = ['in', 'out'] as const;
export type PlannedFlowDirection = (typeof PLANNED_FLOW_DIRECTIONS)[number];

/** §H-ENUM: how often it recurs. */
export const PLANNED_FLOW_RECURRENCES = ['once', 'monthly', 'quarterly', 'yearly'] as const;
export type PlannedFlowRecurrence = (typeof PLANNED_FLOW_RECURRENCES)[number];

const CURRENCY = /^[A-Z]{3}$/;
const LABEL_MAX = 120;

export interface SetPlannedFlowInput {
  flowId?: string;
  label: string;
  direction: string;
  amountMinor: number;
  currency: string;
  firstDate: string;
  recurrence: string;
  endDate?: string;
  active?: boolean;
  /** The bank account the flow moves (critic R2-M2); omitted, the flow names no account. */
  bankAccountId?: string;
  idempotencyKey: string;
}

export interface PlannedFlowRow {
  id: string;
  label: string;
  direction: PlannedFlowDirection;
  amount_minor: number;
  currency: string;
  first_date: string;
  recurrence: PlannedFlowRecurrence;
  end_date: string | null;
  active: number;
  bank_account_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export function plannedFlowView(row: PlannedFlowRow) {
  return {
    id: row.id,
    label: row.label,
    direction: row.direction,
    amountMinor: row.amount_minor,
    currency: row.currency,
    firstDate: row.first_date,
    recurrence: row.recurrence,
    endDate: row.end_date,
    active: row.active === 1,
    bankAccountId: row.bank_account_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Create a planned flow, or (with `flowId`) replace one (US-A40.3). */
export function setPlannedFlow(ctx: WorkspaceContext, input: SetPlannedFlowInput): Result {
  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalId(input.flowId, 'flowId') ??
    requireString(input.label, 'label') ??
    requireDate(input.firstDate, 'firstDate') ??
    optionalDate(input.endDate, 'endDate') ??
    optionalId(input.bankAccountId, 'bankAccountId');
  if (guard) return guard;
  const label = input.label.trim();
  if (label.length === 0 || label.length > LABEL_MAX) return err('invalid_input', { field: 'label', max: LABEL_MAX });
  if (!(PLANNED_FLOW_DIRECTIONS as readonly string[]).includes(input.direction)) {
    return err('invalid_input', { field: 'direction', allowed: [...PLANNED_FLOW_DIRECTIONS] });
  }
  if (!(PLANNED_FLOW_RECURRENCES as readonly string[]).includes(input.recurrence)) {
    return err('invalid_input', { field: 'recurrence', allowed: [...PLANNED_FLOW_RECURRENCES] });
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return err('invalid_input', { field: 'amountMinor', reason: 'a positive integer in minor units; the direction carries the sign' });
  }
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) {
    return err('invalid_input', { field: 'currency' });
  }
  if (input.endDate !== undefined && input.endDate < input.firstDate) {
    return err('invalid_input', { field: 'endDate', reason: 'before firstDate' });
  }
  if (input.active !== undefined && typeof input.active !== 'boolean') return err('invalid_input', { field: 'active' });
  if (input.bankAccountId !== undefined) {
    // The account must be this workspace's (§H-TENANT) and move the flow's own currency.
    const acc = ctx.store.db
      .prepare('SELECT currency FROM bank_account WHERE workspace_id = ? AND id = ? AND archived = 0')
      .get(ctx.workspaceId, input.bankAccountId) as { currency: string } | undefined;
    if (acc === undefined) return err('not_found', { field: 'bankAccountId', bankAccountId: input.bankAccountId });
    if (acc.currency !== input.currency) {
      return err('invalid_input', { field: 'bankAccountId', reason: 'the account holds another currency', accountCurrency: acc.currency });
    }
  }
  if (input.flowId !== undefined) {
    const found = ctx.store.db
      .prepare('SELECT id FROM planned_flow WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.flowId);
    if (found === undefined) return err('not_found', { flowId: input.flowId });
  }

  const scopedKey = JSON.stringify(['liquidity_flow_set', input.idempotencyKey]);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'liquidity_flow_set', () => {
    const now = ctx.clock.now();
    const active = input.active === false ? 0 : 1;
    let id: string;
    if (input.flowId === undefined) {
      id = ctx.ids.next('pflow');
      ctx.store.db
        .prepare(
          `INSERT INTO planned_flow
             (id, workspace_id, label, direction, amount_minor, currency, first_date, recurrence, end_date,
              active, bank_account_id, idempotency_key, created_by, created_at, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ctx.workspaceId,
          label,
          input.direction,
          input.amountMinor,
          input.currency,
          input.firstDate,
          input.recurrence,
          input.endDate ?? null,
          active,
          input.bankAccountId ?? null,
          input.idempotencyKey,
          ctx.actor,
          now,
          ctx.actor,
          now,
        );
    } else {
      id = input.flowId;
      ctx.store.db
        .prepare(
          `UPDATE planned_flow SET label = ?, direction = ?, amount_minor = ?, currency = ?, first_date = ?,
                  recurrence = ?, end_date = ?, active = ?, bank_account_id = ?, updated_by = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          label,
          input.direction,
          input.amountMinor,
          input.currency,
          input.firstDate,
          input.recurrence,
          input.endDate ?? null,
          active,
          input.bankAccountId ?? null,
          ctx.actor,
          now,
          ctx.workspaceId,
          id,
        );
    }
    const row = ctx.store.db
      .prepare('SELECT * FROM planned_flow WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as PlannedFlowRow;
    return ok({ flow: plannedFlowView(row), created: input.flowId === undefined });
  });
}

/** The planned flows, active first (US-A40.3). */
export function listPlannedFlows(ctx: WorkspaceContext, input: { includeInactive?: boolean } = {}): Result {
  if (input.includeInactive !== undefined && typeof input.includeInactive !== 'boolean') {
    return err('invalid_input', { field: 'includeInactive' });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM planned_flow WHERE workspace_id = ? AND (? = 1 OR active = 1)
        ORDER BY active DESC, first_date, id`,
    )
    .all(ctx.workspaceId, input.includeInactive === true ? 1 : 0) as PlannedFlowRow[];
  return ok({ flows: rows.map(plannedFlowView), total: rows.length });
}

const STEP: Record<Exclude<PlannedFlowRecurrence, 'once'>, 'monthly' | 'quarterly' | 'yearly'> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  yearly: 'yearly',
};

/** Every occurrence date of one flow within `[from, to]`. */
export function occurrencesWithin(row: PlannedFlowRow, from: string, to: string): string[] {
  const out: string[] = [];
  if (row.recurrence === 'once') {
    if (row.first_date >= from && row.first_date <= to) out.push(row.first_date);
    return out;
  }
  const last = row.end_date !== null && row.end_date < to ? row.end_date : to;
  for (let n = 0; n < 5000; n += 1) {
    const d = occurrenceAt(row.first_date, STEP[row.recurrence], null, n);
    if (d > last) break;
    if (d >= from) out.push(d);
  }
  return out;
}
